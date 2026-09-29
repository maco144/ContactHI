#!/usr/bin/env bash
# diagnose.sh — does the chi.delivery router actually work?
#
# /v1/health only proves the process is alive (it returned "ok" for six months
# while every write 404'd). This walks the real path instead:
#   public:  health → POST /v1/send → GET /v1/status, through TLS + proxy
#   on box:  container state, SpacetimeDB heartbeat, advertised endpoint, logs
#
# Usage: scripts/diagnose.sh            (needs `ssh rising`, curl, jq)
#   CHI_URL=https://… CHI_HOST=… CHI_NODE_ID=… to point it elsewhere.
# Exit 0 = no FAIL (WARNs allowed), 1 = something is broken.
#
# Leaves one message in agent_inbox per run, from did:chi:diagnose.

set -uo pipefail

CHI_URL="${CHI_URL:-https://chi.delivery}"
CHI_HOST="${CHI_HOST:-rising}"
CHI_NODE_ID="${CHI_NODE_ID:-chi-router-baremetal-1}"
STDB_DB="${STDB_DB:-contacthi}"

if [ -t 1 ]; then G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' D=$'\e[2m' N=$'\e[0m'; else G= Y= R= D= N=; fi
FAILS=0 WARNS=0
ok()   { printf '  %sOK%s    %s\n' "$G" "$N" "$1"; }
warn() { printf '  %sWARN%s  %s\n' "$Y" "$N" "$1"; WARNS=$((WARNS+1)); }
fail() { printf '  %sFAIL%s  %s\n' "$R" "$N" "$1"; FAILS=$((FAILS+1)); }
info() { printf '  %s%s%s\n' "$D" "$1" "$N"; }

for bin in curl jq ssh; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 2; }
done

echo "== public: $CHI_URL"

health=$(curl -s -m 10 "$CHI_URL/v1/health")
if [ "$(jq -r '.status // empty' <<<"$health" 2>/dev/null)" = ok ]; then
  ok "health 200 (liveness only — the checks below are the real ones)"
  node_in_health=$(jq -r .node_id <<<"$health")
  [ "$node_in_health" = "$CHI_NODE_ID" ] || warn "health reports node_id=$node_in_health, expected $CHI_NODE_ID"
  if [ "$(jq -r '.registry.consent_enforcement // "enforced"' <<<"$health")" = none ]; then
    warn "consent NOT enforced — no registry contract; every send is granted (CHI_ALLOW_NO_REGISTRY)"
  else
    ok "registry contract $(jq -r .registry.contract <<<"$health")"
  fi
else
  fail "health: ${health:-no response}"
fi

msg_id="diag-$(date +%s)-$$"
envelope=$(jq -nc --arg id "$msg_id" --argjson now "$(date +%s%3N)" '{
  version: "1.0", message_id: $id,
  sender_did: "did:chi:diagnose", sender_type: "AA",
  recipient_did: "did:chi:diagnose-recipient",
  intent: "inform.diagnostic",
  payload: "scripts/diagnose.sh smoke test", payload_type: "text/plain",
  created_at: $now, ttl_seconds: 300 }')

send=$(curl -s -m 15 -w '\n%{http_code}' -X POST "$CHI_URL/v1/send" \
  -H 'content-type: application/json' -d "$envelope")
send_code=$(tail -n1 <<<"$send"); send_body=$(sed '$d' <<<"$send")
if [ "$send_code" = 202 ]; then
  ok "send 202 $(jq -r .status <<<"$send_body") ($msg_id)"
  status="" channel=""
  for _ in 1 2 3 4 5; do
    st=$(curl -s -m 10 "$CHI_URL/v1/status/$msg_id")
    status=$(jq -r '.status // empty' <<<"$st" 2>/dev/null)
    channel=$(jq -r '.channel_used // empty' <<<"$st" 2>/dev/null)
    [ "$status" = delivered ] && break
    sleep 1
  done
  if [ "$status" = delivered ] && [ -n "$channel" ]; then
    ok "status delivered via $channel"
  else
    fail "status after 5s: ${status:-none}, channel_used=${channel:-null} — ${st:-no response}"
  fi
else
  fail "send HTTP $send_code: $send_body"
fi

echo "== on box: $CHI_HOST"

# One ssh round-trip; each section tagged so a partial failure stays readable.
box=$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$CHI_HOST" "
  echo '#container'; sudo docker inspect chi-router --format '{{.State.Status}} {{.RestartCount}} {{.State.StartedAt}}' 2>&1
  echo '#nodes'; curl -s -m 5 -X POST localhost:3000/v1/database/$STDB_DB/sql --data-raw 'SELECT * FROM router_nodes'
  echo; echo '#now'; date +%s%3N
  echo '#errors'; sudo docker logs --since 24h chi-router 2>&1 | grep -ciE 'error|fail|unhandled'
  echo '#grants'; sudo docker logs --since 24h chi-router 2>&1 | grep 'UNENFORCED: granting' | grep -vc 'did:chi:diagnose'
  echo '#disk'; df -P / | awk 'NR==2 {print \$5}'
" 2>&1)
if [ $? -ne 0 ] && ! grep -q '^#container' <<<"$box"; then
  fail "ssh $CHI_HOST: $box"
else
  section() { awk -v s="#$1" '$0==s {f=1; next} /^#/ {f=0} f' <<<"$box"; }

  read -r c_state c_restarts c_started <<<"$(section container)"
  if [ "$c_state" = running ]; then
    ok "container running since ${c_started%%.*}Z, $c_restarts restarts"
    [ "${c_restarts:-0}" -gt 0 ] && warn "container has restarted $c_restarts times"
  else
    fail "container: $(section container)"
  fi

  nodes=$(section nodes); now=$(section now)
  row=$(jq -c --arg id "$CHI_NODE_ID" '.[0] as $t
          | ($t.schema.elements | map(.name.some)) as $cols
          | $t.rows[] | [$cols, .] | transpose | map({(.[0]): .[1]}) | add
          | select(.node_id == $id)' <<<"$nodes" 2>/dev/null)
  if [ -z "$row" ]; then
    fail "node $CHI_NODE_ID not in SpacetimeDB router_nodes: ${nodes:-no response}"
  else
    age=$(( (now - $(jq -r .last_seen <<<"$row")) / 1000 ))
    if [ "$age" -le 120 ]; then ok "SpacetimeDB heartbeat ${age}s ago (every 60s)"
    elif [ "$age" -le 300 ]; then warn "SpacetimeDB heartbeat ${age}s ago — late, stale at 300s"
    else fail "SpacetimeDB heartbeat ${age}s ago — node is stale"; fi

    endpoint=$(jq -r .endpoint_url <<<"$row")
    if [ "$endpoint" = "$CHI_URL" ]; then ok "advertises $endpoint"
    else warn "advertises $endpoint, not $CHI_URL — federation peers get a dead address (set NODE_ENDPOINT_URL)"; fi
    info "messages_routed: $(jq -r .messages_routed <<<"$row") lifetime"
  fi

  errs=$(section errors); grants=$(section grants)
  [ "${errs:-0}" -eq 0 ] && ok "0 error lines in 24h logs" || warn "$errs error lines in 24h logs — sudo docker logs --since 24h chi-router"
  info "ungoverned grants in 24h: ${grants:-0} (real traffic, excluding diagnose runs)"

  disk=$(section disk); disk=${disk%\%}
  [ "${disk:-100}" -lt 85 ] && ok "disk ${disk}% used" || warn "disk ${disk}% used"
fi

echo
if [ "$FAILS" -gt 0 ]; then echo "${R}BROKEN${N} — $FAILS fail, $WARNS warn"; exit 1; fi
echo "${G}WORKING${N} — 0 fail, $WARNS warn"

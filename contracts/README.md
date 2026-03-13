# CHI Protocol — On-Chain Human Preference Registry

A CosmWasm smart contract that lets humans register their **contact preferences on-chain**. AI agents and message routers query the contract before sending any message to determine whether they are permitted to contact a given human and via which delivery channels.

This is the foundational consent layer for the ContactHI protocol: AI agents must check here before reaching out.

---

## Overview

- **Default stance: Block.** A human with no preferences registered, or with `DefaultPolicy::Block`, is unreachable by default. Contact is opt-in.
- **Rule-based:** Humans write ordered rules that match on sender entity type and message intent. Each rule lists permitted channels, an optional rate limit, and an optional time-of-day window.
- **Blocklist:** A global per-human blocklist allows blocking specific DIDs or domain patterns unconditionally, regardless of rules.
- **Wildcard matching:** Both sender type and intent support an `Any` wildcard for catch-all rules.

---

## Data Model

### Entity Types (`EntityType`)

Codes from the Entity Identity specification:

| Code | Description |
|------|-------------|
| `CA` | Conversational Agent |
| `LM` | Language Model |
| `GN` | Generative Model |
| `AA` | Autonomous Agent |
| `RB` | Robot |
| `DR` | Drone |
| `VH` | Vehicle |
| `US` | Human User |
| `CP` | Copilot |
| `HS` | Hive / Swarm |
| `Any` | Wildcard — matches all types |

### Intent Types (`Intent`)

| Value | Description |
|-------|-------------|
| `Inform` | Informational message, no action required |
| `Collect` | Data collection request |
| `Authorize` | Authorization / approval request |
| `Escalate` | Alert or escalation |
| `Result` | Result or response delivery |
| `Any` | Wildcard — matches all intents |

### Channels (`Channel`)

`Push`, `Sms`, `Email`, `Webhook`, `InApp`, `AgentInbox`

### Preference Rule

```json
{
  "sender_type": "AA",
  "intent": "Inform",
  "allowed_channels": ["InApp", "AgentInbox"],
  "rate_limit": { "count": 10, "period_seconds": 86400 },
  "time_window": { "start_hour": 9, "start_minute": 0, "end_hour": 18, "end_minute": 0 },
  "blocklist": ["did:bad-actor:*", "*.spam.com"]
}
```

### Rule Matching Priority

When evaluating a `CheckPermission` query, the contract selects the most specific matching rule:

1. Exact `sender_type` + exact `intent`
2. Exact `sender_type` + `Any` intent
3. `Any` sender_type + exact `intent`
4. `Any` sender_type + `Any` intent (catch-all)

The first tier that yields a match wins. If no rule matches, `DefaultPolicy` is applied.

### Pattern Matching (Blocklist)

| Pattern | Matches |
|---------|---------|
| `*.evil.com` | anything ending in `.evil.com` |
| `did:key:*` | anything starting with `did:key:` |
| `*` | everything |
| `exact-string` | exact equality only |

---

## Execute Messages

| Message | Description |
|---------|-------------|
| `RegisterPreferences` | Create a new preference profile (fails if one exists) |
| `UpdatePreferences` | Replace all rules, policy, and webhook URL |
| `AddRule` | Append a single rule to the existing profile |
| `RemoveRule { index }` | Remove a rule by its zero-based position |
| `BlockSender { pattern }` | Add a DID/domain pattern to the global blocklist |
| `UnblockSender { pattern }` | Remove a pattern from the global blocklist |
| `DeletePreferences` | Remove the preference profile entirely |

All write operations are **owner-only**: only the address that owns the profile may modify it.

## Query Messages

| Message | Returns | Description |
|---------|---------|-------------|
| `GetPreferences { address }` | `PreferencesResponse` | Full profile for an address |
| `CheckPermission { sender_did, sender_type, recipient, intent }` | `PermissionResponse` | Full permission evaluation |
| `IsBlocked { sender_pattern, recipient }` | `IsBlockedResponse` | Quick blocklist check |
| `GetRules { address }` | `RulesResponse` | Rule list only |

### `PermissionResponse`

```json
{
  "allowed": true,
  "allowed_channels": ["InApp"],
  "reason": null,
  "rate_limit_remaining": 9
}
```

When `allowed` is `false`, `reason` will be one of:

| Reason | Meaning |
|--------|---------|
| `RECIPIENT_NOT_FOUND` | No preferences registered |
| `SENDER_GLOBALLY_BLOCKED` | Sender is on the recipient's global blocklist |
| `SENDER_RULE_BLOCKED` | Sender matched the per-rule blocklist |
| `NO_MATCHING_RULE_DEFAULT_BLOCK` | No rule matched and default policy is Block |
| `OUTSIDE_TIME_WINDOW` | Message falls outside the rule's allowed time window |
| `RATE_LIMIT_EXCEEDED` | Sender has exceeded the rule's rate limit for this window |

---

## Building

### Prerequisites

- Rust 1.73+ with the `wasm32-unknown-unknown` target
- `cargo` in PATH

```bash
# Install wasm target (once)
rustup target add wasm32-unknown-unknown

# Development check (fast, no wasm output)
cargo check

# Optimized wasm binary (requires Docker + cosmwasm/optimizer)
docker run --rm -v "$(pwd)":/code \
  --mount type=volume,source="$(basename "$(pwd)")_cache",target=/target \
  --mount type=volume,source=registry_cache,target=/usr/local/cargo/registry \
  cosmwasm/optimizer:0.16.0
```

The optimized `.wasm` binary will appear at `artifacts/contacthi_contracts.wasm`.

### Generate JSON Schema

```bash
# Add a schema-generation binary to src/bin/schema.rs, then:
cargo run --bin schema
```

---

## Deployment (Cosmos Testnet)

The examples below use the Cosmos Hub testnet (`theta-testnet-001`) and `gaiad`.
Substitute your preferred chain and CLI tool.

```bash
# 1. Store the contract on-chain
RES=$(gaiad tx wasm store artifacts/contacthi_contracts.wasm \
  --from <your-key> \
  --chain-id theta-testnet-001 \
  --gas auto --gas-adjustment 1.3 \
  --node https://rpc.sentry-01.theta-testnet.polypore.xyz:443 \
  -y --output json)

CODE_ID=$(echo "$RES" | jq -r '.logs[0].events[] | select(.type=="store_code") | .attributes[] | select(.key=="code_id") | .value')
echo "Code ID: $CODE_ID"

# 2. Instantiate the contract
INIT='{"admin": null}'
gaiad tx wasm instantiate "$CODE_ID" "$INIT" \
  --label "chi-preference-registry-v1" \
  --from <your-key> \
  --chain-id theta-testnet-001 \
  --gas auto --gas-adjustment 1.3 \
  --node https://rpc.sentry-01.theta-testnet.polypore.xyz:443 \
  --no-admin \
  -y

# 3. Get the contract address
CONTRACT=$(gaiad query wasm list-contract-by-code "$CODE_ID" \
  --node https://rpc.sentry-01.theta-testnet.polypore.xyz:443 \
  --output json | jq -r '.contracts[-1]')
echo "Contract: $CONTRACT"
```

---

## Usage Examples

### Register preferences

```bash
MSG=$(cat <<'EOF'
{
  "register_preferences": {
    "rules": [
      {
        "sender_type": "AA",
        "intent": "Inform",
        "allowed_channels": ["InApp", "AgentInbox"],
        "rate_limit": { "count": 20, "period_seconds": 86400 },
        "time_window": { "start_hour": 8, "start_minute": 0, "end_hour": 20, "end_minute": 0 },
        "blocklist": []
      },
      {
        "sender_type": "Any",
        "intent": "Any",
        "allowed_channels": [],
        "rate_limit": null,
        "time_window": null,
        "blocklist": []
      }
    ],
    "default_policy": "Block",
    "webhook_url": null
  }
}
EOF
)

gaiad tx wasm execute "$CONTRACT" "$MSG" \
  --from <your-key> --chain-id theta-testnet-001 --gas auto --gas-adjustment 1.3 -y
```

### Check permission (query)

```bash
QUERY=$(cat <<'EOF'
{
  "check_permission": {
    "sender_did": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    "sender_type": "AA",
    "recipient": "cosmos1...",
    "intent": "Inform"
  }
}
EOF
)

gaiad query wasm contract-state smart "$CONTRACT" "$QUERY" \
  --node https://rpc.sentry-01.theta-testnet.polypore.xyz:443 \
  --output json
```

### Block a sender

```bash
gaiad tx wasm execute "$CONTRACT" \
  '{"block_sender": {"pattern": "did:bad-actor:*"}}' \
  --from <your-key> --chain-id theta-testnet-001 --gas auto -y
```

---

## Contract Limits

| Parameter | Limit |
|-----------|-------|
| Max rules per profile | 64 |
| Max global blocklist entries | 512 |

---

## Storage Layout

| Store key | Type | Description |
|-----------|------|-------------|
| `preferences` | `Map<Addr, HumanPreference>` | Primary preference registry |
| `blocklist` | `Map<(Addr, str), bool>` | Per-owner global blocklist |
| `rate_counts` | `Map<(Addr, Addr, str), u32>` | Rate-limit counters per window |

Rate-limit windows use a **fixed-window** strategy. The period key encodes `<period_seconds>:<floor(now / period_seconds)>`, so windows reset cleanly on period boundaries.

---

## Security Notes

- All mutating operations require the transaction signer to be the profile owner; there is no admin override of individual preferences.
- The `DefaultPolicy::Block` default means a newly registered profile with no matching rules will deny all contacts.
- Webhook URLs are validated to require `https://`.
- Blocklist patterns support simple prefix/suffix wildcards only — no regex to avoid DoS vectors.

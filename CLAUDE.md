# CLAUDE.md — ContactHI

## Project Overview

ContactHI implements **CHI/1.0**, a consent-first agent-to-human communication protocol. Humans register on-chain preferences (CosmWasm) before agents can contact them. Router nodes enforce these preferences and route messages via pluggable delivery channels.

Read `PROJECT_INDEX.md` for a full map of the codebase before starting work.

---

## Repository Layout

| Directory | Language | Purpose |
|-----------|----------|---------|
| `contracts/` | Rust (CosmWasm) | On-chain preference registry |
| `router/router-node/` | TypeScript/Express | Reference router node |
| `router/spacetimedb-module/` | Rust (SpacetimeDB) | Real-time message/ack storage |
| `sdk/` | TypeScript | `@contacthi/sdk` client library |
| `extension/` | TypeScript (MV3) | "ContactHI Shield" browser extension |
| `web/chi-codes/` | HTML/CSS | Developer landing page |
| `web/chi-contact/` | HTML/CSS | User preference registration UI |
| `protocol-spec.md` | Markdown | Authoritative CHI/1.0 wire spec |

---

## Build & Run Commands

### Smart Contract (Rust/CosmWasm)
```bash
cd contracts
cargo build
cargo test
# Compile to WASM for deployment
RUSTFLAGS='-C link-arg=-s' cargo build --release --target wasm32-unknown-unknown
```

### Router Node (TypeScript)
```bash
cd router/router-node
npm install
npm run build          # tsc compile to dist/
npm start              # node dist/index.js
npm run dev            # ts-node src/index.ts (if configured)

# Docker
docker build -t chi-router .
docker run -p 3001:3001 -e REGISTRY_CONTRACT=cosmos1... chi-router
```

### SpacetimeDB Module (Rust)
```bash
cd router/spacetimedb-module
cargo build --release --target wasm32-unknown-unknown

# Publish to the engine on rising (must run ON the box — :3000 is localhost-only)
scp target/wasm32-unknown-unknown/release/contacthi_spacetimedb.wasm rising:/tmp/contacthi.wasm
ssh rising 'spacetime publish --server local --bin-path /tmp/contacthi.wasm contacthi'
```
⚠️ `spacetime`'s `default_server` is `maincloud` — omitting `--server local` resolves to
`maincloud.spacetimedb.com` and returns 401.

### Extension (TypeScript/MV3)
```bash
cd extension
npm install
npm run build          # esbuild → dist/
npm run watch
npm run typecheck
```

### SDK (TypeScript)
```bash
cd sdk
npm install
npm run build          # tsc compile to dist/
npm test               # jest
npm run lint           # eslint
```

---

## Key Design Decisions

### Consent-First by Default
- Contract defaults to `Block` policy — senders must be explicitly allowed
- No admin can override individual user preferences
- All write operations are owner-only on-chain

🔴 **No registry contract has been deployed yet.** Every `cosmos1…` in this repo, the
README and `protocol-spec.md` is a placeholder. With `REGISTRY_CONTRACT` unset there are
no declared rules to read, so `checkPermission()` returns
`{granted: true, reason: 'NO_REGISTRY_CONFIGURED'}` for everything — the node serves, but
it is **not** consent-first. That posture must now be chosen explicitly:
`assertConsentPosture()` in `index.ts` exits 1 unless `CHI_ALLOW_NO_REGISTRY=true`, and
when it is set the node logs every ungoverned grant, restricts delivery to `agent-inbox`,
and reports `registry.consent_enforcement: "none"` on `/v1/health`. **Deploying a real
contract is the open item.**

### Rule Matching Priority (contracts/src/contract.rs)
1. Exact `sender_type` + exact `intent`
2. Exact `sender_type` + `Any` intent
3. `Any` sender_type + exact `intent`
4. `Any` sender_type + `Any` intent
5. → default_policy (Block or Allow)

### Envelope Signing (sdk/src/envelope.ts)
- Ed25519 via `@noble/ed25519`
- Canonical JSON: keys sorted alphabetically at all nesting levels, `signature` field omitted before signing
- Signature verification currently optional (required in CHI/1.1)

### SpacetimeDB as Shared State
- All router nodes are stateless — shared state lives in SpacetimeDB
- Tables are publicly readable → real-time subscriptions for inbox/dashboards
- Nodes heartbeat every 60s; stale after 5min
- Tables: `messages`, `acks`, `preference_cache`, `router_nodes`, `agent_inbox`

**Engine and ABI (learned the hard way, 2026-09-01):**
- `Cargo.toml` pins `spacetimedb = "=2.0.4"` to match the engine byte for byte. `"2.0"`
  resolves to 2.9.x — it compiles, and it is a different module ABI.
- The HTTP API is versioned: `/v1/database/{db}/call/{reducer}` and
  `/v1/database/{db}/sql`. The unversioned `/database/…` paths are pre-2.x and 404.
- The SQL endpoint takes the **raw SQL string** as the body (not `{"query": …}`) and
  returns `[{schema, rows}]` with **positional** rows.
- `Option<T>` is a sum type in both directions. Encode arguments as `{"some": v}` /
  `{"none": []}` — a bare value or a bare `null` is rejected with HTTP 400. Decode SQL
  results from the positional form `[0, v]` (some) / `[1, []]` (none). See `option()` and
  `unwrapOption()` in `services/spacetime.ts`.
- Reducers take scalar args, so the router sends a flat positional array. **Argument order
  in `spacetime.ts` must match the reducer signature in `lib.rs`** — nothing checks this
  for you.

### Delivery Channel Ordering
Router tries channels in the order declared in the recipient's preference rules. First success wins. `agent_inbox` (SpacetimeDB write) is the default fallback.

---

## API Endpoints (Router Node)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/send` | Submit CHI envelope |
| `GET` | `/v1/status/:message_id` | Poll delivery status |
| `GET` | `/v1/health` | Node health + capabilities |
| `GET` | `/` | Root info page |

---

## Envelope Validation Rules (router/router-node/src/middleware/validate.ts)

- `version` must be `"1.0"`
- `message_id`, `sender_did`, `recipient_did`, `intent`, `payload`, `payload_type`, `created_at`, `ttl_seconds` — all required
- DIDs must start with `"did:"`
- `sender_type` ∈ Entity Identity codes `{CA, LM, GN, AA, RB, DR, VH, US, CP, HS}` — the on-chain vocabulary (spec §4.3)
- `intent` format: `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`, and the namespace MUST be a registry Intent class (`inform|collect|authorize|escalate|result`) — an intent that cannot match a rule is rejected rather than silently dropped
- `ttl_seconds`: 1–604800 (7 days)
- `priority`: 0–255
- Reject if message already expired or `created_at` > 5 minutes in future

---

## Environment Variables (Router Node)

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3001` | |
| `NODE_ID` | `contacthi-node-local` | Must be unique in federation |
| `REGISTRY_CONTRACT` | — | **Required** — CosmWasm bech32 address. None deployed yet |
| `CHI_ALLOW_NO_REGISTRY` | `false` | `true` to run unenforced on purpose; without it the node refuses to start when `REGISTRY_CONTRACT` is empty |
| `NODE_ENDPOINT_URL` | `http://localhost:$PORT` | Advertised in `router_nodes` |
| `COSMOS_RPC` | `https://rpc.cosmos.directory/cosmoshub` | |
| `SPACETIMEDB_URL` | `http://localhost:3000` | |
| `SPACETIMEDB_DB` | `contacthi` | |
| `NULLCONE_URL` | `https://nullcone.example.com` | Fails open if unavailable |
| `FCM_KEY` | — | Firebase push (optional) |
| `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM` | — | SMS (optional) |
| `SMTP_HOST/USER/PASS` | — | Email (optional) |

---

## SDK Usage Pattern

```typescript
import { ChiClient } from '@contacthi/sdk'

const client = new ChiClient({
  router_url: 'https://router.chi.network',
  sender_did: 'did:chi:cosmos1...',
  sender_type: 'AA',
  private_key: process.env.CHI_PRIVATE_KEY,
})

// Always check permission before sending
const perm = await client.checkPermission({
  recipient: 'did:chi:cosmos1recipient...',
  intent: 'inform.shipping_update',
})
if (!perm.allowed) return

const { message_id } = await client.send({
  to: 'did:chi:cosmos1recipient...',
  intent: 'inform.shipping_update',
  content: 'Your order has shipped.',
  ttl: 86400,
})

const ack = await client.waitForAck(message_id, 60000)
```

---

## Protocol Version

Current: **CHI/1.0 Draft** (wire format settled 2026-09-02)

Planned CHI/1.1 changes: mandatory envelope signatures; removal of the deprecated
`Reach*` SDK aliases.

⚠️ **The envelope is flat and the vocabulary is the contract's.** Until 2026-09-02 the
SDK emitted a nested envelope (`sender.did`, `chi`, `ttl`) with `INFORM`-style intents
while the router expected flat fields with `human|agent|service` — no envelope the SDK
produced could be accepted by any router. Field layout follows the router (it maps 1:1
onto storage with no reshaping); vocabulary follows `contracts/src/state.rs`, because the
registry decides consent and its serialization freezes on first instantiation.

The canonical spec lives in `protocol-spec.md`. When in doubt about wire format, error codes, or semantics — that document is authoritative.

---

## Deployment (rising)

`chi.delivery` (:8016), `chi.codes` and `chi.contact` all run on **rising**
(`45.77.104.159`). The router is the `chi-router` container on the host network;
compose + env live at `/opt/services/contacthi/router/`. Build source on the box is
`~/ContactHI-build/router-node` (rsynced — the durable fix is cloning this repo there).
Rollback image: `chi-router:pre-20260901`.

```bash
rsync -az --exclude node_modules --exclude dist router/router-node/ rising:~/ContactHI-build/router-node/
ssh rising 'cd ~/ContactHI-build/router-node && docker build -t chi-router:latest .'
ssh rising 'cd /opt/services/contacthi/router && sudo docker compose -f docker-compose.prod.yml up -d --force-recreate'
```

⚠️ **A 200 from `/v1/health` does not mean the router works.** It reports process liveness
only and touches neither SpacetimeDB nor the registry. Between 2026-03-13 and 2026-09-01 it
returned `"status":"ok"` while every write 404'd. Smoke-test the real path instead:
`POST /v1/send` → expect `202 delivered` → `GET /v1/status/{id}` → expect `delivered` with
a non-null `channel_used`.

---

## Testing Philosophy

- SDK tests live in `sdk/tests/` and use Jest + ts-jest (101 tests)
- Contract tests live in `contracts/src/tests.rs`, run with `cargo test` (31 tests)
- ⚠️ **`cargo test` on zero tests prints `test result: ok`.** The contract had no
  tests at all until 2026-09-02 and reported success the whole time. Check the
  count, not the colour — and the same goes for any suite you inherit.
- The contract suite is mutation-checked: inverting the rule-priority tiers,
  making `default_policy: Block` allow, or making the blocklist never match each
  fail 3–4 tests. If you change consent logic and nothing goes red, the test
  you need does not exist yet.
- Router node has no automated tests yet (manual integration testing via curl)
- All SDK tests mock CosmWasm and SpacetimeDB HTTP calls (no live chain required)

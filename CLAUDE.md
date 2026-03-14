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
- `sender_type` ∈ `{human, agent, service, device, dao}`
- `intent` format: `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`
- `ttl_seconds`: 1–604800 (7 days)
- `priority`: 0–255
- Reject if message already expired or `created_at` > 5 minutes in future

---

## Environment Variables (Router Node)

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3001` | |
| `NODE_ID` | `contacthi-node-local` | Must be unique in federation |
| `REGISTRY_CONTRACT` | — | **Required** — CosmWasm bech32 address |
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
import { ReachClient } from '@contacthi/sdk'

const client = new ReachClient({
  router_url: 'https://router.chi.network',
  sender_did: 'did:chi:cosmos1...',
  sender_type: 'AA',
  private_key: process.env.CHI_PRIVATE_KEY,
})

// Always check permission before sending
const perm = await client.checkPermission({
  recipient: 'did:chi:cosmos1recipient...',
  intent: 'INFORM',
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

Current: **CHI/1.0 Draft** (dated 2026-03-11)

Planned CHI/1.1 changes: mandatory envelope signatures.

The canonical spec lives in `protocol-spec.md`. When in doubt about wire format, error codes, or semantics — that document is authoritative.

---

## Testing Philosophy

- SDK tests live in `sdk/tests/` and use Jest + ts-jest
- Contract tests use standard `cargo test`
- Router node has no automated tests yet (manual integration testing via curl)
- All SDK tests mock CosmWasm and SpacetimeDB HTTP calls (no live chain required)

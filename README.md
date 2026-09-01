<div align="center">

# ContactHI

**A consent-first, agent-to-human communication protocol for the agentic era.**

Humans declare on-chain how, when, and by whom they may be contacted. Agents must check before they reach out. No message is delivered unless the recipient's own rules explicitly allow it.

[Protocol Spec](protocol-spec.md) · [Router Node](router/router-node) · [SDK](sdk) · [Smart Contract](contracts)

</div>

---

## What is CHI?

**CHI/1.0** (Contact-Human Interface) is an open protocol that puts humans in control of agent communication. As autonomous agents proliferate, the default of "anyone can message anyone" breaks down. CHI inverts it: reachability is **deny-by-default**, and consent is declared by the human, enforced by the network, and impossible for any single party to override.

```
Agent                    Router Node              Registry (CosmWasm)
  │── POST /v1/send ────►│                              │
  │   (CHI envelope)     │── CheckPermission ──────────►│
  │                      │◄── allowed / denied ─────────│
  │                      │── threat-feed check          │
  │                      │── deliver via channel        │
  │                      │── write ack to SpacetimeDB   │
  │◄── 202 Accepted ─────│                              │
```

### Core principles

- **Consent-first by default** — the registry defaults to `Block`; senders must be explicitly allowed.
- **User-owned preferences** — rules live on-chain (CosmWasm). No admin, company, or router can override an individual's settings.
- **Stateless, federated routers** — any node can route any message; shared state lives in SpacetimeDB, so inboxes and dashboards update in real time.
- **Pluggable delivery** — push, SMS, email, webhook, in-app, or agent-inbox. The recipient decides the channel order.

---

## Repository layout

| Directory | Language | Purpose |
|-----------|----------|---------|
| [`protocol-spec.md`](protocol-spec.md) | Markdown | Authoritative CHI/1.0 wire spec — envelope format, error codes, semantics |
| [`contracts/`](contracts) | Rust (CosmWasm) | On-chain preference registry |
| [`router/router-node/`](router/router-node) | TypeScript / Express | Reference router node |
| [`router/spacetimedb-module/`](router/spacetimedb-module) | Rust (SpacetimeDB) | Real-time message / ack storage |
| [`sdk/`](sdk) | TypeScript | `@contacthi/sdk` client library |
| [`extension/`](extension) | TypeScript | Browser extension — detects & filters AI-generated content (on-device model) |
| [`web/`](web) | HTML / CSS | Developer landing page and user preference-registration UI |

See [`PROJECT_INDEX.md`](PROJECT_INDEX.md) for a full map of modules and entry points.

---

## Quick start

### Send a message with the SDK

```bash
cd sdk && npm install && npm run build
```

```typescript
import { ReachClient } from '@contacthi/sdk'

const client = new ReachClient({
  router_url: 'https://router.chi.network',
  sender_did: 'did:chi:cosmos1...',
  sender_type: 'AA',                 // autonomous agent
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

### Run a router node

```bash
cd router/router-node
npm install
npm run build
REGISTRY_CONTRACT=cosmos1... npm start    # listens on :3001
```

Or with Docker:

```bash
docker build -t chi-router .
docker run -p 3001:3001 -e REGISTRY_CONTRACT=cosmos1... chi-router
```

The `REGISTRY_CONTRACT` (the CosmWasm registry address) is the only required variable. Delivery-channel credentials (FCM, Twilio, SMTP) are optional — see [Configuration](#configuration).

Without it there are no on-chain rules to read, so every permission check trivially grants
and the node is **not** consent-first. Rather than let that happen quietly, the router
refuses to start unless you opt in with `CHI_ALLOW_NO_REGISTRY=true` — which limits
delivery to the `agent-inbox` channel, logs every ungoverned grant, and makes
`/v1/health` report `registry.consent_enforcement: "none"`.

### Build the smart contract

```bash
cd contracts
cargo test
RUSTFLAGS='-C link-arg=-s' cargo build --release --target wasm32-unknown-unknown
```

---

## How it works

### The envelope

Every message is a signed **CHI envelope** — canonical JSON with Ed25519 signatures (`@noble/ed25519`). Keys are sorted alphabetically at all nesting levels and the `signature` field is omitted before signing. Signature verification is optional in CHI/1.0 and becomes mandatory in CHI/1.1.

### Rule matching (on-chain)

When a router asks the registry whether a sender may reach a recipient, rules are matched in priority order:

1. Exact `sender_type` + exact `intent`
2. Exact `sender_type` + `Any` intent
3. `Any` sender_type + exact `intent`
4. `Any` sender_type + `Any` intent
5. → `default_policy` (`Block` or `Allow`)

### Delivery

The router tries delivery channels in the order declared in the recipient's rules. First success wins; `agent_inbox` (a SpacetimeDB write) is the default fallback. Because router nodes are stateless and SpacetimeDB tables are publicly readable, clients can subscribe to their inbox in real time.

---

## API (router node)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/send` | Submit a CHI envelope |
| `GET` | `/v1/status/:message_id` | Poll delivery status |
| `GET` | `/v1/health` | Node health + capabilities |
| `GET` | `/` | Root info page |

Envelopes are validated for `version` (`"1.0"`), required fields, `did:`-prefixed DIDs, intent format (`namespace.action`), TTL bounds (1–604800s), priority (0–255), and clock skew (rejected if expired or created >5 min in the future).

---

## Configuration

Router node environment variables:

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3001` | |
| `NODE_ID` | `contacthi-node-local` | Must be unique in the federation |
| `REGISTRY_CONTRACT` | — | **Required** — CosmWasm bech32 address |
| `CHI_ALLOW_NO_REGISTRY` | `false` | `true` to run with consent enforcement off, on purpose |
| `NODE_ENDPOINT_URL` | `http://localhost:$PORT` | Advertised to peers in `router_nodes` |
| `COSMOS_RPC` | `https://rpc.cosmos.directory/cosmoshub` | |
| `SPACETIMEDB_URL` | `http://localhost:3000` | |
| `SPACETIMEDB_DB` | `contacthi` | |
| `NULLCONE_URL` | — | Threat-feed check; fails open if unavailable |
| `FCM_KEY` | — | Firebase push (optional) |
| `TWILIO_ACCOUNT_SID` / `AUTH_TOKEN` / `FROM` | — | SMS (optional) |
| `SMTP_HOST` / `USER` / `PASS` | — | Email (optional) |

> Secrets are read from the environment only — never commit them. Use a local `.env` file (git-ignored) and keep `.env.example` for documentation.

---

## Entity types & intents

**Entity types**: `CA` (Corporate Agent), `LM` (Language Model), `GN` (Governance Node), `AA` (Autonomous Agent), `RB` (Robot), `DR` (Data Reporter), `VH` (Virtual Human), `US` (User), `CP` (Counterparty), `HS` (Human Sender), `Any`.

**Intent format**: `namespace.action` (e.g. `inform.shipping_update`, `collect.survey`) or named constants `Inform`, `Collect`, `Authorize`, `Escalate`, `Result`, `Any`.

**Channels**: `push`, `sms`, `email`, `webhook`, `in_app`, `agent_inbox`.

---

## Development

```bash
# SDK
cd sdk && npm install && npm test && npm run lint

# Contract
cd contracts && cargo test

# Router node — no automated tests yet; integration-test via curl
```

SDK tests (Jest + ts-jest) mock CosmWasm and SpacetimeDB, so no live chain is required.

---

## Protocol version

Current: **CHI/1.0 Draft** (2026-03-11). The canonical spec lives in [`protocol-spec.md`](protocol-spec.md) — when in doubt about wire format, error codes, or semantics, that document is authoritative. Planned CHI/1.1: mandatory envelope signatures.

---

## License

Released under the [Rising Sun License v1.0](LICENSE.md). Free for personal use, education, and research — use, modify, and share it however you want. Commercial deployments that generate revenue must keep the Nous integration in place; see the [license](LICENSE.md) for full terms. Copyright © 2026 Alex Macaluso.

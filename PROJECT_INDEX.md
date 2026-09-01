# Project Index: ContactHI

Generated: 2026-09-01

## Overview

**ContactHI** is an open-source implementation of the **CHI/1.0 protocol** — a consent-first, asynchronous agent-to-human communication protocol for the agentic era. AI agents query on-chain preference registries to determine if they're allowed to contact a human, then route messages through a federated network of router nodes.

**Core principle**: Humans declare reachability preferences on-chain before any agent may send a message. No message is delivered unless the human's declared rules explicitly allow it.

---

## 📁 Project Structure

```
ContactHI/
├── protocol-spec.md              # Full CHI/1.0 wire spec (55KB)
├── contracts/                    # CosmWasm smart contract (Rust)
│   └── src/
│       ├── contract.rs           # execute/query/instantiate handlers
│       ├── msg.rs                # Message types (Execute, Query)
│       ├── state.rs              # Data models & storage
│       ├── error.rs              # Error types
│       └── helpers.rs            # Utility functions
├── router/
│   ├── router-node/              # Reference router (TypeScript/Express)
│   │   └── src/
│   │       ├── index.ts          # Server entry point
│   │       ├── config.ts         # Environment config
│   │       ├── routes/           # HTTP endpoints
│   │       ├── middleware/       # Validation + rate limiting
│   │       └── services/         # Registry, delivery, SpacetimeDB, Nullcone
│   └── spacetimedb-module/       # SpacetimeDB reducer module (Rust, 2.0.4)
│       └── src/lib.rs            # Tables and reducers
├── sdk/                          # @contacthi/sdk (TypeScript)
│   └── src/
│       ├── client.ts             # ReachClient — main API
│       ├── envelope.ts           # Create/sign/verify CHI envelopes
│       ├── preferences.ts        # PreferencesManager
│       ├── did.ts                # DID utilities
│       ├── types.ts              # All TypeScript types
│       └── errors.ts             # Error classes
├── extension/                    # "ContactHI Shield" — MV3 browser extension
│   └── src/
│       ├── background/           # Service worker; plugin registration
│       ├── content/              # gmail.ts, general.ts, ui.ts injectors
│       ├── detection/            # Pluggable AI-detection provider interface
│       ├── options/              # Provider + policy configuration UI
│       ├── popup/                # Toolbar popup
│       └── shared/               # types, storage, message passing
└── web/
    ├── chi-codes/index.html      # Developer landing (chi.codes)
    └── chi-contact/index.html    # User preference registration (chi.contact)
```

---

## 🚀 Entry Points

| Component | Entry Point | Purpose |
|-----------|------------|---------|
| Router Node | `router/router-node/src/index.ts` | Express HTTP server on port 3001 |
| SDK | `sdk/src/index.ts` | All public exports |
| Contract | `contracts/src/lib.rs` | CosmWasm module entrypoint |
| SpacetimeDB | `router/spacetimedb-module/src/lib.rs` | Reducer module |
| Extension | `extension/src/background/service-worker.ts` | MV3 service worker |

---

## 📦 Core Modules

### contracts/src/contract.rs
CosmWasm smart contract handling on-chain preference registration.
- **Execute**: `RegisterPreferences`, `UpdatePreferences`, `AddRule`, `RemoveRule`, `BlockSender`, `UnblockSender`
- **Query**: `CheckPermission`, `GetPreferences`, `IsBlocked`
- Rule priority: exact sender_type+intent → exact sender_type+Any → Any+exact intent → Any+Any → default_policy

### router/router-node/src/routes/send.ts
`POST /v1/send` — Primary message submission endpoint.
- Validates CHI envelope → queries preference registry → checks Nullcone threat feed → delivers via channel → writes ack to SpacetimeDB
- Returns 202 (delivered/pending/failed), 403 (blocked), 429 (rate limited)

### router/router-node/src/services/registry.ts
Queries CosmWasm preference registry to check if sender is allowed to contact recipient.

### router/router-node/src/services/delivery.ts
Multi-channel delivery orchestration: agent-inbox (SpacetimeDB), push (FCM), SMS (Twilio), email (SMTP), webhook.

### router/router-node/src/middleware/validate.ts
CHI envelope structural validation (version, DIDs, intent format, TTL, clock skew).

### sdk/src/client.ts
`ReachClient` — main SDK class: `send()`, `checkPermission()`, `waitForAck()`, `preferences`.

### sdk/src/envelope.ts
`createEnvelope()`, `signEnvelope()` (Ed25519), `verifyEnvelope()`, `validateEnvelope()`, `isExpired()`.

### router/spacetimedb-module/src/lib.rs
SpacetimeDB tables: **messages**, **acks**, **preference_cache**, **router_nodes**, **agent_inbox**.
Reducers: `submit_message`, `update_ack`, `cache_preferences`, `register_node`,
`write_agent_inbox`, `mark_inbox_read`, `expire_messages`.

⚠️ **Pinned to `spacetimedb = "=2.0.4"`** to match the engine on rising exactly. Do not
relax to `"2.0"` — that resolves to 2.9.x, which compiles but is a different module ABI.
All reducers take **scalar** arguments, so the router sends a flat positional JSON array;
keep the two in step when changing a signature.

### extension/src/detection/plugin.ts
`DetectionPlugin` — the provider interface behind ContactHI Shield. CHI owns the policy
(what the human declared); a plugin owns the signal (is this content AI-generated?).
Add a provider by implementing the interface under `src/detection/adapters/`, registering
it in `src/background/service-worker.ts`, and listing it in `PROVIDERS` in
`src/options/options.ts`.

---

## 🔧 Configuration

| File | Purpose |
|------|---------|
| `contracts/Cargo.toml` | Contract deps: cosmwasm-std 1.5, cw-storage-plus 1.2 |
| `router/router-node/package.json` | Router deps: express 4.18, @cosmjs/cosmwasm-stargate 0.32 |
| `router/router-node/Dockerfile` | Multi-stage Docker build (node:22-alpine) |
| `sdk/package.json` | SDK deps: @noble/ed25519 2.0, @cosmjs/cosmwasm-stargate 0.32 |
| `sdk/tsconfig.json` | TypeScript 5 config |
| `extension/manifest.json` | MV3 manifest — Gmail + all-urls content scripts, HF host perms |
| `extension/build.mjs` | esbuild bundler (`npm run build` / `watch`) |

**Required env vars for router**: `REGISTRY_CONTRACT` (CosmWasm address). The router
**refuses to start** without it unless `CHI_ALLOW_NO_REGISTRY=true` is set — with no
registry there are no declared rules to read, so every permission check trivially grants
and the node is not consent-first. In that posture delivery is limited to `agent-inbox`,
every ungoverned grant is logged, and `/v1/health` reports
`registry.consent_enforcement: "none"`.

**Optional env vars**: `PORT`, `NODE_ID`, `COSMOS_RPC`, `SPACETIMEDB_URL`, `SPACETIMEDB_DB`, `NULLCONE_URL`, `NODE_ENDPOINT_URL`, `FCM_KEY`, `TWILIO_*`, `SMTP_*`

---

## 📚 Documentation

| File | Contents |
|------|---------|
| `protocol-spec.md` | Full CHI/1.0 wire format, semantics, error codes, entity types |
| `contracts/README.md` | Contract deployment and usage guide |
| `router/router-node/README.md` | Router setup and API reference |
| `sdk/README.md` | SDK quick-start and API docs |

---

## 🧪 Tests

| File | Coverage |
|------|---------|
| `sdk/tests/client.test.ts` | ReachClient — send, checkPermission, waitForAck |
| `sdk/tests/envelope.test.ts` | createEnvelope, signEnvelope, verifyEnvelope, validateEnvelope |
| `sdk/tests/preferences.test.ts` | PreferencesManager — register, get, block/unblock |
| `sdk/tests/setup.ts` | Jest global setup |

---

## 🔗 Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@cosmjs/cosmwasm-stargate` | 0.32 | CosmWasm contract queries |
| `@noble/ed25519` | 2.0 | Ed25519 envelope signing |
| `express` | 4.18 | Router HTTP server |
| `cosmwasm-std` | 1.5 | Rust CosmWasm contract SDK |
| `cw-storage-plus` | 1.2 | Contract storage abstractions |
| `uuid` | 9.0 | Message ID generation |

---

## 🚢 Deployment (as of 2026-09-01)

| Host | Serves | Where |
|---|---|---|
| `chi.delivery` | Router node, :8016 | `chi-router` container, host network, on **rising** (`45.77.104.159`) |
| `chi.codes` | Static dev landing | `/opt/services/contacthi/chi-codes` |
| `chi.contact` | Static preference UI | `/opt/services/contacthi/chi-contact` |

- Compose + env: `/opt/services/contacthi/router/docker-compose.prod.yml` and `.env`
- Build source on the box: `~/ContactHI-build/router-node` (rsynced; the durable fix is
  cloning this repo). Image `chi-router:latest`; rollback tag `chi-router:pre-20260901`.
- SpacetimeDB runs natively via `spacetimedb.service` at `localhost:3000`, engine **2.0.4**,
  datadir `/data/volumes/spacetimedb`. Publish with
  `spacetime publish --server local --bin-path <wasm> contacthi` — the CLI's
  `default_server` is `maincloud`, so **always pass `--server local`** or it 401s.
- Database `contacthi` identity:
  `c2001c46adcb5053e82af22c7fe31358aeeb9c0049902417e0ea42054d24fc21` (first published
  2026-09-01; it had never existed before — see `~/rising-rescue/docs/`).
- Query it with `curl -X POST --data 'SELECT COUNT(*) AS n FROM t'
  http://127.0.0.1:3000/v1/database/contacthi/sql` — aggregates require a column alias.

---

## 🏗️ Protocol Flow

```
Agent                    Router Node              Registry (CosmWasm)
  │── POST /v1/send ────►│                              │
  │   (CHI envelope)     │── CheckPermission ──────────►│
  │                      │◄── allowed/denied ───────────│
  │                      │── Nullcone threat check      │
  │                      │── deliver via channel        │
  │                      │── write ack to SpacetimeDB   │
  │◄── 202 Accepted ─────│                              │
  │                      │
  │── GET /v1/status ───►│
  │◄── ack + channel ────│
```

---

## 📝 Entity Types & Intents

**EntityType**: `CA` (Corporate Agent), `LM` (Language Model), `GN` (Governance Node), `AA` (Autonomous Agent), `RB` (Robot), `DR` (Data Reporter), `VH` (Virtual Human), `US` (User), `CP` (Counterparty), `HS` (Human Sender), `Any`

**Intent format**: `namespace.action` (e.g., `inform.shipping_update`, `collect.survey`) or named constants: `Inform`, `Collect`, `Authorize`, `Escalate`, `Result`, `Any`

**Channels**: `push`, `sms`, `email`, `webhook`, `in_app`, `agent_inbox`

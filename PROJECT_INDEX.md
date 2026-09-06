# Project Index: ContactHI

Generated: 2026-09-06

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
│       ├── helpers.rs            # Utility functions
│       ├── tests.rs              # Consent-boundary suite (31 tests)
│       └── bin/schema.rs         # JSON schema generator → contracts/schema/
├── router/
│   ├── router-node/              # Reference router (TypeScript/Express)
│   │   └── src/
│   │       ├── index.ts          # Server entry point
│   │       ├── config.ts         # Environment config
│   │       ├── routes/           # send, status, health, check-permission
│   │       ├── middleware/       # Envelope validation + per-IP rate limiting
│   │       └── services/         # registry, delivery, rateLimit, spacetime, nullcone
│   └── spacetimedb-module/       # SpacetimeDB reducer module (Rust, 2.0.4)
│       └── src/lib.rs            # Tables and reducers
├── sdk/                          # @contacthi/sdk (TypeScript)
│   └── src/
│       ├── client.ts             # ChiClient — main API
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
- `CheckPermission` returns the matched rule's **`rate_limit` policy**, not a remaining
  count. The registry declares the ceiling — that is a consent decision — but cannot
  enforce it: enforcement needs a count of delivered messages and the chain never sees a
  delivery. A `RATE_COUNTS` map existed until 2026-09-02 that no execute path ever wrote,
  so every configured limit passed everything; `state.rs` now carries a comment where it
  used to be so it is not reintroduced.

### router/router-node/src/routes/send.ts
`POST /v1/send` — Primary message submission endpoint.
- Validates CHI envelope → queries preference registry → checks Nullcone threat feed → delivers via channel → writes ack to SpacetimeDB
- Returns 202 (delivered/pending/failed), 403 (blocked), 429 (rate limited)

### router/router-node/src/services/registry.ts
Queries CosmWasm preference registry to check if sender is allowed to contact recipient.

### router/router-node/src/services/rateLimit.ts
Where declared rate limits are actually enforced. `enforceRateLimit()` counts rows in the
SpacetimeDB `messages` table against the policy the registry returned;
`checkPermissionWithRateLimit()` is the single code path shared by `/v1/send` and
`/v1/check-permission`, so the two cannot drift into disagreeing. The check runs **before**
the message is recorded, so a refusal does not consume the sender's own allowance. **Fails
open** when SpacetimeDB is unreachable — a storage outage must not become a total delivery
block.

### router/router-node/src/routes/checkPermission.ts
`POST /v1/check-permission` — ask the router whether a send would be accepted, without
sending. The SDK has called this since it was written; the router did not serve it until
2026-09-02, so `client.checkPermission()` against a router 404'd.

### router/router-node/src/services/delivery.ts
Multi-channel delivery orchestration: agent-inbox (SpacetimeDB), push (FCM), SMS (Twilio), email (SMTP), webhook.

### router/router-node/src/middleware/validate.ts
CHI envelope structural validation (version, DIDs, intent format, TTL, clock skew).

### sdk/src/client.ts
`ChiClient` — main SDK class: `send()`, `checkPermission()`, `waitForAck()`, `preferences`.

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

## 🌐 Router API

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/send` | Submit a CHI envelope |
| `POST` | `/v1/check-permission` | Dry-run the consent + rate-limit decision |
| `GET` | `/v1/status/:message_id` | Poll delivery status |
| `GET` | `/v1/health` | Liveness + capabilities (**not** a dependency check) |
| `GET` | `/` | Root info page |

⚠️ A 200 from `/v1/health` means the process is up and nothing more — it touches neither
SpacetimeDB nor the registry. Smoke-test the real path instead: `POST /v1/send` →
`202 delivered` → `GET /v1/status/{id}` → `delivered` with a non-null `channel_used`.

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

| File | Tests | Coverage |
|------|------|---------|
| `contracts/src/tests.rs` | 31 | Rule priority, default policy, blocklist, owner-only writes (`cargo test`) |
| `sdk/tests/envelope.test.ts` | 48 | createEnvelope, signEnvelope, verifyEnvelope, validateEnvelope |
| `sdk/tests/client.test.ts` | 28 | ChiClient — send, checkPermission, waitForAck |
| `sdk/tests/preferences.test.ts` | 25 | PreferencesManager — register, get, block/unblock |
| `sdk/tests/setup.ts` | — | Jest global setup |

**The router node has no automated tests** — integration is verified manually via curl.

⚠️ `cargo test` on zero tests prints `test result: ok`. The contract had no tests at all
until 2026-09-02 and reported success the whole time — check the count, not the colour.
The contract suite is mutation-checked: inverting the rule-priority tiers, making
`default_policy: Block` allow, or making the blocklist never match each fail 3–4 tests. If
you change consent logic and nothing goes red, the test you need does not exist yet.

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
  │                      │◄── allowed + rate_limit ─────│
  │                      │── count sends in window       (SpacetimeDB)
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

**EntityType** (`contracts/src/state.rs`, serialized verbatim): `CA` Conversational Agent, `LM` Language Model, `GN` Generative Model, `AA` Autonomous Agent, `RB` Robot, `DR` Drone, `VH` Vehicle, `US` Human User, `CP` Copilot, `HS` Hive/Swarm, plus `any` as the rule wildcard.

**Intent**: `class.action` on the wire (e.g. `inform.shipping_update`). The class — `inform`, `collect`, `authorize`, `escalate`, `result` — is what the registry stores and matches rules against; the action is sender-defined. A router queries the chain with the class alone.

**Channels**: `push`, `sms`, `email`, `webhook`, `in-app`, `agent-inbox` (the contract serializes the last two as `in_app` / `agent_inbox`).

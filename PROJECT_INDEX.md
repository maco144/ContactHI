# Project Index: ContactHI

Generated: 2026-03-14

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
│   └── spacetimedb-module/       # SpacetimeDB reducer module (Rust)
│       └── src/lib.rs            # Tables and reducers
├── sdk/                          # @contacthi/sdk (TypeScript)
│   └── src/
│       ├── client.ts             # ReachClient — main API
│       ├── envelope.ts           # Create/sign/verify CHI envelopes
│       ├── preferences.ts        # PreferencesManager
│       ├── did.ts                # DID utilities
│       ├── types.ts              # All TypeScript types
│       └── errors.ts             # Error classes
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
SpacetimeDB tables: **messages**, **acks**, **preference_cache**, **router_nodes**.
Reducers: `submit_message`, `update_ack`, `cache_preferences`, `register_node`, `expire_messages`.

---

## 🔧 Configuration

| File | Purpose |
|------|---------|
| `contracts/Cargo.toml` | Contract deps: cosmwasm-std 1.5, cw-storage-plus 1.2 |
| `router/router-node/package.json` | Router deps: express 4.18, @cosmjs/cosmwasm-stargate 0.32 |
| `router/router-node/Dockerfile` | Multi-stage Docker build (node:22-alpine) |
| `sdk/package.json` | SDK deps: @noble/ed25519 2.0, @cosmjs/cosmwasm-stargate 0.32 |
| `sdk/tsconfig.json` | TypeScript 5 config |

**Required env vars for router**: `REGISTRY_CONTRACT` (CosmWasm address)

**Optional env vars**: `PORT`, `NODE_ID`, `COSMOS_RPC`, `SPACETIMEDB_URL`, `SPACETIMEDB_DB`, `NULLCONE_URL`, `FCM_KEY`, `TWILIO_*`, `SMTP_*`

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

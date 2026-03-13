# CHI/1.0 Protocol Specification

**Status:** Draft
**Version:** 1.0.0-draft
**Date:** 2026-03-11
**Authors:** Rising Sun Protocol Working Group

---

## Abstract

CHI/1.0 is an open, asynchronous agent-to-human communication protocol for the agentic era. It defines a universal primitive for AI agents, autonomous systems, and hybrid entities to contact humans through a consent-first model: humans declare their reachability preferences on-chain before any agent may send a message. Agents must query those preferences and receive permission before initiating contact. No message is delivered unless the human's declared rules explicitly allow it.

CHI/1.0 is not a messaging application, not an inbox, and not a notification service. It is the protocol layer beneath all of the above — the DNS of human reachability.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Architecture Overview](#3-architecture-overview)
4. [Identity and DIDs](#4-identity-and-dids)
5. [Preference Registry](#5-preference-registry)
6. [Message Envelope](#6-message-envelope)
7. [Router Node Specification](#7-router-node-specification)
8. [Delivery Channels](#8-delivery-channels)
9. [Acknowledgment Protocol](#9-acknowledgment-protocol)
10. [Error Codes](#10-error-codes)
11. [Security Considerations](#11-security-considerations)
12. [Versioning and Extensibility](#12-versioning-and-extensibility)
13. [Appendix A: Entity Identity Type Codes](#appendix-a-entity-identity-type-codes)
14. [Appendix B: Reference Implementations](#appendix-b-reference-implementations)

---

## 1. Introduction

### 1.1 Background

AI agents are becoming first-class internet citizens. They book appointments, monitor accounts, execute trades, draft documents, and escalate decisions to humans when they reach the boundary of their authority. Every agent — from a simple automation to an advanced autonomous system — occasionally needs to reach a human.

Today, there is no standard for this. Agents send emails. They generate push notifications through proprietary SDKs. They POST to Slack webhooks. They place phone calls via Twilio. Each integration is ad-hoc, fragile, and — critically — decided by the agent's operator, not the human being contacted.

Left to market incumbents, agent-to-human communication defaults to opt-out. Platforms design for maximum reach, not human control. The result is an agentic spam crisis: a world where every AI system that touches a human's life also asserts the right to interrupt it.

### 1.2 Design Philosophy

CHI/1.0 is built on a single philosophical premise: **humans set the rules first**.

This inverts the incumbent model. Under CHI/1.0:

1. A human registers a preference profile on-chain, declaring which types of senders may contact them, through which channels, at what frequency, and during which time windows.
2. Before an agent sends any message, it must query the preference registry and receive an explicit permission grant.
3. If no preference profile exists for a recipient, the default policy is `BLOCK`. Opt-in, not opt-out.
4. Senders prove their type via zero-knowledge proofs using the Entity Identity system, so humans know what kind of entity is contacting them without the sender revealing its identity.

This design means the preference registry is not a feature — it is the protocol's security boundary.

### 1.3 Scope

This specification defines:

- DID formats for human recipients and agent senders
- The on-chain preference registry data model and query interface (CosmWasm)
- The CHI/1.0 message envelope format
- The router node API and routing behavior
- Delivery channel adapters and selection logic
- The acknowledgment protocol using SpacetimeDB
- Error codes and error handling
- Security requirements

This specification does not define:

- The user interface for managing preference profiles (implementation detail)
- The content policy of any specific router operator
- The business terms of channel providers (SMS, push, email)
- Agent behavior after receiving a `PERMISSION_DENIED` error

---

## 2. Terminology

**Human**: A natural person who has registered a ContactHI preference profile and wishes to be reachable by agents on their own terms.

**Sender**: Any entity submitting a CHI envelope. May be an AI agent, autonomous robot, enterprise software system, or human acting in a formal role. Senders are identified by DID and entity type.

**Router Node**: An infrastructure operator that accepts CHI envelopes, validates them, queries the preference registry, and routes to delivery channels.

**Preference Registry**: An on-chain CosmWasm smart contract storing human preference rules. The authoritative source of truth for all routing decisions.

**Entity Identity**: The ZK-based entity type verification system used by ContactHI to prove sender type without revealing sender identity. See [Entity Identity specification](https://github.com/maco144/entity-identity).

**DID**: Decentralized Identifier. A W3C standard for globally unique, cryptographically verifiable identifiers.

**Intent**: A semantic classification of why an agent is contacting a human. One of: `INFORM`, `COLLECT`, `AUTHORIZE`, `ESCALATE`, `RESULT`.

**Channel**: A delivery mechanism. One of: `push`, `sms`, `email`, `webhook`, `in-app`, `agent-inbox`.

**Ack**: Delivery or read acknowledgment, persisted to SpacetimeDB and queryable by the sender.

**TTL**: Time-to-live. The number of seconds after `created_at` during which a message may be delivered. After TTL expiry, the message is discarded.

**Nullcone**: The threat intelligence feed used by router nodes to check senders against known malicious actors. See [Nullcone specification](https://rising.sun/projects/nullcone).

---

## 3. Architecture Overview

CHI/1.0 defines three separable layers. Each layer can evolve independently. Implementors may choose to run all three layers, or integrate with existing operators for any layer.

```
┌─────────────────────────────────────────────────────────┐
│  LAYER 3 — DELIVERY                                     │
│  Channel Adapters: push / sms / email / webhook /       │
│  in-app / agent-inbox                                   │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  LAYER 2 — ROUTING                                      │
│  Federated Router Network                               │
│  - Envelope validation                                  │
│  - ZK proof verification                                │
│  - Preference registry query                            │
│  - Nullcone threat check                                │
│  - Channel selection and delivery                       │
│  - Ack write to SpacetimeDB                             │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  LAYER 1 — IDENTITY + PREFERENCES                       │
│  On-Chain (CosmWasm on Cosmos)                          │
│  - Human preference registry                            │
│  - Sender DID registry                                  │
│  - Entity Identity ZK verification                      │
└─────────────────────────────────────────────────────────┘
```

### 3.1 Data Flow

A CHI message follows this path:

```
Agent constructs envelope
        │
        ▼
Agent signs envelope with DID key
        │
        ▼
Agent POSTs to Router Node /v1/send
        │
        ▼
Router validates envelope signature
        │
        ▼
Router verifies Entity Identity ZK proof
        │
        ▼
Router queries Preference Registry:
  check_permission(sender_did, sender_type, recipient_did, intent)
        │
        ├─── BLOCK ──► Return PERMISSION_DENIED to sender
        │
        ├─── RATE_LIMITED ──► Return RATE_LIMIT_EXCEEDED to sender
        │
        └─── ALLOW (channel list, priority) ──►
                │
                ▼
        Router checks Nullcone threat feed
                │
                ├─── THREAT ──► Return SENDER_BLOCKLISTED to sender
                │
                └─── CLEAN ──►
                        │
                        ▼
                Router selects channel per intent rules
                        │
                        ▼
                Router delivers to channel adapter
                        │
                        ▼
                Router writes ack to SpacetimeDB
                        │
                        ▼
                Sender polls /v1/status/{message_id}
                  or subscribes to SpacetimeDB table
```

### 3.2 Federation Model

Any operator may run a router node. Router nodes are not coordinated by a central authority. They share state only through:

1. **Preference Registry** (on-chain, globally readable): All routers query the same Cosmos contract. No router can override a human's declared preferences.
2. **Ack fabric** (SpacetimeDB subscription tables): Routers write delivery acks to a shared SpacetimeDB instance, enabling senders to check delivery status regardless of which router handled routing.

There is no required peering between router nodes. A sender chooses which router to submit to. Competition between routers provides incentive for performance and reliability.

---

## 4. Identity and DIDs

### 4.1 Human DIDs

Human participants in the CHI protocol are identified by DIDs of the form:

```
did:chi:{cosmos-address}
```

Where `{cosmos-address}` is the bech32-encoded Cosmos address of the human's key. Example:

```
did:chi:cosmos1qnk2n4nlkpw9xfqntladh74er2xa62wqxn3mzr
```

The DID resolution method for `did:chi` is:

1. Extract the Cosmos address from the DID.
2. Query the CHI preference registry contract on-chain for the address.
3. Return the preference profile as the DID document, including any registered channel endpoints.

Human DIDs are self-sovereign. The private key associated with the Cosmos address is the sole authority for updating the preference profile.

### 4.2 Sender DIDs

Senders (AI agents, autonomous systems, enterprise software) are identified by a DID plus an Entity Identity type code:

```
did:chi:{cosmos-address}#{entity-type-code}
```

Example:
```
did:chi:cosmos1abc...def#AA
```

This identifies an Autonomous Agent (`AA`) at a specific on-chain address. The entity type code must match the ZK proof included in the message envelope.

### 4.3 Entity Identity Type Codes

ContactHI uses the Entity Identity type system. The full type registry is defined in the Entity Identity specification. The codes relevant to CHI senders are:

| Code | Phonetic | Category | Description |
|------|----------|----------|-------------|
| CA | Kah | AI | Conversational Agent |
| LM | Elm | AI | Language Model |
| GN | Jen | AI | Generative Model |
| AA | Ahh | AI | Autonomous Agent |
| RB | Rob | AR | Robot |
| DR | Dar | AR | Drone |
| VH | Vee | AR | Vehicle |
| US | Who | HU | Human User |
| CP | Kip | HY | Copilot (Human+AI) |
| HS | His | HY | Hive Swarm |

The wildcard `*` may be used in preference rules to match any sender type.

### 4.4 ZK Proof of Sender Type

Every CHI envelope includes a zero-knowledge proof that:

1. The sender possesses a valid Entity Identity attestation for the claimed type code.
2. The sender's DID key signed the attestation.

The proof does NOT reveal:
- The attester identity
- The sender's full DID (only the type code and a pseudonymous commitment are revealed)
- Any private metadata associated with the attestation

The proof format is a Groth16 zero-knowledge proof using the Entity Identity circuit. Proof size is approximately 200 bytes. Verification time at the router is approximately 10ms.

Router nodes MUST verify the ZK proof before querying the preference registry. A message with an invalid proof MUST be rejected with `SENDER_PROOF_INVALID`.

---

## 5. Preference Registry

### 5.1 Overview

The Preference Registry is a CosmWasm smart contract deployed on Cosmos. It is the on-chain source of truth for all human reachability preferences.

Any human with a Cosmos address may register a preference profile. The act of registering constitutes opt-in to the CHI protocol. An address with no registered profile is treated as BLOCK-all.

### 5.2 Data Model

#### HumanPreference

```rust
pub struct HumanPreference {
    /// Human's Cosmos address (also their DID)
    pub owner: Addr,

    /// Ordered list of rules. First matching rule wins.
    pub rules: Vec<PreferenceRule>,

    /// Default policy when no rule matches
    pub default_policy: Policy,  // Always BLOCK in v1.0

    /// Schema version for upgrades
    pub version: u32,

    /// Last update block height
    pub updated_at: u64,

    /// Registered delivery channel endpoints
    pub channels: Vec<ChannelEndpoint>,
}
```

#### PreferenceRule

```rust
pub struct PreferenceRule {
    /// Sender type to match. "*" matches any type.
    pub sender_type: String,

    /// Intent to match. "*" matches any intent.
    pub intent: Intent,

    /// If both sender_type and intent match, apply this policy.
    pub policy: Policy,

    /// Allowed delivery channels for this rule. Empty = all registered channels.
    pub allowed_channels: Vec<ChannelType>,

    /// Maximum messages per period. None = unlimited (within policy).
    pub rate_limit: Option<RateLimit>,

    /// Time window during which delivery is allowed (local time).
    /// None = any time.
    pub time_window: Option<TimeWindow>,

    /// Blocked sender patterns. DID prefixes or domain patterns.
    /// Messages from matching senders are blocked even if other fields match.
    pub blocklist: Vec<String>,
}
```

#### Supporting Types

```rust
pub enum Intent {
    Inform,
    Collect,
    Authorize,
    Escalate,
    Result,
}

pub enum Policy {
    Allow,
    Block,
}

pub enum ChannelType {
    Push,
    Sms,
    Email,
    Webhook,
    InApp,
    AgentInbox,
}

pub struct RateLimit {
    /// Maximum messages allowed in the period.
    pub max_messages: u32,

    /// Period in seconds.
    pub period_seconds: u64,
}

pub struct TimeWindow {
    /// Start time in HH:MM format (24h, human's local timezone).
    pub start: String,

    /// End time in HH:MM format (24h, human's local timezone).
    pub end: String,

    /// IANA timezone identifier, e.g. "America/New_York"
    pub timezone: String,
}

pub struct ChannelEndpoint {
    pub channel_type: ChannelType,

    /// Channel-specific endpoint. E.g. FCM token, phone number, email, webhook URL.
    pub endpoint: String,

    /// Whether this endpoint is currently active.
    pub active: bool,

    /// Encrypted with the human's DID key. Router nodes receive only the encrypted form.
    /// They decrypt using the human's public key (from DID document) + their own routing key.
    pub encrypted: bool,
}
```

### 5.3 Rule Matching

Rules are evaluated in order. The first rule whose `sender_type` and `intent` both match the incoming message is applied. If no rule matches, the `default_policy` (`BLOCK`) applies.

Matching semantics:

- `sender_type == "*"` matches any sender type code.
- `sender_type == "AA"` matches only Autonomous Agent senders.
- `intent == "*"` matches any intent.
- `intent == "ESCALATE"` matches only ESCALATE messages.
- If `blocklist` is non-empty and the sender DID or domain matches any pattern, the message is blocked regardless of the rule's policy.
- Rate limit checks are performed after rule matching. If the sender has exceeded the rate limit for this rule, `RATE_LIMIT_EXCEEDED` is returned.
- Time window checks are performed after rate limit checks. If the current time falls outside the window, the message is queued until the window opens (if TTL permits) or discarded.

### 5.4 Query Interface

The registry exposes a single primary query endpoint:

#### check_permission

```rust
pub struct CheckPermissionQuery {
    pub sender_did: String,
    pub sender_type: String,
    pub recipient_did: String,
    pub intent: Intent,
}

pub struct PermissionResult {
    pub allowed: bool,
    pub channels: Vec<ChannelType>,
    pub rate_limit_remaining: Option<u32>,
    pub next_window_open: Option<u64>,  // Unix timestamp if time-gated
    pub deny_reason: Option<DenyReason>,
}

pub enum DenyReason {
    NoProfile,
    DefaultBlock,
    RuleBlock,
    Blocklisted,
    RateLimitExceeded,
    OutsideTimeWindow,
}
```

#### get_channels

```rust
pub struct GetChannelsQuery {
    pub recipient_did: String,
}

pub struct ChannelsResult {
    pub channels: Vec<ChannelEndpoint>,
}
```

Routers call `get_channels` after `check_permission` returns `allowed: true` to retrieve the human's registered channel endpoints.

### 5.5 Execute Interface

The registry exposes the following execute endpoints (callable by the human only, signed by their DID key):

- `register_profile(rules, channels)` — Create initial preference profile.
- `update_rules(rules)` — Replace the entire rules array. Versioned; prev version is retained for audit.
- `add_channel(endpoint)` — Add a new channel endpoint.
- `remove_channel(channel_type, endpoint)` — Deactivate a channel endpoint.
- `set_blocklist(patterns)` — Update global blocklist patterns (applied before any rule matching).

### 5.6 Default Policy

In CHI/1.0, the `default_policy` field is always `BLOCK`. This is not configurable. The only way to receive messages via ContactHI is to create an explicit `Allow` rule.

Future protocol versions may introduce `default_policy: Allow` for users who prefer opt-out semantics, but v1.0 is strictly opt-in.

### 5.7 On-Chain Deployment

- **Runtime**: CosmWasm v1.x on Cosmos
- **Chain**: Cosmos chain TBD; testnet deployment first
- **Instantiation**: Permissioned instantiation by the ContactHI Foundation multisig; contract logic is open source
- **Upgrades**: Contract is upgradable via governance with 7-day timelock
- **State**: Append-only for audit purposes; old preference versions are retained with block height timestamps

---

## 6. Message Envelope

### 6.1 Envelope Format

A CHI/1.0 message is a JSON object. All fields are required unless marked optional.

```json
{
  "chi": "1.0",
  "id": "<uuid-v4>",
  "sender": {
    "did": "did:chi:<cosmos-address>",
    "type": "<EntityIdentityCode>",
    "proof": "<groth16-proof-hex>"
  },
  "recipient": {
    "did": "did:chi:<cosmos-address>"
  },
  "intent": "INFORM|COLLECT|AUTHORIZE|ESCALATE|RESULT",
  "priority": 0,
  "ttl": 3600,
  "payload": {
    "type": "text|voice|document|structured",
    "content": "<string or base64-encoded bytes>",
    "transcript": "<string, auto-populated for voice>",
    "mime_type": "<optional, e.g. application/json>"
  },
  "reply_to": "<uuid-v4 of original message, optional>",
  "created_at": "<ISO8601 datetime with timezone>",
  "signature": "<ed25519-signature-hex>"
}
```

### 6.2 Field Definitions

#### reach
Protocol version string. MUST be `"1.0"` for this version of the specification. Routers MUST reject envelopes with unknown version strings.

#### id
A UUID v4 string, generated by the sender. Must be globally unique. Used for deduplication, ack tracking, and reply threading.

#### sender.did
The sender's ContactHI DID. Format: `did:chi:{cosmos-address}`.

#### sender.type
Entity Identity type code. MUST be one of the codes defined in Section 4.3. Case-sensitive.

#### sender.proof
Hexadecimal-encoded Groth16 zero-knowledge proof generated by the Entity Identity circuit. Proves that the sender holds a valid attestation for the claimed `sender.type` without revealing the sender's identity. Approximately 200 bytes (400 hex characters).

#### recipient.did
The recipient's ContactHI DID.

#### intent
Semantic classification of the message. See Section 6.3 for semantics.

#### priority
Integer 0–3 indicating urgency. See Section 6.4 for semantics.

#### ttl
Integer seconds. Maximum age of the message before it is considered expired. Measured from `created_at`. A router that cannot deliver within TTL MUST discard the message and return `TTL_EXPIRED`. Minimum value: 60. Maximum value: 604800 (7 days). Recommended default: 3600 (1 hour).

#### payload.type
One of: `text`, `voice`, `document`, `structured`.

- `text`: Human-readable text content.
- `voice`: Audio content, base64-encoded. `transcript` field SHOULD be populated automatically by the sending agent.
- `document`: Binary document, base64-encoded. `mime_type` MUST be set.
- `structured`: Structured data for programmatic consumption. `mime_type` MUST be set (e.g., `application/json`).

#### payload.content
The message content. For `text` intent, a UTF-8 string. For `voice` and `document`, base64-encoded binary. For `structured`, a base64-encoded JSON/binary payload.

#### payload.transcript
Optional. For `voice` payloads, a human-readable transcript automatically generated by the sending agent. Delivery channels that cannot deliver audio SHOULD fall back to delivering the transcript.

#### payload.mime_type
Optional. MIME type of the payload content. Required for `document` and `structured` types.

#### reply_to
Optional. If present, the UUID of the original message this envelope is responding to. Used to thread RESULT intents back to their originating COLLECT or AUTHORIZE.

#### created_at
ISO 8601 datetime with timezone offset. Example: `"2026-03-11T14:23:00Z"`. Used for TTL calculation and ordering.

#### signature
Ed25519 signature over the canonical JSON serialization of the envelope (all fields except `signature` itself), hex-encoded. The signing key MUST correspond to the Cosmos address in `sender.did`. Routers MUST verify this signature.

### 6.3 Intent Semantics

| Intent | Code | Description | Response Expected |
|--------|------|-------------|-------------------|
| INFORM | 0 | Informational notification. No action required from the human. | No |
| COLLECT | 1 | The agent needs data or input from the human. | Yes |
| AUTHORIZE | 2 | The agent needs explicit human approval before proceeding. Blocking — the agent halts until a response arrives. | Yes (required) |
| ESCALATE | 3 | The agent has reached a decision boundary it cannot cross. Human judgment required. | Yes (required) |
| RESULT | 4 | Delivery of a result the human previously requested. Completes a prior COLLECT or AUTHORIZE interaction. | No |

Delivery channel selection MUST respect intent semantics:
- `AUTHORIZE` and `ESCALATE` MUST be delivered via `push` or `sms` if those channels are available and permitted. Email is acceptable only if push and sms are unavailable.
- `INFORM` and `RESULT` may be delivered via any permitted channel.
- `COLLECT` prefers `push` or `in-app` but may use any permitted channel.

### 6.4 Priority Levels

| Priority | Label | Behavior |
|----------|-------|----------|
| 0 | Background | Deliver when convenient. May be batched. Does not wake device from DND. |
| 1 | Normal | Deliver promptly. Standard notification behavior. |
| 2 | Urgent | Deliver immediately. May wake device from DND per channel capabilities. |
| 3 | Critical | Override all human preferences except hard blocklist entries. Deliver via all available channels simultaneously. Reserved for genuine safety emergencies. |

Priority 3 (Critical) is intentionally a last resort. Senders that abuse Priority 3 will be flagged in the Nullcone threat feed and blocked by all routers.

### 6.5 Envelope Size Limits

| Field | Maximum Size |
|-------|-------------|
| payload.content | 1 MB |
| payload.transcript | 64 KB |
| id | 36 bytes (UUID) |
| sender.proof | 1 KB |
| Entire envelope | 1.1 MB |

Routers MUST reject envelopes exceeding these limits with HTTP 413.

### 6.6 Canonical Serialization

The canonical serialization for signature verification is the JSON envelope with all fields in alphabetical key order at every nesting level, no whitespace, and the `signature` field omitted. This is the byte string that MUST be signed by the sender and verified by the router.

---

## 7. Router Node Specification

### 7.1 Overview

A router node is an infrastructure operator that accepts CHI envelopes, validates them against the preference registry, and routes to the human's registered delivery channels. Any party may operate a router node. There is no central registration; senders choose which router to submit to.

### 7.2 Router Responsibilities

In order, a router node MUST:

1. **Validate envelope structure**: Verify all required fields are present and correctly typed.
2. **Check envelope size**: Reject oversized envelopes with HTTP 413.
3. **Verify sender signature**: Verify the Ed25519 signature in `signature` against the canonical serialization.
4. **Verify ZK proof**: Verify `sender.proof` using the Entity Identity verifier contract (or local verifier). Reject with `SENDER_PROOF_INVALID` if invalid.
5. **Check TTL**: If `created_at + ttl < now`, discard with `TTL_EXPIRED`.
6. **Query preference registry**: Call `check_permission(sender_did, sender_type, recipient_did, intent)` on-chain.
7. **Evaluate permission result**: If `allowed: false`, return appropriate error code.
8. **Check Nullcone threat feed**: Query the Nullcone feed for `sender.did` and sender IP. If a threat match is found, reject with `SENDER_BLOCKLISTED`.
9. **Apply rate limits**: Enforce `rate_limit_remaining` from the permission result. Track per-sender, per-recipient counters locally (backed up on-chain state for cross-router consistency).
10. **Get channel endpoints**: Call `get_channels(recipient_did)` to retrieve registered endpoints.
11. **Select channel**: Apply channel selection logic (see Section 8.3).
12. **Deliver to channel adapter**: Pass the message to the appropriate channel adapter.
13. **Write ack to SpacetimeDB**: Record delivery status in the shared ack table.

### 7.3 HTTP API

#### POST /v1/send

Submit a CHI envelope for delivery.

**Request:**
```
Content-Type: application/json
Authorization: Bearer <sender-api-key>
```

Body: The CHI/1.0 message envelope (see Section 6.1).

**Response (202 Accepted):**
```json
{
  "message_id": "<uuid>",
  "status": "accepted",
  "estimated_delivery": "<ISO8601 datetime or null>"
}
```

**Response (4xx/5xx):**
```json
{
  "error": "<ErrorCode>",
  "message": "<human-readable description>",
  "retry_after": "<seconds, if rate-limited>"
}
```

The sender API key is used for router-level authentication (not to be confused with the sender's DID key used for envelope signing). Routers may require API key registration; this is an operator policy decision.

#### GET /v1/status/{message_id}

Check the delivery status of a previously submitted message.

**Response (200 OK):**
```json
{
  "message_id": "<uuid>",
  "status": "accepted|delivered|read|responded|expired|failed",
  "channel_used": "push|sms|email|webhook|in-app|agent-inbox|null",
  "delivered_at": "<ISO8601 datetime or null>",
  "read_at": "<ISO8601 datetime or null>",
  "responded_at": "<ISO8601 datetime or null>",
  "error": "<ErrorCode or null>"
}
```

**Response (404 Not Found):** If the message ID is unknown to this router.

#### GET /v1/health

Router health check.

**Response (200 OK):**
```json
{
  "status": "ok",
  "version": "1.0",
  "registry_reachable": true,
  "spacetimedb_connected": true,
  "nullcone_feed_fresh": true,
  "uptime_seconds": 86400
}
```

### 7.4 Federation via SpacetimeDB

Router nodes share ack state via SpacetimeDB subscription tables. This allows senders to check delivery status through any router, not just the one they submitted to.

**Ack Table Schema (SpacetimeDB):**

```rust
#[spacetimedb(table)]
pub struct MessageAck {
    #[primarykey]
    pub message_id: String,

    pub recipient_did: String,
    pub sender_did: String,
    pub status: AckStatus,
    pub channel_used: Option<ChannelType>,
    pub delivered_at: Option<Timestamp>,
    pub read_at: Option<Timestamp>,
    pub responded_at: Option<Timestamp>,
    pub router_node_id: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

pub enum AckStatus {
    Accepted,
    Delivered,
    Read,
    Responded,
    Expired,
    Failed,
}
```

Routers write to this table:
- When a message is accepted (status: `Accepted`)
- When delivery to a channel adapter succeeds (status: `Delivered`)
- When the channel adapter reports a read receipt (status: `Read`)
- When a response is received and routed back (status: `Responded`)
- When TTL expires before delivery (status: `Expired`)
- When delivery fails after all retries (status: `Failed`)

Routers subscribe to this table to avoid duplicate delivery if a message is submitted to multiple routers.

### 7.5 Rate Limit Enforcement

Routers enforce rate limits from the `rate_limit_remaining` field in `PermissionResult`. Local counters are maintained per (sender_did, recipient_did, rule_id) tuple. Counters are persisted to avoid reset on router restart.

When a message would exceed a rate limit:
- Return `RATE_LIMIT_EXCEEDED` immediately.
- Include `retry_after` in the error response, set to when the next period begins.

### 7.6 Message Routing and Retry

If a delivery channel adapter fails transiently (network error, channel unavailable):
- Retry up to 3 times with exponential backoff: 30s, 2min, 10min.
- If TTL would expire before the next retry, discard and write `Expired` ack.
- If all retries are exhausted, try the next permitted channel (if any).
- If no channels succeed, write `Failed` ack and notify sender via status endpoint.

### 7.7 Stateless Content Handling

Routers MUST NOT store message content. The envelope payload is held in memory only for the duration of delivery. After writing the ack, the payload is discarded. Routers store only message IDs, status, and metadata in the ack table.

---

## 8. Delivery Channels

### 8.1 Channel Overview

| Channel | Type | Description | Capabilities |
|---------|------|-------------|--------------|
| push | Mobile/Desktop | FCM (Android) or APNs (iOS/macOS) push notification | Rich notifications, badge, wake-from-DND |
| sms | Mobile | SMS via carrier (Twilio, Vonage, or direct) | Text only, universal reach |
| email | Internet | SMTP or email API (SendGrid, Postmark, etc.) | Rich HTML, attachments |
| webhook | Internet | HTTP POST to registered URL | Full envelope payload, for integrations |
| in-app | Application | In-app notification for CHI-native applications | Rich UI, inline response |
| agent-inbox | Programmatic | Structured delivery to agent recipients | Machine-readable, no human rendering |

### 8.2 Channel Registration

Humans register channel endpoints in their preference profile via `add_channel`. Channel endpoints are stored encrypted with the human's DID key so only they (and routers with delegation) can read them.

Channel endpoint formats:

| Channel | Endpoint Format |
|---------|----------------|
| push | FCM registration token or APNs device token + bundle ID |
| sms | E.164 phone number, e.g. `+14155552671` |
| email | RFC 5322 email address |
| webhook | HTTPS URL |
| in-app | Application-specific token (defined by app) |
| agent-inbox | Agent endpoint URL or DID |

### 8.3 Channel Selection Logic

The router selects among permitted channels using the following priority matrix:

| Intent | Preferred Channels (in order) |
|--------|-------------------------------|
| INFORM | in-app > push > email > webhook > sms |
| COLLECT | push > in-app > sms > email > webhook |
| AUTHORIZE | push > sms > in-app > email > webhook |
| ESCALATE | push > sms > in-app > email > webhook |
| RESULT | in-app > push > webhook > email > sms |

The router evaluates this priority order against the channels permitted by the matching preference rule. The first permitted channel in the list is used.

For `AUTHORIZE` and `ESCALATE` intents at `priority >= 2`, routers MUST attempt `push` and `sms` before any other channel.

### 8.4 Channel Adapter Requirements

Each channel adapter MUST:

1. Accept the CHI message envelope.
2. Render the payload appropriately for the channel (plain text for SMS, formatted notification for push, etc.).
3. Handle voice payloads by falling back to `transcript` if the channel cannot deliver audio.
4. Report delivery success or failure back to the router.
5. Report read receipts if the channel supports them (push on supported platforms, in-app).

### 8.5 Push Channel Adapter

Uses Firebase Cloud Messaging (FCM) for Android and Apple Push Notification service (APNs) for iOS/macOS.

- **Title**: Derived from intent type and sender type code.
  - Example: `"Authorization Request from AA"` for AUTHORIZE intent from an Autonomous Agent.
- **Body**: `payload.content` truncated to 256 characters. Full content available in notification data.
- **Badge**: Increment unread count.
- **Category**: Intent type (enables system-level filtering).
- **DND override**: Set `priority: "high"` in FCM / `apns-priority: 10` in APNs for `priority >= 2`.

### 8.6 SMS Channel Adapter

Uses a carrier SMS API. SMS payloads are plain text only.

- Maximum 1600 characters (multi-part SMS concatenation).
- For `COLLECT`/`AUTHORIZE`/`ESCALATE`, append a response URL:
  `"Reply at: https://chi.example.com/r/{message_id}"`
- Voice payloads fall back to `transcript`.

### 8.7 Webhook Channel Adapter

POSTs the full CHI/1.0 envelope as the request body to the registered URL.

- Content-Type: `application/json`
- Includes `X-CHI-Signature` header: HMAC-SHA256 of the body using a shared secret configured during webhook registration.
- Expects HTTP 2xx response within 30 seconds.
- On non-2xx response, retry per router retry policy.

---

## 9. Acknowledgment Protocol

### 9.1 Delivery Acknowledgment

A delivery ack is written to SpacetimeDB by the router when:
- A message is accepted by the router (status: `Accepted`).
- The channel adapter reports successful delivery (status: `Delivered`).

Delivery does not mean the human has read the message. It means the message has reached the channel.

### 9.2 Read Acknowledgment

A read ack is optional. It is emitted by the client application when the human opens or views the message. Read acks are supported on:
- `push`: Via APNs silent push callback or FCM delivery receipt.
- `in-app`: Via client SDK event.

Channels that cannot report read receipts (SMS, email, webhook) will not generate read acks. The ack record for these channels will remain at `Delivered`.

### 9.3 Response Envelope

When a human responds to a `COLLECT`, `AUTHORIZE`, or `ESCALATE` message, the response is a new CHI/1.0 envelope with:

- `intent`: `RESULT`
- `reply_to`: The `id` of the original message.
- `sender`: The human's DID (with type code `US`) and Entity Identity proof.
- `recipient`: The original sender's DID.
- `payload`: The human's response content.

The response envelope follows the same routing flow as any other CHI message, in reverse. The original agent receives the response via their registered `agent-inbox` channel (or whichever channel they have registered).

### 9.4 Response Time Expectations

Agents MUST handle response timeouts gracefully. If a response is not received before the original message's TTL, the agent SHOULD treat the interaction as expired and not re-send without a new explicit trigger.

Agents MUST NOT flood humans with repeated COLLECT or AUTHORIZE messages. Repeated messages with the same semantic intent within a short window MUST be deduplicated and combined, or the agent must wait for explicit human action.

### 9.5 Ack Query Interface

Senders may query ack status via:

1. **Router HTTP API**: `GET /v1/status/{message_id}` — available on the submitting router.
2. **SpacetimeDB subscription**: Subscribe to the `MessageAck` table filtered by `sender_did` for real-time status updates from any router.

---

## 10. Error Codes

All error codes are returned as strings in the `error` field of error responses.

| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `PERMISSION_DENIED` | 403 | The preference registry explicitly blocks this sender/intent combination. |
| `RECIPIENT_NOT_FOUND` | 404 | No preference profile exists for the recipient DID. Under default policy, this is equivalent to BLOCK-all. |
| `SENDER_PROOF_INVALID` | 400 | The ZK proof in `sender.proof` failed verification. The sender cannot prove their claimed entity type. |
| `SENDER_BLOCKLISTED` | 403 | The sender's DID or IP appears in the Nullcone threat feed. |
| `RATE_LIMIT_EXCEEDED` | 429 | The sender has exceeded the rate limit configured by the recipient for this rule. Includes `retry_after` field. |
| `TTL_EXPIRED` | 400 | The message TTL elapsed before delivery was possible. |
| `CHANNEL_UNAVAILABLE` | 503 | No permitted delivery channel is currently available or reachable. |
| `ENVELOPE_INVALID` | 400 | The envelope is missing required fields or has malformed values. |
| `SIGNATURE_INVALID` | 400 | The `signature` field does not verify against the envelope content. |
| `ENVELOPE_TOO_LARGE` | 413 | The envelope exceeds size limits defined in Section 6.5. |
| `VERSION_UNSUPPORTED` | 400 | The `chi` field specifies a version this router does not support. |
| `REGISTRY_UNAVAILABLE` | 503 | The preference registry could not be queried (chain connectivity issue). Router MUST NOT route without a registry check. |
| `ROUTER_INTERNAL_ERROR` | 500 | An internal router error occurred. The sender should retry on a different router. |

---

## 11. Security Considerations

### 11.1 Envelope Integrity

Every CHI envelope is signed by the sender's DID key using Ed25519. Routers MUST verify this signature before processing. An unverified envelope MUST NOT be delivered to any channel or queried against the preference registry.

Sender API keys (used for router authentication) are separate from DID keys (used for envelope signing). Compromise of a sender API key does not compromise envelope signing.

### 11.2 Zero-Knowledge Sender Privacy

The ZK proof in `sender.proof` allows the human recipient to know the sender's entity type (e.g., `AA` for Autonomous Agent) without learning the sender's actual identity or DID. This provides a trust primitive without sacrificing sender privacy.

The router learns the sender's DID (because the sender authenticated to the router), but the router does not share this with the recipient. The recipient sees only the type code and pseudonymous commitment from the ZK proof.

### 11.3 Preference Registry as Security Boundary

The preference registry is the core security guarantee of ContactHI. Routers MUST query the registry before routing. A router that routes without a registry check is non-conformant and should be treated as untrusted by senders and recipients.

If the registry is unavailable (chain connectivity issue), routers MUST return `REGISTRY_UNAVAILABLE` and MUST NOT fall back to a default-allow policy.

### 11.4 Nullcone Threat Intelligence

Router operators integrate with the Nullcone threat feed to block known malicious actors. Nullcone provides:

- DID-based blocklists for known abusive senders.
- IP-based blocklists for known attack sources.
- AI-native IOC types: PROMPT injection payloads and SKILL abuse patterns.

Nullcone feed updates are near-real-time via SpacetimeDB subscription. Routers that cannot reach the Nullcone feed SHOULD log a warning but MAY continue routing (unlike registry unavailability, which is a hard block).

### 11.5 Channel Endpoint Encryption

Human channel endpoints (phone numbers, push tokens, webhook URLs, email addresses) are sensitive. They are stored encrypted in the preference registry using the human's DID-derived public key. Routers receive only the encrypted endpoints and must decrypt using a shared routing key established during router registration.

This means a compromised router cannot leak a human's phone number or push token in plaintext form.

### 11.6 Content Privacy

Routers are stateless with respect to message content. The payload is never written to persistent storage by the router. After delivery, the payload is discarded. Only the message ID, status, channel used, and timestamps are written to SpacetimeDB.

The SpacetimeDB ack table contains no message content — only metadata sufficient for delivery tracking.

### 11.7 Replay Attacks

Each envelope has a globally unique `id`. Routers MUST cache recently processed message IDs for at least 2× the maximum TTL (14 days) and reject duplicate submissions with the same ID. The `created_at` field provides additional replay protection: envelopes with `created_at` more than 5 minutes in the future MUST be rejected.

### 11.8 Priority 3 Abuse

Priority 3 (Critical) overrides human preferences. This is an intentional escape hatch for genuine emergencies (e.g., a safety system alerting a human to a physical hazard). Abuse of Priority 3 is a protocol violation.

Routers MUST monitor Priority 3 usage per sender DID. Senders that submit more than 5 Priority 3 messages per 24 hours SHOULD be flagged and reported to Nullcone. Recipients have an explicit mechanism to block all Priority 3 messages from specific senders via the hard blocklist.

### 11.9 Denial of Service

Routers are potential DDoS targets due to their public HTTP API. Recommended mitigations:

- Rate limit all unauthenticated requests at the infrastructure layer.
- Require sender API key authentication for `/v1/send`.
- Implement proof-of-work challenge for API key registration (to raise the cost of creating throwaway sender accounts).
- Share DDoS source intelligence via Nullcone.

---

## 12. Versioning and Extensibility

### 12.1 Protocol Versioning

The `chi` field in the envelope identifies the protocol version. The version string follows semver major.minor format (e.g., `"1.0"`, `"1.1"`, `"2.0"`).

Routers MUST implement the version they advertise in `/v1/health`. Routers MUST reject envelopes with unknown version strings with `VERSION_UNSUPPORTED`. Routers MUST NOT silently process an unrecognized version.

### 12.2 Minor Version Updates

Minor version bumps (1.0 → 1.1) indicate backward-compatible additions:
- New optional fields may be added to the envelope.
- New channel types may be added.
- New intent types may be added.
- New error codes may be added.

Routers that have not implemented a minor update SHOULD process envelopes at that minor version by ignoring unknown fields (see Section 12.3).

### 12.3 Forward Compatibility

Unknown fields in the envelope MUST be ignored by routers, not rejected. This allows senders to include extension fields that will be used by future router versions while remaining compatible with current routers.

Unknown channel types in preference rules MUST be treated as unavailable (not as errors).

### 12.4 Major Version Updates

Major version bumps (1.x → 2.0) may introduce breaking changes. Routers MUST NOT attempt to process a major version they do not implement. Senders SHOULD check `/v1/health` to verify a router's supported versions before submission.

---

## Appendix A: Entity Identity Type Codes

Full type codes from the Entity Identity specification, included here for reference.

### AI Category (0x01xx)

| Code | Phonetic | Full Name | Description |
|------|----------|-----------|-------------|
| CA | Kah | Conversational Agent | Interactive dialogue systems, chatbots |
| LM | Elm | Language Model | Large language model inference endpoints |
| GN | Jen | Generative Model | Image, audio, video generation systems |
| AA | Ahh | Autonomous Agent | Goal-directed agents with tool use |
| MC | Mock | Multi-agent Coordinator | Orchestration and routing agents |
| AN | Ann | Analytical System | Data analysis and reasoning systems |
| DP | Deep | Deep Learning System | Neural network inference systems |
| RL | Rail | Reinforcement Learning | RL-trained decision systems |

### AR Category (0x02xx) — Autonomous Robotics

| Code | Phonetic | Full Name | Description |
|------|----------|-----------|-------------|
| RB | Rob | Robot | Physical robotic systems |
| DR | Dar | Drone | Aerial autonomous systems |
| VH | Vee | Vehicle | Autonomous ground vehicles |

### HU Category (0x03xx) — Human

| Code | Phonetic | Full Name | Description |
|------|----------|-----------|-------------|
| US | Who | Human User | Natural person acting independently |

### HY Category (0x04xx) — Hybrid

| Code | Phonetic | Full Name | Description |
|------|----------|-----------|-------------|
| CP | Kip | Copilot | Human operator with AI assistance |
| HS | His | Hive Swarm | Collective of AI agents acting as a unit |

---

## Appendix B: Reference Implementations

The following reference implementations are planned:

### TypeScript SDK (Open Source)

- Envelope construction and signing
- ZK proof generation via Entity Identity
- Router client (submit, status, subscribe)
- Preference registry client (register, update rules, add channels)

**Repository**: `https://github.com/maco144/contacthi-sdk-ts` (planned)

### Python SDK (Open Source)

- Envelope construction and signing
- Router client
- Preference registry read client

**Repository**: `https://github.com/maco144/contacthi-sdk-py` (planned)

### Router Node Reference Implementation

- Rust-based router node
- Full compliance with Section 7
- SpacetimeDB integration for ack fabric
- All six channel adapters

**Repository**: `https://github.com/maco144/contacthi-router` (planned)

### CosmWasm Preference Registry

- Rust CosmWasm contract
- Full preference rule engine
- Channel endpoint encryption

**Repository**: `https://github.com/maco144/contacthi-registry` (planned)

---

## Appendix C: Example Interaction Flow

### AUTHORIZE Flow — Agent Requesting Expense Approval

```
1. Enterprise AI agent (type: AA) builds CHI envelope:
   - intent: AUTHORIZE
   - priority: 1
   - payload: "Approve $12,400 purchase order for AWS reserved instances?"
   - ttl: 7200 (2 hours)

2. Agent submits to router node.

3. Router verifies signature and ZK proof (AA type confirmed).

4. Router queries preference registry:
   check_permission(
     sender_did: "did:chi:cosmos1aa...",
     sender_type: "AA",
     recipient_did: "did:chi:cosmos1hr...",
     intent: AUTHORIZE
   )

   Registry evaluates rules:
   - Rule 1: sender_type=AA, intent=AUTHORIZE, policy=Allow,
             channels=[push,sms], rate_limit=10/day, time_window=09:00-22:00
   - Current time: 14:30 — within window
   - Rate limit: 3 of 10 used today — OK
   - Result: ALLOW, channels=[push,sms]

5. Router checks Nullcone — sender clean.

6. Router selects push (preferred for AUTHORIZE).

7. Router delivers push notification to human's iPhone.
   Title: "Authorization Request from AA"
   Body: "Approve $12,400 purchase order for AWS reserved instances?"

8. Router writes ack: { message_id, status: Delivered, channel: push }

9. Human taps "Approve" in notification.

10. Human's device constructs RESULT envelope:
    - intent: RESULT
    - reply_to: <original message_id>
    - payload: '{"decision": "approved", "notes": "within Q1 budget"}'
    - sender.type: US

11. RESULT envelope routes back to agent via agent-inbox.

12. Agent receives approval, executes purchase order.
```

### INFORM Flow — Agent Completing Background Task

```
1. Data pipeline agent (type: AA) builds CHI envelope:
   - intent: INFORM
   - priority: 0
   - payload: "Monthly report generated. 847MB CSV ready in /reports/march-2026.csv"
   - ttl: 86400 (24 hours)

2. Router routes per preference rules.
   Rule for INFORM from AA: Allow, channel=[email], no time window.

3. Router delivers via email adapter.

4. Human receives email at their registered address.

5. No response required. Interaction complete.
```

---

*CHI/1.0 is an open protocol specification. Implementations, improvements, and extensions are welcomed under the [Apache 2.0 License](https://apache.org/licenses/LICENSE-2.0). For protocol governance, see the ContactHI Foundation charter.*

*This specification was drafted by the Rising Sun Protocol Working Group. Rising Sun builds technology for an internet where users are safe, AIs are allies, and power is decentralized.*

# ContactHI Router Node

The reference implementation of a CHI/1.0 router node. A router node is the infrastructure layer of the ContactHI protocol — it accepts message envelopes from senders, validates them against on-chain recipient preferences, checks the Nullcone threat feed, delivers to the recipient's preferred channel, and writes delivery acknowledgements to a shared SpacetimeDB instance.

## What a Router Node Does

```
Sender → [POST /v1/send] → Router Node
                              │
                              ├── 1. Validate envelope (structure, TTL, version)
                              ├── 2. Check CosmWasm preference registry
                              │       "Is this sender allowed to contact this recipient?"
                              ├── 3. Check Nullcone threat feed
                              │       "Is this sender known-malicious?"
                              ├── 4. Write message to SpacetimeDB
                              ├── 5. Deliver via allowed channels (push / sms / email / webhook / agent-inbox)
                              └── 6. Write delivery ack to SpacetimeDB
```

Router nodes are stateless with respect to message storage — all durable state lives in SpacetimeDB. Multiple router nodes can run in parallel; they share the same SpacetimeDB database and coordinate via the `router_nodes` table heartbeat.

## Running Locally

### Prerequisites

- Node.js 20+
- A running SpacetimeDB instance (or the hosted cloud version)

### Install and start

```bash
npm install
npm run dev
```

The server starts on port 3001 by default.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP port to listen on |
| `NODE_ID` | `contacthi-node-local` | Unique name for this node in the federation |
| `NODE_ENDPOINT_URL` | `http://localhost:3001` | Public URL of this node (reported to federation) |
| `COSMOS_RPC` | `https://rpc.cosmos.directory/cosmoshub` | CosmWasm RPC endpoint |
| `REGISTRY_CONTRACT` | _(required)_ | Bech32 address of the preference registry contract |
| `SPACETIMEDB_URL` | `http://localhost:3000` | SpacetimeDB server URL |
| `SPACETIMEDB_DB` | `contacthi` | SpacetimeDB database name |
| `NULLCONE_URL` | `https://nullcone.example.com` | Nullcone threat feed API base URL |
| `FCM_KEY` | _(optional)_ | Firebase Cloud Messaging server key (enables push) |
| `TWILIO_ACCOUNT_SID` | _(optional)_ | Twilio account SID (enables SMS) |
| `TWILIO_AUTH_TOKEN` | _(optional)_ | Twilio auth token |
| `TWILIO_FROM` | _(optional)_ | Twilio sender phone number |
| `SMTP_HOST` | _(optional)_ | SMTP server hostname (enables email) |
| `SMTP_USER` | _(optional)_ | SMTP username |
| `SMTP_PASS` | _(optional)_ | SMTP password |

### Docker one-liner

```bash
docker run -d \
  --name contacthi-router \
  -p 3001:3001 \
  -e NODE_ID=my-router-1 \
  -e REGISTRY_CONTRACT=cosmos1abc...xyz \
  -e SPACETIMEDB_URL=http://spacetimedb:3000 \
  -e NULLCONE_URL=https://nullcone.example.com \
  contacthi/router-node:latest
```

Or with docker compose:

```yaml
services:
  router:
    image: contacthi/router-node:latest
    ports:
      - "3001:3001"
    environment:
      NODE_ID: my-router-1
      REGISTRY_CONTRACT: cosmos1abc...xyz
      SPACETIMEDB_URL: http://spacetimedb:3000
      SPACETIMEDB_DB: contacthi
      NULLCONE_URL: https://nullcone.example.com
```

## API Reference

### POST /v1/send

Submit a CHI/1.0 message envelope for delivery.

**Request body:**

```json
{
  "version": "1.0",
  "message_id": "msg_01HZ4K8MNPQ2R3T7UVWXY",
  "sender_did": "did:chi:cosmoshub-4:cosmos1sendersaddress",
  "sender_type": "human",
  "recipient_did": "did:chi:cosmoshub-4:cosmos1recipientaddress",
  "intent": "message.send",
  "priority": 128,
  "ttl_seconds": 3600,
  "payload_type": "text/plain",
  "payload": "Hey, wanted to check in about the proposal.",
  "created_at": 1741651200000
}
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | `"1.0"` | yes | Protocol version. Must be `"1.0"`. |
| `message_id` | string | yes | Globally unique message ID (UUID or ULID recommended) |
| `sender_did` | string | yes | DID of the sender (must start with `did:`) |
| `sender_type` | string | yes | Entity type: `human`, `agent`, `service`, `device`, or `dao` |
| `recipient_did` | string | yes | DID of the recipient |
| `intent` | string | yes | Namespaced intent: `namespace.action` (e.g. `message.send`, `payment.request`) |
| `priority` | integer | no | 0–255. Higher = more urgent. Default 128. |
| `ttl_seconds` | integer | yes | Message time-to-live. Max 604800 (7 days). |
| `payload_type` | string | yes | MIME-style descriptor: `text/plain`, `application/json`, etc. |
| `payload` | any | yes | The message content. Shape is defined by `payload_type`. |
| `created_at` | integer | yes | Unix timestamp in milliseconds when the message was created. |
| `signature` | string | no | Base64-encoded sender signature. Optional in CHI/1.0; required in 1.1. |

**Responses:**

`202 Accepted` — Message delivered:
```json
{
  "message_id": "msg_01HZ4K8MNPQ2R3T7UVWXY",
  "status": "delivered",
  "channel": "agent-inbox"
}
```

`202 Accepted` — Message accepted but delivery pending (retry via status endpoint):
```json
{
  "message_id": "msg_01HZ4K8MNPQ2R3T7UVWXY",
  "status": "pending",
  "note": "Message recorded; delivery will be retried",
  "delivery_error": "NO_FCM_TOKEN"
}
```

`400 Bad Request` — Validation failure:
```json
{
  "error": "INVALID_INTENT",
  "message": "intent must match pattern \"namespace.action\" (e.g. \"message.send\")."
}
```

`403 Forbidden` — Permission denied by recipient's on-chain preferences:
```json
{
  "error": "PERMISSION_DENIED",
  "reason": "DEFAULT_BLOCK",
  "message_id": "msg_01HZ4K8MNPQ2R3T7UVWXY"
}
```

`403 Forbidden` — Sender is on the Nullcone blocklist:
```json
{
  "error": "SENDER_BLOCKLISTED",
  "reason": "Known spam operation",
  "threat_level": "high",
  "message_id": "msg_01HZ4K8MNPQ2R3T7UVWXY"
}
```

`429 Too Many Requests` — Rate limit exceeded:
```json
{
  "error": "RATE_LIMITED",
  "message": "Too many requests. Limit is 200 per minute.",
  "retry_after_seconds": 42
}
```

---

### GET /v1/status/:message_id

Poll the delivery status of a message. Reads from the SpacetimeDB `acks` table.

**Response:**

```json
{
  "message_id": "msg_01HZ4K8MNPQ2R3T7UVWXY",
  "status": "delivered",
  "channel_used": "push",
  "delivered_at": 1741651205000,
  "read_at": null,
  "responded_at": null,
  "error_code": null,
  "updated_at": 1741651205123
}
```

Status values: `pending` | `delivered` | `read` | `responded` | `expired` | `failed`

---

### GET /v1/health

Node health check and capability advertisement. Used by the router federation for node discovery and load balancing.

**Response:**

```json
{
  "status": "ok",
  "node_id": "contacthi-node-prod-1",
  "version": "1.0.0",
  "protocol": "CHI/1.0",
  "uptime_seconds": 3847,
  "spacetimedb": {
    "url": "http://spacetimedb:3000",
    "database": "contacthi"
  },
  "registry": {
    "cosmos_rpc": "https://rpc.cosmos.directory/cosmoshub",
    "contract": "cosmos1abc...xyz"
  },
  "nullcone": {
    "url": "https://nullcone.example.com"
  },
  "capabilities": {
    "channels": ["agent-inbox", "push", "sms"],
    "max_ttl_seconds": 604800,
    "max_payload_bytes": 1048576,
    "rate_limit": "200/min"
  }
}
```

## Delivery Channels

A recipient's on-chain preference record specifies which channels are allowed and provides the necessary endpoint data (FCM token, phone number, etc.). The router tries channels in the order specified by the preference record, returning on the first success.

| Channel | Description | Required config |
|---|---|---|
| `agent-inbox` | Write to SpacetimeDB agent-inbox table. Default for agent recipients. | SpacetimeDB |
| `push` | Firebase Cloud Messaging. Best for mobile apps. | `FCM_KEY` + recipient FCM token in prefs |
| `sms` | Twilio SMS. Fallback for non-app users. | Twilio env vars + phone in prefs |
| `email` | SMTP email. Lowest-priority fallback. | SMTP env vars + email in prefs |
| `webhook` | HTTP POST to a URL. Used for service/agent recipients. | Webhook URL in prefs |

## Federation

Multiple router nodes can share the same SpacetimeDB instance. Each node registers itself via the `register_node` reducer on startup and sends heartbeats every 60 seconds. The `router_nodes` SpacetimeDB table is publicly readable, so any node can discover its peers.

Senders can contact any router node — the node that accepts a message records itself as the `router_node` for that message. Cross-node routing (where one node delegates to another closer to the recipient) is planned for CHI/1.1.

## Connecting to SpacetimeDB

1. Deploy the SpacetimeDB module from `../spacetimedb-module/`:
   ```bash
   spacetime publish contacthi --server http://localhost:3000 ./spacetimedb-module
   ```

2. Set `SPACETIMEDB_URL` and `SPACETIMEDB_DB` environment variables.

3. The router node will call `register_node` on startup and begin submitting messages automatically.

The SpacetimeDB tables (`messages`, `acks`, `preference_cache`, `router_nodes`) are all public, meaning any authenticated client can subscribe to real-time updates via WebSocket. This enables dashboards, sender-side delivery tracking, and agent-side inbox subscriptions without additional infrastructure.

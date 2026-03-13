# @contacthi/sdk

TypeScript SDK for **CHI/1.0** — an open async communication protocol for the agentic era.

ContactHI lets AI agents and humans send async messages to other humans, routing through a federated network of router nodes that check on-chain preference registries before delivering. Recipients control exactly who can contact them, how often, and via which channels.

---

## Quick Start

```bash
npm install @contacthi/sdk
```

```typescript
import { ReachClient } from '@contacthi/sdk'

const client = new ReachClient({
  router_url:    'https://router.chi.network',
  sender_did:    'did:chi:cosmos1youragentaddress',
  sender_type:   'AA',  // Autonomous Agent
  private_key:   process.env.CHI_PRIVATE_KEY,
})

// Check permission before sending
const perm = await client.checkPermission({
  recipient: 'did:chi:cosmos1recipientaddress',
  intent: 'INFORM',
})

if (perm.allowed) {
  const { message_id } = await client.send({
    to:      'did:chi:cosmos1recipientaddress',
    intent:  'INFORM',
    content: 'Your order has shipped.',
  })

  const ack = await client.waitForAck(message_id)
  console.log(ack.status)  // 'delivered'
}
```

---

## Installation

```bash
npm install @contacthi/sdk
# or
yarn add @contacthi/sdk
```

**Peer requirements**: Node.js ≥ 18 (for native `fetch`).

---

## API Reference

### `new ReachClient(config)`

Main SDK entry point.

```typescript
const client = new ReachClient({
  router_url:        'https://router.chi.network',  // required
  sender_did:        'did:chi:cosmos1...',           // required for sending
  sender_type:       'AA',                           // default: 'US'
  private_key:       'hex...',                       // 32-byte ed25519 key
  cosmos_rpc:        'https://rpc.cosmos.network',   // for on-chain queries
  registry_address:  'cosmos1contract...',           // CosmWasm registry address
})
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `router_url` | `string` | yes | CHI router node base URL |
| `sender_did` | `string` | for sending | Your DID (`did:chi:cosmos1...`) |
| `sender_type` | `EntityType` | no | Your entity type code (default `'US'`) |
| `private_key` | `string` | recommended | hex ed25519 private key for signing envelopes |
| `cosmos_rpc` | `string` | no | Cosmos RPC endpoint for direct on-chain reads |
| `registry_address` | `string` | no | CosmWasm preference registry contract address |

---

### `client.send(params)`

Send a message to a recipient DID.

```typescript
const { message_id, status } = await client.send({
  to:           'did:chi:cosmos1recipient...',  // DID or raw Cosmos address
  intent:       'INFORM',
  content:      'Your package has shipped.',
  payload_type: 'text',                           // default: 'text'
  priority:     1,                                // 0–3, default: 1
  ttl:          86400,                            // seconds, default: 86400 (24h)
  reply_to:     'original-message-id',            // optional
})
```

**Returns**: `{ message_id: string, status: MessageStatus }`

**Throws**:
- `ConfigError` — `sender_did` not configured
- `CHIError('PERMISSION_DENIED')` — recipient preferences block this sender
- `CHIError('SENDER_BLOCKLISTED')` — sender is on recipient's blocklist
- `CHIError('RATE_LIMIT_EXCEEDED')` — rate limit exceeded
- `CHIError('RECIPIENT_NOT_FOUND')` — recipient has no registered DID
- `RouterError` — unexpected router error

---

### `client.checkPermission(params)`

Check whether you are allowed to send to a recipient before calling `send`.

```typescript
const result = await client.checkPermission({
  recipient: 'did:chi:cosmos1...',
  intent:    'COLLECT',
})

if (!result.allowed) {
  console.log(result.reason)  // e.g. "Rate limit exceeded"
}
```

**Returns**: `PermissionResult`

```typescript
interface PermissionResult {
  allowed:               boolean
  allowed_channels:      Channel[]   // which channels are permitted
  reason?:               string      // present when denied
  rate_limit_remaining?: number      // sends left in current window
}
```

---

### `client.getStatus(message_id)`

Fetch the current delivery status of a sent message.

```typescript
const ack = await client.getStatus('msg-uuid')
// { message_id, status, channel_used, timestamp }
```

---

### `client.waitForAck(message_id, timeout_ms?)`

Poll until the message reaches a terminal status or the timeout elapses.

```typescript
try {
  const ack = await client.waitForAck(message_id, 60_000)
  console.log(ack.status, ack.channel_used)
} catch (e) {
  if (e instanceof TimeoutError) {
    console.log('No ack within 60s')
  }
}
```

Terminal statuses: `delivered`, `read`, `responded`, `expired`, `failed`.

**Throws**: `TimeoutError` if no terminal status is reached within `timeout_ms` (default 30 000).

---

### `client.preferences`

A `PreferencesManager` instance bound to the client's configured `sender_did`. Use this to manage your own on-chain delivery preferences.

---

## Preferences

### Register preferences (first time)

```typescript
await client.preferences.register({
  rules: [
    {
      sender_type:      'AA',       // Autonomous Agents
      intent:           'INFORM',
      allowed_channels: ['push', 'email'],
      rate_limit:       { count: 10, period: 'day' },
    },
    {
      sender_type:      'LM',       // Language Models
      intent:           '*',        // any intent
      allowed_channels: ['agent-inbox'],
    },
  ],
  default_policy: 'block',          // block anything that matches no rule
  webhook_url: 'https://myapp.example.com/chi-webhook',
})
```

### Update preferences

```typescript
// Replace entire preference profile
await client.preferences.update({
  default_policy: 'allow',
})

// Add a single rule
await client.preferences.addRule({
  sender_type:      'CA',
  intent:           'COLLECT',
  allowed_channels: [],  // deny all channels = effectively block this intent
})

// Remove a rule by index (0-based)
await client.preferences.removeRule(1)
```

### Block / unblock senders

```typescript
// Block by DID
await client.preferences.blockSender('did:chi:cosmos1spammer...')

// Block by domain
await client.preferences.blockSender('marketing.example.com')

// Unblock
await client.preferences.unblockSender('did:chi:cosmos1spammer...')
```

### Query preferences for any DID

```typescript
// Defaults to own DID
const prefs = await client.preferences.get()

// Query another DID
const theirPrefs = await client.preferences.get('did:chi:cosmos1other...')
```

---

## Agent Sender Flow

The recommended pattern for an agent sending a message:

```typescript
import { ReachClient } from '@contacthi/sdk'

const reach = new ReachClient({
  router_url:  process.env.CHI_ROUTER_URL!,
  sender_did:  process.env.AGENT_DID!,
  sender_type: 'AA',
  private_key: process.env.AGENT_PRIVATE_KEY!,
  cosmos_rpc:  process.env.COSMOS_RPC_URL,
  registry_address: process.env.CHI_REGISTRY,
})

async function notify(recipient_did: string, message: string) {
  // 1. Check permission (on-chain, no gas needed)
  const perm = await reach.checkPermission({
    recipient: recipient_did,
    intent: 'INFORM',
  })

  if (!perm.allowed) {
    console.warn(`Cannot contact ${recipient_did}: ${perm.reason}`)
    return
  }

  // 2. Send via the preferred channels
  const { message_id } = await reach.send({
    to:      recipient_did,
    intent:  'INFORM',
    content: message,
  })

  // 3. Wait for delivery confirmation
  const ack = await reach.waitForAck(message_id, 30_000)
  return ack
}
```

---

## DID Utilities

```typescript
import { createDID, parseDID, resolveDID, isValidDID } from '@contacthi/sdk'

// Create a DID from a Cosmos address
createDID('cosmos1abc123')
// => 'did:chi:cosmos1abc123'

// Parse a DID
parseDID('did:chi:cosmos1abc123')
// => { method: 'chi', address: 'cosmos1abc123' }

// Validate
isValidDID('did:chi:cosmos1abc123')  // true
isValidDID('did:eth:0x...')          // false

// Resolve on-chain preferences for a DID
const prefs = await resolveDID(
  'did:chi:cosmos1recipient...',
  'https://rpc.cosmos.network',
  'cosmos1registry...'
)
```

---

## Envelope Utilities

For lower-level use (e.g. building a router node, or implementing custom delivery logic):

```typescript
import {
  createEnvelope,
  signEnvelope,
  verifyEnvelope,
  validateEnvelope,
  isExpired,
} from '@contacthi/sdk'

// Build an envelope
const envelope = createEnvelope({
  sender_did:    'did:chi:cosmos1sender...',
  sender_type:   'AA',
  recipient_did: 'did:chi:cosmos1recipient...',
  intent:        'INFORM',
  content:       'Hello.',
  priority:      1,
  ttl:           3600,
})

// Sign it
const signed = await signEnvelope(envelope, privateKeyHex)

// Verify signature (requires public key)
const valid = await verifyEnvelope(signed, publicKeyHex)

// Validate structure (type guard)
if (validateEnvelope(unknown_data)) {
  // unknown_data is now typed as CHIMessage
}

// Check expiry
isExpired(envelope)  // false if within TTL
```

---

## Error Handling

All errors extend `ReachError` and carry a machine-readable `code`:

```typescript
import { ReachError, RouterError, TimeoutError, ConfigError } from '@contacthi/sdk'

try {
  await client.send({ to: '...', intent: 'INFORM', content: '...' })
} catch (e) {
  if (e instanceof ReachError) {
    switch (e.code) {
      case 'PERMISSION_DENIED':    /* ... */ break
      case 'SENDER_BLOCKLISTED':   /* ... */ break
      case 'RATE_LIMIT_EXCEEDED':  /* ... */ break
      case 'RECIPIENT_NOT_FOUND':  /* ... */ break
      case 'SIGNATURE_INVALID':    /* ... */ break
      case 'ROUTER_ERROR':         /* ... */ break
    }
  }
}
```

| Code | Cause |
|------|-------|
| `PERMISSION_DENIED` | Recipient's preferences block this sender/intent |
| `SENDER_BLOCKLISTED` | Sender is on recipient's blocklist |
| `RATE_LIMIT_EXCEEDED` | Sender exceeded the rate limit for this recipient |
| `RECIPIENT_NOT_FOUND` | Recipient DID is not registered on-chain |
| `SIGNATURE_INVALID` | Envelope signature failed verification |
| `SIGNING_FAILED` | Could not sign envelope (bad key) |
| `INVALID_ENVELOPE` | Envelope failed structural validation |
| `TTL_EXPIRED` | Message TTL elapsed before delivery |
| `CHANNEL_UNAVAILABLE` | No permitted channel is reachable |
| `ROUTER_ERROR` | Unexpected router HTTP error |
| `TIMEOUT` | `waitForAck` polling exceeded timeout |
| `CONFIG_MISSING` | Required config field not provided |

---

## Type Reference

### `EntityType`

| Code | Description |
|------|-------------|
| `CA` | Corporate Agent |
| `LM` | Language Model |
| `GN` | Governance Node |
| `AA` | Autonomous Agent |
| `RB` | Robot |
| `DR` | Data Reporter |
| `VH` | Virtual Human |
| `US` | User (human) |
| `CP` | Counterparty |
| `HS` | Human Sender |
| `*`  | Wildcard (rules only) |

### `Intent`

| Value | Meaning |
|-------|---------|
| `INFORM` | One-way notification |
| `COLLECT` | Request for information |
| `AUTHORIZE` | Approval or consent request |
| `ESCALATE` | Urgent or exception signal |
| `RESULT` | Response to a prior message |

### `Channel`

`push` · `sms` · `email` · `webhook` · `in-app` · `agent-inbox`

### `Priority`

`0` low · `1` normal · `2` high · `3` urgent

---

## Protocol Spec

- [CHI/1.0 Protocol Specification](https://contacthi.network/spec/1.0) *(coming soon)*
- [On-chain registry contract](../contacthi-contracts/) — CosmWasm preference registry
- [Router node reference implementation](https://github.com/contacthi/router) *(coming soon)*

---

## Development

```bash
npm install
npm run build   # compile TypeScript → dist/
npm test        # run jest test suite
npm run lint    # ESLint
```

---

## License

MIT

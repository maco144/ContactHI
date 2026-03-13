/**
 * CHI/1.0 Protocol — Core Type Definitions
 *
 * Entity type codes match the on-chain registry exactly.
 * See: tools/contacthi-contracts/src/msg.rs
 */

/** Entity type codes per the ContactHI entity taxonomy */
export type EntityType =
  | 'CA'  // Corporate Agent
  | 'LM'  // Language Model
  | 'GN'  // Governance Node
  | 'AA'  // Autonomous Agent
  | 'RB'  // Robot
  | 'DR'  // Data Reporter
  | 'VH'  // Virtual Human
  | 'US'  // User (human)
  | 'CP'  // Counterparty
  | 'HS'  // Human Sender (generic)
  | '*'   // Wildcard — matches any entity type in rules

/** Message intent classifies the purpose of communication */
export type Intent = 'INFORM' | 'COLLECT' | 'AUTHORIZE' | 'ESCALATE' | 'RESULT'

/** Delivery channels the protocol supports */
export type Channel = 'push' | 'sms' | 'email' | 'webhook' | 'in-app' | 'agent-inbox'

/**
 * Message priority level.
 * 0 = low, 1 = normal, 2 = high, 3 = urgent
 */
export type Priority = 0 | 1 | 2 | 3

/** Payload encoding type */
export type PayloadType = 'text' | 'voice' | 'document' | 'structured'

/** Lifecycle status of a sent message */
export type MessageStatus = 'pending' | 'delivered' | 'read' | 'responded' | 'expired' | 'failed'

/** Rate-limit period specifiers */
export type RateLimitPeriod = 'hour' | 'day' | 'week'

// ---------------------------------------------------------------------------
// Core message envelope
// ---------------------------------------------------------------------------

/**
 * A CHI/1.0 message envelope. This is the canonical wire format.
 * All fields except `signature` and `sender.proof` must be present before signing.
 */
export interface ReachMessage {
  /** Protocol version — always "1.0" */
  chi: '1.0'
  /** Unique message identifier (UUID v4) */
  id: string
  sender: {
    /** Sender's DID in did:chi: format */
    did: string
    /** Sender entity type */
    type: EntityType
    /** ZK proof hex — optional for v1, required for proof-gated recipients */
    proof?: string
  }
  recipient: {
    /** Recipient's DID in did:chi: format */
    did: string
  }
  /** Purpose of this message */
  intent: Intent
  /** Delivery priority */
  priority: Priority
  /** Time-to-live in seconds. Message is invalid after created_at + ttl. */
  ttl: number
  payload: {
    /** Encoding/format of the content field */
    type: PayloadType
    /** The actual message body */
    content: string
    /** Optional transcript (for voice payloads) */
    transcript?: string
    /** MIME type when type is 'document' */
    mime_type?: string
  }
  /** ID of the message this is a reply to, if any */
  reply_to?: string
  /** ISO 8601 creation timestamp */
  created_at: string
  /** ed25519 signature over canonical JSON, hex-encoded */
  signature?: string
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/** A single rule governing which senders may contact the recipient */
export interface PreferenceRule {
  /** Entity type this rule applies to ('*' for any) */
  sender_type: EntityType
  /** Intent this rule applies to ('*' for any) */
  intent: Intent | '*'
  /** Which channels are permitted when this rule matches */
  allowed_channels: Channel[]
  /** Optional rate limiting */
  rate_limit?: {
    count: number
    period: RateLimitPeriod
  }
  /** Optional delivery time window (UTC) */
  time_window?: {
    /** "HH:MM" format, UTC */
    start: string
    /** "HH:MM" format, UTC */
    end: string
  }
  /** DID or domain patterns that are always blocked (overrides allow) */
  blocklist?: string[]
}

/** Full on-chain preference profile for a DID */
export interface HumanPreferences {
  /** Owner's DID */
  did: string
  /** Ordered list of preference rules (first match wins) */
  rules: PreferenceRule[]
  /** What to do when no rule matches */
  default_policy: 'block' | 'allow'
  /** HTTPS URL to receive webhook deliveries */
  webhook_url?: string
  /** ISO 8601 timestamp of last update */
  updated_at: string
}

// ---------------------------------------------------------------------------
// Permission / delivery
// ---------------------------------------------------------------------------

/** Result of a permission check */
export interface PermissionResult {
  /** Whether the sender is allowed to contact this recipient */
  allowed: boolean
  /** Which channels are permitted (empty if denied) */
  allowed_channels: Channel[]
  /** Human-readable explanation (present when denied or rate-limited) */
  reason?: string
  /** Remaining sends allowed in the current rate-limit window */
  rate_limit_remaining?: number
}

/** Acknowledgement from the router after delivery or status query */
export interface DeliveryAck {
  /** ID of the message being acknowledged */
  message_id: string
  /** Current status of the message */
  status: MessageStatus
  /** Which channel was used to deliver */
  channel_used?: Channel
  /** ISO 8601 timestamp of this ack */
  timestamp: string
}

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

/** Configuration for a ReachClient instance */
export interface ReachClientConfig {
  /** URL of a CHI router node (e.g. "https://router.chi.network") */
  router_url: string
  /** Cosmos RPC endpoint for on-chain queries (e.g. "https://rpc.cosmos.network") */
  cosmos_rpc?: string
  /** CosmWasm contract address of the preference registry */
  registry_address?: string
  /** DID of the sender (did:chi:cosmos1...) */
  sender_did?: string
  /** Sender entity type */
  sender_type?: EntityType
  /** hex-encoded ed25519 private key for signing envelopes */
  private_key?: string
}

// ---------------------------------------------------------------------------
// Router API shapes (internal)
// ---------------------------------------------------------------------------

/** POST /v1/messages — request body */
export interface RouterSendRequest {
  envelope: ReachMessage
}

/** POST /v1/messages — response body */
export interface RouterSendResponse {
  message_id: string
  status: MessageStatus
  router_timestamp: string
}

/** GET /v1/messages/:id/status — response body */
export interface RouterStatusResponse {
  message_id: string
  status: MessageStatus
  channel_used?: Channel
  timestamp: string
}

/** POST /v1/check-permission — request body */
export interface RouterPermissionRequest {
  sender_did: string
  sender_type: EntityType
  recipient_did: string
  intent: Intent
}

/** POST /v1/check-permission — response body */
export interface RouterPermissionResponse {
  allowed: boolean
  allowed_channels: Channel[]
  reason?: string
  rate_limit_remaining?: number
}

// ---------------------------------------------------------------------------
// On-chain query shapes (mirrors msg.rs response structs)
// ---------------------------------------------------------------------------

/** CosmWasm query response for GetPreferences */
export interface ChainPreferencesResponse {
  owner: string
  rules: ChainPreferenceRule[]
  default_policy: 'block' | 'allow'
  webhook_url: string | null
  updated_at: number  // unix seconds (u64 from chain)
}

/** On-chain preference rule (snake_case from CosmWasm) */
export interface ChainPreferenceRule {
  sender_type: EntityType
  intent: Intent | '*'
  allowed_channels: Channel[]
  rate_limit?: {
    count: number
    period: RateLimitPeriod
  }
  time_window?: {
    start: string
    end: string
  }
  blocklist?: string[]
}

/** CosmWasm query response for CheckPermission */
export interface ChainPermissionResponse {
  allowed: boolean
  allowed_channels: Channel[]
  reason: string | null
  rate_limit_remaining: number | null
}

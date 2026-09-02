/**
 * CHI/1.0 Protocol — Core Type Definitions
 *
 * The vocabulary here mirrors `contracts/src/state.rs` exactly, because the
 * on-chain registry is the consent boundary: it is the only party that decides
 * whether a message may be delivered, and its serialization is frozen once a
 * registry is instantiated. Verified against `contracts/schema/raw/query.json`.
 */

/**
 * Entity Identity type codes. Matches `EntityType` in the registry contract
 * and protocol-spec.md §4.3.
 */
export type EntityType =
  | 'CA'  // Conversational Agent
  | 'LM'  // Language Model
  | 'GN'  // Generative Model
  | 'AA'  // Autonomous Agent
  | 'RB'  // Robot
  | 'DR'  // Drone
  | 'VH'  // Vehicle
  | 'US'  // Human User
  | 'CP'  // Copilot
  | 'HS'  // Hive / Swarm
  | 'any' // Wildcard — matches any entity type in rules

/**
 * The coarse intent class the registry stores and matches rules against.
 * Matches `Intent` in the registry contract.
 */
export type IntentClass =
  | 'inform'
  | 'collect'
  | 'authorize'
  | 'escalate'
  | 'result'
  | 'any'

/**
 * The intent carried on the wire: `class.action`, e.g. `inform.shipping_update`.
 *
 * The namespace before the dot IS the registry's intent class, which is how a
 * granular envelope intent resolves to a coarse on-chain rule. The template
 * type makes a namespace the registry cannot match a compile error rather than
 * a 400 at the router.
 */
export type Intent = `${Exclude<IntentClass, 'any'>}.${string}`

/** Extract the registry intent class from a wire intent. */
export function intentClass(intent: string): IntentClass {
  const namespace = intent.split('.')[0]?.toLowerCase() ?? ''
  return (
    ['inform', 'collect', 'authorize', 'escalate', 'result'].includes(namespace)
      ? namespace
      : 'any'
  ) as IntentClass
}

/** Delivery channels the protocol supports */
export type Channel = 'push' | 'sms' | 'email' | 'webhook' | 'in-app' | 'agent-inbox'

/**
 * Message priority, 0–255; higher is more urgent. Defaults to 128.
 * (The router validates this range; the registry does not use it.)
 */
export type Priority = number

/**
 * MIME-like payload descriptor, e.g. `text/plain`, `application/json`.
 * Free-form so payload formats can be added without a protocol revision.
 */
export type PayloadType = string

/** Lifecycle status of a sent message */
export type MessageStatus =
  | 'pending'
  | 'delivered'
  | 'read'
  | 'responded'
  | 'expired'
  | 'failed'

/** Rate-limit period specifiers */
export type RateLimitPeriod = 'hour' | 'day' | 'week'

// ---------------------------------------------------------------------------
// Core message envelope
// ---------------------------------------------------------------------------

/**
 * A CHI/1.0 message envelope — the canonical wire format (protocol-spec.md §6.1).
 *
 * Flat by design: it maps 1:1 onto the router's validation, the SpacetimeDB
 * `messages` table, and the ack record, with no reshaping at any hop.
 * All fields except `signature` must be present before signing.
 */
export interface ChiEnvelope {
  /** Protocol version — always "1.0" */
  version: '1.0'
  /** Unique message identifier (UUID v4) */
  message_id: string
  /** Sender's DID, `did:chi:<address>` */
  sender_did: string
  /** Sender's Entity Identity code */
  sender_type: EntityType
  /** Recipient's DID, `did:chi:<address>` */
  recipient_did: string
  /** Purpose of this message, `class.action` */
  intent: Intent
  /** Delivery priority, 0–255 (default 128) */
  priority?: Priority
  /** Time-to-live in seconds. Invalid after `created_at + ttl_seconds * 1000`. */
  ttl_seconds: number
  /** MIME-like descriptor for `payload` */
  payload_type: PayloadType
  /** The message body */
  payload: unknown
  /** Creation time, Unix milliseconds */
  created_at: number
  /** `message_id` this is a response to — see protocol-spec.md §9.3 */
  reply_to?: string
  /** ed25519 signature over canonical JSON, hex-encoded. Optional in CHI/1.0. */
  signature?: string
}

/** @deprecated Renamed to {@link ChiEnvelope}. Kept so existing imports compile. */
export type ReachMessage = ChiEnvelope

// ---------------------------------------------------------------------------
// Preferences — mirrors contracts/src/state.rs
// ---------------------------------------------------------------------------

/** A single rule governing which senders may contact the recipient */
export interface PreferenceRule {
  /** Entity type this rule applies to (`'any'` for all) */
  sender_type: EntityType
  /** Intent class this rule applies to (`'any'` for all) */
  intent: IntentClass
  /** Which channels are permitted when this rule matches */
  allowed_channels: Channel[]
  /** Optional rate limiting */
  rate_limit?: {
    count: number
    period: RateLimitPeriod
  } | null
  /** Optional delivery time window (UTC), "HH:MM" */
  time_window?: {
    start: string
    end: string
  } | null
  /** DID or domain patterns denied even when this rule would otherwise match */
  blocklist?: string[]
}

/** Full on-chain preference profile, as `PreferencesResponse` returns it */
export interface HumanPreferences {
  /** Owner's bech32 address */
  owner: string
  /** Preference rules, evaluated most-specific-first on-chain */
  rules: PreferenceRule[]
  /** What to do when no rule matches */
  default_policy: 'block' | 'allow'
  /** HTTPS URL to receive webhook deliveries */
  webhook_url?: string | null
  /** Unix seconds of last update */
  updated_at: number
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
  /** Machine or human-readable explanation */
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
  channel_used?: Channel | null
  /** When delivery completed — null until delivered */
  delivered_at?: string | number | null
  /** When the recipient read it — null until read */
  read_at?: string | number | null
  /** When the recipient responded — null until responded */
  responded_at?: string | number | null
  /** ErrorCode when status is `failed` or `expired`, else null */
  error?: string | null
}

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

/** Configuration for a ChiClient instance */
export interface ChiClientConfig {
  /** URL of a CHI router node (e.g. "https://chi.delivery") */
  router_url: string
  /** Cosmos RPC endpoint for on-chain queries */
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

/** @deprecated Renamed to {@link ChiClientConfig}. */
export type ReachClientConfig = ChiClientConfig

// ---------------------------------------------------------------------------
// Router API shapes (internal)
// ---------------------------------------------------------------------------

/** POST /v1/send — response body */
export interface RouterSendResponse {
  message_id: string
  status: MessageStatus
  channel?: Channel
}

/** GET /v1/status/:message_id — response body (protocol-spec.md §7.3) */
export interface RouterStatusResponse {
  message_id: string
  status: MessageStatus
  channel_used?: Channel | null
  delivered_at?: string | number | null
  read_at?: string | number | null
  responded_at?: string | number | null
  error?: string | null
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
// On-chain query shapes (mirror msg.rs response structs)
// ---------------------------------------------------------------------------

/** CosmWasm query response for GetPreferences */
export type ChainPreferencesResponse = HumanPreferences

/** On-chain preference rule */
export type ChainPreferenceRule = PreferenceRule

/** CosmWasm query response for CheckPermission */
export interface ChainPermissionResponse {
  allowed: boolean
  allowed_channels: Channel[]
  reason: string | null
  rate_limit_remaining: number | null
}

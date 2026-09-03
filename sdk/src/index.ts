/**
 * @contacthi/sdk
 *
 * TypeScript SDK for the CHI/1.0 agent-to-human communication protocol.
 *
 * Quick start:
 *
 *   import { ChiClient } from '@contacthi/sdk'
 *
 *   const client = new ChiClient({
 *     router_url: 'https://router.chi.network',
 *     sender_did: 'did:chi:cosmos1youraddress',
 *     sender_type: 'AA',
 *     private_key: process.env.CHI_PRIVATE_KEY,
 *   })
 *
 *   const { message_id } = await client.send({
 *     to: 'did:chi:cosmos1recipientaddress',
 *     intent: 'inform.shipping_update',
 *     content: 'Your order has shipped.',
 *   })
 */

// Main client
export { ChiClient } from './client'

// Preferences manager (also accessible as client.preferences)
export { PreferencesManager } from './preferences'

// Envelope utilities
export {
  createEnvelope,
  signEnvelope,
  verifyEnvelope,
  validateEnvelope,
  isExpired,
} from './envelope'

// DID utilities
export {
  createDID,
  parseDID,
  isValidDID,
  addressFromDID,
  resolveDID,
} from './did'

// Error classes
export {
  ChiError,
  InvalidEnvelopeError,
  SignatureError,
  RouterError,
  TimeoutError,
  ConfigError,
} from './errors'

// All types
export type {
  // Domain types
  EntityType,
  Intent,
  IntentClass,
  Channel,
  Priority,
  PayloadType,
  MessageStatus,
  RateLimitPeriod,
  // Core message
  ChiEnvelope,
  // Preferences
  PreferenceRule,
  HumanPreferences,
  // Results
  PermissionResult,
  RateLimitPolicy,
  DeliveryAck,
  // Config
  ChiClientConfig,
} from './types'

export { intentClass } from './types'

export type { ChiErrorCode, ChiErrorCode as ErrorCode } from './errors'

// ---------------------------------------------------------------------------
// Deprecated aliases
//
// The project was renamed Reach → CHI before 1.0 and the SDK identifiers were
// never carried across. These keep existing imports compiling; they will be
// removed in CHI/1.1.
// ---------------------------------------------------------------------------

export { ChiClient as ReachClient } from './client'
export { ChiError as ReachError } from './errors'
export type { ChiErrorCode as ReachErrorCode } from './errors'
export type {
  ChiEnvelope as ReachMessage,
  ChiClientConfig as ReachClientConfig,
} from './types'

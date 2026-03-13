/**
 * @contacthi/sdk
 *
 * TypeScript SDK for the CHI/1.0 agent-to-human communication protocol.
 *
 * Quick start:
 *
 *   import { ReachClient } from '@contacthi/sdk'
 *
 *   const client = new ReachClient({
 *     router_url: 'https://router.chi.network',
 *     sender_did: 'did:chi:cosmos1youraddress',
 *     sender_type: 'AA',
 *     private_key: process.env.CHI_PRIVATE_KEY,
 *   })
 *
 *   const { message_id } = await client.send({
 *     to: 'did:chi:cosmos1recipientaddress',
 *     intent: 'INFORM',
 *     content: 'Your order has shipped.',
 *   })
 */

// Main client
export { ReachClient } from './client'

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
  ReachError,
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
  Channel,
  Priority,
  PayloadType,
  MessageStatus,
  RateLimitPeriod,
  // Core message
  ReachMessage,
  // Preferences
  PreferenceRule,
  HumanPreferences,
  // Results
  PermissionResult,
  DeliveryAck,
  // Config
  ReachClientConfig,
} from './types'

export type { ReachErrorCode, ReachErrorCode as ErrorCode } from './errors'

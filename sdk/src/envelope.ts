/**
 * CHI/1.0 Protocol — Envelope Utilities
 *
 * Handles creation, signing, verification, and structural validation of
 * ContactHI message envelopes.
 *
 * Signing uses ed25519 via @noble/ed25519. The signature is computed over
 * the canonical JSON of the envelope with the `signature` field omitted.
 */

import { v4 as uuidv4 } from 'uuid'
import * as ed from '@noble/ed25519'
import type {
  ChiEnvelope,
  EntityType,
  Intent,
  PayloadType,
  Priority,
} from './types'
import { InvalidEnvelopeError, SignatureError } from './errors'

// ---------------------------------------------------------------------------
// Node.js SHA-512 shim for @noble/ed25519 v2
//
// @noble/ed25519 v2 uses Web Crypto (async) by default. In Node.js ≥ 15 the
// globalThis.crypto.subtle API is available and will be used automatically.
// For Node.js < 15 or environments without SubtleCrypto, register a
// synchronous SHA-512 fallback using the built-in `crypto` module so that
// sign/verify still work.
// ---------------------------------------------------------------------------
;(function shimSha512() {
  const edTyped = ed as unknown as {
    etc?: { sha512Sync?: (...msgs: Uint8Array[]) => Uint8Array }
  }
  if (edTyped.etc && !edTyped.etc.sha512Sync) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeCrypto = require('crypto') as typeof import('crypto')
      edTyped.etc.sha512Sync = (...msgs: Uint8Array[]): Uint8Array => {
        const h = nodeCrypto.createHash('sha512')
        for (const msg of msgs) h.update(msg)
        return new Uint8Array(h.digest())
      }
    } catch {
      // Not in a Node.js environment — Web Crypto will be used instead.
    }
  }
})()

// ---------------------------------------------------------------------------
// Canonical JSON helpers
// ---------------------------------------------------------------------------

/**
 * Recursively sort all object keys alphabetically.
 * Arrays are preserved as-is (element order is significant).
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * Produce the canonical JSON string for signing: the envelope serialized
 * with all keys sorted alphabetically at every nesting level, with the
 * `signature` field omitted.
 */
function canonicalJSON(envelope: ChiEnvelope): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signature: _sig, ...withoutSig } = envelope
  return JSON.stringify(sortKeys(withoutSig))
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a new CHI/1.0 message envelope.
 * The envelope is not yet signed — call `signEnvelope` before sending.
 */
export function createEnvelope(params: {
  sender_did: string
  sender_type: EntityType
  recipient_did: string
  intent: Intent
  /** Message body. A string is sent as-is; anything else is sent structured. */
  content: unknown
  payload_type?: PayloadType
  priority?: Priority
  ttl?: number
  reply_to?: string
}): ChiEnvelope {
  const {
    sender_did,
    sender_type,
    recipient_did,
    intent,
    content,
    priority = 128,
    ttl = 86400, // 24 hours default
    reply_to,
  } = params

  const payload_type =
    params.payload_type ?? (typeof content === 'string' ? 'text/plain' : 'application/json')

  if (!sender_did) throw new InvalidEnvelopeError('sender_did is required', 'sender_did')
  if (!sender_type) throw new InvalidEnvelopeError('sender_type is required', 'sender_type')
  if (!recipient_did) throw new InvalidEnvelopeError('recipient_did is required', 'recipient_did')
  if (!intent) throw new InvalidEnvelopeError('intent is required', 'intent')
  if (content === undefined || content === null || content === '') {
    throw new InvalidEnvelopeError('content is required', 'payload')
  }
  if (ttl <= 0) throw new InvalidEnvelopeError('ttl must be a positive integer', 'ttl_seconds')
  if (priority < 0 || priority > 255) {
    throw new InvalidEnvelopeError('priority must be between 0 and 255', 'priority')
  }

  const envelope: ChiEnvelope = {
    version: '1.0',
    message_id: uuidv4(),
    sender_did,
    sender_type,
    recipient_did,
    intent,
    priority,
    ttl_seconds: ttl,
    payload_type,
    payload: content,
    created_at: Date.now(),
    ...(reply_to !== undefined && { reply_to }),
  }

  return envelope
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

/**
 * Sign a CHI envelope with an ed25519 private key.
 *
 * @param envelope    - Unsigned (or previously signed) envelope
 * @param private_key - hex-encoded 32-byte ed25519 private key
 * @returns           - New envelope object with `signature` field set
 *
 * @throws SignatureError if the key is invalid
 */
export async function signEnvelope(
  envelope: ChiEnvelope,
  private_key: string
): Promise<ChiEnvelope> {
  let privKeyBytes: Uint8Array
  try {
    privKeyBytes = hexToBytes(private_key)
  } catch {
    throw new SignatureError('SIGNING_FAILED', 'private_key must be a valid hex string')
  }

  if (privKeyBytes.length !== 32) {
    throw new SignatureError(
      'SIGNING_FAILED',
      `ed25519 private key must be 32 bytes, got ${privKeyBytes.length}`
    )
  }

  const message = new TextEncoder().encode(canonicalJSON(envelope))

  let sigBytes: Uint8Array
  try {
    sigBytes = await ed.signAsync(message, privKeyBytes)
  } catch (err) {
    throw new SignatureError('SIGNING_FAILED', `Signing failed: ${String(err)}`)
  }

  return { ...envelope, signature: bytesToHex(sigBytes) }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify the ed25519 signature on a CHI envelope.
 *
 * The public key is derived from the sender's DID address using Cosmos
 * key derivation conventions. For v1, the public key must be retrievable
 * from the on-chain account registry or provided out-of-band.
 *
 * This implementation verifies against a public key embedded as the
 * last 32 bytes of the 64-byte signature (convention for self-contained
 * verification in CHI v1). For production use, resolve the sender's
 * public key from the chain.
 *
 * @returns true if the signature is valid, false otherwise
 */
export async function verifyEnvelope(
  envelope: ChiEnvelope,
  public_key?: string
): Promise<boolean> {
  if (!envelope.signature) {
    return false
  }

  let sigBytes: Uint8Array
  let pubKeyBytes: Uint8Array
  let messageBytes: Uint8Array

  try {
    sigBytes = hexToBytes(envelope.signature)
  } catch {
    return false
  }

  if (sigBytes.length !== 64) {
    return false
  }

  if (public_key) {
    try {
      pubKeyBytes = hexToBytes(public_key)
    } catch {
      return false
    }
  } else {
    // CHI v1 fallback: derive public key from private key is not possible
    // without the private key. In v1, the router stores the public key
    // during registration. This path returns false when no key is provided.
    return false
  }

  try {
    messageBytes = new TextEncoder().encode(canonicalJSON(envelope))
    return await ed.verifyAsync(sigBytes, messageBytes, pubKeyBytes)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

// These mirror the router's `validate.ts` and the contract's enums. If SDK-side
// validation and router-side validation disagree, the SDK's job — telling you
// before you spend a round trip — is worthless.
const VALID_ENTITY_TYPES = new Set([
  'CA', 'LM', 'GN', 'AA', 'RB', 'DR', 'VH', 'US', 'CP', 'HS',
])
const VALID_INTENT_NAMESPACES = new Set([
  'inform', 'collect', 'authorize', 'escalate', 'result',
])
const INTENT_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
const MAX_TTL_SECONDS = 604_800 // 7 days

/**
 * Type guard: validate that an unknown value is a structurally valid ChiEnvelope.
 *
 * This checks all required fields are present with correct types and values.
 * It does NOT verify the cryptographic signature.
 */
export function validateEnvelope(envelope: unknown): envelope is ChiEnvelope {
  if (typeof envelope !== 'object' || envelope === null) return false

  const msg = envelope as Record<string, unknown>

  // Protocol version
  if (msg['version'] !== '1.0') return false

  // Identifiers
  if (typeof msg['message_id'] !== 'string' || !msg['message_id']) return false
  if (typeof msg['sender_did'] !== 'string' || !msg['sender_did']) return false
  if (typeof msg['recipient_did'] !== 'string' || !msg['recipient_did']) return false
  if (!(msg['sender_did'] as string).startsWith('did:')) return false
  if (!(msg['recipient_did'] as string).startsWith('did:')) return false

  // Sender entity type
  if (!VALID_ENTITY_TYPES.has(msg['sender_type'] as string)) return false

  // Intent: `class.action`, where the class is one the registry can match
  const intent = msg['intent']
  if (typeof intent !== 'string' || !INTENT_PATTERN.test(intent)) return false
  if (!VALID_INTENT_NAMESPACES.has(intent.split('.')[0])) return false

  // Priority — optional, 0–255
  if (msg['priority'] !== undefined) {
    const priority = msg['priority']
    if (typeof priority !== 'number' || !Number.isInteger(priority)) return false
    if (priority < 0 || priority > 255) return false
  }

  // TTL
  const ttl = msg['ttl_seconds']
  if (typeof ttl !== 'number' || !Number.isInteger(ttl)) return false
  if (ttl < 1 || ttl > MAX_TTL_SECONDS) return false

  // Payload
  if (typeof msg['payload_type'] !== 'string' || !msg['payload_type']) return false
  if (msg['payload'] === undefined || msg['payload'] === null) return false

  // created_at — Unix milliseconds
  if (typeof msg['created_at'] !== 'number' || !Number.isFinite(msg['created_at'])) {
    return false
  }

  // Optional fields — type-check when present
  if (msg['reply_to'] !== undefined && typeof msg['reply_to'] !== 'string') return false
  if (msg['signature'] !== undefined && typeof msg['signature'] !== 'string') return false

  return true
}

/**
 * Check whether a CHI message envelope is expired (TTL elapsed).
 */
export function isExpired(envelope: ChiEnvelope): boolean {
  const created = envelope.created_at
  if (typeof created !== 'number' || Number.isNaN(created)) return true
  return Date.now() > created + envelope.ttl_seconds * 1000
}

// ---------------------------------------------------------------------------
// Hex utilities
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) {
    throw new Error('Hex string must have an even number of characters')
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    if (isNaN(byte)) throw new Error(`Invalid hex character at position ${i * 2}`)
    bytes[i] = byte
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Re-export for use in tests
export { hexToBytes, bytesToHex }

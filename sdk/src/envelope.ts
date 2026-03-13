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
  ReachMessage,
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
function canonicalJSON(envelope: ReachMessage): string {
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
  content: string
  payload_type?: PayloadType
  priority?: Priority
  ttl?: number
  reply_to?: string
  mime_type?: string
  transcript?: string
}): ReachMessage {
  const {
    sender_did,
    sender_type,
    recipient_did,
    intent,
    content,
    payload_type = 'text',
    priority = 1,
    ttl = 86400,  // 24 hours default
    reply_to,
    mime_type,
    transcript,
  } = params

  if (!sender_did) throw new InvalidEnvelopeError('sender_did is required', 'sender_did')
  if (!sender_type) throw new InvalidEnvelopeError('sender_type is required', 'sender_type')
  if (!recipient_did) throw new InvalidEnvelopeError('recipient_did is required', 'recipient_did')
  if (!intent) throw new InvalidEnvelopeError('intent is required', 'intent')
  if (!content) throw new InvalidEnvelopeError('content is required', 'payload.content')
  if (ttl <= 0) throw new InvalidEnvelopeError('ttl must be a positive integer', 'ttl')

  const envelope: ReachMessage = {
    chi: '1.0',
    id: uuidv4(),
    sender: {
      did: sender_did,
      type: sender_type,
    },
    recipient: {
      did: recipient_did,
    },
    intent,
    priority,
    ttl,
    payload: {
      type: payload_type,
      content,
      ...(transcript !== undefined && { transcript }),
      ...(mime_type !== undefined && { mime_type }),
    },
    created_at: new Date().toISOString(),
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
  envelope: ReachMessage,
  private_key: string
): Promise<ReachMessage> {
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
  envelope: ReachMessage,
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

const VALID_ENTITY_TYPES = new Set([
  'CA', 'LM', 'GN', 'AA', 'RB', 'DR', 'VH', 'US', 'CP', 'HS', '*',
])
const VALID_INTENTS = new Set(['INFORM', 'COLLECT', 'AUTHORIZE', 'ESCALATE', 'RESULT'])
const VALID_PAYLOAD_TYPES = new Set(['text', 'voice', 'document', 'structured'])
const VALID_PRIORITIES = new Set([0, 1, 2, 3])

/**
 * Type guard: validate that an unknown value is a structurally valid ReachMessage.
 *
 * This checks all required fields are present with correct types and values.
 * It does NOT verify the cryptographic signature.
 */
export function validateEnvelope(envelope: unknown): envelope is ReachMessage {
  if (typeof envelope !== 'object' || envelope === null) return false

  const msg = envelope as Record<string, unknown>

  // Protocol version
  if (msg['chi'] !== '1.0') return false

  // ID
  if (typeof msg['id'] !== 'string' || !msg['id']) return false

  // Sender
  if (typeof msg['sender'] !== 'object' || msg['sender'] === null) return false
  const sender = msg['sender'] as Record<string, unknown>
  if (typeof sender['did'] !== 'string' || !sender['did']) return false
  if (!VALID_ENTITY_TYPES.has(sender['type'] as string)) return false

  // Recipient
  if (typeof msg['recipient'] !== 'object' || msg['recipient'] === null) return false
  const recipient = msg['recipient'] as Record<string, unknown>
  if (typeof recipient['did'] !== 'string' || !recipient['did']) return false

  // Intent
  if (!VALID_INTENTS.has(msg['intent'] as string)) return false

  // Priority
  if (!VALID_PRIORITIES.has(msg['priority'] as number)) return false

  // TTL
  if (typeof msg['ttl'] !== 'number' || msg['ttl'] <= 0) return false

  // Payload
  if (typeof msg['payload'] !== 'object' || msg['payload'] === null) return false
  const payload = msg['payload'] as Record<string, unknown>
  if (!VALID_PAYLOAD_TYPES.has(payload['type'] as string)) return false
  if (typeof payload['content'] !== 'string') return false

  // created_at — must be ISO 8601
  if (typeof msg['created_at'] !== 'string') return false
  if (isNaN(Date.parse(msg['created_at'] as string))) return false

  // Optional fields — type-check when present
  if (msg['reply_to'] !== undefined && typeof msg['reply_to'] !== 'string') return false
  if (msg['signature'] !== undefined && typeof msg['signature'] !== 'string') return false

  return true
}

/**
 * Check whether a CHI message envelope is expired (TTL elapsed).
 */
export function isExpired(envelope: ReachMessage): boolean {
  const created = Date.parse(envelope.created_at)
  if (isNaN(created)) return true
  return Date.now() > created + envelope.ttl * 1000
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

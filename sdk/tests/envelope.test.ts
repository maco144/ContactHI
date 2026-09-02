/**
 * Tests for envelope.ts — creation, signing, verification, and validation
 */

// Must be imported before @noble/ed25519 so the sha512Sync shim is registered.
import './setup'

import { getPublicKey } from '@noble/ed25519'
import {
  createEnvelope,
  signEnvelope,
  verifyEnvelope,
  validateEnvelope,
  isExpired,
  hexToBytes,
  bytesToHex,
} from '../src/envelope'
import type { ChiEnvelope } from '../src/types'
import { InvalidEnvelopeError, SignatureError } from '../src/errors'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A known 32-byte private key (DO NOT use in production) */
const TEST_PRIVATE_KEY = 'a'.repeat(64) // 32 bytes of 0xaa...

const SENDER_DID = 'did:chi:cosmos1sender0000000000000000000000000'
const RECIPIENT_DID = 'did:chi:cosmos1recipient000000000000000000000'

function makeBaseParams() {
  return {
    sender_did: SENDER_DID,
    sender_type: 'AA' as const,
    recipient_did: RECIPIENT_DID,
    intent: 'inform.notice' as const,
    content: 'Hello from an agent.',
  }
}

// ---------------------------------------------------------------------------
// createEnvelope
// ---------------------------------------------------------------------------

describe('createEnvelope', () => {
  it('returns a valid ChiEnvelope with protocol version 1.0', () => {
    const env = createEnvelope(makeBaseParams())
    expect(env.version).toBe('1.0')
  })

  it('generates a unique UUID id for each call', () => {
    const a = createEnvelope(makeBaseParams())
    const b = createEnvelope(makeBaseParams())
    expect(a.message_id).toBeTruthy()
    expect(b.message_id).toBeTruthy()
    expect(a.message_id).not.toBe(b.message_id)
  })

  it('sets sender fields correctly', () => {
    const env = createEnvelope(makeBaseParams())
    expect(env.sender_did).toBe(SENDER_DID)
    expect(env.sender_type).toBe('AA')
  })

  it('sets recipient did', () => {
    const env = createEnvelope(makeBaseParams())
    expect(env.recipient_did).toBe(RECIPIENT_DID)
  })

  it('applies default priority 128 and default ttl 86400', () => {
    const env = createEnvelope(makeBaseParams())
    expect(env.priority).toBe(128)
    expect(env.ttl_seconds).toBe(86400)
  })

  it('respects explicit priority and ttl overrides', () => {
    const env = createEnvelope({ ...makeBaseParams(), priority: 3, ttl: 3600 })
    expect(env.priority).toBe(3)
    expect(env.ttl_seconds).toBe(3600)
  })

  it('defaults payload_type to text/plain for string content', () => {
    const env = createEnvelope(makeBaseParams())
    expect(env.payload_type).toBe('text/plain')
  })

  it('sets payload_type when provided', () => {
    const env = createEnvelope({ ...makeBaseParams(), payload_type: 'structured' })
    expect(env.payload_type).toBe('structured')
  })

  it('sets reply_to when provided', () => {
    const env = createEnvelope({ ...makeBaseParams(), reply_to: 'original-message-id' })
    expect(env.reply_to).toBe('original-message-id')
  })

  it('omits reply_to when not provided', () => {
    const env = createEnvelope(makeBaseParams())
    expect(env.reply_to).toBeUndefined()
  })

  it('sets created_at as Unix milliseconds', () => {
    const before = Date.now()
    const env = createEnvelope(makeBaseParams())
    const after = Date.now()
    expect(typeof env.created_at).toBe('number')
    expect(env.created_at).toBeGreaterThanOrEqual(before)
    expect(env.created_at).toBeLessThanOrEqual(after)
  })

  it('does not set signature on fresh envelope', () => {
    const env = createEnvelope(makeBaseParams())
    expect(env.signature).toBeUndefined()
  })

  it('throws InvalidEnvelopeError when sender_did is missing', () => {
    expect(() =>
      createEnvelope({ ...makeBaseParams(), sender_did: '' })
    ).toThrow(InvalidEnvelopeError)
  })

  it('throws InvalidEnvelopeError when recipient_did is missing', () => {
    expect(() =>
      createEnvelope({ ...makeBaseParams(), recipient_did: '' })
    ).toThrow(InvalidEnvelopeError)
  })

  it('throws InvalidEnvelopeError when content is empty', () => {
    expect(() =>
      createEnvelope({ ...makeBaseParams(), content: '' })
    ).toThrow(InvalidEnvelopeError)
  })

  it('throws InvalidEnvelopeError when ttl is zero or negative', () => {
    expect(() =>
      createEnvelope({ ...makeBaseParams(), ttl: 0 })
    ).toThrow(InvalidEnvelopeError)

    expect(() =>
      createEnvelope({ ...makeBaseParams(), ttl: -1 })
    ).toThrow(InvalidEnvelopeError)
  })

  it('carries the MIME type in payload_type', () => {
    const env = createEnvelope({
      ...makeBaseParams(),
      payload_type: 'application/pdf',
    })
    expect(env.payload_type).toBe('application/pdf')
  })

  it('defaults payload_type from the content shape', () => {
    const text = createEnvelope({ ...makeBaseParams(), content: 'plain words' })
    expect(text.payload_type).toBe('text/plain')

    const structured = createEnvelope({
      ...makeBaseParams(),
      content: { transcript: 'Hello world' },
    })
    expect(structured.payload_type).toBe('application/json')
    expect(structured.payload).toEqual({ transcript: 'Hello world' })
  })

  it('records reply_to when the message is a response', () => {
    const env = createEnvelope({ ...makeBaseParams(), reply_to: 'msg-original' })
    expect(env.reply_to).toBe('msg-original')
  })
})

// ---------------------------------------------------------------------------
// signEnvelope
// ---------------------------------------------------------------------------

describe('signEnvelope', () => {
  it('attaches a hex signature string', async () => {
    const env = createEnvelope(makeBaseParams())
    const signed = await signEnvelope(env, TEST_PRIVATE_KEY)
    expect(typeof signed.signature).toBe('string')
    expect(signed.signature!.length).toBe(128) // 64 bytes * 2 hex chars
  })

  it('returns a new envelope object (does not mutate original)', async () => {
    const env = createEnvelope(makeBaseParams())
    const signed = await signEnvelope(env, TEST_PRIVATE_KEY)
    expect(env.signature).toBeUndefined()
    expect(signed.signature).toBeDefined()
    expect(signed).not.toBe(env)
  })

  it('preserves all original fields after signing', async () => {
    const env = createEnvelope(makeBaseParams())
    const signed = await signEnvelope(env, TEST_PRIVATE_KEY)
    expect(signed.message_id).toBe(env.message_id)
    expect(signed.sender_did).toEqual(env.sender_did)
    expect(signed.sender_type).toEqual(env.sender_type)
    expect(signed.recipient_did).toEqual(env.recipient_did)
    expect(signed.intent).toBe(env.intent)
    expect(signed.payload).toEqual(env.payload)
    expect(signed.created_at).toBe(env.created_at)
  })

  it('produces a different signature when content changes', async () => {
    const env1 = createEnvelope(makeBaseParams())
    const env2 = createEnvelope({ ...makeBaseParams(), content: 'Different content' })
    // Force same id/timestamp for a fair comparison
    const env2Patched = { ...env2, id: env1.message_id, created_at: env1.created_at }
    const signed1 = await signEnvelope(env1, TEST_PRIVATE_KEY)
    const signed2 = await signEnvelope(env2Patched, TEST_PRIVATE_KEY)
    expect(signed1.signature).not.toBe(signed2.signature)
  })

  it('throws SignatureError when private_key is not valid hex', async () => {
    const env = createEnvelope(makeBaseParams())
    await expect(signEnvelope(env, 'not-hex!!!')).rejects.toThrow(SignatureError)
  })

  it('throws SignatureError when private_key is the wrong length', async () => {
    const env = createEnvelope(makeBaseParams())
    // 16 bytes = 32 hex chars, not 64
    await expect(signEnvelope(env, 'aa'.repeat(16))).rejects.toThrow(SignatureError)
  })
})

// ---------------------------------------------------------------------------
// verifyEnvelope
// ---------------------------------------------------------------------------

describe('verifyEnvelope', () => {
  async function signedPair(): Promise<{
    signed: ChiEnvelope
    publicKeyHex: string
  }> {
    const privBytes = hexToBytes(TEST_PRIVATE_KEY)
    const pubBytes = await getPublicKey(privBytes)
    const env = createEnvelope(makeBaseParams())
    const signed = await signEnvelope(env, TEST_PRIVATE_KEY)
    return { signed, publicKeyHex: bytesToHex(pubBytes) }
  }

  it('returns true when signature is valid', async () => {
    const { signed, publicKeyHex } = await signedPair()
    const result = await verifyEnvelope(signed, publicKeyHex)
    expect(result).toBe(true)
  })

  it('returns false when envelope has no signature', async () => {
    const env = createEnvelope(makeBaseParams())
    const result = await verifyEnvelope(env)
    expect(result).toBe(false)
  })

  it('returns false when signature is tampered', async () => {
    const { signed, publicKeyHex } = await signedPair()
    const tampered = { ...signed, signature: 'ff'.repeat(64) }
    const result = await verifyEnvelope(tampered, publicKeyHex)
    expect(result).toBe(false)
  })

  it('returns false when envelope content is mutated after signing', async () => {
    const { signed, publicKeyHex } = await signedPair()
    const mutated = {
      ...signed,
      payload: 'Evil content!',
    }
    const result = await verifyEnvelope(mutated, publicKeyHex)
    expect(result).toBe(false)
  })

  it('returns false when no public_key is provided', async () => {
    const env = createEnvelope(makeBaseParams())
    const signed = await signEnvelope(env, TEST_PRIVATE_KEY)
    const result = await verifyEnvelope(signed)
    expect(result).toBe(false)
  })

  it('returns false when public_key is not valid hex', async () => {
    const env = createEnvelope(makeBaseParams())
    const signed = await signEnvelope(env, TEST_PRIVATE_KEY)
    const result = await verifyEnvelope(signed, '!not-hex!')
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateEnvelope
// ---------------------------------------------------------------------------

describe('validateEnvelope', () => {
  it('returns true for a valid unsigned envelope', () => {
    const env = createEnvelope(makeBaseParams())
    expect(validateEnvelope(env)).toBe(true)
  })

  it('returns true for a signed envelope', async () => {
    const env = createEnvelope(makeBaseParams())
    const signed = await signEnvelope(env, TEST_PRIVATE_KEY)
    expect(validateEnvelope(signed)).toBe(true)
  })

  it('returns false for null / undefined', () => {
    expect(validateEnvelope(null)).toBe(false)
    expect(validateEnvelope(undefined)).toBe(false)
  })

  it('returns false when the protocol version is wrong', () => {
    const env = { ...createEnvelope(makeBaseParams()), version: '2.0' }
    expect(validateEnvelope(env)).toBe(false)
  })

  it('returns false when message_id is missing', () => {
    const env = createEnvelope(makeBaseParams())
    const { message_id: _id, ...noId } = env
    expect(validateEnvelope(noId)).toBe(false)
  })

  it('returns false when sender_type is not an Entity Identity code', () => {
    const env = createEnvelope(makeBaseParams())
    expect(validateEnvelope({ ...env, sender_type: 'INVALID' })).toBe(false)
    // The router's old vocabulary is not accepted either.
    expect(validateEnvelope({ ...env, sender_type: 'agent' })).toBe(false)
  })

  it('returns false when intent is invalid', () => {
    const env = createEnvelope(makeBaseParams())
    const bad = { ...env, intent: 'shout.loudly' }
    expect(validateEnvelope(bad)).toBe(false)
  })

  it('returns false when priority is out of range', () => {
    const env = createEnvelope(makeBaseParams())
    const bad = { ...env, priority: 256 }
    expect(validateEnvelope(bad)).toBe(false)
  })

  it('returns false when ttl is zero', () => {
    // Bypass createEnvelope guard to construct a bad envelope directly
    const env = createEnvelope(makeBaseParams())
    const bad = { ...env, ttl_seconds: 0 }
    expect(validateEnvelope(bad)).toBe(false)
  })

  it('returns false when created_at is not a valid date string', () => {
    const env = createEnvelope(makeBaseParams())
    const bad = { ...env, created_at: 'not-a-date' }
    expect(validateEnvelope(bad)).toBe(false)
  })

  it('returns false when payload_type is empty', () => {
    const env = createEnvelope(makeBaseParams())
    expect(validateEnvelope({ ...env, payload_type: '' })).toBe(false)
  })

  it('returns false when ttl_seconds exceeds the 7-day maximum', () => {
    const env = createEnvelope(makeBaseParams())
    expect(validateEnvelope({ ...env, ttl_seconds: 604_801 })).toBe(false)
  })

  it('returns false when a DID is not did:-prefixed', () => {
    const env = createEnvelope(makeBaseParams())
    expect(validateEnvelope({ ...env, recipient_did: 'cosmos1nope' })).toBe(false)
  })

  it('returns false for a plain string', () => {
    expect(validateEnvelope('not-an-envelope')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isExpired
// ---------------------------------------------------------------------------

describe('isExpired', () => {
  it('returns false for a fresh envelope with default 24h TTL', () => {
    const env = createEnvelope(makeBaseParams())
    expect(isExpired(env)).toBe(false)
  })

  it('returns true for an envelope created far in the past', () => {
    const env = createEnvelope(makeBaseParams())
    const old = {
      ...env,
      created_at: Date.now() - 48 * 3600 * 1000,
      ttl_seconds: 3600,
    }
    expect(isExpired(old)).toBe(true)
  })

  it('returns true when created_at is well before now and ttl has clearly elapsed', () => {
    const env = createEnvelope(makeBaseParams())
    const forceExpired = {
      ...env,
      // 10 seconds ago with a 1-second TTL — unambiguously expired
      created_at: Date.now() - 10_000,
      ttl_seconds: 1,
    }
    expect(isExpired(forceExpired)).toBe(true)
  })
})

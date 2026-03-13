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
import type { ReachMessage } from '../src/types'
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
    intent: 'INFORM' as const,
    content: 'Hello from an agent.',
  }
}

// ---------------------------------------------------------------------------
// createEnvelope
// ---------------------------------------------------------------------------

describe('createEnvelope', () => {
  it('returns a valid ReachMessage with protocol version 1.0', () => {
    const env = createEnvelope(makeBaseParams())
    expect(env.chi).toBe('1.0')
  })

  it('generates a unique UUID id for each call', () => {
    const a = createEnvelope(makeBaseParams())
    const b = createEnvelope(makeBaseParams())
    expect(a.id).toBeTruthy()
    expect(b.id).toBeTruthy()
    expect(a.id).not.toBe(b.id)
  })

  it('sets sender fields correctly', () => {
    const env = createEnvelope(makeBaseParams())
    expect(env.sender.did).toBe(SENDER_DID)
    expect(env.sender.type).toBe('AA')
  })

  it('sets recipient did', () => {
    const env = createEnvelope(makeBaseParams())
    expect(env.recipient.did).toBe(RECIPIENT_DID)
  })

  it('applies default priority 1 and default ttl 86400', () => {
    const env = createEnvelope(makeBaseParams())
    expect(env.priority).toBe(1)
    expect(env.ttl).toBe(86400)
  })

  it('respects explicit priority and ttl overrides', () => {
    const env = createEnvelope({ ...makeBaseParams(), priority: 3, ttl: 3600 })
    expect(env.priority).toBe(3)
    expect(env.ttl).toBe(3600)
  })

  it('defaults payload_type to text', () => {
    const env = createEnvelope(makeBaseParams())
    expect(env.payload.type).toBe('text')
  })

  it('sets payload_type when provided', () => {
    const env = createEnvelope({ ...makeBaseParams(), payload_type: 'structured' })
    expect(env.payload.type).toBe('structured')
  })

  it('sets reply_to when provided', () => {
    const env = createEnvelope({ ...makeBaseParams(), reply_to: 'original-message-id' })
    expect(env.reply_to).toBe('original-message-id')
  })

  it('omits reply_to when not provided', () => {
    const env = createEnvelope(makeBaseParams())
    expect(env.reply_to).toBeUndefined()
  })

  it('sets created_at as a valid ISO 8601 string', () => {
    const before = Date.now()
    const env = createEnvelope(makeBaseParams())
    const after = Date.now()
    const ts = Date.parse(env.created_at)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
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

  it('includes mime_type in payload when provided', () => {
    const env = createEnvelope({
      ...makeBaseParams(),
      payload_type: 'document',
      mime_type: 'application/pdf',
    })
    expect(env.payload.mime_type).toBe('application/pdf')
  })

  it('includes transcript in payload when provided', () => {
    const env = createEnvelope({
      ...makeBaseParams(),
      payload_type: 'voice',
      transcript: 'Hello world',
    })
    expect(env.payload.transcript).toBe('Hello world')
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
    expect(signed.id).toBe(env.id)
    expect(signed.sender).toEqual(env.sender)
    expect(signed.recipient).toEqual(env.recipient)
    expect(signed.intent).toBe(env.intent)
    expect(signed.payload).toEqual(env.payload)
    expect(signed.created_at).toBe(env.created_at)
  })

  it('produces a different signature when content changes', async () => {
    const env1 = createEnvelope(makeBaseParams())
    const env2 = createEnvelope({ ...makeBaseParams(), content: 'Different content' })
    // Force same id/timestamp for a fair comparison
    const env2Patched = { ...env2, id: env1.id, created_at: env1.created_at }
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
    signed: ReachMessage
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
      payload: { ...signed.payload, content: 'Evil content!' },
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

  it('returns false when chi version is wrong', () => {
    const env = { ...createEnvelope(makeBaseParams()), chi: '2.0' }
    expect(validateEnvelope(env)).toBe(false)
  })

  it('returns false when id is missing', () => {
    const env = createEnvelope(makeBaseParams())
    const { id: _id, ...noId } = env
    expect(validateEnvelope(noId)).toBe(false)
  })

  it('returns false when sender.type is invalid', () => {
    const env = createEnvelope(makeBaseParams())
    const bad = { ...env, sender: { ...env.sender, type: 'INVALID' } }
    expect(validateEnvelope(bad)).toBe(false)
  })

  it('returns false when intent is invalid', () => {
    const env = createEnvelope(makeBaseParams())
    const bad = { ...env, intent: 'SHOUT' }
    expect(validateEnvelope(bad)).toBe(false)
  })

  it('returns false when priority is out of range', () => {
    const env = createEnvelope(makeBaseParams())
    const bad = { ...env, priority: 5 }
    expect(validateEnvelope(bad)).toBe(false)
  })

  it('returns false when ttl is zero', () => {
    // Bypass createEnvelope guard to construct a bad envelope directly
    const env = createEnvelope(makeBaseParams())
    const bad = { ...env, ttl: 0 }
    expect(validateEnvelope(bad)).toBe(false)
  })

  it('returns false when created_at is not a valid date string', () => {
    const env = createEnvelope(makeBaseParams())
    const bad = { ...env, created_at: 'not-a-date' }
    expect(validateEnvelope(bad)).toBe(false)
  })

  it('returns false when payload.type is invalid', () => {
    const env = createEnvelope(makeBaseParams())
    const bad = { ...env, payload: { ...env.payload, type: 'video' } }
    expect(validateEnvelope(bad)).toBe(false)
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
      created_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      ttl: 3600,
    }
    expect(isExpired(old)).toBe(true)
  })

  it('returns true when created_at is well before now and ttl has clearly elapsed', () => {
    const env = createEnvelope(makeBaseParams())
    const forceExpired = {
      ...env,
      // 10 seconds ago with a 1-second TTL — unambiguously expired
      created_at: new Date(Date.now() - 10_000).toISOString(),
      ttl: 1,
    }
    expect(isExpired(forceExpired)).toBe(true)
  })
})

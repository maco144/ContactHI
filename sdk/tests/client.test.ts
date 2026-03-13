/**
 * Tests for client.ts — ReachClient
 *
 * HTTP calls are mocked via jest's global fetch mock.
 * CosmWasm calls are mocked via jest.mock('@cosmjs/cosmwasm-stargate').
 */

import { ReachClient } from '../src/client'
import type { DeliveryAck, PermissionResult } from '../src/types'
import { RouterError, ConfigError, TimeoutError, ReachError } from '../src/errors'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const _cosmjsMocks = {
  queryContractSmart: jest.fn(),
}

jest.mock('@cosmjs/cosmwasm-stargate', () => ({
  CosmWasmClient: {
    connect: jest.fn().mockResolvedValue({
      queryContractSmart: (...args: unknown[]) =>
        _cosmjsMocks.queryContractSmart(...args),
    }),
  },
}))


const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROUTER_URL = 'https://router.chi.test'
const SENDER_DID = 'did:chi:cosmos1sender0000000000000000000000000'
const RECIPIENT_DID = 'did:chi:cosmos1recipient000000000000000000000'
const TEST_PRIVATE_KEY = 'a'.repeat(64) // 32 bytes

function makeClient(overrides?: Partial<ConstructorParameters<typeof ReachClient>[0]>) {
  return new ReachClient({
    router_url: ROUTER_URL,
    sender_did: SENDER_DID,
    sender_type: 'AA',
    private_key: TEST_PRIVATE_KEY,
    ...overrides,
  })
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function ack(
  status: DeliveryAck['status'],
  message_id = 'msg-id-1'
): DeliveryAck {
  return {
    message_id,
    status,
    channel_used: 'email',
    timestamp: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('ReachClient constructor', () => {
  it('constructs successfully with minimal config', () => {
    const client = new ReachClient({ router_url: ROUTER_URL })
    expect(client).toBeInstanceOf(ReachClient)
  })

  it('throws ConfigError when router_url is missing', () => {
    expect(() => new ReachClient({ router_url: '' })).toThrow(ConfigError)
  })

  it('exposes a preferences manager', () => {
    const client = makeClient()
    expect(client.preferences).toBeDefined()
    expect(typeof client.preferences.get).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// send()
// ---------------------------------------------------------------------------

describe('ReachClient.send()', () => {
  it('POSTs to /v1/messages with a valid envelope', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ message_id: 'msg-abc', status: 'pending', router_timestamp: new Date().toISOString() })
    )
    const client = makeClient()

    const result = await client.send({
      to: RECIPIENT_DID,
      intent: 'INFORM',
      content: 'Hello world',
    })

    expect(mockFetch).toHaveBeenCalledWith(
      `${ROUTER_URL}/v1/messages`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      })
    )
    expect(result.message_id).toBe('msg-abc')
    expect(result.status).toBe('pending')
  })

  it('signs the envelope when private_key is configured', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ message_id: 'msg-xyz', status: 'pending', router_timestamp: new Date().toISOString() })
    )
    const client = makeClient()

    await client.send({ to: RECIPIENT_DID, intent: 'INFORM', content: 'Signed!' })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.envelope.signature).toBeTruthy()
    expect(typeof body.envelope.signature).toBe('string')
    expect(body.envelope.signature.length).toBe(128)
  })

  it('does not attach signature when no private_key is configured', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ message_id: 'msg-unsigned', status: 'pending', router_timestamp: new Date().toISOString() })
    )
    const client = makeClient({ private_key: undefined })

    await client.send({ to: RECIPIENT_DID, intent: 'INFORM', content: 'Unsigned' })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.envelope.signature).toBeUndefined()
  })

  it('accepts a raw Cosmos address (non-DID) as recipient', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ message_id: 'msg-raw', status: 'pending', router_timestamp: new Date().toISOString() })
    )
    const client = makeClient()

    await client.send({
      to: 'cosmos1recipient000000000000000000000',
      intent: 'INFORM',
      content: 'Raw address recipient',
    })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.envelope.recipient.did).toBe('did:chi:cosmos1recipient000000000000000000000')
  })

  it('passes reply_to and priority through to the envelope', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ message_id: 'msg-1', status: 'pending', router_timestamp: new Date().toISOString() })
    )
    const client = makeClient()

    await client.send({
      to: RECIPIENT_DID,
      intent: 'RESULT',
      content: 'Reply content',
      priority: 3,
      reply_to: 'original-msg-id',
    })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.envelope.priority).toBe(3)
    expect(body.envelope.reply_to).toBe('original-msg-id')
  })

  it('throws ConfigError when sender_did is not configured', async () => {
    const client = makeClient({ sender_did: undefined })
    await expect(
      client.send({ to: RECIPIENT_DID, intent: 'INFORM', content: 'test' })
    ).rejects.toThrow(ConfigError)
  })

  it('throws ReachError PERMISSION_DENIED on 403', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, text: async () => 'denied' })
    const client = makeClient()
    await expect(
      client.send({ to: RECIPIENT_DID, intent: 'INFORM', content: 'blocked' })
    ).rejects.toThrow(ReachError)
  })

  it('throws ReachError SENDER_BLOCKLISTED on 403 with blocklist body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'sender on recipient blocklist',
    })
    const client = makeClient()

    let err: ReachError | undefined
    try {
      await client.send({ to: RECIPIENT_DID, intent: 'INFORM', content: 'blocked' })
    } catch (e) {
      err = e as ReachError
    }

    expect(err).toBeInstanceOf(ReachError)
    expect(err!.code).toBe('SENDER_BLOCKLISTED')
  })

  it('throws ReachError RECIPIENT_NOT_FOUND on 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => 'Not found' })
    const client = makeClient()

    let err: ReachError | undefined
    try {
      await client.send({ to: RECIPIENT_DID, intent: 'INFORM', content: 'test' })
    } catch (e) {
      err = e as ReachError
    }

    expect(err!.code).toBe('RECIPIENT_NOT_FOUND')
  })

  it('throws RouterError on 500', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' })
    const client = makeClient()
    await expect(
      client.send({ to: RECIPIENT_DID, intent: 'INFORM', content: 'test' })
    ).rejects.toThrow(RouterError)
  })
})

// ---------------------------------------------------------------------------
// checkPermission()
// ---------------------------------------------------------------------------

describe('ReachClient.checkPermission()', () => {
  const ALLOWED: PermissionResult = {
    allowed: true,
    allowed_channels: ['email', 'push'],
    rate_limit_remaining: 50,
  }

  const DENIED: PermissionResult = {
    allowed: false,
    allowed_channels: [],
    reason: 'Blocked by recipient rule',
  }

  it('delegates to preferences.checkPermission and returns result', async () => {
    mockFetch.mockResolvedValue(jsonResponse(ALLOWED))
    const client = makeClient()

    const result = await client.checkPermission({
      recipient: RECIPIENT_DID,
      intent: 'INFORM',
    })

    expect(result.allowed).toBe(true)
    expect(result.allowed_channels).toContain('email')
  })

  it('returns denied result without throwing', async () => {
    mockFetch.mockResolvedValue(jsonResponse(DENIED))
    const client = makeClient()

    const result = await client.checkPermission({
      recipient: RECIPIENT_DID,
      intent: 'COLLECT',
    })

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('Blocked by recipient rule')
  })

  it('sends the correct sender_did and sender_type to the router', async () => {
    mockFetch.mockResolvedValue(jsonResponse(ALLOWED))
    const client = makeClient({ sender_type: 'LM' })

    await client.checkPermission({ recipient: RECIPIENT_DID, intent: 'AUTHORIZE' })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.sender_did).toBe(SENDER_DID)
    expect(body.sender_type).toBe('LM')
    expect(body.intent).toBe('AUTHORIZE')
  })

  it('defaults sender_type to US when not configured', async () => {
    mockFetch.mockResolvedValue(jsonResponse(ALLOWED))
    const client = makeClient({ sender_type: undefined })

    await client.checkPermission({ recipient: RECIPIENT_DID, intent: 'INFORM' })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.sender_type).toBe('US')
  })

  it('throws ConfigError when sender_did is not set', async () => {
    const client = makeClient({ sender_did: undefined })
    await expect(
      client.checkPermission({ recipient: RECIPIENT_DID, intent: 'INFORM' })
    ).rejects.toThrow(ConfigError)
  })
})

// ---------------------------------------------------------------------------
// getStatus()
// ---------------------------------------------------------------------------

describe('ReachClient.getStatus()', () => {
  it('GETs the correct status endpoint', async () => {
    mockFetch.mockResolvedValue(jsonResponse(ack('delivered')))
    const client = makeClient()

    const result = await client.getStatus('msg-id-1')

    expect(mockFetch).toHaveBeenCalledWith(
      `${ROUTER_URL}/v1/messages/msg-id-1/status`,
      expect.objectContaining({ headers: { Accept: 'application/json' } })
    )
    expect(result.status).toBe('delivered')
    expect(result.message_id).toBe('msg-id-1')
  })

  it('URL-encodes special characters in message_id', async () => {
    mockFetch.mockResolvedValue(jsonResponse(ack('pending', 'a b+c')))
    const client = makeClient()

    await client.getStatus('a b+c')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('a%20b%2Bc'),
      expect.anything()
    )
  })

  it('throws RouterError on 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' })
    const client = makeClient()
    await expect(client.getStatus('unknown')).rejects.toThrow(ReachError)
  })

  it('throws ReachError for empty message_id', async () => {
    const client = makeClient()
    await expect(client.getStatus('')).rejects.toThrow(ReachError)
  })
})

// ---------------------------------------------------------------------------
// waitForAck()
// ---------------------------------------------------------------------------

describe('ReachClient.waitForAck()', () => {
  it('returns immediately when status is already terminal', async () => {
    mockFetch.mockResolvedValue(jsonResponse(ack('delivered')))
    const client = makeClient()

    const result = await client.waitForAck('msg-id-1', 5000)

    expect(result.status).toBe('delivered')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('polls until terminal status is received', async () => {
    // First 2 responses: pending; 3rd: delivered
    mockFetch
      .mockResolvedValueOnce(jsonResponse(ack('pending')))
      .mockResolvedValueOnce(jsonResponse(ack('pending')))
      .mockResolvedValueOnce(jsonResponse(ack('delivered')))

    const client = makeClient()
    const result = await client.waitForAck('msg-id-1', 10_000)

    expect(result.status).toBe('delivered')
    expect(mockFetch).toHaveBeenCalledTimes(3)
  }, 15_000)

  it('resolves on "failed" status (terminal)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(ack('failed')))
    const client = makeClient()

    const result = await client.waitForAck('msg-id-fail', 5000)
    expect(result.status).toBe('failed')
  })

  it('resolves on "expired" status (terminal)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(ack('expired')))
    const client = makeClient()

    const result = await client.waitForAck('msg-id-exp', 5000)
    expect(result.status).toBe('expired')
  })

  it('throws TimeoutError when status never reaches terminal', async () => {
    // Always return pending — will time out
    mockFetch.mockResolvedValue(jsonResponse(ack('pending')))

    const client = makeClient()

    await expect(
      client.waitForAck('msg-id-stuck', 50)  // 50ms timeout
    ).rejects.toThrow(TimeoutError)
  }, 5_000)

  it('TimeoutError carries the correct message_id', async () => {
    mockFetch.mockResolvedValue(jsonResponse(ack('pending')))
    const client = makeClient()

    let err: TimeoutError | undefined
    try {
      await client.waitForAck('my-special-id', 50)
    } catch (e) {
      err = e as TimeoutError
    }

    expect(err).toBeInstanceOf(TimeoutError)
    expect(err!.message_id).toBe('my-special-id')
    expect(err!.code).toBe('TIMEOUT')
  }, 5_000)
})

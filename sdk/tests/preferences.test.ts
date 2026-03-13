/**
 * Tests for preferences.ts — PreferencesManager
 *
 * All HTTP calls are mocked via jest's global fetch mock.
 * On-chain CosmWasm calls are mocked via jest.mock('@cosmjs/cosmwasm-stargate').
 */

import { PreferencesManager } from '../src/preferences'
import type { HumanPreferences, PreferenceRule, PermissionResult } from '../src/types'
import { RouterError, ConfigError, ReachError } from '../src/errors'

// ---------------------------------------------------------------------------
// Mock @cosmjs/cosmwasm-stargate
//
// jest.mock() is hoisted above variable declarations, so we cannot reference
// a `const mockQueryContractSmart` in the factory. Instead we store it on a
// shared object that the factory closes over — this reference is stable at
// hoist time.
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

// Convenience alias
const mockQueryContractSmart = _cosmjsMocks.queryContractSmart

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROUTER_URL = 'https://router.chi.test'
const COSMOS_RPC = 'https://rpc.cosmos.test'
const REGISTRY = 'cosmos1registry000000000000000000000000000'
const SENDER_DID = 'did:chi:cosmos1sender0000000000000000000000000'
const SENDER_ADDRESS = 'cosmos1sender0000000000000000000000000'

const SAMPLE_RULE: PreferenceRule = {
  sender_type: 'AA',
  intent: 'INFORM',
  allowed_channels: ['email', 'push'],
}

const SAMPLE_PREFS: HumanPreferences = {
  did: SENDER_DID,
  rules: [SAMPLE_RULE],
  default_policy: 'block',
  webhook_url: 'https://example.com/webhook',
  updated_at: new Date().toISOString(),
}

/** Chain response shape from CosmWasm */
const CHAIN_PREFS_RESPONSE = {
  owner: SENDER_ADDRESS,
  rules: [SAMPLE_RULE],
  default_policy: 'block' as const,
  webhook_url: 'https://example.com/webhook',
  updated_at: Math.floor(Date.now() / 1000),
}

function makeManager(opts?: {
  cosmos_rpc?: string
  registry_address?: string
  sender_did?: string
}) {
  return new PreferencesManager({
    router_url: ROUTER_URL,
    sender_did: opts?.sender_did ?? SENDER_DID,
    cosmos_rpc: opts?.cosmos_rpc,
    registry_address: opts?.registry_address,
  })
}

function makeManagerWithChain() {
  return makeManager({ cosmos_rpc: COSMOS_RPC, registry_address: REGISTRY })
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
})

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe('PreferencesManager.get()', () => {
  it('queries on-chain when cosmos_rpc + registry_address are configured', async () => {
    mockQueryContractSmart.mockResolvedValue(CHAIN_PREFS_RESPONSE)
    const mgr = makeManagerWithChain()

    const result = await mgr.get()

    expect(mockQueryContractSmart).toHaveBeenCalledWith(REGISTRY, {
      get_preferences: { address: SENDER_ADDRESS },
    })
    expect(result).not.toBeNull()
    expect(result!.did).toBe(SENDER_DID)
    expect(result!.rules).toEqual([SAMPLE_RULE])
    expect(result!.default_policy).toBe('block')
  })

  it('returns null when chain reports preferences not found', async () => {
    mockQueryContractSmart.mockRejectedValue(new Error('PreferencesNotFound: not found'))
    const mgr = makeManagerWithChain()

    const result = await mgr.get()
    expect(result).toBeNull()
  })

  it('falls back to router HTTP when no chain config provided', async () => {
    mockFetch.mockResolvedValue(jsonResponse(SAMPLE_PREFS))
    const mgr = makeManager()

    const result = await mgr.get()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/preferences/'),
      expect.objectContaining({ headers: { Accept: 'application/json' } })
    )
    expect(result).toEqual(SAMPLE_PREFS)
  })

  it('returns null when router responds 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => 'Not found' })
    const mgr = makeManager()

    const result = await mgr.get()
    expect(result).toBeNull()
  })

  it('throws RouterError on non-404 router failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'Internal error' })
    const mgr = makeManager()

    await expect(mgr.get()).rejects.toThrow(RouterError)
  })

  it('throws ConfigError when no sender_did and no did argument', async () => {
    const mgr = new PreferencesManager({ router_url: ROUTER_URL })
    await expect(mgr.get()).rejects.toThrow(ConfigError)
  })

  it('accepts an explicit DID argument overriding sender_did', async () => {
    const other = 'did:chi:cosmos1other00000000000000000000000000'
    mockFetch.mockResolvedValue(jsonResponse(SAMPLE_PREFS))
    const mgr = makeManager()

    await mgr.get(other)

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('cosmos1other'),
      expect.anything()
    )
  })
})

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

describe('PreferencesManager.register()', () => {
  it('POSTs register action to router', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    const mgr = makeManager()

    await mgr.register({
      rules: [SAMPLE_RULE],
      default_policy: 'block',
      webhook_url: 'https://example.com/webhook',
    })

    expect(mockFetch).toHaveBeenCalledWith(
      `${ROUTER_URL}/v1/preferences`,
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"action":"register"'),
      })
    )
  })

  it('includes sender_did in the request body', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    const mgr = makeManager()

    await mgr.register({ rules: [], default_policy: 'allow' })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.sender_did).toBe(SENDER_DID)
  })

  it('throws ConfigError when sender_did is not set', async () => {
    const mgr = new PreferencesManager({ router_url: ROUTER_URL })
    await expect(mgr.register({ rules: [], default_policy: 'allow' })).rejects.toThrow(ConfigError)
  })

  it('throws RouterError on router failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'fail' })
    const mgr = makeManager()
    await expect(mgr.register({ rules: [], default_policy: 'allow' })).rejects.toThrow(RouterError)
  })
})

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

describe('PreferencesManager.update()', () => {
  it('fetches current prefs then POSTs update action', async () => {
    // First call is the get(), second is the update
    mockFetch
      .mockResolvedValueOnce(jsonResponse(SAMPLE_PREFS))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })

    const mgr = makeManager()
    await mgr.update({ default_policy: 'allow' })

    expect(mockFetch).toHaveBeenCalledTimes(2)
    const updateBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(updateBody.action).toBe('update')
    expect(updateBody.payload.default_policy).toBe('allow')
  })

  it('throws ReachError RECIPIENT_NOT_FOUND when no existing preferences', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => 'Not found' })
    const mgr = makeManager()

    await expect(mgr.update({ default_policy: 'allow' })).rejects.toThrow(ReachError)
  })
})

// ---------------------------------------------------------------------------
// addRule()
// ---------------------------------------------------------------------------

describe('PreferencesManager.addRule()', () => {
  it('POSTs add_rule action with the rule in payload', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    const mgr = makeManager()

    await mgr.addRule(SAMPLE_RULE)

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.action).toBe('add_rule')
    expect(body.payload.rule).toEqual(SAMPLE_RULE)
  })
})

// ---------------------------------------------------------------------------
// removeRule()
// ---------------------------------------------------------------------------

describe('PreferencesManager.removeRule()', () => {
  it('POSTs remove_rule action with the index in payload', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    const mgr = makeManager()

    await mgr.removeRule(2)

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.action).toBe('remove_rule')
    expect(body.payload.index).toBe(2)
  })

  it('throws ReachError for negative index', async () => {
    const mgr = makeManager()
    await expect(mgr.removeRule(-1)).rejects.toThrow(ReachError)
  })

  it('throws ReachError for non-integer index', async () => {
    const mgr = makeManager()
    await expect(mgr.removeRule(1.5)).rejects.toThrow(ReachError)
  })
})

// ---------------------------------------------------------------------------
// blockSender()
// ---------------------------------------------------------------------------

describe('PreferencesManager.blockSender()', () => {
  it('POSTs block_sender action with the pattern', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    const mgr = makeManager()

    await mgr.blockSender('did:chi:cosmos1spam0000000000000000000000000')

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.action).toBe('block_sender')
    expect(body.payload.pattern).toBe('did:chi:cosmos1spam0000000000000000000000000')
  })

  it('trims whitespace from pattern', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    const mgr = makeManager()

    await mgr.blockSender('  spam.example.com  ')

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.payload.pattern).toBe('spam.example.com')
  })

  it('throws ReachError for empty pattern', async () => {
    const mgr = makeManager()
    await expect(mgr.blockSender('')).rejects.toThrow(ReachError)
    await expect(mgr.blockSender('   ')).rejects.toThrow(ReachError)
  })
})

// ---------------------------------------------------------------------------
// unblockSender()
// ---------------------------------------------------------------------------

describe('PreferencesManager.unblockSender()', () => {
  it('POSTs unblock_sender action', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    const mgr = makeManager()

    await mgr.unblockSender('spam.example.com')

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.action).toBe('unblock_sender')
    expect(body.payload.pattern).toBe('spam.example.com')
  })
})

// ---------------------------------------------------------------------------
// checkPermission()
// ---------------------------------------------------------------------------

describe('PreferencesManager.checkPermission()', () => {
  const PERMISSION_RESULT: PermissionResult = {
    allowed: true,
    allowed_channels: ['email'],
    rate_limit_remaining: 100,
  }

  it('queries chain when cosmos_rpc + registry are configured', async () => {
    mockQueryContractSmart.mockResolvedValue({
      allowed: true,
      allowed_channels: ['email'],
      reason: null,
      rate_limit_remaining: 100,
    })
    const mgr = makeManagerWithChain()

    const result = await mgr.checkPermission(
      'did:chi:cosmos1sender0000000000000000000000000',
      'AA',
      'INFORM'
    )

    expect(mockQueryContractSmart).toHaveBeenCalledWith(REGISTRY, {
      check_permission: {
        sender_did: 'did:chi:cosmos1sender0000000000000000000000000',
        sender_type: 'AA',
        recipient: SENDER_ADDRESS,
        intent: 'INFORM',
      },
    })
    expect(result.allowed).toBe(true)
    expect(result.allowed_channels).toEqual(['email'])
    expect(result.rate_limit_remaining).toBe(100)
  })

  it('falls back to router HTTP when no chain config', async () => {
    mockFetch.mockResolvedValue(jsonResponse(PERMISSION_RESULT))
    const mgr = makeManager()

    const result = await mgr.checkPermission(
      'did:chi:cosmos1sender0000000000000000000000000',
      'AA',
      'INFORM'
    )

    expect(mockFetch).toHaveBeenCalledWith(
      `${ROUTER_URL}/v1/check-permission`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(result).toEqual(PERMISSION_RESULT)
  })

  it('throws ConfigError when no recipient DID is determinable', async () => {
    const mgr = new PreferencesManager({ router_url: ROUTER_URL })
    await expect(
      mgr.checkPermission('did:chi:cosmos1sender', 'AA', 'INFORM')
    ).rejects.toThrow(ConfigError)
  })

  it('maps null reason/rate_limit_remaining to undefined', async () => {
    mockQueryContractSmart.mockResolvedValue({
      allowed: false,
      allowed_channels: [],
      reason: null,
      rate_limit_remaining: null,
    })
    const mgr = makeManagerWithChain()
    const result = await mgr.checkPermission('did:chi:cosmos1sender', 'AA', 'INFORM')

    expect(result.reason).toBeUndefined()
    expect(result.rate_limit_remaining).toBeUndefined()
  })
})

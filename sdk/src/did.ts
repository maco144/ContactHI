/**
 * CHI/1.0 Protocol — DID Utilities
 *
 * The did:chi: method wraps Cosmos bech32 addresses:
 *   did:chi:cosmos1abc...xyz
 *
 * DID resolution queries the on-chain preference registry via CosmWasm
 * smart contract queries.
 */

import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import type { HumanPreferences, ChainPreferencesResponse } from './types'
import { ReachError } from './errors'

const DID_METHOD = 'chi'
const DID_PREFIX = `did:${DID_METHOD}:`

// ---------------------------------------------------------------------------
// DID construction / parsing
// ---------------------------------------------------------------------------

/**
 * Create a did:chi: DID from a Cosmos bech32 address.
 *
 * @example
 * createDID('cosmos1abc123')  // => 'did:chi:cosmos1abc123'
 */
export function createDID(cosmos_address: string): string {
  if (!cosmos_address || typeof cosmos_address !== 'string') {
    throw new ReachError('INVALID_ENVELOPE', 'cosmos_address must be a non-empty string')
  }
  const trimmed = cosmos_address.trim()
  // If it's already a full DID, return as-is
  if (trimmed.startsWith(DID_PREFIX)) {
    return trimmed
  }
  return `${DID_PREFIX}${trimmed}`
}

/**
 * Parse a did:chi: DID into its components.
 *
 * @throws ReachError('INVALID_ENVELOPE') if the DID is malformed
 */
export function parseDID(did: string): { method: string; address: string } {
  if (!did || typeof did !== 'string') {
    throw new ReachError('INVALID_ENVELOPE', 'DID must be a non-empty string')
  }
  if (!did.startsWith(DID_PREFIX)) {
    throw new ReachError(
      'INVALID_ENVELOPE',
      `DID must start with "${DID_PREFIX}", got: ${did}`
    )
  }
  const address = did.slice(DID_PREFIX.length)
  if (!address) {
    throw new ReachError('INVALID_ENVELOPE', `DID has no address component: ${did}`)
  }
  return { method: DID_METHOD, address }
}

/**
 * Validate that a string is a well-formed did:chi: DID.
 */
export function isValidDID(did: string): boolean {
  try {
    parseDID(did)
    return true
  } catch {
    return false
  }
}

/**
 * Extract the raw Cosmos address from a DID or bech32 address string.
 * Returns the input unchanged if it is already an address (not a DID).
 */
export function addressFromDID(did: string): string {
  if (did.startsWith(DID_PREFIX)) {
    return parseDID(did).address
  }
  return did
}

// ---------------------------------------------------------------------------
// On-chain DID resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a did:chi: DID by querying the on-chain preference registry.
 *
 * Returns the recipient's `HumanPreferences` if registered, or `null` if not found.
 *
 * @param did              - did:chi: DID or raw Cosmos address
 * @param cosmos_rpc       - Cosmos RPC endpoint URL
 * @param registry_address - CosmWasm contract address of the preference registry
 */
export async function resolveDID(
  did: string,
  cosmos_rpc: string,
  registry_address: string
): Promise<HumanPreferences | null> {
  const address = addressFromDID(did)

  let client: CosmWasmClient
  try {
    client = await CosmWasmClient.connect(cosmos_rpc)
  } catch (err) {
    throw new ReachError(
      'ROUTER_ERROR',
      `Failed to connect to Cosmos RPC at ${cosmos_rpc}: ${String(err)}`
    )
  }

  let response: ChainPreferencesResponse
  try {
    response = await client.queryContractSmart(registry_address, {
      get_preferences: { address },
    }) as ChainPreferencesResponse
  } catch (err) {
    const msg = String(err)
    // CosmWasm returns a "not found" / "unknown" error when no preferences exist
    if (
      msg.includes('not found') ||
      msg.includes('unknown') ||
      msg.includes('PreferencesNotFound')
    ) {
      return null
    }
    throw new ReachError(
      'ROUTER_ERROR',
      `Failed to query preferences for ${address}: ${msg}`
    )
  }

  return chainResponseToPreferences(did, response)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert the on-chain CosmWasm response to the SDK's HumanPreferences shape.
 * updated_at on-chain is a u64 unix timestamp in seconds.
 */
function chainResponseToPreferences(
  did: string,
  chain: ChainPreferencesResponse
): HumanPreferences {
  return {
    did,
    rules: chain.rules,
    default_policy: chain.default_policy,
    webhook_url: chain.webhook_url ?? undefined,
    updated_at: new Date(chain.updated_at * 1000).toISOString(),
  }
}

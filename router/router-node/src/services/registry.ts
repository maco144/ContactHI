import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import { config } from '../config';

/**
 * CosmWasm preference-registry client.
 *
 * ## Why this file was rewritten (2026-09-02)
 *
 * It previously declared its own `PreferenceRule` shape —
 * `{ sender_pattern, sender_types[], intents[], action }` — and re-implemented
 * rule matching in TypeScript against it. **The contract has never emitted any
 * of those fields.** `contracts/src/state.rs` defines a rule as
 * `{ sender_type, intent, allowed_channels, rate_limit, time_window, blocklist }`.
 *
 * With a real registry attached, every matcher read an undefined field and
 * returned `true`, so the first rule always "matched"; then
 * `rule.action === 'allow'` compared `undefined` and fell to the deny branch.
 * The router would have blocked 100% of traffic on the first rule of any real
 * profile. It was never noticed because REGISTRY_CONTRACT has never been set.
 *
 * The contract already evaluates rules on-chain and protocol-spec.md §5.4 says
 * so plainly — *"the registry exposes a single primary query endpoint:
 * check_permission"*. So we ask it, rather than guessing at its data model.
 */

// ---------------------------------------------------------------------------
// On-chain vocabulary — mirrors contracts/src/state.rs exactly.
// Verified against contracts/schema/raw/query.json; regenerate that with
// `cargo run --bin schema` if the enums ever change.
// ---------------------------------------------------------------------------

export type EntityTypeCode =
  | 'CA' | 'LM' | 'GN' | 'AA' | 'RB'
  | 'DR' | 'VH' | 'US' | 'CP' | 'HS'
  | 'any';

export type IntentCode =
  | 'inform' | 'collect' | 'authorize' | 'escalate' | 'result' | 'any';

/** Channel names as the contract serializes them (snake_case). */
export type ChainChannel =
  | 'push' | 'sms' | 'email' | 'webhook' | 'in_app' | 'agent_inbox';

/** A rule exactly as `contracts/src/state.rs::PreferenceRule` serializes it. */
export interface ChainPreferenceRule {
  sender_type: EntityTypeCode;
  intent: IntentCode;
  allowed_channels: ChainChannel[];
  rate_limit?: { count: number; period: string } | null;
  time_window?: { start: string; end: string } | null;
  blocklist: string[];
}

/** `PreferencesResponse` from the contract. */
export interface HumanPreferences {
  owner: string;
  rules: ChainPreferenceRule[];
  default_policy: 'block' | 'allow';
  webhook_url?: string | null;
  updated_at: number;
}

/** `PermissionResponse` from the contract. */
interface ChainPermissionResponse {
  allowed: boolean;
  allowed_channels: ChainChannel[];
  reason?: string | null;
  rate_limit_remaining?: number | null;
}

export interface PermissionResult {
  granted: boolean;
  reason: string;
  allowed_channels?: string[];
  rate_limit_remaining?: number;
}

// ---------------------------------------------------------------------------
// Vocabulary translation
// ---------------------------------------------------------------------------

const VALID_ENTITY_CODES = new Set<string>([
  'CA', 'LM', 'GN', 'AA', 'RB', 'DR', 'VH', 'US', 'CP', 'HS', 'any',
]);

/**
 * The router accepted `human|agent|service|device|dao` for its first six
 * months. Those names exist nowhere in the contract, the spec, or the SDK, and
 * the endpoint has no real callers — so they are simply gone rather than
 * carried forward as a compatibility shim nobody needs.
 */
export function toEntityCode(sender_type: string): EntityTypeCode | null {
  return VALID_ENTITY_CODES.has(sender_type) ? (sender_type as EntityTypeCode) : null;
}

const VALID_INTENT_CODES = new Set<string>([
  'inform', 'collect', 'authorize', 'escalate', 'result', 'any',
]);

/**
 * CHI envelopes carry a granular namespaced intent (`inform.shipping_update`);
 * the registry stores the coarse class (`inform`). The namespace IS the class,
 * so the chain query uses the segment before the first dot.
 */
export function toChainIntent(intent: string): IntentCode {
  const namespace = intent.split('.')[0]?.toLowerCase() ?? '';
  return (VALID_INTENT_CODES.has(namespace) ? namespace : 'any') as IntentCode;
}

/** Contract channel names → the router's internal channel names. */
const CHANNEL_FROM_CHAIN: Record<ChainChannel, string> = {
  push: 'push',
  sms: 'sms',
  email: 'email',
  webhook: 'webhook',
  in_app: 'in-app',
  agent_inbox: 'agent-inbox',
};

function mapChannels(channels: ChainChannel[] | undefined): string[] {
  if (!channels?.length) return ['agent-inbox'];
  return channels.map((c) => CHANNEL_FROM_CHAIN[c] ?? c);
}

// ---------------------------------------------------------------------------
// Client + cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expires: number;
}

const prefCache = new Map<string, CacheEntry<HumanPreferences | null>>();
const permCache = new Map<string, CacheEntry<PermissionResult>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cosmClient: CosmWasmClient | null = null;

async function getCosmClient(): Promise<CosmWasmClient> {
  if (!cosmClient) {
    cosmClient = await CosmWasmClient.connect(config.cosmos_rpc);
  }
  return cosmClient;
}

/**
 * Fetch the full preference profile for a recipient. Used for channel endpoint
 * data during delivery, NOT for the permission decision — that is `checkPermission`.
 * Returns null if the recipient has no profile.
 */
export async function getPreferences(address: string): Promise<HumanPreferences | null> {
  const cached = prefCache.get(address);
  if (cached && Date.now() < cached.expires) {
    return cached.value;
  }

  if (!config.registry_contract) {
    return null;
  }

  try {
    const client = await getCosmClient();
    const result = (await client.queryContractSmart(config.registry_contract, {
      get_preferences: { address },
    })) as HumanPreferences | null;

    prefCache.set(address, { value: result, expires: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('unknown address')) {
      prefCache.set(address, { value: null, expires: Date.now() + CACHE_TTL_MS });
      return null;
    }
    console.error('[registry] CosmWasm query failed:', msg);
    throw new Error(`Registry query failed: ${msg}`);
  }
}

/**
 * Ask the registry whether a sender may contact a recipient with a given intent.
 *
 * Rule evaluation happens on-chain (contracts/src/contract.rs::check_permission),
 * which is the only place that can see the recipient's rules, blocklists, rate
 * limits and time windows. This function translates vocabularies and caches.
 */
export async function checkPermission(
  sender_did: string,
  sender_type: string,
  recipient_did: string,
  intent: string
): Promise<PermissionResult> {
  // No registry contract → nothing to enforce against. Say so in the result
  // rather than letting it read as a genuine "this recipient has no rules".
  if (!config.registry_contract) {
    console.warn(
      `[registry] UNENFORCED: granting ${sender_did} → ${recipient_did} (${intent}) ` +
        'because REGISTRY_CONTRACT is not set. No consent was checked.'
    );
    return {
      granted: true,
      reason: 'NO_REGISTRY_CONFIGURED',
      // Without a registry we will not reach a human on an external channel.
      allowed_channels: ['agent-inbox'],
    };
  }

  const recipientAddress = didToAddress(recipient_did);
  const entityCode = toEntityCode(sender_type);
  const chainIntent = toChainIntent(intent);

  if (!entityCode) {
    return {
      granted: false,
      reason: `UNKNOWN_SENDER_TYPE:${sender_type}`,
    };
  }

  const cacheKey = `${sender_did}|${entityCode}|${recipientAddress}|${chainIntent}`;
  const cached = permCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) {
    return cached.value;
  }

  let response: ChainPermissionResponse;
  try {
    const client = await getCosmClient();
    response = (await client.queryContractSmart(config.registry_contract, {
      check_permission: {
        sender_did,
        sender_type: entityCode,
        recipient: recipientAddress,
        intent: chainIntent,
      },
    })) as ChainPermissionResponse;
  } catch (err) {
    // Registry unreachable — fail open so a chain outage does not halt all
    // routing. A *reachable* registry that denies is honoured below.
    console.warn('[registry] Falling back to allow-all due to registry error:', err);
    return { granted: true, reason: 'REGISTRY_UNAVAILABLE' };
  }

  const result: PermissionResult = response.allowed
    ? {
        granted: true,
        reason: response.reason ?? 'RULE_MATCH',
        allowed_channels: mapChannels(response.allowed_channels),
        ...(response.rate_limit_remaining != null
          ? { rate_limit_remaining: response.rate_limit_remaining }
          : {}),
      }
    : {
        granted: false,
        reason: response.reason ?? 'DEFAULT_BLOCK',
      };

  permCache.set(cacheKey, { value: result, expires: Date.now() + CACHE_TTL_MS });
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function didToAddress(did: string): string {
  // did:chi:<address> / did:cosmos:<chain>:<address> → <address>
  const parts = did.split(':');
  return parts[parts.length - 1];
}

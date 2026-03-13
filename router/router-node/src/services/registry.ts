import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import { config } from '../config';

export interface PreferenceRule {
  sender_pattern: string;   // glob or exact DID
  sender_types: string[];   // entity types this rule applies to
  intents: string[];        // intent patterns ("*" = all)
  action: 'allow' | 'block';
  reason?: string;
}

export interface HumanPreferences {
  recipient_did: string;
  rules: PreferenceRule[];
  default_policy: 'allow' | 'block';
  allowed_channels: string[];
}

export interface PermissionResult {
  granted: boolean;
  reason: string;
  matched_rule?: PreferenceRule;
  allowed_channels?: string[];
}

// Simple TTL cache: key → { value, expires }
interface CacheEntry<T> {
  value: T;
  expires: number;
}

const prefCache = new Map<string, CacheEntry<HumanPreferences | null>>();
const PREF_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cosmClient: CosmWasmClient | null = null;

async function getCosmClient(): Promise<CosmWasmClient> {
  if (!cosmClient) {
    cosmClient = await CosmWasmClient.connect(config.cosmos_rpc);
  }
  return cosmClient;
}

/**
 * Fetch preference record for a recipient from the CosmWasm registry contract.
 * Returns null if the recipient has no record (falls back to default "allow").
 */
export async function getPreferences(address: string): Promise<HumanPreferences | null> {
  const cached = prefCache.get(address);
  if (cached && Date.now() < cached.expires) {
    return cached.value;
  }

  if (!config.registry_contract) {
    // No contract configured — permissive mode
    console.warn('[registry] REGISTRY_CONTRACT not set; skipping on-chain preference lookup');
    return null;
  }

  try {
    const client = await getCosmClient();
    // The contract query message: { get_preferences: { address } }
    const result = await client.queryContractSmart(config.registry_contract, {
      get_preferences: { address },
    }) as HumanPreferences | null;

    prefCache.set(address, { value: result, expires: Date.now() + PREF_TTL_MS });
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // A "not found" error from CosmWasm means the address has no prefs record.
    if (msg.includes('not found') || msg.includes('unknown address')) {
      prefCache.set(address, { value: null, expires: Date.now() + PREF_TTL_MS });
      return null;
    }
    console.error('[registry] CosmWasm query failed:', msg);
    throw new Error(`Registry query failed: ${msg}`);
  }
}

/**
 * Evaluates whether a sender is permitted to contact a recipient for a given intent.
 * Rule evaluation order: explicit rules first (most specific wins), then default_policy.
 */
export async function checkPermission(
  sender_did: string,
  sender_type: string,
  recipient_did: string,
  intent: string
): Promise<PermissionResult> {
  // Extract the Cosmos address from the recipient DID (did:cosmos:<chain>:<address>)
  const recipientAddress = didToAddress(recipient_did);

  let prefs: HumanPreferences | null = null;
  try {
    prefs = await getPreferences(recipientAddress);
  } catch (err) {
    // Registry unavailable — fail open so we don't break all routing
    console.warn('[registry] Falling back to allow-all due to registry error:', err);
    return { granted: true, reason: 'REGISTRY_UNAVAILABLE' };
  }

  // No preference record → system default: allow
  if (!prefs) {
    return {
      granted: true,
      reason: 'NO_PREFERENCES_RECORD',
      allowed_channels: ['push', 'agent-inbox'],
    };
  }

  // Evaluate rules in order
  for (const rule of prefs.rules) {
    if (!ruleMatchesEntityType(rule, sender_type)) continue;
    if (!ruleMatchesIntent(rule, intent)) continue;
    if (!ruleMatchesSender(rule, sender_did)) continue;

    if (rule.action === 'allow') {
      return {
        granted: true,
        reason: 'RULE_MATCH',
        matched_rule: rule,
        allowed_channels: prefs.allowed_channels,
      };
    } else {
      return {
        granted: false,
        reason: rule.reason ?? 'RULE_MATCH_BLOCKED',
        matched_rule: rule,
      };
    }
  }

  // Default policy
  if (prefs.default_policy === 'allow') {
    return {
      granted: true,
      reason: 'DEFAULT_ALLOW',
      allowed_channels: prefs.allowed_channels,
    };
  } else {
    return {
      granted: false,
      reason: 'DEFAULT_BLOCK',
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function didToAddress(did: string): string {
  // did:cosmos:<chain>:<address> → <address>
  // did:key:<...> → full did (no CosmWasm lookup will succeed, handled gracefully)
  const parts = did.split(':');
  return parts[parts.length - 1];
}

function ruleMatchesEntityType(rule: PreferenceRule, sender_type: string): boolean {
  if (!rule.sender_types || rule.sender_types.length === 0) return true;
  return rule.sender_types.includes(sender_type) || rule.sender_types.includes('*');
}

function ruleMatchesIntent(rule: PreferenceRule, intent: string): boolean {
  if (!rule.intents || rule.intents.length === 0) return true;
  return rule.intents.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.endsWith('.*')) {
      return intent.startsWith(pattern.slice(0, -1));
    }
    return pattern === intent;
  });
}

function ruleMatchesSender(rule: PreferenceRule, sender_did: string): boolean {
  const pattern = rule.sender_pattern;
  if (!pattern || pattern === '*') return true;
  if (pattern.startsWith('did:')) {
    // Exact DID match
    return pattern === sender_did;
  }
  // Simple glob: "did:cosmos:*" style
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(sender_did);
  }
  return pattern === sender_did;
}

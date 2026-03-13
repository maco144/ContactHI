import { config } from '../config';

export interface ThreatCheckResult {
  blocked: boolean;
  reason?: string;
  threat_level?: 'low' | 'medium' | 'high' | 'critical';
  reported_at?: string;
}

interface NullconeApiResponse {
  did: string;
  blocked: boolean;
  reason?: string;
  threat_level?: 'low' | 'medium' | 'high' | 'critical';
  reported_at?: string;
}

// TTL cache: 1 minute for blocked, 5 minutes for clean
interface CacheEntry {
  result: ThreatCheckResult;
  expires: number;
}

const threatCache = new Map<string, CacheEntry>();
const CLEAN_TTL_MS = 5 * 60 * 1000;   // 5 minutes for clean DIDs
const BLOCKED_TTL_MS = 60 * 1000;     // 1 minute for blocked DIDs (re-check more often)

/**
 * Checks whether a sender DID appears on the Nullcone threat feed.
 *
 * Nullcone is a federated threat-intelligence layer for the ContactHI network.
 * It aggregates spam reports, sybil clusters, and known-malicious agent DIDs.
 *
 * GET /v1/threat-check?did=<encoded_did>
 * Response: NullconeApiResponse
 *
 * Fails open: if Nullcone is unreachable, we allow the message through and log
 * the outage. This prevents a Nullcone outage from blocking all CHI traffic.
 */
export async function checkSender(did: string): Promise<ThreatCheckResult> {
  // Check cache first
  const cached = threatCache.get(did);
  if (cached && Date.now() < cached.expires) {
    return cached.result;
  }

  if (!config.nullcone_url || config.nullcone_url.includes('example.com')) {
    // Not configured — skip check
    return { blocked: false, reason: 'NULLCONE_NOT_CONFIGURED' };
  }

  const url = `${config.nullcone_url}/v1/threat-check?did=${encodeURIComponent(did)}`;

  try {
    // Dynamic import to support ESM node-fetch while compiling to CJS
    const { default: fetch } = await import('node-fetch');

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': `contacthi-router-node/${config.node_id}`,
      },
      // 3 second timeout
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      if (response.status === 404) {
        // DID not in the threat database — clean
        const result: ThreatCheckResult = { blocked: false };
        threatCache.set(did, { result, expires: Date.now() + CLEAN_TTL_MS });
        return result;
      }
      console.warn(`[nullcone] Non-OK response ${response.status} for did=${did}`);
      return { blocked: false, reason: 'NULLCONE_ERROR' };
    }

    const data = (await response.json()) as NullconeApiResponse;

    const result: ThreatCheckResult = {
      blocked: data.blocked,
      reason: data.reason,
      threat_level: data.threat_level,
      reported_at: data.reported_at,
    };

    const ttl = data.blocked ? BLOCKED_TTL_MS : CLEAN_TTL_MS;
    threatCache.set(did, { result, expires: Date.now() + ttl });

    if (data.blocked) {
      console.warn(
        `[nullcone] Sender ${did} is blocklisted: ${data.reason} (level=${data.threat_level})`
      );
    }

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[nullcone] Threat check failed for ${did}: ${msg}`);
    // Fail open: do not block traffic when Nullcone is unavailable
    return { blocked: false, reason: 'NULLCONE_UNAVAILABLE' };
  }
}

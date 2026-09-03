import { checkPermission, PermissionResult } from './registry';
import { countMessagesInWindow } from './spacetime';

/**
 * Rate-limit enforcement.
 *
 * The split is deliberate. The registry contract stores the human's declared
 * policy — "at most 3 a day from Autonomous Agents" — because that is a consent
 * decision and belongs in the consent record. It cannot enforce it: enforcement
 * needs a count of messages actually delivered, and the chain never sees a
 * delivery. Making it see one would mean a transaction per message, putting gas
 * and a funded key in the delivery hot path, and a rate limiter that fails when
 * the chain is slow.
 *
 * The router already has the history. Every accepted message is a row in the
 * SpacetimeDB `messages` table, so the count is one indexed query.
 *
 * Before 2026-09-02 the contract carried a `RATE_COUNTS` map that no execute
 * path ever wrote, so the ceiling was unreachable and every configured limit
 * silently passed everything. This module is what makes the setting real.
 */

export interface RateLimitVerdict {
  /** False when the sender has reached the declared ceiling. */
  allowed: boolean;
  /** Sends still available in the current window; undefined when unlimited. */
  remaining?: number;
  /** The declared ceiling, when one applies. */
  limit?: number;
}

/**
 * Apply the rate-limit policy attached to an already-granted permission result.
 *
 * Fails **open** when SpacetimeDB cannot be reached: a storage outage must not
 * silently convert into a total delivery block. The outage is logged, and the
 * consent decision itself (the part that matters) has already been made
 * on-chain.
 */
export async function enforceRateLimit(
  permission: PermissionResult,
  sender_did: string,
  recipient_did: string
): Promise<RateLimitVerdict> {
  const policy = permission.rate_limit;
  if (!policy) {
    return { allowed: true };
  }

  // A malformed policy denies rather than waves through. The contract rejects
  // count/period of zero at registration, so this should be unreachable — but
  // "unreachable" is what the old on-chain counter was too, and in a
  // consent-first system an unreadable limit must fail closed, not open.
  if (policy.count <= 0 || policy.period_seconds <= 0) {
    console.warn(
      `[ratelimit] Malformed policy (count=${policy.count}, ` +
        `period_seconds=${policy.period_seconds}); denying.`
    );
    return { allowed: false, remaining: 0, limit: policy.count };
  }

  let used: number;
  try {
    used = await countMessagesInWindow(sender_did, recipient_did, policy.period_seconds);
  } catch (err) {
    console.warn(
      '[ratelimit] Could not count prior messages; allowing through:',
      err instanceof Error ? err.message : String(err)
    );
    return { allowed: true, limit: policy.count };
  }

  const remaining = Math.max(0, policy.count - used);
  return {
    allowed: used < policy.count,
    remaining,
    limit: policy.count,
  };
}

/**
 * Check permission and the rate limit together.
 *
 * `/v1/send` and `/v1/check-permission` both need the same answer; giving them
 * one code path is what stops them drifting into disagreement — an agent that
 * is told it may send, then refused, is worse than either answer alone.
 */
export async function checkPermissionWithRateLimit(
  sender_did: string,
  sender_type: string,
  recipient_did: string,
  intent: string
): Promise<{ permission: PermissionResult; rate: RateLimitVerdict }> {
  const permission = await checkPermission(sender_did, sender_type, recipient_did, intent);
  if (!permission.granted) {
    return { permission, rate: { allowed: true } };
  }

  const rate = await enforceRateLimit(permission, sender_did, recipient_did);
  return { permission, rate };
}

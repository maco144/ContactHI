import { Router, Request, Response } from 'express';
import { checkPermissionWithRateLimit } from '../services/rateLimit';

export const checkPermissionRouter = Router();

/**
 * POST /v1/check-permission
 *
 * Ask this router whether a sender may contact a recipient with a given intent,
 * without sending anything. Agents are expected to call this before `/v1/send`
 * so they never submit a message that will be refused.
 *
 * The router holds the CosmWasm client and the permission cache, so asking it
 * is cheaper than every agent opening its own chain connection — the decision
 * itself is still made on-chain by the registry contract.
 *
 * The SDK has called this endpoint since it was written; the router has never
 * served it, so `client.checkPermission()` against a router 404'd. Added 2026-09-02.
 */
checkPermissionRouter.post('/', async (req: Request, res: Response) => {
  const { sender_did, sender_type, recipient_did, intent } = (req.body ?? {}) as Record<
    string,
    string
  >;

  const missing = ['sender_did', 'sender_type', 'recipient_did', 'intent'].filter(
    (f) => !(req.body ?? {})[f]
  );
  if (missing.length) {
    return res.status(400).json({
      error: 'MISSING_FIELD',
      message: `Required field(s) missing: ${missing.join(', ')}.`,
    });
  }

  try {
    const { permission, rate } = await checkPermissionWithRateLimit(
      sender_did,
      sender_type,
      recipient_did,
      intent
    );

    // A sender at its ceiling is not allowed to send right now, and saying
    // otherwise here only to refuse at /v1/send would be the worse answer.
    const allowed = permission.granted && rate.allowed;

    return res.status(200).json({
      allowed,
      allowed_channels: allowed ? permission.allowed_channels ?? [] : [],
      reason: rate.allowed ? permission.reason : 'RATE_LIMIT_EXCEEDED',
      ...(rate.limit != null
        ? { rate_limit: rate.limit, rate_limit_remaining: rate.remaining ?? 0 }
        : {}),
    });
  } catch (err) {
    console.error('[check-permission] failed:', err);
    return res.status(503).json({
      error: 'REGISTRY_UNAVAILABLE',
      message: 'Could not evaluate permission. Try again shortly.',
    });
  }
});

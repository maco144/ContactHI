import { Router, Request, Response } from 'express';
import { checkPermission } from '../services/registry';

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
    const result = await checkPermission(sender_did, sender_type, recipient_did, intent);
    return res.status(200).json({
      allowed: result.granted,
      allowed_channels: result.allowed_channels ?? [],
      reason: result.reason,
      ...(result.rate_limit_remaining != null
        ? { rate_limit_remaining: result.rate_limit_remaining }
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

import { Router, Request, Response } from 'express';
import { validateEnvelope, ChiEnvelope } from '../middleware/validate';
import { checkPermission, getPreferences } from '../services/registry';
import { checkSender } from '../services/nullcone';
import { submitMessage, updateAck } from '../services/spacetime';
import { deliver, Channel } from '../services/delivery';

export const sendRouter = Router();

sendRouter.post('/', validateEnvelope, async (req: Request, res: Response) => {
  const envelope = req.body as ChiEnvelope;
  const {
    message_id,
    sender_did,
    sender_type,
    recipient_did,
    intent,
  } = envelope;

  console.log(
    `[send] message_id=${message_id} sender=${sender_did} recipient=${recipient_did} intent=${intent}`
  );

  // ------------------------------------------------------------------
  // Step 1-3: Envelope structure and TTL were validated by middleware.
  //           Signature verification is deferred to CHI/1.1.
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // Step 4: Query on-chain preference registry
  // ------------------------------------------------------------------
  let permissionResult;
  try {
    permissionResult = await checkPermission(
      sender_did,
      sender_type,
      recipient_did,
      intent
    );
  } catch (err) {
    console.error('[send] Registry error:', err);
    return res.status(503).json({
      error: 'REGISTRY_UNAVAILABLE',
      message: 'Could not query preference registry. Try again shortly.',
    });
  }

  // ------------------------------------------------------------------
  // Step 5: Permission denied
  // ------------------------------------------------------------------
  if (!permissionResult.granted) {
    console.log(
      `[send] DENIED message_id=${message_id} reason=${permissionResult.reason}`
    );
    return res.status(403).json({
      error: 'PERMISSION_DENIED',
      reason: permissionResult.reason,
      message_id,
    });
  }

  // ------------------------------------------------------------------
  // Step 6-7: Nullcone threat feed check
  // ------------------------------------------------------------------
  let threatResult;
  try {
    threatResult = await checkSender(sender_did);
  } catch (err) {
    // Fail open — log and continue
    console.warn('[send] Nullcone check threw unexpectedly:', err);
    threatResult = { blocked: false };
  }

  if (threatResult.blocked) {
    console.log(
      `[send] BLOCKLISTED message_id=${message_id} sender=${sender_did} reason=${threatResult.reason}`
    );
    return res.status(403).json({
      error: 'SENDER_BLOCKLISTED',
      reason: threatResult.reason ?? 'Sender appears on Nullcone threat feed',
      threat_level: threatResult.threat_level,
      message_id,
    });
  }

  // ------------------------------------------------------------------
  // Step 8: Write message to SpacetimeDB
  // ------------------------------------------------------------------
  try {
    await submitMessage(envelope);
  } catch (err) {
    console.error('[send] SpacetimeDB submitMessage failed:', err);
    // Return 202 anyway — message is not lost, just not acked yet.
    // In production you'd want a durable queue here.
    return res.status(503).json({
      error: 'SPACETIMEDB_UNAVAILABLE',
      message: 'Message accepted but could not be recorded. Please retry.',
      message_id,
    });
  }

  // ------------------------------------------------------------------
  // Step 9: Route to delivery channels
  // ------------------------------------------------------------------
  const allowedChannels = (permissionResult.allowed_channels ?? ['agent-inbox']) as Channel[];

  // Fetch full preferences for channel endpoint data (FCM token, phone, etc.)
  let prefs = null;
  try {
    // Extract address from DID for lookup
    const parts = recipient_did.split(':');
    const address = parts[parts.length - 1];
    prefs = await getPreferences(address);
  } catch {
    // Non-fatal — delivery will proceed with available channels
  }

  const deliveryResult = await deliver(allowedChannels, prefs, envelope);

  // ------------------------------------------------------------------
  // Step 10: Update ack in SpacetimeDB
  // ------------------------------------------------------------------
  const newStatus = deliveryResult.success ? 'delivered' : 'failed';
  try {
    await updateAck(
      message_id,
      newStatus,
      deliveryResult.success ? deliveryResult.channel : undefined,
      deliveryResult.success ? undefined : deliveryResult.error
    );
  } catch (err) {
    console.warn('[send] Failed to update ack in SpacetimeDB:', err);
    // Non-fatal: message was delivered; ack will be reconciled by expire_messages
  }

  // ------------------------------------------------------------------
  // Step 11: Return result
  // ------------------------------------------------------------------
  if (deliveryResult.success) {
    return res.status(202).json({
      message_id,
      status: 'delivered',
      channel: deliveryResult.channel,
    });
  } else {
    // Message was accepted and recorded but delivery failed.
    // The client should poll /v1/status/:message_id for updates.
    return res.status(202).json({
      message_id,
      status: 'pending',
      note: 'Message recorded; delivery will be retried',
      delivery_error: deliveryResult.error,
    });
  }
});

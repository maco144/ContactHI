import { Router, Request, Response } from 'express';
import { getAck } from '../services/spacetime';

export const statusRouter = Router();

/**
 * GET /v1/status/:message_id
 *
 * Returns the current delivery ack for a CHI message.
 * Useful for polling after a 202 Accepted response from POST /v1/send.
 */
statusRouter.get('/:message_id', async (req: Request, res: Response) => {
  const { message_id } = req.params;

  if (!message_id || message_id.length > 128) {
    return res.status(400).json({
      error: 'INVALID_MESSAGE_ID',
      message: 'message_id must be a non-empty string up to 128 characters',
    });
  }

  try {
    const ack = await getAck(message_id);

    if (!ack) {
      return res.status(404).json({
        error: 'MESSAGE_NOT_FOUND',
        message: `No message found with id "${message_id}"`,
        message_id,
      });
    }

    return res.status(200).json({
      message_id: ack.message_id,
      status: ack.status,
      channel_used: ack.channel_used,
      delivered_at: ack.delivered_at,
      read_at: ack.read_at,
      responded_at: ack.responded_at,
      error_code: ack.error_code,
      updated_at: ack.updated_at,
    });
  } catch (err) {
    console.error('[status] Failed to query ack:', err);
    return res.status(503).json({
      error: 'SPACETIMEDB_UNAVAILABLE',
      message: 'Could not retrieve ack status. Try again shortly.',
      message_id,
    });
  }
});

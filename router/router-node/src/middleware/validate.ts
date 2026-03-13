import { Request, Response, NextFunction } from 'express';

// CHI/1.0 envelope structure
export interface ChiEnvelope {
  version: '1.0';
  message_id: string;
  sender_did: string;
  sender_type: string;
  recipient_did: string;
  intent: string;
  priority?: number;     // 0–255, default 128
  ttl_seconds: number;
  payload_type: string;
  payload: unknown;
  created_at: number;    // Unix ms
  signature?: string;    // optional in v1
}

const VALID_ENTITY_TYPES = new Set(['human', 'agent', 'service', 'device', 'dao']);
const VALID_INTENTS = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/; // e.g. "message.send"
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export function validateEnvelope(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const body = req.body as Partial<ChiEnvelope>;

  // Version check
  if (body.version !== '1.0') {
    res.status(400).json({
      error: 'INVALID_VERSION',
      message: `Unsupported CHI version "${body.version}". Only "1.0" is supported.`,
    });
    return;
  }

  // Required string fields
  const required: (keyof ChiEnvelope)[] = [
    'message_id', 'sender_did', 'sender_type', 'recipient_did',
    'intent', 'payload_type', 'payload',
  ];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      res.status(400).json({
        error: 'MISSING_FIELD',
        message: `Required field "${field}" is missing or empty.`,
      });
      return;
    }
  }

  // DID format: must start with "did:"
  if (!body.sender_did!.startsWith('did:')) {
    res.status(400).json({
      error: 'INVALID_DID',
      message: `sender_did must be a valid DID (e.g. "did:cosmos:abc123...").`,
    });
    return;
  }
  if (!body.recipient_did!.startsWith('did:')) {
    res.status(400).json({
      error: 'INVALID_DID',
      message: `recipient_did must be a valid DID.`,
    });
    return;
  }

  // sender_type
  if (!VALID_ENTITY_TYPES.has(body.sender_type!)) {
    res.status(400).json({
      error: 'INVALID_SENDER_TYPE',
      message: `sender_type must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}.`,
    });
    return;
  }

  // intent format
  if (!VALID_INTENTS.test(body.intent!)) {
    res.status(400).json({
      error: 'INVALID_INTENT',
      message: `intent must match pattern "namespace.action" (e.g. "message.send").`,
    });
    return;
  }

  // TTL
  const ttl = Number(body.ttl_seconds);
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    res.status(400).json({
      error: 'INVALID_TTL',
      message: `ttl_seconds must be an integer between 1 and ${MAX_TTL_SECONDS}.`,
    });
    return;
  }

  // created_at
  const createdAt = Number(body.created_at);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    res.status(400).json({
      error: 'INVALID_TIMESTAMP',
      message: `created_at must be a Unix timestamp in milliseconds.`,
    });
    return;
  }

  // TTL expiry check
  const nowMs = Date.now();
  const expiresAt = createdAt + ttl * 1000;
  if (expiresAt <= nowMs) {
    res.status(400).json({
      error: 'MESSAGE_EXPIRED',
      message: `Message TTL has already elapsed (created_at=${createdAt}, ttl=${ttl}s).`,
    });
    return;
  }

  // Clock skew: reject messages created more than 5 minutes in the future
  if (createdAt > nowMs + 5 * 60 * 1000) {
    res.status(400).json({
      error: 'CLOCK_SKEW',
      message: `created_at is too far in the future. Check your system clock.`,
    });
    return;
  }

  // Priority range
  if (body.priority !== undefined) {
    const pri = Number(body.priority);
    if (!Number.isInteger(pri) || pri < 0 || pri > 255) {
      res.status(400).json({
        error: 'INVALID_PRIORITY',
        message: `priority must be an integer between 0 and 255.`,
      });
      return;
    }
  }

  // Signature: in CHI/1.0, signatures are optional but if present must be
  // a non-empty string. Full cryptographic verification is deferred to v1.1.
  if (body.signature !== undefined && typeof body.signature !== 'string') {
    res.status(400).json({
      error: 'INVALID_SIGNATURE',
      message: `signature must be a base64-encoded string.`,
    });
    return;
  }

  next();
}

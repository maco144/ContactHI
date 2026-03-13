import { Request, Response, NextFunction } from 'express';

interface BucketEntry {
  count: number;
  windowStart: number;
}

// In-memory rate limit store. For production, replace with Redis.
const buckets = new Map<string, BucketEntry>();

const WINDOW_MS = 60_000;       // 1 minute window
const MAX_REQUESTS = 200;       // per IP per window
const CLEANUP_INTERVAL_MS = 5 * 60_000; // prune stale buckets every 5 minutes

// Prune expired buckets to avoid unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (now - entry.windowStart > WINDOW_MS * 2) {
      buckets.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);

export function rateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress
    ?? 'unknown';

  const now = Date.now();
  const existing = buckets.get(ip);

  if (!existing || now - existing.windowStart > WINDOW_MS) {
    // New window
    buckets.set(ip, { count: 1, windowStart: now });
    next();
    return;
  }

  existing.count += 1;

  if (existing.count > MAX_REQUESTS) {
    const retryAfterMs = WINDOW_MS - (now - existing.windowStart);
    res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000).toString());
    res.status(429).json({
      error: 'RATE_LIMITED',
      message: `Too many requests. Limit is ${MAX_REQUESTS} per minute.`,
      retry_after_seconds: Math.ceil(retryAfterMs / 1000),
    });
    return;
  }

  next();
}

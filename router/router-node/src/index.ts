import express from 'express';
import { config } from './config';
import { healthRouter } from './routes/health';
import { sendRouter } from './routes/send';
import { statusRouter } from './routes/status';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { registerNode, startHeartbeat } from './services/spacetime';

const app = express();

// Parse JSON bodies up to 1 MB
app.use(express.json({ limit: '1mb' }));

// Global rate limit: 200 req/min per IP
app.use(rateLimitMiddleware);

// Routes
app.use('/v1/health', healthRouter);
app.use('/v1/send', sendRouter);
app.use('/v1/status', statusRouter);

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err.message, err.stack);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
});

async function main() {
  // Register this node with SpacetimeDB on startup
  try {
    await registerNode();
    console.log(`[startup] Registered node ${config.node_id} with SpacetimeDB`);
  } catch (err) {
    console.warn('[startup] Could not register node with SpacetimeDB (will retry on next heartbeat):', err);
  }

  startHeartbeat();

  app.listen(config.port, () => {
    console.log(`[startup] ContactHI router node "${config.node_id}" listening on port ${config.port}`);
    console.log(`[startup] SpacetimeDB: ${config.spacetimedb_url} / db: ${config.spacetimedb_db}`);
    console.log(`[startup] Registry contract: ${config.registry_contract || '(not configured)'}`);
  });
}

main();

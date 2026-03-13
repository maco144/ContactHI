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

// Root — node info page
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>chi.delivery — CHI/1.0 Router Node</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#e0e0e0;font-family:'JetBrains Mono',monospace;font-size:14px;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem}
.box{border:1px solid #222;padding:2.5rem 3rem;max-width:520px;width:100%}
.label{color:#606060;font-size:.7rem;letter-spacing:.1em;margin-bottom:1.5rem}
h1{color:#ffb000;font-size:1.4rem;margin-bottom:.4rem}
.sub{color:#606060;font-size:.82rem;margin-bottom:2rem}
.row{display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid #1a1a1a;font-size:.82rem}
.row:last-of-type{border-bottom:none}
.k{color:#606060}.v{color:#00ff41}
.links{margin-top:1.8rem;display:flex;gap:1.5rem;flex-wrap:wrap}
.links a{color:#00d4ff;font-size:.78rem;text-decoration:none}
.links a:hover{color:#00ff41}
</style>
</head>
<body>
<div class="box">
  <div class="label">// CHI/1.0 ROUTER NODE</div>
  <h1>chi.delivery</h1>
  <p class="sub">Federated router node for the ContactHI protocol.<br/>Agents submit envelopes here. Humans set the rules at <a href="https://chi.contact" style="color:#00d4ff">chi.contact</a>.</p>
  <div class="row"><span class="k">status</span><span class="v">operational</span></div>
  <div class="row"><span class="k">protocol</span><span class="v">CHI/1.0-draft</span></div>
  <div class="row"><span class="k">health</span><span class="v"><a href="/v1/health" style="color:#00ff41">/v1/health</a></span></div>
  <div class="row"><span class="k">send endpoint</span><span class="v">POST /v1/send</span></div>
  <div class="row"><span class="k">status endpoint</span><span class="v">GET /v1/status/:id</span></div>
  <div class="links">
    <a href="https://chi.codes" target="_blank">Developer Docs →</a>
    <a href="https://chi.contact" target="_blank">For Humans →</a>
    <a href="https://github.com/maco144/ContactHI" target="_blank">GitHub →</a>
  </div>
</div>
</body>
</html>`);
});

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

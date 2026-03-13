import { Router, Request, Response } from 'express';
import { config } from '../config';

export const healthRouter = Router();

const startedAt = Date.now();

/**
 * GET /v1/health
 *
 * Returns node health status and capability summary.
 * Used by the router federation to discover and validate peer nodes.
 */
healthRouter.get('/', (_req: Request, res: Response) => {
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

  const channels: string[] = ['agent-inbox'];
  if (config.fcm_key) channels.push('push');
  if (config.twilio_sid && config.twilio_token) channels.push('sms');
  if (config.smtp_host && config.smtp_user) channels.push('email');

  res.status(200).json({
    status: 'ok',
    node_id: config.node_id,
    version: '1.0.0',
    protocol: 'CHI/1.0',
    uptime_seconds: uptimeSeconds,
    spacetimedb: {
      url: config.spacetimedb_url,
      database: config.spacetimedb_db,
    },
    registry: {
      cosmos_rpc: config.cosmos_rpc,
      contract: config.registry_contract || null,
    },
    nullcone: {
      url: config.nullcone_url,
    },
    capabilities: {
      channels,
      max_ttl_seconds: 7 * 24 * 60 * 60,
      max_payload_bytes: 1_048_576,
      rate_limit: '200/min',
    },
  });
});

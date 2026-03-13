/**
 * SpacetimeDB HTTP client for the ContactHI router node.
 *
 * SpacetimeDB exposes a REST API for calling reducers and querying tables.
 * All reducer calls are POST requests to:
 *   POST /database/call/{reducer_name}
 * Table reads use the SQL query endpoint:
 *   POST /database/sql
 *
 * Reference: https://spacetimedb.com/docs/http-api
 */

import { config } from '../config';
import { ChiEnvelope } from '../middleware/validate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpacetimeAck {
  message_id: string;
  status: string;
  channel_used: string | null;
  delivered_at: number | null;
  read_at: number | null;
  responded_at: number | null;
  error_code: string | null;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Low-level HTTP helpers
// ---------------------------------------------------------------------------

function baseUrl(): string {
  return `${config.spacetimedb_url}/database/${config.spacetimedb_db}`;
}

async function callReducer(
  reducerName: string,
  args: unknown[]
): Promise<void> {
  const { default: fetch } = await import('node-fetch');

  const url = `${baseUrl()}/call/${reducerName}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `SpacetimeDB reducer "${reducerName}" failed (HTTP ${response.status}): ${text}`
    );
  }
}

async function querySql<T>(sql: string): Promise<T[]> {
  const { default: fetch } = await import('node-fetch');

  const url = `${baseUrl()}/sql`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SpacetimeDB SQL query failed (HTTP ${response.status}): ${text}`);
  }

  // SpacetimeDB returns { rows: [...] }
  const result = (await response.json()) as { rows: T[] };
  return result.rows;
}

// ---------------------------------------------------------------------------
// Reducer calls
// ---------------------------------------------------------------------------

/**
 * Submit a new CHI message to SpacetimeDB.
 * Calls the `submit_message` reducer which also creates the pending ack.
 */
export async function submitMessage(message: ChiEnvelope): Promise<void> {
  const expiresAt = message.created_at + message.ttl_seconds * 1_000;

  const stdbMessage = {
    message_id: message.message_id,
    sender_did: message.sender_did,
    sender_type: message.sender_type,
    recipient_did: message.recipient_did,
    intent: message.intent,
    priority: message.priority ?? 128,
    ttl_seconds: message.ttl_seconds,
    payload_type: message.payload_type,
    created_at: message.created_at,
    expires_at: expiresAt,
    router_node: config.node_id,
  };

  await callReducer('submit_message', [stdbMessage]);
}

/**
 * Update the delivery ack for a message.
 * Calls the `update_ack` reducer.
 */
export async function updateAck(
  message_id: string,
  status: string,
  channel?: string,
  error?: string
): Promise<void> {
  await callReducer('update_ack', [
    message_id,
    status,
    channel ?? null,
    error ?? null,
  ]);
}

/**
 * Retrieve the current ack for a message_id.
 * Queries the `acks` table directly via SQL.
 */
export async function getAck(message_id: string): Promise<SpacetimeAck | null> {
  const rows = await querySql<SpacetimeAck>(
    `SELECT * FROM acks WHERE message_id = '${message_id.replace(/'/g, "''")}'`
  );
  return rows[0] ?? null;
}

/**
 * Register this router node with SpacetimeDB.
 * Called on startup and periodically as a heartbeat.
 */
export async function registerNode(): Promise<void> {
  // Build the public endpoint URL from the configured port.
  // In production, set NODE_ENDPOINT_URL explicitly.
  const endpointUrl =
    process.env.NODE_ENDPOINT_URL ?? `http://localhost:${config.port}`;

  await callReducer('register_node', [config.node_id, endpointUrl]);
}

/**
 * Write a CHI message directly to the recipient's agent-inbox table.
 * This table is used for agent-to-agent in-band delivery without an
 * external channel (push/sms/email).
 *
 * The agent-inbox table is separate from the messages table and is
 * partitioned by recipient_did so each agent only sees its own inbox.
 */
export async function writeToAgentInbox(
  recipient_did: string,
  message: ChiEnvelope
): Promise<void> {
  const inboxEntry = {
    message_id: message.message_id,
    recipient_did,
    sender_did: message.sender_did,
    sender_type: message.sender_type,
    intent: message.intent,
    payload_type: message.payload_type,
    payload_json: JSON.stringify(message.payload),
    created_at: message.created_at,
    read: false,
  };

  await callReducer('write_agent_inbox', [inboxEntry]);
}

// ---------------------------------------------------------------------------
// Background: periodic heartbeat to keep node registration current
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 60_000; // every minute

export function startHeartbeat(): void {
  setInterval(async () => {
    try {
      await registerNode();
    } catch (err) {
      console.warn('[spacetime] Heartbeat failed:', err);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

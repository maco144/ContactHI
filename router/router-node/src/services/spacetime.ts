/**
 * SpacetimeDB HTTP client for the ContactHI router node.
 *
 * Targets the SpacetimeDB 2.x HTTP API, which is versioned under /v1:
 *   POST /v1/database/{name}/call/{reducer}   body: JSON array of positional args
 *   POST /v1/database/{name}/sql              body: the raw SQL string
 *
 * The SQL endpoint returns an array of statement results, each shaped
 * `{ schema: { elements: [{ name: { some: "col" }, ... }] }, rows: [[...]] }` —
 * rows are POSITIONAL, not keyed, and nullable columns arrive as the tagged
 * values `{ "some": v }` / `{ "none": [] }`. `decodeRows` below turns that back
 * into plain objects.
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
  return `${config.spacetimedb_url}/v1/database/${config.spacetimedb_db}`;
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

interface SqlStatementResult {
  schema: { elements: Array<{ name: { some?: string; none?: unknown[] } }> };
  rows: unknown[][];
}

/**
 * Encode a `Option<T>` reducer argument. SpacetimeDB rejects a bare value and a
 * bare `null` alike — an Option is a sum type and has to arrive tagged by
 * variant name (`some` is variant 0, `none` is variant 1 carrying unit).
 */
function option<T>(value: T | null | undefined): Record<string, unknown> {
  return value === null || value === undefined ? { none: [] } : { some: value };
}

/**
 * Decode a sum-typed column. The SQL endpoint returns options positionally as
 * `[tag, payload]` — `[0, v]` for some, `[1, []]` for none — while other
 * surfaces use the named form `{some: v}` / `{none: []}`. Accept both.
 */
function unwrapOption(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number') {
    return value[0] === 0 ? value[1] : null;
  }
  if (value !== null && typeof value === 'object') {
    const tagged = value as Record<string, unknown>;
    if ('some' in tagged) return tagged.some;
    if ('none' in tagged) return null;
  }
  return value;
}

/** Turn one positional statement result into keyed objects. */
function decodeRows<T>(result: SqlStatementResult | undefined): T[] {
  if (!result) return [];
  const columns = result.schema.elements.map((el) => el.name.some ?? '');
  return result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = unwrapOption(row[i]);
    });
    return obj as T;
  });
}

async function querySql<T>(sql: string): Promise<T[]> {
  const { default: fetch } = await import('node-fetch');

  const url = `${baseUrl()}/sql`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
    },
    body: sql,
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SpacetimeDB SQL query failed (HTTP ${response.status}): ${text}`);
  }

  const results = (await response.json()) as SqlStatementResult[];
  return decodeRows<T>(results[0]);
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

  // Positional, in the order declared by the reducer in
  // router/spacetimedb-module/src/lib.rs. Keep the two in step.
  await callReducer('submit_message', [
    message.message_id,
    message.sender_did,
    message.sender_type,
    message.recipient_did,
    message.intent,
    message.priority ?? 128,
    message.ttl_seconds,
    message.payload_type,
    message.created_at,
    expiresAt,
    config.node_id,
    message.reply_to ?? '',
  ]);
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
    option(channel),
    option(error),
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
 * Count messages this sender has already had accepted for this recipient inside
 * the current fixed rate-limit window.
 *
 * The registry declares the human's rate-limit policy but cannot enforce it —
 * enforcement needs a count of real deliveries, and the chain never sees one.
 * The router does: every accepted message is already a row in `messages`.
 *
 * Windows are fixed, not rolling: `floor(now / period) * period`. A rolling
 * window would need a per-sender history scan on every send; a fixed window is
 * one indexed count, and the difference only matters at the boundary.
 */
export async function countMessagesInWindow(
  sender_did: string,
  recipient_did: string,
  periodSeconds: number
): Promise<number> {
  const periodMs = periodSeconds * 1_000;
  const windowStart = Math.floor(Date.now() / periodMs) * periodMs;

  const esc = (v: string) => v.replace(/'/g, "''");
  const rows = await querySql<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages ` +
      `WHERE sender_did = '${esc(sender_did)}' ` +
      `AND recipient_did = '${esc(recipient_did)}' ` +
      `AND created_at >= ${windowStart}`
  );
  return Number(rows[0]?.n ?? 0);
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
  // Positional, in the order declared by the reducer in
  // router/spacetimedb-module/src/lib.rs. `read` is set false by the module.
  await callReducer('write_agent_inbox', [
    message.message_id,
    recipient_did,
    message.sender_did,
    message.sender_type,
    message.intent,
    message.payload_type,
    JSON.stringify(message.payload),
    message.created_at,
  ]);
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

// ---------------------------------------------------------------------------
// Background: periodic TTL sweep
// ---------------------------------------------------------------------------

const EXPIRY_SWEEP_INTERVAL_MS = 5 * 60_000; // every five minutes

/**
 * Run the module's `expire_messages` reducer.
 *
 * It marks TTL-elapsed acks `expired`, evicts stale preference-cache entries,
 * and removes router nodes that have missed heartbeats for over five minutes.
 * Nothing called it before — the reducer was defined and never invoked, so
 * `send.ts`'s "ack will be reconciled by expire_messages" was never true: a
 * failed delivery's ack stayed `pending` forever and dead nodes stayed in the
 * federation table indefinitely.
 */
export async function expireMessages(): Promise<void> {
  await callReducer('expire_messages', []);
}

export function startExpirySweep(): void {
  setInterval(async () => {
    try {
      await expireMessages();
    } catch (err) {
      console.warn('[spacetime] Expiry sweep failed:', err);
    }
  }, EXPIRY_SWEEP_INTERVAL_MS);
}

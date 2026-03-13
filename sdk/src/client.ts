/**
 * CHI/1.0 Protocol — ReachClient
 *
 * Main entry point for the SDK. Handles:
 *   - Composing, signing, and sending message envelopes to a router node
 *   - Permission checks before sending (optional but recommended)
 *   - Polling for delivery acknowledgements
 *   - Exposing a PreferencesManager for the caller's own preferences
 */

import type {
  ReachClientConfig,
  Intent,
  PayloadType,
  Priority,
  MessageStatus,
  DeliveryAck,
  PermissionResult,
  RouterSendResponse,
  RouterStatusResponse,
} from './types'
import { createEnvelope, signEnvelope } from './envelope'
import { PreferencesManager } from './preferences'
import { createDID } from './did'
import {
  ReachError,
  RouterError,
  ConfigError,
  TimeoutError,
} from './errors'

/** Default TTL for messages: 24 hours */
const DEFAULT_TTL_SECONDS = 86400

/** Default waitForAck timeout: 30 seconds */
const DEFAULT_ACK_TIMEOUT_MS = 30_000

/** Polling interval for waitForAck */
const ACK_POLL_INTERVAL_MS = 1_000

/** Terminal message statuses that stop polling */
const TERMINAL_STATUSES = new Set<MessageStatus>([
  'delivered',
  'read',
  'responded',
  'expired',
  'failed',
])

export class ReachClient {
  private readonly config: ReachClientConfig
  private readonly base_url: string

  /** Manage your own on-chain delivery preferences */
  public readonly preferences: PreferencesManager

  constructor(config: ReachClientConfig) {
    if (!config.router_url) {
      throw new ConfigError('router_url')
    }

    this.config = config
    this.base_url = config.router_url.replace(/\/$/, '')

    this.preferences = new PreferencesManager({
      router_url: config.router_url,
      cosmos_rpc: config.cosmos_rpc,
      registry_address: config.registry_address,
      sender_did: config.sender_did,
    })
  }

  // ---------------------------------------------------------------------------
  // send
  // ---------------------------------------------------------------------------

  /**
   * Send a REACH message to a recipient.
   *
   * - Builds a CHI/1.0 envelope
   * - Signs it with the configured private key (if provided)
   * - POSTs it to the router's /v1/messages endpoint
   *
   * @returns message_id and initial status from the router
   * @throws ConfigError if sender_did is not configured
   * @throws RouterError if the router returns a non-2xx response
   */
  async send(params: {
    /** Recipient DID (did:chi:cosmos1...) or raw Cosmos address */
    to: string
    intent: Intent
    content: string
    payload_type?: PayloadType
    priority?: Priority
    ttl?: number
    reply_to?: string
  }): Promise<{ message_id: string; status: MessageStatus }> {
    const sender_did = this._requireSenderDID()
    const sender_type = this.config.sender_type ?? 'US'

    const recipient_did = params.to.startsWith('did:')
      ? params.to
      : createDID(params.to)

    let envelope = createEnvelope({
      sender_did,
      sender_type,
      recipient_did,
      intent: params.intent,
      content: params.content,
      payload_type: params.payload_type,
      priority: params.priority,
      ttl: params.ttl ?? DEFAULT_TTL_SECONDS,
      reply_to: params.reply_to,
    })

    if (this.config.private_key) {
      envelope = await signEnvelope(envelope, this.config.private_key)
    }

    const res = await fetch(`${this.base_url}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ envelope }),
    })

    if (!res.ok) {
      const body = await res.text()
      this._mapRouterError(res.status, body)
    }

    const data = (await res.json()) as RouterSendResponse
    return {
      message_id: data.message_id,
      status: data.status,
    }
  }

  // ---------------------------------------------------------------------------
  // checkPermission
  // ---------------------------------------------------------------------------

  /**
   * Ask the router (or on-chain contract) whether you are allowed to contact
   * a recipient with a given intent. Call this before `send` to avoid
   * sending messages that will be rejected.
   *
   * @throws ConfigError if sender_did is not configured
   */
  async checkPermission(params: {
    recipient: string
    intent: Intent
  }): Promise<PermissionResult> {
    const sender_did = this._requireSenderDID()
    const sender_type = this.config.sender_type ?? 'US'

    return this.preferences.checkPermission(
      sender_did,
      sender_type,
      params.intent,
      params.recipient
    )
  }

  // ---------------------------------------------------------------------------
  // waitForAck
  // ---------------------------------------------------------------------------

  /**
   * Poll for a delivery acknowledgement until the message reaches a terminal
   * status (delivered, read, responded, expired, or failed), or the timeout elapses.
   *
   * @param message_id  - ID returned by `send`
   * @param timeout_ms  - Maximum time to wait in milliseconds (default 30 000)
   * @throws TimeoutError if no terminal status is received within the timeout
   */
  async waitForAck(
    message_id: string,
    timeout_ms: number = DEFAULT_ACK_TIMEOUT_MS
  ): Promise<DeliveryAck> {
    const deadline = Date.now() + timeout_ms

    while (Date.now() < deadline) {
      const ack = await this.getStatus(message_id)

      if (TERMINAL_STATUSES.has(ack.status)) {
        return ack
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) break

      await sleep(Math.min(ACK_POLL_INTERVAL_MS, remaining))
    }

    throw new TimeoutError(message_id, timeout_ms)
  }

  // ---------------------------------------------------------------------------
  // getStatus
  // ---------------------------------------------------------------------------

  /**
   * Fetch the current delivery status for a sent message.
   *
   * @throws RouterError if the router returns a non-2xx response
   */
  async getStatus(message_id: string): Promise<DeliveryAck> {
    if (!message_id) {
      throw new ReachError('INVALID_ENVELOPE', 'message_id is required')
    }

    const res = await fetch(
      `${this.base_url}/v1/messages/${encodeURIComponent(message_id)}/status`,
      { headers: { Accept: 'application/json' } }
    )

    if (!res.ok) {
      const body = await res.text()
      this._mapRouterError(res.status, body)
    }

    const data = (await res.json()) as RouterStatusResponse
    return {
      message_id: data.message_id,
      status: data.status,
      channel_used: data.channel_used,
      timestamp: data.timestamp,
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _requireSenderDID(): string {
    if (!this.config.sender_did) {
      throw new ConfigError('sender_did')
    }
    return this.config.sender_did
  }

  private _mapRouterError(status: number, body: string): never {
    // Map router HTTP error codes to typed ReachErrors where possible
    if (status === 403) {
      if (body.includes('blocklist') || body.includes('BLOCKLISTED')) {
        throw new ReachError('SENDER_BLOCKLISTED', body)
      }
      if (body.includes('rate_limit') || body.includes('RATE_LIMIT')) {
        throw new ReachError('RATE_LIMIT_EXCEEDED', body)
      }
      throw new ReachError('PERMISSION_DENIED', body)
    }
    if (status === 404) {
      throw new ReachError('RECIPIENT_NOT_FOUND', `Recipient not found: ${body}`)
    }
    if (status === 400) {
      throw new ReachError('INVALID_ENVELOPE', body)
    }
    if (status === 401 || body.includes('SIGNATURE_INVALID')) {
      throw new ReachError('SIGNATURE_INVALID', body)
    }
    throw new RouterError(status, body)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

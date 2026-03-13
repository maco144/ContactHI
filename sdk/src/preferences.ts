/**
 * CHI/1.0 Protocol — PreferencesManager
 *
 * Manages a user's on-chain preference profile via two paths:
 *   1. Direct CosmWasm queries for reads (no gas needed)
 *   2. Router REST API for writes (router submits tx on behalf of user)
 *
 * Write operations POST to the router's /v1/preferences endpoint, which
 * signs and broadcasts the CosmWasm ExecuteMsg transaction. This keeps
 * the SDK usable without a local Cosmos wallet — the router acts as a
 * relayer and bills the sender's account via pre-authorization.
 */

import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import type {
  HumanPreferences,
  PreferenceRule,
  PermissionResult,
  EntityType,
  Intent,
  ChainPreferencesResponse,
  ChainPermissionResponse,
} from './types'
import { ReachError, RouterError, ConfigError } from './errors'
import { addressFromDID, createDID } from './did'

// ---------------------------------------------------------------------------
// Types for router preference write API
// ---------------------------------------------------------------------------

interface RouterPrefsWriteBody {
  action:
    | 'register'
    | 'update'
    | 'add_rule'
    | 'remove_rule'
    | 'block_sender'
    | 'unblock_sender'
  sender_did: string
  payload: unknown
}

// ---------------------------------------------------------------------------
// PreferencesManager
// ---------------------------------------------------------------------------

export class PreferencesManager {
  private readonly router_url: string
  private readonly cosmos_rpc?: string
  private readonly registry_address?: string
  private readonly sender_did?: string

  constructor(config: {
    router_url: string
    cosmos_rpc?: string
    registry_address?: string
    sender_did?: string
  }) {
    this.router_url = config.router_url.replace(/\/$/, '')
    this.cosmos_rpc = config.cosmos_rpc
    this.registry_address = config.registry_address
    this.sender_did = config.sender_did
  }

  // -------------------------------------------------------------------------
  // Reads — go directly to the chain via CosmWasm
  // -------------------------------------------------------------------------

  /**
   * Retrieve the full preference profile for a DID.
   * Defaults to the configured sender_did when no argument is provided.
   *
   * Returns null when the address has no registered preferences.
   */
  async get(did?: string): Promise<HumanPreferences | null> {
    const target = did ?? this.sender_did
    if (!target) {
      throw new ConfigError('sender_did (or pass did argument to get())')
    }

    const address = addressFromDID(target)

    // Prefer direct on-chain query when RPC + registry are configured
    if (this.cosmos_rpc && this.registry_address) {
      return this._queryChainPreferences(address, target)
    }

    // Fallback: ask the router to proxy the query
    return this._routerGetPreferences(target)
  }

  /**
   * Register a new preference profile on-chain.
   * Fails if preferences already exist — use `update` to replace them.
   */
  async register(prefs: Omit<HumanPreferences, 'did' | 'updated_at'>): Promise<void> {
    const sender_did = this._requireSenderDID()
    await this._routerWrite({
      action: 'register',
      sender_did,
      payload: {
        rules: prefs.rules,
        default_policy: prefs.default_policy,
        webhook_url: prefs.webhook_url ?? null,
      },
    })
  }

  /**
   * Replace the caller's entire preference profile (rules + policy + webhook).
   */
  async update(prefs: Partial<HumanPreferences>): Promise<void> {
    const sender_did = this._requireSenderDID()

    // Fetch current preferences to fill in any omitted fields
    const current = await this.get(sender_did)
    if (!current) {
      throw new ReachError(
        'RECIPIENT_NOT_FOUND',
        'No preferences found for this DID. Use register() first.'
      )
    }

    await this._routerWrite({
      action: 'update',
      sender_did,
      payload: {
        rules: prefs.rules ?? current.rules,
        default_policy: prefs.default_policy ?? current.default_policy,
        webhook_url: prefs.webhook_url ?? current.webhook_url ?? null,
      },
    })
  }

  /**
   * Append a single rule to the preference profile.
   */
  async addRule(rule: PreferenceRule): Promise<void> {
    const sender_did = this._requireSenderDID()
    await this._routerWrite({
      action: 'add_rule',
      sender_did,
      payload: { rule },
    })
  }

  /**
   * Remove the rule at position `index` (0-based).
   */
  async removeRule(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0) {
      throw new ReachError('INVALID_ENVELOPE', 'index must be a non-negative integer')
    }
    const sender_did = this._requireSenderDID()
    await this._routerWrite({
      action: 'remove_rule',
      sender_did,
      payload: { index },
    })
  }

  /**
   * Add a DID or domain pattern to the global blocklist.
   *
   * @param pattern - DID (did:chi:cosmos1...) or domain (e.g. "spam.example.com")
   */
  async blockSender(pattern: string): Promise<void> {
    if (!pattern || !pattern.trim()) {
      throw new ReachError('INVALID_ENVELOPE', 'pattern must be a non-empty string')
    }
    const sender_did = this._requireSenderDID()
    await this._routerWrite({
      action: 'block_sender',
      sender_did,
      payload: { pattern: pattern.trim() },
    })
  }

  /**
   * Remove a pattern from the global blocklist.
   */
  async unblockSender(pattern: string): Promise<void> {
    if (!pattern || !pattern.trim()) {
      throw new ReachError('INVALID_ENVELOPE', 'pattern must be a non-empty string')
    }
    const sender_did = this._requireSenderDID()
    await this._routerWrite({
      action: 'unblock_sender',
      sender_did,
      payload: { pattern: pattern.trim() },
    })
  }

  /**
   * Check whether a given sender is permitted to contact this DID.
   *
   * Queries the on-chain contract directly when chain config is available;
   * otherwise falls back to the router's check-permission endpoint.
   */
  async checkPermission(
    sender_did: string,
    sender_type: EntityType,
    intent: Intent,
    recipient_did?: string
  ): Promise<PermissionResult> {
    const target = recipient_did ?? this.sender_did
    if (!target) {
      throw new ConfigError('sender_did (or pass recipient_did argument)')
    }

    const recipient_address = addressFromDID(target)

    if (this.cosmos_rpc && this.registry_address) {
      return this._queryChainPermission(sender_did, sender_type, recipient_address, intent)
    }

    return this._routerCheckPermission(sender_did, sender_type, target, intent)
  }

  // -------------------------------------------------------------------------
  // Private: on-chain reads
  // -------------------------------------------------------------------------

  private async _queryChainPreferences(
    address: string,
    originalDID: string
  ): Promise<HumanPreferences | null> {
    let client: CosmWasmClient
    try {
      client = await CosmWasmClient.connect(this.cosmos_rpc!)
    } catch (err) {
      throw new ReachError(
        'ROUTER_ERROR',
        `Failed to connect to Cosmos RPC: ${String(err)}`
      )
    }

    let response: ChainPreferencesResponse
    try {
      response = await client.queryContractSmart(this.registry_address!, {
        get_preferences: { address },
      }) as ChainPreferencesResponse
    } catch (err) {
      const msg = String(err)
      if (
        msg.includes('not found') ||
        msg.includes('unknown') ||
        msg.includes('PreferencesNotFound')
      ) {
        return null
      }
      throw new ReachError('ROUTER_ERROR', `Chain query failed: ${msg}`)
    }

    return {
      did: originalDID.startsWith('did:') ? originalDID : createDID(originalDID),
      rules: response.rules,
      default_policy: response.default_policy,
      webhook_url: response.webhook_url ?? undefined,
      updated_at: new Date(response.updated_at * 1000).toISOString(),
    }
  }

  private async _queryChainPermission(
    sender_did: string,
    sender_type: EntityType,
    recipient_address: string,
    intent: Intent
  ): Promise<PermissionResult> {
    let client: CosmWasmClient
    try {
      client = await CosmWasmClient.connect(this.cosmos_rpc!)
    } catch (err) {
      throw new ReachError(
        'ROUTER_ERROR',
        `Failed to connect to Cosmos RPC: ${String(err)}`
      )
    }

    let response: ChainPermissionResponse
    try {
      response = await client.queryContractSmart(this.registry_address!, {
        check_permission: {
          sender_did,
          sender_type,
          recipient: recipient_address,
          intent,
        },
      }) as ChainPermissionResponse
    } catch (err) {
      throw new ReachError('ROUTER_ERROR', `Chain permission query failed: ${String(err)}`)
    }

    return {
      allowed: response.allowed,
      allowed_channels: response.allowed_channels,
      reason: response.reason ?? undefined,
      rate_limit_remaining: response.rate_limit_remaining ?? undefined,
    }
  }

  // -------------------------------------------------------------------------
  // Private: router HTTP calls
  // -------------------------------------------------------------------------

  private async _routerGetPreferences(did: string): Promise<HumanPreferences | null> {
    const address = addressFromDID(did)
    const url = `${this.router_url}/v1/preferences/${encodeURIComponent(address)}`

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    })

    if (res.status === 404) return null
    if (!res.ok) {
      throw new RouterError(res.status, await res.text())
    }

    const body = (await res.json()) as HumanPreferences
    return body
  }

  private async _routerCheckPermission(
    sender_did: string,
    sender_type: EntityType,
    recipient_did: string,
    intent: Intent
  ): Promise<PermissionResult> {
    const url = `${this.router_url}/v1/check-permission`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender_did, sender_type, recipient_did, intent }),
    })

    if (!res.ok) {
      throw new RouterError(res.status, await res.text())
    }

    return res.json() as Promise<PermissionResult>
  }

  private async _routerWrite(body: RouterPrefsWriteBody): Promise<void> {
    const url = `${this.router_url}/v1/preferences`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      // Map well-known router error messages to typed errors
      if (res.status === 403 || text.includes('Permission') || text.includes('Unauthorized')) {
        throw new ReachError('PERMISSION_DENIED', text)
      }
      throw new RouterError(res.status, text)
    }
  }

  // -------------------------------------------------------------------------
  // Private: helpers
  // -------------------------------------------------------------------------

  private _requireSenderDID(): string {
    if (!this.sender_did) {
      throw new ConfigError('sender_did')
    }
    return this.sender_did
  }
}

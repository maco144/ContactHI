/**
 * CHI/1.0 Protocol — Error Classes
 */

/** All possible CHI error codes */
export type ReachErrorCode =
  | 'PERMISSION_DENIED'       // recipient's preferences block this sender
  | 'RECIPIENT_NOT_FOUND'     // recipient DID not registered on-chain
  | 'SENDER_PROOF_INVALID'    // ZK proof attached to envelope is invalid
  | 'SENDER_BLOCKLISTED'      // sender is on recipient's blocklist
  | 'RATE_LIMIT_EXCEEDED'     // sender has hit their rate limit for this recipient
  | 'TTL_EXPIRED'             // message TTL has elapsed before delivery
  | 'CHANNEL_UNAVAILABLE'     // none of the allowed channels can be reached
  | 'INVALID_ENVELOPE'        // envelope fails structural validation
  | 'ROUTER_ERROR'            // router returned an unexpected error
  | 'SIGNATURE_INVALID'       // envelope signature does not verify
  | 'SIGNING_FAILED'          // envelope could not be signed (key error)
  | 'CONFIG_MISSING'          // required config field not provided
  | 'TIMEOUT'                 // waitForAck exceeded timeout_ms

/**
 * Base error class for all CHI SDK errors.
 * Always carries a machine-readable `code` alongside the human message.
 */
export class ReachError extends Error {
  public readonly code: ReachErrorCode

  constructor(code: ReachErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'ReachError'
    // Maintain proper prototype chain in transpiled environments
    Object.setPrototypeOf(this, new.target.prototype)
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
    }
  }
}

/** Thrown when envelope validation fails */
export class InvalidEnvelopeError extends ReachError {
  public readonly field?: string

  constructor(message: string, field?: string) {
    super('INVALID_ENVELOPE', message)
    this.name = 'InvalidEnvelopeError'
    this.field = field
  }
}

/** Thrown when a signature operation fails */
export class SignatureError extends ReachError {
  constructor(code: 'SIGNING_FAILED' | 'SIGNATURE_INVALID', message: string) {
    super(code, message)
    this.name = 'SignatureError'
  }
}

/** Thrown when the router returns a non-2xx response */
export class RouterError extends ReachError {
  public readonly statusCode: number
  public readonly routerMessage?: string

  constructor(statusCode: number, routerMessage?: string) {
    const message = routerMessage
      ? `Router responded with ${statusCode}: ${routerMessage}`
      : `Router responded with ${statusCode}`
    super('ROUTER_ERROR', message)
    this.name = 'RouterError'
    this.statusCode = statusCode
    this.routerMessage = routerMessage
  }
}

/** Thrown when waitForAck polling exceeds the timeout */
export class TimeoutError extends ReachError {
  public readonly message_id: string

  constructor(message_id: string, timeout_ms: number) {
    super('TIMEOUT', `waitForAck timed out after ${timeout_ms}ms for message ${message_id}`)
    this.name = 'TimeoutError'
    this.message_id = message_id
  }
}

/** Thrown when required configuration is missing */
export class ConfigError extends ReachError {
  public readonly field: string

  constructor(field: string) {
    super('CONFIG_MISSING', `Required config field missing: ${field}`)
    this.name = 'ConfigError'
    this.field = field
  }
}

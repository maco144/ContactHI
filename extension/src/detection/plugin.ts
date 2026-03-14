/**
 * CHI Detection Plugin Interface
 *
 * Any AI-detection provider implements this interface to plug into
 * the ContactHI Shield enforcement layer. CHI handles the policy
 * (what the human wants done); the plugin handles the signal
 * (is this content AI-generated?).
 *
 * To add a new provider:
 *   1. Create a class implementing DetectionPlugin in src/detection/adapters/
 *   2. Register it in src/background/service-worker.ts via registerPlugin()
 *   3. Add its metadata to PROVIDERS in src/options/options.ts
 */

export interface DetectionRequest {
  /** Plain text to classify — strip HTML before passing */
  text: string
  /** Context hint for providers that tune models per surface */
  contentType: 'email' | 'webpage' | 'comment' | 'chat' | 'unknown'
  /** Optional metadata to assist detection */
  metadata?: {
    sender?: string
    subject?: string
    url?: string
    [key: string]: string | undefined
  }
}

export interface DetectionResult {
  /** True if content is classified as AI-generated */
  isAI: boolean
  /** Confidence score 0.0–1.0 */
  confidence: number
  /** Provider name that produced this result */
  provider: string
  /** Specific model identified, if the provider supports it */
  modelDetected?: string
  /** Soft failure — detection ran but encountered an error; treat as inconclusive */
  error?: string
  /** Raw provider response for debugging */
  raw?: unknown
}

export interface DetectionPlugin {
  /** Unique provider identifier — used as the storage key */
  readonly name: string
  /** Semver string */
  readonly version: string
  /**
   * Apply runtime configuration from user settings.
   * Called before every detect() call so config changes take effect immediately.
   */
  configure(config: Record<string, string>): void
  /** Returns true if the plugin has everything it needs to make calls */
  isConfigured(): boolean
  /** Run detection on the provided request */
  detect(request: DetectionRequest): Promise<DetectionResult>
}

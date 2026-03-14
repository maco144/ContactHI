import type { DetectionPlugin, DetectionRequest, DetectionResult } from '../plugin.js'

/**
 * Originality.ai adapter
 * API docs: https://docs.originality.ai/
 * Get a key at: https://originality.ai/
 */
export class OriginalityAdapter implements DetectionPlugin {
  readonly name = 'originality'
  readonly version = '1.0.0'

  private apiKey = ''

  configure(config: Record<string, string>): void {
    if (config.apiKey) this.apiKey = config.apiKey
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0
  }

  async detect(request: DetectionRequest): Promise<DetectionResult> {
    const response = await fetch('https://api.originality.ai/api/v1/scan/ai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OAI-API-KEY': this.apiKey,
      },
      body: JSON.stringify({ content: request.text, aiModelVersion: 'v3' }),
    })

    if (!response.ok) {
      return {
        isAI: false,
        confidence: 0,
        provider: 'originality',
        error: `HTTP ${response.status}`,
      }
    }

    const data = await response.json()
    // Originality returns score.ai (0–1, AI probability)
    const confidence: number = data.score?.ai ?? 0

    return {
      isAI: confidence >= 0.5,
      confidence: parseFloat(confidence.toFixed(2)),
      provider: 'originality',
      raw: data,
    }
  }
}

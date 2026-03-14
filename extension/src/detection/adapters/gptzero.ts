import type { DetectionPlugin, DetectionRequest, DetectionResult } from '../plugin.js'

/**
 * GPTZero adapter
 * API docs: https://api.gptzero.me/v2/predict/text
 * Get a key at: https://gptzero.me/
 */
export class GPTZeroAdapter implements DetectionPlugin {
  readonly name = 'gptzero'
  readonly version = '1.0.0'

  private apiKey = ''

  configure(config: Record<string, string>): void {
    if (config.apiKey) this.apiKey = config.apiKey
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0
  }

  async detect(request: DetectionRequest): Promise<DetectionResult> {
    const response = await fetch('https://api.gptzero.me/v2/predict/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({ document: request.text }),
    })

    if (!response.ok) {
      return {
        isAI: false,
        confidence: 0,
        provider: 'gptzero',
        error: `HTTP ${response.status}`,
      }
    }

    const data = await response.json()
    // GPTZero returns completely_generated_prob (0–1) and average_generated_prob
    const confidence: number = data.documents?.[0]?.completely_generated_prob ?? 0

    return {
      isAI: confidence >= 0.5,
      confidence: parseFloat(confidence.toFixed(2)),
      provider: 'gptzero',
      raw: data,
    }
  }
}

import type { DetectionPlugin, DetectionRequest, DetectionResult } from '../plugin.js'

/**
 * Winston AI adapter
 * API docs: https://docs.gowinston.ai/api-reference/
 * Get a key at: https://gowinston.ai/
 */
export class WinstonAIAdapter implements DetectionPlugin {
  readonly name = 'winston-ai'
  readonly version = '1.0.0'

  private apiKey = ''

  configure(config: Record<string, string>): void {
    if (config.apiKey) this.apiKey = config.apiKey
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0
  }

  async detect(request: DetectionRequest): Promise<DetectionResult> {
    const response = await fetch('https://api.gowinston.ai/v2/predict', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ text: request.text, language: 'en' }),
    })

    if (!response.ok) {
      return {
        isAI: false,
        confidence: 0,
        provider: 'winston-ai',
        error: `HTTP ${response.status}`,
      }
    }

    const data = await response.json()
    // Winston returns score 0–100 (AI probability)
    const confidence: number = (data.score ?? 0) / 100

    return {
      isAI: confidence >= 0.5,
      confidence: parseFloat(confidence.toFixed(2)),
      provider: 'winston-ai',
      raw: data,
    }
  }
}

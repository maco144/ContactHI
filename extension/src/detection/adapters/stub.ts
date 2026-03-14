import type { DetectionPlugin, DetectionRequest, DetectionResult } from '../plugin.js'

/**
 * Built-in heuristic adapter — no API key required.
 * Uses phrase matching against common AI writing patterns.
 * Useful for development and as a fallback.
 */

const AI_SIGNALS: string[] = [
  // Self-identification
  'as an ai',
  "i'm an ai",
  'i am an ai',
  'language model',
  'large language model',
  'i was trained',
  'my training data',
  'my knowledge cutoff',
  "i don't have access to real-time",
  // Refusals
  'i cannot provide',
  'i am not able to',
  'i cannot assist with',
  'i apologize, but i',
  // Sycophantic openers
  "i'd be happy to",
  "i'd be glad to",
  'certainly!',
  'absolutely!',
  'of course!',
  'great question',
  'as a helpful assistant',
  // AI prose tells
  'dive deeper into',
  'delve into',
  "it's worth noting",
  'it is worth noting',
  'in conclusion,',
  'to summarize,',
  'in summary,',
  'furthermore,',
  'moreover,',
  'on the other hand,',
  'it is important to note',
  'it should be noted',
  'this comprehensive',
  'a comprehensive',
]

export class StubDetectionAdapter implements DetectionPlugin {
  readonly name = 'stub'
  readonly version = '1.0.0'

  private threshold = 0.4

  configure(config: Record<string, string>): void {
    if (config.threshold !== undefined) {
      this.threshold = parseFloat(config.threshold)
    }
  }

  isConfigured(): boolean {
    return true
  }

  async detect(request: DetectionRequest): Promise<DetectionResult> {
    const lower = request.text.toLowerCase()
    const wordCount = request.text.split(/\s+/).filter(Boolean).length

    let matchCount = 0
    for (const signal of AI_SIGNALS) {
      if (lower.includes(signal)) matchCount++
    }

    // Diminishing returns per match; cap at 1.0
    const rawScore = matchCount > 0 ? Math.min(matchCount * 0.2, 1.0) : 0

    // Penalise very short content — not enough signal
    const lengthPenalty = wordCount < 20 ? 0.5 : 1.0
    const confidence = parseFloat((rawScore * lengthPenalty).toFixed(2))

    return {
      isAI: confidence >= this.threshold,
      confidence,
      provider: 'stub',
    }
  }
}

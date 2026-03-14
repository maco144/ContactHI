import { getSettings } from '../shared/storage.js'
import { registerPlugin, getPlugin } from '../detection/registry.js'
import {
  StubDetectionAdapter,
  GPTZeroAdapter,
  WinstonAIAdapter,
  OriginalityAdapter,
} from '../detection/adapters/index.js'
import type { Message } from '../shared/messages.js'
import type { DetectionRequest, DetectionResult } from '../detection/plugin.js'

// Register all available adapters on startup
registerPlugin(new StubDetectionAdapter())
registerPlugin(new GPTZeroAdapter())
registerPlugin(new WinstonAIAdapter())
registerPlugin(new OriginalityAdapter())

chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse): boolean => {
    if (message.type === 'DETECT') {
      handleDetection(message).then(sendResponse)
      return true
    }
    if (message.type === 'GET_SETTINGS') {
      getSettings().then(sendResponse)
      return true
    }
    return false
  },
)

async function handleDetection(
  message: Extract<Message, { type: 'DETECT' }>,
): Promise<DetectionResult> {
  const settings = await getSettings()

  if (!settings.enabled) {
    return { isAI: false, confidence: 0, provider: 'disabled' }
  }

  const plugin = getPlugin(settings.detectionProvider)
  if (!plugin) {
    return {
      isAI: false,
      confidence: 0,
      provider: 'unknown',
      error: `Provider '${settings.detectionProvider}' not registered`,
    }
  }

  plugin.configure({
    threshold: String(settings.confidenceThreshold),
    ...settings.detectionProviderConfig,
  })

  if (!plugin.isConfigured()) {
    return {
      isAI: false,
      confidence: 0,
      provider: plugin.name,
      error: 'Provider not configured — check Settings for required API key',
    }
  }

  const request: DetectionRequest = {
    text: message.text,
    contentType: message.contentType as DetectionRequest['contentType'],
    metadata: message.metadata,
  }

  try {
    return await plugin.detect(request)
  } catch (err) {
    return {
      isAI: false,
      confidence: 0,
      provider: plugin.name,
      error: String(err),
    }
  }
}

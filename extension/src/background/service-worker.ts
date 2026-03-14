// Capture any top-level import or startup errors before anything else runs
self.addEventListener('error', (event) => {
  const msg = `SW error: ${event.message} (${event.filename}:${event.lineno})`
  chrome.storage.local.set({ modelError: msg, modelStatus: { state: 'error', message: msg } })
})
self.addEventListener('unhandledrejection', (event) => {
  const msg = `SW unhandled rejection: ${String((event as PromiseRejectionEvent).reason)}`
  chrome.storage.local.set({ modelError: msg, modelStatus: { state: 'error', message: msg } })
})

import { getSettings } from '../shared/storage.js'
import { registerPlugin, getPlugin } from '../detection/registry.js'
import { StubDetectionAdapter, LocalModelAdapter } from '../detection/adapters/index.js'
import type { Message } from '../shared/messages.js'
import type { DetectionRequest, DetectionResult } from '../detection/plugin.js'
import type { ModelStatus } from '../detection/adapters/local-model.js'

// Register adapters — local-model is the default, stub is the fallback
const localModel = new LocalModelAdapter()
registerPlugin(localModel)
registerPlugin(new StubDetectionAdapter())

// Warm up the model immediately so it's ready before the first email is opened
localModel.detect({ text: 'warmup', contentType: 'unknown' }).catch(() => {})

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
    if (message.type === 'GET_MODEL_STATUS') {
      chrome.storage.local.get('modelStatus').then((result) => {
        sendResponse((result.modelStatus ?? { state: 'idle' }) as ModelStatus)
      })
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

  const request: DetectionRequest = {
    text: message.text,
    contentType: message.contentType as DetectionRequest['contentType'],
    metadata: message.metadata,
  }

  try {
    return await plugin.detect(request)
  } catch (err) {
    // If local model fails, fall back to stub silently
    if (settings.detectionProvider === 'local-model') {
      const stub = getPlugin('stub')
      if (stub) {
        stub.configure({ threshold: String(settings.confidenceThreshold) })
        return await stub.detect(request)
      }
    }
    return { isAI: false, confidence: 0, provider: plugin.name, error: String(err) }
  }
}

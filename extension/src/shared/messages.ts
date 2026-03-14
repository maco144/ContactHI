import type { DetectionResult } from '../detection/plugin.js'
import type { ModelStatus } from '../detection/adapters/local-model.js'

export type Message =
  | { type: 'DETECT'; text: string; contentType: string; metadata?: Record<string, string> }
  | { type: 'DETECTION_RESULT'; result: DetectionResult }
  | { type: 'GET_SETTINGS' }
  | { type: 'SETTINGS_UPDATED' }
  | { type: 'MODEL_STATUS'; status: ModelStatus }
  | { type: 'GET_MODEL_STATUS' }

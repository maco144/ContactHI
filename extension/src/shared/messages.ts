import type { DetectionResult } from '../detection/plugin.js'

export type Message =
  | { type: 'DETECT'; text: string; contentType: string; metadata?: Record<string, string> }
  | { type: 'DETECTION_RESULT'; result: DetectionResult }
  | { type: 'GET_SETTINGS' }
  | { type: 'SETTINGS_UPDATED' }

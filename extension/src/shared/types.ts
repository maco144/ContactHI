export type DetectionAction = 'label' | 'blur' | 'hide' | 'none'

export interface ExtensionSettings {
  enabled: boolean
  detectionProvider: string
  detectionProviderConfig: Record<string, string>
  /** 0.0–1.0. Only act when provider confidence exceeds this. */
  confidenceThreshold: number
  action: DetectionAction
  /** User's CHI DID — used for on-chain registry lookups (future) */
  chiDid?: string
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  detectionProvider: 'local-model',
  detectionProviderConfig: {},
  confidenceThreshold: 0.3,
  action: 'label',
}

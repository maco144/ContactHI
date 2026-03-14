import { DEFAULT_SETTINGS } from './types.js'
import type { ExtensionSettings } from './types.js'

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.sync.get('settings')
  return { ...DEFAULT_SETTINGS, ...(result.settings ?? {}) }
}

export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<void> {
  const current = await getSettings()
  await chrome.storage.sync.set({ settings: { ...current, ...patch } })
}

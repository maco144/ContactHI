import { getSettings, saveSettings } from '../shared/storage.js'

async function init() {
  const settings = await getSettings()

  const dot = document.getElementById('statusDot')!
  const statusText = document.getElementById('statusText')!
  const toggle = document.getElementById('enabledToggle') as HTMLInputElement
  const providerChip = document.getElementById('providerChip')!
  const actionValue = document.getElementById('actionValue')!
  const thresholdValue = document.getElementById('thresholdValue')!

  function render(enabled: boolean) {
    dot.className = `status-dot${enabled ? '' : ' off'}`
    statusText.textContent = enabled ? 'Shield active' : 'Shield disabled'
    toggle.checked = enabled
  }

  render(settings.enabled)
  providerChip.textContent = settings.detectionProvider
  actionValue.textContent = settings.action
  thresholdValue.textContent = `${Math.round(settings.confidenceThreshold * 100)}%`

  toggle.addEventListener('change', async () => {
    await saveSettings({ enabled: toggle.checked })
    render(toggle.checked)
  })

  document.getElementById('openSettings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage()
  })
}

init().catch(console.error)

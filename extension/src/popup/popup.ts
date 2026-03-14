import { getSettings, saveSettings } from '../shared/storage.js'
import type { ModelStatus } from '../detection/adapters/local-model.js'
import type { Message } from '../shared/messages.js'

async function init() {
  const settings = await getSettings()

  const dot = document.getElementById('statusDot')!
  const statusText = document.getElementById('statusText')!
  const toggle = document.getElementById('enabledToggle') as HTMLInputElement
  const providerChip = document.getElementById('providerChip')!
  const actionValue = document.getElementById('actionValue')!
  const thresholdValue = document.getElementById('thresholdValue')!
  const modelBar = document.getElementById('modelBar')!
  const modelLabel = document.getElementById('modelLabel')!
  const modelPct = document.getElementById('modelPct')!
  const progressFill = document.getElementById('progressFill')!

  function renderShield(enabled: boolean) {
    toggle.checked = enabled
    // Dot state set separately by renderModel
  }

  function renderModel(status: ModelStatus) {
    const isLocalModel = settings.detectionProvider === 'local-model'

    if (!isLocalModel || status.state === 'ready') {
      modelBar.classList.remove('visible')
      dot.className = `status-dot${settings.enabled ? '' : ' off'}`
      statusText.textContent = settings.enabled ? 'Shield active' : 'Shield disabled'
      return
    }

    if (status.state === 'downloading') {
      modelBar.classList.add('visible')
      dot.className = 'status-dot loading'
      statusText.textContent = 'Downloading model…'
      modelLabel.textContent = `Downloading${status.file ? ` ${status.file}` : ''}…`
      modelPct.textContent = `${status.progress}%`
      progressFill.classList.remove('indeterminate')
      progressFill.style.width = `${status.progress}%`
    } else if (status.state === 'loading') {
      modelBar.classList.add('visible')
      dot.className = 'status-dot loading'
      statusText.textContent = 'Loading model…'
      modelLabel.textContent = 'Initialising RoBERTa…'
      modelPct.textContent = ''
      progressFill.classList.add('indeterminate')
      progressFill.style.width = ''
    } else if (status.state === 'error') {
      modelBar.classList.remove('visible')
      dot.className = 'status-dot error'
      statusText.textContent = 'Model error — using fallback'
    } else {
      // idle — model hasn't started loading yet
      modelBar.classList.add('visible')
      dot.className = 'status-dot loading'
      statusText.textContent = 'Preparing…'
      modelLabel.textContent = 'Waiting for model…'
      modelPct.textContent = ''
      progressFill.classList.add('indeterminate')
    }
  }

  // Initial render
  renderShield(settings.enabled)
  actionValue.textContent = settings.action
  thresholdValue.textContent = `${Math.round(settings.confidenceThreshold * 100)}%`

  if (settings.detectionProvider === 'local-model') {
    providerChip.textContent = 'on-device'
    providerChip.className = 'chip on-device'
  } else {
    providerChip.textContent = settings.detectionProvider
    providerChip.className = 'chip'
  }

  // Get current model status
  const modelStatus = await chrome.runtime.sendMessage({
    type: 'GET_MODEL_STATUS',
  } satisfies Message) as ModelStatus
  renderModel(modelStatus)

  // Listen for live model status updates while popup is open
  chrome.runtime.onMessage.addListener((message: Message) => {
    if (message.type === 'MODEL_STATUS') {
      renderModel(message.status)
    }
  })

  // Toggle
  toggle.addEventListener('change', async () => {
    await saveSettings({ enabled: toggle.checked })
    settings.enabled = toggle.checked
    renderShield(toggle.checked)
  })

  document.getElementById('openSettings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage()
  })
}

init().catch(console.error)

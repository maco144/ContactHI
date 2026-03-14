import { getSettings, saveSettings } from '../shared/storage.js'
import type { DetectionAction } from '../shared/types.js'

interface ProviderDef {
  id: string
  name: string
  description: string
  config: Array<{ key: string; label: string; placeholder: string }>
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'local-model',
    name: 'On-Device AI (RoBERTa)',
    description: 'Real ML inference — runs entirely in your browser. No data ever leaves your device. Downloads ~66MB on first use.',
    config: [],
  },
  {
    id: 'stub',
    name: 'Built-in Heuristics',
    description: 'Phrase and pattern matching — no download needed. Less accurate but instant. Useful as a fallback.',
    config: [],
  },
]

async function init() {
  const settings = await getSettings()

  // DID
  const didInput = document.getElementById('chiDid') as HTMLInputElement
  didInput.value = settings.chiDid ?? ''

  // Threshold
  const thresholdInput = document.getElementById('threshold') as HTMLInputElement
  const thresholdDisplay = document.getElementById('thresholdDisplay')!
  thresholdInput.value = String(Math.round(settings.confidenceThreshold * 100))
  thresholdDisplay.textContent = `${thresholdInput.value}%`
  thresholdInput.addEventListener('input', () => {
    thresholdDisplay.textContent = `${thresholdInput.value}%`
  })

  // Action
  const actionSelect = document.getElementById('action') as HTMLSelectElement
  actionSelect.value = settings.action

  // Provider cards
  const providerList = document.getElementById('providerList')!
  const configInputs: Record<string, Record<string, HTMLInputElement>> = {}

  for (const provider of PROVIDERS) {
    const card = document.createElement('div')
    card.className = `provider-card${settings.detectionProvider === provider.id ? ' active' : ''}`
    card.dataset.providerId = provider.id

    card.innerHTML = `
      <div class="provider-name">${provider.name}</div>
      <div class="provider-desc">${provider.description}</div>
    `

    if (provider.config.length > 0) {
      const configDiv = document.createElement('div')
      configDiv.className = `provider-config${settings.detectionProvider === provider.id ? ' visible' : ''}`
      configInputs[provider.id] = {}

      for (const field of provider.config) {
        const label = document.createElement('label')
        label.textContent = field.label
        label.style.cssText = 'display:block;font-size:12px;color:#94a3b8;margin-top:10px;margin-bottom:4px'

        const input = document.createElement('input')
        input.type = 'text'
        input.placeholder = field.placeholder
        input.value = settings.detectionProviderConfig?.[field.key] ?? ''
        input.style.cssText =
          'width:100%;padding:6px 10px;background:#0f172a;border:1px solid #334155;border-radius:5px;color:#f8fafc;font-size:12px;outline:none'

        configInputs[provider.id][field.key] = input
        configDiv.appendChild(label)
        configDiv.appendChild(input)
      }

      card.appendChild(configDiv)
    }

    card.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('.provider-card').forEach((c) => {
        c.classList.remove('active')
        c.querySelector<HTMLElement>('.provider-config')?.classList.remove('visible')
      })
      card.classList.add('active')
      card.querySelector<HTMLElement>('.provider-config')?.classList.add('visible')
    })

    providerList.appendChild(card)
  }

  // Save
  const saveBtn = document.getElementById('saveBtn')!
  const savedMsg = document.getElementById('savedMsg')!

  saveBtn.addEventListener('click', async () => {
    const activeCard = document.querySelector<HTMLElement>('.provider-card.active')
    const selectedProvider = activeCard?.dataset.providerId ?? settings.detectionProvider

    const providerConfig: Record<string, string> = {}
    for (const [key, input] of Object.entries(configInputs[selectedProvider] ?? {})) {
      if (input.value.trim()) providerConfig[key] = input.value.trim()
    }

    await saveSettings({
      chiDid: didInput.value.trim() || undefined,
      detectionProvider: selectedProvider,
      detectionProviderConfig: providerConfig,
      confidenceThreshold: parseInt(thresholdInput.value, 10) / 100,
      action: actionSelect.value as DetectionAction,
    })

    savedMsg.classList.add('visible')
    setTimeout(() => savedMsg.classList.remove('visible'), 2000)
  })
}

init().catch(console.error)

import { applyAction } from './ui.js'
import type { Message } from '../shared/messages.js'
import type { ExtensionSettings } from '../shared/types.js'

async function detect(text: string, metadata?: Record<string, string>) {
  return chrome.runtime.sendMessage({
    type: 'DETECT',
    text,
    contentType: 'webpage',
    metadata,
  } satisfies Message)
}

async function getSettings(): Promise<ExtensionSettings> {
  return chrome.runtime.sendMessage({ type: 'GET_SETTINGS' } satisfies Message)
}

function extractTextBlocks(): HTMLElement[] {
  // Prefer semantic content containers
  const semantic = [
    ...document.querySelectorAll<HTMLElement>('article, [role="article"], main'),
  ]
  if (semantic.length > 0) return semantic

  // Fallback: find the parent of the largest paragraph cluster
  const paragraphs = Array.from(document.querySelectorAll<HTMLElement>('p'))
  const parents = new Map<HTMLElement, number>()
  for (const p of paragraphs) {
    if (!p.parentElement) continue
    parents.set(p.parentElement, (parents.get(p.parentElement) ?? 0) + p.innerText.length)
  }

  const [topParent] = [...parents.entries()].sort((a, b) => b[1] - a[1])
  return topParent ? [topParent[0]] : []
}

async function init(): Promise<void> {
  const settings = await getSettings()
  if (!settings.enabled) return

  const blocks = extractTextBlocks()

  for (const el of blocks) {
    if (el.dataset.chiProcessed) continue
    const text = el.innerText?.trim()
    if (!text || text.length < 120) continue

    const result = await detect(text, { url: location.href })
    if (result?.isAI && result.confidence >= settings.confidenceThreshold) {
      applyAction(el, settings.action, result.confidence, result.provider)
    }
  }
}

// Skip extension and browser pages
const skip = /^(chrome|chrome-extension|about|data|moz-extension):/
if (!skip.test(location.protocol)) {
  window.addEventListener('load', () => init().catch(console.error))
}

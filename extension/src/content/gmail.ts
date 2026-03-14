import { applyAction } from './ui.js'
import type { Message } from '../shared/messages.js'
import type { ExtensionSettings } from '../shared/types.js'

async function detect(
  text: string,
  metadata?: Record<string, string>,
) {
  return chrome.runtime.sendMessage({
    type: 'DETECT',
    text,
    contentType: 'email',
    metadata,
  } satisfies Message)
}

async function getSettings(): Promise<ExtensionSettings> {
  return chrome.runtime.sendMessage({ type: 'GET_SETTINGS' } satisfies Message)
}

// ── Reading pane ──────────────────────────────────────────────────────────────

async function processEmailPane(pane: Element): Promise<void> {
  const bodyEl = pane.querySelector('.a3s.aiL') as HTMLElement | null
  if (!bodyEl || bodyEl.dataset.chiProcessed) return

  const text = bodyEl.innerText?.trim()
  if (!text || text.length < 60) return

  const senderEl = pane.querySelector('.gD') as HTMLElement | null
  const subjectEl = pane.querySelector('h2.hP') as HTMLElement | null

  const result = await detect(text, {
    sender: senderEl?.getAttribute('email') ?? senderEl?.innerText ?? '',
    subject: subjectEl?.innerText ?? '',
  })

  const settings = await getSettings()
  if (result?.isAI && result.confidence >= settings.confidenceThreshold) {
    applyAction(bodyEl, settings.action, result.confidence, result.provider)
  }
}

// ── Inbox rows ────────────────────────────────────────────────────────────────

async function processInboxRows(): Promise<void> {
  const settings = await getSettings()
  const rows = document.querySelectorAll<HTMLElement>('.zA:not([data-chi-scanned])')

  for (const row of rows) {
    row.dataset.chiScanned = 'true'
    const snippetEl = row.querySelector('.y2') as HTMLElement | null
    if (!snippetEl) continue

    const text = snippetEl.innerText?.trim()
    if (!text || text.length < 30) continue

    const result = await detect(text)
    if (!result?.isAI || result.confidence < settings.confidenceThreshold) continue

    // Subtle dot on inbox rows — avoid altering row layout
    if (snippetEl.dataset.chiDot) continue
    snippetEl.dataset.chiDot = 'true'

    const dot = document.createElement('span')
    dot.title = `CHI: AI-generated content detected (${Math.round(result.confidence * 100)}% via ${result.provider})`
    dot.style.cssText = `
      display: inline-block;
      width: 7px;
      height: 7px;
      background: #f59e0b;
      border-radius: 50%;
      margin-right: 5px;
      flex-shrink: 0;
      vertical-align: middle;
    `
    snippetEl.prepend(dot)
  }
}

// ── Observers ─────────────────────────────────────────────────────────────────

function watchReadingPane(): void {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue
        // Reading pane container in Gmail
        const pane = node.matches('.gs') ? node : node.querySelector('.gs')
        if (pane) processEmailPane(pane)
      }
    }
  })
  // .AO is Gmail's main content column
  const target = document.querySelector('.AO') ?? document.body
  observer.observe(target, { childList: true, subtree: true })
}

function watchInbox(): void {
  const observer = new MutationObserver(() => processInboxRows())
  const target = document.querySelector('.BltHh') ?? document.body
  observer.observe(target, { childList: true, subtree: true })
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const settings = await getSettings()
  if (!settings.enabled) return

  watchReadingPane()
  watchInbox()
  await processInboxRows()
}

init().catch(console.error)

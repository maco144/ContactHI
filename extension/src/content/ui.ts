/**
 * DOM manipulation helpers for applying detection actions.
 * All functions are idempotent — safe to call multiple times on the same element.
 */

function badge(confidence: number, provider: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'chi-ai-badge'
  el.innerHTML = `
    <span style="font-size:10px;opacity:0.7">⚠</span>
    AI-generated &middot; ${Math.round(confidence * 100)}%
    <span style="font-size:9px;opacity:0.6">(${provider})</span>
  `
  el.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    margin-bottom: 6px;
    background: #fef3c7;
    border: 1px solid #f59e0b;
    border-radius: 4px;
    font-size: 11px;
    font-family: system-ui, sans-serif;
    color: #92400e;
    cursor: default;
    line-height: 1.6;
  `
  return el
}

export function applyLabel(el: HTMLElement, confidence: number, provider: string): void {
  if (el.dataset.chiProcessed) return
  el.dataset.chiProcessed = 'label'
  el.insertAdjacentElement('beforebegin', badge(confidence, provider))
}

export function applyBlur(el: HTMLElement, confidence: number, provider: string): void {
  if (el.dataset.chiProcessed) return
  el.dataset.chiProcessed = 'blur'

  const wrapper = document.createElement('div')
  wrapper.style.cssText = 'position:relative;display:contents'

  const overlay = document.createElement('div')
  overlay.style.cssText = `
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
    cursor: pointer;
    border-radius: 4px;
    backdrop-filter: blur(0px);
  `

  const pill = document.createElement('div')
  pill.style.cssText = `
    padding: 6px 14px;
    background: rgba(0,0,0,0.72);
    color: #fff;
    border-radius: 6px;
    font-size: 12px;
    font-family: system-ui, sans-serif;
    pointer-events: none;
  `
  pill.textContent = `AI-generated (${Math.round(confidence * 100)}%) — click to reveal`
  overlay.appendChild(pill)

  el.style.filter = 'blur(5px)'
  el.style.userSelect = 'none'
  el.parentNode?.insertBefore(wrapper, el)
  wrapper.appendChild(el)
  wrapper.appendChild(overlay)

  overlay.addEventListener('click', () => {
    el.style.filter = ''
    el.style.userSelect = ''
    overlay.remove()
  })
}

export function applyHide(el: HTMLElement): void {
  if (el.dataset.chiProcessed) return
  el.dataset.chiProcessed = 'hide'
  el.style.display = 'none'
}

export function applyAction(
  el: HTMLElement,
  action: string,
  confidence: number,
  provider: string,
): void {
  switch (action) {
    case 'label':
      applyLabel(el, confidence, provider)
      break
    case 'blur':
      applyBlur(el, confidence, provider)
      break
    case 'hide':
      applyHide(el)
      break
    // 'none' — detect only, no visual change
  }
}

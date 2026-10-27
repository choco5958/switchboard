// Runs inside the page the browser view shows (injected with executeJavaScript).
// It reports back through console messages with a fixed prefix and a nonce the
// host makes for each injection, which the host reads from the webview's
// console-message event. The page's own scripts can log too: a message without
// the nonce is ignored, so a page cannot fake picks, comments or mode changes.
//
// Flow: a click in comment mode sends PICK (element, where it is, its box); the
// host saves a shot of that box, then calls __claudeIde.ask(id), which opens the
// memo popover next to the element. 저장 sends SAVE, 취소 or Esc sends CANCEL.
// Esc with no popover sends EXIT; ⌥M sends TOGGLE (the host owns the mode).
import { t } from '../../shared/i18n'

export const PICK_PREFIX = '__CLAUDE_IDE_PICK__'
export const SAVE_PREFIX = '__CLAUDE_IDE_SAVE__'
export const CANCEL_PREFIX = '__CLAUDE_IDE_CANCEL__'
export const EXIT_PREFIX = '__CLAUDE_IDE_EXIT__'
export const TOGGLE_PREFIX = '__CLAUDE_IDE_TOGGLE__'

// The words of a breadcrumb in the UI language; they go into the page with the picker.
const CRUMB_WORDS = ['main', 'nav', 'header', 'footer', 'aside', 'dialog', 'form', 'table', 'list', 'section', 'named', 'quoted', 'button', 'link', 'checkbox', 'radio', 'input', 'select', 'image', 'heading', 'listItem', 'row', 'cell', 'label', 'paragraph', 'tag', 'text', 'element'] as const
export type CrumbWords = Record<(typeof CRUMB_WORDS)[number], string>

export function crumbWords(): CrumbWords {
  return Object.fromEntries(CRUMB_WORDS.map(word => [word, t(`crumb.${word}`)])) as CrumbWords
}

export type Pick = {
  selector: string
  tag: string
  text: string
  url: string
  rect: { x: number; y: number; width: number; height: number }
  crumbs?: string[] // where it is, outermost first: 본문 › 현황판 쪽 › "미시작" 꼬리표
}

export type PickMessage = Pick & { id: number }

// What the page tells about one element on the way from the clicked one up to <body>.
export type CrumbNode = {
  tag: string // lower case
  role: string
  type: string // input type
  label: string // aria-label, aria-labelledby, <label for>, placeholder, alt, title
  heading: string // first heading or legend directly inside, for sections
  cls: string
  text: string // own visible text, for the clicked element
}

// The breadcrumb for a chain that starts at the clicked element (index 0) and
// goes outward, in the UI language.
export function crumbsOf(chain: CrumbNode[], words: CrumbWords = crumbWords()): string[] {
  return crumbsIn(chain, words)
}

// Self-contained: it is also injected into the page as source.
function crumbsIn(chain: CrumbNode[], w: CrumbWords): string[] {
  const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all)
  const clean = (value: string, max: number) => {
    const one = (value || '').replace(/\s+/g, ' ').trim()
    return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one
  }
  const named = (base: string, name: string) => (name ? fill(w.named, { name, base }) : base)
  const place = (node: CrumbNode): string => {
    const name = clean(node.label || node.heading, 20)
    const role = node.role
    if (node.tag === 'main' || role === 'main') return w.main
    if (node.tag === 'nav' || role === 'navigation') return named(w.nav, name)
    if (node.tag === 'header' || role === 'banner') return w.header
    if (node.tag === 'footer' || role === 'contentinfo') return w.footer
    if (node.tag === 'aside' || role === 'complementary') return named(w.aside, name)
    if (node.tag === 'dialog' || role === 'dialog' || role === 'alertdialog') return named(w.dialog, name)
    if (node.tag === 'form' || role === 'form') return named(w.form, name)
    if (node.tag === 'table' || role === 'table' || role === 'grid') return named(w.table, name)
    if (node.tag === 'ul' || node.tag === 'ol' || role === 'list') return node.label ? named(w.list, clean(node.label, 20)) : ''
    const sectiony = ['section', 'article', 'fieldset'].includes(node.tag) || role === 'region' || role === 'group' || role === 'tabpanel'
    if (sectiony && name) return fill(w.section, { name })
    if (node.label) return fill(w.section, { name: clean(node.label, 20) })
    return ''
  }
  const kind = (node: CrumbNode): string => {
    const { tag, role, type } = node
    if (tag === 'button' || role === 'button' || (tag === 'input' && ['submit', 'button', 'reset'].includes(type))) return w.button
    if (tag === 'a' || role === 'link') return w.link
    if (tag === 'input' && type === 'checkbox') return w.checkbox
    if (tag === 'input' && type === 'radio') return w.radio
    if (tag === 'input' || tag === 'textarea' || role === 'textbox') return w.input
    if (tag === 'select' || role === 'combobox') return w.select
    if (tag === 'img' || tag === 'svg' || tag === 'picture' || tag === 'canvas' || role === 'img') return w.image
    if (/^h[1-6]$/.test(tag) || role === 'heading') return w.heading
    if (tag === 'li' || role === 'listitem') return w.listItem
    if (tag === 'ul' || tag === 'ol') return w.list
    if (tag === 'tr' || role === 'row') return w.row
    if (tag === 'td' || tag === 'th' || role === 'cell') return w.cell
    if (tag === 'table') return w.table
    if (tag === 'label') return w.label
    if (tag === 'p') return w.paragraph
    if (/(^|[-_ ])(badge|tag|chip|pill|label|status)/i.test(node.cls)) return w.tag
    if (['span', 'strong', 'em', 'b', 'small', 'i'].includes(tag)) return w.text
    return w.element
  }
  const first = chain[0]
  if (!first) return []
  const name = clean(first.label || first.text, 24)
  const self = name ? fill(w.quoted, { name, kind: kind(first) }) : kind(first)
  const places: string[] = []
  for (const node of chain.slice(1)) {
    const one = place(node)
    if (one && places[0] !== one) places.unshift(one)
  }
  const kept = places.length > 3 ? [places[0] as string, ...places.slice(-2)] : places
  return [...kept, self]
}

export type PageMessage =
  | { kind: 'pick'; pick: PickMessage }
  | { kind: 'save'; id: number; memo: string }
  | { kind: 'cancel'; id: number }
  | { kind: 'exit' }
  | { kind: 'toggle' }

export function makeNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

const MAX_TEXT = 4000

// A console message from the page, when it carries this injection's nonce and
// the shape the picker sends; anything else is null.
export function parseMessage(message: string, nonce: string): PageMessage | null {
  if (!nonce) return null
  if (message === EXIT_PREFIX + nonce) return { kind: 'exit' }
  if (message === TOGGLE_PREFIX + nonce) return { kind: 'toggle' }
  const body = (prefix: string): Record<string, unknown> | null => {
    const head = prefix + nonce + ':'
    if (!message.startsWith(head)) return null
    try {
      const parsed: unknown = JSON.parse(message.slice(head.length))
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const id = (data: Record<string, unknown>) => (Number.isInteger(data.id) && (data.id as number) > 0 ? (data.id as number) : null)
  const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : '')
  const cancel = body(CANCEL_PREFIX)
  if (cancel) return id(cancel) ? { kind: 'cancel', id: id(cancel)! } : null
  const save = body(SAVE_PREFIX)
  if (save) return id(save) && text(save.memo).trim() ? { kind: 'save', id: id(save)!, memo: text(save.memo).trim() } : null
  const pick = body(PICK_PREFIX)
  if (!pick || !id(pick)) return null
  const r = (pick.rect ?? {}) as Record<string, unknown>
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    kind: 'pick',
    pick: {
      id: id(pick)!,
      selector: text(pick.selector),
      tag: text(pick.tag).slice(0, 40),
      text: text(pick.text).slice(0, 160),
      url: text(pick.url),
      rect: { x: num(r.x), y: num(r.y), width: Math.max(0, num(r.width)), height: Math.max(0, num(r.height)) },
      crumbs: Array.isArray(pick.crumbs) ? pick.crumbs.slice(0, 8).map(c => text(c).slice(0, 80)) : [],
    },
  }
}

// Element shots are taken for picks: at most one per gap and a fixed number per
// page load, so a page that found a way around the nonce still cannot fill the disk.
export class CaptureLimiter {
  private last = -Infinity
  private count = 0
  constructor(
    private readonly gapMs = 500,
    private readonly max = 100,
  ) {}
  reset(): void {
    this.last = -Infinity
    this.count = 0
  }
  allow(now: number): boolean {
    if (this.count >= this.max || now - this.last < this.gapMs) return false
    this.last = now
    this.count++
    return true
  }
}

// Text for the popover markup, which sits inside a single-quoted string of the source.
const attr = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

// Evaluates to 'kept' when the document already has a picker (which keeps its nonce).
export const pickerSource = (nonce: string): string => `(() => {
  if (window.__claudeIde) return 'kept'
  const nonce = ${JSON.stringify(nonce)}
  const log = console.log.bind(console)
  const send = (prefix, data) => log(prefix + nonce + (data === undefined ? '' : ':' + JSON.stringify(data)))
  const crumbsIn = (${crumbsIn.toString()})
  const crumbWords = ${JSON.stringify(crumbWords())}
  const host = document.createElement('div')
  host.setAttribute('data-claude-ide', '')
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = '<style>' +
    '.box{position:fixed;pointer-events:none;border:2px solid #5b8cff;background:rgba(91,140,255,.12);border-radius:3px;display:none}' +
    '.box.sel{border-color:#f2b84b;background:rgba(242,184,75,.14)}' +
    '.pop{position:fixed;display:none;width:320px;pointer-events:auto;padding:10px;border:1px solid #2a3354;border-radius:10px;background:#161c30;color:#dde3f3;font:13px/1.5 Pretendard,-apple-system,"Apple SD Gothic Neo",sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.45)}' +
    '.crumbs{margin-bottom:6px;color:#8b95b5;font-size:12px;word-break:keep-all}' +
    '.crumbs b{color:#dde3f3;font-weight:600}' +
    'textarea{box-sizing:border-box;width:100%;min-height:72px;padding:8px;border:1px solid #2a3354;border-radius:8px;background:#0f1424;color:#dde3f3;font:inherit;resize:vertical;outline:none}' +
    'textarea:focus{border-color:#5b8cff}' +
    '.row{display:flex;align-items:center;gap:6px;margin-top:8px}' +
    '.hint{flex:1;color:#8b95b5;font-size:11px}' +
    'button{padding:4px 12px;border:1px solid #2a3354;border-radius:6px;background:#1c2440;color:#dde3f3;font:inherit;cursor:pointer}' +
    'button.save{background:#5b8cff;border-color:#5b8cff;color:#fff}' +
    'button:disabled{opacity:.45;cursor:default}' +
    '.mark{position:fixed;display:grid;place-items:center;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#f2b84b;color:#0f1424;font:700 11px/18px sans-serif;pointer-events:none}' +
    '</style>' +
    '<div class="box hover"></div><div class="box sel"></div><div class="marks"></div>' +
    '<div class="pop"><div class="crumbs"></div><textarea placeholder="${attr(t('picker.placeholder'))}"></textarea>' +
    '<div class="row"><span class="hint">${attr(t('picker.hint'))}</span><button class="cancel">${attr(t('picker.cancel'))}</button><button class="save" disabled>${attr(t('picker.save'))}</button></div></div>'
  document.documentElement.appendChild(host)
  const hover = root.querySelector('.hover')
  const sel = root.querySelector('.sel')
  const pop = root.querySelector('.pop')
  const crumbBox = root.querySelector('.crumbs')
  const memo = root.querySelector('textarea')
  const saveButton = root.querySelector('.save')
  const marksBox = root.querySelector('.marks')
  let on = false
  let nextId = 1
  let pending = null // { id, rect, crumbs } between PICK and SAVE/CANCEL
  let marks = []
  const ours = e => e.composedPath().includes(host)
  const place = (el, r) => {
    el.style.display = 'block'
    el.style.left = r.x + 'px'; el.style.top = r.y + 'px'
    el.style.width = r.width + 'px'; el.style.height = r.height + 'px'
  }
  const pathOf = el => {
    const parts = []
    for (let node = el; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break }
      let part = node.tagName.toLowerCase()
      const cls = [...node.classList].filter(c => !/^(css|sc|jsx)-/.test(c)).slice(0, 2)
      if (cls.length) part += '.' + cls.map(c => CSS.escape(c)).join('.')
      const parent = node.parentElement
      if (parent) {
        const same = [...parent.children].filter(c => c.tagName === node.tagName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
    }
    return parts.join(' > ')
  }
  const textOf = id => {
    const el = id && document.getElementById(id)
    return el ? (el.innerText || el.textContent || '') : ''
  }
  const labelOf = el => {
    const by = el.getAttribute('aria-labelledby')
    if (by) { const t = by.split(/\\s+/).map(textOf).join(' ').trim(); if (t) return t }
    const aria = el.getAttribute('aria-label')
    if (aria) return aria
    if (el.labels && el.labels.length) return el.labels[0].innerText || ''
    return el.getAttribute('placeholder') || el.getAttribute('alt') || ''
  }
  const HEAD = ':scope > :is(h1,h2,h3,h4,h5,h6), :scope > header :is(h1,h2,h3,h4,h5,h6), :scope > legend, :scope > caption, :scope > :is(div,hgroup) > :is(h1,h2,h3,h4,h5,h6)'
  const nodeOf = (el, self) => {
    let heading = ''
    try { const h = el.querySelector(HEAD); if (h) heading = h.innerText || h.textContent || '' } catch (e) {}
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      type: (el.getAttribute('type') || '').toLowerCase(),
      label: labelOf(el),
      heading,
      cls: typeof el.className === 'string' ? el.className : '',
      text: self ? (el.innerText || el.value || el.getAttribute('title') || '').trim().slice(0, 160) : '',
    }
  }
  const crumbsFor = el => {
    const chain = []
    for (let node = el; node && node.nodeType === 1 && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      chain.push(nodeOf(node, node === el))
    }
    if (!chain.length) chain.push(nodeOf(el, true))
    return crumbsIn(chain, crumbWords)
  }
  const close = () => {
    pop.style.display = 'none'
    sel.style.display = 'none'
    memo.value = ''
    saveButton.disabled = true
  }
  const cancel = () => {
    if (!pending) return
    const id = pending.id
    pending = null
    close()
    send(${JSON.stringify(CANCEL_PREFIX)}, { id })
  }
  const save = () => {
    const text = memo.value.trim()
    if (!pending || !text) return
    const id = pending.id
    pending = null
    close()
    send(${JSON.stringify(SAVE_PREFIX)}, { id, memo: text })
  }
  const drawMarks = () => {
    marksBox.innerHTML = ''
    for (const m of marks) {
      if (m.url !== location.href.split('#')[0]) continue
      let el = null
      try { el = document.querySelector(m.selector) } catch (e) {}
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (r.bottom < 0 || r.top > innerHeight) continue
      const dot = document.createElement('div')
      dot.className = 'mark'
      dot.textContent = String(m.n)
      dot.style.left = Math.max(0, r.left - 8) + 'px'
      dot.style.top = Math.max(0, r.top - 8) + 'px'
      marksBox.appendChild(dot)
    }
  }
  let frame = 0
  const redraw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawMarks() }) }
  memo.addEventListener('input', () => { saveButton.disabled = !memo.value.trim() })
  memo.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save() }
    if (e.key === 'Escape') { e.preventDefault(); cancel() }
  })
  memo.addEventListener('keyup', e => e.stopPropagation())
  memo.addEventListener('keypress', e => e.stopPropagation())
  root.querySelector('.cancel').addEventListener('click', cancel)
  saveButton.addEventListener('click', save)
  const move = e => {
    if (!on || ours(e) || !(e.target instanceof Element)) return
    place(hover, e.target.getBoundingClientRect())
  }
  const block = e => {
    if (!on || ours(e)) return
    e.preventDefault(); e.stopPropagation()
  }
  const click = e => {
    if (!on || ours(e) || !(e.target instanceof Element)) return
    e.preventDefault(); e.stopPropagation()
    cancel()
    const el = e.target
    const r = el.getBoundingClientRect()
    const rect = { x: r.left, y: r.top, width: r.width, height: r.height }
    pending = { id: nextId++, rect, crumbs: crumbsFor(el) }
    hover.style.display = 'none'
    send(${JSON.stringify(PICK_PREFIX)}, {
      id: pending.id,
      selector: pathOf(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 160),
      url: location.href,
      rect,
      crumbs: pending.crumbs,
    })
  }
  const key = e => {
    if (e.altKey && e.code === 'KeyM') { e.preventDefault(); e.stopPropagation(); send(${JSON.stringify(TOGGLE_PREFIX)}); return }
    if (!on || e.key !== 'Escape') return
    if (ours(e)) return
    e.preventDefault()
    if (pending) return cancel()
    send(${JSON.stringify(EXIT_PREFIX)})
    window.__claudeIde.set(false)
  }
  addEventListener('mousemove', move, true)
  addEventListener('pointerdown', block, true)
  addEventListener('mousedown', block, true)
  addEventListener('mouseup', block, true)
  addEventListener('click', click, true)
  addEventListener('keydown', key, true)
  addEventListener('scroll', redraw, true)
  addEventListener('resize', redraw)
  window.__claudeIde = {
    set(value) {
      on = value
      hover.style.display = 'none'
      if (!on) cancel()
      document.documentElement.style.cursor = on ? 'crosshair' : ''
    },
    // Opens the memo popover next to the picked element (after the host took its shot).
    ask(id) {
      if (!pending || pending.id !== id) return
      const r = pending.rect
      place(sel, r)
      crumbBox.innerHTML = ''
      const parts = pending.crumbs || []
      parts.forEach((part, i) => {
        if (i) crumbBox.appendChild(document.createTextNode(' › '))
        const span = document.createElement(i === parts.length - 1 ? 'b' : 'span')
        span.textContent = part
        crumbBox.appendChild(span)
      })
      pop.style.display = 'block'
      const w = pop.offsetWidth, h = pop.offsetHeight, gap = 8
      let top = r.y + r.height + gap
      if (top + h > innerHeight - gap) top = r.y - h - gap
      if (top < gap) top = Math.min(Math.max(gap, r.y), innerHeight - h - gap)
      let left = Math.min(Math.max(gap, r.x), innerWidth - w - gap)
      pop.style.top = Math.max(gap, top) + 'px'
      pop.style.left = Math.max(gap, left) + 'px'
      memo.focus()
    },
    cancel,
    // Numbered pins on the elements that already have a comment: [{ n, selector, url }].
    marks(list) { marks = list || []; drawMarks() },
  }
  return 'installed'
})()`

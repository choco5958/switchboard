// A session driving the in-app browser (browser_* tools, bridge POST /browser/act). It reads
// the page as a short list of the things it can act on, each with a ref bound to that
// reading: a ref from an older reading is refused, so the session never clicks a stale
// element. Clicks and typing go in as real input events; a click on an element something
// else covers is refused with what covers it. Only pages on this computer can be driven, and
// pages on the private network too when the person allows it in Settings (BROWSER_LAN_KEY).

export const ELEMENTS_MAX = 200
export const TEXT_MAX = 12_000

// Settings: true lets sessions drive private network pages (192.168.x.x, 10.x.x.x, name.local)
// too. Off unless set: a router's or a NAS's admin page lives there, and this browser keeps
// its sign-ins.
export const BROWSER_LAN_KEY = 'agentBrowserLan'

export function isLocalUrl(raw: string, lan = false): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  if (lan && host.endsWith('.local')) return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return a === 127 || (lan && (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)))
}

export type Snapshot = {
  url: string
  title: string
  elements: { ref: string; role: string; name: string }[]
  text: string
  truncated: boolean
}

// Runs in the page: marks each visible element one can act on with data-sb-ref="<rev>:<n>"
// and returns them with the page's visible text.
export function snapshotScript(rev: number): string {
  return `(() => {
  const REV = ${rev}, MAX = ${ELEMENTS_MAX}, TEXT = ${TEXT_MAX};
  for (const old of document.querySelectorAll('[data-sb-ref]')) old.removeAttribute('data-sb-ref');
  const shown = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const roleOf = el => el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' })[el.tagName]
    || (el.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', range: 'slider' })[el.type] || 'textbox' : el.isContentEditable ? 'textbox' : 'clickable');
  // Attributes last: the script runs in a world of its own, where properties a page's own
  // elements define (a web component's value) are not seen, but their attributes are.
  const nameOf = el => (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.value || el.placeholder || el.title || el.alt || el.name || el.getAttribute('label') || el.getAttribute('value') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const query = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [contenteditable=""], [contenteditable=true], [onclick], [tabindex]:not([tabindex="-1"])';
  const elements = [];
  for (const el of document.querySelectorAll(query)) {
    if (elements.length >= MAX) break;
    if (!shown(el) || el.disabled) continue;
    const ref = REV + ':' + (elements.length + 1);
    el.setAttribute('data-sb-ref', ref);
    elements.push({ ref, role: roleOf(el), name: nameOf(el) });
  }
  const all = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { url: location.href, title: document.title, elements, text: all.slice(0, TEXT), truncated: all.length > TEXT || elements.length >= MAX };
})()`
}

// Runs in the page: the element of a ref scrolled into view and the point to press, or why not.
export function pointScript(ref: string): string {
  return `(() => {
  const el = document.querySelector('[data-sb-ref="' + ${JSON.stringify(ref)} + '"]');
  if (!el) return { error: 'stale' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  if (top && top !== el && !el.contains(top) && !top.contains(el)) {
    const what = (top.getAttribute('aria-label') || top.innerText || top.tagName).replace(/\\s+/g, ' ').trim().slice(0, 60);
    return { error: 'covered', by: top.tagName.toLowerCase() + ' "' + what + '"' };
  }
  return { x, y };
})()`
}

// Runs in the page: focus the element of a ref and select what it holds, so typing replaces it.
export function focusScript(ref: string): string {
  return `(() => {
  const el = document.querySelector('[data-sb-ref="' + ${JSON.stringify(ref)} + '"]');
  if (!el) return { error: 'stale' };
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (typeof el.select === 'function') el.select();
  else if (el.isContentEditable) document.execCommand('selectAll');
  return { ok: true };
})()`
}

// What the session reads: the address, the title, one line per element, then the text.
export function snapshotText(s: Snapshot): string {
  return [
    `URL: ${s.url}`,
    `Title: ${s.title}`,
    '',
    'Elements (ref role "name"):',
    ...s.elements.map(e => `[${e.ref}] ${e.role}${e.name ? ` "${e.name}"` : ''}`),
    '',
    'Text:',
    s.text,
    s.truncated ? '\n(truncated)' : '',
  ]
    .join('\n')
    .trimEnd()
}

// A ref like "3:12" belongs to reading 3.
export function refRevision(ref: string): number | null {
  const match = /^(\d+):\d+$/.exec(ref)
  return match ? Number(match[1]) : null
}

// A session driving the in-app browser (browser_* tools, bridge POST /browser/act). It reads
// the page as a short list of the things it can act on, each with a ref bound to that
// reading: a ref from an older reading is refused, so the session never clicks a stale
// element. Clicks and typing go in as real input events; a click on an element that is now
// hidden, disabled or out of view, or that something else covers, is refused with why, so the
// session never reads a click that went nowhere as one that worked. A press never opens the
// system's file dialog (FILE_NOTE). Only pages on this computer can be driven, and
// pages on the private network too when the person allows it in Settings (BROWSER_LAN_KEY).

export const ELEMENTS_MAX = 200
export const TEXT_MAX = 12_000
// How many of a select's options a reading lists.
export const OPTIONS_MAX = 30
// How long after a press the page's asks for a file are turned down (ms).
const FILE_GUARD_MS = 2000

// What the session reads when its press made the page ask for a file.
export const FILE_NOTE =
  'The page asked for a file to upload. A session cannot choose files, so no file dialog was opened; ask the person to choose the file in the browser.'

// Settings: true lets sessions drive private network pages (192.168.x.x, 10.x.x.x, name.local)
// too. Off unless set: a router's or a NAS's admin page lives there, and this browser keeps
// its sign-ins.
export const BROWSER_LAN_KEY = 'agentBrowserLan'

// The address a navigation event moved the shown page to, or null when only a frame inside
// the page moved: an embedded frame's route change (did-navigate-in-page fires for every
// frame) is not the page's address. did-navigate carries no isMainFrame; it is the main frame.
export function navigatedTo(event: { url: string; isMainFrame?: boolean }): string | null {
  return event.isMainFrame === false ? null : event.url
}

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
  // What a form control holds is not in the page's text: a field's value, a select's choice and
  // the options it can take, whether a checkbox or radio is checked.
  elements: { ref: string; role: string; name: string; value?: string; options?: string[]; checked?: boolean }[]
  text: string
  truncated: boolean
}

// Runs in the page: marks each visible element one can act on with data-sb-ref="<rev>:<n>"
// and returns them with the page's visible text.
export function snapshotScript(rev: number): string {
  return `(() => {
  const REV = ${rev}, MAX = ${ELEMENTS_MAX}, TEXT = ${TEXT_MAX}, OPTIONS = ${OPTIONS_MAX};
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
  // A select's own text is every option it holds, and a password field's value is not for reading.
  const held = el => el.tagName === 'SELECT' ? '' : el.innerText || (el.type === 'password' ? '' : el.value);
  const nameOf = el => (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || held(el) || el.placeholder || el.title || el.alt || el.name || el.getAttribute('label') || (el.type === 'password' ? '' : el.getAttribute('value')) || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const label = o => (o.label || o.text || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  // Inputs whose value is not what the field holds for reading: a secret, a button's caption, a file's path.
  const UNREAD = ['password', 'submit', 'button', 'reset', 'image', 'file'];
  const query = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [contenteditable=""], [contenteditable=true], [onclick], [tabindex]:not([tabindex="-1"])';
  const elements = [];
  for (const el of document.querySelectorAll(query)) {
    if (elements.length >= MAX) break;
    if (!shown(el) || el.disabled) continue;
    const ref = REV + ':' + (elements.length + 1);
    el.setAttribute('data-sb-ref', ref);
    const one = { ref, role: roleOf(el), name: nameOf(el) };
    if (el.tagName === 'SELECT') {
      const options = [...el.options].filter(o => !o.disabled);
      one.value = [...el.selectedOptions].map(label).join(', ');
      one.options = options.slice(0, OPTIONS).map(label);
      if (options.length > OPTIONS) one.options.push('…');
    } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) one.checked = el.checked === true;
    else if (el.getAttribute('aria-checked')) one.checked = el.getAttribute('aria-checked') === 'true';
    else if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !UNREAD.includes(el.type)) {
      const value = String(el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      if (value && value !== one.name) one.value = value;
    }
    elements.push(one);
  }
  const all = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { url: location.href, title: document.title, elements, text: all.slice(0, TEXT), truncated: all.length > TEXT || elements.length >= MAX };
})()`
}

// Runs in the page: the element of a ref scrolled into view and the point to press, or why not.
// The element was shown and enabled when read, but the page may have changed since: a press
// on a hidden element would land on whatever sits at the page's top left corner instead.
export function pointScript(ref: string): string {
  return `(() => {
  const el = document.querySelector('[data-sb-ref="' + ${JSON.stringify(ref)} + '"]');
  if (!el) return { error: 'stale' };
  if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return { error: 'disabled' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  if (r.width < 1 || r.height < 1 || s.visibility === 'hidden') return { error: 'hidden' };
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { error: 'outside' };
  const top = document.elementFromPoint(x, y);
  if (!top) return { error: 'outside' };
  if (top !== el && !el.contains(top) && !top.contains(el)) {
    const what = (top.getAttribute('aria-label') || top.innerText || top.tagName).replace(/\\s+/g, ' ').trim().slice(0, 60);
    return { error: 'covered', by: top.tagName.toLowerCase() + ' "' + what + '"' };
  }
  // The press may reach a file field, directly or through the page's own script. The system's
  // file dialog would open over the person's work and hold the whole app until they close it,
  // so for a moment such an ask is turned down and noted (fileAskedScript).
  const files = window.__sbFiles || (window.__sbFiles = { until: 0, asked: false });
  if (!files.bound) {
    files.bound = true;
    addEventListener('click', event => {
      const target = (event.composedPath && event.composedPath()[0]) || event.target;
      if (Date.now() >= files.until || !target || target.tagName !== 'INPUT' || target.type !== 'file') return;
      event.preventDefault();
      files.asked = true;
    }, true);
  }
  files.until = Date.now() + ${FILE_GUARD_MS};
  files.asked = false;
  return { x, y };
})()`
}

// Runs in the page after a press: whether the page asked for a file since pointScript. Asking
// again is allowed from here on, so the person's own presses open the dialog as ever.
export function fileAskedScript(): string {
  return `(() => {
  const files = window.__sbFiles;
  if (!files) return false;
  const asked = files.asked === true;
  files.until = 0;
  files.asked = false;
  return asked;
})()`
}

// Fields that take no typed text: their value is set whole, in the form the field keeps it.
const SET_FORMATS: Record<string, string> = {
  date: 'YYYY-MM-DD',
  time: 'HH:MM',
  'datetime-local': 'YYYY-MM-DDTHH:MM',
  month: 'YYYY-MM',
  week: 'YYYY-Www',
  color: '#rrggbb',
  range: 'a number within its range',
}
// Inputs that hold no text at all.
const NO_TEXT = ['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image']

// Runs in the page: puts the text into the element of a ref where typing cannot, or readies it for
// typing. A select takes the option of that name (or value); a date, time, color or slider field
// takes its value whole. Both answer { done: true } and tell the page as a person's change would.
// Typed into, a select lost its choice and a date field its date, and the session read that as
// done. Any other field is focused with what it holds selected ({ ok: true }), so typing replaces
// it. A disabled or read-only field takes no typing, so that is refused rather than reported done.
export function fillScript(ref: string, text: string): string {
  return `(() => {
  const el = document.querySelector('[data-sb-ref="' + ${JSON.stringify(ref)} + '"]');
  if (!el) return { error: 'stale' };
  if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return { error: 'disabled' };
  if (el.readOnly === true || el.getAttribute('aria-readonly') === 'true') return { error: 'readonly' };
  const text = ${JSON.stringify(text)}, FORMATS = ${JSON.stringify(SET_FORMATS)}, NO_TEXT = ${JSON.stringify(NO_TEXT)};
  const type = el.tagName === 'INPUT' ? el.type : '';
  if (NO_TEXT.includes(type)) return { error: 'notext', type };
  el.scrollIntoView({ block: 'center' });
  el.focus();
  const changed = () => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { done: true };
  };
  if (el.tagName === 'SELECT') {
    const tidy = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const label = o => tidy(o.label || o.text);
    const want = tidy(text), options = [...el.options].filter(o => !o.disabled);
    // By its name, its value, its name in another case, or its name as a reading cut it short.
    const option = options.find(o => label(o) === want) || options.find(o => o.value === text || o.value === want)
      || options.find(o => label(o).toLowerCase() === want.toLowerCase()) || options.find(o => want !== '' && label(o).slice(0, 60).trim() === want);
    if (!option) return { error: 'option', options: options.slice(0, ${OPTIONS_MAX}).map(label) };
    option.selected = true;
    return changed();
  }
  if (FORMATS[type]) {
    const before = el.value, want = text.trim();
    el.value = want;
    // A value the field cannot hold is dropped or bent by the browser (an unknown date, a number past the slider's end).
    if (type === 'range' ? want === '' || Number(el.value) !== Number(want) : el.value.toLowerCase() !== want.toLowerCase()) {
      el.value = before;
      return { error: 'value', type, format: FORMATS[type] };
    }
    return changed();
  }
  if (typeof el.select === 'function') el.select();
  else if (el.isContentEditable) document.execCommand('selectAll');
  return { ok: true };
})()`
}

// Why a press or typing on a ref was refused, for the session. Null when it can go ahead.
export function refusal(result: { error?: string; by?: string; type?: string; format?: string; options?: string[] } | undefined): string | null {
  if (!result || result.error === 'stale') return 'that element is gone; call browser_snapshot again'
  if (!result.error) return null
  if (result.error === 'covered') return `the element is covered by ${result.by}`
  if (result.error === 'option') return `the select has no such option; its options are: ${(result.options ?? []).map(o => `"${o}"`).join(', ')}`
  if (result.error === 'value') return `a ${result.type} field takes ${result.format}`
  if (result.error === 'notext') return result.type === 'file' ? 'a session cannot choose a file; ask the person to choose it in the browser' : `a ${result.type} takes no text; press it with browser_click`
  if (result.error === 'disabled') return 'the element is disabled now; call browser_snapshot again'
  if (result.error === 'readonly') return 'the field is read-only'
  if (result.error === 'hidden') return 'the element is hidden now; call browser_snapshot again'
  if (result.error === 'outside') return 'the element cannot be scrolled into view'
  return result.error
}

// What a form control holds, after its name: = "value", a select's options, (checked).
function elementState(e: Snapshot['elements'][number]): string {
  if (e.options) return ` = "${e.value ?? ''}" (options: ${e.options.map(o => (o === '…' ? o : `"${o}"`)).join(', ')})`
  if (e.checked !== undefined) return e.checked ? ' (checked)' : ' (not checked)'
  return e.value ? ` = "${e.value}"` : ''
}

// What the session reads: the address, the title, one line per element, then the text.
export function snapshotText(s: Snapshot): string {
  return [
    `URL: ${s.url}`,
    `Title: ${s.title}`,
    '',
    'Elements (ref role "name"):',
    ...s.elements.map(e => `[${e.ref}] ${e.role}${e.name ? ` "${e.name}"` : ''}${elementState(e)}`),
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

// The phone page (bridge/mobile.ts serves it). The QR code the app shows opens this page
// with "#pair=<id>.<key>"; the page keeps that pair in this browser and drops it from the
// address. A phone whose home screen app keeps its own storage (iPhone) types the code the
// app shows instead. Every request and answer is sealed with the key (aead.js), so the
// network sees neither. "/events" only says that something changed; the page then reads
// the view again.

import { fromB64, fromUtf8, open, seal, toB64, utf8 } from './aead.js'

const STORE = 'switchboard-phone'
const app = document.getElementById('app')

let words = {}
let pairing = null
let offset = 0
let view = null
let tab = 'decisions'
let state = 'loading' // loading | unpaired | revoked | weak | offline | ready
let noticeTimer = 0
let armed = null
let armTimer = 0
let target = ''
let renderLater = false
// Notifications (sw.js, bridge/push.ts): only over HTTPS, the Tailscale address.
let worker = null
let pushOn = false
let waitingCount = null
const picks = new Map()
const memos = new Map()
const drafts = new Map()

// Until the words arrive (the computer may be out of reach), the few the first screens need.
const FALLBACK = {
  notPaired: 'Scan the QR code in Switchboard on your computer (Settings > Phone access).',
  homeNeedsHttps: 'A home screen app on iPhone connects only through the Tailscale HTTPS address. On the same Wi-Fi, open the QR link in Safari and use it there.',
  revoked: 'This phone was disconnected. Show a new QR code in the app to connect again.',
  offline: 'Cannot reach the computer. Check that it is on and on the same network.',
  pairAgain: 'This phone was connected through an address without HTTPS (Wi-Fi or a Tailscale IP), or before an update, so it is not heard through this address and cannot allow permission asks, write to sessions or add a memo. Show a new QR code for the Tailscale HTTPS address in the app and scan it.',
  linkOn: 'Connected to the computer',
  linkOff: 'Cannot reach the computer',
  linkWait: 'Checking the connection',
}
const TABS = ['decisions', 'approvals', 'tasks', 'sessions']
const say = (key, vars = {}) => String(words[`mobile.page.${key}`] ?? FALLBACK[key] ?? '').replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))

// Over the Tailscale HTTPS address the page cannot have been swapped on the way, and only then may
// it allow a permission ask, write to a session or add a memo (bridge/mobile.ts). A Tailscale IP
// address is plain HTTP: with the phone's Tailscale off, the network it is on can answer for it.
const strong = () => isSecureContext && location.protocol === 'https:'
// The phone must also have been paired through that address: a key that went out in a link to
// a plain HTTP address may have been read on the way, so the bridge refuses it all three (pairedStrong).
const mayStrong = () => strong() && view?.pairedStrong !== false
const strongWhy = () => say(strong() ? 'pairAgain' : 'needStrong')
// The longest memo or message: the bridge refuses a request much larger (bridge/mobile.ts API_MAX).
const TEXT_MAX = 4000

// el('div', { className, onclick, ... }, ...children): strings become text, never markup.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value)
    else if (name in node) node[name] = value
    else node.setAttribute(name, String(value))
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child))
  return node
}

// The pair in the address is tried before it replaces the one kept: a link someone else made
// cannot unpair this phone.
function readPairing() {
  let kept = null
  try {
    kept = JSON.parse(localStorage.getItem(STORE) ?? 'null')
  } catch {
    kept = null
  }
  const fragment = new URLSearchParams(location.hash.slice(1)).get('pair')
  if (fragment) history.replaceState(null, '', location.pathname)
  const [id, key] = (fragment ?? '').split('.')
  return { kept, candidate: fragment && key ? { id: Number(id), key } : null }
}

function keep(pair) {
  pairing = pair
  try {
    localStorage.setItem(STORE, JSON.stringify(pair))
  } catch {
    // A browser without storage keeps the pair for this visit only.
  }
}

// Forgets the pair kept in this browser only when it is the one the computer refused.
function forget() {
  try {
    const kept = JSON.parse(localStorage.getItem(STORE) ?? 'null')
    if (kept && pairing && kept.id === pairing.id && kept.key === pairing.key) localStorage.removeItem(STORE)
  } catch {
    // Nothing kept.
  }
  pairing = null
}

async function api(method, path, body, retried = false) {
  const key = fromB64(pairing.key)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const n = toB64(nonce)
  const plain = utf8(JSON.stringify({ t: Date.now() + offset, method, path, body }))
  const c = toB64(seal(key, nonce, plain, utf8(`sb1:req:${pairing.id}`)))
  const res = await fetch('api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ d: pairing.id, n, c }) })
  if (res.status === 401) {
    const error = new Error('revoked')
    error.revoked = true
    throw error
  }
  if (res.status === 409 && !retried) {
    // The phone's clock is off: take the computer's and try once more.
    offset = (await res.json()).now - Date.now()
    return api(method, path, body, true)
  }
  if (res.status === 429) throw Object.assign(new Error('busy'), { busy: true })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const sealed = await res.json()
  const opened = open(key, fromB64(sealed.n), fromB64(sealed.c), utf8(`sb1:res:${pairing.id}:${n}`))
  if (!opened) throw new Error('bad reply')
  return JSON.parse(fromUtf8(opened))
}

// The notices stay outside the part that is drawn anew, so a screen reader reads each one once:
// a trouble at once (alert), the rest when it is free (status).
const said = el('div', { className: 'notice', role: 'status' })
const alarm = el('div', { className: 'notice bad', role: 'alert' })
document.body.append(said, alarm)

function flash(text, bad = false) {
  ;(bad ? alarm : said).textContent = text
  ;(bad ? said : alarm).textContent = ''
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    said.textContent = ''
    alarm.textContent = ''
  }, 2600)
  render()
}

// What went wrong, in words a person can act on.
function trouble(error) {
  if (error.revoked) return lost()
  if (error.busy) return flash(say('tooMany'), true)
  // fetch rejects with a TypeError when the computer cannot be reached.
  if (error instanceof TypeError) return flash(say('offline'), true)
  flash(say('failed', { error: error.message }), true)
}

async function act(method, path, body, done) {
  try {
    const result = await api(method, path, body)
    if (result.json?.strong) return flash(say(result.json.pairAgain ? 'pairAgain' : 'needStrong'), true)
    if (result.json?.hidden) return flash(say('hiddenChars'), true)
    if (result.status >= 400) return flash(say('failed', { error: result.json?.error ?? result.status }), true)
    if (done) flash(done)
  } catch (error) {
    return trouble(error)
  }
  await refresh()
}

function lost() {
  forget()
  state = 'revoked'
  render()
}

let refreshing = null
// A change that comes while a refresh runs gets one more after it: that one may have read too early.
let again = false
async function refresh() {
  if (!pairing) return
  if (refreshing) {
    again = true
    return refreshing
  }
  refreshing = (async () => {
    if (!words.lang) await loadWords()
    try {
      const result = await api('GET', '/mobile/view')
      // Paired over plain HTTP and opened through the HTTPS address: the bridge does not hear it here.
      if (result.json?.strong) {
        view = null
        state = 'weak'
      } else if (result.status < 400) {
        view = result.json
        state = 'ready'
        // Something new while the page is open: a buzz (where phones allow it) and the count in the title.
        const count = view.questions.length + view.approvals.length
        if (waitingCount !== null && count > waitingCount) navigator.vibrate?.(200)
        waitingCount = count
        document.title = count > 0 ? `(${count}) Switchboard` : 'Switchboard'
      }
    } catch (error) {
      if (error.revoked) return lost()
      state = 'offline'
    } finally {
      refreshing = null
    }
    render(true)
    if (again) {
      again = false
      void refresh()
    }
  })()
  return refreshing
}

async function loadWords() {
  try {
    words = await (await fetch('strings')).json()
    document.documentElement.lang = words.lang ?? 'en'
  } catch {
    // Tried again with the next refresh.
  }
}

// --- drawing ---

const typing = () => ['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName ?? '')

// `soft`: a redraw nobody asked for (new data). It would take the text box from under the
// person's fingers, so it waits until they leave it. A tap redraws at once.
// The page is drawn anew each time: the control the person was on (its data-key) gets the focus
// back, with the caret where it was. One that went (an answered question) leaves it on the tab.
function render(soft = false) {
  if (soft && typing() && state === 'ready') {
    renderLater = true
    return
  }
  renderLater = false
  const was = document.activeElement
  const inside = app.contains(was)
  const key = inside ? was.dataset.key : undefined
  const caret = inside && typeof was.selectionStart === 'number' ? [was.selectionStart, was.selectionEnd] : null
  app.replaceChildren(...draw())
  if (!inside) return
  const back = (key && app.querySelector(`[data-key="${CSS.escape(key)}"]`)) || app.querySelector('[role="tab"][aria-selected="true"]')
  back?.focus({ preventScroll: true })
  if (caret && back?.setSelectionRange) back.setSelectionRange(caret[0], caret[1])
}

// The tabs as a screen reader and a keyboard expect them: the arrows, Home and End move between them.
function tabKeys(event) {
  const at = TABS.indexOf(tab)
  const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: TABS.length - 1 }[event.key]
  if (next === undefined) return
  event.preventDefault()
  tab = TABS[(next + TABS.length) % TABS.length]
  render()
  app.querySelector(`[data-key="tab:${tab}"]`)?.focus()
}

function draw() {
  if (state === 'unpaired' || state === 'revoked' || state === 'weak') {
    return [
      el(
        'div',
        { className: 'welcome' },
        el('img', { src: 'icon.png', alt: '' }),
        el('h1', {}, 'Switchboard'),
        el('p', {}, state === 'weak' ? strongWhy() : say(state === 'revoked' ? 'revoked' : 'notPaired')),
        strong() ? drawCode() : standalone() ? el('p', { className: 'small' }, say('homeNeedsHttps')) : null,
      ),
    ]
  }
  // Counts once the view is in; until then a dash, not a zero that reads as "nothing waits".
  const counts = view
    ? { decisions: view.questions.length, approvals: view.approvals.length, tasks: view.tasks.filter(t => t.running).length, sessions: view.sessions.filter(s => s.live).length }
    : { decisions: '-', approvals: '-', tasks: '-', sessions: '-' }
  // The dot says in words too what its colour says.
  const link = say(state === 'ready' ? 'linkOn' : state === 'offline' ? 'linkOff' : 'linkWait')
  const top = el(
    'header',
    { className: 'top' },
    el(
      'div',
      { className: 'brand' },
      el('img', { src: 'icon.png', alt: '' }),
      el('h1', {}, 'Switchboard'),
      el('span', { className: `dot ${state === 'ready' ? 'on' : state === 'offline' ? 'off' : ''}`, role: 'img', 'aria-label': link, title: link }),
    ),
    el(
      'div',
      { className: 'tabs', role: 'tablist', onkeydown: tabKeys },
      TABS.map(name =>
        el(
          'button',
          {
            className: tab === name ? 'on' : '',
            id: `tab-${name}`,
            role: 'tab',
            'aria-selected': String(tab === name),
            'aria-controls': 'panel',
            tabIndex: tab === name ? 0 : -1,
            'data-key': `tab:${name}`,
            onclick: () => ((tab = name), render()),
          },
          say(name),
          el('span', { className: `count ${counts[name] && counts[name] !== '-' ? '' : 'zero'}` }, String(counts[name])),
        ),
      ),
    ),
  )
  const parts = [top]
  if (state === 'offline') parts.push(el('div', { className: 'banner', role: 'status' }, say('offline')))
  const main = el('main', { id: 'panel', role: 'tabpanel', 'aria-labelledby': `tab-${tab}` })
  if (view) {
    const body = { decisions: drawDecisions, approvals: drawApprovals, tasks: drawTasks, sessions: drawSessions }[tab]()
    main.append(...body)
    main.append(
      el(
        'footer',
        {},
        drawNotify(),
        say('refreshed', { time: new Date(view.now).toLocaleTimeString(view.lang, { hour: '2-digit', minute: '2-digit' }) }),
        homeHint() ? el('br') : null,
        homeHint() ? say('homeHint') : null,
      ),
    )
  }
  parts.push(main)
  return parts
}

const empty = key => [el('div', { className: 'empty' }, say(key))]

const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
// An iPhone home screen app keeps storage of its own and pairs with a code, which only HTTPS hands out.
const homeHint = () => !standalone() && (strong() || !ios())

// The code the app shows next to the QR code, for a home screen app that cannot open the QR link itself.
let codeDraft = ''
function drawCode() {
  return el(
    'div',
    { className: 'code' },
    el('label', { className: 'small', htmlFor: 'code' }, say('codeHint')),
    el('input', { className: 'code-input', id: 'code', 'data-key': 'code', placeholder: 'ABCD-EFGH', value: codeDraft, autocapitalize: 'characters', autocomplete: 'off', oninput: e => (codeDraft = e.target.value) }),
    el(
      'button',
      {
        className: 'btn primary',
        'data-key': 'connect',
        onclick: async () => {
          try {
            const res = await fetch('claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: codeDraft }) })
            if (!res.ok) return flash(say(res.status === 429 ? 'tooMany' : 'codeWrong'), true)
            keep(await res.json())
            codeDraft = ''
            location.reload()
          } catch (error) {
            trouble(error)
          }
        },
      },
      say('connect'),
    ),
  )
}
const apple = () => /iPhone|iPad|iPod/.test(navigator.userAgent)

function drawNotify() {
  if (worker && 'PushManager' in window) {
    return el('div', { className: 'notify' }, el('button', { className: 'btn', 'data-key': 'notify', onclick: () => void (pushOn ? notifyOff() : notifyOn()) }, say(pushOn ? 'notifyOff' : 'notifyOn')))
  }
  if (isSecureContext && apple() && !standalone()) return el('p', { className: 'notify' }, say('notifyIos'))
  if (!isSecureContext) return el('p', { className: 'notify' }, say('notifyHttps'))
  return null
}

async function notifyOn() {
  try {
    if ((await Notification.requestPermission()) !== 'granted') return flash(say('notifyDenied'), true)
    const key = (await api('GET', '/push-key')).json.key
    const subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64(key) })
    const result = await api('POST', '/push', { subscription: subscription.toJSON() })
    if (result.status >= 400) return flash(say('failed', { error: result.json?.error ?? result.status }), true)
    pushOn = true
    flash(say('notifyOnDone'))
  } catch (error) {
    trouble(error)
  }
}

async function notifyOff() {
  try {
    await (await worker.pushManager.getSubscription())?.unsubscribe()
    await api('POST', '/push', { subscription: null })
    pushOn = false
    flash(say('notifyOffDone'))
  } catch (error) {
    trouble(error)
  }
}

function where(item) {
  return el('div', { className: 'meta' }, el('span', { className: 'chip accent' }, item.project), item.task ? el('span', {}, item.task) : null)
}

function drawDecisions() {
  if (view.questions.length === 0) return empty('noDecisions')
  return view.questions.map(q => {
    const picked = picks.get(q.id) ?? ''
    const memo = memos.get(q.id) ?? ''
    return el(
      'section',
      { className: 'card' },
      where(q),
      el('p', { className: 'title' }, q.question),
      q.body ? el('p', { className: 'body' }, q.body) : null,
      q.recommend ? el('p', { className: 'small' }, say('recommend', { key: q.recommend })) : null,
      q.reason ? el('p', { className: 'small' }, say('reason', { reason: q.reason })) : null,
      q.options.length > 0
        ? el(
            'div',
            { className: 'options' },
            q.options.map(o =>
              el(
                'button',
                {
                  className: `option ${o.key === q.recommend ? 'rec' : ''} ${o.key === picked ? 'picked' : ''}`,
                  'aria-pressed': String(o.key === picked),
                  'data-key': `option:${q.id}:${o.key}`,
                  onclick: () => (picks.set(q.id, o.key === picked ? '' : o.key), render()),
                },
                el('span', { className: 'key' }, o.key),
                el('span', {}, o.label),
              ),
            ),
          )
        : null,
      // A memo goes into the session's prompt, as a message would: the same address only.
      mayStrong()
        ? [
            el('label', { className: 'field', htmlFor: `memo-${q.id}` }, say('memo')),
            el('textarea', { id: `memo-${q.id}`, 'data-key': `memo:${q.id}`, value: memo, maxLength: TEXT_MAX, oninput: e => memos.set(q.id, e.target.value), onblur: () => renderLater && setTimeout(render) }),
          ]
        : el('p', { className: 'small' }, strongWhy()),
      el(
        'div',
        { className: 'actions' },
        el(
          'button',
          {
            className: 'btn primary',
            'data-key': `send:${q.id}`,
            onclick: () => {
              const choice = picks.get(q.id) ?? ''
              const text = mayStrong() ? (memos.get(q.id) ?? '').trim() : ''
              if (!choice && !text) return flash(say('needChoice'), true)
              picks.delete(q.id)
              memos.delete(q.id)
              void act('POST', `/questions/${q.id}/answer`, { choice, memo: text }, say('answered'))
            },
          },
          say('send'),
        ),
        q.held ? el('span', { className: 'chip warn' }, say('held')) : el('button', { className: 'btn', 'data-key': `hold:${q.id}`, onclick: () => void act('POST', `/questions/${q.id}/hold`, {}) }, say('hold')),
      ),
    )
  })
}

function drawApprovals() {
  if (view.approvals.length === 0) return empty('noApprovals')
  return view.approvals.map(a => {
    // Allowing runs the command: the first tap only arms the button for five seconds. A command
    // with characters that hide or reorder text (shown by the bridge as [U+...]) is allowed
    // in the app or the terminal only.
    const allow = a.hidden
      ? null
      : el(
          'button',
          {
            className: `btn ${armed === a.id ? 'armed' : 'allow'}`,
            'data-key': `allow:${a.id}`,
            onclick: () => {
              if (!mayStrong()) return flash(strongWhy(), true)
              if (armed !== a.id) {
                armed = a.id
                clearTimeout(armTimer)
                armTimer = setTimeout(() => ((armed = null), render(true)), 5000)
                return render()
              }
              armed = null
              void act('POST', `/approvals/${a.id}/answer`, { decision: 'allow' })
            },
          },
          armed === a.id ? say('allowAgain') : say('allow'),
        )
    return el(
      'section',
      { className: 'card' },
      el('div', { className: 'meta' }, el('span', { className: 'chip accent' }, a.project), el('span', { className: 'chip' }, a.tool)),
      el('pre', {}, a.summary),
      a.hidden ? el('p', { className: 'small warn' }, say('hiddenChars')) : null,
      a.reason ? el('p', { className: 'small' }, say('reason', { reason: a.reason })) : null,
      a.cwd ? el('p', { className: 'small' }, a.cwd) : null,
      el('div', { className: 'actions' }, allow, el('button', { className: 'btn deny', 'data-key': `deny:${a.id}`, onclick: () => void act('POST', `/approvals/${a.id}/answer`, { decision: 'deny' }) }, say('deny'))),
      el('div', { className: 'actions' }, el('button', { className: 'btn', 'data-key': `terminal:${a.id}`, onclick: () => void act('POST', `/approvals/${a.id}/answer`, { decision: 'terminal' }) }, say('terminal'))),
      el('p', { className: 'small' }, mayStrong() ? say('terminalHint') : strong() ? say('pairAgain') : say('allowNeedsStrong')),
    )
  })
}

function drawTasks() {
  if (view.tasks.length === 0) return empty('noTasks')
  return view.tasks.map(t =>
    el(
      'section',
      { className: 'card' },
      el(
        'div',
        { className: 'meta' },
        el('span', { className: 'chip accent' }, t.project),
        el('span', { className: `chip ${t.running ? 'good' : ''}` }, t.status),
        el('span', { className: 'chip' }, t.stage),
        el('span', { className: `dot ${t.live ? 'on' : ''}`, role: 'img', 'aria-label': say(t.live ? 'live' : 'notLive'), title: say(t.live ? 'live' : 'notLive') }),
      ),
      el('p', { className: 'title' }, t.title),
      t.now ? el('p', { className: 'small' }, t.now) : null,
    ),
  )
}

function drawSessions() {
  if (view.sessions.length === 0) return empty('noSessions')
  const rows = view.sessions.map(s => {
    const row = el(
      'button',
      { className: 'row', 'aria-expanded': String(target === s.id), 'data-key': `session:${s.id}`, onclick: () => ((target = target === s.id ? '' : s.id), render()) },
      // The chip at the end says it in words.
      el('span', { className: `dot ${s.live ? 'on' : ''}`, 'aria-hidden': 'true' }),
      el('span', { className: 'grow' }, el('div', { className: 'name' }, s.label), el('div', { className: 'small' }, s.cwd)),
      el('span', { className: 'chip' }, s.live ? say('live') : say('notLive')),
    )
    if (target !== s.id) return [row]
    if (!mayStrong()) return [row, el('div', { className: 'composer' }, el('p', { className: 'small' }, strongWhy()))]
    const composer = el(
      'div',
      { className: 'composer' },
      el('label', { className: 'field', htmlFor: `message-${s.id}` }, say('message')),
      el('textarea', { id: `message-${s.id}`, 'data-key': `message:${s.id}`, value: drafts.get(s.id) ?? '', maxLength: TEXT_MAX, oninput: e => drafts.set(s.id, e.target.value), onblur: () => renderLater && setTimeout(render) }),
      el(
        'div',
        { className: 'actions' },
        el(
          'button',
          {
            className: 'btn primary',
            'data-key': `post:${s.id}`,
            onclick: () => {
              const text = (drafts.get(s.id) ?? '').trim()
              if (!text) return
              drafts.delete(s.id)
              void act('POST', '/outbox', { sessionId: s.id, text }, say('messageSent'))
            },
          },
          say('send'),
        ),
      ),
    )
    return [row, composer]
  })
  return [el('section', { className: 'card list' }, rows.flat())]
}

// --- start ---

// A new QR code opened over this page only changes the fragment: start again with its pair.
addEventListener('hashchange', () => {
  if (location.hash.includes('pair=')) return location.reload()
  openTab(new URLSearchParams(location.hash.slice(1)).get('tab'))
})

// A tapped notification names the tab to show.
function openTab(name) {
  if (!TABS.includes(name)) return
  tab = name
  history.replaceState(null, '', location.pathname)
  render()
}

// The live stream's link carries a sealed time, used once: each (re)connection makes a new one.
function eventsLink() {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const c = toB64(seal(fromB64(pairing.key), nonce, utf8(JSON.stringify({ t: Date.now() + offset })), utf8(`sb1:ev:${pairing.id}`)))
  return `events?d=${encodeURIComponent(pairing.id)}&n=${toB64(nonce)}&c=${c}`
}

function listen() {
  if (!pairing || state === 'weak') return
  const events = new EventSource(eventsLink())
  let soon = 0
  events.addEventListener('changed', () => {
    clearTimeout(soon)
    soon = setTimeout(() => void refresh(), 250)
  })
  events.addEventListener('error', () => {
    if (state === 'ready') void refresh()
    // The browser gives up on a link the bridge refused: open a new one in a moment.
    if (events.readyState === EventSource.CLOSED) setTimeout(listen, 3000)
  })
}

async function tryPair(pair) {
  pairing = pair
  state = 'loading'
  await refresh()
  return state === 'ready'
}

async function start() {
  await loadWords()
  const { kept, candidate } = readPairing()
  openTab(new URLSearchParams(location.hash.slice(1)).get('tab'))
  if (candidate && ((await tryPair(candidate)) || (!kept && state === 'offline'))) keep(candidate)
  else if (kept) await tryPair(kept)
  if (!pairing) {
    if (state !== 'revoked') state = 'unpaired'
    return render()
  }
  if (isSecureContext && 'serviceWorker' in navigator) {
    try {
      worker = await navigator.serviceWorker.register('sw.js')
      pushOn = Boolean(await worker.pushManager?.getSubscription())
      navigator.serviceWorker.addEventListener('message', event => openTab(event.data?.tab))
    } catch {
      worker = null
    }
  }
  render()
  listen()
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void refresh())
  setInterval(() => document.visibilityState === 'visible' && void refresh(), 20_000)
}

void start()

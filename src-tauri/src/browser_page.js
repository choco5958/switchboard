// Put into every page of the in-app browser before its own scripts (src/browser.rs), in the
// page's world: what the browser screen keeps of a page (src/shared/pageLog.ts) and what it
// follows (title, in-page navigation). The shell collects the queue a few times a second.
(() => {
  if (window.__sbDrain || window.top !== window) return
  const queue = []
  const push = entry => {
    if (queue.length < 500) queue.push(entry)
  }
  const text = value => {
    try {
      if (typeof value === 'string') return value
      if (value instanceof Error) return value.stack || value.message
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  // Electron's levels, which the screen reads (pageLog.ts consoleLevel).
  const levels = { debug: 0, log: 1, info: 1, warn: 2, error: 3 }
  for (const name of Object.keys(levels)) {
    const original = console[name]
    console[name] = function (...args) {
      push({ kind: 'console', level: levels[name], message: args.map(text).join(' ') })
      return original.apply(this, args)
    }
  }
  addEventListener(
    'error',
    event => {
      const target = event.target
      if (target && target !== window && (target.src || target.href)) push({ kind: 'net', method: 'GET', url: target.src || target.href, error: 'net::ERR_FAILED' })
      else push({ kind: 'console', level: 3, message: event.message, source: event.filename, line: event.lineno })
    },
    true,
  )
  addEventListener('unhandledrejection', event => push({ kind: 'console', level: 3, message: `Uncaught (in promise) ${text(event.reason)}` }))
  const where = input => {
    try {
      return new URL(typeof input === 'string' ? input : input.url, location.href).href
    } catch {
      return String(input)
    }
  }
  const originalFetch = window.fetch
  if (originalFetch) {
    window.fetch = function (input, init) {
      const method = (init && init.method) || (input && input.method) || 'GET'
      const url = where(input)
      return originalFetch.apply(this, arguments).then(
        reply => {
          if (reply.status >= 400) push({ kind: 'net', method, url, statusCode: reply.status })
          return reply
        },
        error => {
          push({ kind: 'net', method, url, error: 'net::ERR_FAILED' })
          throw error
        },
      )
    }
  }
  const open = XMLHttpRequest.prototype.open
  const send = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__sb = { method, url: where(url) }
    return open.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('loadend', () => {
      const request = this.__sb
      if (!request) return
      if (this.status === 0) push({ kind: 'net', ...request, error: 'net::ERR_FAILED' })
      else if (this.status >= 400) push({ kind: 'net', ...request, statusCode: this.status })
    })
    return send.apply(this, arguments)
  }
  // The page's alert(), confirm() and prompt() while a session presses or types in it
  // (src/renderer/src/agentBrowser.ts): the dialog would open over the person's work and hold the
  // page until they answer it. For that moment no dialog opens: the page gets the answer the
  // session chose (dismissed, unless it said to accept), and what it asked is kept for the session.
  let quietUntil = 0
  let accepting = false
  const asked = []
  for (const kind of ['alert', 'confirm', 'prompt']) {
    const original = window[kind]
    if (typeof original !== 'function') continue
    window[kind] = function (message, text) {
      if (Date.now() >= quietUntil) return original.apply(window, arguments)
      if (asked.length < 20) asked.push({ kind, message: String(message === undefined ? '' : message).slice(0, 300) })
      if (kind === 'confirm') return accepting
      if (kind === 'prompt') return accepting ? String(text === undefined ? '' : text) : null
    }
  }
  // For `ms` from now the page's dialogs are answered here, accepted when `accept`; 0 ends it.
  // Answers with what the page asked since the last call.
  window.__sbQuiet = (ms, accept) => {
    quietUntil = ms > 0 ? Date.now() + ms : 0
    accepting = accept === true
    return asked.splice(0)
  }
  let lastUrl = location.href
  let lastTitle = ''
  window.__sbDrain = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      push({ kind: 'navigate', url: lastUrl, inPage: true })
    }
    if (document.title !== lastTitle) {
      lastTitle = document.title
      push({ kind: 'title', title: lastTitle })
    }
    return queue.splice(0)
  }
})()

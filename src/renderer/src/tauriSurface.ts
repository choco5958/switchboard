// The in-app browser's page in the Tauri shell (docs/tauri-이전.md, step 6): a child webview
// the shell keeps over the spot PageView.tsx leaves for it (src-tauri/src/browser.rs).
//
// Unlike Electron's <webview> it gives no trusted input events: a click and typing are DOM
// events made in the app's own world, which pages see as untrusted (event.isTrusted false).
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { netEntry } from '../../shared/pageLog'
import type { PageSurface, SurfaceEvents } from './pageSurface'

type ShellEvent = {
  kind: 'startNavigation' | 'startLoading' | 'loaded' | 'navigate' | 'title' | 'console' | 'net'
  url?: string
  inPage?: boolean
  title?: string
  level?: number
  message?: string
  source?: string
  line?: number
  method?: string
  statusCode?: number
  error?: string
  world?: string
}

// What the page's world sees of console.log in the app's world: kept for the shell to collect,
// as Electron reports a world's console messages (picker.ts sends its messages that way).
const APP_WORLD = `if (!window.__sbOut) { window.__sbOut = []; console.log = (...args) => { window.__sbOut.push(args.map(String).join(' ')) } }`

const js = (value: unknown) => JSON.stringify(value)

export function tauriSurface(initialUrl: string): PageSurface {
  let current = initialUrl
  const run = (code: string) => invoke('browser_run', { code: `${APP_WORLD};${code}` })
  const fail = (handlers: Set<Partial<SurfaceEvents>>, url: string, code: string) => {
    for (const one of handlers) one.fail?.({ errorCode: -102, errorDescription: code, validatedURL: url, isMainFrame: true })
  }
  const handlers = new Set<Partial<SurfaceEvents>>()
  void listen<ShellEvent>('browser:event', ({ payload: event }) => {
    // The blank page the webview starts on (PageView.tsx) is not the person's page.
    if (event.url === 'about:blank') return
    if (event.world !== 'app' && (event.kind === 'loaded' || (event.kind === 'navigate' && event.url))) current = event.url ?? current
    for (const one of handlers) {
      switch (event.kind) {
        case 'startNavigation':
          one.startNavigation?.({ url: event.url ?? '', isMainFrame: true, isInPlace: false })
          break
        case 'startLoading':
          one.startLoading?.()
          break
        case 'loaded':
          one.navigate?.({ url: event.url ?? current, isMainFrame: true })
          one.ready?.()
          one.stopLoading?.()
          break
        case 'navigate':
          one.navigate?.({ url: event.url ?? current, isMainFrame: true })
          break
        case 'title':
          one.title?.(event.title ?? '')
          break
        case 'console':
          one.console?.({ message: event.message ?? '', level: event.level ?? 1, sourceId: event.source, line: event.line })
          break
        case 'net': {
          const entry = netEntry(Date.now(), { method: event.method ?? 'GET', url: event.url ?? '', statusCode: event.statusCode, error: event.error })
          if (entry) one.net?.(entry)
          break
        }
      }
    }
  })
  return {
    url: () => current,
    load: async url => {
      // WebKit does not say a connection was refused: asked first, as Electron's error page needs.
      const refused = await invoke<string | null>('browser_probe', { url }).catch(() => null)
      if (refused) return fail(handlers, url, refused)
      await invoke('browser_load', { url }).catch(() => undefined)
    },
    back: () => void run('history.back()'),
    forward: () => void run('history.forward()'),
    reload: () => void invoke('browser_reload', { ignoreCache: false }),
    reloadIgnoringCache: () => void invoke('browser_reload', { ignoreCache: true }),
    run,
    capture: rect => invoke<string | null>('browser_capture', { rect: rect ? [rect.x, rect.y, rect.width, rect.height] : null }),
    click: (x, y) =>
      void run(`(() => {
        const target = document.elementFromPoint(${js(x)}, ${js(y)})
        if (!target) return
        const at = { bubbles: true, cancelable: true, composed: true, clientX: ${js(x)}, clientY: ${js(y)}, button: 0 }
        target.dispatchEvent(new PointerEvent('pointerdown', at))
        target.dispatchEvent(new MouseEvent('mousedown', at))
        if (target.focus) target.focus()
        target.dispatchEvent(new PointerEvent('pointerup', at))
        target.dispatchEvent(new MouseEvent('mouseup', at))
        target.click()
      })()`),
    insertText: async text => {
      await run(`(() => {
        const field = document.activeElement
        if (!field) return
        if (!document.execCommand('insertText', false, ${js(text)}) && 'value' in field) {
          field.value += ${js(text)}
          field.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${js(text)}, inputType: 'insertText' }))
        }
      })()`)
    },
    pressEnter: () =>
      void run(`(() => {
        const field = document.activeElement || document.body
        const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
        const go = field.dispatchEvent(new KeyboardEvent('keydown', key))
        field.dispatchEvent(new KeyboardEvent('keypress', key))
        field.dispatchEvent(new KeyboardEvent('keyup', key))
        if (go && field.form) field.form.requestSubmit ? field.form.requestSubmit() : field.form.submit()
      })()`),
    on: one => {
      handlers.add(one)
      return () => void handlers.delete(one)
    },
  }
}

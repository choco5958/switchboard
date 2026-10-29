import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebPreferences } from 'electron'

// Checks that keep foreign pages away from window.ide: only the app's own page
// may navigate the main window or call the main process, and bridge:call only
// reaches the routes it is meant for.

function bare(url: string): URL | null {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    parsed.search = ''
    return parsed
  } catch {
    return null
  }
}

// The app's page: the dev server's origin in development, the bundled index.html otherwise.
export function isAppUrl(url: string | undefined | null, appUrl: string): boolean {
  if (!url) return false
  const page = bare(url)
  const app = bare(appUrl)
  if (!page || !app) return false
  if (app.protocol === 'file:') return page.protocol === 'file:' && page.host === app.host && page.pathname === app.pathname
  return page.origin === app.origin
}

export function isExternalUrl(url: string): boolean {
  const parsed = bare(url)
  return parsed?.protocol === 'http:' || parsed?.protocol === 'https:'
}

// Plain bridge calls from screens that only read or write rows (archive, settings, command results, scheduled prompts).
const BRIDGE_ROUTES = /^\/(tasks|settings|commands|routines|telegram)(\/|$)/

const DEBUG_ROUTES = /^\/(comments|dev\/open|sessions\/live|browser\/result)(\/|$)/

export function bridgePathAllowed(path: unknown, routes: RegExp = BRIDGE_ROUTES): path is string {
  if (typeof path !== 'string' || !path.startsWith('/')) return false
  const route = path.split('?')[0] ?? ''
  // No way to climb out of an allowed route: dot segments, encoded dots or slashes, backslashes.
  if (route.includes('..') || route.includes('\\') || /%(2e|2f|5c)/i.test(route) || route.includes('//')) return false
  return routes.test(route)
}

// The debugging page's own calls: screen comments, open_in_ide requests, live sessions.
export function debugPathAllowed(path: unknown): path is string {
  return bridgePathAllowed(path, DEBUG_ROUTES)
}

// A <webview> (the debugging browser) gets no preload and no Node, whatever the page asked for.
export const BROWSER_PARTITION = 'persist:claude-ide'
// The isolated world the browser view's scripts run in (any id above 0, the page's own).
export const BROWSER_WORLD = 1001
// What a page in the app may be granted: copying to the clipboard and going full screen.
export const PAGE_PERMISSIONS = ['clipboard-sanitized-write', 'fullscreen']

// Whatever the page asked for, a webview runs sandboxed, without Node or a preload, in the
// in-app browser's own session.
export function hardenWebview(prefs: WebPreferences, params?: Record<string, string>): void {
  delete prefs.preload
  prefs.nodeIntegration = false
  prefs.nodeIntegrationInSubFrames = false
  prefs.contextIsolation = true
  prefs.sandbox = true
  prefs.webSecurity = true
  prefs.allowRunningInsecureContent = false
  if (params) {
    delete params.preload
    params.partition = BROWSER_PARTITION
  }
}

type AnyEvent = IpcMainEvent | IpcMainInvokeEvent
type Listener = (event: AnyEvent, ...args: unknown[]) => unknown

// ipcMain whose handlers only run for senders the check trusts. An invoke from
// anyone else rejects; a plain message is dropped.
export function guardIpc(ipc: IpcMain, trusted: (event: AnyEvent) => boolean): IpcMain {
  const wrapped = new WeakMap<Listener, Listener>()
  const listen = (channel: string, listener: Listener): Listener => {
    const guarded: Listener = (event, ...args) => {
      if (!trusted(event)) return
      return listener(event, ...args)
    }
    wrapped.set(listener, guarded)
    return guarded
  }
  return new Proxy(ipc, {
    get(target, prop, receiver) {
      if (prop === 'handle' || prop === 'handleOnce') {
        return (channel: string, listener: Listener) =>
          target[prop](channel, (event, ...args) => {
            if (!trusted(event)) throw new Error(`blocked ${channel} from ${event.senderFrame?.url ?? 'unknown'}`)
            return listener(event, ...args)
          })
      }
      if (prop === 'on' || prop === 'once' || prop === 'addListener' || prop === 'prependListener') {
        return (channel: string, listener: Listener) => {
          target[prop](channel, listen(channel, listener))
          return receiver
        }
      }
      if (prop === 'off' || prop === 'removeListener') {
        return (channel: string, listener: Listener) => {
          target[prop](channel, wrapped.get(listener) ?? listener)
          return receiver
        }
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
}

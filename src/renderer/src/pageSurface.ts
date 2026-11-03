// The page the in-app browser shows (BrowserView.tsx), whatever shell draws it: Electron's
// <webview> here, a Tauri child webview in tauriSurface.ts (docs/tauri-이전.md, step 6). The
// browser screen only ever talks to this.
import type { WebviewTag } from 'electron'
import type { PageLogEntry } from '../../shared/pageLog'

export type SurfaceEvents = {
  // A document is ready for scripts (each new document, also an error page).
  ready: () => void
  startNavigation: (event: { url: string; isMainFrame: boolean; isInPlace: boolean }) => void
  // A navigation committed, also within the page (hash, pushState); isMainFrame false for frames.
  navigate: (event: { url: string; isMainFrame?: boolean }) => void
  startLoading: () => void
  stopLoading: () => void
  title: (title: string) => void
  fail: (event: { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }) => void
  // The page's console, and messages of the scripts this app runs in the page (picker.ts).
  console: (event: { message: string; level: unknown; sourceId?: string; line?: number }) => void
  // A request of the page that failed or answered with an error.
  net: (entry: PageLogEntry) => void
}

export type Rect = { x: number; y: number; width: number; height: number }

export type PageSurface = {
  url(): string
  load(url: string): Promise<void>
  back(): void
  forward(): void
  reload(): void
  reloadIgnoringCache(): void
  // A script in a world of the app's own: the page shares the DOM with it but not its functions.
  run(code: string): Promise<unknown>
  // A PNG data URL of the page, or of a part of it.
  capture(rect?: Rect): Promise<string | null>
  click(x: number, y: number): void
  insertText(text: string): Promise<void>
  pressEnter(): void
  on(handlers: Partial<SurfaceEvents>): () => void
}

// Electron's <webview>: scripts run through the main process in the browser's own world
// (index.ts browser:run), failed requests come from its session (index.ts watchBrowserRequests).
export function webviewSurface(wv: WebviewTag): PageSurface {
  return {
    url: () => wv.getURL(),
    load: url => wv.loadURL(url).catch(() => undefined),
    back: () => wv.goBack(),
    forward: () => wv.goForward(),
    reload: () => wv.reload(),
    reloadIgnoringCache: () => wv.reloadIgnoringCache(),
    run: code => window.ideDebug.run(wv.getWebContentsId(), code).catch(() => undefined),
    capture: async rect => {
      const image = await (rect ? wv.capturePage(rect) : wv.capturePage())
      return image.toDataURL()
    },
    click: (x, y) => {
      wv.sendInputEvent({ type: 'mouseMove', x, y })
      wv.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      wv.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    },
    insertText: text => wv.insertText(text),
    pressEnter: () => {
      wv.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      wv.sendInputEvent({ type: 'char', keyCode: '\r' })
      wv.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    },
    on: handlers => {
      const bound: [string, (event: Event) => void][] = []
      const bind = (name: string, listener: (event: Event) => void) => {
        wv.addEventListener(name, listener)
        bound.push([name, listener])
      }
      const as = <T,>(event: Event) => event as unknown as T
      if (handlers.ready) bind('dom-ready', () => handlers.ready!())
      if (handlers.startNavigation) bind('did-start-navigation', e => handlers.startNavigation!(as(e)))
      if (handlers.navigate) {
        bind('did-navigate', e => handlers.navigate!(as(e)))
        bind('did-navigate-in-page', e => handlers.navigate!(as(e)))
      }
      if (handlers.startLoading) bind('did-start-loading', () => handlers.startLoading!())
      if (handlers.stopLoading) bind('did-stop-loading', () => handlers.stopLoading!())
      if (handlers.title) bind('page-title-updated', e => handlers.title!(as<{ title: string }>(e).title))
      if (handlers.fail) bind('did-fail-load', e => handlers.fail!(as(e)))
      if (handlers.console) bind('console-message', e => handlers.console!(as(e)))
      const offNet = handlers.net
        ? window.ideDebug.onNet(({ webContentsId, entry }) => {
            try {
              if (webContentsId === wv.getWebContentsId()) handlers.net!(entry as PageLogEntry)
            } catch {
              // Not attached yet: nothing of its own to report.
            }
          })
        : () => undefined
      return () => {
        offNet()
        for (const [name, listener] of bound) wv.removeEventListener(name, listener)
      }
    },
  }
}

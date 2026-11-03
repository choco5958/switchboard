// The Electron shell: the window, its guard, the in-app browser's webviews, captures, the
// single instance and the updater. The app logic runs in core.ts on the Platform this file
// gives it (platform.ts), the same logic the Tauri host runs (docs/tauri-이전.md).

import { app, BrowserWindow, dialog, ipcMain as rawIpcMain, nativeImage, Notification, powerMonitor, powerSaveBlocker, safeStorage, session, shell, webContents } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BROWSER_PARTITION, BROWSER_WORLD, PAGE_PERMISSIONS, fromMainFrame, guardIpc, hardenWebview, isAppUrl, isExternalUrl } from './guard'
import { terminalStates } from './terminals'
import { registerUpdates, startUpdates } from './updater'
import { netEntry, type PageLogEntry } from '../shared/pageLog'
import { resolveLang, setLang, t } from '../shared/i18n'
import { usePlatform, type Platform } from './platform'
import { loadAppKey } from './appKey'
import { provenBridgePid, registerCore, startCore, watchCore } from './core'

// Captures keep their own profile so they never overwrite the real app's saved tabs and addresses.
if (process.env.CLAUDE_IDE_CAPTURE) app.setPath('userData', `${process.env.CLAUDE_IDE_CAPTURE}.profile`)

// One app at a time: a second start would run its own bridge start, terminals and delivery
// beside the first. It hands over to the running one ('second-instance' below) and quits.
// Captures run beside the installed app on purpose, with a profile of their own: no lock.
const primary = process.env.CLAUDE_IDE_CAPTURE ? true : app.requestSingleInstanceLock()
if (!primary) app.quit()

let win: BrowserWindow | null = null

// The app's own page. Only it may navigate the main window or call the handlers
// below: every ipcMain.handle and ipcMain.on in this process goes through the
// guard, so a page dropped onto the window or opened in a webview gets nothing.
// The main window's top frame is the one sender: its preload is the only one there is.
const APP_URL = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
const ipcMain = guardIpc(rawIpcMain, event => !!win && !win.isDestroyed() && fromMainFrame(event, win.webContents) && isAppUrl(event.senderFrame?.url, APP_URL))

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// Electron drops a notification's click handler once the object is collected, so live ones are held here.
const liveNotifications = new Set<Notification>()

// After the last window closes on macOS the app keeps running; a click then needs a new window, and the
// question id is sent once the page has loaded and its listeners exist.
function focusWindow(afterLoad?: () => void): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    if (afterLoad) win?.webContents.once('did-finish-load', () => setTimeout(afterLoad, 500))
    return
  }
  afterLoad?.()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// The power save blocker held while an agent works, or null.
let awakeBlocker: number | null = null

const electronPlatform: Platform = {
  ipc: ipcMain,
  send,
  isPackaged: app.isPackaged,
  version: () => app.getVersion(),
  locale: () => app.getLocale(),
  appPath: () => app.getAppPath(),
  resourcesPath: () => process.resourcesPath,
  userDataPath: () => app.getPath('userData'),
  appKey: () => loadAppKey(join(app.getPath('userData'), 'app-key.bin'), safeStorage),
  notificationsSupported: () => Notification.isSupported(),
  notify: (title, body, onClick) => {
    const notification = new Notification({ title, body })
    liveNotifications.add(notification)
    notification.on('click', () => {
      liveNotifications.delete(notification)
      onClick?.()
    })
    notification.on('close', () => liveNotifications.delete(notification))
    notification.show()
  },
  messageBox: async box => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const answer = parent ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box)
    return answer.response
  },
  pickFolder: async title => {
    const picked = await dialog.showOpenDialog({ properties: ['openDirectory'], title })
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  },
  openPath: path => shell.openPath(path),
  openExternal: url => shell.openExternal(url),
  setBadge: text => app.dock?.setBadge(text),
  onPower: (event, listener) => void powerMonitor.on(event as 'resume', listener),
  idleState: async seconds => powerMonitor.getSystemIdleState(seconds),
  keepAwake: on => {
    if (on && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension')
    else if (!on && awakeBlocker !== null) {
      powerSaveBlocker.stop(awakeBlocker)
      awakeBlocker = null
    }
  },
  windowFocused: () => !!win && !win.isDestroyed() && win.isFocused(),
  focusWindow,
  onQuit: (stage, hook) => {
    const held = (event: Electron.Event) =>
      hook(work => {
        event.preventDefault()
        void work.finally(() => app.quit())
      })
    if (stage === 'before') app.on('before-quit', held)
    else app.on('will-quit', held)
  },
  quit: () => app.quit(),
}
usePlatform(electronPlatform)
registerCore()
registerUpdates(ipcMain, send)

// macOS runs an app opened from Downloads or the disk image from a new temporary path each
// time (App Translocation), which the launchers written below would point at. Moving it
// restarts the app from /Applications.
async function offerApplicationsFolder(): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged || process.env.CLAUDE_IDE_CAPTURE || app.isInApplicationsFolder()) return
  const answer = await dialog.showMessageBox({
    type: 'question',
    buttons: [t('mac.move'), t('mac.later')],
    defaultId: 0,
    cancelId: 1,
    message: t('mac.moveMessage'),
    detail: t('mac.moveDetail'),
  })
  if (answer.response !== 0) return
  try {
    app.moveToApplicationsFolder()
  } catch (error) {
    console.error('could not move the app:', error)
  }
}

// The browser view's scripts (src/renderer/src/BrowserView.tsx) run in a world of their own,
// and only in a webview of this window.
ipcMain.handle('browser:run', (_e, webContentsId: number, code: string) => {
  const contents = webContents.fromId(Number(webContentsId))
  if (!contents || contents.getType() !== 'webview' || !win || contents.hostWebContents !== win.webContents) return undefined
  return contents.executeJavaScriptInIsolatedWorld(BROWSER_WORLD, [{ code: String(code) }]).catch(() => undefined)
})

// Drawn by scripts/icon.mjs.
const ICON = join(app.getAppPath(), 'resources', 'icon.png')

function createWindow(): void {
  win = new BrowserWindow({
    // A capture can ask for another size (CLAUDE_IDE_CAPTURE_WIDTH), to check a narrow window.
    width: Number(process.env.CLAUDE_IDE_CAPTURE && process.env.CLAUDE_IDE_CAPTURE_WIDTH) || 1440,
    height: 900,
    // Below this the sidebar, the main area and the top bar's right group no longer fit side by side.
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f1424',
    title: 'Switchboard',
    icon: ICON,
    // Captures run without a window on screen, so checks never cover what the person is doing.
    show: !process.env.CLAUDE_IDE_CAPTURE,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      webviewTag: true,
    },
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  win.on('closed', () => (win = null))

  // Window hardening: a dropped link or a stray navigation never replaces the
  // app page, new windows open in the browser instead, and the debugging
  // browser's <webview> runs without the preload or Node.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, APP_URL)) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-attach-webview', (_event, webPreferences, params) => hardenWebview(webPreferences, params))

  // For checks without a person at the screen: save one capture of the window, then quit.
  const capture = process.env.CLAUDE_IDE_CAPTURE
  if (capture) {
    win.webContents.on('console-message', event => console.log(`renderer ${event.level}: ${event.message}`))
    // Load stages, so a capture that never finishes shows where it stopped.
    for (const stage of ['did-start-loading', 'dom-ready', 'did-stop-loading', 'unresponsive', 'did-attach-webview'] as const) {
      win.webContents.on(stage as 'dom-ready', () => console.log(`capture: ${stage}`))
    }
    win.webContents.on('did-fail-load', (_e, code, reason, url) => console.log(`capture: did-fail-load ${code} ${reason} ${url}`))
    win.webContents.on('render-process-gone', (_e, details) => console.log(`capture: render-process-gone ${details.reason}`))
    // A capture that hangs (it happens now and then with a hidden window) gives up instead of lingering.
    setTimeout(() => {
      console.error('capture: gave up after 40s')
      app.exit(1)
    }, 40_000).unref()
    win.webContents.once('did-finish-load', () => {
      console.log('capture: did-finish-load')
      setTimeout(async () => {
        // Optional script and key presses before the capture, e.g.
        // CLAUDE_IDE_CAPTURE_JS="document.querySelector('.task').click()" CLAUDE_IDE_CAPTURE_KEYS=a,Return
        const script = process.env.CLAUDE_IDE_CAPTURE_JS
        if (script) {
          await win?.webContents.executeJavaScript(script).catch((error: unknown) => console.error('capture script failed:', error))
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        for (const keyCode of (process.env.CLAUDE_IDE_CAPTURE_KEYS ?? '').split(',').filter(Boolean)) {
          win?.webContents.sendInputEvent({ type: 'keyDown', keyCode })
          if (keyCode.length === 1) win?.webContents.sendInputEvent({ type: 'char', keyCode })
          win?.webContents.sendInputEvent({ type: 'keyUp', keyCode })
          await new Promise(resolve => setTimeout(resolve, 300))
        }
        console.log('capture: taking the picture')
        const image = await win?.webContents.capturePage()
        if (image) writeFileSync(capture, image.toPNG())
        console.log('capture: saved, quitting')
        app.quit()
      }, 2500)
    })
  }
}

// No web page in the app opens a window of its own: a webview's page, or anything else made
// later. The main window sets its own handler right after (createWindow), which replaces this.
app.on('web-contents-created', (_event, contents) => contents.setWindowOpenHandler(() => ({ action: 'deny' })))

// A second start of the app brings the running window forward (it quits itself, see `primary`).
// Before the first window exists the start under way shows it.
let started = false
app.on('second-instance', () => {
  if (!started) return
  if (!win || win.isDestroyed()) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

app.whenReady().then(async () => {
  if (!primary) return
  setLang(resolveLang(undefined, app.getLocale()))
  if (process.env.CLAUDE_IDE_CAPTURE) app.dock?.hide()
  else app.dock?.setIcon(nativeImage.createFromPath(ICON))
  await offerApplicationsFolder()
  // The terminals a host kept running while the app was closed are shown again before the window asks.
  await startCore()
  createWindow()
  started = true
  watchCore()
  watchBrowserRequests()
  startUpdates(provenBridgePid, terminalStates)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Requests of the in-app browser that failed go to the view that made them, which keeps
// them for its screen comments (src/shared/pageLog.ts).
function watchBrowserRequests(): void {
  // Pages get no camera, microphone, location or notifications: no page here needs them, and
  // without a handler Electron grants each one it asks for.
  for (const one of [session.defaultSession, session.fromPartition(BROWSER_PARTITION)]) {
    one.setPermissionRequestHandler((_contents, permission, callback) => callback(PAGE_PERMISSIONS.includes(permission)))
    one.setPermissionCheckHandler((_contents, permission) => PAGE_PERMISSIONS.includes(permission))
  }
  const requests = session.fromPartition(BROWSER_PARTITION).webRequest
  const filter = { urls: ['http://*/*', 'https://*/*'] }
  const report = (webContentsId: number | undefined, entry: PageLogEntry | null) => {
    if (entry && webContentsId !== undefined) send('browser:net', { webContentsId, entry })
  }
  requests.onCompleted(filter, d => report(d.webContentsId, netEntry(Date.now(), { method: d.method, url: d.url, statusCode: d.statusCode })))
  requests.onErrorOccurred(filter, d => report(d.webContentsId, netEntry(Date.now(), { method: d.method, url: d.url, error: d.error })))
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
import { app, BrowserWindow, dialog, ipcMain as rawIpcMain, nativeImage, Notification, powerMonitor, session, shell, webContents } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BridgeState, Reply, WorktreeCheck } from '../shared/types'
import { watchBridge } from './bridgeWatch'
import { registerAccount } from './account'
import { ccrPath } from './termAccount'
import { registerDevServers } from './devservers'
import { BROWSER_PARTITION, BROWSER_WORLD, PAGE_PERMISSIONS, bridgePathAllowed, debugPathAllowed, guardIpc, hardenWebview, isAppUrl, isExternalUrl } from './guard'
import { saveShot } from './shots'
import { onTerminalsChange, openClaudeIn, registerTerminals, typingTarget } from './terminals'
import { registerAgentTerms } from './agentTerms'
import { startAgentDelivery } from './agentDelivery'
import { nodeRoot, useNodeRoot } from './appRoot'
import { copyRuntime, oldBridgePid, pruneRuntimes, staleBridge, writeRuntime } from './runtime'
import { startUpdates } from './updater'
import { APP_HEADER, requestTarget, resolveEndpoint } from '../../bridge/endpoint.ts'
import { loadAppKey } from './appKey'
import { badgeText, firstLine, planNotification, scanPending, scanReleased, scanRuns, scanStalled } from './notify'
import { STALL_MS, stalledSessions } from '../shared/stall'
import { limitedUntil } from '../shared/limit'
import { netEntry, type PageLogEntry } from '../shared/pageLog'
import { resolveLang, setLang, t } from '../shared/i18n'

const DIR = join(homedir(), '.claude-ide')
// Where the bridge is: a Unix socket, or TCP with a token on Windows (bridge/endpoint.ts).
const target = () => requestTarget(resolveEndpoint())
const RETRY_MS = 2000

let win: BrowserWindow | null = null
let connected = false

// The app's own page. Only it may navigate the main window or call the handlers
// below: every ipcMain.handle and ipcMain.on in this process goes through the
// guard, so a page dropped onto the window or opened in a webview gets nothing.
const APP_URL = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
const ipcMain = guardIpc(rawIpcMain, event => isAppUrl(event.senderFrame?.url, APP_URL))

// The app's key for the person-only routes (src/main/appKey.ts), read once the app is ready.
let appKey = ''

// A bridge of the app's own: run on the app's Node, the key on its standard input. One a mod
// or the switchboard command started has no key, and one of another version is out of date;
// either is replaced, which drops and brings back every session's stream once.
async function launchBridge(): Promise<boolean> {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const log = openSync(join(DIR, 'bridge.log'), 'a')
  const child = spawn(process.env.APPIMAGE ?? process.execPath, [join(nodeRoot(), 'bridge', 'server.ts')], {
    detached: true,
    windowsHide: true,
    stdio: ['pipe', log, log],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_VERSION: app.isPackaged ? app.getVersion() : '', SWITCHBOARD_APP_KEY_STDIN: '1' },
  })
  child.stdin?.end(`${appKey}\n`)
  child.unref()
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    if ((await call('GET', '/app/check')).ok) return true
  }
  return false
}

async function stopBridge(pid: number): Promise<void> {
  try {
    process.kill(pid)
  } catch {
    return
  }
  for (let i = 0; i < 30 && (await call('GET', '/health')).ok; i++) await new Promise(resolve => setTimeout(resolve, 100))
}

async function startBridge(): Promise<boolean> {
  const health = await call('GET', '/health')
  if (health.ok) {
    const outdated = app.isPackaged && staleBridge(health.json, app.getVersion()) !== null
    if (!outdated && (await call('GET', '/app/check')).ok) return true
    const where = resolveEndpoint()
    const pid = typeof health.json.pid === 'number' ? health.json.pid : where.kind === 'socket' ? await oldBridgePid(where.path) : null
    if (pid !== null) await stopBridge(pid)
  }
  return launchBridge()
}

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

// The installed app writes the launchers for this copy of itself (src/main/runtime.ts) and
// replaces a bridge left running by the version before an update.
async function prepareRuntime(): Promise<void> {
  if (!app.isPackaged) return
  try {
    useNodeRoot(copyRuntime(nodeRoot(), homedir(), app.getVersion()))
    // An AppImage runs from a folder mounted for this run only; the file itself stays.
    writeRuntime({ execPath: process.env.APPIMAGE ?? process.execPath, root: nodeRoot(), home: homedir(), version: app.getVersion() })
    pruneRuntimes(homedir(), app.getVersion())
  } catch (error) {
    console.error('could not write the launchers:', error)
  }
}

function call(method: string, path: string, body?: unknown): Promise<Reply> {
  return new Promise(resolve => {
    const req = request(
      { ...target(), method, path, headers: { ...target().headers, 'content-type': 'application/json', [APP_HEADER]: appKey } },
      res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => (text += chunk))
        res.on('end', () => {
          let json: Record<string, unknown> = {}
          try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
          } catch {
            json = { error: text }
          }
          const status = res.statusCode ?? 0
          resolve({ ok: status >= 200 && status < 300, status, json })
        })
      },
    )
    req.on('error', error => resolve({ ok: false, status: 0, json: { error: error.message } }))
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// Pending question ids seen by the last scan; null until the first state, which is only a baseline.
let seenPending: Set<number> | null = null
let seenStalled = new Set<string>()
let seenLimited = new Set<string>()
let seenRuns: Set<number> | null = null
let seenApprovals: Set<number> | null = null
let scanTimer: ReturnType<typeof setTimeout> | null = null

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

async function scanQueue(): Promise<void> {
  const reply = await call('GET', '/state')
  if (!reply.ok) return
  notifyStalled(reply.json as unknown as BridgeState)
  notifyReleased(reply.json as unknown as BridgeState)
  notifyRuns(reply.json as unknown as BridgeState)
  notifyApprovals(reply.json as unknown as BridgeState)
  const scan = scanPending((reply.json as unknown as BridgeState).questions ?? [], seenPending)
  seenPending = scan.ids
  app.dock?.setBadge(badgeText(scan.count + ((reply.json as unknown as BridgeState).approvals ?? []).filter(a => a.status === 'pending').length))
  // A focused window already shows the queue; only the badge is kept current.
  const plan = win?.isFocused() ? null : planNotification(scan.fresh)
  if (!plan || !Notification.isSupported()) return
  const notification = 'many' in plan
    ? new Notification({ title: 'Switchboard', body: t('notify.many', { count: plan.many }) })
    : new Notification({ title: plan.title, body: plan.body })
  liveNotifications.add(notification)
  notification.on('click', () => {
    liveNotifications.delete(notification)
    const id = !('many' in plan) ? plan.questionId : null
    focusWindow(id !== null ? () => send('notify:open', id) : undefined)
  })
  notification.on('close', () => liveNotifications.delete(notification))
  notification.show()
}

// A session whose turn stopped moving (src/shared/stall.ts): one notification per stall,
// also while the window is focused, since the terminal that waits may be in another tab.
function notifyStalled(state: BridgeState): void {
  const stalled = stalledSessions(state.activity ?? {}, state.live ?? [], Date.now())
  const scan = scanStalled(stalled, seenStalled)
  seenStalled = scan.ids
  if (!Notification.isSupported()) return
  for (const id of scan.fresh) {
    const project = state.sessions.find(s => s.id === id)?.project ?? id
    const notification = new Notification({ title: project, body: t('notify.stalled', { minutes: STALL_MS / 60_000 }) })
    liveNotifications.add(notification)
    notification.on('click', () => {
      liveNotifications.delete(notification)
      focusWindow()
    })
    notification.on('close', () => liveNotifications.delete(notification))
    notification.show()
  }
}

// A scheduled prompt run that ended with something to say, or failed. A quiet run, one that
// was skipped and the runs already over at launch notify nothing.
function notifyRuns(state: BridgeState): void {
  const scan = scanRuns(state.routineRuns ?? [], seenRuns)
  seenRuns = scan.ids
  if (!Notification.isSupported()) return
  for (const run of scan.fresh) {
    const routine = (state.routines ?? []).find(r => r.id === run.routine_id)
    const body = run.status === 'failed' ? t('notify.runFailed', { reason: run.failure }) : firstLine(run.result) || t('notify.runDone')
    const notification = new Notification({ title: routine?.name ?? 'Switchboard', body })
    liveNotifications.add(notification)
    notification.on('click', () => {
      liveNotifications.delete(notification)
      focusWindow()
    })
    notification.on('close', () => liveNotifications.delete(notification))
    notification.show()
  }
}

// A permission ask came while the person is away: the notification waits on the screen too.
function notifyApprovals(state: BridgeState): void {
  const pending = (state.approvals ?? []).filter(a => a.status === 'pending')
  const fresh = seenApprovals === null ? [] : pending.filter(a => !seenApprovals!.has(a.id))
  seenApprovals = new Set(pending.map(a => a.id))
  if (!Notification.isSupported()) return
  for (const a of fresh) {
    const notification = new Notification({ title: a.project, body: t('notify.approval', { tool: a.tool, what: firstLine(a.summary) }) })
    liveNotifications.add(notification)
    notification.on('click', () => {
      liveNotifications.delete(notification)
      focusWindow()
    })
    notification.on('close', () => liveNotifications.delete(notification))
    notification.show()
  }
}

// A usage limit lifted: what waited for the session goes in now (the bridge looks every minute).
function notifyReleased(state: BridgeState): void {
  const at = Date.now()
  const limited = state.sessions.filter(s => limitedUntil(s.usage, s.last_seen, at) !== null).map(s => s.id)
  const scan = scanReleased(limited, seenLimited)
  seenLimited = scan.ids
  if (!Notification.isSupported()) return
  for (const id of scan.released) {
    const project = state.sessions.find(s => s.id === id)?.project
    if (!project) continue
    const notification = new Notification({ title: project, body: t('notify.limitReleased') })
    liveNotifications.add(notification)
    notification.on('click', () => {
      liveNotifications.delete(notification)
      focusWindow()
    })
    notification.on('close', () => liveNotifications.delete(notification))
    notification.show()
  }
}

// SSE events arrive in bursts; one state read per burst is enough.
function scheduleScan(): void {
  if (scanTimer) return
  scanTimer = setTimeout(() => {
    scanTimer = null
    void scanQueue().catch(() => undefined)
  }, 300)
}

// Keeps one SSE subscription to the bridge; every change becomes an IPC event,
// and the renderer refetches /state (also on the 'connected' event after a
// reconnect). On loss the app shows the bridge as down at once, restarts it and
// subscribes again.
// Away from the desk: the screen locked, or no keyboard and mouse for five minutes. The
// bridge writes to Telegram only then (bridge/telegram.ts); an old report counts as away.
const AWAY_IDLE_SECONDS = 300
function reportPresence(): void {
  const state = powerMonitor.getSystemIdleState(AWAY_IDLE_SECONDS)
  void call('POST', '/presence', { away: state === 'idle' || state === 'locked' }).catch(() => undefined)
}

function watch(): void {
  // A stall is the absence of events, so the state is also read now and then without one.
  setInterval(() => {
    scheduleScan()
    reportPresence()
  }, 30_000).unref()
  powerMonitor.on('lock-screen', reportPresence)
  powerMonitor.on('unlock-screen', reportPresence)
  powerMonitor.on('resume', reportPresence)
  watchBridge({
    target,
    retryMs: RETRY_MS,
    onConnection: up => {
      connected = up
      send('bridge:connection', up)
      if (up) {
        scheduleScan()
        reportPresence()
      }
      else app.dock?.setBadge('')
    },
    onEvent: event => {
      // A scheduled prompt found no Claude session of its project: start one there.
      const change = event as { type?: string; cwd?: string }
      if (change.type === 'routine-open' && change.cwd) openClaudeIn(change.cwd)
      send('bridge:change', event)
      scheduleScan()
      agentDelivery.onBridgeEvent(event)
    },
    beforeRetry: startBridge,
  })
}

ipcMain.handle('bridge:state', async (): Promise<BridgeState | null> => {
  const reply = await call('GET', '/state')
  // Feature area: UI language. Texts this process words (errors, dialogs, terminal names) follow the setting.
  if (reply.ok) setLang(resolveLang((reply.json as unknown as BridgeState).settings?.lang, app.getLocale()))
  // The bridge, the mod and the MCP server only see LANG, which often says en_US on a Mac set
  // to another language. Saving the OS language once makes them all speak the app's language.
  if (reply.ok && (reply.json as unknown as BridgeState).settings?.lang === undefined) {
    await call('POST', '/settings', { key: 'lang', value: resolveLang(undefined, app.getLocale()) })
  }
  return reply.ok ? (reply.json as unknown as BridgeState) : null
})
ipcMain.handle('bridge:answer', (_e, id: number, choice: string, memo: string) =>
  call('POST', `/questions/${Number(id)}/answer`, { choice, memo }),
)
function run(command: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(command, args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: (stdout || stderr).trim() }),
    )
  })
}

const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'

// Answer to Q11: before removing a worktree, show what would be lost.
ipcMain.handle('worktree:check', async (_e, path: string, branch: string): Promise<WorktreeCheck> => {
  if (!existsSync(path)) return { exists: false, changed: [], unpushed: 0, merged: false, base: '' }
  const status = await run('git', ['status', '--porcelain'], path)
  const changed = status.out ? status.out.split('\n').map(line => line.slice(3)) : []
  const head = await run('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], path)
  const base = head.code === 0 && head.out ? head.out : 'main'
  const upstream = await run('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], path)
  const against = upstream.code === 0 ? upstream.out : base
  const ahead = await run('git', ['rev-list', '--count', `${against}..${branch}`], path)
  const merged = await run('git', ['merge-base', '--is-ancestor', branch, base], path)
  return { exists: true, changed, unpushed: Number(ahead.out) || 0, merged: merged.code === 0, base }
})

ipcMain.handle('worktree:remove', async (_e, nodeId: number, path: string, force: boolean): Promise<Reply> => {
  const orca = existsSync(ORCA) ? ORCA : 'orca'
  if (existsSync(path)) {
    const args = ['worktree', 'rm', '--worktree', `path:${path}`, '--json', ...(force ? ['--force'] : [])]
    const removed = await run(orca, args)
    let ok = false
    try {
      ok = (JSON.parse(removed.out) as { ok?: boolean }).ok === true
    } catch {
      ok = false
    }
    if (!ok) return { ok: false, status: 0, json: { error: removed.out || 'orca worktree rm failed' } }
  }
  return call('POST', '/nodes/worktree', { nodeId, worktree: null })
})

// Linear issues through Orca's Linear connection (read only here; the session does the rest).
ipcMain.handle('linear:list', async (_e, filter: string) => {
  const orca = existsSync(ORCA) ? ORCA : 'orca'
  const allowed = ['assigned', 'created', 'all', 'open', 'completed']
  const ran = await run(orca, ['linear', 'list', '--filter', allowed.includes(filter) ? filter : 'assigned', '--limit', '50', '--json'])
  try {
    const reply = JSON.parse(ran.out) as { ok?: boolean; result?: { issues?: unknown[] }; error?: { message?: string } }
    return reply.ok ? { issues: reply.result?.issues ?? [] } : { issues: [], error: reply.error?.message ?? t('linear.listFailed') }
  } catch {
    return { issues: [], error: ran.out || t('linear.listRunFailed') }
  }
})

ipcMain.handle('bridge:connected', () => connected)
ipcMain.handle('bridge:command', (_e, sessionId: string, kind: string, payload: Record<string, unknown>) =>
  call('POST', '/commands', { sessionId, kind, payload }),
)
// Plain bridge calls for screens that only read or write rows (archive, settings, command results).
ipcMain.handle('bridge:call', (_e, method: string, path: string, body?: unknown) => {
  if (!bridgePathAllowed(path)) return { ok: false, status: 0, json: { error: `not allowed: ${String(path)}` } }
  return call(method === 'POST' ? 'POST' : 'GET', path, body)
})
ipcMain.handle('bridge:send', (_e, sessionId: string, text: string, kind: string, taskTitle: string) =>
  call('POST', '/outbox', { sessionId, text, kind, taskTitle }),
)
// Element shots for screen comments; the prompt carries the path so the session can read the image.
ipcMain.handle('shots:save', (_e, dataUrl: string): string | null => saveShot(join(DIR, 'shots'), dataUrl))
ipcMain.handle('bridge:hold', (_e, id: number) => call('POST', `/questions/${Number(id)}/hold`))
ipcMain.handle('bridge:forward', (_e, id: number, to: string) => call('POST', `/questions/${Number(id)}/forward`, { to: String(to) }))
ipcMain.handle('bridge:approve', (_e, id: number, decision: string) =>
  call('POST', `/approvals/${Number(id)}/answer`, { decision: ['allow', 'deny', 'terminal'].includes(decision) ? decision : 'terminal' }),
)
// Dynamic debugging: screen comments, open_in_ide requests and live sessions (bridge/debug.ts).
ipcMain.handle('debug:call', (_e, method: string, path: string, body?: unknown) => {
  if (!debugPathAllowed(path)) return { ok: false, status: 0, json: { error: `not allowed: ${String(path)}` } }
  return call(method === 'POST' ? 'POST' : 'GET', path, body)
})
// The browser view's scripts (src/renderer/src/BrowserView.tsx) run in a world of their own,
// and only in a webview of this window.
ipcMain.handle('browser:run', (_e, webContentsId: number, code: string) => {
  const contents = webContents.fromId(Number(webContentsId))
  if (!contents || contents.getType() !== 'webview' || !win || contents.hostWebContents !== win.webContents) return undefined
  return contents.executeJavaScriptInIsolatedWorld(BROWSER_WORLD, [{ code: String(code) }]).catch(() => undefined)
})
registerDevServers(ipcMain, event => send('dev:change', event))
registerTerminals(ipcMain, send)
registerAccount(ipcMain, () => ccrPath())
// Feature area: agent CLIs other than Claude Code. Their terminals, and answers typed into them.
registerAgentTerms(ipcMain, call)
const agentDelivery = startAgentDelivery({
  target,
  call,
  terminal: typingTarget,
  // The CLI shows a menu of its own: what waits is not typed into it, and the person hears why.
  menuWaiting: sessionId =>
    void call('GET', '/state').then(reply => {
      const session = ((reply.json.sessions ?? []) as { id: string; project: string; agent?: string }[]).find(s => s.id === sessionId)
      if (!Notification.isSupported()) return
      new Notification({ title: 'Switchboard', body: t('agent.menuWaiting', { project: session?.project ?? sessionId, agent: session?.agent ?? '' }) }).show()
    }),
})
onTerminalsChange(() => void agentDelivery.refresh())

// Drawn by scripts/icon.mjs.
const ICON = join(app.getAppPath(), 'resources', 'icon.png')

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
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

// Captures keep their own profile so they never overwrite the real app's saved tabs and addresses.
if (process.env.CLAUDE_IDE_CAPTURE) app.setPath('userData', `${process.env.CLAUDE_IDE_CAPTURE}.profile`)

app.whenReady().then(async () => {
  setLang(resolveLang(undefined, app.getLocale()))
  if (process.env.CLAUDE_IDE_CAPTURE) app.dock?.hide()
  else app.dock?.setIcon(nativeImage.createFromPath(ICON))
  await offerApplicationsFolder()
  appKey = loadAppKey(join(app.getPath('userData'), 'app-key.bin'))
  await prepareRuntime()
  await startBridge()
  createWindow()
  watch()
  watchBrowserRequests()
  startUpdates(async () => {
    const health = await call('GET', '/health')
    return health.ok && typeof health.json.pid === 'number' ? health.json.pid : null
  })
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

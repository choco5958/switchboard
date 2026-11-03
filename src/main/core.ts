// The app logic, whatever shell it runs in (platform.ts): the bridge it starts and watches, the
// notifications and the Dock badge, presence, and every call the page makes (window.ide). The
// Electron shell (index.ts) and the Tauri host (docs/tauri-이전.md) run the same code.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BridgeState, Reply, WorktreeCheck } from '../shared/types'
import { sharedStart, watchBridge } from './bridgeWatch'
import { registerAccount } from './account'
import { ccrPath } from './termAccount'
import { registerDevServers } from './devservers'
import { bridgePathAllowed, debugPathAllowed } from './guard'
import { saveShot } from './shots'
import { anyoneWorking } from './awake'
import { dockIdOf, onTerminalsChange, openClaudeIn, registerTerminals, setCloseTerminalsOnQuit, startTerminalHost, terminalConfigDir, typingTarget } from './terminals'
import { registerSessionHistory } from './sessionHistory'
import { openAgentIn, registerAgentTerms } from './agentTerms'
import { startAgentDelivery } from './agentDelivery'
import { nodeRoot, useNodeRoot } from './appRoot'
import { buildId, copyRuntime, nodeEntry, oldBridgePid, pruneRuntimes, staleBridge, writeRuntime } from './runtime'
import { requestTarget, resolveEndpoint } from '../../bridge/endpoint.ts'
import { bridgeClient } from './bridgeClient'
import { ROUTINE_FAIL_LIMIT } from '../../bridge/schedule.ts'
import { badgeText, firstLine, planNotification, scanPending, scanReleased, scanRuns, scanStalled, switchedOff } from './notify'
import { STALL_MS, stalledSessions } from '../shared/stall'
import { limitedUntil } from '../shared/limit'
import { resolveLang, setLang, t } from '../shared/i18n'
import { CLOSE_TERMINALS_KEY } from '../shared/agents'
import { hostBuilds } from './termClient'
import { hostDir } from './termProtocol'
import { platform } from './platform'

const DIR = join(homedir(), '.claude-ide')
// Where the bridge is: a Unix socket, or TCP with a token on Windows (bridge/endpoint.ts).
const target = () => requestTarget(resolveEndpoint())
const RETRY_MS = 2000

let connected = false

// The app's key for the person-only routes (src/main/appKey.ts), read once the app is ready.
let appKey = ''
// This build of the installed app (runtime.ts buildId), known once prepareRuntime has run: the
// bridge it starts says it, and a bridge of any other build is replaced.
let build = ''
const ownBuild = () => build || platform().version()

// A bridge of the app's own: run on the app's Node, the key on its standard input. One a mod
// or the switchboard command started has no key, and one of another version is out of date;
// either is replaced, which drops and brings back every session's stream once.
async function launchBridge(): Promise<boolean> {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const log = openSync(join(DIR, 'bridge.log'), 'a')
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(process.env.APPIMAGE ?? process.execPath, [nodeEntry(nodeRoot(), 'bridge/server')], {
      detached: true,
      windowsHide: true,
      stdio: ['pipe', log, log],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_VERSION: platform().isPackaged ? ownBuild() : '', SWITCHBOARD_APP_KEY_STDIN: '1' },
    })
  } finally {
    // The child has its own copy of the descriptor; this one would stay open for every start.
    closeSync(log)
  }
  // A spawn that fails (the app moved, no permission) says so in the log instead of throwing in main.
  child.on('error', error => {
    bridgeProblem = error.message
    console.error('could not start the bridge:', error.message)
  })
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(`${appKey}\n`)
  child.unref()
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    if ((await call('GET', '/app/check')).ok) return true
  }
  return false
}

// Only a pid the bridge proved the key for (bridgeClient.ts), or the process that holds the
// socket and runs bridge/server.ts (a bridge of 0.3.5 or before, which cannot prove it).
async function stopBridge(pid: number): Promise<void> {
  try {
    process.kill(pid)
  } catch {
    return
  }
  for (let i = 0; i < 30 && (await call('GET', '/health')).ok; i++) await new Promise(resolve => setTimeout(resolve, 100))
}

// Why the last start did not give the app a bridge of its own, for the screen (bridge:problem).
let bridgeProblem = ''

// A bridge that runs but does not take the app's key (a mod or another start beat the app's
// own): person-only answers fail and the person always looks away. Checked on every connection
// and now and then; replaced when it happens.
let replacing = false
async function ensureOwnBridge(): Promise<void> {
  if (replacing) return
  const check = await call('GET', '/app/check')
  if (check.ok || check.status !== 403) return
  replacing = true
  try {
    if (!(await startBridge())) bridgeProblem ||= t('app.bridgeNotOwn')
    else bridgeProblem = ''
  } finally {
    replacing = false
  }
}

// Shared by every caller (the app's start, ensureOwnBridge, the stream's retry): two at once
// would each stop the other's new bridge and launch one more.
const startBridge = sharedStart(startBridgeOnce)

async function startBridgeOnce(): Promise<boolean> {
  const health = await call('GET', '/health')
  if (health.ok) {
    const outdated = platform().isPackaged && staleBridge(health.json, ownBuild()) !== null
    if (!outdated && (await call('GET', '/app/check')).ok) return true
    // What /health says is anyone's word: only a bridge that proves the key names a pid to stop.
    // One without the key gives way to the bridge the app starts (bridge/server.ts listen).
    const where = resolveEndpoint()
    const pid = (await bridge.provenPid()) ?? (where.kind === 'socket' ? await oldBridgePid(where.path) : null)
    if (pid !== null) await stopBridge(pid)
  }
  return launchBridge()
}


// The installed app writes the launchers for this copy of itself (src/main/runtime.ts) and
// replaces a bridge left running by the version before an update.
async function prepareRuntime(): Promise<void> {
  if (!platform().isPackaged) return
  try {
    const id = buildId(nodeRoot(), platform().version())
    useNodeRoot(copyRuntime(nodeRoot(), homedir(), id))
    build = id
    // An AppImage runs from a folder mounted for this run only; the file itself stays.
    writeRuntime({ execPath: process.env.APPIMAGE ?? process.execPath, root: nodeRoot(), home: homedir(), version: id })
    pruneRuntimes(homedir(), id, hostBuilds(hostDir(homedir())))
  } catch (error) {
    console.error('could not write the launchers:', error)
  }
}

// The key goes only to a bridge that proves it holds it (bridgeClient.ts); `proven` says so.
const bridge = bridgeClient(target, () => appKey)
const call = bridge.call


// Pending question ids seen by the last scan; null until the first state, which is only a baseline.
let seenPending: Set<number> | null = null
let seenStalled = new Set<string>()
let seenLimited = new Set<string>()
let seenRuns: Set<number> | null = null
let seenApprovals: Set<number> | null = null
let scanTimer: ReturnType<typeof setTimeout> | null = null


// The computer stays awake while an agent works (awake.ts).
function keepAwake(state: BridgeState): void {
  platform().keepAwake(anyoneWorking(state.activity ?? {}, state.live ?? [], Date.now()))
}

async function scanQueue(): Promise<void> {
  const reply = await call('GET', '/state')
  if (!reply.ok) return
  keepAwake(reply.json as unknown as BridgeState)
  // Read at the quit, which has no time to ask the bridge.
  setCloseTerminalsOnQuit((reply.json as unknown as BridgeState).settings?.[CLOSE_TERMINALS_KEY] === true)
  notifyStalled(reply.json as unknown as BridgeState)
  notifyReleased(reply.json as unknown as BridgeState)
  notifyRuns(reply.json as unknown as BridgeState)
  notifyApprovals(reply.json as unknown as BridgeState)
  const scan = scanPending((reply.json as unknown as BridgeState).questions ?? [], seenPending)
  seenPending = scan.ids
  platform().setBadge(badgeText(scan.count + ((reply.json as unknown as BridgeState).approvals ?? []).filter(a => a.status === 'pending').length))
  // A focused window already shows the queue; only the badge is kept current.
  const plan = platform().windowFocused() ? null : planNotification(scan.fresh)
  if (!plan) return
  if ('many' in plan) notify('Switchboard', t('notify.many', { count: plan.many }))
  else notify(plan.title, plan.body, () => platform().focusWindow(() => send('notify:open', plan.questionId)))
}

// A session whose turn stopped moving (src/shared/stall.ts): one notification per stall,
// also while the window is focused, since the terminal that waits may be in another tab.
function notifyStalled(state: BridgeState): void {
  const stalled = stalledSessions(state.activity ?? {}, state.live ?? [], Date.now())
  const scan = scanStalled(stalled, seenStalled)
  seenStalled = scan.ids
  for (const id of scan.fresh) {
    const project = state.sessions.find(s => s.id === id)?.project ?? id
    notify(project, t('notify.stalled', { minutes: STALL_MS / 60_000 }))
  }
}

// A scheduled prompt run that ended with something to say, or failed. A quiet run, one that
// was skipped and the runs already over at launch notify nothing.
function notifyRuns(state: BridgeState): void {
  const scan = scanRuns(state.routineRuns ?? [], seenRuns)
  seenRuns = scan.ids
  for (const run of scan.fresh) {
    const routine = (state.routines ?? []).find(r => r.id === run.routine_id)
    const body = switchedOff(run, state.routines ?? [], state.routineRuns ?? [])
      ? t('notify.runFailedOff', { reason: run.failure, n: ROUTINE_FAIL_LIMIT })
      : run.status === 'failed'
        ? t('notify.runFailed', { reason: run.failure })
        : firstLine(run.result) || t('notify.runDone')
    notify(routine?.name ?? 'Switchboard', body)
  }
}

// A permission ask came while the person is away: the notification waits on the screen too.
function notifyApprovals(state: BridgeState): void {
  const pending = (state.approvals ?? []).filter(a => a.status === 'pending')
  const fresh = seenApprovals === null ? [] : pending.filter(a => !seenApprovals!.has(a.id))
  seenApprovals = new Set(pending.map(a => a.id))
  for (const a of fresh) {
    notify(a.project, t('notify.approval', { tool: a.tool, what: firstLine(a.summary) }))
  }
}

// A usage limit lifted: what waited for the session goes in now (the bridge looks every minute).
function notifyReleased(state: BridgeState): void {
  const at = Date.now()
  const limited = state.sessions.filter(s => limitedUntil(s.usage, s.last_seen, at) !== null).map(s => s.id)
  const scan = scanReleased(limited, seenLimited)
  seenLimited = scan.ids
  for (const id of scan.released) {
    const project = state.sessions.find(s => s.id === id)?.project
    if (!project) continue
    notify(project, t('notify.limitReleased'))
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
  void platform().idleState(AWAY_IDLE_SECONDS).then(state =>
    call('POST', '/presence', { away: state === 'idle' || state === 'locked' }).catch(() => undefined),
  )
}

export function watchCore(): void {
  // A stall is the absence of events, so the state is also read now and then without one.
  setInterval(() => {
    scheduleScan()
    reportPresence()
    void ensureOwnBridge()
  }, 30_000).unref()
  platform().onPower('lock-screen', reportPresence)
  platform().onPower('unlock-screen', reportPresence)
  platform().onPower('resume', reportPresence)
  watchBridge({
    target,
    retryMs: RETRY_MS,
    onConnection: up => {
      connected = up
      send('bridge:connection', up)
      if (up) {
        scheduleScan()
        reportPresence()
        void ensureOwnBridge()
      }
      else platform().setBadge('')
    },
    onEvent: event => {
      // A scheduled prompt found no session of its agent in its project: start one there.
      const change = event as { type?: string; routineId?: unknown }
      if (change.type === 'routine-open') void openForRoutine(change.routineId)
      send('bridge:change', event)
      scheduleScan()
      agentDelivery?.onBridgeEvent(event)
    },
    beforeRetry: startBridge,
  })
}

// A scheduled prompt's terminal, where the routine the person saved says: only for a routine a
// bridge that proved the key lists, never a folder or a CLI an event names by itself.
async function openForRoutine(routineId: unknown): Promise<void> {
  if (typeof routineId !== 'number') return
  const reply = await call('GET', '/state')
  if (!reply.proven) return
  const routine = ((reply.json as unknown as BridgeState).routines ?? []).find(r => r.id === routineId)
  if (!routine?.cwd) return
  if (!routine.agent || routine.agent === 'claude') {
    openClaudeIn(routine.cwd)
    return
  }
  const opened = await openAgentIn(call, routine.cwd, routine.agent)
  if ('error' in opened) console.error('routine terminal:', opened.error)
}

// The page's calls (window.ide), each through the shell's guarded IPC.
export function registerCore(): void {
const ipcMain = platform().ipc
ipcMain.handle('bridge:state', async (): Promise<BridgeState | null> => {
  const reply = await call('GET', '/state')
  // Feature area: UI language. Texts this process words (errors, dialogs, terminal names) follow the setting.
  if (reply.ok) setLang(resolveLang((reply.json as unknown as BridgeState).settings?.lang, platform().locale()))
  // The bridge, the mod and the MCP server only see LANG, which often says en_US on a Mac set
  // to another language. Saving the OS language once makes them all speak the app's language.
  if (reply.ok && (reply.json as unknown as BridgeState).settings?.lang === undefined) {
    await call('POST', '/settings', { key: 'lang', value: resolveLang(undefined, platform().locale()) })
  }
  if (!reply.ok) return null
  // A session's terminal comes as that terminal's key (SWITCHBOARD_TERMINAL), which can have
  // answers typed into it. The renderer gets the dock id instead, or 'closed' when no dock
  // terminal has that key now.
  const state = reply.json as unknown as BridgeState
  return { ...state, sessions: state.sessions.map(s => (s.terminal ? { ...s, terminal: dockIdOf(s.terminal) ?? 'closed' } : s)) }
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

// Whether Linear can be reached at all: Orca's CLI carries the connection, so no Orca, no Linear.
// The app bundle's copy first; otherwise an `orca` on PATH that runs.
ipcMain.handle('linear:available', async () => existsSync(ORCA) || (await run('orca', ['--version'])).code === 0)

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
// The bridge does not come up: the log's path and its last line, for the screen to show.
ipcMain.handle('bridge:problem', () => {
  const log = join(DIR, 'bridge.log')
  let last = ''
  try {
    const text = readFileSync(log, 'utf8').slice(-4000)
    last = text.trim().split('\n').filter(Boolean).pop() ?? ''
  } catch {
    // No log yet.
  }
  return { log, last: (bridgeProblem || last).slice(0, 300) }
})
ipcMain.handle('bridge:openLog', () => platform().openPath(join(DIR, 'bridge.log')))
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
ipcMain.handle('bridge:approve', (_e, id: number, decision: string, note?: unknown) =>
  call('POST', `/approvals/${Number(id)}/answer`, {
    decision: ['allow', 'deny', 'terminal'].includes(decision) ? decision : 'terminal',
    ...(decision === 'deny' && typeof note === 'string' && note.trim() ? { note } : {}),
  }),
)
// Dynamic debugging: screen comments, open_in_ide requests and live sessions (bridge/debug.ts).
ipcMain.handle('debug:call', (_e, method: string, path: string, body?: unknown) => {
  if (!debugPathAllowed(path)) return { ok: false, status: 0, json: { error: `not allowed: ${String(path)}` } }
  return call(method === 'POST' ? 'POST' : 'GET', path, body)
})

registerDevServers(ipcMain, event => send('dev:change', event))
registerTerminals(ipcMain, send)
registerAccount(ipcMain, () => ccrPath())
registerSessionHistory(ipcMain, terminalConfigDir)
// Feature area: agent CLIs other than Claude Code. Their terminals, and answers typed into them.
registerAgentTerms(ipcMain, call)
agentDelivery = startAgentDelivery({
  // The app's key on the delivery stream too (a session that took a token answers only it or the
  // app), sent only to a bridge that proved it holds the key.
  target: () => bridge.streamTarget(),
  call,
  terminal: typingTarget,
  // The CLI shows a menu of its own: what waits is not typed into it, and the person hears why.
  menuWaiting: sessionId =>
    void call('GET', '/state').then(reply => {
      const session = ((reply.json.sessions ?? []) as { id: string; project: string; agent?: string }[]).find(s => s.id === sessionId)
      notify('Switchboard', t('agent.menuWaiting', { project: session?.project ?? sessionId, agent: session?.agent ?? '' }), () => undefined)
    }),
})
onTerminalsChange(() => void agentDelivery?.refresh())
}
const send = (channel: string, payload: unknown) => platform().send(channel, payload)

// A clicked notification brings the window forward unless it says otherwise.
function notify(title: string, body: string, onClick: () => void = () => platform().focusWindow()): void {
  if (platform().notificationsSupported()) platform().notify(title, body, onClick)
}

let agentDelivery: ReturnType<typeof startAgentDelivery> | null = null

// Once the shell is ready, before its window opens: the app key, this build's runtime copy and
// launchers, the bridge, and the terminals a host kept running while the app was closed.
export async function startCore(): Promise<void> {
  const loaded = platform().appKey()
  appKey = loaded.key
  if (loaded.refused) notify('Switchboard', t('app.keyRefused'), () => undefined)
  await prepareRuntime()
  await startBridge()
  await startTerminalHost(appKey, ownBuild(), loaded.lasting)
}

// For the shell's own parts (the Electron updater): the bridge the app proved.
export const provenBridgePid = () => bridge.provenPid()

import { app, dialog, type IpcMain } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as pty from 'node-pty'
import type { TermInfo } from '../shared/types'
import { projectName, shellQuote, terminalEnv } from '../shared/projects'
import { accountDir, claudeLauncher, claudeLine } from './termAccount'
import { ccrPaths } from './account'
import { pasteModeAfter, type TypingTarget } from './agentInput'
import { createScreen, type Screen } from './termScreen'
import { t } from '../shared/i18n'
import { writeOpenUrl } from './openUrl'
import { nodeRoot } from './appRoot'
import { loginShell } from './shell'
import { shellWord } from '../shared/agents'
import { HOST_DOWN, hostSupported, localBackend, terminalHosts, type HostEvents, type Hosts, type TermBackend } from './termClient'
import { hostDir, type Snapshot } from './termProtocol'
import type { SpawnPty } from './termCore'

// Terminals in the IDE's bottom dock. Each is a login shell in a project folder;
// a Claude terminal types `claude --plugin-dir <this app's mod>` into it first,
// so the session reports to the IDE without installing the plugin. The shell
// stays after claude exits, as in any terminal. Other agent CLIs open the same
// way (src/main/agentTerms.ts).
// The shells run in the terminal host (termHost.ts), which keeps them running when the app
// quits, restarts or updates; the next start shows them again. Where no host runs (Windows,
// termClient.ts hostSupported) they run in this process and end with it.

// seq numbers every output chunk, so a view that replays the buffer can skip live chunks it already holds.
// key names the terminal to an agent's MCP server (SWITCHBOARD_TERMINAL): 128 random bits
// (newKey), so a session left from an earlier run never maps onto a new terminal and no other
// process can guess one to have answers typed into it. A terminal the host kept keeps its key.
// lastOutput and paste tell the answer typing whether the CLI waits for input and takes bracketed paste.
// screen: what the terminal shows now (termScreen.ts), for the typing check's menu test.
// fg: the program in front, as the backend last read it. backend: where the shell runs.
type Live = TermInfo & { buffer: string; seq: number; key: string; shell: string; lastOutput: number; paste: boolean; fg: string; bins: string[]; screen: Screen; backend: TermBackend }

const BUFFER_MAX = 256 * 1024
const terms = new Map<string, Live>()
let seq = 0
const changeListeners = new Set<() => void>()
// Close the terminals with the app (the closeTerminalsOnQuit setting); off, the host keeps them.
let closeOnQuit = false

const newKey = (): string => randomBytes(16).toString('hex')

const byKey = (key: string) => [...terms.values()].find(one => one.key === key)

// The dock id of the terminal with this key, for the renderer, which never sees the keys.
export const dockIdOf = (key: string): string | undefined => byKey(key)?.id

// What the answer typing (agentDelivery.ts) sees of the terminal with this key.
export function typingTarget(key: string): TypingTarget | undefined {
  const term = byKey(key)
  if (!term) return undefined
  return {
    agent: term.agent,
    alive: term.alive,
    shell: term.shell,
    lastOutput: term.lastOutput,
    paste: term.paste,
    // On Windows this is the terminal name, not a program: typingBlock goes by the screen there.
    foreground: term.alive ? term.fg : '',
    expect: term.bins,
    screen: term.screen.rows(),
    platform: process.platform,
    write: data => {
      if (term.alive) term.backend.write(term.key, data)
    },
  }
}

export function onTerminalsChange(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

// What a quit would end: each terminal's state, for the update's question (updater.ts). A
// terminal the host keeps running counts as not alive here, unless the setting closes it.
export function terminalStates(): { alive: boolean }[] {
  return [...terms.values()].map(one => ({ alive: one.alive && (!one.backend.keeps || closeOnQuit) }))
}

export function setCloseTerminalsOnQuit(on: boolean): void {
  closeOnQuit = on
}

const changed = () => {
  for (const listener of changeListeners) listener()
}

// What a terminal printed, wherever it runs: kept for a view opened later, and passed on.
function output(term: Live, data: string): void {
  term.buffer = (term.buffer + data).slice(-BUFFER_MAX)
  term.seq += 1
  term.lastOutput = Date.now()
  term.paste = pasteModeAfter(term.paste, data)
  term.screen.write(data)
  send('term:data', { id: term.id, data, seq: term.seq })
}

function ended(term: Live, exitCode: number | null): void {
  if (!term.alive) return
  term.alive = false
  term.exitCode = exitCode
  send('term:exit', { id: term.id, exitCode })
  changed()
}

const events: HostEvents = {
  data: (key, data) => {
    const term = byKey(key)
    if (term) output(term, data)
  },
  exit: (key, code) => {
    const term = byKey(key)
    if (term) ended(term, code)
  },
  fg: (key, fg) => {
    const term = byKey(key)
    if (term) term.fg = fg
  },
  // The host went away (a crash, a kill): its terminals went with it.
  lost: key => {
    const term = byKey(key)
    if (!term?.alive) return
    output(term, `\r\n\x1b[2m[${t('term.hostLost')}]\x1b[0m\r\n`)
    ended(term, -1)
  },
}

// Terminals in this process: where no host runs, and the fallback while none is set up.
const local = localBackend(pty.spawn as unknown as SpawnPty, events)
let hosts: Hosts | null = null

// A renderer reload keeps every terminal. Quitting the app ends the ones in this process.
function killLocal(): void {
  void local.killAll()
}

function info(t: Live): TermInfo {
  return { id: t.id, project: t.project, cwd: t.cwd, title: t.title, claude: t.claude, alive: t.alive, exitCode: t.exitCode, agent: t.agent }
}

let send: (channel: string, payload: unknown) => void = () => undefined
let configDir: string | undefined

export type TermStart = {
  cwd: string
  cols: number
  rows: number
  title: string // without the number a second terminal of the project gets
  claude?: boolean
  agent?: string
  // The program names that mean the terminal's CLI is in front, the only time answers are typed.
  bins?: string[]
  // Env vars for the shell and the command typed into it once it starts. They may name
  // the terminal's key, which exists only now.
  prepare?: (key: string) => { env?: Record<string, string>; line?: string }
}

let browserScript = ''

// A `+ Claude` terminal opened by the app itself (a scheduled prompt with no session to go
// to); set once the terminal handlers are registered.
export let openClaudeIn: (cwd: string) => TermInfo | { error: string } = () => ({ error: 'terminals not ready' })

// A login shell in the folder, the way every dock terminal starts.
export function openTerminal(start: TermStart): TermInfo | { error: string } {
  const folder = start.cwd.startsWith('~/') ? homedir() + start.cwd.slice(1) : start.cwd
  if (!folder || !existsSync(folder)) return { error: t('term.noFolder', { path: start.cwd }) }
  const shell = loginShell()
  const id = `t${++seq}`
  const key = newKey()
  const prepared = start.prepare?.(key) ?? {}
  const cols = Math.max(20, start.cols || 100)
  const rows = Math.max(5, start.rows || 30)
  const env = {
    ...terminalEnv(process.env, configDir),
    // Local links a CLI opens land in the in-app browser (openUrl.ts), unless the person set their own.
    // Not on Windows: a .js file there may open in Windows Script Host instead of Node.
    ...(browserScript && !process.env.BROWSER && process.platform !== 'win32' ? { BROWSER: browserScript } : {}),
    ...(start.agent ? { SWITCHBOARD_AGENT: start.agent, SWITCHBOARD_TERMINAL: key } : {}),
    ...prepared.env,
  }
  const project = projectName(folder)
  const same = [...terms.values()].filter(one => one.project === project).length
  const title = `${start.title}${same > 0 ? ` ${same + 1}` : ''}`
  const backend = hosts ?? local
  const term: Live = {
    id, project, cwd: folder, title, claude: start.claude === true, agent: start.agent, alive: true, exitCode: null,
    buffer: '', seq: 0, key, shell: shell.file, lastOutput: Date.now(), paste: false, fg: '', bins: start.bins ?? [], screen: createScreen(cols, rows), backend,
  }
  terms.set(id, term)
  const meta = { project, cwd: folder, title, claude: term.claude, agent: start.agent, shell: shell.file, bins: term.bins }
  void backend.spawn({ id: key, file: shell.file, args: shell.interactive, cwd: folder, env, cols, rows, meta }).then(result => {
    if (!('error' in result)) return
    const why = result.error === HOST_DOWN ? t('term.hostFailed', { log: HOST_LOG }) : result.error
    output(term, `\x1b[31m${why}\x1b[0m\r\n`)
    ended(term, -1)
  })
  // Sent after the spawn, which it follows to the host.
  if (prepared.line) backend.write(key, `${prepared.line}\r`)
  changed()
  return info(term)
}

const HOST_LOG = join(homedir(), '.claude-ide', 'termhost.log')

// A terminal the host kept from an earlier run of the app: a dock tab again, its screen as it
// is now, and the typing target its session's answers go to (agentDelivery.ts).
function restored(snapshot: Snapshot, backend: TermBackend): void {
  const id = `t${++seq}`
  const screen = createScreen(snapshot.cols, snapshot.rows)
  screen.write(snapshot.screen)
  const { meta } = snapshot
  terms.set(id, {
    id, project: meta.project, cwd: meta.cwd, title: meta.title, claude: meta.claude, agent: meta.agent, alive: snapshot.alive, exitCode: snapshot.exitCode,
    buffer: snapshot.screen, seq: 0, key: snapshot.id, shell: meta.shell, lastOutput: snapshot.lastOutput, paste: pasteModeAfter(false, snapshot.screen),
    fg: snapshot.fg, bins: meta.bins, screen, backend,
  })
}

// Before the window opens: finds the hosts that run (this build's and older ones), shows
// their terminals again and starts this build's host if none runs. `lastingKey`: the app key
// is the same at the next start (appKey.ts), which the host asks for.
export async function startTerminalHost(key: string, build: string, lastingKey: boolean): Promise<void> {
  if (!hostSupported(process.platform, lastingKey, process.env)) return
  const made = terminalHosts({
    // An AppImage runs from a mount that goes with the app; the file itself gives the host its own.
    execPath: process.env.APPIMAGE ?? process.execPath,
    appImage: !!process.env.APPIMAGE,
    script: join(nodeRoot(), 'src', 'main', 'termHost.ts'),
    build,
    dir: hostDir(homedir()),
    key,
    log: HOST_LOG,
    // From the repo (pnpm dev) its node_modules; installed, the app.asar the host finds itself.
    modules: app.isPackaged ? undefined : app.getAppPath(),
    events,
  })
  hosts = made
  // A host that does not answer in time keeps its terminals for the next start.
  let late = false
  const timer = new Promise<void>(resolve => setTimeout(() => ((late = true), resolve()), 8000).unref())
  await Promise.race([made.restore(snapshot => !late && restored(snapshot, made)).catch(error => console.error('could not attach the terminal hosts:', error)), timer])
  if (terms.size > 0) changed()
  void made.ready()
}

export function registerTerminals(ipcMain: IpcMain, sendTo: (channel: string, payload: unknown) => void): void {
  send = sendTo
  try {
    browserScript = writeOpenUrl(join(homedir(), '.claude-ide'))
  } catch {
    browserScript = ''
  }
  configDir = accountDir(process.env, join(homedir(), '.claude-ide', 'terminal.json'))
  // Read at each open: the installed app moves it to its runtime copy once it is ready.
  const modDir = () => join(nodeRoot(), 'mod')

  ipcMain.handle('term:list', () => [...terms.values()].map(info))

  ipcMain.handle('term:open', (_e, cwd: string, claude: boolean, cols: number, rows: number, slot?: number): TermInfo | { error: string } =>
    openTerminal({
      cwd,
      cols,
      rows,
      claude,
      title: claude ? 'claude' : t('term.shell'),
      prepare: () => ({ line: claude ? claudeLine(claudeLauncher(), shellWord(modDir()), slot, ccrPaths().count) : undefined }),
    }),
  )
  openClaudeIn = cwd =>
    openTerminal({
      cwd,
      cols: 100,
      rows: 30,
      claude: true,
      title: 'claude',
      prepare: () => ({ line: claudeLine(claudeLauncher(), shellWord(modDir()), undefined, ccrPaths().count) }),
    })

  ipcMain.handle('term:buffer', (_e, id: string) => {
    const t = terms.get(id)
    return { data: t?.buffer ?? '', seq: t?.seq ?? 0 }
  })
  ipcMain.on('term:write', (_e, id: string, data: string) => {
    const t = terms.get(id)
    if (t?.alive) t.backend.write(t.key, data)
  })
  ipcMain.on('term:resize', (_e, id: string, cols: number, rows: number) => {
    const t = terms.get(id)
    if (t?.alive && cols > 0 && rows > 0) {
      t.backend.resize(t.key, cols, rows)
      t.screen.resize(cols, rows)
    }
  })
  // Closing a tab ends its program even where the host would keep it.
  ipcMain.handle('term:close', (_e, id: string) => {
    const t = terms.get(id)
    if (!t) return false
    void t.backend.kill(t.key)
    t.alive = false
    t.screen.dispose()
    terms.delete(id)
    changed()
    return true
  })
  // Whether the terminals keep running after a quit, for the setting's screen.
  ipcMain.handle('term:keeps', () => hosts !== null)
  ipcMain.handle('term:pickFolder', async (): Promise<string | null> => {
    const picked = await dialog.showOpenDialog({ properties: ['openDirectory'], title: t('term.pickFolder') })
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  })

  app.on('before-quit', killLocal)
  app.on('will-quit', killLocal)
  // A quit that skips the events above (a signal, a crash in main) still takes the shells.
  process.on('exit', killLocal)
  // With the setting on, the quit waits for the host to end its terminals; off, they keep running.
  let closed = false
  app.on('before-quit', event => {
    if (closed || !closeOnQuit || !hosts || ![...terms.values()].some(one => one.alive && one.backend === hosts)) return
    event.preventDefault()
    closed = true
    void hosts.killAll().finally(() => app.quit())
  })
}

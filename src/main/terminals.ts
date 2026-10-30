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

// Terminals in the IDE's bottom dock. Each is a login shell in a project folder;
// a Claude terminal types `claude --plugin-dir <this app's mod>` into it first,
// so the session reports to the IDE without installing the plugin. The shell
// stays after claude exits, as in any terminal. Other agent CLIs open the same
// way (src/main/agentTerms.ts).

// seq numbers every output chunk, so a view that replays the buffer can skip live chunks it already holds.
// key names the terminal to an agent's MCP server (SWITCHBOARD_TERMINAL); lastOutput and
// paste tell the answer typing whether the CLI waits for input and takes bracketed paste.
// screen: what the terminal shows now (termScreen.ts), for the typing check's menu test.
type Live = TermInfo & { proc: pty.IPty; buffer: string; seq: number; key: string; shell: string; lastOutput: number; paste: boolean; bins: string[]; screen: Screen }

const BUFFER_MAX = 256 * 1024
const terms = new Map<string, Live>()
let seq = 0
// Terminal ids restart at t1 with every app start; the key stays unique across starts,
// so a session left from an earlier run never maps onto a new terminal.
const RUN = randomBytes(3).toString('hex')
const changeListeners = new Set<() => void>()

// What the answer typing (agentDelivery.ts) sees of the terminal with this key.
export function typingTarget(key: string): TypingTarget | undefined {
  const term = [...terms.values()].find(one => one.key === key)
  if (!term) return undefined
  return {
    alive: term.alive,
    shell: term.shell,
    lastOutput: term.lastOutput,
    paste: term.paste,
    // On Windows this is the terminal name, not a program: typingBlock goes by the screen there.
    foreground: term.alive ? term.proc.process : '',
    expect: term.bins,
    screen: term.screen.rows(),
    platform: process.platform,
    write: data => {
      if (term.alive) term.proc.write(data)
    },
  }
}

export function onTerminalsChange(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

const changed = () => {
  for (const listener of changeListeners) listener()
}

// Terminals live in main, so a renderer reload keeps them; quitting the app ends them all.
function killAll(): void {
  for (const t of terms.values()) {
    if (!t.alive) continue
    t.alive = false
    try {
      t.proc.kill()
    } catch {
      // already gone
    }
  }
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
  const key = `${RUN}-${id}`
  const prepared = start.prepare?.(key) ?? {}
  const cols = Math.max(20, start.cols || 100)
  const rows = Math.max(5, start.rows || 30)
  const proc = pty.spawn(shell.file, shell.interactive, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: folder,
    env: {
      ...terminalEnv(process.env, configDir),
      // Local links a CLI opens land in the in-app browser (openUrl.ts), unless the person set their own.
      // Not on Windows: a .js file there may open in Windows Script Host instead of Node.
      ...(browserScript && !process.env.BROWSER && process.platform !== 'win32' ? { BROWSER: browserScript } : {}),
      ...(start.agent ? { SWITCHBOARD_AGENT: start.agent, SWITCHBOARD_TERMINAL: key } : {}),
      ...prepared.env,
    },
  })
  const project = projectName(folder)
  const same = [...terms.values()].filter(one => one.project === project).length
  const title = `${start.title}${same > 0 ? ` ${same + 1}` : ''}`
  const term: Live = {
    id, project, cwd: folder, title, claude: start.claude === true, agent: start.agent, alive: true, exitCode: null,
    proc, buffer: '', seq: 0, key, shell: shell.file, lastOutput: Date.now(), paste: false, bins: start.bins ?? [], screen: createScreen(cols, rows),
  }
  terms.set(id, term)
  proc.onData(data => {
    term.buffer = (term.buffer + data).slice(-BUFFER_MAX)
    term.seq += 1
    term.lastOutput = Date.now()
    term.paste = pasteModeAfter(term.paste, data)
    term.screen.write(data)
    send('term:data', { id, data, seq: term.seq })
  })
  proc.onExit(({ exitCode }) => {
    term.alive = false
    term.exitCode = exitCode
    send('term:exit', { id, exitCode })
    changed()
  })
  if (prepared.line) proc.write(`${prepared.line}\r`)
  changed()
  return info(term)
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
    if (t?.alive) t.proc.write(data)
  })
  ipcMain.on('term:resize', (_e, id: string, cols: number, rows: number) => {
    const t = terms.get(id)
    if (t?.alive && cols > 0 && rows > 0) {
      t.proc.resize(cols, rows)
      t.screen.resize(cols, rows)
    }
  })
  ipcMain.handle('term:close', (_e, id: string) => {
    const t = terms.get(id)
    if (!t) return false
    if (t.alive) t.proc.kill()
    t.screen.dispose()
    terms.delete(id)
    changed()
    return true
  })
  ipcMain.handle('term:pickFolder', async (): Promise<string | null> => {
    const picked = await dialog.showOpenDialog({ properties: ['openDirectory'], title: t('term.pickFolder') })
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  })

  app.on('before-quit', killAll)
  app.on('will-quit', killAll)
  // A quit that skips the events above (a signal, a crash in main) still takes the shells.
  process.on('exit', killAll)
}

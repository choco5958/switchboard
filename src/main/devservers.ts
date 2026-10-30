import { app, BrowserWindow, dialog, type IpcMain } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request as httpGet } from 'node:http'
import { request as httpsGet } from 'node:https'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DevGit, DevResult, DevStatus, DevTarget } from '../shared/types'
import { appendLines, longCommand, portOf, runProblem } from '../shared/devtargets'
import { terminalEnv } from '../shared/projects'
import { killStale, removePid, stopGroup, writePid } from './procgroups'
import { t } from '../shared/i18n'
import { loginShell } from './shell'
import { commandKey, loadApproved, saveApproved } from './approvedCommands'

// Dev servers of the debugging page. The list itself lives in bridge settings
// ('devTargets'); the renderer passes the target to run, this file only keeps
// the processes it started. Each runs in its own process group so stop and quit
// take the whole tree (npm, vite, node ...) down.

type Running = {
  child: ChildProcess
  startedAt: number
  lines: string[]
  rest: string
  exitCode: number | null
  alive: boolean
}

const STOP_WAIT_MS = 4000
// Quitting waits less than a stop button does: a stuck server must not hold the app open.
const QUIT_WAIT_MS = 2000
const PROBE_MS = 1500
const PID_DIR = join(homedir(), '.claude-ide', 'devservers')
const servers = new Map<string, Running>()

function home(path: string): string {
  return path.startsWith('~/') ? homedir() + path.slice(1) : path
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  // Windows has no process groups: taskkill ends the server and what it started.
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined)
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

function run(command: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(command, args, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 60_000 }, (error, stdout, stderr) => {
      const out = [stdout, stderr].map(s => s.trim()).filter(Boolean).join('\n')
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) || 1 : 0, out })
    })
  })
}

function probeHttp(url: string): Promise<boolean> {
  return new Promise(resolve => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      resolve(ok)
    }
    try {
      const get = url.startsWith('https:') ? httpsGet : httpGet
      const req = get(url, { method: 'GET', timeout: PROBE_MS, rejectUnauthorized: false }, res => {
        res.resume()
        finish(true)
      })
      req.on('timeout', () => {
        req.destroy()
        finish(false)
      })
      req.on('error', () => finish(false))
      req.end()
    } catch {
      finish(false)
    }
  })
}

function probePort(url: string): Promise<boolean> {
  const port = portOf(url)
  if (port === null) return Promise.resolve(false)
  let host = '127.0.0.1'
  try {
    host = new URL(url).hostname || host
  } catch {
    // keep the default
  }
  return new Promise(resolve => {
    const socket = connect({ host, port, timeout: PROBE_MS })
    const finish = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function waitExit(one: Running): Promise<void> {
  if (!one.alive) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      killGroup(one.child, 'SIGKILL')
      resolve()
    }, STOP_WAIT_MS)
    one.child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export function registerDevServers(ipcMain: IpcMain, onChange: (event: { id: string }) => void): void {
  // Groups an app that crashed or was killed left running would hold the ports; end them before any start.
  const cleared = killStale(PID_DIR, QUIT_WAIT_MS).catch(() => [])

  const approvedFile = join(homedir(), '.claude-ide', 'approved-commands.json')
  const approved = loadApproved(approvedFile)
  // The person sees the command and its folder and says yes once (approvedCommands.ts).
  const confirmed = async (cwd: string, command: string): Promise<boolean> => {
    const key = commandKey(cwd, command)
    if (approved.has(key)) return true
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      type: 'warning' as const,
      buttons: [t('devMain.confirmRun'), t('common.cancel')],
      defaultId: 1,
      cancelId: 1,
      message: t('devMain.confirmTitle'),
      // The warning comes first: blanks in a long command cannot push it out of sight.
      detail: [longCommand(command) ? t('devMain.confirmLong', { length: command.length }) : '', t('devMain.confirmDetail', { command, path: cwd })].filter(Boolean).join('\n\n'),
    }
    const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (answer.response !== 0) return false
    approved.add(key)
    saveApproved(approvedFile, approved)
    return true
  }

  const start = async (target: DevTarget): Promise<DevResult> => {
    const current = servers.get(target.id)
    if (current?.alive) return { ok: true, out: t('devMain.alreadyUp') }
    const cwd = home(target.repo)
    // A target saved before the form checked these is refused here too.
    const problem = runProblem('repo', target.repo) ?? runProblem('command', target.command)
    if (problem) return { ok: false, out: problem }
    if (!existsSync(cwd)) return { ok: false, out: t('devMain.noRepo', { path: cwd }) }
    if (!(await confirmed(cwd, target.command))) return { ok: false, out: t('devMain.notConfirmed') }
    const shell = loginShell()
    const child = spawn(shell.file, shell.command(target.command), {
      cwd,
      detached: true,
      windowsHide: true,
      // The terminals' environment: nothing of Electron's, Orca's or a parent Claude Code session's.
      env: { ...terminalEnv(process.env), FORCE_COLOR: '0', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const one: Running = { child, startedAt: Date.now(), lines: [`$ ${target.command}`], rest: '', exitCode: null, alive: true }
    servers.set(target.id, one)
    if (child.pid) writePid(PID_DIR, target.id, child.pid)
    const take = (chunk: Buffer) => {
      const next = appendLines(one.lines, one.rest, chunk.toString('utf8'))
      one.lines = next.lines
      one.rest = next.rest
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', error => {
      one.lines = appendLines(one.lines, '', `${t('devMain.runFailed', { error: error.message })}\n`).lines
    })
    child.on('exit', (code, signal) => {
      one.alive = false
      if (servers.get(target.id) === one) removePid(PID_DIR, target.id)
      one.exitCode = code
      if (one.rest) one.lines = appendLines(one.lines, one.rest, '\n').lines
      one.rest = ''
      one.lines = appendLines(one.lines, '', `[${t('devMain.ended', { how: signal ?? t('devMain.code', { code: String(code) }) })}]\n`).lines
      onChange({ id: target.id })
    })
    onChange({ id: target.id })
    return { ok: true, out: `pid ${child.pid ?? '?'}` }
  }

  const stop = async (id: string): Promise<DevResult> => {
    const one = servers.get(id)
    if (!one?.alive) return { ok: true, out: t('devMain.notUp') }
    killGroup(one.child, 'SIGTERM')
    await waitExit(one)
    onChange({ id })
    return { ok: true, out: t('devMain.stopped') }
  }

  ipcMain.handle('dev:start', async (_e, target: DevTarget) => {
    await cleared
    return start(target)
  })
  ipcMain.handle('dev:stop', (_e, id: string) => stop(id))
  ipcMain.handle('dev:restart', async (_e, target: DevTarget) => {
    await cleared
    await stop(target.id)
    return start(target)
  })
  ipcMain.handle('dev:pull', async (_e, repo: string): Promise<DevResult> => {
    const result = await run('git', ['-C', home(repo), 'pull', '--ff-only'])
    return { ok: result.code === 0, out: result.out }
  })
  ipcMain.handle('dev:git', async (_e, repo: string): Promise<DevGit> => {
    const cwd = home(repo)
    if (!existsSync(cwd)) return { ok: false, branch: '', commit: '', subject: '', error: t('devMain.noRepoShort') }
    const branch = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch.code !== 0) return { ok: false, branch: '', commit: '', subject: '', error: branch.out || t('devMain.notRepo') }
    const log = await run('git', ['-C', cwd, 'log', '-1', '--format=%h%x09%s'])
    const [commit = '', subject = ''] = log.out.split('\t')
    return { ok: true, branch: branch.out, commit, subject, error: '' }
  })
  ipcMain.handle('dev:status', async (_e, target: DevTarget): Promise<DevStatus> => {
    const one = servers.get(target.id)
    const [listening, responding] = await Promise.all([probePort(target.url), probeHttp(target.url)])
    return {
      id: target.id,
      running: one?.alive ?? false,
      pid: one?.alive ? (one.child.pid ?? null) : null,
      startedAt: one?.startedAt ?? null,
      exitCode: one?.exitCode ?? null,
      listening,
      responding,
    }
  })
  ipcMain.handle('dev:log', (_e, id: string): string[] => {
    const one = servers.get(id)
    if (!one) return []
    return one.rest ? [...one.lines, one.rest] : one.lines
  })

  // Every child goes with the app: TERM on quit, KILL after QUIT_WAIT_MS or if
  // the process exits first. The quit waits for that, then carries on.
  let quitting = false
  app.on('will-quit', event => {
    const alive = [...servers.values()].filter(one => one.alive && one.child.pid)
    if (quitting || alive.length === 0) return
    quitting = true
    event.preventDefault()
    void Promise.all(alive.map(one => stopGroup(one.child.pid!, QUIT_WAIT_MS))).finally(() => app.quit())
  })
  process.on('exit', () => {
    for (const one of servers.values()) if (one.alive) killGroup(one.child, 'SIGKILL')
  })
}

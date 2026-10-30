// The installed app carries the Node side of Switchboard (bridge, MCP server, mod, the
// switchboard command) under Resources/node, and runs it with its own executable in Node
// mode (ELECTRON_RUN_AS_NODE), so the person needs no Node of their own. Each start copies
// those files to ~/.claude-ide/runtime/<build> (an AppImage's own folder is gone once it
// quits, and the mod writes its types beside itself) and writes the small launchers the
// mod, other CLIs and shells call, pointing at this copy of the app: a moved or updated app
// fixes them by starting once. A run from the repo (pnpm dev) leaves them to `pnpm run setup`.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, win32 } from 'node:path'

export type RuntimeFile = { path: string; content: string; mode: number }

export type RuntimeInput = {
  execPath: string // the app's executable
  root: string // the folder holding bridge/, mcp/, mod/, scripts/ and src/shared/
  home: string
  version: string
  platform?: string
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const cmdLines = (...lines: string[]) => `${['@echo off', ...lines].join('\r\n')}\r\n`

// Paths as the target system writes them, whatever system computes them (the tests).
const pathsOf = (platform: string) => (platform === 'win32' ? win32 : posix)

export function nodeLauncher(home: string, platform: string = process.platform): string {
  return pathsOf(platform).join(home, '.claude-ide', 'bin', platform === 'win32' ? 'switchboard-node.cmd' : 'switchboard-node')
}

export function runtimeFiles(input: RuntimeInput): RuntimeFile[] {
  const platform = input.platform ?? process.platform
  const { join } = pathsOf(platform)
  const dir = join(input.home, '.claude-ide')
  const start = join(input.root, 'bridge', 'start.ts')
  const cli = join(input.root, 'scripts', 'switchboard.ts')
  const env = { ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_VERSION: input.version }
  // What the app, the MCP server and the mod run to start the bridge, with no shell between.
  const startJson: RuntimeFile = { path: join(dir, 'start-bridge.json'), mode: 0o600, content: `${JSON.stringify({ argv: [input.execPath, start], env }, null, 2)}\n` }
  if (platform === 'win32') {
    const exe = `"${input.execPath}"`
    return [
      { path: nodeLauncher(input.home, platform), mode: 0o755, content: cmdLines('set ELECTRON_RUN_AS_NODE=1', `${exe} %*`) },
      startJson,
      { path: join(dir, 'start-bridge.cmd'), mode: 0o755, content: cmdLines('set ELECTRON_RUN_AS_NODE=1', `set SWITCHBOARD_VERSION=${input.version}`, `${exe} "${start}"`) },
      // Not on PATH by itself: the README says to add this folder.
      { path: join(dir, 'bin', 'switchboard.cmd'), mode: 0o755, content: cmdLines('set ELECTRON_RUN_AS_NODE=1', `${exe} "${cli}" %*`) },
    ]
  }
  const node = nodeLauncher(input.home, platform)
  return [
    {
      path: node,
      mode: 0o755,
      content: `#!/bin/sh\n# Written by Switchboard ${input.version}: Node from the app itself (src/main/runtime.ts).\nELECTRON_RUN_AS_NODE=1 exec ${quote(input.execPath)} "$@"\n`,
    },
    startJson,
    {
      path: join(dir, 'start-bridge.sh'),
      mode: 0o755,
      content: `#!/bin/sh\n# Written by Switchboard ${input.version} each time it starts (src/main/runtime.ts).\nSWITCHBOARD_VERSION=${quote(input.version)} exec ${quote(node)} ${quote(start)}\n`,
    },
    { path: join(input.home, '.local', 'bin', 'switchboard'), mode: 0o755, content: `#!/bin/sh\nexec ${quote(node)} ${quote(cli)} "$@"\n` },
  ]
}

export function writeRuntime(input: RuntimeInput): void {
  for (const file of runtimeFiles(input)) {
    mkdirSync(dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.content)
    chmodSync(file.path, file.mode)
  }
  chmodSync(join(input.home, '.claude-ide'), 0o700)
}

// What the Node side is, file by file: two builds of one version with any file changed (a
// rebuild, a test build) differ, so each gets its own copy and replaces the other's bridge.
export function contentHash(dir: string): string {
  const hash = createHash('sha256')
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        hash.update(`${relative(dir, path).split('\\').join('/')}\0`)
        hash.update(readFileSync(path))
        hash.update('\0')
      }
    }
  }
  walk(dir)
  return hash.digest('hex').slice(0, 12)
}

// The name of this build: its version and what its Node side holds (contentHash).
export function buildId(source: string, version: string): string {
  return `${version}-${contentHash(source)}`
}

// The copy of Resources/node for this build, made once; other builds' copies go (pruneRuntimes).
export function copyRuntime(source: string, home: string, build: string): string {
  const base = join(home, '.claude-ide', 'runtime')
  const target = join(base, build)
  if (!existsSync(target)) {
    const partial = `${target}.partial`
    rmSync(partial, { recursive: true, force: true })
    cpSync(source, partial, { recursive: true })
    renameSync(partial, target)
  }
  return target
}

// Other builds' copies, once this one is in use. Each on its own: a file another program
// holds open (Windows) keeps that folder for the next start, and nothing else stops.
// `keep`: builds whose terminal host still runs terminals (termClient.ts hostBuilds). A Claude
// Code started there runs the mod's hooks from that copy, and other CLIs their MCP server.
export function pruneRuntimes(home: string, build: string, keep: Iterable<string> = []): void {
  const base = join(home, '.claude-ide', 'runtime')
  const kept = new Set(keep)
  for (const name of readdirSync(base)) {
    if (name === build || kept.has(name)) continue
    try {
      rmSync(join(base, name), { recursive: true, force: true })
    } catch {
      // Left for the next start.
    }
  }
}

// The bridge a start finds running may be from before an update, or a rebuild of the same
// version: it says its build (SWITCHBOARD_VERSION, buildId), and the app replaces one not its own.
export function staleBridge(health: Record<string, unknown>, build: string): number | null {
  const pid = typeof health.pid === 'number' ? health.pid : null
  return pid !== null && health.version !== build ? pid : null
}

type Run = (file: string, args: string[]) => Promise<string>
const runText: Run = (file, args) =>
  new Promise(resolve => execFile(file, args, { timeout: 3000 }, (error, stdout) => resolve(error ? '' : String(stdout))))

// A bridge from before 0.2.0 says no pid on /health. On macOS and Linux it is the one process
// that holds the bridge's socket file open (clients connect without opening the file) and runs
// bridge/server.ts; anything else is left alone. Windows had no bridge before 0.2.0.
export async function oldBridgePid(socketPath: string, run: Run = runText): Promise<number | null> {
  if (process.platform === 'win32') return null
  const pids = (await run('lsof', ['-t', '--', socketPath])).split('\n').map(Number).filter(n => Number.isInteger(n) && n > 0)
  if (pids.length !== 1) return null
  const command = await run('ps', ['-o', 'command=', '-p', String(pids[0])])
  return /[\\/]bridge[\\/]server\.ts(\s|$)/.test(command.trim()) ? pids[0]! : null
}

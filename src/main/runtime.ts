// The installed app carries the Node side of Switchboard (bridge, MCP server, mod, the
// switchboard command) under Resources/node, and runs it with its own executable in Node
// mode (ELECTRON_RUN_AS_NODE), so the person needs no Node of their own. Each start copies
// those files to ~/.claude-ide/runtime/<version> (an AppImage's own folder is gone once it
// quits, and the mod writes its types beside itself) and writes the small launchers the
// mod, other CLIs and shells call, pointing at this copy of the app: a moved or updated app
// fixes them by starting once. A run from the repo (pnpm dev) leaves them to `pnpm run setup`.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, win32 } from 'node:path'

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

// The copy of Resources/node for this version, made once; other versions' copies go.
export function copyRuntime(source: string, home: string, version: string): string {
  const base = join(home, '.claude-ide', 'runtime')
  const target = join(base, version)
  if (!existsSync(target)) {
    const partial = `${target}.partial`
    rmSync(partial, { recursive: true, force: true })
    cpSync(source, partial, { recursive: true })
    renameSync(partial, target)
  }
  for (const name of readdirSync(base)) if (name !== version) rmSync(join(base, name), { recursive: true, force: true })
  return target
}

// The bridge a start finds running may be from before an update; the app replaces it.
export function staleBridge(health: Record<string, unknown>, version: string): number | null {
  const pid = typeof health.pid === 'number' ? health.pid : null
  return pid !== null && health.version !== version ? pid : null
}

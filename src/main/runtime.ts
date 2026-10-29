// The installed app carries the Node side of Switchboard (bridge, MCP server, mod, the
// switchboard command) under Resources/node, and runs it with its own executable in Node
// mode (ELECTRON_RUN_AS_NODE), so the person needs no Node of their own. Each start copies
// those files to ~/.claude-ide/runtime/<version> (an AppImage's own folder is gone once it
// quits, and the mod writes its types beside itself) and writes the small launchers the
// mod, other CLIs and shells call, pointing at this copy of the app: a moved or updated app
// fixes them by starting once. A run from the repo (pnpm dev) leaves them to `pnpm run setup`.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type RuntimeFile = { path: string; content: string; mode: number }

export type RuntimeInput = {
  execPath: string // the app's executable
  root: string // the folder holding bridge/, mcp/, mod/, scripts/ and src/shared/
  home: string
  version: string
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

export function nodeLauncher(home: string): string {
  return join(home, '.claude-ide', 'bin', 'switchboard-node')
}

export function runtimeFiles(input: RuntimeInput): RuntimeFile[] {
  const node = nodeLauncher(input.home)
  const dir = join(input.home, '.claude-ide')
  return [
    {
      path: node,
      mode: 0o755,
      content: `#!/bin/sh\n# Written by Switchboard ${input.version}: Node from the app itself (src/main/runtime.ts).\nELECTRON_RUN_AS_NODE=1 exec ${quote(input.execPath)} "$@"\n`,
    },
    {
      path: join(dir, 'start-bridge.sh'),
      mode: 0o755,
      content: [
        '#!/bin/sh',
        `# Written by Switchboard ${input.version} each time it starts (src/main/runtime.ts).`,
        'SOCK="${CLAUDE_IDE_SOCKET:-$HOME/.claude-ide/bridge.sock}"',
        'healthy() { curl -sf --max-time 1 --unix-socket "$SOCK" http://bridge/health >/dev/null 2>&1; }',
        'healthy && exit 0',
        `SWITCHBOARD_VERSION=${quote(input.version)} nohup ${quote(node)} ${quote(join(input.root, 'bridge', 'server.ts'))} >> "$HOME/.claude-ide/bridge.log" 2>&1 &`,
        'i=0',
        'while [ $i -lt 30 ]; do',
        '  healthy && exit 0',
        '  sleep 0.1',
        '  i=$((i + 1))',
        'done',
        'echo "bridge did not start; see ~/.claude-ide/bridge.log" >&2',
        'exit 1',
        '',
      ].join('\n'),
    },
    {
      path: join(input.home, '.local', 'bin', 'switchboard'),
      mode: 0o755,
      content: `#!/bin/sh\nexec ${quote(node)} ${quote(join(input.root, 'scripts', 'switchboard.ts'))} "$@"\n`,
    },
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

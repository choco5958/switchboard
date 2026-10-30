import type { McpServer } from '../shared/agents'
import { isAbsolutePath, whereScript } from './shell'

// Pure pieces of opening an agent terminal (agentTerms.ts): finding installed CLIs and
// the MCP server command a terminal's CLI starts.

const MARK = '__switchboard__'

// One login shell that prints where each command is: the same PATH a dock terminal has,
// including what .zshrc adds (nvm, Homebrew).
export function detectScript(bins: readonly string[], platform: string = process.platform): string {
  return whereScript(bins, MARK, platform)
}

export function parseDetect(out: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const at = line.indexOf(MARK)
    if (at === -1) continue
    const [bin, path] = line.slice(at + MARK.length).split(/=(.*)/s)
    // An alias or a shell function prints its definition, not a path.
    if (bin && path && isAbsolutePath(path)) found[bin] = path.trim()
  }
  return found
}

// The first bytes of a native program: Mach-O (both byte orders, 32 and 64 bit, universal) and ELF.
const NATIVE = ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'cafebabf', '7f454c46']

// The program names that mean a terminal's CLI is in front (cliInFront). An npm-installed CLI runs
// as node, so node counts too, unless the command on PATH is a native program (Homebrew's codex,
// goose): then a node in front is something the person started, a REPL, not the CLI. `head`: the
// command file's first bytes, null when it was not found or not read (node then counts).
export function cliBins(command: string, head: Uint8Array | null): string[] {
  const magic = head ? Buffer.from(head.subarray(0, 4)).toString('hex') : ''
  return [command, ...(NATIVE.includes(magic) ? [] : ['node'])].filter(Boolean)
}

// The Node that runs a terminal's MCP server, or null when there is none to use. The installed
// app runs it with its own Node through `launcher` (src/main/runtime.ts). On Windows that
// launcher is a .cmd, which a Node-based CLI cannot start without a shell, so only the
// person's own Node will do there; with none the terminal does not open (agents.noNode)
// instead of opening with a server that never starts.
export function mcpNode(packaged: boolean, platform: string, found: string | null, launcher: string): string | null {
  if (!packaged || platform === 'win32') return found
  return launcher
}

// The server command for one terminal. --socket only when the app runs on a socket of its
// own; flags rather than env vars, because Codex and Copilot pass MCP servers few of them.
export function serverFor(node: string, serverPath: string, agent: string, key: string, socket?: string): McpServer {
  return { command: node, args: [serverPath, '--agent', agent, '--terminal', key, ...(socket ? ['--socket', socket] : [])] }
}

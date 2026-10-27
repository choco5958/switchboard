import type { McpServer } from '../shared/agents'

// Pure pieces of opening an agent terminal (agentTerms.ts): finding installed CLIs and
// the MCP server command a terminal's CLI starts.

const MARK = '__switchboard__'

// One login shell that prints where each command is: the same PATH a dock terminal has,
// including what .zshrc adds (nvm, Homebrew).
export function detectScript(bins: readonly string[]): string {
  return `for c in ${bins.join(' ')}; do printf '${MARK}%s=%s\\n' "$c" "$(command -v "$c" 2>/dev/null)"; done`
}

export function parseDetect(out: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const at = line.indexOf(MARK)
    if (at === -1) continue
    const [bin, path] = line.slice(at + MARK.length).split(/=(.*)/s)
    // An alias or a shell function prints its definition, not a path.
    if (bin && path?.startsWith('/')) found[bin] = path.trim()
  }
  return found
}

// The server command for one terminal. --socket only when the app runs on a socket of its
// own; flags rather than env vars, because Codex and Copilot pass MCP servers few of them.
export function serverFor(node: string, serverPath: string, agent: string, key: string, socket?: string): McpServer {
  return { command: node, args: [serverPath, '--agent', agent, '--terminal', key, ...(socket ? ['--socket', socket] : [])] }
}

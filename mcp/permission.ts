// A CLI's permission hook (mcp/hook.ts) and the MCP server of the same run (mcp/server.ts)
// talk over a local socket: the hook sends what the CLI is about to ask, the server posts it to
// the bridge like the mod's tool.check hook does and sends the person's answer back. The
// session's token stays in the server; the hook proves it belongs to the run with the
// terminal's key (SWITCHBOARD_TERMINAL, 128 random bits), which the CLI hands its hooks.
// docs/에이전트-기능-맞추기.md has the design.

import { createHash, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { approvalSummary } from '../mod/hooks/batch.ts'

export type HookAsk = { tool: string; summary: string; complete: boolean; cwd: string; reason: string; requestKey: string }
// 'ask': nothing decided, and the CLI asks in its terminal as it would without the hook.
export type HookAnswer = { answer: 'allow' | 'deny' | 'ask'; message: string }
export type HookRequest = { terminal: string; ask: HookAsk }

export const PASS: HookAnswer = { answer: 'ask', message: '' }

type Json = Record<string, unknown>
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const object = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

// Where the server of the terminal listens. The name is a hash, so the key stays out of it. Under
// the person's own ~/.claude-ide (0700), never a shared folder another user could take the name in;
// a HOME long enough to pass the socket path limit (about 104 bytes) gets no relay.
export function hookSocket(home: string, terminal: string, platform: string = process.platform): string {
  const name = digest(terminal).slice(0, 16)
  return platform === 'win32' ? `\\\\.\\pipe\\switchboard-hook-${name}` : join(home, '.claude-ide', 'agents', `h-${name}.sock`)
}

export function sameTerminal(a: string, b: string): boolean {
  return a !== '' && timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)))
}

export type HookAdapter = {
  // What the CLI is about to ask, or null when the ask is never answered away from the terminal.
  ask: (input: Json) => HookAsk | null
  // What the hook prints for an answer: '' prints nothing, and the CLI asks in its terminal.
  reply: (answer: HookAnswer) => string
}

// Codex's PermissionRequest hook (Codex 0.166, learn.chatgpt.com/docs/hooks). A command Codex asks
// about would run outside its sandbox, and those are asked in the terminal only, as for Claude
// Code (mod/hooks/batch.ts approvalSummary): what goes away is file changes and MCP tool calls.
const codex: HookAdapter = {
  ask: input => {
    if (input.hook_event_name !== 'PermissionRequest') return null
    const tool = text(input.tool_name)
    if (!tool || tool === 'Bash') return null
    const toolInput = object(input.tool_input)
    const shown = approvalSummary(tool, toolInput)
    return {
      tool,
      summary: shown.summary,
      complete: shown.complete,
      cwd: text(input.cwd),
      reason: text(toolInput.description).slice(0, 500),
      // The same call asked again finds the same ask (bridge POST /approvals).
      requestKey: `${text(input.turn_id)}:${digest(`${tool}\n${JSON.stringify(toolInput)}`).slice(0, 24)}`,
    }
  },
  reply: answer => {
    if (answer.answer === 'ask') return ''
    const decision = answer.answer === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: answer.message }
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
  },
}

export const ADAPTERS: Record<string, HookAdapter> = { codex }

// The hook's wait, a little under the timeout the CLI is given for it (shared/agents.ts), so the
// hook always ends by itself and the CLI asks in its terminal.
export const HOOK_WAIT_MS = 6 * 3600_000

// A CLI's permission hook (mcp/hook.ts) and the MCP server of the same run (mcp/server.ts)
// talk over a local socket: the hook sends what the CLI is about to ask, the server posts it to
// the bridge like the mod's tool.check hook does and sends the person's answer back. The
// session's token stays in the server; the hook proves it belongs to the run with the
// terminal's key (SWITCHBOARD_TERMINAL, 128 random bits), which the CLI hands its hooks.
// docs/에이전트-기능-맞추기.md has the design.

import { createHash, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { approvalSummary, approvalText } from '../mod/hooks/batch.ts'

export type HookAsk = { tool: string; summary: string; complete: boolean; cwd: string; reason: string; requestKey: string }
// 'ask': nothing decided, and the CLI asks in its terminal as it would without the hook.
export type HookAnswer = { answer: 'allow' | 'deny' | 'ask'; message: string }
// What else a CLI's hooks tell the run's server (docs/에이전트-대등하게.md): a turn starts (the
// person's prompt went in), a tool starts or ends, a turn ends with its last answer (`answer`, or
// the CLI's transcript to read it from).
export type HookEvent =
  | { kind: 'turnStart' }
  | { kind: 'toolStart' }
  | { kind: 'toolEnd' }
  | { kind: 'turnEnd'; answer: string; transcript?: string; aborted?: boolean }
// The server's answer to an event: text to add to the prompt the turn starts with, if any.
export type HookEventReply = { context?: string }
export type HookRequest = { terminal: string; ask?: HookAsk; event?: HookEvent }

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
  // Another event of the CLI's, or null for one the server does not follow.
  event?: (input: Json) => HookEvent | null
  // What the hook prints after an event ('' for nothing): the context a turn starts with, where
  // the CLI takes some.
  eventReply?: (event: HookEvent, reply: HookEventReply) => string
}

// Claude Code's hook names, which Codex and Qwen use too: the person's prompt, a tool's start and
// end, and the end of the turn with its last answer (learn.chatgpt.com/docs/hooks; Qwen Code 0.26.7,
// tested).
function claudeStyleEvent(input: Json): HookEvent | null {
  const name = text(input.hook_event_name)
  if (name === 'UserPromptSubmit') return { kind: 'turnStart' }
  if (name === 'PreToolUse') return { kind: 'toolStart' }
  if (name === 'PostToolUse' || name === 'PostToolUseFailure') return { kind: 'toolEnd' }
  if (name === 'Stop') return { kind: 'turnEnd', answer: text(input.last_assistant_message) }
  return null
}

// Added context for the prompt, in the hook output Codex and Qwen read for UserPromptSubmit.
function claudeStyleContext(event: HookEvent, reply: HookEventReply): string {
  if (event.kind !== 'turnStart' || !reply.context) return ''
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: reply.context } })
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
  event: claudeStyleEvent,
  eventReply: claudeStyleContext,
}

// A summary only from the fields it shows: an input with any other field (one that could change
// what the call does) is shown whole, as JSON.
function shown(input: Json, keys: string[], summary: () => string): { summary: string; complete: boolean } {
  return Object.keys(input).every(key => keys.includes(key)) ? approvalText(summary()) : approvalText(JSON.stringify(input, null, 1))
}

// Qwen Code's PermissionRequest hook (Qwen Code 0.26, docs/users/features/hooks.md): the same
// input and output as Codex's, with Qwen's tool ids. Qwen runs commands on the machine as Claude
// Code does without a sandbox, so a command is answered away like Claude Code's Bash.
const qwen: HookAdapter = {
  ask: input => {
    if (input.hook_event_name !== 'PermissionRequest') return null
    const tool = text(input.tool_name)
    if (!tool) return null
    const v = object(input.tool_input)
    const about = text(v.description).replace(/\s+/g, ' ').trim().slice(0, 200)
    const view =
      tool === 'run_shell_command'
        ? shown(v, ['command', 'description'], () => (about ? `${text(v.command)}\n# ${about}` : text(v.command)))
        : tool === 'write_file'
          ? shown(v, ['file_path', 'content'], () => `${text(v.file_path)}\n${text(v.content)}`)
          : tool === 'edit'
            ? shown(v, ['file_path', 'old_string', 'new_string'], () => `${text(v.file_path)}\n- ${text(v.old_string)}\n+ ${text(v.new_string)}`)
            : approvalSummary(tool, v)
    return {
      tool,
      summary: view.summary,
      complete: view.complete,
      cwd: text(input.cwd),
      reason: '',
      requestKey: `${text(input.prompt_id) || text(input.session_id)}:${digest(`${tool}\n${JSON.stringify(v)}`).slice(0, 24)}`,
    }
  },
  reply: codex.reply,
  event: claudeStyleEvent,
  eventReply: claudeStyleContext,
}

// Copilot CLI's permissionRequest hook (1.0.105, tested; output in
// docs.github.com/en/copilot/reference/hooks-configuration). A new file and a change both come as
// `edit` with the file and a diff, a command as `bash` with its whole script. Without Copilot's
// sandbox a command runs on the machine as Claude Code's Bash does, and one allow also covers the
// paths outside the folder it names, so it is answered away whole. A command asking to leave the
// sandbox (requestSandboxBypass) cannot be allowed by a hook: the terminal asks. Copilot gives no
// turn id, so the ask's time keeps two runs of one command apart.
const copilot: HookAdapter = {
  ask: input => {
    if (input.hookName !== 'permissionRequest') return null
    const tool = text(input.toolName)
    if (!tool) return null
    const v = object(input.toolInput)
    const view =
      tool === 'bash'
        ? shown(v, ['command'], () => text(v.command))
        : tool === 'edit'
          ? shown(v, ['file_path', 'diff'], () => `${text(v.file_path)}\n${text(v.diff).replace(/^\n+/, '')}`)
          : approvalSummary(tool, v)
    return {
      tool,
      summary: view.summary,
      complete: view.complete && v.requestSandboxBypass !== true,
      cwd: text(input.cwd),
      reason: '',
      requestKey: `${text(input.sessionId)}:${String(input.timestamp ?? '')}:${digest(`${tool}\n${JSON.stringify(v)}`).slice(0, 24)}`,
    }
  },
  reply: answer => {
    if (answer.answer === 'ask') return ''
    return JSON.stringify(answer.answer === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: answer.message })
  },
  // Copilot's own names (1.0.105, tested). agentStop gives no answer, only the session's event log
  // (its last assistant.message, copilotAnswer below). userPromptSubmitted takes no added context.
  event: input => {
    const name = text(input.hookName)
    if (name === 'userPromptSubmitted') return { kind: 'turnStart' }
    if (name === 'preToolUse') return { kind: 'toolStart' }
    if (name === 'postToolUse' || name === 'postToolUseFailure') return { kind: 'toolEnd' }
    if (name === 'agentStop') return { kind: 'turnEnd', answer: '', transcript: text(input.transcriptPath), aborted: text(input.stopReason) === 'abort' }
    return null
  },
}

// The last answer in a Copilot session's event log (session-state/<id>/events.jsonl): the text of
// its last assistant.message that has some, after the person's last message ('' when the turn's
// answer is not in the file yet, never an earlier turn's). Only the end of a long log is read.
export function copilotAnswer(log: string): string {
  const lines = log.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i] ?? '') as { type?: unknown; data?: { content?: unknown } }
      if (entry.type === 'user.message') return ''
      if (entry.type === 'assistant.message' && typeof entry.data?.content === 'string' && entry.data.content.trim()) return entry.data.content
    } catch {
      // a line cut at the start of what was read, or not JSON
    }
  }
  return ''
}

// The bash commands Crush runs without asking (internal/agent/tools/safe.go, 0.99): one with no
// chaining that starts with one of these. They are not sent away, as Crush would not ask about them.
const CRUSH_SAFE = [
  'cal', 'date', 'df', 'du', 'echo', 'env', 'free', 'groups', 'hostname', 'id', 'kill', 'killall', 'ls', 'nice', 'nohup',
  'printenv', 'ps', 'pwd', 'set', 'time', 'timeout', 'top', 'type', 'uname', 'unset', 'uptime', 'whatis', 'whereis', 'which',
  'whoami', 'git blame', 'git branch', 'git config --get', 'git config --list', 'git describe', 'git diff', 'git grep', 'git log',
  'git ls-files', 'git ls-remote', 'git remote', 'git rev-parse', 'git shortlog', 'git show', 'git status', 'git tag',
]
export function crushSafe(command: string): boolean {
  if ([';', '|', '&&', '$(', '`'].some(c => command.includes(c))) return false
  const lower = command.toLowerCase()
  return CRUSH_SAFE.some(safe => lower.startsWith(safe) && (lower.length === safe.length || lower[safe.length] === ' ' || lower[safe.length] === '-'))
}

// Crush's hooks (0.99, docs/hooks): its PermissionRequest only watches, so the ask goes away from
// PreToolUse, which runs before Crush's own check and whose allow skips Crush's prompt. Only what
// Crush asks about is sent: a command not on its list above and a file change. A tool the person
// allowed in their own config (allowed_tools) is asked about here as well. Crush runs commands on
// the machine as Claude Code's Bash does, so a command is answered away whole.
const crush: HookAdapter = {
  ask: input => {
    if (input.hook_event_name !== 'PreToolUse') return null
    const tool = text(input.tool_name)
    const v = object(input.tool_input)
    const edit = (e: Json) => `- ${text(e.old_string)}\n+ ${text(e.new_string)}`
    const edits = Array.isArray(v.edits) ? v.edits.map(object) : []
    const view =
      tool === 'bash'
        ? crushSafe(text(v.command))
          ? null
          : shown(v, ['command', 'description', 'working_dir', 'run_in_background', 'auto_background_after'], () =>
              [text(v.command), ...(text(v.working_dir) ? [`# in ${text(v.working_dir)}`] : []), ...(text(v.description) ? [`# ${text(v.description)}`] : [])].join('\n'),
            )
        : tool === 'write'
          ? shown(v, ['file_path', 'content'], () => `${text(v.file_path)}\n${text(v.content)}`)
          : tool === 'edit'
            ? shown(v, ['file_path', 'old_string', 'new_string', 'replace_all'], () => `${text(v.file_path)}${v.replace_all === true ? ' (all)' : ''}\n${edit(v)}`)
            : tool === 'multiedit' && edits.every(e => Object.keys(e).every(key => ['old_string', 'new_string', 'replace_all'].includes(key)))
              ? shown(v, ['file_path', 'edits'], () => [text(v.file_path), ...edits.map(e => `${e.replace_all === true ? '(all)\n' : ''}${edit(e)}`)].join('\n'))
              : tool === 'multiedit'
                ? approvalText(JSON.stringify(v, null, 1))
                : null
    if (!view) return null
    return {
      tool,
      summary: view.summary,
      complete: view.complete,
      cwd: text(input.cwd),
      reason: '',
      // Crush calls the hook once a call; a model that gives every call the same id (some local
      // ones do) must not find an earlier answer, so the time keeps two asks apart.
      requestKey: `${text(input.session_id)}:${text(input.tool_use_id)}:${Date.now()}`,
    }
  },
  reply: answer => {
    if (answer.answer === 'ask') return ''
    return JSON.stringify(answer.answer === 'allow' ? { decision: 'allow' } : { decision: 'deny', reason: answer.message })
  },
  // One of TurnEnd, Interrupt and StopFailure ends each turn (internal/agent/turn_hooks.go). Its
  // TurnStart takes no added context.
  event: input => {
    const name = text(input.hook_event_name)
    if (name === 'TurnStart') return { kind: 'turnStart' }
    if (name === 'PreToolUse') return { kind: 'toolStart' }
    if (name === 'PostToolUse' || name === 'PostToolUseFailure') return { kind: 'toolEnd' }
    if (name === 'TurnEnd') return { kind: 'turnEnd', answer: text(input.last_assistant_message) }
    if (name === 'Interrupt') return { kind: 'turnEnd', answer: '', aborted: true }
    if (name === 'StopFailure') return { kind: 'turnEnd', answer: '' }
    return null
  },
}

export const ADAPTERS: Record<string, HookAdapter> = { codex, qwen, copilot, crush }

// An ask of OpenCode 2 (its permission.asked event: packages/schema/src/permission.ts), which the
// run's plugin (mcp/opencode/server.ts) sends here. A file change carries a diff of each file
// (metadata.files[].patch, as OpenCode 2.2.5 sends a new file; the patch tool also sends them
// joined in metadata.diff), shown as it is. A command's ask names only the commands it found in the script, not the script with its
// folder, so the person could not see what runs: commands are asked in the terminal only.
export function opencodeAsk(request: Json): HookAsk | null {
  const action = text(request.action)
  const id = text(request.id)
  if (!action || !id) return null
  const resources = Array.isArray(request.resources) ? request.resources.map(text) : []
  const metadata = object(request.metadata)
  const files = Array.isArray(metadata.files) ? metadata.files.map(object) : []
  const patches = files.length > 0 && files.every(file => typeof file.patch === 'string') ? files.map(file => text(file.patch)).join('') : ''
  const diff = patches || text(metadata.diff)
  const view =
    action === 'shell' || action === 'bash'
      ? approvalText(resources.join('\n'), false)
      : action === 'edit' && diff
        ? approvalText(diff)
        : approvalText(JSON.stringify({ action, resources, metadata }, null, 1))
  return { tool: action, summary: view.summary, complete: view.complete, cwd: '', reason: '', requestKey: `${text(request.sessionID)}:${id}` }
}

// The hook's wait, a little under the timeout the CLI is given for it (shared/agents.ts), so the
// hook always ends by itself and the CLI asks in its terminal.
export const HOOK_WAIT_MS = 6 * 3600_000

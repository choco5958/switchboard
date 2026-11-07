// Switchboard MCP server: connects an agent CLI other than Claude Code (Codex,
// Gemini, ...) to the bridge with the same tools the mod gives Claude Code, plus
// check_answers for answers the app could not type into the session itself.
// stdio, newline-delimited JSON-RPC 2.0. Run with Node 24: node mcp/server.ts --agent codex
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { closeSync, fstatSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { createInterface } from 'node:readline'
import { SESSION_HEADER, requestTarget, resolveEndpoint, startCommand, usesTcp } from '../bridge/endpoint.ts'
import { pendingLine, takenText } from '../mod/hooks/batch.ts'
import { langFromLocale, langOfState, osLocale, t, type Key, type Lang, type Vars } from '../mod/hooks/i18n.ts'
import { waitApproval } from '../mod/hooks/approval.ts'
import { codexArgv, watchCodexUsage } from './codexUsage.ts'
import { HOOK_WAIT_MS, PASS, copilotAnswer, hookSocket, sameTerminal, type HookAnswer, type HookAsk, type HookEvent, type HookEventReply, type HookRequest } from './permission.ts'
import { BROWSER_TOOLS, cancelText, delegatedText, openBody, openResultText, openToolDef, peersText, sentText, toolDefs, worktreeRoot, type Peer, type ToolDef } from '../mod/hooks/tools.ts'

export { takenText }

export const SERVER_NAME = 'switchboard'
const VERSION = '0.3.26'
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
// How often the session tells the bridge it is still there.
const SEEN_MS = 20_000
const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'

// `cli`: the agent CLI's own program, for what the server asks it (Codex's usage, codexUsage.ts).
// `abilities`: what the run's hooks and plugins add beyond the tools, as the app attached them
// (src/main/agentTerms.ts); the bridge goes by these (bridge/server.ts ABILITIES).
// `appOnly`: a server every run of the CLI starts (Gemini's extension, src/main/geminiExtension.ts),
// which does something only in a run the app opened through it (a terminal key, and
// SWITCHBOARD_EXTENSION, shared/agents.ts EXTENSION_RUN_ENV).
export type Options = { agent: string; terminal: string; cwd: string; socket: string; home: string; cli: string; abilities: string[]; appOnly?: boolean; extensionRun?: boolean }

// Flags first, since some CLIs pass MCP servers only a few env vars; env vars second.
export function parseOptions(argv: readonly string[], env: Record<string, string | undefined>, cwd: string): Options {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const home = env.HOME || homedir()
  return {
    agent: (flag('agent') || env.SWITCHBOARD_AGENT || 'mcp').toLowerCase(),
    terminal: flag('terminal') || env.SWITCHBOARD_TERMINAL || '',
    cwd: flag('cwd') || cwd,
    cli: flag('cli') || '',
    abilities: (flag('abilities') || env.SWITCHBOARD_ABILITIES || '').split(',').filter(Boolean),
    appOnly: argv.includes('--app-only'),
    extensionRun: env.SWITCHBOARD_EXTENSION === '1',
    // Empty: Windows, where the bridge is on TCP and each call reads where (bridge/endpoint.ts).
    socket: flag('socket') || env.CLAUDE_IDE_SOCKET || (usesTcp(env) ? '' : join(home, '.claude-ide', 'bridge.sock')),
    home,
  }
}

// What the model reads besides the mod's own tool texts: Korean for ko, English otherwise, as in tools.ts.
const KO = {
  instead: ['AskUserQuestion 대신 쓴다', '대화창에서 묻는 대신 쓴다'],
  outside:
    ' Switchboard 앱의 터미널에서 돌 때는 답이 이 세션에 프롬프트로 입력된다. 앱 밖에서 돌 때는 답이 저절로 들어오지 않으니, ' +
    '하던 일을 마쳤거나 답이 필요해지면 check_answers를 불러 확인한다.',
  check:
    'Switchboard에서 이 세션 앞으로 온 것 가운데 아직 전달되지 않은 것(ask_decision 질문의 답, IDE에서 보낸 메시지, 진행 보고 요청)을 받아 오고, ' +
    '받은 것은 전달됨으로 표시한다. Switchboard 앱의 터미널에서 돌 때는 답이 프롬프트로 저절로 입력되므로 보통 부를 필요가 없다. ' +
    '앱 밖에서 돌 때는 ask_decision으로 질문한 뒤, 하던 일을 마쳤을 때나 답이 필요할 때 부른다.',
  instructions:
    '이 서버는 세션을 Switchboard(여러 코딩 에이전트 세션을 한 화면에서 보는 앱)에 연결한다. 작업을 시작하면 set_task로 올리고, ' +
    '계획은 plan_nodes, 진행은 update_node로 알린다. 사람의 결정이 필요하면 대화창에서 묻는 대신 ask_decision으로 올리고 다른 일을 계속한다.',
}

const EN: typeof KO = {
  instead: ['Use it instead of AskUserQuestion.', 'Use it instead of asking in the chat.'],
  outside:
    ' When this session runs in a Switchboard app terminal, the answer is typed into it as a prompt. When it runs outside the app, ' +
    'answers do not come in by themselves: call check_answers when you finish what you are doing or need the answer.',
  check:
    'Fetches what Switchboard has for this session that was not delivered yet (answers to ask_decision questions, messages from the IDE, ' +
    'progress report requests) and marks it delivered. In a Switchboard app terminal answers are typed in as prompts, so this is rarely needed. ' +
    'Outside the app, call it after ask_decision when you finish what you are doing or need the answer.',
  instructions:
    'This server connects the session to Switchboard, an app that shows several coding agent sessions on one screen. Post a task with set_task ' +
    'when you start, the plan with plan_nodes and progress with update_node. When a person must decide, post it with ask_decision instead of ' +
    'asking in the chat, and carry on with other work.',
}

const textOf = (lang: Lang) => (lang === 'ko' ? KO : EN)

// The mod's tool definitions in the bridge's language, said for any CLI, plus check_answers.
export function mcpTools(lang: Lang): ToolDef[] {
  const x = textOf(lang)
  const tools = [...toolDefs(lang), openToolDef(lang, 'open_in_ide')]
  return [
    ...tools.map(tool => (tool.name === 'ask_decision' ? { ...tool, description: tool.description.replace(x.instead[0]!, x.instead[1]!) + x.outside } : tool)),
    { name: 'check_answers', description: x.check, inputSchema: { type: 'object', properties: {} } },
  ]
}

export type Reply = { ok: boolean; status: number; json: Record<string, unknown> }
type Run = (argv: string[], cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>

export type Deps = {
  // `headers`: the session's token (SESSION_HEADER) once the bridge gave it one.
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Reply>
  startBridge: () => Promise<boolean>
  run: Run
  log: (line: string) => void
}

export function bridgeCall(socket: string): Deps['call'] {
  return (method, path, body, headers = {}) =>
    new Promise(resolve => {
      const target = requestTarget(socket ? { kind: 'socket', path: socket } : resolveEndpoint())
      const req = request({ ...target, method, path, headers: { ...target.headers, ...headers, 'content-type': 'application/json' } }, res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => (text += chunk))
        res.on('end', () => {
          let json: Record<string, unknown> = {}
          try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
          } catch {
            json = { error: text }
          }
          const status = res.statusCode ?? 0
          resolve({ ok: status >= 200 && status < 300, status, json })
        })
      })
      req.on('error', error => resolve({ ok: false, status: 0, json: { error: error.message } }))
      if (body !== undefined) req.write(JSON.stringify(body))
      req.end()
    })
}

const runCommand = (argv: string[], cwd?: string, env?: Record<string, string>): ReturnType<Run> =>
  new Promise(resolve => {
    execFile(argv[0]!, argv.slice(1), { cwd, env: env ? { ...process.env, ...env } : undefined, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) || 1 : 0, stdout, stderr }),
    )
  })

type Json = Record<string, unknown>
type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json }
type Response = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function createSession(options: Options, deps: Deps) {
  const sessionId = randomUUID()
  // What the bridge handed over at registration: this session's own routes answer only with it,
  // so another program that learns the id cannot take its answers. Kept in memory only.
  let token = ''
  const own = (): Record<string, string> => (token ? { [SESSION_HEADER]: token } : {})
  let registered: Promise<boolean> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  // The bridge's `lang` setting, read at registration and with every heartbeat.
  let lang: Lang = langFromLocale(osLocale())
  const say = (key: Key, vars?: Vars) => t(lang, key, vars)

  const readLang = async () => {
    const state = await deps.call('GET', '/state')
    if (state.ok) lang = langOfState(state.json)
  }

  const register = async (): Promise<boolean> => {
    // `token`: made with the session's row (a new database makes it anew) and handed over once.
    const body = { id: sessionId, cwd: options.cwd, agent: options.agent, terminal: options.terminal, token: true, abilities: options.abilities }
    let reply = await deps.call('POST', '/sessions', body, own())
    if (reply.status === 0 && (await deps.startBridge())) reply = await deps.call('POST', '/sessions', body, own())
    if (!reply.ok) deps.log(say('mcp.registerFailed', { error: String(reply.json.error ?? reply.status) }))
    else {
      if (typeof reply.json.token === 'string' && reply.json.token) token = reply.json.token
      await readLang()
    }
    return reply.ok
  }

  const ready = (): Promise<boolean> => {
    registered ??= register().then(ok => {
      if (!ok) registered = null
      return ok
    })
    return registered
  }

  // A bridge that went away is started again and learns the session anew; so is one
  // that answers 404 for this session (a new database).
  const call = async (method: string, path: string, body?: unknown): Promise<Reply> => {
    await ready()
    const reply = await deps.call(method, path, body, own())
    if (reply.status !== 0 && !(reply.status === 404 && path === '/deliveries/take')) return reply
    registered = null
    if (!(await ready())) return reply
    return deps.call(method, path, body, own())
  }

  const seen = async () => {
    const reply = await deps.call('POST', '/sessions/seen', { sessionId }, own())
    if (!reply.ok) {
      registered = null
      await ready()
    } else await readLang()
  }

  const errorText = (reply: Reply) => String(reply.json.error ?? reply.status)

  async function createWorktree(task: string, key: string, base?: string, repo?: string): Promise<string> {
    const found = await worktreeRoot(async (argv, cwd) => (await deps.run(argv, cwd)).stdout, options.cwd, repo, base)
    if ('refused' in found) return say(found.refused, found.vars)
    const { root } = found
    const orca = async (args: string[]): Promise<Json> => {
      const ran = await deps.run(['sh', '-c', `exec "$(command -v orca || echo ${ORCA})" "$@"`, 'orca', ...args, '--json'])
      try {
        return JSON.parse(ran.stdout) as Json
      } catch {
        return { ok: false, error: { message: ran.stderr || ran.stdout || `exit ${ran.code}` } }
      }
    }
    const errorOf = (reply: Json) => {
      const error = reply.error as { code?: string; message?: string } | undefined
      return error?.message ?? error?.code ?? 'unknown error'
    }
    const listed = await orca(['worktree', 'list', '--repo', `path:${root}`, '--limit', '1'])
    if (listed.ok !== true) {
      const added = await orca(['repo', 'add', '--path', root])
      if (added.ok !== true) return say('wt.repoAddFailed', { error: errorOf(added) })
    }
    const slug = key.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'node'
    const name = `${slug}-${Date.now().toString(36).slice(-4)}`
    const args = ['worktree', 'create', '--repo', `path:${root}`, '--name', name, '--comment', `Switchboard: ${task} / ${key}`]
    if (base) args.push('--base-branch', base)
    const created = await orca(args)
    const worktree = (created.result as { worktree?: { path?: string; branch?: string } } | undefined)?.worktree
    if (created.ok !== true || !worktree?.path) return say('wt.createFailed', { error: errorOf(created) })
    const branch = (worktree.branch ?? '').replace(/^refs\/heads\//, '')
    const saved = await call('POST', '/nodes/worktree', { sessionId, taskTitle: task, key, worktree: worktree.path, branch })
    const note = saved.ok ? '' : say('wt.saveFailed', { error: String(saved.json.error) })
    return say('wt.created', { note, path: worktree.path, branch })
  }

  // What a tool call returns to the agent: its text, and whether it failed. The texts are the mod's.
  async function callTool(name: string, a: Json): Promise<{ text: string; isError?: boolean }> {
    // One key per tool call: call() sends it again after a lost connection, and the bridge
    // gives a request it already stored back instead of storing it twice.
    const requestKey = randomUUID()
    if (name === 'ask_decision') {
      const reply = await call('POST', '/questions', {
        sessionId,
        taskTitle: a.task,
        question: a.question,
        body: a.body,
        options: a.options,
        recommend: a.recommend,
        reason: a.reason,
        requestKey,
      })
      if (!reply.ok) return { text: say('mcp.askFailed', { error: errorText(reply) }), isError: true }
      return { text: `${say(reply.json.duplicate ? 'tool.askedAgain' : 'tool.asked', { id: String(reply.json.id) })} ${say(options.terminal ? 'mcp.askInside' : 'mcp.askOutside')}` }
    }
    if (BROWSER_TOOLS[name]) {
      const reply = await call('POST', '/browser/act', { sessionId, action: BROWSER_TOOLS[name], args: a })
      if (!reply.ok) return { text: say('tool.browserFailed', { error: errorText(reply) }), isError: true }
      return { text: String(reply.json.text ?? '') }
    }
    if (name === 'list_sessions') {
      const reply = await call('GET', `/sessions/peers?session=${encodeURIComponent(sessionId)}`)
      if (!reply.ok) return { text: say('tool.sendFailed', { error: errorText(reply) }), isError: true }
      return { text: peersText((reply.json.peers ?? []) as Peer[], lang) }
    }
    if (name === 'send_to_session') {
      const expectsReply = !a.replyTo && a.expectsReply !== false
      const reply = await call('POST', '/messages', { sessionId, to: a.to, text: a.text, replyTo: a.replyTo, expectsReply, requestKey })
      if (!reply.ok) return { text: say('tool.sendFailed', { error: errorText(reply) }), isError: true }
      return { text: sentText(reply.json, expectsReply, lang) }
    }
    if (name === 'delegate') {
      const reply = await call('POST', '/delegations', { sessionId, agent: a.agent, task: a.task, requestKey })
      if (!reply.ok) return { text: say('tool.delegateFailed', { error: errorText(reply) }), isError: true }
      return { text: delegatedText(reply.json, String(a.agent ?? ''), lang) }
    }
    if (name === 'cancel_request') {
      const reply = await call('POST', '/messages/cancel', { sessionId, ids: a.ids, reason: a.reason })
      if (!reply.ok) return { text: say('tool.cancelFailed', { error: errorText(reply) }), isError: true }
      return { text: cancelText(reply.json, lang) }
    }
    if (name === 'routine_no_update' || name === 'routine_report_failure' || name === 'await_event' || name === 'close_wait') {
      const waitId = String(a.id ?? '').replace(/^w/, '')
      // The id goes into the path: digits only, so it can name no other route.
      if (name === 'close_wait' && !/^\d+$/.test(waitId)) return { text: say('tool.sendFailed', { error: `bad wait id: ${String(a.id)}` }), isError: true }
      const [path, body, done] =
        name === 'routine_no_update'
          ? ['/routines/report', { sessionId, kind: 'quiet' }, () => say('tool.quietOk')]
          : name === 'routine_report_failure'
            ? ['/routines/report', { sessionId, kind: 'failed', reason: a.reason }, () => say('tool.failureOk')]
            : name === 'await_event'
              ? ['/waits', { sessionId, note: a.note }, (json: Record<string, unknown>) => say('tool.waitOpened', { id: String(json.id) })]
              : [`/waits/${waitId}/close`, { sessionId }, () => say('tool.waitClosed', { id: `w${waitId}` })]
      const reply = await call('POST', path as string, body)
      if (!reply.ok) return { text: say('tool.sendFailed', { error: errorText(reply) }), isError: true }
      return { text: (done as (json: Record<string, unknown>) => string)(reply.json) }
    }
    if (name === 'set_task') {
      const fields = ['title', 'stage', 'status', 'now', 'why', 'what', 'result', 'artifact', 'tests', 'branch']
      const reply = await call('POST', '/tasks', { sessionId, ...Object.fromEntries(fields.map(f => [f, a[f]])) })
      if (!reply.ok) return { text: say('tool.taskFailed', { error: errorText(reply) }), isError: true }
      return { text: say('tool.taskDone', { title: text(a.title) }) }
    }
    if (name === 'plan_nodes') {
      const reply = await call('POST', '/nodes', { sessionId, taskTitle: a.task, nodes: a.nodes })
      if (!reply.ok) return { text: say('tool.planFailed', { error: errorText(reply) }), isError: true }
      return { text: say('tool.planDone', { n: String(reply.json.count) }) }
    }
    if (name === 'update_node') {
      const reply = await call('POST', '/nodes/status', { sessionId, taskTitle: a.task, key: a.key, status: a.status, note: a.note })
      if (!reply.ok) return { text: say('tool.nodeFailed', { error: errorText(reply) }), isError: true }
      return { text: say('tool.nodeDone', { key: text(a.key), status: text(a.status), round: String(reply.json.round) }) }
    }
    if (name === 'node_worktree') {
      const optional = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
      return { text: await createWorktree(text(a.task), text(a.key), optional(a.base), optional(a.repo)) }
    }
    if (name === 'open_in_ide') {
      const reply = await call('POST', '/dev/open', openBody(a, sessionId, options.cwd))
      return { text: openResultText(reply, lang), isError: !reply.ok }
    }
    if (name === 'check_answers') {
      const reply = await call('POST', '/deliveries/take', { sessionId })
      if (!reply.ok) return { text: say('mcp.checkFailed', { error: errorText(reply) }), isError: true }
      return { text: takenText(reply.json, lang) || say('mcp.nothing') }
    }
    return { text: say('mcp.unknownTool', { name }), isError: true }
  }

  async function handle(message: Message): Promise<Response | undefined> {
    const id = message.id ?? null
    const isRequest = message.id !== undefined && message.id !== null
    const ok = (result: unknown): Response | undefined => (isRequest ? { jsonrpc: '2.0', id, result } : undefined)
    const error = (code: number, text: string): Response | undefined =>
      isRequest ? { jsonrpc: '2.0', id, error: { code, message: text } } : undefined
    // A message without a method is no request at all (JSON-RPC 2.0: Invalid Request, id null when unknown).
    if (typeof message.method !== 'string') return { jsonrpc: '2.0', id, error: { code: -32600, message: say('mcp.badRequest') } }
    const method = message.method
    if (method === 'initialize') {
      const asked = text(message.params?.protocolVersion)
      await ready()
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: 'Switchboard', version: VERSION },
        instructions: textOf(lang).instructions,
      })
    }
    if (method === 'ping') return ok({})
    if (method.startsWith('notifications/')) return undefined
    if (method === 'tools/list') {
      await ready()
      return ok({ tools: mcpTools(lang) })
    }
    if (method === 'tools/call') {
      const name = text(message.params?.name)
      if (!mcpTools(lang).some(tool => tool.name === name)) return error(-32602, say('mcp.unknownTool', { name }))
      const args = message.params?.arguments
      const result = await callTool(name, args !== null && typeof args === 'object' ? (args as Json) : {}).catch(
        (e: unknown) => ({ text: say('mcp.toolError', { error: e instanceof Error ? e.message : String(e) }), isError: true }),
      )
      return ok({ content: [{ type: 'text', text: result.text }], isError: result.isError === true })
    }
    return error(-32601, say('mcp.unknownMethod', { method }))
  }

  // A permission ask from the CLI's hook (mcp/hook.ts), handled as the mod's tool.check hook
  // handles Claude Code's: only while the person is away and only what they can see in full;
  // anything else, or no answer in time, leaves the CLI to ask in its terminal.
  async function approve(ask: HookAsk, aborted: () => boolean, waitMs = HOOK_WAIT_MS): Promise<HookAnswer> {
    if (!ask.complete || !ask.summary) return PASS
    const presence = await deps.call('GET', '/presence').catch(() => undefined)
    if (presence?.json.away !== true) return PASS
    const posted = await call('POST', '/approvals', {
      sessionId,
      tool: ask.tool,
      summary: ask.summary,
      cwd: ask.cwd || options.cwd,
      reason: ask.reason,
      requestKey: ask.requestKey,
    }).catch(() => undefined)
    if (!posted?.ok) return PASS
    const id = String(posted.json.id)
    const { answer, note } = await waitApproval({
      until: Date.now() + waitMs,
      now: async () => Date.now(),
      poll: waitMs => call('GET', `/approvals/${id}?wait=${waitMs}`),
      aborted,
      reconnect: async () => (await ready()) || ((await deps.startBridge()) && (await ready())),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      abandon: () => call('POST', `/approvals/${id}/abandon`, { sessionId }),
    })
    if (answer === 'allow') return { answer, message: say('mod.allowedRemote', { id }) }
    if (answer === 'deny') return { answer, message: note ? say('mod.deniedRemoteNote', { id, note }) : say('mod.deniedRemote', { id }) }
    return PASS
  }

  // The turn as the CLI's hooks tell it (docs/에이전트-대등하게.md), followed as the mod follows
  // Claude Code's: working or idle and open tools (/sessions/activity), and at the end the turn's
  // last answer for what went in with it (/messages/turn-end, which picks those out itself).
  let turnAt = 0
  let openTools = 0
  const activity = () =>
    void call('POST', '/sessions/activity', { sessionId, state: turnAt ? 'working' : 'idle', openTools }).catch(() => undefined)
  // The questions of this session still waiting, for the prompt the turn starts with (as the mod's).
  async function pendingContext(): Promise<string | undefined> {
    const state = await deps.call('GET', '/state').catch(() => undefined)
    if (!state?.ok) return undefined
    lang = langOfState(state.json)
    type Pending = { id: number; session_id: string; task_title: string; question: string; status: string; recommend: string; options: string }
    const questions = ((state.json.questions ?? []) as Pending[]).filter(q => q.session_id === sessionId && q.status === 'pending')
    return questions.length > 0 ? `${say('mod.pending')}\n${questions.map(q => pendingLine(q, lang)).join('\n')}` : undefined
  }
  async function onEvent(event: HookEvent): Promise<HookEventReply> {
    if (!(await ready())) return {}
    if (event.kind === 'turnStart') {
      // Codex and Qwen tell it again within a turn; the turn started at the first.
      if (!turnAt) {
        turnAt = Date.now()
        openTools = 0
        activity()
      }
      const context = options.abilities.includes('prompt') ? await pendingContext() : undefined
      return context ? { context } : {}
    }
    if (event.kind === 'toolStart' || event.kind === 'toolEnd') {
      openTools = Math.max(0, openTools + (event.kind === 'toolStart' ? 1 : -1))
      if (!turnAt) turnAt = Date.now()
      activity()
      return {}
    }
    // Only a Copilot session log is read for the answer, whatever path the event names. Copilot
    // may call the hook before the turn's last message is in the file: read again a few times.
    let answer = event.answer
    const transcript = event.transcript && /[\\/]events\.jsonl$/.test(event.transcript) ? event.transcript : ''
    for (let tries = 0; !answer && transcript && tries < 6; tries++) {
      if (tries > 0) await new Promise(resolve => setTimeout(resolve, 300))
      answer = copilotAnswer(tail(transcript))
    }
    const since = turnAt
    turnAt = 0
    openTools = 0
    activity()
    await call('POST', '/messages/turn-end', { sessionId, answer, aborted: event.aborted === true, ...(since ? { since } : {}) }).catch(() => undefined)
    return {}
  }

  return {
    sessionId,
    handle,
    ready,
    approve,
    onEvent,
    // The plan usage the CLI reports (codexUsage.ts), for the usage bar and the limit hold.
    reportUsage: (usage: Record<string, unknown>) => void call('POST', '/sessions/usage', { sessionId, usage }).catch(() => undefined),
    lang: () => lang,
    start: () => {
      void ready()
      timer = setInterval(() => void seen(), SEEN_MS)
      timer.unref()
    },
    stop: () => {
      if (timer) clearInterval(timer)
    },
  }
}

// The last 2 MiB of a file the CLI named (its transcript), '' when it cannot be read.
function tail(path: string, bytes = 2 * 1024 * 1024): string {
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size, bytes)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

// The socket the CLI's permission hook asks on (mcp/permission.ts): one request line and one
// answer line per connection, from a hook that knows the terminal's key. A hook that goes away
// (the CLI gave up on it, the person answered in the terminal) withdraws its ask.
export function listenForHooks(
  path: string,
  terminal: string,
  approve: (ask: HookAsk, aborted: () => boolean) => Promise<HookAnswer>,
  onEvent: (event: HookEvent) => Promise<HookEventReply> = async () => ({}),
): Server {
  const server = createServer(socket => {
    let data = ''
    let gone = false
    socket.setEncoding('utf8')
    socket.on('close', () => (gone = true))
    socket.on('error', () => (gone = true))
    socket.on('data', chunk => {
      if (data.includes('\n')) return
      data += chunk
      if (data.length > 1024 * 1024) return void socket.destroy()
      const end = data.indexOf('\n')
      if (end < 0) return
      let request: HookRequest | null = null
      try {
        request = JSON.parse(data.slice(0, end)) as HookRequest
      } catch {
        request = null
      }
      const ask = request?.ask
      const event = request?.event
      if (!request || typeof request.terminal !== 'string' || !sameTerminal(request.terminal, terminal)) return void socket.end(`${JSON.stringify(PASS)}\n`)
      if (!ask && event && ['turnStart', 'toolStart', 'toolEnd', 'turnEnd'].includes(event.kind)) {
        const clean: HookEvent =
          event.kind === 'turnEnd'
            ? { kind: 'turnEnd', answer: typeof event.answer === 'string' ? event.answer : '', transcript: typeof event.transcript === 'string' ? event.transcript : undefined, aborted: event.aborted === true }
            : { kind: event.kind }
        return void onEvent(clean)
          .catch(() => ({}))
          .then(reply => {
            if (!gone) socket.end(`${JSON.stringify(reply)}\n`)
          })
      }
      if (!ask || typeof ask.tool !== 'string' || typeof ask.summary !== 'string') return void socket.end(`${JSON.stringify(PASS)}\n`)
      const clean: HookAsk = {
        tool: ask.tool.slice(0, 200),
        summary: ask.summary,
        complete: ask.complete === true,
        cwd: typeof ask.cwd === 'string' ? ask.cwd : '',
        reason: typeof ask.reason === 'string' ? ask.reason : '',
        requestKey: typeof ask.requestKey === 'string' ? ask.requestKey.slice(0, 200) : '',
      }
      void approve(clean, () => gone)
        .catch(() => PASS)
        .then(answer => {
          if (!gone) socket.end(`${JSON.stringify(answer)}\n`)
        })
    })
  })
  if (!path.startsWith('\\\\')) {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    rmSync(path, { force: true })
  }
  server.on('error', () => undefined)
  server.listen(path)
  server.unref()
  return server
}

// One line of stdin: a request, a notification or a batch of them. Replies for the lines
// that need one, in order, or a parse error.
export async function answerLine(line: string, handle: (m: Message) => Promise<Response | undefined>, lang: Lang = 'en'): Promise<unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: t(lang, 'mcp.badJson') } }
  }
  const one = (m: unknown) =>
    m !== null && typeof m === 'object' && !Array.isArray(m)
      ? handle(m as Message)
      : Promise.resolve<Response>({ jsonrpc: '2.0', id: null, error: { code: -32600, message: t(lang, 'mcp.badRequest') } })
  if (Array.isArray(parsed)) {
    // An empty batch is one Invalid Request, not an empty array (JSON-RPC 2.0).
    if (parsed.length === 0) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: t(lang, 'mcp.badRequest') } }
    const replies = (await Promise.all(parsed.map(one))).filter(Boolean)
    return replies.length > 0 ? replies : undefined
  }
  return one(parsed)
}

// A server with nothing to do (appOnly, outside the app): it answers as an MCP server with no tools,
// so the CLI shows no error, and reaches no bridge.
export async function idleHandle(message: Message): Promise<Response | undefined> {
  const id = message.id ?? null
  if (typeof message.method !== 'string') return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } }
  if (message.id === undefined || message.id === null || message.method.startsWith('notifications/')) return undefined
  const asked = text(message.params?.protocolVersion)
  if (message.method === 'initialize')
    return {
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, title: 'Switchboard', version: VERSION } },
    }
  if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (message.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: [] } }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method}` } }
}

const started = import.meta.main ? parseOptions(process.argv.slice(2), process.env, process.cwd()) : null
if (started?.appOnly && !(started.terminal && started.extensionRun)) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', line => {
    if (line.trim()) void answerLine(line, idleHandle).then(reply => reply !== undefined && process.stdout.write(`${JSON.stringify(reply)}\n`))
  })
  lines.on('close', () => process.exit(0))
} else if (started) {
  const options = started
  const session = createSession(options, {
    call: bridgeCall(options.socket),
    startBridge: async () => {
      const start = startCommand(options.home)
      return (await runCommand(start.argv, undefined, start.env)).code === 0
    },
    run: runCommand,
    log: line => process.stderr.write(`${line}\n`),
  })
  session.start()
  // A run the app opened has a terminal key, and its CLI's permission hook may ask here.
  const hooks = options.terminal ? listenForHooks(hookSocket(options.home, options.terminal), options.terminal, session.approve, session.onEvent) : null
  const stopUsage =
    options.agent === 'codex' && options.cli
      ? watchCodexUsage(codexArgv(options.cli), { ...process.env, HOME: options.home }, rateLimits => session.reportUsage({ rateLimits }))
      : () => undefined
  const write = (reply: unknown) => {
    if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`)
  }
  // The CLI closing stdin ends the server, once the calls still running have answered.
  let running = 0
  let closed = false
  const finish = () => {
    if (!closed || running > 0) return
    session.stop()
    hooks?.close()
    stopUsage()
    if (hooks && process.platform !== 'win32') rmSync(hookSocket(options.home, options.terminal), { force: true })
    process.exit(0)
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', line => {
    if (!line.trim()) return
    running += 1
    void answerLine(line, session.handle, session.lang())
      .then(write)
      .finally(() => {
        running -= 1
        finish()
      })
  })
  lines.on('close', () => {
    closed = true
    finish()
  })
  process.stdout.on('error', () => process.exit(0))
}

// Switchboard MCP server: connects an agent CLI other than Claude Code (Codex,
// Gemini, ...) to the bridge with the same tools the mod gives Claude Code, plus
// check_answers for answers the app could not type into the session itself.
// stdio, newline-delimited JSON-RPC 2.0. Run with Node 24: node mcp/server.ts --agent codex
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { SESSION_HEADER, requestTarget, resolveEndpoint, startCommand, usesTcp } from '../bridge/endpoint.ts'
import { takenText } from '../mod/hooks/batch.ts'
import { langFromLocale, langOfState, osLocale, t, type Key, type Lang, type Vars } from '../mod/hooks/i18n.ts'
import { BROWSER_TOOLS, cancelText, openBody, openResultText, openToolDef, peersText, sentText, toolDefs, worktreeRoot, type Peer, type ToolDef } from '../mod/hooks/tools.ts'

export { takenText }

export const SERVER_NAME = 'switchboard'
const VERSION = '0.3.10'
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
// How often the session tells the bridge it is still there.
const SEEN_MS = 20_000
const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'

export type Options = { agent: string; terminal: string; cwd: string; socket: string; home: string }

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
    const body = { id: sessionId, cwd: options.cwd, agent: options.agent, terminal: options.terminal, token: true }
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

  return {
    sessionId,
    handle,
    ready,
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

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2), process.env, process.cwd())
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
  const write = (reply: unknown) => {
    if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`)
  }
  // The CLI closing stdin ends the server, once the calls still running have answered.
  let running = 0
  let closed = false
  const finish = () => {
    if (!closed || running > 0) return
    session.stop()
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

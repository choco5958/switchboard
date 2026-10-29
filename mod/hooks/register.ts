import type { EngineInterface as Engine, Register } from 'claude-code'
import { batchText, nextDelay, normalizeIds, parseFrame, pendingLine, remember, staleKeys, toastText, type Delivery } from './batch'
import { registerPane } from './pane'
import { registerDevtool } from './devtool'
import { currentLang, langOfState, sessionLang, setLang, t } from './i18n.ts'
import { toolDefs } from './tools.ts'

// The mod connects this Claude Code session to the Switchboard bridge:
// questions and task state go out over the bridge's Unix socket, and answers
// come back through a subscription the mod keeps open (curl over the socket),
// each one entering the session as a prompt.

const BASE = 'http://bridge'
// A prompt the session refused (a hook's drop) is tried again after this long.
const SUBMIT_RETRY_MS = 30000
// Store keys of a session not seen for two weeks are removed (it crashed before session.end).
const STALE_MS = 14 * 24 * 3600_000
const ID_CAP = 500

// What this mod keeps in $.store per session, so a mod reload loses none of it:
// sent, the deliveries submitted; commands, the command ids already run;
// agents, the subagents paused or stopped from the IDE; queued, command prompts not yet submitted.
type StoreKind = 'sent' | 'commands' | 'agents' | 'queued'
const STORE_KINDS: StoreKind[] = ['sent', 'commands', 'agents', 'queued']

function storeKey(kind: StoreKind, id = sessionId): string {
  return `${kind}:${id}`
}

type Reply = { ok: boolean; status: number; json: Record<string, unknown> }

let home = ''
let socket = ''
let sessionId = ''
let cwd = ''
let subscribed = false
// The main loop is mid-turn: what arrives now waits and goes in as one prompt
// when the turn completes.
let busy = false
let flushing = false
let retrying = false
let waiting: Delivery[] = []
// Subagents the person paused or stopped from the IDE: their tool calls are refused.
const paused = new Set<string>()
const stopped = new Set<string>()
let mainTurnId = ''
// Commands run one at a time, so the record of run ids is never written by two at once.
let commandChain: Promise<void> = Promise.resolve()
let touchedAt = 0

function socketPath(): string {
  return socket || `${home}/.claude-ide/bridge.sock`
}

async function call($: Engine, method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await $.http.fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    socketPath: socketPath(),
  })
  let json: Record<string, unknown> = {}
  try {
    json = res.text ? (JSON.parse(res.text) as Record<string, unknown>) : {}
  } catch {
    json = { error: res.text }
  }
  return { ok: res.ok, status: res.status, json }
}

// orca is on PATH in Orca terminals; elsewhere fall back to the app bundle.
const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'

async function orca($: Engine, args: string[]): Promise<Record<string, unknown>> {
  const ran = await $.process.run(['sh', '-c', `exec "$(command -v orca || echo ${ORCA})" "$@"`, 'orca', ...args, '--json'], {
    timeoutMs: 120000,
  })
  try {
    return JSON.parse(ran.stdout) as Record<string, unknown>
  } catch {
    return { ok: false, error: { message: ran.stderr || ran.stdout || `exit ${ran.exitCode}` } }
  }
}

function errorOf(reply: Record<string, unknown>): string {
  const error = reply.error as { code?: string; message?: string } | undefined
  return error?.message ?? error?.code ?? 'unknown error'
}

// Answer to Q9 and Q10: the session asks for a worktree when a node needs one,
// and its own subagent works there.
async function createWorktree($: Engine, task: string, key: string, base?: string, repo?: string): Promise<string> {
  const from = repo ?? (await $.session.root())
  const root = (await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: from })).stdout.trim()
  if (!root) return t(currentLang(), 'wt.notRepo', { path: from })
  const listed = await orca($, ['worktree', 'list', '--repo', `path:${root}`, '--limit', '1'])
  if (listed.ok !== true) {
    const added = await orca($, ['repo', 'add', '--path', root])
    if (added.ok !== true) return t(currentLang(), 'wt.repoAddFailed', { error: errorOf(added) })
  }
  const slug = key.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'node'
  const name = `${slug}-${Date.now().toString(36).slice(-4)}`
  const args = ['worktree', 'create', '--repo', `path:${root}`, '--name', name, '--comment', `Switchboard: ${task} / ${key}`]
  if (base) args.push('--base-branch', base)
  const created = await orca($, args)
  const worktree = (created.result as { worktree?: { path?: string; branch?: string } } | undefined)?.worktree
  if (created.ok !== true || !worktree?.path) return t(currentLang(), 'wt.createFailed', { error: errorOf(created) })
  const branch = (worktree.branch ?? '').replace(/^refs\/heads\//, '')
  const saved = await call($, 'POST', '/nodes/worktree', { sessionId, taskTitle: task, key, worktree: worktree.path, branch })
  const note = saved.ok ? '' : t(currentLang(), 'wt.saveFailed', { error: String(saved.json.error) })
  return t(currentLang(), 'wt.created', { note, path: worktree.path, branch })
}

async function ensureBridge($: Engine): Promise<boolean> {
  const started = await $.process.run(['sh', `${home}/.claude-ide/start-bridge.sh`], { timeoutMs: 10000 })
  if (started.exitCode !== 0) $.ui.log(t(currentLang(), 'log.bridgeStart', { error: started.stderr }), { to: 'debug' })
  return started.exitCode === 0
}

function post($: Engine, kind: string, text: string, taskTitle = ''): Promise<Reply | undefined> {
  return call($, 'POST', '/events', { sessionId, kind, text, taskTitle }).catch(() => undefined)
}

// The subscription runs for the whole session: when the bridge is down at the start
// or goes away later, it keeps trying, waiting longer each time.
async function subscribe($: Engine): Promise<void> {
  if (subscribed) return
  subscribed = true
  let delay = 0
  for (;;) {
    delay = (await listenOnce($).catch(() => false)) ? nextDelay(0) : nextDelay(delay)
    await $.clock.sleep(delay)
  }
}

// One connection: start the bridge if needed, register the session (again, since the
// bridge may have restarted), then read the stream until it ends. True when it connected.
async function listenOnce($: Engine): Promise<boolean> {
  if (!(await ensureBridge($))) return false
  const registered = await call($, 'POST', '/sessions', { id: sessionId, cwd }).catch(() => undefined)
  if (!registered?.ok) return false
  let connected = false
  try {
    const stream = $.process.spawn({
      argv: ['curl', '-sN', '--unix-socket', socketPath(), `${BASE}/deliveries?session=${sessionId}`],
    })
    let buffer = ''
    for await (const piece of stream) {
      if (!('text' in piece) || piece.stream !== 'stdout') continue
      connected = true
      buffer += piece.text
      let end = buffer.indexOf('\n\n')
      while (end !== -1) {
        handleFrame($, buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        end = buffer.indexOf('\n\n')
      }
    }
  } catch (error) {
    $.ui.log(t(currentLang(), 'log.subscriptionLost', { error: String(error) }), { to: 'debug' })
  }
  return connected
}

function handleFrame($: Engine, frame: string): void {
  const parsed = parseFrame(frame)
  if (!parsed) return
  try {
    if (parsed.event === 'command') {
      const command = JSON.parse(parsed.data) as Command
      commandChain = commandChain.then(() => runCommand($, command)).catch(() => undefined)
    } else if (parsed.event === 'delivery') {
      const delivery = JSON.parse(parsed.data) as Delivery
      if (!waiting.some(d => d.id === delivery.id)) waiting.push(delivery)
      void flush($)
    }
  } catch (error) {
    $.ui.log(t(currentLang(), 'log.badFrame', { error: String(error) }), { to: 'debug' })
  }
}

// $.store outlives a mod reload: what was submitted before a reload is
// acknowledged again, never submitted twice. Only a prompt that went in is recorded
// and acknowledged; one the session dropped stays waiting for the next try.
async function flush($: Engine): Promise<void> {
  if (busy || flushing || waiting.length === 0) return
  flushing = true
  let dropped = false
  try {
    const sent = normalizeIds(((await $.store.get(storeKey('sent'))) as (string | number)[] | undefined) ?? [])
    const batch = waiting.filter(d => !sent.includes(d.id))
    const done = waiting.filter(d => sent.includes(d.id))
    waiting = []
    if (batch.length > 0) {
      const submitted = await $.prompt.submit({ text: batchText(batch, currentLang()) }).catch((error: unknown) => ({ drop: String(error) }))
      if (typeof submitted.drop === 'string') {
        dropped = true
        waiting = [...batch, ...waiting.filter(d => !batch.some(b => b.id === d.id))]
        $.ui.log(t(currentLang(), 'log.retry', { error: submitted.drop }), { to: 'debug' })
      } else {
        await $.store.set(storeKey('sent'), remember(sent, batch.map(d => d.id), ID_CAP))
        $.ui.toast(toastText(batch, currentLang()))
      }
    }
    const acked = dropped ? done : [...done, ...batch]
    for (const d of acked) if (!d.id.startsWith('c')) await call($, 'POST', `/deliveries/${d.id}/ack`).catch(() => undefined)
    await saveQueued($)
  } finally {
    flushing = false
  }
  if (dropped) retryLater($)
  else if (!busy && waiting.length > 0) void flush($)
}

function retryLater($: Engine): void {
  if (retrying) return
  retrying = true
  void $.clock.sleep(SUBMIT_RETRY_MS).then(
    () => {
      retrying = false
      void flush($)
    },
    () => undefined,
  )
}

// Command prompts (report, sync, a message to the main session) exist nowhere else
// once their command is done, so they wait in $.store until they go in.
async function saveQueued($: Engine): Promise<void> {
  await $.store.set(storeKey('queued'), waiting.filter(d => d.id.startsWith('c'))).catch(() => undefined)
}

async function saveAgents($: Engine): Promise<void> {
  await $.store.set(storeKey('agents'), { paused: [...paused], stopped: [...stopped] }).catch(() => undefined)
}

// After a reload (or a restart of the same session) the module starts empty: take back
// what the store kept, and forget the keys of sessions gone for two weeks.
async function restore($: Engine): Promise<void> {
  const agents = (await $.store.get(storeKey('agents'))) as { paused?: string[]; stopped?: string[] } | undefined
  for (const id of agents?.paused ?? []) paused.add(id)
  for (const id of agents?.stopped ?? []) stopped.add(id)
  const queued = ((await $.store.get(storeKey('queued'))) as Delivery[] | undefined) ?? []
  for (const d of queued) if (!waiting.some(w => w.id === d.id)) waiting.push(d)
  const at = await $.clock.now()
  const seen = { ...(((await $.store.get('seen')) as Record<string, number> | undefined) ?? {}) }
  const keys = await $.store.keys()
  for (const key of keys) {
    const id = /^(?:sent|commands|agents|queued):(.+)$/.exec(key)?.[1]
    if (id && seen[id] === undefined) seen[id] = at
  }
  seen[sessionId] = at
  touchedAt = at
  for (const key of staleKeys(keys, seen, at, STALE_MS)) await $.store.delete(key)
  for (const [id, last] of Object.entries(seen)) if (at - last > STALE_MS) delete seen[id]
  await $.store.set('seen', seen)
}

// A session that runs for weeks marks itself seen now and then, so nobody removes its keys.
async function touchSeen($: Engine): Promise<void> {
  const at = await $.clock.now()
  if (at - touchedAt < 3600_000) return
  touchedAt = at
  const seen = (((await $.store.get('seen')) as Record<string, number> | undefined) ?? {})
  await $.store.set('seen', { ...seen, [sessionId]: at })
}

type Command = { id: number; kind: string; payload?: { agentId?: string; text?: string } }

// The IDE's control of this session: answered once, its result stored on the bridge.
// The bridge sends a command again until it hears it is done (a new stream gets every
// pending one), so a command already run is only reported done again. A transcript
// reads and changes nothing: it runs again.
async function runCommand($: Engine, command: Command): Promise<void> {
  if (typeof command.id !== 'number') return
  const ran = ((await $.store.get(storeKey('commands'))) as number[] | undefined) ?? []
  if (ran.includes(command.id) && command.kind !== 'transcript') {
    await call($, 'POST', `/commands/${command.id}/done`, { result: { ok: true } }).catch(() => undefined)
    return
  }
  await $.store.set(storeKey('commands'), remember(ran, [command.id], ID_CAP))
  let result: unknown = { ok: true }
  try {
    const payload = command.payload ?? {}
    const agentId = payload.agentId ?? ''
    if (command.kind === 'pause' && agentId) {
      paused.add(agentId)
      await saveAgents($)
    } else if (command.kind === 'resume' && agentId) {
      paused.delete(agentId)
      await saveAgents($)
      await $.session.send({ to: { agentId }, text: t(currentLang(), 'mod.resumed') })
    } else if (command.kind === 'stop' && agentId) {
      paused.delete(agentId)
      stopped.add(agentId)
      await saveAgents($)
      await $.session.send({ to: { agentId }, text: t(currentLang(), 'mod.stopped') })
    } else if (command.kind === 'message' && payload.text) {
      const text = t(currentLang(), 'mod.message', { text: payload.text })
      if (agentId) await $.session.send({ to: { agentId }, text })
      else await queueDelivery($, { id: `c${command.id}`, text })
    } else if (command.kind === 'transcript' && agentId) {
      const found = await $.session.messages({ agentId })
      result = 'deny' in found ? { error: String(found.deny) } : { messages: found.slice(-200).map(m => ({ role: m.role, text: m.text })) }
    } else if (command.kind === 'report') {
      await queueDelivery($, { id: `c${command.id}`, text: t(currentLang(), 'mod.reportPrompt') })
    } else if (command.kind === 'sync') {
      await queueDelivery($, { id: `c${command.id}`, text: t(currentLang(), 'mod.syncPrompt') })
    } else {
      result = { error: t(currentLang(), 'mod.unknownCommand', { kind: command.kind }) }
    }
  } catch (error) {
    result = { error: String(error) }
  }
  await call($, 'POST', `/commands/${command.id}/done`, { result }).catch(() => undefined)
  void reportAgents($)
}

// Command prompts ride the same batching as answers; they need no bridge acknowledgement.
async function queueDelivery($: Engine, delivery: Delivery): Promise<void> {
  if (!waiting.some(d => d.id === delivery.id)) waiting.push(delivery)
  await saveQueued($)
  void flush($)
}

async function reportAgents($: Engine): Promise<void> {
  if (!sessionId) return
  const list = await $.agent.list().catch(() => [])
  const agents = list.map(a => ({
    id: a.id,
    description: a.description,
    type: a.type,
    status: stopped.has(a.id) && a.status === 'running' ? 'stopped' : paused.has(a.id) ? 'paused' : a.status,
  }))
  await call($, 'POST', '/agents', { sessionId, agents }).catch(() => undefined)
}

async function reportUsage($: Engine): Promise<void> {
  if (!sessionId) return
  const usage = await $.session.usage().catch(() => undefined)
  if (!usage) return
  const running = (await $.agent.list().catch(() => [])).filter(a => a.status === 'running').length
  // ccr puts the account slot in claude's environment; the app shows each slot's live usage by it.
  const slot = Number(await $.env.get('CCR_SLOT').catch(() => undefined))
  await call($, 'POST', '/sessions/usage', {
    sessionId,
    usage: {
      rateLimits: usage.rateLimits,
      cost: usage.cost ? { totalUsd: usage.cost.usd } : undefined,
      contextPercent: usage.context.percent,
      model: await $.session.model(),
      agentsRunning: running,
      ccrSlot: Number.isInteger(slot) && slot > 0 ? slot : undefined,
    },
  }).catch(() => undefined)
}

// Each prompt of the person carries this session's questions still waiting in the IDE,
// so the reply can end with them, as the reference session does.
async function pendingContext($: Engine): Promise<string | undefined> {
  if (!sessionId) return undefined
  const reply = await call($, 'GET', '/state').catch(() => undefined)
  if (reply?.ok) setLang(langOfState(reply.json))
  const questions = ((reply?.json.questions ?? []) as {
    id: number
    session_id: string
    task_title: string
    question: string
    status: string
    recommend: string
    options: string
  }[]).filter(q => q.session_id === sessionId && q.status === 'pending')
  if (questions.length === 0) return undefined
  const lang = currentLang()
  const lines = questions.map(q => pendingLine(q, lang))
  return `${t(lang, 'mod.pending')}\n${lines.join('\n')}`
}

export const register: Register = on => {
  registerPane(on)
  registerDevtool(on)
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
    // The IDE and start-bridge.sh honour CLAUDE_IDE_SOCKET; so does the mod.
    socket = (await $.env.get('CLAUDE_IDE_SOCKET').catch(() => undefined)) || `${home}/.claude-ide/bridge.sock`
    sessionId = await $.session.id()
    cwd = e.cwd
    await restore($).catch(() => undefined)

    // Described in the language the app is set to when the session starts.
    for (const def of toolDefs(await sessionLang($))) await $.tool.register({ ...def, isDeferred: false })

    // Rejects only when a reload unloads this environment; the new one subscribes again.
    void subscribe($).catch(() => undefined)
    if (waiting.length > 0) void flush($)
    return started
  })

  // The session's store keys go with it, so the 4 MiB store never fills up.
  on('session.end', async ($, e, next) => {
    for (const kind of STORE_KINDS) await $.store.delete(storeKey(kind, e.sessionId)).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__ide-bridge__ask_decision' }, async ($, e) => {
    const reply = await call($, 'POST', '/questions', {
      sessionId,
      taskTitle: e.task,
      question: e.question,
      body: e.body,
      options: e.options,
      recommend: e.recommend,
      reason: e.reason,
      turnId: mainTurnId,
      requestKey: e.tool_use_id,
    }).catch((error: unknown): Reply => ({ ok: false, status: 0, json: { error: String(error) } }))
    if (!reply.ok) return { result: t(currentLang(), 'tool.askFailed', { error: String(reply.json.error) }) }
    return { result: t(currentLang(), reply.json.duplicate ? 'tool.askedAgain' : 'tool.asked', { id: String(reply.json.id) }) }
  }).catch(() => ({ result: t(currentLang(), 'tool.askFailedPlain') }))

  on('tool.call', { tool: 'mcp__ide-bridge__set_task' }, async ($, e) => {
    const reply = await call($, 'POST', '/tasks', {
      sessionId,
      title: e.title,
      stage: e.stage,
      status: e.status,
      now: e.now,
      why: e.why,
      what: e.what,
      result: e.result,
      artifact: e.artifact,
      tests: e.tests,
      branch: e.branch,
    }).catch((error: unknown): Reply => ({ ok: false, status: 0, json: { error: String(error) } }))
    if (!reply.ok) return { result: t(currentLang(), 'tool.taskFailed', { error: String(reply.json.error) }) }
    return { result: t(currentLang(), 'tool.taskDone', { title: String(e.title) }) }
  }).catch(() => ({ result: t(currentLang(), 'tool.taskFailedPlain') }))

  on('tool.call', { tool: 'mcp__ide-bridge__plan_nodes' }, async ($, e) => {
    const reply = await call($, 'POST', '/nodes', { sessionId, taskTitle: e.task, nodes: e.nodes }).catch(
      (error: unknown): Reply => ({ ok: false, status: 0, json: { error: String(error) } }),
    )
    if (!reply.ok) return { result: t(currentLang(), 'tool.planFailed', { error: String(reply.json.error) }) }
    return { result: t(currentLang(), 'tool.planDone', { n: Number(reply.json.count) }) }
  }).catch(() => ({ result: t(currentLang(), 'tool.planFailedPlain') }))

  on('tool.call', { tool: 'mcp__ide-bridge__node_worktree' }, async ($, e) => ({
    result: await createWorktree(
      $,
      String(e.task),
      String(e.key),
      typeof e.base === 'string' && e.base ? e.base : undefined,
      typeof e.repo === 'string' && e.repo ? e.repo : undefined,
    ),
  })).catch(() => ({ result: t(currentLang(), 'wt.createFailedPlain') }))

  on('tool.call', { tool: 'mcp__ide-bridge__update_node' }, async ($, e) => {
    const reply = await call($, 'POST', '/nodes/status', {
      sessionId,
      taskTitle: e.task,
      key: e.key,
      status: e.status,
      note: e.note,
    }).catch((error: unknown): Reply => ({ ok: false, status: 0, json: { error: String(error) } }))
    if (!reply.ok) return { result: t(currentLang(), 'tool.nodeFailed', { error: String(reply.json.error) }) }
    return { result: t(currentLang(), 'tool.nodeDone', { key: String(e.key), status: String(e.status), round: String(reply.json.round) }) }
  }).catch(() => ({ result: t(currentLang(), 'tool.nodeFailedPlain') }))

  // Logging only: a failure here must never stop the subagent from running.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (sessionId) void post($, '에이전트', t(currentLang(), 'mod.agentStart', { text: e.description }))
    const ran = await next(e)
    void reportAgents($)
    return ran
  }).catch(($, e, next) => next(e))

  // A paused or stopped worker gets every tool call refused until the IDE resumes it.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId && stopped.has(agentId)) return { deny: t(currentLang(), 'mod.denyStopped') }
    if (agentId && paused.has(agentId)) return { deny: t(currentLang(), 'mod.denyPaused') }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    const extra = await pendingContext($).catch(() => undefined)
    return next(extra ? { ...e, context: [...(e.context ?? []), extra] } : e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      busy = true
      mainTurnId = e.turnId
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      busy = false
      void flush($)
      void reportUsage($)
      void touchSeen($).catch(() => undefined)
    } else if (sessionId) {
      void post($, '에이전트', t(currentLang(), 'mod.agentEnd', { text: e.answer.split('\n')[0]?.slice(0, 120) ?? '' }))
    }
    void reportAgents($)
    return next(e)
  })
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'
import type { Inflight } from '../types'
import { batchText, nextDelay, normalizeIds, parseFrame, pendingLine, remember, restateText, staleKeys, toastText, approvalSummary, type Delivery } from './batch'
import { registerPane } from './pane'
import { registerDevtool } from './devtool'
import { currentLang, langOfState, sessionLang, setLang, t } from './i18n.ts'
import { SESSION_HEADER, bridgeFetch, startArgv, streamArgv } from './link.ts'
import { BROWSER_TOOLS, cancelText, peersText, sentText, toolDefs, worktreeRoot, type Peer } from './tools.ts'
import { waitApproval } from './approval.ts'

// The mod connects this Claude Code session to the Switchboard bridge:
// questions and task state go out over the bridge's socket (TCP on Windows: link.ts),
// and answers come back through a subscription the mod keeps open (curl), each one
// entering the session as a prompt.

// A prompt the session refused (a hook's drop) is tried again after this long.
const SUBMIT_RETRY_MS = 30000
// Store keys of a session not seen for two weeks are removed (it crashed before session.end).
const STALE_MS = 14 * 24 * 3600_000
const ID_CAP = 500

// What this mod keeps in $.store per session, so a mod reload loses none of it:
// sent, the deliveries submitted; commands, the command ids already run;
// agents, the subagents paused or stopped from the IDE; queued, command prompts not yet submitted;
// token, what the bridge gave this session to act as it (sessionToken).
type StoreKind = 'sent' | 'commands' | 'agents' | 'queued' | 'token'
// Removed at the session's exit. The token stays (until STALE_MS): a session resumed later
// under the same id registers again with it, and the bridge refuses that without it.
const STORE_KINDS: StoreKind[] = ['sent', 'commands', 'agents', 'queued']

function storeKey(kind: StoreKind, id = sessionId): string {
  return `${kind}:${id}`
}

type Reply = { ok: boolean; status: number; json: Record<string, unknown> }

let sessionId = ''
let cwd = ''
// The token the bridge handed over when this session first registered (POST /sessions): its own
// routes (deliveries, acknowledgements, commands, permission asks) answer only with it, so another
// program that knows the session's id cannot act as it. '' with a bridge from before tokens.
let sessionToken = ''
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
// Activity for the app's stall check (src/shared/stall.ts): tool calls open now, and when
// the bridge last heard of this session's work.
let openTools = 0
// Messages from other sessions that went in with the prompt now running: when its turn ends
// without a reply to one, the bridge sends the turn's last answer back (POST /messages/turn-end).
let answering: string[] = []
// Every delivery that went in with the prompt now running: a cancel_request stops the turn
// only when it is made of cancelled requests alone, never the person's own work.
let turnItems: string[] = []
// Requests their sender cancelled: a turn that starts with these alone stops at once.
const cancelledIds = new Set<string>()
// The four above outlive a reload of this mod (the session's $.state keeps them).
const inflight = atom({ plugin: 'ide-bridge', key: 'inflight' } as const, { sessionId: '', isBusy: false, turnId: '', answering: [], turnItems: [] } as Inflight)
const keepTurn = ($: Engine) => update($, inflight, () => ({ sessionId, isBusy: busy, turnId: mainTurnId, answering, turnItems })).catch(() => undefined)
async function restoreTurn($: Engine): Promise<void> {
  const kept = await read($, inflight)
  if (kept.sessionId !== sessionId) return
  busy = kept.isBusy
  mainTurnId = kept.turnId
  answering = kept.answering
  turnItems = kept.turnItems
  if (busy) void settleRestored($)
}

// When the main loop last showed it runs (a turn starting or ending, a tool call).
let turnSignalAt = 0
const RESTORED_IDLE_MS = 5 * 60_000
// A turn that ended while the mod was being reloaded left `busy` set with no turn.complete to
// clear it, and what waits would never go in. With no sign of a running turn for
// RESTORED_IDLE_MS after the reload, it counts as over.
async function settleRestored($: Engine): Promise<void> {
  const since = Date.now()
  while (busy) {
    await $.clock.sleep(60_000).catch(() => undefined)
    if (!busy || turnSignalAt > since) return
    if (Date.now() - since >= RESTORED_IDLE_MS) {
      busy = false
      await keepTurn($)
      void flush($)
      return
    }
  }
}
// The main conversation was compacted: the next prompt restates this session's Switchboard state.
let restate = false
let activitySentAt = 0
let activitySent = ''
const ACTIVITY_BEAT_MS = 15_000
// How long a permission ask waits for the person away from the desk before the terminal asks.
const APPROVAL_WAIT_MS = 6 * 3600_000

async function call($: Engine, method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await bridgeFetch($, path, {
    method,
    headers: { 'content-type': 'application/json', ...(sessionToken ? { [SESSION_HEADER]: sessionToken } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  const found = await worktreeRoot(async (argv, cwd) => (await $.process.run(argv, { cwd })).stdout, await $.session.root(), repo, base)
  if ('refused' in found) return t(currentLang(), found.refused, found.vars)
  const { root } = found
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
  const start = await startArgv($)
  const started = await $.process.run(start.argv, { timeoutMs: 10000, env: start.env })
  if (started.exitCode !== 0) $.ui.log(t(currentLang(), 'log.bridgeStart', { error: started.stderr }), { to: 'debug' })
  return started.exitCode === 0
}

// A write the bridge must not miss while it restarts (a new app version replaces it): tried
// again after starting the bridge, about half a minute in all. Only one that never reached it
// is sent again, and the bridge takes each one once.
const RESEND_TRIES = 5
const RESEND_MS = 2000
async function sendSurely($: Engine, path: string, body: unknown): Promise<void> {
  for (let attempt = 0; attempt < RESEND_TRIES; attempt++) {
    const reply = await call($, 'POST', path, body).catch(() => undefined)
    if (reply && reply.status !== 0) return
    await $.clock.sleep(RESEND_MS).catch(() => undefined)
    await ensureBridge($).catch(() => false)
  }
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
  // `token`: the bridge makes one with the session's row and hands it over this once.
  const registered = await call($, 'POST', '/sessions', { id: sessionId, cwd, token: true }).catch(() => undefined)
  if (!registered?.ok) {
    // 403: the session took a token this mod no longer has (its store lost it); only the app could act for it now.
    if (registered?.status === 403) $.ui.log(t(currentLang(), 'log.subscriptionLost', { error: String(registered.json.error) }), { to: 'debug' })
    return false
  }
  if (typeof registered.json.token === 'string' && registered.json.token) {
    sessionToken = registered.json.token
    await $.store.set(storeKey('token'), sessionToken).catch(() => undefined)
  }
  let connected = false
  try {
    // The token goes to curl on its standard input, never its command line.
    const stream = $.process.spawn({
      argv: await streamArgv($, `/deliveries?session=${sessionId}`, sessionToken !== ''),
      ...(sessionToken ? { input: `${SESSION_HEADER}: ${sessionToken}\n` } : {}),
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
      // Known before the turn starts, so a cancel that comes while it is being submitted still finds them.
      const ids = batch.map(d => d.id)
      turnItems = [...turnItems, ...ids]
      await keepTurn($)
      const submitted = await $.prompt.submit({ text: batchText(batch, currentLang()) }).catch((error: unknown) => ({ drop: String(error) }))
      if (typeof submitted.drop === 'string') {
        turnItems = turnItems.filter(id => !ids.includes(id))
        await keepTurn($)
        dropped = true
        waiting = [...batch, ...waiting.filter(d => !batch.some(b => b.id === d.id))]
        $.ui.log(t(currentLang(), 'log.retry', { error: submitted.drop }), { to: 'debug' })
      } else {
        await $.store.set(storeKey('sent'), remember(sent, batch.map(d => d.id), ID_CAP))
        answering = [...answering, ...batch.filter(d => d.id.startsWith('m')).map(d => d.id)]
        await keepTurn($)
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
  const token = await $.store.get(storeKey('token'))
  sessionToken = typeof token === 'string' ? token : ''
  const agents = (await $.store.get(storeKey('agents'))) as { paused?: string[]; stopped?: string[] } | undefined
  for (const id of agents?.paused ?? []) paused.add(id)
  for (const id of agents?.stopped ?? []) stopped.add(id)
  const queued = ((await $.store.get(storeKey('queued'))) as Delivery[] | undefined) ?? []
  for (const d of queued) if (!waiting.some(w => w.id === d.id)) waiting.push(d)
  const at = await $.clock.now()
  const seen = { ...(((await $.store.get('seen')) as Record<string, number> | undefined) ?? {}) }
  const keys = await $.store.keys()
  for (const key of keys) {
    const id = /^(?:sent|commands|agents|queued|token):(.+)$/.exec(key)?.[1]
    if (id && seen[id] === undefined) seen[id] = at
  }
  seen[sessionId] = at
  touchedAt = at
  for (const key of staleKeys(keys, seen, at, STALE_MS)) await $.store.delete(key)
  for (const [id, last] of Object.entries(seen)) if (at - last > STALE_MS) delete seen[id]
  await $.store.set('seen', seen)
}

// Tells the bridge the turn is working or idle and whether a tool call is open. A change goes
// at once; the same picture again only as a heartbeat, at most every ACTIVITY_BEAT_MS.
async function reportActivity($: Engine): Promise<void> {
  if (!sessionId) return
  const picture = `${busy ? 'working' : 'idle'}:${openTools > 0}`
  const at = await $.clock.now()
  if (picture === activitySent && at - activitySentAt < ACTIVITY_BEAT_MS) return
  activitySent = picture
  activitySentAt = at
  await call($, 'POST', '/sessions/activity', { sessionId, state: busy ? 'working' : 'idle', openTools }).catch(() => undefined)
}

// A session that runs for weeks marks itself seen now and then, so nobody removes its keys.
async function touchSeen($: Engine): Promise<void> {
  const at = await $.clock.now()
  if (at - touchedAt < 3600_000) return
  touchedAt = at
  const seen = (((await $.store.get('seen')) as Record<string, number> | undefined) ?? {})
  await $.store.set('seen', { ...seen, [sessionId]: at })
}

type Command = { id: number; kind: string; payload?: { agentId?: string; text?: string; ids?: string[] } }

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
    } else if (command.kind === 'cancel') {
      // Requests their sender took back (bridge POST /messages/cancel): what has not gone in
      // never does, and a turn working on these alone stops.
      const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : []
      for (const id of ids) cancelledIds.add(id)
      waiting = waiting.filter(d => !ids.includes(d.id))
      await saveQueued($)
      const stop = busy && mainTurnId !== '' && turnItems.length > 0 && turnItems.every(id => ids.includes(id))
      if (stop) await $.turn.abort({ turnId: mainTurnId })
      // Ones already in the running prompt: unless the turn stopped, the bridge tells the model to drop them.
      result = { stopped: stop, reached: ids.filter(id => turnItems.includes(id)) }
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

// A tool whose whole work is one bridge call; its result reads `ok(json)` or the failure.
async function bridgeTool($: Engine, path: string, body: unknown, ok: (json: Record<string, unknown>) => string): Promise<{ result: string }> {
  const reply = await call($, 'POST', path, body).catch((error: unknown): Reply => ({ ok: false, status: 0, json: { error: String(error) } }))
  return { result: reply.ok ? ok(reply.json) : t(currentLang(), 'tool.sendFailed', { error: String(reply.json.error) }) }
}

// The person wrote in the terminal: replies the bridge held for a later turn (an answer to a
// request sent to several sessions, a cancelled request's note) go in with this prompt.
async function releaseHeld($: Engine): Promise<string[]> {
  if (!sessionId) return []
  const reply = await call($, 'POST', '/messages/release', { sessionId })
  const items = (reply.ok ? (reply.json.items ?? []) : []) as Delivery[]
  if (items.length === 0) return []
  const ids = items.map(d => d.id)
  waiting = waiting.filter(d => !ids.includes(d.id))
  const sent = normalizeIds(((await $.store.get(storeKey('sent'))) as (string | number)[] | undefined) ?? [])
  await $.store.set(storeKey('sent'), remember(sent, ids, ID_CAP))
  return items.map(d => d.text)
}

async function restateContext($: Engine): Promise<string | undefined> {
  if (!sessionId) return undefined
  const [state, waits] = await Promise.all([
    call($, 'GET', '/state'),
    call($, 'GET', `/waits?session=${encodeURIComponent(sessionId)}`).catch(() => undefined),
  ])
  if (!state.ok) return undefined
  setLang(langOfState(state.json))
  return restateText(state.json as Parameters<typeof restateText>[0], ((waits?.json.waits ?? []) as { id: number; note: string }[]), sessionId, currentLang())
}

export const register: Register = on => {
  registerPane(on)
  registerDevtool(on)
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionId = await $.session.id()
    cwd = e.cwd
    await restoreTurn($).catch(() => undefined)
    await restore($).catch(() => undefined)

    // Described in the language the app is set to when the session starts.
    for (const def of toolDefs(await sessionLang($))) await $.tool.register({ ...def, isDeferred: false })

    // Rejects only when a reload unloads this environment; the new one subscribes again.
    void subscribe($).catch(() => undefined)
    if (waiting.length > 0) void flush($)
    return started
  })

  // The session's store keys go with it, so the 4 MiB store never fills up. A /clear or a
  // resume is no end for this mod: no session.start follows, and it carries on under the id
  // it has, whose keys it still needs (STALE_MS removes them once it is gone for good).
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') return next(e)
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

  on('tool.call', { tool: 'mcp__ide-bridge__list_sessions' }, async $ => {
    const reply = await call($, 'GET', `/sessions/peers?session=${encodeURIComponent(sessionId)}`).catch(
      (error: unknown): Reply => ({ ok: false, status: 0, json: { error: String(error) } }),
    )
    if (!reply.ok) return { result: t(currentLang(), 'tool.sendFailed', { error: String(reply.json.error) }) }
    return { result: peersText((reply.json.peers ?? []) as Peer[], currentLang()) }
  }).catch(() => ({ result: t(currentLang(), 'tool.sendFailed', { error: '' }) }))

  on('tool.call', { tool: 'mcp__ide-bridge__send_to_session' }, async ($, e) => {
    const expectsReply = !e.replyTo && e.expectsReply !== false
    const reply = await call($, 'POST', '/messages', {
      sessionId,
      to: e.to,
      text: e.text,
      replyTo: e.replyTo,
      expectsReply,
      requestKey: e.tool_use_id,
    }).catch((error: unknown): Reply => ({ ok: false, status: 0, json: { error: String(error) } }))
    if (!reply.ok) return { result: t(currentLang(), 'tool.sendFailed', { error: String(reply.json.error) }) }
    return { result: sentText(reply.json, expectsReply, currentLang()) }
  }).catch(() => ({ result: t(currentLang(), 'tool.sendFailed', { error: '' }) }))

  on('tool.call', { tool: 'mcp__ide-bridge__cancel_request' }, async ($, e) => {
    const reply = await call($, 'POST', '/messages/cancel', { sessionId, ids: e.ids, reason: e.reason }).catch(
      (error: unknown): Reply => ({ ok: false, status: 0, json: { error: String(error) } }),
    )
    if (!reply.ok) return { result: t(currentLang(), 'tool.cancelFailed', { error: String(reply.json.error) }) }
    return { result: cancelText(reply.json, currentLang()) }
  }).catch(() => ({ result: t(currentLang(), 'tool.cancelFailed', { error: '' }) }))

  on('tool.call', { tool: 'mcp__ide-bridge__routine_no_update' }, async $ =>
    bridgeTool($, '/routines/report', { sessionId, kind: 'quiet' }, () => t(currentLang(), 'tool.quietOk')),
  ).catch(() => ({ result: t(currentLang(), 'tool.sendFailed', { error: '' }) }))
  on('tool.call', { tool: 'mcp__ide-bridge__routine_report_failure' }, async ($, e) =>
    bridgeTool($, '/routines/report', { sessionId, kind: 'failed', reason: e.reason }, () => t(currentLang(), 'tool.failureOk')),
  ).catch(() => ({ result: t(currentLang(), 'tool.sendFailed', { error: '' }) }))
  on('tool.call', { tool: 'mcp__ide-bridge__await_event' }, async ($, e) =>
    bridgeTool($, '/waits', { sessionId, note: e.note }, json => t(currentLang(), 'tool.waitOpened', { id: String(json.id) })),
  ).catch(() => ({ result: t(currentLang(), 'tool.sendFailed', { error: '' }) }))
  on('tool.call', { tool: 'mcp__ide-bridge__close_wait' }, async ($, e) => {
    const id = String(e.id ?? '').replace(/^w/, '')
    return bridgeTool($, `/waits/${id}/close`, { sessionId }, () => t(currentLang(), 'tool.waitClosed', { id: `w${id}` }))
  }).catch(() => ({ result: t(currentLang(), 'tool.sendFailed', { error: '' }) }))

  for (const [name, action] of Object.entries(BROWSER_TOOLS)) {
    on('tool.call', { tool: `mcp__ide-bridge__${name}` }, async ($, e) => {
      const { tool, tool_use_id, agentId, ...args } = e as unknown as Record<string, unknown>
      void tool
      void tool_use_id
      void agentId
      const reply = await call($, 'POST', '/browser/act', { sessionId, action, args }).catch(
        (error: unknown): Reply => ({ ok: false, status: 0, json: { error: String(error) } }),
      )
      return { result: reply.ok ? String(reply.json.text ?? '') : t(currentLang(), 'tool.browserFailed', { error: String(reply.json.error) }) }
    }).catch(() => ({ result: t(currentLang(), 'tool.browserFailed', { error: '' }) }))
  }

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
    openTools += 1
    // Only the main loop's calls show its turn still runs (settleRestored): a subagent's
    // can go on after the turn that started it ended.
    const main = agentId === undefined
    if (main) turnSignalAt = Date.now()
    void reportActivity($).catch(() => undefined)
    try {
      return await next(e)
    } finally {
      if (main) turnSignalAt = Date.now()
      openTools = Math.max(0, openTools - 1)
      void reportActivity($).catch(() => undefined)
    }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    const extra = restate ? await restateContext($).catch(() => undefined) : await pendingContext($).catch(() => undefined)
    restate = false
    const held = await releaseHeld($).catch(() => [])
    const context = [...(e.context ?? []), ...(extra ? [extra] : []), ...held]
    return next(context.length > (e.context ?? []).length ? { ...e, context } : e)
  }).catch(($, e, next) => next(e))

  // A permission ask while the person is away (the bridge knows from the app): it goes to the
  // app's decision queue and Telegram, and this hook waits for the answer. At the desk, or
  // when the person picks 'answer in the terminal', the terminal's own dialog asks as before.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || !sessionId || !e.tool_use_id || e.approver !== 'person' || e.ceiling === 'ask') return verdict
    // What the person could not see in full away from the terminal is asked there only.
    const shown = approvalSummary(e.tool, e.input)
    if (!shown.complete) return verdict
    const presence = await call($, 'GET', '/presence').catch(() => undefined)
    if (presence?.json.away !== true) return verdict
    const posted = await call($, 'POST', '/approvals', {
      sessionId,
      tool: e.tool,
      summary: shown.summary,
      cwd,
      reason: verdict.reason ?? '',
      requestKey: e.tool_use_id,
    }).catch(() => undefined)
    if (!posted?.ok) return verdict
    const id = String(posted.json.id)
    // Long polls, never a sleep: the wait stays out of the hook's 10 s (approval.ts).
    const { answer, note } = await waitApproval({
      until: (await $.clock.now()) + APPROVAL_WAIT_MS,
      now: () => $.clock.now(),
      poll: waitMs => call($, 'GET', `/approvals/${id}?wait=${waitMs}`),
      aborted: () => next.signal.aborted,
      reconnect: () => ensureBridge($),
      sleep: ms => $.clock.sleep(ms, { signal: next.signal }),
      abandon: () => call($, 'POST', `/approvals/${id}/abandon`, { sessionId }),
    })
    if (answer === 'allow') return { decision: 'allow', reason: t(currentLang(), 'mod.allowedRemote', { id }) }
    if (answer === 'deny') return { decision: 'deny', reason: note ? t(currentLang(), 'mod.deniedRemoteNote', { id, note }) : t(currentLang(), 'mod.deniedRemote', { id }) }
    return verdict
  }).catch(($, e, next) => next(e))

  // The summary is told to keep what Switchboard names; whatever it drops, the next prompt
  // brings back (restateContext). A precompute is only a dry run.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const keep = t(currentLang(), 'mod.compactKeep')
    const done = await next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${keep}` : keep })
    if (!('skip' in done && done.skip)) restate = true
    return done
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      busy = true
      mainTurnId = e.turnId
      turnSignalAt = Date.now()
      void keepTurn($)
      if (turnItems.length > 0 && turnItems.every(id => cancelledIds.has(id))) {
        void $.turn.abort({ turnId: e.turnId }).catch(() => undefined)
      }
    }
    void reportActivity($).catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      busy = false
      turnSignalAt = Date.now()
      openTools = 0
      // An interrupted turn answered nothing: the bridge sends no result for its requests and
      // ends a scheduled run it carried as failed.
      if (answering.length > 0 && sessionId) {
        void sendSurely($, '/messages/turn-end', { sessionId, ids: answering, answer: e.answer, aborted: e.isAborted })
      }
      answering = []
      turnItems = []
      await keepTurn($)
      void flush($)
      void reportUsage($)
      void touchSeen($).catch(() => undefined)
    } else if (sessionId) {
      void post($, '에이전트', t(currentLang(), 'mod.agentEnd', { text: e.answer.split('\n')[0]?.slice(0, 120) ?? '' }))
    }
    void reportAgents($)
    void reportActivity($).catch(() => undefined)
    return next(e)
  })
}

// Switchboard bridge: one local process that every project's Claude Code session
// (through the mod) and the Electron IDE talk to over a Unix socket.
// Run directly with Node 24 (type stripping): node bridge/server.ts
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { debugRoutes } from './debug.ts'
import { eventKindLabel, nodeOwnerLabel, nodeStatusLabel, resolveLang, setLang, stageLabel, tIn, type Key, type Lang, type Vars } from '../src/shared/i18n/index.ts'

export type Option = { key: string; label: string }

export type QuestionRow = {
  id: number
  session_id: string
  project: string
  task_title: string
  question: string
  body: string
  options: string
  recommend: string
  reason: string
  status: 'pending' | 'answered' | 'held'
  choice: string | null
  memo: string | null
  created_at: number
  answered_at: number | null
  delivered: number
}

const SCHEMA = `
create table if not exists sessions (
  id text primary key, project text not null, cwd text not null,
  started_at integer not null, last_seen integer not null
);
create table if not exists tasks (
  id integer primary key, session_id text not null, project text not null,
  title text not null, stage text not null default '요구',
  status text not null default '하는 중', now text not null default '',
  created_at integer not null, updated_at integer not null,
  unique (session_id, title)
);
create table if not exists questions (
  id integer primary key, session_id text not null, project text not null,
  task_title text not null default '', question text not null,
  body text not null default '', options text not null default '[]',
  recommend text not null default '', reason text not null default '',
  status text not null default 'pending', choice text, memo text,
  created_at integer not null, answered_at integer,
  delivered integer not null default 0
);
create table if not exists events (
  id integer primary key, ts integer not null, session_id text not null,
  project text not null, task_title text not null default '',
  kind text not null, text text not null
);
create index if not exists events_ts on events (ts);
create table if not exists outbox (
  id integer primary key, session_id text not null, kind text not null default '메시지',
  task_title text not null default '', text text not null,
  created_at integer not null, delivered integer not null default 0
);
create table if not exists agents (
  id text primary key, session_id text not null, task_title text not null default '',
  node_key text not null default '', description text not null default '', type text not null default '',
  status text not null default 'running', created_at integer not null, updated_at integer not null
);
create table if not exists commands (
  id integer primary key, session_id text not null, kind text not null, payload text not null default '{}',
  created_at integer not null, done_at integer, result text
);
create table if not exists settings (key text primary key, value text not null);
create table if not exists nodes (
  id integer primary key, task_id integer not null, key text not null,
  title text not null, kind text not null default '구현', owner text not null default '작업자',
  stage text, status text not null default '대기', after text not null default '[]',
  round integer not null default 1, note text not null default '',
  updated_at integer not null,
  unique (task_id, key)
);
`

export const STAGES = ['요구', '설계', '작업', '완료'] as const
export const NODE_KINDS = ['시험', '확인', '구현', '검토', '기타'] as const
export const NODE_OWNERS = ['작업자', '검토자', '사용자', '오케스트레이터'] as const
export const NODE_STATUSES = ['대기', '지금', '끝', '실패'] as const
export const COMMAND_KINDS = ['pause', 'resume', 'stop', 'message', 'transcript', 'report', 'sync'] as const
// Task summary fields the session fills with set_task (the task header in the IDE).
export const TASK_FIELDS = ['why', 'what', 'result', 'artifact', 'tests', 'branch'] as const

// "[task::node] what it does": an Agent description in this shape ties the agent to a node.
export function agentTarget(description: string): { taskTitle: string; nodeKey: string } {
  const match = /^\[([^\]]+?)::([^\]]+?)\]/.exec(description)
  return match ? { taskTitle: match[1]!.trim(), nodeKey: match[2]!.trim() } : { taskTitle: '', nodeKey: '' }
}

// A session's agent CLI ("claude", "codex", "custom:my-llama") and its app terminal id.
export const AGENT_KIND = /^[a-z0-9][a-z0-9:_-]{0,47}$/
export const TERMINAL_ID = /^[A-Za-z0-9_-]{0,64}$/
// Commands an agent without the mod can still follow: they become a prompt (mod/hooks/batch.ts commandPrompt).
const PROMPT_COMMANDS = ['message', 'report', 'sync']

export function defaultSocketPath(): string {
  return process.env.CLAUDE_IDE_SOCKET ?? join(homedir(), '.claude-ide', 'bridge.sock')
}

export function defaultDbPath(): string {
  return process.env.CLAUDE_IDE_DB ?? join(homedir(), '.claude-ide', 'ide.db')
}

type Json = Record<string, unknown>

// Errors the bridge words itself reach the person in the UI language; anything else is wrapped.
class BridgeError extends Error {
  key: Key
  constructor(key: Key) {
    super(key)
    this.key = key
  }
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BridgeError('bridge.badJson')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BridgeError('bridge.notObject')
  }
  return parsed as Json
}

// ~/.claude-ide holds the answers and the socket: only its owner may read it.
function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (dir === join(homedir(), '.claude-ide')) chmodSync(dir, 0o700)
}

const DAY = 24 * 3600_000

// Two folders with the same last name (/a/web, /b/web) would share one project:
// the later one is named with its parent ("b/web").
export function projectName(cwd: string, taken: readonly { project: string; cwd: string }[]): string {
  const parts = cwd.split('/').filter(Boolean)
  const name = parts.at(-1) ?? ''
  if (!name || parts.length < 2) return name
  return taken.some(s => s.project === name && s.cwd !== cwd) ? `${parts.at(-2)}/${name}` : name
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function sse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write(': connected\n\n')
}

function sseSend(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// The answer as the session reads it, in the UI language.
export function deliveryText(q: QuestionRow, lang: Lang = 'ko'): string {
  const options = JSON.parse(q.options) as Option[]
  const picked = options.find(o => o.key === q.choice)
  const lines = [tIn(lang, 'prompt.answer.head', { id: q.id }), tIn(lang, 'prompt.answer.question', { question: q.question })]
  if (q.choice) lines.push(tIn(lang, 'prompt.answer.picked', { key: q.choice, label: picked?.label ?? '' }).trimEnd())
  else lines.push(tIn(lang, 'prompt.answer.none'))
  if (q.memo) lines.push(tIn(lang, 'prompt.answer.memo', { memo: q.memo }))
  lines.push(tIn(lang, 'prompt.answer.go'))
  return lines.join('\n')
}

// The log line of a node status change: what happened, who owns the node, and the round.
// "끝, 작업자: 화면 구현", "다시 시작, 검토자: 독립 검토 (2회차)".
export function nodeEventText(status: string, owner: string, title: string, round: number, restarted: boolean, note = '', lang: Lang = 'ko'): string {
  const word = status === '지금' ? tIn(lang, restarted ? 'bridge.restarted' : 'eventKind.started') : nodeStatusLabel(status, lang)
  const rounds = round > 1 ? ` (${tIn(lang, 'taskView.round', { n: round })})` : ''
  return `${word}, ${nodeOwnerLabel(owner, lang)}: ${title}${rounds}${note ? ` / ${note}` : ''}`
}

// The locale the bridge falls back to when no language is set: the system's, like the app's.
export function systemLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale
}

export function createBridge(dbPath: string, locale = systemLocale()) {
  privateDir(dirname(dbPath))
  const db = new DatabaseSync(dbPath)
  db.exec('pragma journal_mode = wal;')
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(file)) chmodSync(file, 0o600)
  db.exec(SCHEMA)
  // Columns added after the first release: create them on databases made before.
  const addColumns = (table: string, columns: [string, string][]) => {
    const have = (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map(c => c.name)
    for (const [name, type] of columns) if (!have.includes(name)) db.exec(`alter table ${table} add column ${name} ${type}`)
  }
  addColumns('nodes', [['worktree', 'text'], ['branch', 'text']])
  addColumns('tasks', [
    ...TASK_FIELDS.map((f): [string, string] => [f, "text not null default ''"]),
    ['number', 'integer'],
    ['archived_at', 'integer'],
    ['restored_at', 'integer'],
  ])
  addColumns('sessions', [['usage', "text not null default '{}'"]])
  addColumns('questions', [['turn_id', "text not null default ''"]])
  addColumns('questions', [['request_key', "text not null default ''"]])
  // Which agent CLI a session runs in (sessions before this were all Claude Code)
  // and the app terminal it runs in, when it does.
  addColumns('sessions', [['agent', "text not null default 'claude'"], ['terminal', "text not null default ''"]])
  db.exec('update tasks set number = id where number is null')

  // Feature area: UI language. Errors, log lines and texts for sessions follow the `lang` setting.
  const langNow = (): Lang => {
    const row = db.prepare("select value from settings where key = 'lang'").get() as { value: string } | undefined
    return resolveLang(row ? JSON.parse(row.value) : undefined, locale)
  }
  const say = (key: Key, vars?: Vars): string => tIn(langNow(), key, vars)

  const watchers = new Set<ServerResponse>()
  const deliveryWatchers = new Map<string, Set<ServerResponse>>()

  const now = () => Date.now()
  const changed = (type: string) => {
    for (const res of watchers) sseSend(res, 'change', { type })
  }

  const projectOf = (sessionId: string): string => {
    const row = db.prepare('select project from sessions where id = ?').get(sessionId) as
      | { project: string }
      | undefined
    return row?.project ?? say('bridge.unknownProject')
  }

  const logEvent = (sessionId: string, kind: string, text: string, taskTitle = '') => {
    db.prepare(
      'insert into events (ts, session_id, project, task_title, kind, text) values (?, ?, ?, ?, ?, ?)',
    ).run(now(), sessionId, projectOf(sessionId), taskTitle, kind, text)
    db.prepare('delete from events where id <= (select max(id) - 5000 from events)').run()
  }

  const undelivered = (sessionId: string): QuestionRow[] =>
    db
      .prepare(
        "select * from questions where session_id = ? and status = 'answered' and delivered = 0 order by id",
      )
      .all(sessionId) as QuestionRow[]

  // Everything waiting for a session, oldest first: answers ("q<id>") and
  // messages the IDE sent, such as screen comments ("m<id>").
  const pushDeliveries = (sessionId: string, only?: ServerResponse) => {
    const targets = only ? new Set([only]) : deliveryWatchers.get(sessionId)
    if (!targets || targets.size === 0) return
    const messages = db
      .prepare('select id, text, created_at from outbox where session_id = ? and delivered = 0 order by id')
      .all(sessionId) as { id: number; text: string; created_at: number }[]
    const items = [
      ...undelivered(sessionId).map(q => ({ id: `q${q.id}`, text: deliveryText(q, langNow()), at: q.answered_at ?? 0 })),
      ...messages.map(m => ({ id: `m${m.id}`, text: m.text, at: m.created_at })),
    ].sort((a, b) => a.at - b.at)
    for (const item of items) {
      for (const res of targets) sseSend(res, 'delivery', { id: item.id, text: item.text })
    }
  }

  const taskIdOf = (sessionId: string, title: string): number => {
    const t = now()
    db.prepare(
      `insert into tasks (session_id, project, title, created_at, updated_at) values (?, ?, ?, ?, ?)
       on conflict (session_id, title) do update set updated_at = excluded.updated_at`,
    ).run(sessionId, projectOf(sessionId), title, t, t)
    const row = db.prepare('select id from tasks where session_id = ? and title = ?').get(sessionId, title) as {
      id: number
    }
    numberTask(row.id)
    revive(row.id)
    return row.id
  }

  // Every task gets a running number when it first appears (the badge in the task list).
  const numberTask = (taskId: number) => {
    db.prepare('update tasks set number = (select coalesce(max(number), 0) + 1 from tasks) where id = ? and number is null').run(taskId)
  }

  // New activity on an archived task brings it back to the task list.
  const revive = (taskId: number) => {
    const task = db.prepare('select session_id, title, status from tasks where id = ?').get(taskId) as
      | { session_id: string; title: string; status: string }
      | undefined
    if (!task || task.status !== '보관') return
    const t = now()
    db.prepare("update tasks set status = '하는 중', archived_at = null, restored_at = ?, updated_at = ? where id = ?").run(t, t, taskId)
    logEvent(task.session_id, '되살림', say('bridge.event.revived'), task.title)
    changed('tasks')
  }

  const taskByTitle = (sessionId: string, title: string) =>
    db.prepare('select id from tasks where session_id = ? and title = ?').get(sessionId, title) as { id: number } | undefined

  const archive = (taskId: number) => {
    const task = db.prepare('select session_id, title, status from tasks where id = ?').get(taskId) as
      | { session_id: string; title: string; status: string }
      | undefined
    if (!task || task.status === '보관') return false
    db.prepare("update tasks set status = '보관', archived_at = ?, updated_at = ? where id = ?").run(now(), now(), taskId)
    logEvent(task.session_id, '보관', task.title, task.title)
    return true
  }

  const pendingCommands = (sessionId: string) =>
    db.prepare('select id, kind, payload from commands where session_id = ? and done_at is null order by id').all(sessionId) as {
      id: number
      kind: string
      payload: string
    }[]

  // Commands go to the mod at once and are not batched: they control the session, not its conversation.
  // A new stream gets every pending command; streams already open get only the new one.
  const pushCommands = (sessionId: string, target: { only: ServerResponse } | { id: number }) => {
    const targets = 'only' in target ? new Set([target.only]) : deliveryWatchers.get(sessionId)
    if (!targets || targets.size === 0) return
    const list = pendingCommands(sessionId).filter(c => 'only' in target || c.id === target.id)
    for (const c of list) {
      for (const res of targets) sseSend(res, 'command', { id: c.id, kind: c.kind, payload: JSON.parse(c.payload) })
    }
  }

  // Answer to Q2: a task's stage is the first stage that still has an unfinished
  // node; with every staged node finished it is 완료. Tasks without staged nodes keep theirs.
  const syncStage = (taskId: number) => {
    const rows = db.prepare('select stage, status from nodes where task_id = ? and stage is not null').all(taskId) as {
      stage: string
      status: string
    }[]
    if (rows.length === 0) return
    const open = STAGES.find(stage => rows.some(r => r.stage === stage && r.status !== '끝')) ?? '완료'
    const task = db.prepare('select session_id, title, stage from tasks where id = ?').get(taskId) as {
      session_id: string
      title: string
      stage: string
    }
    if (task.stage === open) return
    db.prepare('update tasks set stage = ?, updated_at = ? where id = ?').run(open, now(), taskId)
    logEvent(task.session_id, '단계', say('bridge.event.stage', { from: stageLabel(task.stage, langNow()), to: stageLabel(open, langNow()) }), task.title)
    changed('tasks')
  }

  // Sessions whose delivery stream is open: the mod's, or the app's for a CLI in its terminal.
  const liveSessions = () => [...deliveryWatchers].filter(([, set]) => set.size > 0).map(([id]) => id)

  // Retention. Questions are history and stay. Delivered messages, done commands and
  // ended subagents go after 7 days; events keep the newest 5000; commands a session
  // never picked up go once it has not been seen for a day.
  const prune = (at = now()) => {
    db.prepare('delete from outbox where delivered = 1 and created_at < ?').run(at - 7 * DAY)
    db.prepare('delete from commands where done_at is not null and done_at < ?').run(at - 7 * DAY)
    db.prepare("delete from agents where status in ('completed', 'failed', 'killed') and updated_at < ?").run(at - 7 * DAY)
    db.prepare('delete from events where id <= (select max(id) - 5000 from events)').run()
    const live = liveSessions()
    db.prepare(
      `delete from commands where done_at is null
       and session_id not in (select value from json_each(?))
       and (session_id not in (select id from sessions) or session_id in (select id from sessions where last_seen < ?))`,
    ).run(JSON.stringify(live), at - DAY)
  }
  prune()
  const pruning = setInterval(() => prune(), 3600_000)
  pruning.unref()

  const state = () => ({
    sessions: db.prepare('select * from sessions order by last_seen desc').all(),
    live: liveSessions(),
    // Every running task, however many: the limit only trims waiting ones.
    tasks: db
      .prepare(
        `select * from tasks where status != '보관' and (status = '하는 중'
           or id in (select id from tasks where status != '보관' order by updated_at desc limit 200))
         order by updated_at desc`,
      )
      .all(),
    archived: db.prepare("select * from tasks where status = '보관' order by archived_at desc limit 100").all(),
    agents: db.prepare('select * from agents order by updated_at desc limit 300').all(),
    commands: db
      .prepare('select id, session_id, kind, payload, created_at, done_at from commands order by id desc limit 50')
      .all(),
    settings: Object.fromEntries(
      (db.prepare('select key, value from settings').all() as { key: string; value: string }[]).map(r => [r.key, JSON.parse(r.value)]),
    ),
    questions: db
      .prepare(
        `select * from questions where status in ('pending', 'held')
         union all
         select * from (select * from questions where status = 'answered' order by answered_at desc limit 50)
         order by id desc`,
      )
      .all(),
    answeredCount: (db.prepare("select count(*) n from questions where status = 'answered'").get() as {
      n: number
    }).n,
    answeredByProject: Object.fromEntries(
      (db.prepare("select project, count(*) n from questions where status = 'answered' group by project").all() as {
        project: string
        n: number
      }[]).map(r => [r.project, r.n]),
    ) as Record<string, number>,
    events: db.prepare('select * from (select * from events order by id desc limit 300) order by id').all(),
    nodes: db
      .prepare("select n.* from nodes n join tasks t on t.id = n.task_id where t.status != '보관' order by n.id")
      .all(),
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://bridge')
    const path = url.pathname
    const method = req.method ?? 'GET'
    // Shared helpers (dev targets) word their errors through the module language.
    setLang(langNow())

    if (method === 'GET' && path === '/health') return send(res, 200, { ok: true })
    if (method === 'GET' && path === '/state') return send(res, 200, state())

    if (method === 'GET' && path === '/stream') {
      sse(res)
      watchers.add(res)
      req.on('close', () => watchers.delete(res))
      return
    }

    if (method === 'GET' && path === '/deliveries') {
      const sessionId = url.searchParams.get('session') ?? ''
      if (!sessionId) return send(res, 400, { error: say('bridge.noSession') })
      sse(res)
      const set = deliveryWatchers.get(sessionId) ?? new Set()
      set.add(res)
      deliveryWatchers.set(sessionId, set)
      // The app shows which sessions can take an answer now (state().live).
      if (set.size === 1) changed('sessions')
      req.on('close', () => {
        set.delete(res)
        if (set.size === 0) changed('sessions')
      })
      db.prepare('update sessions set last_seen = ? where id = ?').run(now(), sessionId)
      pushDeliveries(sessionId, res)
      pushCommands(sessionId, { only: res })
      return
    }

    if (method === 'POST' && path === '/sessions') {
      const body = await readJson(req)
      const id = str(body.id)
      if (!id) return send(res, 400, { error: say('bridge.noSession') })
      const cwd = str(body.cwd)
      const agent = str(body.agent).trim()
      const terminal = str(body.terminal).trim()
      if (agent && !AGENT_KIND.test(agent)) return send(res, 400, { error: say('bridge.badAgent') })
      if (!TERMINAL_ID.test(terminal)) return send(res, 400, { error: say('bridge.badTerminal') })
      const known = db.prepare('select project from sessions where id = ?').get(id) as { project: string } | undefined
      const taken = db.prepare('select project, cwd from sessions where id != ?').all(id) as { project: string; cwd: string }[]
      // A session registers again on every reconnect: it keeps the name it got first,
      // and its agent and terminal unless it names them again.
      const project = str(body.project) || known?.project || projectName(cwd, taken) || id
      db.prepare(
        `insert into sessions (id, project, cwd, started_at, last_seen, agent, terminal)
         values (?, ?, ?, ?, ?, coalesce(nullif(?, ''), 'claude'), ?)
         on conflict (id) do update set project = excluded.project, cwd = excluded.cwd, last_seen = excluded.last_seen,
           agent = coalesce(nullif(?, ''), sessions.agent), terminal = coalesce(nullif(?, ''), sessions.terminal)`,
      ).run(id, project, cwd, now(), now(), agent, terminal, agent, terminal)
      changed('sessions')
      return send(res, 200, { id, project })
    }

    if (method === 'POST' && path === '/tasks') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      const title = str(body.title).trim()
      if (!sessionId || !title) return send(res, 400, { error: say('bridge.needSessionTitle') })
      const stage = str(body.stage)
      if (stage && !(STAGES as readonly string[]).includes(stage)) {
        return send(res, 400, { error: say('bridge.badStage', { values: STAGES.join(', ') }) })
      }
      const existing = taskByTitle(sessionId, title)
      if (existing && str(body.status) !== '보관') revive(existing.id)
      const t = now()
      db.prepare(
        `insert into tasks (session_id, project, title, stage, status, now, created_at, updated_at)
         values (?, ?, ?, coalesce(nullif(?, ''), '요구'), coalesce(nullif(?, ''), '하는 중'), ?, ?, ?)
         on conflict (session_id, title) do update set
           stage = coalesce(nullif(?, ''), tasks.stage),
           status = coalesce(nullif(?, ''), tasks.status),
           now = coalesce(?, tasks.now),
           updated_at = excluded.updated_at`,
      ).run(
        sessionId, projectOf(sessionId), title, stage, str(body.status), str(body.now), t, t,
        stage, str(body.status), typeof body.now === 'string' ? body.now : null,
      )
      const saved = taskByTitle(sessionId, title)!
      numberTask(saved.id)
      for (const field of TASK_FIELDS) {
        if (typeof body[field] === 'string') db.prepare(`update tasks set ${field} = ? where id = ?`).run(body[field], saved.id)
      }
      if (str(body.status) === '보관') db.prepare('update tasks set archived_at = coalesce(archived_at, ?) where id = ?').run(t, saved.id)
      logEvent(sessionId, '작업', `${title}: ${[stage && stageLabel(stage, langNow()), str(body.now)].filter(Boolean).join(', ') || say('bridge.event.updated')}`, title)
      changed('tasks')
      const row = db.prepare('select * from tasks where session_id = ? and title = ?').get(sessionId, title)
      return send(res, 200, row)
    }

    if (method === 'POST' && path === '/questions') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      const question = str(body.question).trim()
      if (!sessionId || !question) return send(res, 400, { error: say('bridge.needSessionQuestion') })
      const options = Array.isArray(body.options) ? body.options : []
      const clean: Option[] = options
        .filter((o): o is Json => o !== null && typeof o === 'object')
        .map(o => ({ key: str(o.key).trim(), label: str(o.label).trim() }))
        .filter(o => o.key && o.label)
      const taskTitle = str(body.taskTitle)
      // One question, asked once. The same call seen again (its tool_use_id) gets its
      // question back, answered or not; the same question asked again while the first
      // still waits (a model retrying, or asking after a compaction) gets the first.
      const requestKey = str(body.requestKey)
      const same = db
        .prepare(
          `select id from questions where session_id = ? and (
             (? != '' and request_key = ?)
             or (status in ('pending', 'held') and question = ? and options = ?))
           order by id limit 1`,
        )
        .get(sessionId, requestKey, requestKey, question, JSON.stringify(clean)) as { id: number } | undefined
      if (same) return send(res, 200, { id: same.id, duplicate: true })
      const result = db
        .prepare(
          `insert into questions (session_id, project, task_title, question, body, options, recommend, reason, created_at, turn_id, request_key)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId, projectOf(sessionId), taskTitle, question, str(body.body),
          JSON.stringify(clean), str(body.recommend), str(body.reason), now(), str(body.turnId), requestKey,
        )
      const owner = taskTitle ? taskByTitle(sessionId, taskTitle) : undefined
      if (owner) revive(owner.id)
      const id = Number(result.lastInsertRowid)
      logEvent(sessionId, '결정 대기', `Q${id} ${question}`, taskTitle)
      changed('questions')
      return send(res, 200, { id })
    }

    const answer = path.match(/^\/questions\/(\d+)\/(answer|hold)$/)
    if (method === 'POST' && answer) {
      const id = Number(answer[1])
      const q = db.prepare('select * from questions where id = ?').get(id) as QuestionRow | undefined
      if (!q) return send(res, 404, { error: say('bridge.noQuestion', { id }) })
      if (q.status === 'answered') return send(res, 409, { error: say('bridge.alreadyAnswered', { id }) })
      if (answer[2] === 'hold') {
        db.prepare("update questions set status = 'held' where id = ?").run(id)
        logEvent(q.session_id, '보류', `Q${id} ${q.question}`, q.task_title)
        changed('questions')
        return send(res, 200, { id, status: 'held' })
      }
      const body = await readJson(req)
      const choice = str(body.choice).trim()
      const memo = str(body.memo).trim()
      const keys = (JSON.parse(q.options) as Option[]).map(o => o.key)
      if (choice && !keys.includes(choice)) {
        const error = keys.length > 0 ? say('bridge.badChoice', { keys: keys.join(', ') }) : say('bridge.noOptions')
        return send(res, 400, { error })
      }
      if (!choice && !memo) return send(res, 400, { error: say('bridge.needAnswer') })
      db.prepare(
        "update questions set status = 'answered', choice = ?, memo = ?, answered_at = ?, delivered = 0 where id = ?",
      ).run(choice || null, memo || null, now(), id)
      logEvent(q.session_id, '답함', `Q${id} ${choice ? `(${choice})` : say('history.memo')} ${q.question}`, q.task_title)
      changed('questions')
      pushDeliveries(q.session_id)
      return send(res, 200, { id, status: 'answered' })
    }

    const ackMessage = path.match(/^\/deliveries\/m(\d+)\/ack$/)
    if (method === 'POST' && ackMessage) {
      const id = Number(ackMessage[1])
      const result = db.prepare('update outbox set delivered = 1 where id = ? and delivered = 0').run(id)
      if (result.changes > 0) {
        const m = db.prepare('select * from outbox where id = ?').get(id) as {
          session_id: string
          kind: string
          task_title: string
        }
        logEvent(m.session_id, '전달', say('bridge.event.injected', { kind: eventKindLabel(m.kind, langNow()) }), m.task_title)
        changed('outbox')
      }
      return send(res, 200, { id: `m${id}`, delivered: true })
    }

    // Answers: "q<id>", or a bare number from mods older than the outbox.
    const ack = path.match(/^\/deliveries\/q?(\d+)\/ack$/)
    if (method === 'POST' && ack) {
      const id = Number(ack[1])
      const result = db.prepare('update questions set delivered = 1 where id = ? and delivered = 0').run(id)
      if (result.changes > 0) {
        const q = db.prepare('select * from questions where id = ?').get(id) as QuestionRow
        logEvent(q.session_id, '전달', say('bridge.event.answerInjected', { id }), q.task_title)
        changed('questions')
      }
      return send(res, 200, { id, delivered: true })
    }

    // Plan: create or rewrite a task's nodes. Nodes left out of a later plan stay.
    if (method === 'POST' && path === '/nodes') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      const taskTitle = str(body.taskTitle).trim()
      const list = Array.isArray(body.nodes) ? body.nodes : []
      if (!sessionId || !taskTitle || list.length === 0) {
        return send(res, 400, { error: say('bridge.needNodes') })
      }
      const nodes = list.filter((n): n is Json => n !== null && typeof n === 'object')
      // A node may come after one this request leaves out but an earlier plan of the task made.
      const existing = db
        .prepare('select n.key from nodes n join tasks t on t.id = n.task_id where t.session_id = ? and t.title = ?')
        .all(sessionId, taskTitle) as { key: string }[]
      const keys = new Set([...nodes.map(n => str(n.key).trim()), ...existing.map(n => n.key)])
      for (const n of nodes) {
        const key = str(n.key).trim()
        if (!key || !str(n.title).trim()) return send(res, 400, { error: say('bridge.nodeNeedsKey') })
        const bad = (value: string, allowed: readonly string[]) => value !== '' && !allowed.includes(value)
        if (bad(str(n.kind), NODE_KINDS)) return send(res, 400, { error: say('bridge.badKind', { values: NODE_KINDS.join(', ') }) })
        if (bad(str(n.owner), NODE_OWNERS)) return send(res, 400, { error: say('bridge.badOwner', { values: NODE_OWNERS.join(', ') }) })
        if (bad(str(n.stage), STAGES)) return send(res, 400, { error: say('bridge.badStage', { values: STAGES.join(', ') }) })
        const after = Array.isArray(n.after) ? n.after.map(a => str(a)) : []
        const unknown = after.find(a => !keys.has(a))
        if (unknown) return send(res, 400, { error: say('bridge.unknownAfter', { key, unknown }) })
      }
      const taskId = taskIdOf(sessionId, taskTitle)
      const upsert = db.prepare(
        `insert into nodes (task_id, key, title, kind, owner, stage, after, updated_at)
         values (?, ?, ?, coalesce(nullif(?, ''), '구현'), coalesce(nullif(?, ''), '작업자'), nullif(?, ''), ?, ?)
         on conflict (task_id, key) do update set
           title = excluded.title, kind = excluded.kind, owner = excluded.owner,
           stage = excluded.stage, after = excluded.after, updated_at = excluded.updated_at`,
      )
      for (const n of nodes) {
        upsert.run(
          taskId, str(n.key).trim(), str(n.title).trim(), str(n.kind), str(n.owner), str(n.stage),
          JSON.stringify(Array.isArray(n.after) ? n.after.map(a => str(a)) : []), now(),
        )
      }
      syncStage(taskId)
      logEvent(sessionId, '계획', say('bridge.event.plan', { n: nodes.length, titles: nodes.map(n => str(n.title)).join(', ') }).slice(0, 500), taskTitle)
      changed('nodes')
      return send(res, 200, { taskId, count: nodes.length })
    }

    // A node starting again after it ended is a new round (review, then fixes).
    if (method === 'POST' && path === '/nodes/status') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      const taskTitle = str(body.taskTitle).trim()
      const key = str(body.key).trim()
      const status = str(body.status)
      if (!(NODE_STATUSES as readonly string[]).includes(status)) {
        return send(res, 400, { error: say('bridge.badNodeStatus', { values: NODE_STATUSES.join(', ') }) })
      }
      const task = db.prepare('select id from tasks where session_id = ? and title = ?').get(sessionId, taskTitle) as
        | { id: number }
        | undefined
      const node = task
        ? (db.prepare('select * from nodes where task_id = ? and key = ?').get(task.id, key) as
            | { id: number; title: string; status: string; round: number; owner: string }
            | undefined)
        : undefined
      if (!task || !node) return send(res, 404, { error: say('bridge.noNode', { task: taskTitle, key }) })
      revive(task.id)
      const round = status === '지금' && (node.status === '끝' || node.status === '실패') ? node.round + 1 : node.round
      db.prepare('update nodes set status = ?, round = ?, note = coalesce(?, note), updated_at = ? where id = ?').run(
        status, round, typeof body.note === 'string' ? body.note : null, now(), node.id,
      )
      syncStage(task.id)
      logEvent(sessionId, status === '지금' ? '시작' : status, nodeEventText(status, node.owner, node.title, round, round > node.round, str(body.note), langNow()), taskTitle)
      changed('nodes')
      return send(res, 200, { key, status, round })
    }

    if (method === 'POST' && path === '/outbox') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      const text = str(body.text).trim()
      if (!sessionId || !text) return send(res, 400, { error: say('bridge.needText') })
      const known = db.prepare('select 1 from sessions where id = ?').get(sessionId)
      if (!known) return send(res, 404, { error: say('bridge.noSessionFound', { id: sessionId }) })
      const kind = str(body.kind) || '메시지'
      const taskTitle = str(body.taskTitle)
      const result = db
        .prepare('insert into outbox (session_id, kind, task_title, text, created_at) values (?, ?, ?, ?, ?)')
        .run(sessionId, kind, taskTitle, text, now())
      logEvent(sessionId, kind, text.split('\n')[0]?.slice(0, 200) ?? '', taskTitle)
      changed('outbox')
      pushDeliveries(sessionId)
      return send(res, 200, { id: `m${Number(result.lastInsertRowid)}` })
    }

    // The Orca worktree a node's worker uses; null worktree clears it after removal.
    if (method === 'POST' && path === '/nodes/worktree') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      const taskTitle = str(body.taskTitle).trim()
      const key = str(body.key).trim()
      const worktree = typeof body.worktree === 'string' && body.worktree ? body.worktree : null
      const branch = typeof body.branch === 'string' && body.branch ? body.branch : null
      const node = db
        .prepare(
          `select n.id, n.title, t.session_id, t.title task_title from nodes n join tasks t on t.id = n.task_id
           where (t.session_id = ? and t.title = ? and n.key = ?) or n.id = ?`,
        )
        .get(sessionId, taskTitle, key, Number(body.nodeId ?? 0)) as
        | { id: number; title: string; session_id: string; task_title: string }
        | undefined
      if (!node) return send(res, 404, { error: say('bridge.noNode', { task: taskTitle, key }) })
      db.prepare('update nodes set worktree = ?, branch = ?, updated_at = ? where id = ?').run(worktree, branch, now(), node.id)
      logEvent(
        node.session_id,
        '워크트리',
        worktree ? `${node.title}: ${branch ?? ''} ${worktree}`.trim() : say('bridge.event.worktreeCleared', { title: node.title }),
        node.task_title,
      )
      changed('nodes')
      return send(res, 200, { id: node.id, worktree, branch })
    }

    const archiveOne = path.match(/^\/tasks\/(\d+)\/(archive|restore)$/)
    if (method === 'POST' && archiveOne) {
      const id = Number(archiveOne[1])
      if (archiveOne[2] === 'archive') archive(id)
      else revive(id)
      changed('tasks')
      return send(res, 200, { id })
    }

    // Body {project} archives only that project's done tasks. A task the person
    // restored stays out until it has new activity.
    if (method === 'POST' && path === '/tasks/archive-done') {
      const body = await readJson(req)
      const project = str(body.project)
      const done = db
        .prepare(
          `select id from tasks where stage = '완료' and status != '보관'
           and (restored_at is null or restored_at < updated_at) and (? = '' or project = ?)`,
        )
        .all(project, project) as { id: number }[]
      const count = done.filter(t => archive(t.id)).length
      changed('tasks')
      return send(res, 200, { count })
    }

    // The mod reports its session's subagents ($.agent.list()); "[task::node]" descriptions tie them to nodes.
    if (method === 'POST' && path === '/agents') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      const list = Array.isArray(body.agents) ? body.agents.filter((a): a is Json => a !== null && typeof a === 'object') : []
      if (!sessionId) return send(res, 400, { error: say('bridge.noSession') })
      for (const a of list) {
        const id = str(a.id)
        if (!id) continue
        const description = str(a.description)
        const target = agentTarget(description)
        const before = db.prepare('select status from agents where id = ?').get(id) as { status: string } | undefined
        const status = str(a.status, 'running')
        db.prepare(
          `insert into agents (id, session_id, task_title, node_key, description, type, status, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict (id) do update set status = excluded.status, description = excluded.description,
             task_title = excluded.task_title, node_key = excluded.node_key, updated_at = excluded.updated_at`,
        ).run(id, sessionId, target.taskTitle, target.nodeKey, description, str(a.type), status, now(), now())
        if (before?.status !== status && ['completed', 'failed', 'killed'].includes(status)) {
          logEvent(sessionId, '작업자', `${status === 'completed' ? say('nodeStatus.done') : status}: ${description}`.slice(0, 300), target.taskTitle)
        }
      }
      changed('agents')
      return send(res, 200, { count: list.length })
    }

    if (method === 'POST' && path === '/commands') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      const kind = str(body.kind)
      if (!sessionId || !(COMMAND_KINDS as readonly string[]).includes(kind)) {
        return send(res, 400, { error: say('bridge.needCommand', { values: COMMAND_KINDS.join(', ') }) })
      }
      const payload = body.payload !== null && typeof body.payload === 'object' ? body.payload : {}
      const result = db
        .prepare('insert into commands (session_id, kind, payload, created_at) values (?, ?, ?, ?)')
        .run(sessionId, kind, JSON.stringify(payload), now())
      const id = Number(result.lastInsertRowid)
      changed('commands')
      pushCommands(sessionId, { id })
      return send(res, 200, { id })
    }

    const commandDone = path.match(/^\/commands\/(\d+)\/done$/)
    if (method === 'POST' && commandDone) {
      const body = await readJson(req)
      const id = Number(commandDone[1])
      db.prepare('update commands set done_at = coalesce(done_at, ?), result = ? where id = ?').run(now(), JSON.stringify(body.result ?? null), id)
      changed('commands')
      return send(res, 200, { id })
    }

    const commandOne = path.match(/^\/commands\/(\d+)$/)
    if (method === 'GET' && commandOne) {
      const row = db.prepare('select * from commands where id = ?').get(Number(commandOne[1])) as
        | { result: string | null; payload: string }
        | undefined
      if (!row) return send(res, 404, { error: say('bridge.noCommand') })
      return send(res, 200, { ...row, payload: JSON.parse(row.payload), result: row.result === null ? null : JSON.parse(row.result) })
    }

    if (method === 'POST' && path === '/sessions/usage') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      if (!sessionId) return send(res, 400, { error: say('bridge.noSession') })
      db.prepare('update sessions set usage = ?, last_seen = ? where id = ?').run(JSON.stringify(body.usage ?? {}), now(), sessionId)
      changed('sessions')
      return send(res, 200, { ok: true })
    }

    if (method === 'POST' && path === '/settings') {
      const body = await readJson(req)
      const key = str(body.key)
      if (!key) return send(res, 400, { error: say('bridge.noSettingKey') })
      if (body.value === null || body.value === undefined) db.prepare('delete from settings where key = ?').run(key)
      else db.prepare('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(key, JSON.stringify(body.value))
      changed('settings')
      return send(res, 200, { key })
    }

    if (method === 'POST' && path === '/events') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      const text = str(body.text).trim()
      if (!sessionId || !text) return send(res, 400, { error: say('bridge.needText') })
      logEvent(sessionId, str(body.kind, '로그') || '로그', text.slice(0, 500), str(body.taskTitle))
      db.prepare('update sessions set last_seen = ? where id = ?').run(now(), sessionId)
      changed('events')
      return send(res, 200, { ok: true })
    }

    // Feature area: agent CLIs other than Claude Code (mcp/server.ts and the app's terminal typing).
    // An MCP session says it is still there without a full registration (no change event).
    if (method === 'POST' && path === '/sessions/seen') {
      const body = await readJson(req)
      const result = db.prepare('update sessions set last_seen = ? where id = ?').run(now(), str(body.sessionId))
      if (result.changes === 0) return send(res, 404, { error: say('bridge.noSessionFound', { id: str(body.sessionId) }) })
      return send(res, 200, { ok: true })
    }

    // Everything waiting for a session, taken at once and marked delivered: answers ("q<id>")
    // and IDE messages ("m<id>") as text, oldest first, and the commands still open. Commands
    // that can become a prompt come back to be typed; the rest are closed as unsupported.
    if (method === 'POST' && path === '/deliveries/take') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      if (!db.prepare('select 1 from sessions where id = ?').get(sessionId)) {
        return send(res, 404, { error: say('bridge.noSessionFound', { id: sessionId }) })
      }
      const answers = undelivered(sessionId)
      const messages = db
        .prepare('select id, kind, task_title, text, created_at from outbox where session_id = ? and delivered = 0 order by id')
        .all(sessionId) as { id: number; kind: string; task_title: string; text: string; created_at: number }[]
      const items = [
        ...answers.map(q => ({ id: `q${q.id}`, text: deliveryText(q, langNow()), at: q.answered_at ?? 0 })),
        ...messages.map(m => ({ id: `m${m.id}`, text: m.text, at: m.created_at })),
      ].sort((a, b) => a.at - b.at)
      for (const q of answers) {
        db.prepare('update questions set delivered = 1 where id = ?').run(q.id)
        logEvent(sessionId, '전달', say('bridge.event.answerInjected', { id: q.id }), q.task_title)
      }
      for (const m of messages) {
        db.prepare('update outbox set delivered = 1 where id = ?').run(m.id)
        logEvent(sessionId, '전달', say('bridge.event.injected', { kind: eventKindLabel(m.kind, langNow()) }), m.task_title)
      }
      const commands = pendingCommands(sessionId).map(c => ({ id: c.id, kind: c.kind, payload: JSON.parse(c.payload) as Json }))
      const usable = commands.filter(c => PROMPT_COMMANDS.includes(c.kind) && !(c.kind === 'message' && str(c.payload.agentId)))
      for (const c of commands) {
        const result = usable.includes(c) ? { ok: true } : { error: say('bridge.agentCommand') }
        db.prepare('update commands set done_at = coalesce(done_at, ?), result = ? where id = ?').run(now(), JSON.stringify(result), c.id)
      }
      if (answers.length > 0) changed('questions')
      if (messages.length > 0) changed('outbox')
      if (commands.length > 0) changed('commands')
      return send(res, 200, { items: items.map(({ id, text }) => ({ id, text })), commands: usable })
    }

    // Dynamic debugging (bridge/debug.ts): screen comments, open_in_ide, live sessions.
    if (await debugRoutes({ db, watchers, deliveryWatchers }, req, res, method, path, url)) return

    return send(res, 404, { error: say('bridge.noRoute', { method, path }) })
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof BridgeError ? say(error.key) : say('bridge.failed', { error: error instanceof Error ? error.message : String(error) })
      if (!res.headersSent) send(res, 400, { error: message })
      else res.end()
    })
  })

  return { server, db, prune, close: () => { clearInterval(pruning); server.close(); db.close() } }
}

function isAnswering(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = connect(socketPath)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

// A live socket means another bridge already serves it (the IDE and a mod can
// both try to start one at once): refuse rather than take the socket over.
export async function listen(server: Server, socketPath: string): Promise<void> {
  privateDir(dirname(socketPath))
  if (existsSync(socketPath)) {
    if (await isAnswering(socketPath)) throw new Error(`다른 브리지가 이미 ${socketPath}에서 돌고 있습니다`)
    unlinkSync(socketPath)
  }
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  chmodSync(socketPath, 0o600)
}

if (import.meta.main) {
  const socketPath = defaultSocketPath()
  const bridge = createBridge(defaultDbPath())
  try {
    await listen(bridge.server, socketPath)
    console.log(`claude-ide bridge listening on ${socketPath}`)
  } catch (error) {
    console.log(`claude-ide bridge not started: ${error instanceof Error ? error.message : String(error)}`)
    bridge.close()
  }
}

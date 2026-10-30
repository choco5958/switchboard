// Switchboard bridge: one local process that every project's Claude Code session
// (through the mod) and the Electron IDE talk to over a Unix socket.
// Run directly with Node 24 (type stripping): node bridge/server.ts
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { Readable } from 'node:stream'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { debugRoutes } from './debug.ts'
import { APP_HEADER, PROVE_PATH, bridgeProof, curlConfigFile, endpointFile, ideDir, usesTcp } from './endpoint.ts'
import type { Activity } from '../src/shared/stall.ts'
import { limitedUntil } from '../src/shared/limit.ts'
import { maskSecrets } from '../src/shared/pageLog.ts'
import {
  CHAIN_WINDOW_MS,
  DELEGATION_MAX,
  HELD_REPLY_MS,
  OFFLINE_NOTE_MS,
  PAIR_WINDOW_MS,
  PEER_RECIPIENTS_MAX,
  cancelledText,
  clipText,
  forwardText,
  forwardedAnswer,
  noReplyText,
  peerText,
  routineText,
  shellText,
  waitText,
  type NoReply,
  type PeerRow,
} from './peer.ts'
import { ROUTINE_FAIL_LIMIT, nextRun, parseSchedule, type Schedule } from './schedule.ts'
import { TELEGRAM_API, createTelegram } from './telegram.ts'
import { MOBILE_PORT, createMobile } from './mobile.ts'
import { makeVapidKeys, type PushMessage, type VapidKeys } from './push.ts'
import { DICTS, eventKindLabel, nodeOwnerLabel, nodeStatusLabel, resolveLang, setLang, stageLabel, taskStatusLabel, tIn, type Key, type Lang, type Vars } from '../src/shared/i18n/index.ts'

export type Option = { key: string; label: string }

type RoutineRow = {
  id: number
  project: string
  cwd: string
  name: string
  prompt: string
  schedule: string
  missed: 'skip' | 'run-once'
  enabled: number
  next_at: number | null
  created_at: number
  updated_at: number
  failed_off: number
}

type RunRow = {
  id: number
  routine_id: number
  scheduled_for: number
  created_at: number
  session_id: string
  message_id: number | null
  status: 'waiting' | 'sent' | 'done' | 'quiet' | 'failed' | 'skipped' | 'missed'
  quiet: number
  failure: string
  result: string
  finished_at: number | null
  opened: number
}

type ApprovalRow = {
  id: number
  session_id: string
  project: string
  tool: string
  summary: string
  cwd: string
  reason: string
  status: 'pending' | 'allow' | 'deny' | 'terminal' | 'expired'
  created_at: number
}

type OutboxRow = PeerRow & {
  session_id: string
  delivered: number
  routine_run: number | null
  wait_id: number | null
  kind: string
  task_title: string
  created_at: number
  answered: number
  group_key: string
  question_id: number | null
  chain: number | null
  no_reply: string
  cancelled: number
  piggyback: number
}

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
create table if not exists routines (
  id integer primary key, project text not null, cwd text not null, name text not null,
  prompt text not null, schedule text not null, missed text not null default 'skip',
  enabled integer not null default 1, next_at integer, created_at integer not null, updated_at integer not null
);
create table if not exists routine_runs (
  id integer primary key, routine_id integer not null, scheduled_for integer not null,
  created_at integer not null, session_id text not null default '', message_id integer,
  status text not null default 'waiting', quiet integer not null default 0,
  failure text not null default '', result text not null default '', finished_at integer,
  opened integer not null default 0
);
create index if not exists routine_runs_routine on routine_runs (routine_id, id);
create table if not exists secrets (key text primary key, value text not null);
create table if not exists approvals (
  id integer primary key, session_id text not null, project text not null, tool text not null,
  summary text not null, cwd text not null default '', reason text not null default '',
  status text not null default 'pending', via text not null default '', request_key text not null default '',
  created_at integer not null, answered_at integer
);
create table if not exists telegram_approvals (approval_id integer primary key, message_id integer not null);
create table if not exists telegram_messages (question_id integer primary key, message_id integer not null, created_at integer not null);
create table if not exists waits (
  id integer primary key, session_id text not null, note text not null,
  created_at integer not null, fired_at integer, closed_at integer, payload text not null default ''
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
  // Capped first: the lazy groups are quadratic on a long line of brackets and colons.
  const match = /^\[([^\]]+?)::([^\]]+?)\]/.exec(description.slice(0, 300))
  return match ? { taskTitle: match[1]!.trim(), nodeKey: match[2]!.trim() } : { taskTitle: '', nodeKey: '' }
}

// A session's agent CLI ("claude", "codex", "custom:my-llama") and its app terminal id.
export const AGENT_KIND = /^[a-z0-9][a-z0-9:_-]{0,47}$/
export const TERMINAL_ID = /^[A-Za-z0-9_-]{0,64}$/
// Commands an agent without the mod can still follow: they become a prompt (mod/hooks/batch.ts commandPrompt).
const PROMPT_COMMANDS = ['message', 'report', 'sync']
// How long cancel_request waits for the recipient's mod to say whether it stopped the turn.
const CANCEL_WAIT_MS = 3000
// How long a message taken with `hold` counts as typed in before its acknowledgement comes.
const HOLD_MS = 5 * 60_000
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

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

// The largest body any route takes (a screen comment with its logs is well under it).
export const BODY_MAX = 8 * 1024 * 1024

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > BODY_MAX) {
      req.destroy()
      throw new BridgeError('bridge.tooLarge')
    }
    chunks.push(chunk as Buffer)
  }
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

// `token`: the bridge listens on TCP (bridge/endpoint.ts) and answers only requests that carry it.
// `appKey`: what the app proves itself with (appOnly); the app hands it over at the start.
// `tailscale`: the tailscale command for phones (bridge/mobile.ts), null for none (tests).
export type BridgeOptions = { telegramApi?: string; fetch?: typeof fetch; token?: string; appKey?: string; tailscale?: string | null }

// What only the person may do, through the app: answer a permission ask, say they are away,
// set up Telegram or phones, schedule prompts, change settings, control sessions and read their
// transcripts. Any program of the same user reaches the bridge, a session with a shell too;
// without the app's key these refuse. Answers to decision questions, messages and waits stay
// open to the switchboard command.
export function appOnly(method: string, path: string): boolean {
  if (path === '/telegram' || path.startsWith('/telegram/') || path === '/app/check') return true
  // Phones: turning them on, pairing and the view they read (bridge/mobile.ts).
  if (path === '/mobile' || path.startsWith('/mobile/')) return true
  if (method === 'GET') return /^\/commands\/\d+$/.test(path)
  return (
    /^\/approvals\/\d+\/answer$/.test(path) ||
    path === '/presence' ||
    path === '/settings' ||
    path === '/commands' ||
    path === '/routines' ||
    /^\/routines\/\d+\/(run|delete)$/.test(path)
  )
}


export function createBridge(dbPath: string, locale = systemLocale(), options: BridgeOptions = {}) {
  privateDir(dirname(dbPath))
  // `timeout`: a write that meets another's lock waits for it instead of failing at once.
  const db = new DatabaseSync(dbPath, { timeout: 5000 })
  db.exec('pragma journal_mode = wal;')
  // The WAL shrinks back to this after a checkpoint instead of keeping its largest size.
  db.exec('pragma journal_size_limit = 16777216;')
  // What a bridge that died left in the WAL goes into the database now (or at the next prune,
  // when another connection holds it).
  try {
    db.exec('pragma wal_checkpoint(TRUNCATE);')
  } catch {
    // Not now.
  }
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
  addColumns('questions', [['request_key', "text not null default ''"], ['forwarded_to', "text not null default ''"]])
  // Messages between sessions (bridge/peer.ts): who sent it, what it answers, whether it
  // wants an answer and got one, the batch it went out with, and a forwarded question.
  addColumns('outbox', [
    ['from_session', "text not null default ''"],
    ['reply_to', 'integer'],
    ['expects_reply', 'integer not null default 0'],
    ['answered', 'integer not null default 0'],
    ['group_key', "text not null default ''"],
    ['question_id', 'integer'],
    ['request_key', "text not null default ''"],
    // A request from the shell (switchboard send --wait): the session's reply waits here.
    ['reply_text', 'text'],
    ['replied_at', 'integer'],
    // A scheduled prompt's run (bridge/schedule.ts) and a fired wait (await_event).
    ['routine_run', 'integer'],
    ['wait_id', 'integer'],
    // The first request of a run of hand-offs between sessions (DELEGATION_MAX), why the
    // sender was told no reply would come, a request its sender cancelled, and a note that
    // waits to go in with the session's next turn instead of starting one.
    ['chain', 'integer'],
    ['no_reply', "text not null default ''"],
    ['cancelled', 'integer not null default 0'],
    ['piggyback', 'integer not null default 0'],
  ])
  // Which agent CLI a session runs in (sessions before this were all Claude Code)
  // and the app terminal it runs in, when it does.
  addColumns('sessions', [['agent', "text not null default 'claude'"], ['terminal', "text not null default ''"]])
  // A scheduled prompt that switched itself off after ROUTINE_FAIL_LIMIT failed runs in a row.
  addColumns('routines', [['failed_off', 'integer not null default 0']])
  // Which agent CLI a scheduled prompt goes to (agents.ts ids; routines before this were Claude Code's).
  addColumns('routines', [['agent', "text not null default 'claude'"]])
  db.exec('update tasks set number = id where number is null')
  // Indexes for what runs on every delivery, timer tick and /state, made after the columns
  // above exist: without them each of these reads the whole table.
  db.exec(`
    create index if not exists outbox_session on outbox (session_id, delivered);
    create index if not exists outbox_group on outbox (group_key);
    create index if not exists outbox_chain on outbox (chain);
    create index if not exists outbox_pair on outbox (from_session, session_id, created_at);
    create index if not exists outbox_request on outbox (from_session, request_key);
    create index if not exists outbox_routine on outbox (routine_run);
    create index if not exists outbox_open on outbox (session_id) where expects_reply = 1 and answered = 0 and cancelled = 0 and no_reply = '';
    create index if not exists questions_session on questions (session_id, status, delivered);
    create index if not exists questions_status on questions (status, answered_at);
    create index if not exists questions_project on questions (status, project);
    create index if not exists routine_runs_status on routine_runs (status, created_at);
    create index if not exists sessions_seen on sessions (last_seen);
    create index if not exists sessions_project on sessions (project, last_seen);
    create index if not exists approvals_status on approvals (status, answered_at);
    create index if not exists approvals_session on approvals (session_id, status);
    create index if not exists commands_session on commands (session_id, done_at);
    create index if not exists waits_session on waits (session_id);
    create index if not exists telegram_messages_message on telegram_messages (message_id);
  `)

  // Writes that belong together land together or not at all: a crash between two statements
  // leaves no half of them. A savepoint, so one may run inside another.
  const atomic = <T>(fn: () => T): T => {
    db.exec('savepoint atomic')
    try {
      const result = fn()
      db.exec('release atomic')
      return result
    } catch (error) {
      db.exec('rollback to atomic')
      db.exec('release atomic')
      throw error
    }
  }

  // Statements of the hot paths (/state, deliveries, timers) are prepared once and kept.
  const statements = new Map<string, StatementSync>()
  const stmt = (sql: string): StatementSync => {
    let made = statements.get(sql)
    if (!made) {
      made = db.prepare(sql)
      statements.set(sql, made)
    }
    return made
  }

  // Feature area: UI language. Errors, log lines and texts for sessions follow the `lang` setting.
  const langNow = (): Lang => {
    const row = stmt("select value from settings where key = 'lang'").get() as { value: string } | undefined
    return resolveLang(row ? JSON.parse(row.value) : undefined, locale)
  }
  const say = (key: Key, vars?: Vars): string => tIn(langNow(), key, vars)

  const watchers = new Set<ServerResponse>()
  const deliveryWatchers = new Map<string, Set<ServerResponse>>()
  // Messages the app took with `hold` (/deliveries/take) and is typing into a terminal, by
  // outbox id, with when: a cancel in between treats them as delivered and sends the note.
  const holding = new Map<number, number>()
  const isHeld = (id: number) => {
    const at = holding.get(id)
    if (at !== undefined && now() - at > HOLD_MS) holding.delete(id)
    return holding.has(id)
  }

  const now = () => Date.now()
  // Phones hear that something changed (createMobile below).
  let phonesChanged = () => {}
  const changed = (type: string) => {
    for (const res of watchers) sseSend(res, 'change', { type })
    phonesChanged()
  }

  const projectOf = (sessionId: string): string => {
    const row = stmt('select project from sessions where id = ?').get(sessionId) as
      | { project: string }
      | undefined
    return row?.project ?? say('bridge.unknownProject')
  }

  const logEvent = (sessionId: string, kind: string, text: string, taskTitle = '') => {
    stmt('insert into events (ts, session_id, project, task_title, kind, text) values (?, ?, ?, ?, ?, ?)').run(
      now(), sessionId, projectOf(sessionId), taskTitle, kind, text,
    )
    stmt('delete from events where id <= (select max(id) - 5000 from events)').run()
  }

  const undelivered = (sessionId: string): QuestionRow[] =>
    stmt("select * from questions where session_id = ? and status = 'answered' and delivered = 0 order by id").all(sessionId) as QuestionRow[]

  const sessionLabel = (id: string): string => {
    const row = stmt('select project from sessions where id = ?').get(id) as { project: string } | undefined
    return row ? `${row.project} (${id})` : id
  }
  // A Claude Code session's mod sends the turn's last answer back when it did not reply itself.
  const autoReplies = (id: string): boolean =>
    ((stmt('select agent from sessions where id = ?').get(id) as { agent: string } | undefined)?.agent ?? 'claude') === 'claude'

  // What a session reads for one outbox row: a message from another session, or a question
  // the person forwarded, gets its header in the reader's language; the rest is the text sent.
  const outboxText = (m: OutboxRow): string => {
    if (m.routine_run) {
      const run = stmt('select r.name, r.prompt, rr.scheduled_for from routine_runs rr join routines r on r.id = rr.routine_id where rr.id = ?').get(m.routine_run) as
        | { name: string; prompt: string; scheduled_for: number }
        | undefined
      if (run) return routineText(run.name, run.prompt, run.scheduled_for, langNow())
    }
    if (m.wait_id) {
      const wait = stmt('select * from waits where id = ?').get(m.wait_id) as { id: number; note: string; payload: string; created_at: number } | undefined
      if (wait) return waitText(wait, langNow())
    }
    if (m.question_id) {
      const q = stmt('select * from questions where id = ?').get(m.question_id) as QuestionRow | undefined
      if (q) return forwardText(m.id, q, sessionLabel(q.session_id), langNow(), autoReplies(m.session_id))
    }
    if (m.from_session) return peerText(m, sessionLabel(m.from_session), langNow(), autoReplies(m.session_id))
    if (m.expects_reply) return shellText(m, langNow(), autoReplies(m.session_id))
    return m.text
  }

  // A reply to a request that went to several sessions waits until every live one of them
  // answered, or HELD_REPLY_MS after the request: the asker reads the answers in one turn.
  // A piggyback note (a cancelled request) waits the same way, for a turn that starts anyway.
  const heldReply = (m: OutboxRow, at = now()): boolean => {
    if (m.piggyback) return true
    if (!m.reply_to || !m.from_session) return false
    const request = stmt('select group_key, created_at from outbox where id = ?').get(m.reply_to) as
      | { group_key: string; created_at: number }
      | undefined
    if (!request?.group_key || at - request.created_at >= HELD_REPLY_MS) return false
    const open = stmt("select session_id from outbox where group_key = ? and id != ? and answered = 0 and no_reply = ''").all(request.group_key, m.reply_to) as {
      session_id: string
    }[]
    const live = liveSessions()
    return open.some(o => live.includes(o.session_id))
  }

  // A session at its usage limit takes nothing until the reset (src/shared/limit.ts).
  const limitedSession = (sessionId: string): boolean => {
    const row = stmt('select usage, last_seen from sessions where id = ?').get(sessionId) as { usage: string; last_seen: number } | undefined
    return row !== undefined && limitedUntil(row.usage, row.last_seen, now()) !== null
  }

  // A turn that starts anyway (the person answered or wrote, or anything else came) takes
  // what is held with it: waiting longer would not save that session a turn.
  const pendingOutbox = (sessionId: string): OutboxRow[] => {
    const rows = stmt('select * from outbox where session_id = ? and delivered = 0 order by id').all(sessionId) as OutboxRow[]
    if (rows.some(m => !heldReply(m)) || undelivered(sessionId).length > 0) return rows
    return []
  }

  const answerQuestion = (q: QuestionRow, choice: string | null, memo: string | null, via: 'app' | 'telegram' = 'app') => {
    db.prepare(
      "update questions set status = 'answered', choice = ?, memo = ?, answered_at = ?, delivered = 0 where id = ?",
    ).run(choice, memo, now(), q.id)
    logEvent(q.session_id, '답함', `Q${q.id} ${choice ? `(${choice})` : say('history.memo')} ${q.question}`, q.task_title)
    changed('questions')
    pushDeliveries(q.session_id)
    if (via !== 'telegram') telegram.answeredElsewhere(q, choice, memo)
  }

  let shuttingDown = false

  // A permission ask answered once, from wherever it was first.
  const answerApproval = (row: ApprovalRow, decision: 'allow' | 'deny' | 'terminal' | 'expired', via: string, event?: Key): boolean => {
    const result = db.prepare("update approvals set status = ?, via = ?, answered_at = ? where id = ? and status = 'pending'").run(decision, via, now(), row.id)
    if (result.changes === 0) return false
    const key = event ?? ({ allow: 'bridge.event.approvalAllow', deny: 'bridge.event.approvalDeny', terminal: 'bridge.event.approvalTerminal', expired: 'bridge.event.approvalExpired' } as const)[decision]
    logEvent(row.session_id, '권한', say(key, { id: row.id, tool: row.tool }))
    changed('approvals')
    if (via !== 'telegram') telegram.approvalClosed(row, decision)
    approvalSeen.delete(row.id)
    for (const wake of approvalWaiters.get(row.id) ?? []) wake()
    return true
  }

  // The mod's hook waits on an ask with long polls (GET /approvals/:id?wait=ms), one after
  // another; an answer wakes the poll at once. An ask nobody polls for APPROVAL_STALE_MS has no
  // hook behind it any more (the mod gave up, its session or the bridge before this one went
  // away), so an answer could reach nothing: it expires. Asks found at the start get that long
  // for their mods to come back.
  const APPROVAL_STALE_MS = 90_000
  const APPROVAL_POLL_MAX_MS = 25_000
  const approvalWaiters = new Map<number, Set<() => void>>()
  const approvalSeen = new Map<number, number>()
  const approvalsFrom = now()
  const sweepApprovals = () => {
    if (shuttingDown) return clearInterval(approvalSweep)
    const at = now()
    for (const row of db.prepare("select * from approvals where status = 'pending'").all() as ApprovalRow[]) {
      if ((approvalWaiters.get(row.id)?.size ?? 0) > 0) continue
      const seen = approvalSeen.get(row.id) ?? Math.max(row.created_at, approvalsFrom)
      if (at - seen > APPROVAL_STALE_MS) answerApproval(row, 'expired', '', 'bridge.event.approvalStale')
    }
  }
  const approvalSweep = setInterval(sweepApprovals, 30_000)
  approvalSweep.unref()

  // The person's presence at the desk, from the app (POST /presence): away when the app is
  // closed, its report is old, or it says so (screen locked, idle). Telegram writes only then.
  let presence = { away: false, at: 0 }
  const away = () => watchers.size === 0 || presence.away || now() - presence.at > 90_000
  const secret = (key: string) => (db.prepare('select value from secrets where key = ?').get(key) as { value: string } | undefined)?.value ?? null
  const setSecret = (key: string, value: string | null) => {
    if (value === null) db.prepare('delete from secrets where key = ?').run(key)
    else db.prepare('insert into secrets (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(key, value)
  }
  const telegram = createTelegram({
    api: options.telegramApi ?? TELEGRAM_API,
    fetch: options.fetch ?? fetch,
    secret,
    setSecret,
    lang: langNow,
    away,
    pending: () => db.prepare("select * from questions where status = 'pending' order by id").all() as QuestionRow[],
    question: id => db.prepare('select * from questions where id = ?').get(id) as QuestionRow | undefined,
    answer: (id, choice, memo) => {
      const q = db.prepare('select * from questions where id = ?').get(id) as QuestionRow | undefined
      if (q && q.status !== 'answered') answerQuestion(q, choice, memo, 'telegram')
    },
    hold: id => {
      const q = db.prepare('select * from questions where id = ?').get(id) as QuestionRow | undefined
      if (!q || q.status !== 'pending') return
      db.prepare("update questions set status = 'held' where id = ?").run(id)
      logEvent(q.session_id, '보류', `Q${id} ${q.question}`, q.task_title)
      changed('questions')
    },
    sentMessage: id => (db.prepare('select message_id from telegram_messages where question_id = ?').get(id) as { message_id: number } | undefined)?.message_id ?? null,
    saveMessage: (id, messageId) => db.prepare('insert or replace into telegram_messages (question_id, message_id, created_at) values (?, ?, ?)').run(id, messageId, now()),
    questionOf: messageId => (db.prepare('select question_id from telegram_messages where message_id = ?').get(messageId) as { question_id: number } | undefined)?.question_id ?? null,
    pendingApprovals: () => db.prepare("select * from approvals where status = 'pending' order by id").all() as ApprovalRow[],
    approval: id => db.prepare('select * from approvals where id = ?').get(id) as ApprovalRow | undefined,
    answerApproval: (id, decision) => {
      const row = db.prepare('select * from approvals where id = ?').get(id) as ApprovalRow | undefined
      return row ? answerApproval(row, decision, 'telegram') : false
    },
    approvalMessage: id => (db.prepare('select message_id from telegram_approvals where approval_id = ?').get(id) as { message_id: number } | undefined)?.message_id ?? null,
    saveApprovalMessage: (id, messageId) => db.prepare('insert or replace into telegram_approvals (approval_id, message_id) values (?, ?)').run(id, messageId),
    changed: () => changed('telegram'),
    log: text => console.log(text),
  })

  // The answer a session gave to a question the person forwarded to it. The person may have
  // answered first; then the late answer only closes the forward.
  const answerForwarded = (row: OutboxRow, from: string, text: string) => {
    db.prepare('update outbox set answered = 1 where id = ?').run(row.id)
    const q = db.prepare('select * from questions where id = ?').get(row.question_id) as QuestionRow | undefined
    if (!q || q.status === 'answered' || !text.trim()) return
    const { choice, memo } = forwardedAnswer(text, q.options)
    answerQuestion(q, choice, say('peer.forwardedMemo', { session: sessionLabel(from), text: memo }))
  }

  const keepShellReply = (row: OutboxRow, text: string) => {
    db.prepare('update outbox set answered = 1, reply_text = ?, replied_at = ? where id = ? and answered = 0').run(clipText(text), now(), row.id)
    changed('outbox')
  }

  // One message from a session to others; replies and plain information want no answer.
  // A request carries the run of hand-offs it belongs to (`chain`, DELEGATION_MAX); one that
  // starts a run names itself.
  const sendPeer = (from: string, to: string[], text: string, replyTo: number | null, expectsReply: boolean, requestKey = '', chain: number | null = null) => {
    const group = to.length > 1 && expectsReply ? `g${now()}-${Math.random().toString(36).slice(2, 8)}` : ''
    const ids: string[] = []
    let root = chain
    // A request that starts a run names itself right after its insert: never one without the other.
    atomic(() => {
      for (const recipient of to) {
        const row = db
          .prepare(
            `insert into outbox (session_id, kind, text, created_at, from_session, reply_to, expects_reply, group_key, request_key, chain)
             values (?, '세션메시지', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(recipient, clipText(text), now(), from, replyTo, expectsReply ? 1 : 0, group, requestKey, expectsReply ? root : null)
        const id = Number(row.lastInsertRowid)
        if (expectsReply && root === null) {
          root = id
          db.prepare('update outbox set chain = ? where id = ?').run(id, id)
        }
        ids.push(`m${id}`)
      }
      const names = to.map(sessionLabel).join(', ')
      logEvent(from, '세션메시지', `→ ${names}: ${text.split('\n')[0]?.slice(0, 160) ?? ''}`)
    })
    changed('outbox')
    for (const recipient of to) pushDeliveries(recipient)
    // The reply may release answers the sender of the request held back (heldReply).
    return ids
  }

  // Scheduled prompts (bridge/schedule.ts). A run goes to an idle connected Claude Code
  // session of its project; with none, the app opens a `+ Claude` terminal there (the
  // 'routine-open' event) and the run waits for it. A run that comes while the previous one
  // still runs is skipped, so a laptop waking up does not get a burst. It ends at the turn's
  // end, quiet when the session called routine_no_update, failed with routine_report_failure.
  const RUN_WAIT_MS = 30 * 60_000
  const RUN_RESULT_MS = 6 * 3600_000
  const MISSED_GRACE_MS = 2 * 60_000

  const scheduleOf = (r: RoutineRow): Schedule => JSON.parse(r.schedule) as Schedule
  const advanceRoutine = (r: RoutineRow, after: number) => {
    const next = nextRun(scheduleOf(r), after)
    // A once that ran is done: it stays in the list, switched off.
    db.prepare('update routines set next_at = ?, enabled = ? where id = ?').run(next, next === null ? 0 : r.enabled, r.id)
  }
  const addRun = (r: RoutineRow, scheduledFor: number, status: RunRow['status'], failure = '') =>
    Number(
      db
        .prepare('insert into routine_runs (routine_id, scheduled_for, created_at, status, failure, finished_at) values (?, ?, ?, ?, ?, ?)')
        .run(r.id, scheduledFor, now(), status, failure, status === 'waiting' ? null : now()).lastInsertRowid,
    )
  const startRun = (r: RoutineRow, scheduledFor: number) => {
    if (db.prepare("select 1 from routine_runs where routine_id = ? and status in ('waiting', 'sent')").get(r.id)) {
      addRun(r, scheduledFor, 'skipped', say('routine.skippedLive'))
      return
    }
    addRun(r, scheduledFor, 'waiting')
  }
  const routineSession = (project: string, agent: string): string | null => {
    const live = liveSessions()
    const rows = db.prepare('select id from sessions where project = ? and agent = ? order by last_seen desc').all(project, agent) as { id: string }[]
    const ready = rows.filter(row => live.includes(row.id) && !limitedSession(row.id))
    return (ready.find(row => activity.get(row.id)?.state !== 'working') ?? ready[0])?.id ?? null
  }
  const assignRuns = () => {
    const waiting = db
      .prepare("select rr.*, r.project, r.cwd, r.name, r.agent from routine_runs rr join routines r on r.id = rr.routine_id where rr.status = 'waiting' order by rr.id")
      .all() as (RunRow & { project: string; cwd: string; name: string; agent: string })[]
    for (const run of waiting) {
      const sessionId = routineSession(run.project, run.agent)
      if (!sessionId) {
        // Only the app opens terminals: with it away the run asks again on the next tick.
        if (!run.opened && watchers.size > 0) {
          db.prepare('update routine_runs set opened = 1 where id = ?').run(run.id)
          for (const res of watchers) sseSend(res, 'change', { type: 'routine-open', routineId: run.routine_id, cwd: run.cwd, project: run.project, agent: run.agent })
        }
        continue
      }
      // The prompt and its run marked sent, together: a run left waiting would send it twice.
      atomic(() => {
        const row = db
          .prepare("insert into outbox (session_id, kind, text, created_at, expects_reply, routine_run) values (?, '예약', '', ?, 1, ?)")
          .run(sessionId, now(), run.id)
        db.prepare("update routine_runs set status = 'sent', session_id = ?, message_id = ? where id = ?").run(sessionId, Number(row.lastInsertRowid), run.id)
        logEvent(sessionId, '예약', say('bridge.event.routineSent', { name: run.name }))
      })
      changed('routines')
      pushDeliveries(sessionId)
    }
  }
  // Only runs that reached a session count: one that found no session, was skipped or missed
  // spent nothing. Counting starts again when the person saves or switches the routine back on.
  const stopIfFailing = (routineId: number) => {
    const r = db.prepare('select * from routines where id = ?').get(routineId) as RoutineRow | undefined
    if (!r?.enabled) return
    const recent = db
      .prepare(
        "select status from routine_runs where routine_id = ? and session_id != '' and status in ('done', 'quiet', 'failed') and created_at >= ? order by id desc limit ?",
      )
      .all(r.id, r.updated_at, ROUTINE_FAIL_LIMIT) as { status: string }[]
    if (recent.length < ROUTINE_FAIL_LIMIT || recent.some(run => run.status !== 'failed')) return
    db.prepare('update routines set enabled = 0, failed_off = 1 where id = ?').run(r.id)
  }
  const finishRun = (runId: number, answerText: string, interrupted = false) => {
    const run = db.prepare('select * from routine_runs where id = ?').get(runId) as RunRow | undefined
    if (!run || run.status !== 'sent') return
    const status = interrupted || run.failure ? 'failed' : run.quiet ? 'quiet' : 'done'
    const failure = run.failure || (interrupted ? say('routine.interrupted') : '')
    db.prepare('update routine_runs set status = ?, failure = ?, result = ?, finished_at = ? where id = ?').run(status, failure, clipText(answerText).slice(0, 4000), now(), run.id)
    if (run.message_id) db.prepare('update outbox set answered = 1 where id = ?').run(run.message_id)
    if (status === 'failed') stopIfFailing(run.routine_id)
    changed('routines')
  }
  const tickRoutines = (at = now()) => {
    const due = db.prepare('select * from routines where enabled = 1 and next_at is not null and next_at <= ?').all(at) as RoutineRow[]
    for (const r of due) {
      // Due long ago (the bridge was down): the routine's missed policy decides.
      if (r.next_at! < at - MISSED_GRACE_MS && r.missed === 'skip') addRun(r, r.next_at!, 'missed')
      else startRun(r, r.next_at!)
      advanceRoutine(r, at)
    }
    // A run nobody took, or one whose turn never reported back, ends instead of blocking the next.
    const stale = db
      .prepare("select id, routine_id, status from routine_runs where (status = 'waiting' and created_at < ?) or (status = 'sent' and created_at < ?)")
      .all(at - RUN_WAIT_MS, at - RUN_RESULT_MS) as { id: number; routine_id: number; status: string }[]
    for (const run of stale) {
      db.prepare("update routine_runs set status = 'failed', failure = ?, finished_at = ? where id = ?").run(
        say(run.status === 'waiting' ? 'routine.noSession' : 'routine.noResult'),
        at,
        run.id,
      )
      stopIfFailing(run.routine_id)
    }
    assignRuns()
    if (due.length > 0 || stale.length > 0) changed('routines')
  }

  // Everything waiting for a session, oldest first: answers ("q<id>") and
  // messages the IDE sent, such as screen comments ("m<id>").
  const pushDeliveries = (sessionId: string, only?: ServerResponse) => {
    const targets = only ? new Set([only]) : deliveryWatchers.get(sessionId)
    if (!targets || targets.size === 0 || limitedSession(sessionId)) return
    const items = [
      ...undelivered(sessionId).map(q => ({ id: `q${q.id}`, text: deliveryText(q, langNow()), at: q.answered_at ?? 0 })),
      ...pendingOutbox(sessionId).map(m => ({ id: `m${m.id}`, text: outboxText(m), at: m.created_at })),
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

  const commandResult = (id: number): unknown => {
    const row = db.prepare('select done_at, result from commands where id = ?').get(id) as { done_at: number | null; result: string | null } | undefined
    return row?.done_at ? (JSON.parse(row.result ?? 'null') as unknown) ?? {} : null
  }

  const pendingCommands = (sessionId: string) =>
    stmt('select id, kind, payload from commands where session_id = ? and done_at is null order by id').all(sessionId) as {
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

  // What each session's turn is doing, from the mod's hooks (POST /sessions/activity). Kept in
  // memory: after a restart nothing counts as stalled until the session reports again.
  const activity = new Map<string, Activity>()

  // Sessions whose delivery stream is open: the mod's, or the app's for a CLI in its terminal.
  const liveSessions = () => [...deliveryWatchers].filter(([, set]) => set.size > 0).map(([id]) => id)
  // When each session's stream last closed; one not seen since the bridge started counts from then.
  const offlineSince = new Map<string, number>()
  const bridgeStarted = now()

  // The sender of a request that will not be answered (or not in time) is told once, so it
  // does not wait on it: the recipient went away, its turn was interrupted, or it is the one
  // still missing from a request to several.
  const noteNoReply = (row: OutboxRow, reason: NoReply) => {
    const marked = db.prepare("update outbox set no_reply = ? where id = ? and no_reply = ''").run(reason, row.id)
    if (marked.changes === 0) return
    const recipient = sessionLabel(row.session_id)
    db.prepare("insert into outbox (session_id, kind, text, created_at, reply_to) values (?, '세션메시지', ?, ?, ?)").run(
      row.from_session,
      noReplyText(row.id, recipient, reason, langNow()),
      now(),
      row.id,
    )
    logEvent(row.from_session, '세션메시지', say('bridge.event.peerNoReply', { id: row.id, recipient }))
    changed('outbox')
    pushDeliveries(row.from_session)
  }

  const checkNoReplies = (at = now()) => {
    const open = db
      .prepare("select * from outbox where from_session != '' and expects_reply = 1 and answered = 0 and cancelled = 0 and no_reply = '' and question_id is null")
      .all() as OutboxRow[]
    if (open.length === 0) return
    const live = liveSessions()
    for (const row of open) {
      if (!live.includes(row.session_id) && at - (offlineSince.get(row.session_id) ?? bridgeStarted) >= OFFLINE_NOTE_MS) noteNoReply(row, 'offline')
      else if (row.group_key && at - row.created_at >= HELD_REPLY_MS && db.prepare('select 1 from outbox where group_key = ? and answered = 1 and cancelled = 0 limit 1').get(row.group_key)) {
        noteNoReply(row, 'late')
      }
    }
  }

  // What memory keeps of sessions that went away. A close time past OFFLINE_NOTE_MS tells
  // checkNoReplies nothing the bridge's start does not (both are that long ago); activity of a
  // session that never opened a stream (or reported after it closed) ends after a day.
  const forgetGone = (at = now()) => {
    for (const [id, since] of offlineSince) if (at - since >= OFFLINE_NOTE_MS) offlineSince.delete(id)
    const live = liveSessions()
    for (const [id, a] of activity) if (!live.includes(id) && at - a.at >= DAY) activity.delete(id)
  }

  // Retention. Questions are history and stay. Delivered messages, done commands and
  // ended subagents go after 7 days; events keep the newest 5000; commands a session
  // never picked up go once it has not been seen for a day. After KEEP_MS: finished
  // scheduled runs (the newest RUNS_KEPT of each routine stay, for stopIfFailing), answered
  // permission asks, fired or closed waits, Telegram's message ids of closed questions,
  // messages for a session that never came back, and then that session itself.
  const KEEP_MS = 30 * DAY
  const RUNS_KEPT = 20
  const prune = (at = now()) => {
    db.prepare('delete from outbox where delivered = 1 and created_at < ?').run(at - 7 * DAY)
    db.prepare('delete from commands where done_at is not null and done_at < ?').run(at - 7 * DAY)
    db.prepare("delete from agents where status in ('completed', 'failed', 'killed') and updated_at < ?").run(at - 7 * DAY)
    db.prepare('delete from events where id <= (select max(id) - 5000 from events)').run()
    const live = JSON.stringify(liveSessions())
    db.prepare(
      `delete from commands where done_at is null
       and session_id not in (select value from json_each(?))
       and (session_id not in (select id from sessions) or session_id in (select id from sessions where last_seen < ?))`,
    ).run(live, at - DAY)
    const old = at - KEEP_MS
    // A scheduled prompt whose run is gone would reach its session as an empty request.
    db.prepare('update outbox set delivered = 1, answered = 1 where delivered = 0 and routine_run is not null and routine_run not in (select id from routine_runs)').run()
    // Never what waits for a session that is connected or was seen within KEEP_MS.
    db.prepare(
      `delete from outbox where delivered = 0 and created_at < ?
       and session_id not in (select value from json_each(?))
       and session_id not in (select id from sessions where last_seen >= ?)`,
    ).run(old, live, old)
    db.prepare(
      `delete from routine_runs where id in (
         select id from (select id, status, finished_at, created_at, row_number() over (partition by routine_id order by id desc) as n from routine_runs)
         where n > ? and status not in ('waiting', 'sent') and coalesce(finished_at, created_at) < ?)`,
    ).run(RUNS_KEPT, old)
    db.prepare("delete from approvals where status != 'pending' and coalesce(answered_at, created_at) < ?").run(old)
    db.prepare('delete from telegram_approvals where approval_id not in (select id from approvals)').run()
    db.prepare(
      `delete from waits where coalesce(fired_at, closed_at) < ?
       and id not in (select wait_id from outbox where wait_id is not null and delivered = 0)`,
    ).run(old)
    db.prepare("delete from telegram_messages where created_at < ? and question_id not in (select id from questions where status in ('pending', 'held'))").run(old)
    // A session gone for KEEP_MS that nothing still waits on or for. The newest session of each
    // project stays: the app takes the project's folder from it (src/shared/projects.ts).
    db.prepare(
      `delete from sessions where last_seen < ?
       and id not in (select value from json_each(?))
       and not exists (select 1 from questions q where q.session_id = sessions.id and (q.status in ('pending', 'held') or (q.status = 'answered' and q.delivered = 0)))
       and not exists (select 1 from outbox o where o.session_id = sessions.id and o.delivered = 0)
       and not exists (select 1 from approvals a where a.session_id = sessions.id and a.status = 'pending')
       and not exists (select 1 from waits w where w.session_id = sessions.id and w.fired_at is null and w.closed_at is null)
       and not exists (select 1 from routine_runs r where r.session_id = sessions.id and r.status in ('waiting', 'sent'))
       and exists (select 1 from sessions newer where newer.project = sessions.project and newer.last_seen > sessions.last_seen)`,
    ).run(old, live)
    // The WAL folds back into the database and shrinks (journal_size_limit).
    db.exec('pragma wal_checkpoint(TRUNCATE);')
  }
  // A timer's work that fails (the database still locked after its timeout, a bad row) is
  // logged and tried again on the next tick: an exception in a timer would end the bridge.
  const guarded = (what: string, work: () => void) => () => {
    try {
      work()
    } catch (error) {
      console.log(`claude-ide bridge: ${what} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  guarded('prune', () => prune())()
  const pruning = setInterval(guarded('prune', () => prune()), 3600_000)
  pruning.unref()
  // A held reply (heldReply) and a usage limit's reset have no event to let what waits go:
  // look every minute.
  const releasing = setInterval(
    guarded('release', () => {
      checkNoReplies()
      forgetGone()
      for (const id of liveSessions()) {
        const waiting =
          stmt('select 1 from outbox where session_id = ? and delivered = 0 limit 1').get(id) ||
          stmt("select 1 from questions where session_id = ? and status = 'answered' and delivered = 0 limit 1").get(id)
        if (waiting) pushDeliveries(id)
      }
    }),
    60_000,
  )
  releasing.unref()
  telegram.start()
  guarded('routines', () => tickRoutines())()
  const routineTimer = setInterval(guarded('routines', () => tickRoutines()), 30_000)
  routineTimer.unref()

  // What the app reads, on every change. Sessions: the connected ones, the SESSIONS_SHOWN seen
  // last, the newest of each project (its folder), any a waiting question or running task names,
  // and one in an app terminal seen today (src/main/agentDelivery.ts opens streams only for these).
  const SESSIONS_SHOWN = 300
  const state = () => ({
    sessions: stmt(
      `select * from sessions where id in (
         select value from json_each(?)
         union select * from (select id from sessions order by last_seen desc limit ${SESSIONS_SHOWN})
         union select id from (select id, max(last_seen) from sessions group by project)
         union select session_id from questions where status in ('pending', 'held')
         union select session_id from tasks where status = '하는 중'
         union select id from sessions where last_seen > ? and terminal != '')
       order by last_seen desc`,
    ).all(JSON.stringify(liveSessions()), now() - DAY),
    live: liveSessions(),
    routines: stmt('select * from routines order by id').all(),
    approvals: stmt('select * from (select * from approvals order by id desc limit 30) order by id').all(),
    routineRuns: stmt('select * from (select * from routine_runs order by id desc limit 100) order by id').all(),
    activity: Object.fromEntries(activity),
    // Every running task, however many: the limit only trims waiting ones.
    tasks: stmt(
      `select * from tasks where status != '보관' and (status = '하는 중'
         or id in (select id from tasks where status != '보관' order by updated_at desc limit 200))
       order by updated_at desc`,
    ).all(),
    archived: stmt("select * from tasks where status = '보관' order by archived_at desc limit 100").all(),
    agents: stmt('select * from agents order by updated_at desc limit 300').all(),
    commands: stmt('select id, session_id, kind, payload, created_at, done_at from commands order by id desc limit 50').all(),
    settings: Object.fromEntries(
      (stmt('select key, value from settings').all() as { key: string; value: string }[]).map(r => [r.key, JSON.parse(r.value)]),
    ),
    questions: stmt(
      `select * from questions where status in ('pending', 'held')
       union all
       select * from (select * from questions where status = 'answered' order by answered_at desc limit 50)
       order by id desc`,
    ).all(),
    // Counted from the questions_project index alone, never the rows.
    answeredCount: (stmt("select count(*) n from questions where status = 'answered'").get() as { n: number }).n,
    answeredByProject: Object.fromEntries(
      (stmt("select project, count(*) n from questions where status = 'answered' group by project").all() as {
        project: string
        n: number
      }[]).map(r => [r.project, r.n]),
    ) as Record<string, number>,
    events: stmt('select * from (select * from events order by id desc limit 300) order by id').all(),
    nodes: stmt("select n.* from nodes n join tasks t on t.id = n.task_id where t.status != '보관' order by n.id").all(),
  })

  // Feature area: phones (bridge/mobile.ts). A phone's decrypted request runs through handle()
  // like any other, marked as the phone's so it may answer what only the person may.
  const phoneRequests = new WeakSet<IncomingMessage>()
  const mobileSetting = (): { enabled: boolean; port: number; lan: boolean } => {
    const row = db.prepare("select value from settings where key = 'mobile'").get() as { value: string } | undefined
    const saved = (row ? JSON.parse(row.value) : {}) as { enabled?: unknown; port?: unknown; lan?: unknown }
    return { enabled: saved.enabled === true, port: Number.isInteger(saved.port) ? (saved.port as number) : MOBILE_PORT, lan: saved.lan !== false }
  }
  const viaPhone = (method: string, path: string, body: unknown): Promise<{ status: number; json: unknown }> =>
    new Promise(resolve => {
      const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]) as unknown as IncomingMessage
      Object.assign(req, { method, url: path, headers: {} })
      phoneRequests.add(req)
      let status = 200
      const res = {
        headersSent: false,
        writeHead(code: number) {
          status = code
          this.headersSent = true
          return this
        },
        end(text?: string) {
          let json: unknown = {}
          try {
            json = text ? JSON.parse(text) : {}
          } catch {
            json = { error: String(text) }
          }
          resolve({ status, json })
        },
      }
      handle(req, res as unknown as ServerResponse).catch((error: unknown) => {
        const message = error instanceof BridgeError ? say(error.key) : say('bridge.failed', { error: error instanceof Error ? error.message : String(error) })
        resolve({ status: 400, json: { error: message } })
      })
    })
  // What a phone shows: what waits for the person, the tasks and the sessions, with labels in the app's language.
  const phoneView = () => {
    const lang = langNow()
    const live = liveSessions()
    // Live sessions and running tasks first, so a cap of 60 never leaves one of them out.
    const sessions = (
      db
        .prepare('select * from sessions order by (id in (select value from json_each(?))) desc, last_seen desc limit 60')
        .all(JSON.stringify(live)) as { id: string; project: string; cwd: string; last_seen: number }[]
    )
      .map(s => ({ id: s.id, label: sessionLabel(s.id), project: s.project, cwd: s.cwd, live: live.includes(s.id), lastSeen: s.last_seen }))
      .sort((a, b) => Number(b.live) - Number(a.live))
    const questions = (db.prepare("select * from questions where status in ('pending', 'held') order by id").all() as QuestionRow[]).map(q => ({
      id: q.id,
      sessionId: q.session_id,
      project: q.project,
      task: q.task_title,
      question: q.question,
      body: q.body,
      options: JSON.parse(q.options) as Option[],
      recommend: q.recommend,
      reason: q.reason,
      held: q.status === 'held',
      createdAt: q.created_at,
    }))
    const approvals = (db.prepare("select * from approvals where status = 'pending' order by id").all() as ApprovalRow[]).map(a => ({
      id: a.id,
      sessionId: a.session_id,
      project: a.project,
      tool: a.tool,
      summary: a.summary,
      reason: a.reason,
      cwd: a.cwd,
      createdAt: a.created_at,
    }))
    const tasks = (db.prepare("select * from tasks where status != '보관' order by (status = '하는 중') desc, updated_at desc limit 60").all() as { id: number; session_id: string; project: string; title: string; stage: string; status: string; now: string; updated_at: number }[]).map(t => ({
      id: t.id,
      sessionId: t.session_id,
      project: t.project,
      title: t.title,
      stage: stageLabel(t.stage, lang),
      status: taskStatusLabel(t.status, lang),
      running: t.status === '하는 중',
      now: t.now,
      live: live.includes(t.session_id),
      updatedAt: t.updated_at,
    }))
    return { lang, now: now(), questions, approvals, tasks, sessions }
  }
  // The bridge's VAPID key pair for Web Push (push.ts), made once and kept with the other secrets.
  const vapid = (): VapidKeys => {
    const saved = secret('vapid')
    if (saved) return JSON.parse(saved) as VapidKeys
    const made = makeVapidKeys()
    setSecret('vapid', JSON.stringify(made))
    return made
  }
  const mobile = createMobile({
    db,
    inner: viaPhone,
    vapid,
    fetch: options.fetch,
    tailscale: options.tailscale,
    changed: () => changed('mobile'),
    strings: () => {
      const lang = langNow()
      return { lang, ...Object.fromEntries(Object.entries(DICTS[lang]).filter(([key]) => key.startsWith('mobile.page.'))) }
    },
  })
  phonesChanged = mobile.changed
  const notifyPhones = (message: PushMessage) => (shuttingDown ? Promise.resolve(0) : mobile.notify(message).catch(() => 0))
  // The person just left the desk: one notification for what already waits, as Telegram sends it.
  // Sent once for the same things waiting: locking the screen and then quitting the app tell nothing new.
  let lastAway = ''
  const phonesAway = async () => {
    if (shuttingDown) return
    const waiting = (sql: string) => (db.prepare(sql).all() as { id: number }[]).map(r => r.id)
    const questions = waiting("select id from questions where status = 'pending' order by id")
    const approvals = waiting("select id from approvals where status = 'pending' order by id")
    const what = `${questions.join(',')}|${approvals.join(',')}`
    if (questions.length + approvals.length === 0 || what === lastAway) return
    lastAway = what
    await notifyPhones({ title: say('mobile.push.waiting', { questions: questions.length, approvals: approvals.length }), body: '', tag: 'waiting', tab: questions.length > 0 ? 'decisions' : 'approvals' })
  }
  if (mobileSetting().enabled) void mobile.start(mobileSetting().port, mobileSetting().lan)

  // Where this bridge listens, read once it does (PROVE_PATH): the inode of its socket file, or its port.
  let bound = ''

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A path is taken as written: no dot segments, which URL would resolve into another route
    // (a tool argument such as close_wait's id ends up in the path).
    const rawPath = (req.url ?? '/').split('?')[0]!
    if (/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(rawPath) || /%2f|%5c|\\/i.test(rawPath)) return send(res, 400, { error: say('bridge.badPath') })
    const url = new URL(req.url ?? '/', 'http://bridge')
    const path = url.pathname
    const method = req.method ?? 'GET'
    // Shared helpers (dev targets) word their errors through the module language.
    setLang(langNow())
    // Over TCP only the token opens the bridge, and a web page (it sends Origin) never does.
    // A phone's request (bridge/mobile.ts): it proved itself with its own key and runs in-process.
    const fromPhone = phoneRequests.has(req)
    if (options.token !== undefined && !fromPhone) {
      if (req.headers.origin !== undefined) return send(res, 403, { error: 'forbidden' })
      // Only this machine's loopback by name: a page that rebound a name to 127.0.0.1 sends its own.
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return send(res, 403, { error: 'forbidden' })
      if (!sameSecret(req.headers.authorization ?? '', `Bearer ${options.token}`)) return send(res, 401, { error: 'unauthorized' })
    }

    // The installed app's start script names its version: an app updated since replaces this bridge.
    // `app`: whether the app started it with its key; one started by a mod has none.
    if (method === 'GET' && path === '/health') return send(res, 200, { ok: true, version: process.env.SWITCHBOARD_VERSION ?? '', pid: process.pid, app: options.appKey !== undefined })
    // Asked without the key: the app sends it only to a bridge that answers this (bridge/endpoint.ts bridgeProof).
    if (method === 'GET' && path === PROVE_PATH) {
      const nonce = url.searchParams.get('nonce') ?? ''
      if (options.appKey === undefined || !bound || !/^[0-9a-f]{64}$/.test(nonce)) return send(res, 404, { error: say('bridge.noRoute', { method, path }) })
      return send(res, 200, { pid: process.pid, proof: bridgeProof(options.appKey, nonce, process.pid, bound) })
    }
    if (appOnly(method, path) && !fromPhone && !(options.appKey !== undefined && sameSecret(String(req.headers[APP_HEADER] ?? ''), options.appKey))) {
      return send(res, 403, { error: say('bridge.appOnly') })
    }
    if (method === 'GET' && path === '/app/check') return send(res, 200, { ok: true })
    if (method === 'GET' && path === '/state') return send(res, 200, state())

    if (method === 'GET' && path === '/stream') {
      sse(res)
      watchers.add(res)
      req.on('close', () => {
        watchers.delete(res)
        // The app closed: the person is away from it, and what waits goes to Telegram.
        if (watchers.size === 0) {
          telegram.away()
          void phonesAway().catch(() => undefined)
        }
      })
      return
    }

    if (method === 'GET' && path === '/presence') return send(res, 200, { away: away() })

    // A Claude Code permission ask while the person is away (the mod's tool.check hook):
    // it waits for an answer here, from the app or Telegram. 'terminal' hands it back to
    // the terminal's dialog; a session that drops takes its asks with it ('expired').
    if (method === 'POST' && path === '/approvals') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      if (!db.prepare('select 1 from sessions where id = ?').get(sessionId)) return send(res, 404, { error: say('bridge.noSessionFound', { id: sessionId }) })
      const requestKey = str(body.requestKey)
      const tool = str(body.tool).slice(0, 200)
      // Kept as it is (this database is the person's own): the app shows exactly what would run.
      // Telegram gets it masked, and then offers no allow (bridge/telegram.ts).
      const summary = str(body.summary).slice(0, 4000)
      // The same call sent again; the same key with another tool or summary is another ask, so
      // an answer is never taken for a call the person did not see.
      const same = requestKey
        ? (db.prepare('select id from approvals where session_id = ? and request_key = ? and tool = ? and summary = ?').get(sessionId, requestKey, tool, summary) as { id: number } | undefined)
        : undefined
      if (same) return send(res, 200, { id: same.id, duplicate: true })
      const id = Number(
        db
          .prepare('insert into approvals (session_id, project, tool, summary, cwd, reason, request_key, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(sessionId, projectOf(sessionId), tool, summary, str(body.cwd), maskSecrets(str(body.reason)).slice(0, 500), requestKey, now()).lastInsertRowid,
      )
      logEvent(sessionId, '권한', `A${id} ${tool}: ${maskSecrets(summary.split('\n')[0]?.slice(0, 160) ?? '')}`)
      changed('approvals')
      telegram.approvalPosted(db.prepare('select * from approvals where id = ?').get(id) as ApprovalRow)
      // The tool and the project only: what would run stays off the lock screen.
      if (away()) void notifyPhones({ title: say('mobile.push.approval', { tool, project: projectOf(sessionId) }), body: '', tag: `a${id}`, tab: 'approvals' })
      return send(res, 200, { id })
    }
    const approvalOne = path.match(/^\/approvals\/(\d+)(\/answer|\/abandon)?$/)
    if (approvalOne) {
      const row = db.prepare('select * from approvals where id = ?').get(Number(approvalOne[1])) as ApprovalRow | undefined
      if (!row) return send(res, 404, { error: say('bridge.notFound') })
      // `wait`: answers once the ask is answered or that many milliseconds (at most
      // APPROVAL_POLL_MAX_MS) went by, whichever is first. `waitMs` tells the mod this bridge waits.
      if (method === 'GET' && !approvalOne[2]) {
        const waitMs = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), APPROVAL_POLL_MAX_MS)
        const reply = () => {
          approvalSeen.set(row.id, now())
          const status = (db.prepare('select status from approvals where id = ?').get(row.id) as { status: string } | undefined)?.status ?? row.status
          send(res, 200, { id: row.id, status, waitMs })
        }
        if (row.status !== 'pending' || waitMs === 0) return reply()
        approvalSeen.set(row.id, now())
        const waiters = approvalWaiters.get(row.id) ?? new Set<() => void>()
        approvalWaiters.set(row.id, waiters)
        let done = false
        const finish = (answer: boolean) => {
          if (done) return
          done = true
          clearTimeout(timer)
          waiters.delete(wake)
          if (waiters.size === 0) approvalWaiters.delete(row.id)
          if (answer && !shuttingDown) reply()
        }
        const wake = () => finish(true)
        const timer = setTimeout(wake, waitMs)
        timer.unref()
        waiters.add(wake)
        res.on('close', () => finish(false))
        return
      }
      // The mod's hook stopped waiting (its time ran out, or the bridge was out of reach):
      // an answer now would reach nothing, so the ask leaves the queue.
      if (method === 'POST' && approvalOne[2] === '/abandon') {
        const body = await readJson(req)
        if (str(body.sessionId) !== row.session_id) return send(res, 403, { error: say('bridge.notFound') })
        answerApproval(row, 'expired', '', 'bridge.event.approvalStale')
        return send(res, 200, { id: row.id, status: (db.prepare('select status from approvals where id = ?').get(row.id) as { status: string }).status })
      }
      if (method === 'POST' && approvalOne[2] === '/answer') {
        const body = await readJson(req)
        const decision = str(body.decision)
        if (!['allow', 'deny', 'terminal'].includes(decision)) return send(res, 400, { error: say('bridge.needAnswer') })
        if (!answerApproval(row, decision as 'allow' | 'deny' | 'terminal', fromPhone ? 'mobile' : 'app')) return send(res, 409, { error: say('bridge.alreadyAnswered', { id: row.id }) })
        return send(res, 200, { id: row.id, status: decision })
      }
    }

    if (method === 'POST' && path === '/presence') {
      const body = await readJson(req)
      const wasAway = away()
      presence = { away: body.away === true, at: now() }
      if (!wasAway && away()) {
        telegram.away()
        void phonesAway().catch(() => undefined)
      }
      return send(res, 200, { away: away() })
    }

    // Telegram (bridge/telegram.ts), from the app's settings. The token never leaves the bridge.
    // Phones (bridge/mobile.ts): on or off, pairing one, forgetting one, and what a phone reads.
    if (method === 'GET' && path === '/mobile') return send(res, 200, { ...(await mobile.status()), enabled: mobileSetting().enabled })
    if (method === 'POST' && path === '/mobile') {
      const body = await readJson(req)
      const saved = mobileSetting()
      const enabled = typeof body.enabled === 'boolean' ? body.enabled : saved.enabled
      // `port`: another than MOBILE_PORT, kept for later starts (0 picks a free one, for tests).
      const port = Number.isInteger(body.port) && (body.port as number) >= 0 && (body.port as number) < 65536 ? (body.port as number) : saved.port
      // `lan` false: this computer only, for Tailscale HTTPS (no firewall question either).
      const lan = typeof body.lan === 'boolean' ? body.lan : saved.lan
      db.prepare("insert into settings (key, value) values ('mobile', ?) on conflict (key) do update set value = excluded.value").run(JSON.stringify({ enabled, port, lan }))
      if (enabled) await mobile.start(port, lan)
      else await mobile.stop()
      changed('mobile')
      return send(res, 200, { ...(await mobile.status()), enabled })
    }
    // Tailscale HTTPS for the phone page: tailscale serve, on the person's say in the app.
    if (method === 'POST' && path === '/mobile/tailscale') {
      const body = await readJson(req)
      const on = body.on === true
      // Open to the internet (Tailscale Funnel), so a phone needs no Tailscale of its own.
      const funnel = on && body.funnel === true
      const status = await mobile.status()
      if (on && !status.listening) return send(res, 409, { error: say('mobile.off') })
      if (on && status.tailscale.busy) return send(res, 409, { error: say('mobile.tailscaleBusy') })
      // Asked without the tailnet's leave, the command would wait for it instead of failing.
      if (funnel && !status.tailscale.funnelAllowed) return send(res, 400, { error: say('mobile.funnelPolicy', { link: status.tailscale.funnelLink }) })
      const result = await mobile.tailscale(on, funnel)
      if (!result.ok) return send(res, 400, { error: say('mobile.tailscaleFailed', { error: result.error }) })
      changed('mobile')
      return send(res, 200, { ...(await mobile.status()), enabled: mobileSetting().enabled })
    }
    if (method === 'POST' && path === '/mobile/pair') {
      const body = await readJson(req)
      // The address the QR code is for: a key that goes out over plain HTTP may not allow later.
      const kind = (['https', 'tailscale', 'name', 'lan'] as const).find(k => k === body.kind) ?? 'lan'
      const paired = mobile.pair(str(body.name).trim(), kind)
      changed('mobile')
      return send(res, 200, paired)
    }
    const phoneOne = path.match(/^\/mobile\/devices\/(\d+)\/revoke$/)
    if (method === 'POST' && phoneOne) {
      if (!mobile.revoke(Number(phoneOne[1]))) return send(res, 404, { error: say('bridge.notFound') })
      changed('mobile')
      return send(res, 200, { ok: true })
    }
    if (method === 'GET' && path === '/mobile/view') return send(res, 200, phoneView())

    if (method === 'GET' && path === '/telegram') return send(res, 200, telegram.status())
    if (method === 'POST' && path === '/telegram/token') {
      const body = await readJson(req)
      const value = body.token === null ? null : str(body.token).trim()
      if (value !== null && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(value)) return send(res, 400, { error: say('telegram.badToken') })
      const result = await telegram.setToken(value)
      changed('telegram')
      return send(res, result.ok ? 200 : 400, result.ok ? telegram.status() : { error: result.error })
    }
    if (method === 'POST' && path === '/telegram/pair') return send(res, 200, await telegram.pair())
    if (method === 'POST' && path === '/telegram/unpair') {
      telegram.unpair()
      changed('telegram')
      return send(res, 200, telegram.status())
    }
    if (method === 'POST' && path === '/telegram/test') {
      try {
        await telegram.test()
        return send(res, 200, { ok: true })
      } catch (error) {
        return send(res, 400, { error: String(error instanceof Error ? error.message : error) })
      }
    }

    if (method === 'GET' && path === '/deliveries') {
      const sessionId = url.searchParams.get('session') ?? ''
      if (!sessionId) return send(res, 400, { error: say('bridge.noSession') })
      sse(res)
      const set = deliveryWatchers.get(sessionId) ?? new Set()
      set.add(res)
      deliveryWatchers.set(sessionId, set)
      offlineSince.delete(sessionId)
      // The app shows which sessions can take an answer now (state().live).
      if (set.size === 1) {
        changed('sessions')
        assignRuns()
      }
      // Guarded: an exception in an event handler would end the bridge.
      req.on('close', guarded('stream close', () => {
        set.delete(res)
        if (set.size > 0) return
        // Gone: what the bridge keeps in memory per session goes too (activity is in every /state).
        if (deliveryWatchers.get(sessionId) === set) deliveryWatchers.delete(sessionId)
        activity.delete(sessionId)
        // Streams close as the bridge shuts down too, after its database.
        if (shuttingDown) return
        offlineSince.set(sessionId, now())
        changed('sessions')
        // Its process is gone, and the ask with it.
        for (const row of db.prepare("select * from approvals where session_id = ? and status = 'pending'").all(sessionId) as ApprovalRow[]) {
          answerApproval(row, 'expired', '')
        }
      }))
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
      // The row, its number, its summary fields and its archive time land together.
      const row = atomic(() => {
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
        return db.prepare('select * from tasks where session_id = ? and title = ?').get(sessionId, title)
      })
      changed('tasks')
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
      const posted = db.prepare('select * from questions where id = ?').get(id) as QuestionRow
      telegram.posted(posted)
      if (away()) void notifyPhones({ title: say('mobile.push.question', { project: posted.project }), body: maskSecrets(posted.question).slice(0, 160), tag: `q${id}`, tab: 'decisions' })
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
      answerQuestion(q, choice || null, memo || null)
      return send(res, 200, { id, status: 'answered' })
    }

    // The person hands a decision question to another session, which answers in their place
    // (bridge/peer.ts forwardText); its reply becomes the answer (answerForwarded).
    const forward = path.match(/^\/questions\/(\d+)\/forward$/)
    if (method === 'POST' && forward) {
      const id = Number(forward[1])
      const q = db.prepare('select * from questions where id = ?').get(id) as QuestionRow | undefined
      if (!q) return send(res, 404, { error: say('bridge.noQuestion', { id }) })
      if (q.status === 'answered') return send(res, 409, { error: say('bridge.peer.forwardNotOpen', { id }) })
      const body = await readJson(req)
      const to = str(body.to)
      if (!to || !db.prepare('select 1 from sessions where id = ?').get(to)) return send(res, 404, { error: say('bridge.noSessionFound', { id: to }) })
      if (to === q.session_id) return send(res, 400, { error: say('bridge.peer.self') })
      const row = db
        .prepare(
          `insert into outbox (session_id, kind, task_title, text, created_at, expects_reply, question_id)
           values (?, '세션메시지', ?, '', ?, 1, ?)`,
        )
        .run(to, q.task_title, now(), id)
      db.prepare('update questions set forwarded_to = ? where id = ?').run(to, id)
      logEvent(q.session_id, '세션메시지', say('bridge.event.forwarded', { id, to: sessionLabel(to) }), q.task_title)
      changed('questions')
      changed('outbox')
      pushDeliveries(to)
      return send(res, 200, { id, message: `m${Number(row.lastInsertRowid)}` })
    }

    const ackMessage = path.match(/^\/deliveries\/m(\d+)\/ack$/)
    if (method === 'POST' && ackMessage) {
      const id = Number(ackMessage[1])
      holding.delete(id)
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
      // From the shell (scripts/switchboard.ts): the session's reply is kept on the row.
      const expectsReply = body.expectsReply === true ? 1 : 0
      const result = db
        .prepare('insert into outbox (session_id, kind, task_title, text, created_at, expects_reply) values (?, ?, ?, ?, ?, ?)')
        .run(sessionId, kind, taskTitle, text, now(), expectsReply)
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
    // send_to_session. `to` may be left out on a reply: it goes to the one who asked. A reply
    // to a forwarded question answers that question instead (answerForwarded).
    if (method === 'POST' && path === '/messages') {
      const body = await readJson(req)
      const from = str(body.sessionId)
      if (!db.prepare('select 1 from sessions where id = ?').get(from)) return send(res, 404, { error: say('bridge.noSessionFound', { id: from }) })
      const text = str(body.text).trim()
      if (!text) return send(res, 400, { error: say('bridge.needText') })
      const requestKey = str(body.requestKey)
      if (requestKey) {
        const sent = db.prepare('select id from outbox where from_session = ? and request_key = ? order by id').all(from, requestKey) as { id: number }[]
        if (sent.length > 0) return send(res, 200, { ids: sent.map(r => `m${r.id}`), duplicate: true })
      }
      const replyId = Number(str(body.replyTo).replace(/^m/, '')) || null
      const replied = replyId
        ? (db.prepare('select * from outbox where id = ? and session_id = ?').get(replyId, from) as OutboxRow | undefined)
        : undefined
      if (replyId && !replied) return send(res, 400, { error: say('bridge.peer.badReply', { id: `m${replyId}` }) })
      if (replied?.question_id) {
        answerForwarded(replied, from, text)
        return send(res, 200, { ids: [], answered: `Q${replied.question_id}` })
      }
      if (replied && !replied.from_session && replied.expects_reply) {
        keepShellReply(replied, text)
        return send(res, 200, { ids: [], answered: `m${replied.id}` })
      }
      const named = Array.isArray(body.to) ? [...new Set(body.to.map(id => str(id)).filter(Boolean))] : []
      const to = named.length > 0 ? named : replied?.from_session ? [replied.from_session] : []
      if (to.length === 0) return send(res, 400, { error: say('bridge.peer.noRecipients') })
      if (to.length > PEER_RECIPIENTS_MAX) return send(res, 400, { error: say('bridge.peer.tooMany', { max: PEER_RECIPIENTS_MAX }) })
      if (to.includes(from)) return send(res, 400, { error: say('bridge.peer.self') })
      const unknown = to.find(id => !db.prepare('select 1 from sessions where id = ?').get(id))
      if (unknown) return send(res, 404, { error: say('bridge.noSessionFound', { id: unknown }) })
      // A reply never asks for another: two sessions never answer each other's answers.
      const expectsReply = !replied && body.expectsReply !== false
      // A request made while working on one (from another session or the shell) continues its
      // run of hand-offs; a run stops at DELEGATION_MAX requests between sessions.
      let chain: number | null = null
      if (expectsReply) {
        const parent = db
          .prepare(
            `select id, chain from outbox where session_id = ? and delivered = 1 and expects_reply = 1 and answered = 0 and cancelled = 0
             and no_reply = '' and routine_run is null and wait_id is null and created_at > ? order by id desc limit 1`,
          )
          .get(from, now() - CHAIN_WINDOW_MS) as { id: number; chain: number | null } | undefined
        chain = parent ? (parent.chain ?? parent.id) : null
        const used = chain === null ? 0 : (db.prepare("select count(*) as n from outbox where chain = ? and from_session != '' and expects_reply = 1").get(chain) as { n: number }).n
        if (used + to.length > DELEGATION_MAX) return send(res, 400, { error: say('bridge.peer.chainFull', { max: DELEGATION_MAX }) })
        for (const recipient of to) {
          const recent = (db
            .prepare("select count(*) as n from outbox where from_session = ? and session_id = ? and expects_reply = 1 and created_at > ?")
            .get(from, recipient, now() - PAIR_WINDOW_MS) as { n: number }).n
          if (recent >= DELEGATION_MAX) return send(res, 429, { error: say('bridge.peer.tooOften', { max: DELEGATION_MAX }) })
        }
      }
      if (replied) db.prepare('update outbox set answered = 1 where id = ?').run(replied.id)
      const ids = sendPeer(from, to, text, replied?.id ?? null, expectsReply, requestKey, chain)
      return send(res, 200, { ids })
    }

    // cancel_request: a session takes back requests it sent. One not delivered yet never goes
    // in; one the recipient got is closed (no result comes back), the recipient is told with
    // its next turn, and a Claude Code recipient whose turn carries only these stops it.
    if (method === 'POST' && path === '/messages/cancel') {
      const body = await readJson(req)
      const from = str(body.sessionId)
      if (!db.prepare('select 1 from sessions where id = ?').get(from)) return send(res, 404, { error: say('bridge.noSessionFound', { id: from }) })
      const ids = (Array.isArray(body.ids) ? body.ids : [body.ids]).map(id => Number(str(id).replace(/^m/, ''))).filter(Boolean)
      if (ids.length === 0) return send(res, 400, { error: say('bridge.peer.needIds') })
      const rows = ids.map(id => db.prepare('select * from outbox where id = ?').get(id) as OutboxRow | undefined)
      const bad = ids.find((_, i) => !rows[i] || rows[i]!.from_session !== from || !rows[i]!.expects_reply)
      if (bad !== undefined) return send(res, 400, { error: say('bridge.peer.notYours', { id: `m${bad}` }) })
      const reason = str(body.reason).trim()
      const results: Record<string, 'queued' | 'noted' | 'stopped' | 'done'> = {}
      // The recipient is told to drop it, with its next prompt.
      const noteCancel = (row: OutboxRow) =>
        db.prepare("insert into outbox (session_id, kind, text, created_at, piggyback) values (?, '세션메시지', ?, ?, 1)").run(
          row.session_id,
          cancelledText(row.id, sessionLabel(from), reason, langNow()),
          now(),
        )
      const byRecipient = new Map<string, OutboxRow[]>()
      // Each request closed with its note to the recipient, all of them or none.
      atomic(() => {
        for (const row of rows as OutboxRow[]) {
          if (row.answered || row.cancelled) {
            results[`m${row.id}`] = 'done'
            continue
          }
          // One the app is typing in now has reached the session as much as a delivered one.
          const reached = Boolean(row.delivered) || isHeld(row.id)
          db.prepare('update outbox set cancelled = 1, answered = 1, delivered = 1 where id = ?').run(row.id)
          results[`m${row.id}`] = reached ? 'noted' : 'queued'
          if (reached) noteCancel(row)
          byRecipient.set(row.session_id, [...(byRecipient.get(row.session_id) ?? []), row])
          logEvent(from, '세션메시지', say('bridge.event.peerCancelled', { id: row.id, recipient: sessionLabel(row.session_id) }))
        }
      })
      for (const list of byRecipient.values()) for (const row of list) holding.delete(row.id)
      changed('outbox')
      // The mod drops what it holds and stops a turn made of these alone (it answers in a moment).
      const asked: { command: number; rows: OutboxRow[] }[] = []
      for (const [recipient, list] of byRecipient) {
        if (!autoReplies(recipient) || !liveSessions().includes(recipient)) continue
        const command = Number(
          db
            .prepare("insert into commands (session_id, kind, payload, created_at) values (?, 'cancel', ?, ?)")
            .run(recipient, JSON.stringify({ ids: list.map(r => `m${r.id}`) }), now()).lastInsertRowid,
        )
        pushCommands(recipient, { id: command })
        asked.push({ command, rows: list })
      }
      if (asked.length > 0) changed('commands')
      for (let waited = 0; waited < CANCEL_WAIT_MS && asked.some(a => !commandResult(a.command)); waited += 100) await sleep(100)
      // `reached`: requests the mod had already put in a prompt it has not acknowledged yet.
      for (const a of asked) {
        const result = commandResult(a.command) as { stopped?: boolean; reached?: string[] } | null
        for (const r of a.rows) {
          const key = `m${r.id}`
          const reached = Array.isArray(result?.reached) && result.reached.includes(key)
          if (result?.stopped && (results[key] === 'noted' || reached)) results[key] = 'stopped'
          else if (results[key] === 'queued' && reached) {
            noteCancel(r)
            results[key] = 'noted'
          }
        }
      }
      return send(res, 200, { results })
    }

    // The person wrote to this session in its terminal: what was held for a later turn
    // (heldReply) goes in with that prompt instead.
    if (method === 'POST' && path === '/messages/release') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      if (!db.prepare('select 1 from sessions where id = ?').get(sessionId)) return send(res, 404, { error: say('bridge.noSessionFound', { id: sessionId }) })
      const held = (db.prepare('select * from outbox where session_id = ? and delivered = 0 order by id').all(sessionId) as OutboxRow[]).filter(m => heldReply(m))
      for (const m of held) {
        db.prepare('update outbox set delivered = 1 where id = ?').run(m.id)
        logEvent(sessionId, '전달', say('bridge.event.injected', { kind: eventKindLabel(m.kind, langNow()) }), m.task_title)
      }
      if (held.length > 0) changed('outbox')
      return send(res, 200, { items: held.map(m => ({ id: `m${m.id}`, text: outboxText(m) })) })
    }

    // switchboard status / send --wait: where a message stands, its reply, and the decision
    // questions its session posted since it was sent (the shell then waits for a person).
    const messageOne = path.match(/^\/messages\/m?(\d+)$/)
    if (method === 'GET' && messageOne) {
      const row = db.prepare('select * from outbox where id = ?').get(Number(messageOne[1])) as (OutboxRow & { reply_text: string | null; replied_at: number | null }) | undefined
      if (!row) return send(res, 404, { error: say('bridge.peer.badReply', { id: `m${messageOne[1]}` }) })
      const questions = db
        .prepare("select id, question from questions where session_id = ? and status in ('pending', 'held') and created_at >= ? order by id")
        .all(row.session_id, row.created_at)
      return send(res, 200, {
        id: `m${row.id}`,
        sessionId: row.session_id,
        live: liveSessions().includes(row.session_id),
        delivered: row.delivered === 1,
        answered: row.answered === 1,
        reply: row.reply_text ?? null,
        repliedAt: row.replied_at ?? null,
        questions,
      })
    }

    // The mod's turn ended (turn.complete). Each request that went in with the turn and got
    // no reply gets the turn's last answer as its result; a forwarded question, as its answer.
    if (method === 'POST' && path === '/messages/turn-end') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      const answerText = str(body.answer).trim()
      const aborted = body.aborted === true
      const ids = Array.isArray(body.ids) ? body.ids.map(id => Number(str(id).replace(/^m/, ''))).filter(Boolean) : []
      let relayed = 0
      for (const id of ids) {
        const row = db.prepare('select * from outbox where id = ? and session_id = ?').get(id, sessionId) as OutboxRow | undefined
        if (row?.routine_run) {
          finishRun(row.routine_run, answerText, aborted)
          continue
        }
        if (row && aborted && row.from_session && row.expects_reply && !row.answered && !row.cancelled) {
          noteNoReply(row, 'interrupted')
          continue
        }
        if (!row || aborted || !row.expects_reply || row.answered || row.cancelled) continue
        // A turn that ended with no text (only tool calls, an API error) answered nothing.
        if (!answerText) {
          if (row.from_session && !row.question_id) noteNoReply(row, 'empty')
          continue
        }
        if (row.question_id) answerForwarded(row, sessionId, answerText)
        else if (!row.from_session) keepShellReply(row, answerText)
        else if (row.from_session) {
          db.prepare('update outbox set answered = 1 where id = ?').run(row.id)
          sendPeer(sessionId, [row.from_session], answerText, row.id, false, `auto:${row.id}`)
        } else continue
        relayed++
      }
      return send(res, 200, { relayed })
    }

    // list_sessions: the other sessions a session can write to, connected ones first.
    if (method === 'GET' && path === '/sessions/peers') {
      const self = url.searchParams.get('session') ?? ''
      const live = liveSessions()
      const rows = db
        .prepare('select id, project, cwd, agent, last_seen from sessions where id != ? and last_seen > ? order by last_seen desc')
        .all(self, now() - 7 * DAY) as { id: string; project: string; cwd: string; agent: string; last_seen: number }[]
      const peers = rows.map(s => {
        const task = db
          .prepare("select title, now from tasks where session_id = ? and status != '보관' order by updated_at desc limit 1")
          .get(s.id) as { title: string; now: string } | undefined
        return { ...s, live: live.includes(s.id), state: activity.get(s.id)?.state ?? '', task: task?.title ?? '', now: task?.now ?? '' }
      })
      peers.sort((a, b) => Number(b.live) - Number(a.live))
      return send(res, 200, { peers })
    }

    // Scheduled prompts, from the app's settings. A new or changed one counts its next run from now.
    if (method === 'POST' && path === '/routines') {
      const body = await readJson(req)
      const schedule = parseSchedule(body.schedule, now())
      if ('error' in schedule) return send(res, 400, { error: schedule.error })
      const name = str(body.name).trim()
      const prompt = str(body.prompt).trim()
      const project = str(body.project).trim()
      const cwd = str(body.cwd).trim()
      if (!name || !prompt || !project || !cwd) return send(res, 400, { error: say('bridge.needText') })
      const missed = str(body.missed) === 'run-once' ? 'run-once' : 'skip'
      const enabled = body.enabled === false ? 0 : 1
      // An agents.ts id, or a custom CLI's: the app opens it by that id.
      const agent = str(body.agent, 'claude').trim() || 'claude'
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent)) return send(res, 400, { error: say('bridge.badAgent') })
      const next = nextRun(schedule, now())
      const id = Number(body.id) || 0
      if (id) {
        const updated = db.prepare('update routines set project = ?, cwd = ?, name = ?, prompt = ?, schedule = ?, missed = ?, enabled = ?, next_at = ?, updated_at = ?, failed_off = 0, agent = ? where id = ?').run(
          project, cwd, name, prompt, JSON.stringify(schedule), missed, enabled, next, now(), agent, id,
        )
        // Deleted meanwhile (another window): nothing was saved.
        if (updated.changes === 0) return send(res, 404, { error: say('bridge.notFound') })
      }
      const saved = id
        ? id
        : Number(
            db
              .prepare('insert into routines (project, cwd, name, prompt, schedule, missed, enabled, next_at, created_at, updated_at, agent) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(project, cwd, name, prompt, JSON.stringify(schedule), missed, enabled, next, now(), now(), agent).lastInsertRowid,
          )
      changed('routines')
      return send(res, 200, db.prepare('select * from routines where id = ?').get(saved))
    }
    const routineAction = path.match(/^\/routines\/(\d+)\/(run|delete)$/)
    if (method === 'POST' && routineAction) {
      const r = db.prepare('select * from routines where id = ?').get(Number(routineAction[1])) as RoutineRow | undefined
      if (!r) return send(res, 404, { error: say('bridge.notFound') })
      if (routineAction[2] === 'delete') {
        // A run's prompt still waiting for its session goes with it: without its run it would
        // reach the session as an empty request.
        const dropped = atomic(() => {
          const closed = db
            .prepare('update outbox set delivered = 1, answered = 1 where delivered = 0 and routine_run in (select id from routine_runs where routine_id = ?)')
            .run(r.id).changes
          db.prepare('delete from routine_runs where routine_id = ?').run(r.id)
          db.prepare('delete from routines where id = ?').run(r.id)
          return closed
        })
        if (dropped > 0) changed('outbox')
      } else {
        startRun(r, now())
        assignRuns()
      }
      changed('routines')
      return send(res, 200, { ok: true })
    }

    // routine_no_update / routine_report_failure: the run this session is on ends quiet or failed
    // when its turn ends.
    if (method === 'POST' && path === '/routines/report') {
      const body = await readJson(req)
      const run = db
        .prepare("select id from routine_runs where session_id = ? and status = 'sent' order by id desc limit 1")
        .get(str(body.sessionId)) as { id: number } | undefined
      if (!run) return send(res, 400, { error: say('routine.notInRun') })
      if (str(body.kind) === 'failed') db.prepare('update routine_runs set failure = ? where id = ?').run(str(body.reason).trim().slice(0, 1000) || '-', run.id)
      else db.prepare('update routine_runs set quiet = 1 where id = ?').run(run.id)
      return send(res, 200, { ok: true, run: run.id })
    }

    // await_event: a session parks what it waits for and ends its turn; `switchboard fire w<id>`
    // later puts the request back into it with what came.
    if (method === 'POST' && path === '/waits') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      const note = str(body.note).trim()
      if (!db.prepare('select 1 from sessions where id = ?').get(sessionId)) return send(res, 404, { error: say('bridge.noSessionFound', { id: sessionId }) })
      if (!note) return send(res, 400, { error: say('bridge.needText') })
      const open = (db.prepare('select count(*) n from waits where session_id = ? and fired_at is null and closed_at is null').get(sessionId) as { n: number }).n
      if (open >= 20) return send(res, 400, { error: say('bridge.waitLimit', { max: 20 }) })
      const id = Number(db.prepare('insert into waits (session_id, note, created_at) values (?, ?, ?)').run(sessionId, note.slice(0, 2000), now()).lastInsertRowid)
      logEvent(sessionId, '대기', `w${id} ${note.split('\n')[0]?.slice(0, 160) ?? ''}`)
      changed('waits')
      return send(res, 200, { id: `w${id}` })
    }
    if (method === 'GET' && path === '/waits') {
      const session = url.searchParams.get('session')
      const rows = db
        .prepare(`select w.*, s.project from waits w left join sessions s on s.id = w.session_id where w.fired_at is null and w.closed_at is null ${session ? 'and w.session_id = ?' : ''} order by w.id`)
        .all(...(session ? [session] : []))
      return send(res, 200, { waits: rows })
    }
    const waitAction = path.match(/^\/waits\/w?(\d+)\/(fire|close)$/)
    if (method === 'POST' && waitAction) {
      const body = await readJson(req)
      const wait = db.prepare('select * from waits where id = ?').get(Number(waitAction[1])) as { id: number; session_id: string; fired_at: number | null; closed_at: number | null } | undefined
      if (!wait || wait.fired_at || wait.closed_at) return send(res, 404, { error: say('bridge.notFound') })
      // A session closes only its own wait; the shell (no sessionId) fires and closes any.
      if (str(body.sessionId) && str(body.sessionId) !== wait.session_id) return send(res, 403, { error: say('bridge.notFound') })
      if (waitAction[2] === 'close') {
        db.prepare('update waits set closed_at = ? where id = ?').run(now(), wait.id)
      } else {
        db.prepare('update waits set fired_at = ?, payload = ? where id = ?').run(now(), clipText(str(body.payload)), wait.id)
        db.prepare("insert into outbox (session_id, kind, text, created_at, wait_id) values (?, '메시지', '', ?, ?)").run(wait.session_id, now(), wait.id)
        changed('outbox')
        pushDeliveries(wait.session_id)
      }
      changed('waits')
      return send(res, 200, { ok: true })
    }

    // A turn started or ended, or a tool call opened or closed. The app is told only when
    // the picture changes (working or idle, a tool open or not); a heartbeat just moves `at`.
    if (method === 'POST' && path === '/sessions/activity') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      const state = str(body.state)
      if (!sessionId || (state !== 'working' && state !== 'idle')) return send(res, 400, { error: say('bridge.noSession') })
      const openTools = Math.max(0, Math.floor(Number(body.openTools) || 0))
      const before = activity.get(sessionId)
      activity.set(sessionId, { state, openTools, at: now() })
      if (!before || before.state !== state || (before.openTools > 0) !== (openTools > 0)) changed('activity')
      return send(res, 200, { ok: true })
    }

    if (method === 'POST' && path === '/sessions/seen') {
      const body = await readJson(req)
      const result = db.prepare('update sessions set last_seen = ? where id = ?').run(now(), str(body.sessionId))
      if (result.changes === 0) return send(res, 404, { error: say('bridge.noSessionFound', { id: str(body.sessionId) }) })
      return send(res, 200, { ok: true })
    }

    // Everything waiting for a session, taken at once and marked delivered: answers ("q<id>")
    // and IDE messages ("m<id>") as text, oldest first, and the commands still open. Commands
    // that can become a prompt come back to be typed; the rest are closed as unsupported.
    // The app took these with `hold` but could not type them (the terminal closed): they are not in.
    if (method === 'POST' && path === '/deliveries/unhold') {
      const body = await readJson(req)
      for (const id of Array.isArray(body.ids) ? body.ids : []) holding.delete(Number(str(id).replace(/^m/, '')))
      return send(res, 200, { ok: true })
    }

    if (method === 'POST' && path === '/deliveries/take') {
      const body = await readJson(req)
      const sessionId = str(body.sessionId)
      if (!stmt('select 1 from sessions where id = ?').get(sessionId)) {
        return send(res, 404, { error: say('bridge.noSessionFound', { id: sessionId }) })
      }
      const limited = limitedSession(sessionId)
      const answers = limited ? [] : undelivered(sessionId)
      const messages = limited ? [] : pendingOutbox(sessionId)
      const items = [
        ...answers.map(q => ({ id: `q${q.id}`, text: deliveryText(q, langNow()), at: q.answered_at ?? 0 })),
        ...messages.map(m => ({ id: `m${m.id}`, text: outboxText(m), at: m.created_at })),
      ].sort((a, b) => a.at - b.at)
      // `hold`: the caller types the items first and acknowledges each one after
      // (/deliveries/<id>/ack), so a terminal that closes in between loses nothing.
      if (body.hold === true) {
        for (const m of messages) holding.set(m.id, now())
        answers.length = 0
        messages.length = 0
      }
      const commands = pendingCommands(sessionId).map(c => ({ id: c.id, kind: c.kind, payload: JSON.parse(c.payload) as Json }))
      const usable = commands.filter(c => PROMPT_COMMANDS.includes(c.kind) && !(c.kind === 'message' && str(c.payload.agentId)))
      // With `hold` the commands it can type stay open too, and the caller closes each one after
      // typing it (/commands/<id>/done): one it could not type is still here for the next take.
      const marked = body.hold === true ? commands.filter(c => !usable.includes(c)) : commands
      // Everything handed over is marked at once: a crash midway would give some of it again.
      atomic(() => {
        for (const q of answers) {
          stmt('update questions set delivered = 1 where id = ?').run(q.id)
          logEvent(sessionId, '전달', say('bridge.event.answerInjected', { id: q.id }), q.task_title)
        }
        for (const m of messages) {
          stmt('update outbox set delivered = 1 where id = ?').run(m.id)
          logEvent(sessionId, '전달', say('bridge.event.injected', { kind: eventKindLabel(m.kind, langNow()) }), m.task_title)
        }
        for (const c of marked) {
          const result = usable.includes(c) ? { ok: true } : { error: say('bridge.agentCommand') }
          stmt('update commands set done_at = coalesce(done_at, ?), result = ? where id = ?').run(now(), JSON.stringify(result), c.id)
        }
      })
      if (answers.length > 0) changed('questions')
      if (messages.length > 0) changed('outbox')
      if (marked.length > 0) changed('commands')
      return send(res, 200, { items: items.map(({ id, text }) => ({ id, text })), commands: usable })
    }

    // Dynamic debugging (bridge/debug.ts): screen comments, open_in_ide, live sessions.
    if (await debugRoutes({ db, watchers, deliveryWatchers, readJson }, req, res, method, path, url)) return

    return send(res, 404, { error: say('bridge.noRoute', { method, path }) })
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof BridgeError ? say(error.key) : say('bridge.failed', { error: error instanceof Error ? error.message : String(error) })
      if (!res.headersSent) send(res, 400, { error: message })
      else res.end()
    })
  })

  server.on('listening', () => {
    const address = server.address()
    try {
      bound = typeof address === 'string' ? `inode:${statSync(address).ino}` : address ? `port:${address.port}` : ''
    } catch {
      bound = ''
    }
  })

  // Once only: a signal and the self-check may both ask. The last checkpoint leaves the WAL empty.
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    shuttingDown = true
    telegram.stop()
    void mobile.stop()
    clearInterval(pruning)
    clearInterval(releasing)
    clearInterval(routineTimer)
    server.close()
    try {
      db.exec('pragma wal_checkpoint(TRUNCATE);')
    } catch {
      // Another connection still reads: closing checkpoints what it can.
    }
    db.close()
  }

  // How many sessions memory holds something for (tests).
  const memory = () => ({ streams: deliveryWatchers.size, activity: activity.size, offlineSince: offlineSince.size })

  return { server, db, prune, tickRoutines, checkNoReplies, forgetGone, memory, close }
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function newToken(): string {
  return randomBytes(24).toString('base64url')
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
}

// Windows (bridge/endpoint.ts): a free port on 127.0.0.1, written with the token for the
// clients. bridge.lock holds the pid of the bridge that serves, so a second one started at
// the same moment (the IDE and a mod can both try) refuses instead of taking over. Except the
// app's own bridge (`ownsKey`) over one a session started without the key, as `listen` does:
// the app no longer stops a bridge that cannot prove the key (src/main/bridgeClient.ts).
export async function listenTcp(server: Server, token: string, home = homedir(), ownsKey = false): Promise<number> {
  const dir = ideDir(home)
  privateDir(dir)
  const lock = join(dir, 'bridge.lock')
  // Made with wx only: a lock left by a bridge that died is removed, then made again, so two
  // starts at once cannot both hold it. One just made may still be empty for a moment.
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
      break
    } catch {
      const holder = Number(readFileSync(lock, 'utf8').trim() || 0)
      if (holder && holder !== process.pid && alive(holder)) {
        const keyless = ownsKey ? await keylessPid(tcpTarget(home)) : null
        if (keyless !== holder || !(await stopped(holder))) throw new Error(`다른 브리지(pid ${holder})가 이미 돌고 있습니다`)
        console.log(`claude-ide bridge: replaced bridge ${holder}, which ran without the app's key`)
      }
      if (attempt >= 20) throw new Error(tIn(resolveLang(undefined, systemLocale()), 'bridge.noLock', { file: lock }))
      if (holder) rmSync(lock, { force: true })
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  writePrivate(endpointFile(home), JSON.stringify({ port, token, pid: process.pid }))
  writePrivate(curlConfigFile(home), `header = "Authorization: Bearer ${token}"\n`)
  process.once('exit', () => {
    try {
      if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock)
    } catch {
      // Gone already.
    }
  })
  return port
}

// Whether this bridge still serves where clients look: another start may have taken the
// socket path (or bridge.json) over in a race. A bridge nobody reaches would keep its timers
// running on the same database, so it leaves.
export function servingCheck(where: { socketPath: string } | { home: string }): () => boolean {
  if ('socketPath' in where) {
    const inode = statSync(where.socketPath).ino
    return () => {
      try {
        return statSync(where.socketPath).ino === inode
      } catch {
        return false
      }
    }
  }
  return () => {
    try {
      return (JSON.parse(readFileSync(endpointFile(where.home), 'utf8')) as { pid?: number }).pid === process.pid
    } catch {
      return false
    }
  }
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

// Where the bridge in bridge.json listens, for keylessPid; null without one.
function tcpTarget(home: string): { host: string; port: number; headers: Record<string, string> } | null {
  try {
    const saved = JSON.parse(readFileSync(endpointFile(home), 'utf8')) as { port?: unknown; token?: unknown }
    if (typeof saved.port === 'number' && typeof saved.token === 'string') return { host: '127.0.0.1', port: saved.port, headers: { authorization: `Bearer ${saved.token}` } }
  } catch {
    // None written.
  }
  return null
}

// The pid of the bridge answering on the socket (or the port) when it runs without the app's key, else null.
function keylessPid(where: string | ReturnType<typeof tcpTarget>): Promise<number | null> {
  if (where === null) return Promise.resolve(null)
  return new Promise(resolve => {
    const req = httpRequest({ ...(typeof where === 'string' ? { socketPath: where } : where), path: '/health', timeout: 1000 }, res => {
      let text = ''
      res.on('data', chunk => (text += String(chunk)))
      res.on('end', () => {
        try {
          const health = JSON.parse(text) as { app?: unknown; pid?: unknown }
          resolve(health.app === false && typeof health.pid === 'number' && health.pid !== process.pid ? health.pid : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end()
  })
}

// Stops a bridge and waits until its process is gone: an exiting bridge removes its socket
// file as it closes, which must not happen after this one has made its own.
async function stopped(pid: number, waitMs = 3000): Promise<boolean> {
  try {
    process.kill(pid)
  } catch {
    return !alive(pid)
  }
  for (let waited = 0; waited < waitMs && alive(pid); waited += 50) await new Promise(resolve => setTimeout(resolve, 50))
  return !alive(pid)
}

// A live socket means another bridge already serves it (the IDE and a mod can
// both try to start one at once): refuse rather than take the socket over.
// Except the app's own bridge (`ownsKey`) over one a session started without the key: the app
// would replace that one anyway (src/main/index.ts ensureOwnBridge), and taking over at once
// keeps a session that restarts the bridge while the app replaces it (an update) from leaving
// a bridge the app cannot use.
export async function listen(server: Server, socketPath: string, ownsKey = false): Promise<void> {
  privateDir(dirname(socketPath))
  if (existsSync(socketPath)) {
    if (await isAnswering(socketPath)) {
      const pid = ownsKey ? await keylessPid(socketPath) : null
      if (pid === null || !(await stopped(pid))) throw new Error(tIn(resolveLang(undefined, systemLocale()), 'bridge.alreadyRunning', { where: socketPath }))
      console.log(`claude-ide bridge: replaced bridge ${pid}, which ran without the app's key`)
    }
    rmSync(socketPath, { force: true })
  }
  // Created private: no moment where the socket is open to others before the chmod.
  const mask = process.umask(0o077)
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve))
  } finally {
    process.umask(mask)
  }
  chmodSync(socketPath, 0o600)
}

// The app's key comes on standard input, never in the environment or a file another program reads.
async function keyFromStdin(): Promise<string | undefined> {
  if (process.env.SWITCHBOARD_APP_KEY_STDIN !== '1') return undefined
  let text = ''
  for await (const chunk of process.stdin) {
    text += String(chunk)
    if (text.includes('\n') || text.length > 200) break
  }
  const key = text.split('\n')[0]!.trim()
  return /^[0-9a-f]{64}$/.test(key) ? key : undefined
}

if (import.meta.main) {
  const token = usesTcp() ? newToken() : undefined
  const appKey = await keyFromStdin()
  const bridge = createBridge(defaultDbPath(), undefined, { token, appKey })
  // Stopped from outside (the app quitting or replacing it, a kill, Ctrl-C): the database
  // closes first, so the WAL is folded in and Telegram and the phone server stop cleanly.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      bridge.close()
      process.exit(0)
    })
  }
  try {
    let where = defaultSocketPath()
    if (token === undefined) await listen(bridge.server, where, appKey !== undefined)
    else where = `127.0.0.1:${await listenTcp(bridge.server, token, homedir(), appKey !== undefined)}`
    console.log(`claude-ide bridge listening on ${where}`)
    const serving = servingCheck(token === undefined ? { socketPath: where } : { home: homedir() })
    // Tests that start a bridge name themselves here, so one they leave behind goes with them.
    const parent = Number(process.env.CLAUDE_IDE_PARENT_PID) || 0
    const watch = setInterval(() => {
      if (serving() && !(parent && !alive(parent))) return
      console.log('claude-ide bridge: another bridge took over, or the process that started it is gone; leaving')
      clearInterval(watch)
      bridge.close()
      process.exit(0)
    }, parent ? 2000 : 30_000)
  } catch (error) {
    console.log(`claude-ide bridge not started: ${error instanceof Error ? error.message : String(error)}`)
    bridge.close()
  }
}

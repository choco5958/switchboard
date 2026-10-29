// Bridge routes of the dynamic debugging page: screen comments kept across
// restarts, the session asking the IDE to open a page (open_in_ide), and which
// sessions are alive right now. server.ts hands every request it does not know
// to debugRoutes before its 404.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { planOpen, targetsOf } from '../src/shared/devtargets.ts'

export const COMMENT_STATUSES = ['열림', '보냄', '해결'] as const

export type CommentRow = {
  id: number
  url: string // the page, without its #fragment
  place: string // where it is on the page: 본문 › 현황판 쪽 › "미시작" 꼬리표
  css: string
  element: string // tag and text: button "저장"
  text: string // what the person wants changed
  shot: string | null // png path of the element
  session_id: string // the session it went (or will go) to
  status: (typeof COMMENT_STATUSES)[number]
  created_at: number
  updated_at: number
  sent_at: number | null
  resolved_at: number | null
}

const SCHEMA = `
create table if not exists comments (
  id integer primary key, url text not null, place text not null default '',
  css text not null default '', element text not null default '', text text not null,
  shot text, session_id text not null default '', status text not null default '열림',
  created_at integer not null, updated_at integer not null, sent_at integer, resolved_at integer
);
create index if not exists comments_url on comments (url, id);
`

export type DebugContext = {
  db: DatabaseSync
  watchers: Set<ServerResponse> // the IDE's /stream
  deliveryWatchers: Map<string, Set<ServerResponse>> // each mod's /deliveries, by session
}

// The last open request, for an IDE that (re)connects after the session asked.
type OpenEvent = {
  id: string
  at: number
  url: string
  sessionId: string
  target: ReturnType<typeof planOpen>['target']
  restart: boolean // a new target, or its folder or command changed
}

const ready = new WeakSet<DatabaseSync>()
const lastOpen = new WeakMap<DatabaseSync, OpenEvent>()
const BOOT = Date.now().toString(36)
let seq = 0

type Json = Record<string, unknown>

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed as Json
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export function pageKey(url: string): string {
  const hash = url.indexOf('#')
  return hash === -1 ? url : url.slice(0, hash)
}

function emit(ctx: DebugContext, data: Json): void {
  for (const res of ctx.watchers) res.write(`event: change\ndata: ${JSON.stringify(data)}\n\n`)
}

// Handles the request when it is one of these routes; false sends it on to the 404.
export async function debugRoutes(ctx: DebugContext, req: IncomingMessage, res: ServerResponse, method: string, path: string, url: URL): Promise<boolean> {
  const { db } = ctx
  if (!ready.has(db)) {
    db.exec(SCHEMA)
    // Added after the first release: the page's console and failed requests with a comment.
    const columns = (db.prepare('pragma table_info(comments)').all() as { name: string }[]).map(c => c.name)
    if (!columns.includes('logs')) db.exec("alter table comments add column logs text not null default ''")
    ready.add(db)
  }
  const now = Date.now()
  const reply = (status: number, body: unknown) => {
    send(res, status, body)
    return true
  }
  const one = (id: number) => db.prepare('select * from comments where id = ?').get(id) as CommentRow | undefined

  // Comments of one page (url), or of every page, oldest first.
  if (method === 'GET' && path === '/comments') {
    const page = url.searchParams.get('url')
    const status = url.searchParams.get('status')
    const filters = [page ? ['url = ?', pageKey(page)] : null, status ? ['status = ?', status] : null].filter(f => f !== null)
    const where = filters.length ? `where ${filters.map(f => f[0]).join(' and ')}` : ''
    const rows = db.prepare(`select * from (select * from comments ${where} order by id desc limit 500) order by id`).all(...filters.map(f => f[1]!))
    return reply(200, { comments: rows })
  }

  if (method === 'POST' && path === '/comments') {
    const body = await readJson(req)
    const page = pageKey(str(body.url).trim())
    const text = str(body.text).trim()
    if (!page || !text) return reply(400, { error: 'url and text are required' })
    const result = db
      .prepare(
        `insert into comments (url, place, css, element, text, shot, session_id, created_at, updated_at, logs)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(page, str(body.place), str(body.css), str(body.element), text, str(body.shot) || null, str(body.sessionId), now, now, str(body.logs).slice(0, 8000))
    emit(ctx, { type: 'comments' })
    return reply(200, one(Number(result.lastInsertRowid)))
  }

  // Several at once: sending marks the batch 보냄 with the session it went to.
  if (method === 'POST' && path === '/comments/status') {
    const body = await readJson(req)
    const status = str(body.status)
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : []
    if (!(COMMENT_STATUSES as readonly string[]).includes(status) || ids.length === 0) {
      return reply(400, { error: `ids and status (${COMMENT_STATUSES.join(', ')}) are required` })
    }
    let count = 0
    const update = db.prepare(
      `update comments set status = ?, updated_at = ?,
         session_id = coalesce(nullif(?, ''), session_id),
         sent_at = case when ? = '보냄' then ? when ? = '열림' then null else sent_at end,
         resolved_at = case when ? = '해결' then ? else null end
       where id = ?`,
    )
    for (const id of ids) count += Number(update.run(status, now, str(body.sessionId), status, now, status, status, now, id).changes)
    emit(ctx, { type: 'comments' })
    return reply(200, { count, status })
  }

  const edit = path.match(/^\/comments\/(\d+)(\/delete)?$/)
  if (method === 'POST' && edit) {
    const id = Number(edit[1])
    const before = one(id)
    if (!before) return reply(404, { error: `comment ${id} not found` })
    if (edit[2]) {
      db.prepare('delete from comments where id = ?').run(id)
      emit(ctx, { type: 'comments' })
      return reply(200, { id, deleted: true })
    }
    const body = await readJson(req)
    const text = typeof body.text === 'string' ? body.text.trim() : before.text
    if (!text) return reply(400, { error: 'text must not be empty' })
    db.prepare('update comments set text = ?, updated_at = ? where id = ?').run(text, now, id)
    emit(ctx, { type: 'comments' })
    return reply(200, one(id))
  }

  // open_in_ide: register or update the dev target the page belongs to, then
  // tell the IDE to show it. The IDE starts the server when the target changed.
  if (method === 'POST' && path === '/dev/open') {
    const body = await readJson(req)
    const row = db.prepare("select value from settings where key = 'devTargets'").get() as { value: string } | undefined
    const list = targetsOf(row ? JSON.parse(row.value) : [])
    const plan = planOpen(list, { url: str(body.url), name: str(body.name), repo: str(body.repo), command: str(body.command) }, `t${now.toString(36)}`)
    if (plan.errors.length) return reply(400, { error: plan.errors.join(' ') })
    if (plan.list !== list) {
      db.prepare("insert into settings (key, value) values ('devTargets', ?) on conflict (key) do update set value = excluded.value").run(JSON.stringify(plan.list))
      emit(ctx, { type: 'settings' })
    }
    const event: OpenEvent = {
      id: `${BOOT}-${++seq}`,
      at: now,
      url: plan.url,
      sessionId: str(body.sessionId),
      target: plan.target,
      restart: plan.changed,
    }
    // Kept so an app still starting up picks it up; the app remembers the ids it handled.
    lastOpen.set(db, event)
    emit(ctx, { type: 'devOpen', open: event })
    return reply(200, { ...event, created: plan.created, ideWatching: ctx.watchers.size > 0 })
  }

  if (method === 'GET' && path === '/dev/open') {
    return reply(200, { open: lastOpen.get(db) ?? null })
  }

  // Sessions whose mod holds its delivery stream open right now.
  if (method === 'GET' && path === '/sessions/live') {
    const ids = [...ctx.deliveryWatchers].filter(([, set]) => set.size > 0).map(([id]) => id)
    return reply(200, { ids })
  }

  return false
}

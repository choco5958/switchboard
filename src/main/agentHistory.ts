// Past conversations of the CLIs other than Claude Code that resume one by id (agents.ts
// resumeArgs), for the past sessions page (sessionHistory.ts). Each keeps its own files, read
// here as they were on this computer (Codex 0.166, Copilot CLI 1.0.105, Qwen Code 0.26, Gemini CLI
// 0.67). Read only, like Claude Code's.
import { readdir, readFile, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { PastSession } from '../shared/types'
import { resumableId } from '../shared/agents'
import { countAll, oneLine, recordsOf, type Ends, type Found, type Source } from './sessionHistory'

const TITLE_CHARS = 120
const SNIPPET_CHARS = 200
type Json = Record<string, unknown>
const object = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
// Text blocks of a message: [{text}] or [{type: 'input_text' | 'output_text', text}].
const blocks = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map(object)
          .filter(block => typeof block.text === 'string' && (block.type === undefined || /text$/.test(text(block.type))))
          .map(block => text(block.text))
          .join(' ')
      : ''
// What a CLI adds to the person's turn itself: a tag it wraps (<environment_context>,
// <session_context>), or the project's instructions.
const added = (said: string) => /^<[a-z_-]+>/i.test(said) || said.startsWith('# AGENTS.md')

// One conversation from its prompts and replies in order, as Claude Code's reads (sessionHistory.ts).
function session(input: Found & Ends, agent: string, id: string, cwd: string, turns: { prompt: string; reply: string }[], branch = ''): PastSession | null {
  const said = turns.filter(t => t.prompt || t.reply)
  if (!resumableId(id) || said.length === 0) return null
  const first = said.find(t => t.prompt)?.prompt ?? ''
  const last = [...said].reverse().find(t => t.prompt || t.reply)
  return {
    id,
    agent,
    cwd,
    project: cwd ? basename(cwd) : input.folder,
    folder: input.folder,
    branch,
    title: oneLine(input.side?.title || first, TITLE_CHARS),
    snippet: oneLine(last?.reply || last?.prompt || '', SNIPPET_CHARS),
    messages: countAll(said.length, input),
    approximate: !input.whole,
    updatedAt: input.mtime,
  }
}

const records = (input: Ends): Json[] => [...recordsOf<Json>(input.head, false, !input.whole), ...(input.whole ? [] : recordsOf<Json>(input.tail, true, false))]

// Codex: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, or .jsonl.zst once Codex packed it. Its
// first record (session_meta) has the id and folder; the person's words are user messages but for
// what Codex adds; a turn's answer is an assistant message. A conversation the person ran in the
// terminal or an editor (source cli or vscode) resumes; `codex exec` and subagent runs do not.
export function parseCodex(input: Found & Ends): PastSession | null {
  let id = ''
  let cwd = ''
  let resumes = false
  const turns: { prompt: string; reply: string }[] = []
  for (const record of records(input)) {
    const payload = object(record.payload)
    if (record.type === 'session_meta') {
      id = text(payload.id)
      cwd = text(payload.cwd)
      resumes = payload.source === 'cli' || payload.source === 'vscode'
    }
    if (record.type !== 'response_item' || payload.type !== 'message') continue
    const said = blocks(payload.content).trim()
    if (payload.role === 'user' && said && !added(said)) turns.push({ prompt: said, reply: '' })
    if (payload.role === 'assistant' && said) turns.push({ prompt: '', reply: said })
  }
  return resumes ? session(input, 'codex', id, cwd, turns) : null
}

// Copilot CLI: session-state/<id>/events.jsonl; session.start has the folder and branch.
export function parseCopilot(input: Found & Ends): PastSession | null {
  let cwd = ''
  let branch = ''
  const turns: { prompt: string; reply: string }[] = []
  for (const record of records(input)) {
    const data = object(record.data)
    if (record.type === 'session.start') {
      cwd = text(object(data.context).cwd)
      branch = text(object(data.context).branch)
    }
    if (record.type === 'user.message' && text(data.content).trim()) turns.push({ prompt: text(data.content).trim(), reply: '' })
    if (record.type === 'assistant.message' && text(data.content).trim()) turns.push({ prompt: '', reply: text(data.content).trim() })
  }
  return session(input, 'copilot', input.id, cwd || input.side?.cwd || '', turns, branch)
}

// Qwen Code: projects/<folder>/chats/<id>.jsonl, the records as Claude Code's with Gemini's parts.
export function parseQwen(input: Found & Ends): PastSession | null {
  let cwd = ''
  const turns: { prompt: string; reply: string }[] = []
  for (const record of records(input)) {
    if (!cwd && typeof record.cwd === 'string') cwd = record.cwd
    const said = blocks(object(record.message).parts).trim()
    if (record.type === 'user' && said && !added(said)) turns.push({ prompt: said, reply: '' })
    if (record.type === 'assistant' && said) turns.push({ prompt: '', reply: said })
  }
  return session(input, 'qwen', input.id, cwd, turns)
}

// Gemini CLI: tmp/<project>/chats/session-<time>-<short id>.jsonl, whose first record has the whole
// id; the project's folder is in tmp/<project>/.project_root.
export function parseGemini(input: Found & Ends): PastSession | null {
  let id = ''
  const turns: { prompt: string; reply: string }[] = []
  for (const record of records(input)) {
    if (!id && typeof record.sessionId === 'string') id = record.sessionId
    const said = blocks(record.content).trim()
    if (record.type === 'user' && said && !added(said)) turns.push({ prompt: said, reply: '' })
    if (record.type === 'gemini' && said) turns.push({ prompt: '', reply: said })
  }
  return session(input, 'gemini', id, input.side?.cwd ?? '', turns)
}

// The files under a folder whose names pass `want`, `depth` folders down.
async function walk(root: string, depth: number, want: (name: string) => boolean): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  if (depth === 0) return names.filter(want).map(name => join(root, name))
  return (await Promise.all(names.map(name => walk(join(root, name), depth - 1, want)))).flat()
}

async function found(path: string, id: string, folder: string, side?: Found['side']): Promise<Found | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? { path, id, folder, size: info.size, mtime: info.mtimeMs, ...(side ? { side } : {}) } : null
  } catch {
    return null
  }
}
const present = (list: (Found | null)[]): Found[] => list.filter((f): f is Found => f !== null)

// Codex's own names for its conversations (session_index.jsonl: id, thread_name), the last one kept.
export function codexNames(index: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const record of recordsOf<Json>(index, false, false)) if (typeof record.id === 'string' && text(record.thread_name).trim()) names.set(record.id, text(record.thread_name).trim())
  return names
}

const read = (path: string): Promise<string> => readFile(path, 'utf8').catch(() => '')

// A CLI's own database, read only and closed again; [] when it cannot be read (none, locked, changed).
function query<T>(path: string, sql: string, ...args: (string | number)[]): T[] {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 1000 })
    return db.prepare(sql).all(...args) as T[]
  } catch {
    return []
  } finally {
    db?.close()
  }
}

const conversation = (agent: string, row: { id: string; cwd: string; title: string; snippet: string; messages: number; updatedAt: number; branch?: string }, folder: string): PastSession => ({
  id: row.id,
  agent,
  cwd: row.cwd,
  project: row.cwd ? basename(row.cwd) : folder,
  folder,
  branch: row.branch ?? '',
  title: oneLine(row.title, TITLE_CHARS),
  snippet: oneLine(row.snippet, SNIPPET_CHARS),
  messages: row.messages,
  approximate: false,
  updatedAt: row.updatedAt,
})
// One ready conversation as a listing entry: its database and id name it, its time dates it.
const listed = (path: string, session: PastSession): Found => ({ path: `${path}#${session.id}`, id: session.id, folder: session.folder, size: session.messages, mtime: session.updatedAt, ready: session })

// OpenCode 2: opencode.db. A conversation is a session_v2 row with no parent (a subagent's has one);
// its messages are session_message rows, the words in their JSON data.
export function opencodeSessions(path: string): Found[] {
  type Row = { id: string; directory: string | null; title: string | null; time_updated: number }
  const rows = query<Row>(path, 'select id, directory, title, time_updated from session_v2 where parent_id is null and time_archived is null order by time_updated desc limit 200')
  return rows.flatMap(row => {
    if (!resumableId(row.id)) return []
    const said = query<{ type: string; data: string }>(path, "select type, data from session_message where session_id = ? and type in ('user', 'assistant') order by seq", row.id)
    const words = said.map(m => {
      const data = (() => {
        try {
          return object(JSON.parse(m.data))
        } catch {
          return {}
        }
      })()
      return m.type === 'user' ? { prompt: text(data.text).trim(), reply: '' } : { prompt: '', reply: blocks(data.content).trim() || text(data.text).trim() }
    }).filter(w => w.prompt || w.reply)
    if (words.length === 0) return []
    const last = words[words.length - 1]!
    const session = conversation('opencode', { id: row.id, cwd: row.directory ?? '', title: row.title || words.find(w => w.prompt)?.prompt || '', snippet: last.reply || last.prompt, messages: words.length, updatedAt: row.time_updated }, 'opencode')
    return [listed(path, session)]
  })
}

// Cursor CLI: chats/<workspace>/<chat id>/ with meta.json (folder, time, whether anything was said)
// and store.db, whose meta row "0" is hex JSON with the chat's name. The messages are stored
// encrypted, so a chat shows by its name alone.
export async function cursorSessions(root: string): Promise<Found[]> {
  const chats = (await Promise.all((await readdir(root).catch(() => [] as string[])).map(async ws => (await readdir(join(root, ws)).catch(() => [] as string[])).map(id => join(root, ws, id))))).flat()
  const found = await Promise.all(chats.map(async dir => {
    const id = basename(dir)
    if (!resumableId(id)) return null
    const info = await readFile(join(dir, 'meta.json'), 'utf8').then(raw => object(JSON.parse(raw))).catch(() => ({}) as Json)
    if (info.hasConversation !== true) return null
    const named = query<{ value: string }>(join(dir, 'store.db'), "select value from meta where key = '0'")[0]?.value ?? ''
    const name = (() => {
      try {
        return text(object(JSON.parse(Buffer.from(named, 'hex').toString('utf8'))).name)
      } catch {
        return ''
      }
    })()
    const updatedAt = typeof info.updatedAtMs === 'number' ? info.updatedAtMs : 0
    return listed(join(dir, 'store.db'), conversation('cursor', { id, cwd: text(info.cwd), title: name, snippet: '', messages: 0, updatedAt }, 'cursor'))
  }))
  return found.filter((f): f is Found => f !== null)
}

// Crush run in the app: the data folders the app keeps for each project (agentTerms.ts), each with
// its crush.db and the project's folder in a file named cwd. Times are in seconds.
export async function crushSessions(root: string): Promise<Found[]> {
  const folders = await readdir(root).catch(() => [] as string[])
  return (await Promise.all(folders.map(async name => {
    const dir = join(root, name)
    const cwd = (await read(join(dir, 'cwd'))).trim()
    if (!cwd) return []
    type Row = { id: string; title: string | null; message_count: number; updated_at: number }
    const rows = query<Row>(join(dir, 'crush.db'), 'select id, title, message_count, updated_at from sessions where parent_session_id is null order by updated_at desc limit 100')
    return rows.flatMap(row => {
      if (!resumableId(row.id) || !row.message_count) return []
      const parts = query<{ parts: string }>(join(dir, 'crush.db'), "select parts from messages where session_id = ? and role in ('assistant', 'user') order by created_at desc limit 1", row.id)[0]?.parts ?? '[]'
      const snippet = (() => {
        try {
          return (JSON.parse(parts) as unknown[]).map(object).filter(p => p.type === 'text').map(p => text(object(p.data).text)).join(' ')
        } catch {
          return ''
        }
      })()
      return [listed(join(dir, 'crush.db'), conversation('crush', { id: row.id, cwd, title: row.title ?? '', snippet, messages: row.message_count, updatedAt: row.updated_at * 1000 }, 'crush'))]
    })
  }))).flat()
}

// The CLIs' folders, as each finds its own: a variable it reads first, else its folder in the home.
// `appAgents`: the app's own folder for agent runs (~/.claude-ide/agents), where Crush's data is.
export function agentSources(env: NodeJS.ProcessEnv, home = env.HOME || homedir(), appAgents = join(home, '.claude-ide', 'agents')): Source[] {
  const codexHome = env.CODEX_HOME || join(home, '.codex')
  const copilotHome = env.COPILOT_HOME || join(home, '.copilot')
  const qwenHome = join(home, '.qwen')
  const geminiHome = join(env.GEMINI_CLI_HOME || home, '.gemini')
  const opencodeDb = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode', 'opencode.db')
  // Ready entries need no parse: each comes read from its database.
  const ready: Source['parse'] = input => input.ready ?? null
  return [
    { files: async () => opencodeSessions(opencodeDb), parse: ready },
    { files: () => cursorSessions(join(home, '.cursor', 'chats')), parse: ready },
    { files: () => crushSessions(join(appAgents, 'crush')), parse: ready },
    {
      files: async () => {
        const names = codexNames(await read(join(codexHome, 'session_index.jsonl')))
        const all = await walk(join(codexHome, 'sessions'), 3, name => /^rollout-.*\.jsonl(?:\.zst)?$/.test(name))
        // Codex packs a conversation left alone for a week into <name>.jsonl.zst (its feature
        // local_thread_store_compression, read in Codex 0.167) and unpacks it beside to go on
        // with it: where both are there, the plain one is the conversation.
        const plain = new Set(all)
        const paths = all.filter(path => !(path.endsWith('.zst') && plain.has(path.slice(0, -'.zst'.length))))
        // The id ends the file's name; session_meta says it again.
        return present(await Promise.all(paths.map(async path => {
          const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/.exec(path)?.[1] ?? ''
          const file = await found(path, id, 'codex', names.has(id) ? { title: names.get(id) } : undefined)
          return file && path.endsWith('.zst') ? { ...file, packed: true } : file
        })))
      },
      parse: parseCodex,
    },
    {
      files: async () => {
        const root = join(copilotHome, 'session-state')
        const ids = await readdir(root).catch(() => [] as string[])
        return present(await Promise.all(ids.filter(id => resumableId(id)).map(async id => {
          // workspace.yaml: the name Copilot gave the conversation or the person did.
          const name = /^name:\s*(.+)$/m.exec(await read(join(root, id, 'workspace.yaml')))?.[1]?.replace(/^["']|["']$/g, '').trim()
          return found(join(root, id, 'events.jsonl'), id, 'copilot', name ? { title: name } : undefined)
        })))
      },
      parse: parseCopilot,
    },
    {
      files: async () => {
        const paths = await walk(join(qwenHome, 'projects'), 2, name => name.endsWith('.jsonl'))
        return present(await Promise.all(paths.filter(path => basename(join(path, '..')) === 'chats').map(path => found(path, basename(path, '.jsonl'), basename(join(path, '..', '..'))))))
      },
      parse: parseQwen,
    },
    {
      files: async () => {
        const root = join(geminiHome, 'tmp')
        const projects = await readdir(root).catch(() => [] as string[])
        return (await Promise.all(projects.map(async project => {
          const cwd = (await read(join(root, project, '.project_root'))).trim()
          const paths = await walk(join(root, project, 'chats'), 0, name => /^session-.*\.jsonl$/.test(name))
          return present(await Promise.all(paths.map(path => found(path, '', project, cwd ? { cwd } : undefined))))
        }))).flat()
      },
      parse: parseGemini,
    },
  ]
}

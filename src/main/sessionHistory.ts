import type { Ipc } from './platform'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { PastSession, PastSessions } from '../shared/types'
import { resumableId } from '../shared/agents'
import { agentSources } from './agentHistory'

// Past conversations on this computer, for the past sessions page: Claude Code's, read from the
// transcripts it keeps at <config>/projects/<folder>/<session id>.jsonl, and the other CLIs' that
// can be resumed by id (agentHistory.ts). Read only: nothing here writes a file or sends anything
// anywhere. A transcript can run to hundreds of megabytes, so only its head (the first prompt) and
// its tail (the latest words) are read.

const HEAD_BYTES = 128 * 1024
const TAIL_BYTES = 64 * 1024
const MAX_FILES = 500
const MAX_RESULTS = 200
const TITLE_CHARS = 120
const SNIPPET_CHARS = 200
const READ_AT_ONCE = 16

export function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

type Block = { type?: unknown; text?: unknown }
type Line = {
  type?: unknown
  cwd?: unknown
  gitBranch?: unknown
  isMeta?: unknown
  isSidechain?: unknown
  isCompactSummary?: unknown
  message?: { content?: unknown }
  aiTitle?: unknown
  summary?: unknown
  lastPrompt?: unknown
}

// Claude Code wraps what it adds to the conversation itself in hyphenated tags: slash commands
// (<command-name>), their output (<local-command-stdout>), background task news
// (<task-notification>), shell lines (<bash-input>), reminders (<system-reminder>).
const WRAPPED = /^<[a-z][a-z0-9]*(?:-[a-z0-9]+)+[\s>]/
const INTERRUPTED = /^\[Request interrupted by user/

export const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: Block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: Block) => block.text as string)
    .join(' ')
}

// The words a person typed, or '' for a tool result, a meta or command record, a reminder.
function promptOf(record: Line): string {
  if (record.type !== 'user' || record.isMeta || record.isSidechain || record.isCompactSummary) return ''
  const text = textOf(record.message?.content).trim()
  return text && !WRAPPED.test(text) && !INTERRUPTED.test(text) ? text : ''
}

function replyOf(record: Line): string {
  if (record.type !== 'assistant' || record.isSidechain) return ''
  return textOf(record.message?.content).trim()
}

// Whole lines only: a chunk that starts or ends inside a line drops that part line.
export function recordsOf<T = Line>(text: string, cutStart: boolean, cutEnd: boolean): T[] {
  const lines = text.split('\n')
  if (cutStart) lines.shift()
  if (cutEnd) lines.pop()
  const records: T[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as unknown
      if (record && typeof record === 'object' && !Array.isArray(record)) records.push(record as T)
    } catch {
      // A broken or half-written line: skip it.
    }
  }
  return records
}

// What one transcript says, from its head and tail. whole: the two chunks are the full file.
// folder: the project folder name Claude Code made from the working directory.
export function parseTranscript(input: { id: string; folder: string; head: string; tail: string; whole: boolean; size: number; mtime: number }): PastSession | null {
  const head = recordsOf(input.head, false, !input.whole)
  const tail = input.whole ? [] : recordsOf(input.tail, true, false)
  const all = [...head, ...tail]
  let cwd = ''
  let branch = ''
  let title = ''
  let named = ''
  let lastPrompt = ''
  let messages = 0
  for (const record of all) {
    if (!cwd && typeof record.cwd === 'string') cwd = record.cwd
    if (typeof record.gitBranch === 'string' && record.gitBranch && record.gitBranch !== 'HEAD') branch = record.gitBranch
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') named = record.aiTitle
    if (record.type === 'summary' && typeof record.summary === 'string' && !named) named = record.summary
    if (record.type === 'last-prompt' && typeof record.lastPrompt === 'string') lastPrompt = record.lastPrompt
    const prompt = promptOf(record)
    if (prompt && !title) title = prompt
    if (prompt || replyOf(record)) messages++
  }
  if (messages === 0 && !named) return null
  let snippet = ''
  for (let i = all.length - 1; i >= 0 && !snippet; i--) snippet = promptOf(all[i]!) || replyOf(all[i]!)
  // Only part of a long file was read: the count grows by the share of bytes read.
  messages = countAll(messages, input)
  return {
    id: input.id,
    agent: 'claude',
    cwd,
    project: cwd ? basename(cwd) : input.folder,
    folder: input.folder,
    branch,
    title: oneLine(title || named || lastPrompt, TITLE_CHARS),
    snippet: oneLine(snippet, SNIPPET_CHARS),
    messages,
    approximate: !input.whole,
    updatedAt: input.mtime,
  }
}

// `side`: what the listing learned besides the file (a name a CLI keeps apart, its project folder).
export type Found = { path: string; id: string; folder: string; size: number; mtime: number; side?: { title?: string; cwd?: string } }
export type Ends = { head: string; tail: string; whole: boolean }
// Where one CLI keeps its conversations, and how one reads.
export type Source = { files: () => Promise<Found[]>; parse: (input: Found & Ends) => PastSession | null }
// The share of a long file's records that were read, to count all of them.
export function countAll(count: number, input: { head: string; tail: string; whole: boolean; size: number }): number {
  const read = Buffer.byteLength(input.head) + Buffer.byteLength(input.tail)
  return !input.whole && read > 0 && read < input.size ? Math.round((count * input.size) / read) : count
}

async function transcripts(root: string): Promise<Found[]> {
  const found: Found[] = []
  let folders: string[]
  try {
    folders = await readdir(root)
  } catch {
    return found
  }
  await Promise.all(
    folders.map(async folder => {
      let names: string[]
      try {
        names = await readdir(join(root, folder))
      } catch {
        return
      }
      await Promise.all(
        names.map(async name => {
          if (!name.endsWith('.jsonl')) return
          const id = name.slice(0, -'.jsonl'.length)
          // agent-*.jsonl: a subagent's side conversation, which cannot be resumed on its own.
          if (!resumableId(id) || id.startsWith('agent-')) return
          try {
            const info = await stat(join(root, folder, name))
            if (info.isFile()) found.push({ path: join(root, folder, name), id, folder, size: info.size, mtime: info.mtimeMs })
          } catch {
            // Gone between the listing and the look.
          }
        }),
      )
    }),
  )
  return found
}

async function readEnds(path: string, size: number): Promise<Ends> {
  const file = await open(path, 'r')
  try {
    const whole = size <= HEAD_BYTES + TAIL_BYTES
    const headBuf = Buffer.alloc(whole ? size : HEAD_BYTES)
    const { bytesRead: headRead } = await file.read(headBuf, 0, headBuf.length, 0)
    if (whole) return { head: headBuf.toString('utf8', 0, headRead), tail: '', whole: headRead >= size }
    const tailBuf = Buffer.alloc(TAIL_BYTES)
    const { bytesRead: tailRead } = await file.read(tailBuf, 0, TAIL_BYTES, size - TAIL_BYTES)
    return { head: headBuf.toString('utf8', 0, headRead), tail: tailBuf.toString('utf8', 0, tailRead), whole: false }
  } finally {
    await file.close()
  }
}

// A transcript read once is kept until its file changes (another size or time).
const cache = new Map<string, { size: number; mtime: number; title?: string; session: PastSession | null }>()

export const claudeSource = (configDir: string): Source => ({
  files: () => transcripts(join(configDir, 'projects')),
  parse: input => parseTranscript(input),
})

// Claude Code's newest transcripts, newest first. total: how many transcripts there are in all.
export function loadSessions(configDir = claudeConfigDir()): Promise<{ total: number; sessions: PastSession[] }> {
  return loadFrom([claudeSource(configDir)])
}

// The newest conversations of all the sources, newest first.
export async function loadFrom(sources: readonly Source[]): Promise<{ total: number; sessions: PastSession[] }> {
  const listed = await Promise.all(sources.map(async source => (await source.files().catch(() => [])).map(file => ({ file, source }))))
  const found = listed.flat().sort((a, b) => b.file.mtime - a.file.mtime)
  const newest = found.slice(0, MAX_FILES)
  const sessions: (PastSession | null)[] = new Array(newest.length).fill(null)
  for (let start = 0; start < newest.length; start += READ_AT_ONCE) {
    await Promise.all(
      newest.slice(start, start + READ_AT_ONCE).map(async ({ file, source }, offset) => {
        const kept = cache.get(file.path)
        // A name a CLI keeps apart (Codex's index) may change while the file does not.
        if (kept && kept.size === file.size && kept.mtime === file.mtime && kept.title === file.side?.title) {
          sessions[start + offset] = kept.session
          return
        }
        let session: PastSession | null = null
        try {
          session = source.parse({ ...file, ...(await readEnds(file.path, file.size)) })
        } catch {
          // Unreadable: left out.
        }
        cache.set(file.path, { size: file.size, mtime: file.mtime, title: file.side?.title, session })
        sessions[start + offset] = session
      }),
    )
  }
  const live = new Set(newest.map(({ file }) => file.path))
  for (const path of cache.keys()) if (!live.has(path)) cache.delete(path)
  return { total: found.length, sessions: sessions.filter((s): s is PastSession => s !== null) }
}

// Every word of the query, ignoring case, somewhere in the title, the snippet, the folder, the
// project folder name or the branch. Newest first, at most limit.
export function searchSessions(sessions: readonly PastSession[], query: string, limit = MAX_RESULTS): PastSession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hits = sessions.filter(s => {
    if (words.length === 0) return true
    const text = [s.title, s.snippet, s.cwd, s.project, s.folder, s.branch].join('\n').toLowerCase()
    return words.every(word => text.includes(word))
  })
  return [...hits].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}

// Typing a query asks again at each pause: a listing from the last few seconds answers it.
const FRESH_MS = 3_000
let recent: { dir: string; at: number; load: ReturnType<typeof loadSessions> } | null = null

// `others`: the other CLIs' sources (agentHistory.ts agentSources), none by default.
export async function sessionHistory(query: string, configDir = claudeConfigDir(), now = Date.now(), others: readonly Source[] = []): Promise<PastSessions> {
  if (!recent || recent.dir !== configDir || now - recent.at > FRESH_MS) recent = { dir: configDir, at: now, load: loadFrom([claudeSource(configDir), ...others]) }
  const { total, sessions } = await recent.load
  return { total, sessions: searchSessions(sessions, typeof query === 'string' ? query.slice(0, 500) : '') }
}

// configDir: the folder the app's Claude terminals use (terminals.ts), read at each call so
// `claude --resume` finds the same transcripts the list showed.
export function registerSessionHistory(ipc: Ipc, configDir: () => string | undefined): void {
  ipc.handle('sessions:history', (_e, query: string) => sessionHistory(query, configDir() || claudeConfigDir(), Date.now(), agentSources(process.env)))
}

// Past conversations of the CLIs other than Claude Code that resume one by id (agents.ts
// resumeArgs), for the past sessions page (sessionHistory.ts). Each keeps its own files, read
// here as they were on this computer (Codex 0.166, Copilot CLI 1.0.105, Qwen Code 0.26, Gemini CLI
// 0.67). Read only, like Claude Code's.
import { readdir, readFile, stat } from 'node:fs/promises'
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

// Codex: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl. Its first record (session_meta) has the id
// and folder; the person's words are user messages but for what Codex adds; a turn's answer is an
// assistant message. A conversation the person ran in the terminal or an editor (source cli or
// vscode) resumes; `codex exec` and subagent runs do not.
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

// The CLIs' folders, as each finds its own: a variable it reads first, else its folder in the home.
export function agentSources(env: NodeJS.ProcessEnv, home = env.HOME || homedir()): Source[] {
  const codexHome = env.CODEX_HOME || join(home, '.codex')
  const copilotHome = env.COPILOT_HOME || join(home, '.copilot')
  const qwenHome = join(home, '.qwen')
  const geminiHome = join(env.GEMINI_CLI_HOME || home, '.gemini')
  return [
    {
      files: async () => {
        const names = codexNames(await read(join(codexHome, 'session_index.jsonl')))
        const paths = await walk(join(codexHome, 'sessions'), 3, name => /^rollout-.*\.jsonl$/.test(name))
        // The id ends the file's name; session_meta says it again.
        return present(await Promise.all(paths.map(path => {
          const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path)?.[1] ?? ''
          return found(path, id, 'codex', names.has(id) ? { title: names.get(id) } : undefined)
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

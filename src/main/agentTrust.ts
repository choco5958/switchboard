// A CLI opened in a folder for the first time asks whether to trust it. The app types answers
// and scheduled prompts into Codex, Copilot and Cursor terminals, and a trust menu on screen
// would hold them back until someone answers it, so the app records the trust before it opens
// one, for the folders the person opened it in. The same as answering yes in the CLI's own
// menu; the CLI's approval and sandbox settings stay as they are. Only when the person turned
// it on (agents.ts trustFolders), and never for a folder that brings agent config of its own
// (agentConfigIn): trusting it is what lets that config run, and that stays the person's call.
// Claude Code is left alone: answers reach it through the mod, not its input, and it rewrites
// its own .claude.json all the time, so a write from here could lose one of its changes.
// The approach follows Orca's agent-trust-presets.ts (MIT, github.com/stablyai/orca).

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Each CLI compares the real path of the folder, so a symlink (macOS /tmp) is followed.
function realFolder(folder: string): string {
  try {
    return realpathSync.native(folder)
  } catch {
    return folder
  }
}

// Written beside and renamed over, so the CLI never reads a half-written file; the mode stays.
function replaceFile(file: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true })
  const keep = existsSync(file) ? statSync(file).mode & 0o777 : mode
  const temp = `${file}.switchboard-${process.pid}`
  writeFileSync(temp, content, { mode: keep })
  renameSync(temp, file)
}

// A basic string: a control character (a folder name may hold one) is written as \uXXXX.
const tomlString = (text: string) =>
  `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`

// A key path a TOML text names: a table header (`[a."b"]`), or a key of a key/value line under its
// table (`value`), whose value may be an inline table.
export type TomlKey = { path: string[]; value: boolean }

const BARE_KEY = /[A-Za-z0-9_-]+/y
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' }

// The keys a TOML text names, read as TOML reads them: a key in "double" or 'single' quotes or
// bare, spaces around dots and brackets, and values skipped whole (multiline strings and arrays
// across lines too), so a line inside a value is never taken for a header. Lenient: a line it
// cannot read is passed over.
export function tomlKeys(text: string): TomlKey[] {
  const out: TomlKey[] = []
  const n = text.length
  let i = text.startsWith('\uFEFF') ? 1 : 0
  let table: string[] = []
  const space = () => {
    while (text[i] === ' ' || text[i] === '\t') i++
  }
  const lineEnd = () => {
    while (i < n && text[i] !== '\n') i++
  }
  const part = (): string | null => {
    space()
    const quote = text[i]
    if (quote === "'") {
      const end = text.indexOf("'", i + 1)
      const body = end < 0 ? '' : text.slice(i + 1, end)
      if (end < 0 || body.includes('\n')) return null
      i = end + 1
      return body
    }
    if (quote === '"') {
      let body = ''
      for (i++; i < n && text[i] !== '"'; i++) {
        if (text[i] === '\n') return null
        if (text[i] !== '\\') {
          body += text[i]
          continue
        }
        const c = text[++i] ?? ''
        const hex = c === 'u' ? 4 : c === 'U' ? 8 : c === 'x' ? 2 : 0
        if (hex) {
          const code = parseInt(text.slice(i + 1, i + 1 + hex), 16)
          if (!Number.isInteger(code) || code > 0x10ffff) return null
          body += String.fromCodePoint(code)
          i += hex
        } else if (c in ESCAPES) body += ESCAPES[c]
        else return null
      }
      if (text[i] !== '"') return null
      i++
      return body
    }
    BARE_KEY.lastIndex = i
    const bare = BARE_KEY.exec(text)
    if (!bare) return null
    i += bare[0].length
    return bare[0]
  }
  const dotted = (): string[] | null => {
    const parts: string[] = []
    for (;;) {
      const p = part()
      if (p === null) return null
      parts.push(p)
      space()
      if (text[i] !== '.') return parts
      i++
    }
  }
  // A value, to the end of its line; brackets and braces may carry it over more lines.
  const skipValue = () => {
    let depth = 0
    while (i < n) {
      const c = text[i]!
      if (c === '"' || c === "'") {
        if (text.startsWith(c.repeat(3), i)) {
          // A multiline string ends at the first run of three or more quotes; up to two of the
          // run belong to the string (`'''a''''` ends with `a'`).
          for (i += 3; i < n; ) {
            if (c === '"' && text[i] === '\\') i += 2
            else if (text[i] === c) {
              let run = 0
              while (text[i] === c) run++, i++
              if (run >= 3) break
            } else i++
          }
        } else {
          for (i++; i < n && text[i] !== c && text[i] !== '\n'; i++) if (c === '"' && text[i] === '\\') i++
          if (text[i] === c) i++
        }
        continue
      }
      if (c === '#') lineEnd()
      else if (c === '\n' && depth <= 0) return
      else {
        if (c === '[' || c === '{') depth++
        else if (c === ']' || c === '}') depth--
        i++
      }
    }
  }
  while (i < n) {
    space()
    const c = text[i]
    if (c === '\n' || c === '\r') i++
    else if (c === '#') lineEnd()
    else if (c === '[') {
      const array = text[i + 1] === '['
      i += array ? 2 : 1
      const path = dotted()
      space()
      if (path && text[i] === ']' && (!array || text[i + 1] === ']')) {
        table = path
        out.push({ path, value: false })
      }
      lineEnd()
    } else {
      const key = dotted()
      space()
      if (key && text[i] === '=') {
        i++
        out.push({ path: [...table, ...key], value: true })
        skipValue()
      } else lineEnd()
    }
  }
  return out
}

const startsWith = (path: string[], head: string[]) => head.length <= path.length && head.every((p, at) => path[at] === p)

// Codex: [projects."<folder>"] trust_level = "trusted" in config.toml. A folder the file names
// already, trusted or not, is the person's choice and is left as it is, in whatever form it is
// written: Codex itself writes a Windows folder as [projects.'C:\…'], and a second table for the
// same folder would stop Codex with a duplicate key. So would a table under `projects = { … }`.
export function codexTrustText(existing: string, folder: string): string | null {
  const want = ['projects', folder]
  if (tomlKeys(existing).some(key => startsWith(key.path, want) || (key.value && startsWith(want, key.path)))) return null
  const header = `[projects.${tomlString(folder)}]`
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const gap = existing === '' || existing.endsWith(eol + eol) ? '' : existing.endsWith(eol) ? eol : eol + eol
  return `${existing}${gap}${header}${eol}trust_level = "trusted"${eol}`
}

// Copilot: trustedFolders in ~/.copilot/config.json. Copilot 1.0.105 starts the file with `//`
// comment lines, kept as they are. A file it cannot read otherwise stays untouched.
export function copilotTrustText(existing: string | null, folder: string): string | null {
  let config: Record<string, unknown> = {}
  const head = existing?.match(/^(?:[ \t]*\/\/[^\n]*\n)*/)?.[0] ?? ''
  const body = existing?.slice(head.length) ?? null
  if (body !== null && body.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(body)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      config = parsed as Record<string, unknown>
    } catch {
      return null
    }
  }
  const trusted = Array.isArray(config.trustedFolders) ? config.trustedFolders.filter((f): f is string => typeof f === 'string') : []
  if (trusted.includes(folder)) return null
  return `${head}${JSON.stringify({ ...config, trustedFolders: [...trusted, folder] }, null, 2)}\n`
}

// Cursor: a .workspace-trusted file in ~/.cursor/projects/<folder as a slug>/.
export function cursorTrustFile(home: string, folder: string): string | null {
  const slug = folder.replace(/^[\\/]+/, '').replace(/[\\/:*?"<>|]+/g, '-')
  return slug ? join(home, '.cursor', 'projects', slug, '.workspace-trusted') : null
}

// Config an agent CLI reads from the folder itself once it trusts it: MCP servers, hooks,
// instructions. The first one found, or null.
const AGENT_CONFIG = ['.codex', '.cursor', '.mcp.json', '.vscode/mcp.json']
export function agentConfigIn(folder: string): string | null {
  for (const name of AGENT_CONFIG) if (existsSync(join(folder, name))) return name
  try {
    const copilot = readdirSync(join(folder, '.github')).find(name => name.toLowerCase().startsWith('copilot'))
    if (copilot) return `.github/${copilot}`
  } catch {
    // No .github folder.
  }
  return null
}

// Records the trust for `agent` (an agents.ts id) in `folder`; quietly does nothing for the
// other CLIs, a folder with agent config of its own, or when the CLI's file cannot be read.
// Never throws: opening the terminal matters more.
export function trustFolder(agent: string, folder: string, home: string, env: Record<string, string | undefined> = process.env): void {
  try {
    const path = realFolder(folder)
    const config = agentConfigIn(path)
    if (config) {
      console.error(`not recording folder trust for ${agent} in ${path}: it has ${config}`)
      return
    }
    if (agent === 'codex') {
      const file = join(env.CODEX_HOME || join(home, '.codex'), 'config.toml')
      const next = codexTrustText(existsSync(file) ? readFileSync(file, 'utf8') : '', path)
      if (next !== null) replaceFile(file, next)
    } else if (agent === 'copilot') {
      const file = join(env.COPILOT_HOME || join(home, '.copilot'), 'config.json')
      const next = copilotTrustText(existsSync(file) ? readFileSync(file, 'utf8') : null, path)
      if (next !== null) replaceFile(file, next)
    } else if (agent === 'cursor') {
      const file = cursorTrustFile(home, path)
      if (file && !existsSync(file)) replaceFile(file, `${JSON.stringify({ trustedAt: new Date().toISOString(), workspacePath: path }, null, 2)}\n`)
    }
  } catch (error) {
    console.error(`could not record folder trust for ${agent}:`, error)
  }
}

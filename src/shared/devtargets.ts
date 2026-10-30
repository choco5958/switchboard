// Dev-server targets of the debugging page. Pure helpers shared by the main
// process (which runs them) and the renderer (which edits the list).
import { t } from './i18n/index.ts'

export type DevTarget = {
  id: string
  name: string
  description: string
  repo: string // absolute folder the command runs in
  command: string // run with a login shell
  url: string
  port: number | null // from the url when it names one
}

export type DevDraft = Omit<DevTarget, 'id' | 'port'>

// The port a target listens on: the url's own, else the scheme default.
export function portOf(url: string): number | null {
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`)
    if (parsed.port) return Number(parsed.port)
    if (parsed.protocol === 'http:') return 80
    if (parsed.protocol === 'https:') return 443
    return null
  } catch {
    return null
  }
}

export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

// The command runs in a shell (`sh -l -c`) and a session can name it (open_in_ide). A newline
// or another control character would hide more lines behind the one the confirmation shows,
// and a direction override or a zero width character (the format characters, Cf) would show
// the text in another order than it runs, so none may be in the command or its folder; tabs
// alone stay. The lengths are caps far past any real start command or path.
export const COMMAND_MAX = 2000
export const REPO_MAX = 1024
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u

// Why a folder or a command may not run, or null when it may.
export function runProblem(field: 'repo' | 'command', value: string): string | null {
  if (CONTROL.test(value)) return t('devForm.controlChars')
  const max = field === 'repo' ? REPO_MAX : COMMAND_MAX
  if (value.trim().length > max) return t('devForm.tooLong', { max })
  return null
}

// A command long enough, or with a run of blanks wide enough, that its end may sit out of
// sight in the confirmation: the dialog says to read it to the end.
export function longCommand(command: string): boolean {
  return command.length > 200 || /\s{8,}/.test(command)
}

// Problems with a draft by field, in the words the form shows under each one.
// Empty means it can be saved.
export function fieldErrors(draft: DevDraft, others: DevTarget[] = [], selfId = ''): Partial<Record<keyof DevDraft, string>> {
  const errors: Partial<Record<keyof DevDraft, string>> = {}
  if (!draft.name.trim()) errors.name = t('devForm.name')
  if (!draft.repo.trim()) errors.repo = t('devForm.repo')
  else if (runProblem('repo', draft.repo)) errors.repo = runProblem('repo', draft.repo)!
  else if (!draft.repo.trim().startsWith('/') && !draft.repo.trim().startsWith('~/')) errors.repo = t('devForm.repoAbsolute')
  if (!draft.command.trim()) errors.command = t('devForm.command')
  else if (runProblem('command', draft.command)) errors.command = runProblem('command', draft.command)!
  if (!draft.url.trim()) errors.url = t('devForm.url')
  else {
    let ok = true
    try {
      const parsed = new URL(normalizeUrl(draft.url))
      ok = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      ok = false
    }
    if (!ok) errors.url = t('devForm.urlInvalid')
  }
  const port = portOf(normalizeUrl(draft.url))
  const clash = others.find(t => t.id !== selfId && port !== null && t.port === port && hostOf(t.url) === hostOf(draft.url))
  if (clash && !errors.url) errors.url = t('devForm.portTaken', { port: port ?? '', name: clash.name })
  return errors
}

// The same problems as one list, in field order.
export function validateTarget(draft: DevDraft, others: DevTarget[] = [], selfId = ''): string[] {
  const errors = fieldErrors(draft, others, selfId)
  return (['name', 'description', 'repo', 'command', 'url'] as const).flatMap(key => (errors[key] ? [errors[key]] : []))
}

function hostOf(url: string): string {
  try {
    return new URL(normalizeUrl(url)).hostname
  } catch {
    return ''
  }
}

export function makeTarget(draft: DevDraft, id: string): DevTarget {
  const url = normalizeUrl(draft.url)
  return {
    id,
    name: draft.name.trim(),
    description: draft.description.trim(),
    repo: draft.repo.trim(),
    command: draft.command.trim(),
    url,
    port: portOf(url),
  }
}

// The stored list as it comes back from settings (any shape), kept to valid rows.
export function targetsOf(value: unknown): DevTarget[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (t): t is DevTarget =>
      typeof t === 'object' && t !== null && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.repo === 'string' && typeof t.command === 'string' && typeof t.url === 'string',
  )
}

// Keeps the last `max` lines of a stream that arrives in arbitrary chunks.
// `rest` is the unfinished last line, carried to the next chunk.
export function appendLines(lines: string[], rest: string, chunk: string, max = 200): { lines: string[]; rest: string } {
  const parts = (rest + chunk).split(/\r?\n/)
  const tail = parts.pop() ?? ''
  const next = lines.concat(parts)
  return { lines: next.length > max ? next.slice(next.length - max) : next, rest: tail }
}

// What open_in_ide asks for: a page to show, and optionally the dev server behind it.
export type OpenRequest = { url: string; name?: string; repo?: string; command?: string }

export type OpenPlan = {
  url: string
  list: DevTarget[] // the targets after the request
  target: DevTarget | null // the target the page belongs to, when there is one
  created: boolean
  changed: boolean // a new target, or its folder or command changed: the server needs a (re)start
  errors: string[]
}

// Finds the target an open request means (same host and port, else same name),
// updates it with what the request names, or adds one when it names a folder
// and a command. A bare url of no target only opens the page.
export function planOpen(list: DevTarget[], request: OpenRequest, newId: string): OpenPlan {
  const url = normalizeUrl(request.url ?? '')
  const name = (request.name ?? '').trim()
  const repo = (request.repo ?? '').trim()
  const command = (request.command ?? '').trim()
  const fail = (errors: string[]): OpenPlan => ({ url, list, target: null, created: false, changed: false, errors })
  let valid = false
  try {
    const parsed = new URL(url)
    valid = (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname
  } catch {
    valid = false
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(request.url?.trim() ?? '') && !/^https?:/i.test(request.url?.trim() ?? '')) valid = false
  if (!request.url?.trim() || !valid) return fail([t('devForm.openUrlInvalid')])
  const port = portOf(url)
  const existing =
    list.find(t => port !== null && t.port === port && hostOf(t.url) === hostOf(url)) ??
    (name ? list.find(t => t.name.trim().toLowerCase() === name.toLowerCase()) : undefined)
  if (existing) {
    const draft: DevDraft = {
      name: name || existing.name,
      description: existing.description,
      repo: repo || existing.repo,
      command: command || existing.command,
      // A page deeper on the same server keeps the target's own address.
      url: portOf(existing.url) === port && hostOf(existing.url) === hostOf(url) ? existing.url : url,
    }
    const errors = validateTarget(draft, list, existing.id)
    if (errors.length) return fail(errors)
    const target = makeTarget(draft, existing.id)
    const changed = target.repo !== existing.repo || target.command !== existing.command || target.port !== existing.port
    return { url, list: list.map(t => (t.id === existing.id ? target : t)), target, created: false, changed, errors: [] }
  }
  if (!repo || !command) return { url, list, target: null, created: false, changed: false, errors: [] }
  const draft: DevDraft = { name: name || hostOf(url) + (port !== null ? `:${port}` : ''), description: '', repo, command, url }
  const errors = validateTarget(draft, list)
  if (errors.length) return fail(errors)
  const target = makeTarget(draft, newId)
  return { url, list: [...list, target], target, created: true, changed: true, errors: [] }
}

// git's own failure text is English; the panel shows a short reason in the UI language and keeps the original as a tooltip.
export function gitErrorText(error: string): string {
  if (/not a git repository/i.test(error)) return t('git.notRepo')
  if (/no such file|cannot change to/i.test(error)) return t('git.noFolder')
  return error ? t('git.unreadable') : ''
}

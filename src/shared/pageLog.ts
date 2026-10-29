// What went wrong on a page in the in-app browser, kept beside a screen comment: console
// warnings and errors, and requests that failed (an HTTP status of 400 or more, or no
// answer). The session reads them with the comment, so it sees what the person saw.
// Values that look like credentials are masked as they come in, so no later reader can
// forget to.

export type PageLogEntry = { at: number; kind: 'console' | 'net'; level: 'error' | 'warning'; text: string }

export const PAGE_LOG_CAP = 30 // kept per page
export const PAGE_LOG_SENT = 10 // of each kind, with one comment
const TEXT_MAX = 300

// The webview's console-message level: a number in older Electron (2 warning, 3 error),
// a name in newer. Info and debug lines are left out.
export function consoleLevel(level: unknown): PageLogEntry['level'] | null {
  if (level === 3 || level === 'error') return 'error'
  if (level === 2 || level === 'warning') return 'warning'
  return null
}

// Every pattern is bounded or anchored on a fixed prefix, so the time stays linear in the text.
export function maskSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g, '-----BEGIN PRIVATE KEY----- *** -----END PRIVATE KEY-----')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    // name=value, name: value, "name": "value", at a line start too: API_KEY=, DB_PASSWORD=, X-Api-Key:
    .replace(/(^|[^A-Za-z0-9])([A-Za-z0-9_-]{0,40}?(?:token|key|secret|password|passwd|pwd|session|sig|signature|credential)s?)(["']?\s{0,4}[=:]\s{0,4}["']?)([^\s"'&;,}]{3,})/gim, '$1$2$3***')
    // user:password@ in an address
    .replace(/\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,100}:)[^\s/@]{1,200}@/gi, '$1***@')
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|ghu|ghr|xox[abprs]|glpat|github_pat)[-_][A-Za-z0-9_-]{12,}/g, '$1-***')
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '$1***')
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, 'AIza***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'eyJ***')
}

function clip(text: string): string {
  const one = maskSecrets(text.replace(/\s+/g, ' ').trim())
  return one.length > TEXT_MAX ? `${one.slice(0, TEXT_MAX - 1)}…` : one
}

export function consoleEntry(at: number, level: unknown, message: string, source = '', line = 0): PageLogEntry | null {
  const kind = consoleLevel(level)
  // Electron's own advice about the app, not the page's.
  if (!kind || !message.trim() || message.startsWith('Electron Security Warning')) return null
  const file = source.split('/').pop() ?? ''
  const where = file ? ` (${file}${line ? `:${line}` : ''})` : ''
  return { at, kind: 'console', level: kind, text: clip(`${message}${where}`) }
}

// A finished request from the webview's session; null when it went fine or was only cancelled.
export function netEntry(
  at: number,
  details: { method: string; url: string; statusCode?: number; error?: string },
): PageLogEntry | null {
  if (details.error) {
    if (details.error === 'net::ERR_ABORTED') return null
    return { at, kind: 'net', level: 'error', text: clip(`${details.method} ${details.url} ${details.error}`) }
  }
  if (details.statusCode === undefined || details.statusCode < 400) return null
  return { at, kind: 'net', level: details.statusCode >= 500 ? 'error' : 'warning', text: clip(`${details.method} ${details.url} ${details.statusCode}`) }
}

export function pushEntry(list: PageLogEntry[], entry: PageLogEntry | null, cap = PAGE_LOG_CAP): PageLogEntry[] {
  if (!entry) return list
  const next = [...list, entry]
  return next.length > cap ? next.slice(next.length - cap) : next
}

// The lines a comment carries: the newest of each kind, oldest first, with their time.
export function logText(list: PageLogEntry[], limit = PAGE_LOG_SENT): string {
  const newest = (kind: PageLogEntry['kind']) => list.filter(e => e.kind === kind).slice(-limit)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = (at: number) => {
    const d = new Date(at)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }
  return [...newest('console'), ...newest('net')]
    .sort((a, b) => a.at - b.at)
    .map(e => `${time(e.at)} ${e.kind === 'net' ? 'net' : 'console'} ${e.level}: ${e.text}`)
    .join('\n')
}

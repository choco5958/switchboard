import type { Agent, GraphNode, LogEvent, Question, Task } from '../../shared/types'
import { t } from '../../shared/i18n'

// A task belongs to one session: two sessions in one project may well use the same task title.
export function taskQuestions(questions: Question[], task: Task): Question[] {
  return questions.filter(q => q.session_id === task.session_id && q.task_title === task.title && q.status !== 'answered')
}

export function taskEvents(events: LogEvent[], task: Task, limit = 8): LogEvent[] {
  return events.filter(e => e.session_id === task.session_id && e.task_title === task.title).slice(-limit)
}

// Node keys repeat across tasks ("plan", "rv"), so the detail panel is keyed by the row id and
// the worktree: a check made for one node never carries over to another.
export function nodeDetailKey(node: GraphNode): string {
  return `${node.id}:${node.worktree ?? ''}`
}

const newestFirst = (nodes: GraphNode[]) => [...nodes].filter(n => n.note).sort((a, b) => b.updated_at - a.updated_at)

// "PR #364" in node notes, newest first, each PR once.
export function artifactFromNotes(nodes: GraphNode[]): string {
  const seen: string[] = []
  for (const node of newestFirst(nodes)) {
    for (const match of node.note.matchAll(/PR\s*#(\d+)/gi)) {
      const pr = `PR #${match[1]}`
      if (!seen.includes(pr)) seen.push(pr)
    }
  }
  return seen.join(', ')
}

// The newest note that reads like a test run, in the languages sessions write in:
// "통과 304, 실패 0", "304 passed, 0 failed", "pass 304 / fail 0", "成功 304、失敗 0", "通过 304，失败 0".
const TEST_RUNS = [
  /통과\s*\d+[\s,]*실패\s*\d+/,
  /\d+\s*(?:tests?\s*)?pass(?:ed|ing)?[\s,;/]*\d+\s*fail(?:ed|ing|ures?)?/i,
  /pass(?:ed)?:?\s*\d+[\s,;/]*fail(?:ed|ures?)?:?\s*\d+/i,
  /(?:成功|合格|通過)\s*\d+[\s,、，]*失敗\s*\d+/,
  /通过\s*\d+[\s,、，]*失败\s*\d+/,
]
export function testsFromNotes(nodes: GraphNode[]): string {
  for (const node of newestFirst(nodes)) {
    for (const pattern of TEST_RUNS) {
      const match = pattern.exec(node.note)
      if (match) return match[0]
    }
  }
  return ''
}

export function runningAgents(agents: Agent[]): number {
  return agents.filter(a => a.status === 'running').length
}

// resetsAt comes as an ISO date or as epoch seconds (or milliseconds).
export function resetText(resetsAt: string | number | undefined, now = Date.now()): string {
  if (resetsAt === undefined || resetsAt === '') return ''
  const raw = typeof resetsAt === 'number' || /^\d+$/.test(resetsAt) ? Number(resetsAt) : Date.parse(resetsAt)
  if (!Number.isFinite(raw)) return ''
  const at = raw < 1e12 ? raw * 1000 : raw
  const minutes = Math.max(0, Math.round((at - now) / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  const d = t('time.days', { n: days })
  const h = t('time.hours', { n: hours })
  const m = t('time.minutes', { n: rest })
  const parts = days > 0 ? [d, hours > 0 ? h : ''] : hours > 0 ? [h, m] : [m]
  return t('time.resetsIn', { time: parts.filter(Boolean).join(' ') })
}

export const LIGHT_THEME = 'metro'
const LIGHT_THEMES = new Set([LIGHT_THEME, 'solarizedlight', 'githublight'])
// A scheme with both a light and a dark version flips to its other half.
const PAIRS: Record<string, string> = { solarizeddark: 'solarizedlight', solarizedlight: 'solarizeddark' }

export function isLight(theme: string): boolean {
  return LIGHT_THEMES.has(theme)
}

// The light switch: from any dark theme to the light one, and back to the dark theme used last.
export function flipTheme(current: string, lastDark: string | undefined, fallbackDark: string): { theme: string; lastDark: string } {
  const pair = PAIRS[current]
  if (isLight(current)) {
    const theme = pair ?? (lastDark && !isLight(lastDark) ? lastDark : fallbackDark)
    return { theme, lastDark: pair ?? lastDark ?? fallbackDark }
  }
  return { theme: pair ?? LIGHT_THEME, lastDark: current }
}

// "결정 1 (전체 3)" while one project is chosen.
export function countLabel(label: string, total: number, scoped: number | null): string {
  return scoped === null ? t('count.total', { label, total }) : t('count.scoped', { label, scoped, total })
}

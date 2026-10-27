import type { BridgeState, Session, Task } from './types'
import { t } from './i18n/index.ts'

// Projects for the sidebar switcher and the per-project view. A project is a
// folder; its name is the folder's last part, the same name the bridge gives a
// session that starts there.

export type SavedProject = { name: string; cwd: string }

export type ProjectInfo = {
  name: string
  cwd: string
  running: number
  pending: number
  active: number // newest of its sessions' last_seen and its tasks' updated_at, 0 when none
}

// A task in stage 완료 is finished whatever its status says; the bridge keeps
// status '하는 중' until it is archived.
export type TaskState = 'run' | 'wait' | 'done'

export function taskState(task: Pick<Task, 'stage' | 'status'>): TaskState {
  if (task.stage === '완료') return 'done'
  return task.status === '하는 중' ? 'run' : 'wait'
}

export function taskStateLabel(state: TaskState): string {
  return t(`taskState.${state}`)
}

export function isRunning(task: Pick<Task, 'stage' | 'status'>): boolean {
  return taskState(task) === 'run'
}

export function projectName(cwd: string): string {
  return cwd.split('/').filter(Boolean).at(-1) ?? cwd
}

// The name a hand-added folder gets: the name it already has, else its folder
// name, or "<parent>/<name>" when another folder holds that name (the bridge's rule).
export function nameForFolder(projects: Pick<ProjectInfo, 'name' | 'cwd'>[], cwd: string): string {
  const known = projects.find(p => p.cwd === cwd)
  if (known) return known.name
  const name = projectName(cwd)
  if (!projects.some(p => p.name === name)) return name
  const parts = cwd.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

export function savedProjects(value: unknown): SavedProject[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (p): p is SavedProject => !!p && typeof p === 'object' && typeof (p as SavedProject).name === 'string' && typeof (p as SavedProject).cwd === 'string',
  )
}

// Every project the IDE knows of: folders added by hand and ones sessions or
// tasks name, the most recently active first so adding a folder never reorders
// the list. The folder comes from the hand-added entry, else the newest session.
export function projectsOf(state: BridgeState, saved: SavedProject[]): ProjectInfo[] {
  const cwd = new Map<string, string>()
  for (const p of saved) cwd.set(p.name, p.cwd)
  for (const s of state.sessions) if (!cwd.has(s.project) || !cwd.get(s.project)) cwd.set(s.project, s.cwd)
  for (const t of state.tasks) if (!cwd.has(t.project)) cwd.set(t.project, '')
  const list = [...cwd].map(([name, folder]) => ({
    name,
    cwd: folder,
    running: state.tasks.filter(t => t.project === name && isRunning(t)).length,
    pending: state.questions.filter(q => q.project === name && q.status === 'pending').length,
    active: Math.max(
      0,
      ...state.sessions.filter(s => s.project === name).map(s => s.last_seen || 0),
      ...state.tasks.filter(t => t.project === name).map(t => t.updated_at || 0),
    ),
  }))
  return list.sort((a, b) => b.active - a.active)
}

// The project a terminal belongs to, by folder: the project whose folder is the
// terminal's or the nearest one above it. Names can clash between folders, cwds cannot.
export function projectOfCwd(projects: Pick<ProjectInfo, 'name' | 'cwd'>[], cwd: string): string | null {
  const inside = (root: string) => root !== '' && (cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`))
  const best = projects.filter(p => inside(p.cwd)).sort((a, b) => b.cwd.length - a.cwd.length)[0]
  return best?.name ?? null
}

// The session a report, sync or Linear send goes to: the most recently seen one
// in the project in view. Never one of another project.
export function pickSession(sessions: Session[], scope: string | null): Session | null {
  const inScope = sessions.filter(s => scope === null || s.project === scope)
  return inScope.reduce<Session | null>((best, s) => (!best || s.last_seen > best.last_seen ? s : best), null)
}

// Opening a task or question of another project moves the view to that project,
// so the tab does not open hidden.
export function scopeFor(scope: string | null, project: string | undefined): string | null {
  if (scope === null || project === undefined || project === scope) return scope
  return project
}

// Optional until the bridge sends it on every /state.
type WithAnswered = { answeredByProject?: Record<string, number> }

function answeredOf(state: BridgeState, scope: string): number | undefined {
  const counts = (state as BridgeState & WithAnswered).answeredByProject
  return counts && typeof counts === 'object' ? (counts[scope] ?? 0) : undefined
}

// The state as one project sees it; null scope is every project.
export function scopeState(state: BridgeState, scope: string | null): BridgeState {
  if (scope === null) return state
  const sessions = state.sessions.filter(s => s.project === scope)
  const ids = new Set(sessions.map(s => s.id))
  const tasks = state.tasks.filter(t => t.project === scope)
  const taskIds = new Set(tasks.map(t => t.id))
  const questions = state.questions.filter(q => q.project === scope)
  return {
    ...state,
    sessions,
    tasks,
    questions,
    // The bridge's own count per project when it sends one; the questions here are only the recent ones.
    answeredCount: answeredOf(state, scope) ?? questions.filter(q => q.status === 'answered').length,
    events: state.events.filter(e => e.project === scope),
    nodes: state.nodes.filter(n => taskIds.has(n.task_id)),
    archived: state.archived.filter(t => t.project === scope),
    agents: state.agents.filter(a => ids.has(a.session_id)),
    commands: state.commands.filter(c => ids.has(c.session_id)),
  }
}

// Environment for a terminal the IDE opens. The IDE may itself run inside a
// Claude Code or Orca terminal; their per-session variables would make the new
// claude think it is a child session, so they go. The account folder stays.
export function terminalEnv(env: Record<string, string | undefined>, configDir?: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (/^(ORCA_|ELECTRON_|CLAUDE_CODE_|CLAUDE_IDE_CAPTURE)/.test(key)) continue
    if (['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'TERM_PROGRAM_VERSION'].includes(key)) continue
    out[key] = value
  }
  if (configDir && !out.CLAUDE_CONFIG_DIR) out.CLAUDE_CONFIG_DIR = configDir
  out.TERM = 'xterm-256color'
  out.COLORTERM = 'truecolor'
  out.TERM_PROGRAM = 'claude-ide'
  return out
}

// Shell words: single quotes, with any single quote inside closed and escaped.
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

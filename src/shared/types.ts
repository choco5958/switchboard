// Rows as the bridge's GET /state returns them.
import type { DevTarget } from './devtargets'
import type { Activity } from './stall'

export type Option = { key: string; label: string }

export type Session = {
  id: string
  project: string
  cwd: string
  started_at: number
  last_seen: number
  usage: string // JSON of SessionUsage below
  agent?: string // the agent CLI: 'claude', 'codex', 'custom-...' (src/shared/agents.ts)
  terminal?: string // the app terminal it runs in, '' when outside the app
}

export type SessionUsage = {
  rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { totalUsd?: number }
  contextPercent?: number
  model?: string
  agentsRunning?: number
  ccrSlot?: number // the ccr account slot the session runs on, when ccr started it
}

export type Task = {
  id: number
  session_id: string
  project: string
  title: string
  stage: '요구' | '설계' | '작업' | '완료'
  status: '하는 중' | '대기' | '보관'
  now: string
  created_at: number
  updated_at: number
  why: string
  what: string
  result: string
  artifact: string
  tests: string
  branch: string
  number: number
  archived_at: number | null
  restored_at: number | null
}

export type Agent = {
  id: string
  session_id: string
  task_title: string
  node_key: string
  description: string
  type: string
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed' | 'paused' | 'stopped'
  created_at: number
  updated_at: number
}

export type CommandKind = 'pause' | 'resume' | 'stop' | 'message' | 'transcript' | 'report' | 'sync'

export type Command = {
  id: number
  session_id: string
  kind: CommandKind
  payload: string
  created_at: number
  done_at: number | null
}

export type Question = {
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
  turn_id: string
  forwarded_to?: string // the session the person handed it to, '' when none
}

export type LogEvent = {
  id: number
  ts: number
  session_id: string
  project: string
  task_title: string
  kind: string
  text: string
}

export type GraphNode = {
  id: number
  task_id: number
  key: string
  title: string
  kind: '시험' | '확인' | '구현' | '검토' | '기타'
  owner: '작업자' | '검토자' | '사용자' | '오케스트레이터'
  stage: '요구' | '설계' | '작업' | '완료' | null
  status: '대기' | '지금' | '끝' | '실패'
  after: string
  round: number
  note: string
  updated_at: number
  worktree: string | null
  branch: string | null
}

export type BridgeState = {
  sessions: Session[]
  live?: string[] // sessions whose delivery stream is open now
  activity?: Record<string, Activity> // what each session's turn is doing (src/shared/stall.ts)
  routines?: Routine[]
  approvals?: Approval[] // the newest 30 permission asks (bridge: POST /approvals)
  routineRuns?: RoutineRun[] // the newest 100
  tasks: Task[]
  questions: Question[]
  answeredCount: number
  events: LogEvent[]
  nodes: GraphNode[]
  archived: Task[]
  agents: Agent[]
  commands: Command[]
  settings: Record<string, unknown>
}

export type LinearIssue = {
  id?: string
  identifier?: string
  title?: string
  url?: string
  description?: string
  state?: { name?: string } | string
  priority?: number
  assignee?: { name?: string } | string | null
  team?: { key?: string; name?: string } | string
}

export type WorktreeCheck = {
  exists: boolean
  changed: string[] // uncommitted paths
  unpushed: number // commits not on the upstream (or on the base when there is none)
  merged: boolean // branch reachable from the base branch
  base: string
}

export type Reply = { ok: boolean; status: number; json: Record<string, unknown> }

export type { DevTarget }

// A dev server as the main process sees it.
export type DevStatus = {
  id: string
  running: boolean // a process this app started is alive
  pid: number | null
  startedAt: number | null
  exitCode: number | null // of the last run, when it ended
  listening: boolean // something accepts connections on the port
  responding: boolean // an HTTP GET to the url answered
}

export type DevGit = { ok: boolean; branch: string; commit: string; subject: string; error: string }

export type DevResult = { ok: boolean; out: string }

export type TermInfo = {
  id: string
  project: string
  cwd: string
  title: string
  claude: boolean
  alive: boolean
  exitCode: number | null
  agent?: string // an agent CLI other than Claude Code (src/shared/agents.ts)
}

export type IdeApi = {
  state: () => Promise<BridgeState | null>
  answer: (id: number, choice: string, memo: string) => Promise<Reply>
  hold: (id: number) => Promise<Reply>
  forward: (id: number, to: string) => Promise<Reply> // hand a question to another session to answer
  approve: (id: number, decision: 'allow' | 'deny' | 'terminal') => Promise<Reply>
  connected: () => Promise<boolean>
  send: (sessionId: string, text: string, kind: string, taskTitle: string) => Promise<Reply>
  saveShot: (dataUrl: string) => Promise<string | null>
  command: (sessionId: string, kind: CommandKind, payload: Record<string, unknown>) => Promise<Reply>
  commandResult: (id: number) => Promise<Reply>
  bridge: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Reply>
  linearList: (filter: string) => Promise<{ issues: LinearIssue[]; error?: string }>
  checkWorktree: (path: string, branch: string) => Promise<WorktreeCheck>
  removeWorktree: (nodeId: number, path: string, force: boolean) => Promise<Reply>
  devStart: (target: DevTarget) => Promise<DevResult>
  devStop: (id: string) => Promise<DevResult>
  devRestart: (target: DevTarget) => Promise<DevResult>
  devPull: (repo: string) => Promise<DevResult>
  devGit: (repo: string) => Promise<DevGit>
  devStatus: (target: DevTarget) => Promise<DevStatus>
  devLog: (id: string) => Promise<string[]>
  onDevChange: (listener: (event: { id: string }) => void) => () => void
  onChange: (listener: (event: { type: string }) => void) => () => void
  onConnection: (listener: (connected: boolean) => void) => () => void
  onNotifyOpen: (listener: (questionId: number) => void) => () => void
  termList: () => Promise<TermInfo[]>
  termOpen: (cwd: string, claude: boolean, cols: number, rows: number, slot?: number) => Promise<TermInfo | { error: string }>
  // Agent CLIs other than Claude Code: a terminal running one, and which ones are installed.
  termOpenAgent: (cwd: string, agentId: string, cols: number, rows: number) => Promise<TermInfo | { error: string }>
  detectAgents: (force?: boolean) => Promise<AgentDetect>
  termBuffer: (id: string) => Promise<{ data: string; seq: number }>
  termWrite: (id: string, data: string) => void
  termResize: (id: string, cols: number, rows: number) => void
  termClose: (id: string) => Promise<boolean>
  pickFolder: () => Promise<string | null>
  onTermData: (listener: (event: { id: string; data: string; seq: number }) => void) => () => void
  onTermExit: (listener: (event: { id: string; exitCode: number }) => void) => () => void
  accountInfo: () => Promise<AccountInfo | null>
  measureAccounts: () => Promise<AccountInfo | null>
}

// Feature area: the signed-in Claude account for the top bar (masked email, readable plan).
export type AccountInfo = { email: string; plan: string; ccr?: { current: number; slots: CcrSlot[] } }

// One ccr slot. until: epoch seconds its limit lifts (0: not marked spent); usage as ccr measured it at measuredAt.
export type CcrSlot = {
  slot: number
  email: string
  plan: string
  until: number
  fiveHour?: number
  week?: number
  weekResetsAt?: string
  measuredAt?: number
  measureError?: string
  token?: boolean // a one year token sits in the keychain for this slot
  refreshExpiresAt?: number // epoch ms the login's refresh token stops working, from ccr's last measurement
}

// Feature area: agent CLIs other than Claude Code. found maps a command to its path
// on the login-shell PATH; a command missing from it is not installed.
export type AgentDetect = { found: Record<string, string>; node: string | null; at: number }

// A scheduled prompt (bridge/schedule.ts) and one of its runs, as GET /state returns them.
export type RoutineSchedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'interval'; every: number; anchor: number }
  | { kind: 'once'; at: string }

export type Routine = {
  id: number
  project: string
  cwd: string
  name: string
  prompt: string
  schedule: string // JSON of RoutineSchedule
  missed: 'skip' | 'run-once'
  enabled: number
  next_at: number | null
  created_at: number
  updated_at: number
}

export type RoutineRun = {
  id: number
  routine_id: number
  scheduled_for: number
  created_at: number
  session_id: string
  status: 'waiting' | 'sent' | 'done' | 'quiet' | 'failed' | 'skipped' | 'missed'
  failure: string
  result: string
  finished_at: number | null
}

// A Claude Code permission ask put to the person while away from the desk (mod tool.check).
export type Approval = {
  id: number
  session_id: string
  project: string
  tool: string
  summary: string
  cwd: string
  reason: string
  status: 'pending' | 'allow' | 'deny' | 'terminal' | 'expired'
  via: string
  created_at: number
  answered_at: number | null
}

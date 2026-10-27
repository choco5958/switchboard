// What the Switchboard pane keeps in $.state: the last bridge snapshot of this
// session, which tab the person is looking at, the main loop's turn and an
// opened subagent transcript.

export type FlowTask = {
  id: number
  number: number
  title: string
  stage: string
  status: string
  now: string
  branch: string
  artifact: string
}

export type FlowNode = {
  taskId: number
  key: string
  title: string
  status: string
  kind: string
  owner: string
  after: string[]
  round: number
}

export type FlowAgent = {
  id: string
  taskTitle: string
  description: string
  status: string
  updatedAt: number
}

export type FlowOption = { key: string; label: string }

export type FlowQuestion = {
  id: number
  taskTitle: string
  question: string
  options: FlowOption[]
  recommend: string
}

export type Snapshot = {
  tasks: FlowTask[]
  nodes: FlowNode[]
  agents: FlowAgent[]
  questions: FlowQuestion[]
  costUsd: number | null
  fetchedAt: number
  // The app's UI language from the bridge's settings (Lang in hooks/i18n.ts).
  lang: 'ko' | 'en' | 'ja' | 'zh-CN'
}

export type Feed = {
  snapshot: Snapshot | null
  checkedAt: number
  isOffline: boolean
  // Why the last fetch ran: a poll, a turn's start or end, the r key.
  reason: RefreshReason
}

export type PaneView = {
  tab: 'flow' | 'decisions'
  isSummaryOpen: boolean
  // Tasks whose subagent list is unfolded, by task id.
  openAgents: number[]
}

// The main loop's turn: whether it runs, and when it last started or ended.
export type MainTurn = {
  isBusy: boolean
  since: number
}

// One subagent's recent transcript, opened from its row in the pane.
// note holds the error when it could not be read.
export type AgentTranscript = {
  agentId: string
  lines: string[]
  note: string
}

export type RefreshReason = '' | 'auto' | 'open' | 'key' | 'turnStart' | 'turnEnd' | 'agentTurnEnd'

declare module 'claude-code' {
  interface PluginState {
    'ide-bridge': {
      feed: Shaped<Feed>
      view: Shaped<PaneView>
      turn: MainTurn
      transcript: AgentTranscript | null
    }
  }
}

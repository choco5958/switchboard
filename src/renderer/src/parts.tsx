import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { Approval, BridgeState, Question, Task } from '../../shared/types'
import { taskStateLabel, taskState } from '../../shared/projects'
import { eventKindLabel, stageLabel, t } from '../../shared/i18n'
import { STAGES, ago, clock, optionsOf, stripTaskPrefix, taskOfEvent, type Attention } from './model'
import type { AgentTag } from '../../shared/agents'

// Six task colors, cycled by task number (the round badge in the task list).
export function taskColor(task: Pick<Task, 'number'>): string {
  return `var(--task-${((task.number || 1) - 1) % 6})`
}

export function NumberBadge({ task, title }: { task: Pick<Task, 'number'>; title?: string }) {
  return (
    <span className="num-badge" style={{ background: taskColor(task) }} title={title}>
      {task.number}
    </span>
  )
}

// Which agent CLI a session runs in (Claude, Codex, Gemini, ...). Shown only once a
// session of another agent than Claude Code exists.
export function AgentBadge({ tag }: { tag: AgentTag | undefined }) {
  if (!tag) return null
  return (
    <span className={`agent-badge agent-${tag.kind.replace(/[^a-z0-9-]/g, '')}`} title={t('agents.badgeTitle', { label: tag.label })}>
      {tag.label}
    </span>
  )
}

export function QueueItem({ q, active, gone, onClick }: { q: Question; active: boolean; gone?: boolean; onClick: () => void }) {
  return (
    <button className={`queue-item ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="qid">Q{q.id}</span> <span className="tag">[{q.task_title || q.project}]</span>
      {gone && <span className="gone-mark" title={t('question.goneTitle')}>{t('question.gone')}</span>}
      <span className="qtext">{q.question}</span>
      <span className="quiet small">{ago(q.created_at)}</span>
    </button>
  )
}

export function TaskItem({
  task,
  active,
  openQuestions,
  nodeCount,
  agent,
  attention = null,
  project,
  onClick,
}: {
  task: Task
  active: boolean
  openQuestions: number
  nodeCount: number
  agent?: AgentTag
  attention?: Attention | null // why it needs the person now (model.ts attentionOf)
  project?: string // shown in the waiting group, where tasks of every project mix
  onClick: () => void
}) {
  const at = STAGES.indexOf(task.stage)
  const state = taskState(task)
  return (
    <button className={`task ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="task-title">
        <span className={`status status-${state}`}>{taskStateLabel(state)}</span> <NumberBadge task={task} />{' '}
        {task.title} <AgentBadge tag={agent} />
        {project && <span className="quiet small"> {project}</span>}
      </div>
      {task.now && <div className="quiet small">{t('task.now', { now: task.now })}</div>}
      <ol className="stages">
        {STAGES.map((stage, i) => (
          <li key={stage} className={i < at ? 'done' : i === at ? 'now' : ''}>
            {stageLabel(stage)}
          </li>
        ))}
      </ol>
      <div className="task-tags">
        {attention === 'stalled' && (
          <span className="tag-chip warn" title={t('task.stalledTitle')}>
            {t('task.stalled')}
          </span>
        )}
        {attention === 'limited' && (
          <span className="tag-chip warn" title={t('task.limitedTitle')}>
            {t('task.limited')}
          </span>
        )}
        {attention === 'offline' && (
          <span className="tag-chip" title={t('task.offlineTitle')}>
            {t('question.gone')}
          </span>
        )}
        {openQuestions > 0 && <span className="tag-chip warn">{t('task.openQuestions', { n: openQuestions })}</span>}
        {task.restored_at && Date.now() - task.restored_at < 24 * 3600_000 && (
          <span className="tag-chip accent">{t('task.restoredTag')}</span>
        )}
        {nodeCount === 0 && (
          <span className="tag-chip" title={t('task.noPlanTitle')}>
            {t('task.noPlan')}
          </span>
        )}
      </div>
    </button>
  )
}

export function History({ questions, onOpen }: { questions: Question[]; onOpen: (id: number) => void }) {
  const answered = questions.filter(q => q.status === 'answered')
  return (
    <div className="card wide">
      <h1>{t('rail.history')}</h1>
      <p className="quiet small">{t('history.recent')}</p>
      {answered.length === 0 ? (
        <p className="quiet">{t('history.empty')}</p>
      ) : (
        <table className="history">
          <thead>
            <tr>
              <th>{t('history.colId')}</th>
              <th>{t('history.colTask')}</th>
              <th>{t('history.colQuestion')}</th>
              <th>{t('history.colAnswer')}</th>
              <th>{t('history.colAnsweredAt')}</th>
            </tr>
          </thead>
          <tbody>
            {answered.map(q => {
              const label = optionsOf(q).find(o => o.key === q.choice)?.label
              return (
                <tr key={q.id} onClick={() => onOpen(q.id)} className="clickable">
                  <td>Q{q.id}</td>
                  <td>{q.task_title || q.project}</td>
                  <td>{q.question}</td>
                  <td>
                    {q.choice ? `(${q.choice}) ${label ?? ''}` : t('history.memo')}
                    {q.memo && <div className="quiet small">{q.memo}</div>}
                  </td>
                  <td>{q.answered_at ? clock(q.answered_at) : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// One line per event. The task shows as its number badge (title in the tooltip) when
// the tasks are known; the long bracketed title is left for lines without a task.
export function LogLines({
  events,
  tasks = [],
  empty,
  agents = {},
}: {
  events: BridgeState['events']
  tasks?: Task[]
  empty?: string
  agents?: Record<string, AgentTag> // session id to its agent badge
}) {
  if (events.length === 0 && empty) return <p className="quiet log-empty">{empty}</p>
  return (
    <>
      {events.map(e => {
        const task = taskOfEvent(tasks, e)
        return (
          <div key={e.id} className={`log kind-${e.kind}`}>
            <span className="quiet">{clock(e.ts)}</span>{' '}
            {agents[e.session_id] && (
              <>
                <AgentBadge tag={agents[e.session_id]} />{' '}
              </>
            )}
            {task ? <NumberBadge task={task} title={task.title} /> : <span className="tag">[{e.task_title || e.project}]</span>}{' '}
            <span className="kind">{eventKindLabel(e.kind)}</span> {stripTaskPrefix(e.text)}
          </div>
        )
      })}
    </>
  )
}

// Short notices after an action ("진행 보고를 요청했습니다", or the error). App keeps the
// list and renders <Toast>; any component under it calls useToast() to add one.
export type ToastKind = 'good' | 'bad' | 'info'
export type ToastItem = { id: number; text: string; kind: ToastKind }
export type ShowToast = (text: string, kind?: ToastKind) => void

const ToastContext = createContext<ShowToast>(() => {})
export const ToastProvider = ToastContext.Provider

export function useToast(): ShowToast {
  return useContext(ToastContext)
}

// The list behind <Toast>: show() adds a notice that leaves by itself after a few seconds.
export function useToastList(ms = 4000): { toasts: ToastItem[]; show: ShowToast; dismiss: (id: number) => void } {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const next = useRef(1)
  const dismiss = useCallback((id: number) => setToasts(list => list.filter(t => t.id !== id)), [])
  const show = useCallback<ShowToast>(
    (text, kind = 'good') => {
      const id = next.current++
      setToasts(list => [...list.slice(-3), { id, text, kind }])
      setTimeout(() => dismiss(id), kind === 'bad' ? ms * 2 : ms)
    },
    [dismiss, ms],
  )
  return { toasts, show, dismiss }
}

export function Toast({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(item => (
        <div key={item.id} className={`toast toast-${item.kind}`}>
          <span>{item.text}</span>
          <button className="toast-close" title={t('common.close')} onClick={() => onDismiss(item.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

// A permission ask that came while the person was away (mod tool.check). Allow and deny answer
// it here; 'in the terminal' hands it back to Claude Code's own dialog.
export function ApprovalItem({ a, onAnswer }: { a: Approval; onAnswer: (decision: 'allow' | 'deny' | 'terminal') => void }) {
  return (
    <div className="approval-item">
      <div>
        <span className="qid">A{a.id}</span> <span className="tag">[{a.project}]</span> <strong>{a.tool}</strong>
        <span className="quiet small"> {ago(a.created_at)}</span>
      </div>
      <pre className="approval-summary" title={a.summary}>
        {a.summary}
      </pre>
      {a.reason && <div className="small">{t('approval.reason', { reason: a.reason })}</div>}
      {a.cwd && <div className="quiet small">{t('approval.cwd', { cwd: a.cwd })}</div>}
      <div className="approval-actions">
        <button className="primary" onClick={() => onAnswer('allow')}>
          {t('approval.allow')}
        </button>
        <button onClick={() => onAnswer('deny')}>{t('approval.deny')}</button>
        <button className="link small" title={t('approval.terminalTitle')} onClick={() => onAnswer('terminal')}>
          {t('approval.terminal')}
        </button>
      </div>
    </div>
  )
}

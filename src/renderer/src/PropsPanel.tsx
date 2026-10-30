import { useEffect, useRef, useState } from 'react'
import type { BridgeState, GraphNode } from '../../shared/types'
import { clock } from './model'
import type { Tab } from './tabs'
import { nodeKindLabel, nodeOwnerLabel, nodeStatusLabel, stageLabel, t, taskStatusLabel } from '../../shared/i18n'
import { Icon } from './Icons'
import { EmptyState, IconButton } from './ui'
import { NodeWorktree } from './NodeWorktree'
import { nodeDetailKey } from './taskInfo'

const OPEN_KEY = 'claude-ide:props-open'

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

type Row = [string, string | number | null | undefined]
// node: the group is the picked node's, and its worktree actions go under the rows.
type Group = { title: string; rows: Row[]; node?: GraphNode }

// What the active tab is about, in plain rows: the task, the question, the node picked in the graph.
export function propsOf(tab: Tab, state: BridgeState, node: GraphNode | null): Group[] {
  const groups: Group[] = []
  if (tab.kind === 'task') {
    const task = state.tasks.find(t => t.id === tab.id)
    if (task) {
      groups.push({
        title: t('props.task'),
        rows: [
          ['id', task.id],
          [t('props.number'), task.number],
          [t('props.project'), task.project],
          [t('props.session'), task.session_id],
          [t('props.branch'), task.branch],
          [t('props.stage'), stageLabel(task.stage)],
          [t('props.status'), taskStatusLabel(task.status)],
          [t('props.created'), clock(task.created_at)],
          [t('props.updated'), clock(task.updated_at)],
          [t('props.nodes'), state.nodes.filter(n => n.task_id === task.id).length],
        ],
      })
      if (node && node.task_id === task.id) {
        groups.push({
          title: t('props.node'),
          node,
          rows: [
            ['key', node.key],
            [t('taskView.colTitle'), node.title],
            [t('taskView.colKind'), nodeKindLabel(node.kind)],
            [t('taskView.colOwner'), nodeOwnerLabel(node.owner)],
            [t('props.stage'), node.stage && stageLabel(node.stage)],
            [t('props.status'), nodeStatusLabel(node.status)],
            [t('taskView.colRound'), node.round],
            [t('history.memo'), node.note],
            [t('props.updated'), clock(node.updated_at)],
            [t('taskView.worktree'), node.worktree],
            [t('props.branch'), node.branch],
          ],
        })
      }
    }
  }
  if (tab.kind === 'question') {
    const q = state.questions.find(one => one.id === tab.id)
    if (q) {
      groups.push({
        title: t('props.question'),
        rows: [
          ['id', `Q${q.id}`],
          [t('props.project'), q.project],
          [t('props.task'), q.task_title],
          [t('props.session'), q.session_id],
          [t('props.round'), q.turn_id],
          [t('props.status'), t(q.status === 'pending' ? 'palette.qPending' : q.status === 'held' ? 'palette.qHeld' : 'palette.qAnswered')],
          [t('props.asked'), clock(q.created_at)],
          [t('history.colAnsweredAt'), q.answered_at ? clock(q.answered_at) : null],
          [t('props.delivery'), q.status === 'answered' ? (q.delivered ? t('props.delivered') : t('props.waiting')) : null],
        ],
      })
    }
  }
  return groups.map(g => ({ ...g, rows: g.rows.filter(([, value]) => value !== null && value !== undefined && value !== '') }))
}

// The right edge: a thin strip ("« 속성") that opens into the properties of the active tab.
export function PropsPanel({ tab, state, node }: { tab: Tab; state: BridgeState; node: GraphNode | null }) {
  const [open, setOpen] = useState(loadOpen)
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0')
    } catch {
      // per-viewer convenience only
    }
  }, [open])
  // A node picked in the graph opens the panel: its details live here, not under the graph.
  const shownKey = useRef<string | null>(null)
  useEffect(() => {
    const key = node ? `${node.task_id}:${node.key}` : null
    if (key && key !== shownKey.current) setOpen(true)
    shownKey.current = key
  }, [node])

  if (!open) {
    return (
      <aside className="props-panel closed">
        <button type="button" className="props-toggle" title={t('props.expand')} aria-label={t('props.expand')} aria-expanded={false} onClick={() => setOpen(true)}>
          <Icon name="panelOpen" size="sm" />
          <span className="props-vertical" aria-hidden="true">
            {t('props.title')}
          </span>
        </button>
      </aside>
    )
  }
  const groups = propsOf(tab, state, node)
  return (
    <aside className="props-panel">
      <div className="props-head">
        <h2>{t('props.title')}</h2>
        <IconButton icon="panelClose" size="sm" label={t('props.collapse')} aria-expanded onClick={() => setOpen(false)} />
      </div>
      {groups.length === 0 && <EmptyState className="small">{t('props.empty')}</EmptyState>}
      {groups.map(group => (
        <section key={group.title}>
          <h3>{group.title}</h3>
          <dl className="props-list">
            {group.rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
          {group.node && <NodeWorktree key={nodeDetailKey(group.node)} node={group.node} />}
        </section>
      ))}
    </aside>
  )
}

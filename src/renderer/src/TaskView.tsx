import { useEffect, useRef, useState } from 'react'
import type { Agent, CommandKind, GraphNode, LogEvent, Question, Task, WorktreeCheck } from '../../shared/types'
import { WorkerLane } from './WorkerLane'
import { ago, clock, layoutGraph, reviewLoops, stageCounts, stations } from './model'
import { AgentBadge, NumberBadge, onPress } from './parts'
import type { AgentTag } from '../../shared/agents'
import { eventKindLabel, nodeKindLabel, nodeOwnerLabel, nodeStatusLabel, nodeStatusSlug, stageLabel, t, taskStatusLabel } from '../../shared/i18n'
import { artifactFromNotes, nodeDetailKey, runningAgents, taskEvents, taskQuestions, testsFromNotes } from './taskInfo'

const COL_W = 220
const COL_GAP = 36
const ROW_H = 100
const BOX_H = 80
const PAD = 16

export function TaskView({
  task,
  agent,
  nodes,
  questions,
  events,
  agents,
  onQuestion,
  onCommand,
  onSelectNode,
}: {
  task: Task
  agent?: AgentTag // the agent CLI of the task's session, once other agents than Claude are around
  nodes: GraphNode[]
  questions: Question[]
  events: LogEvent[]
  agents: Agent[]
  onQuestion: (id: number) => void
  onCommand: (kind: CommandKind, payload: Record<string, unknown>) => void
  onSelectNode?: (node: GraphNode | null) => void
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selectedNode = nodes.find(n => n.key === selectedKey)
  // The properties panel shows the selected node; it clears when this task closes. Every bridge
  // push brings a new copy of the same node, so it is sent again only when its content changed.
  const latestNode = useRef(selectedNode)
  latestNode.current = selectedNode
  const selectedText = selectedNode ? JSON.stringify(selectedNode) : ''
  useEffect(() => {
    onSelectNode?.(latestNode.current ?? null)
  }, [selectedText, onSelectNode])
  useEffect(() => () => onSelectNode?.(null), [onSelectNode])
  const layout = layoutGraph(nodes)
  const width = PAD * 2 + layout.cols * COL_W + Math.max(0, layout.cols - 1) * COL_GAP
  const height = PAD * 2 + Math.max(1, layout.rows) * ROW_H + 12
  const at = new Map(layout.placed.map(p => [p.node.key, p]))
  const x = (col: number) => PAD + col * (COL_W + COL_GAP)
  const y = (row: number) => PAD + row * ROW_H
  const open = taskQuestions(questions, task)
  const recent = taskEvents(events, task)
  const loops = reviewLoops(nodes)
  const station = stations(task.stage)
  // Fields the session left empty are filled from the graph and node notes, marked "자동".
  const nowNodes = nodes.filter(n => n.status === '지금').map(n => n.title)
  const lastDone = [...nodes].filter(n => n.status === '끝' && n.note).sort((a, b) => b.updated_at - a.updated_at)[0]
  const running = runningAgents(agents)
  const nowText = [task.now || nowNodes.join(', '), running > 0 ? t('taskView.runningAgents', { n: running }) : ''].filter(Boolean).join(', ')
  const summary: [string, string, boolean][] = [
    [t('taskView.why'), task.why, false],
    [t('taskView.what'), task.what || task.title, !task.what],
    [t('taskView.now'), nowText, !task.now],
    [t('taskView.result'), task.result || (lastDone ? `${lastDone.title}: ${lastDone.note}` : ''), !task.result],
    [t('taskView.artifact'), task.artifact || artifactFromNotes(nodes), !task.artifact],
    [t('taskView.tests'), task.tests || testsFromNotes(nodes), !task.tests],
  ]

  return (
    <div className="card wide">
      <div className="card-head">
        <span className="tag">[{task.project}]</span>
        <AgentBadge tag={agent} />
        <span className="spacer" />
        <span className="quiet small">{t('taskView.updated', { ago: ago(task.updated_at) })}</span>
      </div>
      <div className="task-summary">
        <h1>
          {task.title}
          {task.branch && <span className="branch-chip">{task.branch}</span>}
        </h1>
        <ul>
          {summary
            .filter(([, value]) => value)
            .map(([label, value, auto]) => (
              <li key={label}>
                <b>{label}:</b> {value} {auto && <span className="auto-chip" title={t('taskView.autoTitle')}>{t('taskView.auto')}</span>}
              </li>
            ))}
        </ul>
      </div>

      <div className="stations">
        <NumberBadge task={task} />
        <span className="quiet small">{t('taskView.currentStage')}</span> <b className="station-now">{stageLabel(station.now)}</b>
        <span className="station-arrow">▶ {taskStatusLabel(task.status)}</span>
        {station.next && (
          <>
            <span className="station-arrow">▶▶</span> <span className="quiet small">{t('taskView.nextStage')}</span> <b className="station-next">{stageLabel(station.next)}</b>
          </>
        )}
      </div>

      <ol className="pipeline">
        {stageCounts(nodes).map(({ stage, done, total }, i) => (
          <li key={stage} className={stage === task.stage ? 'now' : done > 0 && done === total ? 'done' : ''}>
            <span className="stage-num">{String(i + 1).padStart(2, '0')}</span>
            <span className="pipeline-name">{stageLabel(stage)}</span>
            {done > 0 && done === total && <span className="stage-done"> ✓</span>}
            {total > 0 && (
              <span className="quiet small">
                {' '}
                {t('taskView.stageNodes', { total, done })}
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="quiet small">{t('taskView.graphHint')}</p>

      {open.length > 0 && (
        <div className="task-questions">
          {open.map(q => (
            <button key={q.id} className="link" onClick={() => onQuestion(q.id)}>
              <span className="qid">Q{q.id}</span> {q.question} {q.status === 'held' ? t('taskView.qHeld') : t('taskView.qPending')}
            </button>
          ))}
        </div>
      )}

      {nodes.length === 0 ? (
        <p className="quiet" title={t('taskView.noPlanTitle')}>
          {t('taskView.noPlan')}
        </p>
      ) : (
        <div className="graph-scroll">
          <div className="graph" style={{ width, height }}>
            <svg className="edges" width={width} height={height}>
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0 0L10 5L0 10z" fill="currentColor" />
                </marker>
              </defs>
              {loops.map(({ from, to, round }) => {
                const a = at.get(from)
                const b = at.get(to)
                if (!a || !b) return null
                const x1 = x(a.col) + COL_W / 2
                const y1 = y(a.row) + BOX_H
                const x2 = x(b.col) + COL_W / 2
                const y2 = y(b.row) + BOX_H
                const dip = Math.max(y1, y2) + 14
                return (
                  <g key={`loop-${from}-${to}`} className="loop">
                    <path d={`M${x1} ${y1} C${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2 + 2}`} markerEnd="url(#arrow)" />
                    <text x={(x1 + x2) / 2} y={dip - 2} textAnchor="middle">
                      {t('taskView.round', { n: round })}
                    </text>
                  </g>
                )
              })}
              {layout.edges.map(([from, to]) => {
                const a = at.get(from)
                const b = at.get(to)
                if (!a || !b) return null
                const x1 = x(a.col) + COL_W
                const y1 = y(a.row) + BOX_H / 2
                const x2 = x(b.col)
                const y2 = y(b.row) + BOX_H / 2
                const bend = Math.max(24, (x2 - x1) / 2)
                return (
                  <path
                    key={`${from}-${to}`}
                    d={`M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 2} ${y2}`}
                    className={a.node.status === '끝' ? 'edge done' : 'edge'}
                    markerEnd="url(#arrow)"
                  />
                )
              })}
            </svg>
            {layout.placed.map(({ node, col, row }) => (
              <div
                key={node.key}
                className={`node node-${node.status} ${node.key === selectedKey ? 'node-selected' : ''}`}
                data-status={nodeStatusSlug(node.status)}
                role="button"
                tabIndex={0}
                aria-pressed={node.key === selectedKey}
                onClick={() => setSelectedKey(key => (key === node.key ? null : node.key))}
                onKeyDown={onPress(() => setSelectedKey(key => (key === node.key ? null : node.key)))}
                style={{ left: x(col), top: y(row), width: COL_W, height: BOX_H }}
                title={node.note ? `${node.title}\n${node.note}` : node.title}
              >
                <div className="node-title">
                  <span className="kind">{nodeKindLabel(node.kind)}</span>
                  {node.worktree && <span className="kind">{t('taskView.worktree')}</span>}
                  {node.title}
                </div>
                <div className="quiet small">
                  {nodeOwnerLabel(node.owner)}, {nodeStatusLabel(node.status)}
                  {node.round > 1 ? `, ${t('taskView.round', { n: node.round })}` : ''}
                  {node.note ? `, ${node.note}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {selectedNode && <NodeDetail key={nodeDetailKey(selectedNode)} node={selectedNode} />}

      {nodes.length > 0 && <NodeTable nodes={nodes} selectedKey={selectedKey} onSelect={key => setSelectedKey(current => (current === key ? null : key))} />}

      <WorkerLane sessionId={task.session_id} agents={agents} nodes={nodes} />

      {recent.length > 0 && (
        <>
          <h3>{t('taskView.recent')}</h3>
          <div className="task-log">
            {recent.map(e => (
              <div key={e.id}>
                <span className="quiet">{clock(e.ts)}</span> <span className="kind">{eventKindLabel(e.kind)}</span> {e.text}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function NodeDetail({ node }: { node: GraphNode }) {
  const [check, setCheck] = useState<WorktreeCheck | null>(null)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  // A fresh check (or none) always needs its own second press.
  useEffect(() => setArmed(false), [check])

  const inspect = async () => {
    if (!node.worktree) return
    setBusy(true)
    setCheck(await window.ide.checkWorktree(node.worktree, node.branch ?? ''))
    setBusy(false)
  }

  const risky = check !== null && check.exists && (check.changed.length > 0 || (!check.merged && check.unpushed > 0))

  const remove = async () => {
    if (!node.worktree) return
    // Anything that would be lost needs a second press.
    if (risky && !armed) return setArmed(true)
    setBusy(true)
    const reply = await window.ide.removeWorktree(node.id, node.worktree, check?.changed.length ? true : false)
    setBusy(false)
    setMessage(reply.ok ? t('taskView.removed') : t('taskView.removeFailed', { error: String(reply.json.error ?? '') }))
  }

  return (
    <div className="node-detail">
      <h3>
        {node.title} <span className="quiet small">({nodeKindLabel(node.kind)}, {nodeOwnerLabel(node.owner)}, {nodeStatusLabel(node.status)}{node.round > 1 ? `, ${t('taskView.round', { n: node.round })}` : ''})</span>
      </h3>
      {node.note && <p>{node.note}</p>}
      {node.worktree ? (
        <>
          <div className="small mono">{node.worktree}</div>
          <div className="small quiet">{t('taskView.branch', { branch: node.branch ?? '' })}</div>
          {!check && (
            <button className="link" disabled={busy} onClick={() => void inspect()}>
              {t('taskView.checkFirst')}
            </button>
          )}
          {check && !check.exists && <p className="small quiet">{t('taskView.folderGone')}</p>}
          {check && check.exists && (
            <ul className="small check">
              <li className={check.changed.length > 0 ? 'bad' : 'good'}>
                {t('taskView.uncommitted', { n: check.changed.length })}{check.changed.length > 0 ? `: ${check.changed.slice(0, 5).join(', ')}` : ''}
              </li>
              <li className={check.merged ? 'good' : 'warn'}>{check.merged ? t('taskView.merged', { base: check.base }) : t('taskView.notMerged', { base: check.base })}</li>
              <li className={check.unpushed > 0 ? 'warn' : 'good'}>{t('taskView.unpushed', { n: check.unpushed })}</li>
            </ul>
          )}
          {check && (
            <div className="actions">
              <button className={armed ? 'danger' : ''} disabled={busy || message !== ''} onClick={() => void remove()}>
                {armed ? t('taskView.removeAnyway') : t('taskView.remove')}
              </button>
            </div>
          )}
          {message && <p className="small">{message}</p>}
        </>
      ) : (
        <p className="small quiet">{t('taskView.noWorktree')}</p>
      )}
    </div>
  )
}

function NodeTable({ nodes, selectedKey, onSelect }: { nodes: GraphNode[]; selectedKey: string | null; onSelect: (key: string) => void }) {
  return (
    <>
      <h3>{t('taskView.nodes', { n: nodes.length })}</h3>
      <table className="history node-table">
        <thead>
          <tr>
            <th>{t('taskView.colKind')}</th>
            <th>{t('taskView.colTitle')}</th>
            <th>{t('taskView.colOwner')}</th>
            <th>{t('taskView.colStatus')}</th>
            <th>{t('taskView.colRound')}</th>
            <th>{t('history.memo')}</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map(node => (
            <tr
              key={node.id}
              className={`clickable ${node.key === selectedKey ? 'on' : ''}`}
              tabIndex={0}
              onClick={() => onSelect(node.key)}
              onKeyDown={onPress(() => onSelect(node.key))}
            >
              <td>
                <span className="tag-chip">{nodeKindLabel(node.kind)}</span>
              </td>
              <td>{node.title}</td>
              <td className="nowrap">{nodeOwnerLabel(node.owner)}</td>
              <td className={`nowrap node-status-${node.status}`} data-status={nodeStatusSlug(node.status)}>{nodeStatusLabel(node.status)}</td>
              <td className="nowrap">{node.round}</td>
              <td className="quiet">{node.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

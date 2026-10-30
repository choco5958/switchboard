import { useState } from 'react'
import type { Agent, GraphNode } from '../../shared/types'
import { ago, clock } from './model'
import { t, type Key } from '../../shared/i18n'
import { composing } from './ime'
import { Badge, Button, Card, Dialog, EmptyState, Input, type Tone } from './ui'

const STATUS: Record<Agent['status'], Key> = {
  pending: 'agent.pending',
  running: 'agent.running',
  waiting: 'agent.waiting',
  idle: 'agent.idle',
  completed: 'agent.completed',
  failed: 'agent.failed',
  killed: 'agent.killed',
  paused: 'agent.paused',
  stopped: 'agent.stopped',
}

const COMMAND = { pause: 'worker.pause', resume: 'worker.resume', stop: 'worker.stop', message: 'worker.message' } as const

const TONE: Partial<Record<Agent['status'], Tone>> = { running: 'accent', paused: 'warn', failed: 'bad' }

type Transcript = { role: string; text: string }[]

// Poll a command until the mod answers it (transcripts come back this way).
async function resultOf(id: number): Promise<{ messages?: Transcript; error?: string } | null> {
  for (let i = 0; i < 40; i++) {
    const reply = await window.ide.commandResult(id)
    if (reply.ok && reply.json.done_at) return (reply.json.result ?? null) as { messages?: Transcript; error?: string } | null
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return { error: t('worker.noAnswer') }
}

export function WorkerLane({ sessionId, agents, nodes }: { sessionId: string; agents: Agent[]; nodes: GraphNode[] }) {
  const [talking, setTalking] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [transcript, setTranscript] = useState<{ agent: Agent; lines: Transcript | null; error?: string } | null>(null)
  // What the last command did, per agent: sent, done, or why it failed.
  const [feedback, setFeedback] = useState<Record<string, { text: string; bad: boolean }>>({})
  const done = agents.filter(a => ['completed', 'failed', 'killed'].includes(a.status)).length
  const nodeTitle = (key: string) => nodes.find(n => n.key === key)?.title ?? key

  const send = async (kind: 'pause' | 'resume' | 'stop' | 'message', agent: Agent, payload: Record<string, unknown> = {}) => {
    const say = (text: string, bad = false) => setFeedback(current => ({ ...current, [agent.id]: { text, bad } }))
    const command = t(COMMAND[kind])
    say(t('worker.sent', { command }))
    const reply = await window.ide.command(sessionId, kind, { agentId: agent.id, ...payload })
    if (!reply.ok) return say(t('worker.sendFailed', { command, error: String(reply.json.error ?? reply.status) }), true)
    const result = await resultOf(Number(reply.json.id))
    if (result?.error) return say(t('worker.failed', { command, error: result.error }), true)
    say(t('worker.done', { command, time: clock(Date.now()) }))
  }

  const openTranscript = async (agent: Agent) => {
    setTranscript({ agent, lines: null })
    const reply = await window.ide.command(sessionId, 'transcript', { agentId: agent.id })
    if (!reply.ok) return setTranscript({ agent, lines: [], error: String(reply.json.error ?? '') })
    const result = await resultOf(Number(reply.json.id))
    setTranscript({ agent, lines: result?.messages ?? [], error: result?.error })
  }

  return (
    <div className="worker-lane">
      <h3 title={t('worker.headTitle')}>
        {t('worker.head')} <span className="quiet small">{t('worker.headHint')}</span>
      </h3>
      {agents.length === 0 ? (
        <EmptyState className="small">{t('worker.none')}</EmptyState>
      ) : (
        <p className="quiet small">
          {t('worker.count', { n: agents.length })}{done > 0 ? t('worker.countDone', { n: done }) : ''}
        </p>
      )}
      {agents.map(agent => {
        const live = ['running', 'waiting', 'idle', 'pending', 'paused'].includes(agent.status)
        return (
          <Card key={agent.id} sunk pad="sm" className={`worker worker-${agent.status}`}>
            <div className="worker-head">
              <Badge shape="pill" tone={TONE[agent.status] ?? 'neutral'}>
                {STATUS[agent.status] ? t(STATUS[agent.status]) : agent.status}
              </Badge>
              <span className="worker-node">{agent.node_key ? nodeTitle(agent.node_key) : t('worker.noNode')}</span>
              <span className="quiet small">{ago(agent.updated_at)}</span>
              <span className="spacer" />
              {live && agent.status !== 'paused' && (
                <Button size="sm" onClick={() => void send('pause', agent)}>
                  {t('worker.pause')}
                </Button>
              )}
              {agent.status === 'paused' && (
                <Button size="sm" onClick={() => void send('resume', agent)}>
                  {t('worker.resume')}
                </Button>
              )}
              {live && (
                <Button size="sm" onClick={() => void send('stop', agent)}>
                  {t('worker.stop')}
                </Button>
              )}
              <Button size="sm" aria-expanded={talking === agent.id} onClick={() => setTalking(talking === agent.id ? null : agent.id)}>
                {t('worker.message')}
              </Button>
              <Button size="sm" onClick={() => void openTranscript(agent)}>
                {t('worker.transcript')}
              </Button>
            </div>
            <div className="small">{agent.description.replace(/^\[[^\]]+\]\s*/, '')}</div>
            {feedback[agent.id] && <div className={`small ${feedback[agent.id]!.bad ? 'error' : 'quiet'}`}>{feedback[agent.id]!.text}</div>}
            {talking === agent.id && (
              <div className="worker-talk">
                <Input
                  autoFocus
                  aria-label={t('worker.messagePlaceholder')}
                  value={text}
                  placeholder={t('worker.messagePlaceholder')}
                  onChange={event => setText(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !composing(event) && text.trim()) {
                      void send('message', agent, { text: text.trim() })
                      setText('')
                      setTalking(null)
                    }
                    if (event.key === 'Escape') setTalking(null)
                  }}
                />
              </div>
            )}
          </Card>
        )
      })}
      {transcript && (
        <Dialog label={transcript.agent.description} onClose={() => setTranscript(null)} className="transcript" scrimClassName="transcript-scrim">
          <div className="card-head">
            <b>{transcript.agent.description}</b>
            <span className="spacer" />
            <Button variant="link" onClick={() => setTranscript(null)}>
              {t('common.close')}
            </Button>
          </div>
          {transcript.lines === null && <p className="quiet">{t('worker.loading')}</p>}
          {transcript.error && <p className="error">{transcript.error}</p>}
          {transcript.lines?.map((line, i) => (
            <div key={i} className={`transcript-line role-${line.role}`}>
              <span className="quiet small">{line.role === 'user' ? t('worker.roleUser') : t('worker.roleAgent')}</span>
              <pre>{line.text}</pre>
            </div>
          ))}
        </Dialog>
      )}
    </div>
  )
}

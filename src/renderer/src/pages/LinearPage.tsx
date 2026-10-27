import { useEffect, useState } from 'react'
import type { LinearIssue, Session } from '../../../shared/types'
import { pickSession } from '../../../shared/projects'
import { useToast } from '../parts'
import { t, type Key } from '../../../shared/i18n'

const FILTERS: [string, Key][] = [
  ['assigned', 'linear.assigned'],
  ['open', 'linear.open'],
  ['created', 'linear.created'],
  ['all', 'linear.all'],
]

function nameOf(value: { name?: string } | string | null | undefined): string {
  if (!value) return ''
  return typeof value === 'string' ? value : (value.name ?? '')
}

// The prompt a session gets when the person picks a Linear issue as a task.
export function linearPrompt(issue: LinearIssue): string {
  const lines = [t('prompt.linear.head', { id: issue.identifier ?? '' }), t('prompt.linear.title', { title: issue.title ?? '' })]
  if (issue.url) lines.push(t('prompt.comments.url', { url: issue.url }))
  if (issue.description) lines.push(t('prompt.linear.description', { text: issue.description.slice(0, 2000) }))
  lines.push(t('prompt.linear.ask', { id: issue.identifier ?? '', title: issue.title ?? '' }))
  return lines.join('\n')
}

// sessions: those of the project in view; the newest one receives unless the person picks another.
export function LinearPage({ sessions }: { sessions: Session[] }) {
  const toast = useToast()
  const NO_SESSION = t('linear.noSession')
  const [filter, setFilter] = useState('assigned')
  const [issues, setIssues] = useState<LinearIssue[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [target, setTarget] = useState('')
  const [sent, setSent] = useState<string[]>([])
  const targetId = (sessions.some(s => s.id === target) ? target : pickSession(sessions, null)?.id) ?? ''

  useEffect(() => {
    setLoading(true)
    void window.ide.linearList(filter).then(reply => {
      setIssues(reply.issues)
      setError(reply.error ?? '')
      setLoading(false)
    })
  }, [filter])

  const send = async (issue: LinearIssue) => {
    if (!targetId) return
    const reply = await window.ide.send(targetId, linearPrompt(issue), 'Linear', '')
    if (reply.ok) {
      setSent(list => [...list, issue.identifier ?? issue.id ?? ''])
      toast(t('linear.sent', { id: issue.identifier ?? '', session: targetId.slice(0, 8) }))
    } else toast(t('linear.sendFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }

  return (
    <div className="card wide">
      <h1>{t('linear.title')}</h1>
      <p className="quiet small">{t('linear.intro')}</p>
      <div className="linear-bar">
        {FILTERS.map(([key, label]) => (
          <button key={key} className={`chip chip-button ${filter === key ? 'chip-on' : ''}`} onClick={() => setFilter(key)}>
            {t(label)}
          </button>
        ))}
        <span className="spacer" />
        <span className="small quiet">{t('linear.target')}</span>
        {sessions.length === 0 ? (
          <span className="small quiet" title={NO_SESSION}>
            {t('linear.none')}
          </span>
        ) : (
          <select className="session-select inline" value={targetId} onChange={event => setTarget(event.target.value)}>
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.project} ({s.id.slice(0, 8)})
              </option>
            ))}
          </select>
        )}
      </div>
      {sessions.length === 0 && <p className="quiet small">{NO_SESSION}</p>}
      {loading && <p className="quiet">{t('linear.loading')}</p>}
      {error && (
        <p className="error">
          {t('linear.error')}
          <span className="quiet small block-line">{error}</span>
        </p>
      )}
      {!loading && !error && issues.length === 0 && <p className="quiet">{t('linear.empty')}</p>}
      <table className="history">
        <tbody>
          {issues.map(issue => {
            const key = issue.identifier ?? issue.id ?? ''
            return (
              <tr key={key}>
                <td className="mono">{issue.identifier}</td>
                <td>
                  {issue.title}
                  <div className="quiet small">
                    {[nameOf(issue.state), nameOf(issue.team), nameOf(issue.assignee)].filter(Boolean).join(', ')}
                  </div>
                </td>
                <td>
                  <button
                    className="link"
                    disabled={!targetId || sent.includes(key)}
                    title={targetId ? undefined : NO_SESSION}
                    onClick={() => void send(issue)}
                  >
                    {sent.includes(key) ? t('linear.sentShort') : t('linear.send')}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

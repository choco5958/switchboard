import { useEffect, useState } from 'react'
import type { PastSession, PastSessions } from '../../../shared/types'
import { ago } from '../model'
import { RESUME_SESSION } from '../parts'
import { t } from '../../../shared/i18n'
import { Icon } from '../Icons'
import { Badge, Button, Card, EmptyState, Input, Notice } from '../ui'

// Asks again after a short pause in typing, not at every key.
const TYPING_PAUSE_MS = 150

function resume(session: PastSession) {
  window.dispatchEvent(new CustomEvent(RESUME_SESSION, { detail: { cwd: session.cwd, session: session.id } }))
}

function SessionItem({ session, running }: { session: PastSession; running: boolean }) {
  const title = session.title || t('sessions.untitled')
  return (
    <li>
      <Card pad="sm" className="past-session">
        <div className="past-session-main">
          <div className="past-session-title">{title}</div>
          {session.snippet && session.snippet !== session.title && <div className="past-session-snippet quiet small">{session.snippet}</div>}
          <div className="past-session-meta small quiet">
            <span title={session.cwd || session.folder}>{session.project}</span>
            {session.branch && (
              <Badge mono className="past-session-branch">
                {session.branch}
              </Badge>
            )}
            <span>{ago(session.updatedAt)}</span>
            <span>{t(session.approximate ? 'sessions.messagesApprox' : 'sessions.messages', { n: session.messages })}</span>
          </div>
        </div>
        {running ? (
          <Badge tone="good" shape="pill" title={t('sessions.runningTitle')}>
            {t('sessions.running')}
          </Badge>
        ) : (
          <Button
            size="sm"
            disabled={!session.cwd}
            title={session.cwd ? t('sessions.resumeTitle', { cwd: session.cwd }) : t('sessions.noCwd')}
            onClick={() => resume(session)}
          >
            <Icon name="dock" size="sm" />
            {t('session.resume')}
          </Button>
        )}
      </Card>
    </li>
  )
}

// Past Claude Code conversations on this computer, to find one and continue it in the dock
// (Dock.tsx handles RESUME_SESSION). running: ids of Claude Code sessions connected now, which
// show as running instead of offering a second copy of the same conversation. Optional.
export function SessionsPage({ running = [] }: { running?: readonly string[] }) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<PastSessions | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    // A newer query asked before the last answer came back: that late answer is for the old query.
    let stale = false
    const timer = setTimeout(
      () => {
        window.ide.sessionHistory(query).then(
          reply => {
            if (stale) return
            setResult(reply)
            setError('')
          },
          (err: unknown) => {
            if (!stale) setError(err instanceof Error ? err.message : String(err))
          },
        )
      },
      query ? TYPING_PAUSE_MS : 0,
    )
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query])

  const sessions = result?.sessions ?? []
  return (
    <div className="card wide">
      <h1>{t('rail.sessions')}</h1>
      <p className="quiet small">{t('sessions.intro')}</p>
      <Input
        autoFocus
        type="search"
        className="past-sessions-search"
        value={query}
        maxLength={200}
        placeholder={t('sessions.search')}
        aria-label={t('sessions.search')}
        onChange={event => setQuery(event.target.value)}
      />
      {error && <Notice tone="error" title={t('sessions.error', { error })} />}
      {!result && !error && <p className="quiet">{t('sessions.loading')}</p>}
      {result && sessions.length === 0 && (
        <EmptyState>{result.total === 0 || !query.trim() ? t('sessions.none') : t('sessions.noMatch', { query: query.trim() })}</EmptyState>
      )}
      {sessions.length > 0 && (
        <>
          <p className="quiet small" aria-live="polite">
            {t('sessions.shown', { shown: sessions.length, total: result?.total ?? 0 })}
          </p>
          <ul className="past-sessions">
            {sessions.map(session => (
              <SessionItem key={session.id} session={session} running={running.includes(session.id)} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

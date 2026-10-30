import { useCallback, useEffect, useState } from 'react'
import { t, type Key } from '../../../shared/i18n'
import type { UpdateStatus } from '../../../shared/types'
import { Button, Notice } from '../ui'

const RELEASES_URL = 'https://github.com/choco5958/switchboard/releases/latest'

// What each state says under the version line (src/main/updater.ts UpdateStatus).
const SAYS: Record<UpdateStatus['state'], Key> = {
  off: 'updates.off',
  idle: 'updates.idle',
  checking: 'updates.checking',
  latest: 'updates.latest',
  downloading: 'updates.downloading',
  ready: 'updates.ready',
  manual: 'updates.manual',
  refused: 'updates.refused',
  error: 'updates.failed',
}

// The app's version, where its update stands, and a check now. The app also checks at start
// and every 6 hours.
export function UpdateSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  // A first read that failed says so, with a way to try again, instead of leaving no section at all.
  const [loadError, setLoadError] = useState('')
  const load = useCallback(() => {
    setLoadError('')
    window.ide.updateStatus().then(setStatus, (error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)))
  }, [])
  useEffect(() => {
    load()
    return window.ide.onUpdateStatus(next => {
      setLoadError('')
      setStatus(next)
    })
  }, [load])
  if (!status)
    return (
      <section id="settings-update" className="settings-row settings-update">
        <h2>{t('updates.title')}</h2>
        {loadError ? (
          <Notice
            tone="error"
            action={
              <Button size="sm" className="load-retry" onClick={load}>
                {t('common.retry')}
              </Button>
            }
          >
            <span className="small">{t('updates.loadFailed', { error: loadError })}</span>
          </Notice>
        ) : (
          <p className="quiet small">{t('common.loading')}</p>
        )}
      </section>
    )
  const { state } = status
  const busy = state === 'checking' || state === 'downloading'
  const checkedAt = status.checkedAt ? new Date(status.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  return (
    <section id="settings-update" className="settings-row settings-update">
      <h2>{t('updates.title')}</h2>
      <p className="small">{t('updates.current', { version: status.version })}</p>
      <p className="quiet small" role="status">
        {t(SAYS[state], { version: status.latest ?? '', time: checkedAt, error: status.error ?? '' })}
      </p>
      <div className="settings-actions">
        {state === 'ready' ? (
          <Button variant="primary" onClick={() => void window.ide.updateInstall()}>
            {t('update.installNow')}
          </Button>
        ) : (
          state !== 'off' && (
            <Button disabled={busy} onClick={() => void window.ide.updateCheck().then(setStatus)}>
              {t('updates.check')}
            </Button>
          )
        )}
        {(state === 'off' || state === 'manual' || state === 'refused' || state === 'error') && (
          <Button variant="link" size="sm" onClick={() => window.open(RELEASES_URL)}>
            {t('updates.releases')}
          </Button>
        )}
      </div>
      {state !== 'off' && <p className="quiet small">{t('updates.auto')}</p>}
    </section>
  )
}

import { useEffect, useState } from 'react'
import { t, type Key } from '../../../shared/i18n'
import type { UpdateStatus } from '../../../shared/types'

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
  useEffect(() => {
    void window.ide.updateStatus().then(setStatus)
    return window.ide.onUpdateStatus(setStatus)
  }, [])
  if (!status) return null
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
          <button className="primary" onClick={() => void window.ide.updateInstall()}>
            {t('update.installNow')}
          </button>
        ) : (
          state !== 'off' && (
            <button disabled={busy} onClick={() => void window.ide.updateCheck().then(setStatus)}>
              {t('updates.check')}
            </button>
          )
        )}
        {(state === 'off' || state === 'manual' || state === 'refused' || state === 'error') && (
          <button className="link small" onClick={() => window.open(RELEASES_URL)}>
            {t('updates.releases')}
          </button>
        )}
      </div>
      {state !== 'off' && <p className="quiet small">{t('updates.auto')}</p>}
    </section>
  )
}

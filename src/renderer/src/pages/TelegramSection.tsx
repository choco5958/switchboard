import { useCallback, useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'
import { useToast } from '../parts'

// Settings: the person's own Telegram bot for answering decisions away from the desk
// (bridge/telegram.ts). The token goes to the bridge and never comes back to this screen.

type Status = { configured: boolean; bot: string; paired: boolean; name: string; code: string }

export function TelegramSection() {
  const toast = useToast()
  const [status, setStatus] = useState<Status | null>(null)
  const [token, setToken] = useState('')
  const [pair, setPair] = useState<{ code: string; link: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const reply = await window.ide.bridge('GET', '/telegram')
    if (reply.ok) setStatus(reply.json as unknown as Status)
  }, [])
  useEffect(() => {
    void load()
    return window.ide.onChange(event => {
      if (event.type === 'telegram') {
        setPair(null)
        void load()
      }
    })
  }, [load])

  const post = async (path: string, body?: unknown) => {
    setBusy(true)
    const reply = await window.ide.bridge('POST', path, body)
    setBusy(false)
    if (!reply.ok) toast(String(reply.json.error ?? reply.status), 'bad')
    return reply
  }

  if (!status) return null
  return (
    <section className="settings-row telegram">
      <h2>{t('telegram.title')}</h2>
      <p className="quiet small">{t('telegram.hint')}</p>
      {!status.configured && (
        <>
          <ol className="small telegram-steps">
            <li>{t('telegram.step1')}</li>
            <li>{t('telegram.step2')}</li>
            <li>{t('telegram.step3')}</li>
          </ol>
          <div className="telegram-token">
            <input type="password" autoComplete="off" placeholder="123456:ABC..." value={token} onChange={e => setToken(e.target.value)} />
            <button
              className="primary"
              disabled={busy || !token.trim()}
              onClick={async () => {
                const reply = await post('/telegram/token', { token: token.trim() })
                if (reply.ok) setToken('')
                void load()
              }}
            >
              {t('telegram.connectBot')}
            </button>
          </div>
        </>
      )}
      {status.configured && (
        <div className="telegram-status">
          <p className="small">
            {t('telegram.bot', { bot: status.bot ? `@${status.bot}` : '-' })}
            {status.paired ? `, ${t('telegram.pairedWith', { name: status.name || '-' })}` : ''}
          </p>
          {!status.paired && !pair && (
            <button disabled={busy} onClick={async () => setPair(((await post('/telegram/pair')).json as { code: string; link: string }) ?? null)}>
              {t('telegram.getCode')}
            </button>
          )}
          {!status.paired && pair && (
            <p className="small">
              {pair.link ? (
                <>
                  {t('telegram.openLink')} <a href={pair.link} target="_blank" rel="noreferrer">{pair.link}</a>
                </>
              ) : (
                t('telegram.sendCode', { code: pair.code })
              )}
            </p>
          )}
          <div className="actions">
            {status.paired && (
              <button disabled={busy} onClick={() => void post('/telegram/test').then(r => r.ok && toast(t('telegram.testSent')))}>
                {t('telegram.sendTest')}
              </button>
            )}
            {status.paired && (
              <button disabled={busy} onClick={() => void post('/telegram/unpair')}>
                {t('telegram.unpair')}
              </button>
            )}
            <button disabled={busy} onClick={() => void post('/telegram/token', { token: null }).then(() => load())}>
              {t('telegram.forget')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

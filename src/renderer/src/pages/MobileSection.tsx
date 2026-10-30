import { useCallback, useEffect, useState } from 'react'
import qrcode from 'qrcode-generator'
import { agoText, t } from '../../../shared/i18n'
import { useToast } from '../parts'

// Settings: phones that open the bridge's phone page (bridge/mobile.ts). Each phone is paired
// with a QR code that carries its own key; the bridge never hands the key out again, so the
// code is shown once.

type Address = { address: string; kind: 'name' | 'lan' | 'tailscale' | 'https'; url: string }
type Device = { id: number; name: string; created_at: number; last_seen: number | null }
type Tailscale = { installed: boolean; domain: string; served: boolean; busy: boolean; funnel: boolean; funnelAllowed: boolean; funnelLink: string }
type Status = { enabled: boolean; listening: boolean; port: number; error: string; lan: boolean; addresses: Address[]; devices: Device[]; tailscale: Tailscale }

// The link the QR code holds: the key is in the fragment, which the browser never sends.
export function pairLink(base: string, id: number, key: string): string {
  return `${base}/#pair=${id}.${key}`
}

const KIND_LABEL = { name: 'mobile.name', https: 'mobile.https', tailscale: 'mobile.tailscale' } as const
const TAILSCALE_DNS = 'https://login.tailscale.com/admin/dns'

// Text with its https links made clickable (they open in the person's browser).
function LinkedText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(https:\/\/[^\s)]+)/)
  return (
    <p className={className}>
      {parts.map((part, i) =>
        /^https:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </p>
  )
}

function QrCode({ text }: { text: string }) {
  const code = qrcode(0, 'M')
  code.addData(text)
  code.make()
  const size = code.getModuleCount()
  const cells: string[] = []
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (code.isDark(row, col)) cells.push(`M${col + 4},${row + 4}h1v1h-1z`)
  return (
    <svg className="mobile-qr" viewBox={`0 0 ${size + 8} ${size + 8}`} role="img" aria-label="QR">
      <rect width={size + 8} height={size + 8} fill="#fff" />
      <path d={cells.join('')} fill="#000" />
    </svg>
  )
}

export function MobileSection() {
  const toast = useToast()
  const [status, setStatus] = useState<Status | null>(null)
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [shown, setShown] = useState<{ id: number; key: string; code: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  // A Tailscale failure, kept on screen: its text often names a page to open.
  const [tailscaleError, setTailscaleError] = useState('')

  const load = useCallback(async () => {
    const reply = await window.ide.bridge('GET', '/mobile')
    if (reply.ok) {
      setStatus(reply.json as unknown as Status)
      setLoadError('')
    } else setLoadError(String(reply.json.error ?? reply.status))
  }, [])
  useEffect(() => {
    void load()
    // Last seen times change without an event.
    const timer = setInterval(() => void load(), 15_000)
    const off = window.ide.onChange(event => event.type === 'mobile' && void load())
    return () => {
      clearInterval(timer)
      off()
    }
  }, [load])

  const post = async (path: string, body?: unknown) => {
    setBusy(true)
    const reply = await window.ide.bridge('POST', path, body)
    setBusy(false)
    if (!reply.ok) toast(String(reply.json.error ?? reply.status), 'bad')
    return reply
  }

  if (!status) {
    if (!loadError) return null
    return (
      <section id="settings-mobile" className="settings-row mobile">
        <h2>{t('mobile.title')}</h2>
        <p className="error small">{t('mobile.loadFailed', { error: loadError })}</p>
      </section>
    )
  }
  const chosen = status.addresses.find(a => a.address === address) ?? status.addresses[0]
  return (
    <section id="settings-mobile" className="settings-row mobile">
      <h2>{t('mobile.title')}</h2>
      <p className="quiet small">{t('mobile.hint')}</p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={busy}
          onChange={async e => {
            const reply = await post('/mobile', { enabled: e.target.checked })
            if (reply.ok) setStatus(s => (s ? { ...s, ...(reply.json as unknown as Status) } : s))
            if (!e.target.checked) setShown(null)
          }}
        />
        {t('mobile.enable')}
      </label>
      {status.enabled && (
        <p className="small">
          {status.listening ? t('mobile.listening', { port: status.port }) : status.error ? <span className="error">{t('mobile.error', { error: status.error })}</span> : t('mobile.off')}
        </p>
      )}
      {status.enabled && status.listening && (
        <div className="mobile-pair">
          {status.addresses.length === 0 ? (
            // This computer only and no Tailscale HTTPS yet: the button below makes the address.
            status.lan && <p className="quiet small">{t('mobile.noAddress')}</p>
          ) : (
            <>
              <label className="small">
                {t('mobile.address')}{' '}
                <select value={chosen?.address ?? ''} onChange={e => setAddress(e.target.value)}>
                  {status.addresses.map(a => (
                    <option key={a.url} value={a.address}>
                      {a.address}
                      {a.kind !== 'lan' ? ` (${t(a.kind === 'https' && status.tailscale.funnel ? 'mobile.httpsFunnel' : KIND_LABEL[a.kind])})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              {chosen?.kind === 'name' && <p className="quiet small">{t('mobile.nameHint')}</p>}
              {!shown && (
                <div className="mobile-add actions">
                  <input placeholder={t('mobile.namePlaceholder')} aria-label={t('mobile.deviceName')} value={name} maxLength={60} onChange={e => setName(e.target.value)} />
                  <button
                    className="primary"
                    disabled={busy || !chosen}
                    onClick={async () => {
                      const reply = await post('/mobile/pair', { name: name.trim() })
                      if (reply.ok) {
                        setShown(reply.json as unknown as { id: number; key: string; code: string })
                        setName('')
                      }
                    }}
                  >
                    {t('mobile.add')}
                  </button>
                </div>
              )}
              {shown && chosen && (
                <div className="mobile-shown">
                  <QrCode text={pairLink(chosen.url, shown.id, shown.key)} />
                  <div>
                    <p className="small">{t('mobile.scan')}</p>
                    {shown.code && <p className="small">{t('mobile.code', { code: `${shown.code.slice(0, 4)}-${shown.code.slice(4)}` })}</p>}
                    <div className="actions">
                      <button onClick={() => setShown(null)}>{t('mobile.done')}</button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
          {status.lan && <p className="quiet small">{t('mobile.firewall')}</p>}
          {status.lan && <p className="quiet small">{t('mobile.strongNote')}</p>}
          {status.tailscale.installed && status.tailscale.domain ? (
            <div className="mobile-tailscale">
              <p className="quiet small">{t('mobile.tailscaleHint')}</p>
              <div className="actions">
                <button
                  disabled={busy || (!status.tailscale.served && status.tailscale.busy)}
                  onClick={async () => {
                    setBusy(true)
                    const reply = await window.ide.bridge('POST', '/mobile/tailscale', { on: !status.tailscale.served })
                    setBusy(false)
                    if (reply.ok) {
                      setStatus(reply.json as unknown as Status)
                      setTailscaleError('')
                    } else setTailscaleError(String(reply.json.error ?? reply.status))
                  }}
                >
                  {status.tailscale.served ? t('mobile.tailscaleOff') : t('mobile.tailscaleOn')}
                </button>
              </div>
              {!status.tailscale.served && status.tailscale.busy && <p className="quiet small">{t('mobile.tailscaleBusy')}</p>}
              {status.tailscale.served && (
                <>
                  <label className="check-row" title={t('mobile.funnelHint')}>
                    <input
                      type="checkbox"
                      checked={status.tailscale.funnel}
                      disabled={busy}
                      onChange={async e => {
                        setBusy(true)
                        const reply = await window.ide.bridge('POST', '/mobile/tailscale', { on: true, funnel: e.target.checked })
                        setBusy(false)
                        if (reply.ok) {
                          setStatus(reply.json as unknown as Status)
                          setTailscaleError('')
                        } else setTailscaleError(String(reply.json.error ?? reply.status))
                      }}
                    />
                    {t('mobile.funnel')}
                  </label>
                  <p className="quiet small">{t(status.tailscale.funnel ? 'mobile.funnelOnNote' : 'mobile.funnelHint')}</p>
                  {!status.tailscale.funnelAllowed && !status.tailscale.funnel && (
                    <p className="quiet small">
                      {t('mobile.funnelAllowFirst')}{' '}
                      <a href={status.tailscale.funnelLink} target="_blank" rel="noreferrer">
                        {t('mobile.funnelAllow')}
                      </a>
                    </p>
                  )}
                </>
              )}
              {tailscaleError && <LinkedText className="error small" text={tailscaleError} />}
            </div>
          ) : status.tailscale.installed ? (
            <p className="quiet small">
              {t('mobile.tailscaleLogin')}{' '}
              <a href={TAILSCALE_DNS} target="_blank" rel="noreferrer">
                {t('mobile.tailscaleAdmin')}
              </a>
            </p>
          ) : (
            <p className="quiet small">{t('mobile.outside')}</p>
          )}
          <label className="check-row" title={t('mobile.lanHint')}>
            <input
              type="checkbox"
              checked={status.lan}
              disabled={busy}
              onChange={async e => {
                const reply = await post('/mobile', { lan: e.target.checked })
                if (reply.ok) setStatus(reply.json as unknown as Status)
              }}
            />
            {t('mobile.lan')}
          </label>
          <p className="quiet small">{t('mobile.lanHint')}</p>
        </div>
      )}
      <h3 className="small">{t('mobile.devices')}</h3>
      {status.devices.length === 0 ? (
        <p className="quiet small">{t('mobile.noDevices')}</p>
      ) : (
        <ul className="mobile-devices">
          {status.devices.map(d => (
            <li key={d.id}>
              <span>{d.name}</span>
              <span className="quiet small">{d.last_seen ? t('mobile.lastSeen', { time: agoText(Date.now() - d.last_seen) }) : t('mobile.never')}</span>
              <button className="link small" disabled={busy} onClick={() => void post(`/mobile/devices/${d.id}/revoke`).then(load)}>
                {t('mobile.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

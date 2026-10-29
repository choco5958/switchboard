import { useCallback, useEffect, useState } from 'react'
import qrcode from 'qrcode-generator'
import { agoText, t } from '../../../shared/i18n'
import { useToast } from '../parts'

// Settings: phones that open the bridge's phone page (bridge/mobile.ts). Each phone is paired
// with a QR code that carries its own key; the bridge never hands the key out again, so the
// code is shown once.

type Address = { address: string; kind: 'name' | 'lan' | 'tailscale' | 'https'; url: string }
type Device = { id: number; name: string; created_at: number; last_seen: number | null }
type Tailscale = { installed: boolean; domain: string; served: boolean; busy: boolean }
type Status = { enabled: boolean; listening: boolean; port: number; error: string; lan: boolean; addresses: Address[]; devices: Device[]; tailscale: Tailscale }

// The link the QR code holds: the key is in the fragment, which the browser never sends.
export function pairLink(base: string, id: number, key: string): string {
  return `${base}/#pair=${id}.${key}`
}

const KIND_LABEL = { name: 'mobile.name', https: 'mobile.https', tailscale: 'mobile.tailscale' } as const

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
  const [shown, setShown] = useState<{ id: number; key: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const reply = await window.ide.bridge('GET', '/mobile')
    if (reply.ok) setStatus(reply.json as unknown as Status)
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

  if (!status) return null
  const chosen = status.addresses.find(a => a.address === address) ?? status.addresses[0]
  return (
    <section className="settings-row mobile">
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
                      {a.kind !== 'lan' ? ` (${t(KIND_LABEL[a.kind])})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              {!shown && (
                <div className="mobile-add actions">
                  <input placeholder={t('mobile.namePlaceholder')} aria-label={t('mobile.deviceName')} value={name} maxLength={60} onChange={e => setName(e.target.value)} />
                  <button
                    className="primary"
                    disabled={busy || !chosen}
                    onClick={async () => {
                      const reply = await post('/mobile/pair', { name: name.trim() })
                      if (reply.ok) {
                        setShown(reply.json as unknown as { id: number; key: string })
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
                    <div className="actions">
                      <button onClick={() => setShown(null)}>{t('mobile.done')}</button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
          {status.lan && <p className="quiet small">{t('mobile.firewall')}</p>}
          {status.tailscale.installed && status.tailscale.domain ? (
            <div className="mobile-tailscale">
              <p className="quiet small">{t('mobile.tailscaleHint')}</p>
              <div className="actions">
                <button
                  disabled={busy || (!status.tailscale.served && status.tailscale.busy)}
                  onClick={async () => {
                    const reply = await post('/mobile/tailscale', { on: !status.tailscale.served })
                    if (reply.ok) setStatus(reply.json as unknown as Status)
                  }}
                >
                  {status.tailscale.served ? t('mobile.tailscaleOff') : t('mobile.tailscaleOn')}
                </button>
              </div>
              {!status.tailscale.served && status.tailscale.busy && <p className="quiet small">{t('mobile.tailscaleBusy')}</p>}
            </div>
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

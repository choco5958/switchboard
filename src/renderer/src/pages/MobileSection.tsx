import { useCallback, useEffect, useState } from 'react'
import qrcode from 'qrcode-generator'
import { agoText, t } from '../../../shared/i18n'
import { useToast } from '../parts'
import { Button, Input, More, Notice, Select } from '../ui'

// Settings: phones that open the bridge's phone page (bridge/mobile.ts). Each phone is paired
// with a QR code that carries its own key; the bridge never hands the key out again, so the
// code is shown once. The bridge is told which address the QR code links to: a key that goes
// out in a plain HTTP link may not allow or write later, so one shown key never moves to
// another address (changing the address hides it).

type Address = { address: string; kind: 'name' | 'lan' | 'tailscale' | 'https'; url: string }
type Device = { id: number; name: string; created_at: number; last_seen: number | null; strong: boolean; code: boolean }
type Tailscale = { installed: boolean; domain: string; served: boolean; busy: boolean; funnel: boolean; funnelAllowed: boolean; funnelLink: string }
type Status = { enabled: boolean; listening: boolean; port: number; error: string; lan: boolean; addresses: Address[]; devices: Device[]; tailscale: Tailscale }

// The link the QR code holds: the key is in the fragment, which the browser never sends.
export function pairLink(base: string, id: number, key: string): string {
  return `${base}/#pair=${id}.${key}`
}

const KIND_LABEL = { name: 'mobile.name', https: 'mobile.https', tailscale: 'mobile.tailscale' } as const
const TAILSCALE_DNS = 'https://login.tailscale.com/admin/dns'
const REVOKE_ARMED_MS = 4000

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
  // `url`: the address this key was paired for, the only one its QR code may link to.
  const [shown, setShown] = useState<{ id: number; key: string; code: string; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  // A Tailscale failure, kept on screen: its text often names a page to open.
  const [tailscaleError, setTailscaleError] = useState('')
  // The phone whose Disconnect was pressed once; a few seconds later the button is plain again.
  const [revoking, setRevoking] = useState<number | null>(null)
  useEffect(() => {
    if (revoking === null) return
    const timer = setTimeout(() => setRevoking(null), REVOKE_ARMED_MS)
    return () => clearTimeout(timer)
  }, [revoking])

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

  const chosen = status ? (status.addresses.find(a => a.address === address) ?? status.addresses[0]) : undefined
  // Another address picked (or the list changed under the QR code): that key stays with its own.
  useEffect(() => {
    if (shown && chosen?.url !== shown.url) setShown(null)
  }, [shown, chosen?.url])

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
        <Notice tone="error">
          <span className="small">{t('mobile.loadFailed', { error: loadError })}</span>
        </Notice>
      </section>
    )
  }
  const showing = shown && chosen && shown.url === chosen.url ? shown : null
  // The code goes once it is used, its phone comes with the QR code, or ten minutes pass.
  const codeOpen = showing ? (status.devices.find(d => d.id === showing.id)?.code ?? false) : false
  const setTailscale = async (body: { on: boolean; funnel?: boolean }) => {
    setBusy(true)
    const reply = await window.ide.bridge('POST', '/mobile/tailscale', body)
    setBusy(false)
    if (reply.ok) {
      setStatus(reply.json as unknown as Status)
      setTailscaleError('')
    } else setTailscaleError(String(reply.json.error ?? reply.status))
  }

  // Disconnecting takes a second press on the same button; it can not be undone from here.
  const revoke = async (device: Device) => {
    if (revoking !== device.id) return setRevoking(device.id)
    setRevoking(null)
    const reply = await post(`/mobile/devices/${device.id}/revoke`)
    await load()
    if (reply.ok) toast(t('mobile.revokedDone', { name: device.name }))
  }

  return (
    <section id="settings-mobile" className="settings-row mobile">
      <h2>{t('mobile.title')}</h2>
      <p className="quiet small">
        {t('mobile.hint')}
        <More>{t('mobile.hintMore')}</More>
      </p>
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
        <>
          {/* The way that does everything comes first: Tailscale HTTPS. */}
          <div className="mobile-step">
            <h3 className="settings-sub">{t('mobile.recommended')}</h3>
            <p className="quiet small">{t('mobile.recommendedWhy')}</p>
            {status.tailscale.installed && status.tailscale.domain ? (
              <div className="mobile-tailscale">
                <p className="quiet small">{t('mobile.tailscaleHint')}</p>
                <div className="actions">
                  <Button
                    variant={status.tailscale.served ? 'default' : 'primary'}
                    disabled={busy || (!status.tailscale.served && status.tailscale.busy)}
                    onClick={() => void setTailscale({ on: !status.tailscale.served })}
                  >
                    {status.tailscale.served ? t('mobile.tailscaleOff') : t('mobile.tailscaleOn')}
                  </Button>
                </div>
                {!status.tailscale.served && status.tailscale.busy && <p className="quiet small">{t('mobile.tailscaleBusy')}</p>}
                {status.tailscale.served && (
                  <>
                    <label className="check-row" title={t('mobile.funnelHint')}>
                      <input type="checkbox" checked={status.tailscale.funnel} disabled={busy} onChange={e => void setTailscale({ on: true, funnel: e.target.checked })} />
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
              </div>
            ) : status.tailscale.installed ? (
              <p className="quiet small">
                {t('mobile.tailscaleLogin')}{' '}
                <a href={TAILSCALE_DNS} target="_blank" rel="noreferrer">
                  {t('mobile.tailscaleAdmin')}
                </a>
              </p>
            ) : (
              <p className="quiet small">
                {t('mobile.outside')}
                <More>{t('mobile.outsideMore')}</More>
              </p>
            )}
            {tailscaleError && <LinkedText className="error small" text={tailscaleError} />}
          </div>

          {(status.addresses.length > 0 || status.lan) && (
            <div className="mobile-step mobile-pair">
              <h3 className="settings-sub">{t('mobile.pairTitle')}</h3>
              {status.addresses.length === 0 ? (
                // This computer only and no Tailscale HTTPS yet: the button above makes the address.
                <p className="quiet small">{t('mobile.noAddress')}</p>
              ) : (
                <>
                  <label className="small">
                    {t('mobile.address')}{' '}
                    <Select compact value={chosen?.address ?? ''} onChange={e => setAddress(e.target.value)}>
                      {status.addresses.map(a => (
                        <option key={a.url} value={a.address}>
                          {a.address}
                          {a.kind !== 'lan' ? ` (${t(a.kind === 'https' && status.tailscale.funnel ? 'mobile.httpsFunnel' : KIND_LABEL[a.kind])})` : ''}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {chosen?.kind === 'name' && <p className="quiet small">{t('mobile.nameHint')}</p>}
                  {!showing && (
                    <div className="mobile-add actions">
                      <Input placeholder={t('mobile.namePlaceholder')} aria-label={t('mobile.deviceName')} value={name} maxLength={60} onChange={e => setName(e.target.value)} />
                      <Button
                        variant="primary"
                        disabled={busy || !chosen}
                        onClick={async () => {
                          if (!chosen) return
                          const reply = await post('/mobile/pair', { name: name.trim(), kind: chosen.kind })
                          if (reply.ok) {
                            // The new phone in the list first, so its open code shows.
                            await load()
                            setAddress(chosen.address)
                            setShown({ ...(reply.json as unknown as { id: number; key: string; code: string }), url: chosen.url })
                            setName('')
                          }
                        }}
                      >
                        {t('mobile.add')}
                      </Button>
                    </div>
                  )}
                  {showing && (
                    <div className="mobile-shown">
                      <QrCode text={pairLink(showing.url, showing.id, showing.key)} />
                      <div>
                        <p className="small">{t('mobile.scan')}</p>
                        {showing.code && codeOpen && <p className="small">{t('mobile.code', { code: `${showing.code.slice(0, 4)}-${showing.code.slice(4)}` })}</p>}
                        {showing.code && !codeOpen && <p className="quiet small">{t('mobile.codeGone')}</p>}
                        <div className="actions">
                          <Button onClick={() => setShown(null)}>{t('mobile.done')}</Button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* The plain Wi-Fi address: works without Tailscale, with less allowed; folded away. */}
          <details className="mobile-advanced">
            <summary>{t('mobile.advanced')}</summary>
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
            {status.lan && <p className="quiet small">{t('mobile.firewall')}</p>}
            {status.lan && (
              <p className="quiet small">
                {t('mobile.strongNote')}
                <More>{t('mobile.strongNoteMore')}</More>
              </p>
            )}
          </details>
        </>
      )}
      <h3 className="settings-sub">{t('mobile.devices')}</h3>
      {status.devices.length === 0 ? (
        <p className="quiet small">{t('mobile.noDevices')}</p>
      ) : (
        <ul className="mobile-devices">
          {status.devices.map(d => (
            <li key={d.id}>
              <span>{d.name}</span>
              <span className="quiet small">{d.last_seen ? t('mobile.lastSeen', { time: agoText(Date.now() - d.last_seen) }) : t('mobile.never')}</span>
              {!d.strong && <span className="quiet small">{t('mobile.weakDevice')}</span>}
              <Button
                variant={revoking === d.id ? 'danger' : 'link'}
                size="sm"
                className="mobile-revoke"
                disabled={busy}
                onBlur={() => setRevoking(current => (current === d.id ? null : current))}
                onClick={() => void revoke(d)}
              >
                {revoking === d.id ? t('mobile.revokeAgain') : t('mobile.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

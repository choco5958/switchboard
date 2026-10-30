import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentDetect, UpdateStatus } from '../../shared/types'
import { t } from '../../shared/i18n'
import { shortcutGroups } from './shortcuts'
import { AGENTS_FOUND } from './Dock'
import { Button, Chip, Dialog, Notice } from './ui'

// Parts of the app's flows that stand on their own: the shortcut list, the new-version chip,
// and the second step before turning on something that gives sessions broad access.

const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)

// Scroll a settings section into view once the settings tab has drawn it.
export function scrollToSection(id: string, tries = 20): void {
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView({ block: 'start' })
    return
  }
  if (tries > 0) requestAnimationFrame(() => scrollToSection(id, tries - 1))
}

export function ShortcutHelp({ keysAnywhere, onClose }: { keysAnywhere: boolean; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null)
  return (
    <Dialog label={t('keys.title')} onClose={onClose} initial={close} className="shortcut-help">
      <div className="shortcut-head">
        <h2>{t('keys.title')}</h2>
        <Button ref={close} variant="ghost" size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
      <div className="shortcut-body">
        {shortcutGroups(MAC, keysAnywhere).map(group => (
          <section key={group.title} className="shortcut-group">
            <h3>{t(group.title)}</h3>
            {group.note && <p className="quiet small">{t(group.note)}</p>}
            <dl>
              {group.items.map(item => (
                <Fragment key={`${item.label}-${item.keys.join()}`}>
                  <dt>
                    {item.keys.map((k, i) => (
                      <Fragment key={`${k}-${i}`}>
                        {i > 0 && ' '}
                        <kbd>{k}</kbd>
                      </Fragment>
                    ))}
                  </dt>
                  <dd>{t(item.label)}</dd>
                </Fragment>
              ))}
            </dl>
          </section>
        ))}
        <p className="quiet small">{t('keys.typingNote', { key: MAC ? '⌘/' : 'Ctrl+/' })}</p>
      </div>
    </Dialog>
  )
}

// A small chip in the top bar while a new version downloads or waits to install; it opens the
// update section of the settings (src/main/updater.ts sends the status).
export function UpdateChip({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void window.ide.updateStatus?.().then(setStatus, () => undefined)
    return window.ide.onUpdateStatus?.(setStatus)
  }, [])
  if (!status || (status.state !== 'ready' && status.state !== 'downloading')) return null
  const ready = status.state === 'ready'
  const version = status.latest ?? ''
  return (
    <Chip tone={ready ? 'good' : 'neutral'} className="update-chip" title={t(ready ? 'update.chipReadyTitle' : 'update.chipDownloadingTitle', { version })} onClick={onOpen}>
      {t(ready ? 'update.chipReady' : 'update.chipDownloading')}
    </Chip>
  )
}

// Opening a settings section from a screen that does not hold App's tab state (the first run):
// App listens for this event and opens the settings tab at the section named in `detail`.
export const OPEN_SETTINGS = 'switchboard:open-settings'
export const openSettings = (section: string) => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS, { detail: section }))

const SKIP_CONNECT_KEY = 'claude-ide:first-run-connect-skipped'

function connectSkipped(): boolean {
  try {
    return localStorage.getItem(SKIP_CONNECT_KEY) === '1'
  } catch {
    return false
  }
}

// The first run's fourth step: answering away from the desk, by phone or Telegram. Optional, so it
// can be skipped; skipping is remembered on this computer only.
export function ConnectStep() {
  const [skipped, setSkipped] = useState(connectSkipped)
  if (skipped) return null
  const skip = () => {
    setSkipped(true)
    try {
      localStorage.setItem(SKIP_CONNECT_KEY, '1')
    } catch {
      // per-viewer convenience only
    }
  }
  return (
    <li className="first-run-connect">
      <b>{t('home.step4')}</b> <span className="quiet small">{t('home.optional')}</span>
      <p className="quiet">{t('home.step4Body')}</p>
      <div className="first-run-links">
        <Button variant="link" size="sm" className="inline-link" onClick={() => openSettings('settings-mobile')}>
          {t('home.step4Mobile')}
        </Button>
        <Button variant="link" size="sm" className="inline-link" onClick={() => openSettings('settings-telegram')}>
          {t('home.step4Telegram')}
        </Button>
        <Button variant="link" size="sm" className="inline-link quiet" onClick={skip}>
          {t('home.skip')}
        </Button>
      </div>
    </li>
  )
}

// Claude Code is not on this computer's PATH (agents:detect, the same look the dock uses):
// how to install it, and a look again once it is in.
export function ClaudeMissingNotice() {
  const [found, setFound] = useState<AgentDetect | null>(null)
  const [looking, setLooking] = useState(false)
  useEffect(() => {
    void window.ide.detectAgents?.().then(setFound, () => undefined)
    const again = (event: Event) => setFound((event as CustomEvent<AgentDetect>).detail)
    window.addEventListener(AGENTS_FOUND, again)
    return () => window.removeEventListener(AGENTS_FOUND, again)
  }, [])
  if (!found || found.found.claude) return null
  const look = async () => {
    setLooking(true)
    const result = await window.ide.detectAgents(true).finally(() => setLooking(false))
    setFound(result)
    window.dispatchEvent(new CustomEvent(AGENTS_FOUND, { detail: result }))
  }
  return (
    <Notice
      tone="warn"
      title={t('home.claudeMissing')}
      className="claude-missing"
      action={
        <Button size="sm" disabled={looking} onClick={() => void look()}>
          {looking ? t('agents.looking') : t('agents.lookAgain')}
        </Button>
      }
    >
      <span className="small">{t('home.claudeMissingBody')}</span>
      <code className="claude-install">{CLAUDE_INSTALL}</code>
    </Notice>
  )
}

const CLAUDE_INSTALL = 'npm i -g @anthropic-ai/claude-code'

// The second step before turning on a setting that lets sessions reach further than the
// default. The checkbox only asks; this dialog says what changes, and only its button turns it on.
export function RiskyConfirm({ title, children, onConfirm, onClose }: { title: string; children: ReactNode; onConfirm: () => void; onClose: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <Dialog label={title} onClose={onClose} initial={cancel} className="risky-confirm">
      <h2>{title}</h2>
      <div className="risky-body">{children}</div>
      <div className="actions risky-actions">
        <Button ref={cancel} onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            onClose()
            onConfirm()
          }}
        >
          {t('risky.enable')}
        </Button>
      </div>
    </Dialog>
  )
}

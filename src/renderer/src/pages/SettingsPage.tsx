import { useEffect, useRef, useState, type RefObject } from 'react'
import { DEFAULT_THEME, THEMES, applyTheme, themeLabel, themeOf } from '../theme'
import { LANGS, isLang, resolveLang, t, type Key, type Lang } from '../../../shared/i18n'
import { useToast } from '../parts'
import { AgentSettings } from './AgentSettings'
import { RoutinesSection } from './RoutinesSection'
import { TelegramSection } from './TelegramSection'
import { MobileSection } from './MobileSection'
import { UpdateSection } from './UpdateSection'
import type { Routine, RoutineRun } from '../../../shared/types'
import type { ProjectInfo } from '../../../shared/projects'
import { saveSetting } from '../settings'
import { CUSTOM_AGENTS_KEY, customAgents } from '../../../shared/agents'
import { DECISION_KEYS_KEY } from '../QuestionCard'
import { Button, cx, reducedMotion, surfaceClass } from '../ui'

// In the order of the page: answering while away first (Telegram, the phone), then the agents and
// what they run on a schedule, then how the app looks and reads, then updates.
const SECTIONS: [string, Key][] = [
  ['settings-telegram', 'telegram.title'],
  ['settings-mobile', 'mobile.title'],
  ['settings-agents', 'agents.title'],
  ['settings-routines', 'routines.title'],
  ['settings-keys', 'settings.keys'],
  ['settings-theme', 'settings.theme'],
  ['settings-lang', 'settings.language'],
  ['settings-update', 'updates.title'],
  ['settings-dev', 'settings.dev'],
]

// The section being read: the last one whose top has passed a line a little under the table of contents
// that stays at the top of the page. Not scrolled yet, the first; at the very bottom, the last one,
// however short.
export function currentSection(tops: [string, number][], line: number, at: 'top' | 'bottom' | null): string | null {
  if (tops.length === 0) return null
  if (at === 'top') return tops[0]![0]
  if (at === 'bottom') return tops[tops.length - 1]![0]
  let current = tops[0]![0]
  for (const [id, top] of tops) if (top <= line) current = id
  return current
}

// The table of contents follows the scrolling of the page (the main area scrolls, not the window).
function useCurrentSection(toc: RefObject<HTMLElement | null>): string | null {
  const [current, setCurrent] = useState<string | null>(null)
  useEffect(() => {
    const box = toc.current
    const scroller = box?.closest('.main')
    if (!box || !scroller) return
    let frame = 0
    const measure = () => {
      frame = 0
      // A third of the way down what shows under the contents: a section scrolled to (its heading
      // just under them) counts as read, and so does one that fills the view.
      const line = box.getBoundingClientRect().bottom + (scroller.clientHeight - box.offsetHeight) / 3
      const tops = SECTIONS.flatMap(([id]): [string, number][] => {
        const at = document.getElementById(id)
        return at ? [[id, at.getBoundingClientRect().top]] : []
      })
      const at = scroller.scrollTop <= 2 ? 'top' : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 ? 'bottom' : null
      setCurrent(currentSection(tops, line, at))
    }
    const later = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    scroller.addEventListener('scroll', later, { passive: true })
    window.addEventListener('resize', later)
    // Sections that load later (Telegram, the phone) move the others down.
    const grow = new ResizeObserver(later)
    grow.observe(box.parentElement ?? box)
    return () => {
      scroller.removeEventListener('scroll', later)
      window.removeEventListener('resize', later)
      grow.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [toc])
  return current
}

// Tokens shown in each theme's swatch strip. The strip carries data-theme, so it shows that theme's own colors.
const SWATCH = ['--bg', '--panel', '--line', '--text', '--accent', '--good', '--warn', '--bad']

// The gallery is a rail tab; pressing its rail button opens it without reaching into App.
function openGallery() {
  document.querySelector<HTMLButtonElement>('.rail-button[data-rail="gallery"]')?.click()
}

export function SettingsPage({
  settings = {},
  routines = [],
  runs = [],
  projects = [],
}: {
  settings?: Record<string, unknown>
  routines?: Routine[]
  runs?: RoutineRun[]
  projects?: ProjectInfo[]
}) {
  const toast = useToast()
  const toc = useRef<HTMLElement>(null)
  const reading = useCurrentSection(toc)
  const devMenu = settings.devMenu === true
  const saved = themeOf(settings.theme)
  const [chosen, setChosen] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState('')
  const current = chosen ?? saved
  // The pick shows at once; once the saved theme is the same, the saved one rules again, so a
  // theme changed elsewhere (the top bar's light and dark button) shows here too.
  useEffect(() => {
    if (chosen !== null && chosen === saved) setChosen(null)
  }, [chosen, saved])
  const isDefault = settings.theme === undefined && current === DEFAULT_THEME

  const save = async (value: string | null) => {
    const next = themeOf(value)
    setChosen(next)
    applyTheme(next)
    setStatus('saving')
    setError('')
    const reply = await saveSetting('theme', value)
    if (reply.ok) return setStatus('saved')
    setChosen(null)
    applyTheme(saved)
    setStatus('idle')
    setError(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }))
  }

  // Feature area: UI language. The app redraws as soon as the bridge reports the new setting.
  const lang = resolveLang(settings.lang, navigator.language)
  const langSet = isLang(settings.lang)
  const saveLang = async (value: Lang | null) => {
    const reply = await saveSetting('lang', value)
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }

  // The component gallery in the rail is for building the IDE itself; off unless asked for.
  const toggleDevMenu = async () => {
    const reply = await saveSetting('devMenu', devMenu ? null : true)
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }

  // The decision card's single-letter keys: only while the card has focus (the default), or anywhere.
  const keysAnywhere = settings[DECISION_KEYS_KEY] === true
  const toggleKeys = async () => {
    const reply = await saveSetting(DECISION_KEYS_KEY, keysAnywhere ? null : true)
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }

  return (
    <div className="card wide settings">
      <h1>{t('rail.settings')}</h1>
      {/* The page is long: one click to each part. */}
      <nav ref={toc} className="settings-toc" aria-label={t('settings.toc')}>
        {SECTIONS.map(([id, key]) => (
          <Button
            key={id}
            variant="link"
            size="sm"
            className={cx(reading === id && 'on')}
            aria-current={reading === id ? 'location' : undefined}
            onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' })}
          >
            {t(key)}
          </Button>
        ))}
      </nav>
      <TelegramSection />
      <MobileSection />
      <AgentSettings settings={settings} />
      <RoutinesSection routines={routines} runs={runs} projects={projects} customs={customAgents(settings[CUSTOM_AGENTS_KEY])} />
      <section id="settings-keys" className="settings-row settings-keys">
        <h2>{t('settings.keys')}</h2>
        <label className="check-row">
          <input type="checkbox" checked={keysAnywhere} onChange={() => void toggleKeys()} />
          {t('settings.decisionKeysAnywhere')}
          <span className="quiet small">{t('settings.decisionKeysAnywhereHint')}</span>
        </label>
      </section>
      <section id="settings-theme" className="settings-row">
        <h2>{t('settings.theme')}</h2>
        <div className="theme-list">
          {THEMES.map(theme => (
            <button
              key={theme.id}
              type="button"
              className={surfaceClass({ on: theme.id === current }, 'theme-option')}
              aria-pressed={theme.id === current}
              disabled={status === 'saving'}
              onClick={() => void save(theme.id)}
            >
              <span className="swatch" data-theme={theme.id}>
                {SWATCH.map(token => (
                  <i key={token} style={{ background: `var(${token})` }} />
                ))}
              </span>
              <span className="theme-label">
                {themeLabel(theme)} <span className="quiet small mono-inline">({theme.id})</span>
              </span>
              {theme.id === current && <span className="quiet small">{t('settings.inUse')}</span>}
            </button>
          ))}
        </div>
        {(devMenu || import.meta.env.DEV) && (
          <p className="quiet small">
            <Button variant="link" size="sm" className="inline-link" onClick={openGallery}>
              {t('settings.galleryLink')}
            </Button>
          </p>
        )}
        <div className="actions">
          <Button disabled={status === 'saving' || isDefault} onClick={() => void save(null)}>
            {t('settings.defaultTheme')}
          </Button>
          {status === 'saving' && <span className="quiet small">{t('settings.saving')}</span>}
          {status === 'saved' && <span className="answered small">{t('settings.saved')}</span>}
          {error && <span className="error small">{error}</span>}
        </div>
      </section>
      <section id="settings-lang" className="settings-row settings-lang">
        <h2>{t('settings.language')}</h2>
        <div className="lang-list" role="radiogroup" aria-label={t('settings.language')}>
          {LANGS.map(one => (
            <button
              key={one.id}
              type="button"
              role="radio"
              lang={one.id}
              className={surfaceClass({ on: one.id === lang }, 'lang-option')}
              aria-checked={one.id === lang}
              onClick={() => void saveLang(one.id)}
            >
              {one.label}
            </button>
          ))}
        </div>
        <p className="quiet small">
          {langSet ? (
            <Button variant="link" size="sm" className="inline-link" onClick={() => void saveLang(null)}>
              {t('settings.languageSystem')}
            </Button>
          ) : (
            t('settings.languageFollowing')
          )}
        </p>
      </section>
      <UpdateSection />
      <section id="settings-dev" className="settings-row settings-dev">
        <h2>{t('settings.dev')}</h2>
        <label className="check-row">
          <input type="checkbox" checked={devMenu} onChange={() => void toggleDevMenu()} />
          {t('settings.devMenu')}
          <span className="quiet small">{t('settings.devMenuHint')}</span>
        </label>
      </section>
    </div>
  )
}

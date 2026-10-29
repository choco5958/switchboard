import { useState } from 'react'
import { DEFAULT_THEME, THEMES, applyTheme, themeLabel, themeOf } from '../theme'
import { LANGS, isLang, resolveLang, t, type Lang } from '../../../shared/i18n'
import { useToast } from '../parts'
import { AgentSettings } from './AgentSettings'
import { RoutinesSection } from './RoutinesSection'
import type { Routine, RoutineRun } from '../../../shared/types'
import type { ProjectInfo } from '../../../shared/projects'

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
  const devMenu = settings.devMenu === true
  const saved = themeOf(settings.theme)
  const [chosen, setChosen] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState('')
  const current = chosen ?? saved
  const isDefault = settings.theme === undefined && current === DEFAULT_THEME

  const save = async (value: string | null) => {
    const next = themeOf(value)
    setChosen(next)
    applyTheme(next)
    setStatus('saving')
    setError('')
    const reply = await window.ide.bridge('POST', '/settings', { key: 'theme', value })
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
    const reply = await window.ide.bridge('POST', '/settings', { key: 'lang', value })
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }

  // The component gallery in the rail is for building the IDE itself; off unless asked for.
  const toggleDevMenu = async () => {
    const reply = await window.ide.bridge('POST', '/settings', { key: 'devMenu', value: devMenu ? null : true })
    if (!reply.ok) toast(t('common.saveFailed', { error: String(reply.json.error ?? reply.status) }), 'bad')
  }

  return (
    <div className="card wide settings">
      <h1>{t('rail.settings')}</h1>
      <section className="settings-row settings-lang">
        <h2>{t('settings.language')}</h2>
        <div className="lang-list" role="radiogroup" aria-label={t('settings.language')}>
          {LANGS.map(one => (
            <button
              key={one.id}
              role="radio"
              lang={one.id}
              className={`lang-option ${one.id === lang ? 'on' : ''}`}
              aria-checked={one.id === lang}
              onClick={() => void saveLang(one.id)}
            >
              {one.label}
            </button>
          ))}
        </div>
        <p className="quiet small">
          {langSet ? (
            <button className="link small inline-link" onClick={() => void saveLang(null)}>
              {t('settings.languageSystem')}
            </button>
          ) : (
            t('settings.languageFollowing')
          )}
        </p>
      </section>
      <section className="settings-row">
        <h2>{t('settings.theme')}</h2>
        <div className="theme-list">
          {THEMES.map(theme => (
            <button
              key={theme.id}
              className={`theme-option ${theme.id === current ? 'on' : ''}`}
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
            <button className="link small inline-link" onClick={openGallery}>
              {t('settings.galleryLink')}
            </button>
          </p>
        )}
      </section>
      <div className="actions">
        <button disabled={status === 'saving' || isDefault} onClick={() => void save(null)}>
          {t('settings.defaultTheme')}
        </button>
        {status === 'saving' && <span className="quiet small">{t('settings.saving')}</span>}
        {status === 'saved' && <span className="answered small">{t('settings.saved')}</span>}
        {error && <span className="error small">{error}</span>}
      </div>
      <AgentSettings settings={settings} />
      <RoutinesSection routines={routines} runs={runs} projects={projects} />
      <section className="settings-row settings-dev">
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

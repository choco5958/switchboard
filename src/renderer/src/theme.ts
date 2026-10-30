// Themes: one CSS file per theme under ./themes plus one line in THEMES. Every file there is
// bundled; data-theme on <html> picks the active one. See DESIGN_SYSTEM.md at the repo root.
// The base sheet goes first so that a theme rule wins any tie with a base rule of equal specificity.
import './fonts.css'
import './styles.css'
import './theme-files'
import { tOr } from '../../shared/i18n'

export type Theme = { id: string; label: string }

export const THEMES: Theme[] = [
  { id: 'a3', label: '기본 남색' },
  { id: 'a3light', label: '기본 남색 (밝음)' },
  { id: 'a4', label: '모험 일지' },
  { id: 'crt', label: '인광 터미널' },
  { id: 'dotpico', label: '도트 픽셀' },
  { id: 'metro', label: '지하철 노선도' },
  { id: 'pcb', label: '회로 기판' },
  { id: 'tuimod', label: '요즘 터미널' },
  { id: 'tvision', label: '파란 도스 창' },
  // Popular editor colour schemes.
  { id: 'dracula', label: '드라큘라' },
  { id: 'nord', label: '노르드' },
  { id: 'solarizeddark', label: '솔라라이즈드 (어두움)' },
  { id: 'solarizedlight', label: '솔라라이즈드 (밝음)' },
  { id: 'githublight', label: 'GitHub 밝음' },
]

export const DEFAULT_THEME = 'a3'

// A missing or unknown id (a theme that was removed, a bad setting) falls back to the default.
export function themeOf(id: unknown): string {
  return THEMES.some(theme => theme.id === id) ? (id as string) : DEFAULT_THEME
}

// Feature area: UI language. A theme without a dictionary key yet shows its Korean label.
export function themeLabel(theme: Theme): string {
  return tOr(`theme.${theme.id}`, theme.label)
}

export function applyTheme(id: unknown): string {
  const theme = themeOf(id)
  document.documentElement.dataset.theme = theme
  return theme
}

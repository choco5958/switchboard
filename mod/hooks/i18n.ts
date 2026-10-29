import type { EngineInterface as Engine } from 'claude-code'
import { ko, type Dict } from './lang/ko.ts'
import { en } from './lang/en.ts'
import { ja } from './lang/ja.ts'
import { zhCN } from './lang/zh-CN.ts'
import { bridgeFetch } from './link.ts'

// The mod's UI language. It ships alone, so it keeps its own dictionaries
// (lang/ko.ts is the source; the others are typed against it) and follows the
// app's `lang` setting from the bridge's /state.

export type Lang = 'ko' | 'en' | 'ja' | 'zh-CN'
export type Key = keyof Dict
export type Vars = Record<string, string | number>

export const DICTS: Record<Lang, Dict> = { ko, en, ja, 'zh-CN': zhCN }

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && Object.hasOwn(DICTS, value)
}

export function langFromLocale(locale: string | undefined | null): Lang {
  const tag = (locale ?? '').toLowerCase()
  if (tag.startsWith('ko')) return 'ko'
  if (tag.startsWith('ja')) return 'ja'
  if (tag.startsWith('zh')) return 'zh-CN'
  return 'en'
}

// A valid setting wins; unset or unknown follows the locale.
export function resolveLang(setting: unknown, locale: string | undefined | null): Lang {
  return isLang(setting) ? setting : langFromLocale(locale)
}

export function osLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return ''
  }
}

// The language a /state reply asks for.
export function langOfState(raw: unknown, locale: string = osLocale()): Lang {
  const settings = raw !== null && typeof raw === 'object' ? (raw as { settings?: { lang?: unknown } }).settings : undefined
  return resolveLang(settings?.lang, locale)
}

// "{name}" puts a value in; "{n|one|other}" picks a word by the count n (English plurals).
export function format(template: string, vars: Vars = {}): string {
  return template.replace(/\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g, (whole, name: string, one?: string, other?: string) => {
    const value = vars[name]
    if (value === undefined) return whole
    if (one !== undefined) return Number(value) === 1 ? one : (other ?? '')
    return String(value)
  })
}

export function t(lang: Lang, key: Key, vars?: Vars): string {
  return format(DICTS[lang][key] ?? ko[key], vars)
}

// Stored Korean values (the bridge's enums) as labels; a value the dictionary
// does not know passes through.
function label(lang: Lang, prefix: string, value: string): string {
  const key = `${prefix}.${value}`
  return Object.hasOwn(ko, key) ? t(lang, key as Key) : value
}

export const stageLabel = (lang: Lang, value: string): string => label(lang, 'stage', value)
export const taskStatusLabel = (lang: Lang, value: string): string => label(lang, 'taskStatus', value)
export const nodeStatusLabel = (lang: Lang, value: string): string => label(lang, 'nodeStatus', value)
export const kindLabel = (lang: Lang, value: string): string => label(lang, 'kind', value)
export const ownerLabel = (lang: Lang, value: string): string => label(lang, 'owner', value)
export const eventKindLabel = (lang: Lang, value: string): string => label(lang, 'event', value)

// What the mod says outside the pane (prompts, toasts, tool results) goes by
// the last language the bridge named.
let current: Lang = 'ko'

export function currentLang(): Lang {
  return current
}

export function setLang(lang: Lang): void {
  current = lang
}

let starting: Promise<Lang> | undefined

// The language at session start, read once and shared by every hook that
// registers something then; ko when the bridge is not reached.
export function sessionLang($: Engine): Promise<Lang> {
  starting ??= (async () => {
    try {
      const res = await bridgeFetch($, '/state')
      if (!res.ok) return 'ko'
      const lang = langOfState(JSON.parse(res.text) as unknown)
      setLang(lang)
      return lang
    } catch {
      return 'ko'
    }
  })()
  return starting
}

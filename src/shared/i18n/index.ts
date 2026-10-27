// UI language. ko.ts is the source dictionary and its keys define Key; the other
// languages are typed against it, so a missing key is a type error (and a test failure).
// Runs in the renderer, the main process and the bridge (node strips the types), hence the .ts imports.
import { ko, type Dict } from './ko.ts'
import { en } from './en.ts'
import { ja } from './ja.ts'
import { zhCN } from './zh-CN.ts'

export type Lang = 'ko' | 'en' | 'ja' | 'zh-CN'
export type Key = keyof Dict
export type Vars = Record<string, string | number>

// Each language named in itself, for the picker.
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'ko', label: '한국어' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
  { id: 'zh-CN', label: '简体中文' },
]

export const DICTS: Record<Lang, Dict> = { ko, en, ja, 'zh-CN': zhCN }

// BCP 47 tags for Intl and <html lang>.
export const LOCALE_TAG: Record<Lang, string> = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', 'zh-CN': 'zh-CN' }

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && value in DICTS
}

// The OS locale when nothing is set: ko, ja and any Chinese map to their own; the rest reads English.
export function langFromLocale(locale: string | undefined | null): Lang {
  const tag = (locale ?? '').toLowerCase().replace('_', '-')
  if (tag.startsWith('ko')) return 'ko'
  if (tag.startsWith('ja')) return 'ja'
  if (tag.startsWith('zh')) return 'zh-CN'
  return 'en'
}

// The `lang` setting wins; unset or unknown follows the locale.
export function resolveLang(setting: unknown, locale: string | undefined | null): Lang {
  return isLang(setting) ? setting : langFromLocale(locale)
}

let current: Lang = 'ko'

export function setLang(lang: Lang): void {
  current = lang
}

export function getLang(): Lang {
  return current
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

// The placeholder names a template uses, for the dictionary test.
export function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(/\{(\w+)(?:\|[^|}]*\|[^}]*)?\}/g)].map(m => m[1]!))].sort()
}

export function tIn(lang: Lang, key: Key, vars?: Vars): string {
  return format(DICTS[lang][key] ?? ko[key] ?? key, vars)
}

export function t(key: Key, vars?: Vars): string {
  return tIn(current, key, vars)
}

// For ids that may have no key yet (a theme another change added): the fallback shows instead.
export function tOr(key: string, fallback: string, vars?: Vars): string {
  const template = (DICTS[current] as Record<string, string>)[key]
  return template === undefined ? fallback : format(template, vars)
}

// Stored values (task stages, statuses, node fields, event kinds, comment statuses) stay Korean:
// they are API values in the database and the tool enums. Screens show them through these maps;
// a value with no entry (a newer kind, free text) shows as it is.
const STAGE_KEYS: Record<string, Key> = { 요구: 'stage.req', 설계: 'stage.design', 작업: 'stage.work', 완료: 'stage.done' }
const TASK_STATUS_KEYS: Record<string, Key> = { '하는 중': 'taskStatus.running', 대기: 'taskStatus.waiting', 보관: 'taskStatus.archived' }
const NODE_STATUS_KEYS: Record<string, Key> = { 대기: 'nodeStatus.waiting', 지금: 'nodeStatus.now', 끝: 'nodeStatus.done', 실패: 'nodeStatus.failed' }
const NODE_KIND_KEYS: Record<string, Key> = {
  시험: 'nodeKind.test',
  확인: 'nodeKind.check',
  구현: 'nodeKind.build',
  검토: 'nodeKind.review',
  기타: 'nodeKind.other',
}
const NODE_OWNER_KEYS: Record<string, Key> = {
  작업자: 'nodeOwner.worker',
  검토자: 'nodeOwner.reviewer',
  사용자: 'nodeOwner.user',
  오케스트레이터: 'nodeOwner.orchestrator',
}
const EVENT_KIND_KEYS: Record<string, Key> = {
  작업: 'eventKind.task',
  '결정 대기': 'eventKind.question',
  보류: 'eventKind.held',
  답함: 'eventKind.answered',
  전달: 'eventKind.delivered',
  계획: 'eventKind.plan',
  단계: 'eventKind.stage',
  되살림: 'eventKind.restored',
  보관: 'eventKind.archived',
  워크트리: 'eventKind.worktree',
  작업자: 'eventKind.worker',
  시작: 'eventKind.started',
  끝: 'eventKind.done',
  실패: 'eventKind.failed',
  대기: 'eventKind.waiting',
  메시지: 'eventKind.message',
  로그: 'eventKind.log',
  에이전트: 'eventKind.agent',
  '화면 코멘트': 'eventKind.comment',
  '직접 입력': 'eventKind.typed',
}
const COMMENT_STATUS_KEYS: Record<string, Key> = { 열림: 'commentStatus.open', 보냄: 'commentStatus.sent', 해결: 'commentStatus.resolved', 전체: 'commentStatus.all' }

function labelOf(keys: Record<string, Key>, value: string, lang: Lang): string {
  const key = Object.hasOwn(keys, value) ? keys[value] : undefined
  return key ? tIn(lang, key) : value
}

export const stageLabel = (value: string, lang = current): string => labelOf(STAGE_KEYS, value, lang)
export const taskStatusLabel = (value: string, lang = current): string => labelOf(TASK_STATUS_KEYS, value, lang)
export const nodeStatusLabel = (value: string, lang = current): string => labelOf(NODE_STATUS_KEYS, value, lang)
export const nodeKindLabel = (value: string, lang = current): string => labelOf(NODE_KIND_KEYS, value, lang)
export const nodeOwnerLabel = (value: string, lang = current): string => labelOf(NODE_OWNER_KEYS, value, lang)
export const eventKindLabel = (value: string, lang = current): string => labelOf(EVENT_KIND_KEYS, value, lang)
export const commentStatusLabel = (value: string, lang = current): string => labelOf(COMMENT_STATUS_KEYS, value, lang)

// "37초 전" and its kin.
export function agoText(ms: number, lang = current): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return tIn(lang, 'time.secondsAgo', { n: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return tIn(lang, 'time.minutesAgo', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return tIn(lang, 'time.hoursAgo', { n: hours })
  return tIn(lang, 'time.daysAgo', { n: Math.round(hours / 24) })
}

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import {
  DICTS,
  LANGS,
  agoText,
  commentStatusLabel,
  commentStatusSlug,
  eventKindLabel,
  eventKindSlug,
  format,
  getLang,
  langFromLocale,
  nodeKindLabel,
  nodeOwnerLabel,
  nodeStatusLabel,
  nodeStatusSlug,
  placeholders,
  resolveLang,
  setLang,
  stageLabel,
  t,
  tIn,
  tOr,
  taskStatusLabel,
  type Lang,
} from './index'
import { ko } from './ko'

afterEach(() => setLang('ko'))

const OTHERS = LANGS.map(l => l.id).filter(id => id !== 'ko')

describe('dictionaries', () => {
  test('every language has exactly the keys of ko', () => {
    for (const lang of OTHERS) {
      const keys = Object.keys(DICTS[lang]).sort()
      expect(keys, lang).toEqual(Object.keys(ko).sort())
    }
  })

  test('every translation uses the same placeholders as ko', () => {
    const wrong: string[] = []
    for (const lang of OTHERS) {
      for (const [key, value] of Object.entries(ko)) {
        const other = (DICTS[lang] as Record<string, string>)[key] ?? ''
        if (placeholders(other).join() !== placeholders(value).join()) wrong.push(`${lang} ${key}: ${other}`)
      }
    }
    expect(wrong).toEqual([])
  })

  test('no value is empty, and none uses the em dash, the en dash or a middle dot', () => {
    for (const lang of LANGS.map(l => l.id)) {
      for (const [key, value] of Object.entries(DICTS[lang])) {
        expect(value.trim(), `${lang} ${key}`).not.toBe('')
        expect(value, `${lang} ${key}`).not.toMatch(/[—–·・]/)
      }
    }
  })

  test('the product name stays as it is', () => {
    for (const lang of OTHERS) expect(tIn(lang, 'prompt.answer.head', { id: 1 })).toContain('[Switchboard]')
  })

  test('the picker names each language in itself', () => {
    expect(LANGS.map(l => l.label)).toEqual(['한국어', 'English', '日本語', '简体中文'])
  })
})

describe('language choice', () => {
  test('the OS locale picks ko, ja and zh-CN, and English for the rest', () => {
    expect(langFromLocale('ko-KR')).toBe('ko')
    expect(langFromLocale('ko')).toBe('ko')
    expect(langFromLocale('ja-JP')).toBe('ja')
    expect(langFromLocale('zh-TW')).toBe('zh-CN')
    expect(langFromLocale('zh_Hans_CN')).toBe('zh-CN')
    expect(langFromLocale('en-GB')).toBe('en')
    expect(langFromLocale('fr-FR')).toBe('en')
    expect(langFromLocale('')).toBe('en')
    expect(langFromLocale(undefined)).toBe('en')
  })

  test('a valid setting wins over the locale; anything else falls back to it', () => {
    expect(resolveLang('ja', 'ko-KR')).toBe('ja')
    expect(resolveLang('zh-CN', 'en-US')).toBe('zh-CN')
    expect(resolveLang(undefined, 'ko-KR')).toBe('ko')
    expect(resolveLang('de', 'ja-JP')).toBe('ja')
    expect(resolveLang(42, 'fr')).toBe('en')
  })

  test('setLang switches what t() returns', () => {
    expect(t('rail.settings')).toBe('설정')
    setLang('en')
    expect(getLang()).toBe('en')
    expect(t('rail.settings')).toBe('Settings')
    setLang('ja')
    expect(t('rail.settings')).toBe('設定')
    setLang('zh-CN')
    expect(t('rail.settings')).toBe('设置')
  })
})

describe('t() with values', () => {
  test('fills {name} placeholders and leaves unknown ones', () => {
    expect(t('app.askedReport', { id: 'abc' })).toBe('abc 세션에 진행 보고를 요청했습니다.')
    expect(format('{a} and {b}', { a: 1 })).toBe('1 and {b}')
  })

  test('picks the English plural by the count', () => {
    expect(tIn('en', 'app.archivedDone', { n: 1 })).toBe('Moved 1 finished task to the archive.')
    expect(tIn('en', 'app.archivedDone', { n: 3 })).toBe('Moved 3 finished tasks to the archive.')
    expect(tIn('ko', 'app.archivedDone', { n: 3 })).toBe('완료된 작업 3개를 보관함으로 옮겼습니다.')
  })

  test('tOr falls back for ids that have no key', () => {
    expect(tOr('theme.a3', 'x')).toBe('기본 남색')
    expect(tOr('theme.someday', '언젠가')).toBe('언젠가')
  })

  test('relative times', () => {
    expect(agoText(37_000)).toBe('37초 전')
    expect(agoText(37_000, 'en')).toBe('37s ago')
    expect(agoText(5 * 60_000, 'ja')).toBe('5分前')
    expect(agoText(3 * 3_600_000, 'zh-CN')).toBe('3小时前')
    expect(agoText(2 * 86_400_000, 'en')).toBe('2d ago')
  })
})

// Stored values stay Korean; only their labels change.
describe('labels of stored values', () => {
  const cases: [string, (value: string, lang?: Lang) => string, string[], Record<Lang, string[]>][] = [
    ['stage', stageLabel, ['요구', '설계', '작업', '완료'], {
      ko: ['요구', '설계', '구현', '완료'],
      en: ['Requirements', 'Design', 'Work', 'Done'],
      ja: ['要件', '設計', '作業', '完了'],
      'zh-CN': ['需求', '设计', '开发', '完成'],
    }],
    ['task status', taskStatusLabel, ['하는 중', '대기', '보관'], {
      ko: ['진행 중', '대기 중', '보관'],
      en: ['In progress', 'Waiting', 'Archived'],
      ja: ['進行中', '待機中', 'アーカイブ'],
      'zh-CN': ['进行中', '等待中', '已归档'],
    }],
    ['node status', nodeStatusLabel, ['대기', '지금', '끝', '실패'], {
      ko: ['대기 중', '진행 중', '완료', '실패'],
      en: ['Waiting', 'In progress', 'Done', 'Failed'],
      ja: ['待機中', '進行中', '完了', '失敗'],
      'zh-CN': ['等待中', '进行中', '完成', '失败'],
    }],
    ['node kind', nodeKindLabel, ['시험', '확인', '구현', '검토', '기타'], {
      ko: ['시험', '확인', '구현', '검토', '기타'],
      en: ['Test', 'Check', 'Build', 'Review', 'Other'],
      ja: ['テスト', '確認', '実装', 'レビュー', 'その他'],
      'zh-CN': ['测试', '确认', '实现', '评审', '其他'],
    }],
    ['node owner', nodeOwnerLabel, ['작업자', '검토자', '사용자', '오케스트레이터'], {
      ko: ['서브에이전트', '검토자', '사용자', '오케스트레이터'],
      en: ['Subagent', 'Reviewer', 'User', 'Orchestrator'],
      ja: ['サブエージェント', 'レビュアー', 'ユーザー', 'オーケストレーター'],
      'zh-CN': ['子代理', '评审者', '用户', '编排者'],
    }],
    ['comment status', commentStatusLabel, ['열림', '보냄', '해결', '전체'], {
      ko: ['열림', '보냄', '해결', '전체'],
      en: ['Open', 'Sent', 'Resolved', 'All'],
      ja: ['未対応', '送信済み', '解決済み', 'すべて'],
      'zh-CN': ['待处理', '已发送', '已解决', '全部'],
    }],
  ]
  for (const [name, label, values, expected] of cases) {
    test(`${name}: every value in every language, Korean as stored`, () => {
      for (const lang of LANGS.map(l => l.id)) expect(values.map(v => label(v, lang)), lang).toEqual(expected[lang])
    })
  }

  test('event kinds, including the ones sessions and the app write', () => {
    // The stored kind and its Korean label, which may be another word.
    const kinds: Record<string, string> = {
      작업: '작업', '결정 대기': '결정 질문', 보류: '보류', 답함: '답함', 전달: '전달', 계획: '계획', 단계: '단계',
      되살림: '되살림', 보관: '보관', 워크트리: '워크트리', 작업자: '서브에이전트', 시작: '시작', 끝: '완료', 실패: '실패',
      대기: '대기', 메시지: '메시지', 로그: '로그', 에이전트: '에이전트', '화면 코멘트': '화면 코멘트', '직접 입력': '직접 입력',
    }
    for (const [kind, label] of Object.entries(kinds)) {
      expect(eventKindLabel(kind, 'ko')).toBe(label)
      expect(eventKindLabel(kind, 'en')).not.toBe(kind)
    }
    expect(eventKindLabel('결정 대기', 'en')).toBe('Decision needed')
  })

  // The stored words live in the bridge, the mod and the app. Reading them from their sources
  // keeps this check from going stale when one of them adds a value.
  test('every value the bridge, the mod and the app store has a label in every language', () => {
    const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')
    const quoted = (text: string | undefined) => [...(text ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]!)
    const server = read('bridge/server.ts')
    const list = (name: string) => quoted(server.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))?.[1])
    const stages = list('STAGES')
    const kinds = list('NODE_KINDS')
    const owners = list('NODE_OWNERS')
    const nodeStatuses = list('NODE_STATUSES')
    const taskStatuses = quoted(read('mod/hooks/tools.ts').match(/status: \{ type: 'string', enum: \[([^\]]*)\]/)?.[1])
    const commentStatuses = quoted(read('bridge/debug.ts').match(/COMMENT_STATUSES = \[([^\]]*)\]/)?.[1])
    const events = new Set<string>([
      ...[...server.matchAll(/logEvent\(\s*[\w.]+,\s*'([^']+)'/g)].map(m => m[1]!),
      ...[...server.matchAll(/into outbox \([^)]*\)\s*values \(\?, '([^']+)'/g)].map(m => m[1]!),
      ...[...read('mod/hooks/register.ts').matchAll(/post\(\$, '([^']+)'/g)].map(m => m[1]!),
      ...['src/renderer/src/BrowserView.tsx', 'src/renderer/src/pages/DebugPanel.tsx'].flatMap(f =>
        [...read(f).matchAll(/window\.ide\.send\([^)]*'([^']+)', ''\)/g)].map(m => m[1]!),
      ),
      // Written from a variable: a node's status (지금 is logged as 시작) and the log default.
      ...nodeStatuses.filter(s => s !== '지금'),
      '시작',
      '로그',
    ])
    expect(stages).toEqual(['요구', '설계', '작업', '완료'])
    expect([kinds.length, owners.length, nodeStatuses.length]).toEqual([5, 4, 4])
    expect(taskStatuses).toEqual(['하는 중', '대기', '보관'])
    expect(commentStatuses).toEqual(['열림', '보냄', '해결'])
    expect(events.size).toBeGreaterThan(15)
    const missing: string[] = []
    const check = (what: string, label: (value: string, lang?: Lang) => string, values: Iterable<string>) => {
      for (const value of values) for (const lang of OTHERS) if (label(value, lang) === value) missing.push(`${what} ${value} ${lang}`)
    }
    check('stage', stageLabel, stages)
    check('node kind', nodeKindLabel, kinds)
    check('node owner', nodeOwnerLabel, owners)
    check('node status', nodeStatusLabel, nodeStatuses)
    check('task status', taskStatusLabel, taskStatuses)
    check('comment status', commentStatusLabel, commentStatuses)
    check('event kind', eventKindLabel, events)
    expect(missing).toEqual([])
  })

  test('a value without a label shows as it is, whatever the language', () => {
    for (const label of [stageLabel, taskStatusLabel, nodeStatusLabel, nodeKindLabel, nodeOwnerLabel, eventKindLabel, commentStatusLabel]) {
      expect(label('Linear', 'en')).toBe('Linear')
      expect(label('toString', 'ja')).toBe('toString')
    }
  })

  test('markup slugs are English words for the stored values', () => {
    expect(['대기', '지금', '끝', '실패', '새것'].map(nodeStatusSlug)).toEqual(['waiting', 'now', 'done', 'failed', 'other'])
    expect(['열림', '보냄', '해결'].map(commentStatusSlug)).toEqual(['open', 'sent', 'resolved'])
    expect(['결정 대기', '답함', '전달', 'toString'].map(eventKindSlug)).toEqual(['question', 'answered', 'delivered', 'other'])
  })

  test('labels follow the current language by default', () => {
    setLang('en')
    expect(stageLabel('설계')).toBe('Design')
  })
})

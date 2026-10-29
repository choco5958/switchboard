import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DICTS,
  eventKindLabel,
  format,
  kindLabel,
  langOfState,
  nodeStatusLabel,
  ownerLabel,
  resolveLang,
  stageLabel,
  t,
  taskStatusLabel,
  type Lang,
} from '../hooks/i18n.ts'
import { ko } from '../hooks/lang/ko.ts'
import { openToolDef, toolDefs, toolText } from '../hooks/tools.ts'
import { agentLine, ageText, legend, summaryLines } from '../hooks/flow.ts'
import { batchText, pendingLine, toastText } from '../hooks/batch.ts'
import { openResultText } from '../hooks/devtool.ts'

const LANGS = Object.keys(DICTS) as Lang[]

function names(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)(?:\|[^}]*)?\}/g)].map(m => m[1] ?? ''))].sort()
}

test('every language has every key, with the same placeholders, and no dash or middle dot', () => {
  assert.deepEqual(LANGS, ['ko', 'en', 'ja', 'zh-CN'])
  for (const lang of LANGS) {
    const dict = DICTS[lang]
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(ko).sort(), lang)
    for (const [key, value] of Object.entries(dict)) {
      assert.ok(value.length > 0, `${lang} ${key} is empty`)
      assert.deepEqual(names(value), names(ko[key as keyof typeof ko]), `${lang} ${key}`)
      assert.doesNotMatch(value, /[\u2014\u2013\u00b7]/, `${lang} ${key}`)
    }
  }
})

test('the tool descriptions: Korean for ko, one English text for the rest, same enums', () => {
  const korean = toolDefs('ko')
  assert.match(korean[0]?.description ?? '', /^사람의 결정이 필요할 때 질문을 Switchboard 결정 대기 큐에 올린다/)
  for (const lang of ['en', 'ja', 'zh-CN'] as const) {
    assert.deepEqual(toolDefs(lang), toolDefs('en'))
    assert.deepEqual(openToolDef(lang, 'open_in_ide'), openToolDef('en', 'open_in_ide'))
  }
  assert.deepEqual(Object.keys(toolText('en')), Object.keys(toolText('ko')))
  const enums = (defs: ReturnType<typeof toolDefs>) => JSON.stringify(defs, (k, v) => (k === 'description' ? undefined : v))
  assert.equal(enums(toolDefs('en')), enums(korean))
  assert.deepEqual(
    korean.map(d => d.name),
    ['ask_decision', 'set_task', 'plan_nodes', 'node_worktree', 'list_sessions', 'send_to_session', 'cancel_request', 'routine_no_update', 'routine_report_failure', 'await_event', 'close_wait', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_navigate', 'browser_console', 'browser_screenshot', 'update_node'],
  )
  for (const text of Object.values(toolText('en'))) assert.doesNotMatch(text, /[\u2014\u2013\u00b7]/)
})

test('a valid setting wins, unset follows the locale, unknown locales read English', () => {
  assert.equal(resolveLang('ja', 'ko-KR'), 'ja')
  assert.equal(resolveLang('zh-CN', 'en-US'), 'zh-CN')
  assert.equal(resolveLang(undefined, 'ko-KR'), 'ko')
  assert.equal(resolveLang(null, 'ja-JP'), 'ja')
  assert.equal(resolveLang('', 'zh-TW'), 'zh-CN')
  assert.equal(resolveLang('fr', 'zh-Hans-CN'), 'zh-CN')
  assert.equal(resolveLang('toString', 'de-DE'), 'en')
  assert.equal(resolveLang(undefined, 'en-GB'), 'en')
  assert.equal(resolveLang(undefined, ''), 'en')
  assert.equal(langOfState({ settings: { lang: 'en' } }, 'ko-KR'), 'en')
  assert.equal(langOfState({ settings: {} }, 'ja-JP'), 'ja')
  assert.equal(langOfState('nope', 'ko-KR'), 'ko')
})

test('t puts values in and picks English plurals', () => {
  assert.equal(t('ko', 'pane.tabFlow', { n: 3 }), '1: 흐름 3')
  assert.equal(t('en', 'flow.agents', { n: 1, done: 0 }), '1 subagent (0 done)')
  assert.equal(t('en', 'flow.agents', { n: 2, done: 1 }), '2 subagents (1 done)')
  assert.equal(t('ja', 'flow.cost', { usd: '1.50' }), 'セッション累計 $1.50')
  assert.equal(format('{a} and {b}', { a: 'x' }), 'x and {b}')
  // A value is put in as it is, never read for placeholders.
  assert.equal(t('en', 'tool.taskDone', { title: '{n}' }), 'Updated task "{n}".')
})

test('stored values show as labels; Korean labels are the values, unknown ones pass through', () => {
  const groups: [(lang: Lang, value: string) => string, string][] = [
    [stageLabel, 'stage'],
    [taskStatusLabel, 'taskStatus'],
    [nodeStatusLabel, 'nodeStatus'],
    [kindLabel, 'kind'],
    [ownerLabel, 'owner'],
    [eventKindLabel, 'event'],
  ]
  for (const [label, prefix] of groups) {
    const values = Object.keys(ko)
      .filter(key => key.startsWith(`${prefix}.`))
      .map(key => key.slice(prefix.length + 1))
    assert.ok(values.length > 0, prefix)
    for (const value of values) {
      assert.equal(label('ko', value), value)
      for (const lang of ['en', 'ja', 'zh-CN'] as const) assert.doesNotMatch(label(lang, value), /[\uac00-\ud7a3]/, `${lang} ${value}`)
    }
    assert.equal(label('en', '모르는 값'), '모르는 값')
  }
  assert.equal(stageLabel('en', '설계'), 'Design')
  assert.equal(taskStatusLabel('ja', '하는 중'), '進行中')
  assert.equal(ownerLabel('zh-CN', '검토자'), '评审者')
})

test('flow, batch and devtool lines follow the language and keep Korean by default', () => {
  assert.equal(ageText(37_000), '37초 전')
  assert.equal(ageText(37_000, 'en'), '37s ago')
  assert.equal(ageText(120_000, 'ja'), '2 分前')
  assert.equal(legend('en'), '✓ done  ● now  ▷ next  ○ left  ✗ failed')
  assert.equal(agentLine([], true, 'zh-CN'), '▾ 子代理 0 个（含已完成 0 个）')
  const snapshot = {
    tasks: [{ id: 1, number: 4, title: 'T', stage: '작업', status: '하는 중', now: '', branch: '', artifact: '' }],
    nodes: [],
    agents: [],
    questions: [],
    costUsd: null,
    fetchedAt: 0,
    lang: 'en' as const,
  }
  assert.deepEqual(summaryLines(snapshot, 'en'), ['#4 T: Build stage, Active', '1 task, 0 decisions waiting, 0 subagents running, 0 done'])
  assert.match(batchText([{ id: 'q1', text: 'a' }, { id: 'm1', text: 'b' }], 'en'), /^\[Switchboard\] 2 items arrived/)
  assert.equal(toastText([{ id: 'q6', text: '' }, { id: 'm2', text: '' }], 'en'), 'Put answers to Q6, 1 IDE message into the session')
  assert.equal(
    pendingLine({ id: 3, task_title: '', question: 'Q?', recommend: 'a', options: '[{"key":"a","label":"Yes"}]' }, 'en'),
    '- Q3 [no task] Q? recommended ➡ (a) Yes',
  )
  assert.equal(openResultText({ ok: false, status: 502, json: {} }, 'en'), 'Could not open it in the IDE: status 502')
})

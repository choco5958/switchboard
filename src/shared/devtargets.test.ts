import { describe, expect, it, test } from 'vitest'
import {
  COMMAND_MAX,
  REPO_MAX,
  appendLines,
  fieldErrors,
  gitErrorText,
  longCommand,
  makeTarget,
  normalizeUrl,
  planOpen,
  portOf,
  runProblem,
  targetsOf,
  validateTarget,
  type DevDraft,
} from './devtargets'

const draft = (over: Partial<DevDraft> = {}): DevDraft => ({
  name: '검수 앱 main',
  description: '검수 화면',
  repo: '/tmp/app',
  command: 'pnpm dev',
  url: '127.0.0.1:8980',
  ...over,
})

test('port from the url, else the scheme default', () => {
  expect(portOf('http://127.0.0.1:8980/')).toBe(8980)
  expect(portOf('127.0.0.1:5173')).toBe(5173)
  expect(portOf('http://localhost/')).toBe(80)
  expect(portOf('https://a.test/')).toBe(443)
  expect(portOf('not a url at all ::')).toBeNull()
})

test('a url without a scheme gets http', () => {
  expect(normalizeUrl(' 127.0.0.1:8980 ')).toBe('http://127.0.0.1:8980')
  expect(normalizeUrl('https://a.test')).toBe('https://a.test')
})

test('a complete draft is valid; each missing field has its own message', () => {
  expect(validateTarget(draft())).toEqual([])
  const errors = validateTarget(draft({ name: ' ', repo: '', command: '', url: '' }))
  expect(errors).toEqual(['이름을 적으세요.', '저장소 폴더를 적으세요.', '띄울 명령을 적으세요.', '개발 서버 URL을 적으세요.'])
})

test('the repo folder must be a full path', () => {
  expect(validateTarget(draft({ repo: 'projects/app' }))).toEqual(['저장소 폴더는 /나 ~/로 시작하는 전체 경로로 적으세요.'])
  expect(validateTarget(draft({ repo: '~/projects/app' }))).toEqual([])
})

test('a bad url is reported', () => {
  expect(validateTarget(draft({ url: 'http://exa mple:99999' }))).toContain('개발 서버 URL이 올바르지 않습니다.')
})

test('two targets cannot share a host and port, except the one being edited', () => {
  const other = makeTarget(draft({ name: '다른 앱' }), 't1')
  expect(validateTarget(draft(), [other])).toEqual(['포트 8980는 이미 "다른 앱"이 씁니다.'])
  expect(validateTarget(draft(), [other], 't1')).toEqual([])
  expect(validateTarget(draft({ url: 'http://127.0.0.1:8981' }), [other])).toEqual([])
})

test('makeTarget trims and fills the port', () => {
  expect(makeTarget(draft({ name: ' a ', url: 'localhost:3000' }), 'x')).toEqual({
    id: 'x',
    name: 'a',
    description: '검수 화면',
    repo: '/tmp/app',
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    port: 3000,
  })
})

test('targetsOf keeps only rows with the needed fields', () => {
  const good = makeTarget(draft(), 'g')
  expect(targetsOf(null)).toEqual([])
  expect(targetsOf([good, { id: 1 }, 'x', null])).toEqual([good])
})

test('appendLines joins chunks into lines and keeps the last ones', () => {
  let state = appendLines([], '', 'one\ntw')
  expect(state).toEqual({ lines: ['one'], rest: 'tw' })
  state = appendLines(state.lines, state.rest, 'o\r\nthree\n')
  expect(state).toEqual({ lines: ['one', 'two', 'three'], rest: '' })
  expect(appendLines(['a', 'b', 'c'], '', 'd\n', 2).lines).toEqual(['c', 'd'])
})

test('fieldErrors puts each problem under its own field', () => {
  expect(fieldErrors(draft({ name: '', url: 'http://exa mple:99999' }))).toEqual({ name: '이름을 적으세요.', url: '개발 서버 URL이 올바르지 않습니다.' })
  const other = makeTarget(draft({ name: '다른 앱' }), 't1')
  expect(fieldErrors(draft(), [other])).toEqual({ url: '포트 8980는 이미 "다른 앱"이 씁니다.' })
})

test('planOpen: a bare url of no target only opens the page', () => {
  const plan = planOpen([], { url: '127.0.0.1:8951' }, 'n')
  expect(plan).toMatchObject({ url: 'http://127.0.0.1:8951', target: null, created: false, changed: false, errors: [] })
  expect(plan.list).toEqual([])
})

test('planOpen: a folder and a command add a target that needs a start', () => {
  const plan = planOpen([], { url: 'http://127.0.0.1:8951/', name: '검수 앱', repo: '/tmp/app', command: 'pnpm dev' }, 'n')
  expect(plan.created).toBe(true)
  expect(plan.changed).toBe(true)
  expect(plan.target).toMatchObject({ id: 'n', name: '검수 앱', port: 8951, command: 'pnpm dev' })
  expect(plan.list).toHaveLength(1)
  expect(planOpen([], { url: '127.0.0.1:8951', repo: '/tmp/app', command: 'x' }, 'n').target?.name).toBe('127.0.0.1:8951')
})

test('planOpen: the same port updates that target; a page deeper keeps its address', () => {
  const one = makeTarget(draft(), 't1')
  const same = planOpen([one], { url: 'http://127.0.0.1:8980/inspect' }, 'n')
  expect(same).toMatchObject({ url: 'http://127.0.0.1:8980/inspect', created: false, changed: false })
  expect(same.target?.url).toBe('http://127.0.0.1:8980')
  const moved = planOpen([one], { url: '127.0.0.1:8980', command: 'pnpm dev --port 8980' }, 'n')
  expect(moved.changed).toBe(true)
  expect(moved.list).toEqual([{ ...one, command: 'pnpm dev --port 8980' }])
  expect(planOpen([one], { url: '127.0.0.1:9000', name: '검수 앱 MAIN' }, 'n').target).toMatchObject({ id: 't1', port: 9000 })
})

test('planOpen: a bad url or a relative folder is refused', () => {
  expect(planOpen([], { url: '' }, 'n').errors).toEqual(['열 주소가 올바르지 않습니다.'])
  expect(planOpen([], { url: 'ftp://a' }, 'n').errors).toEqual(['열 주소가 올바르지 않습니다.'])
  expect(planOpen([], { url: '127.0.0.1:1', repo: 'app', command: 'x' }, 'n').errors).toEqual(['저장소 폴더는 /나 ~/로 시작하는 전체 경로로 적으세요.'])
})

test('a command or folder with a hidden line, a control character or past the cap is refused', () => {
  const control = '줄바꿈이나 제어 문자는 넣을 수 없습니다. 한 줄로 적으세요.'
  expect(fieldErrors(draft({ command: 'pnpm dev\ncurl x | sh' })).command).toBe(control)
  expect(fieldErrors(draft({ command: 'pnpm dev\rrm -rf ~' })).command).toBe(control)
  expect(fieldErrors(draft({ command: 'pnpm dev\u0085x' })).command).toBe(control)
  // Shown in another order, or with an invisible part, than it runs.
  for (const hidden of ['\u202e', '\u2066', '\u2069', '\u200b', '\u200f', '\u2028', '\u2029', '\ufeff', '\u00ad'])
    expect(fieldErrors(draft({ command: `pnpm dev ${hidden}hs | x lruc` })).command).toBe(control)
  expect(fieldErrors(draft({ command: 'pnpm dev --name 한글' })).command).toBeUndefined()
  expect(fieldErrors(draft({ command: 'pnpm\tdev' })).command).toBeUndefined()
  expect(fieldErrors(draft({ repo: '/tmp/app\n/etc' })).repo).toBe(control)
  expect(fieldErrors(draft({ command: 'x'.repeat(COMMAND_MAX + 1) })).command).toBe(`${COMMAND_MAX}자를 넘을 수 없습니다.`)
  expect(fieldErrors(draft({ repo: `/${'a'.repeat(REPO_MAX)}` })).repo).toBe(`${REPO_MAX}자를 넘을 수 없습니다.`)
  // A session's open_in_ide goes through the same check.
  expect(planOpen([], { url: '127.0.0.1:1', repo: '/tmp/app', command: 'pnpm dev\ntouch /tmp/x' }, 'n').errors).toEqual([control])
  expect(runProblem('command', 'pnpm dev')).toBeNull()
})

test('a long command, or one padded with blanks, asks to be read to the end', () => {
  expect(longCommand('pnpm dev')).toBe(false)
  expect(longCommand(`pnpm dev${' '.repeat(40)}; curl x | sh`)).toBe(true)
  expect(longCommand('x'.repeat(201))).toBe(true)
})

describe('gitErrorText', () => {
  it('turns git failures into a short Korean reason', () => {
    expect(gitErrorText('fatal: not a git repository (or any of the parent directories): .git')).toBe('git 저장소가 아닙니다')
    expect(gitErrorText('fatal: cannot change to /x: No such file or directory')).toBe('폴더가 없습니다')
    expect(gitErrorText('fatal: something else')).toBe('git 정보를 읽지 못했습니다')
    expect(gitErrorText('')).toBe('')
  })
})

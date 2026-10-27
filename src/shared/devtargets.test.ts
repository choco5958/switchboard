import { describe, expect, it, test } from 'vitest'
import { appendLines, fieldErrors, gitErrorText, makeTarget, normalizeUrl, planOpen, portOf, targetsOf, validateTarget, type DevDraft } from './devtargets'

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
  expect(errors).toEqual(['이름을 적어 주세요.', '레포 폴더를 적어 주세요.', '띄울 명령을 적어 주세요.', '개발 서버 URL을 적어 주세요.'])
})

test('the repo folder must be a full path', () => {
  expect(validateTarget(draft({ repo: 'projects/app' }))).toEqual(['레포 폴더는 /나 ~/로 시작하는 전체 경로로 적어 주세요.'])
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
  expect(fieldErrors(draft({ name: '', url: 'http://exa mple:99999' }))).toEqual({ name: '이름을 적어 주세요.', url: '개발 서버 URL이 올바르지 않습니다.' })
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
  expect(planOpen([], { url: '127.0.0.1:1', repo: 'app', command: 'x' }, 'n').errors).toEqual(['레포 폴더는 /나 ~/로 시작하는 전체 경로로 적어 주세요.'])
})

describe('gitErrorText', () => {
  it('turns git failures into a short Korean reason', () => {
    expect(gitErrorText('fatal: not a git repository (or any of the parent directories): .git')).toBe('git 레포가 아닙니다')
    expect(gitErrorText('fatal: cannot change to /x: No such file or directory')).toBe('폴더가 없습니다')
    expect(gitErrorText('fatal: something else')).toBe('git 정보를 읽지 못했습니다')
    expect(gitErrorText('')).toBe('')
  })
})

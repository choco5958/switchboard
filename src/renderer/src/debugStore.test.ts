import { expect, test } from 'vitest'
import type { DevStatus } from '../../shared/types'
import { makeTarget } from '../../shared/devtargets'
import { failureReason, openAction, sendable, sessionFor, whereTo, type OpenEvent } from './debugStore'

const s = (id: string, project: string, cwd = `/p/${project}`) => ({ id, project, cwd })
const sessions = [s('a1', 'app'), s('b1', 'billing'), s('a2', 'app')]

test('sendable sessions are in the chosen project and alive', () => {
  expect(sendable(sessions, null, null).map(x => x.id)).toEqual(['a1', 'b1', 'a2'])
  expect(sendable(sessions, 'app', null).map(x => x.id)).toEqual(['a1', 'a2'])
  expect(sendable(sessions, 'app', ['a2', 'b1']).map(x => x.id)).toEqual(['a2'])
  expect(sendable(sessions, 'app', [])).toEqual([])
})

test('the default session: the chosen one while sendable, else the newest sendable one', () => {
  expect(sessionFor('a2', sessions, 'app', null)?.id).toBe('a2')
  expect(sessionFor('b1', sessions, 'app', null)?.id).toBe('a1')
  expect(sessionFor('a1', sessions, null, ['a2'])?.id).toBe('a2')
  expect(sessionFor('', sessions, 'billing', ['a1'])).toBeUndefined()
})

test('where a message goes, naming the same folder when it is the target\'s repo', () => {
  const target = makeTarget({ name: 'x', description: '', repo: '/p/app/', command: 'c', url: '127.0.0.1:1' }, 't')
  expect(whereTo(s('a1234567890', 'app'), target)).toBe('이 레포의 Claude Code 세션 a1234567 (같은 폴더)')
  expect(whereTo(s('b1234567890', 'billing'))).toBe('billing의 Claude Code 세션 b1234567')
})

test('load failures in words', () => {
  expect(failureReason('ERR_CONNECTION_REFUSED')).toContain('응답하는 서버가 없습니다')
  expect(failureReason('ERR_CERT_DATE_INVALID')).toContain('인증서')
  expect(failureReason('ERR_SOMETHING_NEW')).toBe('페이지를 불러오지 못했습니다.')
})

test('open_in_ide: restart a changed server this app runs, start one nobody answers for, else open', () => {
  const target = makeTarget({ name: 'x', description: '', repo: '/r', command: 'c', url: '127.0.0.1:8951' }, 't')
  const event = (over: Partial<OpenEvent> = {}): OpenEvent => ({ id: '1', at: 0, url: target.url, sessionId: '', target, restart: false, ...over })
  const status = (over: Partial<DevStatus> = {}): DevStatus => ({ id: 't', running: false, pid: null, startedAt: null, exitCode: null, listening: false, responding: false, ...over })
  expect(openAction(event({ target: null }), null)).toBe('open')
  expect(openAction(event(), status())).toBe('start')
  expect(openAction(event({ restart: true }), status())).toBe('start')
  expect(openAction(event({ restart: true }), status({ running: true, responding: true }))).toBe('restart')
  expect(openAction(event(), status({ running: true, responding: true }))).toBe('open')
  expect(openAction(event(), status({ running: true }))).toBe('restart')
  expect(openAction(event({ restart: true }), status({ listening: true, responding: true }))).toBe('open')
})

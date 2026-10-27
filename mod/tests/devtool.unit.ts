import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openBody, openResultText } from '../hooks/devtool.ts'

test('open_in_ide: a relative folder and a bare command run from the session folder', () => {
  assert.deepEqual(openBody({ url: ' 127.0.0.1:8951 ', command: 'pnpm dev' }, 's1', '/w/app/'), {
    url: '127.0.0.1:8951',
    name: '',
    repo: '/w/app/',
    command: 'pnpm dev',
    sessionId: 's1',
  })
  assert.equal(openBody({ url: 'x', repo: './web', command: 'c' }, 's1', '/w/app/').repo, '/w/app/web')
  assert.equal(openBody({ url: 'x', repo: '~/p' }, 's1', '/w').repo, '~/p')
  assert.equal(openBody({ url: 'x' }, 's1', '/w').repo, '')
  assert.equal(openBody({ url: 3 }, 's1', '/w').url, '')
})

test('open_in_ide: the result says what the IDE will do', () => {
  const ok = (json: Record<string, unknown>) => openResultText({ ok: true, status: 200, json: { url: 'http://127.0.0.1:8951', ideWatching: true, ...json } })
  assert.equal(ok({ target: null }), 'IDE의 다이나믹 디버깅 탭에서 http://127.0.0.1:8951을(를) 엽니다.')
  assert.match(ok({ target: { name: '검수 앱' }, created: true }), /"검수 앱"을\(를\) 새로 등록했습니다/)
  assert.match(ok({ target: { name: '검수 앱' }, restart: true }), /고쳤습니다/)
  assert.match(ok({ target: null, ideWatching: false }), /앱이 꺼져 있습니다/)
  assert.equal(openResultText({ ok: false, status: 400, json: { error: '열 주소가 올바르지 않습니다.' } }), 'IDE에서 열지 못했습니다: 열 주소가 올바르지 않습니다.')
})

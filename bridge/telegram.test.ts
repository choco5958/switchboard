import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge, listen } from './server.ts'
import { questionMessage, replyAnswer } from './telegram.ts'

// A fake Telegram: getMe, sendMessage, editMessageText and answerCallbackQuery are recorded;
// getUpdates hands out what the test queued, then holds briefly as long polling does.
const calls: { method: string; body: any }[] = []
const queued: unknown[] = []
let updateId = 1
let messageId = 100
const fake = createServer((req, res) => {
  let text = ''
  req.on('data', chunk => (text += chunk))
  req.on('end', () => {
    const method = req.url!.split('/').pop()!
    const body = text ? JSON.parse(text) : {}
    const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }))
    if (!req.url!.startsWith('/bot123456:TEST_TOKEN_abcdefghijklmnop/')) return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }))
    if (method === 'getUpdates') {
      const take = () => reply(queued.splice(0).map(u => ({ update_id: updateId++, ...(u as object) })))
      return queued.length > 0 ? take() : setTimeout(take, 30)
    }
    calls.push({ method, body })
    if (method === 'getMe') return reply({ username: 'sb_test_bot' })
    if (method === 'sendMessage') return reply({ message_id: messageId++ })
    reply(true)
  })
})

const dir = mkdtempSync(join(tmpdir(), 'sb-tg-'))
const socketPath = join(dir, 'b.sock')
let bridge: ReturnType<typeof createBridge>

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { 'content-type': 'application/json' } }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(check())
}
const sent = (method: string) => calls.filter(c => c.method === method)

before(async () => {
  await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve))
  bridge = createBridge(join(dir, 'ide.db'), 'ko-KR', { telegramApi: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` })
  await listen(bridge.server, socketPath)
  await call('POST', '/sessions', { id: 'tg-1', cwd: '/w/shop' })
})
after(() => {
  bridge.close()
  fake.close()
  rmSync(dir, { recursive: true, force: true })
})

test('the message a question goes out as, and what a reply means', () => {
  const q = { id: 7, session_id: 's', project: 'shop', task_title: '결제', question: '재시도 몇 번?', body: 'Bearer abcdefghijkl 로 호출', options: JSON.stringify([{ key: 'a', label: '3회' }, { key: 'b', label: '5회' }]), recommend: 'a', status: 'pending' }
  const { text, keyboard } = questionMessage(q, 'ko')
  assert.match(text, /^\[결제\] Q7\n재시도 몇 번\?/)
  assert.match(text, /Bearer \*\*\*/)
  assert.match(text, /\(a\) 3회 \(추천\)/)
  assert.deepEqual(keyboard.map(row => row[0]!.callback_data), ['a:7:a', 'a:7:b', 'h:7'])
  assert.deepEqual(replyAnswer('b 트래픽이 적어서', ['a', 'b']), { choice: 'b', memo: '트래픽이 적어서' })
  assert.deepEqual(replyAnswer('(A)', ['a', 'b']), { choice: 'a', memo: null })
  assert.deepEqual(replyAnswer('잘 모르겠음', ['a', 'b']), { choice: null, memo: '잘 모르겠음' })
})

test('a token is checked, a chat pairs with the code, and only that person answers', async () => {
  assert.equal((await call('POST', '/telegram/token', { token: 'nope' })).status, 400)
  assert.equal((await call('POST', '/telegram/token', { token: '123456:WRONG_TOKEN_abcdefghijklmnop' })).status, 400)
  const ok = await call('POST', '/telegram/token', { token: '123456:TEST_TOKEN_abcdefghijklmnop' })
  assert.deepEqual([ok.status, ok.json.bot, ok.json.paired], [200, 'sb_test_bot', false])
  assert.ok(!JSON.stringify((await call('GET', '/state')).json).includes('TEST_TOKEN'))

  const { json: pair } = await call('POST', '/telegram/pair')
  assert.equal(pair.link, `https://t.me/sb_test_bot?start=${pair.code}`)
  queued.push({ message: { message_id: 1, chat: { id: 42, type: 'private', first_name: '대현' }, from: { id: 42 }, text: '/start 000000' } })
  await until(() => sent('sendMessage').some(c => /맞지 않거나/.test(c.body.text)))
  queued.push({ message: { message_id: 2, chat: { id: 42, type: 'private', first_name: '대현' }, from: { id: 42 }, text: `/start ${pair.code}` } })
  await until(() => sent('sendMessage').some(c => /연결되었습니다/.test(c.body.text)))
  assert.deepEqual([(await call('GET', '/telegram')).json.paired, (await call('GET', '/telegram')).json.name], [true, '대현'])

  // The app is not connected (no /stream), so the person counts as away: the question goes out.
  const { json: q } = await call('POST', '/questions', { sessionId: 'tg-1', taskTitle: '결제', question: '재시도 몇 번?', options: [{ key: 'a', label: '3회' }, { key: 'b', label: '5회' }] })
  await until(() => sent('sendMessage').some(c => c.body.text?.includes(`Q${q.id}`)))
  const out = sent('sendMessage').find(c => c.body.text?.includes(`Q${q.id}`))!
  assert.equal(out.body.chat_id, 42)
  assert.equal(out.body.reply_markup.inline_keyboard.length, 3)

  // Someone else presses; then the person.
  queued.push({ callback_query: { id: 'x1', from: { id: 99 }, data: `a:${q.id}:b`, message: { message_id: 102, chat: { id: 42 } } } })
  await until(() => sent('answerCallbackQuery').some(c => c.body.callback_query_id === 'x1'))
  assert.equal((await call('GET', '/state')).json.questions.find((one: { id: number }) => one.id === q.id).status, 'pending')
  queued.push({ callback_query: { id: 'x2', from: { id: 42 }, data: `a:${q.id}:b`, message: { message_id: 102, chat: { id: 42 } } } })
  await until(() => sent('editMessageText').some(c => /답함: \(b\) 5회/.test(c.body.text)))
  const row = (await call('GET', '/state')).json.questions.find((one: { id: number }) => one.id === q.id)
  assert.deepEqual([row.status, row.choice], ['answered', 'b'])
})

test('a reply answers with a memo; an answer from the app edits the message', async () => {
  const { json: q1 } = await call('POST', '/questions', { sessionId: 'tg-1', question: '배포할까?', options: [{ key: 'a', label: '지금' }, { key: 'b', label: '내일' }] })
  await until(() => sent('sendMessage').some(c => c.body.text?.includes(`Q${q1.id}`)))
  const message = sent('sendMessage').find(c => c.body.text?.includes(`Q${q1.id}`))!
  const id = messageId - 1
  queued.push({ message: { message_id: 50, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'b 금요일 배포는 피하자', reply_to_message: { message_id: id } } })
  await until(() => (bridge.db.prepare('select status from questions where id = ?').get(q1.id) as { status: string }).status === 'answered')
  const row = bridge.db.prepare('select choice, memo from questions where id = ?').get(q1.id) as { choice: string; memo: string }
  assert.deepEqual([row.choice, row.memo], ['b', '금요일 배포는 피하자'])
  assert.ok(message)

  const { json: q2 } = await call('POST', '/questions', { sessionId: 'tg-1', question: '로그 줄일까?', options: [{ key: 'a', label: '예' }] })
  await until(() => sent('sendMessage').some(c => c.body.text?.includes(`Q${q2.id}`)))
  await call('POST', `/questions/${q2.id}/answer`, { choice: 'a' })
  await until(() => sent('editMessageText').some(c => /다른 곳에서 답함: \(a\) 예/.test(c.body.text)))
})

test('at the desk nothing goes out; leaving sends what waits', async () => {
  const stream = request({ socketPath, path: '/stream' })
  stream.on('error', () => undefined)
  stream.end()
  await new Promise(resolve => setTimeout(resolve, 50))
  await call('POST', '/presence', { away: false })
  const before = sent('sendMessage').length
  const { json: q } = await call('POST', '/questions', { sessionId: 'tg-1', question: '캐시 키 바꿀까?', options: [{ key: 'a', label: '예' }] })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(sent('sendMessage').length, before)
  await call('POST', '/presence', { away: true })
  await until(() => sent('sendMessage').some(c => c.body.text?.includes(`Q${q.id}`)))
  stream.destroy()
  assert.equal((await call('POST', '/telegram/token', { token: null })).json.configured, false)
})

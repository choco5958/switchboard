import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge, listen } from './server.ts'
import { mobileAddresses, mobileRouteAllowed, privateAddress } from './mobile.ts'
import { fromB64, fromUtf8, open, seal, toB64, utf8 } from './mobile/aead.js'

describe('the cipher the phone and the bridge share', () => {
  test('RFC 8439 2.8.2: the same ciphertext and tag', () => {
    const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))
    const key = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f')
    const nonce = hex('070000004041424344454647')
    const aad = hex('50515253c0c1c2c3c4c5c6c7')
    const text = utf8("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.")
    const sealed = seal(key, nonce, text, aad)
    assert.equal(Buffer.from(sealed.subarray(0, 16)).toString('hex'), 'd31a8d34648e60db7b86afbc53ef7ec2')
    assert.equal(Buffer.from(sealed.subarray(-16)).toString('hex'), '1ae10b594f09e26a7e902ecbd0600691')
  })

  test("matches Node's own ChaCha20-Poly1305 both ways, at every length around a block", () => {
    for (const length of [0, 1, 15, 16, 17, 63, 64, 65, 1000]) {
      const key = randomBytes(32)
      const nonce = randomBytes(12)
      const aad = randomBytes(length % 20)
      const text = randomBytes(length)
      const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
      cipher.setAAD(aad)
      const native = Buffer.concat([cipher.update(text), cipher.final(), cipher.getAuthTag()])
      assert.deepEqual(Buffer.from(seal(key, nonce, text, aad)), native)
      const ours = seal(key, nonce, text, aad)
      const decipher = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
      decipher.setAAD(aad)
      decipher.setAuthTag(Buffer.from(ours.subarray(-16)))
      assert.deepEqual(Buffer.concat([decipher.update(ours.subarray(0, -16)), decipher.final()]), text)
    }
  })

  test('refuses a changed message, another aad or another key', () => {
    const key = randomBytes(32)
    const nonce = randomBytes(12)
    const sealed = seal(key, nonce, utf8('허용'), utf8('a'))
    assert.equal(fromUtf8(open(key, nonce, sealed, utf8('a'))!), '허용')
    assert.equal(open(key, nonce, sealed.map((b, i) => (i === 0 ? b ^ 1 : b)), utf8('a')), null)
    assert.equal(open(key, nonce, sealed, utf8('b')), null)
    assert.equal(open(randomBytes(32), nonce, sealed, utf8('a')), null)
    assert.deepEqual(fromB64(toB64(Uint8Array.from([0, 250, 251, 255]))), Uint8Array.from([0, 250, 251, 255]))
  })
})

test('a phone may come from this computer, the private network or Tailscale only', () => {
  for (const ok of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.0.5', '100.101.102.103', '::ffff:192.168.1.4', '::1', 'fd7a:115c:a1e0::1', 'fe80::1']) assert.ok(privateAddress(ok), ok)
  for (const no of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '']) assert.ok(!privateAddress(no), no)
  const found = mobileAddresses({
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '', mac: '', cidr: null }],
    tailscale0: [{ address: '100.90.1.2', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }],
    en0: [{ address: '192.168.0.5', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }],
    utun: [{ address: '8.8.4.4', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }],
  })
  assert.deepEqual(found, [
    { address: '192.168.0.5', kind: 'lan' },
    { address: '100.90.1.2', kind: 'tailscale' },
  ])
})

test('a phone reaches only what it is for', () => {
  assert.ok(mobileRouteAllowed('GET', '/mobile/view'))
  assert.ok(mobileRouteAllowed('POST', '/questions/3/answer'))
  assert.ok(mobileRouteAllowed('POST', '/approvals/3/answer'))
  assert.ok(mobileRouteAllowed('POST', '/outbox'))
  for (const [method, path] of [['GET', '/state'], ['POST', '/settings'], ['POST', '/mobile/pair'], ['POST', '/telegram/token'], ['POST', '/commands'], ['GET', '/approvals/3']]) {
    assert.ok(!mobileRouteAllowed(method!, path!), String(path))
  }
})

describe('a paired phone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ide-phone-'))
  const socketPath = join(dir, 'bridge.sock')
  const APP_KEY = 'b'.repeat(64)
  const bridge = createBridge(join(dir, 'ide.db'), 'ko-KR', { appKey: APP_KEY })
  let port = 0
  let phone = { id: 0, key: '' }

  const call = (method: string, path: string, body?: unknown, app = true): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (app) headers['x-switchboard-app'] = APP_KEY
      const req = request({ socketPath, method, path, headers }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
      })
      req.on('error', reject)
      if (body !== undefined) req.write(JSON.stringify(body))
      req.end()
    })

  const http = (method: string, path: string, body?: string): Promise<{ status: number; text: string; headers: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json' } }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }))
      })
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })

  // What the page (mobile/app.js) sends: one sealed request; the answer comes back sealed too.
  const sealed = (inner: unknown, who = phone) => {
    const nonce = randomBytes(12)
    const n = toB64(nonce)
    return { n, body: JSON.stringify({ d: who.id, n, c: toB64(seal(fromB64(who.key), nonce, utf8(JSON.stringify(inner)), utf8(`sb1:req:${who.id}`))) }) }
  }
  const ask = async (method: string, path: string, body?: unknown, at = Date.now()) => {
    const { n, body: wire } = sealed({ t: at, method, path, body })
    const res = await http('POST', '/api', wire)
    if (res.status !== 200) return { outer: res.status, status: 0, json: JSON.parse(res.text) as any }
    const out = JSON.parse(res.text) as { n: string; c: string }
    const plain = open(fromB64(phone.key), fromB64(out.n), fromB64(out.c), utf8(`sb1:res:${phone.id}:${n}`))
    assert.ok(plain, 'the answer opens with the same key')
    return { outer: 200, ...(JSON.parse(fromUtf8(plain)) as { status: number; json: any }) }
  }

  before(async () => {
    await listen(bridge.server, socketPath)
    assert.equal((await call('POST', '/mobile', { enabled: true }, false)).status, 403, 'only the app turns phones on')
    const on = await call('POST', '/mobile', { enabled: true, port: 0 })
    assert.equal(on.json.listening, true)
    port = on.json.port
    assert.equal((await call('POST', '/mobile/pair', { name: '내 아이폰' }, false)).status, 403, 'only the app pairs a phone')
    phone = (await call('POST', '/mobile/pair', { name: '내 아이폰' })).json
  })
  after(() => {
    bridge.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('the page is served with a strict policy, and the words come in the app language', async () => {
    const page = await http('GET', '/')
    assert.equal(page.status, 200)
    assert.match(page.text, /<script type="module" src="app.js">/)
    assert.match(String(page.headers['content-security-policy']), /default-src 'self'/)
    assert.equal(page.headers['referrer-policy'], 'no-referrer')
    assert.equal((await http('GET', '/aead.js')).status, 200)
    const words = JSON.parse((await http('GET', '/strings')).text)
    assert.equal(words.lang, 'ko')
    assert.equal(words['mobile.page.allow'], '허용')
    assert.ok(!Object.keys(words).some(k => k.startsWith('telegram.')))
  })

  test('answers a decision, allows a permission ask and writes to a session', async () => {
    await call('POST', '/sessions', { id: 'ph1', cwd: '/w/phone-app' })
    const q = (await call('POST', '/questions', { sessionId: 'ph1', question: '어느 쪽?', options: [{ key: 'a', label: '왼쪽' }, { key: 'b', label: '오른쪽' }], recommend: 'a' })).json
    const a = (await call('POST', '/approvals', { sessionId: 'ph1', tool: 'Bash', summary: 'rm -rf build', requestKey: 'k1' })).json
    const view = await ask('GET', '/mobile/view')
    assert.equal(view.status, 200)
    assert.deepEqual(view.json.questions.map((x: { id: number }) => x.id), [q.id])
    assert.equal(view.json.approvals[0].summary, 'rm -rf build')
    assert.equal(view.json.sessions[0].id, 'ph1')

    assert.equal((await ask('POST', `/questions/${q.id}/answer`, { choice: 'b' })).status, 200)
    assert.equal((await ask('POST', `/approvals/${a.id}/answer`, { decision: 'allow' })).status, 200)
    assert.equal((await call('GET', `/approvals/${a.id}`)).json.status, 'allow')
    const state = (await call('GET', '/state')).json
    assert.equal(state.approvals.find((x: { id: number }) => x.id === a.id).via, 'mobile')
    assert.equal(state.questions.find((x: { id: number }) => x.id === q.id).choice, 'b')
    assert.equal((await ask('POST', '/outbox', { sessionId: 'ph1', text: '휴대폰에서 보냄' })).status, 200)
  })

  test('anything else, a request sent again, an old one or a forged one is refused', async () => {
    assert.equal((await ask('POST', '/settings', { key: 'lang', value: 'en' })).status, 403)
    assert.equal((await ask('POST', '/mobile/pair', { name: 'x' })).status, 403)
    const once = sealed({ t: Date.now(), method: 'GET', path: '/mobile/view' })
    assert.equal((await http('POST', '/api', once.body)).status, 200)
    assert.equal((await http('POST', '/api', once.body)).status, 409, 'the same nonce twice')
    const old = await ask('GET', '/mobile/view', undefined, Date.now() - 10 * 60_000)
    assert.equal(old.outer, 409)
    assert.ok(Math.abs(old.json.now - Date.now()) < 5000, 'tells the page its time')
    const forged = sealed({ t: Date.now(), method: 'GET', path: '/mobile/view' }, { id: phone.id, key: toB64(randomBytes(32)) })
    assert.equal((await http('POST', '/api', forged.body)).status, 401)
    assert.equal((await http('POST', '/api', 'not json')).status, 400)
  })

  test('a phone the app disconnects is refused from then on', async () => {
    const other = (await call('POST', '/mobile/pair', { name: '태블릿' })).json
    const devices = (await call('GET', '/mobile')).json.devices
    assert.deepEqual(devices.map((d: { name: string }) => d.name), ['내 아이폰', '태블릿'])
    assert.ok(!('key' in devices[0]), 'the keys never leave the bridge again')
    assert.equal((await call('POST', `/mobile/devices/${other.id}/revoke`)).status, 200)
    const { body } = sealed({ t: Date.now(), method: 'GET', path: '/mobile/view' }, other)
    assert.equal((await http('POST', '/api', body)).status, 401)
    assert.equal((await http('GET', `/events?d=${other.id}`)).status, 401)
  })

  test("disconnecting a phone whose live stream is open ends the stream, and the bridge goes on", async () => {
    const third = (await call('POST', '/mobile/pair', { name: '세 번째' })).json
    const ended = new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: `/events?d=${third.id}` }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve(text))
      })
      req.on('error', reject)
      req.end()
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal((await call('POST', `/mobile/devices/${third.id}/revoke`)).status, 200)
    assert.match(await ended, /: connected/)
    // More changes after it: before the fix, the next notice wrote to the ended stream and threw.
    await call('POST', '/sessions', { id: 'ph2', cwd: '/w/after' })
    assert.equal((await call('GET', '/health')).status, 200)
  })

  test('turned off, it stops listening', async () => {
    const off = (await call('POST', '/mobile', { enabled: false })).json
    assert.equal(off.listening, false)
    await assert.rejects(http('GET', '/'))
    port = (await call('POST', '/mobile', { enabled: true, port: 0 })).json.port
  })
})

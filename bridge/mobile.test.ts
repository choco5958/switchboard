import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createECDH, createPublicKey, randomBytes, verify } from 'node:crypto'
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge, listen } from './server.ts'
import { createMobile, mobileAddresses, mobileRouteAllowed, needsStrong, newPairCode, privateAddress, setTailscaleServe, strongTransport, tailscaleState, type Run } from './mobile.ts'
import { DatabaseSync } from 'node:sqlite'
import { encryptPush, pushAllowed, sendPush, validSubscription, vapidAuth, makeVapidKeys } from './push.ts'
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
  const interfaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '', mac: '', cidr: null }],
    tailscale0: [{ address: '100.90.1.2', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }],
    en0: [{ address: '192.168.0.5', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }],
    utun: [{ address: '8.8.4.4', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }],
  } as never
  assert.deepEqual(mobileAddresses(47390, { interfaces, name: 'mac.local', https: 'mac.tail1.ts.net' }), [
    { address: 'mac.tail1.ts.net', kind: 'https', url: 'https://mac.tail1.ts.net' },
    { address: '192.168.0.5', kind: 'lan', url: 'http://192.168.0.5:47390' },
    { address: 'mac.local', kind: 'name', url: 'http://mac.local:47390' },
    { address: '100.90.1.2', kind: 'tailscale', url: 'http://100.90.1.2:47390' },
  ])
  // This computer only: Tailscale HTTPS is the one way in.
  assert.deepEqual(mobileAddresses(47390, { interfaces, name: 'mac.local', https: 'mac.tail1.ts.net', lan: false }).map(a => a.kind), ['https'])
})

test('Tailscale HTTPS: on only for this port, and never over what 443 already serves', async () => {
  const fake = (serve: unknown): { run: Run; calls: string[][] } => {
    const calls: string[][] = []
    const run: Run = async (_bin, args) => {
      calls.push(args)
      if (args[0] === 'status') return { ok: true, out: JSON.stringify({ BackendState: 'Running', CertDomains: ['mac.tail1.ts.net'] }) }
      if (args.join(' ') === 'serve status --json') return { ok: true, out: JSON.stringify(serve) }
      return { ok: true, out: '' }
    }
    return { run, calls }
  }
  const none = fake({})
  assert.deepEqual(await tailscaleState(47390, none.run, '/bin/tailscale'), { installed: true, domain: 'mac.tail1.ts.net', served: false, busy: false })
  const ours = fake({ TCP: { 443: { HTTPS: true } }, Web: { 'mac.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47390' } } } } })
  assert.equal((await tailscaleState(47390, ours.run, '/bin/tailscale')).served, true)
  const other = fake({ TCP: { 443: { HTTPS: true } }, Web: { 'mac.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } })
  assert.deepEqual(await tailscaleState(47390, other.run, '/bin/tailscale'), { installed: true, domain: 'mac.tail1.ts.net', served: false, busy: true })
  assert.equal((await tailscaleState(47390, none.run, null)).installed, false)
  await setTailscaleServe(true, 47390, none.run, '/bin/tailscale')
  await setTailscaleServe(false, 47390, none.run, '/bin/tailscale')
  assert.deepEqual(none.calls.slice(-2), [['serve', '--bg', '--https=443', 'http://127.0.0.1:47390'], ['serve', '--https=443', 'off']])
})

describe('Web Push', () => {
  test('RFC 8291 appendix A: the same message, byte for byte', () => {
    const u = (s: string) => Buffer.from(s, 'base64url')
    const sub = { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } }
    const out = encryptPush(sub, Buffer.from('When I grow up, I want to be a watermelon'), { salt: u('DGv6ra1nlYgDCS1FRnbzlw'), senderPrivate: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') })
    assert.equal(
      out.toString('base64url'),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    )
  })

  test('the VAPID header carries a JWT for the push service, signed with the public key it names', () => {
    const keys = makeVapidKeys()
    const header = vapidAuth('https://fcm.googleapis.com/fcm/send/abc', keys, Date.UTC(2026, 0, 1))
    const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!
    assert.equal(k, keys.publicKey)
    const [h, c, sig] = jwt!.split('.')
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString())
    assert.equal(claims.aud, 'https://fcm.googleapis.com')
    assert.equal(claims.exp, Date.UTC(2026, 0, 1) / 1000 + 12 * 3600)
    assert.doesNotMatch(claims.sub, /@/, 'never a person’s address')
    const pub = Buffer.from(keys.publicKey, 'base64url')
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } })
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url')))
  })

  test('only real push services, and well-formed subscriptions', async () => {
    assert.ok(pushAllowed('https://fcm.googleapis.com/fcm/send/x'))
    assert.ok(pushAllowed('https://web.push.apple.com/QAbc'))
    assert.ok(pushAllowed('https://wns2-par02p.notify.windows.com/w/?token=x'))
    for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://127.0.0.1/x']) assert.ok(!pushAllowed(bad), bad)
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const good = { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
    assert.ok(validSubscription(good))
    assert.ok(!validSubscription({ ...good, endpoint: 'https://evil.example/x' }))
    assert.ok(!validSubscription({ ...good, keys: { ...good.keys, auth: 'short' } }))
    const seen: { url: string; headers: Record<string, string> }[] = []
    const fake = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers })
      return new Response(null, { status: 410 })
    }) as unknown as typeof fetch
    const result = await sendPush(good, { title: 't', body: 'b', tag: 'q1', tab: 'decisions' }, makeVapidKeys(), fake)
    assert.deepEqual(result, { ok: false, gone: true, status: 410 })
    assert.equal(seen[0]!.headers['content-encoding'], 'aes128gcm')
    assert.match(seen[0]!.headers.authorization!, /^vapid t=/)
  })
})

test('allowing and writing to a session take a connection nobody on the Wi-Fi can swap', () => {
  for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.100.3.48', 'fd7a:115c:a1e0::d536:331']) assert.ok(strongTransport(ok), ok)
  for (const no of ['192.168.0.5', '10.0.0.2', '172.16.0.1', 'fe80::1', '100.128.0.1']) assert.ok(!strongTransport(no), no)
  assert.ok(needsStrong('POST', '/outbox', {}))
  assert.ok(needsStrong('POST', '/approvals/3/answer', { decision: 'allow' }))
  for (const decision of ['deny', 'terminal']) assert.ok(!needsStrong('POST', '/approvals/3/answer', { decision }))
  assert.ok(!needsStrong('POST', '/questions/3/answer', { choice: 'a' }))
  assert.ok(!needsStrong('GET', '/mobile/view', {}))
  assert.notEqual(newPairCode(), newPairCode())
})

test('a pairing nobody used goes after ten minutes, with its code', async () => {
  let clock = 1_000_000
  const db = new DatabaseSync(':memory:')
  const mobile = createMobile({ db, inner: async () => ({ status: 200, json: {} }), strings: () => ({}), vapid: makeVapidKeys, now: () => clock, tailscale: null })
  mobile.pair('안 찍음')
  assert.equal((await mobile.status()).devices.length, 1)
  clock += 11 * 60_000
  assert.equal((await mobile.status()).devices.length, 0)
})

test('an address that keeps failing waits out the minute, before anything is decrypted', async () => {
  const db = new DatabaseSync(':memory:')
  const mobile = createMobile({ db, inner: async () => ({ status: 200, json: {} }), strings: () => ({}), vapid: makeVapidKeys, tailscale: null })
  await mobile.start(0, false)
  const { port } = await mobile.status()
  const post = (body: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api', headers: { 'content-type': 'application/json' } }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end(body)
    })
  const junk = JSON.stringify({ d: 1, n: toB64(randomBytes(12)), c: toB64(randomBytes(40)) })
  for (let i = 0; i < 30; i++) assert.equal(await post(junk), 401)
  assert.equal(await post(junk), 429)
  await mobile.stop()
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
  // Pushes the bridge sends, kept instead of going out.
  const pushes: { url: string; body: Uint8Array }[] = []
  const fakeFetch = (async (url: string, init: { body: Uint8Array }) => {
    pushes.push({ url: String(url), body: init.body })
    return new Response(null, { status: 201 })
  }) as unknown as typeof fetch
  const bridge = createBridge(join(dir, 'ide.db'), 'ko-KR', { appKey: APP_KEY, tailscale: null, fetch: fakeFetch })
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

  const http = (method: string, path: string, body?: string, host?: string): Promise<{ status: number; text: string; headers: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (host) headers.host = host
      const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }))
      })
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })

  // The live stream's link the page makes (mobile/app.js eventsLink): a sealed time, used once.
  const eventsPath = (who = phone, at = Date.now()) => {
    const nonce = randomBytes(12)
    return `/events?d=${who.id}&n=${toB64(nonce)}&c=${toB64(seal(fromB64(who.key), nonce, utf8(JSON.stringify({ t: at })), utf8(`sb1:ev:${who.id}`)))}`
  }

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
    assert.equal((await http('GET', eventsPath(other))).status, 401)
  })

  test("disconnecting a phone whose live stream is open ends the stream, and the bridge goes on", async () => {
    const third = (await call('POST', '/mobile/pair', { name: '세 번째' })).json
    const ended = new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: eventsPath(third) }, res => {
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

  test('a phone that turned notifications on gets one while the person is away, sealed for its browser', async () => {
    const key = (await ask('GET', '/push-key')).json.key
    assert.equal(Buffer.from(key, 'base64url').length, 65)
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const auth = randomBytes(16)
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/phone1', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }
    assert.equal((await ask('POST', '/push', { subscription: { ...subscription, endpoint: 'https://evil.example/x' } })).status, 400)
    assert.equal((await ask('POST', '/push', { subscription })).status, 200)
    // No app watching: the person is away.
    await call('POST', '/sessions', { id: 'ph3', cwd: '/w/push-app' })
    await call('POST', '/questions', { sessionId: 'ph3', question: '배포할까요?', options: [{ key: 'a', label: '예' }] })
    for (let i = 0; i < 50 && pushes.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(pushes[0]!.url, subscription.endpoint)
    // Opened the way the phone's browser opens it (RFC 8291).
    const body = Buffer.from(pushes[0]!.body)
    const salt = body.subarray(0, 16)
    const senderPublic = body.subarray(21, 86)
    const shared = ua.computeSecret(senderPublic)
    const { hkdfSync } = await import('node:crypto')
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), senderPublic]), 32))
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
    const sealed = body.subarray(86)
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
    decipher.setAuthTag(sealed.subarray(-16))
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()])
    const message = JSON.parse(plain.subarray(0, -1).toString())
    assert.equal(message.title, '결정 질문: push-app')
    assert.equal(message.body, '배포할까요?')
    assert.equal(message.tab, 'decisions')
    assert.equal((await ask('POST', '/push', { subscription: null })).json.on, false)
  })

  test('this computer only: it answers on 127.0.0.1, which Tailscale HTTPS forwards to', async () => {
    const local = (await call('POST', '/mobile', { enabled: true, port: 0, lan: false })).json
    assert.equal(local.lan, false)
    port = local.port
    assert.equal((await http('GET', '/')).status, 200)
    assert.deepEqual(local.addresses, [], 'no Tailscale here, so no address a phone could use')
    port = (await call('POST', '/mobile', { enabled: true, port: 0, lan: true })).json.port
  })

  test('another spelling of a used nonce, a request without its time, or one too large is refused', async () => {
    const { n, body } = sealed({ t: Date.now(), method: 'GET', path: '/mobile/view' })
    assert.equal((await http('POST', '/api', body)).status, 200)
    for (const spelling of [`${n}AAAA`, `${n.slice(0, 4)} ${n.slice(4)}`, `${n}=`]) assert.equal((await http('POST', '/api', body.replace(n, spelling))).status, 401, spelling)
    assert.equal((await ask('GET', '/mobile/view', undefined, NaN)).outer, 409, 'no time')
    const huge = JSON.stringify({ d: phone.id, n: toB64(randomBytes(12)), c: 'A'.repeat(70_000) })
    assert.notEqual((await http('POST', '/api', huge).catch(() => ({ status: 0 }))).status, 200)
  })

  test('the live stream needs the key, and a name this server does not go by is refused', async () => {
    assert.equal((await http('GET', `/events?d=${phone.id}`)).status, 401, 'the id alone opens nothing')
    assert.equal((await http('GET', eventsPath(phone, Date.now() - 10 * 60_000))).status, 401, 'an old link')
    // DNS rebinding: a page's own name pointed at this computer.
    assert.equal((await http('GET', '/', undefined, 'evil.example:47390')).status, 403)
    assert.equal((await http('GET', '/', undefined, `localhost:${port}`)).status, 200)
  })

  test('a pairing code, typed on the phone instead of the QR link, works once', async () => {
    const paired = (await call('POST', '/mobile/pair', { name: '홈 화면' })).json
    assert.match(paired.code, /^[A-Z2-9]{8}$/)
    const claim = (code: string) => http('POST', '/claim', JSON.stringify({ code }))
    const got = await claim(`${paired.code.slice(0, 4)}-${paired.code.slice(4).toLowerCase()}`)
    assert.equal(got.status, 200)
    assert.deepEqual(JSON.parse(got.text), { id: paired.id, key: paired.key })
    assert.equal((await claim(paired.code)).status, 404, 'once only')
    // Guessing: after ten wrong codes every open code goes.
    const next = (await call('POST', '/mobile/pair', { name: '또 하나' })).json
    for (let i = 0; i < 10; i++) await claim(`WRONG${i}XX`)
    assert.equal((await claim(next.code)).status, 404)
  })

  test('with phones turned off, no notification goes out', async () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/phone-off', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
    assert.equal((await ask('POST', '/push', { subscription })).status, 200)
    await call('POST', '/mobile', { enabled: false })
    const before = pushes.length
    await call('POST', '/questions', { sessionId: 'ph3', question: '꺼진 뒤의 질문' })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(pushes.length, before)
    port = (await call('POST', '/mobile', { enabled: true, port: 0 })).json.port
  })

  test('turned off, it stops listening', async () => {
    const off = (await call('POST', '/mobile', { enabled: false })).json
    assert.equal(off.listening, false)
    await assert.rejects(http('GET', '/'))
    port = (await call('POST', '/mobile', { enabled: true, port: 0 })).json.port
  })
})

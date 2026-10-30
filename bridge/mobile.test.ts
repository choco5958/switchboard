import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createECDH, createPublicKey, randomBytes, verify } from 'node:crypto'
import { createServer, request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge, listen } from './server.ts'
import { clientOf, createMobile, mobileAddresses, mobileRouteAllowed, needsStrong, newPairCode, privateAddress, rateKey, setTailscaleServe, strongTransport, tailscaleState, type Run } from './mobile.ts'
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
  const closed = { funnel: false, funnelAllowed: false, funnelLink: 'https://login.tailscale.com/admin/acls' }
  assert.deepEqual(await tailscaleState(47390, none.run, '/bin/tailscale'), { installed: true, domain: 'mac.tail1.ts.net', served: false, busy: false, ...closed })
  const ours = fake({ TCP: { 443: { HTTPS: true } }, Web: { 'mac.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47390' } } } } })
  assert.equal((await tailscaleState(47390, ours.run, '/bin/tailscale')).served, true)
  const other = fake({ TCP: { 443: { HTTPS: true } }, Web: { 'mac.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } })
  assert.deepEqual(await tailscaleState(47390, other.run, '/bin/tailscale'), { installed: true, domain: 'mac.tail1.ts.net', served: false, busy: true, ...closed })
  assert.equal((await tailscaleState(47390, none.run, null)).installed, false)
  await setTailscaleServe(true, 47390, none.run, '/bin/tailscale')
  await setTailscaleServe(false, 47390, none.run, '/bin/tailscale')
  assert.deepEqual(none.calls.slice(-2), [['serve', '--bg', '--https=443', 'http://127.0.0.1:47390'], ['serve', '--https=443', 'off']])
})

test('Tailscale Funnel: seen in the serve config, allowed by the tailnet, and turned off through serve', async () => {
  const calls: string[][] = []
  const run = (capMap: Record<string, unknown>, allow: Record<string, boolean>): Run => async (_bin, args) => {
    calls.push(args)
    if (args[0] === 'status') return { ok: true, out: JSON.stringify({ BackendState: 'Running', CertDomains: ['mac.tail1.ts.net'], Self: { ID: 'nAbc123CNTRL', CapMap: capMap } }) }
    if (args.join(' ') === 'serve status --json')
      return { ok: true, out: JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { 'mac.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47390' } } } }, AllowFunnel: allow }) }
    return { ok: true, out: '' }
  }
  const open = await tailscaleState(47390, run({ funnel: null, https: null }, { 'mac.tail1.ts.net:443': true }), '/bin/tailscale')
  assert.equal(open.funnel, true)
  assert.equal(open.funnelAllowed, true)
  assert.equal(open.funnelLink, 'https://login.tailscale.com/f/funnel?node=nAbc123CNTRL')
  const notYet = await tailscaleState(47390, run({ https: null }, {}), '/bin/tailscale')
  assert.equal(notYet.funnel, false)
  assert.equal(notYet.funnelAllowed, false)
  // Another port's funnel is not this page's.
  assert.equal((await tailscaleState(3000, run({ funnel: null }, { 'mac.tail1.ts.net:443': true }), '/bin/tailscale')).funnel, false)
  const plain = run({}, {})
  await setTailscaleServe(true, 47390, plain, '/bin/tailscale', true)
  await setTailscaleServe(true, 47390, plain, '/bin/tailscale', false)
  assert.deepEqual(calls.slice(-2), [
    ['funnel', '--bg', '--https=443', 'http://127.0.0.1:47390'],
    ['serve', '--bg', '--https=443', 'http://127.0.0.1:47390'],
  ])
})

test('the sender behind Tailscale HTTPS is the one X-Forwarded-For names, and only then', () => {
  assert.equal(clientOf('127.0.0.1', '203.0.113.7'), '203.0.113.7')
  assert.equal(clientOf('::ffff:127.0.0.1', '203.0.113.7, 10.0.0.1'), '203.0.113.7')
  assert.equal(clientOf('::1', ['198.51.100.2']), '198.51.100.2')
  assert.equal(clientOf('127.0.0.1', undefined), '127.0.0.1')
  // A phone on the Wi-Fi cannot pick a name to be counted under.
  assert.equal(clientOf('192.168.0.5', '203.0.113.7'), '192.168.0.5')
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

test('allowing, writing to a session and a memo take the Tailscale HTTPS address, which nobody on the Wi-Fi can swap', () => {
  const tls = { host: 'mac.tail1.ts.net', 'x-forwarded-proto': 'https' }
  for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.ok(strongTransport(ok, tls, 'mac.tail1.ts.net'), ok)
  assert.ok(strongTransport('127.0.0.1', { ...tls, host: 'MAC.tail1.ts.net:443' }, 'mac.tail1.ts.net'))
  // Plain HTTP, to a Wi-Fi or a Tailscale IP address: a network can answer for either.
  for (const no of ['192.168.0.5', '10.0.0.2', '172.16.0.1', 'fe80::1', '100.100.3.48', 'fd7a:115c:a1e0::d536:331']) assert.ok(!strongTransport(no, tls, 'mac.tail1.ts.net'), no)
  // From this computer without what tailscale serve adds: another tunnel (its own name), a local
  // program (no TLS), or Tailscale not known at all.
  assert.ok(!strongTransport('127.0.0.1', { ...tls, host: 'abc.trycloudflare.com' }, 'mac.tail1.ts.net'))
  assert.ok(!strongTransport('127.0.0.1', { ...tls, host: 'localhost:47390' }, 'mac.tail1.ts.net'))
  assert.ok(!strongTransport('127.0.0.1', { host: 'mac.tail1.ts.net' }, 'mac.tail1.ts.net'))
  assert.ok(!strongTransport('127.0.0.1', tls, ''))
  assert.ok(needsStrong('POST', '/outbox', {}))
  assert.ok(needsStrong('POST', '/approvals/3/answer', { decision: 'allow' }))
  for (const decision of ['deny', 'terminal']) assert.ok(!needsStrong('POST', '/approvals/3/answer', { decision }))
  assert.ok(!needsStrong('POST', '/questions/3/answer', { choice: 'a' }))
  assert.ok(!needsStrong('POST', '/questions/3/answer', { choice: 'a', memo: '  ' }))
  // A memo goes into the session's prompt: words of the phone's own, as a message would be.
  for (const memo of ['이유', 3, ['x'], { a: 1 }]) assert.ok(needsStrong('POST', '/questions/3/answer', { choice: 'a', memo }), String(memo))
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
  // Through Tailscale Funnel every phone comes from 127.0.0.1: a stranger's failures are counted
  // under the stranger's address, and leave the person's own phone alone.
  const via = (from: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api', headers: { 'content-type': 'application/json', 'x-forwarded-for': from } }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end(junk)
    })
  for (let i = 0; i < 30; i++) assert.equal(await via('203.0.113.7'), 401)
  assert.equal(await via('203.0.113.7'), 429)
  assert.equal(await via('198.51.100.2'), 401)
  await mobile.stop()
})

// A request to a phone server of its own (createMobile), with the headers Tailscale HTTPS would add.
const raw = (port: number, method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
const sealedFor = (who: { id: number; key: string }, inner: unknown) => {
  const nonce = randomBytes(12)
  return JSON.stringify({ d: who.id, n: toB64(nonce), c: toB64(seal(fromB64(who.key), nonce, utf8(JSON.stringify(inner)), utf8(`sb1:req:${who.id}`))) })
}
const junkBody = () => JSON.stringify({ d: 1, n: toB64(randomBytes(12)), c: toB64(randomBytes(40)) })
const quiet = () => ({ inner: async () => ({ status: 200, json: {} }), strings: () => ({}), vapid: makeVapidKeys })

test('no request runs a tailscale command, and a name the bridge does not go by counts as a failure', async () => {
  const calls: string[][] = []
  const run: Run = async (_bin, args) => {
    calls.push(args)
    if (args[0] === 'status') return { ok: true, out: JSON.stringify({ BackendState: 'Running', CertDomains: ['mac.tail1.ts.net'] }) }
    return { ok: true, out: '{}' }
  }
  const mobile = createMobile({ db: new DatabaseSync(':memory:'), ...quiet(), run, tailscale: '/bin/tailscale' })
  await mobile.start(0, false)
  const { port } = await mobile.status()
  const phone = mobile.pair('폰', 'https')
  const before = calls.length
  assert.ok(before > 0, 'starting and the status look at Tailscale')
  const host = { host: 'mac.tail1.ts.net' }
  assert.equal((await raw(port, 'GET', '/', undefined, host)).status, 200, 'the name known since the start')
  const routes: [string, string, string?][] = [
    ['GET', '/app.js'],
    ['GET', '/time'],
    ['GET', '/strings'],
    ['GET', '/events?d=1'],
    ['POST', '/claim', '{"code":"ABCDEFGH"}'],
    ['POST', '/api', junkBody()],
    ['POST', '/api', sealedFor(phone, { t: Date.now(), method: 'GET', path: '/mobile/view' })],
    ['GET', '/nothing'],
  ]
  for (const [method, path, body] of routes) await raw(port, method, path, body, host)
  // Names under .ts.net it does not go by: refused without asking Tailscale, and counted.
  for (let i = 0; i < 30; i++) assert.equal((await raw(port, 'GET', '/', undefined, { host: `other${i}.ts.net`, 'x-forwarded-for': '203.0.113.30' })).status, 403)
  assert.equal(calls.length, before, 'no tailscale command ran for a request')
  assert.equal((await raw(port, 'GET', '/time', undefined, { ...host, 'x-forwarded-for': '203.0.113.30' })).status, 429)
  await mobile.stop()
})

test('slow uploads from one sender cannot hold every connection, and each body gets a few seconds', async () => {
  const mobile = createMobile({ db: new DatabaseSync(':memory:'), ...quiet(), tailscale: null, bodyMs: 300 })
  await mobile.start(0, false)
  const { port } = await mobile.status()
  const from = { 'x-forwarded-for': '203.0.113.40' }
  // Headers, then one byte of a body that never comes.
  const slow = () =>
    new Promise<string>(resolve => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api', agent: false, headers: { 'content-type': 'application/json', 'content-length': '20000', ...from } }, res => {
        res.resume()
        res.on('end', () => resolve(`answered ${res.statusCode}`))
      })
      req.on('error', () => resolve('closed'))
      req.write('{')
    })
  const began = Date.now()
  const hanging = Array.from({ length: 8 }, slow)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal((await raw(port, 'GET', '/time', undefined, from)).status, 429, 'eight open at once is the most')
  assert.equal((await raw(port, 'GET', '/time', undefined, { 'x-forwarded-for': '198.51.100.40' })).status, 200, 'another phone gets in')
  assert.deepEqual(await Promise.all(hanging), Array(8).fill('closed'))
  assert.ok(Date.now() - began < 3000, 'cut off by the body deadline')
  assert.equal((await raw(port, 'GET', '/time', undefined, from)).status, 200, 'its places are free again')
  await mobile.stop()
})

// Tailscale as the tests see it: running, with the HTTPS name below, and a serve config kept
// in `served` (the port tailscale serve sends the name to, or 0). Nothing real runs.
const DOMAIN = 'mac.tail1.ts.net'
const TLS = { host: DOMAIN, 'x-forwarded-proto': 'https' }
const fakeTailscale = () => {
  const ts = { served: 0, funnel: false, calls: [] as string[][] }
  const run: Run = async (_bin, args) => {
    ts.calls.push(args)
    if (args[0] === 'status') return { ok: true, out: JSON.stringify({ BackendState: 'Running', CertDomains: [DOMAIN], Self: { ID: 'n1', CapMap: { funnel: null } } }) }
    if (args.join(' ') === 'serve status --json') {
      if (!ts.served) return { ok: true, out: '{}' }
      return { ok: true, out: JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${DOMAIN}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${ts.served}` } } } }, AllowFunnel: ts.funnel ? { [`${DOMAIN}:443`]: true } : {} }) }
    }
    if (args.join(' ') === 'serve --https=443 off') {
      ts.served = 0
      ts.funnel = false
    } else if (args[1] === '--bg') {
      ts.served = Number(args[3]!.split(':').pop())
      ts.funnel = args[0] === 'funnel'
    }
    return { ok: true, out: '' }
  }
  return { ts, run }
}

test('strangers guessing pairing codes never keep the person from pairing, and each guesser waits longer', async () => {
  let clock = Date.now()
  const { run } = fakeTailscale()
  const mobile = createMobile({ db: new DatabaseSync(':memory:'), ...quiet(), tailscale: '/bin/tailscale', run, now: () => clock })
  await mobile.start(0, false)
  const { port } = await mobile.status()
  const paired = mobile.pair('홈 화면', 'https')
  const claim = (code: string, from: string) => raw(port, 'POST', '/claim', JSON.stringify({ code }), { ...TLS, 'x-forwarded-for': from })
  // Over plain HTTP, or from a tunnel that is not Tailscale's, no code is handed over.
  assert.equal((await raw(port, 'POST', '/claim', JSON.stringify({ code: paired.code }), { 'x-forwarded-for': '198.51.100.9' })).status, 403)
  for (let i = 0; i < 60; i++) assert.equal((await claim('WRONGXXX', `203.0.113.${100 + i}`)).status, 404)
  assert.equal((await claim(paired.code, '198.51.100.60')).status, 200, 'a first try is heard')
  // One guesser: five, then a minute, then two.
  const guesser = '2001:db8:aa:1::5'
  for (let i = 0; i < 5; i++) assert.equal((await claim('WRONGXXX', guesser)).status, 404)
  assert.equal((await claim('WRONGXXX', '2001:db8:aa:2::9')).status, 429, 'the same /48')
  clock += 61_000
  assert.equal((await claim('WRONGXXX', guesser)).status, 404)
  clock += 61_000
  assert.equal((await claim('WRONGXXX', guesser)).status, 429, 'two minutes now')
  clock += 61_000
  assert.equal((await claim('WRONGXXX', guesser)).status, 404)
  await mobile.stop()
})

test('a phone paired over plain HTTP is heard from the network only, sees no secret and adds no memo', async () => {
  const { run } = fakeTailscale()
  let from = '192.168.0.23'
  const summary = 'curl -H "Authorization: Bearer abcdefghijklmnop" https://x.example'
  const inner = async (_method: string, path: string) =>
    path === '/mobile/view' ? { status: 200, json: { approvals: [{ id: 1, summary, cwd: '/w/token=abc123' }, { id: 2, summary: 'ls‮', cwd: '' }] } } : { status: 200, json: {} }
  const mobile = createMobile({ db: new DatabaseSync(':memory:'), inner, strings: () => ({}), vapid: makeVapidKeys, tailscale: '/bin/tailscale', run, addressOf: () => from, summaryOf: id => (id === 2 ? 'ls‮' : summary) })
  await mobile.start(0, false)
  const { port } = await mobile.status()
  const weak = mobile.pair('Wi-Fi', 'lan')
  const tailnetIp = mobile.pair('Tailscale IP', 'tailscale')
  const strong = mobile.pair('HTTPS', 'https')
  const ask = async (who: { id: number; key: string }, inner: unknown, headers: Record<string, string> = {}) => {
    const nonce = randomBytes(12)
    const wire = JSON.stringify({ d: who.id, n: toB64(nonce), c: toB64(seal(fromB64(who.key), nonce, utf8(JSON.stringify({ t: Date.now(), ...(inner as object) })), utf8(`sb1:req:${who.id}`))) })
    const res = await raw(port, 'POST', '/api', wire, headers)
    const out = JSON.parse(res.text) as { n: string; c: string }
    return JSON.parse(fromUtf8(open(fromB64(who.key), fromB64(out.n), fromB64(out.c), utf8(`sb1:res:${who.id}:${toB64(nonce)}`))!)) as { status: number; json: any }
  }
  // From the Wi-Fi: it reads, with secrets masked, answers and denies, but adds no memo.
  const view = await ask(weak, { method: 'GET', path: '/mobile/view' })
  assert.equal(view.status, 200)
  assert.equal(view.json.pairedStrong, false)
  assert.equal(view.json.approvals[0].summary, 'curl -H "Authorization: Bearer ***" https://x.example')
  assert.equal(view.json.approvals[0].cwd, '/w/token=***')
  assert.equal((await ask(weak, { method: 'POST', path: '/questions/1/answer', body: { choice: 'a' } })).status, 200)
  assert.deepEqual((await ask(weak, { method: 'POST', path: '/questions/1/answer', body: { choice: 'a', memo: '이렇게 해 줘' } })).json, { error: 'strong', strong: true, pairAgain: false })
  // A phone paired through a Tailscale IP address counts as plain HTTP too.
  assert.equal((await ask(tailnetIp, { method: 'GET', path: '/mobile/view' })).json.pairedStrong, false)
  // Through Tailscale HTTPS or Funnel (from this computer): not heard at all.
  from = '127.0.0.1'
  for (const who of [weak, tailnetIp]) assert.deepEqual((await ask(who, { method: 'GET', path: '/mobile/view' }, { ...TLS, 'x-forwarded-for': '203.0.113.80' })).json, { error: 'strong', strong: true, pairAgain: true })
  const events = (who: { id: number; key: string }) => {
    const nonce = randomBytes(12)
    return `/events?d=${who.id}&n=${toB64(nonce)}&c=${toB64(seal(fromB64(who.key), nonce, utf8(JSON.stringify({ t: Date.now() })), utf8(`sb1:ev:${who.id}`)))}`
  }
  assert.equal((await raw(port, 'GET', events(weak), undefined, TLS)).status, 403)
  // The phone paired through the HTTPS address sees the command whole, and may allow it.
  const shown = await ask(strong, { method: 'GET', path: '/mobile/view' }, TLS)
  assert.equal(shown.json.approvals[0].summary, summary)
  assert.equal(shown.json.approvals[0].hidden, false)
  assert.equal((await ask(strong, { method: 'POST', path: '/questions/1/answer', body: { choice: 'a', memo: '이유' } }, TLS)).status, 200)
  assert.equal((await ask(strong, { method: 'POST', path: '/approvals/1/answer', body: { decision: 'allow' } }, TLS)).status, 200)
  // Characters that hide or reorder text show as [U+...], and such a command is not allowed here.
  assert.equal(shown.json.approvals[1].summary, 'ls[U+202E]')
  assert.equal(shown.json.approvals[1].hidden, true)
  assert.deepEqual((await ask(strong, { method: 'POST', path: '/approvals/2/answer', body: { decision: 'allow' } }, TLS)).json, { error: 'hidden', hidden: true })
  assert.equal((await ask(strong, { method: 'POST', path: '/approvals/2/answer', body: { decision: 'deny' } }, TLS)).status, 200)
  // From this computer without Tailscale's marks (another tunnel, a local program): plain HTTP.
  assert.equal((await ask(strong, { method: 'POST', path: '/approvals/1/answer', body: { decision: 'allow' } }, { 'x-forwarded-for': '203.0.113.81' })).status, 403)
  await mobile.stop()
})

test('phones paired before an address was kept count as plain HTTP once, and are told to pair again', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec('create table mobile_devices (id integer primary key, name text not null, key text not null, created_at integer not null, last_seen integer, push text, strong integer not null default 0)')
  db.prepare('insert into mobile_devices (name, key, created_at, last_seen, strong) values (?, ?, ?, ?, 1)').run('Tailscale IP 폰', toB64(randomBytes(32)), Date.now(), Date.now())
  createMobile({ db, ...quiet(), tailscale: null })
  const again = createMobile({ db, ...quiet(), tailscale: null })
  const after = again.pair('새 폰', 'https')
  // Started once more: only the first start downgrades.
  createMobile({ db, ...quiet(), tailscale: null })
  const devices = (await again.status()).devices
  assert.deepEqual(devices.map(d => [d.name, d.strong]), [['Tailscale IP 폰', false], ['새 폰', true]])
  assert.equal(after.id, 2)
})

test('Tailscale HTTPS goes off when phones do and when the bridge leaves, and comes back as the person left it', async () => {
  const { ts, run } = fakeTailscale()
  const db = new DatabaseSync(':memory:')
  const kept: string[] = []
  const make = () => createMobile({ db, ...quiet(), tailscale: '/bin/tailscale', run, keepTailscale: mode => kept.push(mode), bindMs: 300 })
  const first = make()
  // Settings from before the mode was kept: what is found is kept, nothing changes.
  await first.start(0, false)
  const { port } = await first.status()
  assert.deepEqual(kept, ['off'])
  assert.equal((await first.tailscale(true)).ok, true)
  assert.equal(ts.served, port)
  // Phones turned off: the address goes before the port is let go.
  await first.stop(true)
  assert.equal(ts.served, 0)
  // On again, as the person left it.
  await first.start(port, false, 'serve')
  assert.equal(ts.served, port)
  // The bridge on its way out (an update replaces it): off; the next one turns it on again.
  await first.shutdown()
  assert.equal(ts.served, 0)
  const second = make()
  await second.start(port, false, 'funnel')
  assert.equal(ts.served, port)
  assert.equal(ts.funnel, true)
  await second.stop()
  assert.equal(ts.served, port, 'a restart alone leaves it')
  // Another program holds the port: the address would bring the person's phones to it.
  const squatter = createServer(() => {})
  await new Promise<void>((resolve, reject) => squatter.once('error', reject).listen(port, '127.0.0.1', resolve))
  const third = make()
  await third.start(port, false, 'serve')
  assert.equal((await third.status()).listening, false)
  assert.equal(ts.served, 0)
  squatter.close()
  const offs = ts.calls.filter(c => c.join(' ') === 'serve --https=443 off').length
  assert.equal(offs, 3)
})

test('strangers holding requests open leave room for a phone that showed its key', async () => {
  const { run } = fakeTailscale()
  const mobile = createMobile({ db: new DatabaseSync(':memory:'), ...quiet(), tailscale: '/bin/tailscale', run, bodyMs: 1500 })
  await mobile.start(0, false)
  const { port } = await mobile.status()
  const phone = mobile.pair('폰', 'https')
  // The phone came through Funnel once.
  assert.equal((await raw(port, 'POST', '/api', sealedFor(phone, { t: Date.now(), method: 'GET', path: '/mobile/view' }), { ...TLS, 'x-forwarded-for': '198.51.100.70' })).status, 200)
  const slow = (from: string) =>
    new Promise<string>(resolve => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api', agent: false, headers: { 'content-type': 'application/json', 'content-length': '20000', 'x-forwarded-for': from } }, res => {
        res.resume()
        res.on('end', () => resolve(`answered ${res.statusCode}`))
      })
      req.on('error', () => resolve('closed'))
      req.write('{')
    })
  const hanging = Array.from({ length: 48 }, (_, i) => slow(`203.0.113.${150 + Math.floor(i / 8)}`))
  // Once all 48 are in (a busy machine takes a while), one more stranger finds no room.
  let stranger = 0
  for (let i = 0; i < 100 && stranger !== 429; i++) {
    await new Promise(resolve => setTimeout(resolve, 30))
    stranger = (await raw(port, 'GET', '/time', undefined, { 'x-forwarded-for': '203.0.113.200' })).status
  }
  assert.equal(stranger, 429, 'no room for one more stranger')
  assert.notEqual((await raw(port, 'GET', '/time', undefined, { 'x-forwarded-for': '198.51.100.70' })).status, 429, 'the phone gets in')
  await Promise.all(hanging)
  await mobile.stop()
})

test('IPv6 senders are counted by their /64, and many senders never unblock a blocked one', async () => {
  assert.equal(rateKey('2001:db8:1:2::9'), '2001:db8:1:2::/64')
  assert.equal(rateKey('2001:db8:1:2:3:4:5:6'), rateKey('2001:db8:1:2::9'))
  assert.notEqual(rateKey('2001:db8:1:3::9'), rateKey('2001:db8:1:2::9'))
  assert.equal(rateKey('2001:DB8::1'), '2001:db8:0:0::/64')
  assert.equal(rateKey('fe80::1%en0'), 'fe80:0:0:0::/64')
  assert.equal(rateKey('::ffff:192.168.0.5'), '192.168.0.5')
  assert.equal(rateKey('203.0.113.7'), '203.0.113.7')
  const mobile = createMobile({ db: new DatabaseSync(':memory:'), ...quiet(), tailscale: null })
  await mobile.start(0, false)
  const { port } = await mobile.status()
  const junk = (from: string) => raw(port, 'POST', '/api', junkBody(), { 'x-forwarded-for': from })
  for (let i = 0; i < 30; i++) assert.equal((await junk('203.0.113.50')).status, 401)
  assert.equal((await junk('203.0.113.50')).status, 429)
  // More senders than the bridge keeps: the oldest that blocks nobody goes, never everyone.
  for (let i = 0; i < 1001; i++) assert.equal((await junk(`2001:db8:${i.toString(16)}::1`)).status, 401)
  assert.equal((await junk('203.0.113.50')).status, 429, 'still blocked')
  // Every address of one /64 is one sender.
  for (let i = 0; i < 30; i++) assert.equal((await junk(`2001:db8:ffff:1::${(i + 1).toString(16)}`)).status, 401)
  assert.equal((await junk('2001:db8:ffff:1:aaaa::1')).status, 429)
  await mobile.stop()
})

test('after a restart, a request recorded before it is refused', async () => {
  let clock = Date.now()
  const db = new DatabaseSync(':memory:')
  const first = createMobile({ db, ...quiet(), tailscale: null, now: () => clock })
  const phone = first.pair('폰', 'https')
  await first.start(0, false)
  const recorded = sealedFor(phone, { t: clock, method: 'GET', path: '/mobile/view' })
  assert.equal((await raw((await first.status()).port, 'POST', '/api', recorded)).status, 200)
  await first.stop()
  // Thirty seconds later the bridge starts again, and no longer knows that nonce.
  clock += 30_000
  const second = createMobile({ db, ...quiet(), tailscale: null, now: () => clock })
  await second.start(0, false)
  const { port } = await second.status()
  const replay = await raw(port, 'POST', '/api', recorded)
  assert.equal(replay.status, 409)
  assert.equal(JSON.parse(replay.text).now, clock, 'the page takes this time and sends again')
  assert.equal((await raw(port, 'POST', '/api', sealedFor(phone, { t: clock, method: 'GET', path: '/mobile/view' }))).status, 200)
  await second.stop()
})

test('phones paired before the bridge kept how count as paired over plain HTTP', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec('create table mobile_devices (id integer primary key, name text not null, key text not null, created_at integer not null, last_seen integer, push text)')
  db.prepare('insert into mobile_devices (name, key, created_at, last_seen) values (?, ?, ?, ?)').run('예전 폰', toB64(randomBytes(32)), Date.now(), Date.now())
  const mobile = createMobile({ db, ...quiet(), tailscale: null })
  const [old] = (await mobile.status()).devices
  assert.equal(old?.strong, false)
  assert.equal(mobile.pair('새 폰', 'https').id, 2)
  assert.equal((await mobile.status()).devices[1]?.strong, true)
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
  const tailscale = fakeTailscale()
  const bridge = createBridge(join(dir, 'ide.db'), 'ko-KR', { appKey: APP_KEY, tailscale: '/bin/tailscale', tailscaleRun: tailscale.run, fetch: fakeFetch })
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

  // As a phone through Tailscale HTTPS: from 127.0.0.1, with the marks tailscale serve adds.
  const http = (method: string, path: string, body?: string, host?: string, extra: Record<string, string> = {}): Promise<{ status: number; text: string; headers: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { 'content-type': 'application/json', ...TLS, ...extra }
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
  const ask = async (method: string, path: string, body?: unknown, at = Date.now(), who = phone) => {
    const { n, body: wire } = sealed({ t: at, method, path, body }, who)
    const res = await http('POST', '/api', wire)
    if (res.status !== 200) return { outer: res.status, status: 0, json: JSON.parse(res.text) as any }
    const out = JSON.parse(res.text) as { n: string; c: string }
    const plain = open(fromB64(who.key), fromB64(out.n), fromB64(out.c), utf8(`sb1:res:${who.id}:${n}`))
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
    // Shown for the Tailscale HTTPS address: it may allow and write.
    phone = (await call('POST', '/mobile/pair', { name: '내 아이폰', kind: 'https' })).json
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
    const third = (await call('POST', '/mobile/pair', { name: '세 번째', kind: 'https' })).json
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

  // Each claim test comes as its own sender: tries are limited per sender.
  const claim = (code: string, from: string) => http('POST', '/claim', JSON.stringify({ code }), undefined, { 'x-forwarded-for': from })
  const codeOpen = async (id: number) => (await call('GET', '/mobile')).json.devices.find((d: { id: number }) => d.id === id)?.code

  test('a pairing code, typed on the phone instead of the QR link, works once and hands over a key of its own', async () => {
    // Shown for a Wi-Fi address: the QR code's key may have been read on the way.
    const paired = (await call('POST', '/mobile/pair', { name: '홈 화면', kind: 'lan' })).json
    assert.match(paired.code, /^[A-Z2-9]{8}$/)
    assert.equal(await codeOpen(paired.id), true)
    const got = await claim(`${paired.code.slice(0, 4)}-${paired.code.slice(4).toLowerCase()}`, '203.0.113.20')
    assert.equal(got.status, 200)
    const claimed = JSON.parse(got.text) as { id: number; key: string }
    assert.equal(claimed.id, paired.id)
    assert.notEqual(claimed.key, paired.key, 'a new key, not the one in the QR code')
    assert.equal(await codeOpen(paired.id), false, 'the app sees the code is gone')
    assert.equal((await claim(paired.code, '203.0.113.20')).status, 404, 'once only')
    const old = sealed({ t: Date.now(), method: 'GET', path: '/mobile/view' }, paired)
    assert.equal((await http('POST', '/api', old.body)).status, 401, 'the QR code key no longer opens anything')
    // Claimed over Tailscale HTTPS: this phone may allow.
    assert.equal((await ask('GET', '/mobile/view', undefined, Date.now(), claimed)).json.pairedStrong, true)
  })

  test('wrong codes slow down the one guessing and leave everyone else’s codes open', async () => {
    const next = (await call('POST', '/mobile/pair', { name: '또 하나', kind: 'https' })).json
    for (let i = 0; i < 5; i++) assert.equal((await claim(`WRONG${i}XX`, '203.0.113.21')).status, 404)
    assert.equal((await claim(next.code, '203.0.113.21')).status, 429, 'five tries a minute for one sender')
    assert.equal(await codeOpen(next.id), true, 'the code is still open')
    assert.equal((await claim(next.code, '203.0.113.22')).status, 200)
  })

  test('a code stops working once its phone comes with the QR code', async () => {
    const paired = (await call('POST', '/mobile/pair', { name: 'QR 먼저', kind: 'https' })).json
    assert.equal(await codeOpen(paired.id), true)
    assert.equal((await ask('GET', '/mobile/view', undefined, Date.now(), paired)).status, 200)
    assert.equal(await codeOpen(paired.id), false)
    assert.equal((await claim(paired.code, '203.0.113.23')).status, 404)
    // And the phone that came keeps its key.
    assert.equal((await ask('GET', '/mobile/view', undefined, Date.now(), paired)).status, 200)
  })

  test('a phone paired with a link to a plain HTTP address, a Tailscale IP one too, is not heard through Tailscale HTTPS', async () => {
    await call('POST', '/sessions', { id: 'ph9', cwd: '/w/weak' })
    const a = (await call('POST', '/approvals', { sessionId: 'ph9', tool: 'Bash', summary: 'ls', requestKey: 'weak' })).json
    for (const kind of ['lan', 'name', 'tailscale', undefined]) {
      const weak = (await call('POST', '/mobile/pair', { name: `HTTP ${kind}`, kind })).json
      // This test comes from 127.0.0.1 with Tailscale's marks, as Tailscale HTTPS and Funnel do.
      for (const [method, path, body] of [['GET', '/mobile/view'], ['POST', `/approvals/${a.id}/answer`, { decision: 'deny' }], ['POST', '/outbox', { sessionId: 'ph9', text: 'x' }]] as const) {
        const refused = await ask(method, path, body, Date.now(), weak)
        assert.equal(refused.status, 403, `${kind} ${path}`)
        assert.deepEqual(refused.json, { error: 'strong', strong: true, pairAgain: true })
      }
    }
    assert.equal((await call('GET', `/approvals/${a.id}`)).json.status, 'pending')
    const devices = (await call('GET', '/mobile')).json.devices as { name: string; strong: boolean }[]
    assert.equal(devices.find(d => d.name === 'HTTP lan')?.strong, false)
    assert.equal(devices.find(d => d.name === 'HTTP tailscale')?.strong, false)
    await call('POST', `/approvals/${a.id}/answer`, { decision: 'deny' })
  })

  test('phones off takes Tailscale HTTPS off, and phones on brings it back as the person left it', async () => {
    const on = await call('POST', '/mobile/tailscale', { on: true })
    assert.equal(on.status, 200)
    assert.equal(tailscale.ts.served, port)
    assert.equal(on.json.addresses[0].url, `https://${DOMAIN}`)
    assert.equal((await call('POST', '/mobile', { enabled: false })).json.listening, false)
    assert.equal(tailscale.ts.served, 0)
    port = (await call('POST', '/mobile', { enabled: true })).json.port
    assert.equal(tailscale.ts.served, port)
    assert.equal((await call('POST', '/mobile/tailscale', { on: false })).status, 200)
    assert.equal(tailscale.ts.served, 0)
    port = (await call('POST', '/mobile', { enabled: true, port: 0 })).json.port
    assert.equal(tailscale.ts.served, 0, 'left off')
  })

  test('the largest memo the page lets a person write fits, and a body larger than any real one is refused unread', async () => {
    await call('POST', '/sessions', { id: 'ph8', cwd: '/w/long' })
    const q = (await call('POST', '/questions', { sessionId: 'ph8', question: '길게?' })).json
    // TEXT_MAX in mobile/app.js: 4000 characters, three bytes each.
    assert.equal((await ask('POST', `/questions/${q.id}/answer`, { memo: '가'.repeat(4000) })).status, 200)
    const big = JSON.stringify({ d: phone.id, n: toB64(randomBytes(12)), c: 'A'.repeat(40_000) })
    // Answered 413 and closed at once: the client may see the close before the answer.
    const refused = await http('POST', '/api', big, undefined, { 'x-forwarded-for': '203.0.113.24' }).catch(() => ({ status: 413 }))
    assert.equal(refused.status, 413)
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

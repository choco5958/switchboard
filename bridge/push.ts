// Web Push for the phone page (bridge/mobile.ts): a phone that opened the page over HTTPS
// (Tailscale) and turned notifications on gets a notification when a decision or a permission
// ask waits. The bridge sends it to the phone browser's push service (Apple, Google, Mozilla,
// Microsoft), encrypted for that browser (RFC 8291), so the service relays what it cannot read;
// the VAPID signature (RFC 8292) tells the service it comes from this bridge's key.

import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto'

export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } }
export type VapidKeys = { publicKey: string; privateKey: string }
export type PushMessage = { title: string; body: string; tag: string; tab: string }

// Who the push services may contact about this sender (RFC 8292 "sub"); never the person's address.
export const VAPID_SUBJECT = 'https://github.com/choco5958/switchboard'
const RECORD_SIZE = 4096

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const unb64 = (text: string) => Buffer.from(text, 'base64url')

// Push services only: a subscription that names anything else is refused, so the bridge never
// posts to an address a page made up.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /\.notify\.windows\.com$/]
export function pushAllowed(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    return url.protocol === 'https:' && url.port === '' && PUSH_HOSTS.some(host => host.test(url.hostname))
  } catch {
    return false
  }
}

export function validSubscription(value: unknown): value is Subscription {
  const sub = value as Subscription | null
  return (
    typeof sub?.endpoint === 'string' &&
    pushAllowed(sub.endpoint) &&
    typeof sub.keys?.p256dh === 'string' &&
    unb64(sub.keys.p256dh).length === 65 &&
    typeof sub.keys?.auth === 'string' &&
    unb64(sub.keys.auth).length === 16
  )
}

export function makeVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()) }
}

// The Authorization header: a JWT for the push service's origin, signed with the VAPID key (ES256).
export function vapidAuth(endpoint: string, keys: VapidKeys, now = Date.now()): string {
  const header = b64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: VAPID_SUBJECT })))
  const pub = unb64(keys.publicKey)
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) } })
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${keys.publicKey}`
}

const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length))

// The message body for one subscription (RFC 8291, aes128gcm, one record). `fixed` is for the
// RFC's own example only: a sender always makes a new key pair and salt.
export function encryptPush(sub: Subscription, payload: Uint8Array, fixed?: { salt: Uint8Array; senderPrivate: Uint8Array }): Buffer {
  const receiverPublic = unb64(sub.keys.p256dh)
  const authSecret = unb64(sub.keys.auth)
  const sender = createECDH('prime256v1')
  if (fixed) sender.setPrivateKey(fixed.senderPrivate)
  else sender.generateKeys()
  const senderPublic = sender.getPublicKey()
  const shared = sender.computeSecret(receiverPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic])
  const ikm = hkdf(shared, authSecret, keyInfo, 32)
  const salt = fixed?.salt ?? randomBytes(16)
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02: the last (and only) record, no padding after it.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const head = Buffer.alloc(21)
  salt instanceof Buffer ? salt.copy(head, 0) : head.set(salt, 0)
  head.writeUInt32BE(RECORD_SIZE, 16)
  head.writeUInt8(senderPublic.length, 20)
  return Buffer.concat([head, senderPublic, sealed])
}

// Sends one notification. `gone`: the push service no longer knows the subscription (the phone
// turned notifications off or the browser dropped it), so it can be forgotten.
export async function sendPush(sub: Subscription, message: PushMessage, keys: VapidKeys, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; gone: boolean; status: number }> {
  if (!pushAllowed(sub.endpoint)) return { ok: false, gone: true, status: 0 }
  try {
    const res = await fetchFn(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuth(sub.endpoint, keys),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: '3600',
        urgency: 'high',
        topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'switchboard',
      },
      body: new Uint8Array(encryptPush(sub, Buffer.from(JSON.stringify(message)))),
      signal: AbortSignal.timeout(10_000),
    })
    return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status }
  } catch {
    return { ok: false, gone: false, status: 0 }
  }
}

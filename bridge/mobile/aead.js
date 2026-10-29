// ChaCha20-Poly1305 (RFC 8439) in plain JavaScript, for the phone page and the bridge alike.
// A phone opens the page over plain HTTP on the local network, where the browser offers no
// WebCrypto, and the app's own Node (Electron's BoringSSL) has no ChaCha20; so both ends use
// this one implementation. bridge/mobile.test.ts checks it against Node's native cipher.

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]

const rotl = (v, c) => (v << c) | (v >>> (32 - c))

function quarter(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) | 0
  s[d] = rotl(s[d] ^ s[a], 16)
  s[c] = (s[c] + s[d]) | 0
  s[b] = rotl(s[b] ^ s[c], 12)
  s[a] = (s[a] + s[b]) | 0
  s[d] = rotl(s[d] ^ s[a], 8)
  s[c] = (s[c] + s[d]) | 0
  s[b] = rotl(s[b] ^ s[c], 7)
}

const words = (bytes, count) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: count }, (_, i) => view.getUint32(i * 4, true))
}

// One 64-byte block of key stream.
function block(key, counter, nonce) {
  const init = [...SIGMA, ...words(key, 8), counter >>> 0, ...words(nonce, 3)]
  const s = init.slice()
  for (let i = 0; i < 10; i++) {
    quarter(s, 0, 4, 8, 12)
    quarter(s, 1, 5, 9, 13)
    quarter(s, 2, 6, 10, 14)
    quarter(s, 3, 7, 11, 15)
    quarter(s, 0, 5, 10, 15)
    quarter(s, 1, 6, 11, 12)
    quarter(s, 2, 7, 8, 13)
    quarter(s, 3, 4, 9, 14)
  }
  const out = new Uint8Array(64)
  const view = new DataView(out.buffer)
  for (let i = 0; i < 16; i++) view.setUint32(i * 4, (s[i] + init[i]) | 0, true)
  return out
}

function chacha20(key, counter, nonce, data) {
  const out = new Uint8Array(data.length)
  for (let at = 0, n = counter; at < data.length; at += 64, n++) {
    const stream = block(key, n, nonce)
    for (let i = 0; i < 64 && at + i < data.length; i++) out[at + i] = data[at + i] ^ stream[i]
  }
  return out
}

const P = (1n << 130n) - 5n
const littleEndian = bytes => {
  let v = 0n
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i])
  return v
}

function poly1305(oneTimeKey, message) {
  const r = littleEndian(oneTimeKey.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn
  const s = littleEndian(oneTimeKey.subarray(16, 32))
  let acc = 0n
  for (let at = 0; at < message.length; at += 16) {
    const chunk = message.subarray(at, at + 16)
    acc = ((acc + littleEndian(chunk) + (1n << BigInt(8 * chunk.length))) * r) % P
  }
  let tag = (acc + s) & ((1n << 128n) - 1n)
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++, tag >>= 8n) out[i] = Number(tag & 0xffn)
  return out
}

function macData(aad, ciphertext) {
  const pad = n => (16 - (n % 16)) % 16
  const out = new Uint8Array(aad.length + pad(aad.length) + ciphertext.length + pad(ciphertext.length) + 16)
  out.set(aad, 0)
  const at = aad.length + pad(aad.length)
  out.set(ciphertext, at)
  const view = new DataView(out.buffer)
  view.setUint32(out.length - 16, aad.length, true)
  view.setUint32(out.length - 8, ciphertext.length, true)
  return out
}

const oneTimeKey = (key, nonce) => block(key, 0, nonce).subarray(0, 32)

// key: 32 bytes, nonce: 12 bytes, aad: bytes bound to the message but not hidden.
// Returns the ciphertext followed by its 16-byte tag.
export function seal(key, nonce, plaintext, aad = new Uint8Array(0)) {
  const ciphertext = chacha20(key, 1, nonce, plaintext)
  const tag = poly1305(oneTimeKey(key, nonce), macData(aad, ciphertext))
  const out = new Uint8Array(ciphertext.length + 16)
  out.set(ciphertext, 0)
  out.set(tag, ciphertext.length)
  return out
}

// The plaintext, or null when the message or its aad was changed or made with another key.
export function open(key, nonce, sealed, aad = new Uint8Array(0)) {
  if (sealed.length < 16) return null
  const ciphertext = sealed.subarray(0, sealed.length - 16)
  const expected = poly1305(oneTimeKey(key, nonce), macData(aad, ciphertext))
  let diff = 0
  for (let i = 0; i < 16; i++) diff |= expected[i] ^ sealed[ciphertext.length + i]
  if (diff !== 0) return null
  return chacha20(key, 1, nonce, ciphertext)
}

export function toB64(bytes) {
  let text = ''
  for (const b of bytes) text += String.fromCharCode(b)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64(text) {
  const plain = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(plain, c => c.charCodeAt(0))
}

export const utf8 = text => new TextEncoder().encode(text)
export const fromUtf8 = bytes => new TextDecoder().decode(bytes)

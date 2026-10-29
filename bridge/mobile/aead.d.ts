// Types of aead.js, which the phone page loads as it is.
export function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array
export function open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad?: Uint8Array): Uint8Array | null
export function toB64(bytes: Uint8Array): string
export function fromB64(text: string): Uint8Array
export function utf8(text: string): Uint8Array
export function fromUtf8(bytes: Uint8Array): string

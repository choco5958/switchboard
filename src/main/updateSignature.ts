// The signature of a release's update files (latest.yml, latest-mac.yml, latest-linux*.yml):
// the sha512 of every installer comes from them, so they decide what an update installs. The
// release workflow signs each with the project's Ed25519 key (scripts/sign-update.ts) into
// <file>.sig, the base64 of the 64-byte signature of the file's exact bytes. The app installs a
// version only when one of the keys below verifies its file and electron-updater read the same
// file; a release without the signature, or with another one, is not installed. Nothing here
// imports Electron, so the tests run all of it.

import { createPublicKey, verify } from 'node:crypto'
import { fetchSmall, releaseUrl } from './macUpdate'

// SPKI PEM. A list, so a new key can ship in one version before the releases are signed with it.
// scripts/sign-update.ts refuses to sign with a key that is not here.
export const UPDATE_KEYS: readonly string[] = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+8F52lsNdBbDt8uelWsItRrZK/6i5RdEzlFRIRi9nCE=
-----END PUBLIC KEY-----`,
]

// An update file is under 1 KiB, its signature 89 bytes.
const MAX_FILE = 64 * 1024
const MAX_SIGNATURE = 1024

// Whether one of `keys` signed `data`: `signature` is the text of the .sig file.
export function signedBy(data: Buffer, signature: string, keys: readonly string[] = UPDATE_KEYS): boolean {
  const text = signature.trim()
  if (!/^[A-Za-z0-9+/]{86}==$/.test(text)) return false
  const raw = Buffer.from(text, 'base64')
  return keys.some(pem => {
    try {
      const key = createPublicKey(pem)
      return key.asymmetricKeyType === 'ed25519' && verify(null, data, key, raw)
    } catch {
      return false
    }
  })
}

// The update file electron-updater reads on this system (its Provider.getChannelFilePrefix).
export function channelFile(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === 'darwin') return 'latest-mac.yml'
  if (platform === 'linux') return `latest-linux${arch === 'x64' ? '' : `-${arch}`}.yml`
  return 'latest.yml'
}

type Fields = Record<string, unknown>

function scalar(text: string): unknown {
  if (/^'.*'$/.test(text)) return text.slice(1, -1).replaceAll("''", "'")
  if (/^".*"$/.test(text) && !text.includes('\\')) return text.slice(1, -1)
  if (/^-?(0|[1-9]\d{0,14})$/.test(text)) return Number(text)
  if (text === 'true' || text === 'false') return text === 'true'
  return text
}

// An update file as electron-builder writes it (js-yaml): `key: value` lines, and lists of
// `  - key: value` entries (files:). Any other shape throws. A value read differently from
// electron-updater's js-yaml only makes sameUpdate fail: the update is refused, never trusted.
export function parseUpdateFile(text: string): Fields {
  const fields: Fields = {}
  let list: Fields[] | null = null
  let entry: Fields | null = null
  const put = (into: Fields, key: string, value: string) => {
    if (Object.hasOwn(into, key)) throw new Error(`${key} twice in the update file`)
    into[key] = scalar(value)
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let match = /^([A-Za-z0-9]+):(?: (.+))?$/.exec(line)
    if (match) {
      const [, key, value] = match
      if (value !== undefined) {
        put(fields, key!, value)
        list = entry = null
      } else {
        if (Object.hasOwn(fields, key!)) throw new Error(`${key} twice in the update file`)
        fields[key!] = list = []
        entry = null
      }
      continue
    }
    if (list && (match = /^ {2}- ([A-Za-z0-9]+): (.+)$/.exec(line))) {
      list.push((entry = {}))
      put(entry, match[1]!, match[2]!)
      continue
    }
    if (entry && (match = /^ {4}([A-Za-z0-9]+): (.+)$/.exec(line))) {
      put(entry, match[1]!, match[2]!)
      continue
    }
    throw new Error(`unexpected line in the update file: ${line.slice(0, 80)}`)
  }
  return fields
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((one, i) => same(one, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].every(key => same((a as Fields)[key], (b as Fields)[key]))
  }
  return a === b
}

// What electron-updater adds to the file it read: the release's tag, title and notes.
const ADDED = new Set(['tag', 'releaseName', 'releaseNotes'])

// Whether what electron-updater read (`found`, its UpdateInfo) is the signed file: every field,
// every file with its sha512 and size, nothing more.
export function sameUpdate(found: object, signed: Fields): boolean {
  const keys = new Set([...Object.keys(found), ...Object.keys(signed)])
  return [...keys].every(key => (ADDED.has(key) && !Object.hasOwn(signed, key)) || same((found as Fields)[key], signed[key]))
}

export type SignedUpdate = { version: string; files: readonly { url: string; sha512?: string; size?: number }[] }

// Fetches the update file of the version electron-updater found and its signature from the
// same release, and returns the file once a pinned key verifies it and it is what
// electron-updater read. Throws otherwise: a missing or wrong signature, another file.
export async function signedUpdate(
  found: { version: string; tag?: string },
  file: string,
  fetch: (url: string, max: number) => Promise<Buffer> = fetchSmall,
  keys: readonly string[] = UPDATE_KEYS,
): Promise<SignedUpdate> {
  const { version } = found
  // electron-updater downloads from the release named by the tag; it has to be this version's.
  if (!/^\d+\.\d+\.\d+$/.test(version) || found.tag !== `v${version}`) throw new Error(`no signed update for ${found.tag} ${version}`)
  const url = releaseUrl(version, file)
  const [data, signature] = await Promise.all([fetch(url, MAX_FILE), fetch(`${url}.sig`, MAX_SIGNATURE)])
  if (!signedBy(data, signature.toString('utf8'), keys)) throw new Error(`${file} of ${version} has no valid signature`)
  const signed = parseUpdateFile(data.toString('utf8'))
  if (!sameUpdate(found, signed) || !Array.isArray(signed.files)) throw new Error(`${file} of ${version} is not the one signed`)
  return signed as SignedUpdate
}

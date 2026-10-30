// Signs the update files of a release (.github/workflows/release.yml): every latest*.yml the
// build jobs made gets <file>.sig, the base64 of the Ed25519 signature of the file's exact
// bytes. The app checks it before it trusts the sha512 of an installer (src/main/updateSignature.ts).
// Node alone, nothing installed: the job that holds the key runs no dependency's code.
//
//   UPDATE_SIGNING_KEY=<PKCS8 PEM> node scripts/sign-update.ts <artifacts> <out>
//
// <artifacts> holds one folder per build job (actions/download-artifact). Their files are
// gathered into <out>, signed there, and uploaded from there. Two jobs making a file of the same
// name stop it, as does a key the app does not trust (UPDATE_KEYS): the release would carry
// updates that no installed app accepts.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPrivateKey, createPublicKey, sign } from 'node:crypto'

const TRUSTED = join(import.meta.dirname, '..', 'src', 'main', 'updateSignature.ts')

// Copies the files of every job's folder into `out`. Returns their names.
export function gather(artifacts: string, out: string): string[] {
  mkdirSync(out, { recursive: true })
  const names: string[] = []
  for (const job of readdirSync(artifacts).sort()) {
    for (const name of readdirSync(join(artifacts, job)).sort()) {
      const from = join(artifacts, job, name)
      if (!statSync(from).isFile()) throw new Error(`${job}/${name} is not a file`)
      if (existsSync(join(out, name))) throw new Error(`${name} comes from two build jobs`)
      copyFileSync(from, join(out, name))
      names.push(name)
    }
  }
  return names
}

// Signs every latest*.yml in `dir` with the private key `pem`, which `trusted` (the source of
// UPDATE_KEYS) has to name. Returns the files signed.
export function signUpdates(dir: string, pem: string, trusted: string = readFileSync(TRUSTED, 'utf8')): string[] {
  const key = createPrivateKey(pem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key is not an Ed25519 key')
  const spki = String(createPublicKey(key).export({ type: 'spki', format: 'pem' }))
  const body = spki.split('\n').filter(line => line && !line.startsWith('-----')).join('\n')
  if (!trusted.includes(body)) throw new Error('the app does not trust this key: add its public key to UPDATE_KEYS first')
  const files = readdirSync(dir).filter(name => /^latest.*\.yml$/.test(name)).sort()
  if (files.length === 0) throw new Error(`no latest*.yml in ${dir}`)
  for (const name of files) {
    const signature = sign(null, readFileSync(join(dir, name)), key).toString('base64')
    writeFileSync(join(dir, `${name}.sig`), `${signature}\n`)
  }
  return files
}

if (import.meta.main) {
  const [artifacts, out] = process.argv.slice(2)
  const pem = process.env.UPDATE_SIGNING_KEY
  if (!artifacts || !out || !pem) {
    console.error('usage: UPDATE_SIGNING_KEY=<PKCS8 PEM> node scripts/sign-update.ts <artifacts> <out>')
    process.exit(2)
  }
  try {
    gather(artifacts, out)
    for (const name of signUpdates(out, pem)) console.log(`signed ${name}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

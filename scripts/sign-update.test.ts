import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gather, signUpdates } from './sign-update.ts'

const dir = mkdtempSync(join(tmpdir(), 'sb-sign-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const pem = String(privateKey.export({ type: 'pkcs8', format: 'pem' }))
const pub = String(publicKey.export({ type: 'spki', format: 'pem' }))

// The build jobs' artifacts as actions/download-artifact lays them out: a folder each.
function artifacts(jobs: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(dir, 'artifacts-'))
  for (const [job, files] of Object.entries(jobs)) {
    mkdirSync(join(root, job))
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, job, name), text)
  }
  return root
}

function cli(args: string[], key?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env }
  delete env.UPDATE_SIGNING_KEY
  if (key) env.UPDATE_SIGNING_KEY = key
  return new Promise(resolve =>
    execFile(process.execPath, [join(import.meta.dirname, 'sign-update.ts'), ...args], { env }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    ),
  )
}

test('gathers every job’s files and signs each update file, not the installers', () => {
  const from = artifacts({
    'dist-mac': { 'latest-mac.yml': 'version: 0.3.6\n', 'Switchboard-0.3.6-mac-arm64.zip': 'zip' },
    'dist-win': { 'latest.yml': 'version: 0.3.6\n', 'Switchboard-0.3.6-win.exe': 'exe', 'Switchboard-0.3.6-win.exe.blockmap': 'map' },
  })
  const out = join(dir, 'out')
  assert.equal(gather(from, out).length, 5)
  assert.deepEqual(signUpdates(out, pem, pub), ['latest-mac.yml', 'latest.yml'])
  assert.deepEqual(readdirSync(out).filter(name => name.endsWith('.sig')).sort(), ['latest-mac.yml.sig', 'latest.yml.sig'])
  for (const name of ['latest-mac.yml', 'latest.yml']) {
    const sig = readFileSync(join(out, `${name}.sig`), 'utf8')
    assert.match(sig, /^[A-Za-z0-9+/]{86}==\n$/)
    assert.equal(verify(null, readFileSync(join(out, name)), publicKey, Buffer.from(sig.trim(), 'base64')), true)
  }
})

test('a file that two jobs made stops the release', () => {
  const from = artifacts({ 'dist-a': { 'latest.yml': 'a' }, 'dist-b': { 'latest.yml': 'b' } })
  assert.throws(() => gather(from, join(dir, 'twice')), /two build jobs/)
})

test('refuses a key the app does not trust, and runs only with the key given', async () => {
  const from = artifacts({ 'dist-win': { 'latest.yml': 'version: 0.3.6\n' } })
  // The app's own UPDATE_KEYS do not hold a key made here.
  const untrusted = await cli([from, join(dir, 'untrusted')], pem)
  assert.equal(untrusted.code, 1)
  assert.match(untrusted.stderr, /does not trust/)
  assert.deepEqual(readdirSync(join(dir, 'untrusted')), ['latest.yml'])
  const missing = await cli([from, join(dir, 'nokey')])
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /usage/)
})

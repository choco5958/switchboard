// The Node the Tauri app ships (docs/tauri-이전.md, step 5): the official build from nodejs.org,
// checked against the SHA-256 that release publishes, saved where tauri.conf.json's externalBin
// expects it: src-tauri/binaries/switchboard-node-<target triple>(.exe). Usage:
//   node scripts/fetch-node.ts [target triple]     (default: this machine's)

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const NODE_VERSION = '24.19.0'
const ROOT = resolve(import.meta.dirname, '..')

// Rust's target triple to the name of Node's archive for it.
export const ARCHIVES: Record<string, { dist: string; ext: 'tar.gz' | 'zip'; exe: string }> = {
  'aarch64-apple-darwin': { dist: 'darwin-arm64', ext: 'tar.gz', exe: 'bin/node' },
  'x86_64-apple-darwin': { dist: 'darwin-x64', ext: 'tar.gz', exe: 'bin/node' },
  'x86_64-unknown-linux-gnu': { dist: 'linux-x64', ext: 'tar.gz', exe: 'bin/node' },
  'aarch64-unknown-linux-gnu': { dist: 'linux-arm64', ext: 'tar.gz', exe: 'bin/node' },
  'x86_64-pc-windows-msvc': { dist: 'win-x64', ext: 'zip', exe: 'node.exe' },
  'aarch64-pc-windows-msvc': { dist: 'win-arm64', ext: 'zip', exe: 'node.exe' },
}

function hostTriple(): string {
  const cargo = join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'rustc.exe' : 'rustc')
  const out = execFileSync(existsSync(cargo) ? cargo : 'rustc', ['-vV'], { encoding: 'utf8' })
  return /^host: (.+)$/m.exec(out)![1]!.trim()
}

export function sha256Of(sums: string, file: string): string | null {
  const line = sums.split('\n').find(l => l.trim().endsWith(`  ${file}`))
  return line ? line.split(/\s+/)[0]! : null
}

async function download(url: string): Promise<Buffer> {
  const reply = await fetch(url)
  if (!reply.ok) throw new Error(`${url}: ${reply.status}`)
  return Buffer.from(await reply.arrayBuffer())
}

export async function fetchNode(triple: string, root = ROOT): Promise<string> {
  const archive = ARCHIVES[triple]
  if (!archive) throw new Error(`no Node build for ${triple}`)
  const target = join(root, 'src-tauri', 'binaries', `switchboard-node-${triple}${triple.includes('windows') ? '.exe' : ''}`)
  const stamp = `${target}.version`
  if (existsSync(target) && existsSync(stamp) && readFileSync(stamp, 'utf8') === NODE_VERSION) return target
  const name = `node-v${NODE_VERSION}-${archive.dist}`
  const file = `${name}.${archive.ext}`
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`
  const expected = sha256Of(await (await download(`${base}/SHASUMS256.txt`)).toString('utf8'), file)
  if (!expected) throw new Error(`SHASUMS256.txt of ${NODE_VERSION} does not list ${file}`)
  const bytes = await download(`${base}/${file}`)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) throw new Error(`${file}: sha256 ${actual}, the release says ${expected}`)
  const work = mkdtempSync(join(tmpdir(), 'switchboard-node-'))
  try {
    writeFileSync(join(work, file), bytes)
    // bsdtar (macOS, Windows 10+) and GNU tar both read .tar.gz; bsdtar also reads .zip. On Windows
    // the system's own, not a GNU tar some other tool put first on PATH.
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
    execFileSync(tar, ['-xf', join(work, file), '-C', work, `${name}/${archive.exe}`])
    mkdirSync(join(root, 'src-tauri', 'binaries'), { recursive: true })
    writeFileSync(target, readFileSync(join(work, name, archive.exe)))
    chmodSync(target, 0o755)
    writeFileSync(stamp, NODE_VERSION)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return target
}

if (import.meta.main) {
  const triple = process.argv[2] ?? hostTriple()
  console.log(await fetchNode(triple))
}

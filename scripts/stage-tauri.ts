// The Node side of the Tauri app (docs/tauri-이전.md, step 5), staged in out/tauri/node for
// src-tauri/tauri.conf.json to ship as Resources/node:
// - the same files the Electron app carries there (electron-builder.yml extraResources, read
//   from that file so the two lists stay one), with their built .mjs (out/node);
// - the Node host (out/host/main.mjs) as host/main.mjs;
// - node_modules with what the host and the terminal host load: node-pty (its native module for
//   this platform only), @xterm/headless and @xterm/addon-serialize.
// Run after `pnpm build`.

import { cpSync, existsSync, globSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'out', 'tauri', 'node')
export const PACKAGES = ['node-pty', '@xterm/headless', '@xterm/addon-serialize']

// The filter of the extraResources entry that goes to `node` from `.`.
export function nodeFilter(builderYml: string): { include: string[]; exclude: string[] } {
  const lines = builderYml.split('\n')
  const start = lines.findIndex((line, i) => line.trim() === '- from: .' && lines[i + 1]?.trim() === 'to: node')
  if (start < 0) throw new Error('electron-builder.yml has no extraResources entry from . to node')
  const include: string[] = []
  const exclude: string[] = []
  let i = lines.findIndex((line, at) => at > start && line.trim() === 'filter:') + 1
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.startsWith('#') || line === '') continue
    if (!line.startsWith('- ')) break
    const pattern = line.slice(2).replace(/^'(.*)'$/, '$1')
    if (pattern.startsWith('!')) exclude.push(pattern.slice(1))
    else include.push(pattern)
  }
  return { include, exclude }
}

function copy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  // pnpm links packages; the app gets the files themselves.
  cpSync(from, to, { recursive: true, dereference: true })
}

// node-pty without its sources and the native builds of other platforms.
function keepPty(file: string, platform: string, arch: string): boolean {
  const path = file.split('\\').join('/')
  if (/^(src|deps|scripts|third_party|typings)\//.test(path)) return false
  if (path.startsWith('prebuilds/')) return path === `prebuilds/${platform}-${arch}` || path.startsWith(`prebuilds/${platform}-${arch}/`)
  if (path.startsWith('build/')) return !/\/obj\.target\/|\.(o|d|mk)$/.test(path)
  return true
}

export function stageTauri(root = ROOT, out = OUT, platform: string = process.platform, arch: string = process.arch): string[] {
  rmSync(out, { recursive: true, force: true })
  const { include, exclude } = nodeFilter(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))
  const files = globSync(include, { cwd: root, exclude }).filter(file => !existsSync(join(root, file)) || !globSync(file, { cwd: root, withFileTypes: true })[0]?.isDirectory())
  for (const file of files) copy(join(root, file), join(out, file))
  copy(join(root, 'out', 'node'), out)
  copy(join(root, 'out', 'host', 'main.mjs'), join(out, 'host', 'main.mjs'))
  for (const name of PACKAGES) {
    const from = join(root, 'node_modules', name)
    if (!existsSync(from)) throw new Error(`${name} is not installed`)
    const to = join(out, 'node_modules', name)
    mkdirSync(to, { recursive: true })
    cpSync(from, to, {
      recursive: true,
      dereference: true,
      filter: source => name !== 'node-pty' || keepPty(relative(from, source), platform, arch),
    })
  }
  return globSync('**/*', { cwd: out, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(out, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort()
}

// node scripts/stage-tauri.ts [platform arch]: another architecture's node-pty (a Mac builds both).
if (import.meta.main) {
  const [platform, arch] = process.argv.slice(2)
  const files = stageTauri(ROOT, OUT, platform ?? process.platform, arch ?? process.arch)
  console.log(`out/tauri/node: ${files.length} files`)
}

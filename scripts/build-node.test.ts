import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ENTRIES, buildNode, rewriteImports } from './build-node.ts'

const ROOT = resolve(import.meta.dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'sb-build-node-'))
const out = join(dir, 'node')
const children: ReturnType<typeof spawn>[] = []

after(() => {
  for (const child of children) child.kill()
  rmSync(dir, { recursive: true, force: true })
})

test('relative .ts imports point at the built .mjs files; packages and node: ones stay', () => {
  const { code, imports } = rewriteImports(
    [
      `import { a } from './a.ts'`,
      `export { b } from "../b/b.ts"`,
      `import './side.ts'`,
      `const c = await import('./c.ts')`,
      `import { join } from 'node:path'`,
      `import x from 'some-package'`,
      `const name = 'notes.ts.txt'`,
    ].join('\n'),
  )
  assert.equal(
    code,
    [
      `import { a } from './a.mjs'`,
      `export { b } from "../b/b.mjs"`,
      `import './side.mjs'`,
      `const c = await import('./c.mjs')`,
      `import { join } from 'node:path'`,
      `import x from 'some-package'`,
      `const name = 'notes.ts.txt'`,
    ].join('\n'),
  )
  assert.deepEqual(imports, ['./a.ts', '../b/b.ts', './side.ts', './c.ts'])
})

const built = buildNode(ROOT, out)
const files = (at: string): string[] => readdirSync(at, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(join(at, e.name)) : [join(at, e.name)]))

test('every entry is built, with what it imports, and nothing names a .ts file', () => {
  for (const entry of ENTRIES) {
    assert.ok(built.includes(entry), entry)
    assert.ok(existsSync(join(out, entry.replace(/\.ts$/, '.mjs'))), entry)
  }
  for (const file of files(out)) {
    const code = readFileSync(file, 'utf8')
    for (const [, path] of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      assert.match(path!, /\.m?js$/, file)
      assert.ok(existsSync(resolve(dirname(file), path!)), `${file}: ${path}`)
    }
  }
})

test('the stripping keeps every line where it was', () => {
  const source = readFileSync(join(ROOT, 'bridge', 'server.ts'), 'utf8').split('\n')
  const js = readFileSync(join(out, 'bridge', 'server.mjs'), 'utf8').split('\n')
  assert.equal(js.length, source.length)
})

// Windows: its Node cannot listen on a socket path (bridge/endpoint.ts).
test('the built bridge starts and answers', { skip: process.platform === 'win32' }, async () => {
  const socketPath = join(dir, 'b.sock')
  const child = spawn(process.execPath, [join(out, 'bridge', 'server.mjs')], {
    env: { ...process.env, CLAUDE_IDE_SOCKET: socketPath, CLAUDE_IDE_DB: join(dir, 'b.db') },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  children.push(child)
  let stderr = ''
  child.stderr!.on('data', chunk => (stderr += chunk))
  const health = (): Promise<Record<string, unknown> | null> =>
    new Promise(resolve => {
      const req = request({ socketPath, path: '/health' }, res => {
        let text = ''
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve(JSON.parse(text)))
      })
      req.on('error', () => resolve(null))
      req.end()
    })
  let answer: Record<string, unknown> | null = null
  for (let i = 0; i < 100 && !answer; i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    answer = await health()
  }
  assert.ok(answer, `no answer; stderr: ${stderr}`)
  assert.equal(answer.pid, child.pid)
})

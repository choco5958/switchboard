import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { nodeFilter } from './stage-tauri.ts'
import { ARCHIVES, sha256Of } from './fetch-node.ts'

const ROOT = resolve(import.meta.dirname, '..')

test('the Tauri app ships the same Node files as the Electron app, read from electron-builder.yml', () => {
  const { include, exclude } = nodeFilter(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8'))
  for (const one of ['bridge/*.ts', 'mcp/*.ts', 'mcp/opencode/*.ts', 'scripts/switchboard.ts', 'mod/hooks/**', 'src/main/termHost.ts']) assert.ok(include.includes(one), one)
  assert.deepEqual(exclude, ['**/*.test.ts', '**/*.unit.ts'])
})

test('the Node download is checked against the line of its own file in SHASUMS256.txt', () => {
  const sums = 'aaa  node-v1-darwin-arm64.tar.gz\nbbb  node-v1-darwin-arm64.tar.xz\nccc  node-v1-win-x64.zip\n'
  assert.equal(sha256Of(sums, 'node-v1-darwin-arm64.tar.gz'), 'aaa')
  assert.equal(sha256Of(sums, 'node-v1-linux-x64.tar.gz'), null)
  // Every target the releases build has a Node.
  for (const triple of ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu']) assert.ok(ARCHIVES[triple], triple)
})

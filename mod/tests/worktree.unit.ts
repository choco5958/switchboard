import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SAFE_GIT, insideFolder, worktreeRoot } from '../hooks/tools.ts'

const stdout = (argv: string[], cwd: string): Promise<string> =>
  new Promise(resolve => execFile(argv[0]!, argv.slice(1), { cwd }, (error, out) => resolve(error ? '' : String(out))))

test('a folder is inside itself and its parents, never beside them', () => {
  assert.equal(insideFolder('/w/app', '/w/app/'), true)
  assert.equal(insideFolder('/w/app/sub', '/w/app'), true)
  assert.equal(insideFolder('/w/app-2', '/w/app'), false)
  assert.equal(insideFolder('/w', '/w/app'), false)
  assert.equal(insideFolder('/any', '/'), true)
})

test('node_worktree works only in the session folder, takes no option for a base, and runs no hook of the repo', { skip: process.platform === 'win32' }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sb-worktree-')))
  try {
    const home = join(dir, 'home')
    const inner = join(home, 'repo')
    const outside = join(dir, 'downloaded')
    for (const folder of [home, inner, outside]) mkdirSync(folder, { recursive: true })
    for (const folder of [inner, outside]) await stdout(['git', 'init', '-q'], folder)
    // A hook that would mark it ran, were the repo's hooks started.
    const marker = join(dir, 'hook-ran')
    const hook = join(inner, '.git', 'hooks', 'post-checkout')
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`)
    chmodSync(hook, 0o755)
    symlinkSync(outside, join(home, 'link'))

    assert.deepEqual(await worktreeRoot(stdout, home, 'repo'), { root: inner })
    assert.deepEqual(await worktreeRoot(stdout, inner), { root: inner })
    assert.deepEqual(await worktreeRoot(stdout, home, inner, 'main'), { root: inner })
    assert.equal(existsSync(marker), false)
    // The git it runs starts none of the repo's hooks.
    await stdout(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], inner)
    await stdout([...SAFE_GIT, 'checkout', '-q', '-b', 'safe'], inner)
    assert.equal(existsSync(marker), false)
    await stdout(['git', 'checkout', '-q', '-b', 'plain'], inner)
    assert.equal(existsSync(marker), true)

    assert.deepEqual(await worktreeRoot(stdout, home, 'repo', '--upload-pack=touch x'), { refused: 'wt.badBase', vars: { base: '--upload-pack=touch x' } })
    assert.deepEqual(await worktreeRoot(stdout, home, outside), { refused: 'wt.outside', vars: { path: outside } })
    assert.deepEqual(await worktreeRoot(stdout, home, '../downloaded'), { refused: 'wt.outside', vars: { path: `${home}/../downloaded` } })
    // A symlink inside the session folder that leads out of it.
    assert.deepEqual(await worktreeRoot(stdout, home, 'link'), { refused: 'wt.outside', vars: { path: `${home}/link` } })
    assert.deepEqual(await worktreeRoot(stdout, home, 'missing'), { refused: 'wt.outside', vars: { path: `${home}/missing` } })
    assert.deepEqual(await worktreeRoot(stdout, home), { refused: 'wt.notRepo', vars: { path: home } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

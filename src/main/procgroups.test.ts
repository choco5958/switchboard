import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { groupAlive, isStale, killStale, stopGroup, writePid } from './procgroups'

// A detached group like a dev server's: a shell with two children. With
// ignoreTerm the whole group shrugs off SIGTERM, as a stuck server would.
function group(ignoreTerm: boolean): number {
  const script = `${ignoreTerm ? "trap '' TERM; " : ''}sleep 30 & sleep 30 & wait`
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid!
}

// The shell, its trap and both sleeps are in place.
function ready(pgid: number): boolean {
  try {
    return execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' }).trim().split('\n').length >= 3
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

const pids: number[] = []
const dirs: string[] = []
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // gone
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync('/tmp/cide-pg')
  dirs.push(dir)
  return dir
}

describe('isStale', () => {
  const started = 'Tue Oct 27 15:00:00 2026'
  const appStarted = 'Tue Oct 27 14:00:00 2026'
  const record = { id: 'a', pid: 500, started, owner: 400, ownerStarted: appStarted }
  // Start times by pid; the app (400) is gone unless listed.
  const starts = (map: Record<number, string>) => (pid: number) => map[pid] ?? null

  it('takes a group whose app is gone and whose leader is gone or is the recorded process', () => {
    expect(isStale(record, () => true, starts({}))).toBe(true)
    expect(isStale(record, () => true, starts({ 500: started }))).toBe(true)
    // The app pid now belongs to some other process.
    expect(isStale(record, () => true, starts({ 400: 'Wed Oct 28 08:00:00 2026', 500: started }))).toBe(true)
  })
  it('leaves groups of an app that still runs', () => {
    expect(isStale(record, () => true, starts({ 400: appStarted, 500: started }))).toBe(false)
  })
  it('leaves a pid that now belongs to another process, and groups that are gone', () => {
    expect(isStale(record, () => true, starts({ 500: 'Wed Oct 28 09:00:00 2026' }))).toBe(false)
    expect(isStale(record, () => false, starts({ 500: started }))).toBe(false)
  })
})

// writePid records this test process as the app; these rewrite it as an app that is gone.
function orphan(dir: string, change: Record<string, unknown> = {}): string {
  const file = join(dir, readdirSync(dir)[0]!)
  const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, JSON.stringify({ ...record, ownerStarted: 'Thu Jan  1 00:00:00 2001', ...change }))
  return file
}

describe('dev server groups left by a crashed app', () => {
  it('kills a surviving group at the next start, even one that ignores SIGTERM', async () => {
    const dir = scratch()
    const pid = group(true)
    pids.push(pid)
    await until(() => ready(pid))
    writePid(dir, 'web', pid)
    expect(readdirSync(dir)).toHaveLength(1)
    // While the app that started it runs, another instance leaves it alone.
    expect(await killStale(dir, 300)).toEqual([])
    expect(groupAlive(pid)).toBe(true)
    expect(readdirSync(dir)).toHaveLength(1)

    orphan(dir)
    expect(await killStale(dir, 300)).toEqual(['web'])
    await until(() => !groupAlive(pid))
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('leaves a process that only shares the recorded pid', async () => {
    const dir = scratch()
    const pid = group(false)
    pids.push(pid)
    await until(() => ready(pid))
    writePid(dir, 'web', pid)
    // Pretend the recorded leader started at another time: the pid was handed out again.
    const file = orphan(dir, { started: 'Thu Jan  1 00:00:00 2001' })

    expect(await killStale(dir, 300)).toEqual([])
    expect(groupAlive(pid)).toBe(true)
    expect(existsSync(file)).toBe(false)
  })
})

describe('stopGroup', () => {
  it('returns as soon as a polite group exits', async () => {
    const pid = group(false)
    pids.push(pid)
    await until(() => ready(pid))
    const began = Date.now()
    await stopGroup(pid, 2000)
    expect(Date.now() - began).toBeLessThan(1500)
    expect(groupAlive(pid)).toBe(false)
  })

  it('kills a group that ignores SIGTERM once the wait is over', async () => {
    const pid = group(true)
    pids.push(pid)
    await until(() => ready(pid))
    const began = Date.now()
    await stopGroup(pid, 400)
    expect(Date.now() - began).toBeGreaterThanOrEqual(400)
    await until(() => !groupAlive(pid))
  })
})

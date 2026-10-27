import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev servers run detached, each in its own process group, so they outlive an
// app that crashed or was killed. A pid file per target remembers the group,
// the app that started it, and when each started; the next start ends groups
// whose app is gone. Start times tell a stale entry from an unrelated process
// that got the same pid. A second app instance (a capture run) leaves the
// first one's servers alone because their app is still alive.

export type PidRecord = { id: string; pid: number; started: string; owner: number; ownerStarted: string }

const fileOf = (dir: string, owner: number, id: string) => join(dir, `${owner}-${encodeURIComponent(id)}.json`)

// When the process started, as ps prints it; null when there is no such process.
export function processStart(pid: number): string | null {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    // already gone
  }
}

export function writePid(dir: string, id: string, pid: number): void {
  const started = processStart(pid)
  const ownerStarted = processStart(process.pid)
  if (!started || !ownerStarted) return
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const record: PidRecord = { id, pid, started, owner: process.pid, ownerStarted }
    writeFileSync(fileOf(dir, process.pid, id), JSON.stringify(record), { mode: 0o600 })
  } catch {
    // without the file only a crash cleanup is lost
  }
}

export function removePid(dir: string, id: string): void {
  rmSync(fileOf(dir, process.pid, id), { force: true })
}

function valid(record: Partial<PidRecord>): record is PidRecord {
  const pid = (n: unknown) => Number.isInteger(n) && (n as number) > 1
  return typeof record.id === 'string' && pid(record.pid) && typeof record.started === 'string' && pid(record.owner) && typeof record.ownerStarted === 'string'
}

// Every record with its file; a file that does not parse comes back as null.
export function readPids(dir: string): { file: string; record: PidRecord | null }[] {
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.json'))
  } catch {
    return []
  }
  return names.map(name => {
    const file = join(dir, name)
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as Partial<PidRecord>
      return { file, record: valid(record) ? record : null }
    } catch {
      return { file, record: null }
    }
  })
}

// The app that wrote the record still runs: its servers are its own business.
export function ownerAlive(record: PidRecord, startOf: (pid: number) => string | null): boolean {
  return startOf(record.owner) === record.ownerStarted
}

// A group to end: it still exists and its leader is either gone (the id cannot
// be handed out while the group lives) or the same process as recorded.
export function isStale(record: PidRecord, alive: (pgid: number) => boolean, startOf: (pid: number) => string | null): boolean {
  if (ownerAlive(record, startOf)) return false
  if (!alive(record.pid)) return false
  const leader = startOf(record.pid)
  return leader === null || leader === record.started
}

// TERM, wait up to waitMs for the group to go, then KILL whatever is left.
export async function stopGroup(pgid: number, waitMs: number): Promise<void> {
  signalGroup(pgid, 'SIGTERM')
  const end = Date.now() + waitMs
  while (groupAlive(pgid) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50))
  signalGroup(pgid, 'SIGKILL')
}

// Ends the groups an app that is gone left behind and clears its files; returns the ids it stopped.
export async function killStale(dir: string, waitMs: number): Promise<string[]> {
  const stale: PidRecord[] = []
  for (const { file, record } of readPids(dir)) {
    if (record && ownerAlive(record, processStart)) continue
    if (record && isStale(record, groupAlive, processStart)) stale.push(record)
    rmSync(file, { force: true })
  }
  await Promise.all(stale.map(record => stopGroup(record.pid, waitMs)))
  return stale.map(record => record.id)
}

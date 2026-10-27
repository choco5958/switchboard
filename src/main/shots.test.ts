import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveShot } from './shots'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync('/tmp/cide-shot')
  dirs.push(dir)
  return dir
}

describe('saveShot', () => {
  it('keeps the folder and the file private', () => {
    const dir = join(scratch(), 'shots')
    const file = saveShot(dir, PNG, new Date('2026-10-27T01:02:03.004Z'))
    expect(file).toBe(join(dir, '2026-10-27T01-02-03-004Z.png'))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(file!).mode & 0o777).toBe(0o600)
    expect(readFileSync(file!)).toEqual(Buffer.from('iVBORw0KGgo=', 'base64'))
  })

  it('tightens a folder an older version made open', () => {
    const dir = join(scratch(), 'shots')
    mkdirSync(dir, { mode: 0o755 })
    saveShot(dir, PNG)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('takes nothing but a PNG data URL', () => {
    const dir = join(scratch(), 'shots')
    expect(saveShot(dir, 'data:image/svg+xml;base64,PHN2Zz4=')).toBeNull()
    expect(saveShot(dir, 'data:image/png;base64,')).toBeNull()
    expect(saveShot(dir, 'data:image/png;base64,abc\n../x')).toBeNull()
    expect(saveShot(dir, 42)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { usePlatform, type Platform } from './platform'
import { registerUpdates, stagedUpdates, startHostUpdates, updateTracker } from './updateFlow'
import { UpdateRefused, type SignedUpdate } from './updateSignature'
import type { UpdateStatus } from '../shared/types'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe("the Tauri app's update checks", () => {
  it('reports the latest version, one to download, a refused one and a failed check', async () => {
    const notes: string[] = []
    const opened: string[] = []
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const sent: UpdateStatus[] = []
    usePlatform({
      version: () => '0.3.16',
      userDataPath: () => '/nonexistent',
      notificationsSupported: () => true,
      notify: (_title: string, body: string, onClick?: () => void) => {
        notes.push(body)
        onClick?.()
      },
      openExternal: async (url: string) => void opened.push(url),
      onPower: () => undefined,
      onQuit: () => undefined,
    } as unknown as Platform)
    registerUpdates({ handle: (channel, listener) => void handlers.set(channel, listener) }, (_channel, payload) => sent.push(payload as UpdateStatus))

    let next: () => Promise<SignedUpdate> = async () => ({ version: '0.3.16', files: [] })
    const asked: string[] = []
    // Not inside an app bundle: a Mac cannot swap it, so a newer version is the person's to download.
    startHostUpdates({ exe: '/usr/bin/true', pid: 1, whenQuit: () => undefined }, () => [], file => {
      asked.push(file)
      return next()
    })
    await flush()
    expect(sent.at(-1)).toMatchObject({ version: '0.3.16', state: 'latest' })
    expect(asked[0]).toMatch(/^latest(-mac|-linux(-arm64)?)?\.yml$/)

    next = async () => ({ version: '0.3.17', files: [] })
    await handlers.get('update:check')!(undefined)
    await flush()
    expect(sent.at(-1)).toMatchObject({ state: 'manual', latest: '0.3.17' })
    expect(notes).toHaveLength(1)
    expect(opened).toEqual(['https://github.com/choco5958/switchboard/releases/latest'])

    next = async () => {
      throw new UpdateRefused('latest-mac.yml of 0.3.18 has no valid signature', '0.3.18')
    }
    await handlers.get('update:check')!(undefined)
    await flush()
    expect(sent.at(-1)).toMatchObject({ state: 'refused', latest: '0.3.18' })

    next = async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com')
    }
    await handlers.get('update:check')!(undefined)
    await flush()
    expect(sent.at(-1)).toMatchObject({ state: 'error', error: 'getaddrinfo ENOTFOUND github.com' })
    // The same version again tells nobody twice.
    next = async () => ({ version: '0.3.17', files: [] })
    await handlers.get('update:check')!(undefined)
    await flush()
    expect(notes).toHaveLength(1)
    expect(handlers.get('update:status')!(undefined)).toMatchObject({ state: 'manual', latest: '0.3.17' })
  })
})

describe('an update staged for the quit', () => {
  const update = (version: string, listed = true): SignedUpdate => ({ version, files: listed ? [{ url: `Switchboard-${version}.exe`, sha512: 'eA==', size: 1 }] : [] })

  function staged(failed: string[] = []) {
    const hooks = { quit: () => undefined as void, shutdown: () => undefined as void }
    usePlatform({
      version: () => '0.3.16',
      userDataPath: () => '/nonexistent',
      notificationsSupported: () => false,
      onPower: (_event: string, listener: () => void) => void (hooks.shutdown = listener),
    } as unknown as Platform)
    const status = updateTracker('0.3.16')
    const installs: [string, boolean][] = []
    const discarded: string[] = []
    const control = { fail: false }
    const found = stagedUpdates(() => [], status, { exe: '', pid: 1, whenQuit: start => void (hooks.quit = start) }, new Set(failed), {
      file: one => (one.files[0] ? { name: one.files[0].url, sha512: 'eA==', size: 1 } : null),
      canInstall: () => true,
      stage: async (_file, version) => {
        if (control.fail) throw new Error('offline')
        return version
      },
      discard: version => void discarded.push(version),
      install: (version, relaunch) => void installs.push([version, relaunch]),
    })
    return { found, status, installs, discarded, control, hooks }
  }

  it('downloads a newer version once and installs the last one staged when the app quits', async () => {
    const { found, status, installs, discarded, control, hooks } = staged(['0.3.19'])
    expect(await found(update('0.3.16'))).toBe(true)
    expect(status.get().state).toBe('latest')
    // No file for this system, or one whose install failed before: the person downloads it.
    expect(await found(update('0.3.17', false))).toBe(false)
    expect(await found(update('0.3.19'))).toBe(false)
    expect(await found(update('0.3.17'))).toBe(true)
    expect(status.get()).toMatchObject({ state: 'ready', latest: '0.3.17' })
    expect(await found(update('0.3.18'))).toBe(true)
    expect(discarded).toEqual(['0.3.17'])
    // A download that fails keeps the version staged before.
    control.fail = true
    expect(await found(update('0.3.20'))).toBe(true)
    expect(status.get()).toMatchObject({ state: 'ready', latest: '0.3.18' })
    hooks.quit()
    hooks.quit()
    expect(installs).toEqual([['0.3.18', false]])
  })

  it('installs nothing at a shutdown, and nothing when no version waits', async () => {
    const quiet = staged()
    quiet.hooks.quit()
    expect(quiet.installs).toEqual([])
    const { found, installs, hooks } = staged()
    expect(await found(update('0.3.17'))).toBe(true)
    hooks.shutdown()
    hooks.quit()
    expect(installs).toEqual([])
  })
})

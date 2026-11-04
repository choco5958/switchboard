import { describe, expect, it } from 'vitest'
import { usePlatform, type Platform } from './platform'
import { registerUpdates, startHostUpdates } from './updateFlow'
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

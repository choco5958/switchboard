import { describe, expect, it, vi } from 'vitest'
import type { UpdateInfo } from 'electron-updater'
import { checkable, installsUpdates, requireSignature, stopBridgeNow, terminalsClosing, updateTracker } from './updater'

// The real modules would install Electron's binary while the tests run, and two workers doing
// that at once collide (CI). These tests touch neither.
vi.mock('electron', () => ({ app: {}, dialog: {}, Notification: class {}, powerMonitor: {}, shell: {} }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))

describe('updates', () => {
  it('electron-updater installs only on Windows and the Linux AppImage (macOS: macUpdate.ts)', () => {
    expect(installsUpdates('win32', {})).toBe(true)
    expect(installsUpdates('linux', { APPIMAGE: '/home/me/Switchboard.AppImage' })).toBe(true)
    // A .deb: electron-updater would run pkexec or sudo for it.
    expect(installsUpdates('linux', {})).toBe(false)
    expect(installsUpdates('darwin', { APPIMAGE: '/x' })).toBe(false)
  })

  it('asks before installing now only while app terminals run, naming how many close', () => {
    expect(terminalsClosing([])).toBe(0)
    // Terminals whose shell has exited close with nothing running in them.
    expect(terminalsClosing([{ alive: false }, { alive: false }])).toBe(0)
    expect(terminalsClosing([{ alive: true }, { alive: false }, { alive: true }])).toBe(2)
  })

  it('stops the bridge serving at quit time, not one remembered from the download', async () => {
    const killed: number[] = []
    let serving = 4100
    const pid = () => Promise.resolve(serving)
    // The bridge was restarted after the update came down.
    serving = 4200
    expect(await stopBridgeNow(pid, p => killed.push(p))).toBe(4200)
    expect(killed).toEqual([4200])
  })

  it('kills nothing when the bridge does not answer, answers too late, or names this process', async () => {
    const killed: number[] = []
    expect(await stopBridgeNow(() => Promise.resolve(null), p => killed.push(p))).toBe(null)
    expect(await stopBridgeNow(() => Promise.reject(new Error('down')), p => killed.push(p))).toBe(null)
    expect(await stopBridgeNow(() => new Promise(resolve => setTimeout(() => resolve(4300), 200)), p => killed.push(p), 20)).toBe(null)
    expect(await stopBridgeNow(() => Promise.resolve(process.pid), p => killed.push(p))).toBe(null)
    expect(killed).toEqual([])
  })

  it('reports a version only once its update file is signed, and downloads nothing for any other', async () => {
    const info = (version: string) => ({ version, files: [], path: '', sha512: '', releaseDate: '' }) as UpdateInfo
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let osSupported = true
    const checker = { isUpdateSupported: (_: UpdateInfo): boolean | Promise<boolean> => osSupported }
    const checked: string[] = []
    const signed = requireSignature(checker, async found => {
      checked.push(found.version)
      if (found.version !== '0.3.6') throw new Error('latest.yml of 0.3.7 has no valid signature')
      return { version: found.version, files: [] }
    })
    const good = info('0.3.6')
    expect(await checker.isUpdateSupported(good)).toBe(true)
    expect(signed(good)).toEqual({ version: '0.3.6', files: [] })
    // A missing or wrong signature: electron-updater does not report it, and it has no signed file.
    const bad = info('0.3.7')
    expect(await checker.isUpdateSupported(bad)).toBe(false)
    expect(signed(bad)).toBe(undefined)
    expect(errors).toHaveBeenCalledWith('update refused:', 'latest.yml of 0.3.7 has no valid signature')
    // A version reported without this check, or a copy of the one checked, is not trusted either.
    expect(signed(info('0.3.6'))).toBe(undefined)
    // electron-updater's own check (minimum system version) still comes first.
    osSupported = false
    expect(await checker.isUpdateSupported(info('0.3.8'))).toBe(false)
    expect(checked).toEqual(['0.3.6', '0.3.7'])
    errors.mockRestore()
  })

  it('keeps where the update stands for the settings page, and checks again only when nothing runs or waits', () => {
    const tracker = updateTracker('0.3.6')
    const heard: string[] = []
    const stop = tracker.watch(status => heard.push(`${status.state}:${status.latest ?? ''}`))
    expect(tracker.get()).toEqual({ version: '0.3.6', state: 'off' })
    tracker.set({ state: 'downloading', latest: '0.3.7' })
    tracker.set({ state: 'ready', version: '9.9.9' } as never)
    // The version is always the running app's own.
    expect(tracker.get()).toMatchObject({ version: '0.3.6', state: 'ready', latest: '0.3.7' })
    stop()
    tracker.set({ state: 'latest' })
    expect(heard).toEqual(['downloading:0.3.7', 'ready:0.3.7'])
    expect(['off', 'checking', 'downloading', 'ready'].map(state => checkable(state as never))).toEqual([false, false, false, false])
    expect(['idle', 'latest', 'manual', 'refused', 'error'].map(state => checkable(state as never))).toEqual([true, true, true, true, true])
  })

  it('tells which version a check refused for its signature', async () => {
    const refused: string[] = []
    const checker: { isUpdateSupported: (info: UpdateInfo) => boolean | Promise<boolean> } = { isUpdateSupported: () => true }
    requireSignature(checker, () => Promise.reject(new Error('bad signature')), info => refused.push(info.version))
    expect(await checker.isUpdateSupported({ version: '0.3.8' } as UpdateInfo)).toBe(false)
    expect(refused).toEqual(['0.3.8'])
  })
})

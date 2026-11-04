// Updates of the Electron app, from the GitHub releases (electron-builder.yml publish).
// electron-updater finds new versions; Windows and the Linux AppImage download them with it and
// install when the app quits. macOS does the same with its own download and swap, the path the
// Tauri app shares (updateFlow.ts macUpdates): Squirrel.Mac installs only a signed update, and
// this app is signed ad hoc. A Mac app in a folder this user cannot write and a .deb (or any
// other Linux package, the system package manager's to update, as the README says) get a
// notification that opens the download page.
// Only a version whose update file carries the release key's signature counts at all
// (updateSignature.ts): electron-updater downloads nothing, and the Mac swaps nothing, before
// that holds and the file electron-updater read is the one signed.
// On macOS and Linux the terminal host keeps the terminals running through an update
// (src/main/termHost.ts), so it closes none unless the person set the app to close them at a quit.

import { app } from 'electron'
import updater, { type UpdateInfo } from 'electron-updater'
import { t } from '../shared/i18n'
import { checkable, CHECK_MS, installNowAllowed, macUpdates, manualUpdates, notifyUpdate, onCheckNow, onInstallReady, tracker } from './updateFlow'
import { channelFile, signedUpdate, type SignedUpdate } from './updateSignature'

export { checkable, registerUpdates, RELEASES_URL, terminalsClosing, updateTracker } from './updateFlow'

// A bridge that does not answer /health in this time is not waited for at quit.
const PID_WAIT_MS = 2000

// Whether this copy of the app installs updates with electron-updater. On Linux only the
// AppImage does (its runtime sets APPIMAGE); electron-updater would install a .deb with pkexec
// or sudo. macOS has its own path (macUpdate.ts).
export function installsUpdates(platform: string = process.platform, env: Record<string, string | undefined> = process.env): boolean {
  if (platform === 'win32') return true
  return platform === 'linux' && !!env.APPIMAGE
}

// Makes electron-updater count a version as available only once `check` returns its signed update
// file: a version it refuses is not reported, so nothing is downloaded for it. The returned
// function gives the signed file of a version electron-updater then reports, or undefined for
// one this did not check (electron-updater reports the very object it checked; a copy is refused).
// `refused` hears of a version whose signature did not hold.
export function requireSignature(
  checker: { isUpdateSupported: (info: UpdateInfo) => boolean | Promise<boolean> },
  check: (info: UpdateInfo) => Promise<SignedUpdate>,
  refused: (info: UpdateInfo) => void = () => undefined,
): (info: UpdateInfo) => SignedUpdate | undefined {
  const supported = checker.isUpdateSupported
  const signed = new WeakMap<UpdateInfo, SignedUpdate>()
  checker.isUpdateSupported = async info => {
    if (!(await supported(info))) return false
    try {
      signed.set(info, await check(info))
      return true
    } catch (error) {
      console.error('update refused:', error instanceof Error ? error.message : error)
      refused(info)
      return false
    }
  }
  return info => signed.get(info)
}

// Ends the bridge before an update installs. The pid is read now, not when the update came:
// the bridge may have been restarted since and its old pid reused by another program.
export async function stopBridgeNow(
  bridgePid: () => Promise<number | null>,
  kill: (pid: number) => void = pid => process.kill(pid),
  waitMs = PID_WAIT_MS,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), waitMs)))
  const pid = await Promise.race([bridgePid().catch(() => null), late])
  clearTimeout(timer)
  if (pid === null || pid === process.pid) return null
  try {
    kill(pid)
  } catch {
    // Gone already.
  }
  return pid
}

// `bridgePid`: the pid of the bridge serving now (its /health). The bridge runs on this app's
// own executable, which Windows keeps locked while it runs, so a downloaded update stops it
// before installing. `terminals`: the app's terminals (terminals.ts terminalStates).
export function startUpdates(bridgePid: () => Promise<number | null>, terminals: () => readonly { alive: boolean }[]): void {
  if (!app.isPackaged || process.env.CLAUDE_IDE_CAPTURE) return
  const { autoUpdater } = updater
  const status = tracker()
  status.set({ state: 'idle' })
  const installs = installsUpdates()
  const mac = process.platform === 'darwin' ? macUpdates(terminals, status, { exe: app.getPath('exe'), pid: process.pid, whenQuit: start => void app.on('quit', start) }) : null
  // Downloaded below, once the signature holds.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = installs
  // A version the last check found but whose signature did not hold.
  let refused = ''
  const signed = requireSignature(autoUpdater, info => signedUpdate(info, channelFile()), info => (refused = info.version))
  const tellAvailable = manualUpdates(status)
  autoUpdater.on('checking-for-update', () => {
    refused = ''
    if (checkable(status.get().state)) status.set({ state: 'checking', error: undefined })
  })
  autoUpdater.on('update-not-available', () => {
    if (!['checking', 'idle', 'latest', 'error', 'refused'].includes(status.get().state)) return
    status.set(refused ? { state: 'refused', latest: refused, checkedAt: Date.now() } : { state: 'latest', latest: undefined, checkedAt: Date.now() })
  })
  autoUpdater.on('update-available', info => {
    const update = signed(info)
    if (!update) return
    // Here, within the event: electron-updater downloads what this check found, the file just
    // compared with the signed one. Its own sha512 check of the download does the rest; a failure
    // reaches the error handler below.
    if (installs) {
      if (status.get().state !== 'ready') status.set({ state: 'downloading', latest: update.version, checkedAt: Date.now() })
      void autoUpdater.downloadUpdate().catch(() => undefined)
    } else if (mac) void mac(update).then(done => done || tellAvailable(update.version))
    else tellAvailable(update.version)
  })
  // Set once an update waits to install; the quit then stops the bridge first, once.
  let downloaded = false
  let stopped = false
  const stopBridge = async () => {
    stopped = true
    if (process.platform === 'win32') await stopBridgeNow(bridgePid)
  }
  autoUpdater.on('update-downloaded', info => {
    downloaded = true
    const install = () =>
      void installNowAllowed(terminals, info.version).then(now => {
        if (now) void stopBridge().finally(() => autoUpdater.quitAndInstall())
      })
    onInstallReady(install)
    status.set({ state: 'ready', latest: info.version })
    notifyUpdate(t('update.ready', { version: info.version }), install)
  })
  app.on('before-quit', event => {
    if (!downloaded || stopped || process.platform !== 'win32') return
    // Held until the bridge is asked for its pid and stopped, then the quit carries on.
    event.preventDefault()
    void stopBridge().finally(() => app.quit())
  })
  autoUpdater.on('error', error => {
    console.error('update check failed:', error.message)
    if (['checking', 'downloading'].includes(status.get().state)) status.set({ state: 'error', error: error.message, checkedAt: Date.now() })
  })
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined)
  onCheckNow(check)
  check()
  setInterval(check, CHECK_MS).unref()
}

// Updates of the installed app, from the GitHub releases (electron-builder.yml publish).
// Windows and the Linux AppImage download a new version and install it when the app quits.
// macOS does the same with its own download and swap (macUpdate.ts): Squirrel.Mac installs only
// a signed update, and this app is signed ad hoc. A Mac app in a folder this user cannot write
// and a .deb (or any other Linux package, the system package manager's to update, as the README
// says) get a notification that opens the download page.
// An update never stops the app by itself: it installs when the person quits, or when they ask
// for it from the notification after being told which terminals that closes.

import { app, dialog, Notification, powerMonitor, shell } from 'electron'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import updater from 'electron-updater'
import { t } from '../shared/i18n'
import { bundleOf, canReplace, cleanUpdates, download, isNewer, startSwap, unpack, zipFor, zipUrl } from './macUpdate'

export const RELEASES_URL = 'https://github.com/choco5958/switchboard/releases/latest'
const CHECK_MS = 6 * 3600_000
// A bridge that does not answer /health in this time is not waited for at quit.
const PID_WAIT_MS = 2000

// Whether this copy of the app installs updates with electron-updater. On Linux only the
// AppImage does (its runtime sets APPIMAGE); electron-updater would install a .deb with pkexec
// or sudo. macOS has its own path (macUpdate.ts).
export function installsUpdates(platform: string = process.platform, env: Record<string, string | undefined> = process.env): boolean {
  if (platform === 'win32') return true
  return platform === 'linux' && !!env.APPIMAGE
}

// How many terminals an install now would close: the quit ends every app terminal still running,
// and with it Claude Code or whatever else runs there. None: nothing to ask.
export function terminalsClosing(terminals: readonly { alive: boolean }[]): number {
  return terminals.filter(one => one.alive).length
}

function notify(body: string, onClick: () => void): void {
  if (!Notification.isSupported()) return
  const note = new Notification({ title: 'Switchboard', body })
  note.on('click', onClick)
  note.show()
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

// Asked when the person clicks "ready" while app terminals run: installing now closes them, so
// the default keeps them and installs at the person's own quit.
async function installNowAllowed(terminals: () => readonly { alive: boolean }[], version: string): Promise<boolean> {
  const count = terminalsClosing(terminals())
  if (count === 0) return true
  const answer = await dialog.showMessageBox({
    type: 'question',
    buttons: [t('update.installNow'), t('update.installOnQuit')],
    defaultId: 1,
    cancelId: 1,
    message: t('update.confirmMessage', { version }),
    detail: t('update.confirmDetail', { count }),
  })
  return answer.response === 0
}

// `bridgePid`: the pid of the bridge serving now (its /health). The bridge runs on this app's
// own executable, which Windows keeps locked while it runs, so a downloaded update stops it
// before installing. `terminals`: the app's terminals (terminals.ts terminalStates).
export function startUpdates(bridgePid: () => Promise<number | null>, terminals: () => readonly { alive: boolean }[]): void {
  if (!app.isPackaged || process.env.CLAUDE_IDE_CAPTURE) return
  const { autoUpdater } = updater
  const installs = installsUpdates()
  const mac = process.platform === 'darwin' ? macUpdates(terminals) : null
  autoUpdater.autoDownload = installs
  autoUpdater.autoInstallOnAppQuit = installs
  let told = ''
  const tellAvailable = (version: string) => {
    if (told === version) return
    told = version
    notify(t('update.available', { version }), () => void shell.openExternal(RELEASES_URL))
  }
  autoUpdater.on('update-available', info => {
    if (installs) return
    if (mac) void mac(info).then(done => done || tellAvailable(info.version))
    else tellAvailable(info.version)
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
    notify(t('update.ready', { version: info.version }), () => {
      void installNowAllowed(terminals, info.version).then(now => {
        if (now) void stopBridge().finally(() => autoUpdater.quitAndInstall())
      })
    })
  })
  app.on('before-quit', event => {
    if (!downloaded || stopped || process.platform !== 'win32') return
    // Held until the bridge is asked for its pid and stopped, then the quit carries on.
    event.preventDefault()
    void stopBridge().finally(() => app.quit())
  })
  autoUpdater.on('error', error => console.error('update check failed:', error.message))
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined)
  check()
  setInterval(check, CHECK_MS).unref()
}

type Found = { version: string; files: readonly { url: string; sha512?: string; size?: number }[] }

// The macOS path: returns what to do with a version electron-updater found, resolving true when
// it is downloaded or on its way, false when the person has to download it themselves.
// The bridge keeps running through the swap. It runs this app's executable as Node, but macOS
// keeps a moved or deleted file open for the process using it, and its scripts are a copy under
// ~/.claude-ide/runtime (runtime.ts). The new version replaces it when it starts (staleBridge).
function macUpdates(terminals: () => readonly { alive: boolean }[]): (found: Found) => Promise<boolean> {
  const bundle = bundleOf(app.getPath('exe'))
  const dir = join(app.getPath('userData'), 'updates')
  const log = join(app.getPath('userData'), 'update.log')
  // Versions whose swap failed before (macUpdate.ts SWAP_SCRIPT): offered as a download instead.
  const failed = cleanUpdates(dir, app.getVersion())
  let staged: { version: string; fresh: string; stage: string } | null = null
  let busy = ''
  let relaunch = false
  let swapped = false
  // A shutdown or logout quits the app too, but the system may stop the swap halfway; that
  // update waits for the next quit.
  let shuttingDown = false
  powerMonitor.on('shutdown', () => (shuttingDown = true))
  app.on('quit', () => {
    if (!staged || swapped || shuttingDown || !bundle || !canReplace(bundle)) return
    swapped = true
    try {
      startSwap({ pid: process.pid, target: bundle, fresh: staged.fresh, stage: staged.stage, relaunch, log })
    } catch (error) {
      console.error('could not start the update:', error)
    }
  })
  const installNow = (version: string) =>
    void installNowAllowed(terminals, version).then(now => {
      if (!now) return
      relaunch = true
      app.quit()
    })
  return async found => {
    const { version } = found
    if (!isNewer(version, app.getVersion())) return true
    if (staged?.version === version || busy === version) return true
    const file = zipFor(found.files, version, process.arch)
    if (!bundle || !file || failed.has(version) || !canReplace(bundle)) return false
    busy = version
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const zip = join(dir, file.name)
      const stage = join(dir, version)
      await download(zipUrl(version, file.name), zip, file)
      // A quit while this unpacks installs what was staged before, if anything.
      const fresh = await unpack(zip, stage, version).finally(() => rmSync(zip, { force: true }))
      const before = staged
      staged = { version, fresh, stage }
      if (before) rmSync(before.stage, { recursive: true, force: true })
      notify(t('update.ready', { version }), () => installNow(version))
      return true
    } catch (error) {
      console.error('update download failed:', error instanceof Error ? error.message : error)
      return false
    } finally {
      busy = ''
    }
  }
}

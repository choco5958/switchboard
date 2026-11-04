// Updates of the installed app: the part both shells share (docs/tauri-이전.md, step 7). Nothing
// here imports Electron. The Electron shell finds versions with electron-updater (updater.ts);
// the Tauri shell's Node host reads the release's update file itself (startHostUpdates). Either
// way a version counts only once its update file carries the release key's signature
// (updateSignature.ts), and on macOS both install it with the same download and swap
// (macUpdate.ts, macUpdates below), so an Electron app installs a Tauri bundle like any other.
// An update never stops the app by itself: it installs when the person quits, or when they ask
// for it from the notification after being told which terminals that closes.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../shared/i18n'
import type { UpdateStatus } from '../shared/types'
import { bundleOf, canReplace, cleanUpdates, download, isNewer, NeedsNewerSystem, releaseUrl, startSwap, unpack, zipFor } from './macUpdate'
import { platform, type Ipc } from './platform'
import { channelFile, latestSigned, UpdateRefused, type SignedUpdate } from './updateSignature'

export const RELEASES_URL = 'https://github.com/choco5958/switchboard/releases/latest'
export const CHECK_MS = 6 * 3600_000

// How many terminals an install now would close: the quit ends every app terminal running in the
// app's own process, and with it Claude Code or whatever else runs there (terminals.ts
// terminalStates leaves out those the host keeps). None: nothing to ask.
export function terminalsClosing(terminals: readonly { alive: boolean }[]): number {
  return terminals.filter(one => one.alive).length
}

// Where the update stands, for the settings page; `watch` hears every change.
export function updateTracker(version: string) {
  let status: UpdateStatus = { version, state: 'off' }
  const listeners = new Set<(status: UpdateStatus) => void>()
  return {
    get: () => status,
    set(next: Partial<UpdateStatus>) {
      status = { ...status, ...next, version }
      for (const listener of listeners) listener(status)
    },
    watch(listener: (status: UpdateStatus) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export type Tracker = ReturnType<typeof updateTracker>

// A check now does nothing while one runs or a version is on its way or waiting to install.
export const checkable = (state: UpdateStatus['state']): boolean => !['off', 'checking', 'downloading', 'ready'].includes(state)

let tracked: Tracker | null = null
export const tracker = (): Tracker => (tracked ??= updateTracker(platform().version()))
// Set by the shell's updates: a check now, and the install of a version waiting for it.
let checkNow: () => void = () => undefined
let installReady: () => void = () => undefined
export const onCheckNow = (check: () => void) => void (checkNow = check)
export const onInstallReady = (install: () => void) => void (installReady = install)

// The settings page's view of it: the status, a check now, and the install of what waits.
export function registerUpdates(ipc: Pick<Ipc, 'handle'>, sendTo: (channel: string, payload: unknown) => void): void {
  tracker().watch(status => sendTo('update:status', status))
  ipc.handle('update:status', () => tracker().get())
  ipc.handle('update:check', () => {
    if (checkable(tracker().get().state)) checkNow()
    return tracker().get()
  })
  ipc.handle('update:install', () => {
    if (tracker().get().state === 'ready') installReady()
  })
}

export function notifyUpdate(body: string, onClick: () => void): void {
  if (platform().notificationsSupported()) platform().notify('Switchboard', body, onClick)
}

// Tells of a version this app cannot install itself: the notification opens the download page.
export function manualUpdates(status: Tracker): (version: string) => void {
  let told = ''
  return version => {
    status.set({ state: 'manual', latest: version, checkedAt: Date.now() })
    if (told === version) return
    told = version
    notifyUpdate(t('update.available', { version }), () => void platform().openExternal(RELEASES_URL))
  }
}

// Asked when the person clicks "ready" while app terminals run: installing now closes them, so
// the default keeps them and installs at the person's own quit.
export async function installNowAllowed(terminals: () => readonly { alive: boolean }[], version: string): Promise<boolean> {
  const count = terminalsClosing(terminals())
  if (count === 0) return true
  const answer = await platform().messageBox({
    type: 'question',
    buttons: [t('update.installNow'), t('update.installOnQuit')],
    defaultId: 1,
    cancelId: 1,
    message: t('update.confirmMessage', { version }),
    detail: t('update.confirmDetail', { count }),
  })
  return answer === 0
}

// The running app, for the swap: its executable (inside the bundle to replace), the process the
// swap waits for, and the hook that starts the swap once the app is going away.
export type AppPlace = { exe: string; pid: number; whenQuit: (start: () => void) => void }

// The macOS path: returns what to do with a version found, given its signed latest-mac.yml
// (updateSignature.ts), whose sha512 the zip has to match. Resolves true when it is downloaded or
// on its way, false when the person has to download it themselves.
// The bridge keeps running through the swap. It runs the app's Node (Electron's executable as
// Node, or the Tauri app's switchboard-node), but macOS keeps a moved or deleted file open for the
// process using it, and its scripts are a copy under ~/.claude-ide/runtime (runtime.ts). The new
// version replaces it when it starts (staleBridge). The terminal host does the same and is not
// replaced: it keeps its terminals until they end.
export function macUpdates(terminals: () => readonly { alive: boolean }[], status: Tracker, place: AppPlace): (found: SignedUpdate) => Promise<boolean> {
  const bundle = bundleOf(place.exe)
  const dir = join(platform().userDataPath(), 'updates')
  const log = join(platform().userDataPath(), 'update.log')
  // Versions whose swap failed before (macUpdate.ts SWAP_SCRIPT): offered as a download instead.
  const failed = cleanUpdates(dir, platform().version())
  let staged: { version: string; fresh: string; stage: string } | null = null
  let busy = ''
  let relaunch = false
  let swapped = false
  // A shutdown or logout quits the app too, but the system may stop the swap halfway; that
  // update waits for the next quit.
  let shuttingDown = false
  platform().onPower('shutdown', () => (shuttingDown = true))
  place.whenQuit(() => {
    if (!staged || swapped || shuttingDown || !bundle || !canReplace(bundle)) return
    swapped = true
    try {
      startSwap({ pid: place.pid, target: bundle, fresh: staged.fresh, stage: staged.stage, relaunch, log })
    } catch (error) {
      console.error('could not start the update:', error)
    }
  })
  const installNow = (version: string) =>
    void installNowAllowed(terminals, version).then(now => {
      if (!now) return
      relaunch = true
      platform().quit()
    })
  return async found => {
    const { version } = found
    if (!isNewer(version, platform().version())) {
      status.set({ state: 'latest', latest: undefined, checkedAt: Date.now() })
      return true
    }
    if (staged?.version === version || busy === version) return true
    const file = zipFor(found.files, version, process.arch)
    if (!bundle || !file || failed.has(version) || !canReplace(bundle)) return false
    busy = version
    status.set({ state: 'downloading', latest: version, checkedAt: Date.now() })
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const zip = join(dir, file.name)
      const stage = join(dir, version)
      await download(releaseUrl(version, file.name), zip, file)
      // A quit while this unpacks installs what was staged before, if anything.
      const fresh = await unpack(zip, stage, version).finally(() => rmSync(zip, { force: true }))
      const before = staged
      staged = { version, fresh, stage }
      if (before) rmSync(before.stage, { recursive: true, force: true })
      onInstallReady(() => installNow(version))
      status.set({ state: 'ready', latest: version })
      notifyUpdate(t('update.ready', { version }), () => installNow(version))
      return true
    } catch (error) {
      console.error('update download failed:', error instanceof Error ? error.message : error)
      if (error instanceof NeedsNewerSystem) failed.add(version)
      // A version staged before still waits to install; otherwise the person downloads it.
      if (!staged) return false
      status.set({ state: 'ready', latest: staged.version })
      return true
    } finally {
      busy = ''
    }
  }
}

// The Tauri shell's updates, run by its Node host (src/host/main.ts): every few hours, and when
// the settings page asks, the latest release's signed update file for this system. macOS installs
// it (macUpdates); Windows and Linux are told where to download it until the Tauri app installs
// there too (docs/tauri-이전.md, step 8).
export function startHostUpdates(place: AppPlace, terminals: () => readonly { alive: boolean }[], latest: (file: string) => Promise<SignedUpdate> = latestSigned): void {
  const status = tracker()
  status.set({ state: 'idle' })
  const mac = process.platform === 'darwin' ? macUpdates(terminals, status, place) : null
  const tellAvailable = manualUpdates(status)
  let running = false
  const check = async () => {
    if (running) return
    running = true
    if (checkable(status.get().state)) status.set({ state: 'checking', error: undefined })
    try {
      const update = await latest(channelFile())
      if (!isNewer(update.version, platform().version())) {
        if (status.get().state === 'checking') status.set({ state: 'latest', latest: undefined, checkedAt: Date.now() })
      } else if (mac) {
        if (!(await mac(update))) tellAvailable(update.version)
      } else tellAvailable(update.version)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(error instanceof UpdateRefused ? 'update refused:' : 'update check failed:', message)
      if (status.get().state === 'checking') {
        status.set(error instanceof UpdateRefused ? { state: 'refused', latest: error.version, checkedAt: Date.now() } : { state: 'error', error: message, checkedAt: Date.now() })
      }
    } finally {
      running = false
    }
  }
  onCheckNow(() => void check())
  void check()
  setInterval(() => void check(), CHECK_MS).unref()
}

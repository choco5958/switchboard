import type { Reply } from '../../shared/types'

// Every settings write in the renderer goes through saveSetting. App installs a saver that shows
// the new value at once (an optimistic copy laid over the bridge's settings) and reads the saved
// settings back after the write, even while Live is paused and change events are skipped.

export type SettingSaver = (key: string, value: unknown) => Promise<Reply>

export const postSetting: SettingSaver = (key, value) => window.ide.bridge('POST', '/settings', { key, value })

let saver: SettingSaver = postSetting

export function installSettingSaver(next: SettingSaver | null): void {
  saver = next ?? postSetting
}

export function saveSetting(key: string, value: unknown): Promise<Reply> {
  return saver(key, value)
}

export type Pending = Record<string, unknown>

// The settings on screen: the bridge's, with the writes still on their way laid over them.
// null deletes a setting on the bridge, so it deletes it here too.
export function withPending(settings: Record<string, unknown>, pending: Pending): Record<string, unknown> {
  const keys = Object.keys(pending)
  if (keys.length === 0) return settings
  const out = { ...settings }
  for (const key of keys) {
    if (pending[key] === null || pending[key] === undefined) delete out[key]
    else out[key] = pending[key]
  }
  return out
}

// A write landed (or failed): its key leaves the overlay unless a newer write replaced it meanwhile.
export function settle(pending: Pending, key: string, value: unknown): Pending {
  if (!(key in pending) || pending[key] !== value) return pending
  const rest = { ...pending }
  delete rest[key]
  return rest
}

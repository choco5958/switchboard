import { expect, test } from 'vitest'
import { settle, withPending } from './settings'

test('writes on their way show over the saved settings', () => {
  const saved = { theme: 'crt', lang: 'en', hiddenProjects: ['a'] }
  expect(withPending(saved, {})).toBe(saved)
  expect(withPending(saved, { theme: 'pcb', hiddenProjects: ['a', 'b'] })).toEqual({ theme: 'pcb', lang: 'en', hiddenProjects: ['a', 'b'] })
  // null deletes the setting on the bridge, so it is gone on screen at once too.
  expect(withPending(saved, { lang: null })).toEqual({ theme: 'crt', hiddenProjects: ['a'] })
})

test('a landed write leaves the overlay unless a newer one replaced it', () => {
  const first = ['f1']
  const second = ['f1', 'f2']
  // Two quick writes: the first lands while the second is still on its way.
  expect(settle({ projectFolders: second }, 'projectFolders', first)).toEqual({ projectFolders: second })
  expect(settle({ projectFolders: second, theme: 'crt' }, 'projectFolders', second)).toEqual({ theme: 'crt' })
  const none = {}
  expect(settle(none, 'theme', 'crt')).toBe(none)
})

import { expect, test } from 'vitest'
import { HOME, activeTab, closeTab, openTab, pruneTabs, railActive, restoreTabs, tabKey, type Tabs } from './tabs'

const start: Tabs = { open: [HOME], active: 'home' }

test('opening a tab twice keeps one and activates it', () => {
  const once = openTab(start, { kind: 'task', id: 3 })
  const twice = openTab(openTab(once, { kind: 'question', id: 9 }), { kind: 'task', id: 3 })
  expect(twice.open.map(tabKey)).toEqual(['home', 'task:3', 'question:9'])
  expect(twice.active).toBe('task:3')
})

test('closing the active tab moves right, then left; home stays', () => {
  let tabs = [{ kind: 'task', id: 1 }, { kind: 'task', id: 2 }, { kind: 'task', id: 3 }].reduce(
    (acc, t) => openTab(acc, t as { kind: 'task'; id: number }),
    start,
  )
  tabs = openTab(tabs, { kind: 'task', id: 2 })
  tabs = closeTab(tabs, 'task:2')
  expect(tabs.active).toBe('task:3')
  tabs = closeTab(tabs, 'task:3')
  expect(tabs.active).toBe('task:1')
  expect(closeTab(tabs, 'home')).toBe(tabs)
})

test('tabs for vanished rows close', () => {
  const tabs = openTab(openTab(start, { kind: 'task', id: 1 }), { kind: 'question', id: 5 })
  const pruned = pruneTabs(tabs, t => t.kind !== 'question')
  expect(pruned.open.map(tabKey)).toEqual(['home', 'task:1'])
  expect(activeTab(pruned)).toEqual({ kind: 'task', id: 1 })
})

test('saved tabs restore with home first and a valid active tab', () => {
  expect(restoreTabs(null)).toEqual(start)
  const restored = restoreTabs({ open: [{ kind: 'task', id: 4 }], active: 'gone' })
  expect(restored.open.map(tabKey)).toEqual(['home', 'task:4'])
  expect(restored.active).toBe('home')
})

test('lights one rail button at a time', () => {
  const rail = [
    { icon: 'home', section: 'home', tab: HOME },
    { icon: 'question', section: 'questions' },
    { icon: 'settings', tab: { kind: 'settings' as const } },
  ]
  const view = { picked: null, active: 'home', section: 'home', sidebarOpen: true }
  expect(railActive(rail, view)).toBe('home')
  // Questions opened in the sidebar beside the home tab: only questions lights.
  expect(railActive(rail, { ...view, picked: 'question', section: 'questions' })).toBe('question')
  // Settings picked while the questions section stays open.
  expect(railActive(rail, { ...view, picked: 'settings', active: 'settings', section: 'questions' })).toBe('settings')
  // A task tab opened from the sidebar: the open section lights.
  expect(railActive(rail, { ...view, picked: 'settings', active: 'task:3', section: 'questions' })).toBe('question')
  // The sidebar closed on a task tab: nothing lights.
  expect(railActive(rail, { ...view, picked: 'question', active: 'task:3', section: 'questions', sidebarOpen: false })).toBe(null)
  // A pick whose section was closed gives way to the active tab.
  expect(railActive(rail, { ...view, picked: 'question', section: 'questions', sidebarOpen: false })).toBe('home')
})

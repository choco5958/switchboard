// Open tabs in the main area: every task, question, and page opens as a tab,
// as in the reference screens. Pure functions so the rules are testable.

export type Tab =
  | { kind: 'home' }
  | { kind: 'task'; id: number }
  | { kind: 'question'; id: number }
  | { kind: 'debug' }
  | { kind: 'history' }
  | { kind: 'archive' }
  | { kind: 'log' }
  | { kind: 'settings' }
  | { kind: 'gallery' }
  | { kind: 'linear' }

export type Tabs = { open: Tab[]; active: string }

export const HOME: Tab = { kind: 'home' }

export function tabKey(tab: Tab): string {
  return 'id' in tab ? `${tab.kind}:${tab.id}` : tab.kind
}

// The one rail button lit: the one last picked while what it shows is still on screen (its tab
// active, or its sidebar section open), else the active tab's button, else the open section's.
// A section and a tab can both be up at once (questions beside the home tab), and only one may light.
export type RailItem<Id extends string> = { icon: Id; section?: string; tab?: Tab }

export function railActive<Id extends string>(
  items: readonly RailItem<Id>[],
  view: { picked: Id | null; active: string; section: string; sidebarOpen: boolean },
): Id | null {
  const showing = (item: RailItem<Id>) => (item.tab ? tabKey(item.tab) === view.active : view.sidebarOpen && item.section === view.section)
  const picked = items.find(item => item.icon === view.picked)
  if (picked && showing(picked)) return picked.icon
  const byTab = items.find(item => item.tab && tabKey(item.tab) === view.active)
  if (byTab) return byTab.icon
  return (view.sidebarOpen && items.find(item => item.section === view.section)?.icon) || null
}

export function openTab(tabs: Tabs, tab: Tab): Tabs {
  const key = tabKey(tab)
  const open = tabs.open.some(t => tabKey(t) === key) ? tabs.open : [...tabs.open, tab]
  return { open, active: key }
}

// Closing the active tab activates its right neighbour, else its left one; home never closes.
export function closeTab(tabs: Tabs, key: string): Tabs {
  if (key === tabKey(HOME)) return tabs
  const index = tabs.open.findIndex(t => tabKey(t) === key)
  if (index === -1) return tabs
  const open = tabs.open.filter((_, i) => i !== index)
  if (tabs.active !== key) return { open, active: tabs.active }
  const next = open[index] ?? open[index - 1] ?? HOME
  return { open, active: tabKey(next) }
}

// A tab whose task or question no longer exists closes by itself.
export function pruneTabs(tabs: Tabs, exists: (tab: Tab) => boolean): Tabs {
  return tabs.open.filter(t => !exists(t)).reduce((acc, t) => closeTab(acc, tabKey(t)), tabs)
}

export function activeTab(tabs: Tabs): Tab {
  return tabs.open.find(t => tabKey(t) === tabs.active) ?? HOME
}

export function restoreTabs(saved: unknown): Tabs {
  const fallback: Tabs = { open: [HOME], active: tabKey(HOME) }
  if (!saved || typeof saved !== 'object') return fallback
  const { open, active } = saved as Partial<Tabs>
  if (!Array.isArray(open) || typeof active !== 'string') return fallback
  const valid = open.filter((t): t is Tab => !!t && typeof t === 'object' && typeof (t as Tab).kind === 'string')
  const withHome = valid.some(t => t.kind === 'home') ? valid : [HOME, ...valid]
  return { open: withHome, active: withHome.some(t => tabKey(t) === active) ? active : tabKey(HOME) }
}

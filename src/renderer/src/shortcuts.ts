import type { Key } from '../../shared/i18n'

// The app's keyboard shortcuts, for the help dialog (? or ⌘/). Each entry names the file whose
// handler takes the key and a piece of that handler's code (`needle`); shortcuts.test.ts reads
// the file and fails when the handler is gone, so the list cannot drift from what the keys do.

// A key typed into a field, an editable element or a dock terminal belongs to that field.
export function typingTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null
  if (!el || typeof el.closest !== 'function') return false
  if (el.isContentEditable) return true
  return el.closest('input, textarea, select, [contenteditable="true"], .terminal-view') !== null
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'target'>

// ⌘K (Ctrl+K elsewhere) opens and closes the search palette, from anywhere.
export function isPaletteKey(event: KeyLike): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'
}

// ⌘/ (Ctrl+/) from anywhere; ? only outside a text field, where it would be a typed character.
export function isHelpKey(event: KeyLike): boolean {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === '/') return true
  return event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey && !typingTarget(event.target)
}

export type Shortcut = { keys: string[]; label: Key; source: string; needle: string }
export type ShortcutGroup = { title: Key; note?: Key; items: Shortcut[] }

// mod: '⌘' on a Mac, 'Ctrl' elsewhere; alt likewise ('⌥', 'Alt').
export function shortcutGroups(mac: boolean, decisionKeysAnywhere: boolean): ShortcutGroup[] {
  const mod = mac ? '⌘' : 'Ctrl'
  const alt = mac ? '⌥' : 'Alt'
  const chord = (...keys: string[]) => keys.join(mac ? '' : '+')
  return [
    {
      title: 'keys.groupApp',
      items: [
        { keys: [chord(mod, 'K')], label: 'keys.palette', source: 'App.tsx', needle: 'isPaletteKey(event)' },
        { keys: ['?', chord(mod, '/')], label: 'keys.help', source: 'App.tsx', needle: 'isHelpKey(event)' },
        { keys: ['Esc'], label: 'keys.close', source: 'ui.tsx', needle: "event.key === 'Escape'" },
      ],
    },
    {
      title: 'keys.groupDecision',
      note: decisionKeysAnywhere ? 'keys.decisionAnywhere' : 'keys.decisionFocus',
      items: [
        { keys: ['a', 'b', '1', '2'], label: 'keys.choose', source: 'model.ts', needle: "/^[1-9]$/.test(key)" },
        { keys: ['Enter'], label: 'keys.send', source: 'model.ts', needle: "key === 'Enter'" },
        { keys: ['H', 'H'], label: 'keys.hold', source: 'model.ts', needle: "lower === 'h'" },
        { keys: ['M'], label: 'keys.memo', source: 'model.ts', needle: "lower === 'm'" },
        { keys: [chord(mod, 'Enter')], label: 'keys.memoSend', source: 'QuestionCard.tsx', needle: "event.key === 'Enter' && (event.metaKey || event.ctrlKey)" },
      ],
    },
    {
      title: 'keys.groupLists',
      items: [
        { keys: ['←', '→', 'Home', 'End'], label: 'keys.tabMove', source: 'ui.tsx', needle: "['ArrowRight', 'ArrowLeft', 'Home', 'End']" },
        { keys: ['Delete'], label: 'keys.tabClose', source: 'ui.tsx', needle: "event.key === 'Delete' && item.close" },
        { keys: ['↑', '↓', 'Enter'], label: 'keys.listMove', source: 'Palette.tsx', needle: "event.key === 'ArrowDown'" },
      ],
    },
    {
      title: 'keys.groupSidebar',
      items: [
        { keys: ['Delete'], label: 'keys.hideProject', source: 'ProjectList.tsx', needle: 'hide(p.name)' },
        { keys: ['F2'], label: 'keys.renameGroup', source: 'ProjectList.tsx', needle: "event.key === 'F2'" },
        { keys: ['Delete'], label: 'keys.removeGroup', source: 'ProjectList.tsx', needle: 'ungroup(folder)' },
      ],
    },
    {
      title: 'keys.groupBrowser',
      items: [
        { keys: [chord(alt, 'M')], label: 'keys.comment', source: 'BrowserView.tsx', needle: "event.altKey && event.code === 'KeyM'" },
        { keys: [chord(mod, 'Enter')], label: 'keys.directSend', source: 'pages/DebugPanel.tsx', needle: "event.key === 'Enter' && (event.metaKey || event.ctrlKey)" },
      ],
    },
  ]
}

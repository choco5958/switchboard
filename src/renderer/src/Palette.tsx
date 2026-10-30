import { useEffect, useRef, useState } from 'react'
import { t } from '../../shared/i18n'
import { composing } from './ime'

// disabled holds the reason the item cannot run now; it shows in place of the hint.
export type PaletteItem = { id: string; group: string; label: string; hint?: string; disabled?: string; run: () => void }

// Every word of the query must appear somewhere in the label or hint (case-insensitive).
export function matches(query: string, item: Pick<PaletteItem, 'label' | 'hint' | 'group'>): boolean {
  const hay = `${item.group} ${item.label} ${item.hint ?? ''}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(word => hay.includes(word))
}

// How many rows the list draws; past that it says how many more match.
export const PALETTE_ROWS = 100

export function Palette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const found = items.filter(item => matches(query, item))
  const shown = found.slice(0, PALETTE_ROWS)

  useEffect(() => input.current?.focus(), [])
  useEffect(() => setIndex(0), [query])
  // The arrows can move past the bottom of the list box; the highlighted row stays in sight.
  useEffect(() => {
    list.current?.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const pick = (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return
    onClose()
    item.run()
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={event => event.stopPropagation()}>
        <input
          ref={input}
          className="palette-input"
          placeholder={t('palette.placeholder')}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'ArrowDown') setIndex(i => Math.min(shown.length - 1, i + 1))
            if (event.key === 'ArrowUp') setIndex(i => Math.max(0, i - 1))
            if (event.key === 'Enter' && !composing(event)) pick(shown[index])
          }}
        />
        <div className="palette-list" ref={list}>
          {shown.length === 0 && <div className="quiet small palette-empty">{t('palette.empty')}</div>}
          {shown.map((item, i) => (
            <button
              key={item.id}
              className={`palette-item ${i === index ? 'on' : ''} ${item.disabled ? 'disabled' : ''}`}
              aria-disabled={!!item.disabled}
              title={item.disabled}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(item)}
            >
              <span className="palette-group">{item.group}</span>
              <span className="palette-label">{item.label}</span>
              {(item.disabled ?? item.hint) && <span className="quiet small palette-hint">{item.disabled ?? item.hint}</span>}
            </button>
          ))}
          {found.length > shown.length && <div className="quiet small palette-empty">{t('palette.more', { n: found.length - shown.length })}</div>}
        </div>
      </div>
    </div>
  )
}

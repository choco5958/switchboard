import { useEffect, useId, useRef, useState } from 'react'
import { t } from '../../shared/i18n'
import { composing } from './ime'
import { Dialog, EmptyState, cx } from './ui'

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

// A modal dialog with one field that filters a list (a combobox over a listbox): the arrows move
// the highlighted row while typing stays in the field, Enter runs it, Esc closes and focus goes
// back where it was (Dialog).
export function Palette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const found = items.filter(item => matches(query, item))
  const shown = found.slice(0, PALETTE_ROWS)
  const optionId = (i: number) => `${listId}-${i}`

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
    <Dialog label={t('top.search')} onClose={onClose} initial={input} className="palette">
      <input
        ref={input}
        className="palette-input"
        role="combobox"
        aria-label={t('palette.placeholder')}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown[index] ? optionId(index) : undefined}
        placeholder={t('palette.placeholder')}
        value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') setIndex(i => Math.min(shown.length - 1, i + 1))
          else if (event.key === 'ArrowUp') setIndex(i => Math.max(0, i - 1))
          else if (event.key === 'Enter' && !composing(event)) pick(shown[index])
          else return
          event.preventDefault()
        }}
      />
      <div className="palette-list" ref={list} id={listId} role="listbox" aria-label={t('top.search')}>
        {shown.length === 0 && <EmptyState className="small palette-empty">{t('palette.empty')}</EmptyState>}
        {shown.map((item, i) => (
          <div
            key={item.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === index}
            aria-disabled={item.disabled ? true : undefined}
            className={cx('row palette-item', i === index && 'on', item.disabled && 'disabled')}
            title={item.disabled}
            onMouseEnter={() => setIndex(i)}
            // The field keeps focus: a press on a row must not take it away first.
            onMouseDown={event => event.preventDefault()}
            onClick={() => pick(item)}
          >
            <span className="palette-group">{item.group}</span>
            <span className="palette-label">{item.label}</span>
            {(item.disabled ?? item.hint) && <span className="quiet small palette-hint">{item.disabled ?? item.hint}</span>}
          </div>
        ))}
        {found.length > shown.length && <p className="quiet small palette-empty">{t('palette.more', { n: found.length - shown.length })}</p>}
      </div>
    </Dialog>
  )
}

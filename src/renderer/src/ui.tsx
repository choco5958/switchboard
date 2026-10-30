import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { Icon, type IconName, type IconSize } from './Icons'
import { composing } from './ime'

// The shared parts of every screen: buttons, icon buttons, badges, fields, surfaces, menus, tabs,
// dialogs, notices and empty states. Each one is a class in styles.css ("Parts") drawn from the
// tokens, so a theme changes them through its tokens. GalleryPage shows every variant and state.
// Parts that know about tasks and questions stay in parts.tsx.

export const cx = (...names: (string | false | null | undefined)[]): string => names.filter(Boolean).join(' ')

// Scrolling and other motion follow the system's reduce motion setting.
export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

// Buttons. default is the plain one; primary is the one action a screen leads to; danger loses
// something; ghost has no border until hovered; link reads as text.
export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost' | 'link'
export type ButtonSize = 'md' | 'sm'

export function buttonClass(variant: ButtonVariant = 'default', size: ButtonSize = 'md', extra?: string): string {
  if (variant === 'link') return cx('link', size === 'sm' && 'small', extra)
  return cx('btn', variant !== 'default' && `btn-${variant}`, size === 'sm' && 'btn-sm', extra)
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant, size, className, type = 'button', ...rest }, ref) {
  return <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest} />
})

// A button that shows only an icon. The label is its name for screen readers and its tooltip.
// children replace the icon for a moment (the dock's "close?" step); then they are its name.
type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  label: string
  icon: IconName
  size?: IconSize
  on?: boolean // the place or panel it stands for is the current one
  badge?: ReactNode // a count over the icon (the rail)
  children?: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'md', on, badge, children, className, title, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={children ? undefined : label}
      title={title ?? label}
      className={cx('icon-btn', `icon-btn-${size}`, on && 'on', !!children && 'has-text', className)}
      {...rest}
    >
      {children ?? <Icon name={icon} size={size} />}
      {badge}
    </button>
  )
})

// Badges: a short label or a count. tone colours it; shape is a box (tags), a pill (status chips)
// or a round count; fill is an outline, a soft tint or a solid fill (counts, the recommended mark).
// A solid fill comes in accent, good and warn only: those three have a text colour made for them.
export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad'
export type BadgeShape = 'box' | 'pill' | 'count'
export type BadgeFill = 'outline' | 'soft' | 'solid'
type BadgeLook = { tone?: Tone; shape?: BadgeShape; fill?: BadgeFill; mono?: boolean }

export function badgeClass({ tone = 'neutral', shape = 'box', fill = shape === 'count' ? 'solid' : 'outline', mono }: BadgeLook, extra?: string): string {
  return cx('badge', `badge-${shape}`, `tone-${tone}`, fill !== 'outline' && `badge-${fill}`, mono && 'badge-mono', extra)
}

export function Badge({ tone, shape, fill, mono, className, ...rest }: HTMLAttributes<HTMLSpanElement> & BadgeLook) {
  return <span className={badgeClass({ tone, shape, fill, mono }, className)} {...rest} />
}

// A pill that does something when pressed (the top bar's counts, a filter). on: the filter in use.
export function Chip({ tone, on, className, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; on?: boolean }) {
  return <button type={type} className={badgeClass({ tone: on ? 'accent' : tone, shape: 'pill' }, cx('chip-button', on && 'on', className))} {...rest} />
}

// Text fields, one look for all: a field border in --line-strong, the focus colour when focused.
// compact is the small size for toolbars; mono is for paths, commands and addresses.
type FieldLook = { compact?: boolean; mono?: boolean }
const fieldClass = ({ compact, mono }: FieldLook, extra?: string) => cx('input', compact && 'input-sm', mono && 'input-mono', extra)

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldLook>(function Input({ compact, mono, className, ...rest }, ref) {
  return <input ref={ref} className={fieldClass({ compact, mono }, className)} {...rest} />
})

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & FieldLook>(function TextArea(
  { compact, mono, className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={fieldClass({ compact, mono }, cx('input-area', className))} {...rest} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & FieldLook>(function Select({ compact, mono, className, ...rest }, ref) {
  return <select ref={ref} className={fieldClass({ compact, mono }, cx('input-select', className))} {...rest} />
})

// Surfaces: a bordered panel. sunk sits one step deeper (panel-2) inside another surface; pad is
// sm (8px) or md (12px); interactive brightens the border on hover; on is the selected one (an
// accent-soft tint and a 2px bar on the left edge); tone colours the border for a waiting ask.
type SurfaceLook = { pad?: 'sm' | 'md' | 'none'; sunk?: boolean; interactive?: boolean; on?: boolean; tone?: Tone }

export function surfaceClass({ pad = 'md', sunk, interactive, on, tone }: SurfaceLook, extra?: string): string {
  return cx('surface', sunk && 'sunk', pad !== 'none' && `pad-${pad}`, interactive && 'interactive', on && 'on', tone && tone !== 'neutral' && `tone-${tone}`, extra)
}

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & SurfaceLook>(function Card({ pad, sunk, interactive, on, tone, className, ...rest }, ref) {
  return <div ref={ref} className={surfaceClass({ pad, sunk, interactive, on, tone }, className)} {...rest} />
})

// Nothing to show yet: what is missing and, when there is one, the way to fill it.
export function EmptyState({ title, children, action, className }: { title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('empty-state', className)}>
      {title && <p className="empty-title">{title}</p>}
      {children && <div className="empty-body">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

// A notice in the flow of a screen. error interrupts (role=alert); warn and info wait their turn
// (role=status). bar is the full-width strip at the top of the main area.
export function Notice({
  tone = 'info',
  title,
  children,
  action,
  bar,
  className,
}: {
  tone?: 'error' | 'warn' | 'info'
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  bar?: boolean
  className?: string
}) {
  return (
    <div className={cx('notice', `notice-${tone}`, bar && 'notice-bar', className)} role={tone === 'error' ? 'alert' : 'status'}>
      {title && <b className="notice-title">{title}</b>}
      {children && <span className="notice-body">{children}</span>}
      {action}
    </div>
  )
}

// Menus: a list of actions that pops out of a button. The first entry takes focus; the arrows,
// Home and End move; Esc closes and puts focus back where it was; Tab and a click outside close.
// `within` is the box the menu belongs to (with its button), so pressing that button again only
// toggles it.
type MenuApi = { close: (refocus: boolean) => void }
const MenuContext = createContext<MenuApi>({ close: () => undefined })

export function Menu({
  label,
  onClose,
  within,
  className,
  children,
}: {
  label: string
  onClose: () => void
  within?: RefObject<HTMLElement | null>
  className?: string
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const api = useRef<MenuApi>({
    close: refocus => {
      if (refocus) returnTo.current?.focus()
      closeRef.current()
    },
  })

  useEffect(() => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const outside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!box.current?.contains(target) && !within?.current?.contains(target)) closeRef.current()
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [within])

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const focus = (i: number) => items[(i + items.length) % items.length]?.focus()
    const moves: Record<string, () => void> = {
      ArrowDown: () => focus(at + 1),
      ArrowUp: () => focus(at - 1),
      Home: () => focus(0),
      End: () => focus(items.length - 1),
      Escape: () => api.current.close(true),
    }
    if (event.key === 'Tab') return closeRef.current()
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    event.stopPropagation()
    move()
  }

  return (
    <MenuContext.Provider value={api.current}>
      <div ref={box} role="menu" aria-label={label} className={cx('menu', className)} onKeyDown={keys}>
        {children}
      </div>
    </MenuContext.Provider>
  )
}

// One entry. Choosing it closes the menu and puts focus back first, so whatever it opens can take
// focus after.
export function MenuItem({ onSelect, icon, className, children, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & { onSelect: () => void; icon?: IconName }) {
  const menu = useContext(MenuContext)
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={cx('menu-item', className)}
      onClick={() => {
        menu.close(true)
        onSelect()
      }}
      {...rest}
    >
      {icon && <Icon name={icon} size="sm" />}
      {children}
    </button>
  )
}

export function MenuSeparator() {
  return <hr className="menu-sep" />
}

// Tabs. Only the selected tab is in the Tab order; the arrows, Home and End move along the row and
// select. A tab's close button sits beside the tab, not inside it, with its own name; the middle
// mouse button and Delete close a tab as well. The selected tab's mark is the --tab-indicator token.
export type TabItem = {
  key: string
  label: ReactNode
  title?: string
  className?: string
  close?: { label: string; onClose: () => void; content?: ReactNode; title?: string; className?: string; onBlur?: () => void }
}

export function TabList({
  label,
  items,
  active,
  onSelect,
  className,
}: {
  label: string
  items: TabItem[]
  active: string
  onSelect: (key: string) => void
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const go = (from: number, key: string) => {
    const last = items.length - 1
    const to = key === 'ArrowRight' ? (from >= last ? 0 : from + 1) : key === 'ArrowLeft' ? (from <= 0 ? last : from - 1) : key === 'Home' ? 0 : last
    const next = items[to]
    if (!next) return
    onSelect(next.key)
    box.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus()
  }
  return (
    <div ref={box} role="tablist" aria-label={label} className={cx('tablist', className)}>
      {items.map((item, i) => {
        const on = item.key === active
        return (
          <div key={item.key} role="presentation" className={cx('tab-item', on && 'on', item.className)}>
            <button
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              className={cx('tab', on && 'on')}
              title={item.title}
              onClick={() => onSelect(item.key)}
              // The middle button closes a tab, as in a browser; pressing it down would start autoscroll.
              onMouseDown={event => {
                if (event.button === 1) event.preventDefault()
              }}
              onAuxClick={event => {
                if (event.button !== 1 || !item.close) return
                event.preventDefault()
                item.close.onClose()
              }}
              onKeyDown={event => {
                if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault()
                  go(i, event.key)
                } else if (event.key === 'Delete' && item.close) {
                  event.preventDefault()
                  item.close.onClose()
                }
              }}
            >
              {item.label}
            </button>
            {item.close && (
              <IconButton
                icon="close"
                size="sm"
                label={item.close.label}
                title={item.close.title}
                tabIndex={on ? 0 : -1}
                className={cx('tab-close', item.close.className)}
                onBlur={item.close.onBlur}
                onClick={item.close.onClose}
              >
                {item.close.content}
              </IconButton>
            )}
          </div>
        )
      })}
    </div>
  )
}

// A modal dialog over a scrim. Focus moves in (to `initial`, else the first control), Tab stays
// inside, Esc or a click on the scrim closes, and focus goes back where it was.
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function Dialog({
  label,
  onClose,
  initial,
  className,
  scrimClassName,
  children,
}: {
  label: string
  onClose: () => void
  initial?: RefObject<HTMLElement | null>
  className?: string
  scrimClassName?: string
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = initial?.current ?? box.current?.querySelector<HTMLElement>(FOCUSABLE) ?? box.current
    first?.focus()
    return () => {
      if (returnTo?.isConnected) returnTo.focus()
    }
  }, [])
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !composing(event)) {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab' || !box.current) return
    const stops = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (stops.length === 0) return event.preventDefault()
    const at = stops.indexOf(document.activeElement as HTMLElement)
    const to = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : at === stops.length - 1 ? 0 : at + 1
    event.preventDefault()
    stops[to]?.focus()
  }
  return (
    <div className={cx('scrim', scrimClassName)} onMouseDown={onClose}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cx('dialog', className)}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={keys}
      >
        {children}
      </div>
    </div>
  )
}

// Text only screen readers read: a state shown by colour or a mark, said in words.
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>
}

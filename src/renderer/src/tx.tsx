import { Fragment, type ReactNode } from 'react'
import { format, t, type Key, type Vars } from '../../shared/i18n'

// A sentence with elements inside ("Pick a folder with <kbd>+ Folder</kbd>"): word order
// differs by language, so the elements go in through {name} placeholders of one string.
export function tx(key: Key, parts: Record<string, ReactNode>, vars?: Vars): ReactNode {
  const text = vars ? format(t(key), vars) : t(key)
  return text.split(/\{(\w+)\}/).map((piece, i) => (i % 2 === 1 && piece in parts ? <Fragment key={i}>{parts[piece]}</Fragment> : piece))
}

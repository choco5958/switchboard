import { describe, expect, it } from 'vitest'
import { createReplay } from './termReplay'

describe('createReplay', () => {
  it('drops live chunks the buffer already holds when they arrive first', () => {
    const out: string[] = []
    const replay = createReplay(data => out.push(data))
    replay.live(3, 'c')
    replay.live(4, 'd')
    replay.buffer('abc', 3)
    replay.live(5, 'e')
    expect(out.join('')).toBe('abcde')
  })

  it('writes everything live after the buffer, and ignores old chunks', () => {
    const out: string[] = []
    const replay = createReplay(data => out.push(data))
    replay.buffer('ab', 2)
    replay.live(2, 'b')
    replay.live(3, 'c')
    expect(out.join('')).toBe('abc')
  })

  it('flushes what waited when the buffer is empty or missing', () => {
    const out: string[] = []
    const replay = createReplay(data => out.push(data))
    replay.live(1, 'a')
    replay.live(Infinity, '[end]')
    replay.buffer('', 0)
    expect(out).toEqual(['a', '[end]'])
  })
})

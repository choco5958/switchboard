// Joins a terminal's saved output with its live stream without repeating
// anything. Main numbers every chunk; the saved buffer says up to which number
// it reaches. Live chunks that come before the buffer wait, then only the ones
// past it are written.
export function createReplay(write: (data: string) => void) {
  let upTo: number | null = null
  const waiting: { seq: number; data: string }[] = []
  return {
    live(seq: number, data: string): void {
      if (upTo === null) waiting.push({ seq, data })
      else if (seq > upTo) write(data)
    },
    buffer(data: string, seq: number): void {
      if (upTo !== null) return
      upTo = seq
      if (data) write(data)
      for (const chunk of waiting.splice(0)) if (chunk.seq > seq) write(chunk.data)
    },
  }
}

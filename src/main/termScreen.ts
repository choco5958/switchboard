// What an app terminal shows now, row by row, for the typing check (agentInput.ts
// permissionMenu). The raw output keeps every frame a full-screen CLI ever drew, menus it has
// since erased among them; a headless terminal applies the cursor moves and erasures the way
// the screen does, so only what is on it counts.

import xterm from '@xterm/headless'

const { Terminal } = xterm

export type Screen = { write: (data: string) => void; resize: (cols: number, rows: number) => void; rows: () => string[]; dispose: () => void }

export function createScreen(cols: number, rows: number): Screen {
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
  return {
    write: data => term.write(data),
    resize: (c, r) => term.resize(Math.max(2, c), Math.max(1, r)),
    rows: () => {
      const buffer = term.buffer.active
      const out: string[] = []
      for (let y = 0; y < term.rows; y++) out.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '')
      return out
    },
    dispose: () => term.dispose(),
  }
}

// Writes are parsed a moment later; the tests wait for them this way.
export function settled(screen: Screen, data: string): Promise<void> {
  return new Promise(resolve => {
    screen.write(data)
    setTimeout(resolve, 0)
  })
}

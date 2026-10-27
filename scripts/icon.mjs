// Draws the app icon, resources/icon.png: a plug board of four jacks on blue,
// one of them lit. Run with `node scripts/icon.mjs` after changing a shape.
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const SIZE = 1024
const SAMPLES = 4 // per side, so 16 per pixel for smooth edges

const BG = [0x13, 0x23, 0x5b]
const LINE = [0x8f, 0xa0, 0xd0]
const RING = [0xc8, 0xd2, 0xee]
const LIT = [0xff, 0xd2, 0x3f]

// macOS leaves a margin around the rounded square.
const box = { x0: 100, y0: 100, x1: 924, y1: 924, r: 185 }
const grid = { x0: 262, y0: 262, x1: 762, y1: 762, mid: 512, stroke: 14 }
const jacks = [
  [387, 387, false],
  [637, 387, true],
  [387, 637, false],
  [637, 637, false],
]

function inRoundedBox(x, y) {
  const cx = Math.min(Math.max(x, box.x0 + box.r), box.x1 - box.r)
  const cy = Math.min(Math.max(y, box.y0 + box.r), box.y1 - box.r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= box.r ** 2
}

function onGrid(x, y) {
  const h = grid.stroke / 2
  const inside = x >= grid.x0 - h && x <= grid.x1 + h && y >= grid.y0 - h && y <= grid.y1 + h
  if (!inside) return false
  const near = (v, at) => Math.abs(v - at) <= h
  return near(x, grid.x0) || near(x, grid.x1) || near(x, grid.mid) || near(y, grid.y0) || near(y, grid.y1) || near(y, grid.mid)
}

// The colour at one sample point, or null outside the icon.
function colorAt(x, y) {
  if (!inRoundedBox(x, y)) return null
  for (const [jx, jy, lit] of jacks) {
    const d = Math.hypot(x - jx, y - jy)
    if (lit && d <= 82) return LIT
    if (!lit && d <= 70 && d >= 48) return RING
    if (d <= 82) return BG // the grid lines stop around each jack
  }
  return onGrid(x, y) ? LINE : BG
}

const rgba = Buffer.alloc(SIZE * SIZE * 4)
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const c = colorAt(px + (sx + 0.5) / SAMPLES, py + (sy + 0.5) / SAMPLES)
        if (!c) continue
        r += c[0]; g += c[1]; b += c[2]; a++
      }
    }
    const i = (py * SIZE + px) * 4
    if (a > 0) {
      rgba[i] = Math.round(r / a)
      rgba[i + 1] = Math.round(g / a)
      rgba[i + 2] = Math.round(b / a)
    }
    rgba[i + 3] = Math.round((a / (SAMPLES * SAMPLES)) * 255)
  }
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const header = Buffer.alloc(13)
header.writeUInt32BE(SIZE, 0)
header.writeUInt32BE(SIZE, 4)
header[8] = 8 // bit depth
header[9] = 6 // RGBA
const rows = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) rgba.copy(rows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(rows, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
mkdirSync(new URL('../resources/', import.meta.url), { recursive: true })
writeFileSync(new URL('../resources/icon.png', import.meta.url), png)
console.log(`resources/icon.png ${png.length} bytes`)

import { EMPTY } from '../shared/cells'

// Swatch tiles for the biome picker: the biome's colour with a small glyph
// that says what it is (waves, dunes, a tree, a peak…), drawn once and cached.

/** Biome ids by category, in picker order. */
export const BIOME_GROUPS: [string, number[]][] = [
  ['Water', [0, 13]],
  ['Warm', [1, 3, 5, 7]],
  ['Temperate', [4, 6, 8, 12]],
  ['Cold', [2, 9, 10, 11]],
  ['Highlands', [15, 14, 16, 17]],
]

type G = CanvasRenderingContext2D

function line(g: G, pts: [number, number][]): void {
  g.beginPath()
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
  g.stroke()
}
function tree(g: G, x: number, y: number, r: number): void {
  line(g, [
    [x, y + r * 1.6],
    [x, y + r * 0.6],
  ])
  g.beginPath()
  g.arc(x, y, r, 0, Math.PI * 2)
  g.fill()
  g.stroke()
}
function conifer(g: G, x: number, y: number, s: number): void {
  g.beginPath()
  g.moveTo(x, y - s)
  g.lineTo(x + s * 0.6, y + s * 0.5)
  g.lineTo(x - s * 0.6, y + s * 0.5)
  g.closePath()
  g.fill()
  g.stroke()
  line(g, [
    [x, y + s * 0.5],
    [x, y + s * 0.9],
  ])
}

const GLYPHS: Record<number, (g: G) => void> = {
  0: (g) => {
    for (const y of [11, 18]) line(g, [[5, y], [9, y - 2.5], [13, y], [17, y - 2.5], [21, y], [24, y - 2]])
  },
  13: (g) => {
    g.beginPath()
    g.ellipse(14, 15, 8, 5, 0, 0, Math.PI * 2)
    g.stroke()
    line(g, [[9, 15], [12, 13.5], [15, 15], [18, 13.5]])
  },
  1: (g) => {
    line(g, [[4, 19], [10, 13], [16, 18]])
    line(g, [[12, 21], [18, 15], [25, 20]])
  },
  2: (g) => {
    line(g, [[5, 18], [11, 13], [17, 17]])
    line(g, [[14, 21], [19, 17], [24, 20]])
  },
  3: (g) => {
    line(g, [[14, 22], [14, 13]])
    g.beginPath()
    g.ellipse(14, 11, 8, 3, 0, 0, Math.PI * 2)
    g.fill()
    g.stroke()
  },
  4: (g) => {
    for (const x of [8, 15, 21]) line(g, [[x - 2.5, 14], [x, 19], [x + 2.5, 14]])
  },
  5: (g) => tree(g, 14, 12, 5),
  6: (g) => {
    tree(g, 10, 13, 4.5)
    tree(g, 18, 11, 4.5)
  },
  7: (g) => {
    for (const [x, y] of [[9, 15], [15, 11], [20, 16], [14, 18]]) {
      g.beginPath()
      g.arc(x, y, 4.2, 0, Math.PI * 2)
      g.fill()
      g.stroke()
    }
  },
  8: (g) => {
    tree(g, 9, 12, 4)
    tree(g, 19, 12, 4)
    tree(g, 14, 16, 4)
  },
  9: (g) => {
    conifer(g, 10, 14, 7)
    conifer(g, 18, 13, 7)
  },
  10: (g) => {
    for (const x of [8, 19]) line(g, [[x - 2, 13], [x, 17], [x + 2, 13]])
    for (const [x, y] of [[13, 20], [16, 11], [22, 19]]) g.fillRect(x, y, 1.6, 1.6)
  },
  11: (g) => {
    g.beginPath()
    g.moveTo(14, 4)
    g.lineTo(19, 14)
    g.lineTo(16, 23)
    g.lineTo(11, 23)
    g.lineTo(9, 14)
    g.closePath()
    g.fill()
    g.stroke()
    line(g, [[14, 4], [14, 23]])
  },
  12: (g) => {
    for (const x of [9, 14, 19]) line(g, [[x, 22], [x + 1, 11]])
    line(g, [[5, 21], [24, 21]])
  },
  14: (g) => {
    g.beginPath()
    g.moveTo(4, 22)
    g.lineTo(12, 7)
    g.lineTo(17, 15)
    g.lineTo(20, 11)
    g.lineTo(25, 22)
    g.fill()
    g.stroke()
  },
  15: (g) => {
    g.beginPath()
    g.moveTo(3, 21)
    g.quadraticCurveTo(10, 9, 16, 21)
    g.moveTo(12, 21)
    g.quadraticCurveTo(19, 11, 26, 21)
    g.stroke()
  },
  16: (g) => {
    g.beginPath()
    g.moveTo(4, 22)
    g.lineTo(11, 9)
    g.lineTo(17, 9)
    g.lineTo(24, 22)
    g.fill()
    g.stroke()
    g.fillStyle = '#ff8a3a'
    g.fillRect(11.5, 8, 5, 2.4)
    line(g, [[14, 10], [13, 15], [14.5, 19]])
  },
  17: (g) => {
    for (const [x, y] of [[7, 9], [13, 13], [20, 9], [9, 19], [17, 20], [22, 15]]) {
      g.beginPath()
      g.arc(x, y, 1.4, 0, Math.PI * 2)
      g.fill()
    }
  },
}

const tiles = new Map<string, string>()

/** A 28 px swatch tile for a biome in its colour (checkered for the eraser). */
export function biomeTile(id: number, color: string): string {
  const key = `${id}:${color}`
  const hit = tiles.get(key)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = c.height = 28
  const g = c.getContext('2d')
  if (!g) return ''
  if (id === EMPTY) {
    for (let y = 0; y < 28; y += 7) for (let x = 0; x < 28; x += 7) (g.fillStyle = (x + y) % 14 ? '#cfcfcf' : '#f2f2f2'), g.fillRect(x, y, 7, 7)
    g.strokeStyle = '#b54848'
    g.lineWidth = 2
    line(g, [[5, 23], [23, 5]])
  } else {
    g.fillStyle = color
    g.fillRect(0, 0, 28, 28)
    // Glyph in a tone that reads on the swatch: dark ink on light colours, light on dark ones.
    const n = parseInt(color.slice(1, 7), 16)
    const lum = Number.isFinite(n) ? (((n >> 16) & 255) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) / 255 : 0.5
    const ink = lum > 0.55 ? 'rgba(30,30,25,0.7)' : 'rgba(255,255,255,0.8)'
    g.strokeStyle = ink
    g.fillStyle = lum > 0.55 ? 'rgba(30,30,25,0.22)' : 'rgba(255,255,255,0.25)'
    g.lineWidth = 1.5
    g.lineCap = 'round'
    g.lineJoin = 'round'
    GLYPHS[id]?.(g)
  }
  const url = c.toDataURL()
  tiles.set(key, url)
  return url
}

import { pointInRings } from '../shared/features'
import type { Feature } from '../shared/types'

// Hand-drawn terrain symbols scattered inside terrain areas: trees, hills,
// grass, dunes and reeds. Symbols sit on a grid aligned to world coordinates and
// are jittered from the feature id, so they hold still while panning; zoomed far
// out the grid coarsens instead of shrinking symbols to dust.

export interface Painter {
  toScreen(x: number, y: number): { x: number; y: number }
  toWorld(sx: number, sy: number): { x: number; y: number }
  /** Screen pixels per world unit. */
  scale(): number
}

type Glyph = (g: CanvasRenderingContext2D, x: number, y: number, u: number, r: (salt: number) => number) => void

interface Style {
  /** Grid spacing in world units at size 1, normal density. */
  spacing: number
  /** Share of grid cells that get a symbol. */
  fill: number
  glyph: Glyph
}

export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** A stable pseudo-random number in [0, 1) for a seed and two integers. */
export function hash01(seed: number, a: number, b: number): number {
  let h = Math.imul(seed ^ Math.imul(a, 0x9e3779b1), 0x85ebca6b) ^ Math.imul(b + 1, 0xc2b2ae35)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/** Density presets offered in the editor. */
export const DENSITY_PRESETS: [number, string][] = [
  [0.4, 'Sparse'],
  [0.7, 'Light'],
  [1, 'Normal'],
  [1.5, 'Dense'],
  [2.2, 'Very dense'],
]

// ── Glyphs ──────────────────────────────────────────────────────────────────

/** Overlapping circles outlined as one blob: ink pass underneath, colour pass on top. */
function blob(g: CanvasRenderingContext2D, circles: [number, number, number][], fill: string, ink: string, lw: number): void {
  g.fillStyle = ink
  for (const [cx, cy, cr] of circles) {
    g.beginPath()
    g.arc(cx, cy, cr + lw, 0, Math.PI * 2)
    g.fill()
  }
  g.fillStyle = fill
  for (const [cx, cy, cr] of circles) {
    g.beginPath()
    g.arc(cx, cy, cr, 0, Math.PI * 2)
    g.fill()
  }
}

function broadleaf(palette: { crown: string; shade: string; light: string; ink: string }): Glyph {
  return (g, x, y, u, r) => {
    const cr = u * 0.36 * (0.8 + r(1) * 0.4)
    const cy = y - cr * 0.95
    const lw = Math.max(0.7, u * 0.045)
    g.strokeStyle = '#5a4128'
    g.lineWidth = Math.max(1, u * 0.07)
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x, cy + cr * 0.4)
    g.stroke()
    const lean = (r(2) - 0.5) * cr * 0.3
    blob(
      g,
      [
        [x + lean, cy - cr * 0.25, cr * 0.78],
        [x - cr * 0.45, cy + cr * 0.15, cr * 0.62],
        [x + cr * 0.45, cy + cr * 0.15, cr * 0.62],
      ],
      palette.crown,
      palette.ink,
      lw,
    )
    // Shade on the east side, light on the west.
    g.fillStyle = palette.shade
    g.beginPath()
    g.arc(x + cr * 0.5, cy + cr * 0.2, cr * 0.42, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = palette.light
    g.beginPath()
    g.arc(x - cr * 0.3 + lean, cy - cr * 0.45, cr * 0.28, 0, Math.PI * 2)
    g.fill()
  }
}

const conifer: Glyph = (g, x, y, u, r) => {
  const hh = u * 0.95 * (0.8 + r(1) * 0.45)
  const ww = hh * 0.42
  const lw = Math.max(0.7, u * 0.045)
  g.strokeStyle = '#4a3522'
  g.lineWidth = Math.max(1, u * 0.07)
  g.beginPath()
  g.moveTo(x, y)
  g.lineTo(x, y - hh * 0.2)
  g.stroke()
  const tier = (top: number, base: number, half: number) => {
    g.beginPath()
    g.moveTo(x, top)
    g.lineTo(x + half, base)
    g.quadraticCurveTo(x, base - half * 0.18, x - half, base)
    g.closePath()
  }
  const tiers: [number, number, number][] = [
    [y - hh * 0.55, y - hh * 0.12, ww * 0.5],
    [y - hh, y - hh * 0.45, ww * 0.38],
  ]
  for (const [top, base, half] of tiers) {
    tier(top, base, half)
    g.fillStyle = '#2f5a38'
    g.fill()
    // East half in shade.
    g.beginPath()
    g.moveTo(x, top)
    g.lineTo(x + half, base)
    g.quadraticCurveTo(x + half * 0.5, base - half * 0.12, x, base - half * 0.18)
    g.closePath()
    g.fillStyle = '#21432a'
    g.fill()
    tier(top, base, half)
    g.strokeStyle = '#18301e'
    g.lineWidth = lw
    g.stroke()
  }
}

/** A rounded mound, lit from the west. Also used for hill ranges. */
export const hill: Glyph = (g, x, y, u, r) => {
  const w = u * 0.95 * (0.8 + r(1) * 0.45)
  const hh = w * (0.32 + r(2) * 0.12)
  const outline = () => {
    g.moveTo(x - w / 2, y)
    g.bezierCurveTo(x - w * 0.32, y - hh * 1.3, x + w * 0.22, y - hh * 1.3, x + w / 2, y)
  }
  g.beginPath()
  outline()
  g.closePath()
  g.fillStyle = '#cdb47c'
  g.fill()
  g.beginPath()
  g.moveTo(x + w * 0.02, y - hh * 0.97)
  g.bezierCurveTo(x + w * 0.2, y - hh * 0.9, x + w * 0.4, y - hh * 0.5, x + w / 2, y)
  g.lineTo(x + w * 0.12, y)
  g.quadraticCurveTo(x + w * 0.12, y - hh * 0.5, x + w * 0.02, y - hh * 0.97)
  g.fillStyle = '#a88d59'
  g.fill()
  g.beginPath()
  outline()
  g.strokeStyle = '#6b5636'
  g.lineWidth = Math.max(0.8, u * 0.05)
  g.lineCap = 'round'
  g.stroke()
  // A few hatch strokes on the shaded flank.
  g.globalAlpha *= 0.5
  g.beginPath()
  for (let i = 0; i < 2; i++) {
    const t = 0.55 + i * 0.17
    g.moveTo(x + w * (t - 0.5) * 0.9, y - hh * (1 - t) * 1.1)
    g.lineTo(x + w * (t - 0.5) * 0.9 + w * 0.06, y - hh * (1 - t) * 0.4)
  }
  g.stroke()
  g.globalAlpha /= 0.5
}

/** One peak: sunlit west face, shaded east face, a crease, and a snowcap on the tall ones. */
export function drawPeak(g: CanvasRenderingContext2D, x: number, y: number, h: number, b: number, lean: number, snow: boolean, ink: string): void {
  const ax = x + lean * b
  const ay = y - h
  const silhouette = () => {
    g.moveTo(x - b, y)
    g.quadraticCurveTo(x - b * 0.42, y - h * 0.62, ax, ay)
    g.quadraticCurveTo(x + b * 0.48, y - h * 0.55, x + b, y)
  }
  const creaseX = x + b * 0.12
  g.beginPath()
  silhouette()
  g.closePath()
  g.fillStyle = '#e7d8b6'
  g.fill()
  // Shadow face, east of the crease.
  g.beginPath()
  g.moveTo(ax, ay)
  g.quadraticCurveTo(x + b * 0.48, y - h * 0.55, x + b, y)
  g.lineTo(creaseX, y)
  g.quadraticCurveTo(x + b * 0.02 + lean * b * 0.4, y - h * 0.5, ax, ay)
  g.fillStyle = '#a58b67'
  g.fill()
  if (snow) {
    const d = 0.3
    const lx = ax + (x - b - ax) * d
    const rx = ax + (x + b - ax) * d
    const sy = ay + h * d
    g.beginPath()
    g.moveTo(ax, ay)
    g.lineTo(rx, sy)
    g.lineTo(ax + (rx - ax) * 0.45, sy - h * 0.06)
    g.lineTo(ax + (creaseX - ax) * d, sy + h * 0.04)
    g.lineTo(ax + (lx - ax) * 0.5, sy - h * 0.07)
    g.lineTo(lx, sy)
    g.closePath()
    g.fillStyle = '#f8f9fb'
    g.fill()
    g.beginPath()
    g.moveTo(ax, ay)
    g.lineTo(rx, sy)
    g.lineTo(ax + (rx - ax) * 0.45, sy - h * 0.06)
    g.lineTo(ax + (creaseX - ax) * d, sy + h * 0.04)
    g.closePath()
    g.fillStyle = '#cdd6dd'
    g.fill()
  }
  g.beginPath()
  silhouette()
  g.strokeStyle = ink
  g.stroke()
  // Crease and a short ground stroke on the shaded side.
  g.globalAlpha *= 0.55
  g.beginPath()
  g.moveTo(ax, ay)
  g.quadraticCurveTo(x + b * 0.02 + lean * b * 0.4, y - h * 0.5, creaseX, y - h * 0.08)
  g.moveTo(x + b * 0.7, y)
  g.lineTo(x + b * 1.25, y)
  g.stroke()
  g.globalAlpha /= 0.55
}

/** Scattered peaks for mountain areas. */
const peaks: Glyph = (g, x, y, u, r) => {
  const h = u * (0.8 + r(1) * 0.6)
  g.lineJoin = 'round'
  g.lineCap = 'round'
  g.lineWidth = Math.max(0.8, Math.min(2, u / 14))
  drawPeak(g, x, y, h, h * (0.72 + r(2) * 0.3), (r(5) - 0.5) * 0.4, r(6) > 0.55, '#4a3b2a')
}

const grass: Glyph = (g, x, y, u, r) => {
  const l = u * 0.28 * (0.7 + r(1) * 0.6)
  g.strokeStyle = '#5f7f34'
  g.lineWidth = Math.max(0.8, u * 0.05)
  g.lineCap = 'round'
  g.beginPath()
  g.moveTo(x - l * 0.45, y - l * 0.75)
  g.lineTo(x - l * 0.1, y)
  g.moveTo(x, y - l)
  g.lineTo(x, y)
  g.moveTo(x + l * 0.45, y - l * 0.75)
  g.lineTo(x + l * 0.1, y)
  g.stroke()
}

const dune: Glyph = (g, x, y, u, r) => {
  const w = u * 0.8 * (0.7 + r(1) * 0.5)
  const hh = w * 0.22
  g.beginPath()
  g.moveTo(x - w / 2, y)
  g.quadraticCurveTo(x - w * 0.1, y - hh * 1.6, x + w * 0.08, y - hh)
  g.quadraticCurveTo(x + w * 0.3, y - hh * 0.5, x + w / 2, y)
  g.closePath()
  g.fillStyle = 'rgba(176, 134, 64, 0.35)'
  g.fill()
  g.beginPath()
  g.moveTo(x - w / 2, y)
  g.quadraticCurveTo(x - w * 0.1, y - hh * 1.6, x + w * 0.08, y - hh)
  g.strokeStyle = '#9c773c'
  g.lineWidth = Math.max(0.8, u * 0.05)
  g.lineCap = 'round'
  g.stroke()
}

const reeds: Glyph = (g, x, y, u, r) => {
  const l = u * 0.32 * (0.7 + r(1) * 0.6)
  g.strokeStyle = '#4f5f2e'
  g.lineWidth = Math.max(0.8, u * 0.05)
  g.lineCap = 'round'
  g.beginPath()
  g.moveTo(x - l * 0.3, y - l * 0.8)
  g.lineTo(x - l * 0.05, y)
  g.moveTo(x + l * 0.05, y - l)
  g.lineTo(x, y)
  g.moveTo(x + l * 0.35, y - l * 0.7)
  g.lineTo(x + l * 0.08, y)
  g.stroke()
  g.strokeStyle = '#6d97ab'
  g.beginPath()
  g.moveTo(x - l * 0.7, y + l * 0.25)
  g.lineTo(x - l * 0.15, y + l * 0.25)
  g.moveTo(x + l * 0.2, y + l * 0.25)
  g.lineTo(x + l * 0.55, y + l * 0.25)
  g.stroke()
}

const STYLES: Record<string, Style> = {
  forest: { spacing: 3.2, fill: 0.9, glyph: broadleaf({ crown: '#4f8a3c', shade: '#3b6c2e', light: '#6ea653', ink: '#22401c' }) },
  jungle: { spacing: 3.4, fill: 0.95, glyph: broadleaf({ crown: '#2f7449', shade: '#235a38', light: '#46905e', ink: '#143523' }) },
  pine: { spacing: 2.8, fill: 0.9, glyph: conifer },
  hills: { spacing: 6, fill: 0.75, glyph: hill },
  grassland: { spacing: 5, fill: 0.55, glyph: grass },
  desert: { spacing: 6.5, fill: 0.6, glyph: dune },
  swamp: { spacing: 4.5, fill: 0.7, glyph: reeds },
  peaks: { spacing: 5.5, fill: 0.85, glyph: peaks },
}

export type SymbolStyle = keyof typeof STYLES

export const hasSymbols = (f: Feature): boolean => f.layer === 'terrain' && f.geom === 'area' && f.type in STYLES

/** What to scatter, and where. */
export interface SymbolSpec {
  /** Seeds the jitter, so each area keeps its own pattern. */
  key: string
  style: string
  size?: number
  density?: number
  /** World-space box to cover. */
  minX: number
  minY: number
  maxX: number
  maxY: number
  inside(x: number, y: number): boolean
}

/** Symbols for one terrain area, inside its rings and the visible part of the view. */
export function paintArea(g: CanvasRenderingContext2D, f: Feature, p: Painter, viewW: number, viewH: number): void {
  if (!f.rings.length) return
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of f.rings[0]) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  paintSymbols(g, { key: f.id, style: f.type, size: f.size, density: f.density, minX, minY, maxX, maxY, inside: (x, y) => pointInRings(x, y, f.rings) }, p, viewW, viewH)
}

/** Scatter a style's symbols over the part of `spec` that is in view. */
export function paintSymbols(g: CanvasRenderingContext2D, spec: SymbolSpec, p: Painter, viewW: number, viewH: number): void {
  const style = STYLES[spec.style]
  if (!style) return
  const k = p.scale()
  const size = spec.size ?? 1
  const density = spec.density ?? 1
  // Symbol size follows Size only; density only changes how tightly they pack.
  // Zoomed out, both grow by powers of two together, so densities keep their ratio.
  let unit = style.spacing * size
  while (unit * k < 7) unit *= 2
  let step = unit / Math.sqrt(density)

  // Clip to the view, with a margin so symbols straddling the edge still draw.
  const a = p.toWorld(-40, -40)
  const b = p.toWorld(viewW + 40, viewH + 40)
  const minX = Math.max(spec.minX, Math.min(a.x, b.x))
  const maxX = Math.min(spec.maxX, Math.max(a.x, b.x))
  const minY = Math.max(spec.minY, Math.min(a.y, b.y))
  const maxY = Math.min(spec.maxY, Math.max(a.y, b.y))
  if (minX >= maxX || minY >= maxY) return
  while (((maxX - minX) / step) * ((maxY - minY) / step) > 6000) {
    step *= 2
    unit *= 2
  }

  const seed = hashString(spec.key)
  const u = unit * k
  const i0 = Math.floor(minX / step)
  const i1 = Math.ceil(maxX / step)
  const j0 = Math.floor(minY / step)
  const j1 = Math.ceil(maxY / step)
  g.save()
  // North rows first, so nearer (southern) symbols overlap the ones behind them.
  for (let j = j1; j >= j0; j--) {
    for (let i = i0; i <= i1; i++) {
      const r = (salt: number) => hash01(seed, i * 92821 + j, salt)
      if (r(0) > style.fill) continue
      const wx = (i + 0.1 + r(3) * 0.8) * step
      const wy = (j + 0.1 + r(4) * 0.8) * step
      if (!spec.inside(wx, wy)) continue
      const s = p.toScreen(wx, wy)
      style.glyph(g, s.x, s.y, u, r)
    }
  }
  g.restore()
}

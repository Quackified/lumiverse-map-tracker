import type { Bounds, DecorStamp } from '../shared/types'
import * as G from './glyphs'
import type { Painter } from './terrain'

// Decorations: stamps (a peak, a tree, a dune…) placed with brushes and stored
// in world coordinates. Each stamp keeps its own seed, so it is drawn the same
// way every frame. Most kinds draw one by one, back to front; forest kinds draw
// all their crowns together as one mass with a single outline.

type Rnd = () => number
type DrawFn = (g: CanvasRenderingContext2D, x: number, y: number, size: number, rnd: Rnd) => void

interface Kind {
  draw?: DrawFn
  /** Drawn together with every other stamp of the kind, as one canopy. */
  mass?: (g: CanvasRenderingContext2D, crowns: [number, number, number, number][]) => void
}

const GREY = { light: '#8f8f8f', dark: '#5b5b5b' }
const SNOW = { light: '#f3f6f8', dark: '#a9b9c8' }
const ASH = { light: '#7d7671', dark: '#4e4844' }
const TAN = { light: '#c7b27a', dark: '#97834f' }
const INK_GREEN = { mid: '#5e8a35', dark: '#456b27' }
const GRASS = { light: '#d8d681', mid: '#a6bf5e', dark: '#71933f', shade: '#3e5524' }
const JUNGLE = { light: '#b4cf82', mid: '#5f9346', dark: '#2f5a2c', ink: '#1f361e' }
const BROAD = { light: '#c2d78f', mid: '#71a04f', dark: '#3e6935', ink: '#243f20' }
const PINE = { mid: '#3f6e3a', dark: '#24452a', ink: '#15291a' }

const KINDS: Record<string, Kind> = {
  // Ink set: flat two-tone fills and bold outlines.
  'ink-peak': { draw: (g, x, y, s, r) => void G.inkPeak(g, x, y, s, r, GREY) },
  'ink-snowpeak': { draw: (g, x, y, s, r) => void G.inkPeak(g, x, y, s, r, SNOW) },
  'ink-volcpeak': {
    draw: (g, x, y, s, r) => {
      const top = G.inkPeak(g, x, y, s, r, ASH)
      if (r() < 0.3) G.lavaCap(g, top, s, r)
    },
  },
  'ink-forest': { mass: (g, crowns) => G.inkForest(g, crowns, Math.random, INK_GREEN) },
  'ink-tree': { draw: (g, x, y, s, r) => G.lollipop(g, x, y, s, r, INK_GREEN) },
  'ink-deadtree': { draw: (g, x, y, s, r) => G.deadTree(g, x, y, s, r) },
  'ink-hill': { draw: (g, x, y, s, r) => G.inkHill(g, x, y, s, r, TAN) },
  'ink-cliff': { draw: (g, x, y, s, r) => G.inkCliff(g, x, y, s, r) },
  'ink-shard': { draw: (g, x, y, s, r) => G.shard(g, x, y, s * 0.28, s * (0.7 + r() * 0.9), (r() - 0.5) * 1.1, r) },
  // Painterly set: soft washes and tapered ink.
  'pt-hill': { draw: (g, x, y, s, r) => G.hill(g, x, y, s, r, GRASS) },
  'pt-ridge': { draw: (g, x, y, s, r) => G.ridge(g, x, y, s, r, { dark: '#35502a' }) },
  'pt-canopy': { mass: (g, crowns) => G.canopyMass(g, crowns, JUNGLE, Math.random) },
  'pt-tree': { draw: (g, x, y, s, r) => G.tree(g, x, y, s, r, BROAD) },
  'pt-conifer': { draw: (g, x, y, s, r) => G.conifer(g, x, y, s, r, PINE) },
  'pt-dune': { draw: (g, x, y, s, r) => G.dune(g, x, y, s, r) },
  'pt-sandpeak': { draw: (g, x, y, s, r) => G.sandPeak(g, x, y, s, r) },
  'pt-snowpeak': { draw: (g, x, y, s, r) => G.snowPeak(g, x, y, s, r) },
  'pt-spires': { draw: (g, x, y, s, r) => G.iceSpires(g, x, y, s / 140, r) },
  'pt-volcano': { draw: (g, x, y, s, r) => G.cone(g, x, y, s, r, true) },
  'pt-cone': { draw: (g, x, y, s, r) => G.cone(g, x, y, s, r, false) },
  'pt-darkpeak': { draw: (g, x, y, s, r) => G.darkPeak(g, x, y, s, r) },
  'pt-fissure': { draw: (g, x, y, s, r) => G.fissure(g, x, y, s, r) },
}

export interface DecorBrush {
  id: string
  name: string
  set: 'Ink' | 'Painterly'
  /** Kinds this brush lays down, with their share. */
  kinds: [string, number][]
  /** Stamp size in canvas units (a hundredth of the canvas width). */
  size: number
  /** Distance between stamps, as a multiple of their size. */
  spacing: number
}

export const DECOR_BRUSHES: DecorBrush[] = [
  { id: 'ink-mountains', name: 'Mountains', set: 'Ink', kinds: [['ink-peak', 1]], size: 5.8, spacing: 0.55 },
  { id: 'ink-snow', name: 'Snowy mountains', set: 'Ink', kinds: [['ink-snowpeak', 1]], size: 5.8, spacing: 0.55 },
  { id: 'ink-volcanic', name: 'Volcanic mountains', set: 'Ink', kinds: [['ink-volcpeak', 1]], size: 5.8, spacing: 0.55 },
  { id: 'ink-forest', name: 'Forest', set: 'Ink', kinds: [['ink-forest', 1]], size: 1.1, spacing: 1 },
  { id: 'ink-trees', name: 'Lone trees', set: 'Ink', kinds: [['ink-tree', 0.88], ['ink-deadtree', 0.12]], size: 1.8, spacing: 1.5 },
  { id: 'ink-hills', name: 'Hills', set: 'Ink', kinds: [['ink-hill', 1]], size: 4, spacing: 0.8 },
  { id: 'ink-cliffs', name: 'Cliffs', set: 'Ink', kinds: [['ink-cliff', 1]], size: 14, spacing: 0.8 },
  { id: 'ink-shards', name: 'Glacier shards', set: 'Ink', kinds: [['ink-shard', 1]], size: 6, spacing: 0.4 },
  { id: 'pt-hills', name: 'Hills', set: 'Painterly', kinds: [['pt-hill', 1]], size: 7.2, spacing: 0.6 },
  { id: 'pt-ridges', name: 'Escarpments', set: 'Painterly', kinds: [['pt-ridge', 1]], size: 13, spacing: 0.6 },
  { id: 'pt-canopy', name: 'Rainforest canopy', set: 'Painterly', kinds: [['pt-canopy', 1]], size: 1.6, spacing: 0.85 },
  { id: 'pt-woodland', name: 'Woodland', set: 'Painterly', kinds: [['pt-tree', 1]], size: 3, spacing: 1 },
  { id: 'pt-conifers', name: 'Conifers', set: 'Painterly', kinds: [['pt-conifer', 1]], size: 3, spacing: 0.9 },
  { id: 'pt-dunes', name: 'Dunes', set: 'Painterly', kinds: [['pt-dune', 1]], size: 8, spacing: 0.8 },
  { id: 'pt-sandpeaks', name: 'Sandy peaks', set: 'Painterly', kinds: [['pt-sandpeak', 1]], size: 6.4, spacing: 0.65 },
  { id: 'pt-snowpeaks', name: 'Snowy peaks', set: 'Painterly', kinds: [['pt-snowpeak', 1]], size: 7, spacing: 0.6 },
  { id: 'pt-spires', name: 'Ice spires', set: 'Painterly', kinds: [['pt-spires', 1]], size: 14, spacing: 1.6 },
  { id: 'pt-volcano', name: 'Active volcano', set: 'Painterly', kinds: [['pt-volcano', 1]], size: 16, spacing: 2 },
  { id: 'pt-cones', name: 'Dormant cones', set: 'Painterly', kinds: [['pt-cone', 1]], size: 6, spacing: 1.2 },
  { id: 'pt-darkpeaks', name: 'Dark peaks', set: 'Painterly', kinds: [['pt-darkpeak', 1]], size: 6, spacing: 0.6 },
  { id: 'pt-fissures', name: 'Lava fissures', set: 'Painterly', kinds: [['pt-fissure', 1]], size: 10, spacing: 1.2 },
]

export const brushById = (id: string): DecorBrush => DECOR_BRUSHES.find((b) => b.id === id) ?? DECOR_BRUSHES[0]

/** World units per canvas unit: a hundredth of the canvas width. */
export function decorUnit(b: Bounds): number {
  return Math.max(1e-6, (b.maxX - b.minX) / 100)
}

export interface BrushOptions {
  /** Size multiplier (0.3 … 3). */
  size: number
  /** How much sizes differ (0 … 1). */
  variation: number
  /** Packing (0.2 … 3): more stamps closer together. */
  density: number
}

/** Stamps near a point, found through a coarse grid, for spacing new stamps. */
export class StampIndex {
  private cells = new Map<string, DecorStamp[]>()
  constructor(private cell: number) {}
  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`
  }
  add(s: DecorStamp): void {
    const k = this.key(s.x, s.y)
    const list = this.cells.get(k)
    if (list) list.push(s)
    else this.cells.set(k, [s])
  }
  near(x: number, y: number, r: number, kinds: Set<string>): boolean {
    const span = Math.ceil(r / this.cell)
    const cx = Math.floor(x / this.cell)
    const cy = Math.floor(y / this.cell)
    for (let i = -span; i <= span; i++)
      for (let j = -span; j <= span; j++)
        for (const s of this.cells.get(`${cx + i},${cy + j}`) ?? []) if (kinds.has(s.t) && Math.hypot(s.x - x, s.y - y) < r) return true
    return false
  }
}

/**
 * New stamps for one dab of the brush: random points in the circle, kept apart
 * by the brush spacing from stamps of the same brush (old or new). `single`
 * places one stamp exactly at the centre, for a click.
 */
export function brushDab(brush: DecorBrush, unit: number, opts: BrushOptions, cx: number, cy: number, radius: number, index: StampIndex, single = false, rnd: Rnd = Math.random): DecorStamp[] {
  const size = brush.size * unit * opts.size
  const gap = (brush.spacing * size) / Math.sqrt(opts.density)
  const kinds = new Set(brush.kinds.map(([k]) => k))
  const pick = (): string => {
    let t = rnd()
    for (const [k, w] of brush.kinds) if ((t -= w) <= 0) return k
    return brush.kinds[0][0]
  }
  const make = (x: number, y: number): DecorStamp => ({
    t: pick(),
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    s: Math.round(size * (1 + opts.variation * (rnd() * 2 - 1) * 0.7) * 100) / 100,
    r: Math.floor(rnd() * 2 ** 31),
  })
  const out: DecorStamp[] = []
  if (single) {
    if (!index.near(cx, cy, gap * 0.5, kinds)) {
      const st = make(cx, cy)
      index.add(st)
      out.push(st)
    }
    return out
  }
  const tries = Math.min(400, Math.ceil(((Math.PI * radius * radius) / (gap * gap)) * 0.6) + 1)
  for (let i = 0; i < tries; i++) {
    const a = rnd() * Math.PI * 2
    const d = Math.sqrt(rnd()) * radius
    const x = cx + Math.cos(a) * d
    const y = cy + Math.sin(a) * d
    if (index.near(x, y, gap, kinds)) continue
    const st = make(x, y)
    index.add(st)
    out.push(st)
  }
  return out
}

/** Stamps outside the eraser circle (or of other brushes, when `only` is given). */
export function eraseStamps(list: DecorStamp[], cx: number, cy: number, radius: number, only?: DecorBrush): DecorStamp[] {
  const kinds = only ? new Set(only.kinds.map(([k]) => k)) : null
  return list.filter((s) => (kinds && !kinds.has(s.t)) || Math.hypot(s.x - cx, s.y - cy) > radius)
}

export class DecorRenderer {
  draw(g: CanvasRenderingContext2D, stamps: DecorStamp[], p: Painter, viewW: number, viewH: number, opacity = 1): void {
    if (!stamps.length) return
    const k = p.scale()
    const tl = p.toWorld(0, 0)
    const br = p.toWorld(viewW, viewH)
    const minX = Math.min(tl.x, br.x)
    const maxX = Math.max(tl.x, br.x)
    const minY = Math.min(tl.y, br.y)
    const maxY = Math.max(tl.y, br.y)
    const masses = new Map<string, [number, number, number, number][]>()
    const items: { x: number; y: number; s: number; st: DecorStamp; kind: Kind }[] = []
    for (const st of stamps) {
      const kind = KINDS[st.t]
      if (!kind) continue
      const m = st.s * 1.5
      if (st.x < minX - m || st.x > maxX + m || st.y < minY - m || st.y > maxY + m) continue
      const px = st.s * k
      if (px < 2) continue
      const sp = p.toScreen(st.x, st.y)
      if (kind.mass) {
        const list = masses.get(st.t)
        const crown: [number, number, number, number] = [sp.x, sp.y, px, st.r]
        if (list) list.push(crown)
        else masses.set(st.t, [crown])
      } else items.push({ x: sp.x, y: sp.y, s: px, st, kind })
    }
    g.save()
    g.globalAlpha *= opacity
    // Canopies sit on the ground; everything else stands on top, back to front.
    for (const [t, crowns] of masses) KINDS[t].mass!(g, crowns)
    items.sort((a, b) => a.y - b.y)
    for (const it of items) it.kind.draw!(g, it.x, it.y, it.s, G.mulberry(it.st.r))
    g.restore()
  }
}

/** A small picture of what a brush lays down, for the brush list. */
const previews = new Map<string, string>()
export function brushPreview(brush: DecorBrush): string {
  const cached = previews.get(brush.id)
  if (cached) return cached
  const c = document.createElement('canvas')
  c.width = 96
  c.height = 64
  const g = c.getContext('2d')
  if (!g) return ''
  const rnd = G.mulberry(brush.id.length * 7919)
  const kind = KINDS[brush.kinds[0][0]]
  if (kind.mass) {
    const crowns: [number, number, number, number][] = []
    for (let i = 0; i < 40; i++) crowns.push([18 + rnd() * 60, 18 + rnd() * 32, 9, Math.floor(rnd() * 1e9)])
    kind.mass(g, crowns)
  } else {
    const big = brush.size > 9
    const spots: [number, number, number][] = big ? [[48, 54, 70]] : [[30, 44, 34], [62, 50, 38], [46, 58, 30]]
    for (const [x, y, s] of spots) {
      const k = KINDS[brush.kinds[Math.floor(rnd() * brush.kinds.length)][0]]
      k.draw?.(g, x, y, brush.id.includes('trees') || brush.id.includes('woodland') || brush.id.includes('conifer') ? s * 0.55 : s, G.mulberry(Math.floor(rnd() * 1e9)))
    }
  }
  const url = c.toDataURL()
  previews.set(brush.id, url)
  return url
}

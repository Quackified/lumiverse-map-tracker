import { EMPTY, LAKE, OCEAN, biomeColor, biomesOf, decodeBytes, dropSmallRegions, findCell, graphFor, isWater, regionRings, smoothCells, type Graph } from '../shared/cells'
import { worldToImage } from '../shared/geo'
import type { LandGrid, MapImageMeta } from '../shared/types'
import { paintSymbols, type Painter } from './terrain'

// Draws the land grid: ocean, a soft shallow-water halo, biomes with smoothed
// borders clipped to a smoothed coastline, lakes, and terrain symbols inside
// matching biomes. Outlines are built once per change, in world coordinates,
// and drawn through a transform, so panning and zooming only re-stroke paths.

/** Which terrain symbols a biome gets, and how densely. */
const BIOME_SYMBOLS: Record<number, { style: string; density?: number; size?: number }> = {
  1: { style: 'desert', density: 0.8 },
  2: { style: 'desert', density: 0.45 },
  3: { style: 'grassland', density: 0.7 },
  4: { style: 'grassland', density: 0.35 },
  5: { style: 'forest', density: 0.55 },
  6: { style: 'forest' },
  7: { style: 'jungle', density: 1.4 },
  8: { style: 'forest', density: 1.4 },
  9: { style: 'pine', density: 1.2 },
  12: { style: 'swamp' },
  14: { style: 'peaks', density: 1.2 },
  15: { style: 'hills' },
}

interface Built {
  key: string
  graph: Graph
  biomes: Uint8Array
  coast: Path2D
  ocean: Path2D | null
  lakes: Path2D | null
  regions: { biome: number; path: Path2D; minX: number; minY: number; maxX: number; maxY: number }[]
  /** World units across one cell. */
  cell: number
}

/** Smoothed closed path through a ring's edge midpoints, in world coordinates. */
function addRing(path: Path2D, ring: Float64Array): void {
  const n = ring.length / 2
  if (n < 3) return
  const mx = (i: number) => (ring[2 * (i % n)] + ring[2 * ((i + 1) % n)]) / 2
  const my = (i: number) => (ring[2 * (i % n) + 1] + ring[2 * ((i + 1) % n) + 1]) / 2
  path.moveTo(mx(n - 1), my(n - 1))
  for (let i = 0; i < n; i++) path.quadraticCurveTo(ring[2 * i], ring[2 * i + 1], mx(i), my(i))
  path.closePath()
}

export class LandRenderer {
  private built: Built | null = null

  private build(grid: LandGrid): Built {
    const key = `${grid.bounds.minX},${grid.bounds.maxX},${grid.bounds.minY},${grid.bounds.maxY}|${grid.cells}|${grid.seed}|${grid.biome.length}:${grid.biome}`
    if (this.built?.key === key) return this.built
    const graph = graphFor(grid)
    const biomes = biomesOf(grid, graph)
    const isLand = (c: number) => biomes[c] !== EMPTY && !isWater(biomes[c])
    const coast = new Path2D()
    for (const r of regionRings(graph, (c) => (isLand(c) ? 1 : null)).get(1) ?? []) addRing(coast, r)
    let ocean: Path2D | null = null
    const oceanRings = regionRings(graph, (c) => (biomes[c] === OCEAN ? 1 : null)).get(1)
    if (oceanRings?.length) {
      ocean = new Path2D()
      for (const r of oceanRings) addRing(ocean, r)
    }
    let lakes: Path2D | null = null
    const lakeRings = regionRings(graph, (c) => (biomes[c] === LAKE ? 1 : null)).get(1)
    if (lakeRings?.length) {
      lakes = new Path2D()
      for (const r of lakeRings) addRing(lakes, r)
    }
    const regions: Built['regions'] = []
    for (const [biome, rings] of regionRings(graph, (c) => (isLand(c) ? biomes[c] : null))) {
      const path = new Path2D()
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const r of rings) {
        addRing(path, r)
        for (let i = 0; i < r.length; i += 2) {
          if (r[i] < minX) minX = r[i]
          if (r[i] > maxX) maxX = r[i]
          if (r[i + 1] < minY) minY = r[i + 1]
          if (r[i + 1] > maxY) maxY = r[i + 1]
        }
      }
      regions.push({ biome, path, minX, minY, maxX, maxY })
    }
    this.built = { key, graph, biomes, coast, ocean, lakes, regions, cell: Math.max(graph.dx, graph.dy) }
    return this.built
  }

  /** The biome under a world point, or null outside the grid. */
  biomeAt(grid: LandGrid, x: number, y: number): number | null {
    const b = grid.bounds
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) return null
    const built = this.build(grid)
    const v = built.biomes[findCell(built.graph, x, y)]
    return v === EMPTY ? null : v
  }

  draw(g: CanvasRenderingContext2D, grid: LandGrid, p: Painter, viewW: number, viewH: number, opacity = 1): void {
    const built = this.build(grid)
    const s = p.scale()
    const o = p.toScreen(0, 0)
    g.save()
    g.globalAlpha *= opacity
    g.save()
    g.translate(o.x, o.y)
    g.scale(s, -s)
    g.lineJoin = 'round'
    // Only painted cells are drawn: unpainted ones leave the picture showing.
    if (built.ocean) {
      const sea = biomeColor(OCEAN, grid)
      g.fillStyle = sea
      g.strokeStyle = sea
      g.lineWidth = built.cell * 0.9
      g.fill(built.ocean, 'evenodd')
      g.stroke(built.ocean)
      // Shallow water: soft bands just off the coast.
      g.save()
      g.clip(built.ocean, 'evenodd')
      g.strokeStyle = 'rgba(255,255,255,0.10)'
      g.lineWidth = 14 / s
      g.stroke(built.coast)
      g.lineWidth = 6 / s
      g.stroke(built.coast)
      g.restore()
    }
    // Biomes, each stroked in its own colour too so smoothed neighbours leave no seams.
    g.save()
    g.clip(built.coast, 'evenodd')
    g.lineWidth = built.cell * 0.9
    for (const r of built.regions) {
      const col = biomeColor(r.biome, grid)
      g.fillStyle = col
      g.strokeStyle = col
      g.fill(r.path, 'evenodd')
      g.stroke(r.path)
    }
    g.restore()
    if (built.lakes) {
      g.fillStyle = biomeColor(LAKE, grid)
      g.fill(built.lakes, 'evenodd')
    }
    g.strokeStyle = 'rgba(40, 52, 60, 0.85)'
    g.lineWidth = 1.3 / s
    g.stroke(built.coast)
    if (built.lakes) g.stroke(built.lakes)
    g.restore()

    if (grid.symbols !== false) {
      for (const r of built.regions) {
        const sym = BIOME_SYMBOLS[r.biome]
        if (!sym) continue
        paintSymbols(
          g,
          {
            key: `land-${r.biome}`,
            style: sym.style,
            density: sym.density,
            size: sym.size,
            minX: r.minX,
            minY: r.minY,
            maxX: r.maxX,
            maxY: r.maxY,
            // Keep symbols a little inside the region, off the coast and biome edges.
            inside: (x, y) => built.biomes[findCell(built.graph, x, y)] === r.biome,
          },
          p,
          viewW,
          viewH,
        )
      }
    }
    g.restore()
  }
}

// ── Seeding from the map image ──────────────────────────────────────────────

export interface Sampler {
  canvas: HTMLCanvasElement
  data: Uint8ClampedArray
  /** Image pixels per sampler pixel. */
  factor: number
}

/** The picture downscaled to at most 2048 px wide, for reading colours. */
export function makeSampler(img: HTMLImageElement): Sampler | null {
  const factor = Math.max(1, img.naturalWidth / 2048)
  const w = Math.max(1, Math.round(img.naturalWidth / factor))
  const h = Math.max(1, Math.round(img.naturalHeight / factor))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  try {
    return { canvas, data: ctx.getImageData(0, 0, w, h).data, factor }
  } catch {
    return null
  }
}

/** Average colour around an image pixel, or null outside the picture. */
export function colorAt(s: Sampler, px: number, py: number, radius = 1): [number, number, number] | null {
  const cx = Math.round(px / s.factor)
  const cy = Math.round(py / s.factor)
  const w = s.canvas.width
  const h = s.canvas.height
  if (cx < 0 || cy < 0 || cx >= w || cy >= h) return null
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = Math.max(0, cy - radius); y <= Math.min(h - 1, cy + radius); y++)
    for (let x = Math.max(0, cx - radius); x <= Math.min(w - 1, cx + radius); x++) {
      const i = (y * w + x) * 4
      r += s.data[i]
      g += s.data[i + 1]
      b += s.data[i + 2]
      n++
    }
  return [r / n, g / n, b / n]
}

/** Perceptual-ish colour distance ("redmean"), 0 … ~765. */
function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  const rm = (a[0] + b[0]) / 2
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db)
}

export interface SeedOptions {
  /** Colours farther than this from every sample are left to their neighbours. */
  tolerance: number
  smooth: number
  /** Islands and lakes smaller than this many cells are merged away. */
  minRegion: number
}

/**
 * Classify every cell by the nearest sample colour under it. Cells off the
 * picture keep their value; cells too far from every sample are filled from
 * their neighbours, then the result is smoothed and specks are removed.
 */
export function seedFromImage(grid: LandGrid, meta: MapImageMeta, sampler: Sampler, opts: SeedOptions): Uint8Array {
  const samples = grid.samples ?? []
  const graph = graphFor(grid)
  const out = new Uint8Array(decodeBytes(grid.biome, graph.n))
  if (!samples.length) return out
  const UNKNOWN = 254
  const crop = meta.crop
  const step = Math.max(graph.dx, graph.dy) * 0.22
  for (let i = 0; i < graph.n; i++) {
    const x = graph.points[2 * i]
    const y = graph.points[2 * i + 1]
    const c = worldToImage(meta.calib, x, y)
    if (c.px < crop.x || c.py < crop.y || c.px > crop.x + crop.w || c.py > crop.y + crop.h) continue
    // Five probes across the cell, so one stray pixel (a letter, a ship) counts for less.
    let best = UNKNOWN
    const votes = new Map<number, number>()
    for (const [ox, oy] of [
      [0, 0],
      [step, 0],
      [-step, 0],
      [0, step],
      [0, -step],
    ]) {
      const q = worldToImage(meta.calib, x + ox, y + oy)
      const col = colorAt(sampler, q.px, q.py)
      if (!col) continue
      let nearest = -1
      let nd = Infinity
      for (const smp of samples) {
        const d = colorDistance(col, smp.rgb)
        if (d < nd) {
          nd = d
          nearest = smp.biome
        }
      }
      if (nearest >= 0 && nd <= opts.tolerance) votes.set(nearest, (votes.get(nearest) ?? 0) + 1)
    }
    let bestN = 0
    for (const [k, n] of votes)
      if (n > bestN) {
        best = k
        bestN = n
      }
    out[i] = best
  }
  // Unknown cells take the most common known value around them, growing inward.
  for (let pass = 0; pass < 40; pass++) {
    let left = 0
    const next = new Uint8Array(out)
    for (let i = 0; i < graph.n; i++) {
      if (out[i] !== UNKNOWN) continue
      const counts = new Map<number, number>()
      for (const q of graph.c[i]) if (out[q] !== UNKNOWN) counts.set(out[q], (counts.get(out[q]) ?? 0) + 1)
      let best = -1
      let bestN = 0
      for (const [k, n] of counts)
        if (n > bestN) {
          best = k
          bestN = n
        }
      if (best >= 0) next[i] = best
      else left++
    }
    out.set(next)
    if (!left) break
  }
  for (let i = 0; i < graph.n; i++) if (out[i] === UNKNOWN) out[i] = OCEAN
  let result: Uint8Array = smoothCells(graph, out, opts.smooth)
  if (opts.minRegion > 1) result = dropSmallRegions(graph, result, opts.minRegion)
  return result
}

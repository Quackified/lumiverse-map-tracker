import Delaunator from 'delaunator'
import type { Bounds, FineArea, LandGrid } from './types'

// The land grid: the world as a few thousand irregular cells (a jittered lattice
// and its Voronoi diagram), each holding a biome. Only the biome bytes are
// stored; the geometry is rebuilt from the bounds, cell count and seed.
//
// Adapted from Azgaar's Fantasy Map Generator (MIT, © 2017-2024 Max Haniyeu):
// src/model/graph/voronoi.ts, src/model/graph/lattice.ts, connectVertices and
// getIsolines in src/utils/path-utils.ts, and the default biomes in
// src/model/physical/biomes-generator.ts.

export interface Biome {
  id: number
  name: string
  color: string
  water?: boolean
}

export const OCEAN = 0
export const LAKE = 13
export const DEFAULT_LAND = 4
/** Not painted yet: see-through, so the picture and shapes show until you paint. */
export const EMPTY = 255
/** Cells in a new terrain grid. */
export const DEFAULT_CELLS = 20000

/** Fantasy Map Generator's default biomes, plus lake, mountains and hills. */
export const BIOMES: Biome[] = [
  { id: 0, name: 'Ocean', color: '#466eab', water: true },
  { id: 1, name: 'Hot desert', color: '#fbe79f' },
  { id: 2, name: 'Cold desert', color: '#b5b887' },
  { id: 3, name: 'Savanna', color: '#d2d082' },
  { id: 4, name: 'Grassland', color: '#c8d68f' },
  { id: 5, name: 'Tropical seasonal forest', color: '#b6d95d' },
  { id: 6, name: 'Temperate deciduous forest', color: '#29bc56' },
  { id: 7, name: 'Tropical rainforest', color: '#7dcb35' },
  { id: 8, name: 'Temperate rainforest', color: '#409c43' },
  { id: 9, name: 'Taiga', color: '#4b6b32' },
  { id: 10, name: 'Tundra', color: '#96784b' },
  { id: 11, name: 'Glacier', color: '#d5e7eb' },
  { id: 12, name: 'Wetland', color: '#0b9131' },
  { id: 13, name: 'Lake', color: '#5f8ec4', water: true },
  // Not FMG biomes (it derives relief from height): painted terrain for peaks and hills.
  { id: 14, name: 'Mountains', color: '#a99c86' },
  { id: 15, name: 'Hills', color: '#bfb27e' },
  { id: 16, name: 'Volcanic', color: '#5b4741' },
  { id: 17, name: 'Ash waste', color: '#9a8f86' },
]

export const isWater = (b: number): boolean => b === OCEAN || b === LAKE

export const isPainted = (b: number): boolean => b !== EMPTY

export function biomeName(id: number, grid?: LandGrid | null): string {
  if (id === EMPTY) return 'Unpainted'
  return grid?.names?.[id] ?? BIOMES[id]?.name ?? `Biome ${id}`
}

export function biomeColor(id: number, grid?: LandGrid | null): string {
  if (id === EMPTY) return 'transparent'
  return grid?.colors?.[id] ?? BIOMES[id]?.color ?? '#888888'
}

/** Detail presets: approximate cell counts. */
export const DETAIL: [number, string][] = [
  [4000, 'Coarse'],
  [10000, 'Normal'],
  [20000, 'Fine'],
  [40000, 'Very fine'],
  [80000, 'Ultra'],
]

/** Most cells a grid may have (drawing and seeding slow down past this). */
export const MAX_CELLS = 80000

// ── Geometry ────────────────────────────────────────────────────────────────

export interface Graph {
  /** Real cells; points beyond this index are boundary pseudo-points. */
  n: number
  /** Cell centres, x/y interleaved. */
  points: Float64Array
  bounds: Bounds
  cellsX: number
  cellsY: number
  dx: number
  dy: number
  /** Neighbouring real cells of each cell. */
  c: number[][]
  /** Voronoi vertices (triangle ids) around each cell. */
  v: number[][]
  /** Vertex coordinates, x/y interleaved. */
  vp: Float64Array
  /** Neighbouring vertices of each vertex (3 per vertex, -1 at the hull). */
  vv: Int32Array
  /** The 3 points (cells or boundary points) around each vertex. */
  vc: Int32Array
  /** A real cell in each lattice slot, where a cell lookup starts. */
  slot: Int32Array
  /** Smallest cell spacing: a third of the lattice where there are fine areas. */
  fine: number
}

/** How much finer cells are inside fine areas (per side: 3 → nine times as many). */
export const FINE_FACTOR = 3

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const graphCache = new Map<string, Graph>()

/** The grid's geometry, cached by bounds, count, seed and fine areas. */
export function graphFor(grid: Pick<LandGrid, 'bounds' | 'cells' | 'seed' | 'fine'>): Graph {
  const b = grid.bounds
  const key = `${b.minX},${b.maxX},${b.minY},${b.maxY}|${grid.cells}|${grid.seed}|${(grid.fine ?? []).map((f) => `${f.x},${f.y},${f.r}`).join(';')}`
  let g = graphCache.get(key)
  if (!g) {
    g = buildGraph(b, grid.cells, grid.seed, grid.fine)
    if (graphCache.size > 4) graphCache.clear()
    graphCache.set(key, g)
  }
  return g
}

export function buildGraph(bounds: Bounds, desired: number, seed: number, fine: FineArea[] = []): Graph {
  const w = bounds.maxX - bounds.minX
  const h = bounds.maxY - bounds.minY
  const spacing = Math.sqrt((w * h) / Math.max(16, desired))
  const cellsX = Math.max(2, Math.round(w / spacing))
  const cellsY = Math.max(2, Math.round(h / spacing))
  const dx = w / cellsX
  const dy = h / cellsY
  const rand = mulberry32(seed)
  // 0.9 of half a slot, as in FMG's classic grid: neighbours never coincide.
  const jx = 0.45 * dx
  const jy = 0.45 * dy
  const inFine = (x: number, y: number) => fine.some((f) => (x - f.x) ** 2 + (y - f.y) ** 2 <= f.r * f.r)
  const slot = new Int32Array(cellsX * cellsY).fill(-1)
  const pts: number[] = []
  for (let row = 0; row < cellsY; row++) {
    for (let col = 0; col < cellsX; col++) {
      // Draw the jitter even for skipped slots, so the rest of the grid stays put.
      const x = bounds.minX + (col + 0.5) * dx + (rand() * 2 - 1) * jx
      const y = bounds.minY + (row + 0.5) * dy + (rand() * 2 - 1) * jy
      if (fine.length && inFine(x, y)) continue
      slot[row * cellsX + col] = pts.length / 2
      pts.push(x, y)
    }
  }
  // Fine areas: a global lattice three times finer, jittered from a hash, so
  // overlapping areas share their points and each point is stable.
  if (fine.length) {
    const fx = dx / FINE_FACTOR
    const fy = dy / FINE_FACTOR
    const hash = (a: number, b: number, k: number) => {
      let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(seed ^ k, 982451653)
      h = Math.imul(h ^ (h >>> 13), 1274126177)
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296
    }
    const seen = new Set<number>()
    for (const f of fine) {
      const c0 = Math.max(0, Math.floor((f.x - f.r - bounds.minX) / fx))
      const c1 = Math.min(cellsX * FINE_FACTOR - 1, Math.ceil((f.x + f.r - bounds.minX) / fx))
      const r0 = Math.max(0, Math.floor((f.y - f.r - bounds.minY) / fy))
      const r1 = Math.min(cellsY * FINE_FACTOR - 1, Math.ceil((f.y + f.r - bounds.minY) / fy))
      for (let row = r0; row <= r1; row++)
        for (let col = c0; col <= c1; col++) {
          const key = row * cellsX * FINE_FACTOR + col
          if (seen.has(key)) continue
          const x = bounds.minX + (col + 0.5) * fx + (hash(col, row, 1) * 2 - 1) * 0.45 * fx
          const y = bounds.minY + (row + 0.5) * fy + (hash(col, row, 2) * 2 - 1) * 0.45 * fy
          if (!inFine(x, y)) continue
          seen.add(key)
          const s = Math.min(cellsY - 1, Math.floor(row / FINE_FACTOR)) * cellsX + Math.min(cellsX - 1, Math.floor(col / FINE_FACTOR))
          if (slot[s] < 0) slot[s] = pts.length / 2
          pts.push(x, y)
        }
    }
  }
  const n = pts.length / 2
  // A slot whose point was skipped and got no fine point starts lookups at a neighbour's.
  for (let i = 0; i < slot.length; i++) if (slot[i] < 0) slot[i] = slot[Math.max(0, i - 1)] >= 0 ? slot[Math.max(0, i - 1)] : 0
  // Pseudo-points one slot outside the edge clip the outer cells; they get no cells of their own.
  for (let col = -1; col <= cellsX; col++) {
    const x = bounds.minX + (col + 0.5) * dx
    pts.push(x, bounds.minY - 0.5 * dy, x, bounds.maxY + 0.5 * dy)
  }
  for (let row = 0; row < cellsY; row++) {
    const y = bounds.minY + (row + 0.5) * dy
    pts.push(bounds.minX - 0.5 * dx, y, bounds.maxX + 0.5 * dx, y)
  }
  const coords = Float64Array.from(pts)
  const del = new Delaunator(coords)
  const { triangles, halfedges } = del
  const next = (e: number) => (e % 3 === 2 ? e - 2 : e + 1)
  const tri = (e: number) => Math.floor(e / 3)
  const c: number[][] = new Array(n)
  const v: number[][] = new Array(n)
  const nt = triangles.length / 3
  const vp = new Float64Array(nt * 2)
  const vv = new Int32Array(nt * 3)
  const vc = new Int32Array(nt * 3)
  const seenT = new Uint8Array(nt)

  for (let e = 0; e < triangles.length; e++) {
    const p = triangles[next(e)]
    if (p < n && !c[p]) {
      const edges: number[] = []
      let incoming = e
      do {
        edges.push(incoming)
        incoming = halfedges[next(incoming)]
      } while (incoming !== -1 && incoming !== e && edges.length < 20)
      v[p] = edges.map(tri)
      c[p] = edges.map((q) => triangles[q]).filter((q) => q < n)
    }
    const t = tri(e)
    if (!seenT[t]) {
      seenT[t] = 1
      const a = triangles[3 * t]
      const b = triangles[3 * t + 1]
      const cc = triangles[3 * t + 2]
      vc[3 * t] = a
      vc[3 * t + 1] = b
      vc[3 * t + 2] = cc
      for (let k = 0; k < 3; k++) {
        const o = halfedges[3 * t + k]
        vv[3 * t + k] = o === -1 ? -1 : tri(o)
      }
      const [ax, ay, bx, by, cx, cy] = [coords[2 * a], coords[2 * a + 1], coords[2 * b], coords[2 * b + 1], coords[2 * cc], coords[2 * cc + 1]]
      const ad = ax * ax + ay * ay
      const bd = bx * bx + by * by
      const cd = cx * cx + cy * cy
      const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
      vp[2 * t] = (ad * (by - cy) + bd * (cy - ay) + cd * (ay - by)) / D
      vp[2 * t + 1] = (ad * (cx - bx) + bd * (ax - cx) + cd * (bx - ax)) / D
    }
  }
  for (let i = 0; i < n; i++) {
    c[i] ??= []
    v[i] ??= []
  }
  return { n, points: coords.slice(0, 2 * n), bounds, cellsX, cellsY, dx, dy, c, v, vp, vv, vc, slot, fine: fine.length ? Math.max(dx, dy) / FINE_FACTOR : Math.max(dx, dy) }
}

/** The cell containing (x, y): the lattice slot, then the closest neighbour until none is closer. */
export function findCell(g: Graph, x: number, y: number): number {
  const col = Math.max(0, Math.min(g.cellsX - 1, Math.floor((x - g.bounds.minX) / g.dx)))
  const row = Math.max(0, Math.min(g.cellsY - 1, Math.floor((y - g.bounds.minY) / g.dy)))
  let cell = g.slot[row * g.cellsX + col]
  const d2 = (i: number) => (g.points[2 * i] - x) ** 2 + (g.points[2 * i + 1] - y) ** 2
  let best = d2(cell)
  for (let moved = true; moved; ) {
    moved = false
    for (const q of g.c[cell]) {
      const d = d2(q)
      if (d < best) {
        best = d
        cell = q
        moved = true
      }
    }
  }
  return cell
}

/** Cells whose centre lies within `r` of (x, y), plus the one under the point. */
export function cellsWithin(g: Graph, x: number, y: number, r: number): number[] {
  const start = findCell(g, x, y)
  const out = [start]
  const seen = new Set([start])
  const r2 = r * r
  for (let i = 0; i < out.length; i++) {
    for (const q of g.c[out[i]]) {
      if (seen.has(q)) continue
      seen.add(q)
      if ((g.points[2 * q] - x) ** 2 + (g.points[2 * q + 1] - y) ** 2 <= r2) out.push(q)
    }
  }
  return out
}

/** The connected run of cells around `start` that share its value. */
export function floodCells(g: Graph, values: Uint8Array, start: number, same: (a: number, b: number) => boolean = (a, b) => a === b): number[] {
  const target = values[start]
  const out = [start]
  const seen = new Uint8Array(g.n)
  seen[start] = 1
  for (let i = 0; i < out.length; i++) {
    for (const q of g.c[out[i]]) {
      if (seen[q] || !same(values[q], target)) continue
      seen[q] = 1
      out.push(q)
    }
  }
  return out
}

// ── Outlines ────────────────────────────────────────────────────────────────

/**
 * Closed outlines of every region of cells sharing a type, as vertex-coordinate
 * rings (x/y interleaved). Regions with holes give the holes as extra rings, so
 * an even-odd fill draws them right. Cells typed null are background.
 */
export function regionRings(g: Graph, typeOf: (cell: number) => number | null): Map<number, Float64Array[]> {
  const out = new Map<number, Float64Array[]>()
  const checked = new Uint8Array(g.n)
  const type = (q: number) => (q < g.n ? typeOf(q) : null)
  for (let cell = 0; cell < g.n; cell++) {
    if (checked[cell]) continue
    const t = type(cell)
    if (t === null) continue
    checked[cell] = 1
    const differs = (q: number) => type(q) !== t
    if (!g.c[cell].some(differs) && g.c[cell].length === g.v[cell].length) continue
    const startV = g.v[cell].find((vt) => differs(g.vc[3 * vt]) || differs(g.vc[3 * vt + 1]) || differs(g.vc[3 * vt + 2]))
    if (startV === undefined) continue
    const chain = connectVertices(g, startV, (q) => type(q) === t, (q) => q < g.n && (checked[q] = 1))
    if (chain.length < 3) continue
    const ring = new Float64Array(chain.length * 2)
    chain.forEach((vt, i) => {
      ring[2 * i] = g.vp[2 * vt]
      ring[2 * i + 1] = g.vp[2 * vt + 1]
    })
    if (!out.has(t)) out.set(t, [])
    out.get(t)!.push(ring)
  }
  return out
}

/** Walk the vertices along a region's border (FMG's connectVertices). */
function connectVertices(g: Graph, start: number, same: (cell: number) => boolean, mark: (cell: number) => unknown): number[] {
  const max = g.vp.length / 2
  const chain: number[] = []
  let next = start
  for (let i = 0; i === 0 || next !== start; i++) {
    const previous = chain[chain.length - 1]
    const current = next
    chain.push(current)
    const a = g.vc[3 * current]
    const b = g.vc[3 * current + 1]
    const c = g.vc[3 * current + 2]
    for (const q of [a, b, c]) if (same(q)) mark(q)
    const c1 = same(a)
    const c2 = same(b)
    const c3 = same(c)
    const v1 = g.vv[3 * current]
    const v2 = g.vv[3 * current + 1]
    const v3 = g.vv[3 * current + 2]
    // Delaunator orders a triangle's half-edges a→b, b→c, c→a; edge k borders points k and k+1.
    if (v1 !== previous && c1 !== c2) next = v1
    else if (v2 !== previous && c2 !== c3) next = v2
    else if (v3 !== previous && c1 !== c3) next = v3
    if (next < 0 || next >= max || next === current || i > max) break
  }
  return chain
}

// ── Storage ─────────────────────────────────────────────────────────────────

export function encodeBytes(a: Uint8Array): string {
  let s = ''
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000))
  return btoa(s)
}

export function decodeBytes(s: string, n: number): Uint8Array {
  const out = new Uint8Array(n)
  try {
    const bin = atob(s)
    for (let i = 0; i < Math.min(n, bin.length); i++) out[i] = bin.charCodeAt(i)
  } catch {
    // Unreadable data: an empty (all ocean) grid.
  }
  return out
}

const decodeCache = new Map<string, Uint8Array>()

/** Biome per cell, decoded once per stored string. Treat as read-only; copy before editing. */
export function biomesOf(grid: LandGrid, g: Graph): Uint8Array {
  let a = decodeCache.get(grid.biome)
  if (!a || a.length !== g.n) {
    a = decodeBytes(grid.biome, g.n)
    if (decodeCache.size > 6) decodeCache.clear()
    decodeCache.set(grid.biome, a)
  }
  return a
}

/**
 * The grid with different fine areas: rebuilt, each new cell taking the biome
 * under it in the old grid, so the painting stays where it was.
 */
export function refineGrid(old: LandGrid, fine: FineArea[]): LandGrid {
  const g0 = graphFor(old)
  const b0 = biomesOf(old, g0)
  const next: LandGrid = { ...old, fine: fine.length ? fine : undefined }
  const g1 = graphFor(next)
  const out = new Uint8Array(g1.n)
  for (let i = 0; i < g1.n; i++) out[i] = b0[findCell(g0, g1.points[2 * i], g1.points[2 * i + 1])]
  return { ...next, biome: encodeBytes(out) }
}

/** Cells a fine area would add, roughly: its area at nine times the lattice density, less what it replaces. */
export function fineCellCount(grid: Pick<LandGrid, 'bounds' | 'cells'>, fine: FineArea[]): number {
  const area = (grid.bounds.maxX - grid.bounds.minX) * (grid.bounds.maxY - grid.bounds.minY)
  const per = grid.cells / Math.max(1e-9, area)
  // Overlaps counted once, approximately, by sampling the union on a coarse grid.
  let covered = 0
  if (fine.length) {
    const step = Math.sqrt(area) / 200
    for (let x = grid.bounds.minX; x < grid.bounds.maxX; x += step)
      for (let y = grid.bounds.minY; y < grid.bounds.maxY; y += step) if (fine.some((f) => (x - f.x) ** 2 + (y - f.y) ** 2 <= f.r * f.r)) covered += step * step
  }
  return Math.round(covered * per * (FINE_FACTOR * FINE_FACTOR - 1))
}

/** A new grid over `bounds`, every cell `fill` (unpainted unless told otherwise). */
export function newGrid(bounds: Bounds, cells: number, seed = Math.floor(Math.random() * 2 ** 31), fill = EMPTY): LandGrid {
  const g = buildGraph(bounds, cells, seed)
  return { v: 1, bounds, cells, seed, biome: encodeBytes(new Uint8Array(g.n).fill(fill)) }
}

/** Cells whose centre lies inside the rings (even-odd, so holes stay out). */
export function cellsInRings(g: Graph, rings: [number, number][][]): number[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rings)
    for (const [x, y] of r) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  const out: number[] = []
  for (let i = 0; i < g.n; i++) {
    const x = g.points[2 * i]
    const y = g.points[2 * i + 1]
    if (x < minX || x > maxX || y < minY || y > maxY) continue
    let inside = false
    for (const r of rings)
      for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const [xa, ya] = r[a]
        const [xb, yb] = r[b]
        if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside
      }
    if (inside) out.push(i)
  }
  return out
}

/**
 * The same painting over new bounds: a fresh grid where each cell takes the
 * biome under it in the old grid, and anything outside the old bounds is unpainted.
 */
export function resampleGrid(old: LandGrid, bounds: Bounds, cells: number): LandGrid {
  const g0 = graphFor(old)
  const b0 = biomesOf(old, g0)
  const next = newGrid(bounds, Math.max(1000, Math.min(MAX_CELLS, Math.round(cells))))
  const g1 = graphFor(next)
  const out = new Uint8Array(g1.n)
  const ob = old.bounds
  for (let i = 0; i < g1.n; i++) {
    const x = g1.points[2 * i]
    const y = g1.points[2 * i + 1]
    out[i] = x >= ob.minX && x <= ob.maxX && y >= ob.minY && y <= ob.maxY ? b0[findCell(g0, x, y)] : EMPTY
  }
  return { ...old, bounds: { ...bounds }, cells: next.cells, seed: next.seed, fine: undefined, biome: encodeBytes(out) }
}

// ── Clean-up ────────────────────────────────────────────────────────────────

/** Majority filter: each cell takes the most common value among itself and its neighbours. */
export function smoothCells(g: Graph, values: Uint8Array, passes = 1): Uint8Array {
  let cur = values
  for (let p = 0; p < passes; p++) {
    const next = new Uint8Array(cur)
    const counts = new Map<number, number>()
    for (let i = 0; i < g.n; i++) {
      counts.clear()
      counts.set(cur[i], 1.5)
      for (const q of g.c[i]) counts.set(cur[q], (counts.get(cur[q]) ?? 0) + 1)
      let best = cur[i]
      let bestN = 0
      for (const [k, cnt] of counts)
        if (cnt > bestN) {
          best = k
          bestN = cnt
        }
      next[i] = best
    }
    cur = next
  }
  return cur
}

/** Islands and lakes smaller than `min` cells merge into what surrounds them. */
export function dropSmallRegions(g: Graph, values: Uint8Array, min: number): Uint8Array {
  const out = new Uint8Array(values)
  const seen = new Uint8Array(g.n)
  const water = (b: number) => isWater(b)
  for (let i = 0; i < g.n; i++) {
    if (seen[i]) continue
    const region = floodCells(g, out, i, (a, b) => water(a) === water(b))
    for (const q of region) seen[q] = 1
    if (region.length >= min) continue
    const inside = new Set(region)
    // The most common value around the region replaces it.
    const counts = new Map<number, number>()
    for (const q of region) for (const r of g.c[q]) if (!inside.has(r)) counts.set(out[r], (counts.get(out[r]) ?? 0) + 1)
    let best = -1
    let bestN = 0
    for (const [k, cnt] of counts)
      if (cnt > bestN) {
        best = k
        bestN = cnt
      }
    if (best >= 0) for (const q of region) out[q] = best
  }
  return out
}

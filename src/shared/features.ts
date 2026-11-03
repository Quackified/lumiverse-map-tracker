import type { Bounds, Feature, FeatureGeom, FeatureLayer, LayerSettings, Ring } from './types'

// Geometry helpers for the vector layers (landmass, topography, terrain, props).
// Everything works in world coordinates, [x, y] pairs in GeoJSON order.

export const LAYER_ORDER: FeatureLayer[] = ['landmass', 'topography', 'terrain', 'props']

export const LAYER_LABEL: Record<FeatureLayer, string> = {
  landmass: 'Landmass',
  topography: 'Topography',
  terrain: 'Terrain',
  props: 'Props',
}

export const DEFAULT_LAYER_SETTINGS: Record<FeatureLayer, LayerSettings> = {
  landmass: { visible: true, locked: false, opacity: 1 },
  topography: { visible: true, locked: false, opacity: 0.8 },
  terrain: { visible: true, locked: false, opacity: 0.85 },
  props: { visible: true, locked: false, opacity: 1 },
}

export interface FeatureType {
  type: string
  label: string
  geom: FeatureGeom
}

/** What each layer can hold. The first entry per geometry is the default. */
export const FEATURE_TYPES: Record<FeatureLayer, FeatureType[]> = {
  landmass: [
    { type: 'land', label: 'Land', geom: 'area' },
    { type: 'lake', label: 'Lake / inland sea', geom: 'area' },
    { type: 'coast', label: 'Shoreline', geom: 'line' },
  ],
  topography: [
    { type: 'contour', label: 'Contour (closed)', geom: 'area' },
    { type: 'contour', label: 'Contour line', geom: 'line' },
    { type: 'peak', label: 'Peak / spot height', geom: 'spot' },
  ],
  terrain: [
    { type: 'forest', label: 'Forest (broadleaf)', geom: 'area' },
    { type: 'pine', label: 'Forest (conifer)', geom: 'area' },
    { type: 'jungle', label: 'Jungle', geom: 'area' },
    { type: 'grassland', label: 'Grassland', geom: 'area' },
    { type: 'desert', label: 'Desert', geom: 'area' },
    { type: 'snow', label: 'Snow / tundra', geom: 'area' },
    { type: 'swamp', label: 'Swamp', geom: 'area' },
    { type: 'volcanic', label: 'Volcanic land', geom: 'area' },
    { type: 'hills', label: 'Hills', geom: 'area' },
    { type: 'mountains', label: 'Mountain range', geom: 'line' },
    { type: 'hills', label: 'Hill range', geom: 'line' },
    { type: 'river', label: 'River', geom: 'line' },
    { type: 'road', label: 'Road', geom: 'line' },
    { type: 'volcano', label: 'Volcano', geom: 'spot' },
    { type: 'peak', label: 'Mountain peak', geom: 'spot' },
    { type: 'oasis', label: 'Oasis', geom: 'spot' },
  ],
  props: [
    { type: 'city', label: 'City', geom: 'spot' },
    { type: 'town', label: 'Town', geom: 'spot' },
    { type: 'castle', label: 'Castle / fortress', geom: 'spot' },
    { type: 'tower', label: 'Tower', geom: 'spot' },
    { type: 'port', label: 'Port', geom: 'spot' },
    { type: 'ruin', label: 'Ruin', geom: 'spot' },
    { type: 'temple', label: 'Temple', geom: 'spot' },
    { type: 'crystal', label: 'Crystal', geom: 'spot' },
    { type: 'camp', label: 'Camp', geom: 'spot' },
    { type: 'wall', label: 'Wall', geom: 'line' },
  ],
}

export function typeLabel(layer: FeatureLayer, type: string, geom?: FeatureGeom): string {
  return FEATURE_TYPES[layer].find((t) => t.type === type && (!geom || t.geom === geom))?.label ?? type
}

export function layerSettings(s: Partial<Record<FeatureLayer, LayerSettings>> | undefined, layer: FeatureLayer): LayerSettings {
  return { ...DEFAULT_LAYER_SETTINGS[layer], ...(s?.[layer] ?? {}) }
}

export function newFeatureId(layer: FeatureLayer): string {
  return `${layer}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function featureBounds(fs: Feature[]): Bounds | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const f of fs) {
    for (const r of f.rings) {
      for (const [x, y] of r) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null
}

/** Even-odd test over every ring, so holes punch out. */
export function pointInRings(x: number, y: number, rings: Ring[]): boolean {
  let inside = false
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i]
      const [xj, yj] = r[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/** Distance from p to segment ab, and the closest point's parameter t. */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; t: number } {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t }
}

/** Ramer–Douglas–Peucker: drop vertices closer than `tol` to the simplified line. */
export function simplify(points: Ring, tol: number): Ring {
  if (points.length <= 2) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let best = -1
    let bestD = tol
    for (let i = a + 1; i < b; i++) {
      const { d } = segmentDistance(points[i][0], points[i][1], points[a][0], points[a][1], points[b][0], points[b][1])
      if (d > bestD) (bestD = d), (best = i)
    }
    if (best >= 0) {
      keep[best] = 1
      stack.push([a, best], [best, b])
    }
  }
  return points.filter((_, i) => keep[i])
}

export function mapFeatures(fs: Feature[], fn: (x: number, y: number) => [number, number]): Feature[] {
  return fs.map((f) => ({ ...f, rings: f.rings.map((r) => r.map(([x, y]) => fn(x, y))) }))
}

const round = (n: number) => Math.round(n * 100) / 100

/** Keep only the fields a Feature has, with sane values. Returns null when unusable. */
export function cleanFeature(raw: unknown): Feature | null {
  const f = raw as Partial<Feature> & Record<string, unknown>
  if (!f || typeof f !== 'object' || !Array.isArray(f.rings)) return null
  const layer = (['landmass', 'topography', 'terrain', 'props'] as const).find((l) => l === f.layer)
  const geom = (['area', 'line', 'spot'] as const).find((g) => g === f.geom)
  if (!layer || !geom) return null
  const rings = f.rings
    .map((r) => (Array.isArray(r) ? r.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [round(p[0]), round(p[1])] as [number, number]) : []))
    .filter((r) => r.length >= (geom === 'area' ? 3 : geom === 'line' ? 2 : 1))
  if (!rings.length) return null
  const out: Feature = { id: typeof f.id === 'string' && f.id ? f.id : newFeatureId(layer), layer, geom, type: typeof f.type === 'string' && f.type ? f.type : FEATURE_TYPES[layer].find((t) => t.geom === geom)?.type ?? geom, rings }
  for (const k of ['name', 'note', 'color'] as const) if (typeof f[k] === 'string' && f[k]) out[k] = f[k] as string
  for (const k of ['elevation', 'size', 'density'] as const) if (typeof f[k] === 'number' && Number.isFinite(f[k])) out[k] = f[k] as number
  if (f.smooth) out.smooth = true
  if (f.hidden) out.hidden = true
  return out
}

interface GeoFeature {
  type: 'Feature'
  geometry: { type: string; coordinates: unknown }
  properties?: Record<string, unknown> | null
}

/**
 * Features from a file: a map file (`features`), a bare array, or a GeoJSON
 * FeatureCollection whose properties carry `layer` and `type`.
 */
export function featuresFromJson(data: unknown): Feature[] | null {
  const d = data as { features?: unknown; type?: string }
  const list = Array.isArray(data) ? data : Array.isArray(d?.features) ? d.features : null
  if (!list) return null
  const out: Feature[] = []
  for (const item of list) {
    if ((item as GeoFeature)?.type === 'Feature') out.push(...fromGeo(item as GeoFeature))
    else {
      const f = cleanFeature(item)
      if (f) out.push(f)
    }
  }
  return out
}

function fromGeo(g: GeoFeature): Feature[] {
  const p = g.properties ?? {}
  const base = { ...p, layer: p.layer ?? 'terrain' }
  const c = g.geometry?.coordinates as never
  switch (g.geometry?.type) {
    case 'Polygon':
      return [cleanFeature({ ...base, geom: 'area', rings: (c as Ring[]).map((r) => r.slice(0, -1)) })].filter(Boolean) as Feature[]
    case 'MultiPolygon':
      return (c as Ring[][]).map((poly) => cleanFeature({ ...base, id: undefined, geom: 'area', rings: poly.map((r) => r.slice(0, -1)) })).filter(Boolean) as Feature[]
    case 'LineString':
      return [cleanFeature({ ...base, geom: 'line', rings: [c] })].filter(Boolean) as Feature[]
    case 'Point':
      return [cleanFeature({ ...base, geom: 'spot', rings: [[c]] })].filter(Boolean) as Feature[]
    default:
      return []
  }
}

/** GeoJSON FeatureCollection (x first, polygons closed) with layer/type in properties. */
export function featuresToGeoJson(fs: Feature[]): { type: 'FeatureCollection'; features: GeoFeature[] } {
  return {
    type: 'FeatureCollection',
    features: fs.map((f) => {
      const { rings, geom, ...props } = f
      const geometry =
        geom === 'area'
          ? { type: 'Polygon', coordinates: rings.map((r) => [...r, r[0]]) }
          : geom === 'line'
            ? { type: 'LineString', coordinates: rings[0] }
            : { type: 'Point', coordinates: rings[0][0] }
      return { type: 'Feature' as const, geometry, properties: props }
    }),
  }
}

/** Topmost area features containing a world point, per layer (props first). */
export function areasAt(fs: Feature[], x: number, y: number, visible: (l: FeatureLayer) => boolean): Feature[] {
  const out: Feature[] = []
  for (let i = fs.length - 1; i >= 0; i--) {
    const f = fs[i]
    if (f.geom !== 'area' || f.hidden || !visible(f.layer)) continue
    if (pointInRings(x, y, f.rings)) out.push(f)
  }
  return out.sort((a, b) => LAYER_ORDER.indexOf(b.layer) - LAYER_ORDER.indexOf(a.layer))
}

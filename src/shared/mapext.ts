import type { ParseResult } from './parser'
import { slug } from './parser'
import type { Poi, Span, Zone } from './types'

// Reads structured map data from lorebook entries: `entry.extensions.map`
// (Map Coordinate Format v1, GeoJSON ordering, x first):
//
//   kind: system   origin, axes, scale_km, regions: [{ name, bbox }]   (the continents)
//   kind: region   bbox: [minX, minY, maxX, maxY] (null = open side), priority, continent, places
//   kind: point    coords: [x, y], continent, parent, places: [{ name, coords }]
//
// Entries without `map` are skipped. This is preferred over parsing body text.

export type MapCoord = [number, number]
export type MapBBox = [number | null, number | null, number | null, number | null]

export interface MapPlace {
  name: string
  coords: MapCoord
}

export interface MapField {
  kind: 'point' | 'region' | 'system'
  coords?: MapCoord
  bbox?: MapBBox
  priority?: number
  continent?: string
  parent?: string
  places?: MapPlace[]
  scale_km?: number
  regions?: { name: string; bbox: MapBBox }[]
}

export interface MapEntry {
  /** Entry title / comment, e.g. "[FAC] Eracia Empire". */
  name: string
  map?: unknown
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const coordOf = (v: unknown): MapCoord | null => (Array.isArray(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1]) ? [v[0], v[1]] : null)
const spanOf = (min: unknown, max: unknown): Span => ({ min: isNum(min) ? min : null, max: isNum(max) ? max : null })

/** The map field of an entry, or null when it's missing or malformed. */
export function readMapField(v: unknown): MapField | null {
  if (!v || typeof v !== 'object') return null
  const m = v as Partial<MapField>
  return m.kind === 'point' || m.kind === 'region' || m.kind === 'system' ? (m as MapField) : null
}

/** "[LOC] Eastern Continent: Frostfall Tundra" → "Frostfall Tundra". */
export function displayName(title: string): string {
  const bare = title.replace(/^\s*\[[^\]]+\]\s*/, '').trim()
  const i = bare.lastIndexOf(': ')
  return (i >= 0 ? bare.slice(i + 2) : bare).trim() || bare
}

/** Locations and factions first, so a city listed again by an event keeps its home group. */
const TAG_ORDER = ['LOC', 'FAC', 'ORG', 'RACE', 'CHAR']

function rank(title: string): number {
  const tag = /^\s*\[([^\]]+)\]/.exec(title)?.[1]?.toUpperCase() ?? ''
  const i = TAG_ORDER.indexOf(tag)
  return i >= 0 ? i : TAG_ORDER.length
}

export function hasMapData(entries: MapEntry[]): boolean {
  return entries.some((e) => readMapField(e.map))
}

export function parseMapEntries(entries: MapEntry[]): ParseResult {
  const points: Poi[] = []
  const zones: Zone[] = []
  const zoneIds = new Set<string>()
  const pointIds = new Set<string>()
  const seen = new Set<string>()
  let unitKm: number | null = null
  let skipped = 0

  const uid = (base: string, used: Set<string>) => {
    let id = slug(base)
    for (let i = 2; used.has(id); i++) id = `${slug(base)}-${i}`
    used.add(id)
    return id
  }
  const addPoint = (name: string, c: MapCoord, group: string, note?: string) => {
    const key = `${name.toLowerCase()}|${c[0]}|${c[1]}`
    if (seen.has(key)) return
    seen.add(key)
    // "Bluewatch" and "Bluewatch Village" on the same spot are one place: keep the fuller name.
    const lower = name.toLowerCase()
    const twin = points.find((p) => p.x === c[0] && p.y === c[1] && (p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase())))
    if (twin) {
      if (name.length > twin.name.length) twin.name = name
      return
    }
    points.push({ id: uid(name, pointIds), name, x: c[0], y: c[1], group, ...(note ? { note } : {}) })
  }

  const items = entries
    .map((e) => ({ title: e.name, map: readMapField(e.map) }))
    .filter((e): e is { title: string; map: MapField } => {
      if (!e.map) skipped++
      return !!e.map
    })
    .sort((a, b) => rank(a.title) - rank(b.title))

  // Continents first, so regions can be clipped to them.
  const continents = new Map<string, string>()
  for (const { title, map } of items) {
    if (map.kind !== 'system') continue
    if (isNum(map.scale_km) && map.scale_km > 0) unitKm = map.scale_km
    for (const r of map.regions ?? []) {
      if (!r?.name || !Array.isArray(r.bbox)) continue
      const id = uid(r.name, zoneIds)
      continents.set(r.name.toLowerCase(), id)
      zones.push({ id, name: r.name, group: displayName(title), kind: 'region', x: spanOf(r.bbox[0], r.bbox[2]), y: spanOf(r.bbox[1], r.bbox[3]) })
    }
  }

  for (const { title, map } of items) {
    if (map.kind === 'system') continue
    const name = displayName(title)
    const continent = map.continent?.trim()
    const group = [continent, name].filter(Boolean).join(' / ')
    if (map.kind === 'region') {
      const b = map.bbox
      if (!Array.isArray(b)) {
        skipped++
        continue
      }
      const within = continent ? continents.get(continent.toLowerCase()) : undefined
      zones.push({
        id: uid(name, zoneIds),
        name,
        group: continent ?? '',
        kind: 'zone',
        x: spanOf(b[0], b[2]),
        y: spanOf(b[1], b[3]),
        ...(isNum(map.priority) && map.priority ? { priority: map.priority } : {}),
        ...(within ? { within } : {}),
        note: title.trim(),
      })
    }
    const places = (map.places ?? []).map((p) => ({ name: p?.name, c: coordOf(p?.coords) })).filter((p): p is { name: string; c: MapCoord } => !!p.name && !!p.c)
    for (const p of places) addPoint(p.name, p.c, group, title.trim())
    // A point entry's own coords are usually its capital, already among its places.
    const own = map.kind === 'point' ? coordOf(map.coords) : null
    if (own && !places.some((p) => p.c[0] === own[0] && p.c[1] === own[1])) addPoint(name, own, continent ?? '', title.trim())
  }

  return { points, zones, unitKm, skipped }
}

/** Entries from a lorebook export (Lumiverse / SillyTavern / CCv3 character_book). */
export function entriesFromLorebookJson(data: unknown): MapEntry[] | null {
  const d = data as { entries?: unknown; data?: { character_book?: { entries?: unknown } } }
  let raw = d?.entries ?? d?.data?.character_book?.entries
  if (raw && !Array.isArray(raw) && typeof raw === 'object') raw = Object.values(raw)
  if (!Array.isArray(raw)) return null
  return raw.map((e) => {
    const o = e as { comment?: string; name?: string; key?: string[]; keys?: string[]; extensions?: { map?: unknown } }
    return { name: o.comment || o.name || (o.key ?? o.keys ?? []).join(', '), map: o.extensions?.map }
  })
}

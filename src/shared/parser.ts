import { boundsOf } from './geo'
import type { Poi, Span, WorldProfile, Zone } from './types'

// Infers points and zones from loosely structured coordinate notes, e.g.
//
//   Eastern Continent Locations:
//     Holy Radiance Theocracy:
//       Holy City Lumina:[-3,75]
//       Port of Joy:[-175,140] # west coast enclave
//   Western Continent (Yanzhou):
//     Range: X[-400,-200]
//   Terrain Zones:
//     Storm Mountains: Y>120 AND X[-400,-210]
//     Frostfall Tundra: Y>150
//   Scale: 1 coordinate unit = 50 km
//
// Indentation builds the group path. Anything that doesn't look like a point,
// zone, or group header is ignored, so the whole lorebook entry can be pasted.

export interface ParseResult {
  points: Poi[]
  zones: Zone[]
  unitKm: number | null
  skipped: number
}

const NUM = String.raw`-?\d+(?:\.\d+)?`
const POINT_RE = new RegExp(String.raw`^(.+?)\s*:\s*\[\s*(${NUM})\s*,\s*(${NUM})\s*\]\s*(.*)$`)
const BRACKET_RE = new RegExp(String.raw`\b([XY])\s*\[\s*(${NUM})\s*,\s*(${NUM})\s*\]`, 'gi')
const COMPARE_RE = new RegExp(String.raw`\b([XY])\s*(<=?|>=?)\s*(${NUM})`, 'gi')
const SCALE_RE = /1\s*(?:coordinate\s*)?unit\s*=\s*([\d.]+)\s*km/i

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  )
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`
  used.add(id)
  return id
}

function splitComment(text: string): { body: string; note?: string } {
  const i = text.search(/(^|\s)#/)
  if (i < 0) return { body: text.trim() }
  return { body: text.slice(0, i).trim(), note: text.slice(i).replace(/^\s*#\s*/, '').trim() || undefined }
}

/** Extracts X/Y spans from text such as "X[-45,0] AND Y[0,150]" or "Y>150". Returns null if none. */
export function parseSpans(text: string): { x: Span; y: Span } | null {
  const x: Span = { min: null, max: null }
  const y: Span = { min: null, max: null }
  let found = false
  for (const m of text.matchAll(BRACKET_RE)) {
    const span = m[1].toUpperCase() === 'X' ? x : y
    const a = Number(m[2])
    const b = Number(m[3])
    span.min = Math.min(a, b)
    span.max = Math.max(a, b)
    found = true
  }
  for (const m of text.matchAll(COMPARE_RE)) {
    const span = m[1].toUpperCase() === 'X' ? x : y
    const v = Number(m[3])
    if (m[2].startsWith('>')) span.min = v
    else span.max = v
    found = true
  }
  return found ? { x, y } : null
}

export function parseCoordinateText(text: string): ParseResult {
  const points: Poi[] = []
  const zones: Zone[] = []
  const pointIds = new Set<string>()
  const zoneIds = new Set<string>()
  const notes = new Map<string, string>()
  const stack: { indent: number; name: string }[] = []
  let unitKm: number | null = null
  let skipped = 0
  let inFrontmatter = false

  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  lines.forEach((raw, lineNo) => {
    if (raw.trim() === '---' && (lineNo === 0 || inFrontmatter)) {
      inFrontmatter = !inFrontmatter
      return
    }
    if (inFrontmatter || !raw.trim()) return
    if (/^\s*<\/?[\w-]+>\s*$/.test(raw)) return

    const indent = raw.length - raw.trimStart().length
    const line = raw.trim().replace(/^[-*]\s+/, '')
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const path = stack.map((s) => s.name)
    const group = path.join(' / ')

    const scale = SCALE_RE.exec(line)
    if (scale) {
      unitKm = Number(scale[1])
      return
    }

    const pm = POINT_RE.exec(line)
    if (pm) {
      const { note } = splitComment(pm[4] ?? '')
      const name = pm[1].trim()
      points.push({
        id: uniqueId(slug(name), pointIds),
        name,
        x: Number(pm[2]),
        y: Number(pm[3]),
        group,
        ...(note ? { note } : {}),
      })
      return
    }

    const colon = line.indexOf(':')
    if (colon <= 0) {
      skipped++
      return
    }
    const key = line.slice(0, colon).trim()
    const { body: rest, note } = splitComment(line.slice(colon + 1))

    if (!rest) {
      stack.push({ indent, name: key })
      return
    }

    const spans = parseSpans(rest)
    if (spans) {
      // "Range:" describes its parent group (a continent, an ocean).
      const isRange = /^(range|extent|bounds|area)$/i.test(key)
      const name = isRange ? (path[path.length - 1] ?? 'Region') : key
      const zoneGroup = isRange ? path.slice(0, -1).join(' / ') : group
      zones.push({
        id: uniqueId(slug(name), zoneIds),
        name,
        group: zoneGroup,
        kind: isRange ? 'region' : 'zone',
        x: spans.x,
        y: spans.y,
        ...(note ? { note } : {}),
      })
      return
    }

    if (/^(traits|description|notes?|summary)$/i.test(key)) {
      notes.set(group, rest)
      return
    }
    skipped++
  })

  for (const z of zones) {
    if (z.kind !== 'region' || z.note) continue
    const n = notes.get(z.group ? `${z.group} / ${z.name}` : z.name)
    if (n) z.note = n
  }
  inferWithin(zones)

  return { points, zones, unitKm, skipped }
}

/** "Western Continent Terrain Zones" → clip its zones to the "Western Continent (Yanzhou)" region. */
function inferWithin(zones: Zone[]): void {
  const regions = zones
    .filter((z) => z.kind === 'region')
    .map((r) => ({ id: r.id, key: r.name.replace(/\(.*?\)/g, '').trim().toLowerCase() }))
    .filter((r) => r.key.length > 2)
  for (const z of zones) {
    if (z.kind !== 'zone' || z.within) continue
    const g = z.group.toLowerCase()
    const hit = regions.find((r) => g.includes(r.key))
    if (hit) z.within = hit.id
  }
}

/** Merge by name+group: incoming entries replace same-named ones and keep their ids. */
export function mergeInto(profile: WorldProfile, parsed: ParseResult, mode: 'replace' | 'merge'): WorldProfile {
  const next: WorldProfile = { ...profile, updatedAt: Date.now() }
  if (mode === 'replace') {
    next.points = parsed.points
    next.zones = parsed.zones
  } else {
    const key = (o: { name: string; group: string }) => `${o.group}\u0000${o.name}`.toLowerCase()
    const pts = new Map(profile.points.map((p) => [key(p), p]))
    for (const p of parsed.points) {
      const old = pts.get(key(p))
      pts.set(key(p), old ? { ...old, x: p.x, y: p.y, note: p.note ?? old.note } : p)
    }
    const zs = new Map(profile.zones.map((z) => [key(z), z]))
    for (const z of parsed.zones) {
      const old = zs.get(key(z))
      zs.set(key(z), old ? { ...old, x: z.x, y: z.y, kind: z.kind, note: z.note ?? old.note } : z)
    }
    next.points = dedupeIds([...pts.values()])
    next.zones = dedupeIds([...zs.values()])
  }
  if (parsed.unitKm) next.unitKm = parsed.unitKm
  next.bounds = boundsOf(next)
  return next
}

function dedupeIds<T extends { id: string; name: string }>(items: T[]): T[] {
  const used = new Set<string>()
  return items.map((it) => (used.has(it.id) ? { ...it, id: uniqueId(slug(it.name), used) } : (used.add(it.id), it)))
}

export function newProfile(name: string, id: string): WorldProfile {
  return {
    id,
    name,
    unitKm: 1,
    bounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
    points: [],
    zones: [],
    updatedAt: Date.now(),
  }
}

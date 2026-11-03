import { boundsOf } from './geo'
import { carryMoves } from './places'
import type { Poi, Span, WorldProfile, Zone } from './types'

// Infers points and zones from loosely structured coordinate notes. Both plain
// indented notes and Markdown lorebook entries work:
//
//   Eastern Continent Locations:              ## Eastern Continent
//     Holy Radiance Theocracy:                **Holy Radiance Theocracy**:
//       Holy City Lumina:[-3,75]              * Holy City Lumina [-3,75]
//       Port of Joy:[-175,140] # west coast   * Port of Joy [-175,140], west coast
//   Western Continent (Yanzhou):              **Continents**:
//     Range: X[-400,-200]                     * **Western Continent (Yanzhou)**: X[-400,-200]. Traits.
//   Terrain Zones:                            **Eastern regions by coordinate**:
//     Frostfall Tundra: Y>150                 * when Y > 150, **Frostfall Tundra**.
//   Scale: 1 coordinate unit = 50 km          * **Scale**: 1 unit = 50 km.
//
// Headings and indentation build the group path; a bold "Label:" line groups the
// list under it. Anything that isn't a point, zone, or group header is ignored,
// so a whole lorebook entry can be pasted.

export interface ParseResult {
  points: Poi[]
  zones: Zone[]
  unitKm: number | null
  skipped: number
}

const NUM = String.raw`[-−]?\d+(?:\.\d+)?`
/** "[x,y]" or "(x, y)"; a bracket right after a lone X/Y is a span, not a point. */
export const POINT_RE = new RegExp(String.raw`(?<!(?:^|[^A-Za-z])[XYxy]\s*)(?:\[\s*(${NUM})\s*,\s*(${NUM})\s*\]|\(\s*(${NUM})\s*,\s*(${NUM})\s*\))`, 'g')
/** Coordinate-system notes ("Origin: (0,0)") that look like points but aren't places. */
const NOT_A_PLACE = /^(origin|cent(er|re)|axes|axis|scale|distance|range)$/i
const BRACKET_RE = new RegExp(String.raw`\b([XY])\s*\[\s*(${NUM})\s*,\s*(${NUM})\s*\]`, 'gi')
const COMPARE_RE = new RegExp(String.raw`\b([XY])\s*(<=?|>=?|≤|≥)\s*(${NUM})`, 'gi')
const SCALE_RE = /1\s*(?:coordinate\s*|map\s*)?units?\s*=\s*([\d.,]+)\s*km/i
const RANGE_KEY = /^(range|extent|bounds|area)$/i
const NOTE_KEY = /^(traits|description|notes?|summary)$/i
/** Groups whose items are continent/ocean-scale regions rather than terrain zones. */
const REGION_GROUP = /\b(continents?|landmass(es)?|realms|oceans|hemispheres)\s*$/i

const num = (s: string) => Number(s.replace('−', '-'))

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

function stripMd(s: string): string {
  return s.replace(/\*\*|__|`/g, '').trim()
}

/** Leftover prose → a note: drop separators, a leading "#" comment marker and wrapping. */
function cleanNote(s: string): string | undefined {
  const t = s
    .replace(/^[\s,;:.\-–—#]+/, '')
    .replace(/[\s,;]+$/, '')
    .trim()
  return t.length > 1 ? t : undefined
}

/** Extracts X/Y spans from text such as "X[-45,0] AND Y[0,150]" or "Y > 150". Returns null if none. */
export function parseSpans(text: string): { x: Span; y: Span } | null {
  const x: Span = { min: null, max: null }
  const y: Span = { min: null, max: null }
  let found = false
  for (const m of text.matchAll(BRACKET_RE)) {
    const span = m[1].toUpperCase() === 'X' ? x : y
    const a = num(m[2])
    const b = num(m[3])
    span.min = Math.min(a, b)
    span.max = Math.max(a, b)
    found = true
  }
  for (const m of text.matchAll(COMPARE_RE)) {
    const span = m[1].toUpperCase() === 'X' ? x : y
    const v = num(m[3])
    if (m[2].startsWith('>') || m[2] === '≥') span.min = v
    else span.max = v
    found = true
  }
  return found ? { x, y } : null
}

interface Frame {
  depth: number
  name: string
}

/** Name and note of a zone line: "**Name**: X[..]. note", "Name: X[..] # note" or "when X[..], **Name**. note". */
function zoneLabel(raw: string): { name: string | null; note?: string; isRange: boolean } {
  const bold = [...raw.matchAll(/\*\*(.+?)\*\*|__(.+?)__/g)].map((m) => (m[1] ?? m[2]).trim()).find((b) => !parseSpans(b))
  const plain = stripMd(raw)
  if (bold) {
    const name = bold.replace(/:$/, '').trim()
    return { name, note: residue(plain.replace(bold, ' ')), isRange: false }
  }
  const colon = plain.indexOf(':')
  if (colon > 0 && !parseSpans(plain.slice(0, colon))) {
    const key = plain.slice(0, colon).trim()
    const after = plain.slice(colon + 1)
    const hash = after.search(/(^|\s)#/)
    return { name: key, note: hash >= 0 ? cleanNote(after.slice(hash)) : residue(after), isRange: RANGE_KEY.test(key) }
  }
  // "when X < -45 (west of the mountains), Western Wastes. Note."
  const paren = /\(([^)]*)\)/.exec(plain)?.[1]
  const left = (residue(plain.replace(/\([^)]*\)/g, ' ')) ?? '')
    .split(/[.,;:]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const note = [paren, ...left.slice(1)].filter(Boolean).join('. ')
  return { name: left[0] ?? null, note: cleanNote(note), isRange: false }
}

const CONNECTOR = String.raw`(?:\s|[,;:.&]|\b(?:when|if|where|and|or)\b)+`
const EDGES = new RegExp(String.raw`^${CONNECTOR}|${CONNECTOR}$`, 'gi')

/** What's left of a zone line once the spans and connecting words are gone. */
function residue(s: string): string | undefined {
  const t = s
    .replace(BRACKET_RE, ' ')
    .replace(COMPARE_RE, ' ')
    .replace(/\s+/g, ' ')
    .replace(EDGES, '')
    .trim()
    .replace(/^\((.*)\)\.?$/, '$1')
  return t.length > 1 ? t : undefined
}

export function parseCoordinateText(text: string): ParseResult {
  const points: Poi[] = []
  const zones: Zone[] = []
  const pointIds = new Set<string>()
  const zoneIds = new Set<string>()
  const notes = new Map<string, string>()
  /** Full path (headings included) for each zone, used to infer which region clips it. */
  const zonePaths = new Map<string, string>()
  const stack: Frame[] = []
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

    const heading = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw)
    if (heading) {
      const depth = heading[1].length
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
      stack.push({ depth, name: stripMd(heading[2]).replace(/:$/, '') })
      return
    }

    const expanded = raw.replace(/\t/g, '  ')
    const indent = expanded.length - expanded.trimStart().length
    const bulletRe = /^([-*+]|\d+[.)])\s+/
    const bullet = bulletRe.test(expanded.trim())
    const content = expanded.trim().replace(bulletRe, '')
    // Body lines sit below every heading; a bullet nests under a label at the same indent.
    const depth = 10 + indent + (bullet ? 1 : 0)
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    const path = stack.map((s) => s.name)
    const group = path.join(' / ')
    const plain = stripMd(content)

    const scale = SCALE_RE.exec(plain)
    if (scale) {
      unitKm = Number(scale[1].replace(/,/g, ''))
      return
    }

    // Points: "Name:[x,y] # note", "Name (x, y), note", "Label: A [x,y], B [x,y]".
    const hits = [...plain.matchAll(POINT_RE)]
    if (hits.length) {
      let label: string | null = null
      let cursor = 0
      hits.forEach((m, i) => {
        let seg = plain
          .slice(cursor, m.index)
          .replace(/^[\s,;]+/, '')
          .replace(/^and\s+/i, '')
        if (i === 0) {
          const split = /^(.+?):\s+(\S.*)$/.exec(seg)
          if (split && !/:\s*$/.test(seg)) {
            label = split[1].trim()
            seg = split[2]
          }
        }
        const name = seg.replace(/[\s:–—-]+$/, '').trim()
        cursor = (m.index ?? 0) + m[0].length
        const next = hits[i + 1]
        const tail = next ? '' : plain.slice(cursor)
        if (!name || NOT_A_PLACE.test(name)) return
        const note = cleanNote(tail)
        points.push({
          id: uniqueId(slug(name), pointIds),
          name,
          x: num(m[1] ?? m[3]),
          y: num(m[2] ?? m[4]),
          group: label ? [...path, label].join(' / ') : group,
          ...(note ? { note } : {}),
        })
      })
      return
    }

    const spans = parseSpans(plain)
    if (spans) {
      const lbl = zoneLabel(content)
      // "Range:" describes its parent group (a continent, an ocean).
      const name = lbl.isRange ? (path[path.length - 1] ?? 'Region') : (lbl.name ?? 'Zone')
      const zonePath = lbl.isRange ? path.slice(0, -1) : path
      const isRegion = lbl.isRange || REGION_GROUP.test(path[path.length - 1] ?? '')
      const id = uniqueId(slug(name), zoneIds)
      const note = lbl.note
      zones.push({
        id,
        name,
        group: zonePath.join(' / '),
        kind: isRegion ? 'region' : 'zone',
        x: spans.x,
        y: spans.y,
        ...(note ? { note } : {}),
        ...(note && /\boverrides?\b/i.test(note) ? { priority: 1 } : {}),
      })
      zonePaths.set(id, zonePath.join(' / '))
      return
    }

    // Group header: "Label:" with nothing after it.
    const header = /^(.+?):\s*$/.exec(plain)
    if (header) {
      stack.push({ depth, name: header[1].trim() })
      return
    }

    const colon = plain.indexOf(':')
    if (colon > 0 && NOTE_KEY.test(plain.slice(0, colon).trim())) {
      notes.set(group, plain.slice(colon + 1).trim())
      return
    }
    skipped++
  })

  for (const z of zones) {
    if (z.kind !== 'region' || z.note) continue
    const n = notes.get(z.group ? `${z.group} / ${z.name}` : z.name)
    if (n) z.note = n
  }
  inferWithin(zones, zonePaths)

  return { points, zones, unitKm, skipped }
}

/** "## Eastern Continent" / "Western Continent Terrain Zones" → clip their zones to that continent's region. */
function inferWithin(zones: Zone[], paths: Map<string, string>): void {
  const keys = (name: string) => {
    const alias = /\(([^)]+)\)/.exec(name)?.[1]
    return [name.replace(/\(.*?\)/g, '').trim(), alias ?? ''].map((k) => k.toLowerCase()).filter((k) => k.length > 2)
  }
  const regions = zones.filter((z) => z.kind === 'region').map((r) => ({ id: r.id, keys: keys(r.name) }))
  for (const z of zones) {
    if (z.kind !== 'zone' || z.within) continue
    const g = (paths.get(z.id) ?? z.group).toLowerCase()
    const hit = regions.find((r) => r.keys.some((k) => g.includes(k)))
    if (hit) z.within = hit.id
  }
}

/** Merge by name+group: incoming entries replace same-named ones and keep their ids. */
export function mergeInto(profile: WorldProfile, parsed: ParseResult, mode: 'replace' | 'merge'): WorldProfile {
  const next: WorldProfile = { ...profile, updatedAt: Date.now() }
  if (mode === 'replace') {
    next.points = carryMoves(profile.points, parsed.points)
    next.zones = parsed.zones
  } else {
    const key = (o: { name: string; group: string }) => `${o.group}\u0000${o.name}`.toLowerCase()
    const pts = new Map(profile.points.map((p) => [key(p), p]))
    for (const p of parsed.points) {
      const old = pts.get(key(p))
      if (!old) pts.set(key(p), p)
      else if (old.origin) pts.set(key(p), carryMoves([old], [{ ...old, x: p.x, y: p.y, note: p.note ?? old.note }])[0])
      else pts.set(key(p), { ...old, x: p.x, y: p.y, note: p.note ?? old.note })
    }
    const zs = new Map(profile.zones.map((z) => [key(z), z]))
    const idMap = new Map<string, string>()
    for (const z of parsed.zones) {
      const old = zs.get(key(z))
      if (old) idMap.set(z.id, old.id)
      zs.set(key(z), old ? { ...old, x: z.x, y: z.y, kind: z.kind, note: z.note ?? old.note, within: z.within ?? old.within } : z)
    }
    // Incoming `within` ids refer to incoming region ids; point them at the kept ids.
    next.points = dedupeIds([...pts.values()])
    next.zones = dedupeIds([...zs.values()]).map((z) => (z.within && idMap.has(z.within) ? { ...z, within: idMap.get(z.within) } : z))
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

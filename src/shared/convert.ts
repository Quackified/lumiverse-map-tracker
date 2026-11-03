import { POINT_RE } from './parser'
import { placeRef, placeText } from './places'
import type { Poi, WorldProfile } from './types'

// Turns literal coordinates in lorebook text ("Shackle City (-20, 60)") into
// references to the map ({{getchatvarkey::endwright_places::shackle-city}}),
// so the map owns positions and entries stay current. Nothing here writes:
// it finds candidates, and the UI decides which to apply.

export type MatchBy = 'name' | 'title' | 'coords'

export interface CoordHit {
  /** Offsets of the literal in the entry content. */
  start: number
  end: number
  literal: string
  x: number
  y: number
  /** The place this literal belongs to, if one was found. */
  placeId: string | null
  placeName?: string
  by?: MatchBy
  /** The whole line, for showing the change in context. */
  line: string
  lineStart: number
  /** Where the text naming this literal starts: the line start, or the end of the previous literal. */
  segStart: number
}

const num = (s: string) => Number(s.replace('−', '-'))
const norm = (s: string) =>
  s
    .replace(/\*\*|__|`/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Names a place goes by: "Port of Joy (Feiyue Port)" → itself, "Port of Joy", "Feiyue Port". */
function variants(p: Poi): string[] {
  const out = new Set<string>([norm(p.name)])
  const base = p.name.replace(/\s*\([^)]*\)\s*/g, ' ').trim()
  if (base) out.add(norm(base))
  for (const m of p.name.matchAll(/\(([^)]+)\)/g)) out.add(norm(m[1]))
  return [...out].filter((v) => v.length >= 3)
}

interface Matcher {
  place: Poi
  re: RegExp
}

function matchers(points: Poi[]): Matcher[] {
  const out: Matcher[] = []
  for (const place of points)
    for (const v of variants(place)) out.push({ place, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu') })
  // Longer names first, so "Port of Joy" beats "Joy".
  return out.sort((a, b) => b.re.source.length - a.re.source.length)
}

/** The place named closest before `end` in `text` (later and longer names win). */
function namedBefore(text: string, ms: Matcher[]): Poi | null {
  const plain = text.replace(/\*\*|__|`/g, (m) => ' '.repeat(m.length))
  let best: { place: Poi; at: number; len: number } | null = null
  for (const { place, re } of ms) {
    re.lastIndex = 0
    for (const m of plain.matchAll(re)) {
      const at = (m.index ?? 0) + m[0].length
      if (!best || at > best.at || (at === best.at && m[0].length > best.len)) best = { place, at, len: m[0].length }
    }
  }
  return best?.place ?? null
}

const sameXY = (p: { x: number; y: number }, x: number, y: number) => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9

/**
 * Every literal coordinate in `content`, each matched to a place when it can be:
 * by a place named earlier on the same line (after the previous literal), else by
 * the entry's title, else by being the only place at those coordinates (lorebook
 * or map position). Coordinate spans like X[-45,0] are not points and are skipped.
 */
export function findCoords(content: string, title: string, points: Poi[]): CoordHit[] {
  const ms = matchers(points)
  const titlePlace = namedBefore(title, ms)
  const hits: CoordHit[] = []
  let lineStart = 0
  for (const line of content.split('\n')) {
    let cursor = 0
    for (const m of line.matchAll(POINT_RE)) {
      const at = m.index ?? 0
      const x = num(m[1] ?? m[3])
      const y = num(m[2] ?? m[4])
      const seg = line.slice(cursor, at)
      let place = namedBefore(seg, ms)
      let by: MatchBy | undefined = place ? 'name' : undefined
      // The entry's title only stands in when nothing else is named right before the literal.
      if (!place && titlePlace && !candidateName(seg)) {
        place = titlePlace
        by = 'title'
      }
      if (!place) {
        const at_ = points.filter((p) => sameXY(p.origin ?? p, x, y) || sameXY(p, x, y))
        if (at_.length === 1) {
          place = at_[0]
          by = 'coords'
        }
      }
      hits.push({
        start: lineStart + at,
        end: lineStart + at + m[0].length,
        literal: m[0],
        x,
        y,
        placeId: place?.id ?? null,
        ...(place ? { placeName: place.name, by } : {}),
        line,
        lineStart,
        segStart: lineStart + cursor,
      })
      cursor = at + m[0].length
    }
    lineStart += line.length + 1
  }
  return hits
}

/** Replace the chosen literals with map references. `hits` must come from `findCoords` on this content. */
export function applyRefs(content: string, hits: CoordHit[], varName: string): string {
  let out = content
  for (const h of [...hits].filter((q) => q.placeId).sort((a, b) => b.start - a.start)) {
    if (content.slice(h.start, h.end) !== h.literal) continue
    out = out.slice(0, h.start) + placeRef(varName, h.placeId!) + out.slice(h.end)
  }
  return out
}

/** {{getchatvarkey::var::id}} / {{getchatvarkey::var::["id"]}} (also the getgvarkey form written by 0.4.0). */
export const REF_RE = /\{\{\s*get(?:chat|g)varkey\s*::\s*([A-Za-z0-9_]+)\s*::\s*(?:\[\s*"((?:[^"\\]|\\.)*)"\s*\]|([^}:\s]+))\s*\}\}/g

/**
 * Put current coordinates back in place of map references, so converted
 * entries still import (and read) as plain coordinates. References to another
 * variable, or to a place the map doesn't have, are left alone.
 */
export function resolveRefs(text: string, profile: WorldProfile | null): string {
  if (!profile?.placesVar) return text
  const byId = new Map(profile.points.map((p) => [p.id, p]))
  return text.replace(REF_RE, (whole, v: string, quoted?: string, bare?: string) => {
    if (v !== profile.placesVar) return whole
    const id = quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : bare!
    const p = byId.get(id)
    return p ? placeText(p.x, p.y) : whole
  })
}

export const hasRefs = (text: string): boolean => {
  REF_RE.lastIndex = 0
  return REF_RE.test(text)
}

const NOT_A_PLACE = /^(origin|cent(?:er|re)|axes|axis|scale|distance|range|coordinates?|position|location)$/i

/** The capitalised words right before a literal ("Thunderpeak Summit [-35, 60]"), if they look like a name. */
function candidateName(before: string): string | null {
  const m = /((?:[\p{Lu}][\p{L}\p{N}'’-]*\s+(?:of\s+|the\s+|de\s+)?){0,5}[\p{Lu}][\p{L}\p{N}'’-]*)[\s:–—-]*$/u.exec(before.replace(/\*\*|__|`/g, ''))
  const name = m?.[1].trim()
  return name && !NOT_A_PLACE.test(name) ? name : null
}

/** A name for an unmatched literal, to offer adding it as a new place. */
export function guessName(h: CoordHit): string | null {
  return candidateName(h.line.slice(h.segStart - h.lineStart, h.start - h.lineStart))
}

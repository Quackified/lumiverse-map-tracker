import type { Poi } from './types'

// Places moved on the map remember where the lorebook put them (`origin`), so the
// map can own the coordinates while the lorebook stays the gathering point. The
// map's coordinates are published as one global JSON variable that lorebook
// entries read with {{getgvarkey::<var>::<place id>}}.

/** Default variable name for a map: "Endwright" → "endwright_places". */
export function placesVarName(mapName: string): string {
  const base = mapName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${base || 'map'}_places`
}

export const VAR_NAME_RE = /^[A-Za-z0-9_]{1,64}$/

/** How a coordinate reads inside lorebook text, matching "Shackle City (-20, 60)". */
export function placeText(x: number, y: number): string {
  const f = (n: number) => {
    const v = Math.round(n * 100) / 100
    return Object.is(v, -0) ? '0' : String(v)
  }
  return `(${f(x)}, ${f(y)})`
}

/** The variable's value: { "<place id>": "(x, y)" } in point order. */
export function placesVarValue(points: Poi[]): string {
  const out: Record<string, string> = {}
  for (const p of points) out[p.id] = placeText(p.x, p.y)
  return JSON.stringify(out)
}

/** JSON path for a place id; quoted when it would read as an array index or contains path characters. */
function pathFor(id: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) ? id : `["${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
}

/** The macro a lorebook entry uses to read a place's coordinates. */
export function placeRef(varName: string, id: string): string {
  return `{{getgvarkey::${varName}::${pathFor(id)}}}`
}

const same = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9

/** Move a place in place, remembering its imported position the first time it moves. */
export function movePoint(p: Poi, x: number, y: number): void {
  const origin = p.origin ?? { x: p.x, y: p.y }
  p.x = x
  p.y = y
  if (same(origin, p)) delete p.origin
  else p.origin = origin
}

export function revertPoint(p: Poi): void {
  if (!p.origin) return
  p.x = p.origin.x
  p.y = p.origin.y
  delete p.origin
}

export const isMoved = (p: Poi): boolean => !!p.origin

/**
 * Re-importing from the lorebook refreshes names, groups and notes but keeps
 * places you moved on the map: their map position stays, and `origin` becomes
 * the newly imported coordinate. Matches by id, then by name.
 */
export function carryMoves(old: Poi[], incoming: Poi[]): Poi[] {
  const moved = old.filter(isMoved)
  if (!moved.length) return incoming
  const byId = new Map(moved.map((p) => [p.id, p]))
  const byName = new Map(moved.map((p) => [p.name.trim().toLowerCase(), p]))
  return incoming.map((p) => {
    const m = byId.get(p.id) ?? byName.get(p.name.trim().toLowerCase())
    if (!m) return p
    const next: Poi = { ...p, x: m.x, y: m.y, origin: { x: p.x, y: p.y } }
    if (same(next.origin!, next)) delete next.origin
    return next
  })
}

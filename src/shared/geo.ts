import type { Bounds, CalibPin, Calibration, Rect, ChatMapState, LegacyCalibration, Poi, Settings, WorldProfile, Zone } from './types'

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

export function distanceUnits(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay)
}

/** Compass bearing in degrees (0 = north, clockwise) from a to b. */
export function bearing(ax: number, ay: number, bx: number, by: number): number {
  const deg = (Math.atan2(bx - ax, by - ay) * 180) / Math.PI
  return (deg + 360) % 360
}

export function compass(deg: number): string {
  return COMPASS[Math.round(deg / 22.5) % 16]
}

export function formatKm(km: number): string {
  if (km < 10) return `${km.toFixed(1)} km`
  if (km < 1000) return `${Math.round(km)} km`
  return `${(Math.round(km / 10) * 10).toLocaleString('en-US')} km`
}

export function formatCoord(x: number, y: number, digits = 0): string {
  const f = (n: number) => {
    const v = Number(n.toFixed(digits))
    return Object.is(v, -0) ? '0' : String(v)
  }
  return `[${f(x)}, ${f(y)}]`
}

function spanContains(min: number | null, max: number | null, v: number): boolean {
  return (min === null || v >= min) && (max === null || v <= max)
}

function rawContains(z: Zone, x: number, y: number): boolean {
  return spanContains(z.x.min, z.x.max, x) && spanContains(z.y.min, z.y.max, y)
}

function parentOf(z: Zone, zones: Zone[]): Zone | undefined {
  return z.within && z.within !== z.id ? zones.find((r) => r.id === z.within) : undefined
}

export function zoneContains(z: Zone, x: number, y: number, zones: Zone[] = []): boolean {
  if (!rawContains(z, x, y)) return false
  const parent = parentOf(z, zones)
  return parent ? rawContains(parent, x, y) : true
}

function rawRect(z: Zone, b: Bounds): Bounds {
  return {
    minX: z.x.min ?? Math.min(b.minX, z.x.max ?? b.minX),
    maxX: z.x.max ?? Math.max(b.maxX, z.x.min ?? b.maxX),
    minY: z.y.min ?? Math.min(b.minY, z.y.max ?? b.minY),
    maxY: z.y.max ?? Math.max(b.maxY, z.y.min ?? b.maxY),
  }
}

/** Zone extent with open sides clamped to the profile bounds and clipped to its region. */
export function zoneRect(z: Zone, b: Bounds, zones: Zone[] = []): Bounds {
  const r = rawRect(z, b)
  const parent = parentOf(z, zones)
  if (!parent) return r
  const p = rawRect(parent, b)
  return {
    minX: Math.max(r.minX, p.minX),
    maxX: Math.min(r.maxX, p.maxX),
    minY: Math.max(r.minY, p.minY),
    maxY: Math.min(r.maxY, p.maxY),
  }
}

function zoneArea(z: Zone, b: Bounds, zones: Zone[]): number {
  const r = zoneRect(z, b, zones)
  return Math.max(0, r.maxX - r.minX) * Math.max(0, r.maxY - r.minY)
}

/** Most specific first: higher priority, then smaller area. */
function rankZones(list: Zone[], b: Bounds, zones: Zone[]): Zone[] {
  return [...list].sort(
    (a, c) => (c.priority ?? 0) - (a.priority ?? 0) || zoneArea(a, b, zones) - zoneArea(c, b, zones),
  )
}

export interface Locale {
  zone: Zone | null
  region: Zone | null
  /** Every containing zone (not regions), most specific first. */
  zones: Zone[]
}

export function locate(profile: WorldProfile, x: number, y: number): Locale {
  const all = profile.zones
  const hits = all.filter((z) => !z.hidden && zoneContains(z, x, y, all))
  const zones = rankZones(hits.filter((z) => z.kind === 'zone'), profile.bounds, all)
  const regions = rankZones(hits.filter((z) => z.kind === 'region'), profile.bounds, all)
  return { zone: zones[0] ?? null, region: regions[0] ?? null, zones }
}

export interface NearPoi {
  poi: Poi
  units: number
  km: number
  dir: string
}

export function nearest(profile: WorldProfile, x: number, y: number, count: number, minUnits = 0): NearPoi[] {
  return profile.points
    .filter((p) => !p.hidden)
    .map((poi) => {
      const units = distanceUnits(x, y, poi.x, poi.y)
      return { poi, units, km: units * profile.unitKm, dir: compass(bearing(x, y, poi.x, poi.y)) }
    })
    .filter((n) => n.units >= minUnits)
    .sort((a, b) => a.units - b.units)
    .slice(0, count)
}

export function boundsOf(profile: Pick<WorldProfile, 'points' | 'zones'>, padRatio = 0.06): Bounds {
  const xs: number[] = []
  const ys: number[] = []
  for (const p of profile.points) {
    xs.push(p.x)
    ys.push(p.y)
  }
  for (const z of profile.zones) {
    for (const v of [z.x.min, z.x.max]) if (v !== null) xs.push(v)
    for (const v of [z.y.min, z.y.max]) if (v !== null) ys.push(v)
  }
  if (!xs.length) xs.push(-100, 100)
  if (!ys.length) ys.push(-100, 100)
  let minX = Math.min(...xs)
  let maxX = Math.max(...xs)
  let minY = Math.min(...ys)
  let maxY = Math.max(...ys)
  if (maxX - minX < 1) (minX -= 50), (maxX += 50)
  if (maxY - minY < 1) (minY -= 50), (maxY += 50)
  const px = (maxX - minX) * padRatio
  const py = (maxY - minY) * padRatio
  return { minX: minX - px, maxX: maxX + px, minY: minY - py, maxY: maxY + py }
}

// ── Image calibration ───────────────────────────────────────────────────────

export interface AxisMap {
  /** world = a * px + b */
  a: number
  b: number
}

/** Per-axis mapping from image pixels to world units (north up, no rotation). */
export function calibMaps(c: Calibration): { mx: AxisMap; my: AxisMap } {
  const { a, b } = c
  const dpx = b.px - a.px
  const dpy = b.py - a.py
  const dx = b.x - a.x
  const dy = b.y - a.y
  const pd = Math.hypot(dpx, dpy)
  const wd = Math.hypot(dx, dy)
  const uni = pd > 1e-6 && wd > 1e-9 ? wd / pd : 1
  let sx = uni
  let sy = -uni
  if (!c.uniform) {
    const okX = Math.abs(dpx) > 1e-6 && Math.abs(dx) > 1e-9
    const okY = Math.abs(dpy) > 1e-6 && Math.abs(dy) > 1e-9
    // An axis the pins don't separate borrows the other axis' scale.
    if (okX) sx = dx / dpx
    if (okY) sy = dy / dpy
    if (okX && !okY) sy = -Math.abs(sx)
    if (okY && !okX) sx = Math.abs(sy)
  }
  return { mx: { a: sx, b: a.x - sx * a.px }, my: { a: sy, b: a.y - sy * a.py } }
}

export function imageToWorld(c: Calibration, px: number, py: number): { x: number; y: number } {
  const { mx, my } = calibMaps(c)
  return { x: mx.a * px + mx.b, y: my.a * py + my.b }
}

export function worldToImage(c: Calibration, x: number, y: number): { px: number; py: number } {
  const { mx, my } = calibMaps(c)
  return { px: (x - mx.b) / mx.a, py: (y - my.b) / my.a }
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * Fits the whole image over the bounds, keeping its aspect ratio. Pin a sits on
 * the world origin, pin b on the image's bottom-right corner.
 */
export function calibrationForBounds(width: number, height: number, b: Bounds): Calibration {
  const s = Math.max((b.maxX - b.minX) / width, (b.maxY - b.minY) / height) || 1
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  const toPx = (x: number, y: number) => ({ px: r2((x - cx) / s + width / 2), py: r2(height / 2 - (y - cy) / s) })
  return {
    a: { ...toPx(0, 0), x: 0, y: 0 },
    b: { px: width, py: height, x: r2(cx + (s * width) / 2), y: r2(cy - (s * height) / 2) },
    uniform: true,
  }
}

/** The cropped picture placed over the canvas: inside it keeping proportions, or stretched to fill it. */
export function cropToBounds(crop: Rect, b: Bounds, stretch = false): Calibration {
  const bw = b.maxX - b.minX
  const bh = b.maxY - b.minY
  let w = bw
  let h = bh
  if (!stretch) {
    const s = Math.min(bw / crop.w, bh / crop.h)
    w = crop.w * s
    h = crop.h * s
  }
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  return rectCalibration(crop, { minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2 })
}

/** Pins on the crop corners that place the cropped image over a world rectangle. */
export function rectCalibration(crop: Rect, r: Bounds): Calibration {
  const q = (n: number) => Math.round(n * 1000) / 1000
  return {
    a: { px: crop.x, py: crop.y, x: q(r.minX), y: q(r.maxY) },
    b: { px: crop.x + crop.w, py: crop.y + crop.h, x: q(r.maxX), y: q(r.minY) },
    uniform: false,
  }
}

/** Accepts the current pin format or the pre-0.2 per-axis anchors. */
export function normalizeCalib(c: unknown, width = 1000, height = 1000, bounds?: Bounds): Calibration {
  const o = c as Partial<Calibration & LegacyCalibration> | null | undefined
  const pin = (p: Partial<CalibPin> | undefined): CalibPin | null =>
    p && [p.px, p.py, p.x, p.y].every((v) => typeof v === 'number' && Number.isFinite(v)) ? (p as CalibPin) : null
  const a = pin(o?.a)
  const b = pin(o?.b)
  if (a && b) return { a: { ...a }, b: { ...b }, uniform: !!o!.uniform }
  if (o?.x1 && o.x2 && o.y1 && o.y2) {
    return {
      a: { px: o.x1.px, py: o.y1.px, x: o.x1.w, y: o.y1.w },
      b: { px: o.x2.px, py: o.y2.px, x: o.x2.w, y: o.y2.w },
      uniform: false,
    }
  }
  return calibrationForBounds(width, height, bounds ?? { minX: -100, maxX: 100, minY: -100, maxY: 100 })
}

// ── Prompt context ──────────────────────────────────────────────────────────

export function buildContext(
  profile: WorldProfile | null,
  chat: ChatMapState | null,
  settings: Pick<Settings, 'nearbyCount' | 'askReport'>,
): string {
  if (!profile || !chat?.pos) return ''
  const { x, y } = chat.pos
  const where = locate(profile, x, y)
  const lines: string[] = [`[Map: ${profile.name}]`]
  const place = [where.zone && `zone ${where.zone.name}`, where.region && `region ${where.region.name}`]
    .filter(Boolean)
    .join(', ')
  lines.push(`Current position: ${formatCoord(x, y, 1)}${place ? ` (${place})` : ''}.`)

  const near = nearest(profile, x, y, settings.nearbyCount)
  if (near.length) {
    const parts = near.map((n) => (n.units < 0.5 ? `${n.poi.name} (here)` : `${n.poi.name} ${formatKm(n.km)} ${n.dir}`))
    lines.push(`Nearby: ${parts.join('; ')}.`)
  }

  if (chat.dest) {
    const d = chat.dest
    const km = distanceUnits(x, y, d.x, d.y) * profile.unitKm
    lines.push(`Destination: ${d.name} ${formatCoord(d.x, d.y)}, ${formatKm(km)} ${compass(bearing(x, y, d.x, d.y))}.`)
  }

  lines.push(`Scale: 1 unit = ${profile.unitKm} km; +X east, +Y north.`)
  if (settings.askReport) {
    lines.push(
      'When the travelling party moves to a new location, append <map-pos>x,y</map-pos> with the new coordinates at the very end of the reply. Omit it otherwise.',
    )
  }
  return lines.join('\n')
}

/** Accepts "x,y", "[x, y]", "x y" or attributes. */
export function parsePosText(text: string): { x: number; y: number } | null {
  const m = /(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/.exec(text)
  if (!m) return null
  const x = Number(m[1])
  const y = Number(m[2])
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

export function findPosTag(content: string): { x: number; y: number } | null {
  const re = /<map-pos(?:\s+x\s*=\s*"(-?[\d.]+)"\s+y\s*=\s*"(-?[\d.]+)")?\s*(?:\/>|>([\s\S]*?)<\/map-pos>)/gi
  let last: { x: number; y: number } | null = null
  for (let m = re.exec(content); m; m = re.exec(content)) {
    const hit = m[1] !== undefined ? parsePosText(`${m[1]},${m[2]}`) : parsePosText(m[3] ?? '')
    if (hit) last = hit
  }
  return last
}

import {
  FEATURE_TYPES,
  LAYER_ORDER,
  featureBounds,
  newFeatureId,
  pointInRings,
  segmentDistance,
  simplify,
} from '../shared/features'
import type { Bounds, Feature, FeatureGeom, FeatureLayer, LayerSettings, Ring, WorldProfile } from '../shared/types'
import { drawPeak, hasSymbols, hash01, hashString, hill, paintArea } from './terrain'

// Renders the vector layers and edits them: select, move, scale/stretch with
// handles, drag/insert/delete vertices, and draw new areas, lines and spots.

export type VectorTool = 'vselect' | 'varea' | 'vline' | 'vspot'

export const isVectorTool = (t: string): t is VectorTool => t === 'vselect' || t === 'varea' || t === 'vline' || t === 'vspot'

export interface VectorHost {
  profile(): WorldProfile | null
  toScreen(x: number, y: number): { x: number; y: number }
  toWorld(sx: number, sy: number): { x: number; y: number }
  /** Screen pixels per world unit. */
  scale(): number
  settings(layer: FeatureLayer): LayerSettings
  labels(): boolean
  invalidate(): void
  /** The whole feature list after an edit. `move` while dragging, `end` once done. */
  emit(next: Feature[], phase: 'move' | 'end'): void
  onSelection(ids: string[]): void
  warn(message: string): void
  /**
   * Snap a world point: to a nearby place or shape point, else to whole steps.
   * Ctrl (or Cmd) held turns snapping off; `exclude` skips the shapes being edited.
   */
  snap(x: number, y: number, mods: { ctrlKey: boolean; metaKey: boolean }, exclude?: Set<string>): { x: number; y: number }
}

type Mods = { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

interface Colors {
  bg: string
  text: string
  primary: string
  accent: string
}

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const HANDLE_CURSOR: Record<Handle, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' }

export const WATER = '#24495c'

const AREA_FILL: Record<string, string> = {
  land: '#cdb98a',
  lake: WATER,
  contour: '#a08a5c',
  forest: '#3f7a3e',
  pine: '#2f5e3a',
  jungle: '#2c6a46',
  grassland: '#9fbf6a',
  desert: '#e3c27a',
  snow: '#eef2f4',
  swamp: '#5d6e4a',
  volcanic: '#5e4038',
  hills: '#b39b6b',
}
const AREA_STROKE: Record<string, string> = { land: '#5b4a2c', lake: '#2f5b6e', contour: '#7a5d3a' }
const LINE_STYLE: Record<string, { color: string; width: number; dash?: number[] }> = {
  mountains: { color: '#4a3b2a', width: 2.5 },
  hills: { color: '#6b5636', width: 2 },
  river: { color: '#4f9ed8', width: 2.5 },
  road: { color: '#a07850', width: 1.6, dash: [6, 4] },
  coast: { color: '#3b2f1d', width: 1.6 },
  contour: { color: '#7a5d3a', width: 1.1 },
  wall: { color: '#8b8b8b', width: 3 },
}

/** Elevation colour ramp: lowland green → highland brown → snowcap. */
function elevationColor(e: number, max: number): string {
  const t = max > 0 ? Math.max(0, Math.min(1, e / max)) : 0
  const stops: [number, [number, number, number]][] = [
    [0, [126, 168, 98]],
    [0.45, [196, 174, 112]],
    [0.75, [140, 104, 72]],
    [1, [236, 236, 236]],
  ]
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]
      const [t1, c1] = stops[i]
      const k = (t - t0) / (t1 - t0)
      return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * k)).join(',')})`
    }
  }
  return 'rgb(236,236,236)'
}

export class VectorEditor {
  selection = new Set<string>()
  drawLayer: FeatureLayer = 'landmass'
  drawType = 'land'
  /** When set, the next drawn area becomes a hole in this feature. */
  holeFor: string | null = null

  private draft: Ring | null = null
  private draftFreehand = false
  private cursor: { x: number; y: number } | null = null
  private hoverId: string | null = null
  private hoverVertex: { ri: number; vi: number } | null = null
  private drag: {
    mode: 'move' | 'scale' | 'vertex' | 'freehand'
    sx: number
    sy: number
    moved: boolean
    start: Feature[]
    world: { x: number; y: number }
    bounds?: Bounds
    handle?: Handle
    ri?: number
    vi?: number
    last?: { x: number; y: number }
    /** The selected point nearest the press, which snaps when moving. */
    ref?: [number, number]
  } | null = null

  constructor(private host: VectorHost) {}

  private features(): Feature[] {
    return this.host.profile()?.features ?? []
  }

  private visible(f: Feature): boolean {
    return !f.hidden && this.host.settings(f.layer).visible
  }

  private editable(f: Feature): boolean {
    return this.visible(f) && !this.host.settings(f.layer).locked
  }

  setSelection(ids: string[]): void {
    this.selection = new Set(ids)
    this.hoverVertex = null
    this.host.invalidate()
  }

  private select(ids: string[]): void {
    this.setSelection(ids)
    this.host.onSelection(ids)
  }

  /** Drop the drawing in progress. Returns true if there was one. */
  cancel(): boolean {
    const had = !!this.draft
    this.draft = null
    this.drag = null
    this.host.invalidate()
    return had
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /** Selection, handles and the drawing in progress, drawn above everything else. */
  drawOverlay(g: CanvasRenderingContext2D, c: Colors, tool: string): void {
    if (isVectorTool(tool)) this.drawEditing(g, c, tool)
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, c: Colors): void {
    const fs = this.features()
    const p = this.host.profile()
    if (!p) return
    const maxElev = Math.max(0, ...fs.filter((f) => f.layer === 'topography').map((f) => f.elevation ?? 0))
    for (const layer of LAYER_ORDER) {
      const st = this.host.settings(layer)
      if (!st.visible) continue
      const items = fs.filter((f) => f.layer === layer && !f.hidden)
      if (!items.length) continue
      g.save()
      g.globalAlpha = st.opacity
      if (layer === 'landmass' && items.some((f) => f.geom === 'area' && f.type === 'land')) {
        // Ocean behind the land.
        g.fillStyle = WATER
        g.fillRect(0, 0, w, h)
      }
      for (const f of items) this.drawFeature(g, f, maxElev, c, w, h)
      g.restore()
    }
    if (this.host.labels()) this.drawLabels(g, fs, c)
  }

  private path(g: CanvasRenderingContext2D, ring: Ring, closed: boolean, smooth: boolean): void {
    const pts = ring.map(([x, y]) => this.host.toScreen(x, y))
    if (!pts.length) return
    if (!smooth || pts.length < 3) {
      g.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y)
      if (closed) g.closePath()
      return
    }
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    if (closed) {
      const start = mid(pts[pts.length - 1], pts[0])
      g.moveTo(start.x, start.y)
      for (let i = 0; i < pts.length; i++) {
        const m = mid(pts[i], pts[(i + 1) % pts.length])
        g.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y)
      }
      g.closePath()
    } else {
      g.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length - 1; i++) {
        const m = mid(pts[i], pts[i + 1])
        g.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y)
      }
      g.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y)
    }
  }

  private drawFeature(g: CanvasRenderingContext2D, f: Feature, maxElev: number, c: Colors, viewW: number, viewH: number): void {
    const smooth = !!f.smooth
    if (f.geom === 'area') {
      g.beginPath()
      for (const r of f.rings) this.path(g, r, true, smooth)
      const fill = f.color ?? (f.layer === 'topography' ? elevationColor(f.elevation ?? 0, maxElev) : (AREA_FILL[f.type] ?? '#9a9a9a'))
      g.fillStyle = fill
      // Areas with symbols get a lighter ground tint so the trees, hills or dunes carry them.
      const symbols = hasSymbols(f)
      const alpha = f.layer !== 'terrain' ? 1 : symbols ? 0.4 : 0.75
      g.globalAlpha *= alpha
      g.fill('evenodd')
      g.globalAlpha /= alpha
      if (!symbols) {
        g.strokeStyle = AREA_STROKE[f.type] ?? fill
        g.lineWidth = f.layer === 'landmass' ? 1.6 : 1
        g.stroke()
      }
      if (symbols) paintArea(g, f, this.host, viewW, viewH)
    } else if (f.geom === 'line') {
      const st = LINE_STYLE[f.type] ?? { color: f.color ?? c.text, width: 2 }
      if (f.type === 'mountains' || f.type === 'hills') {
        this.mountainRange(g, f, f.color ?? st.color)
        return
      }
      g.beginPath()
      this.path(g, f.rings[0], false, smooth)
      g.strokeStyle = f.color ?? st.color
      g.lineWidth = st.width
      g.lineCap = 'round'
      g.lineJoin = 'round'
      g.setLineDash(st.dash ?? [])
      g.stroke()
      g.setLineDash([])
    } else {
      const s = this.host.toScreen(f.rings[0][0][0], f.rings[0][0][1])
      this.glyph(g, f.type, s.x, s.y, 9 * (f.size ?? 1), f.color, c)
    }
  }

  /**
   * A mountain range: a band of overlapping, shaded peaks along the ridge line,
   * tallest along the crest and toward the middle of the range. Peaks have a real
   * size in world units (Size scales it), so zooming in shows a wide range rather
   * than a row of ticks; zoomed far out they thin out instead of shrinking to dust.
   * Jitter comes from the feature id, so peaks hold still while panning.
   */
  private mountainRange(g: CanvasRenderingContext2D, f: Feature, ink: string): void {
    const ring = f.rings[0]
    if (ring.length < 2) return
    const k = this.host.scale()
    const size = f.size ?? 1
    const hills = f.type === 'hills'
    const base = (hills ? 6.5 : 6.1) * size
    let step = base
    while (step * k < 9) step *= 2
    const w = step * k
    const rows = step === base ? [0, -1, 1, -2, 2] : [0, -1, 1]
    const lens = [0]
    for (let i = 1; i < ring.length; i++) lens.push(lens[i - 1] + Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]))
    const total = lens[lens.length - 1]
    if (total <= 0) return
    const seed = hashString(f.id)
    const rnd = (i: number, row: number, salt: number) => hash01(seed, i * 7 + row + 3, salt)
    const peaks: { x: number; y: number; h: number; b: number; lean: number }[] = []
    const count = Math.max(1, Math.round(total / step))
    let seg = 1
    for (let i = 0; i < count; i++) {
      const s = ((i + 0.5) / count) * total
      while (seg < ring.length - 1 && lens[seg] < s) seg++
      const [x0, y0] = ring[seg - 1]
      const [x1, y1] = ring[seg]
      const t = (s - lens[seg - 1]) / (lens[seg] - lens[seg - 1] || 1)
      const p = this.host.toScreen(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
      const q = this.host.toScreen(x1, y1)
      const o = this.host.toScreen(x0, y0)
      const len = Math.hypot(q.x - o.x, q.y - o.y) || 1
      const tx = (q.x - o.x) / len
      const ty = (q.y - o.y) / len
      const crest = Math.sin((Math.PI * s) / total)
      for (const row of rows) {
        const off = Math.abs(row)
        if (off && rnd(i, row, 0) < (off === 1 ? 0.2 : 0.45)) continue
        const along = (rnd(i, row, 1) - 0.5) * w * 0.7
        const across = row * w * (0.5 + rnd(i, row, 2) * 0.25)
        const h = w * (off === 0 ? 1.05 + crest * 0.55 : off === 1 ? 0.75 + crest * 0.3 : 0.55 + crest * 0.15) * (0.8 + rnd(i, row, 3) * 0.45)
        peaks.push({
          x: p.x + tx * along - ty * across,
          y: p.y + ty * along + tx * across,
          h,
          b: h * (0.72 + rnd(i, row, 4) * 0.3),
          lean: (rnd(i, row, 5) - 0.5) * 0.4,
        })
      }
    }
    peaks.sort((a, b) => a.y - b.y)
    g.save()
    g.lineJoin = 'round'
    g.lineCap = 'round'
    g.lineWidth = Math.max(0.8, Math.min(2, w / 14))
    if (hills) peaks.forEach((pk, n) => hill(g, pk.x, pk.y, pk.b * 1.35, (salt) => hash01(seed, n, salt + 11)))
    else for (const pk of peaks) this.peak(g, pk.x, pk.y, pk.h, pk.b, pk.lean, pk.h > w * 1.35, ink)
    g.restore()
  }

  /** One peak: sunlit west face, shaded east face, a crease, and a snowcap on the tall ones. */
  private peak(g: CanvasRenderingContext2D, x: number, y: number, h: number, b: number, lean: number, snow: boolean, ink: string): void {
    drawPeak(g, x, y, h, b, lean, snow, ink)
  }

  /** Built-in symbols for spot features. */
  private glyph(g: CanvasRenderingContext2D, type: string, x: number, y: number, r: number, color: string | undefined, c: Colors): void {
    g.save()
    g.lineWidth = 1.5
    g.strokeStyle = 'rgba(20,20,20,0.85)'
    const fill = (col: string) => {
      g.fillStyle = color ?? col
      g.fill()
      g.stroke()
    }
    g.beginPath()
    switch (type) {
      case 'volcano':
        g.moveTo(x - r, y + r * 0.7)
        g.lineTo(x - r * 0.25, y - r * 0.7)
        g.lineTo(x + r * 0.25, y - r * 0.7)
        g.lineTo(x + r, y + r * 0.7)
        g.closePath()
        fill('#6e4a3a')
        g.beginPath()
        g.arc(x, y - r * 0.85, r * 0.3, 0, Math.PI * 2)
        g.fillStyle = '#ff6a2a'
        g.fill()
        break
      case 'peak':
        g.moveTo(x - r, y + r * 0.7)
        g.lineTo(x, y - r * 0.8)
        g.lineTo(x + r, y + r * 0.7)
        g.closePath()
        fill('#8a7356')
        break
      case 'oasis':
        g.arc(x, y, r * 0.75, 0, Math.PI * 2)
        fill('#4fa8d8')
        g.beginPath()
        g.arc(x, y, r * 0.3, 0, Math.PI * 2)
        g.fillStyle = '#5c9a3c'
        g.fill()
        break
      case 'city':
        g.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6)
        fill('#c94f3d')
        break
      case 'town':
        g.rect(x - r * 0.55, y - r * 0.55, r * 1.1, r * 1.1)
        fill('#d9895b')
        break
      case 'castle': {
        const s = r * 0.8
        g.moveTo(x - s, y + s)
        g.lineTo(x - s, y - s)
        g.lineTo(x - s / 2, y - s)
        g.lineTo(x - s / 2, y - s / 2)
        g.lineTo(x, y - s / 2)
        g.lineTo(x, y - s)
        g.lineTo(x + s / 2, y - s)
        g.lineTo(x + s / 2, y - s / 2)
        g.lineTo(x + s, y - s / 2)
        g.lineTo(x + s, y + s)
        g.closePath()
        fill('#8f8f99')
        break
      }
      case 'tower':
        g.rect(x - r * 0.35, y - r, r * 0.7, r * 2)
        fill('#9a8f80')
        break
      case 'port':
        g.arc(x, y, r * 0.8, 0, Math.PI * 2)
        fill('#3d7fb8')
        g.beginPath()
        g.moveTo(x, y - r * 0.5)
        g.lineTo(x, y + r * 0.45)
        g.moveTo(x - r * 0.4, y + r * 0.15)
        g.quadraticCurveTo(x, y + r * 0.7, x + r * 0.4, y + r * 0.15)
        g.strokeStyle = '#fff'
        g.stroke()
        break
      case 'ruin':
        g.setLineDash([3, 2])
        g.rect(x - r * 0.75, y - r * 0.75, r * 1.5, r * 1.5)
        g.strokeStyle = color ?? '#7a6a55'
        g.lineWidth = 2
        g.stroke()
        break
      case 'temple':
        g.moveTo(x - r, y - r * 0.2)
        g.lineTo(x, y - r)
        g.lineTo(x + r, y - r * 0.2)
        g.closePath()
        g.rect(x - r * 0.7, y - r * 0.2, r * 1.4, r)
        fill('#e6dcc3')
        break
      case 'crystal':
        g.moveTo(x, y - r)
        g.lineTo(x + r * 0.55, y)
        g.lineTo(x, y + r)
        g.lineTo(x - r * 0.55, y)
        g.closePath()
        fill('#c46be0')
        break
      case 'camp':
        g.moveTo(x - r, y + r * 0.7)
        g.lineTo(x, y - r * 0.7)
        g.lineTo(x + r, y + r * 0.7)
        g.closePath()
        fill('#b58a4a')
        break
      default:
        g.arc(x, y, r * 0.6, 0, Math.PI * 2)
        fill(c.accent)
    }
    g.restore()
  }

  private drawLabels(g: CanvasRenderingContext2D, fs: Feature[], c: Colors): void {
    g.save()
    g.font = 'italic 500 11px system-ui, sans-serif'
    g.textAlign = 'center'
    g.lineJoin = 'round'
    for (const f of fs) {
      if (!f.name || !this.visible(f)) continue
      let at: { x: number; y: number }
      if (f.geom === 'spot') {
        const s = this.host.toScreen(f.rings[0][0][0], f.rings[0][0][1])
        at = { x: s.x, y: s.y + 9 * (f.size ?? 1) + 12 }
      } else if (f.geom === 'line') {
        const r = f.rings[0]
        const m = r[Math.floor(r.length / 2)]
        const s = this.host.toScreen(m[0], m[1])
        at = { x: s.x, y: s.y - 10 }
      } else {
        const b = featureBounds([f])!
        at = this.host.toScreen((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2)
      }
      g.lineWidth = 3
      g.strokeStyle = c.bg
      g.fillStyle = c.text
      g.strokeText(f.name, at.x, at.y)
      g.fillText(f.name, at.x, at.y)
    }
    g.restore()
  }

  private selectionBoundsScreen(): { x0: number; y0: number; x1: number; y1: number } | null {
    const b = featureBounds(this.features().filter((f) => this.selection.has(f.id)))
    if (!b) return null
    const a = this.host.toScreen(b.minX, b.maxY)
    const z = this.host.toScreen(b.maxX, b.minY)
    return { x0: Math.min(a.x, z.x), y0: Math.min(a.y, z.y), x1: Math.max(a.x, z.x), y1: Math.max(a.y, z.y) }
  }

  private handles(): { h: Handle; x: number; y: number }[] {
    const r = this.selectionBoundsScreen()
    if (!r || (r.x1 - r.x0 < 4 && r.y1 - r.y0 < 4)) return []
    const mx = (r.x0 + r.x1) / 2
    const my = (r.y0 + r.y1) / 2
    return [
      { h: 'nw', x: r.x0, y: r.y0 },
      { h: 'ne', x: r.x1, y: r.y0 },
      { h: 'sw', x: r.x0, y: r.y1 },
      { h: 'se', x: r.x1, y: r.y1 },
      { h: 'n', x: mx, y: r.y0 },
      { h: 's', x: mx, y: r.y1 },
      { h: 'w', x: r.x0, y: my },
      { h: 'e', x: r.x1, y: my },
    ]
  }

  private single(): Feature | null {
    if (this.selection.size !== 1) return null
    const id = [...this.selection][0]
    return this.features().find((f) => f.id === id) ?? null
  }

  private showVertices(f: Feature | null): f is Feature {
    return !!f && f.geom !== 'spot' && f.rings.reduce((n, r) => n + r.length, 0) <= 4000
  }

  private drawEditing(g: CanvasRenderingContext2D, c: Colors, tool: string): void {
    const fs = this.features()
    g.save()
    // Hover and selection outlines.
    for (const f of fs) {
      const sel = this.selection.has(f.id)
      if (!sel && f.id !== this.hoverId) continue
      g.beginPath()
      if (f.geom === 'spot') {
        const s = this.host.toScreen(f.rings[0][0][0], f.rings[0][0][1])
        g.arc(s.x, s.y, 9 * (f.size ?? 1) + 5, 0, Math.PI * 2)
      } else for (const r of f.rings) this.path(g, r, f.geom === 'area', !!f.smooth)
      g.strokeStyle = c.primary
      g.lineWidth = sel ? 2.5 : 1.5
      g.setLineDash(sel ? [] : [4, 3])
      g.stroke()
    }
    g.setLineDash([])
    if (tool === 'vselect') {
      const r = this.selectionBoundsScreen()
      const hs = this.handles()
      if (r && hs.length) {
        g.strokeStyle = c.primary
        g.lineWidth = 1
        g.setLineDash([5, 4])
        g.strokeRect(r.x0 - 0.5, r.y0 - 0.5, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1)
        g.setLineDash([])
        for (const hd of hs) {
          g.beginPath()
          g.rect(hd.x - 4.5, hd.y - 4.5, 9, 9)
          g.fillStyle = this.drag?.handle === hd.h ? c.primary : '#fff'
          g.fill()
          g.strokeStyle = c.primary
          g.stroke()
        }
      }
      const one = this.single()
      if (this.showVertices(one)) {
        for (let ri = 0; ri < one.rings.length; ri++) {
          one.rings[ri].forEach(([x, y], vi) => {
            const s = this.host.toScreen(x, y)
            const hot = this.hoverVertex?.ri === ri && this.hoverVertex.vi === vi
            g.beginPath()
            g.arc(s.x, s.y, hot ? 5 : 3, 0, Math.PI * 2)
            g.fillStyle = hot ? c.primary : '#fff'
            g.fill()
            g.strokeStyle = c.primary
            g.lineWidth = 1.2
            g.stroke()
          })
        }
      }
    }
    // Drawing in progress.
    if (this.draft?.length) {
      const pts = this.draft.map(([x, y]) => this.host.toScreen(x, y))
      g.beginPath()
      g.moveTo(pts[0].x, pts[0].y)
      for (const p of pts.slice(1)) g.lineTo(p.x, p.y)
      if (this.cursor && !this.drag) g.lineTo(this.cursor.x, this.cursor.y)
      if (tool === 'varea' && pts.length > 2) g.closePath()
      g.strokeStyle = c.primary
      g.lineWidth = 2
      g.stroke()
      if (tool === 'varea' && pts.length > 2) {
        g.fillStyle = c.primary
        g.globalAlpha = 0.12
        g.fill()
        g.globalAlpha = 1
      }
      pts.forEach((p, i) => {
        if (pts.length > 60 && i % Math.ceil(pts.length / 60) !== 0 && i !== 0) return
        g.beginPath()
        g.arc(p.x, p.y, i === 0 ? 5 : 3, 0, Math.PI * 2)
        g.fillStyle = i === 0 ? c.primary : '#fff'
        g.fill()
        g.strokeStyle = c.primary
        g.stroke()
      })
    }
    g.restore()
  }

  // ── Hit testing ───────────────────────────────────────────────────────────

  private screenRing(r: Ring): { x: number; y: number }[] {
    return r.map(([x, y]) => this.host.toScreen(x, y))
  }

  private nearRing(pts: { x: number; y: number }[], sx: number, sy: number, closed: boolean, tol: number): boolean {
    const n = closed ? pts.length : pts.length - 1
    for (let i = 0; i < n; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      if (segmentDistance(sx, sy, a.x, a.y, b.x, b.y).d <= tol) return true
    }
    return false
  }

  /** Topmost editable feature under a screen point. */
  featureAt(sx: number, sy: number, includeLocked = false): Feature | null {
    const fs = this.features()
    const world = this.host.toWorld(sx, sy)
    for (const layer of [...LAYER_ORDER].reverse()) {
      const st = this.host.settings(layer)
      if (!st.visible || (st.locked && !includeLocked)) continue
      // Spots and lines first: they sit on top of areas visually.
      for (const geom of ['spot', 'line', 'area'] as FeatureGeom[]) {
        for (let i = fs.length - 1; i >= 0; i--) {
          const f = fs[i]
          if (f.layer !== layer || f.geom !== geom || f.hidden) continue
          if (geom === 'spot') {
            const s = this.host.toScreen(f.rings[0][0][0], f.rings[0][0][1])
            if (Math.hypot(s.x - sx, s.y - sy) <= 9 * (f.size ?? 1) + 3) return f
          } else if (geom === 'line') {
            if (this.nearRing(this.screenRing(f.rings[0]), sx, sy, false, 7)) return f
          } else if (pointInRings(world.x, world.y, f.rings) || f.rings.some((r) => this.nearRing(this.screenRing(r), sx, sy, true, 4))) return f
        }
      }
    }
    return null
  }

  private vertexAt(f: Feature, sx: number, sy: number): { ri: number; vi: number } | null {
    let best: { ri: number; vi: number } | null = null
    let bestD = 8
    f.rings.forEach((r, ri) =>
      r.forEach(([x, y], vi) => {
        const s = this.host.toScreen(x, y)
        const d = Math.hypot(s.x - sx, s.y - sy)
        if (d < bestD) (bestD = d), (best = { ri, vi })
      }),
    )
    return best
  }

  private handleAt(sx: number, sy: number): Handle | null {
    for (const hd of this.handles()) if (Math.abs(hd.x - sx) <= 7 && Math.abs(hd.y - sy) <= 7) return hd.h
    return null
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private worldPt(sx: number, sy: number, mods?: Mods, exclude?: Set<string>): [number, number] {
    let w = this.host.toWorld(sx, sy)
    if (mods) w = this.host.snap(w.x, w.y, mods, exclude)
    return [Math.round(w.x * 100) / 100, Math.round(w.y * 100) / 100]
  }

  /** Shift while drawing: the new point lies on a 15° line from the previous one. */
  private constrain(pt: [number, number], mods: Mods): [number, number] {
    const last = this.draft?.[this.draft.length - 1]
    if (!last || !mods.shiftKey) return pt
    const dx = pt[0] - last[0]
    const dy = pt[1] - last[1]
    const len = Math.hypot(dx, dy)
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12)
    return [Math.round((last[0] + Math.cos(a) * len) * 100) / 100, Math.round((last[1] + Math.sin(a) * len) * 100) / 100]
  }

  private replace(next: Feature[]): Feature[] {
    const byId = new Map(next.map((f) => [f.id, f]))
    return this.features().map((f) => byId.get(f.id) ?? f)
  }

  private canDraw(): boolean {
    if (this.host.settings(this.drawLayer).locked) {
      this.host.warn(`${this.drawLayer} layer is locked.`)
      return false
    }
    return true
  }

  /** Returns true when the vector editor took the press (no panning). */
  pointerDown(tool: VectorTool, sx: number, sy: number, e: PointerEvent): boolean {
    const world = this.host.toWorld(sx, sy)
    const base = { sx, sy, moved: false, world, start: [] as Feature[] }
    if (tool === 'varea' || tool === 'vline') {
      if (!this.canDraw()) return false
      const pt = this.constrain(this.worldPt(sx, sy, e), e)
      if (!this.draft) {
        this.draft = [pt]
        this.draftFreehand = false
      } else {
        const first = this.host.toScreen(this.draft[0][0], this.draft[0][1])
        if (tool === 'varea' && this.draft.length >= 3 && Math.hypot(first.x - sx, first.y - sy) < 10) {
          this.finish(tool)
          return true
        }
        this.draft.push(pt)
      }
      this.drag = { ...base, mode: 'freehand', last: { x: sx, y: sy } }
      this.host.invalidate()
      return true
    }
    if (tool !== 'vselect') return false
    const handle = this.selection.size ? this.handleAt(sx, sy) : null
    if (handle) {
      const sel = this.features().filter((f) => this.selection.has(f.id))
      this.drag = { ...base, mode: 'scale', handle, start: structuredClone(sel), bounds: featureBounds(sel)! }
      return true
    }
    const one = this.single()
    if (one && this.editable(one) && this.showVertices(one)) {
      const v = this.vertexAt(one, sx, sy)
      if (v) {
        if (e.altKey) {
          this.deleteVertex(one, v.ri, v.vi)
          return true
        }
        this.drag = { ...base, mode: 'vertex', start: [structuredClone(one)], ri: v.ri, vi: v.vi }
        return true
      }
    }
    const hit = this.featureAt(sx, sy)
    if (!hit) {
      if (!e.shiftKey && this.selection.size) this.select([])
      return false
    }
    if (e.shiftKey) {
      const ids = new Set(this.selection)
      if (ids.has(hit.id)) ids.delete(hit.id)
      else ids.add(hit.id)
      this.select([...ids])
      return true
    }
    if (!this.selection.has(hit.id)) this.select([hit.id])
    const sel = this.features().filter((f) => this.selection.has(f.id))
    let ref: [number, number] | undefined
    let best = Infinity
    for (const f of sel) for (const r of f.rings) for (const q of r) {
      const dd = Math.hypot(q[0] - world.x, q[1] - world.y)
      if (dd < best) (best = dd), (ref = [q[0], q[1]])
    }
    this.drag = { ...base, mode: 'move', start: structuredClone(sel), ref }
    return true
  }

  pointerMove(tool: string, sx: number, sy: number, e: PointerEvent): void {
    this.cursor = { x: sx, y: sy }
    const d = this.drag
    if (!d) {
      if (tool === 'vselect') {
        const one = this.single()
        this.hoverVertex = one && this.showVertices(one) ? this.vertexAt(one, sx, sy) : null
        this.hoverId = this.featureAt(sx, sy)?.id ?? null
      }
      if (this.draft) this.host.invalidate()
      else if (tool === 'vselect') this.host.invalidate()
      return
    }
    if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 3) return
    d.moved = true
    const w = this.host.toWorld(sx, sy)
    if (d.mode === 'freehand') {
      if (Math.hypot(sx - d.last!.x, sy - d.last!.y) >= 5) {
        this.draft!.push(this.worldPt(sx, sy))
        d.last = { x: sx, y: sy }
        this.draftFreehand = true
        this.host.invalidate()
      }
      return
    }
    let dx = w.x - d.world.x
    let dy = w.y - d.world.y
    const ids = new Set(d.start.map((f) => f.id))
    if (d.mode === 'move' && d.ref) {
      // Snap the point nearest the press, and move everything by the same amount.
      const t = this.host.snap(d.ref[0] + dx, d.ref[1] + dy, e, ids)
      dx = t.x - d.ref[0]
      dy = t.y - d.ref[1]
    } else if (d.mode === 'scale') {
      const b = d.bounds!
      const hd = d.handle!
      const hx = hd.includes('w') ? b.minX : hd.includes('e') ? b.maxX : null
      const hy = hd.includes('n') ? b.maxY : hd.includes('s') ? b.minY : null
      const t = this.host.snap((hx ?? 0) + dx, (hy ?? 0) + dy, e, ids)
      if (hx !== null) dx = t.x - hx
      if (hy !== null) dy = t.y - hy
    }
    let moved: Feature[] = []
    if (d.mode === 'move') {
      moved = d.start.map((f) => ({ ...f, rings: f.rings.map((r) => r.map(([x, y]) => [x + dx, y + dy] as [number, number])) }))
    } else if (d.mode === 'vertex') {
      const f = structuredClone(d.start[0])
      f.rings[d.ri!][d.vi!] = this.worldPt(sx, sy, e, ids)
      moved = [f]
    } else if (d.mode === 'scale') {
      const b = d.bounds!
      const hd = d.handle!
      let { minX, maxX, minY, maxY } = b
      if (hd.includes('w')) minX = Math.min(b.minX + dx, maxX - 1e-3)
      if (hd.includes('e')) maxX = Math.max(b.maxX + dx, minX + 1e-3)
      if (hd.includes('n')) maxY = Math.max(b.maxY + dy, minY + 1e-3)
      if (hd.includes('s')) minY = Math.min(b.minY + dy, maxY - 1e-3)
      const bw = b.maxX - b.minX || 1
      const bh = b.maxY - b.minY || 1
      let kx = (maxX - minX) / bw
      let ky = (maxY - minY) / bh
      if (hd.length === 1) {
        if (hd === 'n' || hd === 's') kx = 1
        else ky = 1
      } else if (e.shiftKey) {
        // Corner + Shift: keep the aspect ratio.
        const k = Math.max(kx, ky)
        kx = ky = k
      }
      // Scale about the opposite edge or corner (or the centre with Alt).
      const ax = e.altKey ? (b.minX + b.maxX) / 2 : hd.includes('w') ? b.maxX : b.minX
      const ay = e.altKey ? (b.minY + b.maxY) / 2 : hd.includes('n') ? b.minY : b.maxY
      moved = d.start.map((f) => ({
        ...f,
        rings: f.rings.map((r) => r.map(([x, y]) => [Math.round((ax + (x - ax) * kx) * 100) / 100, Math.round((ay + (y - ay) * ky) * 100) / 100] as [number, number])),
      }))
    }
    this.host.emit(this.replace(moved), 'move')
  }

  pointerUp(tool: string, sx: number, sy: number): boolean {
    const d = this.drag
    this.drag = null
    if (!d) return false
    if (d.mode === 'freehand') {
      if (this.draftFreehand && this.draft) {
        // Thin out a freehand stroke, then close it if it ended near the start.
        this.draft = simplify(this.draft, 1.2 / this.host.scale())
        const first = this.host.toScreen(this.draft[0][0], this.draft[0][1])
        if (tool === 'varea' && this.draft.length >= 3 && Math.hypot(first.x - sx, first.y - sy) < 14) this.finish(tool)
      }
      this.host.invalidate()
      return true
    }
    if (d.moved) this.host.emit(this.features(), 'end')
    return true
  }

  /** A click that didn't drag, for spot placement. */
  click(tool: string, sx: number, sy: number): boolean {
    if (tool !== 'vspot' || !this.canDraw()) return false
    const geomType = FEATURE_TYPES[this.drawLayer].find((t) => t.type === this.drawType && t.geom === 'spot') ?? FEATURE_TYPES[this.drawLayer].find((t) => t.geom === 'spot')
    if (!geomType) {
      this.host.warn('This layer has no spot types.')
      return true
    }
    const f: Feature = { id: newFeatureId(this.drawLayer), layer: this.drawLayer, geom: 'spot', type: geomType.type, rings: [[this.worldPt(sx, sy)]] }
    this.host.emit([...this.features(), f], 'end')
    this.select([f.id])
    return true
  }

  dblclick(tool: string, sx: number, sy: number): boolean {
    if ((tool === 'varea' || tool === 'vline') && this.draft) {
      // The double-click's presses added two vertices on the same spot.
      const last = this.draft.length - 1
      if (last > 0) {
        const a = this.host.toScreen(this.draft[last][0], this.draft[last][1])
        const b = this.host.toScreen(this.draft[last - 1][0], this.draft[last - 1][1])
        if (Math.hypot(a.x - b.x, a.y - b.y) < 6) this.draft.pop()
      }
      this.finish(tool)
      return true
    }
    if (tool === 'vselect') {
      const one = this.single()
      if (!one || !this.editable(one) || one.geom === 'spot') return false
      // Insert a vertex on the edge under the cursor.
      const pt = this.worldPt(sx, sy)
      for (let ri = 0; ri < one.rings.length; ri++) {
        const pts = this.screenRing(one.rings[ri])
        const n = one.geom === 'area' ? pts.length : pts.length - 1
        for (let i = 0; i < n; i++) {
          const a = pts[i]
          const b = pts[(i + 1) % pts.length]
          if (segmentDistance(sx, sy, a.x, a.y, b.x, b.y).d <= 7) {
            const f = structuredClone(one)
            f.rings[ri].splice(i + 1, 0, pt)
            this.host.emit(this.replace([f]), 'end')
            return true
          }
        }
      }
    }
    return false
  }

  key(tool: string, e: KeyboardEvent): boolean {
    if ((tool === 'varea' || tool === 'vline') && this.draft) {
      if (e.key === 'Enter') this.finish(tool)
      else if (e.key === 'Escape') this.cancel()
      else if (e.key === 'Backspace') {
        this.draft.pop()
        if (!this.draft.length) this.draft = null
        this.host.invalidate()
      } else return false
      return true
    }
    if (tool !== 'vselect') return false
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const one = this.single()
      if (one && this.hoverVertex && this.editable(one)) {
        this.deleteVertex(one, this.hoverVertex.ri, this.hoverVertex.vi)
        return true
      }
      return this.deleteSelected()
    }
    if (e.key === 'Escape' && this.selection.size) {
      this.select([])
      return true
    }
    return false
  }

  deleteSelected(): boolean {
    const ids = [...this.selection].filter((id) => {
      const f = this.features().find((q) => q.id === id)
      return f && this.editable(f)
    })
    if (!ids.length) return false
    this.host.emit(
      this.features().filter((f) => !ids.includes(f.id)),
      'end',
    )
    this.select([])
    return true
  }

  private deleteVertex(f: Feature, ri: number, vi: number): void {
    const min = f.geom === 'area' ? 3 : 2
    const next = structuredClone(f)
    next.rings[ri].splice(vi, 1)
    if (next.rings[ri].length < min) {
      if (ri === 0) return this.host.warn('A shape needs at least ' + min + ' points.')
      next.rings.splice(ri, 1) // a hole that's too small goes away
    }
    this.hoverVertex = null
    this.host.emit(this.replace([next]), 'end')
  }

  private finish(tool: string): void {
    const pts = this.draft
    this.draft = null
    if (!pts) return
    const geom: FeatureGeom = tool === 'varea' ? 'area' : 'line'
    if (pts.length < (geom === 'area' ? 3 : 2)) {
      this.host.invalidate()
      return
    }
    const fs = this.features()
    const holeTarget = geom === 'area' && this.holeFor ? fs.find((f) => f.id === this.holeFor && f.geom === 'area') : null
    if (holeTarget) {
      const f = structuredClone(holeTarget)
      f.rings.push(pts)
      this.holeFor = null
      this.host.emit(this.replace([f]), 'end')
      this.select([f.id])
      return
    }
    const typeDef = FEATURE_TYPES[this.drawLayer].find((t) => t.type === this.drawType && t.geom === geom) ?? FEATURE_TYPES[this.drawLayer].find((t) => t.geom === geom)
    if (!typeDef) {
      this.host.warn(`The ${this.drawLayer} layer has no ${geom} types.`)
      this.host.invalidate()
      return
    }
    const f: Feature = { id: newFeatureId(this.drawLayer), layer: this.drawLayer, geom, type: typeDef.type, rings: [pts], ...(this.draftFreehand ? { smooth: true } : {}) }
    this.host.emit([...fs, f], 'end')
    this.select([f.id])
  }

  cursorFor(tool: string, sx: number, sy: number): string | null {
    if (tool === 'varea' || tool === 'vline' || tool === 'vspot') return 'crosshair'
    if (tool !== 'vselect') return null
    if (this.drag?.mode === 'move') return 'move'
    const hd = this.selection.size ? this.handleAt(sx, sy) : null
    if (hd) return HANDLE_CURSOR[hd]
    if (this.hoverVertex) return 'pointer'
    return this.hoverId ? 'move' : null
  }
}

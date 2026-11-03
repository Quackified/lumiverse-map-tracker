import {
  bearing,
  compass,
  distanceUnits,
  formatCoord,
  formatKm,
  imageToWorld,
  locate,
  nearest,
  worldToImage,
  zoneRect,
} from '../shared/geo'
import type { Bounds, ChatMapState, Poi, Rect, WorldProfile, Zone } from '../shared/types'
import { clear, h, hueOf } from './dom'

export type Tool = 'pan' | 'me' | 'dest' | 'add' | 'measure' | 'crop' | 'zone' | 'calib'

export interface Layers {
  image: boolean
  grid: boolean
  regions: boolean
  zones: boolean
  points: boolean
  labels: boolean
  trail: boolean
}

export const DEFAULT_LAYERS: Layers = {
  image: true,
  grid: true,
  regions: true,
  zones: true,
  points: true,
  labels: true,
  trail: true,
}

export interface MapHooks {
  /** Click with a placement tool (me/dest/add/calib). */
  onPick(tool: Tool, x: number, y: number): void
  /** Finished dragging a rectangle with crop/zone tool (world coords). */
  onRect(tool: Tool, r: Bounds): void
  onSelectPoi(poi: Poi | null): void
  onContextMenu(x: number, y: number, poi: Poi | null, clientX: number, clientY: number): void
  onToolDone(): void
}

interface View {
  cx: number
  cy: number
  /** Screen pixels per world unit. */
  s: number
}

interface Theme {
  bg: string
  text: string
  muted: string
  grid: string
  primary: string
  accent: string
  danger: string
}

const MIN_S = 0.02
const MAX_S = 400

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p
  return 10 * p
}

function fmtTick(v: number, step: number): string {
  const digits = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)))
  const s = v.toFixed(digits)
  return s === '-0' ? '0' : s
}

export class MapView {
  readonly el: HTMLDivElement
  private canvas: HTMLCanvasElement
  private rx: HTMLCanvasElement
  private ry: HTMLCanvasElement
  private readout: HTMLDivElement
  private g: CanvasRenderingContext2D
  private gx: CanvasRenderingContext2D
  private gy: CanvasRenderingContext2D

  profile: WorldProfile | null = null
  chat: ChatMapState | null = null
  image: HTMLImageElement | null = null
  layers: Layers = { ...DEFAULT_LAYERS }
  tool: Tool = 'pan'
  selectedId: string | null = null

  private view: View = { cx: 0, cy: 0, s: 1 }
  private w = 0
  private hgt = 0
  private dpr = 1
  private hover: { x: number; y: number; sx: number; sy: number } | null = null
  private hoverPoi: Poi | null = null
  private measure: { a: { x: number; y: number }; b: { x: number; y: number } | null } | null = null
  private dragRect: { a: { x: number; y: number }; b: { x: number; y: number } } | null = null
  private pointers = new Map<number, { x: number; y: number }>()
  private gesture: { mode: 'pan' | 'rect' | 'pinch' | 'none'; sx: number; sy: number; moved: boolean; view: View; dist: number; mid: { x: number; y: number } } | null = null
  private raf = 0
  private theme: Theme | null = null
  private ro: ResizeObserver
  private hasView = false

  constructor(
    private hooks: MapHooks,
    rulerX: HTMLCanvasElement,
    rulerY: HTMLCanvasElement,
  ) {
    this.canvas = h('canvas', { class: 'mt-canvas' })
    this.readout = h('div', { class: 'mt-readout' })
    this.el = h('div', { class: 'mt-stage', tabindex: '0', dataset: { tool: 'pan' } }, this.canvas, this.readout)
    this.rx = rulerX
    this.ry = rulerY
    this.g = this.canvas.getContext('2d')!
    this.gx = rulerX.getContext('2d')!
    this.gy = rulerY.getContext('2d')!

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(this.el)
    this.bind()
  }

  destroy(): void {
    this.ro.disconnect()
    cancelAnimationFrame(this.raf)
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setProfile(p: WorldProfile | null): void {
    const changed = p?.id !== this.profile?.id
    this.profile = p
    if (changed) {
      this.hasView = false
      this.image = null
      this.measure = null
    }
    if (!this.hasView) this.fit()
    this.invalidate()
  }

  setChat(c: ChatMapState | null): void {
    this.chat = c
    this.invalidate()
  }

  setImage(img: HTMLImageElement | null): void {
    this.image = img
    this.invalidate()
  }

  setTool(t: Tool): void {
    this.tool = t
    this.measure = t === 'measure' ? this.measure : null
    this.dragRect = null
    this.el.dataset.tool = t
    this.invalidate()
  }

  setTheme(): void {
    this.theme = null
    this.invalidate()
  }

  fit(): void {
    if (!this.profile || !this.w || !this.hgt) return
    const b = this.imageVisible() ? this.imageWorldRect()! : this.profile.bounds
    const s = Math.min(this.w / (b.maxX - b.minX), this.hgt / (b.maxY - b.minY)) * 0.96
    this.view = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, s: Math.max(MIN_S, Math.min(MAX_S, s)) }
    this.hasView = true
    this.invalidate()
  }

  zoomBy(f: number, sx = this.w / 2, sy = this.hgt / 2): void {
    const before = this.toWorld(sx, sy)
    this.view.s = Math.max(MIN_S, Math.min(MAX_S, this.view.s * f))
    const after = this.toWorld(sx, sy)
    this.view.cx += before.x - after.x
    this.view.cy += before.y - after.y
    this.invalidate()
  }

  centerOn(x: number, y: number, minScale?: number): void {
    this.view.cx = x
    this.view.cy = y
    if (minScale && this.view.s < minScale) this.view.s = minScale
    this.invalidate()
  }

  /** Scale that comfortably shows ~1/8 of the profile width. */
  focusScale(): number {
    if (!this.profile || !this.w) return this.view.s
    return (this.w / (this.profile.bounds.maxX - this.profile.bounds.minX)) * 4
  }

  invalidate(): void {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.draw()
    })
  }

  // ── Coordinates ───────────────────────────────────────────────────────────

  toScreen(x: number, y: number): { x: number; y: number } {
    const v = this.view
    return { x: (x - v.cx) * v.s + this.w / 2, y: this.hgt / 2 - (y - v.cy) * v.s }
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    const v = this.view
    return { x: (sx - this.w / 2) / v.s + v.cx, y: v.cy - (sy - this.hgt / 2) / v.s }
  }

  private imageVisible(): boolean {
    return !!(this.layers.image && this.image && this.profile?.image?.visible)
  }

  private imageWorldRect(): Bounds | null {
    const meta = this.profile?.image
    if (!meta) return null
    const c = meta.crop
    const a = imageToWorld(meta.calib, c.x, c.y)
    const b = imageToWorld(meta.calib, c.x + c.w, c.y + c.h)
    return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) }
  }

  /** Image pixel under a world point (for calibration picking and cropping). */
  imagePixelAt(x: number, y: number): { px: number; py: number } | null {
    const meta = this.profile?.image
    return meta ? worldToImage(meta.calib, x, y) : null
  }

  imageRectFromWorld(b: Bounds): Rect | null {
    const meta = this.profile?.image
    if (!meta) return null
    const a = worldToImage(meta.calib, b.minX, b.maxY)
    const c = worldToImage(meta.calib, b.maxX, b.minY)
    const x = Math.max(0, Math.round(Math.min(a.px, c.px)))
    const y = Math.max(0, Math.round(Math.min(a.py, c.py)))
    const x2 = Math.min(meta.width, Math.round(Math.max(a.px, c.px)))
    const y2 = Math.min(meta.height, Math.round(Math.max(a.py, c.py)))
    return x2 - x > 2 && y2 - y > 2 ? { x, y, w: x2 - x, h: y2 - y } : null
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private poiAt(sx: number, sy: number): Poi | null {
    if (!this.profile || !this.layers.points) return null
    let best: Poi | null = null
    let bestD = 10
    for (const p of this.profile.points) {
      if (p.hidden) continue
      const s = this.toScreen(p.x, p.y)
      const d = Math.hypot(s.x - sx, s.y - sy)
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    return best
  }

  private bind(): void {
    const el = this.el
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      el.focus({ preventScroll: true })
      el.setPointerCapture(e.pointerId)
      const p = this.local(e)
      this.pointers.set(e.pointerId, p)
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()]
        this.gesture = {
          mode: 'pinch',
          sx: p.x,
          sy: p.y,
          moved: true,
          view: { ...this.view },
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        }
        this.dragRect = null
        return
      }
      const rectTool = this.tool === 'crop' || this.tool === 'zone'
      const w = this.toWorld(p.x, p.y)
      if (rectTool) this.dragRect = { a: w, b: w }
      this.gesture = { mode: rectTool ? 'rect' : 'pan', sx: p.x, sy: p.y, moved: false, view: { ...this.view }, dist: 0, mid: p }
    })

    el.addEventListener('pointermove', (e) => {
      const p = this.local(e)
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p)
      const g = this.gesture
      if (g?.mode === 'pinch' && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        this.view = { ...g.view }
        const anchor = this.toWorld(g.mid.x, g.mid.y)
        this.view.s = Math.max(MIN_S, Math.min(MAX_S, g.view.s * (dist / (g.dist || 1))))
        const now = this.toWorld(mid.x, mid.y)
        this.view.cx += anchor.x - now.x
        this.view.cy += anchor.y - now.y
        this.invalidate()
        return
      }
      if (g && (g.mode === 'pan' || g.mode === 'rect')) {
        if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) > 3) g.moved = true
        if (g.moved && g.mode === 'pan') {
          this.view.cx = g.view.cx - (p.x - g.sx) / this.view.s
          this.view.cy = g.view.cy + (p.y - g.sy) / this.view.s
        }
        if (g.mode === 'rect' && this.dragRect) this.dragRect.b = this.toWorld(p.x, p.y)
      }
      this.updateHover(p.x, p.y)
    })

    const end = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return
      this.pointers.delete(e.pointerId)
      const g = this.gesture
      if (g?.mode === 'pinch') {
        if (this.pointers.size === 0) this.gesture = null
        return
      }
      this.gesture = null
      if (!g) return
      const p = this.local(e)
      if (g.mode === 'rect' && this.dragRect) {
        const { a, b } = this.dragRect
        this.dragRect = null
        if (g.moved) {
          this.hooks.onRect(this.tool, {
            minX: Math.min(a.x, b.x),
            maxX: Math.max(a.x, b.x),
            minY: Math.min(a.y, b.y),
            maxY: Math.max(a.y, b.y),
          })
        }
        this.invalidate()
        return
      }
      if (!g.moved && e.type === 'pointerup') this.click(p.x, p.y)
    }
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)

    el.addEventListener('pointerleave', () => {
      if (this.gesture) return
      this.hover = null
      this.hoverPoi = null
      this.renderReadout()
      this.invalidate()
    })

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const p = this.local(e)
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
        this.zoomBy(Math.pow(1.0015, -dy), p.x, p.y)
        this.updateHover(p.x, p.y)
      },
      { passive: false },
    )

    el.addEventListener('dblclick', (e) => {
      if (this.tool !== 'pan') return
      const p = this.local(e)
      this.zoomBy(2, p.x, p.y)
    })

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const p = this.local(e)
      const w = this.toWorld(p.x, p.y)
      this.hooks.onContextMenu(w.x, w.y, this.poiAt(p.x, p.y), e.clientX, e.clientY)
    })

    el.addEventListener('keydown', (e) => {
      const step = 60 / this.view.s
      const k = e.key
      if (k === '+' || k === '=') this.zoomBy(1.25)
      else if (k === '-' || k === '_') this.zoomBy(0.8)
      else if (k === '0') this.fit()
      else if (k === 'ArrowLeft') this.view.cx -= step
      else if (k === 'ArrowRight') this.view.cx += step
      else if (k === 'ArrowUp') this.view.cy += step
      else if (k === 'ArrowDown') this.view.cy -= step
      else if (k === 'Escape') {
        this.measure = null
        this.dragRect = null
        if (this.tool !== 'pan') this.hooks.onToolDone()
      } else return
      e.preventDefault()
      this.invalidate()
    })
  }

  private click(sx: number, sy: number): void {
    const w = this.toWorld(sx, sy)
    const poi = this.poiAt(sx, sy)
    switch (this.tool) {
      case 'pan':
        this.selectedId = poi?.id ?? null
        this.hooks.onSelectPoi(poi)
        this.invalidate()
        return
      case 'measure': {
        const at = poi ? { x: poi.x, y: poi.y } : w
        if (!this.measure || this.measure.b) this.measure = { a: at, b: null }
        else this.measure.b = at
        this.invalidate()
        return
      }
      case 'me':
      case 'dest':
        // Snap to a POI when clicking right on it.
        this.hooks.onPick(this.tool, poi ? poi.x : w.x, poi ? poi.y : w.y)
        return
      case 'add':
      case 'calib':
        this.hooks.onPick(this.tool, w.x, w.y)
        return
    }
  }

  private updateHover(sx: number, sy: number): void {
    const w = this.toWorld(sx, sy)
    this.hover = { x: w.x, y: w.y, sx, sy }
    this.hoverPoi = this.poiAt(sx, sy)
    this.el.style.cursor = this.hoverPoi && this.tool === 'pan' ? 'pointer' : ''
    this.renderReadout()
    this.invalidate()
  }

  // ── Readout ───────────────────────────────────────────────────────────────

  private renderReadout(): void {
    const r = this.readout
    clear(r)
    const p = this.profile
    if (!p || !this.hover) {
      r.hidden = true
      return
    }
    r.hidden = false
    const poi = this.hoverPoi
    const x = poi ? poi.x : this.hover.x
    const y = poi ? poi.y : this.hover.y
    const digits = this.view.s > 40 ? 2 : this.view.s > 4 ? 1 : 0
    r.append(h('div', { class: 'mt-ro-coord' }, poi ? formatCoord(x, y) : formatCoord(x, y, digits)))
    if (poi) {
      r.append(h('div', { class: 'mt-ro-title' }, poi.name))
      if (poi.group) r.append(h('div', { class: 'mt-ro-dim' }, poi.group))
      if (poi.note) r.append(h('div', { class: 'mt-ro-dim' }, poi.note))
    }
    const where = locate(p, x, y)
    const place = [where.zone?.name, where.region?.name].filter(Boolean).join(' · ')
    if (place) r.append(h('div', null, place))
    if (where.zones.length > 1) r.append(h('div', { class: 'mt-ro-dim' }, `also ${where.zones.slice(1).map((z) => z.name).join(', ')}`))
    if (!poi) {
      const n = nearest(p, x, y, 1)[0]
      if (n) r.append(h('div', { class: 'mt-ro-dim' }, `Nearest: ${n.poi.name}, ${formatKm(n.km)} ${n.dir}`))
    }
    const me = this.chat?.pos
    if (me) {
      const km = distanceUnits(me.x, me.y, x, y) * p.unitKm
      if (km > 0.05) r.append(h('div', { class: 'mt-ro-dim' }, `From you: ${formatKm(km)} ${compass(bearing(me.x, me.y, x, y))}`))
    }
    if (this.tool === 'calib' && p.image) {
      const ip = worldToImage(p.image.calib, x, y)
      r.append(h('div', { class: 'mt-ro-dim' }, `Image px: ${Math.round(ip.px)}, ${Math.round(ip.py)}`))
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  private resize(): void {
    const r = this.el.getBoundingClientRect()
    const w = Math.round(r.width)
    const hh = Math.round(r.height)
    if (w < 2 || hh < 2) return
    const first = !this.w
    this.dpr = window.devicePixelRatio || 1
    this.w = w
    this.hgt = hh
    for (const [c, cw, ch] of [
      [this.canvas, w, hh],
      [this.rx, w, this.rx.clientHeight || 22],
      [this.ry, this.ry.clientWidth || 40, hh],
    ] as const) {
      c.width = Math.round(cw * this.dpr)
      c.height = Math.round(ch * this.dpr)
    }
    if (first || !this.hasView) this.fit()
    this.draw()
  }

  private readTheme(): Theme {
    if (this.theme) return this.theme
    const cs = getComputedStyle(this.el)
    const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb
    this.theme = {
      bg: v('--lumiverse-bg', '#14161b'),
      text: v('--lumiverse-text', '#e8e8ea'),
      muted: v('--lumiverse-text-muted', '#9aa0aa'),
      grid: v('--lumiverse-border', 'rgba(255,255,255,0.12)'),
      primary: v('--lumiverse-primary', '#7aa2ff'),
      accent: v('--lumiverse-accent', '#f5b942'),
      danger: v('--lumiverse-danger', '#ef5f5f'),
    }
    return this.theme
  }

  private draw(): void {
    if (!this.w) return
    const g = this.g
    const t = this.readTheme()
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.clearRect(0, 0, this.w, this.hgt)
    g.fillStyle = t.bg
    g.fillRect(0, 0, this.w, this.hgt)

    const p = this.profile
    const step = niceStep(80 / this.view.s)
    if (p) {
      if (this.imageVisible()) this.drawImage()
      if (this.layers.grid) this.drawGrid(step, t)
      if (this.layers.regions) this.drawZones(p, 'region', t)
      if (this.layers.zones) this.drawZones(p, 'zone', t)
      if (this.layers.trail) this.drawTrail(t)
      this.drawDestLine(t)
      if (this.layers.points) this.drawPoints(p, t)
      this.drawMeasure(p, t)
      this.drawMarkers(t)
      this.drawDragRect(t)
      if (this.tool === 'crop' && this.profile?.image) this.drawCropOutline(t)
    }
    this.drawRulers(step, t)
  }

  private drawImage(): void {
    const meta = this.profile!.image!
    const img = this.image!
    const c = meta.crop
    const a = imageToWorld(meta.calib, c.x, c.y)
    const b = imageToWorld(meta.calib, c.x + c.w, c.y + c.h)
    const sa = this.toScreen(a.x, a.y)
    const sb = this.toScreen(b.x, b.y)
    const g = this.g
    g.save()
    g.globalAlpha = meta.opacity
    g.imageSmoothingEnabled = true
    g.imageSmoothingQuality = 'high'
    g.drawImage(img, c.x, c.y, c.w, c.h, Math.min(sa.x, sb.x), Math.min(sa.y, sb.y), Math.abs(sb.x - sa.x), Math.abs(sb.y - sa.y))
    g.restore()
  }

  private drawCropOutline(t: Theme): void {
    const meta = this.profile!.image!
    const a = imageToWorld(meta.calib, 0, 0)
    const b = imageToWorld(meta.calib, meta.width, meta.height)
    const sa = this.toScreen(a.x, a.y)
    const sb = this.toScreen(b.x, b.y)
    const g = this.g
    g.save()
    g.setLineDash([4, 4])
    g.strokeStyle = t.muted
    g.strokeRect(Math.min(sa.x, sb.x), Math.min(sa.y, sb.y), Math.abs(sb.x - sa.x), Math.abs(sb.y - sa.y))
    g.restore()
  }

  private drawGrid(step: number, t: Theme): void {
    const g = this.g
    const tl = this.toWorld(0, 0)
    const br = this.toWorld(this.w, this.hgt)
    g.save()
    g.strokeStyle = t.grid
    g.globalAlpha = 0.55
    g.lineWidth = 1
    g.beginPath()
    for (let x = Math.ceil(tl.x / step) * step; x <= br.x; x += step) {
      const sx = Math.round(this.toScreen(x, 0).x) + 0.5
      g.moveTo(sx, 0)
      g.lineTo(sx, this.hgt)
    }
    for (let y = Math.ceil(br.y / step) * step; y <= tl.y; y += step) {
      const sy = Math.round(this.toScreen(0, y).y) + 0.5
      g.moveTo(0, sy)
      g.lineTo(this.w, sy)
    }
    g.stroke()
    // Axes through the origin.
    g.globalAlpha = 0.9
    g.beginPath()
    const o = this.toScreen(0, 0)
    if (o.x >= 0 && o.x <= this.w) g.moveTo(Math.round(o.x) + 0.5, 0), g.lineTo(Math.round(o.x) + 0.5, this.hgt)
    if (o.y >= 0 && o.y <= this.hgt) g.moveTo(0, Math.round(o.y) + 0.5), g.lineTo(this.w, Math.round(o.y) + 0.5)
    g.stroke()
    g.restore()
  }

  private zoneColor(z: Zone): string {
    return z.color || `hsl(${hueOf(z.name)} 70% 60%)`
  }

  private drawZones(p: WorldProfile, kind: Zone['kind'], t: Theme): void {
    const g = this.g
    const hoverZone = this.hover ? locate(p, this.hover.x, this.hover.y) : null
    for (const z of p.zones) {
      if (z.kind !== kind || z.hidden) continue
      const r = zoneRect(z, p.bounds, p.zones)
      if (r.maxX <= r.minX || r.maxY <= r.minY) continue
      const a = this.toScreen(r.minX, r.maxY)
      const b = this.toScreen(r.maxX, r.minY)
      const x = a.x
      const y = a.y
      const w = b.x - a.x
      const hh = b.y - a.y
      if (x > this.w || y > this.hgt || x + w < 0 || y + hh < 0) continue
      const color = this.zoneColor(z)
      const isHover = hoverZone?.zone?.id === z.id || hoverZone?.region?.id === z.id
      g.save()
      if (kind === 'zone') {
        g.globalAlpha = isHover ? 0.22 : 0.1
        g.fillStyle = color
        g.fillRect(x, y, w, hh)
        g.globalAlpha = isHover ? 0.95 : 0.6
        g.setLineDash([5, 4])
        g.lineWidth = isHover ? 1.5 : 1
      } else {
        g.globalAlpha = isHover ? 0.9 : 0.45
        g.setLineDash([12, 6])
        g.lineWidth = 2
      }
      g.strokeStyle = color
      g.strokeRect(x + 0.5, y + 0.5, w, hh)
      g.restore()

      if (!this.layers.labels || w < 70 || hh < 24) continue
      // Zones label their top-left corner; regions label top-centre of their visible part.
      const vx1 = Math.max(x, 0)
      const vx2 = Math.min(x + w, this.w)
      const top = Math.max(y, 0)
      if (vx2 - vx1 < 60 || top > y + hh - 20) continue
      g.save()
      g.font = kind === 'region' ? '600 13px system-ui, sans-serif' : '500 11px system-ui, sans-serif'
      g.fillStyle = color
      g.globalAlpha = kind === 'region' ? 0.85 : 0.95
      if (kind === 'region') this.haloText(z.name, (vx1 + vx2) / 2, top + 18, t, 'center', vx2 - vx1 - 12)
      else this.haloText(z.name, vx1 + 6, top + 15, t, 'left', vx2 - vx1 - 12)
      g.restore()
    }
  }

  private haloText(text: string, x: number, y: number, t: Theme, align: CanvasTextAlign = 'left', maxW?: number): void {
    const g = this.g
    g.textAlign = align
    g.lineJoin = 'round'
    g.lineWidth = 3
    g.strokeStyle = t.bg
    g.strokeText(text, x, y, maxW)
    g.fillText(text, x, y, maxW)
  }

  private poiColor(p: Poi): string {
    if (p.color) return p.color
    const top = p.group.split(' / ').slice(0, 2).join('/')
    return `hsl(${hueOf(top || 'x')} 65% 62%)`
  }

  private drawPoints(p: WorldProfile, t: Theme): void {
    const g = this.g
    const placed: { x: number; y: number; w: number; h: number }[] = []
    const visible = p.points.filter((pt) => !pt.hidden)
    const priority = (pt: Poi) =>
      pt.id === this.hoverPoi?.id ? 0 : pt.id === this.selectedId ? 1 : this.chat?.dest && pt.x === this.chat.dest.x && pt.y === this.chat.dest.y ? 2 : 3
    const ordered = [...visible].sort((a, b) => priority(a) - priority(b))

    for (const pt of visible) {
      const s = this.toScreen(pt.x, pt.y)
      if (s.x < -10 || s.y < -10 || s.x > this.w + 10 || s.y > this.hgt + 10) continue
      const hot = pt.id === this.hoverPoi?.id || pt.id === this.selectedId
      g.beginPath()
      g.arc(s.x, s.y, hot ? 6 : 4.2, 0, Math.PI * 2)
      g.fillStyle = this.poiColor(pt)
      g.fill()
      g.lineWidth = hot ? 2.5 : 1.5
      g.strokeStyle = hot ? t.text : t.bg
      g.stroke()
    }

    if (!this.layers.labels) return
    g.font = '500 11.5px system-ui, sans-serif'
    for (const pt of ordered) {
      const s = this.toScreen(pt.x, pt.y)
      if (s.x < -80 || s.y < -20 || s.x > this.w + 80 || s.y > this.hgt + 20) continue
      const tw = g.measureText(pt.name).width
      const box = { x: s.x + 8, y: s.y - 7, w: tw + 4, h: 14 }
      if (placed.some((o) => box.x < o.x + o.w && box.x + box.w > o.x && box.y < o.y + o.h && box.y + box.h > o.y)) continue
      placed.push(box)
      g.fillStyle = t.text
      g.globalAlpha = priority(pt) < 3 ? 1 : 0.88
      this.haloText(pt.name, s.x + 8, s.y + 4, t)
      g.globalAlpha = 1
    }
  }

  private drawTrail(t: Theme): void {
    const trail = this.chat?.trail
    if (!trail || trail.length < 2) return
    const g = this.g
    g.save()
    g.strokeStyle = t.primary
    g.globalAlpha = 0.55
    g.lineWidth = 2
    g.setLineDash([2, 5])
    g.lineCap = 'round'
    g.beginPath()
    trail.forEach((pt, i) => {
      const s = this.toScreen(pt.x, pt.y)
      if (i === 0) g.moveTo(s.x, s.y)
      else g.lineTo(s.x, s.y)
    })
    g.stroke()
    g.setLineDash([])
    for (const pt of trail.slice(0, -1)) {
      const s = this.toScreen(pt.x, pt.y)
      g.beginPath()
      g.arc(s.x, s.y, 2, 0, Math.PI * 2)
      g.fillStyle = t.primary
      g.fill()
    }
    g.restore()
  }

  private drawDestLine(t: Theme): void {
    const me = this.chat?.pos
    const d = this.chat?.dest
    if (!me || !d) return
    const a = this.toScreen(me.x, me.y)
    const b = this.toScreen(d.x, d.y)
    const g = this.g
    g.save()
    g.strokeStyle = t.accent
    g.globalAlpha = 0.8
    g.lineWidth = 1.5
    g.setLineDash([7, 5])
    g.beginPath()
    g.moveTo(a.x, a.y)
    g.lineTo(b.x, b.y)
    g.stroke()
    g.restore()
  }

  private drawMarkers(t: Theme): void {
    const g = this.g
    const d = this.chat?.dest
    if (d) {
      const s = this.toScreen(d.x, d.y)
      g.save()
      g.strokeStyle = t.accent
      g.fillStyle = t.accent
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(s.x, s.y)
      g.lineTo(s.x, s.y - 22)
      g.stroke()
      g.beginPath()
      g.moveTo(s.x, s.y - 22)
      g.lineTo(s.x + 13, s.y - 17)
      g.lineTo(s.x, s.y - 12)
      g.closePath()
      g.fill()
      g.restore()
    }
    const me = this.chat?.pos
    if (me) {
      const s = this.toScreen(me.x, me.y)
      g.save()
      g.beginPath()
      g.arc(s.x, s.y, 13, 0, Math.PI * 2)
      g.fillStyle = t.primary
      g.globalAlpha = 0.2
      g.fill()
      g.globalAlpha = 1
      g.beginPath()
      g.arc(s.x, s.y, 6.5, 0, Math.PI * 2)
      g.fillStyle = t.primary
      g.fill()
      g.lineWidth = 2.5
      g.strokeStyle = '#fff'
      g.stroke()
      if (d) {
        const ang = Math.atan2(-(d.y - me.y), d.x - me.x)
        g.translate(s.x, s.y)
        g.rotate(ang)
        g.beginPath()
        g.moveTo(20, 0)
        g.lineTo(13, -5)
        g.lineTo(13, 5)
        g.closePath()
        g.fillStyle = t.primary
        g.fill()
      }
      g.restore()
    }
  }

  private drawMeasure(p: WorldProfile, t: Theme): void {
    const m = this.measure
    if (!m) return
    const end = m.b ?? (this.hover ? { x: this.hover.x, y: this.hover.y } : null)
    const a = this.toScreen(m.a.x, m.a.y)
    const g = this.g
    g.save()
    g.strokeStyle = t.text
    g.fillStyle = t.text
    g.lineWidth = 1.5
    g.beginPath()
    g.arc(a.x, a.y, 3.5, 0, Math.PI * 2)
    g.fill()
    if (end) {
      const b = this.toScreen(end.x, end.y)
      g.setLineDash([6, 4])
      g.beginPath()
      g.moveTo(a.x, a.y)
      g.lineTo(b.x, b.y)
      g.stroke()
      g.setLineDash([])
      g.beginPath()
      g.arc(b.x, b.y, 3.5, 0, Math.PI * 2)
      g.fill()
      const units = distanceUnits(m.a.x, m.a.y, end.x, end.y)
      const label = `${formatKm(units * p.unitKm)} ${compass(bearing(m.a.x, m.a.y, end.x, end.y))} · ${units.toFixed(1)} u`
      g.font = '600 12px system-ui, sans-serif'
      this.haloText(label, (a.x + b.x) / 2 + 8, (a.y + b.y) / 2 - 8, t)
    }
    g.restore()
  }

  private drawDragRect(t: Theme): void {
    const r = this.dragRect
    if (!r) return
    const a = this.toScreen(r.a.x, r.a.y)
    const b = this.toScreen(r.b.x, r.b.y)
    const g = this.g
    g.save()
    g.fillStyle = t.primary
    g.globalAlpha = 0.12
    g.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
    g.globalAlpha = 1
    g.strokeStyle = t.primary
    g.setLineDash([5, 4])
    g.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y))
    g.restore()
  }

  private drawRulers(step: number, t: Theme): void {
    const minor = step / 5
    const tl = this.toWorld(0, 0)
    const br = this.toWorld(this.w, this.hgt)

    // X ruler
    const gx = this.gx
    const rw = this.rx.width / this.dpr
    const rh = this.rx.height / this.dpr
    gx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    gx.clearRect(0, 0, rw, rh)
    gx.font = '10.5px system-ui, sans-serif'
    gx.fillStyle = t.muted
    gx.strokeStyle = t.muted
    gx.textAlign = 'left'
    gx.beginPath()
    for (let x = Math.ceil(tl.x / minor) * minor; x <= br.x; x += minor) {
      const sx = Math.round(this.toScreen(x, 0).x) + 0.5
      const major = Math.abs(x / step - Math.round(x / step)) < 1e-6
      gx.moveTo(sx, rh)
      gx.lineTo(sx, rh - (major ? 9 : 4))
      if (major) gx.fillText(fmtTick(Math.round(x / step) * step, step), sx + 3, rh - 10)
    }
    gx.globalAlpha = 0.7
    gx.stroke()
    gx.globalAlpha = 1
    if (this.hover) {
      gx.fillStyle = t.primary
      gx.fillRect(Math.round(this.hover.sx) - 1, 0, 2, rh)
    }

    // Y ruler
    const gy = this.gy
    const yw = this.ry.width / this.dpr
    const yh = this.ry.height / this.dpr
    gy.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    gy.clearRect(0, 0, yw, yh)
    gy.font = '10.5px system-ui, sans-serif'
    gy.fillStyle = t.muted
    gy.strokeStyle = t.muted
    gy.textAlign = 'right'
    gy.beginPath()
    for (let y = Math.ceil(br.y / minor) * minor; y <= tl.y; y += minor) {
      const sy = Math.round(this.toScreen(0, y).y) + 0.5
      const major = Math.abs(y / step - Math.round(y / step)) < 1e-6
      gy.moveTo(yw, sy)
      gy.lineTo(yw - (major ? 9 : 4), sy)
      if (major) gy.fillText(fmtTick(Math.round(y / step) * step, step), yw - 11, sy + 3.5)
    }
    gy.globalAlpha = 0.7
    gy.stroke()
    gy.globalAlpha = 1
    if (this.hover) {
      gy.fillStyle = t.primary
      gy.fillRect(0, Math.round(this.hover.sy) - 1, yw, 2)
    }
  }
}

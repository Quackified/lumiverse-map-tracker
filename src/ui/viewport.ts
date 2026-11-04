import { areasAt, layerSettings, typeLabel } from '../shared/features'
import {
  bearing,
  compass,
  rectCalibration,
  distanceUnits,
  formatCoord,
  formatKm,
  imageToWorld,
  locate,
  nearest,
  worldToImage,
  zoneRect,
} from '../shared/geo'
import type { Bounds, Calibration, ChatMapState, DecorStamp, LandGrid, Feature, MapImageMeta, Poi, Rect, WorldProfile, Zone } from '../shared/types'
import { clear, h, hueOf } from './dom'
import { VectorEditor, isVectorTool, type VectorTool } from './vector'
import { LandRenderer } from './landmap'
import { DecorRenderer, stampBox, stampsAt } from './decor'
import { drawMarker, markerStyle } from './markers'
import { EMPTY, biomeColor, biomeName, graphFor } from '../shared/cells'

export type LandTool = 'lbrush' | 'lfill' | 'llasso' | 'lpick' | 'lsample' | 'lwand' | 'lcoast'
const LAND_TOOLS = new Set<string>(['lbrush', 'lfill', 'llasso', 'lpick', 'lsample', 'lwand', 'lcoast'])
export const isLandTool = (t: string): t is LandTool => LAND_TOOLS.has(t)
/** Tools that read the picture: it comes to the front while they're active. */
const PICTURE_TOOLS = new Set<string>(['lsample', 'lwand', 'lcoast', 'scut'])
export type DecorTool = 'dbrush' | 'derase'
export const isDecorTool = (t: string): t is DecorTool => t === 'dbrush' || t === 'derase'
export type Tool = 'pan' | 'me' | 'dest' | 'add' | 'measure' | 'crop' | 'zone' | 'imgxf' | 'pmove' | 'scut' | VectorTool | LandTool | DecorTool
type CropMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const CROP_CURSOR: Record<CropMode, string> = {
  move: 'move',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
}

export interface Layers {
  image: boolean
  grid: boolean
  regions: boolean
  zones: boolean
  points: boolean
  labels: boolean
  trail: boolean
  land: boolean
  decor: boolean
}

export const DEFAULT_LAYERS: Layers = {
  land: true,
  decor: true,
  image: true,
  grid: true,
  regions: true,
  zones: true,
  points: true,
  labels: true,
  trail: true,
}

export interface MapHooks {
  /** Click with a placement tool (me/dest/add). */
  onPick(tool: Tool, x: number, y: number): void
  /** Finished dragging a rectangle with the zone tool (world coords). */
  onRect(tool: Tool, r: Bounds): void
  /** Crop or image transform handles moved. `move` while dragging, `end` once settled. */
  onImageEdit(patch: Partial<Pick<MapImageMeta, 'crop' | 'calib'>>, phase: 'move' | 'end'): void
  /** Vector layers edited: the whole new feature list. */
  onFeaturesEdit(next: Feature[], phase: 'move' | 'end'): void
  onFeatureSelection(ids: string[]): void
  warn(message: string): void
  onSelectPoi(poi: Poi | null): void
  /** Land tools: `down` on press, `move` while dragging (brush only), `end` on release. */
  onLand(tool: LandTool, phase: 'down' | 'move' | 'end', x: number, y: number, e: { altKey: boolean; shiftKey: boolean }): void
  /** Decoration tools: `down` on press, `move` while dragging, `end` on release. */
  onDecor(tool: DecorTool, phase: 'down' | 'move' | 'end', x: number, y: number, e: { altKey: boolean; shiftKey: boolean }): void
  /** The lasso closed: paint everything inside this outline (world coordinates). */
  onLandPolygon(points: [number, number][]): void
  /** A place dragged (or nudged) with the Move places tool. `move` while dragging, `end` once dropped. */
  onPoiMove(id: string, x: number, y: number, phase: 'move' | 'end'): void
  /**
   * The Select tool moved its selection: new place positions, the shapes
   * list with moved shapes, and (on `end` only) the decorations list with
   * moved stamps; null where nothing of that kind moved.
   */
  onMoveSelection(m: { pois: { id: string; x: number; y: number }[]; features: Feature[] | null; decor: DecorStamp[] | null }, phase: 'move' | 'end'): void
  /** Delete what the Select tool has selected. */
  onDeleteSelection(s: { pois: string[]; decor: number[]; features: string[] }): void
  /** What the Select tool has selected changed. */
  onSelectionChange(): void
  /** A plain click with the hand on a named or noted shape (no place there); null on empty map. */
  onInspectShape(f: Feature | null): void
  onContextMenu(x: number, y: number, poi: Poi | null, clientX: number, clientY: number): void
  onToolDone(): void
}

/** Something the Select tool can pick. */
export type Hit = { kind: 'poi'; id: string } | { kind: 'feature'; id: string } | { kind: 'decor'; i: number }
const sameHit = (a: Hit, b: Hit) => a.kind === b.kind && (a.kind === 'decor' ? a.i === (b as { i: number }).i : a.id === (b as { id: string }).id)

interface SelDrag {
  world: { x: number; y: number }
  ref: [number, number]
  pois: { id: string; x: number; y: number }[]
  decor: { i: number; st: DecorStamp }[]
  feats: Feature[]
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
  readonly land = new LandRenderer()
  readonly decor = new DecorRenderer()
  decorOpacity = 1
  /** Land brush radius in screen pixels. */
  brushPx = 24
  /** Draw the map picture above the land grid (for comparing while painting or seeding). */
  imageOnTop = false
  landOpacity = 1
  /** Snapping for shapes: to nearby places and shape points, else to whole steps. Ctrl turns it off. */
  snapOn = true
  /** Where the last snap landed on a place or shape point, to mark it. */
  private snapMark: { x: number; y: number } | null = null
  /** Outline being drawn with the terrain lasso, in world coordinates. */
  private lasso: [number, number][] | null = null

  private view: View = { cx: 0, cy: 0, s: 1 }
  private w = 0
  private hgt = 0
  private dpr = 1
  private hover: { x: number; y: number; sx: number; sy: number } | null = null
  private hoverPoi: Poi | null = null
  private measure: { a: { x: number; y: number }; b: { x: number; y: number } | null } | null = null
  private dragRect: { a: { x: number; y: number }; b: { x: number; y: number } } | null = null
  private pointers = new Map<number, { x: number; y: number }>()
  private gesture: {
    mode: 'pan' | 'rect' | 'pinch' | 'crop' | 'imgxf' | 'vector' | 'poi' | 'land' | 'decor' | 'sel' | 'box'
    sx: number
    sy: number
    moved: boolean
    view: View
    dist: number
    mid: { x: number; y: number }
    crop?: CropMode
    startCrop?: Rect
    startImg?: { px: number; py: number }
    startRect?: Bounds
    startWorld?: { x: number; y: number }
    poiId?: string
    /** Grab offset: place position minus the pointer's world position. */
    grab?: { x: number; y: number }
    /** Select tool: what is being dragged, as it was at the press. */
    sel?: SelDrag
    /** Select tool box: Shift adds to the selection. */
    additive?: boolean
  } | null = null
  /** Places and decorations picked with the Select tool (shapes are in `vec.selection`). */
  readonly selPois = new Set<string>()
  readonly selDecor = new Set<number>()
  /** Space held: drag pans whatever the tool. */
  private spaceDown = false
  readonly vec: VectorEditor
  private painter: import('./terrain').Painter
  private raf = 0
  /**
   * Terrain and decorations drawn once into their own canvases (with a margin
   * around the view), then reused: hovering, places, labels and tool overlays
   * redraw over it without repainting thousands of cells and stamps. While the
   * view moves the cached picture is shifted and scaled; it is redrawn sharp
   * once the view settles, or when the terrain or decorations change.
   */
  private base: { land: HTMLCanvasElement; decor: HTMLCanvasElement; view: View; margin: number; landKey: unknown[]; decorKey: unknown[] } | null = null
  /** Scale all, while its slider is being dragged (not saved yet). */
  private scalePreview: number | null = null

  /** Show every decoration at `scale` until the map's own scale changes (the slider was released and saved). */
  previewDecorScale(scale: number): void {
    this.scalePreview = scale
    this.invalidate(false)
  }

  /** Decorations being dragged with the Select tool, drawn live above the cache. */
  private liveStamps: DecorStamp[] | null = null
  /** World areas an eraser stroke changed since the last frame. */
  private eraseAreas: Bounds[] = []
  private baseDirty = true
  /** When the view last moved, to tell a moving view from a settled one. */
  private movedAt = 0
  private drawnView: View | null = null
  private settleTimer = 0
  /**
   * A brush stroke not saved yet: its cells or stamps are painted straight
   * into the cached picture as they come, and the stroke is saved once when
   * the pointer is released (then the cache is redrawn properly).
   */
  private strokeCells: { grid: LandGrid; biome: number; cells: number[] } | null = null
  private strokeStamps: DecorStamp[] | null = null
  /** The decorations an eraser stroke leaves, shown in place of the saved ones until it ends. */
  private strokeDecor: DecorStamp[] | null = null
  private strokeDrawn = 0
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

    this.vec = new VectorEditor({
      profile: () => this.profile,
      toScreen: (x, y) => this.toScreen(x, y),
      toWorld: (sx, sy) => this.toWorld(sx, sy),
      scale: () => this.view.s,
      settings: (l) => layerSettings(this.profile?.layerSettings, l),
      labels: () => this.layers.labels,
      invalidate: () => this.invalidate(false),
      emit: (next, phase) => this.hooks.onFeaturesEdit(next, phase),
      onSelection: (ids) => this.hooks.onFeatureSelection(ids),
      warn: (m) => this.hooks.warn(m),
      snap: (x, y, mods, exclude) => this.snapWorld(x, y, mods, exclude),
    })
    this.painter = {
      toScreen: (x, y) => this.toScreen(x, y),
      toWorld: (sx, sy) => this.toWorld(sx, sy),
      scale: () => this.view.s,
    }
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(this.el)
    this.bind()
  }

  snapWorld(x: number, y: number, mods: { ctrlKey: boolean; metaKey: boolean }, exclude?: Set<string>, excludePois?: Set<string>): { x: number; y: number } {
    this.snapMark = null
    if (!this.snapOn || mods.ctrlKey || mods.metaKey || !this.profile) return { x, y }
    // Objects first: a place or a shape point within 9 pixels.
    const r = 9 / this.view.s
    let best = r
    let hit: { x: number; y: number } | null = null
    for (const pt of this.profile.points) {
      if (excludePois?.has(pt.id)) continue
      const d = Math.hypot(pt.x - x, pt.y - y)
      if (d < best) (best = d), (hit = { x: pt.x, y: pt.y })
    }
    for (const f of this.profile.features ?? []) {
      if (f.hidden || exclude?.has(f.id) || !layerSettings(this.profile.layerSettings, f.layer).visible) continue
      for (const ring of f.rings)
        for (const [qx, qy] of ring) {
          if (Math.abs(qx - x) > best || Math.abs(qy - y) > best) continue
          const d = Math.hypot(qx - x, qy - y)
          if (d < best) (best = d), (hit = { x: qx, y: qy })
        }
    }
    if (hit) {
      this.snapMark = hit
      return hit
    }
    // Otherwise whole steps that suit the zoom: whole units close in, tens further out.
    const step = Math.max(0.1, niceStep(12 / this.view.s))
    return { x: Math.round(x / step) * step, y: Math.round(y / step) * step }
  }

  destroy(): void {
    this.ro.disconnect()
    cancelAnimationFrame(this.raf)
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setProfile(p: WorldProfile | null): void {
    const changed = p?.id !== this.profile?.id
    this.scalePreview = null
    this.profile = p
    if (changed) {
      this.hasView = false
      this.image = null
      this.measure = null
      this.vec.cancel()
      this.vec.setSelection([])
      this.selPois.clear()
      this.selDecor.clear()
    }
    if (this.selDecor.size && (p?.decor?.length ?? 0) !== this.selDecorLen) this.selDecor.clear()
    this.selDecorLen = p?.decor?.length ?? 0
    if (!this.hasView) this.fit()
    // Edits share the parts they don't touch, so the terrain and decoration
    // caches tell for themselves whether they need repainting.
    this.invalidate(false)
  }

  private selDecorLen = 0

  setChat(c: ChatMapState | null): void {
    this.chat = c
    this.invalidate()
  }

  setImage(img: HTMLImageElement | null): void {
    this.image = img
    this.invalidate()
  }

  setTool(t: Tool): void {
    if (t !== this.tool) this.vec.cancel()
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
    const b = this.tool === 'crop' && this.imageVisible() ? this.imageViewRect(true)! : this.profile.bounds
    const s = Math.min(this.w / (b.maxX - b.minX), this.hgt / (b.maxY - b.minY)) * 0.96
    this.view = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, s: Math.max(MIN_S, Math.min(MAX_S, s)) }
    this.hasView = true
    this.invalidate(false)
  }

  /** Show a world rectangle, not zooming in further than `maxScale` (default: the focus zoom). */
  fitTo(b: Bounds, maxScale = this.focusScale()): void {
    if (!this.w || !this.hgt) return
    const s = Math.min(this.w / Math.max(1e-6, b.maxX - b.minX), this.hgt / Math.max(1e-6, b.maxY - b.minY)) * 0.7
    this.view = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, s: Math.max(MIN_S, Math.min(MAX_S, maxScale, s)) }
    this.hasView = true
    this.invalidate(false)
  }

  zoomBy(f: number, sx = this.w / 2, sy = this.hgt / 2): void {
    const before = this.sView(sx, sy)
    this.view.s = Math.max(MIN_S, Math.min(MAX_S, this.view.s * f))
    const after = this.sView(sx, sy)
    this.view.cx += before.x - after.x
    this.view.cy += before.y - after.y
    this.invalidate(false)
  }

  centerOn(x: number, y: number, minScale?: number): void {
    this.view.cx = x
    this.view.cy = y
    if (minScale && this.view.s < minScale) this.view.s = minScale
    this.invalidate(false)
  }

  /** Scale that comfortably shows ~1/8 of the profile width. */
  /** World units per screen pixel at the current zoom. */
  unitsPerPx(): number {
    return 1 / this.view.s
  }

  focusScale(): number {
    if (!this.profile || !this.w) return this.view.s
    return (this.w / (this.profile.bounds.maxX - this.profile.bounds.minX)) * 4
  }

  /**
   * Redraw on the next frame. `content` (the default) means the terrain or
   * decorations may have changed and must be repainted; hovering and moving
   * the view pass false.
   */
  invalidate(content = true): void {
    if (content) this.baseDirty = true
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.draw()
    })
  }

  // ── Coordinates ───────────────────────────────────────────────────────────

  /** World → screen pixels. */
  private vScreen(x: number, y: number): { x: number; y: number } {
    const v = this.view
    return { x: (x - v.cx) * v.s + this.w / 2, y: this.hgt / 2 - (y - v.cy) * v.s }
  }

  /** Screen pixels → world. */
  private sView(sx: number, sy: number): { x: number; y: number } {
    const v = this.view
    return { x: (sx - this.w / 2) / v.s + v.cx, y: v.cy - (sy - this.hgt / 2) / v.s }
  }

  toScreen(x: number, y: number): { x: number; y: number } {
    return this.vScreen(x, y)
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return this.sView(sx, sy)
  }

  private drawCalib(): Calibration | null {
    return this.profile?.image?.calib ?? null
  }

  imgToScreen(px: number, py: number): { x: number; y: number } {
    const w = imageToWorld(this.drawCalib()!, px, py)
    return this.vScreen(w.x, w.y)
  }

  screenToImg(sx: number, sy: number): { px: number; py: number } {
    const v = this.sView(sx, sy)
    return worldToImage(this.drawCalib()!, v.x, v.y)
  }

  private editingImage(): boolean {
    return (this.tool === 'crop' || this.tool === 'imgxf') && !!this.image && !!this.profile?.image
  }

  private imageVisible(): boolean {
    return !!(this.image && this.profile?.image && (this.editingImage() || (this.layers.image && this.profile.image.visible)))
  }

  /** Image extent in view units: the crop, or the whole picture. */
  private imageViewRect(full = false): Bounds | null {
    const meta = this.profile?.image
    const calib = this.drawCalib()
    if (!meta || !calib) return null
    const c = full ? { x: 0, y: 0, w: meta.width, h: meta.height } : meta.crop
    const a = imageToWorld(calib, c.x, c.y)
    const b = imageToWorld(calib, c.x + c.w, c.y + c.h)
    return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) }
  }

  /** Image pixel under a world point. */
  imagePixelAt(x: number, y: number): { px: number; py: number } | null {
    const meta = this.profile?.image
    return meta ? worldToImage(meta.calib, x, y) : null
  }

  // ── Image editing (crop handles, free transform) ──────────────────────────

  private cropHandles(): { mode: CropMode; x: number; y: number }[] {
    const c = this.profile!.image!.crop
    const a = this.imgToScreen(c.x, c.y)
    const b = this.imgToScreen(c.x + c.w, c.y + c.h)
    const l = Math.min(a.x, b.x)
    const r = Math.max(a.x, b.x)
    const t = Math.min(a.y, b.y)
    const btm = Math.max(a.y, b.y)
    const mx = (l + r) / 2
    const my = (t + btm) / 2
    return [
      { mode: 'nw', x: l, y: t },
      { mode: 'ne', x: r, y: t },
      { mode: 'sw', x: l, y: btm },
      { mode: 'se', x: r, y: btm },
      { mode: 'n', x: mx, y: t },
      { mode: 's', x: mx, y: btm },
      { mode: 'w', x: l, y: my },
      { mode: 'e', x: r, y: my },
    ]
  }

  /** Crop / transform handle (or inside the box) under a screen point. */
  private cropHit(sx: number, sy: number): CropMode | null {
    if (!this.editingImage()) return null
    for (const hd of this.cropHandles()) if (Math.hypot(hd.x - sx, hd.y - sy) <= 11) return hd.mode
    const c = this.profile!.image!.crop
    const p = this.screenToImg(sx, sy)
    return p.px > c.x && p.px < c.x + c.w && p.py > c.y && p.py < c.y + c.h ? 'move' : null
  }

  private dragCrop(mode: CropMode, start: Rect, p0: { px: number; py: number }, p: { px: number; py: number }): Rect {
    const meta = this.profile!.image!
    const MIN = 8
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
    const dx = p.px - p0.px
    const dy = p.py - p0.py
    if (mode === 'move') {
      return {
        x: Math.round(clamp(start.x + dx, 0, meta.width - start.w)),
        y: Math.round(clamp(start.y + dy, 0, meta.height - start.h)),
        w: start.w,
        h: start.h,
      }
    }
    let x1 = start.x
    let y1 = start.y
    let x2 = start.x + start.w
    let y2 = start.y + start.h
    if (mode.includes('w')) x1 = clamp(x1 + dx, 0, x2 - MIN)
    if (mode.includes('e')) x2 = clamp(x2 + dx, x1 + MIN, meta.width)
    if (mode.includes('n')) y1 = clamp(y1 + dy, 0, y2 - MIN)
    if (mode.includes('s')) y2 = clamp(y2 + dy, y1 + MIN, meta.height)
    const rx = Math.round(x1)
    const ry = Math.round(y1)
    return { x: rx, y: ry, w: Math.round(x2) - rx, h: Math.round(y2) - ry }
  }

  /**
   * Free transform: drag the image's box in world space. Corners scale (Shift
   * keeps the aspect ratio), edges stretch one axis, inside moves. The result is
   * stored as two pins on the crop corners, so X and Y can scale independently.
   */
  private dragXf(mode: CropMode, start: Bounds, w0: { x: number; y: number }, w: { x: number; y: number }, keepAspect: boolean): Calibration {
    const dx = w.x - w0.x
    const dy = w.y - w0.y
    let { minX, maxX, minY, maxY } = start
    const MIN = (start.maxX - start.minX) * 0.02 || 1
    if (mode === 'move') {
      minX += dx
      maxX += dx
      minY += dy
      maxY += dy
    } else {
      if (mode.includes('w')) minX = Math.min(start.minX + dx, maxX - MIN)
      if (mode.includes('e')) maxX = Math.max(start.maxX + dx, minX + MIN)
      if (mode.includes('n')) maxY = Math.max(start.maxY + dy, minY + MIN)
      if (mode.includes('s')) minY = Math.min(start.minY + dy, maxY - MIN)
      if (keepAspect && mode.length === 2) {
        const k = Math.max((maxX - minX) / (start.maxX - start.minX), (maxY - minY) / (start.maxY - start.minY))
        const nw = (start.maxX - start.minX) * k
        const nh = (start.maxY - start.minY) * k
        if (mode.includes('w')) minX = maxX - nw
        else maxX = minX + nw
        if (mode.includes('n')) maxY = minY + nh
        else minY = maxY - nh
      }
    }
    return rectCalibration(this.profile!.image!.crop, { minX, maxX, minY, maxY })
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    // Rendered pixels, like the canvas size taken in resize(), so the host's UI zoom cancels out.
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
    // Cards, the search box and menus float over the map: their events are theirs.
    const overlay = (e: Event) => e.target !== el && e.target !== this.canvas
    el.addEventListener('pointerdown', (e) => {
      if (overlay(e)) return
      const middle = e.button === 1 && e.pointerType === 'mouse'
      if (e.button !== 0 && !middle && e.pointerType === 'mouse') return
      if (middle) e.preventDefault()
      el.focus({ preventScroll: true })
      // A primary press means nothing else is down: finish anything whose
      // release never arrived, so it can't turn this press into a pinch.
      if (e.isPrimary) for (const id of [...this.pointers.keys()]) end(e, id)
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
      const base = { sx: p.x, sy: p.y, moved: false, view: { ...this.view }, dist: 0, mid: p }
      if (middle || this.spaceDown) {
        this.gesture = { ...base, mode: 'pan' }
        return
      }
      const meta = this.profile?.image
      const crop = this.cropHit(p.x, p.y)
      if (crop && meta) {
        this.gesture =
          this.tool === 'imgxf'
            ? { ...base, mode: 'imgxf', crop, startRect: this.imageViewRect(false)!, startWorld: this.toWorld(p.x, p.y) }
            : { ...base, mode: 'crop', crop, startCrop: { ...meta.crop }, startImg: this.screenToImg(p.x, p.y) }
        return
      }
      if (isLandTool(this.tool) && this.profile?.land) {
        const w = this.toWorld(p.x, p.y)
        this.gesture = { ...base, mode: 'land' }
        if (this.tool === 'llasso') this.lasso = [[w.x, w.y]]
        else this.hooks.onLand(this.tool, 'down', w.x, w.y, e)
        return
      }
      if (isDecorTool(this.tool) && this.profile) {
        const w = this.toWorld(p.x, p.y)
        this.gesture = { ...base, mode: 'decor' }
        this.hooks.onDecor(this.tool, 'down', w.x, w.y, e)
        return
      }
      if (this.tool === 'pmove') {
        const poi = this.poiAt(p.x, p.y)
        if (poi) {
          const w = this.toWorld(p.x, p.y)
          this.selectedId = poi.id
          this.hooks.onSelectPoi(poi)
          this.gesture = { ...base, mode: 'poi', poiId: poi.id, grab: { x: poi.x - w.x, y: poi.y - w.y } }
          this.invalidate()
          return
        }
      }
      if (this.tool === 'vselect' && this.profile) {
        // Handles and vertices of a selected shape first, as before.
        if (this.vec.grabsEdit(p.x, p.y) && this.vec.pointerDown('vselect', p.x, p.y, e)) {
          this.gesture = { ...base, mode: 'vector' }
          return
        }
        // Ctrl-drag always draws a selection box, even over a crowded map.
        const hits = e.ctrlKey || e.metaKey ? [] : this.hitsAt(p.x, p.y)
        let hit = hits[0]
        // Alt-click: the next thing down in the stack under the cursor.
        if (e.altKey && hits.length > 1) hit = hits[(hits.findIndex((x) => this.isSelected(x)) + 1) % hits.length]
        if (!hit) {
          if (!e.shiftKey) this.setSelected([])
          const w = this.toWorld(p.x, p.y)
          this.dragRect = { a: w, b: w }
          this.gesture = { ...base, mode: 'box', additive: e.shiftKey }
          return
        }
        if (e.shiftKey) {
          this.setSelected(this.isSelected(hit) ? this.selectedHits().filter((x) => !sameHit(x, hit)) : [...this.selectedHits(), hit])
          if (!this.isSelected(hit)) return
        } else if (!this.isSelected(hit) || e.altKey) this.setSelected([hit])
        this.gesture = { ...base, mode: 'sel', sel: this.startSelDrag(hit, p.x, p.y) }
        return
      }
      if (isVectorTool(this.tool) && this.vec.pointerDown(this.tool, p.x, p.y, e)) {
        this.gesture = { ...base, mode: 'vector' }
        return
      }
      const rectTool = this.tool === 'zone' || this.tool === 'scut'
      const w = this.toWorld(p.x, p.y)
      if (rectTool) this.dragRect = { a: w, b: w }
      this.gesture = { ...base, mode: rectTool ? 'rect' : 'pan' }
    })

    el.addEventListener('pointermove', (e) => {
      // Moving with no button held: the release was lost (the host moved focus
      // or the element lost capture), so end the gesture rather than keep painting.
      if (this.pointers.has(e.pointerId) && e.pointerType !== 'touch' && e.buttons === 0) end(e)
      const p = this.local(e)
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p)
      const g = this.gesture
      if (g?.mode === 'pinch' && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        this.view = { ...g.view }
        const anchor = this.sView(g.mid.x, g.mid.y)
        this.view.s = Math.max(MIN_S, Math.min(MAX_S, g.view.s * (dist / (g.dist || 1))))
        const now = this.sView(mid.x, mid.y)
        this.view.cx += anchor.x - now.x
        this.view.cy += anchor.y - now.y
        this.invalidate(false)
        return
      }
      if (g?.mode === 'sel' && g.sel) {
        if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) > 3) g.moved = true
        if (g.moved) this.moveSel(g.sel, p.x, p.y, e, 'move')
        this.updateHover(p.x, p.y)
        return
      }
      if (g?.mode === 'box' && this.dragRect) {
        if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) > 3) g.moved = true
        this.dragRect.b = this.toWorld(p.x, p.y)
        this.updateHover(p.x, p.y)
        return
      }
      if (g && (g.mode === 'crop' || g.mode === 'imgxf')) {
        if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) > 2) g.moved = true
        if (g.moved) this.editDrag(g, p.x, p.y, 'move', e.shiftKey)
        this.updateHover(p.x, p.y)
        return
      }
      if (g?.mode === 'land') {
        if (this.tool === 'lbrush') {
          const w = this.toWorld(p.x, p.y)
          this.hooks.onLand(this.tool, 'move', w.x, w.y, e)
        }
        if (this.lasso) {
          const last = this.lasso[this.lasso.length - 1]
          const ls = this.toScreen(last[0], last[1])
          if (Math.hypot(ls.x - p.x, ls.y - p.y) >= 4) {
            const w = this.toWorld(p.x, p.y)
            this.lasso.push([w.x, w.y])
            this.invalidate(false)
          }
        }
        this.updateHover(p.x, p.y)
        return
      }
      if (g?.mode === 'decor') {
        if (isDecorTool(this.tool)) {
          const w = this.toWorld(p.x, p.y)
          this.hooks.onDecor(this.tool, 'move', w.x, w.y, e)
        }
        this.updateHover(p.x, p.y)
        return
      }
      if (g?.mode === 'poi') {
        if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) > 2) g.moved = true
        if (g.moved) this.dragPoi(g, p.x, p.y, e, 'move')
        this.updateHover(p.x, p.y)
        return
      }
      if (isVectorTool(this.tool) && (!g || g.mode === 'vector')) this.vec.pointerMove(this.tool, p.x, p.y, e)
      if (g?.mode === 'vector') {
        this.updateHover(p.x, p.y)
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

    /** Release a pointer. `id` ends a stale pointer other than the event's, at its last position. */
    const end = (e: PointerEvent, id = e.pointerId) => {
      const last = this.pointers.get(id)
      if (!last) return
      this.pointers.delete(id)
      const g = this.gesture
      if (g?.mode === 'pinch') {
        if (this.pointers.size === 0) this.gesture = null
        return
      }
      this.gesture = null
      if (!g) return
      const p = id === e.pointerId && e.type !== 'lostpointercapture' ? this.local(e) : last
      if (g.mode === 'crop' || g.mode === 'imgxf') {
        if (g.moved) this.editDrag(g, p.x, p.y, 'end', e.shiftKey)
        this.updateHover(p.x, p.y)
        return
      }
      if (g.mode === 'sel') {
        if (g.moved && g.sel) this.moveSel(g.sel, p.x, p.y, e, 'end')
        this.updateHover(p.x, p.y)
        return
      }
      if (g.mode === 'box') {
        const r = this.dragRect
        this.dragRect = null
        if (r && g.moved) {
          const box = { minX: Math.min(r.a.x, r.b.x), maxX: Math.max(r.a.x, r.b.x), minY: Math.min(r.a.y, r.b.y), maxY: Math.max(r.a.y, r.b.y) }
          const inside = this.hitsIn(box)
          this.setSelected(g.additive ? [...this.selectedHits(), ...inside.filter((x) => !this.isSelected(x))] : inside)
        }
        this.invalidate(false)
        return
      }
      if (g.mode === 'land') {
        const w = this.toWorld(p.x, p.y)
        const lasso = this.lasso
        this.lasso = null
        if (lasso) {
          if (lasso.length >= 3) this.hooks.onLandPolygon(lasso)
          this.invalidate()
        } else if (isLandTool(this.tool)) this.hooks.onLand(this.tool, 'end', w.x, w.y, e)
        this.updateHover(p.x, p.y)
        return
      }
      if (g.mode === 'decor') {
        const w = this.toWorld(p.x, p.y)
        if (isDecorTool(this.tool)) this.hooks.onDecor(this.tool, 'end', w.x, w.y, e)
        this.updateHover(p.x, p.y)
        return
      }
      if (g.mode === 'poi') {
        if (g.moved) this.dragPoi(g, p.x, p.y, e, 'end')
        this.updateHover(p.x, p.y)
        return
      }
      if (g.mode === 'vector') {
        this.vec.pointerUp(this.tool, p.x, p.y)
        this.updateHover(p.x, p.y)
        return
      }
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
    el.addEventListener('pointerup', (e) => end(e))
    el.addEventListener('pointercancel', (e) => end(e))
    el.addEventListener('lostpointercapture', (e) => end(e))

    el.addEventListener('pointerleave', () => {
      if (this.gesture) return
      this.hover = null
      this.hoverPoi = null
      this.renderReadout()
      this.invalidate(false)
    })

    el.addEventListener(
      'wheel',
      (e) => {
        if (overlay(e)) return
        e.preventDefault()
        const p = this.local(e)
        const dy = (e.deltaMode === 1 ? 16 : 1) * (e.deltaY || e.deltaX)
        this.zoomBy(Math.pow(1.0015, -dy), p.x, p.y)
        this.updateHover(p.x, p.y)
      },
      { passive: false },
    )

    el.addEventListener('dblclick', (e) => {
      if (overlay(e)) return
      const p = this.local(e)
      if (isVectorTool(this.tool)) {
        this.vec.dblclick(this.tool, p.x, p.y)
        return
      }
      if (this.tool !== 'pan') return
      this.zoomBy(2, p.x, p.y)
    })

    el.addEventListener('contextmenu', (e) => {
      if (overlay(e)) return
      e.preventDefault()
      const p = this.local(e)
      const w = this.toWorld(p.x, p.y)
      this.hooks.onContextMenu(w.x, w.y, this.poiAt(p.x, p.y), e.clientX, e.clientY)
    })

    el.addEventListener('keyup', (e) => {
      if (e.key === ' ') this.spaceDown = false
    })
    el.addEventListener('blur', () => (this.spaceDown = false))
    el.addEventListener('keydown', (e) => {
      if (overlay(e)) return
      if (e.key === ' ') {
        this.spaceDown = true
        e.preventDefault()
        return
      }
      if (this.tool === 'vselect' && this.selKey(e)) {
        e.preventDefault()
        return
      }
      if (isVectorTool(this.tool) && this.vec.key(this.tool, e)) {
        e.preventDefault()
        return
      }
      if (this.tool === 'pmove' && this.selectedId && e.key.startsWith('Arrow')) {
        const pt = this.profile?.points.find((q) => q.id === this.selectedId)
        if (pt) {
          const d = snapStep(e)
          const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0
          const dy = e.key === 'ArrowDown' ? -d : e.key === 'ArrowUp' ? d : 0
          this.hooks.onPoiMove(pt.id, snapTo(pt.x + dx, d), snapTo(pt.y + dy, d), 'end')
          e.preventDefault()
          return
        }
      }
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
      this.invalidate(false)
    })
  }

  private click(sx: number, sy: number): void {
    const w = this.toWorld(sx, sy)
    const poi = this.poiAt(sx, sy)
    switch (this.tool) {
      case 'pan':
        this.selectedId = poi?.id ?? null
        this.hooks.onSelectPoi(poi)
        if (!poi) this.hooks.onInspectShape(this.vec.featuresAt(sx, sy, true).find((f) => f.name || f.note) ?? null)
        this.invalidate(false)
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
        this.hooks.onPick(this.tool, w.x, w.y)
        return
      case 'vspot':
        this.vec.click(this.tool, sx, sy)
        return
    }
  }

  private dragPoi(g: NonNullable<MapView['gesture']>, sx: number, sy: number, e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }, phase: 'move' | 'end'): void {
    if (!g.poiId || !g.grab) return
    const w = this.toWorld(sx, sy)
    const d = snapStep(e)
    this.hooks.onPoiMove(g.poiId, snapTo(w.x + g.grab.x, d), snapTo(w.y + g.grab.y, d), phase)
  }

  private editDrag(g: NonNullable<MapView['gesture']>, sx: number, sy: number, phase: 'move' | 'end', shift: boolean): void {
    const meta = this.profile?.image
    if (!meta) return
    if (g.mode === 'crop' && g.crop && g.startCrop && g.startImg) {
      this.hooks.onImageEdit({ crop: this.dragCrop(g.crop, g.startCrop, g.startImg, this.screenToImg(sx, sy)) }, phase)
    } else if (g.mode === 'imgxf' && g.crop && g.startRect && g.startWorld) {
      this.hooks.onImageEdit({ calib: this.dragXf(g.crop, g.startRect, g.startWorld, this.toWorld(sx, sy), shift) }, phase)
    }
  }

  private updateHover(sx: number, sy: number): void {
    const w = this.toWorld(sx, sy)
    this.hover = { x: w.x, y: w.y, sx, sy }
    this.hoverPoi = this.poiAt(sx, sy)
    const g = this.gesture
    const crop = g?.mode === 'crop' || g?.mode === 'imgxf' ? g.crop! : g ? null : this.cropHit(sx, sy)
    const vcur = this.tool === 'vselect' && !g ? (this.vec.grabsEdit(sx, sy) ? this.vec.cursorFor(this.tool, sx, sy) : this.hitsAt(sx, sy).length ? 'move' : null) : isVectorTool(this.tool) ? this.vec.cursorFor(this.tool, sx, sy) : null
    this.el.style.cursor = this.spaceDown || g?.mode === 'pan' ? (g?.moved ? 'grabbing' : 'grab') : crop ? CROP_CURSOR[crop] : (vcur ?? (g?.mode === 'poi' ? 'grabbing' : this.hoverPoi && this.tool === 'pmove' ? 'move' : this.hoverPoi && this.tool === 'pan' ? 'pointer' : ''))
    this.renderReadout()
    this.invalidate(false)
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
    if (p.land && this.layers.land) {
      const b = this.land.biomeAt(p.land, x, y)
      if (b !== null) r.append(h('div', { class: 'mt-ro-dim' }, biomeName(b, p.land)))
    }
    // What the vector layers say is here: "Land · Forest", or "Sea".
    const fs = p.features ?? []
    if (fs.length) {
      const areas = areasAt(fs, x, y, (l) => layerSettings(p.layerSettings, l).visible)
      const hasLand = fs.some((f) => f.layer === 'landmass' && f.type === 'land' && f.geom === 'area')
      const terrain = areas.filter((f) => f.layer !== 'landmass').map((f) => f.name ?? typeLabel(f.layer, f.type, f.geom))
      const land = areas.find((f) => f.layer === 'landmass')
      const ground = land ? (land.type === 'lake' ? (land.name ?? 'Lake') : (land.name ?? 'Land')) : hasLand ? 'Sea' : null
      const text = [ground, ...terrain].filter(Boolean).join(' · ')
      if (text) r.append(h('div', { class: 'mt-ro-dim' }, text))
    }
    if (!poi) {
      const n = nearest(p, x, y, 1)[0]
      if (n) r.append(h('div', { class: 'mt-ro-dim' }, `Nearest: ${n.poi.name}, ${formatKm(n.km)} ${n.dir}`))
    }
    const me = this.chat?.pos
    if (me) {
      const km = distanceUnits(me.x, me.y, x, y) * p.unitKm
      if (km > 0.05) r.append(h('div', { class: 'mt-ro-dim' }, `From you: ${formatKm(km)} ${compass(bearing(me.x, me.y, x, y))}`))
    }
    if (this.editingImage()) {
      const ip = this.screenToImg(this.hover.sx, this.hover.sy)
      r.append(h('div', { class: 'mt-ro-dim' }, `Image pixel ${Math.round(ip.px)}, ${Math.round(ip.py)}`))
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

  /** Set while drawing a bake: no background, rulers or tool overlays. */
  private baking = false

  /**
   * Bake: draw the whole canvas into a new picture `width` pixels wide, with
   * the layers that are visible now and none of the tools' overlays.
   */
  bake(width: number): HTMLCanvasElement | null {
    const p = this.profile
    if (!p) return null
    const b = p.bounds
    const height = Math.max(1, Math.round((width * (b.maxY - b.minY)) / (b.maxX - b.minX)))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const saved = { g: this.g, w: this.w, hgt: this.hgt, dpr: this.dpr, view: { ...this.view }, hover: this.hover, gesture: this.gesture }
    this.g = ctx
    this.w = width
    this.hgt = height
    this.dpr = 1
    this.view = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, s: width / (b.maxX - b.minX) }
    this.hover = null
    this.gesture = null
    this.baking = true
    try {
      this.draw()
    } finally {
      Object.assign(this, saved)
      this.baking = false
      this.invalidate()
    }
    return canvas
  }

  private draw(): void {
    if (!this.w) return
    this.decor.scale = this.scalePreview ?? this.profile?.decorScale ?? 1
    const g = this.g
    const t = this.readTheme()
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.clearRect(0, 0, this.w, this.hgt)
    if (!this.baking) {
      g.fillStyle = t.bg
      g.fillRect(0, 0, this.w, this.hgt)
    }

    const p = this.profile
    const o = this.toWorld(0, 0)
    const unitPerPx = Math.abs(this.toWorld(1, 0).x - o.x) || 1 / this.view.s
    const step = niceStep(80 * unitPerPx)
    if (p) {
      const cropping = this.tool === 'crop' && this.editingImage()
      const editingImage = this.editingImage()
      const colors = { bg: t.bg, text: t.text, primary: t.primary, accent: t.accent }
      // The picture sits under the vector layers, except while it's being cropped
      // or transformed, when it comes to the front so it can be lined up.
      // Picking colour samples needs the picture in view, so it comes to the front then.
      // A blended picture is a texture laid over the terrain, so it goes above it.
      const picOnTop = this.imageOnTop || PICTURE_TOOLS.has(this.tool) || !!p.image?.blend
      if (this.imageVisible() && !editingImage && !picOnTop) this.drawImage(false)
      this.drawBase(p)
      if (this.liveStamps && this.layers.decor) this.decor.draw(this.g, this.liveStamps, this.painter, this.w, this.hgt, this.decorOpacity)
      if (this.imageVisible() && !editingImage && picOnTop) this.drawImage(false)
      this.vec.draw(this.g, this.w, this.hgt, colors)
      if (this.imageVisible() && editingImage) this.drawImage(cropping)
      if (this.layers.grid) this.drawGrid(step, t)
      if (!cropping) {
        if (this.layers.regions) this.drawZones(p, 'region', t)
        if (this.layers.zones) this.drawZones(p, 'zone', t)
        if (this.layers.trail) this.drawTrail(t)
        this.drawDestLine(t)
        if (this.layers.points) this.drawPoints(p, t)
        this.drawMeasure(p, t)
        this.drawMarkers(t)
        this.drawDragRect(t)
      }
      this.vec.drawOverlay(this.g, colors, this.tool)
      if (this.tool === 'vselect') this.drawSelDecor(p, t)
      if (this.snapMark && (this.gesture?.mode === 'vector' || this.gesture?.mode === 'sel')) {
        const m = this.toScreen(this.snapMark.x, this.snapMark.y)
        g.strokeStyle = t.accent
        g.lineWidth = 2
        g.strokeRect(m.x - 5, m.y - 5, 10, 10)
      }
      if (this.lasso && this.lasso.length > 1) {
        g.beginPath()
        this.lasso.forEach(([x, y], i) => {
          const s = this.toScreen(x, y)
          if (i) g.lineTo(s.x, s.y)
          else g.moveTo(s.x, s.y)
        })
        g.closePath()
        g.fillStyle = 'rgba(255,255,255,0.12)'
        g.fill()
        g.strokeStyle = t.text
        g.lineWidth = 1.5
        g.setLineDash([5, 4])
        g.stroke()
        g.setLineDash([])
      }
      if ((this.tool === 'lbrush' || isDecorTool(this.tool)) && this.hover && (p.land || isDecorTool(this.tool))) {
        g.beginPath()
        g.arc(this.hover.sx, this.hover.sy, this.brushPx, 0, Math.PI * 2)
        g.strokeStyle = t.text
        g.lineWidth = 1.5
        g.setLineDash([4, 3])
        g.stroke()
        g.setLineDash([])
      }
      if (editingImage) this.drawCropEditor(t, !cropping)
    }
    if (!this.baking) this.drawRulers(step, t)
  }

  // ── Select tool ───────────────────────────────────────────────────────────

  /** Everything under a screen point, topmost first: places, spots and lines, decorations, then areas. */
  private hitsAt(sx: number, sy: number): Hit[] {
    const p = this.profile
    if (!p) return []
    const out: Hit[] = []
    if (this.layers.points) {
      const near = p.points
        .filter((q) => !q.hidden)
        .map((q) => ({ q, d: Math.hypot(this.toScreen(q.x, q.y).x - sx, this.toScreen(q.x, q.y).y - sy) }))
        .filter((x) => x.d < 10)
        .sort((a, b) => a.d - b.d)
      for (const { q } of near) out.push({ kind: 'poi', id: q.id })
    }
    const feats = this.vec.featuresAt(sx, sy)
    for (const f of feats) if (f.geom !== 'area') out.push({ kind: 'feature', id: f.id })
    if (p.decor?.length && this.layers.decor) for (const i of stampsAt(p.decor, this.painter, sx, sy, p.decorScale ?? 1)) out.push({ kind: 'decor', i })
    for (const f of feats) if (f.geom === 'area') out.push({ kind: 'feature', id: f.id })
    return out
  }

  /** Everything inside a world rectangle that the box selects. */
  private hitsIn(r: Bounds): Hit[] {
    const p = this.profile
    if (!p) return []
    const inside = (x: number, y: number) => x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY
    const out: Hit[] = []
    if (this.layers.points) for (const q of p.points) if (!q.hidden && inside(q.x, q.y)) out.push({ kind: 'poi', id: q.id })
    for (const f of this.vec.featuresIn(r)) out.push({ kind: 'feature', id: f.id })
    if (this.layers.decor) (p.decor ?? []).forEach((st, i) => inside(st.x, st.y) && out.push({ kind: 'decor', i }))
    return out
  }

  private isSelected(h: Hit): boolean {
    return h.kind === 'poi' ? this.selPois.has(h.id) : h.kind === 'decor' ? this.selDecor.has(h.i) : this.vec.selection.has(h.id)
  }

  selectedHits(): Hit[] {
    return [
      ...[...this.selPois].map((id): Hit => ({ kind: 'poi', id })),
      ...[...this.vec.selection].map((id): Hit => ({ kind: 'feature', id })),
      ...[...this.selDecor].map((i): Hit => ({ kind: 'decor', i })),
    ]
  }

  /** Replace the Select tool's selection. */
  setSelected(hits: Hit[]): void {
    const before = this.selectedHits()
    this.selPois.clear()
    this.selDecor.clear()
    const feats: string[] = []
    for (const h of hits) {
      if (h.kind === 'poi') this.selPois.add(h.id)
      else if (h.kind === 'decor') this.selDecor.add(h.i)
      else if (!feats.includes(h.id)) feats.push(h.id)
    }
    const featsChanged = feats.length !== this.vec.selection.size || feats.some((id) => !this.vec.selection.has(id))
    this.vec.choose(feats)
    this.selectedId = this.selPois.size === 1 ? [...this.selPois][0] : null
    this.invalidate(false)
    const after = this.selectedHits()
    if (before.length === after.length && before.every((x) => after.some((y) => sameHit(x, y)))) return
    if (featsChanged) this.hooks.onFeatureSelection(feats)
    this.hooks.onSelectionChange()
  }

  /** The drag's starting state: where everything selected was, and the point that snaps. */
  private startSelDrag(hit: Hit, sx: number, sy: number): SelDrag {
    const p = this.profile!
    const world = this.toWorld(sx, sy)
    const pois = p.points.filter((q) => this.selPois.has(q.id)).map((q) => ({ id: q.id, x: q.x, y: q.y }))
    const decor = [...this.selDecor].filter((i) => p.decor?.[i]).map((i) => ({ i, st: p.decor![i] }))
    const editable = new Set(this.vec.featuresIn({ minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity }).map((f) => f.id))
    const feats = (p.features ?? []).filter((f) => this.vec.selection.has(f.id) && editable.has(f.id))
    // The point that snaps: the grabbed place or stamp, or the grabbed shape's nearest vertex.
    let ref: [number, number] = [world.x, world.y]
    if (hit.kind === 'poi') {
      const q = p.points.find((x) => x.id === hit.id)
      if (q) ref = [q.x, q.y]
    } else if (hit.kind === 'decor') {
      const st = p.decor?.[hit.i]
      if (st) ref = [st.x, st.y]
    } else {
      let best = Infinity
      for (const f of feats.filter((x) => x.id === hit.id))
        for (const r of f.rings)
          for (const q of r) {
            const d = Math.hypot(q[0] - world.x, q[1] - world.y)
            if (d < best) (best = d), (ref = [q[0], q[1]])
          }
    }
    return { world, ref, pois, decor, feats }
  }

  /** Move the selection by the drag so far. Decorations show as a preview until the drop. */
  private moveSel(d: SelDrag, sx: number, sy: number, mods: { ctrlKey: boolean; metaKey: boolean }, phase: 'move' | 'end'): void {
    const p = this.profile
    if (!p) return
    const w = this.toWorld(sx, sy)
    const t = this.snapWorld(d.ref[0] + w.x - d.world.x, d.ref[1] + w.y - d.world.y, mods, new Set(d.feats.map((f) => f.id)), new Set(d.pois.map((q) => q.id)))
    this.shiftSel(d, t.x - d.ref[0], t.y - d.ref[1], phase)
  }

  private shiftSel(d: SelDrag, dx: number, dy: number, phase: 'move' | 'end'): void {
    const p = this.profile!
    const r = (v: number) => Math.round(v * 100) / 100
    const pois = d.pois.map((q) => ({ id: q.id, x: r(q.x + dx), y: r(q.y + dy) }))
    let features: Feature[] | null = null
    if (d.feats.length) {
      const moved = new Map(d.feats.map((f) => [f.id, { ...f, rings: f.rings.map((ring) => ring.map(([x, y]) => [r(x + dx), r(y + dy)] as [number, number])) }]))
      features = (p.features ?? []).map((f) => moved.get(f.id) ?? f)
    }
    let decor: DecorStamp[] | null = null
    if (d.decor.length) {
      decor = (p.decor ?? []).slice()
      const now = d.decor.map(({ i, st }) => (decor![i] = { ...st, x: r(st.x + dx), y: r(st.y + dy) }))
      if (phase === 'move') {
        // The dragged stamps leave the cached picture once, then draw live on top.
        if (!this.liveStamps) {
          const picked = new Set(d.decor.map((x) => x.i))
          for (const { st } of d.decor) {
            const m = st.s * this.decor.scale * 1.5
            this.eraseAreas.push({ minX: st.x - m, maxX: st.x + m, minY: st.y - m, maxY: st.y + m })
          }
          this.strokeDecor = (p.decor ?? []).filter((_, i) => !picked.has(i))
        }
        this.liveStamps = now
      }
    }
    if (pois.length || features || phase === 'end') this.hooks.onMoveSelection({ pois, features, decor: phase === 'end' ? decor : null }, phase)
    if (phase === 'end') this.endPreview()
    else this.invalidate(false)
  }

  /**
   * Resize the selected decorations to `factor` times the sizes in `base`
   * (index → stamp as they were when resizing began). `end` saves.
   */
  resizeSelectedDecor(base: Map<number, DecorStamp>, factor: number, phase: 'move' | 'end'): void {
    const p = this.profile
    if (!p?.decor || !base.size) return
    const list = p.decor.slice()
    const r = (v: number) => Math.round(v * 1000) / 1000
    for (const [i, st] of base) if (list[i]) list[i] = { ...st, s: r(Math.max(0.01, st.s * factor)) }
    if (phase === 'end') {
      this.hooks.onMoveSelection({ pois: [], features: null, decor: list }, 'end')
      this.endPreview()
      return
    }
    // Repaint around the stamps at their biggest so far.
    let area: Bounds | null = null
    for (const st of base.values()) {
      const m = st.s * Math.max(1, factor) * this.decor.scale * 1.5 + 1
      area = area
        ? { minX: Math.min(area.minX, st.x - m), maxX: Math.max(area.maxX, st.x + m), minY: Math.min(area.minY, st.y - m), maxY: Math.max(area.maxY, st.y + m) }
        : { minX: st.x - m, maxX: st.x + m, minY: st.y - m, maxY: st.y + m }
    }
    if (area) this.eraseAreas.push(area)
    this.strokeDecor = list
    this.invalidate(false)
  }

  /** Delete, arrow nudges and Escape for the Select tool. */
  private selKey(e: KeyboardEvent): boolean {
    const any = this.selPois.size || this.selDecor.size || this.vec.selection.size
    if (!any) return false
    if ((e.key === 'Delete' || e.key === 'Backspace') && (this.selPois.size || this.selDecor.size)) {
      this.hooks.onDeleteSelection({ pois: [...this.selPois], decor: [...this.selDecor], features: [...this.vec.selection] })
      this.setSelected([])
      return true
    }
    if (e.key === 'Escape') {
      this.setSelected([])
      return true
    }
    if (e.key.startsWith('Arrow') && (this.selPois.size || this.selDecor.size)) {
      const step = snapStep(e)
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
      const dy = e.key === 'ArrowDown' ? -step : e.key === 'ArrowUp' ? step : 0
      const first = this.selectedHits()[0]
      this.shiftSel(this.startSelDrag(first, 0, 0), dx, dy, 'end')
      return true
    }
    return false
  }

  /** Dashed boxes around selected decorations. */
  private drawSelDecor(p: WorldProfile, t: Theme): void {
    const list = this.liveStamps ? null : p.decor
    if (!this.selDecor.size) return
    const g = this.g
    g.save()
    g.strokeStyle = t.accent
    g.lineWidth = 1.2
    g.setLineDash([4, 3])
    for (const st0 of this.liveStamps ?? [...this.selDecor].map((i) => list?.[i])) {
      const st = st0
      if (!st) continue
      const b = stampBox(st, this.painter, this.decor.scale)
      g.strokeRect(b.x0 - 2, b.y0 - 2, b.x1 - b.x0 + 4, b.y1 - b.y0 + 4)
    }
    g.restore()
  }

  /** Show terrain cells painted by a stroke that isn't saved yet. */
  previewCells(grid: LandGrid, biome: number, cells: number[]): void {
    if (!this.strokeCells || this.strokeCells.grid !== grid || this.strokeCells.biome !== biome) {
      this.strokeCells = { grid, biome, cells: [] }
      this.strokeStamps = null
      this.strokeDrawn = 0
    }
    this.strokeCells.cells.push(...cells)
    this.invalidate(false)
  }

  /** Show decorations added by a stroke that isn't saved yet. */
  previewStamps(stamps: DecorStamp[]): void {
    if (!this.strokeStamps) {
      this.strokeStamps = []
      this.strokeCells = null
      this.strokeDrawn = 0
    }
    this.strokeStamps.push(...stamps)
    this.invalidate(false)
  }

  /**
   * Show what an eraser stroke that isn't saved yet leaves of the decorations;
   * only the area around (x, y) is repainted.
   */
  previewDecor(list: DecorStamp[], x: number, y: number, radius: number): void {
    this.strokeDecor = list
    this.eraseAreas.push({ minX: x - radius, maxX: x + radius, minY: y - radius, maxY: y + radius })
    this.invalidate(false)
  }

  /** The stroke was saved (or dropped): stop showing it. */
  endPreview(): void {
    const decorTouched = !!(this.liveStamps || this.strokeStamps || this.strokeDecor)
    const landTouched = !!this.strokeCells
    this.liveStamps = null
    if (!landTouched && !decorTouched) return
    this.strokeCells = null
    this.strokeStamps = null
    this.strokeDecor = null
    this.eraseAreas = []
    this.strokeDrawn = 0
    // Only the layer the stroke painted into is redrawn from the saved map.
    if (this.base) {
      if (landTouched) this.base.landKey = []
      if (decorTouched) this.base.decorKey = []
    }
    this.invalidate(false)
  }

  /** Maps the world into a cached layer, drawn at the cache's own view with its margin. */
  private cachePainter(v: View, m: number): import('./terrain').Painter {
    return {
      toScreen: (x, y) => ({ x: (x - v.cx) * v.s + this.w / 2 + m, y: this.hgt / 2 - (y - v.cy) * v.s + m }),
      toWorld: (sx, sy) => ({ x: (sx - m - this.w / 2) / v.s + v.cx, y: v.cy - (sy - m - this.hgt / 2) / v.s }),
      scale: () => v.s,
    }
  }

  /** Paint the stroke's cells or stamps not yet in the cached layers into them. */
  private paintStroke(): void {
    const b = this.base
    if (!b) return
    const items = this.strokeCells?.cells ?? this.strokeStamps
    if (!items || this.strokeDrawn >= items.length) return
    const canvas = this.strokeCells ? b.land : b.decor
    const g = canvas.getContext('2d')!
    const painter = this.cachePainter(b.view, b.margin)
    g.save()
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    if (this.strokeCells) {
      const { grid, biome } = this.strokeCells
      const graph = graphFor(grid)
      g.beginPath()
      for (let i = this.strokeDrawn; i < items.length; i++) {
        graph.v[items[i] as number].forEach((vt, j) => {
          const s = painter.toScreen(graph.vp[2 * vt], graph.vp[2 * vt + 1])
          if (j) g.lineTo(s.x, s.y)
          else g.moveTo(s.x, s.y)
        })
        g.closePath()
      }
      if (biome === EMPTY) g.globalCompositeOperation = 'destination-out'
      g.globalAlpha = biome === EMPTY ? 1 : this.landOpacity
      g.fillStyle = g.strokeStyle = biome === EMPTY ? '#000' : biomeColor(biome, grid)
      g.lineWidth = 1
      g.fill()
      g.stroke()
    } else {
      this.decor.draw(g, (items as DecorStamp[]).slice(this.strokeDrawn), painter, this.w + 2 * b.margin, this.hgt + 2 * b.margin, this.decorOpacity)
    }
    g.restore()
    this.strokeDrawn = items.length
  }

  /** Terrain and decorations, from the cached layers when they still fit (see `base`). */
  private drawBase(p: WorldProfile): void {
    const land = p.land && this.layers.land ? p.land : null
    const shown = this.strokeDecor ?? p.decor
    const decor = (shown?.length || this.strokeStamps) && this.layers.decor ? (shown ?? []) : null
    if (!land && !decor) return
    if (this.baking) {
      if (land) this.land.draw(this.g, land, this.painter, this.w, this.hgt, this.landOpacity)
      if (decor) this.decor.draw(this.g, decor, this.painter, this.w, this.hgt, this.decorOpacity)
      return
    }
    const v = this.view
    const now = performance.now()
    const d = this.drawnView
    if (!d || d.cx !== v.cx || d.cy !== v.cy || d.s !== v.s) this.movedAt = now
    this.drawnView = { ...v }
    const size = [this.w, this.hgt, this.dpr]
    const landKey = [land, this.landOpacity, ...size]
    const decorKey = [decor, this.decorOpacity, this.decor.scale, ...size]
    const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((k, i) => k === b[i])
    const c = this.base
    const landFresh = !!c && !this.baseDirty && same(c.landKey, landKey)
    const decorFresh = !!c && !this.baseDirty && same(c.decorKey, decorKey)
    const sameView = !!c && c.view.cx === v.cx && c.view.cy === v.cy && c.view.s === v.s
    const moving = now - this.movedAt < 180
    // While the view moves, shift and scale the cached layers, as long as they still cover most of the view.
    if (c && landFresh && decorFresh && !sameView && moving) {
      const k = v.s / c.view.s
      if (k > 0.5 && k < 3) {
        const dx = (c.view.cx - v.cx) * v.s
        const dy = (v.cy - c.view.cy) * v.s
        const m = c.margin
        this.paintStroke()
        for (const layer of [c.land, c.decor]) this.g.drawImage(layer, this.w / 2 + dx - (this.w / 2 + m) * k, this.hgt / 2 + dy - (this.hgt / 2 + m) * k, (this.w + 2 * m) * k, (this.hgt + 2 * m) * k)
        clearTimeout(this.settleTimer)
        this.settleTimer = window.setTimeout(() => this.invalidate(false), 200)
        return
      }
    }
    if (!c || !sameView) this.renderBase(land, decor, landKey, decorKey)
    else {
      if (!landFresh) this.renderLayer('land', land, decor, landKey)
      if (!decorFresh) {
        // An eraser stroke: repaint only around the brush.
        if (!this.baseDirty && this.strokeDecor && this.eraseAreas.length) this.repaintDecor(decor, decorKey)
        else this.renderLayer('decor', land, decor, decorKey)
      }
      this.baseDirty = false
    }
    this.eraseAreas = []
    this.paintStroke()
    const b = this.base!
    for (const layer of [b.land, b.decor]) this.g.drawImage(layer, -b.margin, -b.margin, this.w + 2 * b.margin, this.hgt + 2 * b.margin)
  }

  /** Both cached layers, at the current view. */
  private renderBase(land: LandGrid | null, decor: DecorStamp[] | null, landKey: unknown[], decorKey: unknown[]): void {
    // A quarter of the view on each side, so short pans don't show bare edges.
    const margin = Math.round(Math.min(this.w, this.hgt) * 0.25)
    this.base = {
      land: this.base?.land ?? document.createElement('canvas'),
      decor: this.base?.decor ?? document.createElement('canvas'),
      view: { ...this.view },
      margin,
      landKey,
      decorKey,
    }
    this.renderLayer('land', land, decor, landKey)
    this.renderLayer('decor', land, decor, decorKey)
    this.baseDirty = false
    this.strokeDrawn = 0
  }

  private renderLayer(which: 'land' | 'decor', land: LandGrid | null, decor: DecorStamp[] | null, key: unknown[]): void {
    const b = this.base!
    const canvas = b[which]
    const cw = Math.round((this.w + 2 * b.margin) * this.dpr)
    const ch = Math.round((this.hgt + 2 * b.margin) * this.dpr)
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }
    const g = canvas.getContext('2d')!
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, cw, ch)
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const painter = this.cachePainter(b.view, b.margin)
    const vw = this.w + 2 * b.margin
    const vh = this.hgt + 2 * b.margin
    if (which === 'land' && land) this.land.draw(g, land, painter, vw, vh, this.landOpacity)
    if (which === 'decor' && decor) this.decor.draw(g, decor, painter, vw, vh, this.decorOpacity)
    if (which === 'land') b.landKey = key
    else b.decorKey = key
    // A stroke being previewed lives in the layer it paints, so it goes back in.
    if ((which === 'land' && this.strokeCells) || (which === 'decor' && this.strokeStamps)) this.strokeDrawn = 0
  }

  /** Repaint the decorations layer only inside the areas an eraser stroke touched. */
  private repaintDecor(decor: DecorStamp[] | null, key: unknown[]): void {
    const b = this.base!
    const g = b.decor.getContext('2d')!
    const painter = this.cachePainter(b.view, b.margin)
    const vw = this.w + 2 * b.margin
    const vh = this.hgt + 2 * b.margin
    // Stamps reach past their centre; repaint neighbours that overlap the area too.
    let reach = 1
    for (const s of decor ?? []) if (s.s * this.decor.scale * 1.5 > reach) reach = s.s * this.decor.scale * 1.5
    let areas = this.eraseAreas
    if (areas.length > 4)
      areas = [areas.reduce((u, a) => ({ minX: Math.min(u.minX, a.minX), maxX: Math.max(u.maxX, a.maxX), minY: Math.min(u.minY, a.minY), maxY: Math.max(u.maxY, a.maxY) }))]
    for (const a of areas) {
      const p0 = painter.toScreen(a.minX - reach, a.maxY + reach)
      const p1 = painter.toScreen(a.maxX + reach, a.minY - reach)
      g.save()
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      g.beginPath()
      g.rect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y)
      g.clip()
      g.clearRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y)
      if (decor) {
        const near = decor.filter((s) => s.x > a.minX - 3 * reach && s.x < a.maxX + 3 * reach && s.y > a.minY - 3 * reach && s.y < a.maxY + 3 * reach)
        this.decor.draw(g, near, painter, vw, vh, this.decorOpacity)
      }
      g.restore()
    }
    b.decorKey = key
  }

  private screenRect(px: number, py: number, pw: number, ph: number): { x: number; y: number; w: number; h: number } {
    const a = this.imgToScreen(px, py)
    const b = this.imgToScreen(px + pw, py + ph)
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
  }

  /** The cropped image, or the whole picture while cropping. */
  private drawImage(full: boolean): void {
    const meta = this.profile!.image!
    const img = this.image!
    const c = full ? { x: 0, y: 0, w: meta.width, h: meta.height } : meta.crop
    const r = this.screenRect(c.x, c.y, c.w, c.h)
    const g = this.g
    g.save()
    // Sampling needs the picture clear; the wand and landmass tools show the terrain through it.
    g.globalAlpha = this.editingImage() || this.tool === 'lsample' ? Math.max(meta.opacity, 0.85) : PICTURE_TOOLS.has(this.tool) ? Math.min(Math.max(meta.opacity, 0.5), 0.6) : meta.opacity
    g.imageSmoothingEnabled = true
    g.imageSmoothingQuality = 'high'
    if (meta.blend && !full && !this.editingImage() && !PICTURE_TOOLS.has(this.tool)) g.globalCompositeOperation = meta.blend
    g.drawImage(img, c.x, c.y, c.w, c.h, r.x, r.y, r.w, r.h)
    g.restore()
  }

  /**
   * Crop: dimmed outside, a framed box with thirds, eight handles and its pixel
   * size. Transform: the same box and handles around the placed image, sized in
   * world units.
   */
  private drawCropEditor(t: Theme, transform = false): void {
    const meta = this.profile!.image!
    const full = this.screenRect(0, 0, meta.width, meta.height)
    const c = this.screenRect(meta.crop.x, meta.crop.y, meta.crop.w, meta.crop.h)
    const g = this.g
    g.save()
    g.fillStyle = 'rgba(0,0,0,0.55)'
    g.beginPath()
    if (!transform) {
      g.rect(full.x, full.y, full.w, full.h)
      g.rect(c.x, c.y, c.w, c.h)
      g.fill('evenodd')
    }
    g.strokeStyle = 'rgba(255,255,255,0.35)'
    g.lineWidth = 1
    g.beginPath()
    for (const f of [1 / 3, 2 / 3]) {
      g.moveTo(c.x + c.w * f, c.y)
      g.lineTo(c.x + c.w * f, c.y + c.h)
      g.moveTo(c.x, c.y + c.h * f)
      g.lineTo(c.x + c.w, c.y + c.h * f)
    }
    g.stroke()
    g.strokeStyle = '#fff'
    g.lineWidth = 1.5
    g.strokeRect(c.x, c.y, c.w, c.h)
    const active = this.gesture?.mode === 'crop' || this.gesture?.mode === 'imgxf' ? this.gesture.crop : null
    for (const hd of this.cropHandles()) {
      const corner = hd.mode.length === 2
      g.fillStyle = hd.mode === active ? t.primary : '#fff'
      g.strokeStyle = 'rgba(0,0,0,0.5)'
      g.lineWidth = 1
      g.beginPath()
      if (corner) g.arc(hd.x, hd.y, 6.5, 0, Math.PI * 2)
      else g.roundRect(hd.x - (hd.mode === 'n' || hd.mode === 's' ? 9 : 3), hd.y - (hd.mode === 'n' || hd.mode === 's' ? 3 : 9), hd.mode === 'n' || hd.mode === 's' ? 18 : 6, hd.mode === 'n' || hd.mode === 's' ? 6 : 18, 3)
      g.fill()
      g.stroke()
    }
    const wr = this.imageViewRect(false)!
    const label = transform ? `${Math.round((wr.maxX - wr.minX) * 10) / 10} × ${Math.round((wr.maxY - wr.minY) * 10) / 10} units` : `${meta.crop.w} × ${meta.crop.h} px`
    g.font = '600 11px system-ui, sans-serif'
    const tw = g.measureText(label).width + 12
    const ly = c.y + c.h + 8 + 20 > this.hgt ? c.y + c.h - 28 : c.y + c.h + 8
    g.fillStyle = 'rgba(0,0,0,0.65)'
    g.beginPath()
    g.roundRect(c.x + c.w / 2 - tw / 2, ly, tw, 20, 10)
    g.fill()
    g.fillStyle = '#fff'
    g.textAlign = 'center'
    g.fillText(label, c.x + c.w / 2, ly + 14)
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

  private drawPoints(p: WorldProfile, t: Theme): void {
    const g = this.g
    const placed: { x: number; y: number; w: number; h: number }[] = []
    const visible = p.points.filter((pt) => !pt.hidden)
    const priority = (pt: Poi) =>
      pt.id === this.hoverPoi?.id ? 0 : pt.id === this.selectedId || this.selPois.has(pt.id) ? 1 : this.chat?.dest && pt.x === this.chat.dest.x && pt.y === this.chat.dest.y ? 2 : 3
    const ordered = [...visible].sort((a, b) => priority(a) - priority(b))

    // Moved places: a hollow ring where the lorebook puts them, joined to where they are now.
    // All of them while moving places, otherwise only the selected one.
    g.save()
    g.setLineDash([3, 3])
    g.lineWidth = 1.2
    for (const pt of visible) {
      if (!pt.origin || (this.tool !== 'pmove' && pt.id !== this.selectedId && !this.selPois.has(pt.id))) continue
      const o = this.toScreen(pt.origin.x, pt.origin.y)
      const s = this.toScreen(pt.x, pt.y)
      g.strokeStyle = t.muted
      g.globalAlpha = 0.85
      g.beginPath()
      g.moveTo(o.x, o.y)
      g.lineTo(s.x, s.y)
      g.stroke()
      g.beginPath()
      g.arc(o.x, o.y, 4, 0, Math.PI * 2)
      g.stroke()
    }
    g.restore()

    for (const pt of visible) {
      const s = this.toScreen(pt.x, pt.y)
      if (s.x < -10 || s.y < -10 || s.x > this.w + 10 || s.y > this.hgt + 10) continue
      const hot = pt.id === this.hoverPoi?.id || pt.id === this.selectedId || this.selPois.has(pt.id)
      const style = markerStyle(p, pt)
      drawMarker(g, style, s.x, s.y, (hot ? 6 : 4.2) * (style.shape === 'dot' ? 1 : 1.15), hot ? t.text : t.bg, hot ? 2.5 : 1.5)
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

/** Drag/nudge granularity, matching the number fields: 1 unit, Shift 10, Alt 0.1, Ctrl+Alt 0.01. */
function snapStep(e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): number {
  if (e.altKey) return e.ctrlKey || e.metaKey ? 0.01 : 0.1
  return e.shiftKey ? 10 : 1
}

function snapTo(v: number, step: number): number {
  const r = Math.round(v / step) * step
  return step >= 1 ? r : Number(r.toFixed(Math.ceil(-Math.log10(step))))
}

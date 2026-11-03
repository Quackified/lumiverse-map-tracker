import type { SpindleFloatWidgetHandle, SpindleFrontendContext } from 'lumiverse-spindle-types'
import { h, icon } from './dom'

// A floating, resizable window with Windows-style snap layouts: drag the title
// bar to an edge or corner (preview shows the target), or pick a layout from the
// title-bar menu. Snapped windows re-fit when the browser window resizes.

export type Slot = 'max' | 'left' | 'right' | 'tl' | 'tr' | 'bl' | 'br' | 'l23' | 'r13' | 'l13' | 'r23' | 't1' | 't2' | 't3'

const SLOTS: Record<Slot, [number, number, number, number]> = {
  max: [0, 0, 1, 1],
  left: [0, 0, 0.5, 1],
  right: [0.5, 0, 0.5, 1],
  tl: [0, 0, 0.5, 0.5],
  tr: [0.5, 0, 0.5, 0.5],
  bl: [0, 0.5, 0.5, 0.5],
  br: [0.5, 0.5, 0.5, 0.5],
  l23: [0, 0, 2 / 3, 1],
  r13: [2 / 3, 0, 1 / 3, 1],
  l13: [0, 0, 1 / 3, 1],
  r23: [1 / 3, 0, 2 / 3, 1],
  t1: [0, 0, 1 / 3, 1],
  t2: [1 / 3, 0, 1 / 3, 1],
  t3: [2 / 3, 0, 1 / 3, 1],
}

const LAYOUTS: Slot[][] = [['left', 'right'], ['l23', 'r13'], ['l13', 'r23'], ['t1', 't2', 't3'], ['tl', 'tr', 'bl', 'br'], ['max']]

const EDGE = 10
const GAP = 6
const HOST_PAD = 12
const MIN_W = 360
const MIN_H = 260
const STORE_KEY = 'map_tracker.window'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Persisted {
  rect: Rect
  slot: Slot | null
}

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    return raw ? (JSON.parse(raw) as Persisted) : null
  } catch {
    return null
  }
}

function savePersisted(p: Persisted): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable */
  }
}

function workspace(): Rect {
  return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
}

function slotRect(slot: Slot): Rect {
  const ws = workspace()
  const [fx, fy, fw, fh] = SLOTS[slot]
  const x = ws.x + Math.round(ws.w * fx) + GAP
  const y = ws.y + Math.round(ws.h * fy) + GAP
  return { x, y, w: Math.round(ws.w * fw) - GAP * 2, h: Math.round(ws.h * fh) - GAP * 2 }
}

export interface WindowOptions {
  title: string
  content: HTMLElement
  onClose(): void
  onDock?(): void
  /** Extra title-bar elements (left of the window buttons). */
  extras?: HTMLElement[]
}

export class MapWindow {
  private widget: SpindleFloatWidgetHandle
  private frame: HTMLDivElement
  private body: HTMLDivElement
  private picker: HTMLDivElement
  private preview: HTMLDivElement
  private rect: Rect
  private slot: Slot | null
  private current: Rect
  private onResize = () => this.apply()

  constructor(
    ctx: SpindleFrontendContext,
    private opts: WindowOptions,
  ) {
    const saved = loadPersisted()
    const ws = workspace()
    const w = Math.min(980, ws.w - 40)
    const hh = Math.min(640, ws.h - 40)
    this.rect = saved?.rect ?? { x: Math.round((ws.w - w) / 2), y: Math.round((ws.h - hh) / 2), w, h: hh }
    this.slot = saved?.slot ?? null
    this.current = { ...this.rect }

    this.widget = ctx.ui.createFloatWidget({
      width: this.rect.w,
      height: this.rect.h,
      initialPosition: { x: this.rect.x, y: this.rect.y },
      snapToEdge: false,
      chromeless: true,
      tooltip: opts.title,
    })

    const title = h('div', { class: 'mt-win-title' }, icon('map'), h('span', null, opts.title))
    const snapBtn = h('button', { class: 'mt-btn mt-win-btn', title: 'Snap layouts', onclick: (e: Event) => (e.stopPropagation(), this.togglePicker()) }, icon('snap'))
    const dockBtn = opts.onDock
      ? h('button', { class: 'mt-btn mt-win-btn', title: 'Dock in sidebar', onclick: () => opts.onDock!() }, icon('dock'))
      : null
    const closeBtn = h('button', { class: 'mt-btn mt-win-btn', title: 'Close', onclick: () => opts.onClose() }, icon('close'))
    const bar = h('div', { class: 'mt-win-bar' }, title, h('div', { class: 'mt-win-spacer' }), ...(opts.extras ?? []), snapBtn, dockBtn, closeBtn)

    this.picker = this.buildPicker()
    this.body = h('div', { class: 'mt-win-body' }, opts.content)
    const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => {
      const el = h('div', { class: `mt-rs mt-rs-${d}` })
      el.addEventListener('pointerdown', (e) => this.startResize(e, d))
      return el
    })
    this.frame = h('div', { class: 'mt-window' }, bar, this.body, this.picker, ...handles)
    this.widget.root.append(this.frame)
    this.widget.root.classList.add('mt-widget-root')

    this.preview = h('div', { class: 'mt-snap-preview' })
    this.preview.hidden = true
    document.body.append(this.preview)

    bar.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button, select, input')) return
      this.startDrag(e)
    })
    bar.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('button, select, input')) return
      this.snapTo(this.slot === 'max' ? null : 'max')
    })
    this.frame.addEventListener('pointerdown', (e) => {
      if (!this.picker.hidden && !(e.target as HTMLElement).closest('.mt-picker, .mt-win-btn')) this.picker.hidden = true
    })
    window.addEventListener('resize', this.onResize)
    this.apply()
  }

  get content(): HTMLElement {
    return this.opts.content
  }

  /** Re-attach the content (after it was moved to the sidebar). */
  adopt(): void {
    if (this.opts.content.parentElement !== this.body) this.body.append(this.opts.content)
  }

  setVisible(v: boolean): void {
    this.widget.setVisible(v)
    if (v) this.apply()
  }

  isVisible(): boolean {
    return this.widget.isVisible()
  }

  destroy(): void {
    window.removeEventListener('resize', this.onResize)
    this.preview.remove()
    this.widget.destroy()
  }

  // ── Geometry ──────────────────────────────────────────────────────────────

  private apply(): void {
    const r = this.slot ? slotRect(this.slot) : this.clampFloat(this.rect)
    this.place(r)
    this.frame.dataset.snapped = this.slot ?? ''
  }

  private clampFloat(r: Rect): Rect {
    const ws = workspace()
    const w = Math.max(MIN_W, Math.min(r.w, ws.w))
    const hh = Math.max(MIN_H, Math.min(r.h, ws.h))
    const x = Math.max(ws.x - w + 80, Math.min(r.x, ws.x + ws.w - 80))
    const y = Math.max(ws.y, Math.min(r.y, ws.y + ws.h - 40))
    return { x, y, w, h: hh }
  }

  /** Positions the widget, compensating for the host's edge padding so it can sit flush. */
  private place(r: Rect): void {
    this.current = r
    const ws = workspace()
    this.widget.setSize(r.w, r.h)
    const root = this.widget.root
    root.style.width = `${r.w}px`
    root.style.height = `${r.h}px`
    const maxX = Math.max(HOST_PAD, ws.w - r.w - HOST_PAD)
    const maxY = Math.max(HOST_PAD, ws.h - r.h - HOST_PAD)
    const hostX = Math.max(HOST_PAD, Math.min(r.x, maxX))
    const hostY = Math.max(HOST_PAD, Math.min(r.y, maxY))
    this.widget.moveTo(hostX, hostY)
    const ox = r.x - hostX
    const oy = r.y - hostY
    root.style.transform = ox || oy ? `translate3d(${ox}px, ${oy}px, 0)` : ''
  }

  snapTo(slot: Slot | null): void {
    this.slot = slot
    this.picker.hidden = true
    this.apply()
    savePersisted({ rect: this.rect, slot: this.slot })
  }

  // ── Drag & snap ───────────────────────────────────────────────────────────

  private detectSlot(cx: number, cy: number): Slot | null {
    const ws = workspace()
    const left = cx <= ws.x + EDGE
    const right = cx >= ws.x + ws.w - EDGE
    const top = cy <= ws.y + EDGE
    const upper = cy < ws.y + ws.h * 0.22
    const lower = cy > ws.y + ws.h * 0.78
    if (left) return upper ? 'tl' : lower ? 'bl' : 'left'
    if (right) return upper ? 'tr' : lower ? 'br' : 'right'
    if (top) return cx < ws.x + ws.w * 0.2 ? 'tl' : cx > ws.x + ws.w * 0.8 ? 'tr' : 'max'
    return null
  }

  private showPreview(slot: Slot | null): void {
    if (!slot) {
      this.preview.hidden = true
      return
    }
    const r = slotRect(slot)
    Object.assign(this.preview.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
    this.preview.hidden = false
  }

  private startDrag(e: PointerEvent): void {
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    let start = { ...this.current }
    if (this.slot) {
      // Unsnap like Windows: restore the floating size under the pointer.
      const fx = (e.clientX - this.current.x) / this.current.w
      const w = this.rect.w
      start = { x: e.clientX - w * fx, y: this.current.y, w, h: this.rect.h }
    }
    const sx = e.clientX
    const sy = e.clientY
    let moved = false
    let target_slot: Slot | null = null
    this.frame.classList.add('mt-dragging')

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      if (!moved && Math.hypot(dx, dy) < 4) return
      if (!moved) {
        moved = true
        if (this.slot) {
          this.slot = null
          this.frame.dataset.snapped = ''
        }
      }
      this.place({ ...start, x: start.x + dx, y: Math.max(0, start.y + dy) })
      target_slot = this.detectSlot(ev.clientX, ev.clientY)
      this.showPreview(target_slot)
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      this.frame.classList.remove('mt-dragging')
      this.preview.hidden = true
      if (!moved) return
      if (target_slot) this.slot = target_slot
      else this.rect = { ...this.current }
      this.apply()
      savePersisted({ rect: this.rect, slot: this.slot })
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  private startResize(e: PointerEvent, dir: string): void {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const start = { ...this.current }
    this.slot = null
    this.frame.dataset.snapped = ''
    const sx = e.clientX
    const sy = e.clientY
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      const r = { ...start }
      if (dir.includes('e')) r.w = Math.max(MIN_W, start.w + dx)
      if (dir.includes('s')) r.h = Math.max(MIN_H, start.h + dy)
      if (dir.includes('w')) {
        r.w = Math.max(MIN_W, start.w - dx)
        r.x = start.x + start.w - r.w
      }
      if (dir.includes('n')) {
        r.h = Math.max(MIN_H, start.h - dy)
        r.y = Math.max(0, start.y + start.h - r.h)
      }
      this.place(r)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      this.rect = { ...this.current }
      savePersisted({ rect: this.rect, slot: null })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  // ── Layout picker ─────────────────────────────────────────────────────────

  private buildPicker(): HTMLDivElement {
    const tiles = LAYOUTS.map((slots) => {
      const tile = h('div', { class: 'mt-picker-tile' })
      for (const s of slots) {
        const [fx, fy, fw, fh] = SLOTS[s]
        tile.append(
          h('button', {
            class: 'mt-picker-cell',
            title: s,
            style: `left:${fx * 100}%;top:${fy * 100}%;width:${fw * 100}%;height:${fh * 100}%`,
            onclick: () => this.snapTo(s),
          }),
        )
      }
      return tile
    })
    const float = h('button', { class: 'mt-btn mt-picker-float', onclick: () => this.snapTo(null) }, 'Float')
    const el = h('div', { class: 'mt-picker' }, h('div', { class: 'mt-picker-grid' }, ...tiles), float)
    el.hidden = true
    return el
  }

  private togglePicker(): void {
    this.picker.hidden = !this.picker.hidden
  }
}

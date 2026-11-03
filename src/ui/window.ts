import type { SpindleFloatWidgetHandle, SpindleFrontendContext } from 'lumiverse-spindle-types'
import { h, icon } from './dom'

// A floating, resizable window with Windows-style snap layouts: drag the title
// bar to an edge or corner (preview shows the target), or pick a layout from the
// title-bar menu. Snapped windows re-fit when the browser window resizes.
//
// The free space beside the chat column acts like a separate monitor: snapping
// fills the left or right gap instead of covering the conversation. Turn
// "Keep clear of the chat" off in the layout menu to use the whole screen.

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
/** Narrowest gap beside the chat that still counts as a workspace. */
const MIN_AREA = 320
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

/** Which workspace a snapped window lives in. */
export type Area = 'left' | 'right' | 'full'

interface Persisted {
  rect: Rect
  slot: Slot | null
  area?: Area
  avoidChat?: boolean
}

interface Areas {
  full: Rect
  left: Rect | null
  right: Rect | null
  /** Chat column extent, when one is on screen. */
  chat: { l: number; r: number } | null
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

function slotRect(slot: Slot, ws: Rect): Rect {
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
  private pickerInfo!: HTMLDivElement
  private rect: Rect
  private slot: Slot | null
  private current: Rect
  private area: Area
  private avoidChat: boolean
  private poll: ReturnType<typeof setInterval> | null = null
  private onResize = () => this.apply()

  constructor(
    private ctx: SpindleFrontendContext,
    private opts: WindowOptions,
  ) {
    const saved = loadPersisted()
    this.area = saved?.area ?? 'right'
    this.avoidChat = saved?.avoidChat ?? true
    const ws = this.viewport()
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

  // ── Workspace ─────────────────────────────────────────────────────────────

  private uiScale(): number {
    return this.ctx.ui.geometry?.getUiScale() || 1
  }

  /** Pointer client coordinates → layout pixels (they differ under UI scaling). */
  private layoutPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const k = this.uiScale()
    return { x: e.clientX / k, y: e.clientY / k }
  }

  private viewport(): Rect {
    const g = this.ctx.ui.geometry
    if (g) {
      const v = g.layoutViewportSize()
      if (v.width > 0 && v.height > 0) return { x: 0, y: 0, w: v.width, h: v.height }
    }
    return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
  }

  /** Horizontal extent of the chat column (message bubbles + composer), or null when no chat is on screen. */
  private chatColumn(): { l: number; r: number } | null {
    const k = this.uiScale()
    let l = Infinity
    let r = -Infinity
    const add = (el: Element) => {
      if (this.frame.contains(el)) return
      const b = el.getBoundingClientRect()
      if (b.width < 40 || b.height < 4) return
      l = Math.min(l, b.left / k)
      r = Math.max(r, b.right / k)
    }
    try {
      for (const { element } of this.ctx.dom.listMessageElements()) add(element)
    } catch {
      /* older host */
    }
    const composer = [...document.querySelectorAll('textarea')]
      .filter((t) => !this.frame.contains(t) && t.offsetParent !== null)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]
    if (composer && Number.isFinite(l)) add(composer)
    return Number.isFinite(l) ? { l: l - GAP, r: r + GAP } : null
  }

  private areas(): Areas {
    const full = this.viewport()
    const chat = this.avoidChat ? this.chatColumn() : null
    if (!chat) return { full, left: null, right: null, chat: null }
    const lw = chat.l - full.x
    const rw = full.x + full.w - chat.r
    return {
      full,
      chat,
      left: lw >= MIN_AREA ? { x: full.x, y: full.y, w: lw, h: full.h } : null,
      right: rw >= MIN_AREA ? { x: chat.r, y: full.y, w: rw, h: full.h } : null,
    }
  }

  /** The workspace for an area, falling back to the other gap, then the whole screen. */
  private areaRect(area: Area, a = this.areas()): Rect {
    if (area === 'left') return a.left ?? a.right ?? a.full
    if (area === 'right') return a.right ?? a.left ?? a.full
    return a.full
  }

  /** Re-measure the chat column while snapped, since it moves when the drawer opens or the chat changes. */
  private syncPoll(): void {
    const want = !!this.slot && this.avoidChat && this.widget.isVisible()
    if (want && !this.poll) {
      this.poll = setInterval(() => {
        if (!this.slot) return
        const r = slotRect(this.slot, this.areaRect(this.area))
        const c = this.current
        if (Math.abs(r.x - c.x) + Math.abs(r.y - c.y) + Math.abs(r.w - c.w) + Math.abs(r.h - c.h) > 3) this.place(r)
      }, 1200)
    } else if (!want && this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }
  }

  private persist(): void {
    savePersisted({ rect: this.rect, slot: this.slot, area: this.area, avoidChat: this.avoidChat })
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
    this.syncPoll()
  }

  isVisible(): boolean {
    return this.widget.isVisible()
  }

  destroy(): void {
    if (this.poll) clearInterval(this.poll)
    window.removeEventListener('resize', this.onResize)
    this.preview.remove()
    this.widget.destroy()
  }

  // ── Geometry ──────────────────────────────────────────────────────────────

  private apply(): void {
    const r = this.slot ? slotRect(this.slot, this.areaRect(this.area)) : this.clampFloat(this.rect)
    this.place(r)
    this.frame.dataset.snapped = this.slot ?? ''
    this.syncPoll()
  }

  private clampFloat(r: Rect): Rect {
    const ws = this.viewport()
    const w = Math.max(MIN_W, Math.min(r.w, ws.w))
    const hh = Math.max(MIN_H, Math.min(r.h, ws.h))
    const x = Math.max(ws.x - w + 80, Math.min(r.x, ws.x + ws.w - 80))
    const y = Math.max(ws.y, Math.min(r.y, ws.y + ws.h - 40))
    return { x, y, w, h: hh }
  }

  /** Positions the widget, compensating for the host's edge padding so it can sit flush. */
  private place(r: Rect): void {
    this.current = r
    const ws = this.viewport()
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

  snapTo(slot: Slot | null, area: Area = this.pickerArea()): void {
    this.slot = slot
    if (slot) this.area = area
    this.picker.hidden = true
    this.apply()
    this.persist()
  }

  // ── Drag & snap ───────────────────────────────────────────────────────────

  /** Snap target under the pointer. Each gap beside the chat behaves like its own screen. */
  private detectSlot(cx: number, cy: number): { slot: Slot; area: Area } | null {
    const a = this.areas()
    let area: Area = 'full'
    if (a.chat) {
      if (cx < a.chat.l && a.left) area = 'left'
      else if (cx > a.chat.r && a.right) area = 'right'
      else return null // over the chat itself
    }
    const slot = this.slotIn(this.areaRect(area, a), cx, cy)
    return slot ? { slot, area } : null
  }

  private slotIn(ws: Rect, cx: number, cy: number): Slot | null {
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

  private showPreview(target: { slot: Slot; area: Area } | null): void {
    if (!target) {
      this.preview.hidden = true
      return
    }
    const r = slotRect(target.slot, this.areaRect(target.area))
    Object.assign(this.preview.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
    this.preview.hidden = false
  }

  private startDrag(e: PointerEvent): void {
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    let start = { ...this.current }
    const p0 = this.layoutPoint(e)
    if (this.slot) {
      // Unsnap like Windows: restore the floating size under the pointer.
      const fx = (p0.x - this.current.x) / this.current.w
      const w = this.rect.w
      start = { x: p0.x - w * fx, y: this.current.y, w, h: this.rect.h }
    }
    const sx = p0.x
    const sy = p0.y
    let moved = false
    let snap: { slot: Slot; area: Area } | null = null
    this.frame.classList.add('mt-dragging')

    const move = (ev: PointerEvent) => {
      const p = this.layoutPoint(ev)
      const dx = p.x - sx
      const dy = p.y - sy
      if (!moved && Math.hypot(dx, dy) < 4) return
      if (!moved) {
        moved = true
        if (this.slot) {
          this.slot = null
          this.frame.dataset.snapped = ''
        }
      }
      this.place({ ...start, x: start.x + dx, y: Math.max(0, start.y + dy) })
      snap = this.detectSlot(p.x, p.y)
      this.showPreview(snap)
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      this.frame.classList.remove('mt-dragging')
      this.preview.hidden = true
      if (!moved) return
      if (snap) {
        this.slot = snap.slot
        this.area = snap.area
      } else this.rect = { ...this.current }
      this.apply()
      this.persist()
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
    const p0 = this.layoutPoint(e)
    const move = (ev: PointerEvent) => {
      const p = this.layoutPoint(ev)
      const dx = p.x - p0.x
      const dy = p.y - p0.y
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
      this.persist()
      this.syncPoll()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  // ── Layout picker ─────────────────────────────────────────────────────────

  /** Area the layout menu targets: the gap the window sits in, else the wider gap. */
  private pickerArea(): Area {
    const a = this.areas()
    if (!a.chat) return 'full'
    const cx = this.current.x + this.current.w / 2
    if (cx < a.chat.l && a.left) return 'left'
    if (cx > a.chat.r && a.right) return 'right'
    if (a.left && a.right) return a.left.w >= a.right.w ? 'left' : 'right'
    return a.left ? 'left' : a.right ? 'right' : 'full'
  }

  private buildPicker(): HTMLDivElement {
    const avoid = h('input', {
      type: 'checkbox',
      checked: this.avoidChat,
      onchange: () => {
        this.avoidChat = avoid.checked
        this.apply()
        this.persist()
        this.renderPickerInfo()
      },
    })
    this.pickerInfo = h('div', { class: 'mt-picker-info' })
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
    const el = h(
      'div',
      { class: 'mt-picker' },
      this.pickerInfo,
      h('div', { class: 'mt-picker-grid' }, ...tiles),
      float,
      h('label', { class: 'mt-check mt-picker-avoid' }, avoid, 'Keep clear of the chat'),
    )
    el.hidden = true
    return el
  }

  private renderPickerInfo(): void {
    const area = this.pickerArea()
    const a = this.areas()
    this.pickerInfo.textContent =
      area === 'left'
        ? 'Fills the space left of the chat'
        : area === 'right'
          ? 'Fills the space right of the chat'
          : a.chat || !this.avoidChat
            ? 'Fills the whole screen'
            : 'No chat on screen: whole screen'
  }

  private togglePicker(): void {
    this.picker.hidden = !this.picker.hidden
    if (!this.picker.hidden) this.renderPickerInfo()
  }
}

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { bearing, boundsOf, calibrationForBounds, compass, distanceUnits, formatCoord, formatKm, locate } from '../shared/geo'
import { mergeInto, newProfile, parseCoordinateText, slug, type ParseResult } from '../shared/parser'
import type {
  BackendMessage,
  Bounds,
  Calibration,
  FrontendMessage,
  InjectMode,
  Poi,
  StatePayload,
  WorldProfile,
  Zone,
} from '../shared/types'
import { clear, debounce, h, hueOf, icon, numOrNull } from './dom'
import { MapView, type Layers, type Tool } from './viewport'

type Tab = 'chat' | 'points' | 'zones' | 'import' | 'image' | 'map'

const TABS: [Tab, string][] = [
  ['chat', 'Chat'],
  ['points', 'Points'],
  ['zones', 'Zones'],
  ['import', 'Import'],
  ['image', 'Image'],
  ['map', 'Map'],
]

const TOOL_HINT: Partial<Record<Tool, string>> = {
  me: 'Click the map to set your position (snaps to points).',
  dest: 'Click the map to set the destination (snaps to points).',
  add: 'Click the map to add a point.',
  measure: 'Click two spots to measure. Esc to clear.',
  crop: 'Drag over the image to crop it.',
  zone: 'Drag a rectangle to create a zone.',
  calib: 'Click a spot whose real coordinate you know.',
}

const UI_KEY = 'map_tracker.ui'

interface UiPrefs {
  tab: Tab
  side: boolean
  layers: Layers
}

function loadUi(): Partial<UiPrefs> {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) || '{}') as Partial<UiPrefs>
  } catch {
    return {}
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export class MapApp {
  readonly el: HTMLDivElement
  private map: MapView
  private state: StatePayload | null = null
  private profile: WorldProfile | null = null
  private imageKey = ''
  private tab: Tab
  private sideOpen: boolean
  private side: HTMLDivElement
  private sideBody: HTMLDivElement
  private tabBar: HTMLDivElement
  private status: HTMLDivElement
  private toolbar: HTMLDivElement
  private profileSelect: HTMLSelectElement
  private toolButtons = new Map<Tool, HTMLButtonElement>()
  private hint: HTMLDivElement
  private menu: HTMLDivElement
  private layersPop: HTMLDivElement
  private sideDirty = false
  private editingPoi: string | null = null
  private editingZone: string | null = null
  private calibTarget: keyof Calibration | null = null
  private pointFilter = ''
  private importText = ''
  private importMode: 'merge' | 'replace' | 'new' = 'merge'
  private importPreview: ParseResult | null = null
  private books: { id: string; name: string }[] = []
  private entries: { id: string; name: string; content: string }[] = []
  private ro: ResizeObserver
  private pendingSave = false
  private flushSave = debounce(() => {
    if (this.profile) this.send({ type: 'saveProfile', profile: this.profile })
    this.pendingSave = false
  }, 450)

  constructor(
    private ctx: SpindleFrontendContext,
    private send: (msg: FrontendMessage) => void,
  ) {
    const prefs = loadUi()
    this.tab = prefs.tab ?? 'chat'
    this.sideOpen = prefs.side ?? true

    const rulerX = h('canvas', { class: 'mt-ruler-x' })
    const rulerY = h('canvas', { class: 'mt-ruler-y' })
    this.map = new MapView(
      {
        onPick: (tool, x, y) => this.onPick(tool, x, y),
        onRect: (tool, r) => this.onRect(tool, r),
        onSelectPoi: (poi) => this.onSelectPoi(poi),
        onContextMenu: (x, y, poi, cx, cy) => this.openMenu(x, y, poi, cx, cy),
        onToolDone: () => this.setTool('pan'),
      },
      rulerX,
      rulerY,
    )
    if (prefs.layers) this.map.layers = { ...this.map.layers, ...prefs.layers }

    this.hint = h('div', { class: 'mt-hint' })
    this.hint.hidden = true
    this.menu = h('div', { class: 'mt-menu' })
    this.menu.hidden = true
    this.layersPop = this.buildLayers()
    this.map.el.append(this.hint, this.menu)

    this.profileSelect = h('select', { class: 'mt-select mt-profile', title: 'Map', onchange: () => this.onProfileChange() })
    this.toolbar = this.buildToolbar()

    this.tabBar = h('div', { class: 'mt-tabs' })
    this.sideBody = h('div', { class: 'mt-side-body' })
    this.side = h('div', { class: 'mt-side' }, this.tabBar, this.sideBody)
    this.side.addEventListener('focusout', () => {
      setTimeout(() => {
        if (this.sideDirty && !this.side.contains(document.activeElement)) this.renderSide()
      }, 0)
    })

    this.status = h('div', { class: 'mt-status' })
    const grid = h(
      'div',
      { class: 'mt-grid' },
      h('div', { class: 'mt-corner' }),
      rulerX,
      rulerY,
      this.map.el,
      this.side,
      this.layersPop,
    )
    this.el = h('div', { class: 'mt-app' }, this.toolbar, grid, this.status)
    this.el.dataset.side = String(this.sideOpen)

    // Narrow (snapped to a third, docked in the sidebar): the side panel becomes an
    // overlay that starts closed, without touching the saved wide-layout preference.
    let narrow = false
    this.ro = new ResizeObserver(() => {
      const w = this.el.clientWidth
      if (!w) return
      const next = w < 720
      if (next === narrow) return
      narrow = next
      this.el.classList.toggle('mt-narrow', narrow)
      this.el.dataset.side = String(narrow ? false : this.sideOpen)
    })
    this.ro.observe(this.el)

    document.addEventListener('pointerdown', this.onDocPointer, true)
    this.render()
  }

  /** Re-read theme colours (after a theme switch or when the map is re-shown). */
  refreshTheme(): void {
    this.map.setTheme()
  }

  destroy(): void {
    this.flushSave.flush()
    this.ro.disconnect()
    this.map.destroy()
    document.removeEventListener('pointerdown', this.onDocPointer, true)
  }

  private onDocPointer = (e: PointerEvent) => {
    const t = e.target as Node
    if (!this.menu.hidden && !this.menu.contains(t)) this.menu.hidden = true
    if (!this.layersPop.hidden && !this.layersPop.contains(t) && !(t as HTMLElement).closest?.('.mt-layers-btn')) this.layersPop.hidden = true
  }

  private savePrefs(): void {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ tab: this.tab, side: this.sideOpen, layers: this.map.layers }))
    } catch {
      /* ignore */
    }
  }

  private chatId(): string | null {
    return this.state?.chat?.chatId ?? this.ctx.getActiveChat().chatId
  }

  // ── Backend messages ──────────────────────────────────────────────────────

  handle(msg: BackendMessage): void {
    switch (msg.type) {
      case 'state':
        this.state = msg
        if (!this.pendingSave || msg.profile?.id !== this.profile?.id) this.profile = msg.profile
        this.map.setProfile(this.profile)
        this.map.setChat(msg.chat)
        this.syncImage()
        this.render()
        break
      case 'image':
        if (msg.profileId !== this.profile?.id) return
        if (!msg.dataUrl) {
          this.map.setImage(null)
          return
        }
        {
          const img = new Image()
          img.onload = () => {
            if (msg.profileId === this.profile?.id) this.map.setImage(img)
          }
          img.src = msg.dataUrl
        }
        break
      case 'worldBooks':
        this.books = msg.books
        this.entries = []
        this.renderSide(true)
        break
      case 'worldBookEntries':
        this.entries = msg.entries
        this.renderSide(true)
        break
      case 'notice':
        break
    }
  }

  private syncImage(): void {
    const p = this.profile
    const key = p?.image ? `${p.id}:${p.image.rev}` : ''
    if (key === this.imageKey) return
    this.imageKey = key
    this.map.setImage(null)
    if (p?.image) this.send({ type: 'getImage', profileId: p.id })
  }

  /** Apply a local edit, redraw, and save (debounced). */
  private mutate(fn: (p: WorldProfile) => void, rerenderSide = true): void {
    if (!this.profile) return
    const next: WorldProfile = structuredClone(this.profile)
    fn(next)
    next.updatedAt = Date.now()
    this.profile = next
    this.map.setProfile(next)
    this.pendingSave = true
    this.flushSave()
    if (rerenderSide) this.renderSide()
    this.renderStatus()
  }

  // ── Toolbar ───────────────────────────────────────────────────────────────

  private buildToolbar(): HTMLDivElement {
    const toolBtn = (t: Tool, ico: Parameters<typeof icon>[0], title: string) => {
      const b = h('button', { class: 'mt-btn mt-tool', title, onclick: () => this.setTool(this.map.tool === t ? 'pan' : t) }, icon(ico))
      this.toolButtons.set(t, b)
      return b
    }
    return h(
      'div',
      { class: 'mt-toolbar' },
      this.profileSelect,
      h(
        'div',
        { class: 'mt-seg' },
        toolBtn('pan', 'pan', 'Pan / select (drag to move, wheel to zoom)'),
        toolBtn('me', 'me', 'Set my position'),
        toolBtn('dest', 'flag', 'Set destination'),
        toolBtn('add', 'pin', 'Add point'),
        toolBtn('measure', 'ruler', 'Measure distance'),
      ),
      h('div', { class: 'mt-spacer' }),
      h('button', { class: 'mt-btn mt-layers-btn', title: 'Layers', onclick: () => (this.layersPop.hidden = !this.layersPop.hidden) }, icon('layers')),
      h(
        'div',
        { class: 'mt-seg' },
        h('button', { class: 'mt-btn', title: 'Zoom out (-)', onclick: () => this.map.zoomBy(0.8) }, icon('minus')),
        h('button', { class: 'mt-btn', title: 'Fit (0)', onclick: () => this.map.fit() }, icon('fit')),
        h('button', { class: 'mt-btn', title: 'Zoom in (+)', onclick: () => this.map.zoomBy(1.25) }, icon('plus')),
      ),
      h('button', { class: 'mt-btn', title: 'Center on me', onclick: () => this.centerOnMe() }, icon('me')),
      h('button', { class: 'mt-btn mt-side-btn', title: 'Toggle side panel', onclick: () => this.toggleSide() }, icon('side')),
    )
  }

  private buildLayers(): HTMLDivElement {
    const names: [keyof Layers, string][] = [
      ['image', 'Map image'],
      ['grid', 'Grid'],
      ['regions', 'Regions'],
      ['zones', 'Zones'],
      ['points', 'Points'],
      ['labels', 'Labels'],
      ['trail', 'Trail'],
    ]
    const el = h(
      'div',
      { class: 'mt-pop mt-layers' },
      ...names.map(([k, label]) => {
        const cb = h('input', {
          type: 'checkbox',
          onchange: (e: Event) => {
            this.map.layers = { ...this.map.layers, [k]: (e.target as HTMLInputElement).checked }
            this.map.invalidate()
            this.savePrefs()
          },
        })
        cb.dataset.layer = k
        return h('label', { class: 'mt-check' }, cb, label)
      }),
    )
    el.hidden = true
    return el
  }

  private setTool(t: Tool): void {
    this.map.setTool(t)
    if (t !== 'calib') this.calibTarget = null
    for (const [tool, b] of this.toolButtons) b.classList.toggle('mt-on', tool === t)
    const hint = TOOL_HINT[t]
    this.hint.hidden = !hint
    this.hint.textContent = hint ?? ''
    if (t === 'crop' || t === 'zone' || t === 'calib') this.renderSide()
  }

  private isSideShown(): boolean {
    return this.el.dataset.side === 'true'
  }

  private toggleSide(): void {
    const show = !this.isSideShown()
    this.el.dataset.side = String(show)
    if (!this.el.classList.contains('mt-narrow')) {
      this.sideOpen = show
      this.savePrefs()
    }
  }

  private openTab(tab: Tab): void {
    this.tab = tab
    if (!this.isSideShown()) this.toggleSide()
    this.savePrefs()
    this.renderSide(true)
  }

  private centerOnMe(): void {
    const me = this.state?.chat?.pos
    if (me) this.map.centerOn(me.x, me.y, this.map.focusScale())
  }

  private onProfileChange(): void {
    const v = this.profileSelect.value
    if (v === '__new') {
      this.send({ type: 'createProfile', name: 'New map' })
      this.tab = 'import'
      return
    }
    if (v) this.send({ type: 'selectProfile', profileId: v })
  }

  // ── Map hooks ─────────────────────────────────────────────────────────────

  private onPick(tool: Tool, x: number, y: number): void {
    const chatId = this.chatId()
    const px = round2(x)
    const py = round2(y)
    if (tool === 'me') {
      if (!chatId) return this.warn('Open a chat to track a position.')
      this.send({ type: 'setPos', chatId, x: px, y: py })
      this.setTool('pan')
    } else if (tool === 'dest') {
      if (!chatId) return this.warn('Open a chat to set a destination.')
      const poi = this.profile?.points.find((p) => p.x === x && p.y === y)
      this.send({ type: 'setDest', chatId, dest: { name: poi?.name ?? `Marked point ${formatCoord(px, py)}`, x: px, y: py } })
      this.setTool('pan')
    } else if (tool === 'add') {
      if (!this.profile) return
      const id = `poi-${Date.now().toString(36)}`
      const n = Math.round(x)
      const m = Math.round(y)
      this.mutate((p) => p.points.push({ id, name: 'New point', x: n, y: m, group: 'Added' }), false)
      this.editingPoi = id
      this.setTool('pan')
      this.openTab('points')
    } else if (tool === 'calib' && this.calibTarget && this.profile?.image) {
      const ip = this.map.imagePixelAt(x, y)
      const target = this.calibTarget
      if (ip) {
        const value = target.startsWith('x') ? ip.px : ip.py
        this.mutate((p) => {
          p.image!.calib[target].px = Math.round(value * 10) / 10
        })
      }
      this.setTool('pan')
    }
  }

  private onRect(tool: Tool, r: Bounds): void {
    if (tool === 'crop') {
      const rect = this.map.imageRectFromWorld(r)
      if (rect) this.mutate((p) => (p.image!.crop = rect))
      this.setTool('pan')
    } else if (tool === 'zone') {
      const id = `zone-${Date.now().toString(36)}`
      const rd = (v: number) => Math.round(v)
      this.mutate(
        (p) =>
          p.zones.push({
            id,
            name: 'New zone',
            group: 'Added',
            kind: 'zone',
            x: { min: rd(r.minX), max: rd(r.maxX) },
            y: { min: rd(r.minY), max: rd(r.maxY) },
          }),
        false,
      )
      this.editingZone = id
      this.setTool('pan')
      this.openTab('zones')
    }
  }

  private onSelectPoi(poi: Poi | null): void {
    if (!poi) return
    this.editingPoi = poi.id
    if (this.tab === 'points') this.renderSide(true)
  }

  private openMenu(x: number, y: number, poi: Poi | null, clientX: number, clientY: number): void {
    const chatId = this.chatId()
    const tx = poi ? poi.x : round2(x)
    const ty = poi ? poi.y : round2(y)
    const item = (label: string, fn: () => void, disabled = false) =>
      h('button', { class: 'mt-menu-item', disabled, onclick: () => ((this.menu.hidden = true), fn()) }, label)
    clear(this.menu)
    this.menu.append(
      h('div', { class: 'mt-menu-head' }, poi ? poi.name : formatCoord(tx, ty, 1)),
      item('Move me here', () => chatId && this.send({ type: 'setPos', chatId, x: tx, y: ty }), !chatId),
      item('Set as destination', () => chatId && this.send({ type: 'setDest', chatId, dest: { name: poi?.name ?? `Marked point ${formatCoord(tx, ty)}`, x: tx, y: ty } }), !chatId),
      poi
        ? item(`Edit ${poi.name}`, () => {
            this.editingPoi = poi.id
            this.openTab('points')
          })
        : item('Add point here', () => this.onPick('add', x, y), !this.profile),
      item('Copy coordinates', () => void navigator.clipboard?.writeText(formatCoord(tx, ty, poi ? 0 : 1))),
    )
    const r = this.map.el.getBoundingClientRect()
    this.menu.hidden = false
    const mw = this.menu.offsetWidth
    const mh = this.menu.offsetHeight
    this.menu.style.left = `${Math.min(clientX - r.left, r.width - mw - 4)}px`
    this.menu.style.top = `${Math.min(clientY - r.top, r.height - mh - 4)}px`
  }

  private warn(message: string): void {
    this.hint.hidden = false
    this.hint.textContent = message
    setTimeout(() => {
      if (this.hint.textContent === message) this.hint.hidden = !TOOL_HINT[this.map.tool]
    }, 2500)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private render(): void {
    this.renderToolbar()
    this.renderStatus()
    this.renderSide()
  }

  private renderToolbar(): void {
    const s = this.state
    clear(this.profileSelect)
    if (!s?.profiles.length) this.profileSelect.append(h('option', { value: '' }, 'No maps yet'))
    for (const p of s?.profiles ?? []) this.profileSelect.append(h('option', { value: p.id }, p.name))
    this.profileSelect.append(h('option', { value: '__new' }, '+ New map…'))
    this.profileSelect.value = this.profile?.id ?? ''
    for (const [tool, b] of this.toolButtons) b.classList.toggle('mt-on', tool === this.map.tool)
    for (const cb of this.layersPop.querySelectorAll<HTMLInputElement>('input[data-layer]')) {
      cb.checked = this.map.layers[cb.dataset.layer as keyof Layers]
    }
  }

  private renderStatus(): void {
    const s = this.state
    const p = this.profile
    const chat = s?.chat
    clear(this.status)
    if (!chat) {
      this.status.append(h('span', { class: 'mt-dim' }, 'No chat open — browsing only'))
    } else if (!chat.pos || !p) {
      this.status.append(
        h('span', { class: 'mt-dim' }, p ? 'No position yet. ' : 'Pick or create a map. '),
        p ? h('button', { class: 'mt-link', onclick: () => this.setTool('me') }, 'Set my position') : '',
      )
    } else {
      const where = locate(p, chat.pos.x, chat.pos.y)
      const place = [where.zone?.name, where.region?.name].filter(Boolean).join(' · ')
      this.status.append(h('span', { class: 'mt-me-dot' }), h('b', null, formatCoord(chat.pos.x, chat.pos.y, 1)), place ? h('span', null, place) : '')
      if (chat.dest) {
        const km = distanceUnits(chat.pos.x, chat.pos.y, chat.dest.x, chat.dest.y) * p.unitKm
        this.status.append(h('span', { class: 'mt-dest' }, `→ ${chat.dest.name}: ${formatKm(km)} ${compass(bearing(chat.pos.x, chat.pos.y, chat.dest.x, chat.dest.y))}`))
      }
    }
    const mode = s?.settings.injectMode ?? 'auto'
    const label = mode === 'auto' ? 'Injecting' : mode === 'macro' ? 'Macro only' : 'Not sent'
    this.status.append(
      h('span', { class: 'mt-spacer' }),
      h('button', { class: `mt-chip mt-chip-${mode}`, title: 'How the position reaches the model', onclick: () => this.openTab('chat') }, label),
    )
  }

  private renderSide(force = false): void {
    if (!force && this.side.contains(document.activeElement) && (document.activeElement as HTMLElement).matches('input, textarea, select')) {
      this.sideDirty = true
      return
    }
    this.sideDirty = false
    clear(this.tabBar)
    for (const [id, label] of TABS) {
      this.tabBar.append(h('button', { class: `mt-tab${id === this.tab ? ' mt-on' : ''}`, onclick: () => this.openTab(id) }, label))
    }
    const scroll = this.sideBody.scrollTop
    clear(this.sideBody)
    const body = this.sideBody
    if (!this.profile && this.tab !== 'import' && this.tab !== 'chat') {
      body.append(this.emptyMapNotice())
      return
    }
    switch (this.tab) {
      case 'chat':
        this.renderChatTab(body)
        break
      case 'points':
        this.renderPointsTab(body)
        break
      case 'zones':
        this.renderZonesTab(body)
        break
      case 'import':
        this.renderImportTab(body)
        break
      case 'image':
        this.renderImageTab(body)
        break
      case 'map':
        this.renderMapTab(body)
        break
    }
    body.scrollTop = scroll
  }

  private emptyMapNotice(): HTMLElement {
    return h(
      'div',
      { class: 'mt-empty' },
      h('p', null, 'No map selected.'),
      h('button', { class: 'mt-btn mt-primary', onclick: () => this.send({ type: 'createProfile', name: 'New map' }) }, 'Create a map'),
      h('p', { class: 'mt-dim' }, 'Then paste your coordinate notes in Import.'),
    )
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  private renderChatTab(body: HTMLElement): void {
    const s = this.state
    const chat = s?.chat
    const p = this.profile
    if (!p) body.append(this.emptyMapNotice())
    if (!chat) {
      body.append(h('p', { class: 'mt-dim' }, 'Open a chat to track a position. The map stays browsable.'))
    } else if (p) {
      const xIn = h('input', { class: 'mt-input', type: 'number', step: 'any', value: chat.pos ? String(chat.pos.x) : '', placeholder: 'x' })
      const yIn = h('input', { class: 'mt-input', type: 'number', step: 'any', value: chat.pos ? String(chat.pos.y) : '', placeholder: 'y' })
      const setPos = () => {
        const x = numOrNull(xIn.value)
        const y = numOrNull(yIn.value)
        if (x !== null && y !== null) this.send({ type: 'setPos', chatId: chat.chatId, x, y })
      }
      xIn.addEventListener('keydown', (e) => e.key === 'Enter' && setPos())
      yIn.addEventListener('keydown', (e) => e.key === 'Enter' && setPos())
      body.append(
        h('h4', null, 'Position'),
        h('div', { class: 'mt-row' }, h('span', { class: 'mt-lbl' }, 'X'), xIn, h('span', { class: 'mt-lbl' }, 'Y'), yIn, h('button', { class: 'mt-btn mt-primary', onclick: setPos }, 'Set')),
        h(
          'div',
          { class: 'mt-row' },
          h('button', { class: 'mt-btn', onclick: () => this.setTool('me') }, icon('me'), 'Pick on map'),
          h('button', { class: 'mt-btn', onclick: () => this.centerOnMe(), disabled: !chat.pos }, 'Center'),
          h('button', { class: 'mt-btn mt-ghost', onclick: () => this.send({ type: 'clearPos', chatId: chat.chatId }), disabled: !chat.pos }, 'Clear'),
        ),
      )

      const destSel = h('select', { class: 'mt-select mt-grow' }, h('option', { value: '' }, '— none —'))
      const sorted = [...p.points].sort((a, b) => a.name.localeCompare(b.name))
      for (const pt of sorted) destSel.append(h('option', { value: pt.id }, pt.name))
      const cur = chat.dest ? sorted.find((pt) => pt.x === chat.dest!.x && pt.y === chat.dest!.y) : null
      if (chat.dest && !cur) destSel.append(h('option', { value: '__custom' }, chat.dest.name))
      destSel.value = chat.dest ? (cur?.id ?? '__custom') : ''
      destSel.addEventListener('change', () => {
        const pt = p.points.find((q) => q.id === destSel.value)
        if (destSel.value === '') this.send({ type: 'setDest', chatId: chat.chatId, dest: null })
        else if (pt) this.send({ type: 'setDest', chatId: chat.chatId, dest: { name: pt.name, x: pt.x, y: pt.y } })
      })
      let destInfo: HTMLElement | null = null
      if (chat.dest && chat.pos) {
        const km = distanceUnits(chat.pos.x, chat.pos.y, chat.dest.x, chat.dest.y) * p.unitKm
        destInfo = h('div', { class: 'mt-dim' }, `${formatKm(km)} ${compass(bearing(chat.pos.x, chat.pos.y, chat.dest.x, chat.dest.y))} of you`)
      }
      body.append(
        h('h4', null, 'Destination'),
        h('div', { class: 'mt-row' }, destSel, h('button', { class: 'mt-btn', title: 'Pick on map', onclick: () => this.setTool('dest') }, icon('flag'))),
        destInfo ?? '',
        h('h4', null, 'Trail'),
        h(
          'div',
          { class: 'mt-row' },
          h('span', { class: 'mt-dim mt-grow' }, `${chat.trail.length} stop${chat.trail.length === 1 ? '' : 's'} recorded`),
          h('button', { class: 'mt-btn mt-ghost', onclick: () => this.send({ type: 'clearTrail', chatId: chat.chatId }), disabled: chat.trail.length < 2 }, 'Clear trail'),
        ),
      )
    }

    if (!s) return
    const radio = (mode: InjectMode, label: string, desc: string) =>
      h(
        'label',
        { class: 'mt-radio' },
        h('input', { type: 'radio', name: 'mt-inject', checked: s.settings.injectMode === mode, onchange: () => this.send({ type: 'saveSettings', settings: { injectMode: mode } }) }),
        h('span', null, h('b', null, label), h('br'), h('span', { class: 'mt-dim' }, desc)),
      )
    const nearIn = h('input', { class: 'mt-input mt-narrow-in', type: 'number', min: '0', max: '10', value: String(s.settings.nearbyCount) })
    nearIn.addEventListener('change', () => {
      const n = Math.max(0, Math.min(10, Math.round(Number(nearIn.value) || 0)))
      this.send({ type: 'saveSettings', settings: { nearbyCount: n } })
    })
    body.append(
      h('h4', null, 'Sending to the model'),
      radio('auto', 'Append to chat context', 'Added as a system note before the latest message.'),
      radio('macro', 'Macro only', 'Place {{map_pos}} or {{@map_pos}} in your preset yourself.'),
      radio('off', 'Off', 'Track on the map only.'),
      h(
        'label',
        { class: 'mt-check' },
        h('input', { type: 'checkbox', checked: s.settings.askReport, onchange: (e: Event) => this.send({ type: 'saveSettings', settings: { askReport: (e.target as HTMLInputElement).checked } }) }),
        'Ask the model to report moves with <map-pos>x,y</map-pos>',
      ),
      h('div', { class: 'mt-row' }, h('span', { class: 'mt-grow' }, 'Nearby places listed'), nearIn),
      h('div', { class: 'mt-dim' }, 'Macros: ', h('code', null, '{{map_pos}}'), ' (active chat) · ', h('code', null, '{{@map_pos}}'), ' (chat variable)'),
      h('h4', null, 'Preview'),
      h('pre', { class: 'mt-pre' }, s.context || (chat ? 'Nothing to send yet: set a position.' : 'No chat open.')),
    )
  }

  private renderPointsTab(body: HTMLElement): void {
    const p = this.profile!
    const search = h('input', { class: 'mt-input mt-grow', type: 'search', placeholder: `Search ${p.points.length} points`, value: this.pointFilter })
    search.addEventListener('input', () => {
      this.pointFilter = search.value
      renderList()
    })
    body.append(
      h('div', { class: 'mt-row' }, search, h('button', { class: 'mt-btn', title: 'Add point (click on map)', onclick: () => this.setTool('add') }, icon('plus'), 'Add')),
    )
    const editing = p.points.find((pt) => pt.id === this.editingPoi)
    if (editing) body.append(this.poiEditor(editing))
    const list = h('div', { class: 'mt-list' })
    body.append(list)

    const renderList = () => {
      clear(list)
      const q = this.pointFilter.trim().toLowerCase()
      const groups = new Map<string, Poi[]>()
      for (const pt of p.points) {
        if (q && !`${pt.name} ${pt.group} ${pt.note ?? ''}`.toLowerCase().includes(q)) continue
        const g = pt.group || 'Ungrouped'
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g)!.push(pt)
      }
      for (const [g, pts] of groups) {
        const det = h('details', { class: 'mt-group', open: true }, h('summary', null, h('span', null, g.split(' / ').pop()!), h('span', { class: 'mt-dim' }, ` ${pts.length}`)))
        det.title = g
        for (const pt of pts) {
          const color = pt.color || `hsl(${hueOf(pt.group.split(' / ').slice(0, 2).join('/') || 'x')} 65% 62%)`
          det.append(
            h(
              'div',
              { class: `mt-item${pt.id === this.editingPoi ? ' mt-on' : ''}${pt.hidden ? ' mt-muted' : ''}` },
              h('span', { class: 'mt-dot', style: `background:${color}` }),
              h('button', { class: 'mt-item-name', onclick: () => this.focusPoi(pt) }, pt.name),
              h('span', { class: 'mt-dim mt-mono' }, formatCoord(pt.x, pt.y)),
              h('button', { class: 'mt-btn mt-icon-btn', title: 'Edit', onclick: () => ((this.editingPoi = pt.id), this.renderSide(true)) }, '✎'),
            ),
          )
        }
        list.append(det)
      }
      if (!groups.size) list.append(h('p', { class: 'mt-dim' }, q ? 'No matches.' : 'No points yet. Import coordinates or add points on the map.'))
    }
    renderList()
  }

  private focusPoi(pt: Poi): void {
    this.map.selectedId = pt.id
    this.map.centerOn(pt.x, pt.y, this.map.focusScale())
    this.editingPoi = pt.id
    this.renderSide(true)
  }

  private poiEditor(pt: Poi): HTMLElement {
    const p = this.profile!
    const chatId = this.chatId()
    const groups = [...new Set(p.points.map((q) => q.group))].sort()
    const listId = 'mt-groups-list'
    const name = h('input', { class: 'mt-input', value: pt.name })
    const group = h('input', { class: 'mt-input', value: pt.group, list: listId })
    const x = h('input', { class: 'mt-input', type: 'number', step: 'any', value: String(pt.x) })
    const y = h('input', { class: 'mt-input', type: 'number', step: 'any', value: String(pt.y) })
    const note = h('textarea', { class: 'mt-input', rows: 2 }, pt.note ?? '')
    const color = h('input', { class: 'mt-color', type: 'color', value: pt.color || '#7aa2ff' })
    let useColor = !!pt.color
    color.addEventListener('input', () => (useColor = true))
    const hidden = h('input', { type: 'checkbox', checked: !!pt.hidden })
    const save = () => {
      const nx = numOrNull(x.value)
      const ny = numOrNull(y.value)
      if (nx === null || ny === null) return
      this.mutate((d) => {
        const t = d.points.find((q) => q.id === pt.id)
        if (!t) return
        t.name = name.value.trim() || 'Unnamed'
        t.group = group.value.trim()
        t.x = nx
        t.y = ny
        t.note = note.value.trim() || undefined
        t.color = useColor ? color.value : undefined
        t.hidden = hidden.checked || undefined
      })
    }
    return h(
      'div',
      { class: 'mt-editor' },
      h('datalist', { id: listId }, ...groups.map((g) => h('option', { value: g }))),
      h('div', { class: 'mt-form' }, h('label', null, 'Name'), name, h('label', null, 'Group'), group, h('label', null, 'X'), x, h('label', null, 'Y'), y, h('label', null, 'Note'), note),
      h(
        'div',
        { class: 'mt-row' },
        h('label', { class: 'mt-check' }, color, 'Color'),
        h('button', { class: 'mt-btn mt-ghost', onclick: () => ((useColor = false), save()) }, 'Auto color'),
        h('label', { class: 'mt-check' }, hidden, 'Hidden'),
      ),
      h(
        'div',
        { class: 'mt-row' },
        h('button', { class: 'mt-btn mt-primary', onclick: save }, 'Save'),
        h('button', { class: 'mt-btn', onclick: () => chatId && this.send({ type: 'setPos', chatId, x: pt.x, y: pt.y }), disabled: !chatId }, 'Move me here'),
        h('button', { class: 'mt-btn', onclick: () => chatId && this.send({ type: 'setDest', chatId, dest: { name: pt.name, x: pt.x, y: pt.y } }), disabled: !chatId }, 'Go here'),
      ),
      h(
        'div',
        { class: 'mt-row' },
        h('button', { class: 'mt-btn mt-danger', onclick: () => this.deletePoi(pt) }, 'Delete'),
        h('span', { class: 'mt-spacer' }),
        h('button', { class: 'mt-btn mt-ghost', onclick: () => ((this.editingPoi = null), this.renderSide(true)) }, 'Close'),
      ),
    )
  }

  private deletePoi(pt: Poi): void {
    this.editingPoi = null
    this.mutate((d) => {
      d.points = d.points.filter((q) => q.id !== pt.id)
    })
  }

  private renderZonesTab(body: HTMLElement): void {
    const p = this.profile!
    body.append(
      h(
        'div',
        { class: 'mt-row' },
        h('span', { class: 'mt-dim mt-grow' }, `${p.zones.length} zones`),
        h('button', { class: 'mt-btn', title: 'Drag a rectangle on the map', onclick: () => this.setTool('zone') }, icon('zone'), 'Draw zone'),
      ),
    )
    const editing = p.zones.find((z) => z.id === this.editingZone)
    if (editing) body.append(this.zoneEditor(editing))
    const fmtSpan = (s: Zone['x'], axis: string) =>
      s.min === null && s.max === null ? '' : s.min !== null && s.max !== null ? `${axis}[${s.min},${s.max}]` : s.min !== null ? `${axis}>${s.min}` : `${axis}<${s.max}`
    for (const kind of ['region', 'zone'] as const) {
      const zs = p.zones.filter((z) => z.kind === kind)
      if (!zs.length) continue
      const det = h('details', { class: 'mt-group', open: true }, h('summary', null, kind === 'region' ? 'Regions' : 'Zones', h('span', { class: 'mt-dim' }, ` ${zs.length}`)))
      for (const z of zs) {
        const within = z.within ? p.zones.find((r) => r.id === z.within)?.name : null
        det.append(
          h(
            'div',
            { class: `mt-item${z.id === this.editingZone ? ' mt-on' : ''}${z.hidden ? ' mt-muted' : ''}` },
            h('span', { class: 'mt-swatch', style: `border-color:${z.color || `hsl(${hueOf(z.name)} 70% 60%)`}` }),
            h('button', { class: 'mt-item-name', title: z.note ?? '', onclick: () => ((this.editingZone = z.id), this.renderSide(true)) }, z.name),
            h('span', { class: 'mt-dim mt-mono', title: within ? `inside ${within}` : '' }, [fmtSpan(z.x, 'X'), fmtSpan(z.y, 'Y')].filter(Boolean).join(' ') || 'everywhere'),
          ),
        )
      }
      body.append(det)
    }
  }

  private zoneEditor(z: Zone): HTMLElement {
    const p = this.profile!
    const num = (v: number | null) => h('input', { class: 'mt-input', type: 'number', step: 'any', value: v === null ? '' : String(v), placeholder: 'open' })
    const name = h('input', { class: 'mt-input', value: z.name })
    const group = h('input', { class: 'mt-input', value: z.group })
    const kind = h('select', { class: 'mt-select' }, h('option', { value: 'zone' }, 'Zone'), h('option', { value: 'region' }, 'Region'))
    kind.value = z.kind
    const xmin = num(z.x.min)
    const xmax = num(z.x.max)
    const ymin = num(z.y.min)
    const ymax = num(z.y.max)
    const within = h('select', { class: 'mt-select' }, h('option', { value: '' }, '— whole map —'))
    for (const r of p.zones.filter((q) => q.kind === 'region' && q.id !== z.id)) within.append(h('option', { value: r.id }, r.name))
    within.value = z.within ?? ''
    const prio = h('input', { class: 'mt-input', type: 'number', step: '1', value: String(z.priority ?? 0) })
    const note = h('textarea', { class: 'mt-input', rows: 2 }, z.note ?? '')
    const color = h('input', { class: 'mt-color', type: 'color', value: z.color || '#7aa2ff' })
    let useColor = !!z.color
    color.addEventListener('input', () => (useColor = true))
    const hidden = h('input', { type: 'checkbox', checked: !!z.hidden })
    const save = () =>
      this.mutate((d) => {
        const t = d.zones.find((q) => q.id === z.id)
        if (!t) return
        t.name = name.value.trim() || 'Unnamed'
        t.group = group.value.trim()
        t.kind = kind.value as Zone['kind']
        t.x = { min: numOrNull(xmin.value), max: numOrNull(xmax.value) }
        t.y = { min: numOrNull(ymin.value), max: numOrNull(ymax.value) }
        t.within = within.value || undefined
        t.priority = Math.round(Number(prio.value) || 0) || undefined
        t.note = note.value.trim() || undefined
        t.color = useColor ? color.value : undefined
        t.hidden = hidden.checked || undefined
      })
    return h(
      'div',
      { class: 'mt-editor' },
      h(
        'div',
        { class: 'mt-form' },
        h('label', null, 'Name'),
        name,
        h('label', null, 'Group'),
        group,
        h('label', null, 'Kind'),
        kind,
        h('label', null, 'X min / max'),
        h('div', { class: 'mt-pair' }, xmin, xmax),
        h('label', null, 'Y min / max'),
        h('div', { class: 'mt-pair' }, ymin, ymax),
        h('label', null, 'Clip to'),
        within,
        h('label', { title: 'Higher wins when zones overlap; ties go to the smaller zone' }, 'Priority'),
        prio,
        h('label', null, 'Note'),
        note,
      ),
      h('div', { class: 'mt-dim' }, 'Leave a bound empty for an open side (e.g. only Y min = "Y>150").'),
      h(
        'div',
        { class: 'mt-row' },
        h('label', { class: 'mt-check' }, color, 'Color'),
        h('button', { class: 'mt-btn mt-ghost', onclick: () => ((useColor = false), save()) }, 'Auto color'),
        h('label', { class: 'mt-check' }, hidden, 'Hidden'),
      ),
      h(
        'div',
        { class: 'mt-row' },
        h('button', { class: 'mt-btn mt-primary', onclick: save }, 'Save'),
        h(
          'button',
          {
            class: 'mt-btn mt-danger',
            onclick: () => {
              this.editingZone = null
              this.mutate((d) => {
                d.zones = d.zones.filter((q) => q.id !== z.id).map((q) => (q.within === z.id ? { ...q, within: undefined } : q))
              })
            },
          },
          'Delete',
        ),
        h('span', { class: 'mt-spacer' }),
        h('button', { class: 'mt-btn mt-ghost', onclick: () => ((this.editingZone = null), this.renderSide(true)) }, 'Close'),
      ),
    )
  }

  private renderImportTab(body: HTMLElement): void {
    const p = this.profile
    if (!p) this.importMode = 'new'
    const ta = h('textarea', {
      class: 'mt-input mt-code',
      rows: 10,
      placeholder: 'Paste coordinate notes, e.g.\n\nKingdom:\n  Capital:[15,-5]\n  Port:[20,-25] # harbour\nMountains: X[-45,0] AND Y[0,150]\nTundra: Y>150\nScale: 1 unit = 50 km',
    })
    ta.value = this.importText
    ta.addEventListener('input', () => {
      this.importText = ta.value
      this.importPreview = null
    })
    const mode = (m: 'merge' | 'replace' | 'new', label: string) =>
      h('label', { class: 'mt-check' }, h('input', { type: 'radio', name: 'mt-import-mode', checked: this.importMode === m, disabled: !p && m !== 'new', onchange: () => (this.importMode = m) }), label)

    body.append(
      h('h4', null, 'Coordinate notes'),
      h('div', { class: 'mt-dim' }, 'Points as Name:[x,y]; zones as X[a,b] / Y>n; indentation becomes groups; "1 unit = N km" sets the scale.'),
      ta,
      h('div', { class: 'mt-row mt-wrap' }, mode('merge', 'Merge'), mode('replace', 'Replace points & zones'), mode('new', 'New map')),
      h(
        'div',
        { class: 'mt-row' },
        h(
          'button',
          {
            class: 'mt-btn',
            onclick: () => {
              this.importPreview = parseCoordinateText(this.importText)
              this.renderSide(true)
            },
          },
          'Preview',
        ),
        h('button', { class: 'mt-btn mt-primary', onclick: () => this.applyImport(), disabled: !this.importText.trim() }, 'Apply'),
      ),
    )
    const pv = this.importPreview
    if (pv) {
      body.append(
        h(
          'div',
          { class: 'mt-preview' },
          h('b', null, `${pv.points.length} points · ${pv.zones.length} zones`),
          pv.unitKm ? ` · 1 unit = ${pv.unitKm} km` : '',
          pv.skipped ? h('span', { class: 'mt-dim' }, ` · ${pv.skipped} lines ignored`) : '',
          h('ul', null, ...pv.zones.slice(0, 6).map((z) => h('li', null, `${z.kind === 'region' ? 'Region' : 'Zone'}: ${z.name}`)), ...pv.points.slice(0, 6).map((pt) => h('li', null, `${pt.name} ${formatCoord(pt.x, pt.y)}`))),
        ),
      )
    }

    body.append(h('h4', null, 'From a lorebook'))
    if (!this.state?.worldBooksAvailable) {
      body.append(h('div', { class: 'mt-dim' }, 'Grant the world_books permission to pull entries directly.'))
    } else {
      const bookSel = h('select', { class: 'mt-select mt-grow' }, h('option', { value: '' }, this.books.length ? 'Choose a lorebook…' : '—'))
      for (const b of this.books) bookSel.append(h('option', { value: b.id }, b.name))
      bookSel.addEventListener('change', () => bookSel.value && this.send({ type: 'listWorldBookEntries', bookId: bookSel.value }))
      body.append(h('div', { class: 'mt-row' }, h('button', { class: 'mt-btn', onclick: () => this.send({ type: 'listWorldBooks' }) }, 'Load lorebooks'), bookSel))
      if (this.entries.length) {
        const entrySel = h('select', { class: 'mt-select mt-grow' }, h('option', { value: '' }, `${this.entries.length} entries with coordinates…`))
        for (const e of this.entries) entrySel.append(h('option', { value: e.id }, e.name))
        entrySel.addEventListener('change', () => {
          const e = this.entries.find((q) => q.id === entrySel.value)
          if (!e) return
          this.importText = e.content
          this.importPreview = parseCoordinateText(e.content)
          this.renderSide(true)
        })
        body.append(h('div', { class: 'mt-row' }, entrySel))
      }
    }

    body.append(
      h('h4', null, 'Map file'),
      h(
        'div',
        { class: 'mt-row' },
        h('button', { class: 'mt-btn', onclick: () => this.exportProfile(), disabled: !p }, 'Export JSON'),
        h('button', { class: 'mt-btn', onclick: () => void this.importProfileFile() }, 'Import JSON'),
      ),
      h('div', { class: 'mt-dim' }, 'The JSON holds points, zones, crop and calibration. The image is uploaded separately.'),
    )
  }

  private applyImport(): void {
    const parsed = this.importPreview ?? parseCoordinateText(this.importText)
    if (!parsed.points.length && !parsed.zones.length) return this.warn('Nothing recognised in that text.')
    if (this.importMode === 'new' || !this.profile) {
      const base = newProfile('Imported map', 'tmp')
      const profile = mergeInto(base, parsed, 'replace')
      this.send({ type: 'importProfile', profile })
    } else {
      const next = mergeInto(this.profile, parsed, this.importMode)
      this.profile = next
      this.pendingSave = true
      this.flushSave()
      this.flushSave.flush()
      this.map.setProfile(next)
      this.map.fit()
    }
    this.importPreview = null
    this.importText = ''
    this.renderSide(true)
  }

  private exportProfile(): void {
    const p = this.profile
    if (!p) return
    const { source: _s, ...rest } = p
    const blob = new Blob([JSON.stringify({ ...rest, image: p.image ? { ...p.image, rev: 0 } : undefined }, null, 2)], { type: 'application/json' })
    const a = h('a', { href: URL.createObjectURL(blob), download: `${slug(p.name)}.map.json` })
    document.body.append(a)
    a.click()
    setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000)
  }

  private async importProfileFile(): Promise<void> {
    const files = await this.ctx.uploads.pickFile({ accept: ['.json', 'application/json'], maxSizeBytes: 10 * 1024 * 1024 }).catch(() => [])
    const f = files[0]
    if (!f) return
    try {
      const data = JSON.parse(new TextDecoder().decode(f.bytes)) as WorldProfile
      if (!Array.isArray(data.points) || !Array.isArray(data.zones)) throw new Error('Not a map file')
      this.send({ type: 'importProfile', profile: { ...data, bounds: data.bounds ?? boundsOf(data) } })
    } catch (err) {
      this.warn(`Could not read that file: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private renderImageTab(body: HTMLElement): void {
    const p = this.profile!
    const meta = p.image
    body.append(
      h(
        'div',
        { class: 'mt-row' },
        h('button', { class: 'mt-btn mt-primary', onclick: () => void this.uploadImage() }, meta ? 'Replace image' : 'Upload image'),
        meta ? h('button', { class: 'mt-btn mt-danger', onclick: () => this.send({ type: 'removeImage', profileId: p.id }) }, 'Remove') : null,
      ),
    )
    if (!meta) {
      body.append(h('p', { class: 'mt-dim' }, 'Overlay a map picture, then crop away legends or frames and pin it to the coordinate system.'))
      const t = p.imageTemplate
      if (t) body.append(h('p', { class: 'mt-dim' }, `Crop and calibration from the imported file apply automatically to a ${t.width} × ${t.height} image.`))
      return
    }
    const opacity = h('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(meta.opacity), class: 'mt-grow' })
    opacity.addEventListener('input', () => this.mutate((d) => (d.image!.opacity = Number(opacity.value)), false))
    body.append(
      h('div', { class: 'mt-dim' }, `${meta.width} × ${meta.height} px`),
      h(
        'div',
        { class: 'mt-row' },
        h('label', { class: 'mt-check' }, h('input', { type: 'checkbox', checked: meta.visible, onchange: (e: Event) => this.mutate((d) => (d.image!.visible = (e.target as HTMLInputElement).checked)) }), 'Show'),
        h('span', { class: 'mt-lbl' }, 'Opacity'),
        opacity,
      ),
    )

    // Crop
    const cropIn = (k: 'x' | 'y' | 'w' | 'h') => {
      const el = h('input', { class: 'mt-input', type: 'number', step: '1', value: String(meta.crop[k]) })
      el.addEventListener('change', () => {
        const v = numOrNull(el.value)
        if (v === null) return
        this.mutate((d) => {
          const c = d.image!.crop
          c[k] = Math.max(0, Math.round(v))
          c.w = Math.max(1, Math.min(c.w, d.image!.width - c.x))
          c.h = Math.max(1, Math.min(c.h, d.image!.height - c.y))
        })
      })
      return el
    }
    body.append(
      h('h4', null, 'Crop (image pixels)'),
      h('div', { class: 'mt-form mt-form-4' }, h('label', null, 'X'), cropIn('x'), h('label', null, 'Y'), cropIn('y'), h('label', null, 'W'), cropIn('w'), h('label', null, 'H'), cropIn('h')),
      h(
        'div',
        { class: 'mt-row' },
        h('button', { class: `mt-btn${this.map.tool === 'crop' ? ' mt-on' : ''}`, onclick: () => this.setTool(this.map.tool === 'crop' ? 'pan' : 'crop') }, icon('crop'), 'Drag on map'),
        h('button', { class: 'mt-btn mt-ghost', onclick: () => this.mutate((d) => (d.image!.crop = { x: 0, y: 0, w: d.image!.width, h: d.image!.height })) }, 'Reset crop'),
      ),
    )

    // Calibration
    const row = (key: keyof Calibration, label: string) => {
      const a = meta.calib[key]
      const px = h('input', { class: 'mt-input', type: 'number', step: 'any', value: String(a.px) })
      const w = h('input', { class: 'mt-input', type: 'number', step: 'any', value: String(a.w) })
      const commit = () => {
        const vp = numOrNull(px.value)
        const vw = numOrNull(w.value)
        if (vp === null || vw === null) return
        this.mutate((d) => (d.image!.calib[key] = { px: vp, w: vw }), false)
      }
      px.addEventListener('change', commit)
      w.addEventListener('change', commit)
      const active = this.calibTarget === key
      return h(
        'div',
        { class: 'mt-calib-row' },
        h('span', { class: 'mt-lbl' }, label),
        px,
        w,
        h(
          'button',
          {
            class: `mt-btn${active ? ' mt-on' : ''}`,
            title: 'Click the spot on the map',
            onclick: () => {
              this.calibTarget = active ? null : key
              this.setTool(active ? 'pan' : 'calib')
            },
          },
          'Pick',
        ),
      )
    }
    body.append(
      h('h4', null, 'Calibration'),
      h('div', { class: 'mt-dim' }, 'Two reference points per axis (ruler ticks work best). Pick a spot, then type its real coordinate. X and Y scale independently.'),
      h('div', { class: 'mt-calib-row mt-calib-head' }, h('span'), h('span', null, 'image px'), h('span', null, 'world'), h('span')),
      row('x1', 'X₁'),
      row('x2', 'X₂'),
      row('y1', 'Y₁'),
      row('y2', 'Y₂'),
      h(
        'div',
        { class: 'mt-row' },
        h('button', { class: 'mt-btn mt-ghost', onclick: () => this.mutate((d) => (d.image!.calib = calibrationForBounds(d.image!.width, d.image!.height, d.bounds))) }, 'Stretch over map bounds'),
        h('button', { class: 'mt-btn mt-ghost', onclick: () => this.map.fit() }, 'Fit view'),
      ),
    )
  }

  private async uploadImage(): Promise<void> {
    const p = this.profile
    if (!p) return
    const files = await this.ctx.uploads
      .pickFile({ accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', '.png', '.jpg', '.jpeg', '.webp', '.gif'], maxSizeBytes: 40 * 1024 * 1024 })
      .catch((err) => {
        this.warn(String(err instanceof Error ? err.message : err))
        return []
      })
    const f = files[0]
    if (!f) return
    const blob = new Blob([f.bytes as BlobPart], { type: f.mimeType })
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(fr.error)
      fr.readAsDataURL(blob)
    })
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    this.flushSave.flush()
    this.send({ type: 'setImage', profileId: p.id, dataUrl, width: img.naturalWidth, height: img.naturalHeight, mime: f.mimeType })
  }

  private renderMapTab(body: HTMLElement): void {
    const p = this.profile!
    const s = this.state
    const name = h('input', { class: 'mt-input', value: p.name })
    name.addEventListener('change', () => this.mutate((d) => (d.name = name.value.trim() || 'Untitled map')))
    const unit = h('input', { class: 'mt-input', type: 'number', step: 'any', min: '0', value: String(p.unitKm) })
    unit.addEventListener('change', () => {
      const v = numOrNull(unit.value)
      if (v && v > 0) this.mutate((d) => (d.unitKm = v))
    })
    const b = (k: keyof Bounds) => {
      const el = h('input', { class: 'mt-input', type: 'number', step: 'any', value: String(Math.round(p.bounds[k] * 100) / 100) })
      el.addEventListener('change', () => {
        const v = numOrNull(el.value)
        if (v !== null) this.mutate((d) => (d.bounds = { ...d.bounds, [k]: v }))
      })
      return el
    }
    const isDefault = s?.settings.defaultProfileId === p.id
    body.append(
      h('div', { class: 'mt-form' }, h('label', null, 'Name'), name, h('label', null, '1 unit ='), h('div', { class: 'mt-row' }, unit, h('span', null, 'km'))),
      h('h4', null, 'Bounds'),
      h('div', { class: 'mt-form mt-form-4' }, h('label', null, 'X min'), b('minX'), h('label', null, 'X max'), b('maxX'), h('label', null, 'Y min'), b('minY'), h('label', null, 'Y max'), b('maxY')),
      h('div', { class: 'mt-row' }, h('button', { class: 'mt-btn mt-ghost', onclick: () => this.mutate((d) => (d.bounds = boundsOf(d))) }, 'Auto from points & zones')),
      h(
        'label',
        { class: 'mt-check' },
        h('input', { type: 'checkbox', checked: isDefault, onchange: (e: Event) => this.send({ type: 'saveSettings', settings: { defaultProfileId: (e.target as HTMLInputElement).checked ? p.id : null } }) }),
        'Default map for chats that have none',
      ),
      h('div', { class: 'mt-dim' }, `${p.points.length} points · ${p.zones.length} zones${p.image ? ' · image' : ''}`),
      h(
        'div',
        { class: 'mt-row' },
        h('button', { class: 'mt-btn', onclick: () => this.send({ type: 'createProfile', name: 'New map' }) }, 'New map'),
        h('span', { class: 'mt-spacer' }),
        h(
          'button',
          {
            class: 'mt-btn mt-danger',
            onclick: async () => {
              const { confirmed } = await this.ctx.ui.showConfirm({
                title: 'Delete map',
                message: `Delete "${p.name}" with its points, zones and image? Chats using it keep their coordinates.`,
                variant: 'danger',
                confirmLabel: 'Delete',
              })
              if (confirmed) this.send({ type: 'deleteProfile', profileId: p.id })
            },
          },
          'Delete map',
        ),
      ),
    )
  }
}

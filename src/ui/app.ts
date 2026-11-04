import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { bearing, boundsOf, calibMaps, calibrationForBounds, compass, distanceUnits, formatCoord, formatKm, imageToWorld, locate, normalizeCalib, rectCalibration } from '../shared/geo'
import { FEATURE_TYPES, LAYER_LABEL, LAYER_ORDER, featuresFromJson, featuresToGeoJson, layerSettings, newFeatureId } from '../shared/features'
import { entriesFromLorebookJson, hasMapData, parseMapEntries } from '../shared/mapext'
import { mergeInto, newProfile, parseCoordinateText, slug, type ParseResult } from '../shared/parser'
import { VAR_NAME_RE, isMoved, movePoint, placeRef, placeText, placesVarName, revertPoint } from '../shared/places'
import { applyRefs, findCoords, guessName, resolveRefs, type CoordHit } from '../shared/convert'
import type {
  BackendMessage,
  Bounds,
  Feature,
  FeatureGeom,
  FeatureLayer,
  FrontendMessage,
  LayerSettings,
  LorebookBackupSummary,
  MapImageMeta,
  InjectMode,
  Poi,
  StatePayload,
  WorldBookEntryLite,
  WorldProfile,
  Zone,
} from '../shared/types'
import { clear, debounce, enableScrub, h, hueOf, icon, numOrNull } from './dom'
import { History } from './history'
import { MapView, type Layers, type Tool } from './viewport'
import { DENSITY_PRESETS, hasSymbols } from './terrain'
import { BIOMES, DETAIL, DEFAULT_LAND, biomeColor, biomeName, biomesOf, cellsWithin, encodeBytes, findCell, floodCells, graphFor, isWater, newGrid } from '../shared/cells'
import { colorAt, makeSampler, seedFromImage, type Sampler } from './landmap'
import { isLandTool, type LandTool } from './viewport'
import { worldToImage } from '../shared/geo'

type Tab = 'chat' | 'points' | 'zones' | 'land' | 'layers' | 'import' | 'image' | 'map'

const TABS: [Tab, string][] = [
  ['chat', 'Chat'],
  ['points', 'Points'],
  ['zones', 'Zones'],
  ['land', 'Land'],
  ['layers', 'Shapes'],
  ['import', 'Import'],
  ['image', 'Image'],
  ['map', 'Map'],
]

const TOOL_HINT: Partial<Record<Tool, string>> = {
  me: 'Click the map to set your position (snaps to points).',
  dest: 'Click the map to set the destination (snaps to points).',
  add: 'Click the map to add a point.',
  measure: 'Click two spots to measure. Esc to clear.',
  crop: 'Drag the corners or edges to crop; drag inside to move the box. Esc when done.',
  zone: 'Drag a rectangle to create a zone.',
  imgxf: 'Drag inside the picture to move it; corners scale (Shift keeps proportions), edges stretch. Esc when done.',
  vselect: 'Click a shape to select; drag to move; handles scale and stretch. Space+drag pans.',
  varea: 'Click to add points or drag freehand; Enter or double-click finishes. Space+drag pans.',
  vline: 'Click to add points or drag freehand; Enter or double-click finishes. Space+drag pans.',
  vspot: 'Click to place.',
  lbrush: 'Drag to paint the selected biome. Alt+click picks the biome under the cursor. Space+drag pans; Esc stops painting.',
  lfill: 'Click a region to fill it with the selected biome. Esc stops.',
  lsample: 'Click the map picture where it shows the selected biome to add a colour sample.',
  pmove: 'Drag places to move them (Shift 10, Alt 0.1); arrows nudge. Rings mark lorebook positions.',
}

interface ConvHit extends CoordHit {
  on: boolean
  /** Name to add as a new place when the literal matches none. */
  addName: string | null
}

interface ConvRow {
  id: string
  name: string
  content: string
  hits: ConvHit[]
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

/** Profiles from an older backend may still carry per-axis calibration. */
function withPins(p: WorldProfile | null): WorldProfile | null {
  if (!p) return p
  for (const key of ['image', 'imageTemplate'] as const) {
    const m = p[key]
    if (m) p[key] = { ...m, calib: normalizeCalib(m.calib, m.width, m.height, p.bounds) }
  }
  return p
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
  private history = new History()
  private undoBtn!: HTMLButtonElement
  private redoBtn!: HTMLButtonElement
  /** Groups a run of edits (a drag, a scrub) into one undo step. */
  private editGroup: string | null = null
  private pointFilter = ''
  private movedOnly = false
  /** Land painting state. */
  private landBiome = DEFAULT_LAND
  private landKeepCoast = false
  /** Cells the current brush stroke skipped because of Keep coastline, and cells it changed. */
  private landBlocked = 0
  private landPainted = 0
  private landDetail = 10000
  private landSeed = { tolerance: 120, smooth: 1, minRegion: 6 }
  private landStroke: Uint8Array | null = null
  private landFrame = 0
  private confirmRemoveLand = false
  private picture: HTMLImageElement | null = null
  private sampler: Sampler | null = null
  private importText = ''
  private importMode: 'merge' | 'replace' | 'new' = 'merge'
  private importPreview: ParseResult | null = null
  private books: { id: string; name: string }[] = []
  private entries: WorldBookEntryLite[] = []
  private bookId = ''
  /** Lorebook conversion preview: literal coordinates per entry, each with its own checkbox. */
  private convert: ConvRow[] | null = null
  private backups: LorebookBackupSummary[] = []
  private confirmRestore: string | null = null
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
        onPoiMove: (id, x, y, phase) => this.onPoiMove(id, x, y, phase),
        onLand: (tool, phase, x, y, e) => this.onLand(tool, phase, x, y, e),
        onContextMenu: (x, y, poi, cx, cy) => this.openMenu(x, y, poi, cx, cy),
        onToolDone: () => this.setTool('pan'),
        onImageEdit: (patch, phase) => this.onImageEdit(patch, phase),
        onFeaturesEdit: (next, phase) => this.onFeaturesEdit(next, phase),
        onFeatureSelection: (ids) => this.onFeatureSelection(ids),
        warn: (m) => this.warn(m),
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
    this.el.addEventListener('keydown', (e) => this.onKey(e))
    enableScrub(this.el, {
      onStart: () => (this.editGroup = `scrub-${Date.now()}`),
      onEnd: () => {
        this.editGroup = null
        if (this.sideDirty) this.renderSide(true)
      },
    })
    this.render()
  }

  private onKey(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    const t = e.target as HTMLElement
    // Text fields keep their own undo.
    if (t.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]), select')) return
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) this.undo()
    else if ((k === 'z' && e.shiftKey) || k === 'y') this.redo()
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  private undo(): void {
    this.flushSave.flush()
    const prev = this.profile && this.history.undo(this.profile)
    if (prev) this.restore(prev)
  }

  private redo(): void {
    const next = this.profile && this.history.redo(this.profile)
    if (next) this.restore(next)
  }

  /** Put back a snapshot, keeping the current image bytes' metadata when the image changed since. */
  private restore(snap: WorldProfile): void {
    const cur = this.profile!
    const next = structuredClone(snap)
    if (!(snap.image && cur.image && snap.image.rev === cur.image.rev)) next.image = cur.image && structuredClone(cur.image)
    next.updatedAt = Date.now()
    this.profile = next
    this.map.setProfile(next)
    this.pendingSave = true
    this.flushSave()
    this.renderSide(true)
    this.renderStatus()
    this.renderHistory()
  }

  private renderHistory(): void {
    this.undoBtn.disabled = !this.history.canUndo()
    this.redoBtn.disabled = !this.history.canRedo()
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
        if (msg.profile?.id !== this.profile?.id) this.history.clear()
        if (!this.pendingSave || msg.profile?.id !== this.profile?.id) this.profile = withPins(msg.profile)
        this.map.setProfile(this.profile)
        this.map.setChat(msg.chat)
        this.syncImage()
        this.render()
        break
      case 'image':
        if (msg.profileId !== this.profile?.id) return
        this.sampler = null
        if (!msg.dataUrl) {
          this.picture = null
          this.map.setImage(null)
          return
        }
        {
          const img = new Image()
          img.onload = () => {
            if (msg.profileId !== this.profile?.id) return
            this.picture = img
            this.map.setImage(img)
            if (this.tab === 'land') this.renderSide(true)
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
        if (msg.bookId !== this.bookId) this.convert = null
        this.bookId = msg.bookId
        this.entries = msg.entries
        this.renderSide(true)
        break
      case 'lorebookBackups':
        this.backups = msg.backups
        if (this.tab === 'import') this.renderSide(true)
        break
      case 'lorebookApplied':
        this.convert = null
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

  /** Apply a local edit, redraw, and save (debounced). Edits sharing `group` undo as one step. */
  private mutate(fn: (p: WorldProfile) => void, rerenderSide = true, group: string | null = this.editGroup): void {
    if (!this.profile) return
    this.history.record(this.profile, group)
    const next: WorldProfile = structuredClone(this.profile)
    fn(next)
    next.updatedAt = Date.now()
    this.profile = next
    this.map.setProfile(next)
    this.pendingSave = true
    this.flushSave()
    if (rerenderSide) this.renderSide()
    this.renderStatus()
    this.renderHistory()
  }

  private onImageEdit(patch: Partial<Pick<MapImageMeta, 'crop' | 'calib'>>, phase: 'move' | 'end'): void {
    if (!this.profile?.image) return
    this.editGroup ??= `image-${Date.now()}`
    this.mutate((p) => Object.assign(p.image!, structuredClone(patch)), phase === 'end')
    if (phase === 'end') this.editGroup = null
  }

  // ── Toolbar ───────────────────────────────────────────────────────────────

  private buildToolbar(): HTMLDivElement {
    this.undoBtn = h('button', { class: 'mt-btn', title: 'Undo (Ctrl+Z)', disabled: true, onclick: () => this.undo() }, icon('undo'))
    this.redoBtn = h('button', { class: 'mt-btn', title: 'Redo (Ctrl+Shift+Z)', disabled: true, onclick: () => this.redo() }, icon('redo'))
    const toolBtn = (t: Tool, ico: Parameters<typeof icon>[0], title: string) => {
      const b = h('button', { class: 'mt-btn mt-tool', title, onclick: () => this.setTool(t) }, icon(ico))
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
        toolBtn('pmove', 'movepin', 'Move places'),
        toolBtn('measure', 'ruler', 'Measure distance'),
      ),
      h(
        'div',
        { class: 'mt-seg', title: 'Shapes (Layers tab)' },
        toolBtn('vselect', 'select', 'Select shapes'),
        toolBtn('varea', 'area', 'Draw an area'),
        toolBtn('vline', 'line', 'Draw a line'),
        toolBtn('vspot', 'spot', 'Place a spot'),
      ),
      h('div', { class: 'mt-seg' }, this.undoBtn, this.redoBtn),
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
    const prev = this.map.tool
    this.map.setTool(t)
    for (const [tool, b] of this.toolButtons) b.classList.toggle('mt-on', tool === t)
    const hint = TOOL_HINT[t]
    this.hint.hidden = !hint
    this.hint.textContent = hint ?? ''
    const panelTools: Tool[] = ['crop', 'zone', 'imgxf', 'vselect', 'varea', 'vline', 'vspot', 'pmove', 'lbrush', 'lfill', 'lsample']
    if (isLandTool(t) && this.tab !== 'land' && this.profile) {
      this.tab = 'land'
      if (!this.isSideShown()) this.toggleSide()
    }
    if (['varea', 'vline', 'vspot'].includes(t) && this.tab !== 'layers' && this.profile) {
      this.tab = 'layers'
      if (!this.isSideShown()) this.toggleSide()
    }
    if (t === 'varea') this.drawGeom = 'area'
    if (t === 'vline') this.drawGeom = 'line'
    if (t === 'vspot') this.drawGeom = 'spot'
    if (t !== 'varea') this.map.vec.holeFor = null
    if (panelTools.includes(t) || panelTools.includes(prev)) this.renderSide()
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
    }
  }

  private onRect(tool: Tool, r: Bounds): void {
    if (tool === 'zone') {
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

  private onPoiMove(id: string, x: number, y: number, phase: 'move' | 'end'): void {
    this.editGroup ??= `poi-${id}-${Date.now()}`
    this.mutate(
      (d) => {
        const t = d.points.find((q) => q.id === id)
        if (t) movePoint(t, x, y)
      },
      phase === 'end',
    )
    if (phase === 'end') this.editGroup = null
  }

  private revertPoi(ids: string[]): void {
    const set = new Set(ids)
    this.mutate((d) => d.points.forEach((q) => set.has(q.id) && revertPoint(q)))
  }

  private copyRef(pt: Poi): void {
    const p = this.profile!
    const ref = placeRef(p.placesVar ?? placesVarName(p.name), pt.id)
    void navigator.clipboard?.writeText(ref)
    this.warn(p.placesVar ? `Copied ${ref}` : `Copied ${ref}. Turn on the lorebook variable in Points so it resolves.`)
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
      ...(poi ? [item('Copy lorebook reference', () => this.copyRef(poi))] : []),
      ...(poi?.origin ? [item(`Back to lorebook position ${placeText(poi.origin.x, poi.origin.y)}`, () => this.revertPoi([poi.id]))] : []),
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
      case 'layers':
        this.renderLayersTab(body)
        break
      case 'land':
        this.renderLandTab(body)
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
      h(
        'div',
        { class: 'mt-row' },
        search,
        h('button', { class: 'mt-btn', title: 'Add point (click on map)', onclick: () => this.setTool('add') }, icon('plus'), 'Add'),
        h(
          'button',
          { class: `mt-btn${this.map.tool === 'pmove' ? ' mt-on' : ''}`, title: 'Drag places on the map', onclick: () => this.setTool(this.map.tool === 'pmove' ? 'pan' : 'pmove') },
          icon('movepin'),
          'Move',
        ),
      ),
    )
    const moved = p.points.filter(isMoved)
    if (!moved.length) this.movedOnly = false
    if (moved.length) {
      const only = h('input', { type: 'checkbox', checked: this.movedOnly })
      only.addEventListener('change', () => {
        this.movedOnly = only.checked
        renderList()
      })
      body.append(
        h(
          'div',
          { class: 'mt-row mt-wrap' },
          h('span', { class: 'mt-moved' }, `${moved.length} moved`),
          h('span', { class: 'mt-dim' }, 'from their lorebook position'),
          h('span', { class: 'mt-spacer' }),
          h('label', { class: 'mt-check' }, only, 'Only moved'),
          h('button', { class: 'mt-btn mt-ghost', title: 'Put every moved place back where the lorebook has it', onclick: () => this.revertPoi(moved.map((q) => q.id)) }, 'Revert all'),
        ),
      )
    }
    body.append(this.placesVarBox(p))
    const editing = p.points.find((pt) => pt.id === this.editingPoi)
    if (editing) body.append(this.poiEditor(editing))
    const list = h('div', { class: 'mt-list' })
    body.append(list)

    const renderList = () => {
      clear(list)
      const q = this.pointFilter.trim().toLowerCase()
      const groups = new Map<string, Poi[]>()
      for (const pt of p.points) {
        if (this.movedOnly && !isMoved(pt)) continue
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
              pt.origin
                ? h('span', { class: 'mt-mono mt-moved', title: `Moved. Lorebook: ${placeText(pt.origin.x, pt.origin.y)}` }, formatCoord(pt.x, pt.y))
                : h('span', { class: 'mt-dim mt-mono' }, formatCoord(pt.x, pt.y)),
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

  /** Publish place coordinates to a chat variable that lorebook entries read. */
  private placesVarBox(p: WorldProfile): HTMLElement {
    const on = !!p.placesVar
    const name = h('input', { class: 'mt-input mt-grow mt-mono', value: p.placesVar ?? placesVarName(p.name), spellcheck: false })
    const check = h('input', { type: 'checkbox', checked: on })
    const apply = () => {
      const v = name.value.trim()
      if (check.checked && !VAR_NAME_RE.test(v)) {
        check.checked = false
        return this.warn('Use letters, digits and underscores for the variable name.')
      }
      this.mutate((d) => {
        d.placesVar = check.checked ? v : undefined
      })
    }
    check.addEventListener('change', apply)
    name.addEventListener('change', () => check.checked && apply())
    const sample = p.points[0]
    return h(
      'details',
      { class: 'mt-group', open: on },
      h('summary', null, h('span', null, 'Lorebook variable'), h('span', { class: 'mt-dim' }, on ? ` · ${p.placesVar}` : ' · off')),
      h('label', { class: 'mt-check' }, check, 'Publish coordinates to a chat variable'),
      h('div', { class: 'mt-row' }, name),
      h(
        'div',
        { class: 'mt-dim' },
        'Written into every chat that uses this map, as "(x, y)" under each place id, and kept current as you move places. A lorebook entry reads one with ',
        h('span', { class: 'mt-var' }, placeRef(name.value || 'map_places', sample?.id ?? 'place-id')),
        '. Copy reference on a place gives its exact macro.',
      ),
    )
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
        movePoint(t, nx, ny)
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
      pt.origin
        ? h(
            'div',
            { class: 'mt-row' },
            h('span', { class: 'mt-dim' }, 'Lorebook position'),
            h('span', { class: 'mt-mono mt-moved' }, placeText(pt.origin.x, pt.origin.y)),
            h('span', { class: 'mt-spacer' }),
            h('button', { class: 'mt-btn mt-ghost', onclick: () => this.revertPoi([pt.id]) }, 'Revert'),
          )
        : '',
      h(
        'div',
        { class: 'mt-row' },
        h('span', { class: 'mt-var mt-dim mt-grow' }, placeRef(p.placesVar ?? placesVarName(p.name), pt.id)),
        h('button', { class: 'mt-btn', title: 'Copy the macro a lorebook entry uses for this place', onclick: () => this.copyRef(pt) }, 'Copy reference'),
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
        h('button', { class: 'mt-btn mt-primary', onclick: () => this.applyImport(), disabled: !this.importText.trim() && !this.importPreview }, 'Apply'),
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
          pv.skipped ? h('span', { class: 'mt-dim' }, ` · ${pv.skipped} skipped`) : '',
          h('ul', null, ...pv.zones.slice(0, 6).map((z) => h('li', null, `${z.kind === 'region' ? 'Region' : 'Zone'}: ${z.name}`)), ...pv.points.slice(0, 6).map((pt) => h('li', null, `${pt.name} ${formatCoord(pt.x, pt.y)}`))),
        ),
      )
    }

    body.append(h('h4', null, 'From a lorebook'))
    if (!this.state?.worldBooksAvailable) {
      body.append(h('div', { class: 'mt-dim' }, 'Grant the world_books permission to pull entries directly.'))
    } else {
      const bookSel = h('select', { class: 'mt-select mt-grow' }, h('option', { value: '' }, this.books.length ? 'Choose a lorebook…' : '—'))
      for (const b of this.books) bookSel.append(h('option', { value: b.id, selected: b.id === this.bookId }, b.name))
      bookSel.addEventListener('change', () => bookSel.value && this.send({ type: 'listWorldBookEntries', bookId: bookSel.value }))
      body.append(
        h(
          'div',
          { class: 'mt-row' },
          h(
            'button',
            {
              class: 'mt-btn',
              onclick: () => {
                this.send({ type: 'listWorldBooks' })
                this.send({ type: 'listLorebookBackups' })
              },
            },
            'Load lorebooks',
          ),
          bookSel,
        ),
      )
      const mapped = this.entries.filter((e) => e.map)
      if (mapped.length) {
        body.append(
          h(
            'div',
            { class: 'mt-preview' },
            h('b', null, `${mapped.length} entries carry map data`),
            h('div', { class: 'mt-dim' }, 'Points, regions and continents from each entry’s map field. Preferred over reading entry text.'),
            h(
              'div',
              { class: 'mt-row' },
              h(
                'button',
                {
                  class: 'mt-btn mt-primary',
                  onclick: () => {
                    this.importText = ''
                    this.importPreview = parseMapEntries(mapped)
                    if (this.profile && this.importMode === 'merge') this.importMode = 'replace'
                    this.renderSide(true)
                  },
                },
                'Use map data',
              ),
            ),
          ),
        )
      }
      if (this.entries.length) {
        const entrySel = h('select', { class: 'mt-select mt-grow' }, h('option', { value: '' }, `${this.entries.length} entries with coordinates…`))
        for (const e of this.entries) entrySel.append(h('option', { value: e.id }, e.name))
        entrySel.addEventListener('change', () => {
          const e = this.entries.find((q) => q.id === entrySel.value)
          if (!e) return
          // Converted entries hold map references; read them as the coordinates they stand for.
          this.importText = resolveRefs(e.content, this.profile)
          this.importPreview = parseCoordinateText(this.importText)
          this.renderSide(true)
        })
        body.append(h('div', { class: 'mt-row' }, entrySel))
        if (p) body.append(this.convertSection(p))
      }
      if (this.backups.length) body.append(this.backupList())
    }

    body.append(
      h('h4', null, 'Map file'),
      h(
        'div',
        { class: 'mt-row' },
        h('button', { class: 'mt-btn', onclick: () => this.exportProfile(), disabled: !p }, 'Export JSON'),
        h('button', { class: 'mt-btn', onclick: () => void this.importProfileFile() }, 'Import JSON'),
      ),
      h('div', { class: 'mt-dim' }, 'A map file holds points, zones, crop and calibration (the image is uploaded separately). A lorebook export with map fields works too.'),
    )
  }

  // ── Lorebook conversion ─────────────────────────────────────────────────

  private convertSection(p: WorldProfile): HTMLElement {
    const box = h('div', { class: 'mt-preview' })
    const varName = p.placesVar ?? placesVarName(p.name)
    box.append(
      h('b', null, 'Convert coordinates to map references'),
      h(
        'div',
        { class: 'mt-dim' },
        'Replaces literal coordinates in these entries with ',
        h('span', { class: 'mt-var' }, placeRef(varName, 'place-id')),
        ', so the map owns positions. Nothing is written until you apply, and the original text is kept for Restore.',
      ),
    )
    const rows = this.convert
    if (!rows) {
      box.append(
        h(
          'div',
          { class: 'mt-row' },
          h(
            'button',
            {
              class: 'mt-btn mt-primary',
              onclick: () => {
                this.convert = this.buildConversion(p)
                this.renderSide(true)
              },
            },
            'Find coordinates',
          ),
        ),
      )
      return box
    }

    const all = rows.flatMap((r) => r.hits)
    const count = (by: string) => all.filter((x) => x.by === by).length
    const unmatched = all.filter((x) => !x.placeId)
    if (!all.length) {
      box.append(h('div', null, 'No literal coordinates left in these entries.'), h('div', { class: 'mt-row' }, h('button', { class: 'mt-btn mt-ghost', onclick: () => ((this.convert = null), this.renderSide(true)) }, 'Close')))
      return box
    }
    box.append(
      h(
        'div',
        null,
        `${all.length} coordinates in ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}: ${count('name')} by name`,
        count('title') ? `, ${count('title')} by entry title` : '',
        count('coords') ? h('span', { class: 'mt-warn' }, `, ${count('coords')} by position only`) : '',
        unmatched.length ? h('span', { class: 'mt-dim' }, `, ${unmatched.length} with no place`) : '',
        '.',
      ),
    )
    const applyBtn = h('button', { class: 'mt-btn mt-primary' })
    const refresh = () => {
      const n = all.filter((x) => x.on).length
      applyBtn.textContent = `Apply ${n} ${n === 1 ? 'change' : 'changes'}`
      applyBtn.disabled = n === 0
    }
    for (const r of rows) {
      const det = h('details', { class: 'mt-group', open: rows.length <= 3 }, h('summary', null, h('span', null, r.name), h('span', { class: 'mt-dim' }, ` ${r.hits.length}`)))
      for (const x of r.hits) det.append(this.convRow(x, varName, refresh))
      box.append(det)
    }
    applyBtn.addEventListener('click', () => this.applyConversion(p))
    refresh()
    box.append(
      h(
        'div',
        { class: 'mt-row' },
        applyBtn,
        h('span', { class: 'mt-spacer' }),
        h('button', { class: 'mt-btn mt-ghost', onclick: () => ((this.convert = null), this.renderSide(true)) }, 'Cancel'),
      ),
    )
    if (!p.placesVar) box.append(h('div', { class: 'mt-dim' }, `Applying also turns on the lorebook variable (${varName}).`))
    return box
  }

  private convRow(x: ConvHit, varName: string, refresh: () => void): HTMLElement {
    const check = h('input', { type: 'checkbox', checked: x.on })
    check.addEventListener('change', () => {
      x.on = check.checked
      refresh()
    })
    const at = x.start - x.lineStart
    const pre = x.line.slice(Math.max(0, at - 48), at)
    const post = x.line.slice(at + x.literal.length, at + x.literal.length + 32)
    const clip = (s: string, left: boolean) => (left ? (at > 48 ? '…' : '') + s : s + (x.line.length > at + x.literal.length + 32 ? '…' : ''))
    const target = x.placeId ? placeRef(varName, x.placeId) : x.addName ? placeRef(varName, slug(x.addName)) : null
    const label = x.placeId
      ? h('span', { class: x.by === 'coords' ? 'mt-warn' : 'mt-dim' }, `${x.placeName} · ${x.by === 'name' ? 'named here' : x.by === 'title' ? 'entry title' : 'same position only, check it'}`)
      : x.addName
        ? h('span', { class: 'mt-dim' }, `No place yet · adds “${x.addName}” to the map`)
        : h('span', { class: 'mt-dim' }, 'No matching place; left as is')
    return h(
      'label',
      { class: 'mt-conv' },
      x.placeId || x.addName ? check : h('span'),
      h(
        'div',
        null,
        label,
        h('div', { class: 'mt-conv-line' }, clip(pre, true), h('span', { class: 'mt-del' }, x.literal), clip(post, false)),
        target ? h('div', { class: 'mt-conv-line' }, clip(pre, true), h('span', { class: 'mt-ins' }, target), clip(post, false)) : '',
      ),
    )
  }

  private buildConversion(p: WorldProfile): ConvRow[] {
    const rows: ConvRow[] = []
    for (const e of this.entries) {
      const hits = findCoords(e.content, e.name, p.points).map((x): ConvHit => {
        const addName = x.placeId ? null : guessName(x)
        // Matches by name or title start ticked; position-only matches and new places are opt-in.
        return { ...x, on: x.by === 'name' || x.by === 'title', addName }
      })
      if (hits.length) rows.push({ id: e.id, name: e.name, content: e.content, hits })
    }
    return rows
  }

  private applyConversion(p: WorldProfile): void {
    const rows = this.convert
    if (!rows) return
    const varName = p.placesVar ?? placesVarName(p.name)
    // New places first, so their ids exist before entries point at them.
    const used = new Set(p.points.map((q) => q.id))
    const added: Poi[] = []
    for (const x of rows.flatMap((r) => r.hits)) {
      if (!x.on || x.placeId || !x.addName) continue
      const same = added.find((a) => a.name.toLowerCase() === x.addName!.toLowerCase())
      if (same) {
        x.placeId = same.id
        continue
      }
      let id = slug(x.addName)
      for (let i = 2; used.has(id); i++) id = `${slug(x.addName)}-${i}`
      used.add(id)
      added.push({ id, name: x.addName, x: x.x, y: x.y, group: 'From lorebook' })
      x.placeId = id
    }
    const changes = rows
      .map((r) => ({ id: r.id, name: r.name, before: r.content, after: applyRefs(r.content, r.hits.filter((x) => x.on && x.placeId), varName) }))
      .filter((c) => c.after !== c.before)
    if (!changes.length) return this.warn('Nothing selected.')
    if (added.length || !p.placesVar) {
      this.mutate((d) => {
        d.placesVar = varName
        d.points.push(...added)
      })
      this.flushSave.flush()
    }
    const book = this.books.find((b) => b.id === this.bookId)
    this.send({ type: 'applyLorebookRefs', bookId: this.bookId, bookName: book?.name ?? 'Lorebook', changes })
    this.convert = null
    this.renderSide(true)
  }

  private backupList(): HTMLElement {
    const det = h('details', { class: 'mt-group' }, h('summary', null, h('span', null, 'Lorebook backups'), h('span', { class: 'mt-dim' }, ` ${this.backups.length}`)))
    for (const b of this.backups) {
      const armed = this.confirmRestore === b.id
      det.append(
        h(
          'div',
          { class: 'mt-row' },
          h(
            'span',
            { class: 'mt-grow' },
            `${b.bookName} · ${new Date(b.at).toLocaleString()} · ${b.count} ${b.count === 1 ? 'entry' : 'entries'}`,
            h('span', { class: 'mt-dim' }, b.reason === 'restore' ? ' · before a restore' : ' · before converting'),
          ),
          h(
            'button',
            {
              class: `mt-btn${armed ? ' mt-danger' : ''}`,
              title: 'Put these entries back to the saved text',
              onclick: () => {
                if (!armed) {
                  this.confirmRestore = b.id
                  return this.renderSide(true)
                }
                this.confirmRestore = null
                this.send({ type: 'restoreLorebookBackup', backupId: b.id })
              },
            },
            armed ? 'Confirm restore' : 'Restore',
          ),
        ),
      )
    }
    return det
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
      this.history.record(this.profile)
      this.profile = next
      this.renderHistory()
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
      // A lorebook export with map fields: preview it like a pasted import.
      const lore = entriesFromLorebookJson(data)
      if (lore && hasMapData(lore)) {
        this.importText = ''
        this.importPreview = parseMapEntries(lore)
        this.tab = 'import'
        this.renderSide(true)
        return
      }
      if (!Array.isArray(data.points) || !Array.isArray(data.zones)) throw new Error('Not a map file or a lorebook with map data')
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
    opacity.addEventListener('input', () => this.mutate((d) => (d.image!.opacity = Number(opacity.value)), false, 'opacity'))
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
    const cropping = this.map.tool === 'crop'
    const cropIn = (k: 'x' | 'y' | 'w' | 'h') => {
      const el = h('input', { class: 'mt-input', type: 'number', step: '1', min: '0', value: String(meta.crop[k]) })
      el.addEventListener('change', () => {
        const v = numOrNull(el.value)
        if (v === null) return
        this.mutate((d) => {
          const im = d.image!
          const c = im.crop
          c[k] = Math.max(0, Math.round(v))
          c.x = Math.min(c.x, im.width - 1)
          c.y = Math.min(c.y, im.height - 1)
          c.w = Math.max(1, Math.min(c.w, im.width - c.x))
          c.h = Math.max(1, Math.min(c.h, im.height - c.y))
        }, false)
      })
      return el
    }
    body.append(
      h('h4', null, 'Crop'),
      h(
        'div',
        { class: 'mt-row' },
        h('button', { class: `mt-btn${cropping ? ' mt-on mt-primary' : ''}`, onclick: () => this.setTool(cropping ? 'pan' : 'crop') }, icon('crop'), cropping ? 'Done' : 'Edit crop'),
        h('button', { class: 'mt-btn mt-ghost', onclick: () => this.mutate((d) => (d.image!.crop = { x: 0, y: 0, w: d.image!.width, h: d.image!.height })) }, 'Reset'),
      ),
      cropping ? h('div', { class: 'mt-dim' }, 'Drag the corner or edge handles on the map; drag inside the box to move it.') : '',
      h('div', { class: 'mt-form mt-form-4' }, h('label', null, 'Left'), cropIn('x'), h('label', null, 'Top'), cropIn('y'), h('label', null, 'Width'), cropIn('w'), h('label', null, 'Height'), cropIn('h')),
    )

    // Placement: where the picture sits in world coordinates. It's only a
    // tracing reference; the vector layers are the map.
    const transforming = this.map.tool === 'imgxf'
    const calib = meta.calib
    const tl = imageToWorld(calib, meta.crop.x, meta.crop.y)
    const br = imageToWorld(calib, meta.crop.x + meta.crop.w, meta.crop.y + meta.crop.h)
    const rect = { minX: Math.min(tl.x, br.x), maxX: Math.max(tl.x, br.x), minY: Math.min(tl.y, br.y), maxY: Math.max(tl.y, br.y) }
    const cx = (rect.minX + rect.maxX) / 2
    const cy = (rect.minY + rect.maxY) / 2
    const rw = rect.maxX - rect.minX
    const rh = rect.maxY - rect.minY
    const r3 = (n: number) => Math.round(n * 1000) / 1000
    const place = (next: { cx: number; cy: number; w: number; h: number }) =>
      this.mutate(
        (d) =>
          (d.image!.calib = rectCalibration(d.image!.crop, {
            minX: next.cx - next.w / 2,
            maxX: next.cx + next.w / 2,
            minY: next.cy - next.h / 2,
            maxY: next.cy + next.h / 2,
          })),
        false,
      )
    const field = (key: 'cx' | 'cy' | 'w' | 'h', value: number) => {
      const el = h('input', { class: 'mt-input', type: 'number', step: 'any', value: String(r3(value)) })
      el.addEventListener('change', () => {
        const v = numOrNull(el.value)
        if (v === null || ((key === 'w' || key === 'h') && v <= 0)) return
        const next = { cx, cy, w: rw, h: rh, [key]: v }
        if (this.keepAspect && key === 'w') next.h = (rh * v) / rw
        if (this.keepAspect && key === 'h') next.w = (rw * v) / rh
        place(next)
      })
      return el
    }
    body.append(
      h('h4', null, 'Placement'),
      h('div', { class: 'mt-dim' }, 'Place the picture under your coordinates to trace from it. It doesn’t have to match exactly: the shapes you draw are the map.'),
      h(
        'div',
        { class: 'mt-row mt-wrap' },
        h('button', { class: `mt-btn${transforming ? ' mt-on mt-primary' : ''}`, onclick: () => this.setTool(transforming ? 'pan' : 'imgxf') }, icon('transform'), transforming ? 'Done' : 'Transform'),
        h('button', { class: 'mt-btn mt-ghost', onclick: () => this.mutate((d) => (d.image!.calib = calibrationForBounds(d.image!.width, d.image!.height, d.bounds))) }, 'Fit to map bounds'),
        h('button', { class: 'mt-btn mt-ghost', onclick: () => this.map.fit() }, 'Fit view'),
      ),
      transforming ? h('div', { class: 'mt-dim' }, 'Drag inside to move. Corners scale (Shift keeps proportions); edges stretch one side to squash or widen.') : '',
      h('div', { class: 'mt-form mt-form-4' }, h('label', null, 'Centre X'), field('cx', cx), h('label', null, 'Centre Y'), field('cy', cy), h('label', null, 'Width'), field('w', rw), h('label', null, 'Height'), field('h', rh)),
      h(
        'label',
        { class: 'mt-check' },
        h('input', { type: 'checkbox', checked: this.keepAspect, onchange: (e: Event) => (this.keepAspect = (e.target as HTMLInputElement).checked) }),
        'Keep proportions when typing a size',
      ),
      h('div', { class: 'mt-dim mt-mono' }, `Covers X[${Math.round(rect.minX)}, ${Math.round(rect.maxX)}] Y[${Math.round(rect.minY)}, ${Math.round(rect.maxY)}]`),
    )
  }

  private keepAspect = true

  // ── Layers tab: landmass, topography, terrain, props ──────────────────────

  // ── Land grid ───────────────────────────────────────────────────────────

  private renderLandTab(body: HTMLElement): void {
    const p = this.profile!
    const grid = p.land
    if (!grid) {
      const detail = h('select', { class: 'mt-select' })
      for (const [n, label] of DETAIL) detail.append(h('option', { value: String(n), selected: n === this.landDetail }, `${label} (~${n.toLocaleString()} cells)`))
      detail.addEventListener('change', () => (this.landDetail = Number(detail.value)))
      body.append(
        h('h4', null, 'Land grid'),
        h(
          'div',
          { class: 'mt-dim' },
          'Paint the world as small cells, each with a biome: ocean, grassland, forest, taiga, desert, mountains and more. Start from an empty ocean, then paint, or seed it from your map picture by sampling its colours. Cells and biomes are adapted from Azgaar’s Fantasy Map Generator (MIT).',
        ),
        h('div', { class: 'mt-form' }, h('label', null, 'Detail'), detail),
        h(
          'div',
          { class: 'mt-row' },
          h(
            'button',
            {
              class: 'mt-btn mt-primary',
              onclick: () => {
                const b = p.bounds
                const mx = (b.maxX - b.minX) * 0.06
                const my = (b.maxY - b.minY) * 0.06
                const bounds = { minX: Math.floor(b.minX - mx), maxX: Math.ceil(b.maxX + mx), minY: Math.floor(b.minY - my), maxY: Math.ceil(b.maxY + my) }
                this.mutate((d) => {
                  d.land = newGrid(bounds, this.landDetail)
                })
                this.setTool('lbrush')
              },
            },
            'Create land grid',
          ),
        ),
        h('div', { class: 'mt-dim' }, 'It covers the map’s bounds with a small margin.'),
      )
      return
    }

    const graph = graphFor(grid)
    const biomes = biomesOf(grid, graph)
    const counts = new Map<number, number>()
    for (let i = 0; i < biomes.length; i++) counts.set(biomes[i], (counts.get(biomes[i]) ?? 0) + 1)
    const tool = this.map.tool
    const toolBtn = (t: LandTool, label: string, title: string) =>
      h('button', { class: `mt-btn${tool === t ? ' mt-on' : ''}`, title, onclick: () => this.setTool(t) }, label)
    const size = h('input', { type: 'range', min: '4', max: '120', value: String(this.map.brushPx), class: 'mt-grow' })
    size.addEventListener('input', () => {
      this.map.brushPx = Number(size.value)
      this.map.invalidate()
    })
    const keep = h('input', { type: 'checkbox', checked: this.landKeepCoast })
    keep.addEventListener('change', () => (this.landKeepCoast = keep.checked))
    body.append(
      h('h4', null, 'Paint'),
      h('div', { class: 'mt-row mt-wrap' }, toolBtn('lbrush', 'Brush', 'Paint cells'), toolBtn('lfill', 'Fill', 'Fill a connected region'), h('label', { class: 'mt-check', title: 'Painting a land biome only changes land, and water only changes water' }, keep, 'Keep coastline')),
      h('div', { class: 'mt-row' }, h('span', { class: 'mt-dim' }, 'Brush'), size),
    )

    // Palette: pick the biome to paint; the swatch changes its colour.
    const pal = h('div', { class: 'mt-list' })
    for (const b of BIOMES) {
      const color = h('input', { class: 'mt-color', type: 'color', value: biomeColor(b.id, grid), title: 'Change colour' })
      color.addEventListener('change', () =>
        this.mutate((d) => {
          d.land!.colors = { ...d.land!.colors, [b.id]: color.value }
        }),
      )
      const n = counts.get(b.id) ?? 0
      pal.append(
        h(
          'div',
          { class: `mt-item mt-biome${b.id === this.landBiome ? ' mt-on' : ''}` },
          color,
          h(
            'button',
            {
              class: 'mt-item-name',
              onclick: () => {
                this.landBiome = b.id
                if (!isLandTool(this.map.tool)) this.setTool('lbrush')
                else this.renderSide(true)
              },
            },
            biomeName(b.id, grid),
          ),
          h('span', { class: 'mt-dim mt-mono' }, n ? `${Math.round((n / graph.n) * 100)}%` : ''),
          grid.colors?.[b.id]
            ? h(
                'button',
                {
                  class: 'mt-btn mt-icon-btn',
                  title: 'Default colour',
                  onclick: () =>
                    this.mutate((d) => {
                      const c = { ...d.land!.colors }
                      delete c[b.id]
                      d.land!.colors = c
                    }),
                },
                '↺',
              )
            : h('span'),
        ),
      )
    }
    body.append(h('h4', null, 'Biomes'), pal)

    // Display.
    const opacity = h('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(this.map.landOpacity), class: 'mt-grow' })
    opacity.addEventListener('input', () => {
      this.map.landOpacity = Number(opacity.value)
      this.map.invalidate()
    })
    const onTop = h('input', { type: 'checkbox', checked: this.map.imageOnTop, disabled: !p.image })
    onTop.addEventListener('change', () => {
      this.map.imageOnTop = onTop.checked
      this.map.invalidate()
    })
    const symbols = h('input', { type: 'checkbox', checked: grid.symbols !== false })
    symbols.addEventListener('change', () =>
      this.mutate((d) => {
        d.land!.symbols = symbols.checked ? undefined : false
      }),
    )
    body.append(
      h('h4', null, 'Display'),
      h('div', { class: 'mt-row' }, h('span', { class: 'mt-dim' }, 'Opacity'), opacity),
      h('div', { class: 'mt-row mt-wrap' }, h('label', { class: 'mt-check' }, symbols, 'Terrain symbols'), h('label', { class: 'mt-check', title: 'Show the map picture above the land, at its own opacity' }, onTop, 'Picture on top')),
    )

    body.append(this.landSeedBox(grid))

    body.append(
      h(
        'div',
        { class: 'mt-row' },
        h('span', { class: 'mt-dim' }, `${graph.n.toLocaleString()} cells`),
        h('span', { class: 'mt-spacer' }),
        h(
          'button',
          {
            class: `mt-btn${this.confirmRemoveLand ? ' mt-danger' : ' mt-ghost'}`,
            onclick: () => {
              if (!this.confirmRemoveLand) {
                this.confirmRemoveLand = true
                return this.renderSide(true)
              }
              this.confirmRemoveLand = false
              if (isLandTool(this.map.tool)) this.setTool('pan')
              this.mutate((d) => {
                delete d.land
              })
            },
          },
          this.confirmRemoveLand ? 'Confirm remove' : 'Remove land grid',
        ),
      ),
    )
  }

  private landSeedBox(grid: NonNullable<WorldProfile['land']>): HTMLElement {
    const p = this.profile!
    const samples = grid.samples ?? []
    const box = h('details', { class: 'mt-group', open: !!p.image && samples.length < 2 }, h('summary', null, h('span', null, 'Seed from the map picture'), h('span', { class: 'mt-dim' }, samples.length ? ` · ${samples.length} samples` : '')))
    if (!p.image) {
      box.append(h('div', { class: 'mt-dim' }, 'Upload a map picture in the Image tab first.'))
      return box
    }
    box.append(
      h(
        'div',
        { class: 'mt-dim' },
        'Pick a biome above, then Pick colour and click the picture where it shows that biome. Add one sample per look (sea, each forest colour, snow, sand…), then Generate. Cells take the biome of the nearest sample colour.',
      ),
      h(
        'div',
        { class: 'mt-row mt-wrap' },
        h('button', { class: `mt-btn${this.map.tool === 'lsample' ? ' mt-on' : ''}`, onclick: () => this.setTool(this.map.tool === 'lsample' ? 'pan' : 'lsample') }, 'Pick colour'),
        h('span', { class: 'mt-dim' }, `for ${biomeName(this.landBiome, grid)}`),
      ),
    )
    const list = h('div', { class: 'mt-list' })
    samples.forEach((smp, i) => {
      list.append(
        h(
          'div',
          { class: 'mt-item' },
          h('span', { class: 'mt-dot', style: `background:rgb(${smp.rgb.join(',')})`, title: `rgb(${smp.rgb.join(', ')})` }),
          h('span', null, biomeName(smp.biome, grid)),
          h('span', { class: 'mt-dot', style: `background:${biomeColor(smp.biome, grid)}` }),
          h(
            'button',
            {
              class: 'mt-btn mt-icon-btn',
              title: 'Remove sample',
              onclick: () =>
                this.mutate((d) => {
                  d.land!.samples = (d.land!.samples ?? []).filter((_, j) => j !== i)
                }),
            },
            '×',
          ),
        ),
      )
    })
    box.append(list)
    const num = (key: keyof typeof this.landSeed, min: number, max: number, step: number, label: string, title: string) => {
      const el = h('input', { class: 'mt-input', type: 'number', min: String(min), max: String(max), step: String(step), value: String(this.landSeed[key]), title })
      el.addEventListener('change', () => (this.landSeed[key] = Math.max(min, Math.min(max, numOrNull(el.value) ?? this.landSeed[key]))))
      return [h('label', { title }, label), el]
    }
    box.append(
      h(
        'div',
        { class: 'mt-form' },
        ...num('tolerance', 20, 600, 10, 'Tolerance', 'How far a colour may be from every sample before the cell takes its neighbours’ biome instead (labels, ships, ink)'),
        ...num('smooth', 0, 4, 1, 'Smoothing', 'Passes of the majority filter that clears speckle'),
        ...num('minRegion', 1, 200, 1, 'Min island', 'Islands and lakes smaller than this many cells merge into their surroundings'),
      ),
      h(
        'div',
        { class: 'mt-row' },
        h(
          'button',
          {
            class: 'mt-btn mt-primary',
            disabled: samples.length < 2,
            title: samples.length < 2 ? 'Add at least two samples (e.g. sea and land)' : 'Replace every cell on the picture with the nearest sample’s biome',
            onclick: () => this.seedLand(),
          },
          'Generate',
        ),
        h('span', { class: 'mt-dim' }, 'Undo restores the previous paint.'),
      ),
    )
    return box
  }

  private ensureSampler(): Sampler | null {
    if (!this.sampler && this.picture) this.sampler = makeSampler(this.picture)
    return this.sampler
  }

  private seedLand(): void {
    const p = this.profile
    if (!p?.land || !p.image) return
    const sampler = this.ensureSampler()
    if (!sampler) return this.warn('The map picture is still loading.')
    const out = seedFromImage(p.land, p.image, sampler, this.landSeed)
    this.mutate((d) => {
      d.land!.biome = encodeBytes(out)
    })
    if (this.map.imageOnTop) {
      this.map.imageOnTop = false
      this.renderSide(true)
    }
  }

  private onLand(tool: LandTool, phase: 'down' | 'move' | 'end', x: number, y: number, e: { altKey: boolean; shiftKey: boolean }): void {
    const p = this.profile
    const grid = p?.land
    if (!p || !grid) return
    const graph = graphFor(grid)
    if (tool === 'lsample') {
      if (phase !== 'down') return
      const meta = p.image
      const sampler = this.ensureSampler()
      if (!meta || !sampler) return this.warn('Upload a map picture first.')
      const at = worldToImage(meta.calib, x, y)
      const col = colorAt(sampler, at.px, at.py, 2)
      if (!col) return this.warn('Click on the picture.')
      const rgb = col.map((v) => Math.round(v)) as [number, number, number]
      this.mutate((d) => {
        d.land!.samples = [...(d.land!.samples ?? []), { biome: this.landBiome, rgb }]
      })
      return
    }
    const target = this.landBiome
    const allowed = (current: number) => !this.landKeepCoast || isWater(current) === isWater(target)
    if (tool === 'lfill') {
      if (phase !== 'down') return
      const values = new Uint8Array(biomesOf(grid, graph))
      const start = findCell(graph, x, y)
      if (values[start] === target) return
      for (const c of floodCells(graph, values, start)) values[c] = target
      this.mutate((d) => {
        d.land!.biome = encodeBytes(values)
      })
      return
    }
    // Brush.
    if (phase === 'down' && e.altKey) {
      const b = this.map.land.biomeAt(grid, x, y)
      if (b !== null) {
        this.landBiome = b
        this.renderSide(true)
      }
      this.landStroke = null
      return
    }
    if (phase === 'down') {
      this.landStroke = new Uint8Array(biomesOf(grid, graph))
      this.editGroup = `land-${Date.now()}`
      this.landBlocked = 0
      this.landPainted = 0
    }
    const stroke = this.landStroke
    if (!stroke) return
    if (phase !== 'end') {
      let changed = false
      for (const c of cellsWithin(graph, x, y, this.map.brushPx * this.map.unitsPerPx())) {
        if (stroke[c] === target) continue
        if (!allowed(stroke[c])) {
          this.landBlocked++
          continue
        }
        stroke[c] = target
        this.landPainted++
        changed = true
      }
      if (changed && !this.landFrame) {
        this.landFrame = requestAnimationFrame(() => {
          this.landFrame = 0
          if (this.landStroke) this.commitStroke(false)
        })
      }
      return
    }
    if (this.landFrame) cancelAnimationFrame(this.landFrame)
    this.landFrame = 0
    this.commitStroke(true)
    this.landStroke = null
    this.editGroup = null
    if (this.landBlocked && !this.landPainted)
      this.warn(isWater(target) ? 'Keep coastline is on, so water only paints over water. Untick it to flood land.' : 'Keep coastline is on, so land only paints over land. Untick it to draw new land on the sea.')
  }

  private commitStroke(final: boolean): void {
    const stroke = this.landStroke
    if (!stroke || !this.profile?.land) return
    const encoded = encodeBytes(stroke)
    if (encoded === this.profile.land.biome) {
      if (final) this.renderSide()
      return
    }
    this.mutate((d) => {
      d.land!.biome = encoded
    }, final)
  }

  private renderLayersTab(body: HTMLElement): void {
    const p = this.profile!
    const fs = p.features ?? []
    const vec = this.map.vec
    const active = vec.drawLayer

    const setLayer = (layer: FeatureLayer, patch: Partial<LayerSettings>, group?: string) =>
      this.mutate((d) => {
        d.layerSettings = { ...(d.layerSettings ?? {}), [layer]: { ...layerSettings(d.layerSettings, layer), ...patch } }
      }, !group, group ?? null)

    const rows = LAYER_ORDER.slice()
      .reverse()
      .map((layer) => {
        const st = layerSettings(p.layerSettings, layer)
        const count = fs.filter((f) => f.layer === layer).length
        const opacity = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(st.opacity), class: 'mt-layer-opacity', title: 'Opacity' })
        opacity.addEventListener('input', () => setLayer(layer, { opacity: Number(opacity.value) }, `opacity-${layer}`))
        return h(
          'div',
          { class: `mt-layer${layer === active ? ' mt-on' : ''}`, onclick: (e: Event) => !(e.target as HTMLElement).closest('button, input') && this.setDrawLayer(layer) },
          h('button', { class: `mt-btn mt-icon-btn${st.visible ? '' : ' mt-off'}`, title: st.visible ? 'Hide layer' : 'Show layer', onclick: () => setLayer(layer, { visible: !st.visible }) }, icon(st.visible ? 'eye' : 'eyeOff')),
          h('button', { class: `mt-btn mt-icon-btn${st.locked ? ' mt-on' : ''}`, title: st.locked ? 'Unlock layer' : 'Lock layer', onclick: () => setLayer(layer, { locked: !st.locked }) }, icon(st.locked ? 'lock' : 'unlock')),
          h('span', { class: 'mt-layer-name' }, LAYER_LABEL[layer]),
          h('span', { class: 'mt-dim' }, String(count)),
          opacity,
        )
      })
    body.append(h('h4', null, 'Layers'), h('div', { class: 'mt-layers-list' }, ...rows))

    // Drawing: pick a type, then the tool for its shape.
    const types = FEATURE_TYPES[active]
    const typeSel = h('select', { class: 'mt-select mt-grow', title: 'What to draw' })
    types.forEach((t, i) => typeSel.append(h('option', { value: String(i) }, `${t.label} (${t.geom})`)))
    const cur = types.findIndex((t) => t.type === vec.drawType && t.geom === this.drawGeom)
    typeSel.value = String(Math.max(0, cur))
    typeSel.addEventListener('change', () => {
      const t = types[Number(typeSel.value)]
      vec.drawType = t.type
      this.drawGeom = t.geom
      this.setTool(t.geom === 'area' ? 'varea' : t.geom === 'line' ? 'vline' : 'vspot')
    })
    const tool = this.map.tool
    const drawBtn = (t: Tool, ico: Parameters<typeof icon>[0], label: string, geom?: FeatureGeom) =>
      h(
        'button',
        {
          class: `mt-btn${tool === t ? ' mt-on mt-primary' : ''}`,
          disabled: !!geom && !types.some((x) => x.geom === geom),
          onclick: () => {
            if (geom && !types.some((x) => x.type === vec.drawType && x.geom === geom)) {
              const first = types.find((x) => x.geom === geom)!
              vec.drawType = first.type
            }
            if (geom) this.drawGeom = geom
            this.setTool(t)
          },
        },
        icon(ico),
        label,
      )
    body.append(
      h('h4', null, `Draw on ${LAYER_LABEL[active]}`),
      h('div', { class: 'mt-row' }, typeSel),
      h('div', { class: 'mt-row mt-wrap' }, drawBtn('vselect', 'select', 'Select'), drawBtn('varea', 'area', 'Area', 'area'), drawBtn('vline', 'line', 'Line', 'line'), drawBtn('vspot', 'spot', 'Spot', 'spot')),
      h(
        'div',
        { class: 'mt-dim' },
        tool === 'varea' || tool === 'vline'
          ? 'Click to add points, or drag to draw freehand. Enter or double-click finishes; Backspace removes the last point; Esc cancels. Hold Space to pan.'
          : tool === 'vselect'
            ? 'Click a shape to select it (Shift adds). Drag to move; handles scale (Shift keeps proportions, Alt from the centre). Drag a vertex to move it, double-click an edge to add one, Alt+click or Delete removes one.'
            : 'Pick what to draw, then Area, Line or Spot.',
      ),
    )

    // Selection.
    const selected = fs.filter((f) => vec.selection.has(f.id))
    if (selected.length === 1) body.append(this.featureEditor(selected[0]))
    else if (selected.length > 1) {
      body.append(
        h('h4', null, `${selected.length} shapes selected`),
        h('div', { class: 'mt-dim' }, 'Drag the handles on the map to move, scale or stretch them together.'),
        h('div', { class: 'mt-row' }, this.moveToLayerSelect(selected), h('button', { class: 'mt-btn mt-danger', onclick: () => vec.deleteSelected() }, 'Delete')),
      )
    }

    body.append(
      h('h4', null, 'Layer tools'),
      h(
        'div',
        { class: 'mt-row mt-wrap' },
        h(
          'button',
          {
            class: 'mt-btn',
            title: 'Select every shape on this layer, e.g. to move or stretch the whole landmass onto your coordinates',
            disabled: !fs.some((f) => f.layer === active),
            onclick: () => {
              this.setTool('vselect')
              const ids = fs.filter((f) => f.layer === active).map((f) => f.id)
              vec.setSelection(ids)
              this.renderSide(true)
            },
          },
          'Select whole layer',
        ),
        h('button', { class: 'mt-btn', onclick: () => void this.importLayers() }, 'Import shapes…'),
        h('button', { class: 'mt-btn', disabled: !fs.length, onclick: () => this.exportLayers() }, 'Export GeoJSON'),
      ),
      h('div', { class: 'mt-dim' }, 'Import accepts a map file, a GeoJSON FeatureCollection (properties: layer, type) or a list of shapes.'),
    )
  }

  private drawGeom: FeatureGeom = 'area'

  private setDrawLayer(layer: FeatureLayer): void {
    const vec = this.map.vec
    vec.drawLayer = layer
    const t = FEATURE_TYPES[layer].find((x) => x.geom === this.drawGeom) ?? FEATURE_TYPES[layer][0]
    vec.drawType = t.type
    this.drawGeom = t.geom
    if (this.map.tool === 'varea' || this.map.tool === 'vline' || this.map.tool === 'vspot') this.setTool(t.geom === 'area' ? 'varea' : t.geom === 'line' ? 'vline' : 'vspot')
    this.renderSide(true)
  }

  private moveToLayerSelect(selected: Feature[]): HTMLElement {
    const sel = h('select', { class: 'mt-select', title: 'Move to another layer' }, h('option', { value: '' }, 'Move to layer…'))
    for (const l of LAYER_ORDER) sel.append(h('option', { value: l }, LAYER_LABEL[l]))
    sel.addEventListener('change', () => {
      const layer = sel.value as FeatureLayer
      if (!layer) return
      const ids = new Set(selected.map((f) => f.id))
      this.mutate((d) => {
        d.features = (d.features ?? []).map((f) => {
          if (!ids.has(f.id)) return f
          const ok = FEATURE_TYPES[layer].find((t) => t.type === f.type && t.geom === f.geom) ?? FEATURE_TYPES[layer].find((t) => t.geom === f.geom)
          return { ...f, layer, type: ok?.type ?? f.type }
        })
      })
    })
    return sel
  }

  private featureEditor(f: Feature): HTMLElement {
    const types = FEATURE_TYPES[f.layer].filter((t) => t.geom === f.geom)
    const update = (patch: Partial<Feature>) =>
      this.mutate((d) => {
        d.features = (d.features ?? []).map((q) => (q.id === f.id ? { ...q, ...patch } : q))
      })
    const name = h('input', { class: 'mt-input', value: f.name ?? '', placeholder: 'Unnamed' })
    name.addEventListener('change', () => update({ name: name.value.trim() || undefined }))
    const typeSel = h('select', { class: 'mt-select' })
    for (const t of types) typeSel.append(h('option', { value: t.type }, t.label))
    if (!types.some((t) => t.type === f.type)) typeSel.append(h('option', { value: f.type }, f.type))
    typeSel.value = f.type
    typeSel.addEventListener('change', () => update({ type: typeSel.value }))
    const fields: HTMLElement[] = [h('label', null, 'Name'), name, h('label', null, 'Type'), typeSel]
    if (f.layer === 'topography') {
      const el = h('input', { class: 'mt-input', type: 'number', step: 'any', value: f.elevation === undefined ? '' : String(f.elevation), placeholder: 'height' })
      el.addEventListener('change', () => update({ elevation: numOrNull(el.value) ?? undefined }))
      fields.push(h('label', null, 'Elevation'), el)
    }
    const ranged = f.geom === 'line' && (f.type === 'mountains' || f.type === 'hills')
    if (f.geom === 'spot' || hasSymbols(f) || ranged) {
      const el = h('input', { class: 'mt-input', type: 'number', step: '0.1', min: '0.3', max: '6', value: String(f.size ?? 1) })
      el.addEventListener('change', () => update({ size: Math.max(0.3, Math.min(6, numOrNull(el.value) ?? 1)) }))
      fields.push(h('label', null, f.geom === 'spot' ? 'Size' : 'Symbol size'), el)
    }
    if (hasSymbols(f)) {
      const sel = h('select', { class: 'mt-select' })
      const cur = f.density ?? 1
      for (const [v, label] of DENSITY_PRESETS) sel.append(h('option', { value: String(v), selected: Math.abs(v - cur) < 1e-6 }, label))
      if (!DENSITY_PRESETS.some(([v]) => Math.abs(v - cur) < 1e-6)) sel.append(h('option', { value: String(cur), selected: true }, `Custom (${cur})`))
      sel.addEventListener('change', () => update({ density: Number(sel.value) === 1 ? undefined : Number(sel.value) }))
      fields.push(h('label', null, 'Density'), sel)
    }
    const color = h('input', { class: 'mt-color', type: 'color', value: f.color || '#7aa2ff' })
    color.addEventListener('change', () => update({ color: color.value }))
    const verts = f.rings.reduce((n, r) => n + r.length, 0)
    const vec = this.map.vec
    return h(
      'div',
      { class: 'mt-editor' },
      h('div', { class: 'mt-form' }, ...fields),
      h(
        'div',
        { class: 'mt-row mt-wrap' },
        f.geom !== 'spot'
          ? h('label', { class: 'mt-check' }, h('input', { type: 'checkbox', checked: !!f.smooth, onchange: (e: Event) => update({ smooth: (e.target as HTMLInputElement).checked || undefined }) }), 'Smooth')
          : '',
        h('label', { class: 'mt-check' }, color, 'Color'),
        f.color ? h('button', { class: 'mt-btn mt-ghost', onclick: () => update({ color: undefined }) }, 'Auto') : '',
      ),
      h('div', { class: 'mt-dim' }, f.geom === 'spot' ? formatCoord(f.rings[0][0][0], f.rings[0][0][1], 1) : `${verts} points${f.rings.length > 1 ? ` · ${f.rings.length - 1} hole${f.rings.length > 2 ? 's' : ''}` : ''}`),
      h(
        'div',
        { class: 'mt-row mt-wrap' },
        f.geom === 'area'
          ? h(
              'button',
              {
                class: 'mt-btn',
                title: 'Draw an area inside this shape to cut it out (a lake, an inland sea)',
                onclick: () => {
                  vec.holeFor = f.id
                  this.setTool('varea')
                  this.warn('Draw the hole inside the shape; Enter finishes.')
                },
              },
              icon('hole'),
              'Cut a hole',
            )
          : '',
        this.moveToLayerSelect([f]),
        h('button', { class: 'mt-btn mt-danger', onclick: () => vec.deleteSelected() }, 'Delete'),
      ),
    )
  }

  private onFeaturesEdit(next: Feature[], phase: 'move' | 'end'): void {
    if (!this.profile) return
    this.editGroup ??= `shapes-${Date.now()}`
    this.mutate((p) => (p.features = next), phase === 'end')
    if (phase === 'end') this.editGroup = null
  }

  private onFeatureSelection(_ids: string[]): void {
    if (this.tab === 'layers') this.renderSide(true)
  }

  private async importLayers(): Promise<void> {
    const files = await this.ctx.uploads.pickFile({ accept: ['.json', '.geojson', 'application/json', 'application/geo+json'], maxSizeBytes: 20 * 1024 * 1024 }).catch(() => [])
    const file = files[0]
    if (!file || !this.profile) return
    let shapes: Feature[] | null = null
    try {
      shapes = featuresFromJson(JSON.parse(new TextDecoder().decode(file.bytes)))
    } catch (err) {
      return this.warn(`Could not read that file: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!shapes?.length) return this.warn('No shapes found in that file.')
    const used = new Set((this.profile.features ?? []).map((f) => f.id))
    const incoming = shapes.map((f) => (used.has(f.id) ? { ...f, id: newFeatureId(f.layer) } : f))
    this.mutate((d) => (d.features = [...(d.features ?? []), ...incoming]))
    this.warn(`Imported ${incoming.length} shapes.`)
  }

  private exportLayers(): void {
    const p = this.profile
    if (!p?.features?.length) return
    const blob = new Blob([JSON.stringify(featuresToGeoJson(p.features), null, 1)], { type: 'application/geo+json' })
    const a = h('a', { href: URL.createObjectURL(blob), download: `${slug(p.name)}.layers.geojson` })
    document.body.append(a)
    a.click()
    setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000)
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

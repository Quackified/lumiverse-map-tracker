import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { bearing, boundsOf, calibMaps, calibrationForBounds, compass, distanceUnits, formatCoord, formatKm, imageToWorld, locate, normalizeCalib, rectCalibration } from '../shared/geo'
import { FEATURE_TYPES, LAYER_LABEL, LAYER_ORDER, featuresFromJson, featuresToGeoJson, layerSettings, newFeatureId, pointInRings, simplify } from '../shared/features'
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
import { isVectorTool } from './vector'
import { DENSITY_PRESETS, hasSymbols } from './terrain'
import { BIOMES, DETAIL, MAX_CELLS, resampleGrid, cellsInRings, regionRings, EMPTY, DEFAULT_CELLS, LAKE, OCEAN, DEFAULT_LAND, biomeColor, biomeName, biomesOf, cellsWithin, encodeBytes, findCell, floodCells, graphFor, isWater, newGrid } from '../shared/cells'
import { colorAt, detectLandmass, makeSampler, seedFromImage, wandMask, voteCells, type Sampler } from './landmap'
import { isLandTool, type LandTool } from './viewport'
import { worldToImage } from '../shared/geo'

type IconName = Parameters<typeof icon>[0]

/** What the Properties panel shows: the content behind a layer, or the layer a tool works on. */
type Panel = 'points' | 'zones' | 'land' | 'layers' | 'image'
/** Occasional tasks, opened from the top bar over the map. */
type Dialog = 'chat' | 'import' | 'map' | 'canvas'

const PANEL_TITLE: Record<Panel, string> = { points: 'Places', zones: 'Zones & regions', land: 'Terrain', layers: 'Features', image: 'Picture' }
const DIALOG_TITLE: Record<Dialog, string> = { chat: 'Story', import: 'Import', map: 'Map settings', canvas: 'Canvas size' }

/** The tool rail, in groups, with single-key shortcuts. */
const RAIL: { tool: Tool; icon: IconName; label: string; key: string }[][] = [
  [
    { tool: 'pan', icon: 'hand', label: 'Hand', key: 'h' },
    { tool: 'measure', icon: 'ruler', label: 'Measure', key: 'm' },
  ],
  [
    { tool: 'me', icon: 'me', label: 'My position', key: 'p' },
    { tool: 'dest', icon: 'flag', label: 'Destination', key: 'd' },
  ],
  [
    { tool: 'add', icon: 'pin', label: 'Add place', key: 'a' },
    { tool: 'pmove', icon: 'movepin', label: 'Move places', key: 'o' },
    { tool: 'zone', icon: 'zone', label: 'Draw zone', key: 'z' },
  ],
  [
    { tool: 'vselect', icon: 'select', label: 'Select features', key: 'v' },
    { tool: 'varea', icon: 'area', label: 'Draw area', key: 'r' },
    { tool: 'vline', icon: 'line', label: 'Draw line', key: 'l' },
    { tool: 'vspot', icon: 'spot', label: 'Place spot', key: 's' },
  ],
  [
    { tool: 'lbrush', icon: 'brush', label: 'Biome brush', key: 'b' },
    { tool: 'lfill', icon: 'bucket', label: 'Biome fill', key: 'g' },
    { tool: 'llasso', icon: 'lasso', label: 'Biome lasso', key: 'j' },
    { tool: 'lwand', icon: 'wand', label: 'Magic wand (from the picture)', key: 'w' },
    { tool: 'lpick', icon: 'dropper', label: 'Biome eyedropper', key: 'i' },
  ],
]

/** Marks coastline outlines saved from the terrain, so saving again replaces them (unlabelled on the map). */
const DETECTED_COAST = 'Detected coastline (from Terrain)'

/** Terrain shape types and the biome each paints as. */
const SHAPE_BIOME: Record<string, number> = {
  forest: 6,
  pine: 9,
  jungle: 7,
  grassland: 4,
  desert: 1,
  snow: 11,
  swamp: 12,
  volcanic: 16,
  hills: 15,
}

/** The panel each tool works on. */
const TOOL_PANEL: Partial<Record<Tool, Panel>> = {
  add: 'points',
  pmove: 'points',
  zone: 'zones',
  vselect: 'layers',
  varea: 'layers',
  vline: 'layers',
  vspot: 'layers',
  lbrush: 'land',
  lfill: 'land',
  llasso: 'land',
  lpick: 'land',
  lsample: 'land',
  lwand: 'land',
  lcoast: 'land',
  crop: 'image',
  imgxf: 'image',
}

const TOOL_HINT: Partial<Record<Tool, string>> = {
  pan: 'Drag to pan, wheel to zoom. Right-click the map for more.',
  me: 'Click the map to set your position (snaps to points).',
  dest: 'Click the map to set the destination (snaps to points).',
  add: 'Click the map to add a point.',
  measure: 'Click two spots to measure. Esc to clear.',
  crop: 'Drag the corners or edges to crop; drag inside to move the box. Esc when done.',
  zone: 'Drag a rectangle to create a zone.',
  imgxf: 'Drag inside the picture to move it; corners scale (Shift keeps proportions), edges stretch. Esc when done.',
  vselect: 'Click a feature (Shift adds); drag to move; handles scale. Drag a vertex, double-click an edge to add one, Delete removes. Space+drag pans.',
  varea: 'Click to add points or drag freehand; Enter or double-click finishes; Backspace undoes a point; Esc cancels.',
  vline: 'Click to add points or drag freehand; Enter or double-click finishes; Backspace undoes a point; Esc cancels.',
  vspot: 'Click to place.',
  lbrush: 'Drag to paint the selected biome. Alt+click picks the biome under the cursor. Space+drag pans; Esc stops painting.',
  lfill: 'Click inside a shape to fill the shape, or anywhere else to fill the connected area. Shift+click always fills the connected area.',
  llasso: 'Drag around an area: everything inside becomes the selected biome.',
  lpick: 'Click the terrain to pick its biome, then carry on painting.',
  lwand: 'Click a patch of the picture: every connected spot of a similar colour becomes the selected biome. Alt+click erases it back to unpainted.',
  lcoast: 'Click the sea on the picture: water connected to it becomes ocean, enclosed water becomes lakes, everything else land.',
  lsample: 'Seeding: click the picture where it shows the selected biome to add a colour sample, then Generate.',
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
  panel: Panel
  side: boolean
  layers: Layers
  layersOpen: boolean
}

function loadUi(): Partial<UiPrefs> {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) || '{}') as Partial<UiPrefs>
  } catch {
    return {}
  }
}

function fmtBounds(b: Bounds): string {
  const r = (n: number) => String(Math.round(n * 100) / 100)
  return `X ${r(b.minX)} … ${r(b.maxX)}, Y ${r(b.minY)} … ${r(b.maxY)}`
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
  private panel: Panel
  private dialog: Dialog | null = null
  private layersOpen: boolean
  private sideOpen: boolean
  private side: HTMLDivElement
  private sideBody: HTMLDivElement
  private rail: HTMLDivElement
  private optbar: HTMLDivElement
  private layersBox: HTMLDivElement
  private propsTitle: HTMLDivElement
  private dialogEl: HTMLDivElement
  private dialogTitle: HTMLSpanElement
  private dialogBody: HTMLDivElement
  private status: HTMLDivElement
  private toolbar: HTMLDivElement
  private profileSelect: HTMLSelectElement
  private toolButtons = new Map<Tool, HTMLButtonElement>()
  private hint: HTMLDivElement
  private menu: HTMLDivElement
  private sideDirty = false
  private editingPoi: string | null = null
  private editingZone: string | null = null
  private history = new History()
  private undoBtn!: HTMLButtonElement
  private gridBtn!: HTMLButtonElement
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
  /** The paint tool to go back to after the eyedropper. */
  private lastPaintTool: LandTool = 'lbrush'
  /** Fill inside the shape under the click, when there is one. */
  private landFillShapes = true
  /** Magic wand and landmass detection: colour tolerance, and what land becomes. */
  private wandTol = 45
  private coastTol = 60
  private coastLand = DEFAULT_LAND
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
    this.panel = prefs.panel ?? 'points'
    this.layersOpen = prefs.layersOpen ?? true
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
        onLandPolygon: (pts) => this.onLandPolygon(pts),
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
    this.map.el.append(this.hint, this.menu)

    this.profileSelect = h('select', { class: 'mt-select mt-profile', title: 'Map', onchange: () => this.onProfileChange() })
    this.toolbar = this.buildToolbar()
    this.optbar = h('div', { class: 'mt-optbar' })
    this.rail = this.buildRail()

    // Dock: Layers on top, Properties (what's behind the chosen layer or tool) below.
    this.layersBox = h('div', { class: 'mt-lrows' })
    this.propsTitle = h('div', { class: 'mt-panel-title' })
    this.sideBody = h('div', { class: 'mt-side-body' })
    this.side = h(
      'div',
      { class: 'mt-side' },
      h(
        'div',
        { class: 'mt-panel mt-panel-layers' },
        h(
          'button',
          {
            class: 'mt-panel-head mt-panel-toggle',
            title: 'Show or hide the layer list',
            onclick: () => {
              this.layersOpen = !this.layersOpen
              this.savePrefs()
              this.renderLayersPanel()
            },
          },
          icon('chevron'),
          h('span', { class: 'mt-panel-title' }, 'Layers'),
        ),
        this.layersBox,
      ),
      h('div', { class: 'mt-panel mt-panel-props' }, h('div', { class: 'mt-panel-head' }, this.propsTitle), this.sideBody),
    )
    this.dialogTitle = h('span', { class: 'mt-panel-title' })
    this.dialogBody = h('div', { class: 'mt-side-body' })
    this.dialogEl = h(
      'div',
      { class: 'mt-dialog' },
      h('div', { class: 'mt-panel-head' }, this.dialogTitle, h('span', { class: 'mt-spacer' }), h('button', { class: 'mt-btn mt-icon-btn', title: 'Close (Esc)', onclick: () => this.closeDialog() }, icon('close'))),
      this.dialogBody,
    )
    this.dialogEl.hidden = true
    for (const host of [this.side, this.dialogEl])
      host.addEventListener('focusout', () => {
        setTimeout(() => {
          if (this.sideDirty && !this.editingField()) this.renderSide()
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
      this.dialogEl,
    )
    this.el = h('div', { class: 'mt-app', tabindex: '-1' }, this.toolbar, this.optbar, h('div', { class: 'mt-main' }, this.rail, grid), this.status)
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
    // Lumiverse drags a floating widget from any press it doesn't see handled, and then
    // takes the pointer from the map (strokes stop after one dab). Mark presses as ours.
    this.el.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, option, [contenteditable]')) return
      e.preventDefault()
      // A handled press doesn't move focus; keep it in the window for Esc and tool keys.
      if (!this.el.contains(document.activeElement)) this.el.focus({ preventScroll: true })
    })
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
    const t = e.target as HTMLElement
    // Text fields keep their own keys and undo.
    if (t.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]), select')) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (!mod) {
      if (e.altKey || e.repeat) return
      if (k === 'escape' && this.dialog) {
        this.closeDialog()
        return
      }
      const hit = !e.shiftKey && RAIL.flat().find((r) => r.key === k)
      if (!hit) return
      this.pickTool(hit.tool)
      e.preventDefault()
      e.stopPropagation()
      return
    }
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
  }

  private savePrefs(): void {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ panel: this.panel, side: this.sideOpen, layers: this.map.layers, layersOpen: this.layersOpen }))
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
            if (this.panel === 'land') this.renderSide(true)
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
        if (this.dialog === 'import') this.renderSide(true)
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
    const menuBtn = (d: Dialog, ico: IconName, label: string, title: string) =>
      h('button', { class: 'mt-btn mt-menu-btn', title, dataset: { dialog: d }, onclick: () => (this.dialog === d ? this.closeDialog() : this.openDialog(d)) }, icon(ico), h('span', { class: 'mt-btn-label' }, label))
    return h(
      'div',
      { class: 'mt-toolbar' },
      this.profileSelect,
      h(
        'div',
        { class: 'mt-seg mt-menus' },
        menuBtn('chat', 'chat', 'Story', 'Position, destination and what the model is told'),
        menuBtn('import', 'import', 'Import', 'Coordinate notes, lorebooks, map files and lorebook conversion'),
        menuBtn('canvas', 'canvas', 'Canvas', 'Canvas size: how far the world extends'),
        menuBtn('map', 'gear', 'Map', 'Name, scale, new or delete map'),
      ),
      h('div', { class: 'mt-seg' }, this.undoBtn, this.redoBtn),
      h('div', { class: 'mt-spacer' }),
      h(
        'div',
        { class: 'mt-seg' },
        h('button', { class: 'mt-btn', title: 'Zoom out (-)', onclick: () => this.map.zoomBy(0.8) }, icon('minus')),
        h('button', { class: 'mt-btn', title: 'Fit (0)', onclick: () => this.map.fit() }, icon('fit')),
        h('button', { class: 'mt-btn', title: 'Zoom in (+)', onclick: () => this.map.zoomBy(1.25) }, icon('plus')),
      ),
      (this.gridBtn = h(
        'button',
        {
          class: `mt-btn${this.map.layers.grid ? ' mt-on' : ''}`,
          title: 'Coordinate grid',
          onclick: () => {
            this.map.layers = { ...this.map.layers, grid: !this.map.layers.grid }
            this.gridBtn.classList.toggle('mt-on', this.map.layers.grid)
            this.map.invalidate()
            this.savePrefs()
          },
        },
        icon('grid'),
      )),
      h('button', { class: 'mt-btn', title: 'Center on me', onclick: () => this.centerOnMe() }, icon('me')),
      h('button', { class: 'mt-btn mt-side-btn', title: 'Show or hide the Layers and Properties panels', onclick: () => this.toggleSide() }, icon('side')),
    )
  }

  private buildRail(): HTMLDivElement {
    const rail = h('div', { class: 'mt-rail' })
    RAIL.forEach((group, i) => {
      if (i) rail.append(h('div', { class: 'mt-rail-sep' }))
      for (const r of group) {
        const b = h('button', { class: 'mt-btn mt-rail-btn', title: `${r.label} (${r.key.toUpperCase()})`, onclick: () => this.pickTool(r.tool) }, icon(r.icon))
        this.toolButtons.set(r.tool, b)
        rail.append(b)
      }
    })
    return rail
  }

  /** A tool chosen on the rail or by its key. Land tools need a grid, the sampler a picture. */
  private pickTool(t: Tool): void {
    if (t !== 'pan' && t !== 'measure' && !this.profile) return this.warn('Pick or create a map first.')
    if ((t === 'lsample' || t === 'lwand' || t === 'lcoast') && !this.profile?.image) return this.warn('Upload a map picture first (Picture layer).')
    if (isLandTool(t)) this.ensureLand()
    this.setTool(t)
  }

  /** Every map can be painted: the terrain grid is made on first use, all unpainted. */
  private ensureLand(): void {
    if (this.profile && !this.profile.land) this.mutate((d) => (d.land ??= newGrid({ ...d.bounds }, DEFAULT_CELLS)), false, null)
  }

  private setTool(t: Tool): void {
    if (t === 'lbrush' || t === 'lfill' || t === 'llasso' || t === 'lwand') this.lastPaintTool = t
    this.map.setTool(t)
    for (const [tool, b] of this.toolButtons) b.classList.toggle('mt-on', tool === t)
    this.hint.hidden = true
    const panel = TOOL_PANEL[t]
    if (panel && this.profile) {
      this.panel = panel
      if (!this.isSideShown()) this.toggleSide()
    }
    const geom: FeatureGeom | null = t === 'varea' ? 'area' : t === 'vline' ? 'line' : t === 'vspot' ? 'spot' : null
    if (geom) {
      // Draw on a layer that has this kind of shape, with a type of that shape.
      const vec = this.map.vec
      if (!FEATURE_TYPES[vec.drawLayer].some((x) => x.geom === geom)) vec.drawLayer = LAYER_ORDER.find((l) => FEATURE_TYPES[l].some((x) => x.geom === geom)) ?? vec.drawLayer
      const types = FEATURE_TYPES[vec.drawLayer]
      if (!types.some((x) => x.type === vec.drawType && x.geom === geom)) vec.drawType = (types.find((x) => x.geom === geom) ?? types[0]).type
      this.drawGeom = geom
    }
    if (t !== 'varea') this.map.vec.holeFor = null
    this.renderOptions()
    this.renderSide()
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

  private openPanel(panel: Panel): void {
    this.panel = panel
    if (!this.isSideShown()) this.toggleSide()
    this.savePrefs()
    this.renderSide(true)
  }

  private openDialog(d: Dialog): void {
    if (d === 'canvas') {
      this.canvasDraft = null
      this.canvasCells = null
    }
    this.dialog = d
    this.renderSide(true)
  }

  private closeDialog(): void {
    this.dialog = null
    this.renderSide(true)
    this.map.el.focus({ preventScroll: true })
  }

  /** A text field in the dock or dialog has focus: re-rendering would eat the typing. */
  private editingField(): boolean {
    const a = document.activeElement as HTMLElement | null
    return !!a && (this.side.contains(a) || this.dialogEl.contains(a)) && a.matches('input, textarea, select')
  }

  private centerOnMe(): void {
    const me = this.state?.chat?.pos
    if (me) this.map.centerOn(me.x, me.y, this.map.focusScale())
  }

  private onProfileChange(): void {
    const v = this.profileSelect.value
    if (v === '__new') {
      this.send({ type: 'createProfile', name: 'New map' })
      this.dialog = 'import'
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
      this.openPanel('points')
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
      this.openPanel('zones')
    }
  }

  private onSelectPoi(poi: Poi | null): void {
    if (!poi) return
    this.editingPoi = poi.id
    if (this.panel === 'points') this.renderSide(true)
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
            this.openPanel('points')
          })
        : item('Add point here', () => this.onPick('add', x, y), !this.profile),
      item('Copy coordinates', () => void navigator.clipboard?.writeText(formatCoord(tx, ty, poi ? 0 : 1))),
      ...(poi ? [item('Copy lorebook reference', () => this.copyRef(poi))] : []),
      ...(poi?.origin ? [item(`Back to lorebook position ${placeText(poi.origin.x, poi.origin.y)}`, () => this.revertPoi([poi.id]))] : []),
    )
    const r = this.map.el.getBoundingClientRect()
    const k = r.width > 0 && this.map.el.clientWidth > 0 ? this.map.el.clientWidth / r.width : 1
    this.menu.hidden = false
    const mw = this.menu.offsetWidth
    const mh = this.menu.offsetHeight
    this.menu.style.left = `${Math.min((clientX - r.left) * k, this.map.el.clientWidth - mw - 4)}px`
    this.menu.style.top = `${Math.min((clientY - r.top) * k, this.map.el.clientHeight - mh - 4)}px`
  }

  private warn(message: string): void {
    this.hint.hidden = false
    this.hint.textContent = message
    setTimeout(() => {
      if (this.hint.textContent === message) this.hint.hidden = true
    }, 2500)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private render(): void {
    this.renderToolbar()
    this.renderOptions()
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
      h('button', { class: `mt-chip mt-chip-${mode}`, title: 'How the position reaches the model', onclick: () => this.openDialog('chat') }, label),
    )
  }

  private renderSide(force = false): void {
    if (!force && this.editingField()) {
      this.sideDirty = true
      return
    }
    this.sideDirty = false
    const a = document.activeElement
    const hadFocus = !!a && (this.side.contains(a) || this.dialogEl.contains(a))
    this.renderLayersPanel()
    this.renderProps()
    this.renderDialog()
    // The focused button was rebuilt: keep focus in the window so Esc and tool keys still work.
    if (hadFocus && !this.el.contains(document.activeElement)) this.el.focus({ preventScroll: true })
  }

  private renderProps(): void {
    this.propsTitle.textContent = this.panel === 'layers' ? `Features · ${LAYER_LABEL[this.map.vec.drawLayer]}` : PANEL_TITLE[this.panel]
    const body = this.sideBody
    const scroll = body.scrollTop
    clear(body)
    if (!this.profile) {
      body.append(this.emptyMapNotice())
      return
    }
    if (this.panel === 'points') this.renderPointsTab(body)
    else if (this.panel === 'zones') this.renderZonesTab(body)
    else if (this.panel === 'image') this.renderImageTab(body)
    else if (this.panel === 'layers') this.renderLayersTab(body)
    else this.renderLandTab(body)
    body.scrollTop = scroll
  }

  private renderDialog(): void {
    const d = this.dialog
    for (const b of this.toolbar.querySelectorAll<HTMLButtonElement>('[data-dialog]')) b.classList.toggle('mt-on', b.dataset.dialog === d)
    this.dialogEl.hidden = !d
    if (!d) return
    this.dialogTitle.textContent = DIALOG_TITLE[d]
    const body = this.dialogBody
    const scroll = body.scrollTop
    clear(body)
    if (d === 'chat') this.renderChatTab(body)
    else if (d === 'import') this.renderImportTab(body)
    else if (this.profile && d === 'canvas') this.renderCanvasTab(body)
    else if (this.profile) this.renderMapTab(body)
    else body.append(this.emptyMapNotice())
    body.scrollTop = scroll
  }

  /** Every drawn layer, top first: visibility, lock and opacity; a click opens what's behind it. */
  private renderLayersPanel(): void {
    const box = this.layersBox
    box.parentElement?.classList.toggle('mt-collapsed', !this.layersOpen)
    clear(box)
    const p = this.profile
    if (!p || !this.layersOpen) return
    const L = this.map.layers
    const stamp = Date.now()
    const flip = (k: keyof Layers) => {
      this.map.layers = { ...this.map.layers, [k]: !this.map.layers[k] }
      this.map.invalidate()
      this.savePrefs()
      this.renderLayersPanel()
    }
    const setVec = (layer: FeatureLayer, patch: Partial<LayerSettings>, group: string | null = null) => {
      this.mutate((d) => {
        d.layerSettings = { ...(d.layerSettings ?? {}), [layer]: { ...layerSettings(d.layerSettings, layer), ...patch } }
      }, false, group)
      if (!group) this.renderLayersPanel()
    }
    const range = (value: number, onInput: (v: number) => void) => {
      const r = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(value), class: 'mt-lrow-opacity', title: 'Opacity' })
      r.addEventListener('input', () => onInput(Number(r.value)))
      return r
    }
    const row = (o: { label: string; visible: boolean; onEye: () => void; on?: boolean; open?: () => void; count?: string | number; extra?: HTMLElement[]; indent?: boolean }) =>
      h(
        'div',
        {
          class: `mt-lrow${o.on ? ' mt-on' : ''}${o.indent ? ' mt-indent' : ''}${o.visible ? '' : ' mt-off'}${o.open ? ' mt-pick' : ''}`,
          title: o.open ? 'Click to edit in Properties' : undefined,
          onclick: (e: Event) => !(e.target as HTMLElement).closest('button, input') && o.open?.(),
        },
        h('button', { class: 'mt-btn mt-icon-btn', title: o.visible ? 'Hide' : 'Show', onclick: o.onEye }, icon(o.visible ? 'eye' : 'eyeOff')),
        h('span', { class: 'mt-lrow-name' }, o.label),
        o.count !== undefined ? h('span', { class: 'mt-dim mt-mono' }, String(o.count)) : '',
        ...(o.extra ?? []),
      )
    const fs = p.features ?? []
    const vecOn = this.panel === 'layers' ? this.map.vec.drawLayer : null
    box.append(
      row({
        label: 'Places',
        visible: L.points,
        onEye: () => flip('points'),
        on: this.panel === 'points',
        open: () => this.openPanel('points'),
        count: p.points.length,
        extra: [h('button', { class: `mt-btn mt-icon-btn${L.labels ? ' mt-on' : ''}`, title: L.labels ? 'Hide labels' : 'Show labels', onclick: () => flip('labels') }, icon('labels'))],
      }),
      row({ label: 'Trail', visible: L.trail, onEye: () => flip('trail') }),
      row({ label: 'Zones', visible: L.zones, onEye: () => flip('zones'), on: this.panel === 'zones', open: () => this.openPanel('zones'), count: p.zones.filter((z) => z.kind !== 'region').length }),
      row({ label: 'Regions', visible: L.regions, onEye: () => flip('regions'), on: this.panel === 'zones', open: () => this.openPanel('zones'), count: p.zones.filter((z) => z.kind === 'region').length }),
      h('button', { class: `mt-lgroup${this.panel === 'layers' ? ' mt-on' : ''}`, onclick: () => this.openPanel('layers') }, 'Features'),
      ...LAYER_ORDER.slice()
        .reverse()
        .map((layer) => {
          const st = layerSettings(p.layerSettings, layer)
          return row({
            label: LAYER_LABEL[layer],
            indent: true,
            visible: st.visible,
            onEye: () => setVec(layer, { visible: !st.visible }),
            on: vecOn === layer,
            open: () => this.selectVecLayer(layer),
            count: fs.filter((f) => f.layer === layer).length,
            extra: [
              h('button', { class: `mt-btn mt-icon-btn${st.locked ? ' mt-on' : ''}`, title: st.locked ? 'Unlock layer' : 'Lock layer', onclick: () => setVec(layer, { locked: !st.locked }) }, icon(st.locked ? 'lock' : 'unlock')),
              range(st.opacity, (v) => setVec(layer, { opacity: v }, `opacity-${layer}-${stamp}`)),
            ],
          })
        }),
      row({
        label: 'Terrain',
        visible: L.land,
        onEye: () => flip('land'),
        on: this.panel === 'land',
        open: () => this.openPanel('land'),
        extra: p.land
          ? [
              range(this.map.landOpacity, (v) => {
                this.map.landOpacity = v
                this.map.invalidate()
              }),
            ]
          : [],
      }),
      row({
        label: 'Picture',
        visible: L.image,
        onEye: () => flip('image'),
        on: this.panel === 'image',
        open: () => this.openPanel('image'),
        count: p.image ? undefined : 'none',
        extra: p.image ? [range(p.image.opacity, (v) => this.mutate((d) => d.image && (d.image.opacity = v), false, `opacity-image-${stamp}`))] : [],
      }),
    )
  }

  /** Choose a shapes layer to draw on and edit. */
  private selectVecLayer(layer: FeatureLayer): void {
    this.panel = 'layers'
    if (!this.isSideShown()) this.toggleSide()
    this.setDrawLayer(layer)
    this.renderOptions()
  }

  /** The options bar: what the active tool is and its settings. */
  private renderOptions(): void {
    const bar = this.optbar
    clear(bar)
    const t = this.map.tool
    const r = RAIL.flat().find((x) => x.tool === t)
    const name = r?.label ?? (t === 'crop' ? 'Crop picture' : t === 'imgxf' ? 'Transform picture' : t)
    bar.append(h('span', { class: 'mt-opt-tool' }, r ? icon(r.icon) : '', name))
    const p = this.profile
    if (p && isVectorTool(t)) bar.append(...this.shapeOptions(t))
    if (p?.land && isLandTool(t)) bar.append(...this.landOptions(t))
    const hint = TOOL_HINT[t]
    if (hint) bar.append(h('span', { class: 'mt-opt-hint', title: hint }, hint))
  }

  private shapeOptions(t: Tool): HTMLElement[] {
    const vec = this.map.vec
    const layerSel = h('select', { class: 'mt-select', title: 'Layer to draw on and select from' })
    for (const l of LAYER_ORDER) layerSel.append(h('option', { value: l, selected: l === vec.drawLayer }, LAYER_LABEL[l]))
    layerSel.addEventListener('change', () => this.selectVecLayer(layerSel.value as FeatureLayer))
    const out: HTMLElement[] = [h('label', { class: 'mt-opt' }, h('span', { class: 'mt-dim' }, 'Layer'), layerSel)]
    if (t !== 'vselect') {
      const types = FEATURE_TYPES[vec.drawLayer].filter((x) => x.geom === this.drawGeom)
      const typeSel = h('select', { class: 'mt-select', title: 'What to draw' })
      for (const x of types) typeSel.append(h('option', { value: x.type, selected: x.type === vec.drawType }, x.label))
      typeSel.addEventListener('change', () => (vec.drawType = typeSel.value))
      out.push(h('label', { class: 'mt-opt' }, h('span', { class: 'mt-dim' }, 'Type'), typeSel))
    }
    return out
  }

  private landOptions(t: Tool): HTMLElement[] {
    const grid = this.profile!.land!
    const swatch = h('span', { class: 'mt-swatch' })
    swatch.style.background = biomeColor(this.landBiome, grid)
    const sel = h('select', { class: 'mt-select', title: 'Biome to paint (Alt+click on the map picks one)' })
    for (const b of BIOMES) sel.append(h('option', { value: String(b.id), selected: b.id === this.landBiome }, biomeName(b.id, grid)))
    sel.append(h('option', { value: String(EMPTY), selected: this.landBiome === EMPTY }, 'Eraser (unpainted)'))
    sel.addEventListener('change', () => {
      this.landBiome = Number(sel.value)
      swatch.style.background = biomeColor(this.landBiome, grid)
      if (this.panel === 'land') this.renderSide(true)
    })
    const out: HTMLElement[] = [h('label', { class: 'mt-opt' }, swatch, sel)]
    if (t === 'lbrush') {
      const size = h('input', { type: 'range', min: '4', max: '120', value: String(this.map.brushPx), class: 'mt-opt-range', title: 'Brush size' })
      size.addEventListener('input', () => {
        this.map.brushPx = Number(size.value)
        this.map.invalidate()
      })
      out.push(h('label', { class: 'mt-opt' }, h('span', { class: 'mt-dim' }, 'Size'), size))
    }
    const tolerance = (value: number, set: (v: number) => void) => {
      const r = h('input', { type: 'range', min: '5', max: '200', value: String(value), class: 'mt-opt-range', title: 'How different a colour may be and still count' })
      const out = h('span', { class: 'mt-dim mt-mono' }, String(value))
      r.addEventListener('input', () => {
        set(Number(r.value))
        out.textContent = r.value
      })
      return h('label', { class: 'mt-opt' }, h('span', { class: 'mt-dim' }, 'Tolerance'), r, out)
    }
    if (t === 'lcoast') {
      const landSel = h('select', { class: 'mt-select', title: 'What the land becomes' })
      landSel.append(h('option', { value: String(EMPTY), selected: this.coastLand === EMPTY }, 'Unpainted'))
      for (const b of BIOMES) if (!isWater(b.id)) landSel.append(h('option', { value: String(b.id), selected: b.id === this.coastLand }, biomeName(b.id, grid)))
      landSel.addEventListener('change', () => (this.coastLand = Number(landSel.value)))
      return [h('label', { class: 'mt-opt' }, h('span', { class: 'mt-dim' }, 'Land as'), landSel), tolerance(this.coastTol, (v) => (this.coastTol = v))]
    }
    if (t === 'lwand') out.push(tolerance(this.wandTol, (v) => (this.wandTol = v)))
    if (t === 'lpick') return [h('span', { class: 'mt-dim' }, `Picking for the ${this.lastPaintTool === 'lfill' ? 'fill' : this.lastPaintTool === 'llasso' ? 'lasso' : 'brush'}`)]
    if (t === 'lfill') {
      const shapes = h('input', { type: 'checkbox', checked: this.landFillShapes })
      shapes.addEventListener('change', () => (this.landFillShapes = shapes.checked))
      out.push(h('label', { class: 'mt-opt mt-check', title: 'Clicking inside a land, lake or terrain shape fills exactly that shape' }, shapes, 'Fill inside shapes'))
    }
    if (t === 'lbrush' || t === 'lfill' || t === 'llasso') {
      const keep = h('input', { type: 'checkbox', checked: this.landKeepCoast })
      keep.addEventListener('change', () => (this.landKeepCoast = keep.checked))
      out.push(h('label', { class: 'mt-opt mt-check', title: 'Land biomes only paint over land, water only over water' }, keep, 'Keep coastline'))
    }
    if (t === 'lsample') {
      const n = grid.samples?.length ?? 0
      out.push(h('span', { class: 'mt-dim' }, `${n} sample${n === 1 ? '' : 's'}`), h('button', { class: 'mt-btn mt-primary', disabled: !n, onclick: () => this.seedLand() }, 'Generate'))
    }
    return out
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
        this.dialog = 'import'
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
    const graph = grid ? graphFor(grid) : null
    const counts = new Map<number, number>()
    if (grid && graph) {
      const biomes = biomesOf(grid, graph)
      for (let i = 0; i < biomes.length; i++) counts.set(biomes[i], (counts.get(biomes[i]) ?? 0) + 1)
    }
    if (grid) {
      const gb = grid.bounds
      const cb = p.bounds
      if (gb.minX !== cb.minX || gb.maxX !== cb.maxX || gb.minY !== cb.minY || gb.maxY !== cb.maxY) {
        // Grids made before Canvas size (or with a margin) don't match the canvas: offer to follow it.
        const same = Math.min(MAX_CELLS, Math.round((grid.cells * (cb.maxX - cb.minX) * (cb.maxY - cb.minY)) / ((gb.maxX - gb.minX) * (gb.maxY - gb.minY))))
        body.append(
          h(
            'div',
            { class: 'mt-editor' },
            h('div', null, 'The terrain doesn\u2019t cover the whole canvas, so painting stops at its edge.'),
            h(
              'div',
              { class: 'mt-row mt-wrap' },
              h('button', { class: 'mt-btn mt-primary', onclick: () => this.mutate((d) => d.land && (d.land = resampleGrid(d.land, { ...d.bounds }, same))) }, 'Fit terrain to canvas'),
              h('span', { class: 'mt-dim' }, 'painting kept'),
            ),
          ),
        )
      }
    }
    body.append(
      h(
        'div',
        { class: 'mt-dim' },
        'The ground of your world, painted in biomes. Pick one, then use the Brush (B), Fill (G) or Lasso (J); the Eyedropper (I) or Alt+click picks a biome from the map. Unpainted ground is see-through.',
      ),
    )
    const pick = (id: number) => {
      this.landBiome = id
      if (!isLandTool(this.map.tool) || this.map.tool === 'lpick' || this.map.tool === 'lsample' || this.map.tool === 'lcoast') this.pickTool(this.lastPaintTool)
      else {
        this.renderSide(true)
        this.renderOptions()
      }
    }

    // Palette: pick the biome to paint; the swatch changes its colour.
    const pal = h('div', { class: 'mt-list' })
    pal.append(
      h(
        'div',
        { class: `mt-item mt-biome${this.landBiome === EMPTY ? ' mt-on' : ''}` },
        h('span', { class: 'mt-swatch mt-swatch-empty', title: 'Unpainted' }),
        h('button', { class: 'mt-item-name', title: 'Paint cells back to unpainted', onclick: () => pick(EMPTY) }, 'Eraser (unpainted)'),
        h('span', { class: 'mt-dim mt-mono' }, graph && counts.get(EMPTY) ? `${Math.round(((counts.get(EMPTY) ?? 0) / graph.n) * 100)}%` : ''),
        h('span'),
      ),
    )
    for (const b of BIOMES) {
      const color = h('input', { class: 'mt-color', type: 'color', value: biomeColor(b.id, grid), title: 'Change colour' })
      color.addEventListener('change', () =>
        this.mutate((d) => {
          d.land ??= newGrid({ ...d.bounds }, DEFAULT_CELLS)
          d.land.colors = { ...d.land.colors, [b.id]: color.value }
        }),
      )
      const n = counts.get(b.id) ?? 0
      pal.append(
        h(
          'div',
          { class: `mt-item mt-biome${b.id === this.landBiome ? ' mt-on' : ''}` },
          color,
          h('button', { class: 'mt-item-name', onclick: () => pick(b.id) }, biomeName(b.id, grid)),
          h('span', { class: 'mt-dim mt-mono' }, graph && n ? `${Math.round((n / graph.n) * 100)}%` : ''),
          grid?.colors?.[b.id]
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
                '\u21ba',
              )
            : h('span'),
        ),
      )
    }
    body.append(h('h4', null, 'Biomes'), pal)

    // Old shapes painted as terrain.
    const convertible = (p.features ?? []).filter((f) => this.convertibleShape(f))
    if (convertible.length) {
      body.append(
        h('h4', null, 'From your shapes'),
        h('div', { class: 'mt-dim' }, `${convertible.length} land, lake and terrain area shape${convertible.length === 1 ? '' : 's'} can become terrain: land as grassland with sea around it, then forests, deserts and the rest on top. The shapes are hidden, not deleted.`),
        h('div', { class: 'mt-row' }, h('button', { class: 'mt-btn mt-primary', onclick: () => this.convertShapes() }, 'Paint shapes as terrain')),
      )
    }

    if (p.image) body.append(this.detectBox(grid))

    if (!grid || !graph) return

    // Display (opacity is on the Terrain layer row).
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
    const detail = h('select', { class: 'mt-select', title: 'How many cells: more means finer painting' })
    const opts = DETAIL.some(([n]) => n === grid.cells) ? DETAIL : ([[grid.cells, 'Current'], ...DETAIL] as [number, string][])
    for (const [n, label] of opts) detail.append(h('option', { value: String(n), selected: n === grid.cells }, `${label} (~${n.toLocaleString()} cells)`))
    detail.addEventListener('change', () => this.mutate((d) => d.land && (d.land = resampleGrid(d.land, { ...d.land.bounds }, Number(detail.value)))))
    body.append(
      h('h4', null, 'Display'),
      h('div', { class: 'mt-row mt-wrap' }, h('label', { class: 'mt-check' }, symbols, 'Terrain symbols'), h('label', { class: 'mt-check', title: 'Show the map picture above the terrain, at its own opacity' }, onTop, 'Picture on top')),
      h('div', { class: 'mt-form' }, h('label', null, 'Detail'), detail),
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
            title: 'Back to fully unpainted',
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
          this.confirmRemoveLand ? 'Confirm clear' : 'Clear terrain',
        ),
      ),
    )
  }

  /** Detect from the picture: landmass from one click, the magic wand, outline export. */
  private detectBox(grid: WorldProfile['land']): HTMLElement {
    let land = 0
    if (grid) {
      const biomes = biomesOf(grid, graphFor(grid))
      for (let i = 0; i < biomes.length; i++) if (biomes[i] !== EMPTY && !isWater(biomes[i])) land++
    }
    return h(
      'div',
      null,
      h('h4', null, 'Detect from the picture'),
      h(
        'div',
        { class: 'mt-row mt-wrap' },
        h('button', { class: `mt-btn${this.map.tool === 'lcoast' ? ' mt-on' : ''}`, title: 'Then click the sea on the picture', onclick: () => this.pickTool('lcoast') }, 'Find landmass'),
        h('button', { class: `mt-btn${this.map.tool === 'lwand' ? ' mt-on' : ''}`, onclick: () => this.pickTool('lwand') }, icon('wand'), 'Magic wand'),
        h('button', { class: 'mt-btn', disabled: !land, title: 'The coastline as an editable outline line in Features', onclick: () => this.saveCoastline() }, 'Save coastline as outline'),
      ),
      h('div', { class: 'mt-dim' }, 'Find landmass: click the sea once and the coastline is traced for you. Magic wand (W): click one patch (a forest, a desert) to paint just that. Crop the picture to the map first so its frame isn\u2019t read as land.'),
    )
  }

  /** The painted coastline as Outlines lines (replacing an earlier detected one). */
  private saveCoastline(): void {
    const grid = this.profile?.land
    if (!grid) return
    const graph = graphFor(grid)
    const biomes = biomesOf(grid, graph)
    const rings = regionRings(graph, (c) => (biomes[c] !== EMPTY && !isWater(biomes[c]) ? 1 : null)).get(1) ?? []
    const tol = Math.max(graph.dx, graph.dy) * 0.6
    const lines: Feature[] = []
    for (const r of rings) {
      const pts: [number, number][] = []
      for (let i = 0; i < r.length; i += 2) pts.push([Math.round(r[i] * 100) / 100, Math.round(r[i + 1] * 100) / 100])
      if (pts.length < 4) continue
      pts.push(pts[0])
      const simple = simplify(pts, tol)
      if (simple.length >= 4) lines.push({ id: newFeatureId('landmass'), layer: 'landmass', geom: 'line', type: 'coast', note: DETECTED_COAST, rings: [simple], smooth: true })
    }
    if (!lines.length) return this.warn('No coastline to save yet.')
    this.mutate((d) => {
      d.features = [...(d.features ?? []).filter((f) => !(f.layer === 'landmass' && f.note === DETECTED_COAST)), ...lines]
    })
    this.warn(`Saved ${lines.length} coastline outline${lines.length === 1 ? '' : 's'} in Features > Outlines.`)
  }

  /** A shape that "Paint shapes as terrain" understands. */
  private convertibleShape(f: Feature): boolean {
    if (f.geom !== 'area' || f.hidden) return false
    if (f.layer === 'landmass') return f.type === 'land' || f.type === 'lake'
    return f.layer === 'terrain' && f.type in SHAPE_BIOME
  }

  /** The shape (land, lake or terrain area) under a point, topmost first. */
  private shapeAt(x: number, y: number): Feature | null {
    const p = this.profile
    if (!p?.features) return null
    for (const layer of ['terrain', 'landmass'] as FeatureLayer[]) {
      if (!layerSettings(p.layerSettings, layer).visible) continue
      for (let i = p.features.length - 1; i >= 0; i--) {
        const f = p.features[i]
        if (f.layer === layer && f.geom === 'area' && !f.hidden && pointInRings(x, y, f.rings)) return f
      }
    }
    return null
  }

  /** Paint land, lake and terrain area shapes into the terrain, then hide them. */
  private convertShapes(): void {
    const p = this.profile
    if (!p) return
    const shapes = (p.features ?? []).filter((f) => this.convertibleShape(f))
    if (!shapes.length) return
    const ids = new Set(shapes.map((f) => f.id))
    this.mutate((d) => {
      d.land ??= newGrid({ ...d.bounds }, DEFAULT_CELLS)
      const g = graphFor(d.land)
      const v = new Uint8Array(biomesOf(d.land, g))
      const lands = shapes.filter((f) => f.layer === 'landmass' && f.type === 'land')
      if (lands.length) {
        const inLand = new Uint8Array(g.n)
        for (const f of lands) for (const c of cellsInRings(g, f.rings)) inLand[c] = 1
        for (let i = 0; i < g.n; i++) {
          if (!inLand[i]) v[i] = OCEAN
          else if (v[i] === EMPTY || isWater(v[i])) v[i] = DEFAULT_LAND
        }
      }
      for (const f of shapes) if (f.layer === 'landmass' && f.type === 'lake') for (const c of cellsInRings(g, f.rings)) v[c] = LAKE
      for (const f of shapes) if (f.layer === 'terrain') for (const c of cellsInRings(g, f.rings)) v[c] = SHAPE_BIOME[f.type]
      d.land.biome = encodeBytes(v)
      d.features = (d.features ?? []).map((f) => (ids.has(f.id) ? { ...f, hidden: true } : f))
    })
    this.warn(`Painted ${shapes.length} shapes as terrain. They're hidden in Features.`)
  }

  private landSeedBox(grid: NonNullable<WorldProfile['land']>): HTMLElement {
    const p = this.profile!
    const samples = grid.samples ?? []
    const box = h('details', { class: 'mt-group', open: !!p.image && samples.length < 2 }, h('summary', null, h('span', null, 'Colour samples (advanced)'), h('span', { class: 'mt-dim' }, samples.length ? ` · ${samples.length} samples` : '')))
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
    if (tool === 'lwand' || tool === 'lcoast') {
      if (phase !== 'down') return
      const meta = p.image
      const sampler = this.ensureSampler()
      if (!meta || !sampler) return this.warn('Upload a map picture first.')
      const at = worldToImage(meta.calib, x, y)
      if (tool === 'lcoast') {
        const next = detectLandmass(grid, meta, sampler, at.px, at.py, this.coastTol, this.coastLand)
        if (!next) return this.warn('Click on the picture, on the sea.')
        this.mutate((d) => {
          d.land!.biome = encodeBytes(next)
        })
        this.setTool(this.lastPaintTool)
        return this.warn('Landmass found. Paint it, or save the coastline as an outline in Terrain.')
      }
      const mask = wandMask(sampler, at.px, at.py, this.wandTol, meta.crop)
      if (!mask) return this.warn('Click on the picture.')
      const target = e.altKey ? EMPTY : this.landBiome
      const hit = voteCells(grid, meta, sampler, (i) => (mask[i] ? 1 : -1))
      const values = new Uint8Array(biomesOf(grid, graph))
      let changed = 0
      for (let c = 0; c < graph.n; c++)
        if (hit[c] === 1 && values[c] !== target) {
          values[c] = target
          changed++
        }
      if (!changed) return this.warn('Nothing changed: try a higher tolerance.')
      this.mutate((d) => {
        d.land!.biome = encodeBytes(values)
      })
      return
    }
    if (tool === 'lpick') {
      if (phase !== 'down') return
      const b = this.map.land.biomeAt(grid, x, y)
      if (b === null) return this.warn('Nothing painted there.')
      this.landBiome = b
      this.setTool(this.lastPaintTool)
      return
    }
    const target = this.landBiome
    const allowed = (current: number) => !this.landKeepCoast || current === EMPTY || target === EMPTY || isWater(current) === isWater(target)
    if (tool === 'lfill') {
      if (phase !== 'down') return
      const values = new Uint8Array(biomesOf(grid, graph))
      const shape = this.landFillShapes && !e.shiftKey ? this.shapeAt(x, y) : null
      let changed = 0
      if (shape) {
        for (const c of cellsInRings(graph, shape.rings))
          if (values[c] !== target && allowed(values[c])) {
            values[c] = target
            changed++
          }
      } else {
        const start = findCell(graph, x, y)
        if (values[start] === target) return
        for (const c of floodCells(graph, values, start)) {
          values[c] = target
          changed++
        }
      }
      if (!changed) return
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
        this.renderOptions()
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

  /** The lasso closed: paint the cells inside it. */
  private onLandPolygon(pts: [number, number][]): void {
    const grid = this.profile?.land
    if (!grid) return
    const graph = graphFor(grid)
    const values = new Uint8Array(biomesOf(grid, graph))
    const target = this.landBiome
    let changed = 0
    for (const c of cellsInRings(graph, [pts]))
      if (values[c] !== target && (!this.landKeepCoast || values[c] === EMPTY || target === EMPTY || isWater(values[c]) === isWater(target))) {
        values[c] = target
        changed++
      }
    if (!changed) return this.warn('Nothing inside the lasso changed.')
    this.mutate((d) => {
      d.land!.biome = encodeBytes(values)
    })
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

    body.append(
      h(
        'div',
        { class: 'mt-dim' },
        `Rivers, roads, mountain ranges, landmarks and outlines, drawn on ${LAYER_LABEL[active]}. Select (V), Area (R), Line (L) and Spot (S) are on the left; the options bar picks the layer and what to draw. The ground itself is painted in Terrain.`,
      ),
    )
    const hidden = fs.filter((f) => f.hidden)
    if (hidden.length)
      body.append(
        h(
          'div',
          { class: 'mt-row mt-wrap' },
          h('span', { class: 'mt-dim' }, `${hidden.length} shape${hidden.length === 1 ? ' is' : 's are'} hidden (painted as terrain).`),
          h('button', { class: 'mt-btn mt-ghost', onclick: () => this.mutate((d) => (d.features = (d.features ?? []).map((f) => (f.hidden ? { ...f, hidden: undefined } : f)))) }, 'Show them'),
        ),
      )
    if (fs.some((f) => this.convertibleShape(f)))
      body.append(h('div', { class: 'mt-row' }, h('button', { class: 'mt-btn', title: 'Land, lake and terrain areas become painted terrain; the shapes are hidden', onclick: () => this.convertShapes() }, 'Paint shapes as terrain')))

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
  /** Canvas size being edited (applied on Apply), with the edges linked or not. */
  private canvasDraft: Bounds | null = null
  private canvasLinked = true
  private canvasCells: number | null = null

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
    if (this.panel === 'layers') this.renderSide(true)
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

  /**
   * Canvas size, like an image editor's: width and height (always positive),
   * kept centred where the canvas is now. The edges' coordinates are worked out
   * here; the land grid follows on Apply, keeping its painting.
   */
  private renderCanvasTab(body: HTMLElement): void {
    const p = this.profile!
    const d = (this.canvasDraft ??= { ...p.bounds })
    const grid = p.land
    const cx = (d.minX + d.maxX) / 2
    const cy = (d.minY + d.maxY) / 2
    let w = d.maxX - d.minX
    let hh = d.maxY - d.minY
    const ratio = hh > 0 && w > 0 ? hh / w : 1
    const area = (b: Bounds) => Math.max(1e-9, (b.maxX - b.minX) * (b.maxY - b.minY))
    const span = h('div', { class: 'mt-dim' })
    const landInfo = h('div', { class: 'mt-dim' })
    const apply = h('button', { class: 'mt-btn mt-primary' }, 'Apply')
    const detail = h('select', { class: 'mt-select' })
    const wIn = h('input', { class: 'mt-input', type: 'number', min: '1', step: 'any', value: String(round2(w)) })
    const hIn = h('input', { class: 'mt-input', type: 'number', min: '1', step: 'any', value: String(round2(hh)) })

    const refresh = () => {
      d.minX = cx - w / 2
      d.maxX = cx + w / 2
      d.minY = cy - hh / 2
      d.maxY = cy + hh / 2
      if (document.activeElement !== wIn) wIn.value = String(round2(w))
      if (document.activeElement !== hIn) hIn.value = String(round2(hh))
      const ok = w > 0 && hh > 0
      apply.disabled = !ok
      span.textContent = ok ? `${formatKm(w * p.unitKm)} \u00d7 ${formatKm(hh * p.unitKm)}. Spans ${fmtBounds(d)}.` : 'Width and height must be above 0.'
      if (grid && ok) {
        // Same cell size as now, if that stays under the cap; otherwise the finest allowed.
        const same = Math.round((grid.cells * area(d)) / area(grid.bounds))
        const first = Math.min(same, MAX_CELLS)
        const opts: [number, string][] = [
          [first, same > MAX_CELLS ? `Finest allowed (${MAX_CELLS.toLocaleString()} cells)` : `Same cell size (~${same.toLocaleString()} cells)`],
          ...DETAIL.filter(([n]) => n !== first).map(([n, l]) => [n, `${l} (~${n.toLocaleString()} cells)`] as [number, string]),
        ]
        const pick = this.canvasCells ?? first
        clear(detail)
        for (const [n, l] of opts) detail.append(h('option', { value: String(n), selected: n === pick }, l))
        if (!opts.some(([n]) => n === pick)) detail.value = String(first)
        const cell = Math.sqrt(area(d) / Number(detail.value))
        const cut = d.minX > grid.bounds.minX || d.maxX < grid.bounds.maxX || d.minY > grid.bounds.minY || d.maxY < grid.bounds.maxY
        landInfo.textContent = `Cells about ${round2(cell)} units across. New area starts as ocean${cut ? '; land outside the new canvas is cut off' : ''}.`
      }
    }
    const read = (el: HTMLInputElement) => {
      const v = numOrNull(el.value)
      return v !== null && v > 0 ? Math.abs(v) : null
    }
    wIn.addEventListener('input', () => {
      const v = read(wIn)
      if (v === null) return
      w = v
      if (this.canvasLinked) hh = v * ratio
      refresh()
    })
    hIn.addEventListener('input', () => {
      const v = read(hIn)
      if (v === null) return
      hh = v
      if (this.canvasLinked) w = v / ratio
      refresh()
    })
    for (const el of [wIn, hIn]) el.addEventListener('change', () => refresh())
    detail.addEventListener('change', () => {
      this.canvasCells = Number(detail.value)
      refresh()
    })
    apply.addEventListener('click', () => {
      const bounds = { ...d }
      const cells = grid ? Number(detail.value) : 0
      this.mutate((q) => {
        q.bounds = bounds
        if (q.land) q.land = resampleGrid(q.land, bounds, cells)
      })
      this.canvasDraft = null
      this.dialog = null
      this.renderSide(true)
      this.map.fit()
      this.warn(`Canvas is now ${round2(bounds.maxX - bounds.minX)} \u00d7 ${round2(bounds.maxY - bounds.minY)}.`)
    })
    const link = h(
      'button',
      {
        class: `mt-btn mt-icon-btn mt-link-btn${this.canvasLinked ? ' mt-on' : ''}`,
        title: this.canvasLinked ? 'Proportions linked: changing one changes the other' : 'Width and height change separately',
        onclick: () => {
          this.canvasLinked = !this.canvasLinked
          this.renderSide(true)
        },
      },
      icon(this.canvasLinked ? 'link' : 'unlink'),
    )
    body.append(
      h('div', { class: 'mt-dim' }, 'How big the world is, in map units. It grows or shrinks around its centre. Places, zones and shapes stay where they are.'),
      h(
        'div',
        { class: 'mt-canvas-size' },
        h('label', null, 'Width'),
        wIn,
        link,
        h('label', null, 'Height'),
        hIn,
      ),
      span,
      h(
        'div',
        { class: 'mt-row mt-wrap' },
        h(
          'button',
          {
            class: 'mt-btn mt-ghost',
            title: 'Just big enough for every place, zone and shape',
            onclick: () => {
              Object.assign(d, boundsOf(p))
              this.renderSide(true)
            },
          },
          'Fit to content',
        ),
        h(
          'button',
          {
            class: 'mt-btn mt-ghost',
            onclick: () => {
              Object.assign(d, p.bounds)
              this.renderSide(true)
            },
          },
          'Reset',
        ),
      ),
    )
    if (grid)
      body.append(
        h('h4', null, 'Land grid'),
        h('div', { class: 'mt-dim' }, `Rebuilt over the new canvas with your painting kept. Now ${grid.cells.toLocaleString()} cells.`),
        h('div', { class: 'mt-form' }, h('label', null, 'Detail'), detail),
        landInfo,
      )
    body.append(h('div', { class: 'mt-row' }, apply, h('button', { class: 'mt-btn', onclick: () => this.closeDialog() }, 'Cancel')))
    refresh()
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
    const isDefault = s?.settings.defaultProfileId === p.id
    body.append(
      h('div', { class: 'mt-form' }, h('label', null, 'Name'), name, h('label', null, '1 unit ='), h('div', { class: 'mt-row' }, unit, h('span', null, 'km'))),
      h('h4', null, 'Canvas'),
      h('div', { class: 'mt-row mt-wrap' }, h('span', { class: 'mt-mono' }, fmtBounds(p.bounds)), h('button', { class: 'mt-btn', onclick: () => this.openDialog('canvas') }, icon('canvas'), 'Canvas size…')),
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

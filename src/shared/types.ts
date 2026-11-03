// Data model shared by the backend worker and the browser UI.
// World coordinates: +X = east, +Y = north. Distances are in "units"; a profile's
// unitKm converts units to kilometres.

export interface Poi {
  id: string
  name: string
  x: number
  y: number
  /** Slash-separated hierarchy inferred from the source, e.g. "Eastern Continent Locations / Golden Sail Republic". */
  group: string
  note?: string
  color?: string
  hidden?: boolean
}

/** One axis of a zone. `null` means open on that side (e.g. "Y>150" → { min: 150, max: null }). */
export interface Span {
  min: number | null
  max: number | null
}

export type ZoneKind = 'region' | 'zone'

export interface Zone {
  id: string
  name: string
  group: string
  /** `region` = continent/ocean-scale ranges; `zone` = terrain/special areas. */
  kind: ZoneKind
  x: Span
  y: Span
  note?: string
  color?: string
  /** Higher wins when several zones contain a point. Ties go to the smaller zone. */
  priority?: number
  /** Region id this zone is clipped to (e.g. "Y>150" only inside the Eastern Continent). */
  within?: string
  hidden?: boolean
}

export interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** Pins one spot on the image (px, py) to one world coordinate (x, y). */
export interface CalibPin {
  px: number
  py: number
  x: number
  y: number
}

/**
 * Two pins place the image. Pin `a` is usually the world origin (0,0), pin `b` a
 * known place. `uniform` keeps the image's aspect ratio (one scale from the pin
 * distance); otherwise X and Y scale independently from the pins' offsets.
 */
export interface Calibration {
  a: CalibPin
  b: CalibPin
  uniform: boolean
}

/** Pre-0.2 format: two anchors per axis. Still accepted when loading. */
export interface LegacyCalibration {
  x1: { px: number; w: number }
  x2: { px: number; w: number }
  y1: { px: number; w: number }
  y2: { px: number; w: number }
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface MapImageMeta {
  width: number
  height: number
  mime: string
  /** Visible part of the image, in image pixels. */
  crop: Rect
  calib: Calibration
  opacity: number
  visible: boolean
  /** Bumped whenever the image bytes change, so clients can cache by revision. */
  rev: number
}

export interface WorldProfile {
  id: string
  name: string
  unitKm: number
  bounds: Bounds
  points: Poi[]
  zones: Zone[]
  image?: MapImageMeta
  /** Crop/calibration from an imported map file, applied when an image of the same size is uploaded. */
  imageTemplate?: MapImageMeta
  /** The raw coordinate text this profile was last imported from. */
  source?: string
  updatedAt: number
}

export interface ProfileSummary {
  id: string
  name: string
  points: number
  zones: number
  hasImage: boolean
}

export interface TrailPoint {
  x: number
  y: number
  t: number
}

export interface Destination {
  name: string
  x: number
  y: number
}

export interface ChatMapState {
  chatId: string
  profileId: string | null
  pos: { x: number; y: number } | null
  dest: Destination | null
  trail: TrailPoint[]
}

export type InjectMode = 'auto' | 'macro' | 'off'

export interface Settings {
  defaultProfileId: string | null
  /** auto = append to chat context via interceptor; macro = only fill {{map_pos}} / {{@map_pos}}; off = nothing. */
  injectMode: InjectMode
  /** Ask the model to report movement with <map-pos>x,y</map-pos>. */
  askReport: boolean
  nearbyCount: number
  trailMax: number
}

export const DEFAULT_SETTINGS: Settings = {
  defaultProfileId: null,
  injectMode: 'auto',
  askReport: true,
  nearbyCount: 3,
  trailMax: 200,
}

export const POS_TAG = 'map-pos'

// ── Messages ────────────────────────────────────────────────────────────────

export type FrontendMessage =
  | { type: 'hello'; chatId: string | null }
  | { type: 'activeChat'; chatId: string | null }
  | { type: 'selectProfile'; profileId: string }
  | { type: 'createProfile'; name: string }
  | { type: 'saveProfile'; profile: WorldProfile }
  | { type: 'importProfile'; profile: WorldProfile }
  | { type: 'deleteProfile'; profileId: string }
  | { type: 'setImage'; profileId: string; dataUrl: string; width: number; height: number; mime: string }
  | { type: 'getImage'; profileId: string }
  | { type: 'removeImage'; profileId: string }
  | { type: 'setChatProfile'; chatId: string; profileId: string | null }
  | { type: 'setPos'; chatId: string; x: number; y: number }
  | { type: 'clearPos'; chatId: string }
  | { type: 'setDest'; chatId: string; dest: Destination | null }
  | { type: 'clearTrail'; chatId: string }
  | { type: 'saveSettings'; settings: Partial<Settings> }
  | { type: 'tagPos'; chatId: string; messageId: string; x: number; y: number }
  | { type: 'listWorldBooks' }
  | { type: 'closeDrawer' }
  | { type: 'listWorldBookEntries'; bookId: string }

export interface StatePayload {
  type: 'state'
  settings: Settings
  profiles: ProfileSummary[]
  /** Profile shown in the UI: the active chat's profile, else the last selected one. */
  profile: WorldProfile | null
  chat: ChatMapState | null
  /** The exact text injected / exposed as {{map_pos}} for the active chat. */
  context: string
  worldBooksAvailable: boolean
}

export interface WorldBookEntryLite {
  id: string
  name: string
  content: string
  /** `extensions.map` (Map Coordinate Format v1), when the entry has one. */
  map?: unknown
}

export type BackendMessage =
  | StatePayload
  | { type: 'image'; profileId: string; rev: number; dataUrl: string | null }
  | { type: 'worldBooks'; books: { id: string; name: string }[] }
  | { type: 'worldBookEntries'; bookId: string; entries: WorldBookEntryLite[] }
  | { type: 'notice'; level: 'info' | 'success' | 'warning' | 'error'; message: string }

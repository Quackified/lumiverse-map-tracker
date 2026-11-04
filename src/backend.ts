import type { ChatMessageDTO, LlmMessageDTO, WorldBookEntryDTO } from 'lumiverse-spindle-types'
import { boundsOf, buildContext, calibrationForBounds, findPosTag, normalizeCalib } from './shared/geo'
import { newProfile, slug } from './shared/parser'
import { VAR_NAME_RE, placesVarValue } from './shared/places'
import {
  DEFAULT_SETTINGS,
  type BackendMessage,
  type ChatMapState,
  type Destination,
  type FrontendMessage,
  type LorebookBackupSummary,
  type ProfileSummary,
  type Settings,
  type StampAsset,
  type TrailPoint,
  type WorldProfile,
} from './shared/types'

declare const spindle: import('lumiverse-spindle-types').SpindleAPI

// Storage layout (per user):
//   settings.json           Settings + last selected profile
//   profiles/<id>.json      WorldProfile
//   images/<id>.txt         data: URL of the profile's map image
// Per-chat state lives in chat variables so it travels with the chat:
//   map_world, map_xy, map_dest, map_trail, map_seen, and map_pos (the rendered
//   context, usable as {{@map_pos}} / {{getchatvar::map_pos}}).

const VAR = {
  world: 'map_world',
  xy: 'map_xy',
  dest: 'map_dest',
  trail: 'map_trail',
  seen: 'map_seen',
  text: 'map_pos',
} as const

interface UserState {
  activeChatId: string | null
  selectedProfileId: string | null
}

interface StoredSettings extends Settings {
  selectedProfileId?: string | null
}

const users = new Map<string, UserState>()
const UNKNOWN_USER = '__default__'

function userState(userId?: string): UserState {
  const key = userId ?? UNKNOWN_USER
  let s = users.get(key)
  if (!s) {
    s = { activeChatId: null, selectedProfileId: null }
    users.set(key, s)
  }
  return s
}

function send(msg: BackendMessage, userId?: string): void {
  spindle.sendToFrontend(msg, userId)
}

function notice(level: 'info' | 'success' | 'warning' | 'error', message: string, userId?: string): void {
  spindle.toast[level](message, { title: 'Map Tracker', userId })
}

// â”€â”€ Storage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function readJson<T>(path: string, fallback: T, userId?: string): Promise<T> {
  try {
    if (!(await spindle.userStorage.exists(path, userId))) return fallback
    return JSON.parse(await spindle.userStorage.read(path, userId)) as T
  } catch (err) {
    spindle.log.warn(`[Map Tracker] Failed to read ${path}: ${String(err)}`)
    return fallback
  }
}

async function writeJson(path: string, value: unknown, userId?: string): Promise<void> {
  await spindle.userStorage.write(path, JSON.stringify(value), userId)
}

// Picture stamps: one library per user, shared by every map.
const STAMP_INDEX = 'stamps/index.json'
const STAMP_ID = /^[A-Za-z0-9_-]{1,64}$/
const stampPath = (id: string) => `stamps/${id}.txt`

async function sendStamps(userId?: string): Promise<void> {
  send({ type: 'stamps', stamps: await readJson<StampAsset[]>(STAMP_INDEX, [], userId) }, userId)
}

async function loadSettings(userId?: string): Promise<StoredSettings> {
  const stored = await readJson<Partial<StoredSettings>>('settings.json', {}, userId)
  return { ...DEFAULT_SETTINGS, ...stored }
}

async function saveSettings(patch: Partial<StoredSettings>, userId?: string): Promise<StoredSettings> {
  const next = { ...(await loadSettings(userId)), ...patch }
  await writeJson('settings.json', next, userId)
  return next
}

const profilePath = (id: string) => `profiles/${id}.json`
const imagePath = (id: string) => `images/${id}.txt`

async function loadProfile(id: string | null | undefined, userId?: string): Promise<WorldProfile | null> {
  if (!id) return null
  const p = await readJson<WorldProfile | null>(profilePath(id), null, userId)
  return p && withPinCalibration(p)
}

/** Upgrades pre-0.2 per-axis calibration to pins. */
function withPinCalibration(p: WorldProfile): WorldProfile {
  for (const key of ['image', 'imageTemplate'] as const) {
    const m = p[key]
    if (m) p[key] = { ...m, calib: normalizeCalib(m.calib, m.width, m.height, p.bounds) }
  }
  return p
}

async function listProfiles(userId?: string): Promise<ProfileSummary[]> {
  let files: string[] = []
  try {
    files = await spindle.userStorage.list('profiles/', userId)
  } catch {
    return []
  }
  const out: ProfileSummary[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const id = f.replace(/^.*[\\/]/, '').replace(/\.json$/, '')
    const p = await loadProfile(id, userId)
    if (p) out.push({ id: p.id, name: p.name, points: p.points.length, zones: p.zones.length, hasImage: !!p.image })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function sanitizeProfile(p: WorldProfile): WorldProfile {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const clean: WorldProfile = {
    ...p,
    name: String(p.name || 'Untitled map').slice(0, 120),
    unitKm: num(p.unitKm, 1) > 0 ? num(p.unitKm, 1) : 1,
    points: (p.points ?? []).filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y)),
    zones: p.zones ?? [],
    placesVar: typeof p.placesVar === 'string' && VAR_NAME_RE.test(p.placesVar) ? p.placesVar : undefined,
    updatedAt: Date.now(),
  }
  const b = p.bounds
  if (!b || !(b.maxX > b.minX) || !(b.maxY > b.minY)) clean.bounds = boundsOf(clean)
  return withPinCalibration(clean)
}

async function saveProfile(p: WorldProfile, userId?: string): Promise<WorldProfile> {
  const clean = sanitizeProfile(p)
  await writeJson(profilePath(clean.id), clean, userId)
  return clean
}

/**
 * Write the map's place coordinates into a chat's variables, where lorebook
 * entries read them with {{getchatvarkey::<var>::<place id>}}. A chat variable
 * rather than a global one: prompt assembly reads global macro variables from
 * the chat's own copy, so a global written through the extension API never
 * reaches the prompt. Compared against the stored value each time, since a
 * generation or a checkpoint restore can write an older copy back.
 */
async function publishPlaces(chatId: string, p: WorldProfile | null): Promise<void> {
  if (!p?.placesVar) return
  const value = placesVarValue(p.points)
  try {
    if ((await spindle.variables.chat.get(chatId, p.placesVar)) !== value) await spindle.variables.chat.set(chatId, p.placesVar, value)
  } catch (err) {
    spindle.log.warn(`[Map Tracker] Could not write the ${p.placesVar} variable: ${String(err)}`)
  }
}

async function uniqueProfileId(name: string, userId?: string): Promise<string> {
  const base = slug(name)
  let id = base
  for (let i = 2; await spindle.userStorage.exists(profilePath(id), userId); i++) id = `${base}-${i}`
  return id
}

// â”€â”€ Chat state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function loadChat(chatId: string): Promise<ChatMapState> {
  let vars: Record<string, string> = {}
  try {
    vars = await spindle.variables.chat.list(chatId)
  } catch (err) {
    spindle.log.warn(`[Map Tracker] Could not read chat variables for ${chatId}: ${String(err)}`)
  }
  const xy = vars[VAR.xy]?.split(',').map(Number)
  return {
    chatId,
    profileId: vars[VAR.world] || null,
    pos: xy && xy.length === 2 && xy.every(Number.isFinite) ? { x: xy[0], y: xy[1] } : null,
    dest: parseJson<Destination | null>(vars[VAR.dest], null),
    trail: parseJson<TrailPoint[]>(vars[VAR.trail], []),
  }
}

async function setVar(chatId: string, key: string, value: string | null): Promise<void> {
  if (value === null || value === '') await spindle.variables.chat.delete(chatId, key).catch(() => {})
  else await spindle.variables.chat.set(chatId, key, value)
}

/** Effective profile for a chat: its own, else the default. */
function chatProfileId(chat: ChatMapState | null, settings: StoredSettings): string | null {
  return chat?.profileId || settings.defaultProfileId || null
}

async function contextFor(chat: ChatMapState, settings: StoredSettings, userId?: string, profile?: WorldProfile | null): Promise<string> {
  if (settings.injectMode === 'off') return ''
  return buildContext(profile !== undefined ? profile : await loadProfile(chatProfileId(chat, settings), userId), chat, settings)
}

async function saveChat(chat: ChatMapState, userId?: string): Promise<void> {
  const settings = await loadSettings(userId)
  await setVar(chat.chatId, VAR.world, chat.profileId)
  await setVar(chat.chatId, VAR.xy, chat.pos ? `${chat.pos.x},${chat.pos.y}` : null)
  await setVar(chat.chatId, VAR.dest, chat.dest ? JSON.stringify(chat.dest) : null)
  await setVar(chat.chatId, VAR.trail, chat.trail.length ? JSON.stringify(chat.trail.slice(-settings.trailMax)) : null)
  await refreshContext(chat, settings, userId)
}

async function refreshContext(chat: ChatMapState, settings: StoredSettings, userId?: string): Promise<string> {
  const profile = await loadProfile(chatProfileId(chat, settings), userId)
  const text = await contextFor(chat, settings, userId, profile)
  await setVar(chat.chatId, VAR.text, text || null)
  await publishPlaces(chat.chatId, profile)
  if (userState(userId).activeChatId === chat.chatId) spindle.updateMacroValue('map_pos', text)
  return text
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

async function movePosition(chatId: string, x: number, y: number, userId?: string): Promise<ChatMapState> {
  const chat = await loadChat(chatId)
  const settings = await loadSettings(userId)
  const pos = { x: round(x), y: round(y) }
  if (!chat.pos || chat.pos.x !== pos.x || chat.pos.y !== pos.y) {
    chat.trail = [...chat.trail, { ...pos, t: Date.now() }].slice(-settings.trailMax)
  }
  chat.pos = pos
  if (!chat.profileId && settings.defaultProfileId) chat.profileId = settings.defaultProfileId
  await saveChat(chat, userId)
  return chat
}

/** Applies a <map-pos> found in a message once per message+coordinate pair. */
async function applyTag(chatId: string, messageId: string, x: number, y: number, userId?: string): Promise<void> {
  const key = `${messageId}:${round(x)},${round(y)}`
  let seen: string[] = []
  try {
    seen = parseJson<string[]>(await spindle.variables.chat.get(chatId, VAR.seen), [])
  } catch {
    /* no vars yet */
  }
  if (seen.includes(key)) return
  await spindle.variables.chat.set(chatId, VAR.seen, JSON.stringify([...seen, key].slice(-60)))
  await movePosition(chatId, x, y, userId)
  if (userState(userId).activeChatId === chatId) await sendState(userId)
}

// â”€â”€ State broadcast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function sendState(userId?: string): Promise<void> {
  const us = userState(userId)
  const settings = await loadSettings(userId)
  if (us.selectedProfileId === null && settings.selectedProfileId) us.selectedProfileId = settings.selectedProfileId
  const chat = us.activeChatId ? await loadChat(us.activeChatId) : null
  const profileId = chat ? chatProfileId(chat, settings) : us.selectedProfileId || settings.defaultProfileId
  const profile = await loadProfile(profileId, userId)
  const context = chat ? await refreshContext(chat, settings, userId) : ''
  send(
    {
      type: 'state',
      settings,
      profiles: await listProfiles(userId),
      profile,
      chat,
      context,
      worldBooksAvailable: spindle.permissions.has('world_books'),
    },
    userId,
  )
}

async function sendImage(profileId: string, userId?: string): Promise<void> {
  const profile = await loadProfile(profileId, userId)
  let dataUrl: string | null = null
  if (profile?.image) {
    try {
      dataUrl = await spindle.userStorage.read(imagePath(profileId), userId)
    } catch {
      dataUrl = null
    }
  }
  send({ type: 'image', profileId, rev: profile?.image?.rev ?? 0, dataUrl }, userId)
}

// â”€â”€ Frontend messages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handle(msg: FrontendMessage, userId?: string): Promise<void> {
  const us = userState(userId)
  switch (msg.type) {
    case 'hello':
    case 'activeChat': {
      us.activeChatId = msg.chatId
      if (!msg.chatId) spindle.updateMacroValue('map_pos', '')
      break
    }
    case 'selectProfile': {
      us.selectedProfileId = msg.profileId
      await saveSettings({ selectedProfileId: msg.profileId }, userId)
      if (us.activeChatId) {
        const chat = await loadChat(us.activeChatId)
        chat.profileId = msg.profileId
        await saveChat(chat, userId)
      }
      break
    }
    case 'createProfile': {
      const id = await uniqueProfileId(msg.name || 'map', userId)
      await saveProfile(newProfile(msg.name || 'New map', id), userId)
      const settings = await loadSettings(userId)
      if (!settings.defaultProfileId) await saveSettings({ defaultProfileId: id }, userId)
      return handle({ type: 'selectProfile', profileId: id }, userId)
    }
    case 'importProfile': {
      const id = await uniqueProfileId(msg.profile.name || 'map', userId)
      // Image bytes aren't in map files; keep crop/calibration for the next matching upload.
      const { image, imageTemplate, ...rest } = msg.profile
      await saveProfile({ ...rest, id, imageTemplate: image ?? imageTemplate }, userId)
      notice('success', `Imported "${msg.profile.name}". Upload its map image in the Image tab.`, userId)
      return handle({ type: 'selectProfile', profileId: id }, userId)
    }
    case 'saveProfile': {
      const existing = await loadProfile(msg.profile.id, userId)
      if (!existing) return notice('error', 'That map no longer exists.', userId)
      // Image bytes are owned by setImage/removeImage; keep the stored rev.
      const image = msg.profile.image && existing.image ? { ...msg.profile.image, rev: existing.image.rev } : existing.image
      await saveProfile({ ...msg.profile, image }, userId)
      break
    }
    case 'deleteProfile': {
      await spindle.userStorage.delete(profilePath(msg.profileId), userId).catch(() => {})
      await spindle.userStorage.delete(imagePath(msg.profileId), userId).catch(() => {})
      const settings = await loadSettings(userId)
      const patch: Partial<StoredSettings> = {}
      if (settings.defaultProfileId === msg.profileId) patch.defaultProfileId = null
      if (settings.selectedProfileId === msg.profileId) patch.selectedProfileId = null
      await saveSettings(patch, userId)
      if (us.selectedProfileId === msg.profileId) us.selectedProfileId = null
      if (us.activeChatId) {
        const chat = await loadChat(us.activeChatId)
        if (chat.profileId === msg.profileId) {
          chat.profileId = null
          await saveChat(chat, userId)
        }
      }
      break
    }
    case 'setImage': {
      const profile = await loadProfile(msg.profileId, userId)
      if (!profile) return
      await spindle.userStorage.write(imagePath(profile.id), msg.dataUrl, userId)
      const prev = profile.image ?? profile.imageTemplate
      const sameSize = !msg.fit && prev && prev.width === msg.width && prev.height === msg.height
      delete profile.imageTemplate
      profile.image = {
        width: msg.width,
        height: msg.height,
        mime: msg.mime,
        crop: sameSize ? prev.crop : { x: 0, y: 0, w: msg.width, h: msg.height },
        calib: sameSize ? prev.calib : calibrationForBounds(msg.width, msg.height, profile.bounds),
        opacity: prev?.opacity ?? 1,
        visible: true,
        rev: (prev?.rev ?? 0) + 1,
      }
      await saveProfile(profile, userId)
      await sendState(userId)
      return sendImage(profile.id, userId)
    }
    case 'getImage':
      return sendImage(msg.profileId, userId)
    case 'removeImage': {
      const profile = await loadProfile(msg.profileId, userId)
      if (!profile) return
      await spindle.userStorage.delete(imagePath(profile.id), userId).catch(() => {})
      delete profile.image
      await saveProfile(profile, userId)
      await sendState(userId)
      return sendImage(profile.id, userId)
    }
    case 'setChatProfile': {
      const chat = await loadChat(msg.chatId)
      chat.profileId = msg.profileId
      await saveChat(chat, userId)
      break
    }
    case 'setPos':
      await movePosition(msg.chatId, msg.x, msg.y, userId)
      break
    case 'clearPos': {
      const chat = await loadChat(msg.chatId)
      chat.pos = null
      await saveChat(chat, userId)
      break
    }
    case 'setDest': {
      const chat = await loadChat(msg.chatId)
      chat.dest = msg.dest
      await saveChat(chat, userId)
      break
    }
    case 'clearTrail': {
      const chat = await loadChat(msg.chatId)
      chat.trail = chat.pos ? [{ ...chat.pos, t: Date.now() }] : []
      await saveChat(chat, userId)
      break
    }
    case 'saveSettings':
      await saveSettings(msg.settings, userId)
      break
    case 'tagPos':
      return applyTag(msg.chatId, msg.messageId, msg.x, msg.y, userId)
    case 'closeDrawer':
      // So a window popped out from the drawer isn't left underneath it.
      return void (await spindle.ui.closeDrawer({ userId }).catch(() => {}))
    case 'listWorldBooks': {
      if (!spindle.permissions.has('world_books')) return notice('warning', 'Grant the world_books permission to import from a lorebook.', userId)
      const { data } = await spindle.world_books.list({ limit: 500, userId })
      return send({ type: 'worldBooks', books: data.map((b) => ({ id: b.id, name: b.name })) }, userId)
    }
    case 'listWorldBookEntries': {
      if (!spindle.permissions.has('world_books')) return
      return sendEntries(msg.bookId, userId)
    }
    case 'applyLorebookRefs': {
      if (!spindle.permissions.has('world_books')) return
      const originals: { id: string; name: string; content: string }[] = []
      const skipped: string[] = []
      const todo: { id: string; after: string }[] = []
      for (const c of msg.changes) {
        const entry = await spindle.world_books.entries.get(c.id, userId)
        if (!entry || entry.content !== c.before) {
          skipped.push(c.name)
          continue
        }
        originals.push({ id: c.id, name: c.name, content: entry.content })
        todo.push({ id: c.id, after: c.after })
      }
      // The backup is written before any entry changes.
      if (originals.length) await saveBackup(msg.bookId, msg.bookName, originals, 'convert', userId)
      let written = 0
      for (const t of todo) {
        try {
          await spindle.world_books.entries.update(t.id, { content: t.after }, userId)
          written++
        } catch (err) {
          skipped.push(originals.find((o) => o.id === t.id)?.name ?? t.id)
          spindle.log.warn(`[Map Tracker] Could not update entry ${t.id}: ${String(err)}`)
        }
      }
      send({ type: 'lorebookApplied', bookId: msg.bookId, written, skipped }, userId)
      notice(skipped.length ? 'warning' : 'success', `Updated ${written} ${written === 1 ? 'entry' : 'entries'}${skipped.length ? `; skipped ${skipped.length} (changed since the preview)` : ''}. Originals saved.`, userId)
      await sendBackups(userId)
      await sendEntries(msg.bookId, userId)
      break
    }
    case 'listLorebookBackups':
      return sendBackups(userId)
    case 'listStamps':
      return sendStamps(userId)
    case 'getStampImages': {
      const images: { id: string; dataUrl: string }[] = []
      for (const id of msg.ids.slice(0, 80)) {
        if (!STAMP_ID.test(id)) continue
        try {
          if (await spindle.userStorage.exists(stampPath(id), userId)) images.push({ id, dataUrl: await spindle.userStorage.read(stampPath(id), userId) })
        } catch {
          /* a missing image just isn't sent */
        }
      }
      return send({ type: 'stampImages', images }, userId)
    }
    case 'saveStamp': {
      const st = msg.stamp
      if (!STAMP_ID.test(st.id) || !msg.dataUrl.startsWith('data:image/') || msg.dataUrl.length > 4_000_000) return notice('error', 'That stamp could not be saved.', userId)
      await spindle.userStorage.write(stampPath(st.id), msg.dataUrl, userId)
      const index = (await readJson<StampAsset[]>(STAMP_INDEX, [], userId)).filter((s) => s.id !== st.id)
      index.push({ id: st.id, name: String(st.name || 'Stamp').slice(0, 60), group: String(st.group || 'My stamps').slice(0, 60), w: Math.max(1, Math.round(st.w)), h: Math.max(1, Math.round(st.h)) })
      await writeJson(STAMP_INDEX, index, userId)
      return sendStamps(userId)
    }
    case 'deleteStamp': {
      if (!STAMP_ID.test(msg.id)) return
      await spindle.userStorage.delete(stampPath(msg.id), userId).catch(() => {})
      await writeJson(STAMP_INDEX, (await readJson<StampAsset[]>(STAMP_INDEX, [], userId)).filter((s) => s.id !== msg.id), userId)
      return sendStamps(userId)
    }
    case 'restoreLorebookBackup': {
      if (!spindle.permissions.has('world_books')) return
      const backup = await readJson<LorebookBackup | null>(backupPath(msg.backupId), null, userId)
      if (!backup) return notice('error', 'That backup no longer exists.', userId)
      const current: LorebookBackup['entries'] = []
      for (const e of backup.entries) {
        const entry = await spindle.world_books.entries.get(e.id, userId)
        if (entry) current.push({ id: e.id, name: e.name, content: entry.content })
      }
      // Restoring is undoable too: keep what it replaces.
      if (current.length) await saveBackup(backup.bookId, backup.bookName, current, 'restore', userId)
      let restored = 0
      for (const e of backup.entries) {
        if (!current.some((c) => c.id === e.id)) continue
        await spindle.world_books.entries.update(e.id, { content: e.content }, userId)
        restored++
      }
      const missing = backup.entries.length - restored
      notice(missing ? 'warning' : 'success', `Restored ${restored} ${restored === 1 ? 'entry' : 'entries'}${missing ? `; ${missing} no longer exist` : ''}.`, userId)
      await sendBackups(userId)
      await sendEntries(backup.bookId, userId)
      break
    }
  }
  await sendState(userId)
}

// ── Lorebook entries and backups ─────────────────────────────────────────────

/** Every entry in a world book; the host returns at most 200 per call. */
async function listAllEntries(bookId: string, userId?: string): Promise<WorldBookEntryDTO[]> {
  const out: WorldBookEntryDTO[] = []
  for (let offset = 0; offset < 20000; offset += 200) {
    const { data, total } = await spindle.world_books.entries.list(bookId, { limit: 200, offset, userId })
    out.push(...data)
    if (!data.length || out.length >= total) break
  }
  return out
}

/** Points "[x,y]" / "(x, y)", spans "X[a,b]", or map references. */
const LOOKS_LIKE_COORDS = /\[\s*[-−]?\d+(?:\.\d+)?\s*,\s*[-−]?\d+(?:\.\d+)?\s*\]|\(\s*[-−]?\d+(?:\.\d+)?\s*,\s*[-−]?\d+(?:\.\d+)?\s*\)|[XY]\s*\[\s*[-−]?\d|\{\{\s*get(?:chat|g)varkey::/

async function sendEntries(bookId: string, userId?: string): Promise<void> {
  const data = await listAllEntries(bookId, userId)
  const entries = data
    .filter((e) => e.extensions?.map || LOOKS_LIKE_COORDS.test(e.content))
    .map((e) => ({ id: e.id, name: e.comment || e.key.join(', ') || e.id, content: e.content, ...(e.extensions?.map ? { map: e.extensions.map } : {}) }))
  send({ type: 'worldBookEntries', bookId, entries }, userId)
}

interface LorebookBackup extends Omit<LorebookBackupSummary, 'count'> {
  entries: { id: string; name: string; content: string }[]
}

const BACKUP_INDEX = 'lorebook-backups.json'
const BACKUP_LIMIT = 30
const backupPath = (id: string) => `lorebook-backups/${id.replace(/[^a-z0-9-]/gi, '')}.json`

async function saveBackup(bookId: string, bookName: string, entries: LorebookBackup['entries'], reason: LorebookBackup['reason'], userId?: string): Promise<void> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const backup: LorebookBackup = { id, bookId, bookName, at: Date.now(), reason, entries }
  await writeJson(backupPath(id), backup, userId)
  const index = await readJson<LorebookBackupSummary[]>(BACKUP_INDEX, [], userId)
  index.unshift({ id, bookId, bookName, at: backup.at, count: entries.length, reason })
  for (const old of index.splice(BACKUP_LIMIT)) await spindle.userStorage.delete(backupPath(old.id), userId).catch(() => {})
  await writeJson(BACKUP_INDEX, index, userId)
}

async function sendBackups(userId?: string): Promise<void> {
  send({ type: 'lorebookBackups', backups: await readJson<LorebookBackupSummary[]>(BACKUP_INDEX, [], userId) }, userId)
}

spindle.onFrontendMessage((payload, userId) => {
  const msg = payload as FrontendMessage
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return
  handle(msg, userId).catch((err) => {
    spindle.log.error(`[Map Tracker] ${msg.type} failed: ${err instanceof Error ? err.stack : String(err)}`)
    notice('error', `Map Tracker: ${msg.type} failed (${err instanceof Error ? err.message : String(err)})`, userId)
  })
})

// â”€â”€ Position tags written by the model (or the user) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function onMessage(payload: unknown, userId?: string): void {
  const p = payload as { chatId?: string; message?: ChatMessageDTO }
  if (!p?.chatId || !p.message?.content) return
  const pos = findPosTag(p.message.content)
  if (pos) applyTag(p.chatId, p.message.id, pos.x, pos.y, userId).catch(() => {})
}

spindle.on('MESSAGE_SENT', onMessage)
spindle.on('MESSAGE_EDITED', onMessage)
spindle.on('MESSAGE_SWIPED', onMessage)

spindle.on('CHAT_SWITCHED', (payload, userId) => {
  const chatId = (payload as { chatId?: string | null })?.chatId ?? null
  userState(userId).activeChatId = chatId
  if (!chatId) spindle.updateMacroValue('map_pos', '')
  sendState(userId).catch(() => {})
})

spindle.frontendCapabilities.declare('message_tag_interceptor')

// â”€â”€ Macro + prompt injection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

spindle.registerMacro({
  name: 'map_pos',
  category: 'extension:map_tracker',
  description: "Current chat's map position, zone, nearby places and destination (Map Tracker).",
  returnType: 'string',
  handler: '',
})
spindle.updateMacroValue('map_pos', '')

spindle.registerInterceptor(async (messages, context) => {
  if (!context.chatId) return messages
  const settings = await loadSettings(context.userId)
  if (settings.injectMode !== 'auto') return messages
  const chat = await loadChat(context.chatId)
  const text = await contextFor(chat, settings, context.userId)
  if (!text) return messages
  // Just before the latest message, so it reads as current state.
  const at = Math.max(0, messages.length - 1)
  const injected: LlmMessageDTO = { role: 'system', content: text }
  return {
    messages: [...messages.slice(0, at), injected, ...messages.slice(at)],
    breakdown: [{ messageIndex: at, name: 'Map Position' }],
  }
}, 100)

spindle.log.info('[Map Tracker] backend ready')

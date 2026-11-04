// Minimal in-browser mock of the Spindle backend + frontend host, enough to run Map Tracker in a page.
let wbStore: Map<string, any> | null = null
export const wbEntries = () => {
  if (!wbStore) {
    wbStore = new Map()
    wbStore.set('e1', { id: 'e1', comment: 'Shackle City', key: [], content: 'Shackle City (-20, 60) is a slave market. Thunderpeak Summit [-35, 60] looms north.', extensions: {} })
  }
  return wbStore
}
export const gvars = new Map<string, string>()
type Handler = (payload: unknown, userId?: string) => void

const store = new Map<string, string>()
export const chatVars = new Map<string, Map<string, string>>()
const feHandlers: ((p: unknown) => void)[] = []
let beHandler: Handler | null = null
const events = new Map<string, Handler[]>()
const macros: Record<string, string> = {}
let interceptor: ((m: unknown[], c: unknown) => Promise<unknown>) | null = null

const vars = (chatId: string) => {
  if (!chatVars.has(chatId)) chatVars.set(chatId, new Map())
  return chatVars.get(chatId)!
}

;(globalThis as any).spindle = {
  log: { info: console.log, warn: console.warn, error: console.error },
  ui: { closeDrawer: async () => void ((globalThis as any).__closeDrawerCalls = ((globalThis as any).__closeDrawerCalls ?? 0) + 1) },
  toast: { success: console.log, info: console.log, warning: console.warn, error: console.error },
  userStorage: {
    read: async (p: string) => {
      if (!store.has(p)) throw new Error('ENOENT ' + p)
      return store.get(p)!
    },
    write: async (p: string, d: string) => void store.set(p, d),
    exists: async (p: string) => store.has(p),
    delete: async (p: string) => void store.delete(p),
    list: async (prefix = '') => [...store.keys()].filter((k) => k.startsWith(prefix)),
  },
  variables: {
    chat: {
      list: async (c: string) => Object.fromEntries(vars(c)),
      get: async (c: string, k: string) => vars(c).get(k) ?? '',
      set: async (c: string, k: string, v: string) => void vars(c).set(k, v),
      delete: async (c: string, k: string) => void vars(c).delete(k),
      has: async (c: string, k: string) => vars(c).has(k),
    },
    global: {
      get: async (k: string) => gvars.get(k) ?? '',
      set: async (k: string, v: string) => void gvars.set(k, v),
    },
  },
  permissions: { has: (p: string) => ['ui_panels', 'interceptor', 'world_books'].includes(p) },
  world_books: {
    list: async () => ({ data: [{ id: 'wb1', name: 'Endwright' }], total: 1 }),
    entries: {
      list: async (_b: string, o: { limit?: number; offset?: number } = {}) => {
        const all = [...wbEntries().values()]
        const off = o.offset ?? 0
        return { data: all.slice(off, off + Math.min(o.limit ?? 50, 200)), total: all.length }
      },
      get: async (id: string) => wbEntries().get(id) ?? null,
      update: async (id: string, input: any) => {
        const e = wbEntries().get(id)!
        Object.assign(e, input)
        return e
      },
    },
  },
  sendToFrontend: (p: unknown) => setTimeout(() => feHandlers.forEach((h) => h(JSON.parse(JSON.stringify(p)))), 0),
  onFrontendMessage: (h: Handler) => ((beHandler = h), () => {}),
  on: (e: string, h: Handler) => {
    if (!events.has(e)) events.set(e, [])
    events.get(e)!.push(h)
    return () => {}
  },
  frontendCapabilities: { declare: () => () => {} },
  registerMacro: () => {},
  updateMacroValue: (n: string, v: string) => void (macros[n] = v),
  registerInterceptor: (h: any) => ((interceptor = h), () => {}),
}

export const host = {
  store,
  chatVars,
  macros,
  wbEntries,
  emit: (e: string, p: unknown) => events.get(e)?.forEach((h) => h(p, 'u1')),
  runInterceptor: (m: unknown[]) => interceptor!(m, { chatId: 'chat1', userId: 'u1' }),
}

export function makeCtx(): any {
  const sidebar = document.getElementById('sidebar')!
  return {
    dom: {
      listMessageElements: () => [...document.querySelectorAll<HTMLElement>('.bubble')].map((element, i) => ({ messageId: `m${i}`, element })),
      addStyle: (css: string) => {
        const s = document.createElement('style')
        s.textContent = css
        document.head.append(s)
        return () => s.remove()
      },
    },
    ui: {
      geometry: {
        getUiScale: () => 100,
        layoutViewportSize: () => {
          throw new Error('geometry not ready')
        },
      },
      events: { getDrawerState: () => ({ open: true, tabId: 'map' }) },
      createFloatWidget: (o: any) => {
        const outer = document.createElement('div')
        outer.style.cssText = `position:fixed;left:${o.initialPosition.x}px;top:${o.initialPosition.y}px;z-index:100`
        const root = document.createElement('div')
        outer.append(root)
        document.body.append(outer)
        // Mirror Lumiverse's SpindleFloatWidget: an unhandled press drags the widget and captures the pointer.
        outer.addEventListener('pointerdown', (e) => {
          if (e.defaultPrevented || e.button !== 0) return
          for (const t of e.composedPath()) { if (t === outer) break; if (t instanceof Element && t.matches('input, textarea, select, option')) return }
          const id = e.pointerId, sx = e.clientX, sy = e.clientY
          const x0 = parseFloat(outer.style.left), y0 = parseFloat(outer.style.top)
          let moved = false
          const move = (ev: PointerEvent) => {
            if (!moved) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return; moved = true; (globalThis as any).__widgetDragged = true; outer.setPointerCapture(id) }
            outer.style.left = x0 + ev.clientX - sx + 'px'; outer.style.top = y0 + ev.clientY - sy + 'px'
          }
          const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
          window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
        })
        let visible = true
        return {
          root,
          moveTo: (x: number, y: number) => ((outer.style.left = x + 'px'), (outer.style.top = y + 'px')),
          setSize: () => {},
          getPosition: () => ({ x: parseFloat(outer.style.left), y: parseFloat(outer.style.top) }),
          setVisible: (v: boolean) => ((visible = v), (outer.style.display = v ? '' : 'none')),
          isVisible: () => visible,
          onDragEnd: () => () => {},
          destroy: () => outer.remove(),
        }
      },
      registerDrawerTab: () => {
        const root = document.createElement('div')
        root.style.cssText = 'height:100%'
        sidebar.append(root)
        return { root, activate: () => {}, destroy: () => root.remove(), setBadge() {}, onActivate: () => () => {} }
      },
      registerInputBarAction: () => ({ onClick: (h: () => void) => ((globalThis as any).__toggle = h), destroy() {} }),
      showConfirm: async () => ({ confirmed: true }),
    },
    uploads: {
      pickFile: async () => {
        const f = (globalThis as any).__nextFile as { name: string; mimeType: string; text: string } | undefined
        if (!f) return []
        return [{ name: f.name, mimeType: f.mimeType, sizeBytes: f.text.length, bytes: new TextEncoder().encode(f.text) }]
      },
    },
    permissions: { getGranted: async () => ['ui_panels'], request: async () => ['ui_panels'] },
    events: { on: () => () => {} },
    messages: { registerTagInterceptor: () => () => {} },
    getActiveChat: () => ({ chatId: 'chat1', characterId: null }),
    sendToBackend: (p: unknown) => setTimeout(() => beHandler!(JSON.parse(JSON.stringify(p)), 'u1'), 0),
    onBackendMessage: (h: (p: unknown) => void) => (feHandlers.push(h), () => {}),
  }
}

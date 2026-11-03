import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { parsePosText } from './shared/geo'
import { POS_TAG, type BackendMessage, type FrontendMessage } from './shared/types'
import { MapApp } from './ui/app'
import { h, icon, ICONS } from './ui/dom'
import { CSS } from './ui/styles'
import { MapWindow } from './ui/window'

export function setup(ctx: SpindleFrontendContext) {
  const removeStyle = ctx.dom.addStyle(CSS)
  const send = (msg: FrontendMessage) => ctx.sendToBackend(msg)
  const app = new MapApp(ctx, send)
  const unsubBackend = ctx.onBackendMessage((payload) => app.handle(payload as BackendMessage))

  // ── Hosts: floating window (overlay + snap layouts) or the sidebar drawer ──

  let win: MapWindow | null = null
  let docked = false
  /** Why the floating window couldn't open, shown in the drawer until it works. */
  let windowError: string | null = null

  const drawer = ctx.ui.registerDrawerTab({
    id: 'map',
    title: 'Map Tracker',
    shortName: 'Map',
    description: 'World map with coordinates and your position in this chat',
    keywords: ['map', 'coordinates', 'location', 'travel', 'position', 'world'],
    headerTitle: 'Map',
    iconSvg: ICONS.map,
  })
  const drawerBody = h('div', { class: 'mt-drawer-body' })
  const drawerBar = h('div', { class: 'mt-drawer-bar' })
  drawer.root.append(h('div', { class: 'mt-drawer-host' }, drawerBar, drawerBody))

  function renderDrawer(): void {
    drawerBar.replaceChildren(
      h(
        'span',
        { class: `mt-grow ${windowError ? 'mt-error' : 'mt-dim'}` },
        windowError ? `Couldn't open the floating window: ${windowError}` : docked ? 'Docked in sidebar' : win?.isVisible() ? 'Open in a floating window' : 'Map is closed',
      ),
      docked
        ? h('button', { class: 'mt-btn', onclick: () => void openWindow(true) }, icon('popout'), 'Pop out')
        : h('button', { class: 'mt-btn', onclick: () => dock() }, icon('dock'), 'Show here'),
    )
    if (docked) {
      if (app.el.parentElement !== drawerBody) drawerBody.replaceChildren(app.el)
    } else {
      drawerBody.replaceChildren(
        h(
          'div',
          { class: 'mt-drawer-idle mt-grow' },
          h('p', { class: 'mt-dim' }, 'The map works best as a floating window you can snap beside the chat.'),
          h('button', { class: 'mt-btn mt-primary', onclick: () => void openWindow(true) }, icon('popout'), 'Open map window'),
        ),
      )
    }
  }

  async function ensurePanels(): Promise<boolean> {
    try {
      if ((await ctx.permissions.getGranted()).includes('ui_panels')) return true
      const granted = await ctx.permissions.request(['ui_panels'], { reason: 'Map Tracker opens the map as a floating, snappable window.' })
      return granted.includes('ui_panels')
    } catch {
      return false
    }
  }

  async function openWindow(fromDrawer = false): Promise<void> {
    if (!(await ensurePanels())) {
      windowError = 'the ui_panels permission is not granted'
      dock()
      return
    }
    try {
      win ??= new MapWindow(ctx, {
        title: 'Map',
        content: app.el,
        onClose: () => {
          win?.setVisible(false)
          renderDrawer()
        },
        onDock: () => dock(),
      })
      docked = false
      win.adopt()
      win.setVisible(true)
      windowError = null
    } catch (err) {
      console.error('[Map Tracker] Could not open the map window:', err)
      windowError = err instanceof Error ? err.message : String(err)
      dock()
      return
    }
    app.refreshTheme()
    renderDrawer()
    if (fromDrawer) send({ type: 'closeDrawer' })
  }

  function dock(): void {
    docked = true
    win?.setVisible(false)
    renderDrawer()
    app.refreshTheme()
    drawer.activate()
  }

  function toggle(): void {
    if (docked) return drawer.activate()
    if (win?.isVisible()) {
      win.setVisible(false)
      renderDrawer()
    } else void openWindow()
  }

  renderDrawer()

  let inputAction: ReturnType<SpindleFrontendContext['ui']['registerInputBarAction']> | null = null
  try {
    inputAction = ctx.ui.registerInputBarAction({ id: 'toggle-map', label: 'Map', iconSvg: ICONS.map })
    inputAction.onClick(toggle)
  } catch (err) {
    console.debug('[Map Tracker] Input bar action unavailable:', err)
  }

  // ── <map-pos>x,y</map-pos> written by the model ────────────────────────────
  // The backend reads tags from MESSAGE_SENT/EDITED/SWIPED; this is a fallback for
  // replies we watched stream in, and it hides the tag from the rendered message.
  // Tags in old messages re-rendering on scroll are ignored.
  const streamed = new Set<string>()
  const unsubTag = ctx.messages.registerTagInterceptor({ tagName: POS_TAG, removeFromMessage: true }, (tag) => {
    if (!tag.messageId || !tag.chatId) return
    if (tag.isStreaming) {
      streamed.add(tag.messageId)
      return
    }
    if (!streamed.delete(tag.messageId)) return
    const pos = tag.attrs.x !== undefined ? parsePosText(`${tag.attrs.x},${tag.attrs.y}`) : parsePosText(tag.content)
    if (pos) send({ type: 'tagPos', chatId: tag.chatId, messageId: tag.messageId, x: pos.x, y: pos.y })
  })

  const unsubChat = ctx.events.on('CHAT_SWITCHED', (payload) => {
    send({ type: 'activeChat', chatId: (payload as { chatId?: string | null })?.chatId ?? null })
  })

  const scheme = window.matchMedia?.('(prefers-color-scheme: dark)')
  const onScheme = () => app.refreshTheme()
  scheme?.addEventListener?.('change', onScheme)

  const unsubPerm = ctx.events.on('PERMISSION_CHANGED', (payload) => {
    const p = payload as { permission?: string; granted?: boolean }
    if (p?.permission === 'ui_panels' && p.granted === false && win) {
      win.destroy()
      win = null
      dock()
    }
  })

  send({ type: 'hello', chatId: ctx.getActiveChat().chatId })

  return () => {
    unsubBackend()
    unsubTag()
    unsubChat()
    unsubPerm()
    scheme?.removeEventListener?.('change', onScheme)
    inputAction?.destroy()
    app.destroy()
    win?.destroy()
    drawer.destroy()
    removeStyle()
  }
}

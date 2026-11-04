type Child = Node | string | number | null | undefined | false
type Attrs = Record<string, unknown> & { class?: string; style?: string; dataset?: Record<string, string> }

/** Tiny element builder: h('button', { class: 'x', onclick }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') el.className = String(v)
      else if (k === 'style') el.setAttribute('style', String(v))
      else if (k === 'dataset') Object.assign(el.dataset, v)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v
      else el.setAttribute(k, v === true ? '' : String(v))
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild)
}

export function numOrNull(v: string): number | null {
  if (v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Stable pleasant hue for a string. */
export function hueOf(s: string): number {
  let hsh = 2166136261
  for (let i = 0; i < s.length; i++) hsh = Math.imul(hsh ^ s.charCodeAt(i), 16777619)
  return Math.abs(hsh) % 360
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { flush(): void; cancel(): void } {
  let t: ReturnType<typeof setTimeout> | null = null
  let last: A | null = null
  const run = (...a: A) => {
    last = a
    if (t) clearTimeout(t)
    t = setTimeout(() => {
      t = null
      if (last) fn(...last)
    }, ms)
  }
  run.flush = () => {
    if (t) {
      clearTimeout(t)
      t = null
      if (last) fn(...last)
    }
  }
  run.cancel = () => {
    if (t) clearTimeout(t)
    t = null
  }
  return run
}

/**
 * Modifier + drag on any number input inside `root` nudges its value, like a
 * game-engine inspector: Ctrl ±1, Shift ±10, Ctrl+Shift ±100, Alt ±0.1,
 * Ctrl+Alt ±0.01. Whole steps snap to multiples of the step. The same
 * modifiers work with the arrow keys. Each change fires `input` + `change`.
 */
export function enableScrub(root: HTMLElement, hooks: { onStart?(): void; onEnd?(): void } = {}): () => void {
  const PX_PER_STEP = 6
  const stepFor = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): number | null => {
    const ctrl = e.ctrlKey || e.metaKey
    if (e.altKey) return ctrl ? 0.01 : 0.1
    if (ctrl && e.shiftKey) return 100
    if (e.shiftKey) return 10
    if (ctrl) return 1
    return null
  }
  const isNum = (t: EventTarget | null): t is HTMLInputElement => t instanceof HTMLInputElement && t.type === 'number' && !t.disabled && !t.readOnly
  const apply = (input: HTMLInputElement, base: number, steps: number, step: number) => {
    let v = base + steps * step
    v = step >= 1 ? Math.round(v / step) * step : Number((Math.round(v / step) * step).toFixed(Math.ceil(-Math.log10(step))))
    const min = input.min === '' ? -Infinity : Number(input.min)
    const max = input.max === '' ? Infinity : Number(input.max)
    v = Math.max(min, Math.min(max, v))
    if (String(v) === input.value) return
    input.value = String(v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const down = (e: PointerEvent) => {
    if (!isNum(e.target) || e.button !== 0) return
    const step0 = stepFor(e)
    if (step0 === null) return
    const input = e.target
    e.preventDefault()
    input.focus({ preventScroll: true })
    input.setPointerCapture(e.pointerId)
    const base = Number(input.value) || 0
    const sx = e.clientX
    const sy = e.clientY
    const prevCursor = document.body.style.cursor
    document.body.style.cursor = 'ew-resize'
    input.classList.add('mt-scrubbing')
    hooks.onStart?.()
    // Re-base when the modifier changes mid-drag so the value doesn't jump.
    let anchor = { x: sx, y: sy, value: base, step: step0 }
    const move = (ev: PointerEvent) => {
      const step = stepFor(ev) ?? anchor.step
      if (step !== anchor.step) anchor = { x: ev.clientX, y: ev.clientY, value: Number(input.value) || 0, step }
      const steps = Math.trunc((ev.clientX - anchor.x - (ev.clientY - anchor.y)) / PX_PER_STEP)
      apply(input, anchor.value, steps, step)
    }
    const up = () => {
      input.removeEventListener('pointermove', move)
      input.removeEventListener('pointerup', up)
      input.removeEventListener('pointercancel', up)
      document.body.style.cursor = prevCursor
      input.classList.remove('mt-scrubbing')
      hooks.onEnd?.()
    }
    input.addEventListener('pointermove', move)
    input.addEventListener('pointerup', up)
    input.addEventListener('pointercancel', up)
  }

  const key = (e: KeyboardEvent) => {
    if (!isNum(e.target) || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    const step = stepFor(e)
    if (step === null) return
    e.preventDefault()
    apply(e.target, Number(e.target.value) || 0, e.key === 'ArrowUp' ? 1 : -1, step)
  }

  const over = (e: PointerEvent) => {
    if (isNum(e.target) && !e.target.title) e.target.title = 'Ctrl/Shift/Alt + drag (or arrow keys) to adjust: ±1 / ±10 / ±0.1, Ctrl+Shift ±100'
  }

  root.addEventListener('pointerdown', down, true)
  root.addEventListener('keydown', key, true)
  root.addEventListener('pointerover', over)
  return () => {
    root.removeEventListener('pointerdown', down, true)
    root.removeEventListener('keydown', key, true)
    root.removeEventListener('pointerover', over)
  }
}

export const ICONS = {
  select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 3l14 8-6 2-2 6z"/></svg>',
  area: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 8l7-4 9 5-3 10-11 1z" fill="currentColor" fill-opacity="0.18"/></svg>',
  line: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18c4-1 4-9 8-9s4 7 10 4"/><circle cx="3" cy="18" r="1.4" fill="currentColor"/><circle cx="21" cy="13" r="1.4" fill="currentColor"/></svg>',
  spot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l7 7-7 11-7-11z"/></svg>',
  transform: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="5" width="14" height="14" stroke-dasharray="3 2"/><rect x="3" y="3" width="4" height="4" fill="currentColor"/><rect x="17" y="3" width="4" height="4" fill="currentColor"/><rect x="3" y="17" width="4" height="4" fill="currentColor"/><rect x="17" y="17" width="4" height="4" fill="currentColor"/></svg>',
  hole: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6l9-3 9 4-2 12-12 2z" fill="currentColor" fill-opacity="0.18"/><ellipse cx="12" cy="12" rx="4" ry="3"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 12s4-7 10-7c2 0 3.8.7 5.3 1.7M22 12s-4 7-10 7c-2 0-3.8-.7-5.3-1.7"/><path d="M3 3l18 18"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>',
  pan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>',
  me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="12" cy="12" r="8"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.5-6-11a6 6 0 1 1 12 0c0 5.5-6 11-6 11z"/><path d="M12 7v6M9 10h6"/></svg>',
  movepin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17s-4.5-4-4.5-8a4.5 4.5 0 1 1 9 0c0 4-4.5 8-4.5 8z"/><circle cx="10" cy="9" r="1.6" fill="currentColor"/><path d="M15 19h6M18 16l3 3-3 3"/></svg>',
  ruler: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 14-14 4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
  fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  side: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
  snap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M11 4v16M11 12h10"/></svg>',
  dock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16"/></svg>',
  popout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  crop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 2v16h16M2 6h16v16"/></svg>',
  zone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 2"><rect x="4" y="5" width="16" height="14" rx="1"/></svg>',
  hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v6.5"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.5a6 6 0 0 1-4.6-2.2L4 15.5a1.6 1.6 0 0 1 2.4-2.1L8 15"/></svg>',
  brush: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4 11 13"/><path d="M11 13c-2-1-4.5 0-5 2.5S5 20 3 20c3 1.5 7.5 1 8.5-2 .6-1.8.5-3.5-.5-5z" fill="currentColor" fill-opacity="0.18"/><path d="m14 10 2 2"/></svg>',
  bucket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m10 3 9 9-7 7-9-9 4-4"/><path d="M3 10h16" stroke-opacity="0.5"/><path d="M20 15s2 2.4 2 3.6a2 2 0 0 1-4 0c0-1.2 2-3.6 2-3.6z" fill="currentColor"/></svg>',
  dropper: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m14 7 3 3M12 9l-8 8v3h3l8-8"/><path d="M14.5 4.5a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3L17 12l-5-5z" fill="currentColor" fill-opacity="0.25"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  import: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  unlink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M15 13.5l3.7-3.5a4 4 0 0 0-5.7-5.7L11.5 5.8"/><path d="M9 10.5 5.3 14a4 4 0 0 0 5.7 5.7l1.5-1.5"/><path d="M4 4l3 3M20 20l-3-3"/></svg>',
  canvas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/><path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"/></svg>',
  lasso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17.5C4.6 16.3 3 14.3 3 12c0-4.4 4-8 9-8s9 3.6 9 8-4 8-9 8c-1 0-2-.1-2.9-.4" stroke-dasharray="3 2.4"/><circle cx="8" cy="18" r="2"/><path d="M8 20v2"/></svg>',
  wand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 20 11-11M13 7l2 2"/><path d="M17 3v3M15.5 4.5h3M20 8v2M19 9h2M10 3v2M9 4h2"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16" stroke-opacity="0.6"/></svg>',
  stamp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 19 8.5 9l3 5 2.5-3.5L21 19z" fill="currentColor" fill-opacity="0.2"/><path d="M15.5 5.5l1.2 2.5 2.6.4-1.9 1.8.5 2.6-2.4-1.3-2.4 1.3.5-2.6-1.9-1.8 2.6-.4z" fill="currentColor" stroke-width="1"/></svg>',
  eraser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="m14 4 6 6-9 9H6l-3-3z"/><path d="m9 9 6 6M11 19h10"/></svg>',
  magnet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 4v7a6 6 0 0 0 12 0V4"/><path d="M6 4h3v7a3 3 0 0 0 6 0V4h3" /><path d="M6 8h3M15 8h3" stroke-width="2.4"/></svg>',
  finegrid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M12 3v18M3 12h18"/><path d="M15 12v9M18 12v9M12 15h9M12 18h9" stroke-width="1"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  labels: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h11v2M9.5 5v14M7 19h5"/><path d="M14 12h6M17 12v7"/></svg>',
}

export function icon(name: keyof typeof ICONS): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'mt-ico'
  span.innerHTML = ICONS[name]
  return span
}

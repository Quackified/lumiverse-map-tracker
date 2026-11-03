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
}

export function icon(name: keyof typeof ICONS): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'mt-ico'
  span.innerHTML = ICONS[name]
  return span
}

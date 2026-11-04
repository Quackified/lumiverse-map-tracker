// Making a stamp from a picture: cut a box out, remove the background around
// the object (grown from the edges, and from any spot clicked), soften the
// edge, trim to what's left and scale it down for storage.

/** Redmean colour distance, 0 … ~765. */
function dist(d: Uint8ClampedArray, i: number, j: number): number {
  const rm = (d[i] + d[j]) / 2
  const dr = d[i] - d[j]
  const dg = d[i + 1] - d[j + 1]
  const db = d[i + 2] - d[j + 2]
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db)
}

export interface CutOptions {
  /** Grow the background in from every edge pixel. */
  edges: boolean
  /** Extra spots (pixels in the source) whose surrounding colour is background too. */
  seeds: [number, number][]
  /** How different a colour may be and still count as background (5 … 200). */
  tolerance: number
}

/**
 * The cut-out: background pixels made transparent. Growth follows gradual
 * shading (each step close to the pixel it came from) but stops at the
 * object's outline (never too far from where that patch of background began).
 */
export function cutOut(src: HTMLCanvasElement, opts: CutOptions): HTMLCanvasElement {
  const w = src.width
  const h = src.height
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d', { willReadFrequently: true })
  if (!ctx) return out
  ctx.drawImage(src, 0, 0)
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const removed = new Uint8Array(w * h)
  const origin = new Int32Array(w * h)
  const stack = new Int32Array(w * h)
  let top = 0
  const step = opts.tolerance * 0.3
  const cap = opts.tolerance * 3
  const seed = (p: number) => {
    if (removed[p]) return
    removed[p] = 1
    origin[p] = p
    stack[top++] = p
  }
  if (opts.edges) {
    for (let x = 0; x < w; x++) seed(x), seed((h - 1) * w + x)
    for (let y = 0; y < h; y++) seed(y * w), seed(y * w + w - 1)
  }
  for (const [x, y] of opts.seeds) if (x >= 0 && y >= 0 && x < w && y < h) seed(Math.floor(y) * w + Math.floor(x))
  while (top) {
    const p = stack[--top]
    const x = p % w
    const y = (p - x) / w
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
      if (q < 0 || removed[q]) continue
      if (dist(d, q * 4, p * 4) > step || dist(d, q * 4, origin[p] * 4) > cap) continue
      removed[q] = 1
      origin[q] = origin[p]
      stack[top++] = q
    }
  }
  // Transparent background; pixels touching it are half see-through, for a soft edge.
  for (let p = 0; p < w * h; p++) {
    if (removed[p]) {
      d[p * 4 + 3] = 0
      continue
    }
    const x = p % w
    const edge = (x > 0 && removed[p - 1]) || (x < w - 1 && removed[p + 1]) || (p >= w && removed[p - w]) || (p < w * (h - 1) && removed[p + w])
    if (edge) d[p * 4 + 3] = Math.round(d[p * 4 + 3] * 0.5)
  }
  ctx.putImageData(img, 0, 0)
  return out
}

/** Trimmed to the visible pixels and scaled so the long side is at most `max`. */
export function trimmed(c: HTMLCanvasElement, max = 384): HTMLCanvasElement | null {
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const { data } = ctx.getImageData(0, 0, c.width, c.height)
  let x0 = c.width
  let y0 = c.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      if (data[(y * c.width + x) * 4 + 3] > 16) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < x0 || y1 < y0) return null
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  const k = Math.min(1, max / Math.max(w, h))
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(w * k))
  out.height = Math.max(1, Math.round(h * k))
  const o = out.getContext('2d')
  if (!o) return null
  o.imageSmoothingQuality = 'high'
  o.drawImage(c, x0, y0, w, h, 0, 0, out.width, out.height)
  return out
}

/** A source canvas from part of an image, scaled down so the long side is at most `max`. */
export function sourceFrom(img: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, max = 640): HTMLCanvasElement {
  const k = Math.min(1, max / Math.max(sw, sh))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(sw * k))
  c.height = Math.max(1, Math.round(sh * k))
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height)
  }
  return c
}

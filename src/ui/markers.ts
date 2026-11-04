import type { MarkerShape, Poi, WorldProfile } from '../shared/types'
import { hueOf } from './dom'

// Place markers: a shape and a colour per place, from the place itself, else
// its group's style (the closest styled group up the "A / B / C" path), else
// a dot in a colour picked from the group name.

export const MARKER_SHAPES: { id: MarkerShape; label: string }[] = [
  { id: 'dot', label: 'Dot' },
  { id: 'square', label: 'Square' },
  { id: 'diamond', label: 'Diamond' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'star', label: 'Star' },
  { id: 'shield', label: 'Shield' },
  { id: 'castle', label: 'Castle' },
  { id: 'anchor', label: 'Port' },
  { id: 'skull', label: 'Danger' },
]

export interface MarkerStyle {
  shape: MarkerShape
  color: string
}

/** The style set on a group or the nearest group above it. */
export function groupStyle(p: WorldProfile, group: string): { shape?: MarkerShape; color?: string } {
  const styles = p.groupStyles
  if (!styles) return {}
  const parts = group.split(' / ')
  const out: { shape?: MarkerShape; color?: string } = {}
  for (let n = parts.length; n > 0 && (!out.shape || !out.color); n--) {
    const s = styles[parts.slice(0, n).join(' / ')]
    if (!s) continue
    out.shape ??= s.shape
    out.color ??= s.color
  }
  return out
}

export function defaultColor(group: string): string {
  return `hsl(${hueOf(group.split(' / ').slice(0, 2).join('/') || 'x')} 65% 62%)`
}

export function markerStyle(p: WorldProfile, pt: Poi): MarkerStyle {
  const g = groupStyle(p, pt.group)
  return { shape: pt.shape ?? g.shape ?? 'dot', color: pt.color ?? g.color ?? defaultColor(pt.group) }
}

/** Trace a marker's outline (radius r) centred on x, y. */
function trace(g: CanvasRenderingContext2D, shape: MarkerShape, x: number, y: number, r: number): void {
  g.beginPath()
  const poly = (pts: [number, number][]) => {
    pts.forEach(([px, py], i) => (i ? g.lineTo(x + px * r, y + py * r) : g.moveTo(x + px * r, y + py * r)))
    g.closePath()
  }
  switch (shape) {
    case 'square':
      return poly([[-0.85, -0.85], [0.85, -0.85], [0.85, 0.85], [-0.85, 0.85]])
    case 'diamond':
      return poly([[0, -1.15], [1.05, 0], [0, 1.15], [-1.05, 0]])
    case 'triangle':
      return poly([[0, -1.15], [1.1, 0.85], [-1.1, 0.85]])
    case 'star': {
      const pts: [number, number][] = []
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5
        const k = i % 2 ? 0.5 : 1.25
        pts.push([Math.cos(a) * k, Math.sin(a) * k])
      }
      return poly(pts)
    }
    case 'shield':
      g.moveTo(x - r, y - r)
      g.lineTo(x + r, y - r)
      g.lineTo(x + r, y)
      g.quadraticCurveTo(x + r, y + r * 0.8, x, y + r * 1.25)
      g.quadraticCurveTo(x - r, y + r * 0.8, x - r, y)
      g.closePath()
      return
    case 'castle':
      return poly([[-1.05, 1], [-1.05, -0.6], [-1.05, -1.1], [-0.6, -1.1], [-0.6, -0.65], [-0.2, -0.65], [-0.2, -1.1], [0.2, -1.1], [0.2, -0.65], [0.6, -0.65], [0.6, -1.1], [1.05, -1.1], [1.05, 1]])
    default:
      g.arc(x, y, r, 0, Math.PI * 2)
  }
}

/** Draw a place marker: filled shape, outline, and the small inner mark some shapes carry. */
export function drawMarker(g: CanvasRenderingContext2D, style: MarkerStyle, x: number, y: number, r: number, outline: string, lw: number): void {
  const shape = style.shape
  const big = shape === 'anchor' || shape === 'skull'
  // Port and danger are a disc with a mark inside.
  trace(g, big ? 'dot' : shape, x, y, big ? r * 1.25 : r)
  g.fillStyle = style.color
  g.fill()
  g.lineWidth = lw
  g.strokeStyle = outline
  g.stroke()
  if (!big) return
  g.save()
  g.strokeStyle = g.fillStyle = 'rgba(20,20,24,0.85)'
  g.lineWidth = Math.max(1, r * 0.28)
  g.lineCap = 'round'
  const k = r * 0.8
  g.beginPath()
  if (shape === 'anchor') {
    g.moveTo(x, y - k)
    g.lineTo(x, y + k * 0.8)
    g.moveTo(x - k * 0.55, y - k * 0.45)
    g.lineTo(x + k * 0.55, y - k * 0.45)
    g.moveTo(x - k * 0.8, y + k * 0.1)
    g.quadraticCurveTo(x - k * 0.7, y + k * 0.85, x, y + k * 0.8)
    g.quadraticCurveTo(x + k * 0.7, y + k * 0.85, x + k * 0.8, y + k * 0.1)
    g.stroke()
  } else {
    g.arc(x, y - k * 0.15, k * 0.62, 0, Math.PI * 2)
    g.fill()
    g.fillRect(x - k * 0.35, y + k * 0.3, k * 0.7, k * 0.45)
    g.fillStyle = style.color
    g.beginPath()
    g.arc(x - k * 0.24, y - k * 0.18, k * 0.17, 0, Math.PI * 2)
    g.arc(x + k * 0.24, y - k * 0.18, k * 0.17, 0, Math.PI * 2)
    g.fill()
  }
  g.restore()
}

/** A marker as a small image, for lists and pickers. */
const thumbs = new Map<string, string>()
export function markerThumb(style: MarkerStyle, size = 16): string {
  const key = `${style.shape}|${style.color}|${size}`
  const hit = thumbs.get(key)
  if (hit) return hit
  const c = document.createElement('canvas')
  const dpr = 2
  c.width = c.height = size * dpr
  const g = c.getContext('2d')
  if (!g) return ''
  g.scale(dpr, dpr)
  drawMarker(g, style, size / 2, size / 2, size * 0.32, 'rgba(0,0,0,0.55)', 1.2)
  const url = c.toDataURL()
  thumbs.set(key, url)
  return url
}

import { EMPTY, LAKE, OCEAN, biomeName, biomesOf, findCell, graphFor, isWater } from './cells'
import { bearing, compass, distanceUnits, formatKm } from './geo'
import type { WorldProfile } from './types'

// What the model is told about the ground around the position: the biome
// underfoot, the nearest coast (or land, at sea), and the decorations that
// stand out nearby (a volcano, mountains, glacier spires…).

/** What each decoration kind reads as, and how notable it is (higher first). */
const KIND_LABEL: Record<string, [string, number]> = {
  'ink-volcano': ['an active volcano', 9],
  'pt-volcano': ['an active volcano', 9],
  'ink-lava': ['lava flows', 8],
  'pt-fissure': ['lava fissures', 8],
  'ink-dormant': ['a dormant volcano', 7],
  'pt-cone': ['a dormant volcano', 7],
  'ink-shard': ['glacier spires', 6],
  'pt-spires': ['ice spires', 6],
  'ink-snowpeak': ['snowy mountains', 5],
  'pt-snowpeak': ['snowy mountains', 5],
  'ink-volcpeak': ['volcanic peaks', 5],
  'ink-peak': ['mountains', 5],
  'pt-darkpeak': ['dark peaks', 5],
  'pt-sandpeak': ['sandy peaks', 4],
  'ink-cliff': ['cliffs', 4],
  'pt-ridge': ['escarpments', 4],
  'ink-fissure': ['fissures', 4],
  'ink-forest': ['forest', 3],
  'pt-canopy': ['rainforest', 3],
  'pt-tree': ['woodland', 2],
  'pt-conifer': ['conifer forest', 2],
  'ink-tree': ['scattered trees', 1],
  'ink-hill': ['hills', 2],
  'pt-hill': ['hills', 2],
  'pt-dune': ['dunes', 2],
}

/** Lines describing the surroundings of (x, y); empty when the map has no terrain or decorations. */
export function describeSurroundings(p: WorldProfile, x: number, y: number): string[] {
  const lines: string[] = []
  const span = Math.max(1e-9, p.bounds.maxX - p.bounds.minX)
  const reach = span * 0.12
  const km = (units: number) => formatKm(units * p.unitKm)
  const grid = p.land
  if (grid) {
    const b = grid.bounds
    if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) {
      const g = graphFor(grid)
      const biomes = biomesOf(grid, g)
      const start = findCell(g, x, y)
      const here = biomes[start]
      if (here !== EMPTY) {
        lines.push(here === OCEAN ? 'Terrain: at sea.' : here === LAKE ? 'Terrain: on a lake.' : `Terrain: ${biomeName(here, grid).toLowerCase()}.`)
        // The nearest shore: the closest cell on the other side of the water line, within reach.
        const wantWater = !isWater(here)
        const seen = new Uint8Array(g.n)
        seen[start] = 1
        const queue = [start]
        let best: number | null = null
        let bestD = reach
        for (let i = 0; i < queue.length && queue.length < 60000; i++) {
          for (const q of g.c[queue[i]]) {
            if (seen[q]) continue
            seen[q] = 1
            const d = distanceUnits(x, y, g.points[2 * q], g.points[2 * q + 1])
            if (d > reach) continue
            const v = biomes[q]
            if (v !== EMPTY && (wantWater ? v === OCEAN : !isWater(v))) {
              if (d < bestD) (bestD = d), (best = q)
              continue
            }
            queue.push(q)
          }
        }
        if (best !== null) {
          const dir = compass(bearing(x, y, g.points[2 * best], g.points[2 * best + 1]))
          lines.push(wantWater ? `Coast: ${km(bestD)} ${dir}.` : `Nearest land: ${km(bestD)} ${dir}.`)
        }
      }
    }
  }
  const decor = p.decor ?? []
  if (decor.length) {
    // The nearest of each kind of feature, most notable first.
    const nearestByLabel = new Map<string, { d: number; x: number; y: number; rank: number }>()
    for (const s of decor) {
      const label = KIND_LABEL[s.t]
      if (!label) continue
      const d = distanceUnits(x, y, s.x, s.y)
      if (d > reach) continue
      const cur = nearestByLabel.get(label[0])
      if (!cur || d < cur.d) nearestByLabel.set(label[0], { d, x: s.x, y: s.y, rank: label[1] })
    }
    const items = [...nearestByLabel]
      .sort((a, b) => b[1].rank - a[1].rank || a[1].d - b[1].d)
      .slice(0, 4)
      .map(([label, n]) => (n.d < span * 0.006 ? `${label} (here)` : `${label} ${km(n.d)} ${compass(bearing(x, y, n.x, n.y))}`))
    if (items.length) lines.push(`Landscape: ${items.join('; ')}.`)
  }
  return lines
}

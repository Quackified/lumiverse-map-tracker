import { describe, expect, it } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import manifest from '../spindle.json'
import { movePoint, placeRef, placesVarName, placesVarValue, revertPoint } from '../src/shared/places'
import { applyRefs, findCoords, guessName, resolveRefs } from '../src/shared/convert'
import { DEFAULT_LAND, LAKE, OCEAN, biomesOf, buildGraph, dropSmallRegions, encodeBytes, findCell, floodCells, graphFor, isWater, newGrid, regionRings, resampleGrid, smoothCells, cellsInRings, EMPTY } from '../src/shared/cells'
import {
  bearing,
  buildContext,
  compass,
  findPosTag,
  formatKm,
  calibrationForBounds,
  cropToBounds,
  imageToWorld,
  locate,
  nearest,
  normalizeCalib,
  rectCalibration,
  worldToImage,
  zoneRect,
} from '../src/shared/geo'
import { StampIndex, brushById, brushDab, eraseStamps } from '../src/ui/decor'
import { describeSurroundings } from '../src/shared/surroundings'
import { areasAt, featuresFromJson, featuresToGeoJson, pointInRings, simplify } from '../src/shared/features'
import { entriesFromLorebookJson, parseMapEntries } from '../src/shared/mapext'
import { mergeInto, newProfile, parseCoordinateText, parseSpans } from '../src/shared/parser'
import type { Calibration, LegacyCalibration, Poi, WorldProfile } from '../src/shared/types'

const SAMPLE = `---
title: '[LOC] Map Coordinates'
keys:
- map
---
<map_coordinate>
World Geography Overview:
  Eastern Continent (Aldermere):
    Range: X[-180,170], Y[-150,200]
    Traits: Ancient history
  Western Continent (Yanzhou):
    Range: X[-400,-200]
Coordinate System:
  Origin: (0,0) center of Eastern Continent
  Axis: +X=East, +Y=North
  Scale: 1 coordinate unit = 50 km
Eastern Continent Locations:
  Golden Sail Republic:
    Capital City of Thousand Sails:[40,40]
    Bluewatch Village:[60,50] # southeast coast
Special Area Determination:
  Frostfall Tundra: Y>150
  Dragonfang Mountains: X[-45,0] AND Y[0,150]
Western Continent Locations:
  Dark Region:
    Great Wall Entrance:[-280,80]
  New Hope Port:[-205,-45] # east coast facing the Endless Ocean
Western Continent Terrain Zones:
  Dark Domain: X[-300,-230] AND Y>145
  Storm Mountains: Y>120 AND X[-400,-210]
</map_coordinate>`

// The same data written the way the vault's compressed lorebook entries are.
const MARKDOWN = `<map_coordinate>

## World Map Coordinates

**Coordinate system**:
* **Origin**: (0,0), centre of the Eastern Continent.
* **Axes**: +X is east, +Y is north.
* **Scale**: 1 unit = 50 km.

**Continents**:
* **Eastern Continent (Aldermere)**: X[-180,170], Y[-150,200]. Ancient history, mature magic and martial systems.
* **Western Continent (Yanzhou)**: X[-400,-200]. Distinct cultures.

## Eastern Continent

**Golden Sail Republic**:
* Capital City of Thousand Sails [40,40]
* Bluewatch Village (60, 50), southeast coast near Thousand Sails

**Eastern regions by coordinate**:
* when Y > 150, **Frostfall Tundra**.
* when X < -45 (west of the Dragonfang Mountains), **Western Wastes**.

## Western Continent

**Frostwinter Bloodline** (north):
* Yao City [-220,-10]
* Celestial Stairway [-220,135]

**Shattered Heart Inland Sea**:
* Peach Blossom Haven: Jade Pool (-320, 0), Entrance Settlement [-280,-80]

**Western regions by coordinate**:
* when X[-300,-230] and Y > 145, **Dark Domain**, beyond the Storm Mountains. This overrides Storm Mountains inside the box.
* when Y > 120 and X[-400,-210], **Storm Mountains**.

</map_coordinate>`

function profileFrom(text: string): WorldProfile {
  return mergeInto(newProfile('Test', 'test'), parseCoordinateText(text), 'replace')
}

describe('manifest', () => {
  it('is valid', () => {
    expect(manifest.identifier).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(manifest.permissions).toContain('ui_panels')
    expect(manifest.permissions).toContain('interceptor')
  })
  it('has built entry points', () => {
    for (const f of [manifest.entry_backend, manifest.entry_frontend]) {
      const p = join(import.meta.dir, '..', f)
      expect(existsSync(p)).toBe(true)
      expect(statSync(p).size).toBeGreaterThan(0)
    }
  })
})

describe('parser', () => {
  const r = parseCoordinateText(SAMPLE)

  it('reads points with groups and notes', () => {
    expect(r.points.map((p) => p.name)).toEqual(['Capital City of Thousand Sails', 'Bluewatch Village', 'Great Wall Entrance', 'New Hope Port'])
    const blue = r.points.find((p) => p.name === 'Bluewatch Village')!
    expect(blue).toMatchObject({ x: 60, y: 50, group: 'Eastern Continent Locations / Golden Sail Republic', note: 'southeast coast' })
    expect(r.points.find((p) => p.name === 'New Hope Port')!.group).toBe('Western Continent Locations')
  })

  it('reads scale and ignores frontmatter and prose', () => {
    expect(r.unitKm).toBe(50)
    expect(r.points.some((p) => p.name.includes('title'))).toBe(false)
  })

  it('turns Range lines into regions named after their parent, with Traits as note', () => {
    const east = r.zones.find((z) => z.name === 'Eastern Continent (Aldermere)')!
    expect(east).toMatchObject({ kind: 'region', x: { min: -180, max: 170 }, y: { min: -150, max: 200 }, note: 'Ancient history' })
    expect(r.zones.find((z) => z.name === 'Western Continent (Yanzhou)')!.y).toEqual({ min: null, max: null })
  })

  it('reads open-ended and bracketed zones', () => {
    expect(r.zones.find((z) => z.name === 'Frostfall Tundra')).toMatchObject({ kind: 'zone', x: { min: null, max: null }, y: { min: 150, max: null } })
    expect(r.zones.find((z) => z.name === 'Dark Domain')).toMatchObject({ x: { min: -300, max: -230 }, y: { min: 145, max: null } })
  })

  it('clips zones to a region named in their group', () => {
    const west = r.zones.find((z) => z.name === 'Western Continent (Yanzhou)')!
    expect(r.zones.find((z) => z.name === 'Storm Mountains')!.within).toBe(west.id)
    expect(r.zones.find((z) => z.name === 'Frostfall Tundra')!.within).toBeUndefined()
  })

  it('parses comparison spans', () => {
    expect(parseSpans('X<-45 (west of the mountains)')).toEqual({ x: { min: null, max: -45 }, y: { min: null, max: null } })
    expect(parseSpans('Y>=10 AND X[5,-5]')).toEqual({ x: { min: -5, max: 5 }, y: { min: 10, max: null } })
    expect(parseSpans('no coordinates here')).toBeNull()
  })

  it('merges by name and keeps ids', () => {
    const base = profileFrom(SAMPLE)
    const id = base.points.find((p) => p.name === 'New Hope Port')!.id
    const merged = mergeInto(base, parseCoordinateText('Western Continent Locations:\n  New Hope Port:[-210,-40]\n  Brand New:[1,2]'), 'merge')
    const port = merged.points.find((p) => p.name === 'New Hope Port')!
    expect(port).toMatchObject({ id, x: -210, y: -40 })
    expect(merged.points.length).toBe(base.points.length + 1)
  })
})

describe('parser (markdown lorebook format)', () => {
  const r = parseCoordinateText(MARKDOWN)
  const zone = (name: string) => r.zones.find((z) => z.name === name)!

  it('reads bullet points under bold labels and headings', () => {
    expect(r.unitKm).toBe(50)
    expect(r.points.map((p) => p.name)).toEqual([
      'Capital City of Thousand Sails',
      'Bluewatch Village',
      'Yao City',
      'Celestial Stairway',
      'Jade Pool',
      'Entrance Settlement',
    ])
    expect(r.points.find((p) => p.name === 'Bluewatch Village')).toMatchObject({
      x: 60,
      y: 50,
      group: 'Eastern Continent / Golden Sail Republic',
      note: 'southeast coast near Thousand Sails',
    })
  })

  it('splits several points on one line and keeps the line label as a sub-group', () => {
    expect(r.points.find((p) => p.name === 'Entrance Settlement')).toMatchObject({
      x: -280,
      y: -80,
      group: 'Western Continent / Shattered Heart Inland Sea / Peach Blossom Haven',
    })
  })

  it('turns the Continents list into regions with their traits as notes', () => {
    expect(zone('Eastern Continent (Aldermere)')).toMatchObject({ kind: 'region', x: { min: -180, max: 170 }, note: 'Ancient history, mature magic and martial systems' })
    expect(zone('Western Continent (Yanzhou)')).toMatchObject({ kind: 'region', y: { min: null, max: null } })
  })

  it('reads "when …, **Name**" zones and clips them to the heading continent', () => {
    expect(zone('Frostfall Tundra')).toMatchObject({ kind: 'zone', y: { min: 150, max: null }, within: 'eastern-continent-aldermere' })
    expect(zone('Western Wastes')).toMatchObject({ x: { min: null, max: -45 }, note: 'west of the Dragonfang Mountains', within: 'eastern-continent-aldermere' })
    expect(zone('Dark Domain')).toMatchObject({ x: { min: -300, max: -230 }, y: { min: 145, max: null }, within: 'western-continent-yanzhou', priority: 1 })
    expect(zone('Storm Mountains').note).toBeUndefined()
  })

  it('locates western points without eastern zones leaking in', () => {
    const p = profileFrom(MARKDOWN)
    expect(locate(p, -220, -10).zones).toEqual([])
    expect(locate(p, -265, 165).zone?.name).toBe('Dark Domain')
    expect(locate(p, -100, 170).zones.map((z) => z.name)).toEqual(['Frostfall Tundra', 'Western Wastes'])
  })
})

describe('geo', () => {
  const p = profileFrom(SAMPLE)

  it('picks the most specific zone and the region', () => {
    const inDomain = locate(p, -265, 165)
    expect(inDomain.zone?.name).toBe('Dark Domain')
    // Frostfall Tundra (Y>150) isn't clipped to a region in this sample, so it applies here too.
    expect(inDomain.zones.map((z) => z.name)).toEqual(['Dark Domain', 'Storm Mountains', 'Frostfall Tundra'])
    expect(inDomain.region?.name).toBe('Western Continent (Yanzhou)')
    expect(locate(p, -350, 130).zone?.name).toBe('Storm Mountains')
  })

  it('respects region clipping', () => {
    const r = zoneRect(p.zones.find((z) => z.name === 'Storm Mountains')!, p.bounds, p.zones)
    expect(r.maxX).toBe(-210)
    expect(locate(p, -150, 130).zone).toBeNull()
  })

  it('computes nearest places with km and direction', () => {
    const n = nearest(p, 40, 40, 2)
    expect(n[0].poi.name).toBe('Capital City of Thousand Sails')
    expect(n[1].poi.name).toBe('Bluewatch Village')
    expect(Math.round(n[1].km)).toBe(1118)
    expect(n[1].dir).toBe('ENE')
  })

  it('formats compass bearings and distances', () => {
    expect(compass(bearing(0, 0, 0, 10))).toBe('N')
    expect(compass(bearing(0, 0, 10, 0))).toBe('E')
    expect(compass(bearing(0, 0, -10, -10))).toBe('SW')
    expect(formatKm(9947.3)).toBe('9,950 km')
    expect(formatKm(812.4)).toBe('812 km')
  })

  it('maps image pixels with independent X and Y scales (pre-0.2 calibration upgraded)', () => {
    const legacy: LegacyCalibration = { x1: { px: 329.5, w: -400 }, x2: { px: 3718.5, w: 100 }, y1: { px: 418.5, w: 150 }, y2: { px: 1900, w: -100 } }
    const c = normalizeCalib(legacy)
    expect(c.uniform).toBe(false)
    const w = imageToWorld(c, 3040.5, 1159.25)
    expect(w.x).toBeCloseTo(0, 1)
    expect(w.y).toBeCloseTo(25, 6)
    // Different px-per-unit on each axis (6.78 vs 5.93).
    expect(imageToWorld(c, 329.5 + 677.8, 0).x).toBeCloseTo(-300, 1)
    expect(imageToWorld(c, 0, 418.5 + 296.3).y).toBeCloseTo(100, 1)
    const back = worldToImage(c, -280, 80)
    const again = imageToWorld(c, back.px, back.py)
    expect(again.x).toBeCloseTo(-280, 6)
    expect(again.y).toBeCloseTo(80, 6)
  })

  it('places the image from two pins with one scale', () => {
    // Origin at pixel (1000, 500); Auston [15,-5] at pixel (1150, 550): 10 px per unit.
    const c: Calibration = { a: { px: 1000, py: 500, x: 0, y: 0 }, b: { px: 1150, py: 550, x: 15, y: -5 }, uniform: true }
    const s = Math.hypot(150, 50) / Math.hypot(15, -5)
    expect(s).toBeCloseTo(10, 9)
    expect(imageToWorld(c, 1000, 500)).toEqual({ x: 0, y: 0 })
    const w = imageToWorld(c, 1100, 300)
    expect(w.x).toBeCloseTo(10, 9)
    expect(w.y).toBeCloseTo(20, 9)
    const back = worldToImage(c, -280, 80)
    expect(back.px).toBeCloseTo(1000 - 2800, 6)
    expect(back.py).toBeCloseTo(500 - 800, 6)
  })

  it('fits a fresh image over the bounds with pin A on the origin', () => {
    const c = calibrationForBounds(2000, 1000, { minX: -400, maxX: 200, minY: -150, maxY: 150 })
    expect(c.uniform).toBe(true)
    expect(c.a).toMatchObject({ x: 0, y: 0 })
    const o = imageToWorld(c, c.a.px, c.a.py)
    expect(o.x).toBeCloseTo(0, 1)
    expect(o.y).toBeCloseTo(0, 1)
    // The whole image spans the wider of the two bound ranges, aspect kept.
    const tl = imageToWorld(c, 0, 0)
    const br = imageToWorld(c, 2000, 1000)
    expect(br.x - tl.x).toBeCloseTo(600, 1)
    expect(tl.y - br.y).toBeCloseTo(300, 1)
  })

  it('builds the prompt context', () => {
    const text = buildContext(
      p,
      { chatId: 'c', profileId: 'test', pos: { x: -265, y: 150 }, dest: { name: 'New Hope Port', x: -205, y: -45 }, trail: [] },
      { nearbyCount: 2, askReport: true },
    )
    expect(text).toContain('Current position: [-265, 150] (zone Dark Domain, region Western Continent (Yanzhou))')
    expect(text).toContain('Destination: New Hope Port [-205, -45], 10,200 km SSE.')
    expect(text).toContain('<map-pos>x,y</map-pos>')
    expect(buildContext(p, { chatId: 'c', profileId: 'test', pos: null, dest: null, trail: [] }, { nearbyCount: 2, askReport: false })).toBe('')
  })

  it('finds the last position tag in a message', () => {
    expect(findPosTag('They walk on. <map-pos>-262.5, 140</map-pos>')).toEqual({ x: -262.5, y: 140 })
    expect(findPosTag('<map-pos>1,2</map-pos> later <map-pos>[3, -4]</map-pos>')).toEqual({ x: 3, y: -4 })
    expect(findPosTag('<map-pos x="5" y="6"/>')).toEqual({ x: 5, y: 6 })
    expect(findPosTag('no tag')).toBeNull()
  })
})

describe('map fields (extensions.map, Map Coordinate Format v1)', () => {
  const lorebook = {
    entries: [
      {
        comment: '[LOC] Map Coordinates',
        extensions: {
          map: {
            kind: 'system',
            origin: [0, 0],
            scale_km: 50,
            regions: [
              { name: 'Aldermere', bbox: [-180, -150, 170, 200] },
              { name: 'Yanzhou', bbox: [-400, null, -200, null] },
            ],
          },
        },
      },
      { comment: '[HIST] The Dark Domain', extensions: { map: { kind: 'region', bbox: [-300, 145, -230, null], continent: 'Yanzhou', priority: 2, places: [{ name: 'Dark Domain Core', coords: [-265, 165] }] } } },
      { comment: '[LOC] Western Continent: Storm Mountain', extensions: { map: { kind: 'region', bbox: [-400, 120, -210, null], continent: 'Yanzhou' } } },
      { comment: '[LOC] Eastern Continent: Frostfall Tundra', extensions: { map: { kind: 'region', bbox: [null, 150, null, null], continent: 'Aldermere' } } },
      {
        comment: '[FAC] Golden Sail Republic',
        extensions: { map: { kind: 'point', coords: [40, 40], continent: 'Aldermere', places: [{ name: 'Capital City of Thousand Sails', coords: [40, 40] }, { name: 'Bluewatch Village', coords: [60, 50] }] } },
      },
      { comment: '[LOC] Bluewatch', extensions: { map: { kind: 'point', coords: [60, 50], continent: 'Aldermere' } } },
      { comment: '[EVENT] Harbour Festival', extensions: { map: { kind: 'point', coords: [40, 40], places: [{ name: 'Capital City of Thousand Sails', coords: [40, 40] }] } } },
      { comment: '[CHAR] Nobody', content: 'no map here', extensions: {} },
    ],
  }
  const r = parseMapEntries(entriesFromLorebookJson(lorebook)!)

  it('reads the system entry: scale and continents', () => {
    expect(r.unitKm).toBe(50)
    expect(r.zones.filter((z) => z.kind === 'region').map((z) => z.name)).toEqual(['Aldermere', 'Yanzhou'])
  })

  it('turns bbox [minX, minY, maxX, maxY] with nulls into clipped, prioritised zones', () => {
    const tundra = r.zones.find((z) => z.name === 'Frostfall Tundra')!
    expect(tundra).toMatchObject({ kind: 'zone', x: { min: null, max: null }, y: { min: 150, max: null }, within: 'aldermere' })
    expect(r.zones.find((z) => z.name === 'The Dark Domain')).toMatchObject({ priority: 2, within: 'yanzhou', x: { min: -300, max: -230 } })
  })

  it('lists places once, keeps the home entry as group, and merges same-spot name variants', () => {
    expect(r.points.map((p) => p.name).sort()).toEqual(['Bluewatch Village', 'Capital City of Thousand Sails', 'Dark Domain Core'])
    expect(r.points.find((p) => p.name === 'Capital City of Thousand Sails')!.group).toBe('Aldermere / Golden Sail Republic')
    expect(r.skipped).toBe(1)
  })

  it('locates with the imported data', () => {
    const p = mergeInto(newProfile('T', 't'), r, 'replace')
    expect(locate(p, -265, 165).zone?.name).toBe('The Dark Domain')
    expect(locate(p, -265, 165).region?.name).toBe('Yanzhou')
    expect(locate(p, -250, 170).zones.map((z) => z.name)).toEqual(['The Dark Domain', 'Storm Mountain'])
    expect(locate(p, 10, 160).zone?.name).toBe('Frostfall Tundra')
    expect(locate(p, -300, 160).zones.some((z) => z.name === 'Frostfall Tundra')).toBe(false)
  })
})

describe('vector layers', () => {
  const square: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]
  const hole: [number, number][] = [
    [4, 4],
    [6, 4],
    [6, 6],
    [4, 6],
  ]

  it('tests points against areas with holes', () => {
    expect(pointInRings(2, 2, [square, hole])).toBe(true)
    expect(pointInRings(5, 5, [square, hole])).toBe(false)
    expect(pointInRings(12, 5, [square])).toBe(false)
  })

  it('simplifies a freehand stroke but keeps its corners', () => {
    const stroke: [number, number][] = []
    for (let i = 0; i <= 100; i++) stroke.push([i / 10, (i % 2) * 0.01])
    for (let i = 1; i <= 100; i++) stroke.push([10, i / 10])
    const s = simplify(stroke, 0.05)
    expect(s.length).toBe(3)
    expect(s[1]).toEqual([10, 0])
  })

  it('round-trips GeoJSON, x first, polygons closed', () => {
    const fs = featuresFromJson([
      { id: 'a', layer: 'landmass', geom: 'area', type: 'land', rings: [square, hole], smooth: true },
      { id: 'r', layer: 'terrain', geom: 'line', type: 'river', rings: [[[0, 0], [5, 5]]] },
      { id: 'v', layer: 'terrain', geom: 'spot', type: 'volcano', rings: [[[3, 4]]], name: 'Skyfire' },
      { layer: 'nowhere', geom: 'area', rings: [square] },
    ])!
    expect(fs.length).toBe(3)
    const gj = featuresToGeoJson(fs)
    expect(gj.features[0].geometry).toEqual({ type: 'Polygon', coordinates: [[...square, square[0]], [...hole, hole[0]]] })
    expect(gj.features[2].geometry).toEqual({ type: 'Point', coordinates: [3, 4] })
    const back = featuresFromJson(gj)!
    expect(back.map((f) => [f.id, f.layer, f.geom, f.type])).toEqual(fs.map((f) => [f.id, f.layer, f.geom, f.type]))
    expect(back[0].rings).toEqual([square, hole])
    expect(back[2].name).toBe('Skyfire')
  })

  it('names what lies under a point, top layer first', () => {
    const fs = featuresFromJson([
      { id: 'land', layer: 'landmass', geom: 'area', type: 'land', rings: [square] },
      { id: 'wood', layer: 'terrain', geom: 'area', type: 'forest', rings: [hole] },
    ])!
    expect(areasAt(fs, 5, 5, () => true).map((f) => f.id)).toEqual(['wood', 'land'])
    expect(areasAt(fs, 1, 1, () => true).map((f) => f.id)).toEqual(['land'])
    expect(areasAt(fs, 5, 5, (l) => l !== 'terrain').map((f) => f.id)).toEqual(['land'])
  })

  it('places a cropped image over a world rectangle, stretching each axis on its own', () => {
    const crop = { x: 100, y: 50, w: 800, h: 400 }
    const c = rectCalibration(crop, { minX: -400, maxX: 100, minY: -100, maxY: 150 })
    const tl = imageToWorld(c, 100, 50)
    const br = imageToWorld(c, 900, 450)
    expect([tl.x, tl.y, br.x, br.y]).toEqual([-400, 150, 100, -100])
    // 500 units over 800 px across, 250 units over 400 px down: same ratio here, but independent.
    const squashed = rectCalibration(crop, { minX: -400, maxX: 100, minY: 0, maxY: 150 })
    expect(imageToWorld(squashed, 900, 450).y).toBeCloseTo(0, 9)
    expect(imageToWorld(squashed, 900, 450).x).toBeCloseTo(100, 9)
  })
})

describe('moving places', () => {
  const poi = (id: string, name: string, x: number, y: number): Poi => ({ id, name, x, y, group: 'G' })

  it('remembers the lorebook position on the first move and forgets it when moved back', () => {
    const p = poi('shackle-city', 'Shackle City', -20, 60)
    movePoint(p, -26, 67)
    movePoint(p, -25, 66)
    expect(p.origin).toEqual({ x: -20, y: 60 })
    movePoint(p, -20, 60)
    expect(p.origin).toBeUndefined()
    movePoint(p, 1, 2)
    revertPoint(p)
    expect([p.x, p.y, p.origin]).toEqual([-20, 60, undefined])
  })

  it('keeps moved places through a lorebook re-import, in both modes', () => {
    const moved = poi('shackle-city', 'Shackle City', -26, 67)
    moved.origin = { x: -20, y: 60 }
    const profile: WorldProfile = { ...newProfile('Endwright', 'e'), points: [moved, poi('auston', 'Auston', 15, -5)] }
    const parsed = { points: [poi('shackle-city', 'Shackle City', -18, 61), poi('auston', 'Auston', 16, -5)], zones: [], skipped: 0 }
    for (const mode of ['replace', 'merge'] as const) {
      const next = mergeInto(profile, structuredClone(parsed), mode)
      const s = next.points.find((q) => q.name === 'Shackle City')!
      expect([s.x, s.y, s.origin]).toEqual([-26, 67, { x: -18, y: 61 }])
      expect(next.points.find((q) => q.name === 'Auston')!.x).toBe(16)
    }
  })

  it('publishes coordinates as one JSON variable that getchatvarkey can read', () => {
    expect(placesVarName('Endwright')).toBe('endwright_places')
    expect(placesVarName('Articfic Realm!')).toBe('articfic_realm_places')
    const value = JSON.parse(placesVarValue([poi('shackle-city', 'Shackle City', -20, 60), poi('x', 'X', 0.5, -0)]))
    expect(value).toEqual({ 'shackle-city': '(-20, 60)', x: '(0.5, 0)' })
    expect(placeRef('endwright_places', 'shackle-city')).toBe('{{getchatvarkey::endwright_places::shackle-city}}')
    expect(placeRef('v', '2024')).toBe('{{getchatvarkey::v::["2024"]}}')
  })
})

describe('lorebook conversion', () => {
  const pts: Poi[] = [
    { id: 'shackle-city', name: 'Shackle City', x: -26, y: 67, group: 'G', origin: { x: -20, y: 60 } },
    { id: 'port-of-joy-feiyue-port', name: 'Port of Joy (Feiyue Port)', x: -175, y: 140, group: 'G' },
    { id: 'bluewatch-village', name: 'Bluewatch Village', x: 60, y: 50, group: 'G' },
    { id: 'joy', name: 'Joy', x: 1, y: 1, group: 'G' },
  ]
  const text = [
    '* **Shackle City** (-20, 60), a slave market.',
    'Feiyue Port:[-175,140] and Blue Lookout Village:[60,50]',
    'Thunderpeak Summit [-35, 60]. Range: X[-45,0] AND Y[0,150]',
    'Origin: (0,0) center',
  ].join('\n')

  it('matches literals to places by name, alias, title and position', () => {
    const hits = findCoords(text, 'Map_coordinate', pts)
    expect(hits.map((h) => [h.literal, h.placeId, h.by ?? null])).toEqual([
      ['(-20, 60)', 'shackle-city', 'name'],
      ['[-175,140]', 'port-of-joy-feiyue-port', 'name'],
      ['[60,50]', 'bluewatch-village', 'coords'],
      ['[-35, 60]', null, null],
      ['(0,0)', null, null],
    ])
    expect(guessName(hits[3])).toBe('Thunderpeak Summit')
    expect(guessName(hits[4])).toBeNull()
    const titled = findCoords('Coordinates: (5, 5)', 'Shackle City', pts)
    expect([titled[0].placeId, titled[0].by]).toEqual(['shackle-city', 'title'])
    // Another name before the literal beats the entry title.
    const mixed = findCoords('Shackle City (-20, 60) is a market. Thunderpeak Summit [-35, 60] looms.', 'Shackle City', pts)
    expect(mixed.map((h) => [h.placeId, h.by ?? null])).toEqual([['shackle-city', 'name'], [null, null]])
    expect(guessName(mixed[1])).toBe('Thunderpeak Summit')
  })

  it('rewrites chosen literals and reads references back as coordinates', () => {
    const profile: WorldProfile = { ...newProfile('Endwright', 'e'), points: pts, placesVar: 'endwright_places' }
    const hits = findCoords(text, '', pts).filter((h) => h.by === 'name')
    const out = applyRefs(text, hits, 'endwright_places')
    expect(out.split('\n')[0]).toBe('* **Shackle City** {{getchatvarkey::endwright_places::shackle-city}}, a slave market.')
    expect(out).toContain('Blue Lookout Village:[60,50]')
    const back = resolveRefs(out, profile)
    expect(back.split('\n')[0]).toBe('* **Shackle City** (-26, 67), a slave market.')
    expect(parseCoordinateText(back).points.find((p) => p.name === 'Shackle City')).toMatchObject({ x: -26, y: 67 })
    expect(findCoords(out, '', pts).some((h) => h.placeId === 'shackle-city')).toBe(false)
  })
})

describe('land grid', () => {
  const bounds = { minX: -200, maxX: 200, minY: -100, maxY: 100 }

  it('builds the same cells from the same seed, and finds the cell under a point', () => {
    const a = buildGraph(bounds, 3000, 7)
    const b = buildGraph(bounds, 3000, 7)
    expect(a.n).toBe(b.n)
    expect(Array.from(a.points.slice(0, 20))).toEqual(Array.from(b.points.slice(0, 20)))
    for (const [x, y] of [[0, 0], [-199, -99], [199, 99], [57.3, -41.2]]) {
      const c = findCell(a, x, y)
      let best = 0
      let bd = Infinity
      for (let i = 0; i < a.n; i++) {
        const d = (a.points[2 * i] - x) ** 2 + (a.points[2 * i + 1] - y) ** 2
        if (d < bd) {
          bd = d
          best = i
        }
      }
      expect(c).toBe(best)
    }
  })

  it('traces region outlines with holes, and round-trips the stored bytes', () => {
    const g = buildGraph(bounds, 4000, 3)
    const v = new Uint8Array(g.n)
    for (let i = 0; i < g.n; i++) {
      const d = Math.hypot(g.points[2 * i], g.points[2 * i + 1])
      v[i] = d < 60 ? (d < 20 ? LAKE : DEFAULT_LAND) : OCEAN
    }
    const land = regionRings(g, (c) => (isWater(v[c]) ? null : 1)).get(1)!
    expect(land.length).toBe(2) // the island and its lake
    const grid = { v: 1 as const, bounds, cells: 4000, seed: 3, biome: encodeBytes(v) }
    expect(Array.from(biomesOf(grid, graphFor(grid)))).toEqual(Array.from(v))
    expect(floodCells(g, v, findCell(g, 0, 0)).every((c) => v[c] === LAKE)).toBe(true)
  })

  it('clears speckle and tiny islands', () => {
    const g = buildGraph(bounds, 3000, 5)
    const v = new Uint8Array(g.n)
    v[findCell(g, 100, 50)] = DEFAULT_LAND
    expect(dropSmallRegions(g, v, 3).some((b) => b !== OCEAN)).toBe(false)
    expect(smoothCells(g, v, 1).some((b) => b !== OCEAN)).toBe(false)
  })

  it('resizes the canvas keeping the painting, with new area unpainted', () => {
    const grid = newGrid({ minX: -100, maxX: 100, minY: -100, maxY: 100 }, 6000, 7)
    const g = graphFor(grid)
    const v = new Uint8Array(g.n)
    for (const c of floodCells(g, v, findCell(g, 0, 0)).filter((c) => Math.hypot(g.points[2 * c], g.points[2 * c + 1]) < 30)) v[c] = DEFAULT_LAND
    const painted = { ...grid, biome: encodeBytes(v) }
    const big = resampleGrid(painted, { minX: -1000, maxX: 1000, minY: -1000, maxY: 1000 }, 20000)
    expect(big.bounds.maxX).toBe(1000)
    const g2 = graphFor(big)
    const b2 = biomesOf(big, g2)
    expect(b2[findCell(g2, 0, 0)]).toBe(DEFAULT_LAND)
    expect(b2[findCell(g2, 500, 500)]).toBe(EMPTY)
    expect(b2[findCell(g2, 0, 80)]).toBe(OCEAN)
  })

  it('starts unpainted and paints the cells inside an outline, minding holes', () => {
    const grid = newGrid({ minX: -100, maxX: 100, minY: -100, maxY: 100 }, 6000, 3)
    const g = graphFor(grid)
    expect(biomesOf(grid, g).every((b) => b === EMPTY)).toBe(true)
    const outer: [number, number][] = [[-50, -50], [50, -50], [50, 50], [-50, 50]]
    const hole: [number, number][] = [[-10, -10], [10, -10], [10, 10], [-10, 10]]
    const inside = new Set(cellsInRings(g, [outer, hole]))
    expect(inside.has(findCell(g, 30, 30))).toBe(true)
    expect(inside.has(findCell(g, 0, 0))).toBe(false)
    expect(inside.has(findCell(g, 80, 80))).toBe(false)
  })

  it('fits the cropped picture to the canvas, ignoring what was cropped away', () => {
    const crop = { x: 100, y: 50, w: 2000, h: 1000 }
    const b = { minX: -500, maxX: 500, minY: -500, maxY: 500 }
    const fit = cropToBounds(crop, b)
    const tl = imageToWorld(fit, crop.x, crop.y)
    const br = imageToWorld(fit, crop.x + crop.w, crop.y + crop.h)
    expect([tl.x, br.x, tl.y, br.y]).toEqual([-500, 500, 250, -250])
    const st = cropToBounds(crop, b, true)
    expect(imageToWorld(st, crop.x, crop.y)).toEqual({ x: -500, y: 500 })
    expect(imageToWorld(st, crop.x + crop.w, crop.y + crop.h)).toEqual({ x: 500, y: -500 })
  })
})

describe('decorations', () => {
  it('scatters stamps kept apart by the brush spacing, and a click places one', () => {
    const brush = brushById('ink-mountains')
    const index = new StampIndex(40)
    let seed = 1
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const opts = { size: 1, variation: 0.5, density: 1 }
    const dab = brushDab(brush, 10, opts, 0, 0, 120, index, false, rnd)
    expect(dab.length).toBeGreaterThan(5)
    const gap = brush.spacing * brush.size * 10
    for (let i = 0; i < dab.length; i++) for (let j = i + 1; j < dab.length; j++) expect(Math.hypot(dab[i].x - dab[j].x, dab[i].y - dab[j].y)).toBeGreaterThanOrEqual(gap - 0.02)
    expect(dab.every((s) => s.t === 'ink-peak' && Math.hypot(s.x, s.y) <= 120.01)).toBe(true)
    // A click on an existing stamp finds no room; a click far away places exactly one.
    expect(brushDab(brush, 10, opts, dab[0].x, dab[0].y, 20, index, true, rnd)).toHaveLength(0)
    expect(brushDab(brush, 10, opts, 500, 500, 120, index, true, rnd)).toHaveLength(1)
  })

  it('erases inside the circle, optionally only one brush', () => {
    const list = [
      { t: 'ink-peak', x: 0, y: 0, s: 5, r: 1 },
      { t: 'ink-tree', x: 1, y: 1, s: 2, r: 2 },
      { t: 'ink-peak', x: 50, y: 0, s: 5, r: 3 },
    ]
    expect(eraseStamps(list, 0, 0, 10).map((s) => s.r)).toEqual([3])
    expect(eraseStamps(list, 0, 0, 10, brushById('ink-trees')).map((s) => s.r)).toEqual([1, 3])
  })
})

describe('surroundings', () => {
  it('tells the model the biome underfoot, the nearest coast and notable landscape', () => {
    const grid = newGrid({ minX: -100, maxX: 100, minY: -100, maxY: 100 }, 6000, 2)
    const g = graphFor(grid)
    const v = new Uint8Array(g.n).fill(OCEAN)
    for (const c of cellsInRings(g, [[[-100, -100], [0, -100], [0, 100], [-100, 100]]])) v[c] = 6 // forest on the west half
    const p = {
      id: 'm', name: 'M', unitKm: 10, points: [], zones: [], updatedAt: 0,
      bounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
      land: { ...grid, biome: encodeBytes(v) },
      decor: [{ t: 'ink-volcano', x: -30, y: 10, s: 10, r: 1 }, { t: 'ink-peak', x: -40, y: -10, s: 6, r: 2 }],
    } as any
    const lines = describeSurroundings(p, -20, 0)
    expect(lines[0]).toBe('Terrain: temperate deciduous forest.')
    expect(lines[1]).toMatch(/^Coast: \d+ km E/)
    expect(lines[2]).toMatch(/^Landscape: an active volcano [\d,]+ km [NSEW]+; mountains/)
    expect(describeSurroundings(p, 15, 0)[0]).toBe('Terrain: at sea.')
    expect(describeSurroundings(p, 15, 0)[1]).toMatch(/^Nearest land: \d+ km W/)
  })
})


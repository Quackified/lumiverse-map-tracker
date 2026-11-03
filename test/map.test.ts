import { describe, expect, it } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import manifest from '../spindle.json'
import {
  bearing,
  buildContext,
  compass,
  findPosTag,
  formatKm,
  imageToWorld,
  locate,
  nearest,
  worldToImage,
  zoneRect,
} from '../src/shared/geo'
import { mergeInto, newProfile, parseCoordinateText, parseSpans } from '../src/shared/parser'
import type { Calibration, WorldProfile } from '../src/shared/types'

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

  it('maps image pixels with independent X and Y scales', () => {
    const c: Calibration = { x1: { px: 329.5, w: -400 }, x2: { px: 3718.5, w: 100 }, y1: { px: 418.5, w: 150 }, y2: { px: 1900, w: -100 } }
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

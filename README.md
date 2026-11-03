# Map Tracker

A world map with a real coordinate system for Lumiverse: a zoomable, pannable canvas with X/Y rulers, points of interest, zones, and an optional map image overlay. It tracks your position per chat and feeds it to the model.

Works with any world. You give it coordinate notes; it infers the points and zones, and everything stays editable.

## Install

1. Open the **Extensions** drawer in Lumiverse and add the repository URL.
2. Grant permissions:
   - `ui_panels`: the floating map window (without it, the map lives in the sidebar tab)
   - `interceptor`: appends your position to the chat context
   - `world_books` (optional): import coordinates straight from a lorebook entry

## Quick start

1. Open the map from the chat input bar's Extras menu (**Map**) or the **Map** sidebar tab.
2. Pick **+ New map…** in the map dropdown.
3. **Import** tab: paste your coordinate notes (or load a lorebook entry), **Preview**, then **Apply**.
4. **Image** tab (optional): upload a map picture, crop it, calibrate it.
5. **Chat** tab: set your position and, if you like, a destination.

## Map fields in lorebook entries (preferred)

When lorebook entries carry structured map data in `extensions.map`, the **Import** tab offers **Use map data** for the whole lorebook. A lorebook export (`.json`) with map fields also works through **Import JSON**. The format follows GeoJSON ordering, x first:

```yaml
map:
  kind: point                    # point | region | system
  coords: [60, 50]               # point: [x, y]
  bbox: [-35, -25, 100, 100]     # region: [minX, minY, maxX, maxY]; null = open side
  priority: 1                    # region overlap: higher wins (default 0)
  continent: Aldermere           # region is clipped to this continent
  places:                        # named points inside this entry
    - name: Royal Capital Auston
      coords: [15, -5]
```

- **system** (one entry): `scale_km` sets the scale, and `regions` become the continents.
- **region**: becomes a zone. Its `places` become points.
- **point**: its `places` become points grouped under the entry. Its own `coords` is added as a point only when no place already sits there.
- A place listed by several entries is kept once, under its location or faction entry. Same-spot names like "Bluewatch" and "Bluewatch Village" merge.
- Entries without `map` are skipped. The text parser below is the fallback for lorebooks without map fields.

## Coordinate notes format

Paste a whole lorebook entry; anything that isn't recognised is ignored. Plain indented notes and Markdown entries both work.

```
Eastern Continent (Aldermere):
  Range: X[-180,170], Y[-150,200]       ← a region, named after its parent line
  Traits: Ancient history               ← becomes the region's note
Eastern Continent Locations:
  Golden Sail Republic:                 ← indentation builds groups
    Thousand Sails:[40,40]
    Bluewatch Village:[60,50] # coast   ← "# ..." becomes the point's note
Western Continent Terrain Zones:
  Storm Mountains: Y>120 AND X[-400,-210]
  Frostfall Tundra: Y>150               ← open-ended sides are fine
Scale: 1 coordinate unit = 50 km
```

Markdown version of the same thing:

```
## Eastern Continent                                 ← headings build groups too
**Golden Sail Republic**:                            ← a bold label groups the list under it
* Thousand Sails (40, 40)                            ← [x,y] or (x, y)
* Bluewatch Village (60, 50), southeast coast        ← text after the coordinate is the note
* Peach Blossom Haven: Jade Pool (-320, 0), Entrance Settlement (-280, -80)
**Continents**:                                      ← items under "Continents" become regions
* **Eastern Continent (Aldermere)**: X[-180,170], Y[-150,200]. Ancient history.
**Eastern regions by coordinate**:
* when Y > 150, **Frostfall Tundra**.                ← the bold text names the zone
* **Scale**: 1 unit = 50 km.
```

- +X is east and +Y is north.
- Zones under a heading or group whose name mentions a region (here "Western Continent …", or "Eastern Continent" for "Aldermere") are clipped to that region. For other zones, set **Clip to** in the Zones tab. Otherwise an open-ended zone like `Y>150` covers every continent.
- When zones overlap, the higher **priority** wins, and ties go to the smaller zone. A zone whose note says it "overrides" another gets priority 1.

## Map image

- **Crop:** click **Edit crop** and drag the corner or edge handles on the map; drag inside the box to move it. The rest of the picture stays visible, dimmed.
- **Placement:** two pins tie the picture to your coordinates. Click **Edit pins**, then drag pin **A** onto a coordinate you know (usually the origin; **Pick origin** sets A to 0,0 and lets you click where it is) and pin **B** onto a second known place. **Use a place…** fills a pin's coordinate from one of your points. While you edit, the picture holds still and the grid and points move, so you can see them line up.
  - **Keep aspect ratio** (on by default) uses one scale for both axes. Turn it off when the picture is stretched, so X and Y scale separately.
  - On the map, **Shift+drag** slides the whole grid and **Shift+wheel** scales it around the cursor.
- **Number fields:** Ctrl+drag changes the value by 1, Shift by 10, Ctrl+Shift by 100, Alt by 0.1 (Ctrl+Alt by 0.01). Whole steps snap to round numbers. The arrow keys use the same modifiers.
- **Undo / Redo:** Ctrl+Z and Ctrl+Shift+Z (or the toolbar arrows) undo edits to points, zones, bounds, crop and pins. A drag or a scrub counts as one step.
- **Export JSON / Import JSON** (Import tab) moves a map between installs. The file holds points, zones, crop and calibration but not the image. After importing, upload the image; if its size matches, the crop and calibration apply automatically.

## The window

- It's a floating overlay you can drag and resize.
- **Snap layouts:** drag the title bar to a screen edge or corner (a preview shows the target), or use the layout button for halves, thirds, two-thirds, quarters or maximised. Double-click the title bar to maximise or restore.
- **Keeps clear of the chat:** the free space on each side of the chat column works like its own screen, so snapped layouts fill that gap instead of covering the conversation, and they re-fit when the chat column moves. Turn off **Keep clear of the chat** in the layout menu to use the whole screen.
- **Dock** moves the map into the sidebar tab; **Pop out** brings it back.
- When the window is narrow, the side panel becomes an overlay toggled from the toolbar.

**Map controls:** drag to pan, use the wheel or pinch to zoom, double-click to zoom in, `+`/`-`/`0` to zoom and fit, arrow keys to pan. Right-click for **Move me here**, **Set as destination**, **Add point** and **Copy coordinates**. Hover anywhere for the readout: coordinates, zone, region, nearest place, and distance from you.

## How your position reaches the model

Position, destination and trail are stored per chat in chat variables, so they travel with the chat.

| Mode | What happens |
|---|---|
| **Append to chat context** (default) | A system note goes in right before the latest message. It shows up in Prompt Breakdown as "Map Position". |
| **Macro only** | Nothing is injected. Put `{{map_pos}}` (active chat) or `{{@map_pos}}` / `{{getchatvar::map_pos}}` (that chat's variable) in your preset. |
| **Off** | The position is tracked on the map only. |

Example of the text that gets sent:

```
[Map: Endwright]
Current position: [-262, 118] (region Western Continent (Yanzhou)).
Nearby: Dragonbone Graveyard 849 km NE; Frostfire Keep 1,540 km WSW; Aurora Port 1,980 km WNW.
Destination: New Hope Port [-205, -45], 8,630 km SSE.
Scale: 1 unit = 50 km; +X east, +Y north.
```

With **Ask the model to report moves** turned on, the model is asked to end a reply with `<map-pos>x,y</map-pos>` when the party travels. The extension moves you there, adds the move to your trail, and hides the tag in the chat. Each tag is applied once per message.

## Development

```
bun install
bun run build      # dist/backend.js + dist/frontend.js
bun run typecheck
bun test
```

Source layout:
- `src/shared/`: data model, coordinate-notes parser, and geometry (zones, distances, calibration, prompt text)
- `src/backend.ts`: storage, per-chat state, interceptor, `{{map_pos}}` macro, and tag handling
- `src/ui/`: canvas map, window manager, side panels

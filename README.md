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
- **Placement:** the picture is a tracing reference, not the map. Click **Transform**, then drag inside it to move, a corner to scale (Shift keeps proportions) or an edge to squash or stretch one side. Centre, width and height can also be typed. **Fit to map bounds** starts it over your coordinates.
- **Number fields:** Ctrl+drag changes the value by 1, Shift by 10, Ctrl+Shift by 100, Alt by 0.1 (Ctrl+Alt by 0.01). Whole steps snap to round numbers. The arrow keys use the same modifiers.
- **Undo / Redo:** Ctrl+Z and Ctrl+Shift+Z (or the toolbar arrows) undo edits to points, zones, bounds, crop and pins. A drag or a scrub counts as one step.
- **Export JSON / Import JSON** (Import tab) moves a map between installs. The file holds points, zones, crop and calibration but not the image. After importing, upload the image; if its size matches, the crop and calibration apply automatically.

## Moving places

The lorebook gathers your places; the map owns where they are.

- **Move places** (toolbar, or **Move** in the Points tab): drag a place to its spot. Positions snap to whole units; hold Shift for 10 or Alt for 0.1. The arrow keys nudge the selected place with the same modifiers. Every move can be undone.
- A moved place remembers where the lorebook put it. While moving places, a hollow ring and a dashed line show that position. The Points tab counts moved places, can list only those, and reverts one (**Revert** in its editor, or right-click > **Back to lorebook position**) or all of them.
- Re-importing from the lorebook refreshes names, groups and notes but keeps moved places where you put them. Their lorebook position updates to the new import.

### Lorebook variable

Turn on **Lorebook variable** in the Points tab to publish every place's coordinates to one chat variable (default `<map name>_places`, e.g. `endwright_places`). It holds `{"shackle-city": "(-20, 60)", ...}`, is written into each chat that uses the map when the chat is opened, and updates whenever a place moves. A lorebook entry reads a place with:

```
Shackle City {{getchatvarkey::endwright_places::shackle-city}} sits on the trade road.
```

Lumiverse fills that in when the entry is injected into the prompt, so entries stay current without being rewritten. These are built-in macros, so a chat keeps its last value with Map Tracker disabled. **Copy reference** on a place copies its exact macro.

It is a chat variable rather than a global one because Lumiverse's prompt assembly reads `{{getgvar}}` values from the chat's own copy, which an extension cannot update.

### Converting a lorebook

Once places live on the map, the coordinates written into entries can point at it instead (Import tab > From a lorebook > pick the book > **Find coordinates**):

- Every literal like `Shackle City (-20, 60)` or `Port:[20,-25]` is matched to a place: by a place named just before it (aliases in parentheses count), else by the entry's title when nothing else is named there, else by being the only place at those coordinates. Spans like `X[-45,0]` are left alone.
- The preview shows each change in its line (old struck through, new below) with a checkbox. Name and title matches start ticked; position-only matches are marked "check it" and start unticked. A literal that matches no place can be added to the map as a new place.
- **Apply** writes only the ticked changes, skips any entry edited since the preview, and turns on the lorebook variable if it was off. The original text of every changed entry is saved first; **Lorebook backups** lists them, and **Restore** (click twice) puts entries back. A restore is backed up too.
- Converted entries still import: references are read back as the coordinates they stand for.

## Land (cells and biomes)

The **Land** tab turns the world into a few thousand small irregular cells, each with a biome, and draws them as the map: ocean with a soft shallow-water edge, biomes with smooth borders, a coastline, lakes, and terrain symbols (trees in forests, conifers in taiga, grass, dunes, reeds, peaks on mountains, mounds on hills).

- **Create land grid** covers the map's bounds with a small margin. Detail sets the cell count (Coarse ~4,000 to Very fine ~40,000).
- **Biomes:** Fantasy Map Generator's set (ocean, hot and cold desert, savanna, grassland, four forest types, taiga, tundra, glacier, wetland) plus lake, mountains and hills. Click a biome to paint with it; its swatch changes its colour (↺ restores the default).
- **Brush** paints cells under the circle (size slider); **Fill** recolours a connected region. **Keep coastline** stops a land biome from painting over water and water from painting over land. Alt+click with the brush picks the biome under the cursor. Space+drag pans. Every stroke can be undone.
- **Seed from the map picture:** pick a biome, click **Pick colour**, and click the picture where it shows that biome (the picture comes to the front while picking). Add a sample for each look: the sea, each forest colour, sand, snow, rock. **Generate** gives every cell on the picture the biome of the nearest sample colour. **Tolerance** leaves colours unlike every sample (labels, ships, ink) to their neighbours; **Smoothing** clears speckle; **Min island** merges tiny islands and lakes. Crop the picture to the map itself first, or its frame becomes land; any leftovers are one Fill click away.
- **Display:** opacity, terrain symbols on or off, and **Picture on top** to compare against the picture while painting.
- Hovering shows the biome under the cursor.

Cells and biomes are adapted from [Azgaar's Fantasy Map Generator](https://github.com/Azgaar/Fantasy-Map-Generator) (MIT, © Max Haniyeu): the jittered lattice and Voronoi graph, the region outline tracing, and the default biome set and colours.

## Shapes (vector layers)

Draw the world itself in world coordinates, so the map conforms to your data instead of to a picture. Open the **Shapes** tab.

| Layer | Holds |
|---|---|
| **Landmass** | Land outlines (with holes for lakes and inland seas), lakes, shorelines. The sea is drawn around the land. |
| **Topography** | Contours with an elevation (coloured from lowland green to snowcap), spot heights |
| **Terrain** | Broadleaf and conifer forest, jungle, grassland, desert, snow, swamp, volcanic land, hills; mountain and hill ranges, rivers, roads; volcanoes, peaks, oases |
| **Props** | Cities, towns, castles, towers, ports, ruins, temples, crystals, camps, walls |

- Each layer can be shown or hidden, locked, and faded. Click a layer to draw on it.
- **Drawing:** pick a type, then **Area**, **Line** or **Spot** (also in the toolbar). Click to add points or drag to draw freehand. Enter or double-click finishes, Backspace removes the last point, Esc cancels. Hold Space (or the middle mouse button) to pan while drawing.
- **Editing:** with **Select**, click a shape (Shift adds more), drag to move it, and use the handles to scale or stretch (Shift keeps proportions, Alt scales from the centre). Drag a vertex to move it, double-click an edge to add one, Alt+click or Delete removes one. **Cut a hole** draws a lake into a land shape.
- **Select whole layer** picks every shape on a layer, so you can move and stretch an entire traced landmass onto your lorebook coordinates in one go.
- **Import shapes…** takes a map file, a list of shapes, or a GeoJSON FeatureCollection (`properties.layer` and `properties.type`; x first). **Export GeoJSON** writes the same.
- **Terrain symbols:** forests, jungle and conifer forest fill with trees, hills with mounds, grassland with tufts, desert with dunes and swamps with reeds. Mountain ranges draw as shaded peaks along the line and hill ranges as mounds. A selected shape's **Density** (Sparse to Very dense) packs symbols tighter or looser and **Symbol size** scales them. Symbols stay put while panning and thin out when zoomed far out.
- Hovering shows what the layers say is there, e.g. "Land · Forest" or "Sea".

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

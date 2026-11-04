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
3. **Import** (top bar): paste your coordinate notes (or load a lorebook entry), **Preview**, then **Apply**.
4. **Picture** (optional): click the Picture layer, then upload a map picture, crop it, calibrate it.
5. **Story** (top bar): set your position and, if you like, a destination.

## The window

The layout follows image editors such as Photoshop or Affinity:

- **Top bar:** the map picker; **Story** (position, destination, what the model is told), **Import** (notes, lorebooks, map files, lorebook conversion) and **Map** (name, scale, canvas size, new or delete map) open as panels over the map, and Esc closes them; undo and redo; zoom.
- **Tool rail** (left), with a key for each tool:

  | Tool | Key | | Tool | Key |
  |---|---|---|---|---|
  | Hand | H | | Select features | V |
  | Measure | M | | Draw area | R |
  | My position | P | | Draw line | L |
  | Destination | D | | Place spot | S |
  | Add place | A | | Biome brush | B |
  | Move places | O | | Biome fill | G |
  | Draw zone | Z | | Biome lasso | J |
  | Decoration brush | Q | | Magic wand | W |
  | Decoration eraser | E | | Biome eyedropper | I |
  | | | | Detail brush | K |

  Clicking a tool always selects it; Esc returns to the hand.
- **Snapping** (magnet in the top bar, on by default): shapes snap to nearby places and shape points (a small square marks the hit), otherwise to whole steps that suit the zoom, when moving, scaling, dragging a point or drawing. Hold **Ctrl** to place freely. **Shift** draws at 15° angles and keeps proportions when scaling from a corner; **Alt** scales from the centre.
- **Bake to picture** (Map panel): flattens the whole canvas, with the layers visible now, into one picture 2,048, 4,096 or 8,192 pixels wide. **Download PNG**, or **Use as map picture** to replace the picture with it, placed exactly over the canvas.
- **Options bar** (under the top bar): the active tool's settings, such as the brush's biome, size and Keep coastline, or the shape layer and type, and a one-line hint.
- **Layers** (right): the story overlays (Places, Labels, Trail, Zones, Regions) as toggle chips; the eye shows or hides, the label opens the list. Below them, the drawn layers as one stack, top first: Features (Landmarks, Nature, Topography, Outlines, each with a lock), Decorations, Terrain and Picture. Click a layer to edit it in Properties; its opacity is the slim slider under the stack. The coordinate grid is a view toggle in the top bar. Click a layer to edit it in Properties.
- **Properties** (right, below Layers): the content behind the chosen layer or the active tool: the places list and editor, zones, the selected shape, the biome palette and seeding, or the picture's crop and calibration.

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
- Zones under a heading or group whose name mentions a region (here "Western Continent …", or "Eastern Continent" for "Aldermere") are clipped to that region. For other zones, set **Clip to** in Zones (Properties). Otherwise an open-ended zone like `Y>150` covers every continent.
- When zones overlap, the higher **priority** wins, and ties go to the smaller zone. A zone whose note says it "overrides" another gets priority 1.

## Map image

- **Crop:** click **Edit crop** and drag the corner or edge handles on the map; drag inside the box to move it. The rest of the picture stays visible, dimmed.
- **Placement:** the picture is a tracing reference, not the map. Click **Transform**, then drag inside it to move, a corner to scale (Shift keeps proportions) or an edge to squash or stretch one side. Centre, width and height can also be typed. **Blend** lays the picture over the terrain and decorations as a texture (multiply, overlay or soft light), so its paper and brushwork show through the painted colours. **Fit to canvas** places the cropped picture inside the canvas keeping its proportions, **Stretch to canvas** fills it exactly, and **Centre on canvas** recentres it. Only the cropped part counts.
- **Number fields:** Ctrl+drag changes the value by 1, Shift by 10, Ctrl+Shift by 100, Alt by 0.1 (Ctrl+Alt by 0.01). Whole steps snap to round numbers. The arrow keys use the same modifiers.
- **Undo / Redo:** Ctrl+Z and Ctrl+Shift+Z (or the toolbar arrows) undo edits to points, zones, bounds, crop and pins. A drag or a scrub counts as one step.
- **Export JSON / Import JSON** (Import) moves a map between installs. The file holds points, zones, crop and calibration but not the image. After importing, upload the image; if its size matches, the crop and calibration apply automatically.

## Moving places

The lorebook gathers your places; the map owns where they are.

- **Move places** (O, or **Move** in the Places properties): drag a place to its spot. Positions snap to whole units; hold Shift for 10 or Alt for 0.1. The arrow keys nudge the selected place with the same modifiers. Every move can be undone.
- A moved place remembers where the lorebook put it. While moving places, a hollow ring and a dashed line show that position. The Places properties count moved places, can list only those, and reverts one (**Revert** in its editor, or right-click > **Back to lorebook position**) or all of them.
- Re-importing from the lorebook refreshes names, groups and notes but keeps moved places where you put them. Their lorebook position updates to the new import.

### Lorebook variable

Turn on **Lorebook variable** in the Places properties to publish every place's coordinates to one chat variable (default `<map name>_places`, e.g. `endwright_places`). It holds `{"shackle-city": "(-20, 60)", ...}`, is written into each chat that uses the map when the chat is opened, and updates whenever a place moves. A lorebook entry reads a place with:

```
Shackle City {{getchatvarkey::endwright_places::shackle-city}} sits on the trade road.
```

Lumiverse fills that in when the entry is injected into the prompt, so entries stay current without being rewritten. These are built-in macros, so a chat keeps its last value with Map Tracker disabled. **Copy reference** on a place copies its exact macro.

It is a chat variable rather than a global one because Lumiverse's prompt assembly reads `{{getgvar}}` values from the chat's own copy, which an extension cannot update.

### Converting a lorebook

Once places live on the map, the coordinates written into entries can point at it instead (Import > From a lorebook > pick the book > **Find coordinates**):

- Every literal like `Shackle City (-20, 60)` or `Port:[20,-25]` is matched to a place: by a place named just before it (aliases in parentheses count), else by the entry's title when nothing else is named there, else by being the only place at those coordinates. Spans like `X[-45,0]` are left alone.
- The preview shows each change in its line (old struck through, new below) with a checkbox. Name and title matches start ticked; position-only matches are marked "check it" and start unticked. A literal that matches no place can be added to the map as a new place.
- **Apply** writes only the ticked changes, skips any entry edited since the preview, and turns on the lorebook variable if it was off. The original text of every changed entry is saved first; **Lorebook backups** lists them, and **Restore** (click twice) puts entries back. A restore is backed up too.
- Converted entries still import: references are read back as the coordinates they stand for.

## Terrain (biomes)

**Terrain** is the ground of your world: a few thousand small irregular cells, each painted with a biome, drawn as ocean with a soft shallow-water edge, biomes with smooth borders, a coastline, lakes, and terrain symbols (trees in forests, conifers in taiga, grass, dunes, reeds, peaks on mountains, mounds on hills).

- Every map can be painted: pick a biome tool and the terrain is there. It starts **unpainted**, which is see-through, so the picture and features show until you paint over them. Ocean is a biome you paint like any other.
- **Biome picker** (top of Terrain properties): swatches grouped by climate (Water, Warm, Temperate, Cold, Highlands) with a small icon on each, plus the Eraser. The current biome sits on top with its colour (click to change it, ↺ restores the default) and how much of the map it covers. The options bar's biome list is grouped the same way.
- **Biomes:** Fantasy Map Generator's set (ocean, hot and cold desert, savanna, grassland, four forest types, taiga, tundra, glacier, wetland) plus lake, mountains, hills, volcanic and ash waste, and an **Eraser** that paints cells back to unpainted. Click a biome in Properties (or pick one in the options bar) to paint with it; its swatch changes its colour (↺ restores the default).
- **Biome brush** (B) paints cells under the circle (size in the options bar).
- **Biome fill** (G): click inside a shape (a land, lake or terrain area in Features) to fill exactly that shape, or anywhere else to fill the connected area of the same biome. Shift+click always fills the connected area; **Fill inside shapes** in the options bar turns the shape behaviour off.
- **Biome lasso** (J): drag around an area and everything inside becomes the selected biome.
- **Biome eyedropper** (I), or Alt+click with any biome tool: picks the biome under the cursor, then goes back to the tool you were painting with.
- **Keep coastline** (options bar, off by default) stops a land biome from painting over water and water from painting over land.
- **Paint shapes as terrain** (Terrain or Features properties): land shapes become grassland with sea around them, lakes become lake, and forest, conifer, jungle, grassland, desert, snow, swamp, volcanic and hill areas become their biomes (volcanic land becomes the **Volcanic** biome). The shapes are hidden, not deleted; **Show them** in Features brings them back.
- **Canvas size** (in the **Map** panel, top bar) sets how big the world is: a width and a height in map units, always positive and centred on 0, so 1000 × 1000 spans -500 to 500. With the link on, width and height stay equal. **Fit to content** sizes it to your places, zones and shapes. On **Apply**, the terrain is rebuilt over the new canvas with the painting kept; new area starts unpainted, and terrain outside a smaller canvas is cut off. Terrain that doesn't cover the canvas offers **Fit terrain to canvas**.
- **Detect from the picture** (Terrain properties, once a picture is uploaded):
  - **Find landmass:** click the sea once. Water connected to the click becomes ocean, water-coloured patches enclosed by land become lakes, and everything else becomes land (**Land as** in the options bar: a biome, or unpainted). Shading that fades from shallows to deep sea is followed; coastlines stop it. Specks from labels and ships are cleaned up.
  - **Magic wand** (W): click a patch of the picture (a forest, a desert, one continent) and the connected area of similar colour becomes the selected biome. Alt+click erases it back to unpainted. **Tolerance** in the options bar sets how far a colour may differ.
  - **Save coastline as outline:** the painted coastline becomes editable shoreline lines in Features > Outlines; saving again replaces them.
  - While these tools are active the picture comes to the front, see-through, so you can see what you're clicking and what's painted.
  - Crop the picture to the map first, or its frame is read as land.
- **Colour samples (advanced):** pick a biome, click **Pick colour**, and click the picture where it shows that biome (the picture comes to the front while picking). Add a sample for each look: the sea, each forest colour, sand, snow, rock. **Generate** gives every cell on the picture the biome of the nearest sample colour. **Tolerance** leaves colours unlike every sample (labels, ships, ink) to their neighbours; **Smoothing** clears speckle; **Min island** merges tiny islands and lakes. Crop the picture to the map itself first, or its frame becomes land; any leftovers are one Fill click away.
- **Detail brush** (K): paint where cells should be three times finer (nine times as many), so islets, narrow straits and thin rivers don't merge with their neighbours. Cells grow back to normal size gradually around each area instead of meeting the coarse grid at a hard edge. The painting stays where it was; Alt+drag removes fine areas, and **Remove fine areas** evens the grid out again. Changing the overall Detail or the canvas size clears fine areas.
- **Colour** (Terrain properties): **Crisp cells**, or **Blended, painterly**: biome colours fade into each other over a few cells, with soft light and dark grain fixed to the world.
- **Coast** (Terrain properties): a soft shallow-water glow, or **Inked, with water hatching**: a bold black shoreline with short horizontal strokes in the water, densest against the shore.
- **Display:** terrain symbols on or off, **Picture on top** to compare against the picture while painting, and **Detail** (Coarse ~4,000 to Ultra ~80,000 cells; changing it keeps the painting). Opacity is on the Terrain layer row. **Clear terrain** goes back to fully unpainted.
- Hovering shows the biome under the cursor. Every stroke can be undone.

Cells and biomes are adapted from [Azgaar's Fantasy Map Generator](https://github.com/Azgaar/Fantasy-Map-Generator) (MIT, © Max Haniyeu): the jittered lattice and Voronoi graph, the region outline tracing, and the default biome set and colours.

## Decorations

Mountains, forests, hills, dunes, glaciers and volcanoes, scattered with brushes on top of the terrain. Click the **Decorations** layer to see the brushes.

- **Two sets:** the **Ink set** draws flat two-tone shapes with bold outlines (mountains, snowy and volcanic mountains, volcanoes pouring lava veins, dormant volcanoes, lava veins, dry fissures, forest masses, lone trees, hills, cliffs, glacier shards); the **Painterly set** draws soft washes with tapered ink (hills, escarpments, rainforest canopy, woodland, conifers, dunes, sandy and snowy peaks, ice spires, volcanoes, dormant cones, dark peaks, lava fissures).
- **Decoration brush** (Q): drag to scatter, click to place one stamp (a single volcano, say). **Size**, **Variation** and **Density** are in the options bar. Stamps of the same brush keep their distance, so going over an area again fills gaps rather than piling up.
- **Decoration eraser** (E): drag over stamps to remove them; **Only** limits it to the chosen brush.
- Forest and canopy brushes draw as one mass with a single scalloped outline; everything else stands on its own and overlaps back to front.
- Stamps live in world coordinates, so they scale with zoom. The layer row has visibility and opacity; **Clear decorations** removes them all. Every stroke can be undone.
- **Your stamps:** **Cut from picture** and drag a box around something on the map picture (a mountain, a forest clump, a castle). The new-stamp panel removes the background from the edges inward (shading is followed, outlines stop it); click any background that's left to remove it too, and adjust **Tolerance**. Give it a name and a **group**: stamps in one group make one brush that picks between them, so cut a few variants into a group. **Import image** adds PNGs (with their own transparency) or other pictures the same way. Your stamps are shared by all your maps; placed copies are mirrored at random so repeats look less copied.
- **Turn shapes into decorations:** mountain and hill ranges in Nature become peaks and hills along their lines; forest, jungle, conifer, volcanic, desert and hill areas are filled with matching stamps; volcano and peak spots become one stamp each. Symbol size and density carry over, and the shapes are hidden, not deleted.

## Features (vector layers)

Rivers, roads, mountain and hill ranges, borders, landmarks and outlines, in world coordinates. The ground itself is painted in Terrain; area shapes here work as outlines that Biome fill can fill, or that **Paint shapes as terrain** converts. Click a Features layer in Layers to draw on it, then use Select (V), Area (R), Line (L) or Spot (S); the options bar picks the layer and what to draw. Visibility, lock and opacity per layer are on the layer rows.

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

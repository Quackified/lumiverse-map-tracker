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

## Coordinate notes format

Paste a whole lorebook entry; anything that isn't recognised is ignored.

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

- +X is east and +Y is north.
- Zones under a group whose name mentions a region (here "Western Continent …") are clipped to that region. For other zones, set **Clip to** in the Zones tab. Otherwise an open-ended zone like `Y>150` covers every continent.
- When zones overlap, the higher **priority** wins, and ties go to the smaller zone.

## Map image

- **Crop:** type pixel values, or use **Drag on map** to cut away legends, frames and printed rulers.
- **Calibration:** two reference points per axis, so X and Y can have different scales. Click **Pick**, click a spot whose real coordinate you know (ruler ticks are ideal), then type its world value.
- **Export JSON / Import JSON** (Import tab) moves a map between installs. The file holds points, zones, crop and calibration but not the image. After importing, upload the image; if its size matches, the crop and calibration apply automatically.

## The window

- It's a floating overlay you can drag and resize.
- **Snap layouts:** drag the title bar to a screen edge or corner (a preview shows the target), or use the layout button for halves, thirds, two-thirds, quarters or maximised. Snapped windows re-fit when the browser resizes. Double-click the title bar to maximise or restore.
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

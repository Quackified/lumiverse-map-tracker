export const CSS = `
.mt-widget-root { --mt-bg: var(--lumiverse-bg, #14161b); }
.mt-window, .mt-drawer-host {
  --mt-bg: var(--lumiverse-bg, #14161b);
  --mt-elev: var(--lumiverse-bg-elevated, #1b1e25);
  --mt-fill: var(--lumiverse-fill, rgba(255,255,255,0.08));
  --mt-fill-subtle: var(--lumiverse-fill-subtle, rgba(255,255,255,0.045));
  --mt-border: var(--lumiverse-border, rgba(255,255,255,0.1));
  --mt-text: var(--lumiverse-text, #e8e8ea);
  --mt-muted: var(--lumiverse-text-muted, #9aa0aa);
  --mt-primary: var(--lumiverse-primary, #7aa2ff);
  --mt-accent: var(--lumiverse-accent, #f5b942);
  --mt-danger: var(--lumiverse-danger, #ef5f5f);
  --mt-radius: var(--lumiverse-radius, 10px);
  --mt-mono: var(--lumiverse-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  --mt-side: 300px;
  color: var(--mt-text);
  font-family: var(--lumiverse-font-family, system-ui, sans-serif);
  font-size: 13px;
}
.mt-window {
  position: relative; display: flex; flex-direction: column; width: 100%; height: 100%;
  background: var(--mt-elev); border: 1px solid var(--mt-border); border-radius: var(--mt-radius);
  box-shadow: 0 18px 50px rgba(0,0,0,0.45); overflow: hidden; box-sizing: border-box;
}
.mt-window * , .mt-drawer-host * { box-sizing: border-box; }
.mt-window.mt-dragging { user-select: none; opacity: 0.94; }
.mt-win-bar {
  display: flex; align-items: center; gap: 4px; height: 34px; flex: none; padding: 0 4px 0 10px;
  border-bottom: 1px solid var(--mt-border); cursor: grab; user-select: none; touch-action: none;
}
.mt-dragging .mt-win-bar { cursor: grabbing; }
.mt-win-title { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 12.5px; }
.mt-win-spacer, .mt-spacer { flex: 1; }
.mt-win-btn { width: 28px; padding: 0; justify-content: center; background: transparent; }
.mt-win-body { flex: 1; min-height: 0; display: flex; }
.mt-rs { position: absolute; z-index: 30; touch-action: none; }
.mt-rs-n { top: -3px; left: 10px; right: 10px; height: 7px; cursor: ns-resize; }
.mt-rs-s { bottom: -3px; left: 10px; right: 10px; height: 7px; cursor: ns-resize; }
.mt-rs-e { right: -3px; top: 10px; bottom: 10px; width: 7px; cursor: ew-resize; }
.mt-rs-w { left: -3px; top: 10px; bottom: 10px; width: 7px; cursor: ew-resize; }
.mt-rs-ne { right: -3px; top: -3px; width: 13px; height: 13px; cursor: nesw-resize; }
.mt-rs-sw { left: -3px; bottom: -3px; width: 13px; height: 13px; cursor: nesw-resize; }
.mt-rs-nw { left: -3px; top: -3px; width: 13px; height: 13px; cursor: nwse-resize; }
.mt-rs-se { right: -3px; bottom: -3px; width: 13px; height: 13px; cursor: nwse-resize; }
.mt-window:not([data-snapped=""]) .mt-rs { display: none; }

.mt-picker {
  position: absolute; top: 38px; right: 8px; z-index: 40; padding: 10px; border-radius: 10px;
  background: var(--mt-elev); border: 1px solid var(--mt-border); box-shadow: 0 12px 30px rgba(0,0,0,0.4);
}
.mt-picker-grid { display: grid; grid-template-columns: repeat(3, 66px); gap: 8px; }
.mt-picker-tile { position: relative; height: 44px; border-radius: 6px; background: var(--mt-fill-subtle); }
.mt-picker-cell {
  position: absolute; padding: 0; border: 0; background: transparent; cursor: pointer;
  box-shadow: inset 0 0 0 2px var(--mt-elev), inset 0 0 0 3.5px var(--mt-muted); border-radius: 5px;
}
.mt-picker-cell:hover { background: var(--mt-primary); box-shadow: inset 0 0 0 2px var(--mt-elev); }
.mt-picker-float { width: 100%; margin-top: 8px; justify-content: center; }
.mt-snap-preview {
  position: fixed; z-index: 2147483000; pointer-events: none; border-radius: 10px;
  background: color-mix(in srgb, var(--lumiverse-primary, #7aa2ff) 18%, transparent);
  border: 2px solid var(--lumiverse-primary, #7aa2ff); backdrop-filter: blur(2px);
  transition: left .12s, top .12s, width .12s, height .12s;
}
.mt-snap-preview[hidden] { display: none; }

.mt-app { display: flex; flex-direction: column; flex: 1; width: 100%; height: 100%; min-width: 0; min-height: 0; }
.mt-toolbar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 6px 8px; flex: none;
  border-bottom: 1px solid var(--mt-border);
}
.mt-grid {
  position: relative; flex: 1; min-height: 0; display: grid;
  grid-template-columns: 40px minmax(0, 1fr) var(--mt-side); grid-template-rows: 22px minmax(0, 1fr);
}
.mt-app[data-side="false"] .mt-grid { grid-template-columns: 40px minmax(0, 1fr) 0; }
.mt-app[data-side="false"] .mt-side { display: none; }
.mt-corner { grid-column: 1; grid-row: 1; background: var(--mt-fill-subtle); border-right: 1px solid var(--mt-border); border-bottom: 1px solid var(--mt-border); }
.mt-ruler-x { grid-column: 2; grid-row: 1; width: 100%; height: 22px; display: block; background: var(--mt-fill-subtle); border-bottom: 1px solid var(--mt-border); }
.mt-ruler-y { grid-column: 1; grid-row: 2; width: 40px; height: 100%; display: block; background: var(--mt-fill-subtle); border-right: 1px solid var(--mt-border); }
.mt-stage {
  grid-column: 2; grid-row: 2; position: relative; overflow: hidden; outline: none; touch-action: none;
  cursor: grab; background: var(--mt-bg); min-width: 0; min-height: 0;
}
.mt-stage:active { cursor: grabbing; }
.mt-stage:not([data-tool="pan"]):not([data-tool=""])[data-tool] { cursor: crosshair; }
.mt-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.mt-readout {
  position: absolute; top: 8px; right: 8px; max-width: 270px; padding: 7px 10px; border-radius: 8px;
  background: color-mix(in srgb, var(--mt-bg) 74%, transparent); backdrop-filter: blur(8px);
  font-size: 12px; line-height: 1.45; pointer-events: none;
}
.mt-readout[hidden] { display: none; }
.mt-ro-coord { font-family: var(--mt-mono); font-size: 13px; font-weight: 600; }
.mt-ro-title { font-weight: 600; }
.mt-ro-dim { color: var(--mt-muted); }
.mt-hint {
  position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); padding: 5px 12px; border-radius: 999px;
  background: color-mix(in srgb, var(--mt-bg) 80%, transparent); backdrop-filter: blur(8px); font-size: 12px;
  pointer-events: none; white-space: nowrap;
}
.mt-hint[hidden] { display: none; }
.mt-menu {
  position: absolute; z-index: 20; min-width: 190px; padding: 4px; border-radius: 8px;
  background: var(--mt-elev); border: 1px solid var(--mt-border); box-shadow: 0 10px 28px rgba(0,0,0,0.4);
}
.mt-menu[hidden] { display: none; }
.mt-menu-head { padding: 5px 8px 4px; font-size: 11.5px; color: var(--mt-muted); font-family: var(--mt-mono); }
.mt-menu-item { display: block; width: 100%; text-align: left; padding: 6px 8px; border: 0; border-radius: 5px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.mt-menu-item:hover:not(:disabled) { background: var(--mt-fill); }
.mt-menu-item:disabled { opacity: .45; cursor: default; }
.mt-pop {
  position: absolute; z-index: 25; top: 6px; right: calc(var(--mt-side) + 8px); padding: 8px 12px; border-radius: 8px;
  background: var(--mt-elev); border: 1px solid var(--mt-border); box-shadow: 0 10px 28px rgba(0,0,0,0.4);
}
.mt-app[data-side="false"] .mt-pop, .mt-narrow .mt-pop { right: 8px; }
.mt-pop[hidden] { display: none; }

.mt-side { grid-column: 3; grid-row: 1 / 3; display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid var(--mt-border); background: var(--mt-elev); }
.mt-narrow .mt-grid { grid-template-columns: 40px minmax(0, 1fr) 0; }
.mt-narrow .mt-side { grid-column: auto; grid-row: auto; position: absolute; right: 0; top: 0; bottom: 0; width: min(320px, 88%); z-index: 15; box-shadow: -12px 0 30px rgba(0,0,0,0.35); }
.mt-tabs { display: flex; flex: none; overflow-x: auto; border-bottom: 1px solid var(--mt-border); scrollbar-width: none; }
.mt-tab { flex: none; padding: 8px 10px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--mt-muted); font: inherit; font-size: 12px; cursor: pointer; }
.mt-tab:hover { color: var(--mt-text); }
.mt-tab.mt-on { color: var(--mt-text); border-bottom-color: var(--mt-primary); }
.mt-side-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px 16px; font-size: 12.5px; }
.mt-side-body h4 { margin: 14px 0 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--mt-muted); }
.mt-side-body p { margin: 6px 0; }

.mt-status {
  display: flex; align-items: center; gap: 10px; flex: none; padding: 4px 10px; min-height: 28px;
  border-top: 1px solid var(--mt-border); font-size: 12px; white-space: nowrap; overflow: hidden;
}
.mt-status b { font-family: var(--mt-mono); font-weight: 600; }
.mt-me-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--mt-primary); flex: none; }
.mt-dest { color: var(--mt-accent); overflow: hidden; text-overflow: ellipsis; }
.mt-chip { flex: none; padding: 1px 9px; border-radius: 999px; border: 1px solid var(--mt-border); background: transparent; color: var(--mt-muted); font: inherit; font-size: 11px; cursor: pointer; }
.mt-chip-auto { color: var(--mt-primary); border-color: color-mix(in srgb, var(--mt-primary) 50%, transparent); }

.mt-ico { display: inline-flex; width: 16px; height: 16px; flex: none; }
.mt-ico svg { width: 100%; height: 100%; }
.mt-btn {
  display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 9px; flex: none;
  border: 1px solid transparent; border-radius: 6px; background: var(--mt-fill-subtle); color: inherit;
  font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.mt-btn:hover:not(:disabled) { background: var(--mt-fill); }
.mt-btn:disabled { opacity: .45; cursor: default; }
.mt-btn.mt-on { background: color-mix(in srgb, var(--mt-primary) 24%, transparent); color: var(--mt-primary); }
.mt-btn.mt-primary { background: var(--mt-primary); color: var(--lumiverse-accent-fg, #fff); }
.mt-btn.mt-primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--mt-primary); }
.mt-btn.mt-danger { color: var(--mt-danger); }
.mt-btn.mt-ghost { background: transparent; }
.mt-icon-btn { width: 24px; height: 22px; padding: 0; justify-content: center; background: transparent; color: var(--mt-muted); }
.mt-seg { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--mt-fill-subtle); flex: none; }
.mt-seg .mt-btn { background: transparent; width: 28px; padding: 0; justify-content: center; }
.mt-seg .mt-btn.mt-on { background: color-mix(in srgb, var(--mt-primary) 24%, transparent); }
.mt-select, .mt-input {
  min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--mt-border); border-radius: 6px;
  background: var(--mt-fill-subtle); color: inherit; font: inherit; font-size: 12.5px;
}
.mt-select option { background: var(--mt-elev); color: var(--mt-text); }
textarea.mt-input { height: auto; padding: 6px 8px; resize: vertical; width: 100%; line-height: 1.4; }
.mt-input:focus, .mt-select:focus { outline: none; border-color: var(--mt-primary); }
.mt-profile { max-width: 210px; min-width: 110px; flex-shrink: 0; font-weight: 600; }
.mt-code { font-family: var(--mt-mono); font-size: 11.5px; }
.mt-row { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
.mt-row > .mt-input { flex: 1; width: 0; }
.mt-wrap { flex-wrap: wrap; }
.mt-grow { flex: 1; min-width: 0; }
.mt-narrow-in { flex: none !important; width: 64px !important; }
.mt-lbl { color: var(--mt-muted); font-size: 11.5px; flex: none; }
.mt-dim { color: var(--mt-muted); }
.mt-mono { font-family: var(--mt-mono); font-size: 11px; }
.mt-link { padding: 0; border: 0; background: none; color: var(--mt-primary); font: inherit; text-decoration: underline; cursor: pointer; }
.mt-form { display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 6px; align-items: center; }
.mt-form > label { color: var(--mt-muted); font-size: 11.5px; }
.mt-form .mt-input, .mt-form .mt-select { width: 100%; }
.mt-form-4 { grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr); }
.mt-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.mt-check { display: flex; align-items: center; gap: 6px; margin: 5px 0; cursor: pointer; }
.mt-radio { display: flex; align-items: flex-start; gap: 8px; margin: 7px 0; cursor: pointer; line-height: 1.35; }
.mt-radio input { margin-top: 2px; }
.mt-color { width: 26px; height: 22px; padding: 0; border: 0; background: none; cursor: pointer; }
.mt-pre { margin: 0; padding: 8px; max-height: 240px; overflow: auto; border-radius: 6px; background: var(--mt-fill-subtle); font-family: var(--mt-mono); font-size: 11.5px; white-space: pre-wrap; word-break: break-word; }
.mt-side-body code { font-family: var(--mt-mono); font-size: 11.5px; padding: 0 3px; border-radius: 4px; background: var(--mt-fill-subtle); }
.mt-editor { margin: 6px 0 12px; padding: 9px; border-radius: 8px; background: var(--mt-fill-subtle); }
.mt-preview { margin: 6px 0; padding: 8px; border-radius: 6px; background: var(--mt-fill-subtle); }
.mt-preview ul { margin: 6px 0 0; padding-left: 18px; color: var(--mt-muted); }
.mt-group { margin: 4px 0; }
.mt-group > summary { cursor: pointer; padding: 5px 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--mt-muted); list-style-position: inside; }
.mt-item { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto auto; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 5px; }
.mt-item:hover { background: var(--mt-fill-subtle); }
.mt-item.mt-on { background: color-mix(in srgb, var(--mt-primary) 16%, transparent); }
.mt-item.mt-muted { opacity: .5; }
.mt-moved { color: var(--mt-primary); }
.mt-var { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
.mt-item-name { padding: 3px 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mt-dot { width: 9px; height: 9px; border-radius: 50%; }
.mt-swatch { width: 11px; height: 11px; border: 2px dashed; border-radius: 2px; }
.mt-layers-list { display: flex; flex-direction: column; gap: 4px; }
.mt-layer { display: flex; align-items: center; gap: 4px; padding: 4px 6px; border: 1px solid var(--mt-border); border-radius: 8px; cursor: pointer; background: var(--mt-fill-subtle); }
.mt-layer.mt-on { border-color: var(--mt-primary); box-shadow: inset 0 0 0 1px var(--mt-primary); }
.mt-layer-name { flex: 1; font-weight: 600; }
.mt-layer-opacity { width: 70px; }
.mt-icon-btn.mt-off { opacity: 0.45; }
.mt-pin { margin: 8px 0; padding: 8px; border: 1px solid var(--mt-border); border-radius: 8px; background: var(--mt-fill-subtle); }
.mt-pin.mt-on { border-color: var(--mt-primary); box-shadow: inset 0 0 0 1px var(--mt-primary); }
.mt-pin-head { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
.mt-pin-badge { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; font-size: 11px; font-weight: 700; color: #fff; }
.mt-pin-a { background: var(--mt-primary); }
.mt-pin-b { background: var(--mt-accent); color: #1a1a1a; }
.mt-pin-px summary { cursor: pointer; font-size: 11.5px; margin-top: 4px; }
.mt-pin-px .mt-form { margin-top: 6px; }
.mt-scrubbing { cursor: ew-resize !important; outline: 1px solid var(--mt-primary); }
.mt-picker-info { max-width: 214px; font-size: 11.5px; color: var(--mt-muted); margin-bottom: 8px; }
.mt-picker-avoid { margin-top: 8px; font-size: 12px; }
.mt-empty { text-align: center; padding: 26px 8px; }

.mt-drawer-host { display: flex; flex-direction: column; height: 100%; min-height: 70vh; background: var(--mt-elev); }
.mt-drawer-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--mt-border); flex: none; }
.mt-drawer-body { flex: 1; min-height: 0; display: flex; }
.mt-drawer-idle { padding: 20px 12px; text-align: center; }
.mt-error { color: var(--mt-danger); font-size: 12px; }
`

// @ts-nocheck
// Decoration glyphs: each draws one stamp in screen pixels at (x, y), its base
// centre, from a seeded random source, so a stamp looks the same every frame.
// Ported from the brush mock; kept untyped on purpose, since it is plain canvas
// drawing with many small point tuples.

function mulberry(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const INK = '#2a211c';

// ── Paint helpers ──────────────────────────────────────────────────────────
/** Tapered ink line through points: thick in the middle, thin at the ends. */
function ink(g, pts, width, color = INK, alpha = 1, taperStart = true, taperEnd = true) {
  g.save(); g.globalAlpha *= alpha; g.strokeStyle = color; g.lineCap = 'round'; g.lineJoin = 'round';
  for (let i = 1; i < pts.length; i++) {
    const t = i / (pts.length - 1);
    let k = Math.sin(Math.PI * t);
    if (!taperStart && t < 0.5) k = 1; if (!taperEnd && t > 0.5) k = 1;
    g.lineWidth = Math.max(0.6, Math.min(width, 3.4) * (0.35 + 0.65 * k));
    g.beginPath(); g.moveTo(pts[i - 1][0], pts[i - 1][1]); g.lineTo(pts[i][0], pts[i][1]); g.stroke();
  }
  g.restore();
}
function curve(p0, p1, p2, p3, n = 14) { const out = []; for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; out.push([u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0], u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]]); } return out; }
function softShadow(g, x, y, rx, ry, a = 0.18) { const gr = g.createRadialGradient(x, y, 0, x, y, rx); gr.addColorStop(0, `rgba(30,25,15,${a})`); gr.addColorStop(1, 'rgba(30,25,15,0)'); g.save(); g.translate(x, y); g.scale(1, ry / rx); g.translate(-x, -y); g.fillStyle = gr; g.beginPath(); g.arc(x, y, rx, 0, Math.PI * 2); g.fill(); g.restore(); }
function tick(g, x, y, s, color = '#3b4a24', a = 0.7) { ink(g, [[x - s * 0.5, y - s * 0.6], [x - s * 0.1, y]], s * 0.18, color, a); ink(g, [[x + s * 0.45, y - s * 0.7], [x + s * 0.05, y]], s * 0.18, color, a); }

/** Jittered scatter where `mask` (0..1) is high; sizes vary around `size`. */

// ── Glyphs ─────────────────────────────────────────────────────────────────
function hill(g, x, y, W, rnd, pal) {
  const H = W * (0.32 + rnd() * 0.16), lean = (rnd() - 0.5) * 0.25;
  const L = [x - W / 2, y], P = [x + W * lean, y - H], R = [x + W / 2, y];
  g.beginPath(); g.moveTo(L[0], L[1]);
  g.bezierCurveTo(x - W * 0.33, y - H * 0.75, P[0] - W * 0.16, P[1], P[0], P[1]);
  g.bezierCurveTo(P[0] + W * 0.16, P[1], x + W * 0.32, y - H * 0.55, R[0], R[1]); g.closePath();
  const gr = g.createLinearGradient(x - W / 2, 0, x + W / 2, 0);
  gr.addColorStop(0, pal.light); gr.addColorStop(0.5, pal.mid); gr.addColorStop(1, pal.dark);
  g.fillStyle = gr; g.fill();
  // Shading strokes down the shadow side.
  for (let i = 0; i < 3; i++) { const sx = P[0] + W * (0.06 + i * 0.09), sy = P[1] + H * (0.2 + i * 0.12); ink(g, curve([sx, sy], [sx + W * 0.04, sy + H * 0.2], [sx + W * 0.08, sy + H * 0.35], [sx + W * 0.1, y - H * 0.05], 6), W * 0.035, pal.shade, 0.35); }
  // Ink along the top, heavier on the lit side.
  ink(g, curve(L, [x - W * 0.33, y - H * 0.75], [P[0] - W * 0.16, P[1]], P), W * 0.045, INK, 0.95, true, false);
  ink(g, curve(P, [P[0] + W * 0.16, P[1]], [x + W * 0.3, y - H * 0.55], [x + W * 0.42, y - H * 0.12]), W * 0.03, INK, 0.8, false, true);
}
function ridge(g, x, y, L, rnd, pal) {
  const pts = []; const n = 10; let yy = y;
  for (let i = 0; i <= n; i++) { yy += (rnd() - 0.5) * L * 0.05; pts.push([x - L / 2 + (L * i) / n, yy - Math.sin((i / n) * Math.PI) * L * 0.05]); }
  const depth = L * (0.07 + rnd() * 0.05);
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts) g.lineTo(p[0], p[1]);
  for (let i = pts.length - 1; i >= 0; i--) g.lineTo(pts[i][0] + L * 0.01, pts[i][1] + depth * (0.4 + 0.6 * Math.sin((i / n) * Math.PI)));
  g.closePath();
  const gr = g.createLinearGradient(0, y - depth, 0, y + depth); gr.addColorStop(0, pal.dark + 'cc'); gr.addColorStop(1, pal.dark + '00');
  g.fillStyle = gr; g.fill();
  for (let i = 1; i < n; i += 1 + Math.floor(rnd() * 2)) ink(g, [[pts[i][0], pts[i][1] + 1], [pts[i][0] + L * 0.015, pts[i][1] + depth * (0.4 + rnd() * 0.5)]], L * 0.012, INK, 0.45);
  ink(g, pts, L * 0.022, INK, 0.9);
}
/** An irregular, lobed crown outline (not a circle): bumps of uneven size around the edge. */
function lobedPath(x, y, r, rnd) {
  const path = new Path2D(); const N = 26, lobes = 5 + Math.floor(rnd() * 4), ph = rnd() * 6.28;
  const pts = [];
  for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; const rr = r * (0.8 + 0.2 * Math.abs(Math.sin(a * lobes / 2 + ph)) + (rnd() - 0.5) * 0.12); pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.92]); }
  pts.forEach((pt, i) => { const nx = pts[(i + 1) % N]; const mx = (pt[0] + nx[0]) / 2, my = (pt[1] + nx[1]) / 2; i ? path.quadraticCurveTo(pt[0], pt[1], mx, my) : path.moveTo(mx, my); });
  path.closePath(); return path;
}
/**
 * A canopy of crowns drawn as one mass: ink on the outer edge only, a dark
 * understorey, crowns lit from the top left, and small cupped strokes that
 * suggest the tops of bushes inside the mass.
 */
function canopyMass(g, pts, pal, rnd) {
  const crowns = pts.map(([x, y, r, seed]) => { const rr = seed === undefined ? rnd : mulberry(seed); return { x, y, r, rr, path: lobedPath(x, y, r, rr), top: lobedPath(x - r * 0.1, y - r * 0.14, r * 0.8, rr) } }).sort((a, b) => a.y - b.y);
  g.save(); g.strokeStyle = pal.ink; g.lineJoin = 'round';
  for (const c of crowns) { g.lineWidth = Math.min(c.r * 0.2, 2.4); g.stroke(c.path); }
  g.fillStyle = pal.dark; for (const c of crowns) g.fill(c.path);
  for (const c of crowns) {
    g.fillStyle = pal.mid; g.fill(c.top);
    const lg = g.createRadialGradient(c.x - c.r * 0.35, c.y - c.r * 0.4, 0, c.x - c.r * 0.35, c.y - c.r * 0.4, c.r * 0.9);
    lg.addColorStop(0, pal.light + '66'); lg.addColorStop(1, pal.light + '00'); g.fillStyle = lg; g.fill(c.top);
    // Cupped strokes: the outline of the next bush down.
    const k = 1 + Math.floor(c.rr() * 2);
    for (let i = 0; i < k; i++) { const ax = c.x + (c.rr() - 0.5) * c.r * 0.9, ay = c.y + c.r * (0.15 + c.rr() * 0.35), ar = c.r * (0.25 + c.rr() * 0.2);
      g.beginPath(); g.arc(ax, ay - ar, ar, Math.PI * 0.15, Math.PI * 0.85); g.lineWidth = Math.min(c.r * 0.09, 1.4); g.globalAlpha = 0.45; g.stroke(); g.globalAlpha = 1; }
  }
  g.restore();
}
function crownCluster(x, y, s, rnd) {
  const n = 2 + Math.floor(rnd() * 3); const out = [];
  for (let i = 0; i < n; i++) out.push([x + (rnd() - 0.5) * s * 0.5, y - s * (0.7 + rnd() * 0.3), s * (0.3 + rnd() * 0.14)]);
  return out;
}
function tree(g, x, y, s, rnd, pal) {
  softShadow(g, x + s * 0.25, y, s * 0.6, s * 0.18, 0.22);
  ink(g, [[x, y], [x + s * 0.02, y - s * 0.5]], s * 0.1, '#4a3524', 0.9, false, false);
  canopyMass(g, crownCluster(x, y, s, rnd), pal, rnd);
}
function conifer(g, x, y, s, rnd, pal) {
  softShadow(g, x + s * 0.25, y, s * 0.45, s * 0.14, 0.25);
  ink(g, [[x, y], [x, y - s * 0.25]], s * 0.08, '#4a3524', 1, false, false);
  for (let t = 0; t < 3; t++) { const by = y - s * (0.18 + t * 0.28), w = s * (0.42 - t * 0.1), ty = by - s * 0.42;
    g.beginPath(); g.moveTo(x - w, by); g.lineTo(x, ty); g.lineTo(x + w, by); g.quadraticCurveTo(x, by - s * 0.06, x - w, by); g.closePath();
    const gr = g.createLinearGradient(x - w, 0, x + w, 0); gr.addColorStop(0, pal.mid); gr.addColorStop(1, pal.dark); g.fillStyle = gr; g.fill();
    g.lineWidth = s * 0.05; g.strokeStyle = pal.ink; g.stroke(); }
}
function dune(g, x, y, W, rnd) {
  const H = W * (0.12 + rnd() * 0.1);
  const top = curve([x - W / 2, y], [x - W * 0.2, y - H * 1.3], [x + W * 0.15, y - H * 1.2], [x + W / 2, y + H * 0.1], 16);
  g.beginPath(); g.moveTo(top[0][0], top[0][1]); for (const p of top) g.lineTo(p[0], p[1]); g.lineTo(x + W * 0.3, y + H * 0.25); g.closePath();
  const gr = g.createLinearGradient(x, y - H, x + W * 0.2, y + H * 0.3); gr.addColorStop(0, 'rgba(150,110,60,0.0)'); gr.addColorStop(1, 'rgba(150,110,60,0.45)'); g.fillStyle = gr; g.fill();
  ink(g, top, W * 0.03, '#5a4630', 0.85);
}
function sandPeak(g, x, y, W, rnd) {
  const H = W * (0.45 + rnd() * 0.35); const px = x + (rnd() - 0.4) * W * 0.2;
  const L = [x - W / 2, y], P = [px, y - H], R = [x + W / 2, y + W * 0.02];
  g.beginPath(); g.moveTo(L[0], L[1]); g.lineTo(px - W * 0.12, y - H * 0.55); g.lineTo(P[0], P[1]); g.lineTo(px + W * 0.18, y - H * 0.5); g.lineTo(R[0], R[1]); g.closePath();
  g.fillStyle = '#ecd29c'; g.fill();
  g.beginPath(); g.moveTo(P[0], P[1]); g.lineTo(px + W * 0.18, y - H * 0.5); g.lineTo(R[0], R[1]); g.lineTo(px + W * 0.05, y); g.closePath(); g.fillStyle = 'rgba(160,115,60,0.35)'; g.fill();
  for (let i = 0; i < 5; i++) { const t = 0.2 + i * 0.15; const sx = px + (R[0] - px) * t * 0.7, sy = P[1] + (y - P[1]) * t; ink(g, [[sx, sy], [sx + W * 0.06, sy + H * 0.18]], W * 0.025, '#6b4f2e', 0.55); }
  ink(g, [L, [px - W * 0.12, y - H * 0.55], P], W * 0.04, INK, 0.9, true, false);
  ink(g, [P, [px + W * 0.18, y - H * 0.5], [x + W * 0.38, y - H * 0.06]], W * 0.03, INK, 0.75, false, true);
  ink(g, [P, [px + W * 0.02, y - H * 0.5], [px + W * 0.08, y - H * 0.1]], W * 0.02, INK, 0.45);
}
function snowPeak(g, x, y, W, rnd) {
  const H = W * (0.6 + rnd() * 0.4); const px = x + (rnd() - 0.5) * W * 0.15;
  const pts = [[x - W / 2, y], [px - W * 0.22, y - H * 0.45], [px - W * 0.08, y - H * 0.7], [px, y - H], [px + W * 0.12, y - H * 0.72], [px + W * 0.2, y - H * 0.6], [x + W / 2, y]];
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts) g.lineTo(p[0], p[1]); g.closePath();
  const gr = g.createLinearGradient(0, y - H, 0, y); gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#e6edf2'); g.fillStyle = gr; g.fill();
  // Shadow face with soft blue-grey strokes.
  g.save(); g.clip();
  g.beginPath(); g.moveTo(px, y - H); g.lineTo(px + W * 0.04, y - H * 0.4); g.lineTo(px - W * 0.05, y); g.lineTo(x + W / 2, y); g.closePath();
  const sg = g.createLinearGradient(px, 0, x + W / 2, 0); sg.addColorStop(0, 'rgba(110,135,160,0.75)'); sg.addColorStop(1, 'rgba(150,170,190,0.35)'); g.fillStyle = sg; g.fill();
  for (let i = 0; i < 4; i++) ink(g, [[px + W * (0.04 + i * 0.07), y - H * (0.75 - i * 0.12)], [px + W * (0.02 + i * 0.09), y - H * (0.3 - i * 0.05)]], W * 0.03, '#5d7890', 0.35);
  // Base fades into the snow, inside the peak only.
  const fg = g.createLinearGradient(0, y - H * 0.25, 0, y); fg.addColorStop(0, 'rgba(233,238,242,0)'); fg.addColorStop(1, 'rgba(233,238,242,0.95)'); g.fillStyle = fg; g.fillRect(x - W / 2, y - H * 0.25, W, H * 0.26);
  g.restore();
  ink(g, pts.slice(0, 4), W * 0.04, INK, 0.95, true, false);
  ink(g, pts.slice(3, 6).concat([[x + W * 0.38, y - H * 0.12]]), W * 0.032, INK, 0.85, false, true);
  ink(g, [[px, y - H], [px + W * 0.04, y - H * 0.55], [px - W * 0.02, y - H * 0.25]], W * 0.02, INK, 0.5);
}
function crystal(g, x, y, W, H, rnd, broken) {
  const tipY = broken ? y - H * 0.82 : y - H;
  const tip = [x + (rnd() - 0.5) * W * 0.2, tipY];
  const l = [x - W / 2, y - H * 0.72], r = [x + W / 2, y - H * 0.76], bl = [x - W * 0.45, y + W * 0.1], br = [x + W * 0.48, y + W * 0.1], mid = [x + W * 0.05, y - H * 0.78];
  const top = broken ? [[l[0] + W * 0.1, tipY + W * 0.12], [x - W * 0.05, tipY], [x + W * 0.12, tipY + W * 0.2], [r[0] - W * 0.08, tipY + W * 0.05]] : [tip];
  const outline = [bl, l, ...top, r, br];
  g.beginPath(); g.moveTo(bl[0], bl[1]); for (const q of outline) g.lineTo(q[0], q[1]); g.closePath();
  const gr = g.createLinearGradient(x - W / 2, 0, x + W / 2, 0); gr.addColorStop(0, '#b7ecf3'); gr.addColorStop(0.48, '#8fd6e4'); gr.addColorStop(0.52, '#4fb0c6'); gr.addColorStop(1, '#3b8fa8');
  g.globalAlpha = 0.94; g.fillStyle = gr; g.fill(); g.globalAlpha = 1;
  // Inner facets and a cold highlight.
  ink(g, [[x - W * 0.22, y - H * 0.05], [x - W * 0.18, y - H * 0.6]], W * 0.07, '#effcff', 0.75);
  ink(g, [[mid[0], mid[1]], [x + W * 0.02, y]], W * 0.035, '#1e4b57', 0.6);
  if (!broken) ink(g, [tip, mid], W * 0.035, '#1e4b57', 0.6);
  g.lineJoin = 'round'; g.strokeStyle = '#1e4b57'; g.lineWidth = Math.min(Math.max(Math.min(1, W * 0.15), W * 0.07), 2.8);
  g.beginPath(); g.moveTo(bl[0], bl[1]); for (const q of outline) g.lineTo(q[0], q[1]); g.stroke();
}
/** A cluster of ice spires fanning out from one root, leaning and uneven, buried in a drift. */
function iceSpires(g, x, y, s, rnd) {
  const n = 6 + Math.floor(rnd() * 3); const spires = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * 2 - 1; // -1 left … 1 right
    const centre = 1 - Math.abs(t);
    spires.push({ dx: t * 70 * s + (rnd() - 0.5) * 14 * s, h: (60 + centre * 120 + rnd() * 40) * s, w: (22 + centre * 22 + rnd() * 8) * s,
      a: t * 0.42 + (rnd() - 0.5) * 0.22, broken: rnd() < 0.25 && centre < 0.7, depth: rnd() });
  }
  // Outer, shorter spires behind; the tall centre ones in front.
  spires.sort((p, q) => p.h - q.h);
  for (const sp of spires) { g.save(); g.translate(x + sp.dx, y + sp.depth * 6 * s); g.rotate(sp.a); crystal(g, 0, 0, sp.w, sp.h, rnd, sp.broken); g.restore(); }
  // The drift they grow from.
  const L = 110 * s; const pts = [];
  for (let i = 0; i <= 16; i++) { const t = i / 16; pts.push([x - L + 2 * L * t, y - Math.sin(t * Math.PI) * 16 * s - (rnd() - 0.3) * 7 * s]); }
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const q of pts) g.lineTo(q[0], q[1]); g.lineTo(x + L, y + 22 * s); g.lineTo(x - L, y + 22 * s); g.closePath();
  const dg = g.createLinearGradient(0, y - 20 * s, 0, y + 22 * s); dg.addColorStop(0, '#ffffff'); dg.addColorStop(0.55, 'rgba(240,244,247,0.9)'); dg.addColorStop(1, 'rgba(231,237,241,0)'); g.fillStyle = dg; g.fill();
  for (let i = 2; i < 15; i += 3) ink(g, [pts[i], [pts[i][0] + 10 * s, pts[i][1] + 8 * s]], 2.2 * s, '#7d93a8', 0.35);
  ink(g, pts.slice(1, 9), 2.4 * s, INK, 0.75); ink(g, pts.slice(9, 16), 1.8 * s, INK, 0.55);
}
function cone(g, x, y, W, rnd, active) {
  const H = W * (0.5 + rnd() * 0.15), cw = W * 0.13;
  const L = [x - W / 2, y], R = [x + W / 2, y], TL = [x - cw, y - H], TR = [x + cw, y - H * 0.98];
  g.beginPath(); g.moveTo(L[0], L[1]); g.quadraticCurveTo(x - W * 0.2, y - H * 0.35, TL[0], TL[1]); g.quadraticCurveTo(x, y - H * 1.05, TR[0], TR[1]); g.quadraticCurveTo(x + W * 0.22, y - H * 0.35, R[0], R[1]); g.closePath();
  const gr = g.createLinearGradient(x - W / 2, 0, x + W / 2, 0); gr.addColorStop(0, '#7d6c61'); gr.addColorStop(0.55, '#57493f'); gr.addColorStop(1, '#3a302a'); g.fillStyle = gr; g.fill();
  for (let i = 0; i < 4; i++) ink(g, [[x + cw * (0.3 + i * 0.4), y - H * 0.9], [x + W * (0.08 + i * 0.09), y - H * 0.1]], W * 0.02, '#2b221d', 0.4);
  if (active) {
    const gl = g.createRadialGradient(x, y - H, 0, x, y - H, W * 0.35); gl.addColorStop(0, 'rgba(255,170,60,0.55)'); gl.addColorStop(1, 'rgba(255,120,40,0)'); g.fillStyle = gl; g.fillRect(x - W * 0.4, y - H - W * 0.35, W * 0.8, W * 0.6);
    for (let k = 0; k < 4; k++) { let px = x + (rnd() - 0.5) * cw * 1.4, py = y - H * 0.97; const pts = [[px, py]]; const dir = (rnd() - 0.5) * 1.6;
      for (let s = 0; s < 7; s++) { px += dir * W * 0.03 + (rnd() - 0.5) * W * 0.04; py += H * (0.07 + rnd() * 0.06); pts.push([px, py]); }
      ink(g, pts, W * 0.05, '#c8471c', 0.95); ink(g, pts, W * 0.022, '#ffb347', 0.95); }
    g.fillStyle = '#ff9f3a'; g.beginPath(); g.ellipse(x, y - H * 0.99, cw * 0.95, W * 0.03, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffe08a'; g.beginPath(); g.ellipse(x - cw * 0.15, y - H, cw * 0.5, W * 0.016, 0, 0, Math.PI * 2); g.fill();
    for (let k = 0; k < 4; k++) { const sx = x + (rnd() - 0.3) * W * 0.25, sy = y - H - W * (0.12 + k * 0.1), r = W * (0.08 + k * 0.03); const sg = g.createRadialGradient(sx, sy, 0, sx, sy, r); sg.addColorStop(0, 'rgba(90,85,80,0.28)'); sg.addColorStop(1, 'rgba(90,85,80,0)'); g.fillStyle = sg; g.fillRect(sx - r, sy - r, r * 2, r * 2); }
  } else {
    g.fillStyle = '#2b231e'; g.beginPath(); g.ellipse(x, y - H * 0.99, cw * 0.9, W * 0.025, 0, 0, Math.PI * 2); g.fill();
  }
  ink(g, [L, [x - W * 0.22, y - H * 0.4], TL], W * 0.035, INK, 0.95, true, false);
  ink(g, [TR, [x + W * 0.24, y - H * 0.38], [x + W * 0.42, y - H * 0.05]], W * 0.03, INK, 0.85, false, true);
  ink(g, [TL, [x, y - H * 1.03], TR], W * 0.025, INK, 0.9);
}
function darkPeak(g, x, y, W, rnd) {
  const H = W * (0.45 + rnd() * 0.3), px = x + (rnd() - 0.5) * W * 0.2;
  g.beginPath(); g.moveTo(x - W / 2, y); g.lineTo(px - W * 0.1, y - H * 0.6); g.lineTo(px, y - H); g.lineTo(px + W * 0.15, y - H * 0.55); g.lineTo(x + W / 2, y); g.closePath();
  const gr = g.createLinearGradient(x - W / 2, 0, x + W / 2, 0); gr.addColorStop(0, '#8a7a70'); gr.addColorStop(0.5, '#635449'); gr.addColorStop(1, '#4a3d35'); g.fillStyle = gr; g.fill();
  ink(g, [[x - W / 2, y], [px - W * 0.1, y - H * 0.6], [px, y - H]], W * 0.035, INK, 0.9, true, false);
  ink(g, [[px, y - H], [px + W * 0.15, y - H * 0.55], [x + W * 0.38, y - H * 0.06]], W * 0.028, INK, 0.75, false, true);
}
function fissure(g, x, y, L, rnd) {
  const pts = []; let px = x, py = y; const a = (rnd() - 0.5) * 1.2;
  for (let i = 0; i < 9; i++) { pts.push([px, py]); px += Math.cos(a) * L / 8 + (rnd() - 0.5) * L * 0.08; py += Math.sin(a) * L / 8 + (rnd() - 0.5) * L * 0.08; }
  g.save(); g.shadowColor = 'rgba(255,120,40,0.8)'; g.shadowBlur = L * 0.12; ink(g, pts, L * 0.06, '#b8401a', 0.9); g.restore();
  ink(g, pts, L * 0.025, '#ffb04a', 0.95);
}


// ── Ink set: flat two-tone fills and bold black outlines ──────────────────
const K = '#151515';
function strokePath(g, pts, w, color = K, close = false) { g.save(); g.strokeStyle = color; g.lineWidth = w; g.lineJoin = 'round'; g.lineCap = 'round'; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const q of pts) g.lineTo(q[0], q[1]); if (close) g.closePath(); g.stroke(); g.restore(); }
function fillPoly(g, pts, color) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const q of pts) g.lineTo(q[0], q[1]); g.closePath(); g.fillStyle = color; g.fill(); }
/** One angular peak: light face and shadow face split down the ridge, inked silhouette, a crease or two. */
function inkPeak(g, x, y, W, rnd, tone) {
  const H = W * (0.38 + rnd() * 0.38), px = x + (rnd() - 0.45) * W * 0.3;
  const sL = [x - W * (0.24 + rnd() * 0.1), y - H * (0.42 + rnd() * 0.18)], sR = [x + W * (0.2 + rnd() * 0.12), y - H * (0.38 + rnd() * 0.22)];
  // Jagged shoulders: a notch or two on each side of the peak.
  const jL = [(sL[0] + px) / 2 + W * 0.03, (sL[1] + y - H) / 2 + H * 0.08], jR = [(sR[0] + px) / 2 - W * 0.02, (sR[1] + y - H) / 2 + H * (0.06 + rnd() * 0.08)];
  const L = [x - W / 2, y], R = [x + W / 2, y], P = [px, y - H], foot = [px + W * (0.05 + rnd() * 0.1), y];
  fillPoly(g, [L, sL, jL, P, foot], tone.light);
  fillPoly(g, [P, jR, sR, R, foot], tone.dark);
  const lw = Math.min(Math.max(Math.min(1.2, W * 0.08), W * 0.035), 2.6);
  strokePath(g, [L, sL, jL, P, jR, sR, R], lw);
  strokePath(g, [P, [px + W * 0.03, y - H * 0.55], [foot[0] - W * 0.02, y - H * 0.1]], lw * 0.7);
  if (rnd() < 0.7) { const t = 0.3 + rnd() * 0.3; strokePath(g, [[sR[0] - W * 0.05, sR[1] + H * 0.05], [sR[0] - W * 0.02 + (R[0] - sR[0]) * t * 0.3, sR[1] + H * 0.3]], lw * 0.6); }
  return P;
}
/** Forest as one mass: scalloped inked edge, flat green, cupped crown marks inside. */
function inkForest(g, pts, rnd, pal) {
  g.save(); g.strokeStyle = K;
  for (const [x, y, r] of pts) { g.lineWidth = Math.min(2.4, Math.max(0.5, r * 0.4)); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = pal.mid; for (const [x, y, r] of pts) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
  const sorted = pts.slice().sort((a, b) => a[1] - b[1]);
  for (const [x, y, r, seed] of sorted) {
    const rnd2 = seed === undefined ? rnd : mulberry(seed)
    if (rnd2() < 0.18) { g.fillStyle = pal.dark; g.beginPath(); g.arc(x + r * 0.15, y + r * 0.2, r * 0.75, 0.1 * Math.PI, 0.95 * Math.PI); g.fill(); }
    if (rnd2() < 0.3) { g.lineWidth = Math.min(1.3, Math.max(0.4, r * 0.22)); g.beginPath(); g.arc(x, y + r * 0.35, r * 0.62, 1.15 * Math.PI, 1.85 * Math.PI); g.stroke(); }
  }
  g.restore();
}
function lollipop(g, x, y, s, rnd, pal) {
  const lw = Math.min(1.4, Math.max(0.5, s * 0.12));
  strokePath(g, [[x, y], [x, y - s * 0.55]], lw);
  const r = s * 0.42, cy = y - s * 0.8;
  g.fillStyle = pal.mid; g.beginPath(); g.arc(x, cy, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = pal.dark; g.beginPath(); g.arc(x + r * 0.2, cy + r * 0.2, r * 0.75, 0.05 * Math.PI, 0.9 * Math.PI); g.fill();
  g.strokeStyle = K; g.lineWidth = lw; g.beginPath(); g.arc(x, cy, r, 0, Math.PI * 2); g.stroke();
}
function deadTree(g, x, y, s, rnd) {
  const lw = Math.min(1.6, Math.max(0.5, s * 0.1));
  strokePath(g, [[x, y], [x + s * 0.05, y - s * 0.9]], lw);
  for (let i = 0; i < 4; i++) { const t = 0.35 + i * 0.15, bx = x + s * 0.05 * t, by = y - s * 0.9 * t, d = i % 2 ? 1 : -1; strokePath(g, [[bx, by], [bx + d * s * (0.2 + rnd() * 0.15), by - s * (0.15 + rnd() * 0.1)]], lw * 0.75); }
}
function inkHill(g, x, y, W, rnd, tone) {
  const H = W * (0.3 + rnd() * 0.15), P = [x + (rnd() - 0.5) * W * 0.2, y - H];
  const top = curve([x - W / 2, y], [x - W * 0.3, y - H * 0.9], [P[0] - W * 0.12, P[1]], P, 8).concat(curve(P, [P[0] + W * 0.14, P[1]], [x + W * 0.32, y - H * 0.6], [x + W / 2, y], 8));
  fillPoly(g, top, tone.light);
  fillPoly(g, curve(P, [P[0] + W * 0.14, P[1]], [x + W * 0.32, y - H * 0.6], [x + W / 2, y], 8).concat([[P[0] + W * 0.08, y]]), tone.dark);
  strokePath(g, top.slice(0, 13), Math.min(Math.max(Math.min(1.2, W * 0.08), W * 0.04), 2.4));
}
function inkCliff(g, x, y, L, rnd) {
  const pts = []; let yy = y;
  for (let i = 0; i <= 12; i++) { yy += (rnd() - 0.5) * L * 0.04; pts.push([x - L / 2 + (L * i) / 12, yy + Math.sin(i * 1.3 + rnd()) * L * 0.02]); }
  const band = pts.map(([px, py], i) => [px + L * 0.012, py + L * (0.04 + 0.05 * Math.sin((i / 12) * Math.PI))]);
  fillPoly(g, pts.concat(band.reverse()), '#7c6741');
  strokePath(g, pts, Math.min(2.6, Math.max(0.6, L * 0.08)));
}
function lavaCap(g, P, W, rnd) {
  const c = [[P[0] - W * 0.12, P[1] + W * 0.12], [P[0] - W * 0.04, P[1] + W * 0.02], [P[0] + W * 0.06, P[1] + W * 0.03], [P[0] + W * 0.14, P[1] + W * 0.14], [P[0] + W * 0.03, P[1] + W * 0.09]];
  fillPoly(g, c, '#e2461d'); fillPoly(g, c.slice(1, 4).concat([[P[0] + W * 0.02, P[1] + W * 0.06]]), '#ff8a3a'); strokePath(g, c, Math.min(1.6, Math.max(0.5, W * 0.06)), K, true);
}
/** A glacier shard: thin, tilted, two flat cyans, inked. */
function shard(g, x, y, W, H, a, rnd) {
  g.save(); g.translate(x, y); g.rotate(a);
  const tip = [(rnd() - 0.5) * W * 0.3, -H], l = [-W / 2, -H * (0.55 + rnd() * 0.2)], r = [W / 2, -H * (0.5 + rnd() * 0.25)], m = [W * 0.05, -H * 0.62];
  fillPoly(g, [[-W * 0.42, 0], l, tip, m, [W * 0.05, 0]], '#bfeef5');
  fillPoly(g, [[W * 0.05, 0], m, tip, r, [W * 0.45, 0]], '#5fb7cc');
  strokePath(g, [[-W * 0.42, 0], l, tip, r, [W * 0.45, 0]], Math.min(Math.max(1.1, W * 0.08), 2.4));
  strokePath(g, [tip, m, [W * 0.05, -H * 0.1]], 1);
  g.restore();
}

/** A wandering, branching path for veins and cracks: returns polylines, the trunk first. */
function veinPaths(x, y, L, rnd, branches) {
  const walk = (sx, sy, a, len, steps) => { const pts = [[sx, sy]]; let px = sx, py = sy; for (let i = 0; i < steps; i++) { a += (rnd() - 0.5) * 0.7; px += Math.cos(a) * len / steps; py += Math.sin(a) * len / steps; pts.push([px, py]); } return pts; };
  const a0 = rnd() * Math.PI * 2;
  const trunk = walk(x - Math.cos(a0) * L / 2, y - Math.sin(a0) * L / 2, a0, L, 10);
  const out = [trunk];
  for (let b = 0; b < branches; b++) { const i = 2 + Math.floor(rnd() * 6); const [bx, by] = trunk[i]; out.push(walk(bx, by, a0 + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.7), L * (0.25 + rnd() * 0.3), 5)); }
  return out;
}
/** Lava: a black edge, flat orange, a hot core, tapering along the flow. */
function lavaLine(g, pts, w) {
  // Own taper (no pen-width cap), so the black edge, the orange and the hot core stay nested.
  for (const [color, k] of [[K, 1.7], ['#e2461d', 1.05], ['#ffb04a', 0.38]]) {
    g.save(); g.strokeStyle = color; g.lineCap = 'round'; g.lineJoin = 'round';
    for (let i = 1; i < pts.length; i++) { const t = i / (pts.length - 1); g.lineWidth = Math.max(0.6, w * k * (1 - t * 0.65)); g.beginPath(); g.moveTo(pts[i - 1][0], pts[i - 1][1]); g.lineTo(pts[i][0], pts[i][1]); g.stroke(); }
    g.restore();
  }
}
function inkLava(g, x, y, L, rnd) {
  const w = Math.max(1.8, L * 0.035);
  for (const path of veinPaths(x, y, L, rnd, 1 + Math.floor(rnd() * 3))) lavaLine(g, path, w * (path.length > 6 ? 1 : 0.65));
}
/** A dry fissure: a jagged black crack with a brown lip below it. */
function inkFissure(g, x, y, L, rnd) {
  const w = Math.max(1.4, L * 0.04);
  for (const path of veinPaths(x, y, L, rnd, 1 + Math.floor(rnd() * 2))) {
    const jag = path.map(([px, py], i) => [px + (i % 2 ? 1 : -1) * L * 0.012, py]);
    ink(g, jag.map(([px, py]) => [px + w * 0.4, py + w * 0.6]), w * 1.2, '#7c6741', 0.8, false, true);
    ink(g, jag, w * (path.length > 6 ? 1 : 0.7), K, 1, false, true);
  }
}
/** An ink volcano: crater cone in two ash tones; active ones glow in the crater and pour lava veins down the slopes. */
function inkVolcano(g, x, y, W, rnd, active) {
  const H = W * (0.5 + rnd() * 0.12), cw = W * 0.14;
  const L = [x - W / 2, y], R = [x + W / 2, y], TL = [x - cw, y - H], TR = [x + cw, y - H * 0.97], foot = [x + W * 0.06, y];
  const left = [L, ...curve(L, [x - W * 0.3, y - H * 0.25], [x - W * 0.18, y - H * 0.7], TL, 8).slice(1), [x, y - H * 1.01], foot];
  const right = [[x, y - H * 1.01], TR, ...curve(TR, [x + W * 0.18, y - H * 0.7], [x + W * 0.3, y - H * 0.25], R, 8).slice(1), foot];
  fillPoly(g, left, '#857d77');
  fillPoly(g, right, '#524b46');
  const lw = Math.min(Math.max(Math.min(1.3, W * 0.08), W * 0.03), 2.6);
  strokePath(g, curve(L, [x - W * 0.3, y - H * 0.25], [x - W * 0.18, y - H * 0.7], TL, 8), lw);
  strokePath(g, curve(TR, [x + W * 0.18, y - H * 0.7], [x + W * 0.3, y - H * 0.25], R, 8), lw);
  for (let i = 0; i < 3; i++) strokePath(g, [[x + cw * (0.4 + i * 0.5), y - H * 0.88], [x + W * (0.1 + i * 0.09), y - H * (0.3 - i * 0.06)]], lw * 0.55);
  // Crater.
  g.beginPath(); g.ellipse(x, y - H * 0.985, cw * 1.05, W * 0.035, 0, 0, Math.PI * 2);
  g.fillStyle = active ? '#e2461d' : '#2b2420'; g.fill(); g.lineWidth = lw; g.strokeStyle = K; g.stroke();
  if (active) {
    g.beginPath(); g.ellipse(x - cw * 0.15, y - H * 0.995, cw * 0.55, W * 0.016, 0, 0, Math.PI * 2); g.fillStyle = '#ffb04a'; g.fill();
    // Lava veins down the slopes, some splitting.
    const n = 3 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      let px = x + (rnd() - 0.5) * cw * 1.6, py = y - H * 0.97; const pts = [[px, py]]; const dir = (px - x) / cw + (rnd() - 0.5) * 0.8;
      const steps = 8 + Math.floor(rnd() * 4);
      for (let s = 0; s < steps; s++) { px += dir * W * 0.03 + (rnd() - 0.5) * W * 0.03; py += H * (0.08 + rnd() * 0.05); if (py > y - H * 0.04) break; pts.push([px, py]); }
      lavaLine(g, pts, Math.max(1.6, W * 0.03));
      if (rnd() < 0.4 && pts.length > 4) { const [bx, by] = pts[2]; lavaLine(g, [[bx, by], [bx + dir * W * 0.08 + W * 0.04, by + H * 0.12], [bx + dir * W * 0.12 + W * 0.07, by + H * 0.25]], Math.max(1.2, W * 0.02)); }
    }
    // A little inked smoke.
    for (let k = 0; k < 2; k++) { const sx = x + (k - 0.3) * W * 0.12, sy = y - H - W * (0.12 + k * 0.11), r = W * (0.06 + k * 0.02);
      g.beginPath(); g.arc(sx, sy, r, 0, Math.PI * 2); g.fillStyle = '#9a938d'; g.fill(); g.lineWidth = lw * 0.7; g.strokeStyle = K; g.stroke(); }
  }
}

export { veinPaths, lavaLine, inkLava, inkFissure, inkVolcano, mulberry, ink, curve, softShadow, tick, hill, ridge, lobedPath, canopyMass, crownCluster, tree, conifer, dune, sandPeak, snowPeak, crystal, iceSpires, cone, darkPeak, fissure, strokePath, fillPoly, inkPeak, inkForest, lollipop, deadTree, inkHill, inkCliff, lavaCap, shard, INK, K }

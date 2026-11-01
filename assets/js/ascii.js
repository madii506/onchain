// The faint ASCII field behind the whole site (the banner's background, alive): a slow noise drawn through a character
// ramp. Rows are refreshed a band at a time so it flows without redrawing the whole screen each frame.
const RAMP = ' .·:-=+*%#';
const LAT = new Float32Array(256 * 256).map(() => Math.random());
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), tx = x - xi, ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const i = (a, b) => LAT[((b & 255) << 8) | (a & 255)];
  const a = i(xi, yi), b = i(xi + 1, yi), c = i(xi, yi + 1), d = i(xi + 1, yi + 1);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}
function fbm(x, y) { let v = 0, amp = .5, tot = 0, f = 1; for (let o = 0; o < 4; o++) { v += amp * noise(x * f + o * 13.1, y * f - o * 7.7); tot += amp; amp *= .5; f *= 2; } return v / tot; }

export function startAscii(canvas) {
  const g = canvas.getContext('2d', { alpha: false });
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, cw = 8, lh = 16, cols = 0, rows = 0, row = 0, raf = 0, last = 0, t0 = performance.now(), mx = -1e4, my = -1e4;
  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    W = innerWidth; H = innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fs = W < 700 ? 11 : 12;
    g.font = `400 ${fs}px JBM, ui-monospace, monospace`; g.textBaseline = 'top';
    cw = g.measureText('M').width || fs * .6; lh = Math.round(fs * 1.3);
    cols = Math.ceil(W / cw) + 1; rows = Math.ceil(H / lh) + 1;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) drawRow(r, (performance.now() - t0) / 1000);
  }
  function drawRow(r, t) {
    const y = r * lh;
    g.fillStyle = '#000'; g.fillRect(0, y, W, lh);
    for (let c = 0; c < cols; c++) {
      const q = fbm(c * .045 + t * .02, r * .11 - t * .012);
      let v = fbm(c * .028 + 2.4 * q + t * .015, r * .085 + 1.6 * q);
      v = (v - .45) / .32;
      const dx = (c * cw - mx) / 180, dy = (y - my) / 140, near = Math.exp(-(dx * dx + dy * dy));
      v = Math.max(v, 0) + near * .35;
      if (v < .1) continue;
      if (v > 1) v = 1;
      const ch = RAMP[Math.min(RAMP.length - 1, Math.round(v * (RAMP.length - 1)))];
      if (ch === ' ') continue;
      const k = Math.round(15 + 30 * v);
      g.fillStyle = `rgb(${k},${k},${k - 2})`;
      g.fillText(ch, c * cw, y);
    }
  }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (document.hidden || now - last < 70 || document.documentElement.classList.contains('locked')) return;   // paused under dialogs
    last = now;
    const t = (now - t0) / 1000;
    for (let k = 0; k < 2; k++) { drawRow(row, t); row = (row + 1) % rows; }
    // the rows around the pointer follow it at once (a soft lamp moving over the field)
    if (dirty.size) { for (const r of dirty) if (r >= 0 && r < rows) drawRow(r, t); dirty.clear(); }
  }
  const dirty = new Set(); let lastR = -1;
  function mark(r) { for (let k = -6; k <= 6; k++) dirty.add(r + k); }
  size();
  addEventListener('resize', () => { clearTimeout(size.t); size.t = setTimeout(size, 150); });
  addEventListener('pointermove', e => { mx = e.clientX; my = e.clientY; const r = Math.floor(my / lh); if (lastR >= 0) mark(lastR); mark(r); lastR = r; }, { passive: true });
  if (!still) raf = requestAnimationFrame(frame);
  return { stop() { cancelAnimationFrame(raf); } };
}

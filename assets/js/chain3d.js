// The ONCHAIN chain: white line-art links (patent-drawing style) on black. Each link is a flat oval washer with a
// reeded edge; solid faces hide the strokes behind them. Used by the intro (where a pen traces it) and the hero.
import * as THREE from './vendor/three.module.min.js';
import { LineSegments2 } from './vendor/LineSegments2.js';
import { LineSegmentsGeometry } from './vendor/LineSegmentsGeometry.js';
import { LineMaterial } from './vendor/LineMaterial.js';

export const HL = .3, RO = .56, RI = .37, T = .17, PITCH = 1.18;
const N = 200;                                         // segments per outline

function stadium(hl, r, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const a = Math.PI / 2 - Math.PI * i / n; pts.push([hl + r * Math.cos(a), r * Math.sin(a)]); }
  for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 - Math.PI * i / n; pts.push([-hl + r * Math.cos(a), r * Math.sin(a)]); }
  return pts;
}
function along(hl, r, n) {
  const p = [], per = 4 * hl + 2 * Math.PI * r;
  for (let i = 0; i < n; i++) {
    let s = i / n * per;
    if (s < 2 * hl) { p.push([-hl + s, r]); continue; } s -= 2 * hl;
    if (s < Math.PI * r) { const a = Math.PI / 2 - s / r; p.push([hl + r * Math.cos(a), r * Math.sin(a)]); continue; } s -= Math.PI * r;
    if (s < 2 * hl) { p.push([hl - s, -r]); continue; } s -= 2 * hl;
    const a = -Math.PI / 2 - s / r; p.push([-hl + r * Math.cos(a), r * Math.sin(a)]);
  }
  return p;
}

// segment lists, ordered so a growing draw count traces all four outlines of a link at once, with the reeding
// ticks following the pen around the edge
const OO = along(HL, RO, N), II = along(HL, RI, N);
const MAIN = [];
for (let i = 0; i < N; i++) {
  const j = (i + 1) % N;
  for (const [P, z] of [[OO, T / 2], [OO, -T / 2], [II, T / 2], [II, -T / 2]]) MAIN.push(P[i][0], P[i][1], z, P[j][0], P[j][1], z);
}
const TICKS = [...along(HL, RO, 64).map((p, k) => [k / 64, p]), ...along(HL, RI, 40).map((p, k) => [k / 40, p])].sort((a, b) => a[0] - b[0]);
const HAT = []; TICKS.forEach(([, [x, y]]) => HAT.push(x, y, T / 2, x, y, -T / 2));
const TICKF = TICKS.map(t => t[0]);

export function createChain(canvas, { links = 3, line = 2.2, hatch = 1.1, roll = .62, fill = true } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(24, 1, .1, 200);
  cam.position.set(0, 0, 10);

  const shape = new THREE.Shape(); const o = stadium(HL, RO, 48);
  shape.moveTo(o[0][0], o[0][1]); o.slice(1).forEach(([x, y]) => shape.lineTo(x, y)); shape.closePath();
  const hole = new THREE.Path(); const h = stadium(HL, RI, 48).reverse();
  hole.moveTo(h[0][0], h[0][1]); h.slice(1).forEach(([x, y]) => hole.lineTo(x, y)); hole.closePath(); shape.holes.push(hole);
  const solidGeo = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 48 }); solidGeo.translate(0, 0, -T / 2);
  // faces: black, or depth-only (they still hide the strokes behind them but let the background show through)
  const black = new THREE.MeshBasicMaterial({ color: 0x000000, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2, colorWrite: fill });
  const mainMat = new LineMaterial({ color: 0xf4f4f0, linewidth: line, worldUnits: false, transparent: true });
  const hatMat = new LineMaterial({ color: 0xbdbdb6, linewidth: hatch, worldUnits: false, transparent: true });

  const group = new THREE.Group(); group.rotation.order = 'ZYX'; scene.add(group);
  const list = [], geos = [];
  for (let k = 0; k < links; k++) {
    const mg = new LineSegmentsGeometry(); mg.setPositions(MAIN);
    const hg = new LineSegmentsGeometry(); hg.setPositions(HAT);
    geos.push([mg, hg]);
    const g = new THREE.Group();
    g.add(new THREE.Mesh(solidGeo, black));
    g.add(new LineSegments2(mg, mainMat)); g.add(new LineSegments2(hg, hatMat));
    g.position.x = (k - (links - 1) / 2) * PITCH; g.rotation.x = (k % 2 ? Math.PI / 2 : 0) + roll;
    group.add(g); list.push(g);
  }

  function resize() {
    const w = canvas.clientWidth || 1, hgt = canvas.clientHeight || 1, dpr = Math.min(devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr); renderer.setSize(w, hgt, false);
    cam.aspect = w / hgt; cam.updateProjectionMatrix();
    mainMat.resolution.set(w * dpr, hgt * dpr); hatMat.resolution.set(w * dpr, hgt * dpr);
    mainMat.linewidth = line * dpr; hatMat.linewidth = hatch * dpr;
  }
  // camera distance that fits a box of w x h world units into the given share of the view
  function fit(w, h, share = .7) {
    const t = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    return Math.max(h / share / (2 * t), w / share / (2 * t * cam.aspect));
  }
  // p in 0..1: how much of each link the pen has drawn; links start one after another
  function trace(p, stagger = .16) {
    const span = 1 - stagger * (links - 1);
    geos.forEach(([mg, hg], k) => {
      const q = Math.min(1, Math.max(0, (p - k * stagger) / span));
      mg.instanceCount = Math.floor(q * N) * 4;
      const qt = q - .03; let n = 0; while (n < TICKF.length && TICKF[n] <= qt) n++;
      hg.instanceCount = q >= 1 ? TICKF.length : n;
    });
  }
  resize();
  const render = () => renderer.render(scene, cam);
  const setOpacity = a => { mainMat.opacity = a; hatMat.opacity = a; };
  const setFill = on => { black.colorWrite = !!on; };
  const dispose = () => { solidGeo.dispose(); geos.forEach(([a, b]) => { a.dispose(); b.dispose(); }); mainMat.dispose(); hatMat.dispose(); black.dispose(); renderer.dispose(); };
  return { THREE, renderer, scene, cam, group, links: list, resize, fit, trace, render, setOpacity, setFill, dispose };
}

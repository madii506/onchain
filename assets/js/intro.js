// The intro, about 4 s, once per session: the ASCII field wakes up, a pen draws the chain, its faces fill in,
// one ring of light, then the name. Skippable. Never shown with reduced motion or when a shared link is opened.
const KEY = 'oc:intro';

export function wantIntro() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  if (/^#\//.test(location.hash) || /[?&]nointro\b/.test(location.search)) return false;
  try { if (sessionStorage.getItem(KEY)) return false; } catch {}
  return true;
}
export function dropIntro() {
  const el = document.getElementById('intro'); if (!el) return;
  el.classList.add('out'); setTimeout(() => el.remove(), 600);
}

const ease = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

export async function playIntro() {
  const el = document.getElementById('intro'); if (!el) return;
  try { sessionStorage.setItem(KEY, '1'); } catch {}
  el.insertAdjacentHTML('beforeend', '<canvas aria-hidden="true"></canvas><div class="ring" aria-hidden="true"></div><div class="word">ONCHAIN</div><div class="tag2">Off the chart. On chain.</div><button class="skip" type="button">Skip</button>');
  const cv = el.querySelector('canvas'), ring = el.querySelector('.ring'), word = el.querySelector('.word'), tag = el.querySelector('.tag2'), skip = el.querySelector('.skip');
  let ch;
  try {
    const mod = await Promise.race([import('./chain3d.js?v=3'), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 3500))]);
    ch = mod.createChain(cv, { links: 3, line: 2.3, hatch: 1.1, fill: false });
  } catch { return; }                                  // no WebGL or a slow line: straight to the site

  return new Promise(resolve => {
    let done = false, raf = 0, z = 12, t0 = 0, filled = false, worded = false, tagged = false;
    const g = ch.group;
    const place = () => {
      ch.resize(); z = ch.fit(4.15, 1.2, innerWidth < 700 ? .74 : .42);
      // the name sits under the drawn chain, whatever the screen
      const vh = 2 * z * Math.tan(12 * Math.PI / 180), half = .62 * innerHeight / vh;
      word.style.top = Math.round(innerHeight / 2 + half + 34) + 'px';
      tag.style.top = Math.round(innerHeight / 2 + half + 34 + 56) + 'px';
    };
    const finish = () => {
      if (done) return; done = true;
      el.classList.add('out'); resolve();
      setTimeout(() => { cancelAnimationFrame(raf); try { ch.dispose(); } catch {} el.remove(); }, 900);
    };
    skip.addEventListener('click', finish);
    addEventListener('keydown', e => { if (e.key === 'Escape') finish(); });
    addEventListener('resize', place);
    place();
    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (!t0) { t0 = now; el.classList.add('lift'); }
      const t = (now - t0) / 1000;
      ch.trace(ease(clamp((t - .25) / 1.95)));
      g.rotation.x = -.55 + t * .2;                    // the chain turns slowly around its own length
      g.rotation.y = .08 - t * .015;
      g.rotation.z = -.06;
      ch.cam.position.z = z * (1.1 - .1 * ease(clamp(t / 3.8)));
      if (!filled && t > 2.3) { filled = true; ch.setFill(true); ring.classList.add('go'); }
      if (!worded && t > 2.45) { worded = true; word.classList.add('in'); }
      if (!tagged && t > 2.8) { tagged = true; tag.classList.add('in'); }
      ch.render();
      if (t > 3.95) finish();
    }
    raf = requestAnimationFrame(frame);
  });
}

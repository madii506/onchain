// ONCHAIN front end: live pump.fun coins, any wallet's bags, the offer desk and the tape. Every number on the page
// comes from the API (pump.fun, Jupiter and the Solana chain); nothing here is simulated.
import { startAscii } from './ascii.js?v=3';
import * as W from './wallet.js?v=3';
import { wantIntro, playIntro, dropIntro } from './intro.js?v=5';

// ---------------------------------------------------------------- helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const B58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const findAddr = s => (String(s || '').match(B58) || [])[0] || '';
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const short = W.short;

function sig(n, d = 3) {
  if (!n) return '0';
  const a = Math.abs(n);
  if (a >= 1) return Number(n.toPrecision(d)).toLocaleString('en-US', { maximumFractionDigits: 6 });
  const z = Math.ceil(-Math.log10(a));                     // leading zeros after the point
  return n.toFixed(Math.min(18, z + d - 1)).replace(/0+$/, '');
}
const fmtUsd = n => { n = Number(n) || 0; const a = Math.abs(n); return a >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : a >= 1e4 ? '$' + (n / 1e3).toFixed(1) + 'K' : a >= 1e3 ? '$' + (n / 1e3).toFixed(2) + 'K' : a >= 1 ? '$' + n.toFixed(2) : a ? '$' + sig(n) : '$0'; };
const fmtNum = n => { n = Number(n) || 0; const a = Math.abs(n); return a >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : a >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : sig(n); };
const fmtSol = n => { n = Number(n) || 0; const a = Math.abs(n); return '◎ ' + (a >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : a >= 100 ? n.toFixed(1) : a >= 10 ? n.toFixed(2) : a >= .01 ? n.toFixed(4) : a ? sig(n) : '0'); };
const fmtPct = (x, d = 1) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(d) + '%';
const ago = ms => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? Math.floor(s) + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
// plain decimal strings for the API (no exponents, no grouping)
const group = (n, d = 6) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const plain = (n, d = 9) => { if (!isFinite(n) || n <= 0) return '0'; const s = Number(n).toFixed(Math.min(d, 12)); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };
const cleanNum = v => String(v || '').replace(/[\s,_]/g, '').replace(/^\./, '0.');
const solscan = (kind, x) => `https://solscan.io/${kind}/${x}`;

// ---------------------------------------------------------------- API
async function api(op, params, body) {
  const q = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  let r, j = null;
  try { r = await fetch('/api/' + op + q, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { accept: 'application/json' } }); }
  catch { throw new Error('Network error. Check your connection and try again.'); }
  try { j = await r.json(); } catch {}
  if (!r.ok || !j || j.ok === false) {
    const e = new Error((j && j.error) || (j && j.err ? 'The transaction failed on chain.' : `The server answered ${r.status}. Try again.`));
    e.status = r.status; e.data = j; throw e;
  }
  return j;
}
const relay = async b64 => (await api('send', null, { tx: b64 })).sig;
async function waitSig(s, ms = 70000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(1600);
    let st = null; try { st = await api('status', { sig: s }); } catch {}
    if (st && (st.state === 'confirmed' || st.state === 'finalized')) return true;
    if (st && st.state === 'failed') throw new Error('The transaction failed on chain. Nothing moved.');
  }
  throw new Error('Solana has not confirmed it yet. Check your wallet, then try again.');
}

// ---------------------------------------------------------------- toasts, copy, images
function toast(html, kind = '', ms = 4800) {
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.innerHTML = html; $('#toasts').append(t);
  setTimeout(() => { t.classList.add('bye'); setTimeout(() => t.remove(), 450); }, ms);
}
async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(esc(label), 'ok', 1800); } catch { toast('Copy failed. Select the text instead.', 'bad'); }
}
document.addEventListener('click', e => { const c = e.target.closest('[data-copy]'); if (c) { e.preventDefault(); e.stopPropagation(); copy(c.dataset.copy, c.dataset.copied || 'Copied'); } });
const PH = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#0d0d0d"/><rect x="8.5" y="19.5" width="17" height="9" rx="4.5" fill="none" stroke="#5a5a55" stroke-width="2"/><rect x="22.5" y="19.5" width="17" height="9" rx="4.5" fill="none" stroke="#5a5a55" stroke-width="2"/></svg>');
document.addEventListener('error', e => { const i = e.target; if (i && i.tagName === 'IMG' && i.getAttribute('src') !== PH) i.setAttribute('src', PH); }, true);
const img = (src, alt = '') => `<img src="${esc(src || PH)}" alt="${esc(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;

// ---------------------------------------------------------------- layers (dialogs that can stack)
const layers = [];
function openLayer(html, { wide = false, onClose = null } = {}) {
  const ov = document.createElement('div'); ov.className = 'ovl'; ov.style.zIndex = String(60 + layers.length * 2);
  ov.innerHTML = `<div class="dlg${wide ? ' wide' : ''}" role="dialog" aria-modal="true"><button class="x" type="button" aria-label="Close">✕</button>${html}</div>`;
  document.body.append(ov); document.documentElement.classList.add('locked');
  const L = { ov, dlg: $('.dlg', ov), busy: false, onClose, close: force => closeLayer(L, force) };
  layers.push(L);
  $('.x', ov).addEventListener('click', () => L.close());
  ov.addEventListener('mousedown', e => { if (e.target === ov) L.close(); });
  return L;
}
function closeLayer(L, force) {
  const i = layers.indexOf(L); if (i < 0) return;
  if (L.busy && !force) { toast('Finish or cancel the step in your wallet first.'); return; }
  layers.splice(i, 1); L.ov.classList.add('bye'); setTimeout(() => L.ov.remove(), 220);
  if (!layers.length) { document.documentElement.classList.remove('locked'); if (/^#\//.test(location.hash)) history.replaceState(null, '', location.pathname + location.search); }
  const f = L.onClose; L.onClose = null; if (f) f();
}
addEventListener('keydown', e => { if (e.key === 'Escape' && layers.length) layers[layers.length - 1].close(); });

// ---------------------------------------------------------------- wallet
const S = { me: null, config: { nonceRent: 1447680 }, solUsd: 0, tokens: new Map() };
const walBtn = $('#wal');
function paintWallet(c) {
  if (c) { walBtn.innerHTML = `${c.icon ? `<img src="${esc(c.icon)}" alt="">` : ''}<span>${short(c.address)}</span>`; walBtn.classList.add('on'); }
  else { walBtn.textContent = 'Connect wallet'; walBtn.classList.remove('on'); }
}
function connectModal() {
  return new Promise(resolve => {
    const ws = W.wallets(), here = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
    const list = ws.length ? ws.map((w, i) => `<button type="button" data-i="${i}"><img src="${esc(w.icon)}" alt="">${esc(w.name)}</button>`).join('')
      : W.KNOWN.map(k => `<a href="${k.url}" target="_blank" rel="noopener">${esc(k.name)}<span class="tag">install</span></a>`).join('') +
        `<a href="https://phantom.app/ul/browse/${here}?ref=${ref}">Open this page in Phantom<span class="tag">phone</span></a><a href="https://solflare.com/ul/v1/browse/${here}?ref=${ref}">Open this page in Solflare<span class="tag">phone</span></a>`;
    const L = openLayer(`<h3>Connect a wallet</h3><p class="sub">${ws.length ? 'Your wallet shows every transaction before you sign it. onchain never sees your keys.' : 'No Solana wallet in this browser yet. Install one, or open this page inside your wallet app.'}</p><div class="wlist">${list}</div><p class="err mt" hidden></p>`, { onClose: () => resolve(W.current()) });
    $$('[data-i]', L.dlg).forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { const c = await W.connect(ws[+b.dataset.i]); L.close(true); toast(`Connected ${esc(short(c.address))}`, 'ok', 2200); }
      catch (e) { b.disabled = false; const p = $('.err', L.dlg); p.hidden = false; p.textContent = W.walletError(e); }
    }));
  });
}
const needWallet = async () => W.current() || await connectModal();
function walletMenu() {
  const c = W.current(); if (!c) return connectModal();
  const L = openLayer(`<h3>Your wallet</h3><p class="sub">${esc(c.name)} · connected</p><div class="link"><span>${esc(c.address)}</span></div>
    <div class="wlist mt"><button type="button" data-a="copy">Copy address</button><button type="button" data-a="desk">Open my desk</button><button type="button" data-a="bags">Look up my bags</button><button type="button" data-a="off">Disconnect</button></div>`);
  L.dlg.addEventListener('click', async e => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    if (a.dataset.a === 'copy') copy(c.address, 'Address copied');
    if (a.dataset.a === 'desk') { L.close(); $('#desk').scrollIntoView({ behavior: 'smooth' }); }
    if (a.dataset.a === 'bags') { L.close(); $('#look-in').value = c.address; lookup(c.address); $('#lookup').scrollIntoView({ behavior: 'smooth' }); }
    if (a.dataset.a === 'off') { L.close(); await W.disconnect(); toast('Disconnected'); }
  });
}
walBtn.addEventListener('click', () => (W.current() ? walletMenu() : connectModal()));

// ---------------------------------------------------------------- pump.fun curve maths (live reserves from the chain)
const PUMP_SUPPLY = 1e9, PUMP_DEC = 6, INIT_RTOK = 793100000 * 1e6, BAG = .03;
const curvePrice = cv => (cv.vSol / 1e9) / (cv.vTok / 10 ** PUMP_DEC);           // SOL per token
const curveProgress = cv => clamp((INIT_RTOK - cv.rTok) / INIT_RTOK);
function dump(cv, tokens) {                                                        // sell `tokens` into the curve
  const R = cv.vTok, d = tokens * 10 ** PUMP_DEC, k = cv.vSol * R;
  return { sol: Math.min((cv.vSol - k / (R + d)) / 1e9, cv.rSol / 1e9), chart: 1 - (R / (R + d)) ** 2 };
}
// where a holder would dump: the bonding curve while it bonds, the PumpSwap pool after (both read live from Solana)
function amm(c) {
  if (!c) return null;
  if (c.curve && !c.complete && c.curve.vTok > 0) return { kind: 'curve', R: c.curve.vTok, px: curvePrice(c.curve), cap: c.curve.rSol / 1e9 };
  const sol = c.solUsd || S.solUsd;
  if (c.complete === false || !(c.priceUsd > 0) || !(sol > 0)) return null;      // still bonding but no clean curve: no guess
  // after graduation: the canonical PumpSwap pool read from the chain, or every pool's depth from Jupiter's
  // liquidity figure, whichever is deeper (a dump routes through all of them)
  const liqR = c.liquidityUsd > 0 ? c.liquidityUsd / 2 / c.priceUsd * 10 ** PUMP_DEC : 0, poolR = c.pool && c.pool.base > 0 ? c.pool.base : 0;
  const R = Math.max(liqR, poolR);
  return R > 0 ? { kind: 'pool', R, px: c.priceUsd / sol, cap: Infinity } : null;
}
function dumpA(a, tokens) { const f = a.R / (a.R + tokens * 10 ** PUMP_DEC); return { sol: Math.min(tokens * a.px * f, a.cap), chart: 1 - f * f }; }
const priceSol = t => (t && t.curve && !t.complete ? curvePrice(t.curve) : t && t.priceUsd && t.solUsd ? t.priceUsd / t.solUsd : 0);
async function token(mint) {
  const hit = S.tokens.get(mint);
  if (hit && Date.now() - hit.at < 60000) return hit.t;
  const t = (await api('token', { mint })).token; S.tokens.set(mint, { t, at: Date.now() }); if (t.solUsd) S.solUsd = t.solUsd;
  return t;
}

// ---------------------------------------------------------------- header, progress, scroll spy, reveals
const topEl = $('.top'), sprog = document.createElement('i'); sprog.className = 'sprog'; topEl.append(sprog);
function onScroll() {
  topEl.classList.toggle('scrolled', scrollY > 8);
  const h = document.documentElement.scrollHeight - innerHeight; sprog.style.transform = `scaleX(${h > 0 ? clamp(scrollY / h) : 0})`;
}
addEventListener('scroll', onScroll, { passive: true }); onScroll();
const navA = $$('.nav a');
const spy = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) navA.forEach(a => a.classList.toggle('on', a.dataset.s === e.target.id)); }), { rootMargin: '-45% 0px -50% 0px' });
['how', 'lab', 'market', 'lookup', 'desk', 'tape', 'faq'].forEach(id => { const el = document.getElementById(id); if (el) spy.observe(el); });
function scramble(el) {
  const final = el.textContent, chars = '.:-=+*%#', n = 16; let f = 0;
  const iv = setInterval(() => {
    f++; el.textContent = [...final].map((ch, i) => (ch === ' ' || i < f / n * final.length ? ch : chars[Math.random() * chars.length | 0])).join('');
    if (f >= n) { clearInterval(iv); el.textContent = final; }
  }, 34);
}
const io = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  const el = e.target; el.classList.add('in'); io.unobserve(el);
  if (!REDUCED && el.matches('.sec-h')) { const k = $('.kick', el); if (k) scramble(k); }
  if (el.id === 'stats') stats.reveal();
}), { threshold: .12, rootMargin: '0px 0px -6% 0px' });

// ---------------------------------------------------------------- hero: the chain turns with you
async function hero() {
  const cv = $('#hero-chain'); if (!cv) return;
  let ch; try { const m = await import('./chain3d.js?v=3'); ch = m.createChain(cv, { links: 3, line: 2.1, hatch: 1.05 }); } catch { return; }
  const g = ch.group; let vis = true, raf = 0, px = 0, py = 0, tx = 0, ty = 0, spin = .4, lastY = scrollY, vel = 0, flick = 0, drag = null;
  const fit = () => { ch.resize(); ch.cam.position.z = ch.fit(4.25, 2.7, innerWidth < 980 ? .72 : .66); };
  fit(); addEventListener('resize', fit);
  addEventListener('pointermove', e => { tx = e.clientX / innerWidth * 2 - 1; ty = e.clientY / innerHeight * 2 - 1; }, { passive: true });
  // grab it: drag sideways to wind the chain, tap it for a flick
  cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, moved: 0 }; try { cv.setPointerCapture(e.pointerId); } catch {} cv.classList.add('grab'); });
  cv.addEventListener('pointermove', e => { if (!drag) return; const dx = e.clientX - drag.x; drag.x = e.clientX; drag.moved += Math.abs(dx); spin += dx * .011; flick = dx * .006; });
  const letGo = () => { if (drag && drag.moved < 5) flick = .32; drag = null; cv.classList.remove('grab'); };
  cv.addEventListener('pointerup', letGo); cv.addEventListener('pointercancel', letGo);
  const t0 = performance.now();
  function frame(now) {
    raf = 0; if (!vis || document.hidden) return;
    raf = requestAnimationFrame(frame);
    const t = (now - t0) / 1000, y = scrollY;
    vel += ((y - lastY) - vel) * .12; lastY = y;
    spin += (REDUCED ? 0 : .0032) + Math.min(.07, Math.abs(vel) * .0011) + flick;   // scrolling winds it faster
    flick *= .95;
    px += (tx - px) * .05; py += (ty - py) * .05;
    g.rotation.x = spin; g.rotation.y = px * .3; g.rotation.z = -.42 + py * .1;
    const p = clamp(y / innerHeight);
    g.position.y = Math.sin(t * .7) * .05 + p * 1.1;
    ch.setOpacity(1 - p * .75);
    ch.render();
  }
  new IntersectionObserver(([e]) => { vis = e.isIntersecting; if (vis && !raf) raf = requestAnimationFrame(frame); }, { rootMargin: '120px' }).observe(cv);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && vis && !raf) raf = requestAnimationFrame(frame); });
  raf = requestAnimationFrame(frame);
  requestAnimationFrame(() => cv.classList.add('in'));
}

// the hero card and the how-it-works swap cycle through live coins still on their curve
const demo = { list: [], i: 0, timer: 0 };
function feedDemo(j) {
  const add = (j.coins || []).filter(c => amm(c)).slice(0, 10);
  if (!add.length) { if (!demo.list.length) paintImpact(null); return; }
  const had = demo.list.length; demo.list = add; S.solUsd = j.solUsd || S.solUsd; lab.feed(add);
  if (!had) { demo.i = 0; paintImpact(demo.list[0]); clearInterval(demo.timer); demo.timer = setInterval(() => { if (document.hidden) return; demo.i = (demo.i + 1) % demo.list.length; paintImpact(demo.list[demo.i]); }, 6000); }
}
function paintImpact(c) {
  const el = $('#impact'); if (!el) return;
  if (!c) { el.innerHTML = `<div class="ih"><b>Why off the chart</b></div><p class="muted mt0">A sell into a curve or a pool moves the price for everyone. A wallet-to-wallet swap never touches it.</p>`; return; }
  const a = amm(c), tokens = PUMP_SUPPLY * BAG, value = tokens * a.px, d = dumpA(a, tokens);
  el.innerHTML = `<div class="ih">${img(c.image, c.symbol)}<b>$${esc(c.symbol)}</b><span>live ${a.kind} · ${fmtUsd(c.mcapUsd)}</span></div>
    <div class="rows"><span>A 3% bag at market</span><b>${fmtSol(value)}</b>
      <span>Dumped into the ${a.kind}</span><b><em class="down">${fmtPct(-d.chart)}</em> · ${fmtSol(d.sol)}</b>
      <span>Swapped wallet to wallet</span><b><em class="up">0.00%</em> · your price</b></div><div class="bar"><i></i></div>`;
  const sol = $('#sw-sol'), tok = $('#sw-tok');
  if (sol) sol.textContent = fmtSol(value);
  if (tok) tok.textContent = `${fmtNum(tokens)} $${c.symbol}`;
}

// how it works: a line fills as you read and each step lights as it passes
function howScroll() {
  const line = $('.how-line'), fill = $('#how-fill'), steps = $$('.step'); if (!line || !fill) return;
  let tick = false;
  const upd = () => {
    tick = false;
    const r = line.getBoundingClientRect(), mid = innerHeight * .58;
    fill.style.height = (clamp((mid - r.top) / r.height) * 100).toFixed(2) + '%';
    steps.forEach(s => { const b = $('b', s).getBoundingClientRect(); s.classList.toggle('lit', b.top + b.height / 2 < mid); });
  };
  addEventListener('scroll', () => { if (!tick) { tick = true; requestAnimationFrame(upd); } }, { passive: true });
  addEventListener('resize', upd); upd();
}

// ---------------------------------------------------------------- market
const M = { tab: 'live', data: {}, busy: {}, sort: 'rank' };
const near = sel => { const el = $(sel); if (!el) return false; const r = el.getBoundingClientRect(); return r.bottom > -innerHeight && r.top < innerHeight * 2; };
async function loadMarket(tab = M.tab, quiet = false) {
  M.tab = tab;
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const grid = $('#coins');
  if (!M.data[tab]) grid.innerHTML = Array.from({ length: 8 }, () => '<div class="skel"></div>').join('');
  else if (!quiet) paintCoins(M.data[tab]);
  if (M.busy[tab]) return; M.busy[tab] = true;
  try {
    const j = await api('coins', { tab });
    M.data[tab] = j; if (j.solUsd) S.solUsd = j.solUsd;
    if (M.tab === tab) paintCoins(j, quiet);
    feedDemo(j); if (tab === 'live' || !$('#ticker').children.length) paintTicker(j);
  } catch (e) {
    if (!M.data[tab] && M.tab === tab) grid.innerHTML = `<div class="empty">Couldn't load coins right now. ${esc(e.message)}<div class="mt"><button class="btn sm" type="button" data-retry>Try again</button></div></div>`;
  } finally { M.busy[tab] = false; }
}
function coinCard(c) {
  const cv = c.curve && !c.complete && c.curve.vTok > 0 ? c.curve : null, a = amm(c);
  const prog = cv ? curveProgress(cv) : c.complete ? 1 : 0, d = a ? dumpA(a, PUMP_SUPPLY * BAG) : null;
  const ch = c.change1h != null && isFinite(c.change1h) ? c.change1h / 100 : null;
  return `<article class="coin" data-mint="${esc(c.mint)}" tabindex="0">${ch != null ? `<span class="chg ${ch >= 0 ? 'up' : 'down'}">${fmtPct(ch)} 1h</span>` : ''}
    <div class="ch">${img(c.image, c.symbol)}<div class="nm"><b>${esc(c.name || c.symbol || 'Unknown')}</b><span>$${esc(c.symbol || '???')}${c.created ? ' · ' + ago(c.created) : ''}</span></div></div>
    <div class="kv"><div><span>Market cap</span><b>${fmtUsd(c.mcapUsd)}</b></div><div><span>${a ? 'Dump a 3% bag' : 'Curve'}</span><b class="${a ? 'down' : ''}">${a ? fmtPct(-d.chart) : c.complete ? 'Graduated' : '—'}</b></div></div>
    <div class="pg"><div class="prog"><i style="width:${(prog * 100).toFixed(1)}%"></i></div><span>${cv ? 'bonding ' + Math.floor(prog * 100) + '%' : c.complete ? 'on PumpSwap' : ''}${c.holders ? ' · ' + kfmt(c.holders) + ' holders' : ''}</span></div>
    <div class="act"><button class="btn sm solid" type="button">Bid on a bag</button><a class="btn sm" href="https://pump.fun/coin/${esc(c.mint)}" target="_blank" rel="noopener" data-ext>pump.fun ↗</a></div></article>`;
}
const kfmt = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));
const impactOf = c => { const a = amm(c); return a ? dumpA(a, PUMP_SUPPLY * BAG).chart : -1; };
function sorted(list) {
  const l = list.slice();
  if (M.sort === 'mcap') l.sort((a, b) => b.mcapUsd - a.mcapUsd);
  else if (M.sort === 'impact') l.sort((a, b) => impactOf(b) - impactOf(a));
  else if (M.sort === 'age') l.sort((a, b) => (b.created || 0) - (a.created || 0));
  return l;
}
function paintCoins(j, quiet) {
  const grid = $('#coins'), list = sorted((j.coins || []).slice(0, 48));
  $('#coins-src').textContent = list.length ? `${list.length} pump.fun coins · ${j.src === 'jupiter' ? 'ranked live by Jupiter' : 'newest DexScreener profiles'} · curves read straight from Solana · refreshes every 30s` : '';
  if (!list.length) { grid.innerHTML = '<div class="empty">No coins on this tab right now. Try another tab, or paste any token address above.</div>'; return; }
  grid.innerHTML = list.map(coinCard).join('');
  $$('.coin', grid).forEach((c, i) => (quiet || REDUCED ? c.classList.add('in') : setTimeout(() => c.classList.add('in'), 28 * i)));
}
// the band under the hero: live coins and what a 3% dump would do to each chart
function paintTicker(j) {
  const list = (j.coins || []).slice(0, 24); if (!list.length) return;
  const one = c => { const a = amm(c);
    return `<span data-mint="${esc(c.mint)}">${img(c.image, c.symbol)}$${esc(c.symbol)} <b>${fmtUsd(c.mcapUsd)}</b>${a ? ` <em class="down">${fmtPct(-dumpA(a, PUMP_SUPPLY * BAG).chart)}</em> dump 3%` : ''}</span>`; };
  const html = list.map(one).join('');
  $('#ticker').innerHTML = html + html;                // twice, so the loop is seamless
}
$('#ticker').addEventListener('click', e => { const s = e.target.closest('[data-mint]'); if (s) openCoin(s.dataset.mint, coinBy(s.dataset.mint)); });
const coinBy = mint => { for (const t of Object.values(M.data)) { const c = (t.coins || []).find(x => x.mint === mint); if (c) return c; } return null; };
$('#coins').addEventListener('click', e => {
  if (e.target.closest('[data-ext]')) return;
  if (e.target.closest('[data-retry]')) { loadMarket(M.tab); return; }
  const card = e.target.closest('.coin'); if (card) openCoin(card.dataset.mint, coinBy(card.dataset.mint));
});
$('#coins').addEventListener('keydown', e => { const card = e.target.closest('.coin'); if (card && e.key === 'Enter') openCoin(card.dataset.mint, coinBy(card.dataset.mint)); });
$$('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => loadMarket(b.dataset.tab)));
$$('.sort [data-sort]').forEach(b => b.addEventListener('click', () => {
  M.sort = b.dataset.sort; $$('.sort [data-sort]').forEach(x => x.classList.toggle('on', x === b));
  if (M.data[M.tab]) paintCoins(M.data[M.tab]);
}));
// cards lean toward the pointer, with a soft light where it is
$('#coins').addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse' || REDUCED) return;
  const c = e.target.closest('.coin'); if (!c) return;
  const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  c.style.setProperty('--rx', ((.5 - y) * 6).toFixed(2) + 'deg'); c.style.setProperty('--ry', ((x - .5) * 8).toFixed(2) + 'deg');
  c.style.setProperty('--mx', (x * 100).toFixed(1) + '%'); c.style.setProperty('--my', (y * 100).toFixed(1) + '%');
});
$('#coins').addEventListener('pointerout', e => { const c = e.target.closest('.coin'); if (c && !c.contains(e.relatedTarget)) { c.style.removeProperty('--rx'); c.style.removeProperty('--ry'); } });
// "/" jumps to the token search from anywhere
addEventListener('keydown', e => {
  if (e.key !== '/' || layers.length || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) return;
  e.preventDefault(); $('#market').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' }); setTimeout(() => mintIn.focus({ preventScroll: true }), 450);
});
const mintIn = $('#mint-in');
function goMint() { const a = findAddr(mintIn.value); if (!a) { if (mintIn.value.trim()) toast('Paste a token address or a pump.fun link.', 'bad'); return; } mintIn.blur(); openCoin(a, coinBy(a)); }
mintIn.addEventListener('keydown', e => { if (e.key === 'Enter') goMint(); });
mintIn.addEventListener('paste', () => setTimeout(goMint, 40));
setInterval(() => { if (!document.hidden && near('#market')) loadMarket(M.tab, true); }, 30000);

// ---------------------------------------------------------------- one coin: who holds it
function head(t, extra = '') {
  const pf = t.pump || /pump$/.test(t.mint || '');
  return `<div class="ohead">${img(t.image, t.symbol)}<div class="oh"><b>${esc(t.name || 'Token')}</b><span>$${esc(t.symbol || '???')} · <button class="cp" type="button" data-copy="${esc(t.mint)}" data-copied="Token address copied">${esc(short(t.mint))}</button></span></div>
    <div class="lk">${extra}${pf ? `<a class="btn xs" href="https://pump.fun/coin/${esc(t.mint)}" target="_blank" rel="noopener">pump.fun ↗</a>` : ''}<a class="btn xs" href="${solscan('token', esc(t.mint))}" target="_blank" rel="noopener">Solscan ↗</a></div></div>`;
}
const TAG = { curve: 'bonding curve', pool: 'pool', program: 'program', exchange: 'exchange' };
async function openCoin(mint, pre) {
  history.replaceState(null, '', '#/c/' + mint);
  const L = openLayer(`<div class="c-head">${head(pre || { mint, symbol: '…', name: 'Loading…' })}</div><div class="kv4 c-kv"></div>
    <h4 class="h4 c-hh">Top holders · make any wallet an offer</h4><div class="c-hold"><div class="skel sm"></div></div>
    <form class="look tight c-form"><input placeholder="Or paste a holder's wallet address" spellcheck="false" autocomplete="off"><button class="btn solid" type="submit">Bid</button></form>`, { wide: true });
  let t;
  try { t = await token(mint); } catch (e) { $('.c-kv', L.dlg).outerHTML = `<p class="err">${esc(e.message)}</p>`; $('.c-hold', L.dlg).innerHTML = ''; return; }
  $('.c-head', L.dlg).innerHTML = head(t);
  const p = priceSol(t);
  $('.c-kv', L.dlg).innerHTML = `<div><span>Market cap</span><b>${t.mcapUsd ? fmtUsd(t.mcapUsd) : '—'}</b></div><div><span>Price</span><b>${t.priceUsd ? fmtUsd(t.priceUsd) : p ? fmtSol(p) : '—'}</b></div>
    <div><span>${t.curve ? 'Bonding' : 'Liquidity'}</span><b>${t.curve ? Math.floor(curveProgress(t.curve) * 100) + '%' : t.liquidityUsd ? fmtUsd(t.liquidityUsd) : '—'}</b></div>${t.holders ? `<div><span>Holders</span><b>${fmtNum(t.holders)}</b></div>` : `<div><span>Supply</span><b>${fmtNum(t.supply)}</b></div>`}`;
  if (t.hook) $('.c-kv', L.dlg).insertAdjacentHTML('afterend', '<p class="err">This token runs a transfer hook. onchain cannot swap it yet.</p>');
  $('.c-form', L.dlg).addEventListener('submit', e => { e.preventDefault(); const w = findAddr($('input', e.target).value); if (!w) return toast('Paste a Solana wallet address.', 'bad'); openOffer(t, w, null); });
  const box = $('.c-hold', L.dlg);
  try {
    const h = await api('holders', { mint });
    const me = W.current() && W.current().address;
    if (!h.rows.length) { box.innerHTML = '<div class="empty">No holders found.</div>'; return; }
    if (h.count) $('.c-hh', L.dlg).textContent = `Top holders of ${fmtNum(h.count)} · make any wallet an offer`;
    box.innerHTML = `<div class="hold-list">${h.rows.map((r, i) => `<div class="h"><span class="n">${i + 1}</span>
      <span class="a"><a href="${solscan('account', r.owner)}" target="_blank" rel="noopener">${esc(short(r.owner))}</a>${r.wallet ? (r.owner === me ? '<span class="tag">you</span>' : '') : `<span class="tag">${esc(r.kind === 'curve' ? TAG.curve : r.label || TAG[r.kind] || 'program')}</span>`}</span>
      <span class="p">${fmtNum(r.ui)} · ${(r.pct * 100).toFixed(2)}%</span>
      ${r.wallet && r.owner !== me && !t.hook ? `<button class="btn xs solid" type="button" data-bid="${esc(r.owner)}" data-has="${r.ui}">Bid</button>` : '<span></span>'}</div>`).join('')}</div>`;
    box.addEventListener('click', e => { const b = e.target.closest('[data-bid]'); if (b) openOffer(t, b.dataset.bid, Number(b.dataset.has)); });
  } catch (e) { box.innerHTML = `<div class="empty">Couldn't load holders: ${esc(e.message)}<br>You can still paste a holder's wallet below.</div>`; }
}

// ---------------------------------------------------------------- make an offer
const FLOW = ['Check the bag and your SOL', 'Open your deposit slot', 'Sign your half of the swap', 'Post the offer'];
async function openOffer(t, seller, has) {
  const me0 = W.current();
  if (me0 && me0.address === seller) return toast("That's your own wallet.", 'bad');
  const L = openLayer(`<h3>Bid on a bag</h3><p class="sub">You sign your half now. Nothing moves until the holder signs theirs.</p>${head(t)}
    <div class="who"><span>Holder</span><a href="${solscan('account', esc(seller))}" target="_blank" rel="noopener">${esc(short(seller))}</a><b class="o-has">${has != null ? 'holds ' + fmtNum(has) : 'checking…'}</b></div>
    <form class="frm o-form" novalidate>
      <div class="row2"><label>You get · $${esc(t.symbol || 'tokens')}<input class="field o-amt" inputmode="decimal" autocomplete="off" placeholder="0"></label>
        <label>You pay · SOL<input class="field o-sol" inputmode="decimal" autocomplete="off" placeholder="0.00"></label></div>
      <div class="row2"><div class="chips o-ac"><button type="button" data-f=".25">25%</button><button type="button" data-f=".5">50%</button><button type="button" data-f="1">Whole bag</button></div>
        <div class="chips o-sc"><button type="button" data-p="0">Market</button><button type="button" data-p=".05">+5%</button><button type="button" data-p=".1">+10%</button><button type="button" data-p=".25">+25%</button></div></div>
      <label>Note to the holder · optional<input class="field o-note" maxlength="140" autocomplete="off" placeholder="Shown with your offer"></label>
      <div class="calc o-calc"></div>
      <div class="flow o-flow" hidden>${FLOW.map((s, i) => `<div><i>${i + 1}</i><span>${s}</span></div>`).join('')}</div>
      <p class="err o-err" hidden></p><div class="o-done"></div>
      <button class="btn solid o-go" type="submit">${me0 ? 'Sign offer' : 'Connect wallet to offer'}</button>
    </form>`);
  const q = s => $(s, L.dlg), amt = q('.o-amt'), sol = q('.o-sol'), calc = q('.o-calc'), err = q('.o-err'), go = q('.o-go');
  const px = priceSol(t);
  const showErr = m => { err.hidden = false; err.textContent = m; };
  if (has == null) {
    api('bags', { wallet: seller }).then(j => { const b = (j.bags || []).find(x => x.mint === t.mint); has = b ? b.ui : 0; paintHas(); }).catch(() => { q('.o-has').textContent = 'balance unknown'; });
  }
  function paintHas() {
    q('.o-has').textContent = has ? 'holds ' + fmtNum(has) + (t.supply ? ` · ${(has / t.supply * 100).toFixed(2)}%` : '') : 'holds none of this token';
    if (!has) { go.disabled = true; showErr('This wallet holds none of this token.'); return; }
    if (!amt.value) { amt.value = group(has); if (px && !sol.value) sol.value = plain(has * px * 1.05, 4); }
    update();
  }
  function update() {
    const a = +cleanNum(amt.value) || 0, s = +cleanNum(sol.value) || 0, mv = a * px;
    const rows = [];
    if (px && a) rows.push(['Market value', `${fmtSol(mv)}${S.solUsd ? ' · ' + fmtUsd(mv * S.solUsd) : ''}`]);
    if (px && a && s) rows.push(['Your price vs market', `<em class="${s >= mv ? 'up' : 'down'}">${fmtPct(s / mv - 1)}</em>`]);
    const am = amm(t); if (am && a) { const d = dumpA(am, a); rows.push([`If they dumped it into the ${am.kind}`, `${fmtSol(d.sol)} · chart <em class="down">${fmtPct(-d.chart)}</em>`]); }
    rows.push(['Refundable deposit', `${fmtSol((S.config.nonceRent || 1447680) / 1e9)} · back when the offer ends`]);
    rows.push(['Network fee', '≈ ◎ 0.00002'], ['onchain fee', '0']);
    calc.innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  }
  amt.addEventListener('input', update); sol.addEventListener('input', update);
  q('.o-ac').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b || !has) return; amt.value = group(has * +b.dataset.f); if (px) sol.value = plain(+cleanNum(amt.value) * px * 1.05, 4); update(); });
  q('.o-sc').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (!b || !px) return; const a = +cleanNum(amt.value) || 0; if (a) sol.value = plain(a * px * (1 + +b.dataset.p), 4); update(); });
  if (has != null) paintHas(); else update();

  const steps = $$('.o-flow > div', L.dlg);
  const step = (i, st) => steps.forEach((d, k) => { if (k < i) { d.className = 'done'; $('i', d).textContent = '✓'; } else if (k === i) { d.className = st || 'on'; $('i', d).textContent = st === 'bad' ? '!' : k + 1; } else { d.className = ''; $('i', d).textContent = k + 1; } });
  const lock = on => { L.busy = on; [amt, sol, q('.o-note'), go].forEach(x => { x.disabled = on; }); $$('.chips button', L.dlg).forEach(x => { x.disabled = on; }); };
  q('.o-form').addEventListener('submit', async e => {
    e.preventDefault(); err.hidden = true;
    let c = W.current();
    if (!c) { c = await connectModal(); if (!c) return; go.textContent = 'Sign offer'; return; }
    if (c.address === seller) return showErr("You can't bid on your own bag.");
    const amount = plain(+cleanNum(amt.value), 9), price = plain(+cleanNum(sol.value), 9), note = q('.o-note').value.trim();
    if (!(+amount > 0)) return showErr(`Enter how many $${t.symbol || 'tokens'} you want.`);
    if (has != null && +amount > has * (1 + 1e-9)) return showErr(`They hold ${fmtNum(has)}. Ask for that much or less.`);
    if (!(+price >= .0001)) return showErr('Offer at least 0.0001 SOL.');
    const buyer = c.address, body = { buyer, seller, mint: t.mint, amount, sol: price };
    lock(true); q('.o-flow').hidden = false; let at = 0;
    try {
      step(0); await api('check', body);
      at = 1; step(1);
      const st = await api('start', null, { buyer });
      if (!st.ready) { $('span', steps[1]).textContent = 'Open your deposit slot · approve in your wallet'; await waitSig(await W.signAndSend(W.unb64(st.tx), relay)); }
      $('span', steps[1]).textContent = st.ready ? 'Deposit slot ready (reused)' : 'Deposit slot open';
      at = 2; step(2);
      let b;
      for (let i = 0; ; i++) {
        try { b = await api('build', null, { ...body, nonce: st.nonce }); break; }
        catch (x) { if (x.status === 409 && /not on chain yet/i.test(x.message) && i < 12) { await sleep(1500); continue; } throw x; }
      }
      $('span', steps[2]).textContent = 'Sign your half · approve in your wallet';
      const signed = await W.signTx(W.unb64(b.tx));
      $('span', steps[2]).textContent = 'Your half is signed';
      at = 3; step(3);
      const r = await api('create', null, { ...body, id: b.id, nonce: st.nonce, signed: W.b64(signed), note });
      step(4); L.busy = false; go.hidden = true;
      const url = `${location.origin}/#/o/${r.offer.id}`;
      const text = `I made an offer on a $${t.symbol} bag, wallet to wallet. The chart never sees it.`;
      q('.o-done').innerHTML = `<div class="ok">Your offer is live. The holder sees it on their desk when they connect. Send them the link.</div>
        <div class="link mt"><span>${esc(url)}</span><button class="btn xs" type="button" data-copy="${esc(url)}" data-copied="Offer link copied">Copy</button></div>
        <div class="share"><a class="btn sm" href="https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}" target="_blank" rel="noopener">Share on X</a><button class="btn sm" type="button" data-a="desk">Open my desk</button></div>`;
      q('.o-done [data-a="desk"]').addEventListener('click', () => { layers.slice().forEach(x => x.close(true)); $('#desk').scrollIntoView({ behavior: 'smooth' }); });
      desk.refresh(true); tape.load(); stats.load();
    } catch (x) {
      step(at, 'bad'); lock(false); showErr(W.walletError(x));
    } finally { L.busy = false; }
  });
}

// ---------------------------------------------------------------- one offer (shared link, desk, tape)
async function openOfferView(id) {
  history.replaceState(null, '', '#/o/' + id);
  const L = openLayer('<div class="ov"><div class="skel"></div></div>');
  const box = $('.ov', L.dlg);
  async function paint() {
    let j; try { j = await api('offer', { id }); } catch (e) { box.innerHTML = `<h3>Offer ${esc(id)}</h3><p class="err mt">${esc(e.message)}</p>`; return; }
    const o = j.offer, me = W.current() && W.current().address, t = await token(o.mint).catch(() => ({ mint: o.mint, symbol: o.symbol, name: o.name, image: o.image }));
    const px = priceSol(t), vs = px && o.amount ? (o.sol / o.amount) / px - 1 : null;
    const act = o.status !== 'open' ? (o.status === 'filled' && o.sig ? `<a class="btn line" href="${solscan('tx', o.sig)}" target="_blank" rel="noopener">View the swap on Solscan ↗</a>` : '')
      : !me ? '<button class="btn solid" type="button" data-a="connect">Connect wallet</button>'
      : me === o.seller ? `<button class="btn solid" type="button" data-a="fill">Sign &amp; swap · get ${fmtSol(o.sol)}</button>`
      : me === o.buyer ? '<button class="btn danger" type="button" data-a="cancel">Cancel offer · get your deposit back</button>'
      : `<p class="muted">Only the holder (${esc(short(o.seller))}) can accept this offer.</p>`;
    box.innerHTML = `<h3>Offer ${esc(o.id)}</h3><p class="sub"><span class="pill ${o.status}">${o.status}</span> · made ${ago(o.created)} ago${o.closed ? ` · ${o.status} ${ago(o.closed)} ago` : ''}</p>${head(t)}
      <div class="deal"><div><span>Holder sends</span><b>${fmtNum(o.amount)} $${esc(o.symbol || t.symbol || '')}</b></div><i>⇄</i><div><span>Buyer pays</span><b>${fmtSol(o.sol)}</b></div></div>
      <div class="calc"><span>Buyer</span><b><a href="${solscan('account', o.buyer)}" target="_blank" rel="noopener">${esc(short(o.buyer))}</a>${me === o.buyer ? ' · you' : ''}</b>
        <span>Holder</span><b><a href="${solscan('account', o.seller)}" target="_blank" rel="noopener">${esc(short(o.seller))}</a>${me === o.seller ? ' · you' : ''}</b>
        ${vs != null ? `<span>Price vs market now</span><b><em class="${vs >= 0 ? 'up' : 'down'}">${fmtPct(vs)}</em></b>` : ''}
        ${o.status === 'open' && j.held != null ? `<span>Holder holds now</span><b class="${j.held + 1e-9 < o.amount ? 'down' : ''}">${fmtNum(j.held)}</b>` : ''}
        <span>Chart impact</span><b><em class="up">0.00%</em></b></div>
      ${o.note ? `<p class="note">“${esc(o.note)}”</p>` : ''}
      <p class="err mt" hidden></p><div class="ov-act mt">${act}</div>`;
    const errEl = $('.err', box);
    box.querySelector('.ov-act').addEventListener('click', async e => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      errEl.hidden = true;
      if (b.dataset.a === 'connect') { if (await connectModal()) paint(); return; }
      const label = b.innerHTML; b.disabled = true; L.busy = true;
      try {
        if (b.dataset.a === 'fill') {
          if (j.held != null && j.held + 1e-9 < o.amount) throw new Error(`You hold ${fmtNum(j.held)}, less than the ${fmtNum(o.amount)} in this offer.`);
          b.textContent = 'Approve in your wallet…';
          const signed = await W.signTx(W.unb64(j.tx));
          b.textContent = 'Swapping…';
          const r = await api('fill', null, { id: o.id, signed: W.b64(signed) });
          toast(`Swapped. ${fmtSol(o.sol)} is in your wallet. <a href="${solscan('tx', r.sig)}" target="_blank" rel="noopener">View ↗</a>`, 'ok', 9000);
        } else {
          b.textContent = 'Preparing…';
          const c = await api('close', null, { id: o.id, buyer: me });
          b.textContent = 'Approve in your wallet…';
          const s = await W.signAndSend(W.unb64(c.tx), relay);
          b.textContent = 'Confirming…'; await waitSig(s);
          await api('closed', null, { id: o.id }).catch(() => {});
          toast(`Offer cancelled. ${fmtSol(c.lamports / 1e9)} deposit is back in your wallet.`, 'ok', 7000);
        }
        L.busy = false; desk.refresh(true); tape.load(); stats.load(); paint();
      } catch (x) { L.busy = false; b.disabled = false; b.innerHTML = label; errEl.hidden = false; errEl.textContent = W.walletError(x); }
    });
  }
  paint();
}

// ---------------------------------------------------------------- look up any wallet
const look = { wallet: '', data: null };
async function lookup(v) {
  const w = findAddr(v), out = $('#look-out');
  if (!w) return toast('Paste a Solana wallet address.', 'bad');
  look.wallet = w; out.innerHTML = '<div class="skel"></div>';
  try { look.data = await api('bags', { wallet: w }); paintBags(); }
  catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function paintBags() {
  const j = look.data, out = $('#look-out'); if (!j) return;
  const me = W.current() && W.current().address, mine = me === j.wallet, total = j.bags.reduce((s, b) => s + (b.valueUsd || 0), 0);
  const rows = j.bags.map(b => `<tr><td><div class="tok">${img(b.image, b.symbol)}<div><b>${esc(b.name || short(b.mint))}</b><span>${b.symbol ? '$' + esc(b.symbol) : esc(short(b.mint))}</span></div></div></td>
    <td class="r">${fmtNum(b.ui)}</td><td class="r hide-s">${b.priceUsd ? fmtUsd(b.priceUsd) : '—'}</td><td class="r">${b.valueUsd ? fmtUsd(b.valueUsd) : '—'}</td>
    <td class="r">${mine ? '<span class="tag">yours</span>' : `<button class="btn xs solid" type="button" data-bid="${esc(b.mint)}">Bid</button>`}</td></tr>`).join('');
  out.innerHTML = `<div class="wallet-h"><b>${esc(short(j.wallet))}</b><button class="cp" type="button" data-copy="${esc(j.wallet)}" data-copied="Address copied">copy</button>
      <span>${fmtSol(j.sol)}</span><span>${j.bags.length} coin${j.bags.length === 1 ? '' : 's'}</span>${total ? `<span>≈ ${fmtUsd(total)} in coins</span>` : ''}${mine ? '<span class="tag">your wallet</span>' : ''}
      <a href="${solscan('account', j.wallet)}" target="_blank" rel="noopener">Solscan ↗</a></div>
    ${j.bags.length ? `<div class="tscroll"><table class="table"><thead><tr><th>Coin</th><th class="r">Amount</th><th class="r hide-s">Price</th><th class="r">Value</th><th class="r"></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No coins in this wallet.</div>'}`;
}
$('#look-f').addEventListener('submit', e => { e.preventDefault(); lookup($('#look-in').value); });
$('#look-out').addEventListener('click', async e => {
  const b = e.target.closest('[data-bid]'); if (!b) return;
  const bag = look.data.bags.find(x => x.mint === b.dataset.bid); b.disabled = true;
  try { openOffer(await token(bag.mint), look.wallet, bag.ui); } catch (x) { toast(esc(x.message), 'bad'); } finally { b.disabled = false; }
});

// ---------------------------------------------------------------- your desk
const desk = {
  tab: 'in', data: null, seen: null,
  async refresh(quiet) {
    const out = $('#desk-out'), c = W.current();
    if (!c) { this.data = null; this.seen = null; document.title = 'onchain'; out.innerHTML = `<div class="empty">Connect your wallet to see the offers on your bags and the offers you made.<div class="mt"><button class="btn solid" type="button" data-a="connect">Connect wallet</button></div></div>`; return; }
    if (!quiet && !this.data) out.innerHTML = '<div class="skel"></div>';
    try {
      const j = await api('offers', { wallet: c.address });
      if (!W.current() || W.current().address !== c.address) return;
      this.data = j; this.notify(j); this.paint();
    } catch (e) { if (!this.data) out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  },
  notify(j) {
    const open = j.incoming.filter(o => o.status === 'open');
    document.title = open.length ? `(${open.length}) onchain` : 'onchain';
    const ids = new Set(open.map(o => o.id));
    if (this.seen) for (const o of open) if (!this.seen.has(o.id)) toast(`New offer: ${fmtSol(o.sol)} for ${fmtNum(o.amount)} of your $${esc(o.symbol || '')}. <a href="#/o/${esc(o.id)}">Open ↗</a>`, 'ok', 9000);
    this.seen = ids;
  },
  paint() {
    const j = this.data; if (!j) return;
    const inOpen = j.incoming.filter(o => o.status === 'open').length, outOpen = j.outgoing.filter(o => o.status === 'open').length;
    const tabs = `<div class="tabs dtabs"><button type="button" data-t="in" class="${this.tab === 'in' ? 'on' : ''}">On your bags<em>${inOpen}</em></button><button type="button" data-t="out" class="${this.tab === 'out' ? 'on' : ''}">Your offers<em>${outOpen}</em></button><button type="button" data-t="dep" class="${this.tab === 'dep' ? 'on' : ''}">Deposits<em>${j.deposits.length}</em></button></div>`;
    let body = '';
    if (this.tab === 'dep') {
      body = j.deposits.length ? `<div class="tscroll"><table class="table"><thead><tr><th>Deposit slot</th><th class="r">Rent held</th><th class="r"></th></tr></thead><tbody>${j.deposits.map(n => `<tr><td class="mono"><a href="${solscan('account', n)}" target="_blank" rel="noopener">${esc(short(n))}</a> <span class="tag">free</span></td><td class="r">${fmtSol((S.config.nonceRent || 1447680) / 1e9)}</td><td class="r"><button class="btn xs" type="button" data-reclaim="${esc(n)}">Reclaim</button></td></tr>`).join('')}</tbody></table></div><p class="src">A free slot carries your next offer at no new cost. Reclaim it to close the account and take the rent back.</p>`
        : '<div class="empty">No free deposit slots. One opens with your first offer and comes back when the offer ends.</div>';
    } else {
      const list = this.tab === 'in' ? j.incoming : j.outgoing, mineIn = this.tab === 'in';
      body = list.length ? `<div class="tscroll"><table class="table"><thead><tr><th>Coin</th><th class="r">${mineIn ? 'They want' : 'You get'}</th><th class="r">${mineIn ? 'They pay' : 'You pay'}</th><th class="hide-s">${mineIn ? 'From' : 'Holder'}</th><th class="hide-s">Status</th><th class="r"></th></tr></thead><tbody>${list.map(o => `<tr>
          <td><div class="tok">${img(o.image, o.symbol)}<div><b>$${esc(o.symbol || short(o.mint))}</b><span>${ago(o.created)} ago</span></div></div></td>
          <td class="r">${fmtNum(o.amount)}</td><td class="r">${fmtSol(o.sol)}</td>
          <td class="hide-s mono"><a href="${solscan('account', mineIn ? o.buyer : o.seller)}" target="_blank" rel="noopener">${esc(short(mineIn ? o.buyer : o.seller))}</a></td>
          <td class="hide-s"><span class="pill ${o.status}">${o.status}</span></td>
          <td class="r"><div class="row-actions">${o.status === 'open' ? (mineIn ? `<button class="btn xs solid" type="button" data-open="${o.id}">Review &amp; accept</button>` : `<button class="btn xs" type="button" data-copy="${location.origin}/#/o/${o.id}" data-copied="Offer link copied">Link</button><button class="btn xs" type="button" data-open="${o.id}">Manage</button>`) : o.sig ? `<a class="btn xs" href="${solscan('tx', o.sig)}" target="_blank" rel="noopener">Tx ↗</a>` : `<button class="btn xs" type="button" data-open="${o.id}">View</button>`}</div></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">${mineIn ? 'No offers on your bags yet. When someone bids on one, it lands here.' : 'You have not made an offer yet. Pick a coin in the market, or look up any wallet.'}</div>`;
    }
    $('#desk-out').innerHTML = tabs + body;
  },
};
$('#desk-out').addEventListener('click', async e => {
  const t = e.target.closest('[data-t]'); if (t) { desk.tab = t.dataset.t; desk.paint(); return; }
  if (e.target.closest('[data-a="connect"]')) { connectModal(); return; }
  const o = e.target.closest('[data-open]'); if (o) { openOfferView(o.dataset.open); return; }
  const r = e.target.closest('[data-reclaim]');
  if (r) {
    const c = W.current(); if (!c) return;
    r.disabled = true; r.textContent = 'Approve in wallet…';
    try {
      const j = await api('reclaim', null, { nonce: r.dataset.reclaim, buyer: c.address });
      const s = await W.signAndSend(W.unb64(j.tx), relay); r.textContent = 'Confirming…'; await waitSig(s);
      await api('closed', null, { nonce: r.dataset.reclaim }).catch(() => {});
      toast(`Reclaimed ${fmtSol(j.lamports / 1e9)}.`, 'ok'); desk.refresh(true);
    } catch (x) { toast(esc(W.walletError(x)), 'bad', 7000); r.disabled = false; r.textContent = 'Reclaim'; }
  }
});
setInterval(() => { if (!document.hidden && W.current()) desk.refresh(true); }, 20000);

// ---------------------------------------------------------------- the tape and the counters
const KIND = { offer: 'offer', fill: 'swap', cancel: 'cancel' };
const tape = {
  top: 0, ok: false,
  async load() {
    try {
      const j = await api('tape'); this.ok = true;
      const evs = j.events || [], out = $('#tape-out');
      if (!evs.length) { out.innerHTML = '<div class="tape"><div class="empty0">The tape is empty. The first offer writes the first line.</div></div>'; return; }
      if (evs[0].n === this.top) { $$('.ev .when span', out).forEach((s, i) => { if (evs[i]) s.textContent = ago(evs[i].at); }); return; }
      const fresh = this.top;
      out.innerHTML = `<div class="tape">${evs.map(ev => `<div class="ev${fresh && ev.n > fresh ? ' new' : ''}"><span class="k ${ev.kind}">${KIND[ev.kind] || esc(ev.kind)}</span>
        <span class="what">${img(ev.image, ev.symbol)}<b>${fmtNum(ev.amount)} $${esc(ev.symbol || short(ev.mint))}</b><span class="muted">for</span><b>${fmtSol(ev.sol)}</b><span class="muted hide-s">${esc(short(ev.buyer))} → ${esc(short(ev.seller))}</span></span>
        <span class="when">${ev.sig ? `<a href="${solscan('tx', ev.sig)}" target="_blank" rel="noopener">tx ↗</a> · ` : ''}${ev.id && ev.kind === 'offer' ? `<a href="#/o/${esc(ev.id)}">view</a> · ` : ''}<span>${ago(ev.at)}</span></span></div>`).join('')}</div>`;
      this.top = evs[0].n;
    } catch (e) { if (!this.ok) $('#tape-out').innerHTML = `<div class="tape"><div class="empty0">${esc(e.message)}</div></div>`; }
  },
};
const stats = {
  d: null, shown: false, done: false,
  async load() { try { this.d = await api('stats'); this.paint(); } catch { if (!this.d) $('#stats').innerHTML = ''; } },
  cells() { const d = this.d, n = v => Math.round(v).toLocaleString('en-US'); return [['Open offers', d.open, n], ['Swaps filled', d.filled, n], ['Volume', d.volumeSol, fmtSol], ['Wallets', d.wallets, n]]; },
  paint() {
    if (!this.d) return;
    const el = $('#stats');
    if (!el.children.length) el.innerHTML = this.cells().map(([k]) => `<div><span>${k}</span><b>0</b></div>`).join('');
    if (!this.shown) return;
    const anim = !this.done && !REDUCED; this.done = true;
    $$('b', el).forEach((b, i) => { const [, v, f] = this.cells()[i]; if (anim) countUp(b, v, f); else b.textContent = f(v); });
  },
  reveal() { this.shown = true; this.paint(); },
};
function countUp(el, to, f, ms = 1300) {
  const t0 = performance.now();
  const stepF = now => { const p = Math.min(1, (now - t0) / ms); el.textContent = f(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(stepF); };
  requestAnimationFrame(stepF);
}
setInterval(() => { if (!document.hidden && near('#tape')) tape.load(); }, 8000);
setInterval(() => { if (!document.hidden) stats.load(); }, 30000);

// ---------------------------------------------------------------- the dump lab: sell a bag into a live curve vs wallet to wallet
const lab = {
  coins: [], c: null, pct: 3, prog: 1, raf: 0, played: false,
  feed(list) {
    const add = list.filter(c => amm(c)).slice(0, 6); if (!add.length) return;
    const keep = this.c && add.find(x => x.mint === this.c.mint);
    this.coins = add; this.c = keep || add[0]; this.pick(); this.draw();
  },
  pick() {
    $('#lab-pick').innerHTML = this.coins.map(c => `<button type="button" data-m="${esc(c.mint)}" class="${c === this.c ? 'on' : ''}">${img(c.image, c.symbol)}$${esc(c.symbol)}</button>`).join('');
  },
  series(n = 72) {
    const R = amm(this.c).R, D = this.pct / 100 * PUMP_SUPPLY * 10 ** PUMP_DEC, ys = [];
    for (let i = 0; i <= n; i++) ys.push((R / (R + D * i / n)) ** 2);           // price relative to now as the bag sells
    return ys;
  },
  plot(cv, ys, prog, drop) {
    const dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const end = ys[ys.length - 1], top = 1.04, bot = Math.min(.5, end - .06), padB = 20, padR = 8;
    const X = f => f * (w - padR), Y = v => 6 + (top - v) / (top - bot) * (h - padB - 6);
    g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) { const y = Math.round(6 + k * (h - padB - 6) / 4) + .5; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.setLineDash([3, 4]); g.strokeStyle = 'rgba(255,255,255,.28)'; g.beginPath(); g.moveTo(0, Y(1)); g.lineTo(w, Y(1)); g.stroke(); g.setLineDash([]);
    g.font = '500 10px JBM, ui-monospace, monospace'; g.fillStyle = 'rgba(255,255,255,.38)';
    g.fillText('price now', 4, Y(1) - 6); g.fillText('0', 0, h - 5); const lbl = this.pct.toFixed(1) + '% sold'; g.fillText(lbl, w - padR - g.measureText(lbl).width, h - 5);
    const n = ys.length - 1, upto = Math.max(1, Math.round(clamp(prog) * n));
    g.beginPath(); g.moveTo(X(0), Y(ys[0])); for (let i = 1; i <= upto; i++) g.lineTo(X(i / n), Y(ys[i]));
    g.lineTo(X(upto / n), Y(1)); g.lineTo(X(0), Y(1)); g.closePath();
    const grd = g.createLinearGradient(0, Y(1), 0, Y(end)); grd.addColorStop(0, drop ? 'rgba(255,122,122,0)' : 'rgba(110,242,166,.0)'); grd.addColorStop(1, drop ? 'rgba(255,122,122,.28)' : 'rgba(110,242,166,.12)');
    g.fillStyle = grd; g.fill();
    g.beginPath(); g.moveTo(X(0), Y(ys[0])); for (let i = 1; i <= upto; i++) g.lineTo(X(i / n), Y(ys[i]));
    g.strokeStyle = drop ? '#ff8a8a' : '#f2f2ee'; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    const ex = X(upto / n), ey = Y(ys[upto]);
    g.fillStyle = drop ? '#ff8a8a' : '#6ef2a6'; g.beginPath(); g.arc(ex, ey, 4, 0, 7); g.fill();
    g.strokeStyle = drop ? 'rgba(255,138,138,.35)' : 'rgba(110,242,166,.35)'; g.beginPath(); g.arc(ex, ey, 9, 0, 7); g.stroke();
  },
  draw() {
    if (!this.c) return;
    const r = $('#lab-r'); r.style.setProperty('--p', ((this.pct - .1) / 9.9 * 100).toFixed(1) + '%');
    $('#lab-pct').textContent = this.pct.toFixed(1) + '% of supply';
    const a = amm(this.c), ys = this.series(), p = this.prog, tokens = this.pct / 100 * PUMP_SUPPLY, mv = tokens * a.px, d = dumpA(a, tokens * clamp(p));
    $('#lab-al').textContent = a.kind === 'curve' ? 'Sold into the curve' : 'Sold into the pool';
    this.plot($('#lab-ca'), ys, p, true); this.plot($('#lab-cb'), ys.map(() => 1), p, false);
    $('#lab-a').textContent = fmtPct(-d.chart);
    $('#lab-af').innerHTML = `Holder gets <b>${fmtSol(d.sol)}</b> for ${fmtNum(tokens * clamp(p))} $${esc(this.c.symbol)}${p >= 1 ? ` · <span class="down">${fmtSol(mv - d.sol)}</span> lost to slippage` : ''}`;
    $('#lab-bf').innerHTML = `Holder gets <b>your price</b> · market value ${fmtSol(mv * clamp(p))} · the chart never sees it`;
  },
  play() {
    if (!this.c) return; cancelAnimationFrame(this.raf);
    if (REDUCED) { this.prog = 1; this.draw(); return; }
    const t0 = performance.now(), ms = 1300;
    const step = now => { this.prog = Math.min(1, (now - t0) / ms); this.prog = 1 - Math.pow(1 - this.prog, 2); this.draw(); if (now - t0 < ms) this.raf = requestAnimationFrame(step); };
    this.raf = requestAnimationFrame(step);
  },
};
$('#lab-r').addEventListener('input', e => { lab.pct = +e.target.value; lab.prog = 1; cancelAnimationFrame(lab.raf); lab.draw(); });
$('#lab-go').addEventListener('click', () => lab.play());
$('#lab-pick').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; lab.c = lab.coins.find(c => c.mint === b.dataset.m) || lab.c; lab.pick(); lab.play(); });
addEventListener('resize', () => lab.draw());
new IntersectionObserver(([e]) => { if (e.isIntersecting && !lab.played && lab.c) { lab.played = true; setTimeout(() => lab.play(), 350); } }, { threshold: .4 }).observe($('.lab'));

// buttons lean toward the cursor
$$('.ctas .btn, .wal, #lab-go').forEach(b => {
  b.addEventListener('pointermove', e => { if (e.pointerType !== 'mouse' || REDUCED) return; const r = b.getBoundingClientRect(); b.style.transform = `translate(${(((e.clientX - r.left) / r.width) - .5) * 10}px, ${(((e.clientY - r.top) / r.height) - .5) * 8}px)`; });
  b.addEventListener('pointerleave', () => { b.style.transform = ''; });
});

// ---------------------------------------------------------------- footer, routes, boot
async function loadConfig() {
  try {
    const c = await api('config'); S.config = c;
    const bits = [];
    if (c.ca) bits.push(`<button class="cp" type="button" data-copy="${esc(c.ca)}" data-copied="Contract address copied">CA ${esc(short(c.ca))}</button>`, `<a href="https://pump.fun/coin/${esc(c.ca)}" target="_blank" rel="noopener">pump.fun ↗</a>`);
    if (c.x) bits.push(`<a href="${esc(c.x)}" target="_blank" rel="noopener">X ↗</a>`);
    $('#foot-links').innerHTML = bits.join('');
  } catch {}
}
function route() {
  const h = location.hash; let m;
  if ((m = h.match(/^#\/o\/([A-Za-z0-9]{10})$/))) openOfferView(m[1]);
  else if ((m = h.match(/^#\/c\/([1-9A-HJ-NP-Za-km-z]{32,44})$/))) openCoin(m[1], coinBy(m[1]));
  else if ((m = h.match(/^#\/w\/([1-9A-HJ-NP-Za-km-z]{32,44})$/))) { $('#look-in').value = m[1]; lookup(m[1]); $('#lookup').scrollIntoView(); }
}
addEventListener('hashchange', route);

W.onChange(c => { paintWallet(c); S.me = c ? c.address : null; desk.refresh(); paintBags(); });
W.onWallets(() => W.restore());
setTimeout(() => W.restore(), 350);

try { startAscii($('#ascii')); } catch {}
loadConfig(); loadMarket('live'); tape.load(); stats.load();
howScroll();
try { if (wantIntro()) await playIntro(); else dropIntro(); } catch { dropIntro(); }
document.documentElement.classList.remove('intro-on');
$$('.hero .rv').forEach((el, i) => setTimeout(() => el.classList.add('in'), 140 + i * 110));
$$('.rv').filter(el => !el.closest('.hero')).forEach(el => io.observe(el));
hero();
route();
// the live curve card needs coins still on their curve: if the live tab has none, read the newest coins too
setTimeout(() => { if (!demo.list.length) api('coins', { tab: 'new' }).then(j => { M.data.new = M.data.new || j; feedDemo(j); }).catch(() => paintImpact(null)); }, 2500);

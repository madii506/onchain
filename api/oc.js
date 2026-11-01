// ONCHAIN API: one function, ?op= routes. Live pump.fun coins, any wallet's bags, holders, and the offer life cycle:
// start (nonce) -> build (unsigned swap) -> create (buyer-signed, stored) -> fill (holder signs, we relay) | close.
const crypto = require('crypto');
const L = require('./_lib');
const C = require('./_sol');

const JUP = 'https://lite-api.jup.ag';
const FEE_BPS = 0;                                     // onchain takes nothing

// ---------- market data ----------
async function solUsd() {
  return L.cached('solusd', 30000, async () => {
    const r = await L.getJson(`${JUP}/price/v3?ids=${C.WSOL}`);
    const v = r.json && r.json[C.WSOL] && r.json[C.WSOL].usdPrice;
    if (!v) throw new Error('no sol price');
    return Number(v);
  }).catch(() => 0);
}
// pump.fun's own API refuses server requests (Cloudflare), so the live lists come from Jupiter's token feeds,
// filtered to coins launched on pump.fun: trending in the last 5 minutes, highest organic score, newest.
const LISTS = { live: 'toptrending/5m?limit=100', active: 'toporganicscore/5m?limit=100', new: 'recent' };
const isPump = t => t && t.id && (t.launchpad === 'pump.fun' || /pump$/.test(t.id));
const jupCoin = t => ({
  mint: t.id, name: String(t.name || '').slice(0, 40), symbol: String(t.symbol || '').replace(/^\$+/, '').slice(0, 16), image: t.icon || '',
  mcapUsd: Number(t.mcap || t.fdv || 0), priceUsd: Number(t.usdPrice || 0), liquidityUsd: Number(t.liquidity || 0), holders: Number(t.holderCount || 0),
  created: Date.parse(t.createdAt || (t.firstPool && t.firstPool.createdAt) || '') || 0, complete: !!t.graduatedPool,
  change1h: t.stats1h && t.stats1h.priceChange != null ? Number(t.stats1h.priceChange) : null,
  vol1h: t.stats1h ? Number(t.stats1h.buyVolume || 0) + Number(t.stats1h.sellVolume || 0) : 0, organic: Number(t.organicScore || 0), program: t.tokenProgram || null,
});
async function pumpList(kind) {
  return L.cached('jl:' + kind, 20000, async () => {
    const r = await L.getJson(`${JUP}/tokens/v2/${LISTS[kind]}`, {}, 8000);
    const arr = Array.isArray(r.json) ? r.json : [];
    if (!r.ok || !arr.length) throw new Error('jupiter ' + r.status);
    return arr.filter(isPump).map(jupCoin);
  });
}
// a fallback: the newest DexScreener token profiles whose mint is a pump.fun one
async function dexPump() {
  return L.cached('dexpump', 60000, async () => {
    const prof = await L.getJson('https://api.dexscreener.com/token-profiles/latest/v1');
    const mints = [...new Set((prof.json || []).filter(p => p.chainId === 'solana' && /pump$/.test(p.tokenAddress)).map(p => p.tokenAddress))].slice(0, 30);
    if (!mints.length) return [];
    const t = await L.getJson('https://api.dexscreener.com/tokens/v1/solana/' + mints.join(','));
    const best = new Map();
    for (const p of t.json || []) { const m = p.baseToken && p.baseToken.address; if (!m || !mints.includes(m)) continue; const cur = best.get(m); if (!cur || (p.liquidity && p.liquidity.usd || 0) > (cur.liquidity && cur.liquidity.usd || 0)) best.set(m, p); }
    return [...best.values()].map(p => ({ mint: p.baseToken.address, name: p.baseToken.name, symbol: p.baseToken.symbol, image: (p.info && p.info.imageUrl) || '',
      mcapUsd: Number(p.marketCap || p.fdv || 0), priceUsd: Number(p.priceUsd || 0), liquidityUsd: Number(p.liquidity && p.liquidity.usd || 0), holders: 0,
      created: Number(p.pairCreatedAt || 0), complete: p.dexId !== 'pumpfun', change1h: p.priceChange && p.priceChange.h1 != null ? Number(p.priceChange.h1) : null, vol1h: Number(p.volume && p.volume.h1 || 0), organic: 0 }));
  });
}
// a curve is only used for the impact maths when it is a plain SOL curve that agrees with the market price
const K_STD = 30e9 * 1073e12;
function sane(cv, mcapUsd, sol) {
  if (!cv || cv.complete || !(cv.vTok > 0) || !(cv.vSol > 0)) return false;
  if (Math.abs(cv.vSol * cv.vTok / K_STD - 1) < .03) return true;
  if (!mcapUsd || !sol) return false;
  const implied = (cv.vSol / 1e9) / (cv.vTok / 1e6) * 1e9 * sol;
  return implied / mcapUsd > .65 && implied / mcapUsd < 1.5;
}
async function coins(tab) {
  let list = [], src = 'jupiter';
  try { list = await pumpList(tab); } catch { try { list = await dexPump(); src = 'dexscreener'; } catch { list = []; } }
  // live price-impact maths straight from the chain: curve reserves while bonding, the PumpSwap pool after
  const onCurve = list.filter(c => !c.complete).slice(0, 40).map(c => c.mint), grad = list.filter(c => c.complete).slice(0, 40);
  const [cv, pools, sol] = await Promise.all([onCurve.length ? C.curves(onCurve).catch(() => ({})) : {}, grad.length ? C.poolBases(grad).catch(() => ({})) : {}, solUsd()]);
  return { src, solUsd: sol, coins: list.map(c => {
    const k = cv[c.mint], ok = sane(k, c.mcapUsd, sol), out = { ...c, complete: c.complete || !!(k && k.complete), curve: ok ? k : null, pool: pools[c.mint] ? { base: pools[c.mint] } : null };
    if (!out.mcapUsd && ok && sol) { out.priceUsd = (k.vSol / 1e9) / (k.vTok / 1e6) * sol; out.mcapUsd = out.priceUsd * 1e9; }
    return out;
  }) };
}
async function jupTokens(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 50) {
    const part = mints.slice(i, i + 50);
    const r = await L.getJson(`${JUP}/tokens/v2/search?query=${part.join(',')}`).catch(() => ({ json: [] }));
    for (const t of Array.isArray(r.json) ? r.json : []) if (t && t.id) out[t.id] = { name: t.name, symbol: t.symbol, image: t.icon || '', priceUsd: Number(t.usdPrice || 0), mcapUsd: Number(t.mcap || t.fdv || 0), liquidityUsd: Number(t.liquidity || 0), decimals: t.decimals, launchpad: t.launchpad || null, graduated: !!t.graduatedPool, holders: Number(t.holderCount || 0) };
  }
  return out;
}
async function tokenInfo(mint) {
  return L.cached('tok:' + mint, 20000, async () => {
    const [info, jup, sol] = await Promise.all([C.mintInfo(mint), jupTokens([mint]).then(o => o[mint] || null).catch(() => null), solUsd()]);
    const pump = !!(jup && jup.launchpad === 'pump.fun') || /pump$/.test(mint);
    const raw = pump && !(jup && jup.graduated) ? (await C.curves([mint]).catch(() => ({})))[mint] || null : null;
    const cv = sane(raw, jup && jup.mcapUsd, sol) ? raw : null;
    const pool = pump && jup && jup.graduated ? ((await C.poolBases([{ mint, program: info.program }]).catch(() => ({})))[mint] || 0) : 0;
    let priceUsd = jup && jup.priceUsd || 0;
    if (!priceUsd && cv && sol) priceUsd = (cv.vSol / 1e9) / (cv.vTok / 10 ** info.decimals) * sol;
    return {
      mint, decimals: info.decimals, program: info.program, supply: Number(info.supply) / 10 ** info.decimals, hook: info.hook,
      name: (jup && jup.name) || 'Unknown token', symbol: (jup && jup.symbol) || '???', image: (jup && jup.image) || '', priceUsd,
      mcapUsd: (jup && jup.mcapUsd) || (cv && sol ? (cv.vSol / 1e9) / (cv.vTok / 1e6) * 1e9 * sol : 0), liquidityUsd: (jup && jup.liquidityUsd) || 0,
      holders: (jup && jup.holders) || 0, complete: pump ? !!((jup && jup.graduated) || (raw && raw.complete)) : null, curve: cv, pool: pool ? { base: pool } : null, pump, solUsd: sol,
    };
  });
}

// ---------- offers ----------
const pub = o => o && ({
  id: o.id, created: new Date(o.created_at).getTime(), buyer: o.buyer, seller: o.seller, mint: o.mint, symbol: o.symbol, name: o.name, image: o.image,
  amount: Number(o.amount_ui), sol: Number(o.lamports) / 1e9, decimals: o.decimals, status: o.status, sig: o.sig || null, nonce: o.nonce, note: o.note || null,
  closed: o.closed_at ? new Date(o.closed_at).getTime() : null,
});
async function event(kind, o, sig) {
  await L.q(`INSERT INTO oc_events (kind, offer_id, mint, symbol, image, amount_ui, sol, buyer, seller, sig) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [kind, o.id, o.mint, o.symbol, o.image, o.amount_ui, Number(o.lamports) / 1e9, o.buyer, o.seller, sig || null]).catch(() => {});
}
// open offers whose nonce moved were filled or cancelled somewhere else: settle them
async function settle(rows) {
  const open = rows.filter(o => o.status === 'open');
  if (!open.length) return rows;
  const nn = await C.readNonces(open.map(o => o.nonce)).catch(() => null);
  if (!nn) return rows;
  for (const o of open) {
    const n = nn[o.nonce];
    if (n && n.value === o.nonce_value) continue;
    const fate = await C.nonceFate(o.nonce, o.id).catch(() => ({ filled: false }));
    const status = fate.filled ? 'filled' : 'cancelled';
    const upd = await L.q(`UPDATE oc_offers SET status=$2, sig=COALESCE(sig,$3), closed_at=now() WHERE id=$1 AND status='open' RETURNING *`, [o.id, status, fate.sig || null]);
    if (upd[0]) { Object.assign(o, upd[0]); await event(fate.filled ? 'fill' : 'cancel', upd[0], fate.sig); }
    await L.q(`UPDATE oc_nonces SET state=$2, updated_at=now() WHERE nonce=$1`, [o.nonce, n ? 'free' : 'closed']).catch(() => {});
  }
  return rows;
}
const newId = () => crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10);

async function build(b, { keepId } = {}) {
  const buyer = String(b.buyer || ''), seller = String(b.seller || ''), mint = String(b.mint || ''), nonce = String(b.nonce || '');
  for (const [k, v] of [['buyer', buyer], ['holder', seller], ['token', mint], ['deposit', nonce]]) if (!C.isAddr(v)) throw L.err(400, `The ${k} address is missing or wrong.`);
  if (buyer === seller) throw L.err(400, 'You cannot make an offer to yourself.');
  const info = await C.mintInfo(mint);
  const amountRaw = C.toRaw(b.amount, info.decimals), lamports = C.toLamports(b.sol);
  if (amountRaw <= 0n) throw L.err(400, 'Enter how many tokens you want.');
  if (lamports < 100000n) throw L.err(400, 'Offer at least 0.0001 SOL.');
  if (lamports > 100000n * 1000000000n) throw L.err(400, 'That is more SOL than an offer here can carry.');
  const n = await C.readNonce(nonce);
  if (!n) throw L.err(409, 'Your deposit slot is not on chain yet. Give it a few seconds and try again.');
  if (n.authority !== buyer) throw L.err(403, 'That deposit slot belongs to another wallet.');
  const busy = await L.q(`SELECT id FROM oc_offers WHERE nonce=$1 AND status='open' LIMIT 1`, [nonce]);
  if (busy[0] && busy[0].id !== keepId) throw L.err(409, 'That deposit slot already carries an open offer.');
  const id = keepId || newId();
  const { tx } = await C.offerTx({ id, buyer, seller, mint, amountRaw, lamports, nonce, nonceValue: n.value });
  return { id, tx, info, amountRaw, lamports, nonceValue: n.value };
}

// ---------- handler ----------
module.exports = async (req, res) => {
  const qs = L.query(req), op = String(L.one(qs.op) || '');
  try {
    if (req.method === 'POST' && L.limited('p:' + L.ip(req), 40, 60000)) throw L.err(429, 'Too many requests. Wait a minute.');
    if (L.dbReady() && op !== 'health' && op !== 'coins' && op !== 'sol') await L.schema();

    if (op === 'health') {
      let rpcOk = false; try { await C.rpc(c => c.getSlot()); rpcOk = true; } catch {}
      return L.send(res, 200, { ok: true, db: L.dbReady(), rpc: rpcOk });
    }
    if (op === 'config') return L.send(res, 200, { ok: true, feeBps: FEE_BPS, nonceRent: await C.nonceRent().catch(() => 1447680), ca: process.env.OC_CA || null, x: process.env.OC_X || null }, L.CACHE(60));
    if (op === 'sol') return L.send(res, 200, { ok: true, usd: await solUsd() }, L.CACHE(30));
    if (op === 'coins') {
      const tab = ['live', 'active', 'new'].includes(String(L.one(qs.tab))) ? String(L.one(qs.tab)) : 'live';
      return L.send(res, 200, { ok: true, ...(await coins(tab)) }, L.CACHE(20));
    }
    if (op === 'token') {
      const mint = String(L.one(qs.mint) || ''); if (!C.isAddr(mint)) throw L.err(400, 'That is not a token address.');
      return L.send(res, 200, { ok: true, token: await tokenInfo(mint) }, L.CACHE(15));
    }
    if (op === 'holders') {
      const mint = String(L.one(qs.mint) || ''); if (!C.isAddr(mint)) throw L.err(400, 'That is not a token address.');
      return L.send(res, 200, { ok: true, ...(await C.holders(mint)) }, L.CACHE(30));
    }
    if (op === 'bags') {
      const w = String(L.one(qs.wallet) || '').trim(); if (!C.isAddr(w)) throw L.err(400, 'That is not a Solana wallet address.');
      const [lam, list] = await Promise.all([C.solBalance(w), C.bags(w)]);
      const meta = await jupTokens(list.map(x => x.mint)).catch(() => ({}));
      const rows = list.map(x => { const m = meta[x.mint] || {}; return { ...x, name: m.name || null, symbol: m.symbol || null, image: m.image || '', priceUsd: m.priceUsd || 0, valueUsd: (m.priceUsd || 0) * x.ui }; })
        .sort((a, b) => b.valueUsd - a.valueUsd || b.ui - a.ui).slice(0, 60);
      return L.send(res, 200, { ok: true, wallet: w, sol: lam / 1e9, solUsd: await solUsd(), bags: rows }, L.CACHE(15));
    }
    if (op === 'check') {
      // before anything is signed: can this offer settle at all? (holder's bag, buyer's SOL, unsupported tokens)
      const buyer = String(L.one(qs.buyer) || ''), seller = String(L.one(qs.seller) || ''), mint = String(L.one(qs.mint) || '');
      for (const [k, v] of [['buyer', buyer], ['holder', seller], ['token', mint]]) if (!C.isAddr(v)) throw L.err(400, `The ${k} address is missing or wrong.`);
      if (buyer === seller) throw L.err(400, 'You cannot make an offer to yourself.');
      const info = await C.mintInfo(mint);
      if (info.hook) throw L.err(400, 'This token runs a transfer hook, which onchain does not support yet.');
      const amountRaw = C.toRaw(L.one(qs.amount) || '0', info.decimals), lamports = C.toLamports(L.one(qs.sol) || '0');
      if (amountRaw <= 0n) throw L.err(400, 'Enter how many tokens you want.');
      if (lamports < 100000n) throw L.err(400, 'Offer at least 0.0001 SOL.');
      const [held, lam, ata, rent, free] = await Promise.all([
        C.holdings(seller, mint, info.program), C.solBalance(buyer), C.ataRent(buyer, mint, info.program), C.nonceRent(),
        L.dbReady() ? L.q(`SELECT n.nonce FROM oc_nonces n WHERE n.owner=$1 AND n.state='free' AND NOT EXISTS (SELECT 1 FROM oc_offers o WHERE o.nonce=n.nonce AND o.status='open') LIMIT 1`, [buyer]).catch(() => []) : [],
      ]);
      const best = held[0] ? held[0].raw : 0n;
      if (best < amountRaw) throw L.err(409, `That wallet holds ${C.fromRaw(best, info.decimals).toLocaleString('en-US', { maximumFractionDigits: 4 })} of this token in one account, less than the offer.`);
      const deposit = free[0] ? 0 : rent;
      const need = Number(lamports) + deposit + ata + 20000 + 890880;    // + fees and the minimum a wallet must keep
      if (lam < need) throw L.err(409, `Your wallet holds ${(lam / 1e9).toFixed(4)} SOL. This offer needs about ${(need / 1e9).toFixed(4)} SOL (the price, a refundable deposit, the token account and fees).`, { need: need / 1e9, have: lam / 1e9 });
      return L.send(res, 200, { ok: true, holderHas: C.fromRaw(best, info.decimals), buyerSol: lam / 1e9, deposit: deposit / 1e9, tokenAccount: ata / 1e9, needSol: need / 1e9 });
    }
    if (op === 'status') {
      const sig = String(L.one(qs.sig) || ''); if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(sig)) throw L.err(400, 'Bad signature.');
      return L.send(res, 200, { ok: true, ...(await C.txStatus(sig)) });
    }

    // ----- reads that need the database
    if (!L.dbReady()) throw L.err(503, 'The offer book is not connected yet.');
    if (op === 'offers') {
      const w = String(L.one(qs.wallet) || ''); if (!C.isAddr(w)) throw L.err(400, 'That is not a Solana wallet address.');
      const rows = await L.q(`SELECT * FROM oc_offers WHERE buyer=$1 OR seller=$1 ORDER BY created_at DESC LIMIT 100`, [w]);
      await settle(rows);
      const free = await L.q(`SELECT nonce FROM oc_nonces WHERE owner=$1 AND state='free'`, [w]);
      return L.send(res, 200, { ok: true, incoming: rows.filter(o => o.seller === w).map(pub), outgoing: rows.filter(o => o.buyer === w).map(pub), deposits: free.map(r => r.nonce) });
    }
    if (op === 'offer') {
      const id = String(L.one(qs.id) || '').slice(0, 20);
      const rows = await L.q(`SELECT * FROM oc_offers WHERE id=$1`, [id]);
      if (!rows[0]) throw L.err(404, 'That offer does not exist.');
      await settle(rows);
      const o = rows[0]; let held = null;
      if (o.status === 'open') { const h = await C.holdings(o.seller, o.mint).catch(() => null); if (h) held = h.reduce((s, x) => s + Number(x.raw), 0) / 10 ** o.decimals; }
      return L.send(res, 200, { ok: true, offer: pub(o), held, tx: o.status === 'open' ? o.tx : null });
    }
    if (op === 'tape') {
      const rows = await L.q(`SELECT * FROM oc_events ORDER BY n DESC LIMIT 40`);
      return L.send(res, 200, { ok: true, events: rows.map(e => ({ n: Number(e.n), at: new Date(e.at).getTime(), kind: e.kind, id: e.offer_id, mint: e.mint, symbol: e.symbol, image: e.image, amount: Number(e.amount_ui), sol: Number(e.sol), buyer: e.buyer, seller: e.seller, sig: e.sig })) }, L.CACHE(5, 20));
    }
    if (op === 'stats') {
      const r = (await L.q(`SELECT count(*) FILTER (WHERE status='open') AS open, count(*) FILTER (WHERE status='filled') AS filled,
        COALESCE(sum(lamports) FILTER (WHERE status='filled'),0) AS vol, (SELECT count(*) FROM (SELECT buyer AS w FROM oc_offers UNION SELECT seller FROM oc_offers) t) AS wallets FROM oc_offers`))[0] || {};
      return L.send(res, 200, { ok: true, open: Number(r.open || 0), filled: Number(r.filled || 0), volumeSol: Number(r.vol || 0) / 1e9, wallets: Number(r.wallets || 0) }, L.CACHE(10));
    }

    // ----- the offer life cycle
    if (req.method !== 'POST') throw L.err(405, 'Use POST.');
    const b = await L.body(req);
    if (op === 'start') {
      const buyer = String(b.buyer || ''); if (!C.isAddr(buyer)) throw L.err(400, 'Connect a wallet first.');
      // a free deposit slot from an earlier, filled offer can carry the next one
      const free = await L.q(`SELECT nonce FROM oc_nonces WHERE owner=$1 AND state='free' ORDER BY updated_at DESC LIMIT 5`, [buyer]);
      for (const r of free) {
        const n = await C.readNonce(r.nonce).catch(() => null);
        if (n && n.authority === buyer) {
          const busy = await L.q(`SELECT 1 FROM oc_offers WHERE nonce=$1 AND status='open' LIMIT 1`, [r.nonce]);
          if (!busy[0]) return L.send(res, 200, { ok: true, nonce: r.nonce, ready: true });
        } else await L.q(`UPDATE oc_nonces SET state='closed', updated_at=now() WHERE nonce=$1`, [r.nonce]);
      }
      const t = await C.nonceCreateTx(buyer);
      return L.send(res, 200, { ok: true, ready: false, ...t });
    }
    if (op === 'build') {
      const r = await build(b);
      const sim = await C.simulate(r.tx).catch(e => ({ err: String(e.message || e) }));
      if (sim && sim.err) throw L.err(409, C.simError(sim));
      return L.send(res, 200, { ok: true, id: r.id, tx: r.tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
    }
    if (op === 'create') {
      const id = String(b.id || ''); if (!/^[A-Za-z0-9]{10}$/.test(id)) throw L.err(400, 'Bad offer id.');
      const r = await build(b, { keepId: id });
      const signed = C.decode(b.signed);
      if (!C.sameOffer(signed, r.tx)) throw L.err(400, 'The signed transaction is not the offer we built. Start again.');
      if (!C.signedBy(signed, b.buyer)) throw L.err(400, 'The buyer signature is missing or wrong.');
      const tk = await tokenInfo(b.mint).catch(() => ({}));
      const row = (await L.q(`INSERT INTO oc_offers (id, buyer, seller, mint, symbol, name, image, decimals, amount_raw, amount_ui, lamports, nonce, nonce_value, tx, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [id, b.buyer, b.seller, b.mint, tk.symbol || null, tk.name || null, tk.image || null, r.info.decimals, r.amountRaw.toString(), C.fromRaw(r.amountRaw, r.info.decimals),
          r.lamports.toString(), b.nonce, r.nonceValue, signed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), String(b.note || '').slice(0, 140) || null]))[0];
      await L.q(`INSERT INTO oc_nonces (nonce, owner, state) VALUES ($1,$2,'busy') ON CONFLICT (nonce) DO UPDATE SET state='busy', updated_at=now()`, [b.nonce, b.buyer]);
      await event('offer', row);
      return L.send(res, 200, { ok: true, offer: pub(row) });
    }
    if (op === 'fill') {
      const id = String(b.id || '').slice(0, 20);
      const rows = await L.q(`SELECT * FROM oc_offers WHERE id=$1`, [id]);
      const o = rows[0]; if (!o) throw L.err(404, 'That offer does not exist.');
      await settle(rows);
      if (o.status !== 'open') throw L.err(409, `That offer is already ${o.status}.`);
      const stored = C.decode(o.tx), signed = C.decode(b.signed);
      if (!signed.serializeMessage().equals(stored.serializeMessage())) throw L.err(400, 'The signed transaction does not match the offer.');
      if (!C.signedBy(signed, o.buyer) || !C.signedBy(signed, o.seller)) throw L.err(400, 'Both signatures are needed to swap.');
      const raw = signed.serialize();
      let sig;
      try { sig = await C.send(raw); } catch (e) {
        const m = String(e.message || e);
        throw L.err(409, /insufficient funds/i.test(m) ? 'Your wallet no longer holds enough of that token.' : /insufficient lamports/i.test(m) ? 'The buyer no longer has enough SOL. The offer cannot settle.' : /nonce|blockhash/i.test(m) ? 'The buyer cancelled or already used this offer.' : 'The swap failed: ' + m.slice(0, 160));
      }
      const c = await C.confirm(sig, raw);
      if (!c.ok && !c.pending) throw L.err(409, 'The swap failed on chain.', { sig });
      const upd = (await L.q(`UPDATE oc_offers SET status='filled', sig=$2, closed_at=now() WHERE id=$1 AND status='open' RETURNING *`, [id, sig]))[0];
      if (upd) { await event('fill', upd, sig); await L.q(`UPDATE oc_nonces SET state='free', updated_at=now() WHERE nonce=$1`, [o.nonce]); }
      return L.send(res, 200, { ok: true, sig, pending: !!c.pending, offer: pub(upd || o) });
    }
    if (op === 'close') {
      const id = String(b.id || '').slice(0, 20), buyer = String(b.buyer || '');
      const o = (await L.q(`SELECT * FROM oc_offers WHERE id=$1`, [id]))[0];
      if (!o) throw L.err(404, 'That offer does not exist.');
      if (o.buyer !== buyer) throw L.err(403, 'Only the wallet that made the offer can cancel it.');
      return L.send(res, 200, { ok: true, ...(await C.nonceCloseTx(buyer, o.nonce)) });
    }
    if (op === 'reclaim') {
      const nonce = String(b.nonce || ''), buyer = String(b.buyer || '');
      if (!C.isAddr(nonce) || !C.isAddr(buyer)) throw L.err(400, 'Bad request.');
      const busy = await L.q(`SELECT 1 FROM oc_offers WHERE nonce=$1 AND status='open' LIMIT 1`, [nonce]);
      if (busy[0]) throw L.err(409, 'That deposit still carries an open offer. Cancel the offer instead.');
      return L.send(res, 200, { ok: true, ...(await C.nonceCloseTx(buyer, nonce)) });
    }
    if (op === 'closed') {
      // after a cancel or reclaim lands: look at the chain and settle our records
      const id = String(b.id || '').slice(0, 20), nonce = String(b.nonce || '');
      if (id) { const rows = await L.q(`SELECT * FROM oc_offers WHERE id=$1`, [id]); await settle(rows); }
      if (C.isAddr(nonce)) { const n = await C.readNonce(nonce).catch(() => 1); if (n === null) await L.q(`UPDATE oc_nonces SET state='closed', updated_at=now() WHERE nonce=$1`, [nonce]); }
      return L.send(res, 200, { ok: true });
    }
    if (op === 'send') {
      const tx = C.decode(b.tx), raw = tx.serialize({ requireAllSignatures: true });
      let sig; try { sig = await C.send(raw); } catch (e) { throw L.err(409, 'Solana refused the transaction: ' + String(e.message || e).slice(0, 180)); }
      const c = await C.confirm(sig, raw, 30000);
      return L.send(res, 200, { ok: c.ok || !!c.pending, sig, pending: !!c.pending, err: c.err || null });
    }
    throw L.err(404, 'Unknown request.');
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code >= 500) console.error('[oc]', op, e && e.stack || e);
    return L.send(res, code, { ok: false, error: code >= 500 && !e.code ? 'Something went wrong. Try again.' : e.message, ...(e.extra || {}) });
  }
};

// ONCHAIN server helpers: responses, bodies, rate limits, Postgres (Neon on Vercel), the master secret.
const crypto = require('crypto');

// Same origin: the page and the API share one host, so JSON answers carry no CORS headers.
// `cors` is only for the coin metadata and image, which pump.fun and indexers read from anywhere.
function send(res, code, obj, cache = 'no-store', cors = false) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (cors) res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(obj));
}
const CACHE = (s, swr = s * 4) => `public, max-age=0, s-maxage=${s}, stale-while-revalidate=${swr}`;
function query(req) {
  const o = {};
  const src = req.query && typeof req.query === 'object' ? Object.entries(req.query) : [...new URL(req.url || '/', 'http://x').searchParams.entries()];
  for (const [k, v] of src) {                    // a repeated key keeps every value, in order
    if (k in o) o[k] = [].concat(o[k], v); else o[k] = v;
  }
  return o;
}
const one = v => Array.isArray(v) ? v[v.length - 1] : v;
async function body(req, max = 3 * 1024 * 1024) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString('utf8')); } catch { return {}; } }
  const chunks = []; let n = 0;
  for await (const c of req) { chunks.push(c); n += c.length; if (n > max) throw err(413, 'That request is too large.'); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}
function ip(req) { return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '?').split(',')[0].trim(); }
const hits = new Map();
function limited(key, n, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms); a.push(now); hits.set(key, a);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return a.length > n;
}
function err(code, msg, extra) { const e = new Error(msg); e.code = code; e.extra = extra; return e; }
async function getJson(url, opt = {}, ms = 8000) {
  const r = await fetch(url, { ...opt, headers: { accept: 'application/json', 'user-agent': 'onchain/1.0', ...(opt.headers || {}) }, signal: AbortSignal.timeout(ms) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, ok: r.ok, json: j };
}
// in-memory cache with request coalescing; on failure it serves the last good value
const mem = new Map();
async function cached(key, ms, fn) {
  const c = mem.get(key);
  if (c && c.has && Date.now() - c.t < ms) return c.v;
  if (c && c.p) return c.p;
  const p = (async () => {
    try { const v = await fn(); mem.set(key, { t: Date.now(), v, has: true }); return v; }
    catch (e) { if (c && c.has) { mem.set(key, { t: c.t, v: c.v, has: true }); return c.v; } mem.delete(key); throw e; }
  })();
  mem.set(key, { ...(c || {}), p }); return p;
}
function forget(prefix) { for (const k of [...mem.keys()]) if (k.startsWith(prefix)) mem.delete(k); }

// ---------- Postgres ----------
let pg = null;
function dbUrl() {
  const e = process.env;
  for (const k of ['DATABASE_URL', 'POSTGRES_URL', 'STORAGE_URL']) if (e[k]) return e[k];
  for (const [k, v] of Object.entries(e)) if (/_URL$/.test(k) && !/UNPOOLED|NON_POOLING|NO_SSL/.test(k) && /^postgres(ql)?:\/\//.test(v || '')) return v;
  return '';
}
async function q(text, params = []) {
  if (process.env.D_PGLITE) {
    if (!pg) { const { PGlite } = require(process.env.D_PGLITE_MOD || '@electric-sql/pglite'); pg = new PGlite(); }
    return (await pg.query(text, params)).rows;
  }
  if (!pg) { const { neon } = require('@neondatabase/serverless'); pg = neon(dbUrl()); }
  return pg.query(text, params);
}
const dbReady = () => !!(process.env.D_PGLITE || dbUrl());
let schemaP = null;
function schema() {
  if (!schemaP) schemaP = (async () => {
    await q(`CREATE TABLE IF NOT EXISTS oc_meta (k text PRIMARY KEY, v text NOT NULL)`);
    // durable nonce accounts opened by buyers; the buyer is the only authority, we only remember which one is free
    await q(`CREATE TABLE IF NOT EXISTS oc_nonces (
      nonce text PRIMARY KEY, owner text NOT NULL, state text NOT NULL DEFAULT 'free',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
    await q(`CREATE INDEX IF NOT EXISTS oc_nonces_owner ON oc_nonces (owner, state)`);
    // offers: the buyer's half-signed swap, waiting for the holder's signature
    await q(`CREATE TABLE IF NOT EXISTS oc_offers (
      id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),
      buyer text NOT NULL, seller text NOT NULL, mint text NOT NULL, symbol text, name text, image text,
      decimals int NOT NULL, amount_raw text NOT NULL, amount_ui double precision NOT NULL, lamports bigint NOT NULL,
      nonce text NOT NULL, nonce_value text NOT NULL, tx text NOT NULL, note text,
      status text NOT NULL DEFAULT 'open', sig text, closed_at timestamptz)`);
    await q(`CREATE INDEX IF NOT EXISTS oc_offers_seller ON oc_offers (seller, status)`);
    await q(`CREATE INDEX IF NOT EXISTS oc_offers_buyer ON oc_offers (buyer, status)`);
    await q(`CREATE INDEX IF NOT EXISTS oc_offers_mint ON oc_offers (mint, status)`);
    // the tape: every offer, fill and cancel, in order
    await q(`CREATE TABLE IF NOT EXISTS oc_events (
      n bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), kind text NOT NULL, offer_id text NOT NULL,
      mint text, symbol text, image text, amount_ui double precision, sol double precision, buyer text, seller text, sig text)`);
  })().catch(e => { schemaP = null; throw e; });
  return schemaP;
}
async function meta(k) { const r = await q(`SELECT v FROM oc_meta WHERE k = $1`, [k]); return r[0] ? r[0].v : null; }
async function setMeta(k, v) { await q(`INSERT INTO oc_meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [k, String(v)]); }
// The master secret: env OC_MASTER (64 hex) or made once and kept in the database, never sent anywhere.
// It only signs offer ids; no key that can move coins is ever derived from it.
let masterP = null;
function master() {
  if (!masterP) masterP = (async () => {
    if (process.env.OC_MASTER && /^[0-9a-f]{64}$/i.test(process.env.OC_MASTER)) return Buffer.from(process.env.OC_MASTER, 'hex');
    await schema();
    await q(`INSERT INTO oc_meta (k, v) VALUES ('master', $1) ON CONFLICT (k) DO NOTHING`, [crypto.randomBytes(32).toString('hex')]);
    return Buffer.from(await meta('master'), 'hex');
  })().catch(e => { masterP = null; throw e; });
  return masterP;
}
async function hmac(label, data) { return crypto.createHmac('sha256', await master()).update(label).update(data || '').digest(); }

module.exports = { send, CACHE, query, one, body, ip, limited, err, getJson, cached, forget, q, dbReady, schema, meta, setMeta, master, hmac };

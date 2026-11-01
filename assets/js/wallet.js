// Wallet Standard by hand: wallets announce themselves, we list them, connect, and hand them the server-built
// transaction bytes. No wallet library, no outside script. Phantom, Backpack, Solflare and friends.
const WALLETS = [], seenL = new Set(), curL = new Set();
const usable = w => w && w.features && w.features['standard:connect'] && (w.chains || []).some(c => String(c).startsWith('solana:')) && (w.features['solana:signTransaction'] || w.features['solana:signAndSendTransaction']);
const reg = Object.freeze({ register(...ws) { for (const w of ws) if (usable(w) && !WALLETS.includes(w)) WALLETS.push(w); seenL.forEach(f => { try { f(WALLETS.slice()); } catch {} }); return () => {}; } });
try { addEventListener('wallet-standard:register-wallet', e => { try { e.detail(reg); } catch {} }); } catch {}
try { dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: reg })); } catch {}

export const KNOWN = [
  { name: 'Phantom', url: 'https://phantom.com/download' },
  { name: 'Solflare', url: 'https://solflare.com/download' },
  { name: 'Backpack', url: 'https://backpack.app/download' },
];
let CUR = null;
const LAST = 'oc:wallet';
const fire = () => curL.forEach(f => { try { f(CUR); } catch {} });
export const wallets = () => WALLETS.slice();
export const onWallets = f => { seenL.add(f); return () => seenL.delete(f); };
export const current = () => CUR;
export const onChange = f => { curL.add(f); try { f(CUR); } catch {} return () => curL.delete(f); };
export const short = a => a ? String(a).slice(0, 4) + '…' + String(a).slice(-4) : '';

export async function connect(w, { silent = false } = {}) {
  const r = await w.features['standard:connect'].connect(silent ? { silent: true } : undefined);
  const accounts = (r && r.accounts && r.accounts.length ? r.accounts : w.accounts) || [];
  const acc = accounts.find(a => (a.chains || []).some(c => String(c).startsWith('solana:'))) || accounts[0];
  if (!acc) throw new Error('The wallet did not share an account.');
  CUR = { wallet: w, account: acc, address: acc.address, name: w.name, icon: w.icon };
  try { localStorage.setItem(LAST, w.name); } catch {}
  const ev = w.features['standard:events'];
  if (ev && !w.__ocOn) {
    w.__ocOn = true;
    try { ev.on('change', ch => { if (!CUR || CUR.wallet !== w || !ch || !ch.accounts) return; if (!ch.accounts.length) { CUR = null; fire(); } else { const a = ch.accounts[0]; CUR = { ...CUR, account: a, address: a.address }; fire(); } }); } catch {}
  }
  fire(); return CUR;
}
export async function restore() {
  let name = null; try { name = localStorage.getItem(LAST); } catch {}
  if (!name || CUR) return;
  const w = WALLETS.find(x => x.name === name); if (!w) return;
  try { await connect(w, { silent: true }); } catch {}
}
export async function disconnect() {
  const w = CUR && CUR.wallet; CUR = null; fire();
  try { localStorage.removeItem(LAST); } catch {}
  try { if (w && w.features['standard:disconnect']) await w.features['standard:disconnect'].disconnect(); } catch {}
}
export async function signTx(bytes) {
  if (!CUR) throw new Error('Connect a wallet first.');
  const f = CUR.wallet.features['solana:signTransaction'];
  if (!f) throw new Error('This wallet cannot sign here. Try Phantom, Solflare or Backpack.');
  const out = await f.signTransaction({ account: CUR.account, transaction: bytes, chain: 'solana:mainnet' });
  const o = Array.isArray(out) ? out[0] : out;
  if (!o || !o.signedTransaction) throw new Error('The wallet returned no signed transaction.');
  return new Uint8Array(o.signedTransaction);
}
// sign + send in the wallet when it can (Phantom prefers this), else sign here and send through our API
export async function signAndSend(bytes, relay) {
  if (!CUR) throw new Error('Connect a wallet first.');
  const f = CUR.wallet.features['solana:signAndSendTransaction'];
  if (f) {
    const out = await f.signAndSendTransaction({ account: CUR.account, transaction: bytes, chain: 'solana:mainnet' });
    const o = Array.isArray(out) ? out[0] : out;
    if (o && o.signature) return bs58(new Uint8Array(o.signature));
  }
  const signed = await signTx(bytes);
  return relay(b64(signed));
}
export const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
export const unb64 = s => { const bin = atob(String(s || '')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function bs58(bytes) {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] * 256; digits[j] = carry % 58; carry = Math.floor(carry / 58); }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPH[digits[i]];
  return out;
}
export function walletError(e) {
  const m = String((e && (e.message || e.toString())) || '');
  if (/reject|denied|cancel|declin|closed/i.test(m) || (e && e.code === 4001)) return 'You cancelled the request in your wallet.';
  if (/insufficient|not enough|0x1\b/i.test(m)) return 'Your wallet does not hold enough SOL for this.';
  return m ? m.replace(/^Error:\s*/, '').slice(0, 220) : 'The wallet could not sign. Try again.';
}

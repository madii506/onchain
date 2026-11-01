// ONCHAIN on-chain side. The server holds no key that can move anyone's coins. It builds transactions, checks them
// and relays them:
//   1. the buyer opens a durable nonce account (they are its only authority) so an offer can wait for days;
//   2. the buyer signs their half of a swap against that nonce: their SOL to the holder, the holder's tokens to them;
//   3. the holder signs the other half and the one transaction swaps both sides, all or nothing.
// Cancelling = the buyer withdraws the nonce account, which kills the half-signed transaction for good.
const L = require('./_lib');

let W3, SPL;
const w3 = () => W3 || (W3 = require('@solana/web3.js'));
const spl = () => SPL || (SPL = require('@solana/spl-token'));

const RPCS = [process.env.RPC_URL, 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
const timedFetch = ms => (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
let conns = null;
function connections() {
  if (!conns) { const { Connection } = w3(); conns = RPCS.map(u => new Connection(u, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: timedFetch(12000) })); }
  return conns;
}
async function rpc(fn) {
  let last;
  for (const c of connections()) {
    try { return await fn(c); } catch (e) {
      last = e; const m = String((e && e.message) || e);
      if (!/fetch|network|timeout|timed out|429|50[234]|ECONN|socket|Too many|rate|abort|ENOTFOUND|EAI_AGAIN|forbidden|403/i.test(m)) throw e;
    }
  }
  throw L.err(502, 'Solana RPC is busy right now. Try again in a moment.', { detail: String((last && last.message) || last).slice(0, 200) });
}

const SOL = 1e9;
const WSOL = 'So11111111111111111111111111111111111111112';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const pk = s => { const { PublicKey } = w3(); try { return new PublicKey(String(s).trim()); } catch { throw L.err(400, 'That is not a Solana address.'); } };
const isAddr = s => { try { pk(s); return true; } catch { return false; } };
const onCurve = s => { try { return w3().PublicKey.isOnCurve(pk(s).toBytes()); } catch { return false; } };

// ---------- tokens ----------
async function mintInfo(mint) {
  return L.cached('mint:' + mint, 600000, async () => {
    const m = pk(mint);
    const acc = await rpc(c => c.getAccountInfo(m, 'confirmed'));
    if (!acc) throw L.err(404, 'That token does not exist on Solana.');
    const S = spl(), prog = acc.owner;
    if (!prog.equals(S.TOKEN_PROGRAM_ID) && !prog.equals(S.TOKEN_2022_PROGRAM_ID)) throw L.err(400, 'That address is not a token mint.');
    const info = S.unpackMint(m, acc, prog);
    let hook = false;
    if (prog.equals(S.TOKEN_2022_PROGRAM_ID)) { try { hook = !!S.getTransferHook(info); } catch {} }
    return { mint, program: prog.toBase58(), decimals: info.decimals, supply: info.supply.toString(), hook };
  });
}
// every token account an owner holds for one mint (both token programs), biggest first
async function holdings(owner, mint, program) {
  const r = await rpc(c => c.getParsedTokenAccountsByOwner(pk(owner), { mint: pk(mint) }, 'confirmed'));
  return (r.value || []).map(a => ({ account: a.pubkey.toBase58(), raw: BigInt(a.account.data.parsed.info.tokenAmount.amount), program: a.account.owner.toBase58() }))
    .filter(a => !program || a.program === program).sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0));
}
function toRaw(ui, decimals) {
  const s = String(ui).trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) throw L.err(400, 'Enter a plain number for the amount.');
  const [w, f = ''] = s.split('.');
  const raw = BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return raw;
}
const fromRaw = (raw, decimals) => Number(raw) / 10 ** decimals;
function toLamports(sol) {
  const s = String(sol).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw L.err(400, 'Enter a plain number of SOL.');
  const [w, f = ''] = s.split('.');
  return BigInt(w) * 1000000000n + BigInt((f + '000000000').slice(0, 9));
}

// ---------- the nonce ----------
async function nonceRent() { return L.cached('nonceRent', 3600000, () => rpc(c => c.getMinimumBalanceForRentExemption(w3().NONCE_ACCOUNT_LENGTH))); }
async function readNonce(nonce) {
  const { NonceAccount, SystemProgram } = w3();
  const acc = await rpc(c => c.getAccountInfo(pk(nonce), 'confirmed'));
  if (!acc) return null;
  if (!acc.owner.equals(SystemProgram.programId) || acc.data.length !== w3().NONCE_ACCOUNT_LENGTH) return null;
  const n = NonceAccount.fromAccountData(acc.data);
  return { authority: n.authorizedPubkey.toBase58(), value: n.nonce, lamports: acc.lamports };
}
async function readNonces(list) {
  const { NonceAccount, SystemProgram } = w3();
  const out = {};
  for (let i = 0; i < list.length; i += 100) {
    const part = list.slice(i, i + 100);
    const accs = await rpc(c => c.getMultipleAccountsInfo(part.map(pk), 'confirmed'));
    part.forEach((n, j) => {
      const a = accs[j];
      out[n] = a && a.owner.equals(SystemProgram.programId) && a.data.length === w3().NONCE_ACCOUNT_LENGTH
        ? (() => { const x = NonceAccount.fromAccountData(a.data); return { authority: x.authorizedPubkey.toBase58(), value: x.nonce, lamports: a.lamports }; })() : null;
    });
  }
  return out;
}
async function latest() { return (await rpc(c => c.getLatestBlockhash('confirmed'))).blockhash; }

// step 1: a fresh nonce account, authority = the buyer. The throwaway account key signs its own creation here and is
// then forgotten: once it exists, only the buyer can use or close it.
async function nonceCreateTx(buyer) {
  const { Keypair, SystemProgram, Transaction, ComputeBudgetProgram } = w3();
  const b = pk(buyer), kp = Keypair.generate(), rent = await nonceRent();
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 }));
  tx.add(...SystemProgram.createNonceAccount({ fromPubkey: b, noncePubkey: kp.publicKey, authorizedPubkey: b, lamports: rent }).instructions);
  tx.feePayer = b; tx.recentBlockhash = await latest();
  tx.partialSign(kp);
  return { tx: tx.serialize({ requireAllSignatures: false }).toString('base64'), nonce: kp.publicKey.toBase58(), rent };
}
// close a nonce account and hand its rent back (cancels any offer signed against it)
async function nonceCloseTx(buyer, nonce) {
  const { SystemProgram, Transaction, ComputeBudgetProgram } = w3();
  const n = await readNonce(nonce);
  if (!n) throw L.err(409, 'That deposit is already closed.');
  if (n.authority !== buyer) throw L.err(403, 'Only the wallet that made the offer can close it.');
  const b = pk(buyer), tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 }));
  tx.add(SystemProgram.nonceWithdraw({ noncePubkey: pk(nonce), authorizedPubkey: b, toPubkey: b, lamports: n.lamports }));
  tx.feePayer = b; tx.recentBlockhash = await latest();
  return { tx: tx.serialize({ requireAllSignatures: false }).toString('base64'), lamports: n.lamports };
}

// step 2: the swap itself, against the buyer's nonce. Deterministic: same inputs + same nonce value = same bytes,
// which is how the server checks that what was signed is exactly this and nothing else.
async function offerTx({ id, buyer, seller, mint, amountRaw, lamports, nonce, nonceValue }) {
  const { Transaction, SystemProgram, ComputeBudgetProgram, TransactionInstruction } = w3();
  const S = spl();
  const info = await mintInfo(mint), prog = pk(info.program);
  if (info.hook) throw L.err(400, 'This token runs a transfer hook, which ONCHAIN does not support yet.');
  const b = pk(buyer), s = pk(seller), m = pk(mint);
  const held = await holdings(seller, mint, info.program);
  const src = held.find(h => h.raw >= amountRaw);
  if (!src) throw L.err(409, `That wallet holds ${held.length ? fromRaw(held[0].raw, info.decimals).toLocaleString('en-US') : 'none'} of this token, less than the offer.`);
  const dst = S.getAssociatedTokenAddressSync(m, b, false, prog);
  const tx = new Transaction({ feePayer: b, nonceInfo: { nonce: nonceValue, nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey: pk(nonce), authorizedPubkey: b }) } });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 90000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 40000 }));
  tx.add(S.createAssociatedTokenAccountIdempotentInstruction(b, dst, b, m, prog));
  tx.add(S.createTransferCheckedInstruction(pk(src.account), m, dst, s, amountRaw, info.decimals, [], prog));
  tx.add(SystemProgram.transfer({ fromPubkey: b, toPubkey: s, lamports: Number(lamports) }));
  tx.add(new TransactionInstruction({ programId: pk(MEMO), keys: [], data: Buffer.from('onchain:' + id) }));
  return { tx, info, source: src.account };
}

async function simulate(tx) {
  const { VersionedTransaction } = w3();
  const v = new VersionedTransaction(tx.compileMessage());
  const r = await rpc(c => c.simulateTransaction(v, { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' }));
  return r.value;
}
function simError(sim) {
  const logs = (sim.logs || []).join('\n'), e = JSON.stringify(sim.err || '');
  if (/Error: insufficient funds/i.test(logs)) return 'The holder no longer has that many tokens.';
  if (/insufficient lamports|InsufficientFundsForFee|InsufficientFundsForRent|AccountNotFound/i.test(logs + e)) return 'The buying wallet does not hold enough SOL for this offer (price + about 0.003 SOL for fees and the token account).';
  if (/BlockhashNotFound|AdvanceNonce|nonce/i.test(e + logs)) return 'That deposit slot was used or closed. Start the offer again.';
  return 'The swap would fail on chain: ' + (sim.err ? e.slice(0, 140) : 'unknown error');
}

// signatures: legacy transactions, so verify each one against the exact message bytes
function decode(b64) {
  const { Transaction } = w3();
  try { return Transaction.from(Buffer.from(String(b64 || ''), 'base64')); } catch { throw L.err(400, 'That transaction could not be read.'); }
}
function signedBy(tx, who) {
  const s = tx.signatures.find(x => x.publicKey.toBase58() === who);
  if (!s || !s.signature) return false;
  const crypto = require('crypto');
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(s.publicKey.toBytes())]);
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  return crypto.verify(null, tx.serializeMessage(), key, Buffer.from(s.signature));
}

// some wallets add compute-budget or Lighthouse guard instructions when they sign; anything else must match exactly
const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
function sameOffer(signed, built) {
  if (signed.serializeMessage().equals(built.serializeMessage())) return true;
  const safe = new Set([w3().ComputeBudgetProgram.programId.toBase58(), LIGHTHOUSE]);
  const a = signed.compileMessage(), b = built.compileMessage();
  if (a.recentBlockhash !== b.recentBlockhash || !a.accountKeys[0].equals(b.accountKeys[0])) return false;
  // same signers, and the nonce advance must stay the very first instruction (or the offer could never land)
  if (a.header.numRequiredSignatures !== b.header.numRequiredSignatures) return false;
  const first = m => { const ix = m.instructions[0]; return ix ? m.accountKeys[ix.programIdIndex].toBase58() + '|' + ix.accounts.map(i => m.accountKeys[i].toBase58()).join(',') + '|' + ix.data : ''; };
  if (first(a) !== first(b)) return false;
  // an added guard may only lean on the fee payer, never on the holder's signature
  for (const ix of a.instructions) if (safe.has(a.accountKeys[ix.programIdIndex].toBase58()) && ix.accounts.some(i => i !== 0 && a.isAccountSigner(i))) return false;
  const norm = m => m.instructions.map(ix => ({ p: m.accountKeys[ix.programIdIndex].toBase58(),
    k: ix.accounts.map(i => m.accountKeys[i].toBase58() + (m.isAccountWritable(i) ? 'w' : '') + (m.isAccountSigner(i) ? 's' : '')).join(','), d: ix.data }))
    .filter(x => !safe.has(x.p));
  const A = norm(a), B = norm(b);
  return A.length === B.length && A.every((x, i) => x.p === B[i].p && x.k === B[i].k && x.d === B[i].d);
}

async function send(raw) {
  const sig = await rpc(c => c.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 4 }));
  return sig;
}
async function confirm(sig, raw, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await rpc(c => c.getSignatureStatuses([sig], { searchTransactionHistory: false })).catch(() => null);
    const v = st && st.value && st.value[0];
    if (v && v.err) return { ok: false, err: v.err };
    if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) return { ok: true };
    if (raw) await rpc(c => c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })).catch(() => {});
    await new Promise(r => setTimeout(r, 1800));
  }
  return { ok: false, pending: true };
}
async function txStatus(sig) {
  const st = await rpc(c => c.getSignatureStatuses([sig], { searchTransactionHistory: true }));
  const v = st && st.value && st.value[0];
  if (!v) return { state: 'unknown' };
  if (v.err) return { state: 'failed', err: v.err };
  return { state: v.confirmationStatus || 'processed' };
}
// what happened to a nonce we were watching: find the transaction that moved it and whether it carried our memo
async function nonceFate(nonce, id) {
  const sigs = await rpc(c => c.getSignaturesForAddress(pk(nonce), { limit: 5 }, 'confirmed')).catch(() => []);
  for (const s of sigs) {
    if (s.err) continue;
    if (s.memo && s.memo.includes('onchain:' + id)) return { filled: true, sig: s.signature };
  }
  return { filled: false, sig: sigs[0] ? sigs[0].signature : null };
}

// rent for the buyer's token account, or 0 when it already exists
async function ataRent(owner, mint, program) {
  const S = spl(), prog = pk(program), ata = S.getAssociatedTokenAddressSync(pk(mint), pk(owner), false, prog);
  const acc = await rpc(c => c.getAccountInfo(ata, 'confirmed'));
  if (acc) return 0;
  return L.cached('ataRent:' + program, 3600000, () => rpc(c => c.getMinimumBalanceForRentExemption(prog.equals(S.TOKEN_2022_PROGRAM_ID) ? 170 : 165)));
}

// ---------- wallets and holders ----------
async function solBalance(addr) { return rpc(c => c.getBalance(pk(addr), 'confirmed')); }
async function bags(owner) {
  const S = spl(), o = pk(owner);
  const [a, b] = await Promise.all([
    rpc(c => c.getParsedTokenAccountsByOwner(o, { programId: S.TOKEN_PROGRAM_ID }, 'confirmed')),
    rpc(c => c.getParsedTokenAccountsByOwner(o, { programId: S.TOKEN_2022_PROGRAM_ID }, 'confirmed')).catch(() => ({ value: [] })),
  ]);
  const by = new Map();
  for (const x of [...(a.value || []), ...(b.value || [])]) {
    const i = x.account.data.parsed.info, amt = i.tokenAmount;
    if (!amt || amt.amount === '0' || i.mint === WSOL) continue;
    const cur = by.get(i.mint) || { mint: i.mint, raw: 0n, decimals: amt.decimals };
    cur.raw += BigInt(amt.amount); by.set(i.mint, cur);
  }
  return [...by.values()].map(x => ({ mint: x.mint, decimals: x.decimals, raw: x.raw.toString(), ui: fromRaw(x.raw, x.decimals) }));
}
// the biggest real wallets holding a token: pools, curves and other program accounts are left out (they are PDAs)
async function holders(mint) {
  return L.cached('holders:' + mint, 45000, async () => {
    const info = await mintInfo(mint);
    const big = await rpc(c => c.getTokenLargestAccounts(pk(mint), 'confirmed'));
    const accts = (big.value || []).filter(x => x.uiAmount > 0).slice(0, 20);
    const parsed = await rpc(c => c.getMultipleParsedAccounts(accts.map(x => x.address), { commitment: 'confirmed' }));
    const supply = Number(info.supply) / 10 ** info.decimals;
    const rows = [];
    accts.forEach((x, i) => {
      const p = parsed.value[i]; const owner = p && p.data && p.data.parsed && p.data.parsed.info && p.data.parsed.info.owner;
      if (!owner) return;
      rows.push({ owner, account: x.address.toBase58(), ui: x.uiAmount, pct: supply ? x.uiAmount / supply : 0, wallet: onCurve(owner) });
    });
    return { decimals: info.decimals, supply, rows };
  });
}
// the pump.fun accounts that hold a coin's supply: its bonding curve and, once graduated, its canonical PumpSwap pool
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
function pumpAccounts(mint) {
  const { PublicKey } = w3(), m = pk(mint);
  const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), m.toBuffer()], pk(PUMP))[0];
  const auth = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), m.toBuffer()], pk(PUMP))[0];
  const idx = Buffer.alloc(2); idx.writeUInt16LE(0);
  const pool = PublicKey.findProgramAddressSync([Buffer.from('pool'), idx, auth.toBuffer(), m.toBuffer(), pk(WSOL).toBuffer()], pk(PUMPSWAP))[0];
  return { curve: curve.toBase58(), pool: pool.toBase58() };
}
// graduated pump.fun coins trade in their canonical PumpSwap pool: its token vault is the pool's associated account
async function poolBases(list) {
  const S = spl(), keys = [];
  for (const x of list) { try { keys.push(S.getAssociatedTokenAddressSync(pk(x.mint), pk(pumpAccounts(x.mint).pool), true, pk(x.program || S.TOKEN_PROGRAM_ID.toBase58()))); } catch { keys.push(null); } }
  const ok = keys.filter(Boolean); if (!ok.length) return {};
  const accs = await rpc(c => c.getMultipleAccountsInfo(ok, 'confirmed')).catch(() => []);
  const out = {}; let j = 0;
  list.forEach((x, i) => { if (!keys[i]) return; const a = accs[j++]; if (a && a.data.length >= 72) { const v = Number(a.data.readBigUInt64LE(64)); if (v > 0) out[x.mint] = v; } });
  return out;
}
// pump.fun curve reserves for price-impact maths (virtual token/SOL reserves, complete flag)
async function curves(mints) {
  const { PublicKey } = w3();
  const keys = mints.map(m => PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), pk(m).toBuffer()], pk(PUMP))[0]);
  const accs = await rpc(c => c.getMultipleAccountsInfo(keys, 'confirmed')).catch(() => []);
  const out = {};
  mints.forEach((m, i) => {
    const a = accs[i]; if (!a || a.data.length < 49) return;
    const d = a.data;
    out[m] = { vTok: Number(d.readBigUInt64LE(8)), vSol: Number(d.readBigUInt64LE(16)), rTok: Number(d.readBigUInt64LE(24)), rSol: Number(d.readBigUInt64LE(32)), complete: d[48] === 1 };
  });
  return out;
}

module.exports = { w3, spl, rpc, pk, isAddr, onCurve, SOL, WSOL, mintInfo, holdings, toRaw, fromRaw, toLamports, nonceRent, readNonce, readNonces, nonceCreateTx, nonceCloseTx, offerTx, simulate, simError, decode, signedBy, sameOffer, send, confirm, txStatus, nonceFate, solBalance, ataRent, bags, holders, pumpAccounts, poolBases, curves, latest };

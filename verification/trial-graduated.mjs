// Hook Launcher ENGINE — LiteSVM proof suite for the GRADUATED LATCH
// (rule 1, mode 2). Companion to trial.mjs: same harness idioms, ENGINE
// binary only (no registry / venue shim), assertions counted TH-style.
//
// Graduated semantics under test (implementation contract):
//   frac_bps = 10000 if latched, else max(base_frac, time_frac, dip_frac)
//   time_frac = elapsed-since-blended-anchor / vesting_secs
//   dip_frac  = drawdown(basis vs observed min EMA) x dip_mult
//   cap       = max(cap, frac x peak / 10000)   (ratchets at every eval)
//   a sender transfer passes iff sold + amount <= cap, then sold += amount
//   full exit (post-transfer source balance 0) zeroes grad fields [136..192]
//   self-transfers skip the graduated path entirely
//
// Holder extended layout (192B graduated / migrated holders):
//   peak u64 @136, sold u64 @144, cap u64 @152, anchor i64 @160,
//   min_price u128 @168. Legacy fields: basis_num u128 @6, basis_den @22,
//   latched @38. Legacy 136B holders migrate lazily on their first
//   GRADUATED evaluation, rent topped up from the mint's rent vault.
import { LiteSVM, FailedTransactionMetadata, Clock } from 'litesvm';
import {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createInitializeTransferHookInstruction, createInitializeMintInstruction,
  createMintToInstruction, createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync, getMintLen, ExtensionType,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const kp = JSON.parse(fs.readFileSync(path.join(DIR, 'engine-keypair.json'), 'utf8'));
const ENGINE = Keypair.fromSecretKey(Uint8Array.from(kp)).publicKey;
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID;
const IX_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const WHOLE = 10n ** 9n;
const SUPPLY = 1_000_000n * WHOLE;
const PRICE_2E9 = 2_000_000_000n;

const svm = new LiteSVM();
svm.addProgramFromFile(ENGINE, path.join(DIR, 'target/deploy/engine.so'));

// Controllable clock (registry trial idiom): crank/gate read unix_timestamp.
// `nowTs` mirrors the clock so the JS replica below can compute the exact
// fraction/cap the contract should derive at the current instant.
let clockSlot = 1000n;
let nowTs = 0;
const setTime = (ts) => { nowTs = ts; clockSlot += 17n; svm.setClock(new Clock(clockSlot, 0n, 0n, 0n, BigInt(ts))); };
const T0 = 1_760_000_000;
setTime(T0);

const payer = Keypair.generate(); // mint authority + config authority (most mints)
svm.airdrop(payer.publicKey, BigInt(300 * LAMPORTS_PER_SOL));

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, ENGINE)[0];
const configPda = (mint) => pda([Buffer.from('config'), mint.toBuffer()]);
const holderPda = (mint, owner) => pda([Buffer.from('holder'), mint.toBuffer(), owner.toBuffer()]);
const vaultPda = (mint) => pda([Buffer.from('rentvault'), mint.toBuffer()]);
const metaPda = (mint) => pda([Buffer.from('extra-account-metas'), mint.toBuffer()]);
const pricePda = (mint) => pda([Buffer.from('price'), mint.toBuffer()]);

// ---------- tx plumbing ----------
function runTx(ixs, signers, label) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(...signers);
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) {
    const e = new Error(label + ' failed');
    try { const m = res.meta(); e.logs = typeof m.logs === 'function' ? m.logs() : (m.logs || []); }
    catch { e.logs = []; }
    e.chainErr = res.err();
    throw e;
  }
  return res;
}
const send = (ixs, signers, label) => runTx(ixs, signers, label);

const ERR_BY_LOG = [
  ['partially locked', 'PartialLocked'],
  ['locked: stale price feed', 'StalePrice'],
  ['locked: no basis record', 'BasisMissing'],
  ['locked: price', 'Locked'],
  ['bad gate account', 'BadGateAccount'],
  ['holder gate', 'NotGateHolder'],
  ['venue transfer forbidden', 'VenueTransferForbidden'],
  ['wallet transfer forbidden', 'P2PTransferForbidden'],
  ['bad registration account', 'BadRegistration'],
  ['not registered', 'NotRegistered'],
  ['max wallet exceeded', 'MaxWalletExceeded'],
  ['rejected caller', 'BadCaller'],
  ['config is Locked', 'ConfigLocked'],
  ['HolderVote config writes', 'UnsupportedMode'],
  ['rent vault underfunded', 'RentVaultUnderfunded'],
  ['holder state missing', 'HolderMissing'],
  ['rejected rule_id', 'UnknownRule'],
];
function classify(e) {
  const logs = (e.logs || []).join('\n');
  for (const [needle, name] of ERR_BY_LOG) if (logs.includes(needle)) return name;
  const lm = logs.match(/custom program error: 0x([0-9a-f]+)/i);
  if (lm) return 'Custom' + parseInt(lm[1], 16);
  const m = JSON.stringify(e.chainErr || {}).match(/"Custom":(\d+)/);
  if (m) return 'Custom' + m[1];
  return 'Other:' + (logs || String(e.message)).slice(-200).replace(/\n/g, ' | ');
}
async function attempt(fn) { try { await fn(); return null; } catch (e) { return classify(e); } }

const acctData = (pk) => { const a = svm.getAccount(pk); return a ? Buffer.from(a.data) : null; };
const bal = (ata) => { const d = acctData(ata); return d ? d.readBigUInt64LE(64) : 0n; };
const readU128 = (d, o) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);
const holderState = (mint, acct) => {
  const d = acctData(holderPda(mint, acct));
  if (!d) return null;
  return { registered: d[1] === 1, basis: readU128(d, 6), latched: d[38] === 1 };
};
const feedEma = (mint) => { const d = acctData(pricePda(mint)); return d ? readU128(d, 97) : null; };

// ---------- graduated state reader + JS replica (exact contract math) ----------
// Returns BigInt for basis/peak/sold/cap/min, Number for len/anchor.
const gradState = (mint, acct) => {
  const d = acctData(holderPda(mint, acct));
  if (!d) return null;
  const u64 = (o) => (d.length >= o + 8 ? d.readBigUInt64LE(o) : 0n);
  const den = d.length >= 38 ? readU128(d, 22) : 0n;
  return {
    len: d.length,
    basis: den === 0n ? 0n : readU128(d, 6) / den,
    latched: d.length > 38 ? d[38] === 1 : false,
    peak: u64(136),
    sold: u64(144),
    cap: u64(152),
    anchor: d.length >= 168 ? Number(d.readBigInt64LE(160)) : 0,
    min: d.length >= 184 ? readU128(d, 168) : 0n,
  };
};
// Raw-param defaults mirror the contract: vesting 0 -> 432000,
// dip_mult 0 -> 20000 (2x). All math is BigInt floor math, in the
// contract's operation order.
function expectedFrac(state, now, { base = 0, vesting = 0, dipMult = 0 } = {}) {
  if (!state) return 0n;
  if (state.latched) return 10_000n;
  const vestEff = BigInt(vesting === 0 ? 432_000 : vesting);
  const dipEff = BigInt(dipMult === 0 ? 20_000 : dipMult);
  let frac = BigInt(base);
  let elapsed = BigInt(now) - BigInt(state.anchor);
  if (elapsed < 0n) elapsed = 0n;
  let timeFrac = (elapsed * 10_000n) / vestEff;
  if (timeFrac > 10_000n) timeFrac = 10_000n;
  if (timeFrac > frac) frac = timeFrac;
  if (state.basis > 0n && state.min < state.basis) {
    let dipFrac = (((state.basis - state.min) * 10_000n) / state.basis) * dipEff / 10_000n;
    if (dipFrac > 10_000n) dipFrac = 10_000n;
    if (dipFrac > frac) frac = dipFrac;
  }
  return frac;
}
function expectedCap(state, now, params = {}) {
  if (!state) return 0n;
  const ratchet = (expectedFrac(state, now, params) * state.peak) / 10_000n;
  return state.cap > ratchet ? state.cap : ratchet;
}

// ---------- config payload (mirrors engine parse_config_payload) ----------
function configPayload({ mode, authority, rules = [], venues = [], exemptions = [], feeBps = 0, feeMax = 0n, beneficiaryMode = 0, feeVault = null }, tag) {
  const parts = [Buffer.from([tag, mode]), authority.toBuffer(), Buffer.from([rules.length])];
  for (const r of rules) {
    const e = Buffer.alloc(68);
    e.writeUInt16LE(r.id, 0);
    e[2] = r.enabled === false ? 0 : 1;
    if (r.params) r.params.copy(e, 4);
    parts.push(e);
  }
  parts.push(Buffer.from([venues.length]));
  for (const v of venues) parts.push(v.toBuffer());
  parts.push(Buffer.from([exemptions.length]));
  for (const x of exemptions) parts.push(x.toBuffer());
  const tail = Buffer.alloc(2 + 8 + 1 + 32);
  tail.writeUInt16LE(feeBps, 0);
  tail.writeBigUInt64LE(BigInt(feeMax), 2);
  tail[10] = beneficiaryMode;
  (feeVault || payer.publicKey).toBuffer().copy(tail, 11);
  parts.push(tail);
  return Buffer.concat(parts);
}
// Rule-1 params (64B) for all modes:
//   [0..8] max_stale_secs u64 (0 -> 300); [8..16] ema_half_life u64;
//   [16..18] max_crank_bps u16; [18] mode (0 LATCH, 1 LIVE, 2 GRADUATED);
//   [19..21] base_frac_bps u16; [21..29] vesting_secs u64 (0 -> 432000);
//   [29..31] dip_mult_bps u16 (0 -> 20000 = 2x).
// Default stale is huge so scenario time-travel never trips StalePrice;
// halfLife 0 makes every crank take spot exactly.
const gradParams = ({ stale = 1_000_000, halfLife = 0, crankBps = 0, mode = 2, base = 0, vesting = 0, dipMult = 0 } = {}) => {
  const p = Buffer.alloc(64);
  p.writeBigUInt64LE(BigInt(stale), 0);
  p.writeBigUInt64LE(BigInt(halfLife), 8);
  p.writeUInt16LE(crankBps, 16);
  p[18] = mode;
  p.writeUInt16LE(base, 19);
  p.writeBigUInt64LE(BigInt(vesting), 21);
  p.writeUInt16LE(dipMult, 29);
  return p;
};
const latchParams = ({ stale = 1_000_000, halfLife = 0, bps = 0 } = {}) =>
  gradParams({ stale, halfLife, crankBps: bps, mode: 0 });

// ---------- launch helpers ----------
async function launchMint(cfg, { fundVault = 0, supply = SUPPLY } = {}) {
  const mint = Keypair.generate();
  const len = getMintLen([ExtensionType.TransferHook]);
  const rent = svm.minimumBalanceForRentExemption(BigInt(len));
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: Number(rent), programId: TOKEN_2022 }),
    createInitializeTransferHookInstruction(mint.publicKey, payer.publicKey, ENGINE, TOKEN_2022),
    createInitializeMintInstruction(mint.publicKey, 9, payer.publicKey, null, TOKEN_2022),
  ], [payer, mint], 'create mint');
  await send([new TransactionInstruction({
    programId: ENGINE, data: configPayload(cfg, 1),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: configPda(mint.publicKey), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  })], [payer], 'init config');
  await send([new TransactionInstruction({
    programId: ENGINE, data: Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: metaPda(mint.publicKey), isSigner: false, isWritable: true },
      { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: configPda(mint.publicKey), isSigner: false, isWritable: false },
    ],
  })], [payer], 'init metas');
  if (fundVault > 0) {
    await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vaultPda(mint.publicKey), lamports: fundVault })], [payer], 'fund rent vault');
  }
  // fund the payer's own ATA with the full supply (MintTo does not fire the hook)
  const payerAta = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey, false, TOKEN_2022);
  await send([
    createAssociatedTokenAccountInstruction(payer.publicKey, payerAta, payer.publicKey, mint.publicKey, TOKEN_2022),
    createMintToInstruction(mint.publicKey, payerAta, payer.publicKey, supply, [], TOKEN_2022),
  ], [payer], 'mint supply to payer');
  return { mint: mint.publicKey, payerAta };
}

async function plainMint(decimals = 9) {
  const mint = Keypair.generate();
  const len = getMintLen([]);
  const rent = svm.minimumBalanceForRentExemption(BigInt(len));
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: Number(rent), programId: TOKEN_2022 }),
    createInitializeMintInstruction(mint.publicKey, decimals, payer.publicKey, null, TOKEN_2022),
  ], [payer, mint], 'create plain mint');
  return mint.publicKey;
}

async function actor(mintPk, name) {
  const kp = Keypair.generate();
  svm.airdrop(kp.publicKey, BigInt(2 * LAMPORTS_PER_SOL));
  const ata = getAssociatedTokenAddressSync(mintPk, kp.publicKey, false, TOKEN_2022);
  await send([createAssociatedTokenAccountInstruction(payer.publicKey, ata, kp.publicKey, mintPk, TOKEN_2022)], [payer], `${name} ATA`);
  return { kp, ata };
}

// Tail v2 manual resolution: extras in meta order, then ENGINE, then the
// validation (meta-list) account; `appended` accounts ride at the very end.
function hookTransferIx(mintPk, source, dest, owner, amountRaw, appended = []) {
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked
  data.writeBigUInt64LE(BigInt(amountRaw), 1);
  data[9] = 9;
  const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });
  return new TransactionInstruction({
    programId: TOKEN_2022, data,
    keys: [
      K(source, false, true), K(mintPk, false, false), K(dest, false, true), K(owner, true, false),
      // resolved extras, in meta-list order (tail v2):
      K(configPda(mintPk), false, false),
      K(holderPda(mintPk, source), false, true),
      K(holderPda(mintPk, dest), false, true),
      K(vaultPda(mintPk), false, true),
      K(pricePda(mintPk), false, false),
      K(SystemProgram.programId, false, false), K(IX_SYSVAR, false, false),
      K(ENGINE, false, false), K(metaPda(mintPk), false, false),
      ...appended.map((pk) => K(pk, false, false)),
    ],
  });
}
const xfer = (m, from, to, ownerKp, wholeTokens, appended = []) =>
  send([hookTransferIx(m.mint, from, to, ownerKp.publicKey, BigInt(wholeTokens) * WHOLE, appended)], [ownerKp], 'xfer');
const tryXfer = (m, from, to, ownerKp, wholeTokens, appended = []) => attempt(() => xfer(m, from, to, ownerKp, wholeTokens, appended));
// Raw-amount variants (hookTransferIx already takes a raw amount): sell
// boundaries derived from the replica are rarely whole-token amounts.
const xferRaw = (m, from, to, ownerKp, rawBigInt) =>
  send([hookTransferIx(m.mint, from, to, ownerKp.publicKey, BigInt(rawBigInt))], [ownerKp], 'xferRaw');
const tryXferRaw = (m, from, to, ownerKp, rawBigInt) => attempt(() => xferRaw(m, from, to, ownerKp, rawBigInt));

const initHolderIx = (mintPk, tokenAcct) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([3]),
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: false },
    { pubkey: tokenAcct, isSigner: false, isWritable: false },
    { pubkey: holderPda(mintPk, tokenAcct), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
const updateIx = (mintPk, cfg, signer) => new TransactionInstruction({
  programId: ENGINE, data: configPayload(cfg, 2),
  keys: [
    { pubkey: signer.publicKey, isSigner: true, isWritable: false },
    { pubkey: mintPk, isSigner: false, isWritable: false },
    { pubkey: configPda(mintPk), isSigner: false, isWritable: true },
  ],
});
// RefreshExtraAccountMetas (tag 9, Phase 2 templating): rewrite the meta
// list from the CURRENT config. Required after an UpdateConfig that
// EXPANDS the required-extra set (e.g. G7's no-rules -> GRADUATED update):
// Token-2022 forwards only the published list, so without the refresh the
// expanded config's transfers fail closed with MissingExtra by design.
const refreshIx = (mintPk) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([9]),
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: metaPda(mintPk), isSigner: false, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: false },
    { pubkey: configPda(mintPk), isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
const initFeedIx = (mintPk, pool, tokenVault, quoteVault) => {
  const data = Buffer.concat([
    Buffer.from([6]), pool.toBuffer(), tokenVault.toBuffer(), quoteVault.toBuffer(), Buffer.from([9, 9]),
  ]);
  return new TransactionInstruction({
    programId: ENGINE, data,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: configPda(mintPk), isSigner: false, isWritable: false },
      { pubkey: pricePda(mintPk), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
};
const crankIx = (mintPk, tokenVault, quoteVault) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([5]),
  keys: [
    { pubkey: configPda(mintPk), isSigner: false, isWritable: false },
    { pubkey: pricePda(mintPk), isSigner: false, isWritable: true },
    { pubkey: tokenVault, isSigner: false, isWritable: false },
    { pubkey: quoteVault, isSigner: false, isWritable: false },
  ],
});

// ---------- priced-mint setup (simulated constant-product pool, as T9) ----------
// Spot = quote_raw x 1e12 / token_raw. Quote seed 900 whole, token seed
// 450,000 whole -> EMA exactly 2e9. The returned object doubles as the
// launch result for xfer/xferRaw (it carries .mint and .payerAta).
async function setupPricedMint(rules, { fundVault = Math.floor(0.05 * LAMPORTS_PER_SOL) } = {}) {
  const quoteMint = await plainMint(9);
  const poolAuth = Keypair.generate();
  svm.airdrop(poolAuth.publicKey, BigInt(2 * LAMPORTS_PER_SOL));
  const m = await launchMint(
    { mode: 1, authority: payer.publicKey, rules, exemptions: [payer.publicKey, poolAuth.publicKey] },
    { fundVault, supply: 10_000_000n * WHOLE },
  );
  const tokenVault = getAssociatedTokenAddressSync(m.mint, poolAuth.publicKey, true, TOKEN_2022);
  const quoteVault = getAssociatedTokenAddressSync(quoteMint, poolAuth.publicKey, true, TOKEN_2022);
  await send([
    createAssociatedTokenAccountInstruction(payer.publicKey, tokenVault, poolAuth.publicKey, m.mint, TOKEN_2022),
    createAssociatedTokenAccountInstruction(payer.publicKey, quoteVault, poolAuth.publicKey, quoteMint, TOKEN_2022),
    createMintToInstruction(quoteMint, quoteVault, payer.publicKey, 900n * WHOLE, [], TOKEN_2022),
  ], [payer], 'pool vaults + quote seed (900 whole)');
  await send([initFeedIx(m.mint, Keypair.generate().publicKey, tokenVault, quoteVault)], [payer], 'init price feed');
  await xfer(m, m.payerAta, tokenVault, payer, 450_000); // seed token side (exempt<->exempt)
  const crank = () => send([crankIx(m.mint, tokenVault, quoteVault)], [payer], 'crank');
  await crank();
  return { mint: m.mint, payerAta: m.payerAta, poolAuth, tokenVault, quoteVault, quoteMint, crank };
}
// Move the pool's token vault to an exact whole-token total (exempt<->
// exempt transfers in/out), then let the caller crank. Adding tokens dips
// the price; removing them (pool authority -> payer) recovers it.
async function setTokenVaultTotal(S, totalWhole) {
  const curWhole = bal(S.tokenVault) / WHOLE;
  const total = BigInt(totalWhole);
  if (total > curWhole) await xfer(S, S.payerAta, S.tokenVault, payer, Number(total - curWhole));
  else if (total < curWhole) await xfer(S, S.tokenVault, S.payerAta, S.poolAuth, Number(curWhole - total));
}

// Craft a legacy 136-byte holder via LiteSVM setAccount. The installed
// litesvm typings (engine/node_modules/litesvm -> ../proof/node_modules)
// declare setAccount(address, AccountInfoBytes) and the JS wrapper forwards
// the whole account object to the VM, so replacing the account shrinks it.
// The buffer copies the existing holder's first 136 bytes, then the basis
// is patched to 2e9: InitHolder alone zeroes the basis, while a REAL legacy
// holder who acquired at 2e9 carries basis_num=2e9 / basis_den=1 — the
// basis-consistent legacy position the migration scenarios require.
function setLegacyHolder(mintPk, ownerPk) {
  const hp = holderPda(mintPk, getAssociatedTokenAddressSync(mintPk, ownerPk, true, TOKEN_2022));
  const existing = svm.getAccount(hp);
  const buf = Buffer.alloc(136);
  if (existing && existing.data) {
    Buffer.from(existing.data).copy(buf, 0, 0, Math.min(136, existing.data.length));
  }
  buf[0] = 1;
  buf.writeBigUInt64LE(PRICE_2E9, 6); buf.writeBigUInt64LE(0n, 14); // basis_num u128 @6
  buf.writeBigUInt64LE(1n, 22); buf.writeBigUInt64LE(0n, 30);      // basis_den u128 @22 = 1
  svm.setAccount(hp, {
    lamports: Number(svm.minimumBalanceForRentExemption(136n)),
    data: new Uint8Array(buf),
    owner: ENGINE,
    executable: false,
    rentEpoch: 0,
  });
  return hp;
}

// ================= TRIAL (GRADUATED) =================
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
console.log('engine:', ENGINE.toBase58());

console.log('=== G1: time-vesting boundaries (vesting=1000s, base 0) ===');
{
  setTime(T0);
  const S = await setupPricedMint([{ id: 1, params: gradParams({ vesting: 1000 }) }]);
  ok(feedEma(S.mint) === PRICE_2E9, 'G1 EMA exactly 2e9 after seed + crank', `ema=${feedEma(S.mint)}`);
  const buyer = await actor(S.mint, 'g1-buyer');
  await xfer(S, S.payerAta, buyer.ata, payer, 10_000); // buy @2e9 at T0 (exempt source)
  let st = gradState(S.mint, buyer.ata);
  ok(st !== null && st.len === 192, 'G1 fresh graduated holder is born at len 192', `len=${st?.len}`);
  ok(st.anchor === T0, 'G1 anchor == T0 (buy time)', `anchor=${st.anchor}`);
  ok(st.peak === 10_000n * WHOLE, 'G1 peak == 10000 whole (post-transfer balance)');
  ok(st.sold === 0n, 'G1 sold == 0 on a fresh position');
  ok(st.min === PRICE_2E9, 'G1 min == 2e9 (EMA at entry)');
  ok(st.basis === PRICE_2E9, 'G1 basis == 2e9 (entry at feed price)');
  ok(st.latched === false, 'G1 not latched');
  ok((await tryXferRaw(S, buyer.ata, S.payerAta, buyer.kp, 1n)) === 'PartialLocked', 'G1 sell of 1 raw unit at T0 vetoes PartialLocked (0% earned)');
  setTime(T0 + 500);
  await S.crank(); // refresh the feed at the new time (EMA still spot, 2e9)
  st = gradState(S.mint, buyer.ata);
  ok(expectedCap(st, nowTs, { base: 0, vesting: 1000, dipMult: 0 }) === 5_000n * WHOLE, 'G1 replica cap at T0+500 is exactly 5000 whole (50% of peak)');
  await xfer(S, buyer.ata, S.payerAta, buyer.kp, 5_000); // exactly half vested
  ok(bal(buyer.ata) === 5_000n * WHOLE, 'G1 sell of exactly 5000 whole at T0+500 passes');
  st = gradState(S.mint, buyer.ata);
  ok(st.sold === 5_000n * WHOLE, 'G1 sold == 5000 whole after the half sell');
  ok((await tryXferRaw(S, buyer.ata, S.payerAta, buyer.kp, 1n)) === 'PartialLocked', 'G1 sell of 1 more raw unit vetoes PartialLocked (sold == cap)');
  setTime(T0 + 1000);
  await S.crank();
  await xfer(S, buyer.ata, S.payerAta, buyer.kp, 5_000); // fully vested remainder
  ok(bal(buyer.ata) === 0n, 'G1 sell of the remaining 5000 whole at T0+1000 passes (100% vested)');
  st = gradState(S.mint, buyer.ata);
  ok(st.peak === 0n && st.sold === 0n && st.cap === 0n && st.anchor === 0 && st.min === 0n,
    'G1 full exit zeroes the grad fields [136..192] (peak/sold/cap/anchor/min)');
  ok(st.len === 192, 'G1 holder account itself survives full exit at len 192');
}

console.log('=== G2: dip-earned fractions (vesting huge, dip_mult default 2x) ===');
{
  setTime(T0);
  const params = { base: 0, vesting: 86_400_000, dipMult: 0 };
  const S = await setupPricedMint([{ id: 1, params: gradParams({ vesting: 86_400_000, dipMult: 0 }) }]);
  ok(feedEma(S.mint) === PRICE_2E9, 'G2 EMA exactly 2e9 after seed + crank');
  const buyer = await actor(S.mint, 'g2-buyer');
  await xfer(S, S.payerAta, buyer.ata, payer, 10_000); // buy @2e9; clock stays at T0 throughout G2
  const dips = [
    { total: 500_000, ema: 1_800_000_000n, label: '10%' },
    { total: 600_000, ema: 1_500_000_000n, label: '25%' },
    { total: 900_000, ema: 1_000_000_000n, label: '50%' },
  ];
  for (const dip of dips) {
    await setTokenVaultTotal(S, dip.total);
    await S.crank();
    ok(feedEma(S.mint) === dip.ema, `G2 crank after dip: EMA == ${dip.ema} (${dip.label} drawdown)`, `ema=${feedEma(S.mint)}`);
    // Receiving during the dip OBSERVES it (min ratchets down) without
    // firing the latch — the latch only fires at a sender-gate evaluation.
    await xfer(S, S.payerAta, buyer.ata, payer, 1);
    let st = gradState(S.mint, buyer.ata);
    ok(st.latched === false, `G2 receive during the ${dip.label} dip does NOT fire the latch`);
    ok(st.min === dip.ema, `G2 min == dip EMA (${dip.ema}) after the observing receive`);
    await setTokenVaultTotal(S, 450_000); // recovery
    await S.crank();
    ok(feedEma(S.mint) === PRICE_2E9, `G2 EMA recovers to 2e9 after the ${dip.label} dip`);
    st = gradState(S.mint, buyer.ata);
    const frac = expectedFrac(st, nowTs, params);
    if (dip.total === 900_000) {
      ok(frac >= 9_900n, 'G2 replica frac after the 50% dip is >= 9900 bps (sanity)', `frac=${frac}`);
    }
    const capE = expectedCap(st, nowTs, params);
    const sellable = capE - st.sold;
    ok(sellable > 0n, `G2 replica sellable > 0 after the ${dip.label} dip`, `cap=${capE} sold=${st.sold}`);
    await xferRaw(S, buyer.ata, S.payerAta, buyer.kp, sellable); // boundary: exactly cap - sold
    st = gradState(S.mint, buyer.ata);
    ok(st.sold === capE, `G2 sell of exactly (expectedCap - sold) passes after the ${dip.label} dip; sold == cap`);
    ok((await tryXferRaw(S, buyer.ata, S.payerAta, buyer.kp, 1n)) === 'PartialLocked', `G2 sell of 1 more raw unit vetoes PartialLocked after the ${dip.label} dip`);
  }
}

console.log('=== G3: latch crossing => 100% permanent (fresh mint, vesting huge) ===');
{
  setTime(T0);
  const S = await setupPricedMint([{ id: 1, params: gradParams({ vesting: 86_400_000 }) }]);
  const buyer = await actor(S.mint, 'g3-buyer');
  await xfer(S, S.payerAta, buyer.ata, payer, 10_000); // buy @2e9
  await setTokenVaultTotal(S, 900_000); // dip to 1e9 (50%)
  await S.crank();
  ok(feedEma(S.mint) === 1_000_000_000n, 'G3 EMA == 1e9 in the dip');
  await xfer(S, buyer.ata, S.payerAta, buyer.kp, 100); // SELL during the dip: sender-gate eval fires the latch
  let st = gradState(S.mint, buyer.ata);
  ok(st.latched === true, 'G3 sell during the dip passes AND sets latched');
  ok(st.sold === 100n * WHOLE, 'G3 sold == 100 whole after the dip sell');
  await setTokenVaultTotal(S, 450_000); // recovery
  await S.crank();
  ok(feedEma(S.mint) === PRICE_2E9, 'G3 EMA recovers to 2e9');
  await xfer(S, buyer.ata, S.payerAta, buyer.kp, 9_900); // entire remaining balance
  ok(bal(buyer.ata) === 0n, 'G3 latched holder sells the entire remainder after recovery (100% via latch, vesting still huge)');
  st = gradState(S.mint, buyer.ata);
  ok(st.latched === true, 'G3 latched flag (byte 38, outside the grad fields) survives full exit');
}

console.log('=== G4: anti-leak — many small sells cannot exceed the cap ===');
{
  setTime(T0);
  const S = await setupPricedMint([{ id: 1, params: gradParams({ vesting: 1000 }) }]);
  const buyer = await actor(S.mint, 'g4-buyer');
  await xfer(S, S.payerAta, buyer.ata, payer, 10_000);
  setTime(T0 + 500);
  await S.crank();
  const st0 = gradState(S.mint, buyer.ata);
  ok(expectedCap(st0, nowTs, { base: 0, vesting: 1000, dipMult: 0 }) === 5_000n * WHOLE, 'G4 replica cap at T0+500 is exactly 5000 whole');
  await xfer(S, buyer.ata, S.payerAta, buyer.kp, 2_000);
  await xfer(S, buyer.ata, S.payerAta, buyer.kp, 2_000);
  await xfer(S, buyer.ata, S.payerAta, buyer.kp, 1_000);
  let st = gradState(S.mint, buyer.ata);
  ok(st.sold === 5_000n * WHOLE, 'G4 sells of 2000+2000+1000 all pass; sold is cumulative at 5000 whole');
  ok(bal(buyer.ata) === 5_000n * WHOLE, 'G4 balance is 5000 whole after the three sells');
  ok((await tryXferRaw(S, buyer.ata, S.payerAta, buyer.kp, 1n)) === 'PartialLocked', 'G4 next sell of 1 raw unit vetoes PartialLocked');
  ok(bal(buyer.ata) === 5_000n * WHOLE, 'G4 balance unchanged after the veto (atomic)');
  st = gradState(S.mint, buyer.ata);
  ok(st.sold === 5_000n * WHOLE, 'G4 sold still 5000 whole after the veto (no leak)');
}

console.log('=== G5: blended rebuy after a partial sell (vesting=1000) ===');
{
  setTime(T0);
  const S = await setupPricedMint([{ id: 1, params: gradParams({ vesting: 1000 }) }]);
  const buyer = await actor(S.mint, 'g5-buyer');
  await xfer(S, S.payerAta, buyer.ata, payer, 10_000); // buy @2e9 at T0
  setTime(T0 + 500);
  await S.crank();
  await xfer(S, buyer.ata, S.payerAta, buyer.kp, 5_000); // sell the vested half
  setTime(T0 + 600);
  await S.crank();
  await xfer(S, S.payerAta, buyer.ata, payer, 5_000); // rebuy @2e9 at T0+600
  const st = gradState(S.mint, buyer.ata);
  ok(st.basis === PRICE_2E9, 'G5 basis still exactly 2e9 (rebuy at the same price)');
  ok(st.anchor === T0 + 300, 'G5 anchor blended to T0+300 = (5000*T0 + 5000*(T0+600))/10000', `anchor=${st.anchor}`);
  ok(st.peak === 10_000n * WHOLE, 'G5 peak still 10000 whole');
  ok(st.sold === 5_000n * WHOLE, 'G5 sold still 5000 whole (rebuy does not refund sold)');
  ok(bal(buyer.ata) === 10_000n * WHOLE, 'G5 balance back to 10000 whole');
  setTime(T0 + 800);
  await S.crank();
  const st800 = gradState(S.mint, buyer.ata);
  ok(expectedCap(st800, nowTs, { base: 0, vesting: 1000, dipMult: 0 }) === 5_000n * WHOLE,
    'G5 replica cap at T0+800 is 5000 (elapsed 500 from the blended anchor -> 50%)');
  ok((await tryXferRaw(S, buyer.ata, S.payerAta, buyer.kp, 1n)) === 'PartialLocked', 'G5 sell of 1 raw at T0+800 vetoes (cap == sold)');
  setTime(T0 + 1300);
  await S.crank();
  await xfer(S, buyer.ata, S.payerAta, buyer.kp, 5_000); // elapsed 1000 from blended anchor -> 100%
  ok(bal(buyer.ata) === 5_000n * WHOLE, 'G5 sell of 5000 whole at T0+1300 passes');
  ok(gradState(S.mint, buyer.ata).sold === 10_000n * WHOLE, 'G5 sold reaches 10000 whole (100% of peak)');
}

console.log('=== G6: base fraction (base_frac_bps=1000, vesting huge) ===');
{
  setTime(T0);
  const S = await setupPricedMint([{ id: 1, params: gradParams({ base: 1000, vesting: 86_400_000 }) }]);
  const buyer = await actor(S.mint, 'g6-buyer');
  await xfer(S, S.payerAta, buyer.ata, payer, 10_000); // buy @2e9 at T0
  const st = gradState(S.mint, buyer.ata);
  ok(expectedCap(st, nowTs, { base: 1000, vesting: 86_400_000, dipMult: 0 }) === 1_000n * WHOLE,
    'G6 replica cap immediately after buy is exactly 1000 whole (base 10%)');
  await xfer(S, buyer.ata, S.payerAta, buyer.kp, 1_000); // exactly the base fraction
  ok(bal(buyer.ata) === 9_000n * WHOLE, 'G6 immediate sell of 1000 whole passes');
  ok((await tryXferRaw(S, buyer.ata, S.payerAta, buyer.kp, 1n)) === 'PartialLocked', 'G6 sell of 1 more raw unit vetoes PartialLocked');
}

console.log('=== G7: migration of legacy 136B holders ===');
{
  // (a) funded rent vault: first GRADUATED evaluation grows 136 -> 192.
  setTime(T0);
  const Sa = await setupPricedMint([], { fundVault: Math.floor(0.05 * LAMPORTS_PER_SOL) }); // NO rules
  const a7 = await actor(Sa.mint, 'g7a-actor');
  await xfer(Sa, Sa.payerAta, a7.ata, payer, 5_000); // received under no rules
  ok(bal(a7.ata) === 5_000n * WHOLE, 'G7a actor received 5000 under a no-rules config');
  ok(acctData(holderPda(Sa.mint, a7.ata)) === null, 'G7a no holder was created by the no-rules transfer');
  await send([initHolderIx(Sa.mint, a7.ata)], [payer], 'G7a init holder (payer-paid)');
  setLegacyHolder(Sa.mint, a7.kp.publicKey); // shrink/craft to a basis-carrying legacy account
  let st = gradState(Sa.mint, a7.ata);
  ok(st.len === 136, 'G7a holder is legacy 136 after the setAccount shrink', `len=${st.len}`);
  ok(st.basis === PRICE_2E9, 'G7a crafted legacy basis is 2e9');
  await send([updateIx(Sa.mint, {
    mode: 1, authority: payer.publicKey,
    rules: [{ id: 1, params: gradParams({ vesting: 86_400_000 }) }],
    exemptions: [payer.publicKey, Sa.poolAuth.publicKey],
  }, payer)], [payer], 'G7a update config to GRADUATED (Creator mode, rent vault funded >= 0.01 SOL)');
  // PHASE 2 FLOW CHANGE (named, not an assertion change): the update
  // expands the required set (no-rules -> rule 1), so the templated meta
  // list must be refreshed before transfers can carry the holder extras.
  await send([refreshIx(Sa.mint)], [payer], 'G7a refresh meta list after expanding update');
  const MIG_TS = T0 + 7_777;
  setTime(MIG_TS);
  await Sa.crank();
  ok(feedEma(Sa.mint) === PRICE_2E9, 'G7a EMA is 2e9 at migration time');
  await xfer(Sa, Sa.payerAta, a7.ata, payer, 1); // first GRADUATED evaluation (a receive)
  st = gradState(Sa.mint, a7.ata);
  ok(st.len === 192, 'G7a holder migrated to len 192 on its first graduated evaluation', `len=${st.len}`);
  ok(st.basis === PRICE_2E9, 'G7a basis still exactly 2e9 after migration (receive at the same price)');
  ok(st.anchor === MIG_TS, 'G7a anchor == now (migration time)', `anchor=${st.anchor}`);
  ok(st.peak === 5_001n * WHOLE, 'G7a peak == 5001 whole (post-transfer balance, fresh grad position)');
  ok(st.min === PRICE_2E9, 'G7a min == 2e9 (EMA at migration)');
  ok(st.sold === 0n, 'G7a sold == 0 on the fresh grad position');

  // (b) unfunded rent vault: migration fails explicitly, holder stays 136.
  setTime(T0);
  const Sb = await setupPricedMint([], { fundVault: 0 }); // vault UNFUNDED
  const b7 = await actor(Sb.mint, 'g7b-actor');
  await xfer(Sb, Sb.payerAta, b7.ata, payer, 5_000);
  await send([initHolderIx(Sb.mint, b7.ata)], [payer], 'G7b init holder (payer-paid)');
  setLegacyHolder(Sb.mint, b7.kp.publicKey);
  await send([updateIx(Sb.mint, {
    mode: 1, authority: payer.publicKey,
    rules: [{ id: 1, params: gradParams({ vesting: 86_400_000 }) }],
    exemptions: [payer.publicKey, Sb.poolAuth.publicKey],
  }, payer)], [payer], 'G7b update config to GRADUATED (vault unfunded)');
  // PHASE 2 FLOW CHANGE (same as G7a): refresh after the expanding update.
  await send([refreshIx(Sb.mint)], [payer], 'G7b refresh meta list after expanding update');
  setTime(T0 + 8_888);
  await Sb.crank();
  ok((await tryXfer(Sb, Sb.payerAta, b7.ata, payer, 1)) === 'RentVaultUnderfunded',
    'G7b receive under GRADUATED with an unfunded rent vault fails RentVaultUnderfunded');
  st = gradState(Sb.mint, b7.ata);
  ok(st.len === 136, 'G7b holder stays 136 after the failed migration');
  ok(bal(b7.ata) === 5_000n * WHOLE, 'G7b balance unchanged after the failed migration (atomic)');

  // (c) LATCH mode never migrates: a 136 holder stays 136 through latch flows.
  setTime(T0);
  const Sc = await setupPricedMint([{ id: 1, params: latchParams({ stale: 1_000_000 }) }]); // mode 0 LATCH
  const c7 = await actor(Sc.mint, 'g7c-buyer');
  await xfer(Sc, Sc.payerAta, c7.ata, payer, 5_000); // a latch "buy" @2e9
  st = gradState(Sc.mint, c7.ata);
  ok(st !== null && st.len === 136, 'G7c LATCH mint lazily-created holder is 136 (non-graduated creation size)', `len=${st?.len}`);
  setLegacyHolder(Sc.mint, c7.kp.publicKey); // same craft/shrink as (a)/(b)
  ok(gradState(Sc.mint, c7.ata).len === 136, 'G7c holder is 136 after the setAccount shrink');
  await xfer(Sc, Sc.payerAta, c7.ata, payer, 1); // another latch receive @2e9
  st = gradState(Sc.mint, c7.ata);
  ok(st.len === 136, 'G7c holder stays 136 after a latch receive (never migrated)');
  ok(st.basis === PRICE_2E9, 'G7c basis still 2e9 after the latch receive');
  ok((await tryXfer(Sc, c7.ata, Sc.payerAta, c7.kp, 1)) === 'Locked', 'G7c latch sell attempt at price == basis is Locked');
  ok(gradState(Sc.mint, c7.ata).len === 136, 'G7c holder still 136 after the latch gate evaluation');
}

console.log('=== G8: config-write validation + self-transfer ===');
{
  // (a) rule-1 mode byte 3 and (b) base_frac_bps 10001 are write-rejected.
  const badMint = Keypair.generate();
  const mlen = getMintLen([ExtensionType.TransferHook]);
  const mrent = svm.minimumBalanceForRentExemption(BigInt(mlen));
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: badMint.publicKey, space: mlen, lamports: Number(mrent), programId: TOKEN_2022 }),
    createInitializeTransferHookInstruction(badMint.publicKey, payer.publicKey, ENGINE, TOKEN_2022),
    createInitializeMintInstruction(badMint.publicKey, 9, payer.publicKey, null, TOKEN_2022),
  ], [payer, badMint], 'G8 bad mint');
  const initCfgWith = (params) => new TransactionInstruction({
    programId: ENGINE, data: configPayload({ mode: 1, authority: payer.publicKey, rules: [{ id: 1, params }] }, 1),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: badMint.publicKey, isSigner: false, isWritable: false },
      { pubkey: configPda(badMint.publicKey), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  ok((await attempt(() => send([initCfgWith(gradParams({ mode: 3 }))], [payer], 'init mode 3'))) !== null,
    'G8a config init with rule-1 mode byte 3 is rejected');
  ok(acctData(configPda(badMint.publicKey)) === null, 'G8a no config persisted for mode 3');
  ok((await attempt(() => send([initCfgWith(gradParams({ mode: 2, base: 10_001 }))], [payer], 'init base 10001'))) !== null,
    'G8b config init with base_frac_bps 10001 is rejected');
  ok(acctData(configPda(badMint.publicKey)) === null, 'G8b no config persisted for base_frac_bps 10001');

  // (c) self-transfer skips the graduated path entirely (0% earned, still passes).
  setTime(T0);
  const S = await setupPricedMint([{ id: 1, params: gradParams({ vesting: 86_400_000 }) }]);
  const buyer = await actor(S.mint, 'g8-buyer');
  await xfer(S, S.payerAta, buyer.ata, payer, 1_000); // buy @2e9; 0% earned at T0
  ok((await attempt(() => xfer(S, buyer.ata, buyer.ata, buyer.kp, 100))) === null,
    'G8c self-transfer of 100 whole passes despite 0% earned (graduated path skipped)');
  ok(bal(buyer.ata) === 1_000n * WHOLE, 'G8c balance unchanged by the self-transfer');
  ok(gradState(S.mint, buyer.ata).sold === 0n, 'G8c sold still 0 (self-transfer recorded no sale)');
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
fs.writeFileSync(path.join(DIR, 'trial-graduated-result.json'), JSON.stringify({ engine: ENGINE.toBase58(), suite: 'graduated', pass, fail }, null, 2));
if (fail > 0) process.exit(1);

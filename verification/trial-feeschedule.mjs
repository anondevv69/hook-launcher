// Hook Launcher FEE SCHEDULE (rule 14, Decay Tax — honest mint-wide form) —
// LiteSVM trial suite. Local only.
//
// The schedule: rate starts at start_bps (500 = 5%) and decays LINEARLY to
// floor_bps (100 = 1%) over decay_secs (30 days), mint-wide, driven by a
// permissionless crank (tag 1 Apply) that CPIs Token-2022 SetTransferFee
// signed by the program's ["feeauth", mint] PDA.
//
// Token-2022 semantics measured in this suite (spl-token 0.4.15):
// SetTransferFee writes the NEWER fee entry with epoch = current + 2; the
// rate holders pay changes only when the chain epoch reaches it. The trial
// therefore asserts BOTH the scheduled entry (immediately after Apply) and
// the effective rate (after advancing the epoch), including exact withheld
// amounts on real transfers at each rate.
//
// Engine Config PDAs are CONSTRUCTED accounts (LiteSVM setAccount) owned by
// the engine program id EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT with the
// byte-exact layout copied from engine/src/lib.rs (CONFIG_SPACE 1088,
// rules @462, entry = rule_id u16 / enabled u8 / params[64]). The engine
// binary is not deployed: rule 14's engine-side config validation is being
// added in parallel, and this program only READS the Config PDA.
//
// Run: node trial-feeschedule.mjs   (exit 1 on failure)
import { LiteSVM, FailedTransactionMetadata, Clock } from 'litesvm';
import {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createInitializeTransferFeeConfigInstruction, createInitializeMintInstruction,
  createMintToInstruction, createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction, createSetAuthorityInstruction, AuthorityType,
  getAssociatedTokenAddressSync, getMintLen, ExtensionType,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const FS = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(DIR, 'feeschedule-keypair.json'), 'utf8')))).publicKey;
const DIST = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(ROOT, 'distributor', 'distributor-keypair.json'), 'utf8')))).publicKey;
const ENGINE = new PublicKey('EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT');
const T22 = TOKEN_2022_PROGRAM_ID;
const DECIMALS = 6;
const TOK = 10n ** 6n;
const SUPPLY = 1_000_000n * TOK;
const SCALE = 10n ** 12n;
const MAX_FEE = 10n ** 15n;
const START_BPS = 500, FLOOR_BPS = 100, DECAY_SECS = 30 * 24 * 3600; // 2_592_000
const T0 = 1_760_000_000;
const DAY = 24 * 3600;

const ERR = { AlreadyInit: 1, BadState: 2, NoFeeConfig: 3, NotFeeAuthority: 4, BadConfig: 5, RuleNotEnabled: 6, BadParams: 7, OutOfBounds: 8 };

let pass = 0, fail = 0; const failures = [];
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); } else { fail++; failures.push(name); console.log(`  FAIL ${name} ${extra}`); } };
const section = (t) => console.log(`\n=== ${t} ===`);

const svm = new LiteSVM();
svm.addProgramFromFile(FS, path.join(DIR, 'target/deploy/feeschedule.so'));
svm.addProgramFromFile(DIST, path.join(ROOT, 'distributor/target/deploy/distributor.so'));

let slot = 1000n;
const setClock = (ts, epoch) => { slot += 17n; svm.setClock(new Clock(slot, 0n, BigInt(epoch), BigInt(epoch), BigInt(ts))); };
setClock(T0, 0);

const payer = Keypair.generate();
svm.airdrop(payer.publicKey, BigInt(300 * LAMPORTS_PER_SOL));

function runTx(ixs, signers, label) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(...signers);
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) {
    const e = new Error(label + ' failed');
    try { const m = res.meta(); e.logs = typeof m.logs === 'function' ? m.logs() : (m.logs || []); } catch { e.logs = []; }
    e.chainErr = res.err();
    throw e;
  }
  return res;
}
const send = (ixs, signers, label) => runTx(ixs, signers, label);
async function attempt(fn) {
  try { await fn(); return null; }
  catch (e) {
    const logs = (e.logs || []).join('\n');
    const m = logs.match(/custom program error: 0x([0-9a-f]+)/i);
    if (m) return { custom: parseInt(m[1], 16), logs };
    const s = JSON.stringify(e.chainErr || {});
    const m2 = s.match(/"Custom":\s*(\d+)/);
    if (m2) return { custom: Number(m2[1]), logs };
    if (/InvalidSeeds/.test(s) || /Provided seeds do not result in a valid address|invalid seeds/i.test(logs)) return { custom: 'InvalidSeeds', logs };
    return { custom: 'Other:' + s.slice(0, 160), logs };
  }
}

// ---------- PDAs ----------
const feeauthPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('feeauth'), mint.toBuffer()], FS)[0];
const schedPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('sched'), mint.toBuffer()], FS)[0];
const configPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('config'), mint.toBuffer()], ENGINE)[0];
const distPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('dist'), mint.toBuffer()], DIST)[0];
const claimPda = (mint, holder) => PublicKey.findProgramAddressSync([Buffer.from('claim'), mint.toBuffer(), holder.toBuffer()], DIST)[0];

// ---------- account readers / TLV oracles ----------
const acct = (pk) => { const a = svm.getAccount(pk); return a ? { lamports: a.lamports, owner: a.owner, executable: a.executable, rentEpoch: a.rentEpoch, data: Buffer.from(a.data) } : null; };
const acctData = (pk) => { const a = acct(pk); return a ? a.data : null; };
const bal = (ata) => { const d = acctData(ata); return d ? d.readBigUInt64LE(64) : 0n; };
function tlvEntries(d) {
  const out = []; let off = 166;
  while (off + 4 <= d.length) { const ty = d.readUInt16LE(off), len = d.readUInt16LE(off + 2); if (ty === 0 && len === 0) break; out.push({ ty, len, at: off + 4 }); off += 4 + len; }
  return out;
}
function feeConfig(mint) {
  const d = acctData(mint);
  for (const e of tlvEntries(d)) {
    if (e.ty !== 1) continue;
    const b = e.at;
    const key = (o) => d.subarray(b + o, b + o + 32).every((x) => x === 0) ? null : new PublicKey(d.subarray(b + o, b + o + 32));
    return {
      auth: key(0), withdraw: key(32), withheld: d.readBigUInt64LE(b + 64),
      older: { epoch: d.readBigUInt64LE(b + 72), max: d.readBigUInt64LE(b + 80), bps: d.readUInt16LE(b + 88) },
      newer: { epoch: d.readBigUInt64LE(b + 90), max: d.readBigUInt64LE(b + 98), bps: d.readUInt16LE(b + 106) },
    };
  }
  return null;
}
const effectiveBps = (mint, epoch) => { const f = feeConfig(mint); return BigInt(epoch) >= f.newer.epoch ? f.newer.bps : f.older.bps; };
function acctWithheld(ata) {
  const d = acctData(ata); if (!d || d.length <= 165) return 0n;
  for (const e of tlvEntries(d)) if (e.ty === 2) return d.readBigUInt64LE(e.at);
  return 0n;
}
const schedState = (mint) => {
  const d = acctData(schedPda(mint)); if (!d) return null;
  return {
    tag: d[0], schedBump: d[1], feeauthBump: d[2], mint: new PublicKey(d.subarray(4, 36)),
    startTs: Number(d.readBigInt64LE(36)), decay: Number(d.readBigUInt64LE(44)),
    startBps: d.readUInt16LE(52), floorBps: d.readUInt16LE(54), lastApplied: d.readUInt16LE(56),
    lastApplyTs: Number(d.readBigInt64LE(58)), applyCount: d.readBigUInt64LE(66),
  };
};
const distState = (mint) => {
  const d = acctData(distPda(mint));
  return {
    tag: d[0], index: d.readBigUInt64LE(97) | (d.readBigUInt64LE(105) << 64n),
    totalHarvested: d.readBigUInt64LE(113), totalDistributed: d.readBigUInt64LE(121),
    totalCuts: d.readBigUInt64LE(129), cutBps: d.readUInt16LE(137), fundingMode: d[140],
    count: d.readBigUInt64LE(149), totalPaidOut: d.readBigUInt64LE(157),
  };
};

// ---------- engine-shaped Config PDA (byte-exact per engine/src/lib.rs) ----------
function installConfig(mint, rules, { owner = ENGINE } = {}) {
  const d = Buffer.alloc(1088);
  d[0] = 1; d[1] = 2; d[2] = 0; d[3] = rules.length; // tag, ENGINE_VERSION, Locked, count
  mint.toBuffer().copy(d, 4);
  payer.publicKey.toBuffer().copy(d, 36); // authority
  rules.forEach((r, i) => {
    const o = 462 + i * 68;
    d.writeUInt16LE(r.id, o); d[o + 2] = r.enabled === false ? 0 : 1;
    if (r.params) Buffer.from(r.params).copy(d, o + 4);
  });
  d.writeUInt16LE(START_BPS, 1006);  // fee_bps mirror
  d.writeBigUInt64LE(MAX_FEE, 1008); // fee_max mirror
  svm.setAccount(configPda(mint), { lamports: 10_000_000, data: new Uint8Array(d), owner, executable: false, rentEpoch: 0 });
}
const rule14Params = (start = START_BPS, floor = FLOOR_BPS, decay = DECAY_SECS) => {
  const p = Buffer.alloc(64); p.writeUInt16LE(start, 0); p.writeUInt16LE(floor, 2); p.writeBigUInt64LE(BigInt(decay), 4); return p;
};

// ---------- instruction builders ----------
const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });
const initSchedIx = (mint, payerKp = payer) => new TransactionInstruction({
  programId: FS, data: Buffer.from([0]),
  keys: [K(payerKp.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, false), K(schedPda(mint), false, true), K(SystemProgram.programId, false, false)],
});
const applyIx = (mint, crankerPk, schedOverride = null) => new TransactionInstruction({
  programId: FS, data: Buffer.from([1]),
  keys: [K(crankerPk, true, false), K(mint, false, true), K(schedOverride || schedPda(mint), false, true), K(feeauthPda(mint), false, false), K(T22, false, false)],
});

// ---------- mint / actor factories ----------
async function makeFeeMint({ feeAuthFor, withdrawAuth, withdrawAuthFor, bps = START_BPS }) {
  const mintKp = Keypair.generate(); const mint = mintKp.publicKey;
  const feeAuth = feeAuthFor ? feeAuthFor(mint) : payer.publicKey;
  if (withdrawAuthFor) withdrawAuth = withdrawAuthFor(mint);
  const len = getMintLen([ExtensionType.TransferFeeConfig]);
  const rent = svm.minimumBalanceForRentExemption(BigInt(len));
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, space: len, lamports: Number(rent), programId: T22 }),
    createInitializeTransferFeeConfigInstruction(mint, feeAuth, withdrawAuth, bps, MAX_FEE, T22),
    createInitializeMintInstruction(mint, DECIMALS, payer.publicKey, null, T22),
  ], [payer, mintKp], 'create fee mint');
  return mint;
}
async function actor(mint, sol = 5) {
  const kp = Keypair.generate(); svm.airdrop(kp.publicKey, BigInt(sol * LAMPORTS_PER_SOL));
  const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, false, T22);
  await send([createAssociatedTokenAccountInstruction(payer.publicKey, ata, kp.publicKey, mint, T22)], [payer], 'actor ATA');
  return { kp, ata };
}
async function payerAtaWithSupply(mint) {
  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, false, T22);
  await send([
    createAssociatedTokenAccountInstruction(payer.publicKey, ata, payer.publicKey, mint, T22),
    createMintToInstruction(mint, ata, payer.publicKey, SUPPLY, [], T22),
  ], [payer], 'mint supply');
  return ata;
}
const xfer = (mint, fromAta, toAta, ownerKp, amount) =>
  send([createTransferCheckedInstruction(fromAta, mint, toAta, ownerKp.publicKey, amount, DECIMALS, [], T22)], [ownerKp], 'transfer');
// Exact fee Token-2022 charges: ceil(amount * bps / 10000), capped at MAX_FEE.
const feeOf = (amount, bps) => { const f = (amount * BigInt(bps) + 9999n) / 10000n; return f > MAX_FEE ? MAX_FEE : f; };
const linearTarget = (elapsed) => START_BPS - Math.floor((START_BPS - FLOOR_BPS) * Math.min(elapsed, DECAY_SECS) / DECAY_SECS);

console.log('feeschedule:', FS.toBase58(), '| engine id:', ENGINE.toBase58(), '| distributor:', DIST.toBase58());

// ================================================================
section('S1: fee mint (authority = feeauth PDA) + engine Config PDA; InitSchedule snapshots');
// ================================================================
const M1 = await makeFeeMint({ feeAuthFor: (m) => feeauthPda(m), withdrawAuth: payer.publicKey });
installConfig(M1, [{ id: 14, params: rule14Params() }]);
{
  const f = feeConfig(M1);
  ok(f && f.auth && f.auth.equals(feeauthPda(M1)), 'S1 mint transferFeeConfigAuthority == ["feeauth", mint] PDA', `(${f?.auth?.toBase58()})`);
  ok(f.older.bps === START_BPS && f.newer.bps === START_BPS && f.older.max === MAX_FEE && f.newer.max === MAX_FEE, 'S1 mint starts at start_bps with maximumFee as set');
  const cd = acctData(configPda(M1));
  ok(cd.length === 1088 && cd[0] === 1 && cd[1] === 2 && acct(configPda(M1)).owner.equals(ENGINE), 'S1 constructed Config PDA: 1088B, tag 1, v2, engine-owned');
  const rp = cd.subarray(462 + 4, 462 + 4 + 64);
  ok(cd.readUInt16LE(462) === 14 && cd[462 + 2] === 1 && rp.readUInt16LE(0) === START_BPS && rp.readUInt16LE(2) === FLOOR_BPS && Number(rp.readBigUInt64LE(4)) === DECAY_SECS, 'S1 config rule-14 entry carries the coordinator params block');
}
await send([initSchedIx(M1)], [payer], 'InitSchedule M1');
{
  const s = schedState(M1);
  const [, sb] = PublicKey.findProgramAddressSync([Buffer.from('sched'), M1.toBuffer()], FS);
  const [, fb] = PublicKey.findProgramAddressSync([Buffer.from('feeauth'), M1.toBuffer()], FS);
  ok(s && s.tag === 1 && s.mint.equals(M1) && s.schedBump === sb && s.feeauthBump === fb, 'S1 schedule PDA created with correct bumps + mint');
  ok(s.startTs === T0 && s.startBps === START_BPS && s.floorBps === FLOOR_BPS && s.decay === DECAY_SECS, 'S1 snapshot: start_ts = clock, params copied from config', `(ts ${s.startTs})`);
  ok(s.lastApplied === START_BPS && s.applyCount === 0n, 'S1 last_applied_bps = current mint bps (500)');
}
{
  const e = await attempt(() => send([initSchedIx(M1)], [payer], 'InitSchedule again'));
  ok(e && e.custom === ERR.AlreadyInit, 'S1 second InitSchedule fails AlreadyInit (1)', `(${e?.custom})`);
}

// ================================================================
section('S2: InitSchedule fails closed — no rule 14 / fee authority is a plain keypair / foreign config');
// ================================================================
const M_NO14 = await makeFeeMint({ feeAuthFor: (m) => feeauthPda(m), withdrawAuth: payer.publicKey });
installConfig(M_NO14, [{ id: 9, params: (() => { const p = Buffer.alloc(64); p.writeUInt16LE(500, 0); return p; })() }]);
{
  const e = await attempt(() => send([initSchedIx(M_NO14)], [payer], 'init no-rule-14'));
  ok(e && e.custom === ERR.RuleNotEnabled, 'S2 config without rule 14 -> RuleNotEnabled (6)', `(${e?.custom})`);
  ok(acctData(schedPda(M_NO14)) === null, 'S2 no schedule PDA was created');
}
const M_DISABLED14 = await makeFeeMint({ feeAuthFor: (m) => feeauthPda(m), withdrawAuth: payer.publicKey });
installConfig(M_DISABLED14, [{ id: 14, enabled: false, params: rule14Params() }]);
{
  const e = await attempt(() => send([initSchedIx(M_DISABLED14)], [payer], 'init disabled-rule-14'));
  ok(e && e.custom === ERR.RuleNotEnabled, 'S2 rule 14 present but disabled -> RuleNotEnabled (6)', `(${e?.custom})`);
}
const plainAuth = Keypair.generate();
const M_KEYAUTH = await makeFeeMint({ feeAuthFor: () => plainAuth.publicKey, withdrawAuth: payer.publicKey });
installConfig(M_KEYAUTH, [{ id: 14, params: rule14Params() }]);
{
  const e = await attempt(() => send([initSchedIx(M_KEYAUTH)], [payer], 'init keypair-authority mint'));
  ok(e && e.custom === ERR.NotFeeAuthority, 'S2 mint fee authority is a normal keypair -> NotFeeAuthority (4)', `(${e?.custom})`);
  ok(acctData(schedPda(M_KEYAUTH)) === null, 'S2 no schedule PDA was created for the keypair-authority mint');
}
const M_FOREIGN = await makeFeeMint({ feeAuthFor: (m) => feeauthPda(m), withdrawAuth: payer.publicKey });
installConfig(M_FOREIGN, [{ id: 14, params: rule14Params() }], { owner: SystemProgram.programId });
{
  const e = await attempt(() => send([initSchedIx(M_FOREIGN)], [payer], 'init foreign-owned config'));
  ok(e && e.custom === ERR.BadConfig, 'S2 config not owned by the engine program -> BadConfig (5)', `(${e?.custom})`);
}
// Authority-rotation probe (the launcher integration finding, proven live):
// a mint created with a keypair fee authority can be rotated to the PDA
// post-creation via SetAuthority type 4 (TransferFeeConfig), after which
// InitSchedule succeeds for the SAME mint used in the failure above.
svm.airdrop(plainAuth.publicKey, BigInt(5 * LAMPORTS_PER_SOL));
await send([createSetAuthorityInstruction(M_KEYAUTH, plainAuth.publicKey, AuthorityType.TransferFeeConfig, feeauthPda(M_KEYAUTH), [], T22)], [plainAuth], 'rotate fee authority to PDA');
ok(feeConfig(M_KEYAUTH).auth.equals(feeauthPda(M_KEYAUTH)), 'S2 SetAuthority (TransferFeeConfig=4) rotated the keypair authority to the feeauth PDA');
await send([initSchedIx(M_KEYAUTH)], [payer], 'InitSchedule after rotation');
ok(schedState(M_KEYAUTH)?.lastApplied === START_BPS, 'S2 InitSchedule succeeds after the post-creation rotation');

// ================================================================
section('S3: transfers withhold exactly at start_bps before any Apply');
// ================================================================
const payerAta1 = await payerAtaWithSupply(M1);
const A1 = await actor(M1);
{
  const amt = 100_000n * TOK;
  const wb = acctWithheld(A1.ata);
  await xfer(M1, payerAta1, A1.ata, payer, amt);
  ok(acctWithheld(A1.ata) - wb === feeOf(amt, START_BPS) && bal(A1.ata) === amt - feeOf(amt, START_BPS), 'S3 100k TOK at 500 bps: withheld exactly 5,000 TOK', `(${acctWithheld(A1.ata)})`);
  const odd = 1_000_001n; const wb2 = acctWithheld(A1.ata), b2 = bal(A1.ata);
  await xfer(M1, payerAta1, A1.ata, payer, odd);
  ok(acctWithheld(A1.ata) - wb2 === feeOf(odd, START_BPS), 'S3 odd-amount transfer: withheld = ceil(amount*bps/10000) exactly', `(${feeOf(odd, START_BPS)})`);
  ok(bal(A1.ata) - b2 === odd - feeOf(odd, START_BPS), 'S3 odd-amount net credit exact');
}

// ================================================================
section('S4: mid-decay Apply by an unrelated third party — exact linear target, epoch-delayed effect');
// ================================================================
const cranker = Keypair.generate(); svm.airdrop(cranker.publicKey, BigInt(5 * LAMPORTS_PER_SOL));
setClock(T0 + 15 * DAY, 2); // half-way through the 30-day decay; epoch 2
const targetMid = linearTarget(15 * DAY);
ok(targetMid === 300, 'S4 mirror: linear target at 15d is exactly 300 bps', `(${targetMid})`);
await send([applyIx(M1, cranker.publicKey)], [cranker], 'Apply mid-decay by third party');
{
  const s = schedState(M1); const f = feeConfig(M1);
  ok(s.lastApplied === targetMid && s.applyCount === 1n && s.lastApplyTs === T0 + 15 * DAY, 'S4 schedule recorded last_applied = 300 after the permissionless crank');
  ok(f.newer.bps === targetMid && f.newer.epoch === 4n && f.newer.max === MAX_FEE, 'S4 mint NEWER entry scheduled: 300 bps @ epoch 4 (current+2), maximumFee unchanged');
  ok(f.older.bps === START_BPS && effectiveBps(M1, 2) === START_BPS, 'S4 effective rate is still 500 bps at epoch 2 (Token-2022 epoch delay, measured)');
}
setClock(T0 + 15 * DAY, 4); // epoch reaches the newer entry
{
  ok(effectiveBps(M1, 4) === targetMid, 'S4 effective rate is exactly 300 bps at epoch 4');
  const amt = 100_000n * TOK; const wb = acctWithheld(A1.ata), b = bal(A1.ata);
  await xfer(M1, payerAta1, A1.ata, payer, amt);
  ok(acctWithheld(A1.ata) - wb === feeOf(amt, targetMid) && bal(A1.ata) - b === amt - feeOf(amt, targetMid), 'S4 transfers now withhold exactly at 300 bps (3,000 TOK per 100k)');
}

// ================================================================
section('S5: past decay — floor reached, Apply is a no-op thereafter, and can never raise');
// ================================================================
setClock(T0 + 31 * DAY, 6);
await send([applyIx(M1, cranker.publicKey)], [cranker], 'Apply past decay');
{
  const s = schedState(M1); const f = feeConfig(M1);
  ok(s.lastApplied === FLOOR_BPS && s.applyCount === 2n, 'S5 last_applied == floor_bps (100) after the past-decay Apply');
  ok(f.newer.bps === FLOOR_BPS && f.newer.epoch === 8n && f.newer.max === MAX_FEE, 'S5 mint NEWER entry scheduled: 100 bps @ epoch 8, maximumFee unchanged');
}
setClock(T0 + 31 * DAY, 8);
{
  const amt = 100_000n * TOK; const wb = acctWithheld(A1.ata);
  await xfer(M1, payerAta1, A1.ata, payer, amt);
  ok(acctWithheld(A1.ata) - wb === feeOf(amt, FLOOR_BPS), 'S5 transfers withhold exactly at the floor (1,000 TOK per 100k)');
  const before = feeConfig(M1); const cnt = schedState(M1).applyCount;
  await send([applyIx(M1, cranker.publicKey)], [cranker], 'Apply again at floor');
  const after = feeConfig(M1);
  ok(after.newer.bps === before.newer.bps && after.newer.epoch === before.newer.epoch && schedState(M1).applyCount === cnt && schedState(M1).lastApplied === FLOOR_BPS, 'S5 further Apply at the floor is a successful no-op (no CPI, count unchanged)');
}
setClock(T0 + 1 * DAY, 10); // wall clock warped BACKWARDS; epoch keeps moving forward
{
  await send([applyIx(M1, cranker.publicKey)], [cranker], 'Apply with warped-back clock');
  const f = feeConfig(M1); const s = schedState(M1);
  ok(s.lastApplied === FLOOR_BPS && f.newer.bps === FLOOR_BPS && effectiveBps(M1, 10) === FLOOR_BPS, 'S5 warped-back clock: target (500) >= last_applied -> no-op; the rate did NOT rise');
  const amt = 10_000n * TOK; const wb = acctWithheld(A1.ata);
  await xfer(M1, payerAta1, A1.ata, payer, amt);
  ok(acctWithheld(A1.ata) - wb === feeOf(amt, FLOOR_BPS), 'S5 transfers still withhold at the floor after the backwards warp');
}

// ================================================================
section('S6: POST-GRADUATION — hook-free fee mint: schedule flow + Distributor mode-0 end-to-end');
// ================================================================
// A second mint with NO transfer hook at all (the post-DAMM state: the hook
// is revoked at migration, the Transfer Fee extension survives). Its
// withdraw authority is the Distributor's DistState PDA (INTEGRATION.md
// funding path (a)); its fee authority is this program's feeauth PDA.
const T6 = T0 + 40 * DAY;
setClock(T6, 20);
const M2 = await makeFeeMint({ feeAuthFor: (m) => feeauthPda(m), withdrawAuthFor: (m) => distPda(m) });
installConfig(M2, [{ id: 14, params: rule14Params() }]);
{
  const types = tlvEntries(acctData(M2)).map((e) => e.ty);
  ok(types.length === 1 && types[0] === 1, 'S6 mint carries ONLY the TransferFeeConfig extension — no transfer hook (post-graduation shape)', `(types ${types})`);
  ok(feeConfig(M2).withdraw.equals(distPda(M2)), 'S6 mint withdraw authority == DistState PDA (distributor path (a))');
  ok(feeConfig(M2).auth.equals(feeauthPda(M2)), 'S6 mint fee authority == feeauth PDA');
}
await send([initSchedIx(M2)], [payer], 'InitSchedule M2');
ok(schedState(M2)?.startTs === T6 && schedState(M2)?.lastApplied === START_BPS, 'S6 schedule initialized on the hook-free mint');
// Decay it all the way to the floor, then let the epoch catch up.
setClock(T6 + 31 * DAY, 22);
await send([applyIx(M2, cranker.publicKey)], [cranker], 'Apply M2 past decay');
setClock(T6 + 31 * DAY, 24);
ok(schedState(M2).lastApplied === FLOOR_BPS && effectiveBps(M2, 24) === FLOOR_BPS, 'S6 hook-free mint decayed to the floor exactly (schedule survives hook-free state)');
// Distributor: initialize against the hook-free fee mint (mode 0, path (a)).
const vault2 = getAssociatedTokenAddressSync(M2, distPda(M2), true, T22);
await send([createAssociatedTokenAccountInstruction(payer.publicKey, vault2, distPda(M2), M2, T22)], [payer], 'distributor vault ATA');
await send([new TransactionInstruction({
  programId: DIST, data: Buffer.from([0, 100, 0]), // tag 0, crank cut 100 bps
  keys: [K(payer.publicKey, true, true), K(M2, false, false), K(vault2, false, false), K(distPda(M2), false, true), K(SystemProgram.programId, false, false)],
})], [payer], 'init distributor M2');
{
  const s = distState(M2);
  ok(s.tag === 1 && s.fundingMode === 0 && s.cutBps === 100, 'S6 distributor initialized in funding mode 0 (harvest) on the hook-free mint');
}
const payerAta2 = await payerAtaWithSupply(M2);
const H1 = await actor(M2), H2 = await actor(M2);
await xfer(M2, payerAta2, H1.ata, payer, 200_000n * TOK);
await xfer(M2, payerAta2, H2.ata, payer, 100_000n * TOK);
const W6 = acctWithheld(H1.ata) + acctWithheld(H2.ata);
ok(bal(H1.ata) === 198_000n * TOK && bal(H2.ata) === 99_000n * TOK && W6 === 3_000n * TOK, 'S6 fees accrued at the DECAYED 1% rate (2,000 + 1,000 TOK withheld)', `(W ${W6})`);
// Permissionless distribute: harvest + withdraw + fold, cranker takes the cut.
const CUT6 = (W6 * 100n) / 10_000n, NET6 = W6 - CUT6;
const ELIG6 = SUPPLY - NET6; // vault_after = W - cut = NET (vault started empty)
const IDX6 = (NET6 * SCALE) / ELIG6;
const crank2 = await actor(M2);
await send([new TransactionInstruction({
  programId: DIST, data: Buffer.from([1]),
  keys: [K(crank2.kp.publicKey, true, false), K(M2, false, true), K(distPda(M2), false, true), K(vault2, false, true), K(crank2.ata, false, true), K(T22, false, false),
    K(H1.ata, false, true), K(H2.ata, false, true)],
})], [crank2.kp], 'distribute M2');
{
  const s = distState(M2);
  ok(s.index === IDX6 && s.totalHarvested === W6 && s.totalDistributed === NET6 && s.totalCuts === CUT6 && s.count === 1n, 'S6 distribute folded the decayed-rate fees exactly (index/cut/net mirror)', `(index ${s.index})`);
  ok(bal(vault2) === NET6, 'S6 vault holds the net fold');
  ok(bal(crank2.ata) === CUT6 - feeOf(CUT6, FLOOR_BPS) && acctWithheld(crank2.ata) === feeOf(CUT6, FLOOR_BPS), 'S6 cranker received the 30 TOK cut gross (net of the 1% fee on the cut transfer)');
  ok(acctWithheld(H1.ata) === 0n && acctWithheld(H2.ata) === 0n, 'S6 withheld sources harvested clean');
}
// Holder claims exactly: entitlement = balance * index / SCALE, vault-debited
// in full; the holder nets entitlement minus the 1% payout-transfer fee.
{
  const ent = (bal(H1.ata) * IDX6) / SCALE;
  const vaultBefore = bal(vault2), hBal = bal(H1.ata), hWh = acctWithheld(H1.ata);
  await send([new TransactionInstruction({
    programId: DIST, data: Buffer.from([2]),
    keys: [K(H1.kp.publicKey, true, true), K(H1.kp.publicKey, false, false), K(H1.ata, false, true), K(M2, false, false),
      K(distPda(M2), false, true), K(vault2, false, true), K(claimPda(M2, H1.kp.publicKey), false, true), K(T22, false, false), K(SystemProgram.programId, false, false)],
  })], [H1.kp], 'claim H1');
  ok(vaultBefore - bal(vault2) === ent && ent > 0n, 'S6 holder claim: vault debited exactly the entitlement', `(${ent} raw)`);
  ok((bal(H1.ata) - hBal) + (acctWithheld(H1.ata) - hWh) === ent, 'S6 holder received the entitlement (net + fee withheld on the payout)');
  ok(distState(M2).totalPaidOut === ent, 'S6 distributor total_paid_out tracks the claim exactly');
}

// ================================================================
section('S7: bounds — forged schedule PDA / tampered schedule params fail closed, rate unchanged');
// ================================================================
setClock(T0 + 20 * DAY, 30);
{
  const forged = Keypair.generate().publicKey;
  const e = await attempt(() => send([applyIx(M1, cranker.publicKey, forged)], [cranker], 'Apply with forged schedule address'));
  ok(e && (e.custom === 'InvalidSeeds' || e.custom === 0), 'S7 Apply against a non-PDA schedule address is rejected (InvalidSeeds)', `(${e?.custom})`);
  ok(effectiveBps(M1, 30) === FLOOR_BPS && schedState(M1).lastApplied === FLOOR_BPS, 'S7 rate unchanged after the forged-schedule attempt');
}
{
  // Tamper the REAL schedule PDA's stored params in place (setAccount
  // stands in for any state corruption): floor above start.
  const orig = acct(schedPda(M1));
  const tampered = Buffer.from(orig.data);
  tampered.writeUInt16LE(600, 54); // floor_bps 600 > start_bps 500
  svm.setAccount(schedPda(M1), { lamports: orig.lamports, data: new Uint8Array(tampered), owner: orig.owner, executable: false, rentEpoch: 0 });
  const e = await attempt(() => send([applyIx(M1, cranker.publicKey)], [cranker], 'Apply with tampered floor'));
  ok(e && e.custom === ERR.BadParams, 'S7 tampered floor_bps > start_bps -> BadParams (7)', `(${e?.custom})`);
  ok(feeConfig(M1).newer.bps === FLOOR_BPS, 'S7 mint rate unchanged after the tampered-params Apply');
  svm.setAccount(schedPda(M1), { lamports: orig.lamports, data: new Uint8Array(orig.data), owner: orig.owner, executable: false, rentEpoch: 0 });
}
{
  // Tamper last_applied_bps above start_bps.
  const orig = acct(schedPda(M1));
  const tampered = Buffer.from(orig.data);
  tampered.writeUInt16LE(9999, 56);
  svm.setAccount(schedPda(M1), { lamports: orig.lamports, data: new Uint8Array(tampered), owner: orig.owner, executable: false, rentEpoch: 0 });
  const e = await attempt(() => send([applyIx(M1, cranker.publicKey)], [cranker], 'Apply with tampered last_applied'));
  ok(e && e.custom === ERR.OutOfBounds, 'S7 tampered last_applied_bps (9999) -> OutOfBounds (8)', `(${e?.custom})`);
  ok(feeConfig(M1).newer.bps === FLOOR_BPS, 'S7 mint rate unchanged after the tampered-last_applied Apply');
  svm.setAccount(schedPda(M1), { lamports: orig.lamports, data: new Uint8Array(orig.data), owner: orig.owner, executable: false, rentEpoch: 0 });
  await send([applyIx(M1, cranker.publicKey)], [cranker], 'Apply after restoring the schedule');
  ok(schedState(M1).lastApplied === FLOOR_BPS, 'S7 restored schedule Applies cleanly again (no-op at the floor)');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
if (failures.length) console.log('failed checks:', failures.join(' | '));
fs.writeFileSync(path.join(DIR, 'trial-result.json'), JSON.stringify({ pass, fail, failures }, null, 2));
process.exit(fail === 0 ? 0 : 1);

// Hook Launcher DISTRIBUTOR — Phase B settlement SPLITS suite (LiteSVM, local only).
//
// What this proves (tag 4 = DistributeWithSplits):
//   The fold math is tag 1's, in BOTH funding modes. After the caller cut,
//   configured shares of the NET fold are carved out in crown/seat/king
//   order (bps read from the ENGINE Config PDA — constructed here as a
//   byte-exact 1088-byte account owned by the engine program id, layout
//   parsed from engine/src/lib.rs) and paid LIVE from the vault to:
//     rule 5  Crown:  the CURRENT beneficiary in a Crown-program PDA.
//             The REAL crown-sol binary (target/deploy/crown_sol.so,
//             built by the parallel Crown workstream) is deployed in
//             LiteSVM and initialized with a real Init; the beneficiary
//             flip is driven through the REAL challenge -> finalize flow
//             (tiny init params: 0.01 SOL bond/quorum, 60 s window,
//             timelock/min-reign/cooldown 0, slash 0). If the binary is
//             absent the suite falls back to a mock Crown PDA (real PDA
//             address under the Crown id, distributor-validated layout).
//     rule 6  Seat:   the CURRENT holder of the seat NFT (a real
//             Token-2022 mint; the stream follows the NFT on transfer)
//     rule 15 King:   the CURRENT king owner in the engine King PDA
//             (constructed account bytes owned by the engine id, at the
//             real ["king", mint] PDA, engine v4 layout)
//   The remainder folds into the index. Fail-open per split: a skipped
//   split's share folds into the index instead. Wrong config account and
//   bps-sum > 10_000 hard-error. Accounting identity
//   vault == total_distributed - total_paid_out is asserted to the unit
//   after every step, in both modes (mode 0 asserts conservation WITH the
//   transfer fee on split payouts; mode 1 asserts exact amounts).
//
// Run: node trial-splits.mjs   (exit 1 on failure)
import { LiteSVM, FailedTransactionMetadata, Clock } from 'litesvm';
import {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createInitializeTransferFeeConfigInstruction, createInitializeMintInstruction,
  createMintToInstruction, createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, getMintLen, ExtensionType,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const readKp = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
const DIST = readKp(path.join(DIR, 'distributor-keypair.json')).publicKey;
const ENGINE = readKp(path.join(ROOT, 'engine', 'engine-keypair.json')).publicKey; // trial flavor id
const CROWN = readKp(path.join(ROOT, 'crown-sol', 'crown-keypair.json')).publicKey;
const T22 = TOKEN_2022_PROGRAM_ID;
const DECIMALS = 6;
const TOK = 10n ** 6n;
const SUPPLY = 1_000_000n * TOK;
const SCALE = 10n ** 12n;
const CUT_BPS = 100n;

const svm = new LiteSVM();
svm.addProgramFromFile(DIST, path.join(DIR, 'target/deploy/distributor.so'));
const CROWN_SO = path.join(ROOT, 'crown-sol', 'target', 'deploy', 'crown_sol.so');
const CROWN_REAL = fs.existsSync(CROWN_SO);
if (CROWN_REAL) svm.addProgramFromFile(CROWN, CROWN_SO);
svm.setClock(new Clock(1000n, 0n, 0n, 0n, 1_760_000_000n));
const payer = Keypair.generate();
svm.airdrop(payer.publicKey, BigInt(300 * LAMPORTS_PER_SOL));

// ---------- tx plumbing (trial.mjs idiom) ----------
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
async function attempt(fn) {
  try { await fn(); return null; }
  catch (e) { return (e.logs || []).join('\n').match(/custom program error: 0x([0-9a-f]+)/i)?.[1] ?? ('Other:' + String(e.message).slice(-160)); }
}
const acctData = (pk) => { const a = svm.getAccount(pk); return a ? Buffer.from(a.data) : null; };
const bal = (ata) => { const d = acctData(ata); return d ? d.readBigUInt64LE(64) : 0n; };
function acctWithheld(ata) {
  const d = acctData(ata);
  if (!d || d.length <= 165) return 0n;
  let off = 166;
  while (off + 4 <= d.length) {
    const ty = d.readUInt16LE(off), len = d.readUInt16LE(off + 2);
    if (ty === 2) return d.readBigUInt64LE(off + 4);
    off += 4 + len;
  }
  return 0n;
}

// ---------- PDAs ----------
const distPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('dist'), mint.toBuffer()], DIST)[0];
const claimPda = (mint, holder) => PublicKey.findProgramAddressSync([Buffer.from('claim'), mint.toBuffer(), holder.toBuffer()], DIST)[0];
const configPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('config'), mint.toBuffer()], ENGINE)[0];
const kingPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('king'), mint.toBuffer()], ENGINE)[0];
const crownPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('crown'), mint.toBuffer()], CROWN)[0];
const cvaultPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('cvault'), mint.toBuffer()], CROWN)[0];
const challengePda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('challenge'), mint.toBuffer()], CROWN)[0];
const stakePda = (mint, staker, side) => PublicKey.findProgramAddressSync([Buffer.from('stake'), mint.toBuffer(), staker.toBuffer(), Buffer.from([side])], CROWN)[0];
// Real Crown Init: tag 0, accounts [authority(signer,w), mint, crown_pda(w),
// cvault_pda(w), system]; data [0][beneficiary][treasury] + the 50-byte
// param block (bond, quorum, window, timelock, min_reign, cooldown, slash).
const crownInitIx = (mint, beneficiary) => {
  const data = Buffer.alloc(115);
  data[0] = 0;
  beneficiary.toBuffer().copy(data, 1);
  payer.publicKey.toBuffer().copy(data, 33); // treasury = payer
  data.writeBigUInt64LE(10_000_000n, 65);    // bond 0.01 SOL
  data.writeBigUInt64LE(10_000_000n, 73);    // quorum 0.01 SOL
  data.writeBigInt64LE(60n, 81);             // window 60 s
  data.writeBigInt64LE(0n, 89);              // timelock 0
  data.writeBigInt64LE(0n, 97);              // min_reign 0
  data.writeBigInt64LE(0n, 105);             // cooldown 0
  data.writeUInt16LE(0, 113);                // slash 0 bps
  return new TransactionInstruction({
    programId: CROWN, data,
    keys: [K(payer.publicKey, true, true), K(mint, false, false), K(crownPda(mint), false, true),
      K(cvaultPda(mint), false, true), K(SystemProgram.programId, false, false)],
  });
};
async function initCrown(mint, beneficiary, label) {
  if (CROWN_REAL) await send([crownInitIx(mint, beneficiary)], [payer], label);
  else setAcct(crownPda(mint), crownBytes(mint, beneficiary), CROWN);
}
// Real beneficiary flip: OpenChallenge (bond = quorum-sized challenger
// stake, candidate = new beneficiary), warp past window_end + timelock,
// Finalize (challenger wins: stake 10,000,000 > reigning 0, total >= quorum).
async function flipCrown(mint, newBeneficiary) {
  if (!CROWN_REAL) { setAcct(crownPda(mint), crownBytes(mint, newBeneficiary), CROWN); return; }
  const openData = Buffer.alloc(33);
  openData[0] = 1;
  newBeneficiary.toBuffer().copy(openData, 1);
  await send([new TransactionInstruction({
    programId: CROWN, data: openData,
    keys: [K(payer.publicKey, true, true), K(mint, false, false), K(crownPda(mint), false, true),
      K(challengePda(mint), false, true), K(cvaultPda(mint), false, true),
      K(stakePda(mint, payer.publicKey, 1), false, true), K(SystemProgram.programId, false, false)],
  })], [payer], 'crown OpenChallenge');
  svm.setClock(new Clock(2000n, 0n, 0n, 0n, 1_760_000_000n + 7_200n));
  await send([new TransactionInstruction({
    programId: CROWN, data: Buffer.from([3]),
    keys: [K(payer.publicKey, true, false), K(mint, false, false), K(crownPda(mint), false, true),
      K(challengePda(mint), false, true), K(cvaultPda(mint), false, true), K(payer.publicKey, false, true)],
  })], [payer], 'crown Finalize');
}

const distState = (mintPk) => {
  const d = acctData(distPda(mintPk));
  return {
    tag: d[0], index: d.readBigUInt64LE(97) | (d.readBigUInt64LE(105) << 64n),
    totalHarvested: d.readBigUInt64LE(113), totalDistributed: d.readBigUInt64LE(121),
    totalCuts: d.readBigUInt64LE(129), cutBps: d.readUInt16LE(137), count: d.readBigUInt64LE(149),
    fundingMode: d[140], totalPaidOut: d.readBigUInt64LE(157), totalRoutedFolded: d.readBigUInt64LE(165),
  };
};
const claimState = (mintPk, holder) => {
  const d = acctData(claimPda(mintPk, holder));
  if (!d) return null;
  return { settled: d.readBigUInt64LE(65) | (d.readBigUInt64LE(73) << 64n), totalClaimed: d.readBigUInt64LE(81) };
};

// ---------- mock PDA account bytes (setAccount) ----------
const LAMPORTS = 10_000_000;
function setAcct(pk, data, owner) {
  svm.setAccount(pk, { lamports: LAMPORTS, data: new Uint8Array(data), owner, executable: false, rentEpoch: 0 });
}
// Engine Config PDA, 1088 B: [0]=1 tag, [1]=2 version, [2]=authority_mode,
// [3]=rule_count, [4..36] mint, [36..68] authority; rules @462, 68 B each:
// rule_id u16 @+0, enabled @+2, params[64] @+4.
function configBytes(mint, { crownBps = 0, seatMint = null, seatBps = 0, kingBps = 0 }) {
  const d = Buffer.alloc(1088);
  d[0] = 1; d[1] = 2; d[2] = 1; d[3] = 3;
  mint.toBuffer().copy(d, 4);
  payer.publicKey.toBuffer().copy(d, 36);
  const rule = (i, id, params) => { const o = 462 + i * 68; d.writeUInt16LE(id, o); d[o + 2] = 1; params.copy(d, o + 4); };
  const p5 = Buffer.alloc(64); p5.writeUInt16LE(crownBps, 0);
  rule(0, 5, p5);
  const p6 = Buffer.alloc(64); if (seatMint) seatMint.toBuffer().copy(p6, 0); p6.writeUInt16LE(seatBps, 32);
  rule(1, 6, p6);
  const p15 = Buffer.alloc(64); p15.writeUInt16LE(kingBps, 0);
  rule(2, 15, p15);
  return d;
}
// Crown PDA: [0]=1 tag, [1..33] mint, [33..65] beneficiary, [65..73] ts.
function crownBytes(mint, beneficiary) {
  const d = Buffer.alloc(96);
  d[0] = 1;
  mint.toBuffer().copy(d, 1);
  beneficiary.toBuffer().copy(d, 33);
  d.writeBigInt64LE(1_760_000_000n, 65);
  return d;
}
// Engine King PDA, 96 B: [0]=1, [1..33] king token acct, [33..65] king
// owner, [65..73] balance, [73..81] ts.
function kingBytes(kingAta, kingOwner, balanceRaw) {
  const d = Buffer.alloc(96);
  d[0] = 1;
  kingAta.toBuffer().copy(d, 1);
  kingOwner.toBuffer().copy(d, 33);
  d.writeBigUInt64LE(balanceRaw, 65);
  d.writeBigInt64LE(1_760_000_000n, 73);
  return d;
}

// ---------- distributor instruction builders ----------
const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });
const initIx = (mintPk, vaultAta) => new TransactionInstruction({
  programId: DIST, data: Buffer.from([0, 100, 0]),
  keys: [K(payer.publicKey, true, true), K(mintPk, false, false), K(vaultAta, false, false),
    K(distPda(mintPk), false, true), K(SystemProgram.programId, false, false)],
});
const coreKeys = (mintPk, vaultAta, cranker, crankerAta) => [
  K(cranker, true, false), K(mintPk, false, true), K(distPda(mintPk), false, true),
  K(vaultAta, false, true), K(crankerAta, false, true), K(T22, false, false),
];
const distributeIx = (mintPk, vaultAta, cranker, crankerAta, trailing = []) => new TransactionInstruction({
  programId: DIST, data: Buffer.from([1]),
  keys: [...coreKeys(mintPk, vaultAta, cranker, crankerAta), ...trailing.map((t) => K(t, false, true))],
});
// Tag 4: core, then [config, crown|sent, seatAcct|sent, king|sent,
// crownRecip|sent, seatRecip|sent, kingRecip|sent], then trailing
// (mode 0: fee sources writable; mode 1: none in this suite).
const splitsIx = (mintPk, vaultAta, cranker, crankerAta, splitKeys, trailing = []) => new TransactionInstruction({
  programId: DIST, data: Buffer.from([4]),
  keys: [
    ...coreKeys(mintPk, vaultAta, cranker, crankerAta),
    K(splitKeys.config, false, false),
    K(splitKeys.crown, false, false), K(splitKeys.seat, false, false), K(splitKeys.king, false, false),
    K(splitKeys.crownRecip, false, true), K(splitKeys.seatRecip, false, true), K(splitKeys.kingRecip, false, true),
    ...trailing.map((t) => K(t, false, true)),
  ],
});
const payoutIx = (tag, payerKp, holder, holderAta, mintPk, vaultAta) => new TransactionInstruction({
  programId: DIST, data: Buffer.from([tag]),
  keys: [K(payerKp, true, true), K(holder, false, false), K(holderAta, false, true), K(mintPk, false, false),
    K(distPda(mintPk), false, true), K(vaultAta, false, true), K(claimPda(mintPk, holder), false, true),
    K(T22, false, false), K(SystemProgram.programId, false, false)],
});

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
console.log('distributor:', DIST.toBase58(), '| engine (trial):', ENGINE.toBase58(), '| crown:', CROWN.toBase58());
console.log('crown binary:', CROWN_REAL ? CROWN_SO + ' (REAL crown program deployed in LiteSVM)' : 'absent (mock Crown PDA fallback)');

async function wallet(sol = 2) {
  const k = Keypair.generate();
  svm.airdrop(k.publicKey, BigInt(sol * LAMPORTS_PER_SOL));
  return k;
}
async function ataFor(mintPk, owner) {
  const ata = getAssociatedTokenAddressSync(mintPk, owner, false, T22);
  await send([createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mintPk, T22)], [payer], 'create ATA');
  return ata;
}
const xfer = (mintPk, fromAta, toAta, ownerKp, amount, decimals = DECIMALS) =>
  send([createTransferCheckedInstruction(fromAta, mintPk, toAta, ownerKp.publicKey, amount, decimals, [], T22)], [ownerKp], 'transfer');

// ================= SEAT NFT MINT =================
const seatMintKp = Keypair.generate();
const SEAT = seatMintKp.publicKey;
{
  const len = getMintLen([]);
  const rent = svm.minimumBalanceForRentExemption(BigInt(len));
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: SEAT, space: len, lamports: Number(rent), programId: T22 }),
    createInitializeMintInstruction(SEAT, 0, payer.publicKey, null, T22),
  ], [payer, seatMintKp], 'create seat mint');
}
const seatA = await wallet(), seatB = await wallet(), seatC = await wallet();
const seatAtaA = await ataFor(SEAT, seatA.publicKey);
const seatAtaB = await ataFor(SEAT, seatB.publicKey);
const seatAtaC = await ataFor(SEAT, seatC.publicKey);
await send([
  createMintToInstruction(SEAT, seatAtaA, payer.publicKey, 1n, [], T22),
  createMintToInstruction(SEAT, seatAtaC, payer.publicKey, 1n, [], T22),
], [payer], 'mint seat NFTs to A and C');
ok(bal(seatAtaA) === 1n && bal(seatAtaC) === 1n && bal(seatAtaB) === 0n, 'S seat NFTs minted (A=1, C=1, B=0)');

// ================= MODE 1 WORLD (fee-less mint) =================
console.log('=== M1 setup: fee-less mint, distributor mode 1, splits configured ===');
const mint1Kp = Keypair.generate(); const M1 = mint1Kp.publicKey;
const state1 = distPda(M1);
const vault1 = getAssociatedTokenAddressSync(M1, state1, true, T22);
{
  const len = getMintLen([]);
  const rent = svm.minimumBalanceForRentExemption(BigInt(len));
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: M1, space: len, lamports: Number(rent), programId: T22 }),
    createInitializeMintInstruction(M1, DECIMALS, payer.publicKey, null, T22),
    createAssociatedTokenAccountInstruction(payer.publicKey, vault1, state1, M1, T22),
  ], [payer, mint1Kp], 'create fee-less mint + vault');
}
await send([initIx(M1, vault1)], [payer], 'init distributor (mode 1)');
const payerAta1 = await ataFor(M1, payer.publicKey);
await send([createMintToInstruction(M1, payerAta1, payer.publicKey, SUPPLY, [], T22)], [payer], 'mint supply (mode 1)');
const A = await wallet(), B = await wallet(), CR = await wallet();
const aAta = await ataFor(M1, A.publicKey), bAta = await ataFor(M1, B.publicKey), crAta = await ataFor(M1, CR.publicKey);
const cb1 = await wallet(), cb2 = await wallet(), k1w = await wallet(), k2w = await wallet();
const cb1Ata = await ataFor(M1, cb1.publicKey), cb2Ata = await ataFor(M1, cb2.publicKey);
const k1Ata = await ataFor(M1, k1w.publicKey), k2Ata = await ataFor(M1, k2w.publicKey);
const seatAata1 = await ataFor(M1, seatA.publicKey), seatBata1 = await ataFor(M1, seatB.publicKey);
await xfer(M1, payerAta1, aAta, payer, 400_000n * TOK);
await xfer(M1, payerAta1, bAta, payer, 200_000n * TOK);
await xfer(M1, payerAta1, k1Ata, payer, 50_000n * TOK);
await xfer(M1, payerAta1, k2Ata, payer, 40_000n * TOK);

// Config: crown 500 bps, seat 300 bps (seat_mint = SEAT), king 200 bps.
const BPS1 = { crown: 500, seat: 300, king: 200 };
const writeConfig1 = (bps) => setAcct(configPda(M1), configBytes(M1, { crownBps: bps.crown, seatMint: SEAT, seatBps: bps.seat, kingBps: bps.king }), ENGINE);
writeConfig1(BPS1);
await initCrown(M1, cb1.publicKey, 'init crown (mode 1 mint)');
setAcct(kingPda(M1), kingBytes(k1Ata, k1w.publicKey, 50_000n * TOK), ENGINE);
{
  const s = distState(M1);
  ok(s.tag === 1 && s.fundingMode === 1 && s.cutBps === 100, 'M1 distributor in routed mode, cut 100 bps');
  const cd = acctData(configPda(M1));
  ok(cd && cd.length === 1088 && cd[0] === 1 && cd[1] === 2 && cd[3] === 3 && cd.readUInt16LE(462) === 5 && cd.readUInt16LE(462 + 4) === 500
    && cd.readUInt16LE(462 + 68) === 6 && cd.readUInt16LE(462 + 68 + 4 + 32) === 300 && cd.readUInt16LE(462 + 136) === 15,
    'M1 engine Config fixture: layout/params byte-exact vs engine offsets (rules @462, 68B entries)');
  const cr = acctData(crownPda(M1)), kg = acctData(kingPda(M1));
  ok(new PublicKey(cr.subarray(33, 65)).equals(cb1.publicKey) && new PublicKey(kg.subarray(33, 65)).equals(k1w.publicKey),
    'M1 Crown PDA names CB1; King PDA names K1');
}

// ---- mirror (mode 1) ----
const m1 = { index: 0n, vault: 0n, td: 0n, tpo: 0n, cuts: 0n, routed: 0n, count: 0n };
function m1Fold(bps, valid) {
  const fold = m1.vault - (m1.td - m1.tpo);
  const cut = (fold * CUT_BPS) / 10_000n;
  const net = fold - cut;
  const carve = (b, v) => (bps && v ? (net * BigInt(b)) / 10_000n : 0n);
  const crownAmt = carve(bps?.crown, valid.crown), seatAmt = carve(bps?.seat, valid.seat), kingAmt = carve(bps?.king, valid.king);
  const S = crownAmt + seatAmt + kingAmt;
  const remainder = net - S;
  const vaultAfter = m1.vault - cut - S;
  const delta = (remainder * SCALE) / (SUPPLY - vaultAfter);
  m1.index += delta; m1.td += net; m1.tpo += S; m1.cuts += cut; m1.routed += fold; m1.count += 1n; m1.vault = vaultAfter;
  return { fold, cut, net, crownAmt, seatAmt, kingAmt, S, remainder, delta };
}
const m1Claim = (balance, settled) => (balance * (m1.index - settled)) / SCALE;
const ALL = { crown: true, seat: true, king: true };
const splitKeys1 = (over = {}) => ({
  config: configPda(M1), crown: crownPda(M1), seat: seatAtaA, king: kingPda(M1),
  crownRecip: cb1Ata, seatRecip: seatAata1, kingRecip: k1Ata, ...over,
});

console.log('=== M1-D1: tag 4 fold #1 — all three splits pay live ===');
await xfer(M1, payerAta1, vault1, payer, 20_000n * TOK); m1.vault += 20_000n * TOK;
const e1 = m1Fold(BPS1, ALL);
await send([splitsIx(M1, vault1, CR.publicKey, crAta, splitKeys1())], [CR], 'tag4 distribute 1');
{
  ok(e1.crownAmt === 990n * TOK && e1.seatAmt === 594n * TOK && e1.kingAmt === 396n * TOK && e1.cut === 200n * TOK,
    'M1-D1 carve math: net 19,800 -> crown 990 / seat 594 / king 396, cut 200 TOK');
  ok(bal(cb1Ata) === e1.crownAmt, 'M1-D1 crown beneficiary CB1 paid exactly');
  ok(bal(seatAata1) === e1.seatAmt, 'M1-D1 seat holder A paid exactly');
  ok(bal(k1Ata) === 50_000n * TOK + e1.kingAmt && bal(crAta) === e1.cut, 'M1-D1 king K1 and cranker paid exactly');
  const s = distState(M1);
  ok(s.index === m1.index && s.totalDistributed === m1.td && s.totalPaidOut === m1.tpo && s.totalCuts === m1.cuts && s.count === 1n && s.totalRoutedFolded === 20_000n * TOK,
    'M1-D1 state matches mirror (td = FULL net 19,800; tpo = splits 1,980)');
  ok(bal(vault1) === m1.vault && bal(vault1) === s.totalDistributed - s.totalPaidOut, 'M1-D1 identity: vault == td - tpo == remainder 17,820 TOK');
}
let settledA = 0n;
{
  const EA = m1Claim(bal(aAta), 0n);
  const vBefore = bal(vault1);
  await send([payoutIx(2, A.publicKey, A.publicKey, aAta, M1, vault1)], [A], 'claim A after D1');
  ok(vBefore - bal(vault1) === EA && bal(aAta) === 400_000n * TOK + EA, 'M1-D1 A claims its remainder-only entitlement exactly (split money not double-claimed)', `(${EA} raw)`);
  m1.vault -= EA; m1.paidOut = EA; m1.tpo += EA;
  settledA = m1.index;
  const s = distState(M1);
  ok(s.totalPaidOut === m1.tpo && bal(vault1) === s.totalDistributed - s.totalPaidOut, 'M1-D1 identity holds after A claim');
  const cs = claimState(M1, A.publicKey);
  ok(cs && cs.settled === settledA && cs.totalClaimed === EA, 'M1-D1 A claim record exact');
}

console.log('=== M1-D2: seat NFT moves A -> B; the seat stream follows it ===');
await xfer(SEAT, seatAtaA, seatAtaB, seatA, 1n, 0);
ok(bal(seatAtaB) === 1n && bal(seatAtaA) === 0n, 'M1-D2 seat NFT transferred A -> B');
await xfer(M1, payerAta1, vault1, payer, 10_000n * TOK); m1.vault += 10_000n * TOK;
const e2 = m1Fold(BPS1, ALL);
{
  const saBefore = bal(seatAata1), k1Before = bal(k1Ata);
  await send([splitsIx(M1, vault1, CR.publicKey, crAta, splitKeys1({ seat: seatAtaB, seatRecip: seatBata1 }))], [CR], 'tag4 distribute 2');
  ok(bal(seatBata1) === e2.seatAmt && bal(seatAata1) === saBefore, 'M1-D2 seat split pays NEW holder B (297 TOK); A gets nothing', `(${e2.seatAmt} raw)`);
  ok(bal(cb1Ata) === e1.crownAmt + e2.crownAmt && bal(k1Ata) === k1Before + e2.kingAmt, 'M1-D2 crown + king splits exact');
  const s = distState(M1);
  ok(s.index === m1.index && s.totalDistributed === m1.td && s.totalPaidOut === m1.tpo && s.count === 2n && bal(vault1) === s.totalDistributed - s.totalPaidOut,
    'M1-D2 state + identity match mirror');
}

console.log('=== M1-D3: crown passes to CB2, kingship passes to K2 ===');
await flipCrown(M1, cb2.publicKey);
{
  const cr = acctData(crownPda(M1));
  ok(cr && cr[0] === 1 && new PublicKey(cr.subarray(33, 65)).equals(cb2.publicKey),
    CROWN_REAL ? 'M1-D3 crown beneficiary flipped to CB2 via the REAL challenge -> finalize flow' : 'M1-D3 crown beneficiary flipped to CB2 (mock PDA rewrite)');
}
setAcct(kingPda(M1), kingBytes(k2Ata, k2w.publicKey, 40_000n * TOK), ENGINE);
await xfer(M1, payerAta1, vault1, payer, 10_000n * TOK); m1.vault += 10_000n * TOK;
const e3 = m1Fold(BPS1, ALL);
{
  const cb1Before = bal(cb1Ata), k1Before = bal(k1Ata);
  await send([splitsIx(M1, vault1, CR.publicKey, crAta, splitKeys1({ seat: seatAtaB, seatRecip: seatBata1, crownRecip: cb2Ata, kingRecip: k2Ata }))], [CR], 'tag4 distribute 3');
  ok(bal(cb2Ata) === e3.crownAmt && bal(cb1Ata) === cb1Before, 'M1-D3 crown split pays NEW beneficiary CB2 only');
  ok(bal(k2Ata) === 40_000n * TOK + e3.kingAmt && bal(k1Ata) === k1Before, 'M1-D3 king split pays NEW king K2 only');
  const s = distState(M1);
  ok(s.index === m1.index && s.totalPaidOut === m1.tpo && bal(vault1) === s.totalDistributed - s.totalPaidOut, 'M1-D3 state + identity match mirror');
}

console.log('=== M1-D4: fail-open — crown sentinel, seat amount 0 ===');
await xfer(M1, payerAta1, vault1, payer, 10_000n * TOK); m1.vault += 10_000n * TOK;
const e4 = m1Fold(BPS1, { crown: false, seat: false, king: true });
{
  const cb2Before = bal(cb2Ata), sbBefore = bal(seatBata1), saBefore = bal(seatAata1), k2Before = bal(k2Ata);
  const tpoBefore = distState(M1).totalPaidOut;
  await send([splitsIx(M1, vault1, CR.publicKey, crAta, splitKeys1({
    crown: state1, crownRecip: state1,               // sentinel: crown not supplied
    seat: seatAtaA, seatRecip: seatAata1,            // A's seat account now holds 0 NFTs
    kingRecip: k2Ata,
  }))], [CR], 'tag4 distribute 4 (fail-open)');
  ok(bal(cb2Ata) === cb2Before && bal(seatBata1) === sbBefore && bal(seatAata1) === saBefore,
    'M1-D4 skipped splits pay nobody (crown sentinel, seat amount 0)');
  ok(bal(k2Ata) === k2Before + e4.kingAmt, 'M1-D4 king split still pays (fail-open is per-split)');
  const s = distState(M1);
  ok(s.totalPaidOut - tpoBefore === e4.kingAmt && s.index === m1.index && s.totalDistributed === m1.td,
    'M1-D4 skipped shares folded into the index: tpo rose by the king split only; index matches remainder mirror (9,702 TOK remainder)');
  ok(bal(vault1) === s.totalDistributed - s.totalPaidOut && bal(vault1) === m1.vault, 'M1-D4 identity exact');
}

console.log('=== M1-E: wrong config hard-errors; bps sum > 10000 hard-errors; tag 1 still works ===');
await xfer(M1, payerAta1, vault1, payer, 2_000n * TOK); m1.vault += 2_000n * TOK;
{
  const s0 = distState(M1);
  const errBad = await attempt(() => send([splitsIx(M1, vault1, CR.publicKey, crAta, splitKeys1({ config: kingPda(M1), seat: seatAtaB, seatRecip: seatBata1, crownRecip: cb2Ata, kingRecip: k2Ata }))], [CR], 'tag4 wrong config'));
  ok(errBad === 'b', 'M1-E wrong Config account (king PDA passed as config) hard-errors BadConfig (custom 11)', `(got ${errBad})`);
  writeConfig1({ crown: 6000, seat: 3000, king: 2000 });
  const errSum = await attempt(() => send([splitsIx(M1, vault1, CR.publicKey, crAta, splitKeys1({ seat: seatAtaB, seatRecip: seatBata1, crownRecip: cb2Ata, kingRecip: k2Ata }))], [CR], 'tag4 bps sum 11000'));
  ok(errSum === 'c', 'M1-E crown+seat+king bps = 11,000 hard-errors SplitBpsTooLarge (custom 12)', `(got ${errSum})`);
  writeConfig1(BPS1);
  const s1 = distState(M1);
  ok(s1.index === s0.index && s1.count === s0.count && s1.totalDistributed === s0.totalDistributed && bal(vault1) === m1.vault,
    'M1-E both hard errors are atomic: state untouched, deposit still unfolded in the vault');
}
const e5 = m1Fold(null, { crown: false, seat: false, king: false });
await send([distributeIx(M1, vault1, CR.publicKey, crAta)], [CR], 'tag1 distribute after tag4 errors');
{
  const s = distState(M1);
  ok(s.index === m1.index && s.totalDistributed === m1.td && s.totalPaidOut === m1.tpo && s.count === 5n && s.totalRoutedFolded === 52_000n * TOK,
    'M1-E tag 1 folds the same state cleanly (2,000 TOK deposit; 5 folds lifetime; 52,000 routed)');
  ok(bal(vault1) === s.totalDistributed - s.totalPaidOut, 'M1-E identity exact after tag 1');
}

console.log('=== M1 finale: holders claim against the post-split index ===');
{
  const EB = m1Claim(bal(bAta), 0n);
  const vB = bal(vault1);
  await send([payoutIx(2, B.publicKey, B.publicKey, bAta, M1, vault1)], [B], 'claim B (first touch)');
  ok(vB - bal(vault1) === EB && EB > 0n, 'M1 B first-touch claim exact vs final index', `(${EB} raw)`);
  m1.vault -= EB; m1.tpo += EB;
  const EA2 = m1Claim(bal(aAta), settledA);
  const vA = bal(vault1);
  await send([payoutIx(2, A.publicKey, A.publicKey, aAta, M1, vault1)], [A], 'claim A (delta)');
  ok(vA - bal(vault1) === EA2 && EA2 > 0n, 'M1 A delta-only claim exact', `(${EA2} raw)`);
  m1.vault -= EA2; m1.tpo += EA2;
  const s = distState(M1);
  ok(bal(vault1) === m1.vault && s.totalPaidOut === m1.tpo && bal(vault1) === s.totalDistributed - s.totalPaidOut,
    'M1 finale identity: vault == td - tpo to the unit (tpo = splits + claims)');
}

// ================= MODE 0 WORLD (transfer-fee mint) =================
console.log('=== M0 setup: transfer-fee mint, distributor mode 0, splits configured ===');
const mint0Kp = Keypair.generate(); const M0 = mint0Kp.publicKey;
const state0 = distPda(M0);
const vault0 = getAssociatedTokenAddressSync(M0, state0, true, T22);
{
  const len = getMintLen([ExtensionType.TransferFeeConfig]);
  const rent = svm.minimumBalanceForRentExemption(BigInt(len));
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: M0, space: len, lamports: Number(rent), programId: T22 }),
    createInitializeTransferFeeConfigInstruction(M0, payer.publicKey, state0, 100, 10n ** 15n, T22),
    createInitializeMintInstruction(M0, DECIMALS, payer.publicKey, null, T22),
    createAssociatedTokenAccountInstruction(payer.publicKey, vault0, state0, M0, T22),
  ], [payer, mint0Kp], 'create fee mint + vault');
}
await send([initIx(M0, vault0)], [payer], 'init distributor (mode 0)');
const payerAta0 = await ataFor(M0, payer.publicKey);
const cb0 = await wallet(), kg0 = await wallet();
const cb0Ata = await ataFor(M0, cb0.publicKey), kg0Ata = await ataFor(M0, kg0.publicKey);
const seatCata0 = await ataFor(M0, seatC.publicKey);
const a2 = await wallet(), b2 = await wallet();
const a2Ata = await ataFor(M0, a2.publicKey), b2Ata = await ataFor(M0, b2.publicKey);
const crAta0 = await ataFor(M0, CR.publicKey);
await send([
  createMintToInstruction(M0, payerAta0, payer.publicKey, SUPPLY - 10_000n * TOK, [], T22),
  createMintToInstruction(M0, kg0Ata, payer.publicKey, 10_000n * TOK, [], T22),
], [payer], 'mint supply (mode 0; king holds 10,000 via MintTo, no fee)');
await xfer(M0, payerAta0, a2Ata, payer, 600_000n * TOK);
await xfer(M0, payerAta0, b2Ata, payer, 300_000n * TOK);
const BPS0 = { crown: 1000, seat: 500, king: 500 };
setAcct(configPda(M0), configBytes(M0, { crownBps: BPS0.crown, seatMint: SEAT, seatBps: BPS0.seat, kingBps: BPS0.king }), ENGINE);
await initCrown(M0, cb0.publicKey, 'init crown (mode 0 mint)');
setAcct(kingPda(M0), kingBytes(kg0Ata, kg0.publicKey, 10_000n * TOK), ENGINE);
{
  const s = distState(M0);
  ok(s.fundingMode === 0 && bal(a2Ata) === 594_000n * TOK && acctWithheld(a2Ata) === 6_000n * TOK && acctWithheld(b2Ata) === 3_000n * TOK,
    'M0 fee mint in harvest mode; withheld accrued (A 6,000 / B 3,000 TOK)');
}
const m0 = { index: 0n, vault: 0n, td: 0n, tpo: 0n, cuts: 0n, harvested: 0n, count: 0n };
function m0Fold(W, bps, valid) {
  const cut = (W * CUT_BPS) / 10_000n;
  const net = W - cut;
  const carve = (b, v) => (v ? (net * BigInt(b)) / 10_000n : 0n);
  const crownAmt = carve(bps.crown, valid.crown), seatAmt = carve(bps.seat, valid.seat), kingAmt = carve(bps.king, valid.king);
  const S = crownAmt + seatAmt + kingAmt;
  const remainder = net - S;
  const vaultAfter = m0.vault + W - cut - S;
  const delta = (remainder * SCALE) / (SUPPLY - vaultAfter);
  m0.index += delta; m0.td += net; m0.tpo += S; m0.cuts += cut; m0.harvested += W; m0.count += 1n; m0.vault = vaultAfter;
  return { cut, net, crownAmt, seatAmt, kingAmt, S, remainder, delta };
}
console.log('=== M0-D1: tag 4 fold on harvested fees — splits pay gross, fee applies ===');
const f0 = m0Fold(9_000n * TOK, BPS0, ALL);
{
  const grossIn = (ata) => {
    const b0 = bal(ata), w0 = acctWithheld(ata);
    return () => (bal(ata) - b0) + (acctWithheld(ata) - w0);
  };
  const cbIn = grossIn(cb0Ata), scIn = grossIn(seatCata0), kgIn = grossIn(kg0Ata), crIn = grossIn(crAta0);
  const cbBal0 = bal(cb0Ata);
  await send([splitsIx(M0, vault0, CR.publicKey, crAta0, {
    config: configPda(M0), crown: crownPda(M0), seat: seatAtaC, king: kingPda(M0),
    crownRecip: cb0Ata, seatRecip: seatCata0, kingRecip: kg0Ata,
  }, [a2Ata, b2Ata])], [CR], 'tag4 distribute (mode 0, sources trailing)');
  ok(f0.crownAmt === 891n * TOK && f0.seatAmt === 445_500_000n && f0.kingAmt === 445_500_000n && f0.cut === 90n * TOK,
    'M0-D1 carve math: W 9,000, cut 90, net 8,910 -> crown 891 / seat 445.5 / king 445.5 TOK');
  ok(cbIn() === f0.crownAmt && scIn() === f0.seatAmt && kgIn() === f0.kingAmt && crIn() === f0.cut,
    'M0-D1 recipients received the GROSS splits (net balance + withheld fee on each payout transfer)');
  ok(bal(cb0Ata) - cbBal0 === f0.crownAmt - f0.crownAmt / 100n, 'M0-D1 crown recipient nets amount - 1% fee exactly (fee-exact amount)');
  const s = distState(M0);
  ok(s.totalHarvested === 9_000n * TOK && s.totalDistributed === m0.td && s.totalPaidOut === m0.tpo && s.totalCuts === m0.cuts && s.count === 1n && s.index === m0.index,
    'M0-D1 state matches mirror (td = full net 8,910; tpo = splits 1,782 TOK)');
  ok(bal(vault0) === m0.vault && bal(vault0) === s.totalDistributed - s.totalPaidOut,
    'M0-D1 conservation WITH fee mint: vault == td - tpo == remainder 7,128 TOK');
}
{
  const EA = (bal(a2Ata) * m0.index) / SCALE;
  const vBefore = bal(vault0), b0 = bal(a2Ata), w0 = acctWithheld(a2Ata);
  await send([payoutIx(2, a2.publicKey, a2.publicKey, a2Ata, M0, vault0)], [a2], 'claim A (mode 0)');
  ok(vBefore - bal(vault0) === EA && (bal(a2Ata) - b0) + (acctWithheld(a2Ata) - w0) === EA,
    'M0 A claim: vault debited exactly the entitlement; A nets entitlement - fee', `(${EA} raw)`);
  m0.vault -= EA; m0.tpo += EA;
  const s = distState(M0);
  ok(bal(vault0) === s.totalDistributed - s.totalPaidOut && s.totalPaidOut === m0.tpo, 'M0 identity holds after claim');
}
{
  const s0 = distState(M0);
  await send([splitsIx(M0, vault0, CR.publicKey, crAta0, {
    config: configPda(M0), crown: crownPda(M0), seat: seatAtaC, king: kingPda(M0),
    crownRecip: cb0Ata, seatRecip: seatCata0, kingRecip: kg0Ata,
  }, [])], [CR], 'tag4 zero-fold distribute (mode 0)');
  const s1 = distState(M0);
  ok(s1.index === s0.index && s1.count === s0.count && s1.totalPaidOut === s0.totalPaidOut, 'M0 zero-fold tag 4 is a successful no-op');
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
fs.writeFileSync(path.join(DIR, 'trial-splits-result.json'), JSON.stringify({ distributor: DIST.toBase58(), engine: ENGINE.toBase58(), crown: CROWN.toBase58(), pass, fail }, null, 2));
if (fail > 0) process.exit(1);

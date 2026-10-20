// Hook Launcher CROWN BENEFICIARY (Solana) — LiteSVM trial suite.
// No token mint is ever created: the "mint" is a bare pubkey, proving Init
// works for any mint with no engine / token program present (the Crown PDA
// is pure per-mint state). All money is SOL lamports, asserted to the unit
// against hand-computed floor-math expectations.
//
// Three challenges end-to-end:
//   #1 challenger WINS (5.5 vs 2.0 SOL, quorum 5) — beneficiary flips,
//      winner claims = stake + pro-rata slash share, losers 80%, the
//      per-claimant floors leave exactly 1 lamport of slash-pool dust.
//   #2 quorum MISS (2.0 SOL total < 5) — challenge fails, challenger side
//      slashed, cooldown set; its slash pool (winning side has NO stakers)
//      stays in the vault and is part of the final residual identity.
//   #3 after cooldown, with a PendingClaims gate in between — recycled
//      (claimed) Stake PDAs re-stake, challenger wins again.
import { LiteSVM, FailedTransactionMetadata, Clock } from 'litesvm';
import {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const kp = JSON.parse(fs.readFileSync(path.join(DIR, 'crown-keypair.json'), 'utf8'));
const PROG = Keypair.fromSecretKey(Uint8Array.from(kp)).publicKey;
const SOL = BigInt(LAMPORTS_PER_SOL);
const FEE = 5_000n; // LiteSVM: 5,000 lamports per signature; every tx here has 1 signer

const svm = new LiteSVM();
svm.addProgramFromFile(PROG, path.join(DIR, 'target/deploy/crown_sol.so'));

let slot = 1n;
const T0 = 1_760_000_000;
const setTime = (ts) => { slot += 17n; svm.setClock(new Clock(slot, 0n, 0n, 0n, BigInt(ts))); };
setTime(T0);

const payer = Keypair.generate();
svm.airdrop(payer.publicKey, BigInt(500 * LAMPORTS_PER_SOL));
const actor = (sol = 60) => { const k = Keypair.generate(); svm.airdrop(k.publicKey, BigInt(sol * LAMPORTS_PER_SOL)); return k; };
const B0 = actor(), B1 = actor(), B2 = actor();      // beneficiaries (initial, candidate 1, candidate 2/3)
const TREASURY = actor();
const C = actor(), C1 = actor(), C2 = actor();      // challengers / challenger-side stakers
const R1 = actor(), R2 = actor();                   // reigning-side stakers
const CRANK = actor();                              // permissionless finalize caller

const MINT = Keypair.generate().publicKey;          // bare pubkey — no mint account exists
const crownPda = (m) => PublicKey.findProgramAddressSync([Buffer.from('crown'), m.toBuffer()], PROG)[0];
const vaultPda = (m) => PublicKey.findProgramAddressSync([Buffer.from('cvault'), m.toBuffer()], PROG)[0];
const challengePda = (m) => PublicKey.findProgramAddressSync([Buffer.from('challenge'), m.toBuffer()], PROG)[0];
const stakePda = (m, staker, side) => PublicKey.findProgramAddressSync([Buffer.from('stake'), m.toBuffer(), staker.toBuffer(), Buffer.from([side])], PROG)[0];

// ---------- tx plumbing (distributor-trial idiom) ----------
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
  catch (e) { return (e.logs || []).join('\n').match(/custom program error: 0x([0-9a-f]+)/i)?.[1] ?? ('Other:' + String(e.message).slice(-120)); }
}

const acct = (pk) => svm.getAccount(pk);
const lamports = (pk) => { const a = acct(pk); return a ? BigInt(a.lamports) : 0n; };
const data = (pk) => { const a = acct(pk); return a ? Buffer.from(a.data) : null; };
const crownState = (m) => {
  const d = data(crownPda(m));
  return {
    raw: d, tag: d[0], mint: new PublicKey(d.subarray(1, 33)),
    beneficiaryBytes: d.subarray(33, 65), beneficiary: new PublicKey(d.subarray(33, 65)),
    reignStarted: d.readBigInt64LE(65), treasury: new PublicKey(d.subarray(73, 105)),
    authority: new PublicKey(d.subarray(105, 137)),
    bond: d.readBigUInt64LE(137), quorum: d.readBigUInt64LE(145),
    windowSecs: d.readBigInt64LE(153), timelockSecs: d.readBigInt64LE(161),
    minReignSecs: d.readBigInt64LE(169), cooldownSecs: d.readBigInt64LE(177),
    slashBps: d.readUInt16LE(185), cooldownUntil: d.readBigInt64LE(187),
    counter: d.readBigUInt64LE(195), active: d[205],
    totalResolved: d.readBigUInt64LE(206), totalStakeResolved: d.readBigUInt64LE(214),
    totalSlashed: d.readBigUInt64LE(222), totalTreasury: d.readBigUInt64LE(230),
  };
};
const challengeState = (m) => {
  const d = data(challengePda(m));
  if (!d) return null;
  return {
    candidate: new PublicKey(d.subarray(33, 65)), challenger: new PublicKey(d.subarray(65, 97)),
    openedTs: d.readBigInt64LE(97), windowEnd: d.readBigInt64LE(105),
    challengerStake: d.readBigUInt64LE(113), reigningStake: d.readBigUInt64LE(121),
    state: d[129], winningSide: d[130],
    slashTotal: d.readBigUInt64LE(155), treasuryPaid: d.readBigUInt64LE(163), slashPool: d.readBigUInt64LE(171),
    id: d.readBigUInt64LE(179), stakeCount: d.readBigUInt64LE(188), claimedCount: d.readBigUInt64LE(196),
    totalClaimedPayout: d.readBigUInt64LE(204),
  };
};
const stakeState = (m, staker, side) => {
  const d = data(stakePda(m, staker, side));
  if (!d) return null;
  return { side: d[65], claimed: d[66], challengeId: d.readBigUInt64LE(67), amount: d.readBigUInt64LE(75), claimedPayout: d.readBigUInt64LE(83) };
};

// ---------- params (trial-scale: short clocks, realistic SOL amounts) ----------
const BOND = 2n * SOL, QUORUM = 5n * SOL, WINDOW = 3600n, TIMELOCK = 600n, MIN_REIGN = 1000n, COOLDOWN = 900n, SLASH_BPS = 2000;

// ---------- instruction builders ----------
const initIx = (authority, mintPk, beneficiary, treasury, withParams) => {
  let d;
  if (withParams) {
    d = Buffer.alloc(115);
    d[0] = 0;
    beneficiary.toBuffer().copy(d, 1); treasury.toBuffer().copy(d, 33);
    d.writeBigUInt64LE(BOND, 65); d.writeBigUInt64LE(QUORUM, 73);
    d.writeBigInt64LE(WINDOW, 81); d.writeBigInt64LE(TIMELOCK, 89);
    d.writeBigInt64LE(MIN_REIGN, 97); d.writeBigInt64LE(COOLDOWN, 105);
    d.writeUInt16LE(SLASH_BPS, 113);
  } else {
    d = Buffer.alloc(65);
    d[0] = 0;
    beneficiary.toBuffer().copy(d, 1); treasury.toBuffer().copy(d, 33);
  }
  return new TransactionInstruction({
    programId: PROG, data: d,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: crownPda(mintPk), isSigner: false, isWritable: true },
      { pubkey: vaultPda(mintPk), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
};
const openIx = (challenger, mintPk, candidate) => new TransactionInstruction({
  programId: PROG, data: Buffer.concat([Buffer.from([1]), candidate.toBuffer()]),
  keys: [
    { pubkey: challenger, isSigner: true, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: false },
    { pubkey: crownPda(mintPk), isSigner: false, isWritable: true },
    { pubkey: challengePda(mintPk), isSigner: false, isWritable: true },
    { pubkey: vaultPda(mintPk), isSigner: false, isWritable: true },
    { pubkey: stakePda(mintPk, challenger, 1), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
const stakeIx = (staker, mintPk, side, amount) => {
  const d = Buffer.alloc(10); d[0] = 2; d[1] = side; d.writeBigUInt64LE(amount, 2);
  return new TransactionInstruction({
    programId: PROG, data: d,
    keys: [
      { pubkey: staker, isSigner: true, isWritable: true },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: crownPda(mintPk), isSigner: false, isWritable: false },
      { pubkey: challengePda(mintPk), isSigner: false, isWritable: true },
      { pubkey: vaultPda(mintPk), isSigner: false, isWritable: true },
      { pubkey: stakePda(mintPk, staker, side), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
};
const finalizeIx = (caller, mintPk, treasury) => new TransactionInstruction({
  programId: PROG, data: Buffer.from([3]),
  keys: [
    { pubkey: caller, isSigner: true, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: false },
    { pubkey: crownPda(mintPk), isSigner: false, isWritable: true },
    { pubkey: challengePda(mintPk), isSigner: false, isWritable: true },
    { pubkey: vaultPda(mintPk), isSigner: false, isWritable: true },
    { pubkey: treasury, isSigner: false, isWritable: true },
  ],
});
const claimIx = (staker, mintPk, side) => new TransactionInstruction({
  programId: PROG, data: Buffer.from([4]),
  keys: [
    { pubkey: staker, isSigner: true, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: false },
    { pubkey: crownPda(mintPk), isSigner: false, isWritable: false },
    { pubkey: challengePda(mintPk), isSigner: false, isWritable: true },
    { pubkey: vaultPda(mintPk), isSigner: false, isWritable: true },
    { pubkey: stakePda(mintPk, staker, side), isSigner: false, isWritable: true },
  ],
});
// Self-claim assertion: the staker signs (pays FEE), so recipient delta is
// payout - FEE while the VAULT delta is exactly the payout.
async function claimExact(stakerKp, mintPk, side, payout, label) {
  const vBefore = lamports(vaultPda(mintPk)), sBefore = lamports(stakerKp.publicKey);
  await send([claimIx(stakerKp.publicKey, mintPk, side)], [stakerKp], label);
  ok(vBefore - lamports(vaultPda(mintPk)) === payout, `${label}: vault debited exactly the payout`, `(${payout})`);
  ok(lamports(stakerKp.publicKey) - sBefore === payout - FEE, `${label}: staker received payout net of the 5,000 tx fee`);
}

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
console.log('crown-sol:', PROG.toBase58());
const VAULT = vaultPda(MINT);
const vaultRent = svm.minimumBalanceForRentExemption(0n);

// ================= INIT =================
console.log('=== S: init with explicit trial params ===');
await send([initIx(payer.publicKey, MINT, B0.publicKey, TREASURY.publicKey, true)], [payer], 'init crown');
{
  const s = crownState(MINT);
  ok(s.tag === 1 && s.mint.equals(MINT), 'S crown tag + mint at [0]/[1..33]');
  ok(s.beneficiary.equals(B0.publicKey) && Buffer.from(s.beneficiaryBytes).equals(B0.publicKey.toBuffer()), 'S beneficiary at [33..65] is B0 (Distributor offsets)');
  ok(s.reignStarted === BigInt(T0), 'S reign_started_ts at [65..73] = init clock', `(${s.reignStarted})`);
  ok(s.treasury.equals(TREASURY.publicKey) && s.authority.equals(payer.publicKey), 'S treasury + authority stored');
  ok(s.bond === BOND && s.quorum === QUORUM && s.windowSecs === WINDOW && s.timelockSecs === TIMELOCK && s.minReignSecs === MIN_REIGN && s.cooldownSecs === COOLDOWN && s.slashBps === SLASH_BPS, 'S all init params stored verbatim');
  ok(s.active === 0 && s.counter === 0n && s.cooldownUntil === 0n, 'S no live challenge, no cooldown');
  const v = acct(VAULT);
  ok(v && v.owner.equals(PROG) && BigInt(v.lamports) === vaultRent, 'S vault PDA created, program-owned, rent-only balance', `(${vaultRent})`);
}
{
  const err = await attempt(() => send([initIx(payer.publicKey, MINT, B0.publicKey, TREASURY.publicKey, true)], [payer], 'double init'));
  ok(err === '1', 'S double-init rejected (AlreadyInit, custom 1)', `(${err})`);
}

// ================= CHALLENGE 1 — challenger wins =================
console.log('=== T1: open blocked during min_reign, then opens with the bond ===');
{
  const err = await attempt(() => send([openIx(C.publicKey, MINT, B1.publicKey)], [C], 'open too early'));
  ok(err === '4', 'T1 open during min_reign rejected (MinReign, custom 4)', `(${err})`);
}
const T_OPEN1 = T0 + 1000;
setTime(T_OPEN1);
await send([openIx(C.publicKey, MINT, B1.publicKey)], [C], 'open challenge 1');
{
  const ch = challengeState(MINT), s = crownState(MINT);
  ok(ch.id === 1n && ch.state === 1 && ch.candidate.equals(B1.publicKey) && ch.challenger.equals(C.publicKey), 'T1 challenge 1 open: candidate B1, challenger C');
  ok(ch.challengerStake === BOND && ch.reigningStake === 0n && ch.openedTs === BigInt(T_OPEN1) && ch.windowEnd === BigInt(T_OPEN1) + WINDOW, 'T1 bond is the initial challenger stake; window = open + 3600s');
  ok(lamports(VAULT) === vaultRent + BOND, 'T1 vault holds exactly the bond');
  ok(s.active === 1 && s.counter === 1n, 'T1 crown marked live, counter 1');
  const st = stakeState(MINT, C.publicKey, 1);
  ok(st && st.amount === BOND && st.challengeId === 1n && st.claimed === 0, 'T1 challenger bond stake record created (side 1)');
}
{
  const err = await attempt(() => send([openIx(C2.publicKey, MINT, B2.publicKey)], [C2], 'open while live'));
  ok(err === '3', 'T1 second open while one is live rejected (ChallengeLive, custom 3)', `(${err})`);
}

console.log('=== T2: stake-vote both sides ===');
await send([stakeIx(R1.publicKey, MINT, 0, 1_500_000_000n)], [R1], 'R1 stakes reigning 1.5 SOL');
await send([stakeIx(R2.publicKey, MINT, 0, 500_000_000n)], [R2], 'R2 stakes reigning 0.5 SOL');
await send([stakeIx(C1.publicKey, MINT, 1, 2_500_000_000n)], [C1], 'C1 stakes challenger 2.5 SOL');
await send([stakeIx(C.publicKey, MINT, 1, 1n * SOL)], [C], 'C tops up challenger 1 SOL');
{
  const ch = challengeState(MINT);
  ok(ch.challengerStake === 5_500_000_000n && ch.reigningStake === 2_000_000_000n, 'T2 side totals exact: challenger 5.5 SOL (bond inside), reigning 2.0 SOL');
  ok(ch.stakeCount === 4n, 'T2 four distinct stake records');
  ok(stakeState(MINT, C.publicKey, 1).amount === 3n * SOL, 'T2 C\'s record accumulated bond + top-up = 3 SOL');
  ok(lamports(VAULT) === vaultRent + 7_500_000_000n, 'T2 vault holds all 7.5 SOL of stake');
}

console.log('=== T3: finalize timing guards ===');
setTime(T_OPEN1 + 3600 + 1); // 1s past window_end, inside the timelock
{
  const err = await attempt(() => send([stakeIx(R2.publicKey, MINT, 0, 100_000_000n)], [R2], 'stake after window'));
  ok(err === '7', 'T3 stake after window_end rejected (WindowClosed, custom 7)', `(${err})`);
  const err2 = await attempt(() => send([finalizeIx(CRANK.publicKey, MINT, TREASURY.publicKey)], [CRANK], 'finalize early'));
  ok(err2 === '8', 'T3 finalize before window+timelock rejected (TooEarlyFinalize, custom 8)', `(${err2})`);
}
const T_FIN1 = T_OPEN1 + 3600 + 600;
setTime(T_FIN1);

console.log('=== T4: finalize 1 — challenger wins, beneficiary flips, treasury paid ===');
// Mirror: losing = reigning 2.0 SOL; slash 20% = 400,000,000; treasury half
// 200,000,000; winners' pool 200,000,000 over winning_total 5.5 SOL.
{
  const tBefore = lamports(TREASURY.publicKey);
  await send([finalizeIx(CRANK.publicKey, MINT, TREASURY.publicKey)], [CRANK], 'finalize 1 (permissionless crank)');
  ok(lamports(TREASURY.publicKey) - tBefore === 200_000_000n, 'T4 treasury received exactly half the slash at finalize', '(200,000,000)');
  const s = crownState(MINT);
  ok(s.beneficiary.equals(B1.publicKey) && Buffer.from(s.beneficiaryBytes).equals(B1.publicKey.toBuffer()), 'T4 beneficiary bytes at [33..65] flipped to B1');
  ok(s.reignStarted === BigInt(T_FIN1), 'T4 reign_started reset to the finalize time');
  ok(s.active === 0 && s.totalResolved === 1n && s.totalStakeResolved === 7_500_000_000n && s.totalSlashed === 400_000_000n && s.totalTreasury === 200_000_000n, 'T4 crown lifetime counters exact');
  const ch = challengeState(MINT);
  ok(ch.state === 2 && ch.winningSide === 1 && ch.slashTotal === 400_000_000n && ch.treasuryPaid === 200_000_000n && ch.slashPool === 200_000_000n, 'T4 challenge outcome snapshot exact (state won, pool reserved)');
  ok(lamports(VAULT) === vaultRent + 7_300_000_000n, 'T4 vault = stakes - treasury half-slash');
}

console.log('=== T5: claims — winners full + slash share, losers 80%, 1 lamport of floor dust ===');
// C:  3.0 SOL + floor(3.0e9 * 200e6 / 5.5e9)=109,090,909 -> 3,109,090,909
// C1: 2.5 SOL + floor(2.5e9 * 200e6 / 5.5e9)= 90,909,090 -> 2,590,909,090
// R1: 80% of 1.5 SOL = 1,200,000,000 ; R2: 80% of 0.5 SOL = 400,000,000
await claimExact(C, MINT, 1, 3_109_090_909n, 'T5 C (winner, bond+topup+share)');
await claimExact(C1, MINT, 1, 2_590_909_090n, 'T5 C1 (winner)');
await claimExact(R1, MINT, 0, 1_200_000_000n, 'T5 R1 (loser 80%)');
await claimExact(R2, MINT, 0, 400_000_000n, 'T5 R2 (loser 80%)');
{
  ok(lamports(VAULT) === vaultRent + 1n, 'T5 vault residual is exactly 1 lamport (slash-share floor dust)', `(${lamports(VAULT) - vaultRent})`);
  const ch = challengeState(MINT);
  ok(ch.claimedCount === 4n && ch.totalClaimedPayout === 7_299_999_999n, 'T5 claimed counters exact');
  const st = stakeState(MINT, C.publicKey, 1);
  ok(st.claimed === 1 && st.claimedPayout === 3_109_090_909n, 'T5 C stake record marked claimed with its payout');
  const err = await attempt(() => send([claimIx(C.publicKey, MINT, 1)], [C], 'double claim'));
  ok(err === '9', 'T5 double-claim rejected cleanly (AlreadyClaimed, custom 9), pays 0', `(${err})`);
  ok(lamports(VAULT) === vaultRent + 1n, 'T5 vault unchanged by the double-claim attempt');
}

// ================= CHALLENGE 2 — quorum miss =================
console.log('=== T6: challenge 2 — quorum miss fails it and slashes the challenger ===');
{
  const err = await attempt(() => send([openIx(C2.publicKey, MINT, B2.publicKey)], [C2], 'open during new min_reign'));
  ok(err === '4', 'T6 open inside the NEW reign\'s min_reign rejected (custom 4)', `(${err})`);
}
const T_OPEN2 = T_FIN1 + 1000;
setTime(T_OPEN2);
await send([openIx(C2.publicKey, MINT, B2.publicKey)], [C2], 'open challenge 2');
ok(challengeState(MINT).challengerStake === BOND && challengeState(MINT).id === 2n, 'T6 challenge 2 open with bond only (2 SOL total < 5 SOL quorum)');
const T_FIN2 = T_OPEN2 + 3600 + 600;
setTime(T_FIN2);
// Mirror: fail; losing = challenger 2.0 SOL; slash 400,000,000; treasury
// 200,000,000; pool 200,000,000 reserved for reigning stakers — there are
// NONE, so the pool remains in the vault (asserted in the final residual).
{
  const tBefore = lamports(TREASURY.publicKey);
  await send([finalizeIx(CRANK.publicKey, MINT, TREASURY.publicKey)], [CRANK], 'finalize 2');
  ok(lamports(TREASURY.publicKey) - tBefore === 200_000_000n, 'T6 treasury received exactly half the challenger-side slash');
  const s = crownState(MINT);
  ok(s.beneficiary.equals(B1.publicKey) && s.reignStarted === BigInt(T_FIN1), 'T6 beneficiary + reign unchanged on a failed challenge');
  ok(s.cooldownUntil === BigInt(T_FIN2) + COOLDOWN, 'T6 cooldown_until = finalize + 900s stored in the crown');
  const ch = challengeState(MINT);
  ok(ch.state === 3 && ch.winningSide === 0 && ch.slashPool === 200_000_000n, 'T6 outcome snapshot: failed, reigning side "won", pool reserved');
}

console.log('=== T7: cooldown + pending-claims gates before challenge 3 ===');
setTime(T_FIN2 + 450);
{
  const err = await attempt(() => send([openIx(R1.publicKey, MINT, B2.publicKey)], [R1], 'open during cooldown'));
  ok(err === '5', 'T7 open during failed-challenge cooldown rejected (Cooldown, custom 5)', `(${err})`);
}
setTime(T_FIN2 + 900); // cooldown over — but C2 has not claimed yet
{
  const err = await attempt(() => send([openIx(R1.publicKey, MINT, B2.publicKey)], [R1], 'open with pending claims'));
  ok(err === 'e', 'T7 open blocked while challenge 2 stakes are unclaimed (PendingClaims, custom 14)', `(${err})`);
}
await claimExact(C2, MINT, 1, 1_600_000_000n, 'T7 C2 (loser of quorum-miss: 80% of bond)');

// ================= CHALLENGE 3 — wins again, recycled stake records =================
console.log('=== T8: challenge 3 — recycled records, bad-side + bad-treasury guards, flip to B2 ===');
const T_OPEN3 = T_FIN2 + 900;
await send([openIx(R1.publicKey, MINT, B2.publicKey)], [R1], 'open challenge 3 (R1 challenges)');
await send([stakeIx(C.publicKey, MINT, 1, 4n * SOL)], [C], 'C re-stakes challenger 4 SOL (recycled claimed record)');
await send([stakeIx(B0.publicKey, MINT, 0, 3n * SOL)], [B0], 'B0 stakes reigning 3 SOL');
{
  const ch = challengeState(MINT);
  ok(ch.id === 3n && ch.challengerStake === 6n * SOL && ch.reigningStake === 3n * SOL, 'T8 totals: challenger 6 SOL (bond 2 + C 4), reigning 3 SOL');
  ok(stakeState(MINT, C.publicKey, 1).amount === 4n * SOL && stakeState(MINT, C.publicKey, 1).challengeId === 3n, 'T8 C\'s recycled record carries ONLY the new challenge\'s stake');
  const err = await attempt(() => send([stakeIx(C1.publicKey, MINT, 2, 100_000_000n)], [C1], 'stake bad side'));
  ok(err === 'd', 'T8 stake with side 2 rejected (BadSide, custom 13)', `(${err})`);
}
const T_FIN3 = T_OPEN3 + 3600 + 600;
setTime(T_FIN3);
{
  const err = await attempt(() => send([finalizeIx(CRANK.publicKey, MINT, B0.publicKey)], [CRANK], 'finalize with wrong treasury'));
  ok(err === 'f', 'T8 finalize naming the wrong treasury rejected (BadTreasury, custom 15)', `(${err})`);
}
// Mirror: win; losing = reigning 3.0 SOL; slash 600,000,000; treasury
// 300,000,000; pool 300,000,000 over winning_total 6.0 SOL.
{
  const tBefore = lamports(TREASURY.publicKey);
  await send([finalizeIx(CRANK.publicKey, MINT, TREASURY.publicKey)], [CRANK], 'finalize 3');
  ok(lamports(TREASURY.publicKey) - tBefore === 300_000_000n, 'T8 treasury received exactly half the 600M slash');
  const s = crownState(MINT);
  ok(s.beneficiary.equals(B2.publicKey) && Buffer.from(s.beneficiaryBytes).equals(B2.publicKey.toBuffer()) && s.reignStarted === BigInt(T_FIN3), 'T8 beneficiary flipped to B2 at [33..65], reign reset');
  ok(s.totalResolved === 3n && s.totalStakeResolved === 7_500_000_000n + 2_000_000_000n + 9_000_000_000n && s.totalSlashed === 1_400_000_000n && s.totalTreasury === 700_000_000n, 'T8 lifetime counters across all three challenges exact');
}
// R1: 2 SOL + floor(2e9*300e6/6e9)=100,000,000 -> 2,100,000,000
// C:  4 SOL + 200,000,000 -> 4,200,000,000 ; B0: 80% of 3 SOL = 2,400,000,000
await claimExact(R1, MINT, 1, 2_100_000_000n, 'T8 R1 (winner-challenger)');
await claimExact(C, MINT, 1, 4_200_000_000n, 'T8 C (winner, recycled record)');
await claimExact(B0, MINT, 0, 2_400_000_000n, 'T8 B0 (loser 80%)');
{
  // Residual identity: 1 lamport (ch1 floor dust) + 200,000,000 (ch2 slash
  // pool, no winning stakers to claim it) + 0 (ch3 pays out exactly).
  ok(lamports(VAULT) === vaultRent + 200_000_001n, 'T8 final vault residual = 1 lamport dust + the stakerless ch2 slash pool, to the lamport', `(${lamports(VAULT) - vaultRent})`);
}

// ================= DEFAULTS — second crown, no param block =================
console.log('=== T9: init with defaults stores the production constants ===');
const MINT2 = Keypair.generate().publicKey;
await send([initIx(payer.publicKey, MINT2, B0.publicKey, TREASURY.publicKey, false)], [payer], 'init crown 2 (defaults)');
{
  const s = crownState(MINT2);
  ok(s.bond === 100_000_000n && s.quorum === 500_000_000n, 'T9 default bond 0.1 SOL / quorum 0.5 SOL (suggested production values)');
  ok(s.windowSecs === 259_200n && s.timelockSecs === 86_400n && s.minReignSecs === 604_800n && s.cooldownSecs === 259_200n && s.slashBps === 2000, 'T9 default clocks 72h/24h/7d/3d + slash 2000 bps (EVM Crown parameters)');
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
fs.writeFileSync(path.join(DIR, 'trial-result.json'), JSON.stringify({ program: PROG.toBase58(), pass, fail }, null, 2));
if (fail > 0) process.exit(1);

// Hook Launcher DISTRIBUTOR — LiteSVM trial suite.
// Real Token-2022 mint WITH the Transfer Fee extension; withheld fees accrue
// on real transfers, the distributor crank harvests/withdraws/folds them
// into its index, and holders claim/settle pro-rata. Every number is
// asserted against a BigInt mirror of the program's integer math.
import { LiteSVM, FailedTransactionMetadata } from 'litesvm';
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
const kp = JSON.parse(fs.readFileSync(path.join(DIR, 'distributor-keypair.json'), 'utf8'));
const DIST = Keypair.fromSecretKey(Uint8Array.from(kp)).publicKey;
const T22 = TOKEN_2022_PROGRAM_ID;
const DECIMALS = 6;
const TOK = 10n ** 6n;                 // raw units per token
const SUPPLY = 1_000_000n * TOK;       // 1,000,000 tokens
const SCALE = 10n ** 12n;
const CUT_BPS = 100n;                  // 1% crank cut

const svm = new LiteSVM();
svm.addProgramFromFile(DIST, path.join(DIR, 'target/deploy/distributor.so'));

const payer = Keypair.generate();
svm.airdrop(payer.publicKey, BigInt(300 * LAMPORTS_PER_SOL));

const distPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('dist'), mint.toBuffer()], DIST)[0];
const claimPda = (mint, holder) => PublicKey.findProgramAddressSync([Buffer.from('claim'), mint.toBuffer(), holder.toBuffer()], DIST)[0];

// ---------- tx plumbing (engine-trial idiom) ----------
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

const acctData = (pk) => { const a = svm.getAccount(pk); return a ? Buffer.from(a.data) : null; };
const bal = (ata) => { const d = acctData(ata); return d ? d.readBigUInt64LE(64) : 0n; };

// ---------- TLV oracles (independent of the program's parser) ----------
// Mint: extension mints are padded to the 165-byte account base + type byte,
// so TLVs start at 166 (verified byte-by-byte in LiteSVM). TransferFeeConfig
// type=1, data 108 bytes of OptionalNonZeroPubkey fields: config auth @0,
// withdraw auth @32, withheld u64 @64.
function mintWithheld(mintPk) {
  const d = acctData(mintPk);
  let off = 166;
  while (off + 4 <= d.length) {
    const ty = d.readUInt16LE(off), len = d.readUInt16LE(off + 2);
    if (ty === 1) return d.readBigUInt64LE(off + 4 + 64);
    off += 4 + len;
  }
  return 0n;
}
// Token account: base 165 + type byte; TLVs from 166. TransferFeeAmount
// type=2: withheld u64 @0 of the extension data.
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
const distState = (mintPk) => {
  const d = acctData(distPda(mintPk));
  return {
    tag: d[0], mint: new PublicKey(d.subarray(1, 33)), vault: new PublicKey(d.subarray(33, 65)),
    index: d.readBigUInt64LE(97) | (d.readBigUInt64LE(105) << 64n),
    totalHarvested: d.readBigUInt64LE(113), totalDistributed: d.readBigUInt64LE(121),
    totalCuts: d.readBigUInt64LE(129), cutBps: d.readUInt16LE(137), count: d.readBigUInt64LE(149),
    fundingMode: d[140], totalPaidOut: d.readBigUInt64LE(157), totalRoutedFolded: d.readBigUInt64LE(165),
  };
};
const claimState = (mintPk, holder) => {
  const d = acctData(claimPda(mintPk, holder));
  if (!d) return null;
  return {
    tag: d[0], settled: d.readBigUInt64LE(65) | (d.readBigUInt64LE(73) << 64n),
    totalClaimed: d.readBigUInt64LE(81),
  };
};

// ---------- mirror of the program's math ----------
const mirror = { index: 0n, vault: 0n, totalHarvested: 0n, totalDistributed: 0n, totalCuts: 0n, count: 0n };
function mirrorDistribute(W) {
  const cut = (W * CUT_BPS) / 10_000n;
  const net = W - cut;
  const eligible = SUPPLY - (mirror.vault + net);
  const delta = (net * SCALE) / eligible;
  mirror.index += delta;
  mirror.vault += net;
  mirror.totalHarvested += W;
  mirror.totalDistributed += net;
  mirror.totalCuts += cut;
  mirror.count += 1n;
  return { cut, net, delta };
}
const entitlement = (balance, settled) => (balance * (mirror.index - settled)) / SCALE;

// ---------- instruction builders ----------
const initIx = (mintPk, vaultAta) => new TransactionInstruction({
  programId: DIST, data: Buffer.from([0, 100, 0]), // tag 0, cut 100 bps
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: false },
    { pubkey: vaultAta, isSigner: false, isWritable: false },
    { pubkey: distPda(mintPk), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
const distributeIx = (mintPk, vaultAta, cranker, crankerAta, sources) => new TransactionInstruction({
  programId: DIST, data: Buffer.from([1]),
  keys: [
    { pubkey: cranker, isSigner: true, isWritable: false },
    { pubkey: mintPk, isSigner: false, isWritable: true },
    { pubkey: distPda(mintPk), isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true },
    { pubkey: crankerAta, isSigner: false, isWritable: true },
    { pubkey: T22, isSigner: false, isWritable: false },
    ...sources.map((s) => ({ pubkey: s, isSigner: false, isWritable: true })),
  ],
});
const payoutIx = (tag, payerKp, holder, holderAta, mintPk, vaultAta) => new TransactionInstruction({
  programId: DIST, data: Buffer.from([tag]),
  keys: [
    { pubkey: payerKp, isSigner: true, isWritable: true },
    { pubkey: holder, isSigner: false, isWritable: false },
    { pubkey: holderAta, isSigner: false, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: false },
    { pubkey: distPda(mintPk), isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true },
    { pubkey: claimPda(mintPk, holder), isSigner: false, isWritable: true },
    { pubkey: T22, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});

async function actor(mintPk, sol = 5) {
  const k = Keypair.generate();
  svm.airdrop(k.publicKey, BigInt(sol * LAMPORTS_PER_SOL));
  const ata = getAssociatedTokenAddressSync(mintPk, k.publicKey, false, T22);
  await send([createAssociatedTokenAccountInstruction(payer.publicKey, ata, k.publicKey, mintPk, T22)], [payer], 'actor ATA');
  return { kp: k, ata };
}
const xfer = (mintPk, fromAta, toAta, ownerKp, amount) =>
  send([createTransferCheckedInstruction(fromAta, mintPk, toAta, ownerKp.publicKey, amount, DECIMALS, [], T22)], [ownerKp], 'transfer');

// ================= SETUP =================
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
console.log('distributor:', DIST.toBase58());

const mint = Keypair.generate();
const statePk = distPda(mint.publicKey);
const vaultAta = getAssociatedTokenAddressSync(mint.publicKey, statePk, true, T22);
{
  const len = getMintLen([ExtensionType.TransferFeeConfig]);
  const rent = svm.minimumBalanceForRentExemption(BigInt(len));
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: Number(rent), programId: T22 }),
    createInitializeTransferFeeConfigInstruction(mint.publicKey, payer.publicKey, statePk, 100, 10n ** 15n, T22),
    createInitializeMintInstruction(mint.publicKey, DECIMALS, payer.publicKey, null, T22),
    createAssociatedTokenAccountInstruction(payer.publicKey, vaultAta, statePk, mint.publicKey, T22),
  ], [payer, mint], 'create fee mint + vault');
}
const MINT = mint.publicKey;
await send([initIx(MINT, vaultAta)], [payer], 'init distributor');
{
  const s = distState(MINT);
  ok(s.tag === 1 && s.mint.equals(MINT) && s.vault.equals(vaultAta) && s.cutBps === 100 && s.index === 0n, 'S state initialized (mint, vault, cut 100bps, index 0)');
}
const payerAta = getAssociatedTokenAddressSync(MINT, payer.publicKey, false, T22);
await send([
  createAssociatedTokenAccountInstruction(payer.publicKey, payerAta, payer.publicKey, MINT, T22),
  createMintToInstruction(MINT, payerAta, payer.publicKey, SUPPLY, [], T22),
], [payer], 'mint supply');
ok(bal(payerAta) === SUPPLY, 'S payer holds full supply (MintTo pays no fee)');

const A = await actor(MINT), B = await actor(MINT), D = await actor(MINT), E = await actor(MINT), F = await actor(MINT);

console.log('=== T1: funding transfers accrue withheld fees (oracle reads) ===');
await xfer(MINT, payerAta, A.ata, payer, 600_000n * TOK);
await xfer(MINT, payerAta, B.ata, payer, 300_000n * TOK);
ok(bal(A.ata) === 594_000n * TOK && acctWithheld(A.ata) === 6_000n * TOK, 'T1 A: 594k balance, 6k withheld (1%)');
ok(bal(B.ata) === 297_000n * TOK && acctWithheld(B.ata) === 3_000n * TOK, 'T1 B: 297k balance, 3k withheld');
ok(mintWithheld(MINT) === 0n, 'T1 nothing in the mint yet');

console.log('=== T2: distribute #1 — harvest, cut, index (cranker E) ===');
const exp1 = mirrorDistribute(9_000n * TOK);
await send([distributeIx(MINT, vaultAta, E.kp.publicKey, E.ata, [A.ata, B.ata])], [E.kp], 'distribute 1');
{
  const s = distState(MINT);
  ok(s.index === mirror.index && s.totalHarvested === 9_000n * TOK && s.totalDistributed === exp1.net && s.totalCuts === exp1.cut && s.count === 1n,
    'T2 state matches mirror exactly', `(index ${s.index}, net ${exp1.net}, cut ${exp1.cut})`);
  ok(bal(vaultAta) === mirror.vault && mintWithheld(MINT) === 0n, 'T2 vault holds the net; mint withheld drained');
  ok(acctWithheld(A.ata) === 0n && acctWithheld(B.ata) === 0n, 'T2 sources harvested clean');
  ok(bal(E.ata) === 89_100_000n && acctWithheld(E.ata) === 900_000n, 'T2 cranker received the 90-token cut gross (89.1 net + 0.9 withheld by the fee on the cut transfer)');
}

console.log('=== T3: A claims pro-rata; double-claim pays 0 ===');
const EA = entitlement(bal(A.ata), 0n);
{
  const vaultBefore = bal(vaultAta), aBalBefore = bal(A.ata), aWhBefore = acctWithheld(A.ata);
  await send([payoutIx(2, A.kp.publicKey, A.kp.publicKey, A.ata, MINT, vaultAta)], [A.kp], 'claim A');
  ok(vaultBefore - bal(vaultAta) === EA, 'T3 vault debited exactly A\'s entitlement', `(${EA} raw)`);
  ok((bal(A.ata) - aBalBefore) + (acctWithheld(A.ata) - aWhBefore) === EA, 'T3 A received entitlement (net + fee withheld on payout)');
  const cs = claimState(MINT, A.kp.publicKey);
  ok(cs && cs.settled === mirror.index && cs.totalClaimed === EA, 'T3 A claim record: settled = index, total_claimed = entitlement');
  mirror.vault -= EA;
}
{
  const v = bal(vaultAta), b = bal(A.ata);
  await send([payoutIx(2, A.kp.publicKey, A.kp.publicKey, A.ata, MINT, vaultAta)], [A.kp], 'double claim A');
  ok(bal(vaultAta) === v && bal(A.ata) === b, 'T3 double-claim pays 0, nothing moves');
}

console.log('=== T4: B settles permissionlessly (cranker E triggers B\'s payout) ===');
const EB = entitlement(bal(B.ata), 0n);
{
  const vaultBefore = bal(vaultAta);
  await send([payoutIx(3, E.kp.publicKey, B.kp.publicKey, B.ata, MINT, vaultAta)], [E.kp], 'settle B');
  ok(vaultBefore - bal(vaultAta) === EB, 'T4 settle paid B exactly its entitlement', `(${EB} raw)`);
  const cs = claimState(MINT, B.kp.publicKey);
  ok(cs && cs.settled === mirror.index && cs.totalClaimed === EB, 'T4 B claim record written by settle');
  mirror.vault -= EB;
}

console.log('=== T5: distribute #2 — A cranks, A takes the cut; A claims delta-only ===');
await xfer(MINT, payerAta, D.ata, payer, 50_000n * TOK);
ok(acctWithheld(D.ata) === 500n * TOK, 'T5 D accrued 500 tokens of fees');
const idx1 = mirror.index;
const exp2 = mirrorDistribute(500n * TOK);
{
  const aBalBefore = bal(A.ata);
  await send([distributeIx(MINT, vaultAta, A.kp.publicKey, A.ata, [D.ata])], [A.kp], 'distribute 2');
  const s = distState(MINT);
  ok(s.index === mirror.index && s.count === 2n && s.totalCuts === mirror.totalCuts, 'T5 state matches mirror after distribute #2');
  ok(bal(A.ata) - aBalBefore === exp2.cut - exp2.cut / 100n, 'T5 A received its 5-token cut net of the 1% fee on the cut transfer');
  ok(bal(vaultAta) === mirror.vault, 'T5 vault matches mirror');
}
{
  const aBalNow = bal(A.ata);
  const deltaOnly = (aBalNow * (mirror.index - idx1)) / SCALE;
  const fullHistory = (aBalNow * mirror.index) / SCALE;
  const vaultBefore = bal(vaultAta);
  await send([payoutIx(2, A.kp.publicKey, A.kp.publicKey, A.ata, MINT, vaultAta)], [A.kp], 'claim A #2');
  ok(vaultBefore - bal(vaultAta) === deltaOnly, 'T5 A\'s second claim pays the delta only', `(${deltaOnly} raw)`);
  ok(deltaOnly < fullHistory, 'T5 delta-only is strictly less than full-history on the same balance');
  mirror.vault -= deltaOnly;
}

console.log('=== T6: zero-harvest distribute is a successful no-op ===');
{
  const s0 = distState(MINT);
  await send([distributeIx(MINT, vaultAta, E.kp.publicKey, E.ata, [])], [E.kp], 'distribute empty');
  const s1 = distState(MINT);
  ok(s1.index === s0.index && s1.count === s0.count && s1.totalCuts === s0.totalCuts, 'T6 index, count, cuts unchanged');
}

console.log('=== T7: odd-amount dust — withheld read from chain, math still exact ===');
await xfer(MINT, payerAta, D.ata, payer, 1_000_001n);
const oddWithheld = acctWithheld(D.ata);
ok(oddWithheld === 10_000n || oddWithheld === 10_001n, 'T7 odd transfer withheld ~1% (oracle read)', `(${oddWithheld})`);
const exp3 = mirrorDistribute(oddWithheld);
await send([distributeIx(MINT, vaultAta, E.kp.publicKey, E.ata, [D.ata])], [E.kp], 'distribute 3 (dust)');
{
  const s = distState(MINT);
  ok(s.index === mirror.index && s.totalHarvested === mirror.totalHarvested && s.totalCuts === mirror.totalCuts,
    'T7 dust distribute matches mirror to the unit', `(W ${oddWithheld}, cut ${exp3.cut}, net ${exp3.net})`);
  ok(bal(vaultAta) === mirror.vault, 'T7 vault matches mirror');
}

console.log('=== T8: first-touch rule — zero-balance settle starts at current index ===');
const idxBeforeF = mirror.index;
await send([payoutIx(3, E.kp.publicKey, F.kp.publicKey, F.ata, MINT, vaultAta)], [E.kp], 'settle F (balance 0)');
{
  const cs = claimState(MINT, F.kp.publicKey);
  ok(cs && cs.settled === idxBeforeF && cs.totalClaimed === 0n, 'T8 F record created at settled = current index, no payout');
}
await xfer(MINT, payerAta, F.ata, payer, 10_000n * TOK); // F now holds 9,900; 100 withheld in F
const exp4 = mirrorDistribute(100n * TOK);
await send([distributeIx(MINT, vaultAta, E.kp.publicKey, E.ata, [F.ata])], [E.kp], 'distribute 4');
const EF = entitlement(bal(F.ata), idxBeforeF);
{
  const vaultBefore = bal(vaultAta);
  await send([payoutIx(2, F.kp.publicKey, F.kp.publicKey, F.ata, MINT, vaultAta)], [F.kp], 'claim F');
  ok(vaultBefore - bal(vaultAta) === EF && EF > 0n, 'T8 F earns only post-settle distributions', `(${EF} raw)`);
  mirror.vault -= EF;
}

console.log('=== T9: wrong-signer claim fails; payer (full-history holder) claims ===');
{
  const err = await attempt(() => send([payoutIx(2, E.kp.publicKey, A.kp.publicKey, A.ata, MINT, vaultAta)], [E.kp], 'claim A signed by E'));
  ok(err !== null, 'T9 claim for A signed by E is rejected');
}
const EP = entitlement(bal(payerAta), 0n);
{
  const vaultBefore = bal(vaultAta);
  await send([payoutIx(2, payer.publicKey, payer.publicKey, payerAta, MINT, vaultAta)], [payer], 'claim payer');
  ok(vaultBefore - bal(vaultAta) === EP, 'T9 payer claimed its full-history entitlement', `(${EP} raw)`);
  mirror.vault -= EP;
}

console.log('=== T10: claim-everything finale — residual is stranded accrual + spread ===');
{
  // Every remaining holder collects their full current entitlement (formula
  // mirrored from live balances + chain-read settled_index). After this,
  // nothing claimable remains: the vault residual must be exactly the
  // model's stranded accrual (see below) plus bounded spread/floor effects.
  const finale = async (tag, payer, holder, ata, label) => {
    const cs = claimState(MINT, holder);
    const settled = cs ? cs.settled : 0n;
    const exp = (bal(ata) * (mirror.index - settled)) / SCALE;
    const vaultBefore = bal(vaultAta);
    await send([payoutIx(tag, payer.publicKey, holder, ata, MINT, vaultAta)], [payer], label);
    ok(vaultBefore - bal(vaultAta) === exp, `T10 ${label} pays the exact formula amount`, `(${exp} raw)`);
    mirror.vault -= exp;
  };
  await finale(2, D.kp, D.kp.publicKey, D.ata, 'D claims (first touch, settled 0)');
  await finale(2, E.kp, E.kp.publicKey, E.ata, 'E claims (first touch, settled 0)');
  await finale(3, E.kp, A.kp.publicKey, A.ata, 'A settles its post-claim-#2 accrual');
  await finale(3, E.kp, B.kp.publicKey, B.ata, 'B settles its post-settle accrual');

  const v = bal(vaultAta);
  ok(v === mirror.vault, 'T10 vault balance equals mirrored residual to the unit', `(${v} raw)`);
  // Stranded accrual, computed exactly from the trial's own unsettled sends:
  // (a) payer -> F 10,000 TOK after F's settle pinned F at idxBeforeF: the
  //     accrual those tokens carried on the payer's record does not travel
  //     with them (index-model property; integrators settle BEFORE sending).
  // (b) the 500-TOK fee on payer -> D: withheld in transit, accrues to no
  //     balance at idx1.
  const stranded = (10_000n * TOK * idxBeforeF) / SCALE + (500n * TOK * idx1) / SCALE;
  const spread = v - stranded;
  ok(v >= stranded && spread < 6_000_000n, 'T10 residual = stranded accrual on unsettled transfers + bounded eligible-spread/floor remainder',
    `(residual ${v}, stranded ${stranded}, remainder ${spread} raw)`);
  const s = distState(MINT);
  ok(s.totalHarvested === mirror.totalHarvested && s.totalDistributed === mirror.totalDistributed && s.totalCuts === mirror.totalCuts && s.count === 4n,
    'T10 lifetime totals match the mirror exactly');
}

console.log('=== T11: mode 1 — fee-less (DBC-shaped) mint: init, routed deposits, fold ===');
// A DBC-launched token's mint has a fixed extension set (metadata_pointer +
// transfer_hook): a TransferFee extension is impossible, so the mode-0
// harvest path can never exist for it. This mint is plain Token-2022 with
// NO extensions at all.
const m1 = { index: 0n, vault: 0n, distributed: 0n, cuts: 0n, routedFolded: 0n, paidOut: 0n, count: 0n };
function m1Distribute(unfoldedGross) {
  const cut = (unfoldedGross * CUT_BPS) / 10_000n;
  const net = unfoldedGross - cut;
  const eligible = SUPPLY - (m1.vault - cut); // W = 0: vault_after = vault_entry - cut
  const delta = (net * SCALE) / eligible;
  m1.index += delta;
  m1.vault -= cut;
  m1.distributed += net;
  m1.cuts += cut;
  m1.routedFolded += unfoldedGross;
  m1.count += 1n;
  return { cut, net, delta };
}
const ent1 = (balance, settled) => (balance * (m1.index - settled)) / SCALE;

const mint2 = Keypair.generate();
const MINT2 = mint2.publicKey;
const state2 = distPda(MINT2);
const vault2 = getAssociatedTokenAddressSync(MINT2, state2, true, T22);
{
  const len = getMintLen([]);
  const rent = svm.minimumBalanceForRentExemption(BigInt(len));
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: MINT2, space: len, lamports: Number(rent), programId: T22 }),
    createInitializeMintInstruction(MINT2, DECIMALS, payer.publicKey, null, T22),
    createAssociatedTokenAccountInstruction(payer.publicKey, vault2, state2, MINT2, T22),
  ], [payer, mint2], 'create fee-less mint + vault');
}
await send([initIx(MINT2, vault2)], [payer], 'init distributor (fee-less mint)');
{
  const s = distState(MINT2);
  ok(s.tag === 1 && s.fundingMode === 1 && s.index === 0n && s.totalHarvested === 0n && s.totalPaidOut === 0n && s.totalRoutedFolded === 0n,
    'T11 fee-less mint initializes in ROUTED mode (no NoFeeConfig rejection)');
  const s0 = distState(MINT);
  ok(s0.fundingMode === 0 && s0.totalPaidOut > 0n, 'T11 mode-0 state reads funding_mode 0; total_paid_out tracked its payouts');
  ok(s0.totalDistributed - s0.totalPaidOut === bal(vaultAta), 'T11 conservation identity on mode 0: total_distributed - total_paid_out == vault balance');
}
const payerAta2 = getAssociatedTokenAddressSync(MINT2, payer.publicKey, false, T22);
await send([
  createAssociatedTokenAccountInstruction(payer.publicKey, payerAta2, payer.publicKey, MINT2, T22),
  createMintToInstruction(MINT2, payerAta2, payer.publicKey, SUPPLY, [], T22),
], [payer], 'mint2 supply');
const H1 = await actor(MINT2), H2 = await actor(MINT2), KK = await actor(MINT2);
await xfer(MINT2, payerAta2, H1.ata, payer, 600_000n * TOK);
await xfer(MINT2, payerAta2, H2.ata, payer, 300_000n * TOK);
ok(bal(H1.ata) === 600_000n * TOK && bal(H2.ata) === 300_000n * TOK && acctWithheld(H1.ata) === 0n,
  'T11 fee-less transfers land exact (nothing withheld anywhere)');
// Routed deposit #1: the fee-claimer routing step, simulated as what it is
// on-chain — a plain transfer of the launched token into the vault.
await xfer(MINT2, payerAta2, vault2, payer, 9_000n * TOK);
m1.vault += 9_000n * TOK;
ok(bal(vault2) === m1.vault, 'T11 routed deposit #1 sits in the vault (9,000 TOK)');
{
  // HOOK-EXTRAS-FIX.md: the FundModeMismatch check is mode-0-only now — in
  // mode 1, trailing accounts are transfer-hook extras forwarded to the cut
  // payout CPI, NOT fee sources. On this hookless mint a mode-1 distribute
  // carrying a trailing account therefore SUCCEEDS and performs the fold
  // (this call IS fold #1: the mirror fold below accounts for it, and the
  // subsequent no-trailing-accounts distribute is then a zero-fold no-op —
  // the state assertions after this block verify the accounting is identical).
  const err = await attempt(() => send([distributeIx(MINT2, vault2, KK.kp.publicKey, KK.ata, [H1.ata])], [KK.kp], 'mode-1 distribute with trailing account (hook extras)'));
  ok(err === null, 'T11 mode-1 distribute with a trailing account SUCCEEDS — trailing accounts are hook extras, not FundModeMismatch (HOOK-EXTRAS-FIX.md)');
}
const d1 = m1Distribute(9_000n * TOK);
await send([distributeIx(MINT2, vault2, KK.kp.publicKey, KK.ata, [])], [KK.kp], 'mode-1 distribute 1');
{
  const s = distState(MINT2);
  ok(s.index === m1.index && s.totalDistributed === d1.net && s.totalCuts === d1.cut && s.totalRoutedFolded === 9_000n * TOK && s.totalHarvested === 0n && s.count === 1n,
    'T11 routed fold #1: state matches mirror (fold 9,000, cut 90, net 8,910 TOK)', `(index ${s.index})`);
  ok(bal(vault2) === m1.vault && bal(KK.ata) === 90n * TOK, 'T11 vault holds the net; cranker received the 90-TOK cut exactly (fee-less: gross == net)');
}

console.log('=== T12: mode 1 — claims, delta-only second fold, claim-out decomposition ===');
const idxA = m1.index;
const EH1 = ent1(bal(H1.ata), 0n);
{
  const vBefore = bal(vault2);
  await send([payoutIx(2, H1.kp.publicKey, H1.kp.publicKey, H1.ata, MINT2, vault2)], [H1.kp], 'mode-1 claim H1');
  ok(vBefore - bal(vault2) === EH1 && bal(H1.ata) === 600_000n * TOK + EH1, 'T12 H1 claims pro-rata, received to the unit (no fee haircut)', `(${EH1} raw)`);
  const cs = claimState(MINT2, H1.kp.publicKey);
  ok(cs && cs.settled === idxA && cs.totalClaimed === EH1, 'T12 H1 claim record exact');
  m1.vault -= EH1; m1.paidOut += EH1;
  ok(distState(MINT2).totalPaidOut === m1.paidOut, 'T12 state total_paid_out tracks the payout');
}
const EH2 = ent1(bal(H2.ata), 0n);
{
  const vBefore = bal(vault2);
  await send([payoutIx(3, KK.kp.publicKey, H2.kp.publicKey, H2.ata, MINT2, vault2)], [KK.kp], 'mode-1 settle H2');
  ok(vBefore - bal(vault2) === EH2, 'T12 H2 settled permissionlessly, exact', `(${EH2} raw)`);
  m1.vault -= EH2; m1.paidOut += EH2;
}
await xfer(MINT2, payerAta2, vault2, payer, 500n * TOK);
m1.vault += 500n * TOK;
ok(bal(vault2) === m1.vault, 'T12 routed deposit #2 lands (500 TOK)');
const d2 = m1Distribute(500n * TOK);
await send([distributeIx(MINT2, vault2, KK.kp.publicKey, KK.ata, [])], [KK.kp], 'mode-1 distribute 2');
{
  const s = distState(MINT2);
  ok(s.index === m1.index && s.totalRoutedFolded === 9_500n * TOK && s.totalDistributed === m1.distributed && s.totalCuts === m1.cuts && s.count === 2n,
    'T12 fold #2 folds ONLY the new 500-TOK delta (residual backing untouched)');
  ok(bal(vault2) === m1.vault && bal(KK.ata) === 95n * TOK, 'T12 vault + cranker (95 TOK cumulative cuts) match mirror');
}
const EH1b = ent1(bal(H1.ata), idxA);
{
  const vBefore = bal(vault2);
  await send([payoutIx(2, H1.kp.publicKey, H1.kp.publicKey, H1.ata, MINT2, vault2)], [H1.kp], 'mode-1 claim H1 #2');
  ok(vBefore - bal(vault2) === EH1b && EH1b > 0n, 'T12 H1 second claim pays the delta only', `(${EH1b} raw)`);
  m1.vault -= EH1b; m1.paidOut += EH1b;
}
{
  const s0 = distState(MINT2);
  await send([distributeIx(MINT2, vault2, KK.kp.publicKey, KK.ata, [])], [KK.kp], 'mode-1 distribute empty');
  const s1 = distState(MINT2);
  ok(s1.index === s0.index && s1.count === s0.count && s1.totalRoutedFolded === s0.totalRoutedFolded, 'T12 zero-fold distribute is a no-op (nothing double-folds)');
}
{
  const finale = async (tag, payerKp, holder, ata, label) => {
    const cs = claimState(MINT2, holder);
    const settled = cs ? cs.settled : 0n;
    const exp = ent1(bal(ata), settled);
    const vBefore = bal(vault2);
    await send([payoutIx(tag, payerKp.publicKey, holder, ata, MINT2, vault2)], [payerKp], label);
    ok(vBefore - bal(vault2) === exp, `T12 ${label} pays the exact formula amount`, `(${exp} raw)`);
    m1.vault -= exp; m1.paidOut += exp;
  };
  await finale(2, payer, payer.publicKey, payerAta2, 'funder claims (first touch, settled 0)');
  await finale(3, KK.kp, H2.kp.publicKey, H2.ata, 'H2 settles its delta');
  await finale(2, KK.kp, KK.kp.publicKey, KK.ata, 'cranker claims on its cut balance (first touch)');
  await finale(3, KK.kp, H1.kp.publicKey, H1.ata, 'H1 settles (already current: pays 0)');

  const v = bal(vault2);
  const s = distState(MINT2);
  ok(v === m1.vault, 'T12 vault balance equals mirrored residual to the unit', `(${v} raw)`);
  ok(v === s.totalDistributed - s.totalPaidOut && s.totalPaidOut === m1.paidOut,
    'T12 residual identity: vault == total_distributed - total_paid_out (every routed unit accounted)');
  // Decomposition: NO unsettled sends occur in this scenario — the routed
  // deposits are gifts INTO the pool made from the funder's balance, and
  // the funder's claims are computed on its post-deposit balance by
  // design — so stranded accrual is 0 and the residual is purely the
  // eligible-spread (folds are calibrated over eligible supply, which
  // exceeds the sum of claimant balances by the parked vault balance)
  // plus per-operation floors.
  ok(v >= 0n && v < 150n * TOK, 'T12 residual = eligible-spread + floors only (stranded 0)', `(${v} raw)`);
  ok(s.totalHarvested === 0n && s.count === 2n && s.totalRoutedFolded === 9_500n * TOK,
    'T12 lifetime totals: harvested 0, 2 folds, 9,500 TOK routed principal folded');
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
fs.writeFileSync(path.join(DIR, 'trial-result.json'), JSON.stringify({ distributor: DIST.toBase58(), pass, fail }, null, 2));
if (fail > 0) process.exit(1);

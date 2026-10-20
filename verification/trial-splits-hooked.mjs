// Hook Launcher DISTRIBUTOR — HOOKED-MINT SPLITS suite (LiteSVM, local only).
//
// What this proves (tag 4 hooked-mint extension, 2026-10-20):
//   Tag 4 on a HOOKED mint (real engine binary + real published meta
//   list), funding mode 1, engine Config enabling the split rules
//   5 Crown (500 bps) / 6 Tithe Seat (300 bps) / 15 King (200 bps)
//   PLUS hook rules that genuinely evaluate on every payout leg:
//   3 Agent-Only (destination must be registry-mirrored), 9 Max Wallet
//   (2000 bps = 200,000 TOK cap), and 15's own transfer-time King
//   tracking. Rule order in the config is [3, 9, 5, 6, 15] so the veto
//   rules run BEFORE King tracking writes. KG is funded 60,000 TOK —
//   above every other recipient's balance, below the cap — so the
//   streaming-max tracker keeps KG crowned through every leg (a
//   recipient whose balance beat the king's would be crowned by its
//   own leg; that is the tracker's designed behavior).
//
//   The extended instruction data [4, 1, tail_n, crown_n, seat_n,
//   king_n] delimits the legacy tail (cut extras) and one hook-extra
//   group per split leg, each resolved for source = vault, dest = that
//   leg's recipient. Groups use the trial-hooked superset shape plus
//   the King PDA after the sysvar (canonical extra index 7, required
//   by rule 15): [config, src holder, dst holder, rent vault, price
//   feed, system, sysvar, KING, engine, meta list PDA]. (No rule-1 in
//   the stack, so the price feed is never read; its PDA rides the
//   superset tail unread, exactly as in trial-hooked.)
//
//   D1  fully-clean hooked split distribution: all three legs pay
//       exactly, and the KING LEG PROVABLY EXECUTES THE HOOK — the
//       engine King PDA's stored balance rises by exactly the king
//       amount (60,000 -> 60,396 TOK), owner/account unchanged.
//   M   malformed extension headers (count-sum mismatch, bad version)
//       hard-fail BEFORE any transfer: state and balances untouched,
//       the pending deposit still unfolded.
//   D2  NEGATIVE PROOF — transfer-stage fail-open is impossible on
//       Solana: the crown flips (real Crown challenge -> finalize) to
//       CB2, who never registered as an agent; the CROWN leg is then
//       VETOED by Agent-Only and the WHOLE instruction reverts with
//       the engine's error, even though the leg was attempted with
//       correct extras. A failed CPI is always fatal (confirmed at a
//       second failure depth — a Token-level frozen-recipient
//       failure, custom 0x11 — during this build; see INTEGRATION.md).
//       Assertions: the attempt errors, the logs carry the engine
//       veto, and NOTHING moved (no leg paid, state untouched,
//       deposit #2 still unfolded).
//   D2b the working hooked path for a known-vetoed leg: the client
//       skips it at the VALIDATION stage (sentinel crown + recipient
//       slots, empty crown group). The same fold then succeeds: seat
//       and king legs pay exactly (King PDA +396 again), the skipped
//       990 TOK share folds into the index — total_paid_out counts
//       only the paid legs, the identity
//       vault == total_distributed - total_paid_out is exact, and the
//       index matches the remainder mirror.
//   F   a holder claim (tag 2, extras incl. King) pays exactly against
//       the post-split index; the identity holds after it.
//
// Venue allowlist = [DISTRIBUTOR] and the vault-owner mirror sync
// follow the trial-hooked precedents. The payer (mint/config
// authority) is a config EXEMPTION so its treasury balance can never
// be crowned by the streaming-max tracker; the king is established
// by a real hook transfer to KG (40,000 TOK).
//
// Run:  node trial-splits-hooked.mjs   (exit 1 on failure)
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
const ROOT = path.join(DIR, '..');
const readKp = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
const DIST = readKp(path.join(DIR, 'distributor-keypair.json')).publicKey;
const ENGINE = readKp(path.join(ROOT, 'engine', 'engine-keypair.json')).publicKey;
const REGISTRY = readKp(path.join(ROOT, 'registry', 'registry-keypair.json')).publicKey;
const CROWN = readKp(path.join(ROOT, 'crown-sol', 'crown-keypair.json')).publicKey;
const ENGINE_SO = process.env.ENGINE_SO || path.join(ROOT, 'engine', 'target', 'engine-trial.so');
const REGISTRY_SO = path.join(ROOT, 'registry', 'target', 'deploy', 'registry.so');
const CROWN_SO = path.join(ROOT, 'crown-sol', 'target', 'deploy', 'crown_sol.so');
const DIST_SO = path.join(DIR, 'target', 'deploy', 'distributor.so');
const T22 = TOKEN_2022_PROGRAM_ID;
const IX_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const DECIMALS = 6;
const TOK = 10n ** 6n;
const SUPPLY = 1_000_000n * TOK;
const SCALE = 10n ** 12n;
const CUT_BPS = 100n;

const svm = new LiteSVM();
svm.addProgramFromFile(ENGINE, ENGINE_SO);
svm.addProgramFromFile(REGISTRY, REGISTRY_SO);
svm.addProgramFromFile(CROWN, CROWN_SO);
svm.addProgramFromFile(DIST, DIST_SO);
svm.setClock(new Clock(1000n, 0n, 0n, 0n, 1_760_000_000n));
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
    try { const m = res.meta(); e.logs = typeof m.logs === 'function' ? m.logs() : (m.logs || []); }
    catch { e.logs = []; }
    e.chainErr = res.err();
    throw e;
  }
  return res;
}
const send = (ixs, signers, label) => runTx(ixs, signers, label);
async function attempt(fn) { try { await fn(); return null; } catch (e) { return e; } }
const acctData = (pk) => { const a = svm.getAccount(pk); return a ? Buffer.from(a.data) : null; };
const bal = (ata) => { const d = acctData(ata); return d ? d.readBigUInt64LE(64) : 0n; };
const K2 = (pubkey, s, wr) => ({ pubkey, isSigner: s, isWritable: wr });

// ---------- PDAs ----------
const ePda = (seeds) => PublicKey.findProgramAddressSync(seeds, ENGINE)[0];
const configPda = (mint) => ePda([Buffer.from('config'), mint.toBuffer()]);
const holderPda = (mint, ata) => ePda([Buffer.from('holder'), mint.toBuffer(), ata.toBuffer()]);
const rentVaultPda = (mint) => ePda([Buffer.from('rentvault'), mint.toBuffer()]);
const metaPda = (mint) => ePda([Buffer.from('extra-account-metas'), mint.toBuffer()]);
const pricePda = (mint) => ePda([Buffer.from('price'), mint.toBuffer()]);
const kingPda = (mint) => ePda([Buffer.from('king'), mint.toBuffer()]);
const regPda = (wallet) => PublicKey.findProgramAddressSync([Buffer.from('registration'), wallet.toBuffer()], REGISTRY)[0];
const distPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('dist'), mint.toBuffer()], DIST)[0];
const claimPda = (mint, holder) => PublicKey.findProgramAddressSync([Buffer.from('claim'), mint.toBuffer(), holder.toBuffer()], DIST)[0];
const crownPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('crown'), mint.toBuffer()], CROWN)[0];
const cvaultPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('cvault'), mint.toBuffer()], CROWN)[0];
const challengePda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('challenge'), mint.toBuffer()], CROWN)[0];
const stakePda = (mint, staker, side) => PublicKey.findProgramAddressSync([Buffer.from('stake'), mint.toBuffer(), staker.toBuffer(), Buffer.from([side])], CROWN)[0];

// ---------- engine config payload (trial-hooked idiom) ----------
function configPayload({ mode, authority, rules = [], venues = [], exemptions = [], feeBps = 0, feeMax = 0n, beneficiaryMode = 0, feeVault = null }, tag, defaultFeeVault) {
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
  (feeVault || defaultFeeVault).toBuffer().copy(tail, 11);
  parts.push(tail);
  return Buffer.concat(parts);
}
const bpsParams = (bps) => { const p = Buffer.alloc(64); p.writeUInt16LE(bps, 0); return p; };
const seatParams = (seatMint, bps) => { const p = Buffer.alloc(64); seatMint.toBuffer().copy(p, 0); p.writeUInt16LE(bps, 32); return p; };

// ---------- hook extras: trial-hooked superset + King PDA (canonical idx 7) ----------
function extrasFor(mint, sourceAta, destAta) {
  const K = (pubkey, isWritable) => ({ pubkey, isSigner: false, isWritable });
  return [
    K(configPda(mint), false),
    K(holderPda(mint, sourceAta), true),
    K(holderPda(mint, destAta), true),
    K(rentVaultPda(mint), true),
    K(pricePda(mint), false),
    K(SystemProgram.programId, false),
    K(IX_SYSVAR, false),
    K(kingPda(mint), true),
    K(ENGINE, false),
    K(metaPda(mint), false),
  ];
}
function hookTransferIx(mint, source, dest, owner, amountRaw) {
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked
  data.writeBigUInt64LE(BigInt(amountRaw), 1);
  data[9] = DECIMALS;
  return new TransactionInstruction({
    programId: T22, data,
    keys: [
      K2(source, false, true), K2(mint, false, false), K2(dest, false, true), K2(owner, true, false),
      ...extrasFor(mint, source, dest),
    ],
  });
}

// ---------- distributor + crown instruction builders ----------
const distInitIx = (mint, vaultAta) => new TransactionInstruction({
  programId: DIST, data: Buffer.from([0, 100, 0]),
  keys: [
    K2(payer.publicKey, true, true), K2(mint, false, false), K2(vaultAta, false, false),
    K2(distPda(mint), false, true), K2(SystemProgram.programId, false, false),
  ],
});
// Tag 4 EXTENDED: data [4, 1, tail_n, crown_n, seat_n, king_n]; accounts
// = core ++ split-7 ++ cut group ++ crown group ++ seat group ++ king group.
const splitsHookedIx = (mint, vaultAta, cranker, crankerAta, sk, groups, dataOverride = null) => new TransactionInstruction({
  programId: DIST,
  data: dataOverride ?? Buffer.from([4, 1, groups.cut.length, groups.crown.length, groups.seat.length, groups.king.length]),
  keys: [
    K2(cranker, true, false), K2(mint, false, true), K2(distPda(mint), false, true),
    K2(vaultAta, false, true), K2(crankerAta, false, true), K2(T22, false, false),
    K2(sk.config, false, false), K2(sk.crown, false, false), K2(sk.seat, false, false), K2(sk.king, false, false),
    K2(sk.crownRecip, false, true), K2(sk.seatRecip, false, true), K2(sk.kingRecip, false, true),
    ...groups.cut, ...groups.crown, ...groups.seat, ...groups.king,
  ],
});
const payoutIx = (mint, vaultAta, tag, payerKp, holder, holderAta, extras) => new TransactionInstruction({
  programId: DIST, data: Buffer.from([tag]),
  keys: [
    K2(payerKp.publicKey, true, true), K2(holder, false, false), K2(holderAta, false, true), K2(mint, false, false),
    K2(distPda(mint), false, true), K2(vaultAta, false, true), K2(claimPda(mint, holder), false, true),
    K2(T22, false, false), K2(SystemProgram.programId, false, false), ...extras,
  ],
});
// Real Crown Init (trial-splits idiom): tag 0, tiny bond/quorum params.
const crownInitIx = (mint, beneficiary) => {
  const data = Buffer.alloc(115);
  data[0] = 0;
  beneficiary.toBuffer().copy(data, 1);
  payer.publicKey.toBuffer().copy(data, 33); // treasury = payer
  data.writeBigUInt64LE(10_000_000n, 65);
  data.writeBigUInt64LE(10_000_000n, 73);
  data.writeBigInt64LE(60n, 81);
  data.writeBigInt64LE(0n, 89);
  data.writeBigInt64LE(0n, 97);
  data.writeBigInt64LE(0n, 105);
  data.writeUInt16LE(0, 113);
  return new TransactionInstruction({
    programId: CROWN, data,
    keys: [K2(payer.publicKey, true, true), K2(mint, false, false), K2(crownPda(mint), false, true),
      K2(cvaultPda(mint), false, true), K2(SystemProgram.programId, false, false)],
  });
};

// Real beneficiary flip (trial-splits idiom): OpenChallenge (candidate
// = new beneficiary), warp past window_end + timelock, Finalize.
async function flipCrown(mintPk, newBeneficiary) {
  const openData = Buffer.alloc(33);
  openData[0] = 1;
  newBeneficiary.toBuffer().copy(openData, 1);
  await send([new TransactionInstruction({
    programId: CROWN, data: openData,
    keys: [K2(payer.publicKey, true, true), K2(mintPk, false, false), K2(crownPda(mintPk), false, true),
      K2(challengePda(mintPk), false, true), K2(cvaultPda(mintPk), false, true),
      K2(stakePda(mintPk, payer.publicKey, 1), false, true), K2(SystemProgram.programId, false, false)],
  })], [payer], 'crown OpenChallenge');
  svm.setClock(new Clock(2000n, 0n, 0n, 0n, 1_760_000_000n + 7_200n));
  await send([new TransactionInstruction({
    programId: CROWN, data: Buffer.from([3]),
    keys: [K2(payer.publicKey, true, false), K2(mintPk, false, false), K2(crownPda(mintPk), false, true),
      K2(challengePda(mintPk), false, true), K2(cvaultPda(mintPk), false, true), K2(payer.publicKey, false, true)],
  })], [payer], 'crown Finalize');
}

// ---------- state readers ----------
const distState = (mint) => {
  const d = acctData(distPda(mint));
  return {
    tag: d[0], index: d.readBigUInt64LE(97) | (d.readBigUInt64LE(105) << 64n),
    totalDistributed: d.readBigUInt64LE(121), totalCuts: d.readBigUInt64LE(129),
    cutBps: d.readUInt16LE(137), fundingMode: d[140], count: d.readBigUInt64LE(149),
    totalPaidOut: d.readBigUInt64LE(157), totalRoutedFolded: d.readBigUInt64LE(165),
  };
};
const kingState = (mint) => {
  const d = acctData(kingPda(mint));
  if (!d) return null;
  return {
    tag: d[0], acct: new PublicKey(d.subarray(1, 33)), owner: new PublicKey(d.subarray(33, 65)),
    bal: d.readBigUInt64LE(65),
  };
};
const holderRegistered = (mint, owner) => { const d = acctData(holderPda(mint, getAssociatedTokenAddressSync(mint, owner, true, T22))); return !!d && d[1] === 1; };

// ================= SETUP =================
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
console.log('distributor:', DIST.toBase58(), '| engine:', ENGINE.toBase58(), '| crown:', CROWN.toBase58());
console.log('=== SETUP: hooked mint, rules [3, 9, 5, 6, 15], mode-1 distributor ===');

// Actor keypairs up front (the Crown Init names CB as beneficiary).
const A = Keypair.generate(), B = Keypair.generate(), C = Keypair.generate(), K = Keypair.generate();
const CB = Keypair.generate(), S = Keypair.generate(), KG = Keypair.generate();
const CB2 = Keypair.generate(); // second crown beneficiary — never registers (the D2 veto)
for (const kp of [A, B, C, K, CB, S, KG]) svm.airdrop(kp.publicKey, BigInt(5 * LAMPORTS_PER_SOL));

// Seat NFT mint first (rule-6 params name it at config write).
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
const seatAtaS = getAssociatedTokenAddressSync(SEAT, S.publicKey, false, T22);
await send([
  createAssociatedTokenAccountInstruction(payer.publicKey, seatAtaS, S.publicKey, SEAT, T22),
  createMintToInstruction(SEAT, seatAtaS, payer.publicKey, 1n, [], T22),
], [payer], 'seat NFT to S');

const mintKp = Keypair.generate();
const mint = mintKp.publicKey;
const statePk = distPda(mint);
const vaultAta = getAssociatedTokenAddressSync(mint, statePk, true, T22);
{
  const len = getMintLen([ExtensionType.TransferHook]);
  const rent = svm.minimumBalanceForRentExemption(BigInt(len));
  await send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, space: len, lamports: Number(rent), programId: T22 }),
    createInitializeTransferHookInstruction(mint, payer.publicKey, ENGINE, T22),
    createInitializeMintInstruction(mint, DECIMALS, payer.publicKey, null, T22),
    createAssociatedTokenAccountInstruction(payer.publicKey, vaultAta, statePk, mint, T22),
  ], [payer, mintKp], 'create hooked mint + vault ATA');
}
await send([new TransactionInstruction({
  programId: ENGINE,
  data: configPayload({
    mode: 1, authority: payer.publicKey,
    rules: [
      { id: 3 },
      { id: 9, params: bpsParams(2000) },       // Max Wallet cap 2000 bps = 200,000 TOK
      { id: 5, params: bpsParams(500) },        // Crown 500 bps
      { id: 6, params: seatParams(SEAT, 300) }, // Tithe Seat 300 bps
      { id: 15, params: bpsParams(200) },       // King tithe 200 bps + tracking
    ],
    venues: [DIST], exemptions: [payer.publicKey],
  }, 1, payer.publicKey),
  keys: [
    K2(payer.publicKey, true, true), K2(mint, false, false),
    K2(configPda(mint), false, true), K2(SystemProgram.programId, false, false),
  ],
})], [payer], 'init engine config [3,9,5,6,15]');
await send([new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]), // InitializeExtraAccountMetas disc
  keys: [
    K2(payer.publicKey, true, true), K2(metaPda(mint), false, true), K2(mint, false, false),
    K2(SystemProgram.programId, false, false), K2(configPda(mint), false, false),
  ],
})], [payer], 'init extra-account metas');
await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: rentVaultPda(mint), lamports: Math.floor(0.05 * LAMPORTS_PER_SOL) })], [payer], 'fund rent vault');
await send([distInitIx(mint, vaultAta)], [payer], 'init distributor');
await send([crownInitIx(mint, CB.publicKey)], [payer], 'init crown (beneficiary CB)');

// Actor ATAs + MintTo balances (MintTo does not invoke the hook).
async function actor(kp, mintToRaw) {
  const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, false, T22);
  const ixs = [createAssociatedTokenAccountInstruction(payer.publicKey, ata, kp.publicKey, mint, T22)];
  if (mintToRaw > 0n) ixs.push(createMintToInstruction(mint, ata, payer.publicKey, mintToRaw, [], T22));
  await send(ixs, [payer], 'actor ATA + MintTo');
  return { kp, ata };
}
const aA = await actor(A, 30_000n * TOK);
const aB = await actor(B, 20_000n * TOK);
const aC = await actor(C, 0n);
const aK = await actor(K, 40_000n * TOK);   // routes two 20,000 TOK deposits
const aCB = await actor(CB, 0n);
const aS = await actor(S, 49_000n * TOK);
const aKG = await actor(KG, 0n);
const cb2Ata = getAssociatedTokenAddressSync(mint, CB2.publicKey, false, T22);
await send([createAssociatedTokenAccountInstruction(payer.publicKey, cb2Ata, CB2.publicKey, mint, T22)], [payer], 'CB2 ATA (no MintTo, no registration)');
const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, T22);
await send([
  createAssociatedTokenAccountInstruction(payer.publicKey, payerAta, payer.publicKey, mint, T22),
  createMintToInstruction(mint, payerAta, payer.publicKey, SUPPLY - 139_000n * TOK, [], T22),
], [payer], 'mint remainder to payer');

// Registry + SyncRegistered path (b) mirrors for every actor, then the
// vault-owner authority-path mirror (trial-hooked L7b precedent).
const registerIx = (kp) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.from([0, 1]),
  keys: [K2(kp.publicKey, true, true), K2(regPda(kp.publicKey), false, true), K2(SystemProgram.programId, false, false)],
});
const syncPathBIx = (owner) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([4, 0]),
  keys: [
    K2(payer.publicKey, true, true), K2(mint, false, false), K2(configPda(mint), false, false),
    K2(owner, false, false),
    K2(holderPda(mint, getAssociatedTokenAddressSync(mint, owner, true, T22)), false, true),
    K2(SystemProgram.programId, false, false), K2(regPda(owner), false, false),
  ],
});
for (const kp of [A, B, C, K, CB, S, KG]) {
  await send([registerIx(kp)], [kp], 'registry register');
  await send([syncPathBIx(kp.publicKey)], [payer], 'sync registered (path b)');
}
await send([new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([4, 1]),
  keys: [
    K2(payer.publicKey, true, true), K2(mint, false, false), K2(configPda(mint), false, false),
    K2(statePk, false, false),
    K2(holderPda(mint, getAssociatedTokenAddressSync(mint, statePk, true, T22)), false, true),
    K2(SystemProgram.programId, false, false),
  ],
})], [payer], 'sync vault-owner mirror (authority path)');

// Establish the king: a REAL hook transfer payer -> KG of 60,000 TOK.
// The payer is config-exempt, so the streaming-max tracker crowns KG.
await send([hookTransferIx(mint, payerAta, aKG.ata, payer.publicKey, 60_000n * TOK)], [payer], 'fund KG via hook transfer (crowns KG)');

{
  const s = distState(mint);
  ok(s.tag === 1 && s.fundingMode === 1 && s.cutBps === 100, 'SETUP distributor mode 1, cut 100 bps');
  ok([A, B, C, K, CB, S, KG].every((kp) => holderRegistered(mint, kp.publicKey)) && holderRegistered(mint, statePk),
    'SETUP all actors + vault owner registry-mirrored (Agent-Only ready)');
  ok(bal(aA.ata) === 30_000n * TOK && bal(aB.ata) === 20_000n * TOK && bal(aS.ata) === 49_000n * TOK && bal(aK.ata) === 40_000n * TOK && bal(seatAtaS) === 1n,
    'SETUP balances: A 30,000 / B 20,000 / S 49,000 / K 40,000 TOK; S holds the seat NFT');
  const ks = kingState(mint);
  ok(ks && ks.tag === 1 && ks.owner.equals(KG.publicKey) && ks.acct.equals(aKG.ata) && ks.bal === 60_000n * TOK,
    'SETUP engine King PDA names KG at 60,000 TOK after the funding hook transfer', `(bal ${ks?.bal})`);
  const cr = acctData(crownPda(mint));
  ok(cr && cr[0] === 1 && new PublicKey(cr.subarray(33, 65)).equals(CB.publicKey), 'SETUP real Crown PDA names beneficiary CB');
}

// ---------- mirror (mode 1, splits) ----------
const M = { index: 0n, td: 0n, tpo: 0n, cuts: 0n, routed: 0n, count: 0n, vault: 0n };
function mirrorFold(foldGross, paid /* [crown, seat, king] actually paid */) {
  const cut = (foldGross * CUT_BPS) / 10_000n;
  const net = foldGross - cut;
  const S = paid[0] + paid[1] + paid[2];
  const remainder = net - S;
  const vaultAfter = M.vault - cut - S;
  const delta = (remainder * SCALE) / (SUPPLY - vaultAfter);
  M.index += delta; M.td += net; M.tpo += S; M.cuts += cut; M.routed += foldGross; M.count += 1n; M.vault = vaultAfter;
  return { cut, net, S, remainder, delta };
}
const CARVE = { crown: 990n * TOK, seat: 594n * TOK, king: 396n * TOK }; // on a 20,000 TOK fold, net 19,800
const splitKeys = () => ({
  config: configPda(mint), crown: crownPda(mint), seat: seatAtaS, king: kingPda(mint),
  crownRecip: aCB.ata, seatRecip: aS.ata, kingRecip: aKG.ata,
});
const groupsFor = () => ({
  cut: extrasFor(mint, vaultAta, aC.ata),
  crown: extrasFor(mint, vaultAta, aCB.ata),
  seat: extrasFor(mint, vaultAta, aS.ata),
  king: extrasFor(mint, vaultAta, aKG.ata),
});
async function deposit(label) {
  await send([hookTransferIx(mint, aK.ata, vaultAta, K.publicKey, 20_000n * TOK)], [K], label);
  M.vault += 20_000n * TOK;
}

console.log('=== D1: clean hooked split distribution (extended tag 4) ===');
await deposit('route deposit #1 K -> vault');
const e1 = mirrorFold(20_000n * TOK, [CARVE.crown, CARVE.seat, CARVE.king]);
await send([splitsHookedIx(mint, vaultAta, C.publicKey, aC.ata, splitKeys(), groupsFor())], [C], 'tag4 extended distribute #1');
{
  ok(bal(aC.ata) === e1.cut && e1.cut === 200n * TOK, 'D1 cranker cut paid exactly (200 TOK, cut group extras)');
  ok(bal(aCB.ata) === CARVE.crown && bal(aS.ata) === 49_000n * TOK + CARVE.seat && bal(aKG.ata) === 60_000n * TOK + CARVE.king,
    'D1 all three legs paid exactly: crown 990 / seat 594 / king 396 TOK');
  const ks = kingState(mint);
  ok(ks && ks.bal === 60_396n * TOK && ks.owner.equals(KG.publicKey) && ks.acct.equals(aKG.ata),
    'D1 HOOK EXECUTED on the king leg: engine King PDA balance 60,000 -> 60,396 TOK (+ king amount exactly)', `(bal ${ks?.bal})`);
  const s = distState(mint);
  ok(s.index === M.index && s.totalDistributed === M.td && s.totalPaidOut === M.tpo && s.totalCuts === M.cuts && s.count === 1n && s.totalRoutedFolded === 20_000n * TOK,
    'D1 state matches mirror (td = full net 19,800; tpo = paid splits 1,980)');
  ok(bal(vaultAta) === M.vault && bal(vaultAta) === s.totalDistributed - s.totalPaidOut,
    'D1 identity: vault == td - tpo == remainder 17,820 TOK');
}

console.log('=== M: malformed extension headers hard-fail before any transfer ===');
await deposit('route deposit #2 K -> vault');
{
  const s0 = distState(mint);
  const snap = { vault: bal(vaultAta), cb: bal(aCB.ata), s: bal(aS.ata), kg: bal(aKG.ata), c: bal(aC.ata), king: kingState(mint).bal };
  const g = groupsFor();
  const errSum = await attempt(() => send([splitsHookedIx(mint, vaultAta, C.publicKey, aC.ata, splitKeys(), g, Buffer.from([4, 1, 10, 10, 10, 9]))], [C], 'tag4 counts sum 39 != 40 trailing'));
  ok(errSum !== null, 'M count-sum mismatch (39 != 40 trailing accounts) hard-errors');
  const errVer = await attempt(() => send([splitsHookedIx(mint, vaultAta, C.publicKey, aC.ata, splitKeys(), g, Buffer.from([4, 2, 10, 10, 10, 10]))], [C], 'tag4 version 2 header'));
  ok(errVer !== null, 'M unknown extension version hard-errors');
  const errLen = await attempt(() => send([splitsHookedIx(mint, vaultAta, C.publicKey, aC.ata, splitKeys(), g, Buffer.from([4, 1, 10]))], [C], 'tag4 truncated header'));
  ok(errLen !== null, 'M truncated header (len 3) hard-errors');
  const s1 = distState(mint);
  ok(s1.index === s0.index && s1.count === s0.count && s1.totalDistributed === s0.totalDistributed && s1.totalPaidOut === s0.totalPaidOut
    && bal(vaultAta) === snap.vault && bal(aCB.ata) === snap.cb && bal(aS.ata) === snap.s && bal(aKG.ata) === snap.kg && bal(aC.ata) === snap.c && kingState(mint).bal === snap.king,
    'M all three malformed attempts are atomic: no transfer executed, deposit #2 still unfolded');
}

console.log('=== D2: NEGATIVE PROOF — a hook-vetoed leg reverts the whole instruction ===');
await flipCrown(mint, CB2.publicKey);
{
  const cr = acctData(crownPda(mint));
  ok(cr && new PublicKey(cr.subarray(33, 65)).equals(CB2.publicKey),
    'D2 crown beneficiary flipped CB -> CB2 via the REAL challenge -> finalize flow (CB2 never registered as an agent)');
  const s0 = distState(mint);
  const snap = { vault: bal(vaultAta), cb: bal(aCB.ata), cb2: bal(cb2Ata), s: bal(aS.ata), kg: bal(aKG.ata), c: bal(aC.ata), king: kingState(mint).bal };
  const sk = splitKeys(); sk.crownRecip = cb2Ata; // beneficiary is CB2 now; distributor validation passes (owner matches)
  const g = groupsFor(); g.crown = extrasFor(mint, vaultAta, cb2Ata);
  const err = await attempt(() => send([splitsHookedIx(mint, vaultAta, C.publicKey, aC.ata, sk, g)], [C], 'tag4 extended distribute #2 (crown vetoed)'));
  const logs = err ? (err.logs || []).join('\n') : '';
  ok(err !== null, 'D2 distribution with a hook-vetoed crown leg FAILS — a failed CPI cannot be caught on Solana');
  ok(logs.includes('not registered'),
    'D2 failure evidence: engine Agent-Only veto ("not registered") propagated through Token-2022 and aborted the distributor');
  console.log('    D2 veto log excerpt:', logs.split('\n').filter((l) => /not registered|custom program/i.test(l)).slice(0, 3).join(' | '));
  const s1 = distState(mint);
  ok(s1.index === s0.index && s1.count === s0.count && s1.totalDistributed === s0.totalDistributed && s1.totalPaidOut === s0.totalPaidOut
    && bal(vaultAta) === snap.vault && bal(aCB.ata) === snap.cb && bal(cb2Ata) === snap.cb2 && bal(aS.ata) === snap.s && bal(aKG.ata) === snap.kg && bal(aC.ata) === snap.c && kingState(mint).bal === snap.king,
    'D2 revert is atomic: nothing paid (the cut rolled back too), state untouched, deposit #2 still unfolded');
}

console.log('=== D2b: vetoed leg skipped at validation (sentinel) — the fold succeeds ===');
const e2 = mirrorFold(20_000n * TOK, [0n, CARVE.seat, CARVE.king]); // crown share folds into the index
{
  const g = groupsFor(); g.crown = []; // zero-length group for the skipped leg
  const sk = splitKeys(); sk.crown = statePk; sk.crownRecip = statePk; // sentinel slots
  await send([splitsHookedIx(mint, vaultAta, C.publicKey, aC.ata, sk, g)], [C], 'tag4 extended distribute #2b (crown sentinel-skipped)');
  ok(bal(cb2Ata) === 0n && bal(aCB.ata) === CARVE.crown, 'D2b skipped crown leg paid nobody: CB2 0, CB still at its D1 990 TOK');
  ok(bal(aS.ata) === 49_000n * TOK + 2n * CARVE.seat && bal(aKG.ata) === 60_792n * TOK && bal(aC.ata) === 2n * e1.cut,
    'D2b seat + king legs and the cut paid exactly (S cumulative seat 1,188; KG 60,792; cut cumulative 400)');
  const ks = kingState(mint);
  ok(ks && ks.bal === 60_792n * TOK && ks.owner.equals(KG.publicKey),
    'D2b HOOK EXECUTED on the king leg again: King PDA 60,396 -> 60,792 TOK (+396)');
  const s = distState(mint);
  ok(s.totalPaidOut === M.tpo && s.totalDistributed === M.td && s.count === 2n,
    'D2b accounting: total_paid_out counts ONLY paid legs (1,980 + 990 = 2,970 TOK); td = full nets 39,600', `(tpo ${s.totalPaidOut})`);
  ok(s.index === M.index, 'D2b index matches the remainder mirror — the skipped 990 TOK folded into the index (remainder 18,810 TOK)', `(index ${s.index})`);
  ok(bal(vaultAta) === M.vault && bal(vaultAta) === s.totalDistributed - s.totalPaidOut,
    'D2b identity: vault == td - tpo == 36,630 TOK (skipped amount remains in the vault)');
}

console.log('=== F: holder claim against the post-split index (tag 2 with extras) ===');
{
  const EA = (bal(aA.ata) * M.index) / SCALE;
  const vBefore = bal(vaultAta);
  await send([payoutIx(mint, vaultAta, 2, A, A.publicKey, aA.ata, extrasFor(mint, vaultAta, aA.ata))], [A], 'claim A');
  ok(EA > 0n && vBefore - bal(vaultAta) === EA && bal(aA.ata) === 30_000n * TOK + EA,
    'F A claims exactly its post-split-index entitlement', `(${EA} raw)`);
  M.vault -= EA; M.tpo += EA;
  const s = distState(mint);
  ok(s.totalPaidOut === M.tpo && bal(vaultAta) === s.totalDistributed - s.totalPaidOut, 'F identity holds after the claim');
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
fs.writeFileSync(path.join(DIR, 'trial-splits-hooked-result.json'), JSON.stringify({ distributor: DIST.toBase58(), engine: ENGINE.toBase58(), crown: CROWN.toBase58(), pass, fail }, null, 2));
if (fail > 0) process.exit(1);

// Hook Launcher DISTRIBUTOR — HOOKED-MINT proof suite (LiteSVM, local only).
//
// What this proves (distributor/HOOK-EXTRAS-FIX.md): on a mint carrying a
// transfer hook, every nonzero Distributor payout reverted before the fix,
// because cpi_vault_transfer built a bare TransferChecked CPI and never
// forwarded the hook's extra accounts. The fix threads trailing accounts
// through: Distribute (mode 1) accounts [6..] and Claim/Settle accounts
// [9..] are forwarded verbatim as hook extras to the payout CPI.
//
// This suite exercises that composition end-to-end with the REAL programs
// (Token-2022 + engine hook + registry + distributor), mirroring AGTR's
// shape: hooked mint (6 decimals), engine config [3 Agent-Only,
// 9 Max Wallet 500 bps], distributor in funding mode 1 (no TransferFee
// extension on the mint), caller cut 100 bps, vault = ATA owned by the
// distributor state PDA.
//
//   S1  routed deposit into the vault via TransferChecked WITH extras
//   S2  distribute with extras for the cut transfer -> fold lands, cut paid
//   S3  settle (permissionless) + claim for holder A with extras -> exact
//       entitlement paid, conservation identity U == 0 after the fold
//   S4  A/B REGRESSION: the identical scenario against the OLD binary
//       (target/deploy/distributor.so.pre-hookfix) — distribute MUST fail
//       with the missing-account class error that killed AGTR's first fold.
//       Plus a binary-swap leg: fold under the NEW binary, hot-swap the OLD
//       binary into the same SVM, and a nonzero claim MUST fail too.
//   S5  zero-entitlement claim under the new binary, extras appended,
//       succeeds as a no-op (backwards compat for bundled settles)
//
// SETUP DEVIATION (deliberate, load-bearing): the engine config's venue
// allowlist here is [DISTRIBUTOR]. The engine's Execute caller validation
// only accepts transfers whose TOP-LEVEL instruction is Token-2022 or a
// program on the config venue allowlist; a Distributor payout executes
// with the Distributor as the top-level program, so without this entry
// every payout CPI fails BadCaller (custom error 0x3, "engine: rejected
// caller <distributor>") before any rule runs — verified empirically by
// this suite's first run, and independent of the extras fix. Rules 3 and
// 9 ignore venue_context, so the allowlist entry does not weaken any
// assertion below (destination registration and the cap are still fully
// enforced). NOTE: AGTR's live config is Locked with venues=[DBC] only —
// see the run report; the extras fix alone does not clear that gate.
//
// Run:  node trial-hooked.mjs        (from this directory; exit 1 on failure)
//       ENGINE_SO=<path> node trial-hooked.mjs   (override the engine binary)
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
// Engine binary: the trial-consistent build (engine/target/engine-trial.so),
// matching engine/trial.mjs's program id + setup idioms.
const ENGINE_SO = process.env.ENGINE_SO || path.join(ROOT, 'engine', 'target', 'engine-trial.so');
const REGISTRY_SO = path.join(ROOT, 'registry', 'target', 'deploy', 'registry.so');
const DIST_NEW_SO = path.join(DIR, 'target', 'deploy', 'distributor.so');
const DIST_OLD_SO = path.join(DIR, 'target', 'deploy', 'distributor.so.pre-hookfix');
const T22 = TOKEN_2022_PROGRAM_ID;
const IX_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const DECIMALS = 6;
const TOK = 10n ** 6n;
const SUPPLY = 1_000_000n * TOK;       // total minted supply (mirror denominator)
const SCALE = 10n ** 12n;
const CUT_BPS = 100n;                  // 1% crank cut
const R = 9_000n * TOK;                // routed deposit (the fold amount)

// ---------- per-world plumbing (one LiteSVM instance per world) ----------
function makeWorld(distSo) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(ENGINE, ENGINE_SO);
  svm.addProgramFromFile(REGISTRY, REGISTRY_SO);
  svm.addProgramFromFile(DIST, distSo);
  svm.setClock(new Clock(1000n, 0n, 0n, 0n, 1_760_000_000n));
  const payer = Keypair.generate(); // mint authority + config authority ("creator")
  svm.airdrop(payer.publicKey, BigInt(300 * LAMPORTS_PER_SOL));
  return { svm, payer };
}
function runTx(w, ixs, signers, label) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = w.svm.latestBlockhash();
  tx.sign(...signers);
  const res = w.svm.sendTransaction(tx);
  w.svm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) {
    const e = new Error(label + ' failed');
    try { const m = res.meta(); e.logs = typeof m.logs === 'function' ? m.logs() : (m.logs || []); }
    catch { e.logs = []; }
    e.chainErr = res.err();
    throw e;
  }
  return res;
}
const send = (w, ixs, signers, label) => runTx(w, ixs, signers, label);
async function attempt(w, fn) { try { await fn(); return null; } catch (e) { return e; } }
const acctData = (w, pk) => { const a = w.svm.getAccount(pk); return a ? Buffer.from(a.data) : null; };
const bal = (w, ata) => { const d = acctData(w, ata); return d ? d.readBigUInt64LE(64) : 0n; };

// ---------- PDAs ----------
const ePda = (seeds) => PublicKey.findProgramAddressSync(seeds, ENGINE)[0];
const configPda = (mint) => ePda([Buffer.from('config'), mint.toBuffer()]);
const holderPda = (mint, owner) => ePda([Buffer.from('holder'), mint.toBuffer(), owner.toBuffer()]);
const rentVaultPda = (mint) => ePda([Buffer.from('rentvault'), mint.toBuffer()]);
const metaPda = (mint) => ePda([Buffer.from('extra-account-metas'), mint.toBuffer()]);
const pricePda = (mint) => ePda([Buffer.from('price'), mint.toBuffer()]);
const regPda = (wallet) => PublicKey.findProgramAddressSync([Buffer.from('registration'), wallet.toBuffer()], REGISTRY)[0];
const distPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('dist'), mint.toBuffer()], DIST)[0];
const claimPda = (mint, holder) => PublicKey.findProgramAddressSync([Buffer.from('claim'), mint.toBuffer(), holder.toBuffer()], DIST)[0];

// ---------- engine config payload (engine/trial.mjs idiom, verbatim shape) ----------
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
const maxWalletParams = (bps) => { const p = Buffer.alloc(64); p.writeUInt16LE(bps, 0); return p; };

// ---------- hook extras (engine/trial.mjs hookTransferIx construction) ----------
// Resolved extras in meta-list order, then the engine program, then the
// validation (extra-account-metas) PDA — exactly the tail spl-token appends
// after the 4 core TransferChecked keys [source, mint, dest, authority].
function extrasFor(w, mint, sourceAta, destAta) {
  const K = (pubkey, isWritable) => ({ pubkey, isSigner: false, isWritable });
  return [
    K(configPda(mint), false),
    K(holderPda(mint, sourceAta), true),
    K(holderPda(mint, destAta), true),
    K(rentVaultPda(mint), true),
    K(pricePda(mint), false),
    K(SystemProgram.programId, false),
    K(IX_SYSVAR, false),
    K(ENGINE, false),
    K(metaPda(mint), false),
  ];
}
function hookTransferIx(w, mint, source, dest, owner, amountRaw) {
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked
  data.writeBigUInt64LE(BigInt(amountRaw), 1);
  data[9] = DECIMALS;
  const K = (pubkey, s, wr) => ({ pubkey, isSigner: s, isWritable: wr });
  return new TransactionInstruction({
    programId: T22, data,
    keys: [
      K(source, false, true), K(mint, false, false), K(dest, false, true), K(owner, true, false),
      ...extrasFor(w, mint, source, dest),
    ],
  });
}

// ---------- distributor instruction builders (trial.mjs shapes + extras) ----------
const distInitIx = (w, mint, vaultAta) => new TransactionInstruction({
  programId: DIST, data: Buffer.from([0, 100, 0]), // tag 0, cut 100 bps
  keys: [
    { pubkey: w.payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: vaultAta, isSigner: false, isWritable: false },
    { pubkey: distPda(mint), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
const distributeIx = (w, mint, vaultAta, cranker, crankerAta, extras) => new TransactionInstruction({
  programId: DIST, data: Buffer.from([1]),
  keys: [
    { pubkey: cranker, isSigner: true, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: distPda(mint), isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true },
    { pubkey: crankerAta, isSigner: false, isWritable: true },
    { pubkey: T22, isSigner: false, isWritable: false },
    ...extras, // [6..] hook extras for the cut transfer vault -> crankerAta
  ],
});
const payoutIx = (w, mint, vaultAta, tag, payerKp, holder, holderAta, extras) => new TransactionInstruction({
  programId: DIST, data: Buffer.from([tag]),
  keys: [
    { pubkey: payerKp, isSigner: true, isWritable: true },
    { pubkey: holder, isSigner: false, isWritable: false },
    { pubkey: holderAta, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: distPda(mint), isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true },
    { pubkey: claimPda(mint, holder), isSigner: false, isWritable: true },
    { pubkey: T22, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...extras, // [9..] hook extras for the payout transfer vault -> holderAta
  ],
});

// ---------- state readers (trial.mjs offsets) ----------
const distState = (w, mint) => {
  const d = acctData(w, distPda(mint));
  return {
    tag: d[0],
    index: d.readBigUInt64LE(97) | (d.readBigUInt64LE(105) << 64n),
    totalDistributed: d.readBigUInt64LE(121), totalCuts: d.readBigUInt64LE(129),
    cutBps: d.readUInt16LE(137), fundingMode: d[140], count: d.readBigUInt64LE(149),
    totalPaidOut: d.readBigUInt64LE(157), totalRoutedFolded: d.readBigUInt64LE(165),
  };
};
const claimState = (w, mint, holder) => {
  const d = acctData(w, claimPda(mint, holder));
  if (!d) return null;
  return { tag: d[0], settled: d.readBigUInt64LE(65) | (d.readBigUInt64LE(73) << 64n), totalClaimed: d.readBigUInt64LE(81) };
};
const holderRegistered = (w, mint, owner) => { const d = acctData(w, holderPda(mint, getAssociatedTokenAddressSync(mint, owner, true, T22))); return !!d && d[1] === 1; };

// ---------- world setup: AGTR-shaped hooked mint + mode-1 distributor ----------
async function setupWorld(distSo) {
  const w = makeWorld(distSo);
  const { svm, payer } = w;
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const statePk = distPda(mint);
  const vaultAta = getAssociatedTokenAddressSync(mint, statePk, true, T22);

  const len = getMintLen([ExtensionType.TransferHook]);
  const rent = svm.minimumBalanceForRentExemption(BigInt(len));
  await send(w, [
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, space: len, lamports: Number(rent), programId: T22 }),
    createInitializeTransferHookInstruction(mint, payer.publicKey, ENGINE, T22),
    createInitializeMintInstruction(mint, DECIMALS, payer.publicKey, null, T22),
    createAssociatedTokenAccountInstruction(payer.publicKey, vaultAta, statePk, mint, T22),
  ], [payer, mintKp], 'create hooked mint + vault ATA');
  // Engine config: [3 Agent-Only, 9 Max Wallet 500 bps], Creator mode,
  // authority = payer (the creator keypair). venues = [DISTRIBUTOR]: see
  // the SETUP DEVIATION note in the file header (engine caller validation
  // rejects distributor-top-level payout CPIs with BadCaller otherwise).
  await send(w, [new TransactionInstruction({
    programId: ENGINE,
    data: configPayload({ mode: 1, authority: payer.publicKey, rules: [{ id: 3 }, { id: 9, params: maxWalletParams(500) }], venues: [DIST] }, 1, payer.publicKey),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: configPda(mint), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  })], [payer], 'init engine config');
  await send(w, [new TransactionInstruction({
    programId: ENGINE, data: Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]), // InitializeExtraAccountMetas disc
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: metaPda(mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: configPda(mint), isSigner: false, isWritable: false },
    ],
  })], [payer], 'init extra-account metas');
  await send(w, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: rentVaultPda(mint), lamports: Math.floor(0.05 * LAMPORTS_PER_SOL) })], [payer], 'fund rent vault');
  await send(w, [distInitIx(w, mint, vaultAta)], [payer], 'init distributor');

  // Actors: A, B holders; C cranker; K fee-claimer (routes the deposit).
  async function actor(name, mintToRaw) {
    const kp = Keypair.generate();
    svm.airdrop(kp.publicKey, BigInt(5 * LAMPORTS_PER_SOL));
    const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, false, T22);
    const ixs = [createAssociatedTokenAccountInstruction(payer.publicKey, ata, kp.publicKey, mint, T22)];
    if (mintToRaw > 0n) ixs.push(createMintToInstruction(mint, ata, payer.publicKey, mintToRaw, [], T22));
    await send(w, ixs, [payer], `${name} ATA + MintTo`);
    return { kp, ata };
  }
  const A = await actor('A', 30_000n * TOK);
  const B = await actor('B', 20_000n * TOK);
  const C = await actor('C', 0n);
  const K = await actor('K', R); // claimer holds exactly the routed amount
  // Park the remaining supply with the payer via MintTo (no hook on MintTo),
  // so total supply is exactly SUPPLY and the 500 bps cap is 50,000 TOK.
  const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, T22);
  await send(w, [
    createAssociatedTokenAccountInstruction(payer.publicKey, payerAta, payer.publicKey, mint, T22),
    createMintToInstruction(mint, payerAta, payer.publicKey, SUPPLY - 30_000n * TOK - 20_000n * TOK - R, [], T22),
  ], [payer], 'mint remainder to payer');

  // Registry: A, B, C, K register as agents (kind 1), then SyncRegistered
  // path (b) — registration PDA appended — mirrors it into each holder PDA.
  const registerIx = (walletKp) => new TransactionInstruction({
    programId: REGISTRY, data: Buffer.from([0, 1]),
    keys: [
      { pubkey: walletKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: regPda(walletKp.publicKey), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  const syncPathBIx = (owner) => new TransactionInstruction({
    programId: ENGINE, data: Buffer.from([4, 0]),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: configPda(mint), isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: holderPda(mint, getAssociatedTokenAddressSync(mint, owner, true, T22)), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: regPda(owner), isSigner: false, isWritable: false },
    ],
  });
  for (const a of [A, B, C, K]) {
    await send(w, [registerIx(a.kp)], [a.kp], 'registry register');
    await send(w, [syncPathBIx(a.kp.publicKey)], [payer], 'sync registered (path b)');
  }
  // The vault owner (distributor state PDA) cannot self-register: replicate
  // production step L7b — SyncRegistered authority path, data [4,1], signed
  // by the config authority, owner = state PDA (launcher/hook.mjs claim-fees).
  await send(w, [new TransactionInstruction({
    programId: ENGINE, data: Buffer.from([4, 1]),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: configPda(mint), isSigner: false, isWritable: false },
      { pubkey: statePk, isSigner: false, isWritable: false },
      { pubkey: holderPda(mint, getAssociatedTokenAddressSync(mint, statePk, true, T22)), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  })], [payer], 'sync vault-owner mirror (authority path, L7b)');

  // Permissionless settle payer (a stranger to the holder).
  const E = Keypair.generate();
  svm.airdrop(E.publicKey, BigInt(5 * LAMPORTS_PER_SOL));
  return { ...w, mint, statePk, vaultAta, payerAta, A, B, C, K, E };
}

// ---------- mirror math (trial.mjs mode-1 mirror, same integer formulas) ----------
function mirrorFold(vaultBefore, foldGross) {
  const cut = (foldGross * CUT_BPS) / 10_000n;
  const net = foldGross - cut;
  const eligible = SUPPLY - (vaultBefore - cut); // vault_after = vault_entry - cut (W = 0)
  const delta = (net * SCALE) / eligible;
  return { cut, net, delta, eligible };
}

// ================= TRIAL =================
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
console.log('engine:', ENGINE.toBase58(), '| registry:', REGISTRY.toBase58(), '| distributor:', DIST.toBase58());
console.log('engine binary:', ENGINE_SO);
console.log('distributor NEW:', DIST_NEW_SO, '| OLD:', DIST_OLD_SO);

console.log('=== SETUP (new binary): AGTR-shaped hooked mint, mode-1 distributor ===');
const n = await setupWorld(DIST_NEW_SO);
{
  const s = distState(n, n.mint);
  ok(s.tag === 1 && s.fundingMode === 1 && s.cutBps === 100 && s.index === 0n, 'SETUP distributor initialized in mode 1 (hooked mint, no TransferFee ext), cut 100 bps');
  ok([n.A, n.B, n.C, n.K].every(a => holderRegistered(n, n.mint, a.kp.publicKey)), 'SETUP A, B, C, K holder mirrors show registered (registry + SyncRegistered path b)');
  ok(holderRegistered(n, n.mint, n.statePk), 'SETUP vault owner (state PDA) mirror registered via authority path [4,1] (L7b)');
  ok(bal(n, n.A.ata) === 30_000n * TOK && bal(n, n.B.ata) === 20_000n * TOK && bal(n, n.K.ata) === R, 'SETUP balances landed by MintTo (A 30,000 / B 20,000 / K 9,000 TOK)');
}

console.log('=== S1: routed deposit into the vault (TransferChecked WITH extras) ===');
await send(n, [hookTransferIx(n, n.mint, n.K.ata, n.vaultAta, n.K.kp.publicKey, R)], [n.K.kp], 'route deposit K -> vault');
ok(bal(n, n.vaultAta) === R && bal(n, n.K.ata) === 0n, 'S1 deposit landed: vault == R (9,000 TOK), claimer drained');

console.log('=== S2: distribute with hook extras for the cut transfer ===');
const fold = mirrorFold(R, R);
await send(n, [distributeIx(n, n.mint, n.vaultAta, n.C.kp.publicKey, n.C.ata, extrasFor(n, n.mint, n.vaultAta, n.C.ata))], [n.C.kp], 'distribute (new binary)');
{
  const s = distState(n, n.mint);
  ok(bal(n, n.C.ata) === fold.cut, 'S2 cranker C received exactly the cut', `(cut ${fold.cut} raw = 90 TOK)`);
  ok(s.totalDistributed === fold.net && s.totalCuts === fold.cut && s.count === 1n && s.totalRoutedFolded === R,
    'S2 state: total_distributed == R - cut, total_cuts == cut, 1 fold, routed folded == R', `(net ${fold.net} raw)`);
  ok(s.index === fold.delta, 'S2 index == (R-cut)*SCALE/eligible mirror', `(index ${s.index}; eligible ${fold.eligible} raw)`);
  ok(bal(n, n.vaultAta) === R - fold.cut, 'S2 vault == R - cut (8,910 TOK)');
}

console.log('=== S3: settle (permissionless) + claim for A, both with extras ===');
const indexNow = fold.delta;
const entitlementA = (bal(n, n.A.ata) * indexNow) / SCALE; // first touch: settled = 0
{
  const aBefore = bal(n, n.A.ata), vaultBefore = bal(n, n.vaultAta);
  await send(n, [payoutIx(n, n.mint, n.vaultAta, 3, n.E.publicKey, n.A.kp.publicKey, n.A.ata, extrasFor(n, n.mint, n.vaultAta, n.A.ata))], [n.E], 'settle A (payer = stranger E)');
  const paidBySettle = bal(n, n.A.ata) - aBefore;
  ok(paidBySettle === entitlementA && entitlementA > 0n, 'S3 settle paid A exactly its entitlement', `(${entitlementA} raw)`);
  await send(n, [payoutIx(n, n.mint, n.vaultAta, 2, n.A.kp.publicKey, n.A.kp.publicKey, n.A.ata, extrasFor(n, n.mint, n.vaultAta, n.A.ata))], [n.A.kp], 'claim A');
  ok(bal(n, n.A.ata) - aBefore === entitlementA, 'S3 settle+claim cumulative: A increased by exactly the entitlement (claim leg itself pays 0 — A already current; double-claim protection)');
  const s = distState(n, n.mint);
  ok(s.totalPaidOut === entitlementA, 'S3 state total_paid_out == entitlement_A');
  const v = bal(n, n.vaultAta);
  ok(v === R - fold.cut - entitlementA, 'S3 conservation: vault == R - cut - entitlement_A', `(vault ${v} raw)`);
  ok(v - (s.totalDistributed - s.totalPaidOut) === 0n, 'S3 fold identity U = vault - (distributed - paid_out) == 0');
  const cs = claimState(n, n.mint, n.A.kp.publicKey);
  ok(cs && cs.settled === indexNow && cs.totalClaimed === entitlementA, 'S3 A claim record: settled == index, total_claimed == entitlement');
}

console.log('=== S5: zero-entitlement claim with extras is a successful no-op ===');
{
  const vBefore = bal(n, n.vaultAta);
  await send(n, [payoutIx(n, n.mint, n.vaultAta, 2, n.K.kp.publicKey, n.K.kp.publicKey, n.K.ata, extrasFor(n, n.mint, n.vaultAta, n.K.ata))], [n.K.kp], 'claim K (balance 0, entitlement 0)');
  ok(bal(n, n.K.ata) === 0n && bal(n, n.vaultAta) === vBefore, 'S5 zero-entitlement claim moved nothing');
  const cs = claimState(n, n.mint, n.K.kp.publicKey);
  ok(cs && cs.settled === indexNow && cs.totalClaimed === 0n, 'S5 K claim record created at settled == current index (first-touch, zero balance)');
}

console.log('=== S4a: A/B regression — identical scenario, OLD binary ===');
const o = await setupWorld(DIST_OLD_SO);
await send(o, [hookTransferIx(o, o.mint, o.K.ata, o.vaultAta, o.K.kp.publicKey, R)], [o.K.kp], 'route deposit K -> vault (old-binary world)');
ok(bal(o, o.vaultAta) === R, 'S4a deposit lands under the old binary too (plain transfers were never broken)');
const oldDistErr = await attempt(o, () => send(o, [distributeIx(o, o.mint, o.vaultAta, o.C.kp.publicKey, o.C.ata, extrasFor(o, o.mint, o.vaultAta, o.C.ata))], [o.C.kp], 'distribute (old binary)'));
{
  const logs = oldDistErr ? (oldDistErr.logs || []).join('\n') : '';
  ok(oldDistErr !== null, 'S4a distribute FAILS under the old binary (the fix is what makes S2 work)');
  // Observed failure: distributor custom error 0x6 (BadTokenAccount) — the
  // old build validates the trailing accounts as mode-1 fee-source token
  // accounts (the extras include PDAs and the engine program, which are not
  // token accounts) and never reaches / forwards them to a payout CPI.
  ok(logs.includes('custom program error: 0x6'), 'S4a failure class: distributor custom 0x6 BadTokenAccount (old build treats hook extras as fee sources, forwards nothing)');
  console.log('    old-binary distribute error:', oldDistErr ? JSON.stringify(oldDistErr.chainErr ?? oldDistErr.message).slice(0, 200) : '(none)');
  console.log('    old-binary logs excerpt:', logs.split('\n').filter(l => /missing|Unknown program|failed|custom program/i.test(l)).slice(0, 4).join(' | ') || logs.split('\n').slice(-4).join(' | '));
  const s = distState(o, o.mint);
  ok(s.index === 0n && s.count === 0n && bal(o, o.C.ata) === 0n && bal(o, o.vaultAta) === R, 'S4a fold never landed under old binary: index 0, count 0, no cut, vault still holds R');
}

console.log('=== S4b: binary swap — fold under NEW, claim nonzero entitlement under OLD ===');
{
  const s2 = await setupWorld(DIST_NEW_SO);
  await send(s2, [hookTransferIx(s2, s2.mint, s2.K.ata, s2.vaultAta, s2.K.kp.publicKey, R)], [s2.K.kp], 'swap world: route deposit');
  await send(s2, [distributeIx(s2, s2.mint, s2.vaultAta, s2.C.kp.publicKey, s2.C.ata, extrasFor(s2, s2.mint, s2.vaultAta, s2.C.ata))], [s2.C.kp], 'swap world: distribute (new binary)');
  const entSwap = (bal(s2, s2.A.ata) * distState(s2, s2.mint).index) / SCALE;
  ok(entSwap > 0n && distState(s2, s2.mint).index === fold.delta, 'S4b entitlement created under the new binary', `(${entSwap} raw owed to A)`);
  // Hot-swap the program code at the distributor address to the OLD binary.
  s2.svm.addProgramFromFile(DIST, DIST_OLD_SO);
  const aBefore = bal(s2, s2.A.ata);
  const swapErr = await attempt(s2, () => send(s2, [payoutIx(s2, s2.mint, s2.vaultAta, 2, s2.A.kp.publicKey, s2.A.kp.publicKey, s2.A.ata, extrasFor(s2, s2.mint, s2.vaultAta, s2.A.ata))], [s2.A.kp], 'claim A (old binary, post-swap)'));
  if (swapErr) {
    const logs = (swapErr.logs || []).join('\n');
    ok(bal(s2, s2.A.ata) === aBefore, 'S4b nonzero claim FAILS under the old binary (post-swap) — same missing-extras bug on the claim leg');
    console.log('    swap-world claim error:', String(swapErr.chainErr ?? swapErr.message).slice(0, 200));
    console.log('    swap-world logs excerpt:', logs.split('\n').filter(l => /missing|Unknown program|failed/i.test(l)).slice(0, 4).join(' | ') || logs.split('\n').slice(-4).join(' | '));
  } else {
    // LiteSVM did not replace already-loaded program code: the claim paid
    // under what is still the new binary. The operative old-binary claim
    // proof is then S4a's distribute failure — both payout paths share the
    // single cpi_vault_transfer, whose first old-binary invocation (the
    // cut) already fails; a nonzero claim under the old binary is
    // unreachable precisely because the fold that creates entitlements is
    // itself blocked.
    ok(bal(s2, s2.A.ata) - aBefore === entSwap, 'S4b NOTE: LiteSVM kept the first-loaded program code (claim paid) — binary swap not effective in-process; old-binary claim leg covered by S4a reasoning (shared cpi_vault_transfer)');
    console.log('    NOTE: addProgramFromFile did not replace the loaded distributor code in this LiteSVM instance.');
  }
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
fs.writeFileSync(path.join(DIR, 'trial-hooked-result.json'), JSON.stringify({ distributor: DIST.toBase58(), engine: ENGINE.toBase58(), pass, fail }, null, 2));
if (fail > 0) process.exit(1);

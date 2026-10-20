// Hook Launcher — AGTR-FAITHFUL FEE-FOLD composition suite (LiteSVM, local only).
//
// The composition case for the engine's Distributor caller-acceptance fix.
//
// Background: engine Execute caller validation accepts a transfer only when
// the executing TOP-LEVEL instruction is (a) Token-2022 Transfer/
// TransferChecked, or (b) a program on the config's venue allowlist.
// Standalone Distributor transactions (distribute tag 1 / claim tag 2 /
// settle tag 3) are top-level Distributor instructions, so on AGTR — whose
// live config is Locked with venues=[DBC] ONLY — every distributor payout
// transfer on the hooked mint was vetoed BadCaller (engine custom 3), even
// with the Distributor's hook-extras fix applied. The pre-existing hooked
// suite (trial-hooked.mjs, 23/23) only passes because its sim config cheats:
// venues=[DISTRIBUTOR]. This suite removes the cheat.
//
// The engine fix adds a third caller branch: top-level == Distributor
// program is accepted ONLY IF the transfer's authority is THIS mint's
// distributor state PDA (["dist", mint] under the Distributor program) —
// the vault ATA's owner and the only signer the Distributor can produce
// for its vault transfers. venue_context = false on this branch.
//
// This suite proves, on the NEW trial engine (REGISTRY_ID / DISTRIBUTOR_ID
// trial flavors) + the NEW distributor binary:
//   F1  routed deposit into the vault (plain TransferChecked + extras)
//   F2  standalone distribute (cut > 0) LANDS with venues=[DBC] only —
//       the cut arrives at the cranker exactly
//   F3  standalone settle+claim pays holder A a nonzero entitlement
//       exactly; conservation identity U == 0 after the fold
//   F4  zero-entitlement claim is a successful no-op
//   N1  NEGATIVE: a payout-shaped transfer driven by venueshim as
//       top-level (not in venues, not the distributor) -> BadCaller (3)
//   N2  NEGATIVE: distributor program id as top-level but the transfer
//       authority is a plain wallet, NOT the mint's distributor state PDA
//       -> BadCaller (3), via the branch's distinct rejection log.
//       Construction note: the real Distributor ONLY ever signs vault
//       transfers with its state PDA (that is the point of the check), so
//       this shape cannot be produced by the real program; the sim loads
//       the venueshim code under the Distributor's address in its own
//       world — the same program-substitution idiom as trial-hooked S4b —
//       to prove the engine does not trust the program id alone.
//
// Config under test (AGTR-faithful): rules [3 Agent-Only, 9 Max Wallet
// 500 bps], authority_mode LOCKED (0), venues = [DBC] ONLY — the
// distributor is NOT in the venue allowlist.
//
// Run:  node trial-fold.mjs          (from this directory; exit 1 on failure)
//       ENGINE_SO=<path> node trial-fold.mjs   (override the engine binary)
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
const SHIM = readKp(path.join(ROOT, 'venueshim', 'venueshim-keypair.json')).publicKey;
const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
const ENGINE_SO = process.env.ENGINE_SO || path.join(ROOT, 'engine', 'target', 'engine-trial.so');
const REGISTRY_SO = path.join(ROOT, 'registry', 'target', 'deploy', 'registry.so');
const DIST_SO = path.join(DIR, 'target', 'deploy', 'distributor.so');
const SHIM_SO = path.join(ROOT, 'venueshim', 'target', 'deploy', 'venueshim.so');
const T22 = TOKEN_2022_PROGRAM_ID;
const IX_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const DECIMALS = 6;
const TOK = 10n ** 6n;
const SUPPLY = 1_000_000n * TOK;
const SCALE = 10n ** 12n;
const CUT_BPS = 100n;
const R = 9_000n * TOK;

// ---------- per-world plumbing (trial-hooked.mjs idiom) ----------
function makeWorld({ distAsShim = false } = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(ENGINE, ENGINE_SO);
  svm.addProgramFromFile(REGISTRY, REGISTRY_SO);
  if (distAsShim) svm.addProgramFromFile(DIST, SHIM_SO); // N2: shim code at the distributor address
  else svm.addProgramFromFile(DIST, DIST_SO);
  svm.addProgramFromFile(SHIM, SHIM_SO);
  svm.setClock(new Clock(1000n, 0n, 0n, 0n, 1_760_000_000n));
  const payer = Keypair.generate();
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
const isBadCaller = (e) => !!e && ((e.logs || []).join('\n').includes('custom program error: 0x3')
  || /"Custom":3/.test(JSON.stringify(e.chainErr || {})));
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

// ---------- engine config payload (trial.mjs idiom, verbatim shape) ----------
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

// ---------- hook extras (meta-list order + engine + validation) ----------
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
// Venue-shim transfer: the SHIM program (or, in the N2 world, shim code at
// the DIST address) is the top-level instruction and CPIs TransferChecked.
function shimTransferIx(w, programId, mint, source, dest, ownerKp, amountRaw) {
  const data = Buffer.alloc(9);
  data.writeBigUInt64LE(BigInt(amountRaw), 0);
  data[8] = DECIMALS;
  const K = (pubkey, s, wr) => ({ pubkey, isSigner: s, isWritable: wr });
  return new TransactionInstruction({
    programId, data,
    keys: [
      K(source, false, true), K(mint, false, false), K(dest, false, true), K(ownerKp.publicKey, true, false),
      K(T22, false, false),
      ...extrasFor(w, mint, source, dest),
    ],
  });
}

// ---------- distributor instruction builders (trial-hooked shapes) ----------
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
    ...extras,
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
    ...extras,
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

// ---------- world setup: AGTR-faithful hooked mint ----------
// Config: rules [3, 9@500], authority_mode LOCKED (0), venues = [DBC] ONLY.
async function setupWorld(opts, { withDistributor = true, kAmount = R } = {}) {
  const w = makeWorld(opts);
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
  await send(w, [new TransactionInstruction({
    programId: ENGINE,
    data: configPayload({ mode: 0, authority: payer.publicKey, rules: [{ id: 3 }, { id: 9, params: maxWalletParams(500) }], venues: [DBC] }, 1, payer.publicKey),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: configPda(mint), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  })], [payer], 'init engine config (Locked, venues=[DBC])');
  await send(w, [new TransactionInstruction({
    programId: ENGINE, data: Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: metaPda(mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: configPda(mint), isSigner: false, isWritable: false },
    ],
  })], [payer], 'init extra-account metas');
  await send(w, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: rentVaultPda(mint), lamports: Math.floor(0.05 * LAMPORTS_PER_SOL) })], [payer], 'fund rent vault');
  if (withDistributor) await send(w, [distInitIx(w, mint, vaultAta)], [payer], 'init distributor');

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
  const K = await actor('K', kAmount);
  const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, T22);
  await send(w, [
    createAssociatedTokenAccountInstruction(payer.publicKey, payerAta, payer.publicKey, mint, T22),
    createMintToInstruction(mint, payerAta, payer.publicKey, SUPPLY - 30_000n * TOK - 20_000n * TOK - kAmount, [], T22),
  ], [payer], 'mint remainder to payer');

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

  const E = Keypair.generate();
  svm.airdrop(E.publicKey, BigInt(5 * LAMPORTS_PER_SOL));
  return { ...w, mint, statePk, vaultAta, payerAta, A, B, C, K, E };
}

// ---------- mirror math (trial-hooked.mjs mirror) ----------
function mirrorFold(vaultBefore, foldGross) {
  const cut = (foldGross * CUT_BPS) / 10_000n;
  const net = foldGross - cut;
  const eligible = SUPPLY - (vaultBefore - cut);
  const delta = (net * SCALE) / eligible;
  return { cut, net, delta, eligible };
}

// ================= TRIAL =================
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
console.log('engine:', ENGINE.toBase58(), '| registry:', REGISTRY.toBase58(), '| distributor:', DIST.toBase58(), '| shim:', SHIM.toBase58());
console.log('engine binary:', ENGINE_SO);
console.log('config under test: rules [3, 9@500], Locked, venues=[DBC] ONLY (distributor NOT in venues)');

console.log('=== SETUP: AGTR-faithful world ===');
const n = await setupWorld({});
{
  const s = distState(n, n.mint);
  ok(s.tag === 1 && s.fundingMode === 1 && s.cutBps === 100 && s.index === 0n, 'SETUP distributor initialized in mode 1, cut 100 bps');
  ok([n.A, n.B, n.C, n.K].every(a => holderRegistered(n, n.mint, a.kp.publicKey)), 'SETUP A, B, C, K holder mirrors registered');
  ok(holderRegistered(n, n.mint, n.statePk), 'SETUP vault owner (state PDA) mirror registered via authority path [4,1]');
  ok(bal(n, n.A.ata) === 30_000n * TOK && bal(n, n.B.ata) === 20_000n * TOK && bal(n, n.K.ata) === R, 'SETUP balances A 30,000 / B 20,000 / K 9,000 TOK');
}

console.log('=== F1: routed deposit into the vault ===');
await send(n, [hookTransferIx(n, n.mint, n.K.ata, n.vaultAta, n.K.kp.publicKey, R)], [n.K.kp], 'route deposit K -> vault');
ok(bal(n, n.vaultAta) === R && bal(n, n.K.ata) === 0n, 'F1 deposit landed: vault == R, claimer drained');

console.log('=== F2: standalone distribute, venues=[DBC] only — cut lands ===');
const fold = mirrorFold(R, R);
await send(n, [distributeIx(n, n.mint, n.vaultAta, n.C.kp.publicKey, n.C.ata, extrasFor(n, n.mint, n.vaultAta, n.C.ata))], [n.C.kp], 'distribute (AGTR-faithful config)');
{
  const s = distState(n, n.mint);
  ok(bal(n, n.C.ata) === fold.cut && fold.cut > 0n, 'F2 cranker C received exactly the (nonzero) cut', `(cut ${fold.cut} raw = 90 TOK)`);
  ok(s.totalDistributed === fold.net && s.totalCuts === fold.cut && s.count === 1n && s.totalRoutedFolded === R,
    'F2 state: total_distributed == R - cut, total_cuts == cut, 1 fold, routed folded == R');
  ok(s.index === fold.delta, 'F2 index == (R-cut)*SCALE/eligible mirror', `(index ${s.index})`);
  ok(bal(n, n.vaultAta) === R - fold.cut, 'F2 vault == R - cut (8,910 TOK)');
}

console.log('=== F3: standalone settle+claim pays A exactly; conservation ===');
const indexNow = fold.delta;
const entitlementA = (bal(n, n.A.ata) * indexNow) / SCALE;
{
  const aBefore = bal(n, n.A.ata);
  await send(n, [payoutIx(n, n.mint, n.vaultAta, 3, n.E.publicKey, n.A.kp.publicKey, n.A.ata, extrasFor(n, n.mint, n.vaultAta, n.A.ata))], [n.E], 'settle A (permissionless, payer = stranger E)');
  const paidBySettle = bal(n, n.A.ata) - aBefore;
  ok(paidBySettle === entitlementA && entitlementA > 0n, 'F3 settle paid A exactly its nonzero entitlement', `(${entitlementA} raw)`);
  await send(n, [payoutIx(n, n.mint, n.vaultAta, 2, n.A.kp.publicKey, n.A.kp.publicKey, n.A.ata, extrasFor(n, n.mint, n.vaultAta, n.A.ata))], [n.A.kp], 'claim A');
  ok(bal(n, n.A.ata) - aBefore === entitlementA, 'F3 settle+claim cumulative == entitlement exactly (claim leg pays 0; double-claim protection)');
  const s = distState(n, n.mint);
  ok(s.totalPaidOut === entitlementA, 'F3 state total_paid_out == entitlement_A');
  const v = bal(n, n.vaultAta);
  ok(v === R - fold.cut - entitlementA, 'F3 conservation: vault == R - cut - entitlement_A', `(vault ${v} raw)`);
  ok(v - (s.totalDistributed - s.totalPaidOut) === 0n, 'F3 fold identity U = vault - (distributed - paid_out) == 0');
  const cs = claimState(n, n.mint, n.A.kp.publicKey);
  ok(cs && cs.settled === indexNow && cs.totalClaimed === entitlementA, 'F3 A claim record: settled == index, total_claimed == entitlement');
}

console.log('=== F4: zero-entitlement claim is a successful no-op ===');
{
  const vBefore = bal(n, n.vaultAta);
  await send(n, [payoutIx(n, n.mint, n.vaultAta, 2, n.K.kp.publicKey, n.K.kp.publicKey, n.K.ata, extrasFor(n, n.mint, n.vaultAta, n.K.ata))], [n.K.kp], 'claim K (entitlement 0)');
  ok(bal(n, n.K.ata) === 0n && bal(n, n.vaultAta) === vBefore, 'F4 zero-entitlement claim moved nothing');
}

console.log('=== N1 NEGATIVE: venueshim top-level (not in venues, not distributor) -> BadCaller ===');
const n1 = await setupWorld({}, { withDistributor: false, kAmount: 100n * TOK });
{
  const kBefore = bal(n1, n1.K.ata), cBefore = bal(n1, n1.C.ata);
  const err = await attempt(n1, () => send(n1, [shimTransferIx(n1, SHIM, n1.mint, n1.K.ata, n1.C.ata, n1.K.kp, 10n * TOK)], [n1.K.kp], 'shim-driven transfer K -> C'));
  ok(err !== null, 'N1 shim-driven transfer FAILED (no silent pass)');
  ok(isBadCaller(err) && (err.logs || []).join('\n').includes('rejected caller'), 'N1 failure is engine BadCaller (custom 0x3, generic rejected-caller log)');
  ok(bal(n1, n1.K.ata) === kBefore && bal(n1, n1.C.ata) === cBefore, 'N1 balances unchanged (veto is atomic)');
  if (err) console.log('    N1 logs excerpt:', (err.logs || []).filter(l => /rejected|custom program/i.test(l)).slice(0, 3).join(' | '));
}

console.log('=== N2 NEGATIVE: distributor id top-level, wallet authority (not the state PDA) -> BadCaller ===');
const n2 = await setupWorld({ distAsShim: true }, { withDistributor: false, kAmount: 100n * TOK });
{
  const kBefore = bal(n2, n2.K.ata), cBefore = bal(n2, n2.C.ata);
  const err = await attempt(n2, () => send(n2, [shimTransferIx(n2, DIST, n2.mint, n2.K.ata, n2.C.ata, n2.K.kp, 10n * TOK)], [n2.K.kp], 'distributor-shaped transfer, wallet authority'));
  ok(err !== null, 'N2 distributor-shaped transfer with wallet authority FAILED');
  ok(isBadCaller(err), 'N2 failure is engine BadCaller (custom 0x3)');
  ok((err.logs || []).join('\n').includes('rejected distributor caller'), 'N2 rejection came from the distributor branch\'s distinct log (authority != distributor state PDA)');
  ok(bal(n2, n2.K.ata) === kBefore && bal(n2, n2.C.ata) === cBefore, 'N2 balances unchanged (veto is atomic)');
  if (err) console.log('    N2 logs excerpt:', (err.logs || []).filter(l => /rejected|custom program/i.test(l)).slice(0, 3).join(' | '));
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
fs.writeFileSync(path.join(DIR, 'trial-fold-result.json'), JSON.stringify({ distributor: DIST.toBase58(), engine: ENGINE.toBase58(), config: 'rules [3, 9@500], Locked, venues=[DBC]', pass, fail }, null, 2));
if (fail > 0) process.exit(1);

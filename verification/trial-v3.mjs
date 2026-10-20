// trial-v3.mjs — ENGINE v3 instruction-level trials: InitializeHolder
// retarget (tag 3), SyncRegistered ATA binding (tag 4), MigrateHolder
// (tag 10) and SyncHolder merge (tag 11). Helper region inherited from
// engine/trial.mjs (same world, builders, error classification);
// the test body below the TRIAL marker is v3-only.
// VENUESHIM (../venueshim — trial-only CPI shim for venue-context calls).
import { LiteSVM, FailedTransactionMetadata, Clock } from 'litesvm';
import {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createInitializeTransferHookInstruction, createInitializeMintInstruction,
  createMintToInstruction, createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync, getMintLen, ExtensionType,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const kp = JSON.parse(fs.readFileSync(path.join(DIR, 'engine-keypair.json'), 'utf8'));
const ENGINE = Keypair.fromSecretKey(Uint8Array.from(kp)).publicKey;
const REG_DIR = path.join(DIR, '..', 'registry');
const regKp = JSON.parse(fs.readFileSync(path.join(REG_DIR, 'registry-keypair.json'), 'utf8'));
const REGISTRY = Keypair.fromSecretKey(Uint8Array.from(regKp)).publicKey;
const SHIM_DIR = path.join(DIR, '..', 'venueshim');
const shimKp = JSON.parse(fs.readFileSync(path.join(SHIM_DIR, 'venueshim-keypair.json'), 'utf8'));
const SHIM = Keypair.fromSecretKey(Uint8Array.from(shimKp)).publicKey;
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID;
const IX_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const SYSVAR_CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const WHOLE = 10n ** 9n;
const SUPPLY = 1_000_000n * WHOLE;

const svm = new LiteSVM();
svm.addProgramFromFile(ENGINE, path.join(DIR, 'target/deploy/engine.so'));
svm.addProgramFromFile(REGISTRY, path.join(REG_DIR, 'target/deploy/registry.so'));
svm.addProgramFromFile(SHIM, path.join(SHIM_DIR, 'target/deploy/venueshim.so'));

// Controllable clock (registry trial idiom): crank/gate read unix_timestamp.
let clockSlot = 1000n;
const setTime = (ts) => { clockSlot += 17n; svm.setClock(new Clock(clockSlot, 0n, 0n, 0n, BigInt(ts))); };
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
const regPda = (wallet) => PublicKey.findProgramAddressSync([Buffer.from('registration'), wallet.toBuffer()], REGISTRY)[0];

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
const maxWalletParams = (bps) => { const p = Buffer.alloc(64); p.writeUInt16LE(bps, 0); return p; };
const latchParams = ({ stale = 300, halfLife = 0, bps = 0, live = 0 } = {}) => {
  const p = Buffer.alloc(64);
  p.writeBigUInt64LE(BigInt(stale), 0);
  p.writeBigUInt64LE(BigInt(halfLife), 8);
  p.writeUInt16LE(bps, 16);
  p[18] = live;
  return p;
};
const p2pParams = (mode) => { const p = Buffer.alloc(64); p[0] = mode; return p; };
const gateParams = (mint, min) => { const p = Buffer.alloc(64); mint.toBuffer().copy(p, 0); p.writeBigUInt64LE(BigInt(min), 32); return p; };

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

// Venue-context transfer: the SHIM program is the top-level instruction and
// CPIs the TransferChecked (venue allowlist must contain SHIM).
function shimTransferIx(mintPk, source, dest, owner, amountRaw) {
  const data = Buffer.alloc(9);
  data.writeBigUInt64LE(BigInt(amountRaw), 0);
  data[8] = 9;
  const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });
  return new TransactionInstruction({
    programId: SHIM, data,
    keys: [
      K(source, false, true), K(mintPk, false, false), K(dest, false, true), K(owner, true, false),
      K(TOKEN_2022, false, false),
      K(configPda(mintPk), false, false),
      K(holderPda(mintPk, source), false, true),
      K(holderPda(mintPk, dest), false, true),
      K(vaultPda(mintPk), false, true),
      K(pricePda(mintPk), false, false),
      K(SystemProgram.programId, false, false), K(IX_SYSVAR, false, false),
      K(ENGINE, false, false), K(metaPda(mintPk), false, false),
    ],
  });
}
const shimXfer = (m, from, to, ownerKp, wholeTokens) =>
  send([shimTransferIx(m.mint, from, to, ownerKp.publicKey, BigInt(wholeTokens) * WHOLE)], [ownerKp], 'shim xfer');
const tryShimXfer = (m, from, to, ownerKp, wholeTokens) => attempt(() => shimXfer(m, from, to, ownerKp, wholeTokens));

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
// SyncRegistered: with registrationPk -> path (b) mirror (permissionless);
// without -> path (a) config-authority direct set (launch/trial flows).
const syncRegisteredIx = (mintPk, owner, val, signer, registrationPk = null) => {
  const keys = [
    { pubkey: signer.publicKey, isSigner: true, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: false },
    { pubkey: configPda(mintPk), isSigner: false, isWritable: false },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: holderPda(mintPk, getAssociatedTokenAddressSync(mintPk, owner, true, TOKEN_2022)), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  if (registrationPk) keys.push({ pubkey: registrationPk, isSigner: false, isWritable: false });
  return new TransactionInstruction({ programId: ENGINE, data: Buffer.from([4, val]), keys });
};
const setRegisteredIx = syncRegisteredIx; // T3/T4 legacy alias (path a)
const registryRegisterIx = (wallet, kind) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.from([0, kind]),
  keys: [
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: regPda(wallet), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
const registrySetActiveIx = (wallet, active) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.from([1, active]),
  keys: [
    { pubkey: wallet, isSigner: true, isWritable: false },
    { pubkey: regPda(wallet), isSigner: false, isWritable: true },
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
// SyncGateBalance: mirrors the DST owner's gate balance, bound to the
// transfer instruction that immediately follows it in the same tx.
const syncGateIx = (mintPk, owner, gateAcct, destAta, signer) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([7]),
  keys: [
    { pubkey: signer.publicKey, isSigner: true, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: false },
    { pubkey: configPda(mintPk), isSigner: false, isWritable: false },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: holderPda(mintPk, destAta), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: gateAcct, isSigner: false, isWritable: false },
    { pubkey: destAta, isSigner: false, isWritable: false },
    { pubkey: IX_SYSVAR, isSigner: false, isWritable: false },
  ],
});
const gateXfer = (m, from, to, ownerKp, wholeTokens, gateAcct) => {
  const dstOwner = new PublicKey(acctData(to).subarray(32, 64));
  const sigs = ownerKp.publicKey.equals(payer.publicKey) ? [payer] : [payer, ownerKp];
  return send([
    syncGateIx(m.mint, dstOwner, gateAcct, to, payer),
    hookTransferIx(m.mint, from, to, ownerKp.publicKey, BigInt(wholeTokens) * WHOLE),
  ], sigs, 'gate xfer');
};
const tryGateXfer = (m, from, to, ownerKp, wholeTokens, gateAcct) => attempt(() => gateXfer(m, from, to, ownerKp, wholeTokens, gateAcct));
const crankIx = (mintPk, tokenVault, quoteVault) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([5]),
  keys: [
    { pubkey: configPda(mintPk), isSigner: false, isWritable: false },
    { pubkey: pricePda(mintPk), isSigner: false, isWritable: true },
    { pubkey: tokenVault, isSigner: false, isWritable: false },
    { pubkey: quoteVault, isSigner: false, isWritable: false },
  ],
});


// ================= TRIAL (v3 body) =================
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
console.log('engine:', ENGINE.toBase58(), '(v3 build under test)');

const gradParamsV3 = ({ stale = 1_000_000, vesting = 432_000, dipMult = 20_000 } = {}) => {
  const p = Buffer.alloc(64);
  p.writeBigUInt64LE(BigInt(stale), 0);
  p.writeBigUInt64LE(0n, 8);
  p.writeUInt16LE(0, 16);
  p[18] = 2; // GRADUATED
  p.writeUInt16LE(0, 19);
  p.writeBigUInt64LE(BigInt(vesting), 21);
  p.writeUInt16LE(dipMult, 29);
  return p;
};
const gradState = (mint, acct) => {
  const d = acctData(holderPda(mint, acct));
  if (!d) return null;
  return {
    len: d.length, registered: d[1] === 1, ecosystem: d[2], basis: readU128(d, 6), latched: d[38] === 1,
    peak: d.length >= 192 ? d.readBigUInt64LE(136) : 0n, sold: d.length >= 192 ? d.readBigUInt64LE(144) : 0n,
    cap: d.length >= 192 ? d.readBigUInt64LE(152) : 0n, anchor: d.length >= 192 ? d.readBigInt64LE(160) : 0n,
    minPrice: d.length >= 192 ? readU128(d, 168) : 0n,
  };
};
const setAcctRaw = (pk, a) => svm.setAccount(pk, {
  lamports: a ? a.lamports : 0,
  data: a ? new Uint8Array(a.data) : new Uint8Array(0),
  owner: a ? a.owner : SystemProgram.programId,
  executable: false, rentEpoch: 0,
});
const lamportsOf = (pk) => { const a = svm.getAccount(pk); return a ? Number(a.lamports) : 0; };
const patchHolder = (mint, acct, fn) => {
  const pk = holderPda(mint, acct);
  const a = svm.getAccount(pk);
  const d = Buffer.from(a.data);
  fn(d);
  svm.setAccount(pk, { lamports: a.lamports, data: new Uint8Array(d), owner: a.owner, executable: false, rentEpoch: 0 });
};
// A second token account for the same owner+mint, crafted by cloning the
// ATA's account bytes at a fresh address (indistinguishable on-chain).
const secondAccount = (ataPk) => {
  const a = svm.getAccount(ataPk);
  const kp = Keypair.generate();
  const d = Buffer.from(a.data);
  d.writeBigUInt64LE(0n, 64); // zero balance; owner/mint fields already correct
  svm.setAccount(kp.publicKey, { lamports: a.lamports, data: new Uint8Array(d), owner: a.owner, executable: false, rentEpoch: 0 });
  return kp.publicKey;
};
const migrateIx = (mint, owner, ata) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([10]),
  keys: [
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: configPda(mint), isSigner: false, isWritable: false },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: ata, isSigner: false, isWritable: false },
    { pubkey: holderPda(mint, owner), isSigner: false, isWritable: true },
    { pubkey: holderPda(mint, ata), isSigner: false, isWritable: true },
    { pubkey: vaultPda(mint), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
const syncHolderIx = (mint, ownerKp, srcAcct, dstAcct) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([11]),
  keys: [
    { pubkey: ownerKp.publicKey, isSigner: true, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: configPda(mint), isSigner: false, isWritable: false },
    { pubkey: srcAcct, isSigner: false, isWritable: false },
    { pubkey: dstAcct, isSigner: false, isWritable: false },
    { pubkey: holderPda(mint, srcAcct), isSigner: false, isWritable: true },
    { pubkey: holderPda(mint, dstAcct), isSigner: false, isWritable: true },
    { pubkey: vaultPda(mint), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});

// ---------- graduated mint with a cranked feed (T9 price shape: EMA 2e9) ----------
const quoteMint = await plainMint();
const poolAuth = Keypair.generate();
svm.airdrop(poolAuth.publicKey, BigInt(2 * LAMPORTS_PER_SOL));
const mG = await launchMint(
  { mode: 1, authority: payer.publicKey, rules: [{ id: 1, params: gradParamsV3() }], exemptions: [payer.publicKey, poolAuth.publicKey] },
  { fundVault: Math.floor(0.05 * LAMPORTS_PER_SOL), supply: 10_000_000n * WHOLE },
);
const tokenVault = getAssociatedTokenAddressSync(mG.mint, poolAuth.publicKey, true, TOKEN_2022);
const quoteVault = getAssociatedTokenAddressSync(quoteMint, poolAuth.publicKey, true, TOKEN_2022);
await send([
  createAssociatedTokenAccountInstruction(payer.publicKey, tokenVault, poolAuth.publicKey, mG.mint, TOKEN_2022),
  createAssociatedTokenAccountInstruction(payer.publicKey, quoteVault, poolAuth.publicKey, quoteMint, TOKEN_2022),
  createMintToInstruction(quoteMint, quoteVault, payer.publicKey, 1_000n * WHOLE, [], TOKEN_2022),
], [payer], 'pool vaults + quote seed');
await send([initFeedIx(mG.mint, Keypair.generate().publicKey, tokenVault, quoteVault)], [payer], 'init price feed');
await xfer(mG, mG.payerAta, tokenVault, payer, 500_000);
await send([crankIx(mG.mint, tokenVault, quoteVault)], [payer], 'crank');
ok(feedEma(mG.mint) === 2_000_000_000n, 'V0 feed cranked to EMA 2e9', `ema=${feedEma(mG.mint)}`);

console.log('=== V1: InitializeHolder retarget (tag 3) ===');
{
  const ghost = Keypair.generate().publicKey; // a token-account ADDRESS that does not exist
  await send([initHolderIx(mG.mint, ghost)], [payer], 'init holder for nonexistent token account');
  ok(acctData(holderPda(mG.mint, ghost)) !== null, 'V1 record created for a not-yet-existing token account (address-bound)');
  const w = await actor(mG.mint, 'v1-wrongmint');
  const foreignAta = getAssociatedTokenAddressSync(quoteMint, w.kp.publicKey, false, TOKEN_2022);
  await send([createAssociatedTokenAccountInstruction(payer.publicKey, foreignAta, w.kp.publicKey, quoteMint, TOKEN_2022)], [payer], 'foreign-mint ATA');
  const err = await attempt(() => send([initHolderIx(mG.mint, foreignAta)], [payer], 'init holder with foreign-mint account'));
  ok(err !== null && acctData(holderPda(mG.mint, foreignAta)) === null, 'V1 existing account of a DIFFERENT mint is rejected, no record created');
}

console.log('=== V2: SyncRegistered mirrors into the ATA-keyed record (tag 4) ===');
{
  const w = Keypair.generate(); // NOTE: no ATA created for w at all
  svm.airdrop(w.publicKey, BigInt(2 * LAMPORTS_PER_SOL));
  await send([registryRegisterIx(w.publicKey, 1)], [w], 'registry register');
  await send([syncRegisteredIx(mG.mint, w.publicKey, 0, payer, regPda(w.publicKey))], [payer], 'sync (path b)');
  const ataW = getAssociatedTokenAddressSync(mG.mint, w.publicKey, false, TOKEN_2022);
  const rec = acctData(holderPda(mG.mint, ataW));
  ok(rec !== null && rec[1] === 1, 'V2 mirror landed in the record keyed by the (nonexistent) ATA address');
  ok(acctData(holderPda(mG.mint, w.publicKey)) === null, 'V2 NOTHING written at the owner-keyed address');
}

console.log('=== V3: MigrateHolder (tag 10) ===');
const wM = await actor(mG.mint, 'migrate-w');
await xfer(mG, mG.payerAta, wM.ata, payer, 7_000); // real buy: record at ATA-keyed PDA, basis 2e9, peak 7000
const realBytes = acctData(holderPda(mG.mint, wM.ata));
ok(realBytes !== null && readU128(realBytes, 6) === 2_000_000_000n, 'V3 setup: real account-keyed record with basis 2e9');
// stage the legacy world: same bytes at the owner-keyed address, v3 slot cleared
const legacyPk = holderPda(mG.mint, wM.kp.publicKey);
{
  const a = svm.getAccount(holderPda(mG.mint, wM.ata));
  svm.setAccount(legacyPk, { lamports: a.lamports, data: new Uint8Array(realBytes), owner: a.owner, executable: false, rentEpoch: 0 });
  setAcctRaw(holderPda(mG.mint, wM.ata), null);
}
const vaultBefore = lamportsOf(vaultPda(mG.mint));
{
  // signed by payer — an unrelated third party (permissionless)
  await send([migrateIx(mG.mint, wM.kp.publicKey, wM.ata)], [payer], 'migrate holder');
  const moved = acctData(holderPda(mG.mint, wM.ata));
  ok(moved !== null && moved.equals(realBytes), 'V3 record copied VERBATIM to the account-keyed address');
  ok(acctData(legacyPk) === null, 'V3 legacy account closed');
  ok(lamportsOf(vaultPda(mG.mint)) === vaultBefore, 'V3 rent-neutral to the vault at equal sizes (create out == closure refund in)');
}
{
  const err = await attempt(() => send([migrateIx(mG.mint, wM.kp.publicKey, wM.ata)], [payer], 'migrate again'));
  ok(err === 'Custom9', 'V3 second migration fails HolderMissing (legacy record is gone)', `err=${err}`);
}
{
  // v3 record exists + a legacy record re-staged -> AlreadyInit (a merge case, not a copy)
  const a = svm.getAccount(holderPda(mG.mint, wM.ata));
  svm.setAccount(legacyPk, { lamports: a.lamports, data: new Uint8Array(realBytes), owner: a.owner, executable: false, rentEpoch: 0 });
  const err = await attempt(() => send([migrateIx(mG.mint, wM.kp.publicKey, wM.ata)], [payer], 'migrate with live v3 record'));
  ok(err === 'Custom14', 'V3 migration over a live v3 record fails AlreadyInit', `err=${err}`);
  setAcctRaw(legacyPk, null);
}
{
  const stranger = await actor(mG.mint, 'migrate-stranger');
  const err = await attempt(() => send([migrateIx(mG.mint, wM.kp.publicKey, stranger.ata)], [payer], 'migrate with a foreign ATA'));
  ok(err === 'Custom10', 'V3 migration naming someone else\'s token account fails BadState', `err=${err}`);
}

console.log('=== V4: SyncHolder merge (tag 11) — graduated arithmetic ===');
const wS = await actor(mG.mint, 'merge-w');
await xfer(mG, mG.payerAta, wS.ata, payer, 7_000); // record A: basis 2e9, peak 7000
const acct2 = secondAccount(wS.ata);
await xfer(mG, mG.payerAta, acct2, payer, 3_000); // record B: basis 2e9, peak 3000
ok(gradState(mG.mint, acct2)?.peak === 3_000n * WHOLE, 'V4 setup: second account carries its OWN record (fragmentation is real)');
// patch exact merge inputs
patchHolder(mG.mint, wS.ata, (d) => { // A
  d[1] = 1; d[2] = 0; d[38] = 0;
  d.writeBigUInt64LE(1_000n * WHOLE, 144); // sold
  d.writeBigUInt64LE(2_000n * WHOLE, 152); // cap
  d.writeBigInt64LE(1000n, 160);           // anchor ts
  d.fill(0, 168, 184); (1500000000000n).toString(16).padStart(32, '0'); // min_price set below
  let mp = 1_500_000_000_000n; d.writeBigUInt64LE(mp & ((1n << 64n) - 1n), 168); d.writeBigUInt64LE(mp >> 64n, 176);
});
patchHolder(mG.mint, acct2, (d) => { // B
  d[1] = 0; d[2] = 7; d[38] = 1;
  d.writeBigUInt64LE(1_000_000_000n, 6); d.writeBigUInt64LE(1n, 22); // basis 1e9
  d.writeBigUInt64LE(500n * WHOLE, 144);
  d.writeBigUInt64LE(1_500n * WHOLE, 152);
  d.writeBigInt64LE(2000n, 160);
  let mp = 1_200_000_000_000n; d.writeBigUInt64LE(mp & ((1n << 64n) - 1n), 168); d.writeBigUInt64LE(mp >> 64n, 176);
});
const vaultB4 = lamportsOf(vaultPda(mG.mint));
{
  await send([syncHolderIx(mG.mint, wS.kp, acct2, wS.ata)], [wS.kp], 'merge acct2 -> ATA');
  const st = gradState(mG.mint, wS.ata);
  ok(st !== null, 'V4 merged record exists at the destination');
  ok(st.basis === 1_700_000_000n, 'V4 basis = balance-weighted blend (7000*2e9 + 3000*1e9)/10000 = 1.7e9', `basis=${st.basis}`);
  ok(st.peak === 10_000n * WHOLE, 'V4 peak = max(src, dst, combined balance) = 10000');
  ok(st.sold === 1_500n * WHOLE, 'V4 sold = src + dst (both histories charged)');
  ok(st.cap === 3_500n * WHOLE, 'V4 cap = min(cap sum 3500, merged peak)');
  ok(st.anchor === 1300n, 'V4 anchor = balance-weighted blend (7000*1000 + 3000*2000)/10000 = 1300', `anchor=${st.anchor}`);
  ok(st.minPrice === 1_200_000_000_000n, 'V4 min_price = min of the nonzero pair');
  ok(st.latched && st.registered && st.ecosystem === 7, 'V4 latch OR / registered OR / ecosystem fills from src');
  ok(acctData(holderPda(mG.mint, acct2)) === null, 'V4 source record closed');
  ok(lamportsOf(vaultPda(mG.mint)) > vaultB4, 'V4 source rent refunded to the vault');
}

console.log('=== V5: SyncHolder — missing destination record + negatives ===');
{
  const acct3 = secondAccount(wS.ata);
  await send([createMintToInstruction(mG.mint, acct3, payer.publicKey, 1_000n * WHOLE, [], TOKEN_2022)], [payer], 'mintTo acct3 (no hook — no record)');
  ok(acctData(holderPda(mG.mint, acct3)) === null && bal(acct3) === 1_000n * WHOLE, 'V5 setup: acct3 holds tokens with NO record');
  const acct4 = secondAccount(wS.ata);
  await xfer(mG, mG.payerAta, acct4, payer, 500); // record C via a real receive
  await send([syncHolderIx(mG.mint, wS.kp, acct4, acct3)], [wS.kp], 'merge acct4 -> acct3 (dst created)');
  const st = gradState(mG.mint, acct3);
  ok(st !== null && st.basis === 2_000_000_000n, 'V5 merge creates the destination record and carries the known basis across');
  ok(acctData(holderPda(mG.mint, acct4)) === null, 'V5 source record closed');
  const errSelf = await attempt(() => send([syncHolderIx(mG.mint, wS.kp, acct3, acct3)], [wS.kp], 'merge into itself'));
  ok(errSelf !== null && gradState(mG.mint, acct3) !== null, 'V5 self-merge rejected and the record SURVIVES');
  const other = await actor(mG.mint, 'merge-other');
  const errForeign = await attempt(() => send([syncHolderIx(mG.mint, wS.kp, other.ata, wS.ata)], [wS.kp], 'merge a foreign account'));
  ok(errForeign === 'Custom10', 'V5 merging an account the signer does not own fails BadState', `err=${errForeign}`);
  const errMissing = await attempt(() => send([syncHolderIx(mG.mint, wS.kp, secondAccount(wS.ata), wS.ata)], [wS.kp], 'merge from a record-less account'));
  ok(errMissing === 'Custom9', 'V5 missing source record fails HolderMissing', `err=${errMissing}`);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);

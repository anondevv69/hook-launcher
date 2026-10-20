// ECOSYSTEM GATE (engine rule 17) — LiteSVM proof suite.
// Cross-program: REGISTRY v2 (attested registrations) + ENGINE (rule 17
// mirror gate) + real Token-2022 hook transfers. Design: SPEC-ECOSYSTEM-GATE.md.
// Mirrors the engine trial idioms (engine/trial.mjs): real binaries
// in-process, manual extra-account resolution in meta-list order.
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
const ENG_DIR = path.join(DIR, '..', 'engine');
const REG_DIR = path.join(DIR, '..', 'registry');
const engKp = JSON.parse(fs.readFileSync(path.join(ENG_DIR, 'engine-keypair.json'), 'utf8'));
const ENGINE = Keypair.fromSecretKey(Uint8Array.from(engKp)).publicKey;
const regKp = JSON.parse(fs.readFileSync(path.join(REG_DIR, 'registry-keypair.json'), 'utf8'));
const REGISTRY = Keypair.fromSecretKey(Uint8Array.from(regKp)).publicKey;
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID;
const IX_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const WHOLE = 10n ** 9n;
const SUPPLY = 1_000_000n * WHOLE;

const ECO_MUSE = 1, ECO_FOMO = 2;

const svm = new LiteSVM();
// The engine binary here is the TRIAL build (REGISTRY_ID = dev registry id),
// exactly as in engine/trial.mjs; the deploy build differs only in that const.
svm.addProgramFromFile(ENGINE, path.join(ENG_DIR, 'target/deploy/engine.so'));
svm.addProgramFromFile(REGISTRY, path.join(REG_DIR, 'target/deploy/registry.so'));

let clockSlot = 1000n;
const setTime = (ts) => { clockSlot += 17n; svm.setClock(new Clock(clockSlot, 0n, 0n, 0n, BigInt(ts))); };
setTime(1_760_000_000);

const payer = Keypair.generate(); // mint + config authority, transfer source
svm.airdrop(payer.publicKey, BigInt(300 * LAMPORTS_PER_SOL));
const fund = (kp, sol = 5) => { svm.airdrop(kp.publicKey, BigInt(sol * LAMPORTS_PER_SOL)); return kp; };

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, ENGINE)[0];
const configPda = (mint) => pda([Buffer.from('config'), mint.toBuffer()]);
const holderPda = (mint, owner) => pda([Buffer.from('holder'), mint.toBuffer(), owner.toBuffer()]);
const vaultPda = (mint) => pda([Buffer.from('rentvault'), mint.toBuffer()]);
const metaPda = (mint) => pda([Buffer.from('extra-account-metas'), mint.toBuffer()]);
const pricePda = (mint) => pda([Buffer.from('price'), mint.toBuffer()]);
const regPda = (wallet) => PublicKey.findProgramAddressSync([Buffer.from('registration'), wallet.toBuffer()], REGISTRY)[0];
const ecoPda = () => PublicKey.findProgramAddressSync([Buffer.from('ecosystem')], REGISTRY)[0];

// ---------- tx plumbing (engine trial idiom) ----------
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
  ['ecosystem gate: not registered', 'NotRegistered'],
  ['attested for ecosystem', 'WrongEcosystem'],
  ['not registered', 'NotRegistered'],
  ['max wallet exceeded', 'MaxWalletExceeded'],
  ['bad registration account', 'BadRegistration'],
  ['invalid instruction data', 'InvalidInstructionData'],
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
const holderBytes = (mint, owner) => { const d = acctData(holderPda(mint, getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID))); return d ? { registered: d[1], ecosystem: d[2] } : null; };

// ---------- config payload (mirrors engine parse_config_payload) ----------
function configPayload({ mode, authority, rules = [], venues = [], exemptions = [] }, tag) {
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
  payer.publicKey.toBuffer().copy(tail, 11);
  parts.push(tail);
  return Buffer.concat(parts);
}
const ecoParams = (eco) => { const p = Buffer.alloc(64); p[0] = eco; return p; };
const maxWalletParams = (bps) => { const p = Buffer.alloc(64); p.writeUInt16LE(bps, 0); return p; };

async function launchMint(cfg, { fundVault = 50_000_000 } = {}) {
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
  const payerAta = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey, false, TOKEN_2022);
  await send([
    createAssociatedTokenAccountInstruction(payer.publicKey, payerAta, payer.publicKey, mint.publicKey, TOKEN_2022),
    createMintToInstruction(mint.publicKey, payerAta, payer.publicKey, SUPPLY, [], TOKEN_2022),
  ], [payer], 'mint supply to payer');
  return { mint: mint.publicKey, payerAta };
}

async function ataFor(mintPk, walletKp) {
  const ata = getAssociatedTokenAddressSync(mintPk, walletKp.publicKey, false, TOKEN_2022);
  await send([createAssociatedTokenAccountInstruction(payer.publicKey, ata, walletKp.publicKey, mintPk, TOKEN_2022)], [payer], 'actor ATA');
  return ata;
}

// Hook transfer, manual meta resolution (engine trial idiom, tail v2).
function hookTransferIx(mintPk, source, dest, owner, amountRaw) {
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked
  data.writeBigUInt64LE(BigInt(amountRaw), 1);
  data[9] = 9;
  const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });
  return new TransactionInstruction({
    programId: TOKEN_2022, data,
    keys: [
      K(source, false, true), K(mintPk, false, false), K(dest, false, true), K(owner, true, false),
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
const xfer = (m, toAta, wholeTokens) =>
  send([hookTransferIx(m.mint, m.payerAta, toAta, payer.publicKey, BigInt(wholeTokens) * WHOLE)], [payer], 'xfer');
const tryXfer = (m, toAta, wholeTokens) => attempt(() => xfer(m, toAta, wholeTokens));

// SyncRegistered path (b): permissionless mirror from the Registration PDA.
const syncIx = (mintPk, owner) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([4, 0]),
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: false },
    { pubkey: configPda(mintPk), isSigner: false, isWritable: false },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: holderPda(mintPk, getAssociatedTokenAddressSync(mintPk, owner, true, TOKEN_2022_PROGRAM_ID)), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: regPda(owner), isSigner: false, isWritable: false },
  ],
});
// SyncRegistered path (a): config-authority direct set (data [4, registered, ecosystem]).
const syncAuthorityIx = (mintPk, owner, registered, ecosystem) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([4, registered, ecosystem]),
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: false },
    { pubkey: configPda(mintPk), isSigner: false, isWritable: false },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: holderPda(mintPk, getAssociatedTokenAddressSync(mintPk, owner, true, TOKEN_2022_PROGRAM_ID)), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});

// ---------- registry instruction builders ----------
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
const initEcoIx = (authority) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.from([3]),
  keys: [
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: ecoPda(), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
const setAttesterIx = (authority, eco, attesterPk) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.concat([Buffer.from([4, eco]), attesterPk.toBuffer()]),
  keys: [
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: ecoPda(), isSigner: false, isWritable: true },
  ],
});
const registerAttestedIx = (wallet, attester, kind, eco) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.from([5, kind, eco]),
  keys: [
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: attester, isSigner: true, isWritable: false },
    { pubkey: regPda(wallet), isSigner: false, isWritable: true },
    { pubkey: ecoPda(), isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});

// ================= PROOF =================
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
console.log('engine:', ENGINE.toBase58(), '| registry:', REGISTRY.toBase58());

console.log('=== E0: registry attestation setup ===');
const ecoAuthority = fund(Keypair.generate());
const museAttester = Keypair.generate();
const fomoAttester = Keypair.generate();
await send([initEcoIx(ecoAuthority.publicKey)], [ecoAuthority], 'init eco config');
await send([setAttesterIx(ecoAuthority.publicKey, ECO_MUSE, museAttester.publicKey)], [ecoAuthority], 'set muse attester');
await send([setAttesterIx(ecoAuthority.publicKey, ECO_FOMO, fomoAttester.publicKey)], [ecoAuthority], 'set fomo attester');
ok(acctData(ecoPda()) !== null, 'E0 ecosystem config live with Muse + FOMO attesters');

const museW = fund(Keypair.generate());
const fomoW = fund(Keypair.generate());
const plainW = fund(Keypair.generate());
const ghostW = fund(Keypair.generate());
await send([registerAttestedIx(museW.publicKey, museAttester.publicKey, 1, ECO_MUSE)], [museW, museAttester], 'muse wallet attested-register');
await send([registerAttestedIx(fomoW.publicKey, fomoAttester.publicKey, 1, ECO_FOMO)], [fomoW, fomoAttester], 'fomo wallet attested-register');
await send([registryRegisterIx(plainW.publicKey, 1)], [plainW], 'plain wallet self-register');
ok(acctData(regPda(museW.publicKey))[44] === ECO_MUSE, 'E0 muse wallet carries the Muse tag');
ok(acctData(regPda(fomoW.publicKey))[44] === ECO_FOMO, 'E0 fomo wallet carries the FOMO tag');
ok(acctData(regPda(plainW.publicKey))[44] === 0, 'E0 plain wallet carries no tag');
ok(acctData(regPda(ghostW.publicKey)) === null, 'E0 ghost wallet unregistered');

console.log('=== E1: launch the gated mints + AGTR-shape regression mint ===');
const mMuse = await launchMint({ mode: 0, authority: payer.publicKey, rules: [{ id: 17, params: ecoParams(ECO_MUSE) }] });
const mFomo = await launchMint({ mode: 0, authority: payer.publicKey, rules: [{ id: 17, params: ecoParams(ECO_FOMO) }] });
const mAgtr = await launchMint({ mode: 0, authority: payer.publicKey, rules: [{ id: 3 }, { id: 9, params: maxWalletParams(500) }] });
ok(acctData(configPda(mMuse.mint)) !== null && acctData(configPda(mFomo.mint)) !== null, 'E1 Muse-gated and FOMO-gated configs live');

console.log('=== E2: attested Muse wallet receives the Muse-gated token ===');
const museAtaM = await ataFor(mMuse.mint, museW);
await send([syncIx(mMuse.mint, museW.publicKey)], [payer], 'sync muse wallet (Muse mint)');
{
  const h = holderBytes(mMuse.mint, museW.publicKey);
  ok(h.registered === 1 && h.ecosystem === ECO_MUSE, 'E2 sync mirrored registered=1, ecosystem=Muse');
}
await xfer(mMuse, museAtaM, 1000);
ok(bal(museAtaM) === 1000n * WHOLE, 'E2 Muse wallet received 1000 Muse-gated tokens');

console.log('=== E3: the same wallet is vetoed by the FOMO gate (wrong ecosystem) ===');
const museAtaF = await ataFor(mFomo.mint, museW);
await send([syncIx(mFomo.mint, museW.publicKey)], [payer], 'sync muse wallet (FOMO mint)');
ok((await tryXfer(mFomo, museAtaF, 1000)) === 'WrongEcosystem', 'E3 Muse-tagged wallet vetoed by FOMO gate (WrongEcosystem)');
ok(bal(museAtaF) === 0n, 'E3 balance still 0 after veto');

console.log('=== E4: FOMO wallet — accepted by its own gate, vetoed by Muse\'s ===');
const fomoAtaF = await ataFor(mFomo.mint, fomoW);
const fomoAtaM = await ataFor(mMuse.mint, fomoW);
await send([syncIx(mFomo.mint, fomoW.publicKey)], [payer], 'sync fomo wallet (FOMO mint)');
await xfer(mFomo, fomoAtaF, 1000);
ok(bal(fomoAtaF) === 1000n * WHOLE, 'E4 FOMO wallet received 1000 FOMO-gated tokens');
await send([syncIx(mMuse.mint, fomoW.publicKey)], [payer], 'sync fomo wallet (Muse mint)');
ok((await tryXfer(mMuse, fomoAtaM, 1000)) === 'WrongEcosystem', 'E4 FOMO-tagged wallet vetoed by Muse gate (WrongEcosystem)');
ok(bal(fomoAtaM) === 0n, 'E4 balance still 0 after veto');

console.log('=== E5: self-registered wallet (no tag) is vetoed by the ecosystem gate ===');
const plainAtaM = await ataFor(mMuse.mint, plainW);
await send([syncIx(mMuse.mint, plainW.publicKey)], [payer], 'sync plain wallet (Muse mint)');
{
  const h = holderBytes(mMuse.mint, plainW.publicKey);
  ok(h.registered === 1 && h.ecosystem === 0, 'E5 mirror shows registered=1, ecosystem=NONE');
}
ok((await tryXfer(mMuse, plainAtaM, 1000)) === 'WrongEcosystem', 'E5 untagged registration vetoed (WrongEcosystem, not NotRegistered)');
ok(bal(plainAtaM) === 0n, 'E5 balance still 0 after veto');

console.log('=== E6: unregistered wallet is vetoed NotRegistered (no sync at all) ===');
const ghostAtaM = await ataFor(mMuse.mint, ghostW);
ok((await tryXfer(mMuse, ghostAtaM, 1000)) === 'NotRegistered', 'E6 ghost vetoed NotRegistered');
{
  // The gate's lazy holder creation happens INSIDE the transfer transaction;
  // the veto rolls the whole transaction back, so no holder state persists —
  // a veto leaves zero side effects (the mirror is created by the first
  // sync or first successful receive instead).
  const h = holderBytes(mMuse.mint, ghostW.publicKey);
  ok(h === null, 'E6 veto rolled back atomically — no holder PDA persists after a vetoed receive');
}
ok(bal(ghostAtaM) === 0n, 'E6 balance still 0 after veto');

console.log('=== E7: deactivation + re-sync revokes; reactivation restores ===');
await send([registrySetActiveIx(museW.publicKey, 0)], [museW], 'muse wallet deactivates at registry');
await send([syncIx(mMuse.mint, museW.publicKey)], [payer], 're-sync muse wallet');
ok(holderBytes(mMuse.mint, museW.publicKey).registered === 0, 'E7 mirror dropped to registered=0 after deactivation');
ok((await tryXfer(mMuse, museAtaM, 1)) === 'NotRegistered', 'E7 receive vetoed while deactivated');
await send([registrySetActiveIx(museW.publicKey, 1)], [museW], 'muse wallet reactivates');
await send([syncIx(mMuse.mint, museW.publicKey)], [payer], 're-sync muse wallet again');
await xfer(mMuse, museAtaM, 1);
ok(bal(museAtaM) === 1001n * WHOLE, 'E7 receive restored after reactivation + sync');

console.log('=== E8: config-write validation rejects a meaningless gate ===');
{
  const badInit = async (eco) => {
    const mint = Keypair.generate();
    const len = getMintLen([ExtensionType.TransferHook]);
    const rent = svm.minimumBalanceForRentExemption(BigInt(len));
    await send([
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: Number(rent), programId: TOKEN_2022 }),
      createInitializeTransferHookInstruction(mint.publicKey, payer.publicKey, ENGINE, TOKEN_2022),
      createInitializeMintInstruction(mint.publicKey, 9, payer.publicKey, null, TOKEN_2022),
    ], [payer, mint], 'create bad-gate mint');
    return attempt(() => send([new TransactionInstruction({
      programId: ENGINE, data: configPayload({ mode: 0, authority: payer.publicKey, rules: [{ id: 17, params: ecoParams(eco) }] }, 1),
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: configPda(mint.publicKey), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    })], [payer], 'init bad-gate config'));
  };
  ok((await badInit(0)) === 'InvalidInstructionData', 'E8 gate requiring ecosystem 0 rejected at config write');
  ok((await badInit(17)) === 'InvalidInstructionData', 'E8 gate requiring ecosystem 17 (> MAX) rejected at config write');
}

console.log('=== E9: SyncRegistered path (a) — authority mirrors the ecosystem byte directly ===');
const authW = fund(Keypair.generate());
const authAtaF = await ataFor(mFomo.mint, authW);
await send([syncAuthorityIx(mFomo.mint, authW.publicKey, 1, ECO_FOMO)], [payer], 'authority sync (registered=1, ecosystem=FOMO)');
{
  const h = holderBytes(mFomo.mint, authW.publicKey);
  ok(h.registered === 1 && h.ecosystem === ECO_FOMO, 'E9 path (a) wrote both mirror bytes');
}
await xfer(mFomo, authAtaF, 10);
ok(bal(authAtaF) === 10n * WHOLE, 'E9 authority-mirrored wallet receives the FOMO-gated token');

console.log('=== E10: AGTR-shape config (rules 3 + 9) behaves identically on the new binary ===');
const museAtaA = await ataFor(mAgtr.mint, museW);
const ghostAtaA = await ataFor(mAgtr.mint, ghostW);
await send([syncIx(mAgtr.mint, museW.publicKey)], [payer], 'sync muse wallet (AGTR mint)');
await xfer(mAgtr, museAtaA, 500);
ok(bal(museAtaA) === 500n * WHOLE, 'E10 registered wallet receives AGTR-shape token (rules 3+9)');
ok((await tryXfer(mAgtr, ghostAtaA, 500)) === 'NotRegistered', 'E10 unregistered wallet still vetoed NotRegistered on the AGTR shape');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
fs.writeFileSync(path.join(DIR, 'ecosystem-gate-result.json'), JSON.stringify({ engine: ENGINE.toBase58(), registry: REGISTRY.toBase58(), pass, fail }, null, 2));
if (fail > 0) process.exit(1);

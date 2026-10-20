#!/usr/bin/env node
// harness.mjs — Workstream B correctness proof. NO broadcasts, NO signing
// keys beyond throwaway fixed test keypairs; the only funded pubkey used is
// fren's, referenced as fee payer for simulateTransaction (sigVerify off).
//
// For two specs (AGTR-shaped and a Basis-Latch spec) it builds every launch
// step TWICE:
//   REF     — builders transcribed from launch.mjs's LIVE execution blocks,
//             using helpers.generated.mjs (code sliced out of launch.mjs)
//   PRODUCT — the browser bundle's entry (createHookLaunch), same code the
//             composer page ships
// and asserts the instruction sequences are byte-identical (program, keys
// incl. signer/writable flags, data). It then simulateTransaction's the
// product transactions against mainnet RPC: steps that stand alone (L1, L2,
// L5) individually, and the state-dependent steps (L3/L4/L4b/L7) in sequence
// groups (simulation executes a tx's instructions against one bank clone,
// so [L2, L3, L4] etc. see each other's effects — no state persists after).
//
// L2 note: createPoolWithTransferHook reads the config account from chain.
// Both sides build it against AGTR's REAL mainnet config account (the
// launch.mjs code path after its own L1 has landed), with a fresh mint.
import fs from 'fs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, LAMPORTS_PER_SOL, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import * as H from './helpers.generated.mjs';
import { createHookLaunch } from './entry.mjs';
import { LAUNCH_TAG_SECRET } from './tag.mjs';

const TAG_KP = Keypair.fromSecretKey(Uint8Array.from(LAUNCH_TAG_SECRET));

const RPC = process.env.HOOK_RPC || 'https://api.mainnet-beta.solana.com';
const FREN = new PublicKey('FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP');
const AGTR = JSON.parse(fs.readFileSync('/home/hatch/workspace/aonly-site/hooks/agtr-record.json', 'utf8'));
const AGTR_CONFIG = new PublicKey(AGTR.addresses.dbcConfig);
const AGTR_MINT = new PublicKey(AGTR.addresses.mint);
const conn = new Connection(RPC, 'confirmed');
const client = new DynamicBondingCurveClient(conn, 'confirmed');

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, extra); } };

// ---------- fixed identities (deterministic across runs; sha256-derived —
// trivially-patterned seeds like 0x0b×32 are already squatted on mainnet) ----------
import { createHash } from 'crypto';
const seedOf = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const dbcConfigKp = Keypair.fromSeed(seedOf('hook-launcher-harness config v1'));
const baseMintKp = Keypair.fromSeed(seedOf('hook-launcher-harness mint v1'));

// ---------- reference builders (launch.mjs LIVE blocks, transcribed) ----------
function refPrep(spec) {
  const mode = H.MODES[String(spec.authorityMode ?? 'locked').toLowerCase()];
  const rules = (spec.rules ?? []).map((entry) => ({ id: H.ruleIdOf(entry), entry, enabled: entry.enabled !== false }));
  return {
    mode, rules,
    hasRule: (id) => rules.some((r) => r.id === id && r.enabled),
    decimals: spec.decimals ?? 6,
    thresholdSol: H.resolveGraduation(spec).thresholdSol,
    rentVaultSol: spec.rentVaultSol ?? 0.05,
    holderFees: H.resolveFees(spec).holderFees,
  };
}
function refAddresses(spec, configPk, mintPk) {
  const pool = H.deriveDbcPoolAddress(H.NATIVE_MINT, mintPk, configPk);
  const poolAuthority = H.deriveDbcPoolAuthority();
  const baseVault = H.deriveDbcTokenVaultAddress(pool, mintPk);
  const quoteVault = H.deriveDbcTokenVaultAddress(pool, H.NATIVE_MINT);
  const distState = H.distPda(mintPk);
  const distVault = getAssociatedTokenAddressSync(mintPk, distState, true, TOKEN_2022_PROGRAM_ID);
  return { pool, poolAuthority, baseVault, quoteVault, distState, distVault };
}
async function refBuild(stepId, spec, { configPk, mintPk, forPoolConfig }) {
  const p = refPrep(spec);
  const a = refAddresses(spec, configPk, mintPk);
  const launcher = FREN, authority = FREN, feeClaimer = FREN;
  switch (stepId) {
    case 'L1': {
      const tx = await client.partner.createConfigWithTransferHook({
        config: configPk, feeClaimer, leftoverReceiver: feeClaimer, payer: launcher.publicKey ?? launcher,
        quoteMint: H.NATIVE_MINT, transferHookProgram: H.ENGINE, ...H.curveConfig(p.thresholdSol, spec),
      });
      tx.add(H.buildTagMemoIx(TAG_KP.publicKey)); // Feature A — mirrors launch.mjs execute (memo carries the launch signer's co-signature)
      return tx;
    }
    case 'L2': {
      const tx = await client.creator.createPoolWithTransferHook({
        baseMint: mintPk, config: forPoolConfig, transferHookProgram: H.ENGINE,
        name: spec.name, symbol: spec.symbol, uri: H.resolveMetadata(spec).uri,
        payer: launcher, poolCreator: launcher,
      });
      tx.add(H.buildTagMemoIx(TAG_KP.publicKey)); // Feature A — mirrors launch.mjs execute
      return tx;
    }
    case 'L3': {
      const cfg = { mode: p.mode, authority, rules: p.rules, venues: [H.DBC_ID], exemptions: [a.poolAuthority, a.baseVault] };
      const ix = new TransactionInstruction({
        programId: H.ENGINE, data: H.configPayload(cfg, 1),
        keys: [H.K(launcher, true, true), H.K(mintPk, false, false), H.K(H.configPda(mintPk), false, true), H.K(SystemProgram.programId, false, false)],
      });
      return new Transaction().add(ix);
    }
    case 'L4': {
      const ix = new TransactionInstruction({
        programId: H.ENGINE, data: H.INIT_METAS_DISC,
        keys: [H.K(launcher, true, true), H.K(H.metaPda(mintPk), false, true), H.K(mintPk, false, false), H.K(SystemProgram.programId, false, false), H.K(H.configPda(mintPk), false, false)],
      });
      return new Transaction().add(ix);
    }
    case 'L4b': {
      const data = Buffer.concat([Buffer.from([6]), a.pool.toBuffer(), a.baseVault.toBuffer(), a.quoteVault.toBuffer(), Buffer.from([p.decimals, 9])]);
      const ix = new TransactionInstruction({
        programId: H.ENGINE, data,
        keys: [H.K(launcher, true, true), H.K(mintPk, false, false), H.K(H.configPda(mintPk), false, false), H.K(H.pricePda(mintPk), false, true), H.K(SystemProgram.programId, false, false)],
      });
      return new Transaction().add(ix);
    }
    case 'L5':
      return new Transaction().add(SystemProgram.transfer({ fromPubkey: launcher, toPubkey: H.rentVaultPda(mintPk), lamports: Math.round(p.rentVaultSol * LAMPORTS_PER_SOL) }));
    case 'L7': {
      const cut = p.holderFees.callerCutBps;
      const data = Buffer.from([0, cut & 0xff, (cut >> 8) & 0xff]);
      const createVault = createAssociatedTokenAccountInstruction(launcher, a.distVault, a.distState, mintPk, TOKEN_2022_PROGRAM_ID);
      const init = new TransactionInstruction({
        programId: H.DISTRIBUTOR, data,
        keys: [H.K(launcher, true, true), H.K(mintPk, false, false), H.K(a.distVault, false, false), H.K(a.distState, false, true), H.K(SystemProgram.programId, false, false)],
      });
      return new Transaction().add(createVault, init);
    }
    case 'L7b': {
      const holderPda = H.pdaE([Buffer.from('holder'), mintPk.toBuffer(), a.distVault.toBuffer()]);
      const ix = new TransactionInstruction({
        programId: H.ENGINE, data: Buffer.from([4, 1]),
        keys: [H.K(launcher, true, true), H.K(mintPk, false, false), H.K(H.configPda(mintPk), false, false), H.K(a.distState, false, false), H.K(holderPda, false, true), H.K(SystemProgram.programId, false, false)],
      });
      return new Transaction().add(ix);
    }
    default: throw new Error('ref: unknown step ' + stepId);
  }
}

// ---------- comparison ----------
function ixShape(tx) {
  return tx.instructions.map((ix) => ({
    program: ix.programId.toBase58(),
    keys: ix.keys.map((k) => `${k.pubkey.toBase58()}${k.isSigner ? 's' : ''}${k.isWritable ? 'w' : ''}`),
    data: Buffer.from(ix.data).toString('hex'),
  }));
}
function firstDiff(a, b) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja === jb) return '';
  for (let i = 0; i < Math.min(ja.length, jb.length); i++) if (ja[i] !== jb[i]) return `at char ${i}: ref …${ja.slice(Math.max(0, i - 40), i + 40)}… vs prod …${jb.slice(Math.max(0, i - 40), i + 40)}…`;
  return `length ${ja.length} vs ${jb.length}`;
}

// ---------- raw RPC (launch.mjs pattern) ----------
const rpc = async (method, params) => {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error));
      return j.result;
    } catch (e) { lastErr = e; await new Promise((res) => setTimeout(res, 1500 * (attempt + 1))); }
  }
  throw lastErr;
};
async function simulate(tx, label) {
  const blockhash = (await rpc('getLatestBlockhash', [{ commitment: 'processed' }])).value.blockhash;
  const build = (withCb) => {
    const t = new Transaction();
    if (withCb) t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    for (const ix of tx.instructions) t.add(ix);
    t.feePayer = FREN;
    t.recentBlockhash = blockhash;
    return t;
  };
  let t = build(true);
  let note = '';
  // Wire-size packing (simulation artifact only): sequence-group combos
  // pack several on-chain-separate steps into one legacy transaction;
  // with a real metadata URI in L2 (discovery fix) the largest combo
  // exceeds the 1232-byte wire limit with the compute-budget ix added.
  // The CB ix only restates the 1.4M simulation cap, so when the combo
  // would overflow it is dropped — every REAL instruction still runs.
  // (web3's serialize THROWS on oversize rather than returning bytes,
  // so the probe is a try/catch.)
  let b64;
  try {
    b64 = t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  } catch {
    t = build(false);
    note = ' [cb-ix dropped: wire-size packing]';
    b64 = t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }
  const res = await rpc('simulateTransaction', [b64, { encoding: 'base64', sigVerify: false, commitment: 'processed' }]);
  const v = res.value;
  if (v.err) {
    const logs = (v.logs || []).slice(-4).join(' | ');
    ok(false, `simulate ${label}`, `err=${JSON.stringify(v.err)} logs: ${logs}`);
    return false;
  }
  ok(true, `simulate ${label}${note} (units ${v.unitsConsumed})`);
  return true;
}

// ---------- runs ----------
const HL = createHookLaunch();
const SPECS = [
  ['AGTR spec', { name: 'Agent Reserve', symbol: 'AGTR', supply: 1000000000, decimals: 6, authorityMode: 'locked', rules: [{ id: 3 }, { id: 9, capBps: 500 }], holderFees: { enabled: true, callerCutBps: 100 }, seedSol: 0, migrationThresholdSol: 42, rentVaultSol: 0.05 }],
  ['latch spec', { name: 'First Dip', symbol: 'DIP', supply: 1000000000, decimals: 6, authorityMode: 'locked', rules: [{ id: 1, mode: 'latch', maxStaleSecs: 300 }], holderFees: { enabled: true, callerCutBps: 100 }, seedSol: 0, migrationThresholdSol: 42, rentVaultSol: 0.05 }],
  ['creator-fee spec', { name: 'Creator Cut', symbol: 'CUT', supply: 1000000000, decimals: 6, authorityMode: 'creator', rules: [], feeBps: 250, feeDestination: 'creator', seedSol: 0, migrationThresholdSol: 42, rentVaultSol: 0.05 }],
];

for (const [label, spec] of SPECS) {
  console.log(`\n== ${label} ==`);
  const steps = HL.applicableSteps(spec);
  const prodTxs = {}, refTxs = {};
  for (const step of steps) {
    // product session: fresh fixed keypairs; L2 reads AGTR's real config
    const sessOpts = step === 'L2'
      ? { dbcConfigPubkey: AGTR_CONFIG.toBase58(), mintSecret: Array.from(baseMintKp.secretKey) }
      : { dbcConfigSecret: Array.from(dbcConfigKp.secretKey), mintSecret: Array.from(baseMintKp.secretKey) };
    const sess = HL.createSession(spec, sessOpts);
    prodTxs[step] = await HL.buildStepTx(sess, step, { connection: conn, launcherPubkey: FREN });
    refTxs[step] = await refBuild(step, spec, { configPk: dbcConfigKp.publicKey, mintPk: baseMintKp.publicKey, forPoolConfig: AGTR_CONFIG });
    const eq = JSON.stringify(ixShape(prodTxs[step])) === JSON.stringify(ixShape(refTxs[step]));
    ok(eq, `${step} instructions identical (ref vs in-browser builder)`, eq ? '' : firstDiff(ixShape(refTxs[step]), ixShape(prodTxs[step])));
    if (step === 'L2') {
      // Feature A explicit: the product L2 set ends with the tag memo —
      // SPL Memo program, marker-text data, sole key = tag key, signer,
      // read-only — and the memo is the ONLY difference from the
      // pre-tag L2 shape (covered by the ref equality above, since the
      // ref carries the same memo).
      const shape = ixShape(prodTxs[step]);
      const memo = shape[shape.length - 1];
      ok(memo.program === H.MEMO_PROGRAM_ID.toBase58()
        && Buffer.from(memo.data, 'hex').toString('utf8') === H.LAUNCH_TAG_MARKER
        && memo.keys.length === 1 && memo.keys[0] === `${TAG_KP.publicKey.toBase58()}s`,
        'L2 tag memo present in browser-built set (memo program, marker data, sole read-only tag signer)');
      const signers = HL.partialSigners(HL.createSession(spec, { dbcConfigSecret: Array.from(dbcConfigKp.secretKey), mintSecret: Array.from(baseMintKp.secretKey) }), 'L2');
      ok(signers.some((k) => k.publicKey.equals(TAG_KP.publicKey)), 'L2 partial signers include the tag keypair');
    }
  }
  // standalone simulations for the steps that need no launch-local state
  for (const step of ['L1', 'L2', 'L5']) if (prodTxs[step]) await simulate(prodTxs[step], `${label} ${step}`);
  // sequence-group simulations for state-dependent steps
  const groups = [['L2', 'L3', 'L4']];
  if (prodTxs['L4b']) groups.push(['L2', 'L3', 'L4b']);
  if (prodTxs['L7']) groups.push(['L2', 'L3', 'L7']);
  // (No L2+L3+L7+L7b group: the combined legacy transaction exceeds the
  // 1232-byte wire limit — a harness artifact, since on-chain each step is
  // its own transaction. L7b is instead simulated against AGTR's real
  // identities below, where its config + distributor state already exist.)
  for (const g of groups) {
    const combo = new Transaction();
    for (const s of g) for (const ix of prodTxs[s].instructions) {
      // Simulation-artifact packing: the group combo exists so stateful
      // steps see each other's effects in one bank clone. The launch
      // tag memo (Feature A) is state-neutral, is already simulated in
      // the standalone L2 run above (817 bytes, fits), and its extra
      // signer costs 148 bytes in combo context — enough to push these
      // combos past the 1232-byte wire limit (1257 / 1357). On-chain
      // every step is its own transaction, so the memo is stripped
      // ONLY here, only for simulation packing.
      if (ix.programId.equals(H.MEMO_PROGRAM_ID)) continue;
      combo.add(ix);
    }
    await simulate(combo, `${label} sequence ${g.join('+')}`);
  }
  // L4b against AGTR's real identities (its price feed PDA does not exist
  // yet — AGTR carries no rule 1 — while its config/pool/vaults do)
  if (prodTxs['L4b']) {
    const sess = HL.createSession(spec, { dbcConfigPubkey: AGTR_CONFIG.toBase58(), mintPubkey: AGTR_MINT.toBase58() });
    const tx = await HL.buildStepTx(sess, 'L4b', { connection: conn, launcherPubkey: FREN });
    const ref = await refBuild('L4b', spec, { configPk: AGTR_CONFIG, mintPk: AGTR_MINT, forPoolConfig: AGTR_CONFIG });
    const eq = JSON.stringify(ixShape(tx)) === JSON.stringify(ixShape(ref));
    ok(eq, 'L4b (AGTR identities) instructions identical', eq ? '' : firstDiff(ixShape(ref), ixShape(tx)));
    await simulate(tx, `${label} L4b standalone (AGTR identities)`);
  }
  // L7b against AGTR's real identities: AGTR's config + distributor state
  // exist on mainnet and fren IS its config authority. ENGINE v3 NOTE:
  // the in-browser builder derives the mirror under the v3 engine
  // (record keyed by the vault ATA). This was a deployment tripwire
  // while mainnet ran v2 (the live simulation had to reject with
  // InvalidSeeds). WINDOW 2 (2026-10-16): the FIXED v3 build deployed
  // (tag-9 update-then-resize; deploy/DEPLOY-RECORD-V3.md second-window
  // section) and both live lists were flipped + all records migrated,
  // so the positive simulation is restored: the step must now simulate
  // clean, or with AlreadyInit (Custom 14) once the mirror record
  // exists. The byte-equality check above remains the durable builder
  // proof.
  if (prodTxs['L7b'] && label === 'AGTR spec') {
    const sess = HL.createSession(spec, { dbcConfigPubkey: AGTR_CONFIG.toBase58(), mintPubkey: AGTR_MINT.toBase58() });
    const tx = await HL.buildStepTx(sess, 'L7b', { connection: conn, launcherPubkey: FREN });
    const ref = await refBuild('L7b', spec, { configPk: AGTR_CONFIG, mintPk: AGTR_MINT, forPoolConfig: AGTR_CONFIG });
    const eq = JSON.stringify(ixShape(tx)) === JSON.stringify(ixShape(ref));
    ok(eq, 'L7b (AGTR identities) instructions identical', eq ? '' : firstDiff(ixShape(ref), ixShape(tx)));
    const t = new Transaction();
    t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    for (const ix of tx.instructions) t.add(ix);
    t.feePayer = FREN;
    t.recentBlockhash = (await rpc('getLatestBlockhash', [{ commitment: 'processed' }])).value.blockhash;
    const b64 = t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const res = await rpc('simulateTransaction', [b64, { encoding: 'base64', sigVerify: false, commitment: 'processed' }]);
    const errStr = JSON.stringify(res.value.err || '');
    ok(res.value.err === null || errStr.includes('"Custom":14'), 'simulate AGTR spec L7b standalone (AGTR identities) — v3 ix vs live v3 engine simulates clean or AlreadyInit (restored positive form, window 2)', `err=${errStr}`);
  }
}

console.log(`\n==== EQUIVALENCE + SIMULATION HARNESS: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// trial-launch-features.mjs — Phase 4 (Parity Polish) trial surface:
//   Feature A — LAUNCH SIGNER: the dedicated fundless keypair
//     (deploy/launcher-tag.json) — LAUNCH_SIGNER in the code — co-signs
//     every creation transaction READ-ONLY. Placement (2026-10-17,
//     copied from BADGER's verified creation tx: their platform signer
//     sits in the message's signer set, read-only, referenced by NO
//     create instruction): on L1 a pure co-signer in exactly that
//     placement; on L2 the same co-signature plus one SPL Memo v2
//     instruction appended (sole signer = the launch signer, memo text
//     = the fixed marker). Section G proves the placement on the
//     COMPILED messages. Byte-compat: the L2 instruction set EXCLUDING
//     the memo hashes identically to the pre-change baselines captured
//     2026-10-16 from the pre-tag code with the harness identities
//     (config = AGTR's real mainnet config, mint seed
//     'hook-launcher-harness mint v1', payer FREN).
//   Feature B — BUNDLED DEV BUY (spec field devBuySol): validation,
//     plan step order (register/sync for gate rules, crank-then-buy for
//     rule 1), and the unset-default guarantee (AGTR + Latch record
//     specs gain NO new DEV-BUY plan lines and keep their step
//     labels — the one deliberate exception is the discovery-fix L0
//     metadata step (2026-10-16), which every launch now opens with;
//     section E's baselines were recaptured for it).
//   The LiteSVM end-to-end dev-buy proof lives in
//   ../integration/dbc-devbuy.mjs (first swap post-activation, launcher
//   receives, rule-1 Holder PDA created).
//   node trial-launch-features.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import * as H from './browser-src/helpers.generated.mjs';
import { createHookLaunch } from './browser-src/entry.mjs';
import { LAUNCH_TAG_SECRET } from './browser-src/tag.mjs';

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, extra); } };
const throws = (fn, frag) => { try { fn(); return false; } catch (e) { return frag == null || String(e.message).includes(frag); } };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const TAG_KP = Keypair.fromSecretKey(Uint8Array.from(LAUNCH_TAG_SECRET));
const FREN = new PublicKey('FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP');
const AGTR_REC = JSON.parse(fs.readFileSync(new URL('../deploy/launch-record-agtr.json', import.meta.url), 'utf8'));
const LATCH_REC = JSON.parse(fs.readFileSync(new URL('../deploy/launch-record-latch.json', import.meta.url), 'utf8'));
const AGTR_CONFIG = new PublicKey(AGTR_REC.addresses.dbcConfig);

console.log('== A. launch tag identity ==');
{
  const deploySecret = JSON.parse(fs.readFileSync(new URL('../deploy/launcher-tag.json', import.meta.url), 'utf8'));
  const deployKp = Keypair.fromSecretKey(Uint8Array.from(deploySecret));
  ok(deployKp.publicKey.equals(TAG_KP.publicKey), 'A1 embedded bundle tag key == deploy/launcher-tag.json key (same pubkey)', TAG_KP.publicKey.toBase58());
  ok(H.LAUNCH_TAG_MARKER === 'hook-launcher:v1', 'A2 marker text is the fixed "hook-launcher:v1"');
  ok(H.MEMO_PROGRAM_ID.toBase58() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'A3 memo program is SPL Memo v2');
  const ix = H.buildTagMemoIx(TAG_KP.publicKey);
  ok(ix.programId.equals(H.MEMO_PROGRAM_ID) && ix.keys.length === 1 && ix.keys[0].pubkey.equals(TAG_KP.publicKey)
    && ix.keys[0].isSigner === true && ix.keys[0].isWritable === false
    && ix.data.toString('utf8') === 'hook-launcher:v1',
    'A4 buildTagMemoIx shape: memo program, marker data, sole read-only signer = tag key');
  const src = fs.readFileSync(new URL('./launch.mjs', import.meta.url), 'utf8');
  ok(src.includes('tx.add(buildTagMemoIx(tagKeypair.publicKey))') && src.includes('[launcher, baseMint, tagKeypair]'),
    'A5 launch.mjs execute path appends the memo to L2 and adds the tag keypair as a signer');
  const recText = src.slice(src.indexOf('const record = {'), src.indexOf('fs.writeFileSync(recordPath'));
  ok(!recText.includes('secretKey') && recText.includes('launchTag'), 'A6 launch record carries the tag pubkey/marker only — never the secret');
  ok(src.includes('const LAUNCH_SIGNER = tagKeypair.publicKey') && src.includes('[launcher, dbcConfig, tagKeypair]'),
    'A7 LAUNCH_SIGNER is named in launch.mjs and co-signs the L1 creation transaction (pure co-signer, no instruction added)');
  ok(recText.includes('launchSigner: LAUNCH_SIGNER.toBase58()'), 'A8 launch record carries the top-level launchSigner field');
  const esrc = fs.readFileSync(new URL('./browser-src/entry.mjs', import.meta.url), 'utf8');
  ok(esrc.includes('const LAUNCH_SIGNER = TAG_KP.publicKey') && esrc.includes('launchSigner: B58(LAUNCH_SIGNER)')
    && esrc.includes("if (stepId === 'L1') return [...(kps.dbcConfig ? [kps.dbcConfig] : []), TAG_KP];"),
    'A9 browser entry mirrors it: LAUNCH_SIGNER named, L1 partial signers include the tag keypair, record carries launchSigner');
}

console.log('== B. L2 byte-compat (excluding the memo) + browser parity ==');
// Baselines RECAPTURED 2026-10-16 for the discovery-fix template: the
// L2 pool instruction now carries the resolved metadata URI
// (resolveMetadata — the record specs derive
// https://agentonly.fun/hooks/<slug>.json) instead of the pre-fix
// empty uri "". The pre-discovery-fix baselines (uri "") were
// 054f4605… (agtr) and ef56665e… (latch) — kept here so the deliberate
// break stays visible in the record. Harness identities unchanged
// (config = AGTR's real mainnet config, mint seed
// 'hook-launcher-harness mint v1', payer FREN; shape = program + keys
// w/ flags + data hex, JSON-hashed).
const L2_BASE = {
  agtr: '9831532b9b798adc99a8fc6ac25d58cd6e30716f785e1e65431a85ab215c732a',
  latch: 'c968a79240eccfbbfe8d3d0a13944baa21550951cdb3400e5428486f0cfb140c',
};
const seedOf = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const dbcConfigKp = Keypair.fromSeed(seedOf('hook-launcher-harness config v1'));
const mintKp = Keypair.fromSeed(seedOf('hook-launcher-harness mint v1'));
const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const client = new DynamicBondingCurveClient(conn, 'confirmed');
const shape = (tx) => tx.instructions.map((ix) => ({
  program: ix.programId.toBase58(),
  keys: ix.keys.map((k) => `${k.pubkey.toBase58()}${k.isSigner ? 's' : ''}${k.isWritable ? 'w' : ''}`),
  data: Buffer.from(ix.data).toString('hex'),
}));
const isMemo = (s) => s.program === H.MEMO_PROGRAM_ID.toBase58();
async function cliStyleL2(spec) {
  // Exactly the launch.mjs execute construction: SDK pool build, then
  // the memo appended, tag keypair among the signers (signers do not
  // enter the instruction shape; the memo key flags do).
  const tx = await client.creator.createPoolWithTransferHook({
    baseMint: mintKp.publicKey, config: AGTR_CONFIG, transferHookProgram: H.ENGINE,
    name: spec.name, symbol: spec.symbol, uri: H.resolveMetadata(spec).uri,
    payer: FREN, poolCreator: FREN,
  });
  tx.add(H.buildTagMemoIx(TAG_KP.publicKey));
  return tx;
}
{
  for (const [label, spec, base] of [['AGTR', AGTR_REC.spec, L2_BASE.agtr], ['Latch', LATCH_REC.spec, L2_BASE.latch]]) {
    const tx = await cliStyleL2(spec);
    const sh = shape(tx);
    ok(sh.length === 2 && isMemo(sh[1]) && !isMemo(sh[0]), `B-${label} CLI-style L2 = [pool ix, tag memo] — memo present, appended last, nowhere else`);
    ok(sha(Buffer.from(JSON.stringify(sh.filter((s) => !isMemo(s))))) === base, `B-${label} L2 instruction set EXCLUDING the memo hashes identically to the post-discovery-fix baseline`);
  }
  // Browser-built L2 (product entry, same session shape as the harness):
  const HL = createHookLaunch();
  const spec = { name: 'Agent Reserve', symbol: 'AGTR', supply: 1000000000, decimals: 6, authorityMode: 'locked', rules: [{ id: 3 }, { id: 9, capBps: 500 }], holderFees: { enabled: true, callerCutBps: 100 }, seedSol: 0, migrationThresholdSol: 42, rentVaultSol: 0.05 };
  const sess = HL.createSession(spec, { dbcConfigPubkey: AGTR_CONFIG.toBase58(), mintSecret: Array.from(mintKp.secretKey) });
  const prodTx = await HL.buildStepTx(sess, 'L2', { connection: conn, launcherPubkey: FREN });
  const prodShape = shape(prodTx);
  const cliShape = shape(await cliStyleL2(spec));
  ok(JSON.stringify(prodShape) === JSON.stringify(cliShape), 'B-browser browser-built L2 instruction set is byte-identical to the CLI-built set (memo included)');
  const memo = prodShape[prodShape.length - 1];
  ok(isMemo(memo) && Buffer.from(memo.data, 'hex').toString('utf8') === 'hook-launcher:v1' && memo.keys.length === 1 && memo.keys[0] === `${TAG_KP.publicKey.toBase58()}s`,
    'B-browser browser L2 carries the same memo: program, marker data, sole read-only tag signer');
  ok(HL.launchTag.pubkey === TAG_KP.publicKey.toBase58() && HL.partialSigners(sess, 'L2').some((k) => k.publicKey.equals(TAG_KP.publicKey)),
    'B-browser bundle exposes the tag pubkey and partially signs L2 with the tag keypair');
}

console.log('== C. dev buy validation ==');
{
  ok(H.resolveDevBuy({}) === null && H.resolveDevBuy({ devBuySol: undefined }) === null, 'C1 devBuySol unset → null (today\'s behavior exactly)');
  ok(H.resolveDevBuy({ devBuySol: 0.25 }).lamports === 250_000_000, 'C2 devBuySol 0.25 → {sol, lamports 250000000}');
  ok(H.resolveDevBuy({ devBuySol: H.DEV_BUY_MAX_SOL }).sol === H.DEV_BUY_MAX_SOL, `C3 devBuySol at the cap (${H.DEV_BUY_MAX_SOL} SOL) accepted`);
  ok(throws(() => H.resolveDevBuy({ devBuySol: -1 }), 'positive'), 'C4 negative devBuySol → hard error');
  ok(throws(() => H.resolveDevBuy({ devBuySol: 0 }), 'positive'), 'C5 zero devBuySol → hard error');
  ok(throws(() => H.resolveDevBuy({ devBuySol: H.DEV_BUY_MAX_SOL + 1 }), 'cap'), 'C6 over-cap devBuySol → hard error');
  ok(throws(() => H.resolveDevBuy({ devBuySol: '0.5' }), 'positive number'), 'C7 string devBuySol → hard error');
  ok(throws(() => H.validateSpec({ name: 'T', symbol: 'T', devBuySol: -2 }), 'devBuySol'), 'C8 validateSpec surfaces the devBuySol error (dry-run + browser share it)');
}

console.log('== D. dev buy plan order (CLI dry-run) ==');
function dryRun(specObj) {
  const f = path.join(os.tmpdir(), `trial-feat-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(specObj));
  const r = spawnSync(process.execPath, ['launch.mjs', f, '--dry-run'], { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  fs.unlinkSync(f);
  return r;
}
const labelsOf = (stdout) => [...stdout.matchAll(/^ {2}([A-Z0-9]+[a-z]?)\. /gm)].map((m) => m[1]);
{
  const r1 = dryRun({ name: 'LatchDev', symbol: 'LDV', rules: [{ id: 1, mode: 'graduated', maxStaleSecs: 300, vestingSecs: 432000, dipMultBps: 20000, baseFracBps: 0 }], holderFees: { enabled: false }, devBuySol: 0.25 });
  const lab1 = labelsOf(r1.stdout);
  ok(r1.status === 0 && lab1.includes('L8c') && lab1.includes('L9') && !lab1.includes('L8') && !lab1.includes('L8b'),
    'D1 devBuy + rule 1: plan has crank (L8c) + dev buy (L9), no register/sync steps', lab1.join(','));
  ok(lab1.indexOf('L8c') > lab1.indexOf('L5') && lab1.indexOf('L8c') < lab1.indexOf('L9'), 'D2 crank lands after activation (L5) and BEFORE the buy (L9) — the Latch order');
  ok(r1.stdout.includes('NOT atomic with activation') && r1.stdout.includes('first swap after activation'), 'D3 plan states the honest atomicity guarantee verbatim');
  const r3 = dryRun({ name: 'GateDev', symbol: 'GDV', rules: [{ id: 3 }], holderFees: { enabled: false }, devBuySol: 0.5 });
  const lab3 = labelsOf(r3.stdout);
  ok(r3.status === 0 && lab3.includes('L8') && lab3.includes('L8b') && lab3.includes('L9') && !lab3.includes('L8c'),
    'D4 devBuy + rule 3: plan has register (L8) + sync (L8b) + buy (L9), no crank', lab3.join(','));
  ok(r3.stdout.includes('skipped automatically if a Registration PDA'), 'D5 register step is documented as conditional (skipped if already registered)');
  const r17 = dryRun({ name: 'EcoDev', symbol: 'EDV', rules: [{ rule: 'muse-only' }], holderFees: { enabled: false }, devBuySol: 0.5 });
  ok(r17.status === 0 && labelsOf(r17.stdout).includes('L8') && r17.stdout.includes('attester'), 'D6 devBuy + rule 17: register/sync steps present + the attestation limit stated in the plan');
  const bad = dryRun({ name: 'Bad', symbol: 'BAD', rules: [], devBuySol: -1 });
  ok(bad.status === 1 && (bad.stderr + bad.stdout).includes('devBuySol'), 'D7 invalid devBuySol: dry-run refuses (exit 1)');
}

console.log('== E. unset default: AGTR + Latch plans gain NO dev-buy steps ==');
// Baselines recaptured 2026-10-16 for the discovery-fix template: the
// plan now opens with the L0 metadata step (+3 lines) — the one
// deliberate plan-shape change. The invariant this section protects is
// unchanged: with devBuySol unset, the record specs gain no dev-buy
// steps and every other step label/order is identical. (Pre-discovery-
// fix baselines: labels without L0, 40 / 38 lines.)
const PLAN_BASE = {
  agtr: { labels: ['L0', 'L1', 'FEE', 'GRADUATION', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L7b'], lines: 43 },
  latch: { labels: ['L0', 'L1', 'FEE', 'GRADUATION', 'L2', 'L3', 'L4', 'L4b', 'L5', 'L6'], lines: 41 },
};
{
  for (const [label, spec, base] of [['agtr', AGTR_REC.spec, PLAN_BASE.agtr], ['latch', LATCH_REC.spec, PLAN_BASE.latch]]) {
    const r = dryRun(spec);
    ok(r.status === 0 && JSON.stringify(labelsOf(r.stdout)) === JSON.stringify(base.labels) && r.stdout.split('\n').length - 1 === base.lines,
      `E-${label} record spec (no devBuySol): plan step labels + line count identical to the discovery-fix baseline`,
      `labels=${labelsOf(r.stdout).join(',')} lines=${r.stdout.split('\n').length - 1}`);
    ok(!r.stdout.includes('DEV BUY') && !r.stdout.includes('dev buy'), `E-${label} no dev-buy text anywhere in the unset plan`);
  }
}

console.log('== F. discovery-fix template: metadata at creation + config parity ==');
{
  const gen = H.resolveMetadata({ name: 'Agent Reserve', symbol: 'AGTR', rules: [{ id: 3 }, { id: 9, capBps: 500 }] });
  ok(gen.source === 'generated' && gen.uri === 'https://agentonly.fun/hooks/agtr.json' && gen.imageUri === 'https://agentonly.fun/hooks/agtr.png',
    'F1 generated metadata: conventional site URLs derived from the symbol', gen.uri);
  ok(gen.description.includes('Agent-Only') && gen.description.includes('Max Wallet'), 'F2 generated description names the rule stack', gen.description);
  const ovr = H.resolveMetadata({ name: 'X', symbol: 'X', metadataUri: 'https://example.com/m.json' });
  ok(ovr.source === 'spec' && ovr.uri === 'https://example.com/m.json', 'F3 spec.metadataUri override wins verbatim');
  const img = H.resolveMetadata({ name: 'X', symbol: 'X', metadataImageUri: 'https://cdn.example.com/x.png' });
  ok(img.source === 'generated' && img.uri === 'https://agentonly.fun/hooks/x.json' && img.imageUri === 'https://cdn.example.com/x.png',
    'F4 metadataImageUri overrides only the image; the JSON stays generated');
  ok(throws(() => H.validateSpec({ name: 'T', symbol: 'T', metadataUri: 'ipfs://abc' }), 'metadataUri'), 'F5 validateSpec rejects a non-http(s) metadataUri');
  const cc = H.curveConfig(42, { name: 'T', symbol: 'T', rules: [] });
  ok(cc.activationType === 1, 'F6 curveConfig activationType = Timestamp(1) (control parity; was Slot(0))');
  ok(cc.migrationFeeOption === 6 && cc.migratedPoolFee && cc.migratedPoolFee.poolFeeBps === 100 && cc.migratedPoolFee.dynamicFee === 0,
    'F6b curveConfig migrationFeeOption = Customizable(6) (control parity) with our economics preserved: migratedPoolFee 100bps flat, dynamic off');
  ok(H.configFieldsText(42, { name: 'T', symbol: 'T', rules: [] }).includes('activationType=Timestamp(1)'), 'F7 configFieldsText prints the resolved fields');
  const r = dryRun({ name: 'MetaSpec', symbol: 'MSPC', rules: [], holderFees: { enabled: false }, metadataUri: 'https://example.com/m.json' });
  ok(r.status === 0 && r.stdout.includes('operator-supplied metadataUri used verbatim: https://example.com/m.json') && r.stdout.includes('uri="https://example.com/m.json"'),
    'F8 dry-run with a metadataUri override: L0 prints the override, L2 prints the uri it will write');
  const r2 = dryRun({ name: 'MetaGen', symbol: 'MGEN', rules: [], holderFees: { enabled: false } });
  ok(r2.status === 0 && labelsOf(r2.stdout)[0] === 'L0' && r2.stdout.includes('https://agentonly.fun/hooks/mgen.json') && r2.stdout.includes('activationType=Timestamp(1)'),
    'F9 dry-run generated path: plan opens with L0, prints the derived URI + the config fields');
}

console.log('== G. LAUNCH_SIGNER placement in the compiled creation transactions ==');
// The HookedPad placement, proven on COMPILED messages rather than
// source text: the platform signer is a READ-ONLY SIGNER of the
// creation transaction and no CREATE instruction references it
// (BADGER creation tx 2mHbaajf…, decoded 2026-10-17: 4 signers, the
// platform signer read-only, present in neither DBC instruction's
// account list — and referenced by no instruction at all; ours rides
// the appended tag memo because the legacy web3.js compiler rejects
// an unreferenced signer outright). Identities: seed-derived
// payer/config/mint (signable offline) + the real tag keypair; the
// DBC SDK builds both creation transactions exactly as the execute
// paths do.
{
  const payerKp = Keypair.fromSeed(seedOf('hook-launcher-harness payer v1'));
  const flags = (msg, pk) => {
    const i = msg.accountKeys.findIndex((k) => k.equals(pk));
    if (i < 0) return null;
    const signer = i < msg.header.numRequiredSignatures;
    const writable = signer
      ? i < msg.header.numRequiredSignatures - msg.header.numReadonlySignedAccounts
      : i < msg.accountKeys.length - msg.header.numReadonlyUnsignedAccounts;
    return { i, signer, writable };
  };
  // NOTE: this web3.js build's Message.compiledInstructions returns
  // fresh objects per access, so referencing instructions are compared
  // by INDEX, never by object identity.
  const refIdxs = (msg, i) => msg.compiledInstructions.map((ix, n) => (ix.accountKeyIndexes.includes(i) ? n : -1)).filter((n) => n >= 0);
  const DUMMY_BH = '11111111111111111111111111111111';
  // L1 — createConfigWithTransferHook + tag memo, CLI signer set [launcher, config, tag]
  const l1 = await client.partner.createConfigWithTransferHook({
    config: dbcConfigKp.publicKey, feeClaimer: payerKp.publicKey, leftoverReceiver: payerKp.publicKey, payer: payerKp.publicKey,
    quoteMint: H.NATIVE_MINT, transferHookProgram: H.ENGINE, ...H.curveConfig(42, { supply: 1000000000 }),
  });
  l1.add(H.buildTagMemoIx(TAG_KP.publicKey));
  l1.feePayer = payerKp.publicKey; l1.recentBlockhash = DUMMY_BH;
  l1.sign(payerKp, dbcConfigKp, TAG_KP);
  const m1 = l1.compileMessage();
  const f1 = flags(m1, TAG_KP.publicKey);
  ok(f1 && f1.signer && !f1.writable, 'G1 compiled L1: LAUNCH_SIGNER is a read-only signer of the config-creation transaction', f1 ? JSON.stringify(f1) : 'absent');
  const r1 = f1 ? refIdxs(m1, f1.i) : [];
  ok(r1.length === 1 && r1[0] === m1.compiledInstructions.length - 1
    && m1.accountKeys[m1.compiledInstructions[r1[0]].programIdIndex].equals(H.MEMO_PROGRAM_ID),
    'G2 compiled L1: the create instruction does NOT reference LAUNCH_SIGNER — the only referencing instruction is the appended tag memo (final instruction)');
  // L2 — createPoolWithTransferHook + tag memo, CLI signer set [launcher, mint, tag]
  const l2 = await client.creator.createPoolWithTransferHook({
    baseMint: mintKp.publicKey, config: AGTR_CONFIG, transferHookProgram: H.ENGINE,
    name: 'Agent Reserve', symbol: 'AGTR', uri: H.resolveMetadata(AGTR_REC.spec).uri,
    payer: payerKp.publicKey, poolCreator: payerKp.publicKey,
  });
  l2.add(H.buildTagMemoIx(TAG_KP.publicKey));
  l2.feePayer = payerKp.publicKey; l2.recentBlockhash = DUMMY_BH;
  l2.sign(payerKp, mintKp, TAG_KP);
  const m2 = l2.compileMessage();
  const f2 = flags(m2, TAG_KP.publicKey);
  ok(f2 && f2.signer && !f2.writable, 'G3 compiled L2: LAUNCH_SIGNER is a read-only signer of the pool-creation transaction', f2 ? JSON.stringify(f2) : 'absent');
  const r2 = f2 ? refIdxs(m2, f2.i) : [];
  ok(r2.length === 1 && r2[0] === m2.compiledInstructions.length - 1
    && m2.accountKeys[m2.compiledInstructions[r2[0]].programIdIndex].equals(H.MEMO_PROGRAM_ID),
    'G4 compiled L2: the ONLY instruction referencing LAUNCH_SIGNER is the appended tag memo (final instruction) — the create instruction itself carries no tag account');
}

console.log('== H. engine v4 guard + crank pre-flight (rule 1 + graduation "never") ==');
// Engine v4 batch (spec locked 2026-10-19). Background: HARVEST EVER
// (rule 1 + graduation "never") died at launch step L8c because the
// engine's CrankPriceDbc overflowed on never-curve prices (the old
// formula's s*s exceeds 2^128 for the EVER sqrt_start_price). The
// launcher-side protection lives in launch.mjs: a fail-closed guard
// (rule 1 + never launches only once the FIXED engine's ELF sha256,
// recorded in launcher/engine-v4.json, matches the live ProgramData
// ELF) plus an offline BigInt crank pre-flight run before L1.
// The pure pieces are sliced VERBATIM out of launch.mjs's delimited
// PURE section and evaluated here — the same slicing technique
// browser-src/extract-helpers.mjs uses to build helpers.generated.mjs
// (that generated module's export list lives in extract-helpers.mjs,
// outside this trial's ownership, so §H cannot import them from H yet).
// NO RPC anywhere in this section: guard cases use stub hashes, curve
// cases build curves locally through H.curveConfig (the SDK buildCurve
// shape launch.mjs itself uses).
{
  const launchSrc = fs.readFileSync(new URL('./launch.mjs', import.meta.url), 'utf8');
  const pStart = launchSrc.indexOf('// ---------- engine v4 guard');
  const pEnd = launchSrc.indexOf('PURE — END v4-pure');
  ok(pStart >= 0 && pEnd > pStart, 'H1 launch.mjs carries the delimited PURE v4 section (guard decision + crank pre-flight)');
  const pureSrc = launchSrc.slice(pStart, pEnd);
  const V4 = new Function('ruleIdOf', 'resolveGraduation',
    `${pureSrc}\nreturn { engineV4GuardDecision, rule1NeverRefusal, crankPreflight, crankPreflightText, specHasRule1Never, PRICE_SCALE, U128_LIMIT };`
  )(H.ruleIdOf, H.resolveGraduation);
  const SHA_FIXED = '11'.repeat(32);
  const SHA_OTHER = '22'.repeat(32);
  const NEVER1 = { name: 'T', symbol: 'T', graduation: 'never', rules: [{ id: 1, mode: 'latch', maxStaleSecs: 300 }] };
  const dNull = V4.engineV4GuardDecision(NEVER1, null, SHA_FIXED);
  ok(dNull.applies && !dNull.allow, 'H2 guard refuses rule1+never when fixedSha is null (engine-v4.json missing / fixedEngineSha256 null)');
  const dMis = V4.engineV4GuardDecision(NEVER1, SHA_FIXED, SHA_OTHER);
  ok(dMis.applies && !dMis.allow, 'H3 guard refuses rule1+never on live/fixed sha mismatch');
  const dFetch = V4.engineV4GuardDecision(NEVER1, SHA_FIXED, null);
  ok(dFetch.applies && !dFetch.allow, 'H4 guard refuses rule1+never when the live sha could not be fetched (liveSha null — fail closed)');
  const dOk = V4.engineV4GuardDecision(NEVER1, SHA_FIXED, SHA_FIXED);
  ok(dOk.applies && dOk.allow, 'H5 guard allows rule1+never when fixed and live hashes match');
  const dRel = V4.engineV4GuardDecision({ name: 'T', symbol: 'T', graduation: 'release', migrationThresholdSol: 42, rules: [{ id: 1, mode: 'latch', maxStaleSecs: 300 }] }, null, null);
  ok(!dRel.applies && dRel.allow, 'H6 guard does NOT block rule 1 + release (applies=false even with no hashes)');
  const dNeverNoR1 = V4.engineV4GuardDecision({ name: 'T', symbol: 'T', graduation: 'never', rules: [{ id: 9, capBps: 500 }] }, null, null);
  ok(!dNeverNoR1.applies && dNeverNoR1.allow, 'H7 guard does NOT block graduation "never" without rule 1');
  const refusal = V4.rule1NeverRefusal(dMis);
  ok(refusal.includes('rule 1 (Basis Latch) + graduation "never" is refused until the v4 engine (crank overflow fix) is verified live')
    && refusal.includes('fixedEngineSha256') && refusal.includes('ProgramData'),
    'H8 refusal message names the blocked combination, the v4 crank fix, and what was checked (fixedEngineSha256 vs live ProgramData ELF)');
  ok(launchSrc.includes('await liveEngineV4Decision(spec, conn)') && launchSrc.includes('subarray(45)')
    && launchSrc.indexOf('await liveEngineV4Decision(spec, conn)') < launchSrc.indexOf('const metaReport = await stageMetadata'),
    'H9 live wiring: launch.mjs decides via the I/O wrapper (ProgramData ELF at byte offset 45) BEFORE L0/stageMetadata — i.e. before any L-step runs');
  const rGuard = dryRun(NEVER1);
  ok(rGuard.status === 0 && rGuard.stdout.includes('ENGINE V4 GUARD'),
    'H10 dry-run of a rule1+never spec: plan path prints the loud ENGINE V4 GUARD warning and does NOT hard-refuse (exit 0)', `status=${rGuard.status}`);
  // --- crank pre-flight: fixture specs ---
  const harvestSpec = JSON.parse(fs.readFileSync(new URL('../deploy/spec-harvest.json', import.meta.url), 'utf8'));
  const everSpec = JSON.parse(fs.readFileSync(new URL('../deploy/spec-harvest-ever.json', import.meta.url), 'utf8'));
  const sqrtOf = (spec) => H.curveConfig(H.resolveGraduation(spec).thresholdSol, spec).sqrtStartPrice;
  const pHarvest = V4.crankPreflight(sqrtOf(harvestSpec), harvestSpec.decimals ?? 6, 9);
  ok(pHarvest.ok && pHarvest.spot > 0n && Object.values(pHarvest.intermediates).every((v) => v < V4.U128_LIMIT),
    'H11 pre-flight PASSes for deploy/spec-harvest.json (spot > 0, every decomposed intermediate < 2^128)', `spot=${pHarvest.spot} failures=${pHarvest.failures.join(';')}`);
  const pEver = V4.crankPreflight(sqrtOf(everSpec), everSpec.decimals ?? 6, 9);
  ok(pEver.naiveSSquared >= V4.U128_LIMIT,
    'H12 EVER tripwire (old formula): sqrt_start_price s*s exceeds 2^128 — the exact CrankPriceDbc overflow that killed HARVEST EVER at L8c', `s=${pEver.sqrtPrice} s*s=${pEver.naiveSSquared}`);
  ok(pEver.ok && pEver.spot > 0n && Object.values(pEver.intermediates).every((v) => v < V4.U128_LIMIT),
    'H13 pre-flight PASSes for deploy/spec-harvest-ever.json under the FIXED decomposition (every intermediate < 2^128, spot > 0)', `spot=${pEver.spot} failures=${pEver.failures.join(';')}`);
  const pBad = V4.crankPreflight(1n << 114n, 6, 9);
  ok(!pBad.ok && pBad.failures.some((f) => f.includes('a*a*PRICE_SCALE')),
    'H14 synthetic overflow: pre-flight fails and NAMES the failing quantity (a*a*PRICE_SCALE >= 2^128)', pBad.failures.join(';'));
  const rEver = dryRun(everSpec);
  ok(rEver.status === 0 && rEver.stdout.includes('crank pre-flight') && rEver.stdout.includes('PASS') && rEver.stdout.includes('would have overflowed'),
    'H15 dry-run of spec-harvest-ever.json: plan prints the crank pre-flight PASS + the old-formula overflow note', `status=${rEver.status}`);
  const rHarvest = dryRun(harvestSpec);
  ok(rHarvest.status === 0 && rHarvest.stdout.includes('crank pre-flight') && rHarvest.stdout.includes('PASS'),
    'H16 dry-run of spec-harvest.json: plan prints the crank pre-flight PASS', `status=${rHarvest.status}`);
  // --- Phase C: mode 'house' rides never physics, so the guard applies
  // to rule 1 + house exactly as it does to rule 1 + never (contract
  // §3.1: specHasRule1Never also treats mode 'house' as applies; the
  // never decisions above are unchanged).
  const HOUSE1 = { name: 'T', symbol: 'T', graduation: 'house', graduationThresholdSol: 25, rules: [{ id: 1, mode: 'latch', maxStaleSecs: 300 }] };
  ok(V4.specHasRule1Never(HOUSE1) === true, 'H17 specHasRule1Never treats graduation "house" as applies (house curves are built with the u64::MAX threshold)');
  const dHouseNull = V4.engineV4GuardDecision(HOUSE1, null, SHA_FIXED);
  const dHouseOk = V4.engineV4GuardDecision(HOUSE1, SHA_FIXED, SHA_FIXED);
  ok(dHouseNull.applies && !dHouseNull.allow && dHouseOk.applies && dHouseOk.allow,
    'H18 guard decisions for rule 1 + house: refused with no fixed engine recorded, allowed when fixed and live hashes match — same fail-closed shape as never');
  const dHouseNoR1 = V4.engineV4GuardDecision({ name: 'T', symbol: 'T', graduation: 'house', graduationThresholdSol: 25, rules: [{ id: 9, capBps: 500 }] }, null, null);
  ok(!dHouseNoR1.applies && dHouseNoR1.allow, 'H19 guard does NOT block graduation "house" without rule 1');
}

console.log(`\n==== LAUNCHER FEATURES TRIAL (Phase 4): ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

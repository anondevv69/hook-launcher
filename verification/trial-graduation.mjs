#!/usr/bin/env node
// trial-graduation.mjs — launcher spec-surface trial: the rule-17
// spec-entry baseline (17 checks, SPEC-ECOSYSTEM-GATE §6) plus the
// graduation-behavior option (SPEC-HOOK-LAUNCHER §11): resolution,
// validation, plan output, and the on-chain artifact bytes.
//   node trial-graduation.mjs
// Byte-compat baselines were captured 2026-10-16 from the pre-graduation
// launch.mjs (source-of-truth slices) for the two shipped launch records'
// specs — the release default must reproduce them exactly.
// RECAPTURE (Phase C, 2026-10-20): B5 asserted graduation "house" is
// REFUSED as not-implemented — that baseline is deliberately superseded
// by Phase C (contract §3.2), the same way the L1 baselines below were
// recaptured for the discovery-fix template: "house" now resolves (B5),
// with its own assertion set (B9–B14, D5–D6). Every other baseline
// (A*, B1–B4, B6–B8, C*, D1–D4) is untouched and must not move.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient, DynamicBondingCurveIdl, validateConfigParameters, getMigrationThresholdPrice, MAX_SQRT_PRICE } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { BorshInstructionCoder } from '@coral-xyz/anchor';
import BN from 'bn.js';
import * as H from './browser-src/helpers.generated.mjs';

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, extra); } };
const throws = (fn, frag) => { try { fn(); return false; } catch (e) { return frag == null || String(e.message).includes(frag); } };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

console.log('== A. rule-17 spec-entry baseline (17) ==');
const p0 = (entry) => H.encodeParams(17, entry)[0];
ok(p0({ id: 17, ecosystem: 'fomo' }) === 2, 'A1 {id:17, ecosystem:"fomo"} → params[0] = 2');
ok(p0({ rule: 'muse-only' }) === 1, 'A2 {rule:"muse-only"} → params[0] = 1');
ok(p0({ rule: 'fomo-only' }) === 2, 'A3 {rule:"fomo-only"} → params[0] = 2');
ok(p0({ rule: 'claude-only' }) === 3, 'A4 {rule:"claude-only"} → params[0] = 3');
ok(p0({ rule: 'grok-only' }) === 4, 'A5 {rule:"grok-only"} → params[0] = 4');
ok(p0({ id: 17, ecosystem: 'muse' }) === 1, 'A6 ecosystem name "muse" → 1');
ok(p0({ id: 17, ecosystem: 'claude' }) === 3, 'A7 ecosystem name "claude" → 3');
ok(p0({ id: 17, ecosystem: 'grok' }) === 4, 'A8 ecosystem name "grok" → 4');
ok(p0({ id: 17, ecosystem: 2 }) === 2, 'A9 ecosystem number 2 → 2');
ok(p0({ id: 17, ecosystem: '3' }) === 3, 'A10 ecosystem numeric string "3" → 3');
ok(p0({ id: 17, ecosystem: 16 }) === 16, 'A11 ecosystem 16 (max slot) → 16');
ok(throws(() => p0({ id: 17, ecosystem: 0 })), 'A12 ecosystem 0 rejected');
ok(throws(() => p0({ id: 17, ecosystem: 17 })), 'A13 ecosystem 17 rejected');
ok(throws(() => p0({ id: 17, ecosystem: 'bogus' })), 'A14 ecosystem "bogus" rejected');
ok(throws(() => p0({ id: 17 }), 'requires ecosystem'), 'A15 rule 17 with no ecosystem and no alias rejected');
ok(p0({ name: 'Ecosystem Gate', ecosystem: 'fomo' }) === 2, 'A16 name-form entry resolves id + ecosystem → 2');
{
  const w = H.validateSpec({ name: 'T', symbol: 'T', rules: [{ rule: 'muse-only' }] });
  ok(Array.isArray(w) && w.some(x => x.includes('rule 17 (Ecosystem Gate)') && x.includes('attester')), 'A17 validateSpec accepts a Muse-only spec and warns about the attester');
}

console.log('== B. graduation resolution ==');
{
  const d = H.resolveGraduation({ name: 'T', symbol: 'T' });
  ok(d.mode === 'release' && d.thresholdSol === 42 && d.thresholdLamports === 42000000000n, 'B1 absent field → release, threshold 42 SOL (42000000000 lamports)');
  const e = H.resolveGraduation({ migrationThresholdSol: 100 });
  ok(e.mode === 'release' && e.thresholdSol === 100 && e.thresholdLamports === 100000000000n, 'B2 explicit release threshold respected (100 SOL)');
  const n = H.resolveGraduation({ graduation: 'never' });
  ok(n.mode === 'never' && n.thresholdLamports === 18446744073709551615n && n.thresholdSol === '18446744073.709551615', 'B3 never → u64::MAX lamports, exact SOL string');
  ok(throws(() => H.resolveGraduation({ graduation: 'never', migrationThresholdSol: 42 }), 'contradicts'), 'B4 never + migrationThresholdSol is a hard error');
  const h = H.resolveGraduation({ graduation: 'house', graduationThresholdSol: 25 });
  ok(h.mode === 'house' && h.thresholdSol === '18446744073.709551615' && h.thresholdLamports === 18446744073709551615n
    && h.houseThresholdSol === 25 && h.houseThresholdLamports === 25000000000n,
    'B5 "house" resolves (Phase C recapture): curve rides never physics (u64::MAX), house threshold carried alongside (25 SOL = 25000000000 lamports)');
  ok(throws(() => H.resolveGraduation({ graduation: 'house' }), 'requires graduationThresholdSol'), 'B9 house without a positive graduationThresholdSol is a hard error');
  ok(throws(() => H.resolveGraduation({ graduation: 'house', graduationThresholdSol: 25, migrationThresholdSol: 42 }), 'house + migrationThresholdSol'), 'B10 house + migrationThresholdSol is a hard error');
  ok(throws(() => H.resolveGraduation({ graduationThresholdSol: 25 }), 'belongs to graduation "house"'), 'B11 graduationThresholdSol on a non-house mode is a hard error');
  ok(throws(() => H.validateSpec({ name: 'T', symbol: 'T', rules: [{ id: 2 }], graduation: 'house', graduationThresholdSol: 25, houseSeedTokens: 1000, houseSeedBuySol: 0.1 }), 'requires rule 1'), 'B12 rule 2 + house without rule 1 is a hard error (escrow resolution IS rule 1\'s dip logic)');
  ok(throws(() => H.validateSpec({ name: 'T', symbol: 'T', rules: [{ id: 1 }, { id: 2 }] }), 'requires graduation "house"'), 'B13 rule 2 without graduation "house" is a hard error (the split is venue-side)');
  {
    const w = H.validateSpec({ name: 'T', symbol: 'T', rules: [{ id: 1, mode: 'latch' }, { id: 2, splitBps: 4000 }], graduation: 'house', graduationThresholdSol: 25, houseSeedTokens: 1000, houseSeedBuySol: 0.1 });
    ok(w.some(x => x.includes('rule 2 (Escrow Split) is venue-side')) && w.some(x => x.includes('seed-account exemption')),
      'B14 rule 1 + rule 2 + house validates, with the venue-only rule-2 warning and the seed-account exemption disclosure');
    const p2 = H.encodeParams(2, { id: 2, splitBps: 4000 });
    ok(p2.readUInt16LE(0) === 4000 && p2.subarray(2).every(b => b === 0) && H.encodeParams(2, { id: 2 }).readUInt16LE(0) === 5000,
      'B15 encodeParams(2): splitBps u16 @0 (4000), params[2..64] zero, default 5000');
    ok(throws(() => H.encodeParams(2, { id: 2, splitBps: 0 }), 'splitBps') && throws(() => H.encodeParams(2, { id: 2, splitBps: 10001 }), 'splitBps'),
      'B16 encodeParams(2): splitBps outside 1..10000 is a hard error');
    const AUTH = new PublicKey('FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP');
    const cpHouse = H.configPayload({ mode: 0, authority: AUTH, rules: [], venues: [H.DBC_ID], exemptions: [] }, 1,
      { program: H.HOUSE_SWAP_PROGRAM_ID, thresholdLamports: 25000000000n, reserveLamports: 500000000n });
    const cpPlain = H.configPayload({ mode: 0, authority: AUTH, rules: [], venues: [H.DBC_ID], exemptions: [] }, 1);
    ok(cpHouse.length === cpPlain.length + 49 && cpHouse.subarray(0, cpPlain.length).equals(cpPlain)
      && cpHouse[cpPlain.length] === 1 && cpHouse.readBigUInt64LE(cpPlain.length + 33) === 25000000000n && cpHouse.readBigUInt64LE(cpPlain.length + 41) === 500000000n,
      'B17 configPayload house block: exactly +49 bytes appended after the fee tail ([1][program][threshold u64][reserve u64]); the non-house prefix is byte-identical');
  }
  ok(throws(() => H.resolveGraduation({ graduation: 'sometimes' }), 'graduation must be'), 'B6 unknown graduation value is a hard error');
  ok(throws(() => H.validateSpec({ name: 'T', symbol: 'T', graduation: 'sometimes' }), 'graduation must be'), 'B7 validateSpec surfaces the graduation error');
  const wn = H.validateSpec({ name: 'T', symbol: 'T', graduation: 'never', rules: [] });
  ok(wn.some(x => x.includes('graduation "never"') && x.includes('hook-aware doors')), 'B8 validateSpec warns, in plain terms, on a never spec');
}

console.log('== C. on-chain artifact bytes ==');
const FREN = new PublicKey('FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP');
const seedOf = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const dbcConfigKp = Keypair.fromSeed(seedOf('hook-launcher-harness config v1'));
const mintKp = Keypair.fromSeed(seedOf('hook-launcher-harness mint v1'));
const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const client = new DynamicBondingCurveClient(conn, 'confirmed');
const coder = new BorshInstructionCoder(DynamicBondingCurveIdl);
async function artifacts(spec) {
  const t = H.resolveGraduation(spec).thresholdSol;
  const tx = await client.partner.createConfigWithTransferHook({
    config: dbcConfigKp.publicKey, feeClaimer: FREN, leftoverReceiver: FREN, payer: FREN,
    quoteMint: H.NATIVE_MINT, transferHookProgram: H.ENGINE, ...H.curveConfig(t, spec),
  });
  const mode = H.MODES[String(spec.authorityMode ?? 'locked').toLowerCase()];
  const rules = (spec.rules ?? []).map((entry) => ({ id: H.ruleIdOf(entry), entry, enabled: entry.enabled !== false }));
  const pool = H.deriveDbcPoolAddress(H.NATIVE_MINT, mintKp.publicKey, dbcConfigKp.publicKey);
  const baseVault = H.deriveDbcTokenVaultAddress(pool, mintKp.publicKey);
  const l3 = H.configPayload({ mode, authority: FREN, rules, venues: [H.DBC_ID], exemptions: [H.deriveDbcPoolAuthority(), baseVault] }, 1);
  return { l1: tx.instructions[0].data, l3, ixData: tx.instructions[0].data };
}
// L1 baselines RECAPTURED 2026-10-16 for the discovery-fix template:
// activationType Slot(0) -> Timestamp(1) and migrationFeeOption
// FixedBps100(2) -> Customizable(6) with migratedPoolFee 100bps flat
// in curveConfig change exactly the L1 config instruction bytes (the
// L3 engine payloads are untouched). Pre-discovery-fix L1 baseline
// was 4f8caa5b… for both record specs — kept in this comment so the
// deliberate break stays visible.
const BASE = {
  agtrL1: '6350e8b6bbcc47faa7c53b70f4b50f9c6a28bf58f6461d2cdebd2602e43555c9',
  agtrL3: '4545fcd8a9749a045048aeadf1a3871549135de8d12fe98df6b11c2157cbf1a0',
  latchL1: '6350e8b6bbcc47faa7c53b70f4b50f9c6a28bf58f6461d2cdebd2602e43555c9',
  latchL3: '2ba3769c1d4e5ed2803bfb40c07ea5ab6e540968fc8eea86e3380eafc99f0dad',
};
const agtrSpec = JSON.parse(fs.readFileSync(new URL('../deploy/launch-record-agtr.json', import.meta.url), 'utf8')).spec;
const latchSpec = JSON.parse(fs.readFileSync(new URL('../deploy/launch-record-latch.json', import.meta.url), 'utf8')).spec;
{
  const a = await artifacts(agtrSpec);
  ok(sha(a.l1) === BASE.agtrL1, 'C1 AGTR record spec: L1 config instruction bytes identical to the post-discovery-fix baseline');
  ok(sha(a.l3) === BASE.agtrL3, 'C2 AGTR record spec: L3 engine config payload identical to baseline');
  const l = await artifacts(latchSpec);
  ok(sha(l.l1) === BASE.latchL1, 'C3 Latch record spec: L1 config instruction bytes identical to the post-discovery-fix baseline');
  ok(sha(l.l3) === BASE.latchL3, 'C4 Latch record spec: L3 engine config payload identical to baseline');
  const neverSpec = { name: 'Forever', symbol: 'FVR', supply: 1000000000, decimals: 6, authorityMode: 'locked', graduation: 'never', rules: [{ id: 9, capBps: 300 }], holderFees: { enabled: false } };
  const nv = await artifacts(neverSpec);
  const dec = coder.decode(nv.ixData, 'base58');
  ok(dec.name === 'create_config_with_transfer_hook' && dec.data.config_parameters.migration_quote_threshold.toString() === '18446744073709551615',
    'C5 never spec: built L1 instruction decodes to migration_quote_threshold = u64::MAX');
  const params = H.curveConfig(H.resolveGraduation(neverSpec).thresholdSol, neverSpec);
  let sdkOk = true, migOk = true;
  try { validateConfigParameters({ ...params, leftoverReceiver: FREN.toBase58() }); } catch { sdkOk = false; }
  try { migOk = getMigrationThresholdPrice(params.migrationQuoteThreshold, params.sqrtStartPrice, params.curve).lt(new BN(MAX_SQRT_PRICE.toString())); } catch { migOk = false; }
  ok(sdkOk && migOk && params.migrationQuoteThreshold.toString() === '18446744073709551615',
    'C6 never curve params pass the SDK mirror of the program validation; migration sqrt price < MAX_SQRT_PRICE');
}

console.log('== D. dry-run plan output (CLI) ==');
function dryRun(specObj) {
  const f = path.join(os.tmpdir(), `trial-grad-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(specObj));
  const r = spawnSync(process.execPath, ['launch.mjs', f, '--dry-run'], { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  fs.unlinkSync(f);
  return r;
}
{
  const rel = dryRun({ name: 'Rel', symbol: 'REL', rules: [] });
  ok(rel.status === 0 && rel.stdout.includes('GRADUATION. release — the rules retire at graduation') && rel.stdout.includes('migration threshold 42 SOL → DAMM v2'),
    'D1 release dry-run: GRADUATION line (release) + unchanged L1 threshold text');
  const nev = dryRun({ name: 'Nev', symbol: 'NEV', graduation: 'never', rules: [] });
  ok(nev.status === 0 && nev.stdout.includes('GRADUATION. never — the rules are permanent') && nev.stdout.includes('18446744073709551615 lamports'),
    'D2 never dry-run: GRADUATION line (never) with the u64::MAX threshold in the plan');
  const bad = dryRun({ name: 'Bad', symbol: 'BAD', graduation: 'sometimes', rules: [] });
  ok(bad.status === 1 && (bad.stderr + bad.stdout).includes('graduation must be'), 'D3 invalid graduation value: dry-run refuses (exit 1)');
  const ag = dryRun(agtrSpec);
  ok(ag.status === 0 && ag.stdout.includes('migration threshold 42 SOL → DAMM v2'), 'D4 AGTR record spec dry-run: plan threshold text unchanged');
  const hs = dryRun({ name: 'Housey', symbol: 'HSE', rules: [{ id: 1, mode: 'latch' }, { id: 2 }], graduation: 'house', graduationThresholdSol: 25, houseReserveSol: 0.5, houseSeedTokens: 1000000, houseSeedBuySol: 0.25, holderFees: { enabled: false } });
  const hLabels = [...hs.stdout.matchAll(/^ {2}([A-Z0-9]+[a-z]?)\. /gm)].map(m => m[1]);
  ok(hs.status === 0 && ['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].every(s => hLabels.includes(s)),
    'D5 house dry-run: plan carries the full H0–H6 step set', hLabels.join(','));
  ok(hs.stdout.includes('GRADUATION. house — graduate at the house threshold onto the house venue, the rules stay')
    && hs.stdout.includes('reserve 0.5 + seed wallet funding 0.1 + seed buy 0.25'),
    'D6 house dry-run: GRADUATION house line present; budget line includes the reserve + seed funding + seed buy');
}

console.log(`\n==== LAUNCHER GRADUATION TRIAL: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

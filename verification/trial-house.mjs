#!/usr/bin/env node
// trial-house.mjs — Phase C launcher-side trial (contract §4, worker C):
//   * doors.mjs resolveVenue matrix (no slot → curve; pending → curve +
//     threshold progress; activated → house)
//   * doors.mjs swap-instruction shape — account order vs contract
//     §2.2/§2.3 (base order, hook tail placement, rule-2 venue extras)
//   * activation-keeper.mjs planActivation matrix (below-threshold gap
//     named, uncommitted pool, seed-missing, ready → both steps,
//     already-activated → done)
//   * launch.mjs dry-run house plan (H-steps, GRADUATION house line,
//     budget includes reserve + seed) — also covered in
//     trial-graduation D5/D6; the spec-validation error set is covered
//     in trial-graduation B5/B9–B17. This file asserts the doors +
//     keeper surfaces those trials cannot reach.
// Fixtures are hand-built byte buffers in the contract layouts (config
// V2 house region §1.1, DBC pool quote_reserve @240, houseswap pool
// record §2.1) — the same shapes worker B's LiteSVM lifecycle produces
// on-chain; doors/keeper consume raw account bytes either way.
//   node trial-house.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import * as D from './doors.mjs';
import { planActivation, buildActivateHouseIx, buildActivatePoolIx, parseDbcConfigFeeBps, attestFeeBps, ENGINE_PROGRAM_ID } from './activation-keeper.mjs';

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, extra); } };

const HOUSE_PROG = Keypair.generate().publicKey;
const ENGINE = new PublicKey(ENGINE_PROGRAM_ID);
const MINT = Keypair.generate().publicKey;
const USER = Keypair.generate().publicKey;

// ---- fixture builders (contract layouts) ----
function configBytes({ house = null, len = 1152 } = {}) {
  const b = Buffer.alloc(len);
  if (house && len >= 1152) {
    house.program.toBuffer().copy(b, 1088);
    b.writeBigUInt64LE(house.threshold, 1120);
    b.writeBigUInt64LE(house.reserve ?? 0n, 1128);
    b.writeBigInt64LE(house.activatedTs ?? 0n, 1136);
    b[1144] = house.state;
  }
  return b;
}
function dbcPoolBytes(quoteReserve) {
  const b = Buffer.alloc(424);
  b.writeBigUInt64LE(quoteReserve, 240);
  return b;
}
function housePoolBytes({ committed = 1 } = {}) {
  const b = Buffer.alloc(264);
  b[0] = 1; b[162] = committed;
  return b;
}
const REC_PLAIN = { rules: [{ id: 1, enabled: true }], addresses: { mint: MINT.toBase58() }, programs: { engine: ENGINE.toBase58() }, decimals: 6 };
const REC_R2 = { ...REC_PLAIN, rules: [{ id: 1, enabled: true }, { id: 2, enabled: true }] };

console.log('== A. doors parseHouseSlot + resolveVenue matrix ==');
{
  ok(D.parseHouseSlot(configBytes({ len: 1088 })) === null, 'A1 V1-size config (1088 B) → no slot → curve');
  ok(D.parseHouseSlot(configBytes({})) === null, 'A2 V2-size config with house_state 0 → no slot');
  const slot = D.parseHouseSlot(configBytes({ house: { program: HOUSE_PROG, threshold: 25000000000n, reserve: 500000000n, state: 1 } }));
  ok(slot && slot.program.equals(HOUSE_PROG) && slot.thresholdLamports === 25000000000n && slot.reserveLamports === 500000000n && slot.state === 1,
    'A3 pending slot parses: program / threshold / reserve / state read from the §1.1 offsets');
  const vNone = D.resolveVenue(REC_PLAIN, configBytes({ len: 1088 }));
  ok(vNone.venue === 'curve' && vNone.slot === null, 'A4 resolveVenue: no slot → curve');
  const vPend = D.resolveVenue(REC_PLAIN, configBytes({ house: { program: HOUSE_PROG, threshold: 25000000000n, state: 1 } }), dbcPoolBytes(10000000000n));
  ok(vPend.venue === 'curve' && vPend.progress && vPend.progress.quoteReserveLamports === 10000000000n && vPend.progress.thresholdLamports === 25000000000n,
    'A5 resolveVenue: pending → curve + threshold progress (DBC quote_reserve @240 vs slot threshold)');
  const vHouse = D.resolveVenue(REC_PLAIN, configBytes({ house: { program: HOUSE_PROG, threshold: 25000000000n, state: 2, activatedTs: 1760000000n } }));
  ok(vHouse.venue === 'house' && vHouse.slot.activatedTs === 1760000000n, 'A6 resolveVenue: state 2 (activated) → house');
}

console.log('== B. doors swap-ix account order (contract §2.2/§2.3) ==');
{
  const pool = D.housePoolPda(HOUSE_PROG, MINT);
  const tokenVault = getAssociatedTokenAddressSync(MINT, pool, true, TOKEN_2022_PROGRAM_ID);
  const quoteVault = getAssociatedTokenAddressSync(D.NATIVE_MINT, pool, true, TOKEN_PROGRAM_ID);
  const userToken = getAssociatedTokenAddressSync(MINT, USER, false, TOKEN_2022_PROGRAM_ID);
  const userQuote = getAssociatedTokenAddressSync(D.NATIVE_MINT, USER, false, TOKEN_PROGRAM_ID);
  // Fabricated resolved tail in the SPL resolver layout: [config,
  // src holder, dst holder, rent vault, price feed, system, sysvar,
  // hook program, meta list] — doors forwards it verbatim.
  const tailKeys = Array.from({ length: 9 }, (_, i) => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: i === 1 || i === 2 }));
  const base = { houseProgram: HOUSE_PROG, mint: MINT, pool, tokenVault, quoteVault, user: USER, userToken, userQuote, tail: tailKeys };
  const expectHead = [pool, MINT, D.NATIVE_MINT, tokenVault, quoteVault, userToken, userQuote, USER, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID];
  const buy = D.buildHouseSwapKeys({ ...base, dir: 0, amountIn: 1000n });
  ok(JSON.stringify(buy.keys.slice(0, 10).map(k => k.pubkey.toBase58())) === JSON.stringify(expectHead.map(k => k.toBase58()))
    && buy.keys[3].isWritable && buy.keys[4].isWritable && buy.keys[5].isWritable && buy.keys[6].isWritable && buy.keys[7].isSigner && !buy.keys[7].isWritable,
    'B1 buy: head order = [pool, token_mint, quote_mint, token_vault(w), quote_vault(w), user_token(w), user_quote(w), user(signer), token_prog, quote_prog]');
  ok(JSON.stringify(buy.keys.slice(10, 19).map(k => k.pubkey.toBase58())) === JSON.stringify(tailKeys.map(k => k.pubkey.toBase58())) && buy.keys.length === 19,
    'B2 buy without rule 2: hook tail follows verbatim (9 keys), no venue extras');
  ok(buy.data.length === 18 && buy.data[0] === 1 && buy.data[1] === 0 && buy.data.readBigUInt64LE(2) === 1000n && buy.data.readBigUInt64LE(10) === 0n,
    'B3 data = [1][dir 0][amount_in u64][min_out u64] (TaxSwap Swap encoding)');
  const buyR2 = D.buildHouseSwapKeys({ ...base, dir: 0, amountIn: 1000n, rule2: true, engineProgram: ENGINE });
  ok(buyR2.keys.length === 20 && buyR2.keys[19].pubkey.equals(D.houseEscrowPda(HOUSE_PROG, MINT, userToken)) && buyR2.keys[19].isWritable,
    'B4 buy + rule 2: exactly one venue extra — the escrow PDA (w), derived ["escrow", mint, user_token]');
  const sellR2 = D.buildHouseSwapKeys({ ...base, dir: 1, amountIn: 500n, rule2: true, engineProgram: ENGINE });
  const pricePda = D.enginePda(ENGINE, [Buffer.from('price'), MINT.toBuffer()]);
  const holderPda = D.enginePda(ENGINE, [Buffer.from('holder'), MINT.toBuffer(), userToken.toBuffer()]);
  ok(sellR2.keys.length === 22 && sellR2.keys[19].pubkey.equals(D.houseEscrowPda(HOUSE_PROG, MINT, userToken))
    && sellR2.keys[20].pubkey.equals(pricePda) && sellR2.keys[21].pubkey.equals(holderPda) && sellR2.data[1] === 1,
    'B5 sell + rule 2: venue extras = [escrow(w), price_feed, seller_holder] in §2.3 order; holder keyed by the user token account (engine v3)');
  let threw = false;
  try { D.buildHouseSwapKeys({ ...base, dir: 0, amountIn: 1n, rule2: true }); } catch { threw = true; }
  ok(threw, 'B6 rule 2 without the engine program id refuses (extras cannot be derived)');
}

console.log('== C. keeper planActivation matrix ==');
{
  const cfgPend = configBytes({ house: { program: HOUSE_PROG, threshold: 25000000000n, reserve: 0n, state: 1 } });
  const noSlot = planActivation({ configBytes: configBytes({ len: 1088 }), dbcPoolBytes: dbcPoolBytes(0n), houseVault: { lamports: 0n, reserveBalance: 0n, feeBalance: 0n }, poolBytes: housePoolBytes() });
  ok(!noSlot.ready && noSlot.missing.some(m => m.includes('no house commitment')), 'C1 no slot → not ready, gap named');
  const below = planActivation({ configBytes: cfgPend, dbcPoolBytes: dbcPoolBytes(10000000000n), houseVault: { lamports: 0n, reserveBalance: 0n, feeBalance: 500000000n }, poolBytes: housePoolBytes() });
  ok(!below.ready && below.missing.length === 1 && below.missing[0].includes('below the house threshold') && below.missing[0].includes('short 15000000000'),
    'C2 below threshold → not ready, the gap is named with the exact shortfall');
  const uncommitted = planActivation({ configBytes: cfgPend, dbcPoolBytes: dbcPoolBytes(30000000000n), houseVault: { lamports: 0n, reserveBalance: 0n, feeBalance: 500000000n }, poolBytes: housePoolBytes({ committed: 0 }) });
  ok(!uncommitted.ready && uncommitted.missing.some(m => m.includes('not committed')), 'C3 uncommitted pool → not ready (HouseNotCommitted named)');
  const seedless = planActivation({ configBytes: cfgPend, dbcPoolBytes: dbcPoolBytes(30000000000n), houseVault: { lamports: 0n, reserveBalance: 0n, feeBalance: 0n }, poolBytes: housePoolBytes() });
  ok(!seedless.ready && seedless.missing.some(m => m.includes('no activation seed')), 'C4 fee-only seed with fee_balance 0 → not ready, seed gap named');
  const cfgRes = configBytes({ house: { program: HOUSE_PROG, threshold: 25000000000n, reserve: 500000000n, state: 1 } });
  const resShort = planActivation({ configBytes: cfgRes, dbcPoolBytes: dbcPoolBytes(30000000000n), houseVault: { lamports: 0n, reserveBalance: 100000000n, feeBalance: 0n }, poolBytes: housePoolBytes() });
  ok(!resShort.ready && resShort.missing.some(m => m.includes('reserve not recorded')), 'C5 committed reserve unrecorded → not ready (reserve_balance < commitment)');
  const readyFee = planActivation({ configBytes: cfgPend, dbcPoolBytes: dbcPoolBytes(25000000000n), houseVault: { lamports: 0n, reserveBalance: 0n, feeBalance: 1n }, poolBytes: housePoolBytes() });
  ok(readyFee.ready && JSON.stringify(readyFee.steps) === JSON.stringify(['activate-house', 'activate-pool']),
    'C6 ready (reserve at threshold exactly + fee seed) → both steps, in order');
  const readyRes = planActivation({ configBytes: cfgRes, dbcPoolBytes: dbcPoolBytes(30000000000n), houseVault: { lamports: 0n, reserveBalance: 500000000n, feeBalance: 0n }, poolBytes: housePoolBytes() });
  ok(readyRes.ready, 'C7 ready via the committed-reserve path (fee_balance 0 is fine when a reserve is recorded)');
  const done = planActivation({ configBytes: configBytes({ house: { program: HOUSE_PROG, threshold: 25000000000n, state: 2 } }), dbcPoolBytes: dbcPoolBytes(0n), houseVault: { lamports: 0n, reserveBalance: 0n, feeBalance: 0n }, poolBytes: housePoolBytes() });
  ok(done.done === true && !done.ready && done.steps.length === 0 && done.missing.length === 0, 'C8 already activated → done, no steps, no gaps');
  // Instruction builders (the keeper's execute path shapes).
  const caller = Keypair.generate().publicKey;
  const ixH = buildActivateHouseIx({ caller, mint: MINT, configPda: Keypair.generate().publicKey, dbcPool: Keypair.generate().publicKey, houseVaultPda: Keypair.generate().publicKey, housePool: D.housePoolPda(HOUSE_PROG, MINT), houseTokenVault: Keypair.generate().publicKey, houseQuoteVault: Keypair.generate().publicKey });
  ok(ixH.programId.equals(ENGINE) && ixH.data.equals(Buffer.from([14])) && ixH.keys.length === 10
    && ixH.keys[0].pubkey.equals(caller) && ixH.keys[0].isSigner && ixH.keys[2].isWritable && ixH.keys[4].isWritable
    && ixH.keys[8].pubkey.equals(SystemProgram.programId) && ixH.keys[9].pubkey.equals(TOKEN_PROGRAM_ID),
    'C9 ActivateHouse ix: tag 14, §1.4 account order (caller signer, config w, house_vault w, …, system, LEGACY token program for SyncNative)');
  const ixP = buildActivatePoolIx({ houseProgram: HOUSE_PROG, pool: D.housePoolPda(HOUSE_PROG, MINT), mint: MINT, engineConfigPda: Keypair.generate().publicKey, dbcPool: Keypair.generate().publicKey, dbcConfig: Keypair.generate().publicKey, feeBps: 100, launchRecordFeeBps: 100 });
  ok(ixP.programId.equals(HOUSE_PROG) && ixP.data[0] === 5 && ixP.data.readUInt16LE(1) === 100 && ixP.keys.length === 5 && ixP.keys[0].isWritable,
    'C10 ActivatePool ix: tag 5 + fee_bps u16, §2.2 account order (pool w, mint, engine_config, dbc_pool, dbc_config) — rate attested against the launch record');
  // ---- ActivatePool fee-rate attestation (fork 2) ----
  // Synthetic DBC PoolConfig bytes in the Anchor layout: discriminator
  // @0..8, quote_mint @8..40, fee_claimer @40..72, leftover_receiver
  // @72..104, cliff_fee_numerator u64 @104 (= bps * 100000, FEE_DENOMINATOR
  // 1e9), second_factor/period_frequency u64 @112, third_factor/
  // reduction_factor u64 @120, first_factor/number_of_period u16 @128,
  // base_fee_mode u8 @130.
  const dbcConfigBytes = ({ bps = 100, numberOfPeriod = 0, periodFrequency = 0n, reductionFactor = 0n, baseFeeMode = 0 } = {}) => {
    const b = Buffer.alloc(240);
    Keypair.generate().publicKey.toBuffer().copy(b, 40); // fee_claimer
    b.writeBigUInt64LE(BigInt(bps) * 100000n, 104);
    b.writeBigUInt64LE(periodFrequency, 112);
    b.writeBigUInt64LE(reductionFactor, 120);
    b.writeUInt16LE(numberOfPeriod, 128);
    b[130] = baseFeeMode;
    return b;
  };
  const poolArgs = { houseProgram: HOUSE_PROG, pool: D.housePoolPda(HOUSE_PROG, MINT), mint: MINT, engineConfigPda: Keypair.generate().publicKey, dbcPool: Keypair.generate().publicKey, dbcConfig: Keypair.generate().publicKey };
  const throwsWith = (fn, needle) => { try { fn(); return false; } catch (e) { return e.message.includes(needle); } };
  {
    const ix = buildActivatePoolIx({ ...poolArgs, feeBps: 100, launchRecordFeeBps: 100, dbcConfigBytes: dbcConfigBytes({ bps: 100 }) });
    ok(ix.data.readUInt16LE(1) === 100, 'C11 attestation: matching launch record + matching DBC config passes and builds the ix');
  }
  ok(throwsWith(() => buildActivatePoolIx({ ...poolArgs, feeBps: 100, launchRecordFeeBps: 200 }), 'does not match the launch record'),
    'C12 attestation: launch-record mismatch throws');
  ok(throwsWith(() => buildActivatePoolIx({ ...poolArgs, feeBps: 100, dbcConfigBytes: dbcConfigBytes({ bps: 200 }) }), 'does not match the DBC config'),
    'C13 attestation: DBC-config mismatch throws');
  ok(throwsWith(() => buildActivatePoolIx({ ...poolArgs, feeBps: 100 }), 'unattested') && throwsWith(() => attestFeeBps({ feeBps: 100 }), 'unattested'),
    'C14 attestation: no attestation source throws');
  {
    const p = parseDbcConfigFeeBps(dbcConfigBytes({ bps: 250 }));
    ok(p.feeBps === 250 && p.cliffFeeNumerator === 25000000n && p.numberOfPeriod === 0 && p.periodFrequency === 0n && p.reductionFactor === 0n && p.baseFeeMode === 0 && p.flat === true,
      'C15 parseDbcConfigFeeBps: flat config — cliff @104 derives bps (numerator / 100000), scheduler fields read at their offsets');
  }
  {
    const p = parseDbcConfigFeeBps(dbcConfigBytes({ bps: 300, numberOfPeriod: 10, periodFrequency: 60n, reductionFactor: 50n }));
    const ix = buildActivatePoolIx({ ...poolArgs, feeBps: 300, launchRecordFeeBps: 300, dbcConfigBytes: dbcConfigBytes({ bps: 300, numberOfPeriod: 10, periodFrequency: 60n, reductionFactor: 50n }) });
    ok(p.feeBps === 300 && p.flat === false && p.numberOfPeriod === 10 && ix.data.readUInt16LE(1) === 300,
      'C16 parseDbcConfigFeeBps: non-flat scheduler attests on the CLIFF (starting) rate — the launch-record rate — and builds');
  }
  ok(throwsWith(() => parseDbcConfigFeeBps(Buffer.alloc(100)), 'too short') && throwsWith(() => parseDbcConfigFeeBps(null), 'missing'),
    'C17 parseDbcConfigFeeBps: short / missing input throws (fail closed)');
  {
    const mismatch = planActivation({ configBytes: cfgPend, dbcPoolBytes: dbcPoolBytes(30000000000n), houseVault: { lamports: 0n, reserveBalance: 0n, feeBalance: 500000000n }, poolBytes: housePoolBytes(), feeBps: 100, launchRecordFeeBps: 200 });
    ok(!mismatch.ready && mismatch.steps.length === 0 && mismatch.missing.some(m => m.includes('fee rate attestation failed')),
      'C18 planActivation: a fee mismatch surfaces as a missing/not-ready reason — no bad activation is planned');
    const attested = planActivation({ configBytes: cfgPend, dbcPoolBytes: dbcPoolBytes(30000000000n), houseVault: { lamports: 0n, reserveBalance: 0n, feeBalance: 500000000n }, poolBytes: housePoolBytes(), feeBps: 100, launchRecordFeeBps: 100, dbcConfigBytes: dbcConfigBytes({ bps: 100 }) });
    ok(attested.ready && JSON.stringify(attested.steps) === JSON.stringify(['activate-house', 'activate-pool']),
      'C19 planActivation: matching record + config attestation threads through → ready with both steps');
  }
}

console.log('== D. launch.mjs dry-run house plan (spawned CLI) ==');
{
  const f = path.join(os.tmpdir(), `trial-house-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ name: 'Housey', symbol: 'HSE', rules: [{ id: 1, mode: 'latch' }, { id: 2 }, { id: 9, capBps: 500 }], graduation: 'house', graduationThresholdSol: 25, houseReserveSol: 0.5, houseSeedTokens: 1000000, houseSeedBuySol: 0.25, holderFees: { enabled: false } }));
  const r = spawnSync(process.execPath, ['launch.mjs', f, '--dry-run'], { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  fs.unlinkSync(f);
  const labels = [...r.stdout.matchAll(/^ {2}([A-Z0-9]+[a-z]?)\. /gm)].map(m => m[1]);
  ok(r.status === 0 && ['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].every(s => labels.includes(s)), 'D1 dry-run house plan carries H0–H6', labels.join(','));
  ok(r.stdout.includes('GRADUATION. house — graduate at the house threshold onto the house venue, the rules stay'), 'D2 dry-run shows the house GRADUATION line');
  ok(r.stdout.includes('reserve 0.5 + seed wallet funding 0.1 + seed buy 0.25'), 'D3 dry-run budget includes reserve + seed funding + seed buy');
  // Forks 1+3: a house + rule-9 spec's L3 line lists the FULL derived
  // exemption set — the two house vaults (seed not capped by rule 9) and
  // the fee-destination ATA (ClaimFees leg not capped by rule 9).
  const l3Line = r.stdout.split('\n').find((l) => l.includes('exemptions=[poolAuthority=')) ?? '';
  ok(['poolAuthority=', 'baseVault=', 'seedAta=', 'houseTokenVault=', 'houseQuoteVault=', 'feeDestTokenAta='].every((s) => l3Line.includes(s)),
    'D4 dry-run L3 names the full house exemption set [poolAuthority, baseVault, seedAta, houseTokenVault, houseQuoteVault, feeDestTokenAta]', l3Line);
}

console.log(`\n==== LAUNCHER HOUSE TRIAL (Phase C): ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// activation-keeper.mjs — Phase C house-activation keeper (contract §3.4).
//
// Watches house-committed tokens and, the moment activation is possible,
// fires the two permissionless flips:
//   1. engine tag 14 (ActivateHouse) — anyone may call it; the caller
//      earns HOUSE_CALLER_CUT_BPS (1%) of the vault's fee balance, the
//      seed (reserve + remaining fees) moves into the house quote vault,
//      the config appends the house venue + vault exemptions and flips
//      house_state to 2. The ENGINE checks every condition on-chain
//      (threshold from the real DBC pool, committed pool, seed) — this
//      keeper only decides WHEN a call can succeed, it cannot force one.
//   2. houseswap tag 5 (ActivatePool) — anyone; mirrors the curve's
//      creator fee onto the house pool. The DESTINATION is anchored
//      on-chain (read from the DBC config's fee_claimer); the RATE is
//      caller-supplied from the launch record and publicly verifiable
//      against the DBC config's fee scheduler.
//
// Pattern: buyback/buyback-crank.mjs — a library (pure decision fn +
// instruction builders) plus a guarded CLI. LOCAL ONLY in this build:
// the CLI hard-exits without --local and never opens an RPC connection;
// with --local it runs the pure decision fn against a JSON scenario.
// There is deliberately NO mainnet mode in this file — a future keeper
// host injects a live env the way the buyback trial injects LiteSVM.
import fs from 'fs';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { parseHouseSlot, housePoolPda, CONFIG_SPACE_V2 } from './doors.mjs';

export const ENGINE_PROGRAM_ID = new PublicKey('EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT');
export const DBC_POOL_OFF_QUOTE_RESERVE = 240;
export const HOUSE_POOL_SIZE = 264;
export const HOUSE_POOL_OFF_COMMITTED = 162;

const K = (pubkey, w = false, s = false) => ({ pubkey, isSigner: !!s, isWritable: !!w });

/**
 * Pure activation decision (contract §3.4).
 * @param {object} input
 *   { configBytes, dbcPoolBytes,
 *     houseVault: { lamports, reserveBalance, feeBalance },
 *     poolBytes,
 *     feeBps?, launchRecordFeeBps?, dbcConfigBytes? }
 *   Optional fee inputs thread the ActivatePool rate attestation
 *   through: when any is supplied, a fee mismatch (or a rate with no
 *   attestation source) surfaces as a `missing` not-ready reason.
 *   Byte inputs are the LIVE account data; houseVault fields are the
 *   HouseVault PDA's accounting mirrors (engine §1.3: reserve_balance
 *   @9..17, fee_balance @17..25 — callers read them; lamports is the
 *   account's lamport balance, carried for the report).
 * @returns {{ ready: boolean, missing: string[], steps: string[],
 *   done?: boolean, slot?: object }}
 *   ready → steps ['activate-house', 'activate-pool'].
 *   already activated → { ready:false, missing:[], steps:[], done:true }.
 */
/**
 * Parse the creator-fee rate out of a DBC PoolConfig account (Anchor
 * layout, research/dbc-program state/config.rs):
 *   discriminator @0..8 | quote_mint @8..40 | fee_claimer @40..72 |
 *   leftover_receiver @72..104 | pool_fees.base_fee @104:
 *     cliff_fee_numerator u64 @104, second_factor u64 @112
 *     (= period_frequency for the scheduler), third_factor u64 @120
 *     (= reduction_factor), first_factor u16 @128
 *     (= number_of_period), base_fee_mode u8 @130
 *     (0 = FeeSchedulerLinear).
 * FEE_DENOMINATOR = 1_000_000_000, so bps = cliff_fee_numerator / 100_000.
 * The cliff numerator is the STARTING fee: the launcher creates configs
 * flat (number_of_period = 0 / totalDuration = 0), so the cliff encodes
 * the launch-recorded starting feeBps. For a NON-FLAT scheduler config
 * (number_of_period > 0 or period_frequency > 0 or reduction_factor >
 * 0) this parser still returns the cliff-derived bps — the attestation
 * deliberately compares against the starting rate, matching the launch
 * record's fees.feeBps (the starting fee), never a decayed later rate.
 * @param {Buffer|Uint8Array} dbcConfigBytes raw PoolConfig account data
 * @returns {{ feeBps: number, cliffFeeNumerator: bigint,
 *   periodFrequency: bigint, reductionFactor: bigint,
 *   numberOfPeriod: number, baseFeeMode: number, flat: boolean }}
 *   Throws on short/malformed input.
 */
export function parseDbcConfigFeeBps(dbcConfigBytes) {
  if (!dbcConfigBytes || typeof dbcConfigBytes.length !== 'number') {
    throw new Error('parseDbcConfigFeeBps: DBC config bytes are missing');
  }
  const b = Buffer.from(dbcConfigBytes);
  // The fee scheduler fields run through base_fee_mode @130, so the
  // account must carry at least 131 bytes to be a readable PoolConfig.
  if (b.length < 131) {
    throw new Error(`parseDbcConfigFeeBps: DBC config account too short (${b.length} bytes; need at least 131 to read the base_fee scheduler through base_fee_mode @130)`);
  }
  const cliffFeeNumerator = b.readBigUInt64LE(104);
  const periodFrequency = b.readBigUInt64LE(112);
  const reductionFactor = b.readBigUInt64LE(120);
  const numberOfPeriod = b.readUInt16LE(128);
  const baseFeeMode = b[130];
  // FEE_DENOMINATOR = 1e9 and bps = numerator / 100_000 exactly; a
  // numerator that is not an exact multiple cannot be a bps rate the
  // launcher recorded (its configs are built from integer bps), so it
  // is malformed for attestation purposes — fail closed.
  if (cliffFeeNumerator % 100000n !== 0n) {
    throw new Error(`parseDbcConfigFeeBps: cliff_fee_numerator ${cliffFeeNumerator} is not an exact multiple of 100000 (FEE_DENOMINATOR 1e9 / 10000 bps) — cannot derive an integer fee bps`);
  }
  const feeBps = Number(cliffFeeNumerator / 100000n);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) {
    throw new Error(`parseDbcConfigFeeBps: cliff-derived fee ${feeBps} bps is outside 0..10000 — malformed DBC config`);
  }
  const flat = numberOfPeriod === 0 && periodFrequency === 0n && reductionFactor === 0n;
  return { feeBps, cliffFeeNumerator, periodFrequency, reductionFactor, numberOfPeriod, baseFeeMode, flat };
}

/**
 * Fee-rate attestation (Phase C fork 2, resolved): the ActivatePool
 * rate is caller-supplied, so it must be ATTESTED against at least one
 * independent source before an instruction is built:
 *   - launchRecordFeeBps — the launch record's fees.feeBps, and/or
 *   - dbcConfigBytes — the DBC PoolConfig account bytes, parsed by
 *     parseDbcConfigFeeBps (cliff = starting rate; see its doc for the
 *     non-flat scheduler choice).
 * Throws when no source is provided, when feeBps mismatches the
 * launch-record value, or when it mismatches the config-derived value.
 * Matching sources return the attestation detail.
 */
export function attestFeeBps({ feeBps, launchRecordFeeBps, dbcConfigBytes } = {}) {
  const hasRecord = launchRecordFeeBps != null;
  const hasConfig = dbcConfigBytes != null;
  if (!hasRecord && !hasConfig) {
    throw new Error('ActivatePool fee rate is unattested: no attestation source provided — pass launchRecordFeeBps (the launch record\'s fees.feeBps) and/or dbcConfigBytes (the DBC PoolConfig account) so the caller-supplied feeBps can be verified');
  }
  if (hasRecord && feeBps !== launchRecordFeeBps) {
    throw new Error(`ActivatePool fee rate attestation failed: caller-supplied feeBps ${feeBps} does not match the launch record's fees.feeBps ${launchRecordFeeBps}`);
  }
  let dbc = null;
  if (hasConfig) {
    dbc = parseDbcConfigFeeBps(dbcConfigBytes); // throws on short/malformed input
    if (feeBps !== dbc.feeBps) {
      throw new Error(`ActivatePool fee rate attestation failed: caller-supplied feeBps ${feeBps} does not match the DBC config's cliff-derived starting fee ${dbc.feeBps} bps${dbc.flat ? '' : ' (non-flat scheduler: number_of_period/period_frequency/reduction_factor set — the attestation uses the cliff starting rate, matching the launch record)'}`);
    }
  }
  return { feeBps, launchRecordFeeBps: hasRecord ? launchRecordFeeBps : null, dbc };
}

export function planActivation(input) {
  const { configBytes, dbcPoolBytes, houseVault, poolBytes, feeBps, launchRecordFeeBps, dbcConfigBytes } = input ?? {};
  const slot = parseHouseSlot(configBytes ?? null);
  if (!slot) {
    return { ready: false, missing: ['no house commitment — the engine config carries no house slot (not a house token)'], steps: [] };
  }
  if (slot.state === 2) return { ready: false, missing: [], steps: [], done: true, slot };
  const missing = [];
  // House pool committed? (pool record: tag 1, len >= 264, committed @162)
  if (!poolBytes || poolBytes.length < HOUSE_POOL_SIZE || poolBytes[0] !== 1) {
    missing.push('house pool account missing or malformed (no readable houseswap pool record for this mint)');
  } else if (poolBytes[HOUSE_POOL_OFF_COMMITTED] !== 1) {
    missing.push('house pool not committed — CommitPool (launch step H5) has not landed; activation would reject HouseNotCommitted (34)');
  }
  // Curve reserve vs the token's own house threshold.
  if (!dbcPoolBytes || dbcPoolBytes.length < DBC_POOL_OFF_QUOTE_RESERVE + 8) {
    missing.push('DBC pool account missing or too short to read the quote reserve @240');
  } else {
    const reserve = Buffer.from(dbcPoolBytes).readBigUInt64LE(DBC_POOL_OFF_QUOTE_RESERVE);
    if (reserve < slot.thresholdLamports) {
      missing.push(`curve quote reserve ${reserve} lamports is below the house threshold ${slot.thresholdLamports} lamports — short ${slot.thresholdLamports - reserve} lamports`);
    }
  }
  // Seed condition: committed reserve recorded, or fee-only with fees > 0.
  const hv = houseVault ?? { lamports: 0n, reserveBalance: 0n, feeBalance: 0n };
  const reserveBalance = BigInt(hv.reserveBalance ?? 0);
  const feeBalance = BigInt(hv.feeBalance ?? 0);
  if (slot.reserveLamports > 0n) {
    if (reserveBalance < slot.reserveLamports) {
      missing.push(`house reserve not recorded — HouseVault reserve_balance ${reserveBalance} lamports < committed reserve ${slot.reserveLamports} lamports (launch step H6 / engine tag 17)`);
    }
  } else if (feeBalance <= 0n) {
    missing.push('no activation seed — houseReserveSol is 0 and the HouseVault fee_balance is 0 (curve fees must be claimed and deposited via engine tag 16 first)');
  }
  // Fee-rate attestation (fork 2): when the caller supplies any fee
  // input (the rate and/or an attestation source), a mismatch — or a
  // rate with no attestation source — is a not-ready reason, never a
  // planned bad activation. With no fee inputs at all the plan shape is
  // unchanged (attestation is enforced at instruction-build time by
  // buildActivatePoolIx, which refuses an unattested rate outright).
  if (feeBps != null || launchRecordFeeBps != null || dbcConfigBytes != null) {
    if (feeBps == null) {
      missing.push('fee rate missing — an attestation source was supplied but no caller feeBps to attest (the ActivatePool rate from the launch record)');
    } else {
      try {
        attestFeeBps({ feeBps, launchRecordFeeBps, dbcConfigBytes });
      } catch (e) {
        missing.push(`fee rate attestation failed — ${e.message}`);
      }
    }
  }
  if (missing.length) return { ready: false, missing, steps: [], slot };
  return { ready: true, missing: [], steps: ['activate-house', 'activate-pool'], slot };
}

// ---------- instruction builders (the execute path; local-only here) ----------

/**
 * Engine tag 14 (ActivateHouse). Account order per contract §1.4:
 * [caller(signer), mint(ro), config(w), dbc_pool(ro), house_vault(w),
 *  house_pool(ro), house_token_vault(ro), house_quote_vault(ro),
 *  system(ro), token_program(ro — the LEGACY token program, SyncNative)].
 * The token/quote vaults are read from the house pool record
 * (@97..129 / @129..161) by the engine; pass the same accounts here.
 * RUNTIME FLAGS (proven by the trial's bundles and the HPROOF mainnet
 * activation, 2026-10-20): the CALLER and the HOUSE QUOTE VAULT must be
 * passed WRITABLE even though §1.4 lists them read-only — the engine
 * pays the caller cut and credits the seed to the quote vault as
 * lamports, and the runtime rejects balance changes on read-only
 * accounts. The flags below match the proven bundle
 * (deploy/proof-launches/activate.mjs) exactly.
 */
export function buildActivateHouseIx({ caller, mint, configPda, dbcPool, houseVaultPda, housePool, houseTokenVault, houseQuoteVault, engineProgram = ENGINE_PROGRAM_ID }) {
  return new TransactionInstruction({
    programId: engineProgram, data: Buffer.from([14]),
    keys: [
      K(caller, true, true), K(mint), K(configPda, true), K(dbcPool),
      K(houseVaultPda, true), K(housePool), K(houseTokenVault), K(houseQuoteVault, true),
      K(SystemProgram.programId), K(TOKEN_PROGRAM_ID),
    ],
  });
}

/**
 * Houseswap tag 5 (ActivatePool). Accounts per contract §2.2:
 * [pool(w), mint, engine_config(ro), dbc_pool(ro), dbc_config(ro)].
 * Data: [5][fee_bps u16] — the rate comes from the launch record
 * (the curve's creator fee); the destination is anchored on-chain.
 * ATTESTATION (fork 2): the caller-supplied feeBps is never trusted
 * alone — at least one attestation source must accompany it
 * (launchRecordFeeBps and/or dbcConfigBytes, see attestFeeBps) and
 * every supplied source must agree with it, or this throws.
 */
export function buildActivatePoolIx({ houseProgram, pool, mint, engineConfigPda, dbcPool, dbcConfig, feeBps, launchRecordFeeBps, dbcConfigBytes }) {
  if (!Number.isInteger(feeBps) || feeBps < 25 || feeBps > 9900) {
    throw new Error(`ActivatePool fee_bps must be an integer in 25..9900 (the DBC program's fee bounds), got ${feeBps}`);
  }
  attestFeeBps({ feeBps, launchRecordFeeBps, dbcConfigBytes }); // throws: no source / record mismatch / config mismatch
  const data = Buffer.alloc(3);
  data[0] = 5; data.writeUInt16LE(feeBps, 1);
  return new TransactionInstruction({
    programId: houseProgram, data,
    keys: [K(pool, true), K(mint), K(engineConfigPda), K(dbcPool), K(dbcConfig)],
  });
}

// ---------------------------------------------------------------------------
// Guarded CLI-shaped main — LOCAL ONLY (buyback-crank pattern).
// ---------------------------------------------------------------------------
// Without --local the process refuses and exits 2. With --local it still
// opens no RPC connection — it exercises planActivation against a JSON
// scenario of hex-encoded account bytes + vault mirrors, so the CLI
// shape (args in, plan out) can be smoke-tested offline:
//   node activation-keeper.mjs --local --scenario scenario.json
// Scenario: { configHex, dbcPoolHex, poolHex,
//             houseVault: { lamports, reserveBalance, feeBalance } }
// (decimal strings for the vault numbers). Defaults demonstrate a
// below-threshold not-ready plan.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  if (!args.includes('--local')) {
    console.error('activation-keeper: REFUSED — this Phase-C build is local-only. Re-run with --local for the offline decision demo. No mainnet mode exists in this build.');
    process.exit(2);
  }
  const flagValue = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const scenarioArg = flagValue('--scenario');
  const demoConfig = () => {
    const b = Buffer.alloc(CONFIG_SPACE_V2);
    new PublicKey('11111111111111111111111111111111').toBuffer().copy(b, 1088);
    b.writeBigUInt64LE(25_000_000_000n, 1120); // threshold 25 SOL
    b.writeBigUInt64LE(0n, 1128); // no reserve
    b[1144] = 1; // pending
    return b;
  };
  const demoPool = () => { const b = Buffer.alloc(424); b.writeBigUInt64LE(10_000_000_000n, DBC_POOL_OFF_QUOTE_RESERVE); return b; };
  const demoHousePool = () => { const b = Buffer.alloc(HOUSE_POOL_SIZE); b[0] = 1; b[HOUSE_POOL_OFF_COMMITTED] = 1; return b; };
  const scenario = scenarioArg ? JSON.parse(fs.readFileSync(scenarioArg, 'utf8')) : null;
  const input = scenario ? {
    configBytes: Buffer.from(scenario.configHex, 'hex'),
    dbcPoolBytes: Buffer.from(scenario.dbcPoolHex, 'hex'),
    poolBytes: Buffer.from(scenario.poolHex, 'hex'),
    houseVault: {
      lamports: BigInt(scenario.houseVault?.lamports ?? 0),
      reserveBalance: BigInt(scenario.houseVault?.reserveBalance ?? 0),
      feeBalance: BigInt(scenario.houseVault?.feeBalance ?? 0),
    },
  } : {
    configBytes: demoConfig(), dbcPoolBytes: demoPool(), poolBytes: demoHousePool(),
    houseVault: { lamports: 0n, reserveBalance: 0n, feeBalance: 0n },
  };
  const plan = planActivation(input);
  console.log(JSON.stringify({
    mode: 'local-decision-demo (no chain connection opened)',
    plan: {
      ready: plan.ready, done: !!plan.done, missing: plan.missing, steps: plan.steps,
      ...(plan.slot ? { slot: { program: plan.slot.program.toBase58(), thresholdLamports: plan.slot.thresholdLamports.toString(), reserveLamports: plan.slot.reserveLamports.toString(), state: plan.slot.state } } : {}),
    },
  }, null, 2));
}

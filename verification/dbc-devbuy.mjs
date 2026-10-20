// DBC x ENGINE — BUNDLED DEV BUY end-to-end (LiteSVM), Phase 4 Feature B.
//
// Reproduces launch.mjs's dev-buy sequence (spec devBuySol set, rule 1
// Basis Latch in the stack) against the real DBC binary + engine:
//   launch (L1 config -> L2 pool -> L3 engine config [rule 1] -> L4
//   templated metas -> L4b price feed -> L5 rent vault)
//   -> L8c CrankPriceDbc (the rule-1 prerequisite: first crank BEFORE
//      the first buy, the Latch mainnet order)
//   -> launcher ATA creation (the swap build reads its owner field)
//   -> L9 the dev buy: swap2WithTransferHook, the FIRST swap after
//      activation — pool sqrt_price is asserted untouched by any trade
//      before it, the launcher receives the tokens, and the buy creates
//      the launcher's rule-1 Holder PDA with basis == the cranked EMA,
//      exactly. The launch-record devBuy shape {sol, tx, received,
//      receivedRaw} is reconstructed from the measured delta.
// Same-tx dev buy is impossible on the standard build path (the swap
// build reads the on-chain meta list, which exists only after L4) —
// this trial proves the shipped bound form instead: first swap after
// activation, same run, nothing intervening.
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { Clock } from 'litesvm';
import BN from 'bn.js';
import fs from 'fs';
import {
  DynamicBondingCurveClient, buildCurve, SwapMode, TokenType, TokenDecimal,
  ActivationType, BaseFeeMode, CollectFeeMode, MigrationOption,
  MigrationFeeOption, TokenAuthorityOption, deriveDbcPoolAddress,
  deriveDbcPoolAuthority, deriveDbcTokenVaultAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  BUILD_DIR, DBC_ID, makeSvm, patchConnection, sendTx, fund, tokenBalance,
} from '../proof/svm-harness.mjs';

const engineKp = JSON.parse(fs.readFileSync(`${BUILD_DIR}/engine/engine-keypair.json`, 'utf8'));
const ENGINE = Keypair.fromSecretKey(Uint8Array.from(engineKp)).publicKey;
const INIT_METAS_DISC = Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]);
const DEV_BUY_SOL = 0.05;

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const step = (name, data) => console.log(`== ${name}`, data ?? '');

const svm = makeSvm([
  [DBC_ID, `${BUILD_DIR}/bin/dynamic_bonding_curve.so`],
  [ENGINE, `${BUILD_DIR}/engine/target/deploy/engine.so`],
]);
const conn = patchConnection(svm);
const client = new DynamicBondingCurveClient(conn, 'confirmed');

let clockSlot = BigInt(svm.getClock().slot);
const setTime = (ts) => { clockSlot += 17n; svm.setClock(new Clock(clockSlot, 0n, 0n, 0n, BigInt(ts))); };
const T0 = 1_760_100_000;
setTime(T0);

// ONE wallet plays every launcher role, exactly as in launch.mjs:
// payer, pool creator, fee claimer, engine config authority, dev buyer.
const launcher = Keypair.generate();
fund(svm, launcher, 200);
step('actors', { engine: ENGINE.toBase58(), launcher: launcher.publicKey.toBase58(), devBuySol: DEV_BUY_SOL });

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, ENGINE)[0];
const configPda = (mint) => pda([Buffer.from('config'), mint.toBuffer()]);
const holderPda = (mint, owner) => pda([Buffer.from('holder'), mint.toBuffer(), owner.toBuffer()]);
const vaultPda = (mint) => pda([Buffer.from('rentvault'), mint.toBuffer()]);
const metaPda = (mint) => pda([Buffer.from('extra-account-metas'), mint.toBuffer()]);
const pricePda = (mint) => pda([Buffer.from('price'), mint.toBuffer()]);
const acctData = (pk) => { const a = svm.getAccount(pk); return a ? Buffer.from(a.data) : null; };
const readU128 = (buf, off) => buf.readBigUInt64LE(off) + (buf.readBigUInt64LE(off + 8) << 64n);
const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });

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
  authority.toBuffer().copy(tail, 11);
  parts.push(tail);
  return Buffer.concat(parts);
}
const latchParams = () => {
  const p = Buffer.alloc(64);
  p.writeBigUInt64LE(300n, 0); // max_stale_secs
  p.writeBigUInt64LE(0n, 8);   // ema half-life 0 -> crank takes spot
  p.writeUInt16LE(0, 16);      // max_crank_bps 0 -> default
  p[18] = 0;                   // LATCH
  return p;
};
function curveConfig(threshold) {
  return buildCurve({
    token: {
      tokenType: TokenType.Token2022, tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAuthority,
      totalTokenSupply: 1_000_000_000, leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Slot,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: threshold,
  });
}

// ================= LAUNCH (activation) =================
step('LAUNCH', 'L1 -> L2 -> L3 [rule 1] -> L4 -> L4b -> L5, exactly the launch.mjs order');
const dbcConfig = Keypair.generate();
{
  const tx = await client.partner.createConfigWithTransferHook({
    config: dbcConfig.publicKey, feeClaimer: launcher.publicKey,
    leftoverReceiver: launcher.publicKey, payer: launcher.publicKey,
    quoteMint: NATIVE_MINT, transferHookProgram: ENGINE, ...curveConfig(42),
  });
  const r = sendTx(svm, tx, [launcher, dbcConfig], 'L1 createConfigWithTransferHook');
  ok(r.ok, 'L1 DBC config created naming ENGINE');
}
const baseMint = Keypair.generate();
let pool, poolAuthority, baseVault, quoteVault;
{
  const tx = await client.creator.createPoolWithTransferHook({
    baseMint: baseMint.publicKey, config: dbcConfig.publicKey, transferHookProgram: ENGINE,
    name: 'DevBuyProof', symbol: 'DVBP', uri: 'https://example.invalid/dvbp.json',
    payer: launcher.publicKey, poolCreator: launcher.publicKey,
  });
  const r = sendTx(svm, tx, [launcher, baseMint], 'L2 createPoolWithTransferHook');
  pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, dbcConfig.publicKey);
  poolAuthority = deriveDbcPoolAuthority();
  baseVault = deriveDbcTokenVaultAddress(pool, baseMint.publicKey);
  quoteVault = deriveDbcTokenVaultAddress(pool, NATIVE_MINT);
  ok(r.ok, 'L2 DBC pool created; mint carries ENGINE hook');
}
const mint = baseMint.publicKey;
const sqrtAtBirth = () => readU128(acctData(pool), 280);
const sqrtBirth = sqrtAtBirth();
{
  const cfg = { mode: 0, authority: launcher.publicKey, rules: [{ id: 1, params: latchParams() }], venues: [DBC_ID], exemptions: [poolAuthority, baseVault] };
  const ix = new TransactionInstruction({ programId: ENGINE, data: configPayload(cfg, 1),
    keys: [K(launcher.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, true), K(SystemProgram.programId, false, false)] });
  ok(sendTx(svm, new Transaction().add(ix), [launcher], 'L3 InitializeConfig').ok, 'L3 engine config: Basis Latch only, Locked');
  const ix2 = new TransactionInstruction({ programId: ENGINE, data: INIT_METAS_DISC,
    keys: [K(launcher.publicKey, true, true), K(metaPda(mint), false, true), K(mint, false, false), K(SystemProgram.programId, false, false), K(configPda(mint), false, false)] });
  ok(sendTx(svm, new Transaction().add(ix2), [launcher], 'L4 InitializeExtraAccountMetas').ok, 'L4 meta list initialized (templated per config)');
  const data = Buffer.concat([Buffer.from([6]), pool.toBuffer(), baseVault.toBuffer(), quoteVault.toBuffer(), Buffer.from([6, 9])]);
  const ix3 = new TransactionInstruction({ programId: ENGINE, data,
    keys: [K(launcher.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, false), K(pricePda(mint), false, true), K(SystemProgram.programId, false, false)] });
  ok(sendTx(svm, new Transaction().add(ix3), [launcher], 'L4b InitializePriceFeed').ok, 'L4b price feed initialized pinning the DBC pool');
  const ix4 = SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: vaultPda(mint), lamports: 50_000_000 });
  ok(sendTx(svm, new Transaction().add(ix4), [launcher], 'L5 fund rent vault').ok, 'L5 rent vault funded — activation complete');
}

// ================= DEV BUY (L8c crank -> ATA -> L9 buy) =================
step('DEV BUY', 'no swap has landed yet — the dev buy must be the first');
const launcherAta = getAssociatedTokenAddressSync(mint, launcher.publicKey, false, TOKEN_2022_PROGRAM_ID);
ok(acctData(launcherAta) === null, 'pre-buy: launcher ATA does not exist yet');
ok(acctData(holderPda(mint, launcherAta)) === null, 'pre-buy: launcher Holder PDA does not exist yet');
ok(sqrtAtBirth() === sqrtBirth, 'pre-buy: pool sqrt_price untouched since L2 — zero trades have intervened');
ok(readU128(acctData(pricePda(mint)), 97) === 0n && acctData(pricePda(mint)).readBigUInt64LE(121) === 0n, 'pre-buy: feed never cranked (ema 0, count 0)');

const expectedSpot = () => {
  const s = sqrtAtBirth();
  const sq = s * s;
  const a = sq >> 64n;
  const b = a * 1_000_000_000_000n;
  const c = b >> 64n;
  return c / 10n ** 3n; // token_dec 6 < quote_dec 9
};
let crankedEma;
{
  setTime(T0 + 10);
  const spot = expectedSpot();
  const crankIx = new TransactionInstruction({ programId: ENGINE, data: Buffer.from([8]),
    keys: [K(configPda(mint), false, false), K(pricePda(mint), false, true), K(pool, false, false)] });
  const r = sendTx(svm, new Transaction().add(crankIx), [launcher], 'L8c CrankPriceDbc');
  ok(r.ok, 'L8c crank lands BEFORE the buy (rule-1 prerequisite)');
  crankedEma = readU128(acctData(pricePda(mint)), 97);
  ok(crankedEma === spot && spot > 0n, 'L8c feed EMA == curve spot exactly (first crank takes spot)', `ema=${crankedEma}`);
  ok(acctData(pricePda(mint)).readBigUInt64LE(121) === 1n, 'L8c crank_count = 1');
  ok(sqrtAtBirth() === sqrtBirth, 'L8c crank moved no curve state — the buy is still the first swap');
}
{
  const r = sendTx(svm, new Transaction().add(
    createAssociatedTokenAccountInstruction(launcher.publicKey, launcherAta, launcher.publicKey, mint, TOKEN_2022_PROGRAM_ID),
  ), [launcher], 'create launcher ATA');
  ok(r.ok, 'launcher ATA created (required before the swap build)');
}
let devBuyRecord;
{
  setTime(T0 + 20);
  const before = tokenBalance(svm, launcherAta);
  const tx = await client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: false,
    amountIn: new BN(Math.round(DEV_BUY_SOL * 1e9).toString()), minimumAmountOut: new BN(0),
    owner: launcher.publicKey, pool, referralTokenAccount: null, payer: launcher.publicKey,
  });
  const r = sendTx(svm, tx, [launcher], 'L9 dev buy');
  ok(r.ok, 'L9 dev buy succeeds as the first swap after activation');
  const after = tokenBalance(svm, launcherAta);
  ok(after > before && before === 0n, 'L9 launcher wallet RECEIVES the tokens', `received=${after}`);
  ok(sqrtAtBirth() !== sqrtBirth, 'L9 the buy is what moved the curve — it was the first trade');
  const holder = acctData(holderPda(mint, launcherAta));
  ok(holder !== null, 'L9 rule-1 Holder PDA created for the launcher by the buy');
  // Basis semantics proven in dbc-latch (B1): the value at Holder PDA
  // offset 6 equals the cranked EMA the buy executed against, exactly.
  ok(holder !== null && readU128(holder, 6) === crankedEma, 'L9 holder basis recorded EXACTLY from the cranked EMA', `basis=${holder ? readU128(holder, 6) : 'none'} ema=${crankedEma}`);
  devBuyRecord = { sol: DEV_BUY_SOL, tx: r.sig ?? 'litesvm', received: (Number(after - before) / 1e6).toString(), receivedRaw: (after - before).toString() };
  ok(BigInt(devBuyRecord.receivedRaw) === after - before && BigInt(devBuyRecord.receivedRaw) > 0n,
    'record shape: devBuy {sol, tx, received, receivedRaw} reconstructs from the measured delta', JSON.stringify(devBuyRecord));
}

console.log(`\n==== DBC DEV-BUY TRIAL: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

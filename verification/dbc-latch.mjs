// DBC x ENGINE — END-TO-END BASIS LATCH on a real bonding curve (LiteSVM).
//
// The flagship proof for engine v2 + the DBC crank (tag 8, CrankPriceDbc):
// a fresh DBC pool whose engine config enables ONLY rule 1 (Basis Latch).
//   crank (DBC, from pool sqrt_price) -> buyer buys (basis recorded from
//   the cranked EMA, exactly) -> crank -> sell VETOED above basis (engine
//   Locked, atomic) -> exempt market-maker wallet sells the price down ->
//   crank the dip -> sell passes and LATCHES -> price recovers -> latched
//   sell at profit passes -> staleness fails closed on the DBC path too
//   -> crank revives -> sell passes.
// Every EMA value is asserted EXACTLY against a JS replica of the crank's
// integer formula fed by the pool account's sqrt_price bytes; every basis
// value is asserted exactly against the Holder PDA bytes.
// Price movement: the config exempts a market-maker wallet (the launcher
// ops-wallet pattern — exemptions are a per-mint config surface), so its
// trades skip gate + bookkeeping and can move the curve both ways.
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

// controllable clock (trial.mjs pattern)
let clockSlot = BigInt(svm.getClock().slot);
const setTime = (ts) => { clockSlot += 17n; svm.setClock(new Clock(clockSlot, 0n, 0n, 0n, BigInt(ts))); };
const T0 = 1_760_000_000;
setTime(T0);

const partner = Keypair.generate();
const creator = Keypair.generate(); // pool creator AND engine config authority
const mm = Keypair.generate();      // exempt market-maker (launcher ops wallet)
const buyer = Keypair.generate();   // "B" — the latched holder under test
for (const k of [partner, creator, mm, buyer]) fund(svm, k, 200);
step('actors', { engine: ENGINE.toBase58(), mm: mm.publicKey.toBase58(), buyer: buyer.publicKey.toBase58() });

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
  creator.publicKey.toBuffer().copy(tail, 11);
  parts.push(tail);
  return Buffer.concat(parts);
}
// rule 1 params: max_stale_secs=300 @0, ema_half_life=0 @8 (fold takes spot),
// max_crank_bps=0 @16 (-> default 10000, unclamped), mode byte 0 @18 = LATCH.
const latchParams = () => {
  const p = Buffer.alloc(64);
  p.writeBigUInt64LE(300n, 0);
  p.writeBigUInt64LE(0n, 8);
  p.writeUInt16LE(0, 16);
  p[18] = 0;
  return p;
};
const initConfigIx = (mint, cfg) => new TransactionInstruction({
  programId: ENGINE, data: configPayload(cfg, 1),
  keys: [K(creator.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, true), K(SystemProgram.programId, false, false)],
});
const initMetasIx = (mint) => new TransactionInstruction({
  programId: ENGINE, data: INIT_METAS_DISC,
  keys: [
    K(creator.publicKey, true, true), K(metaPda(mint), false, true), K(mint, false, false),
    K(SystemProgram.programId, false, false), K(configPda(mint), false, false),
  ],
});
const initPriceFeedIx = (mint, pool, tokenVault, quoteVault, tokenDec, quoteDec) => new TransactionInstruction({
  programId: ENGINE,
  data: Buffer.concat([Buffer.from([6]), pool.toBuffer(), tokenVault.toBuffer(), quoteVault.toBuffer(), Buffer.from([tokenDec, quoteDec])]),
  keys: [
    K(creator.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, false),
    K(pricePda(mint), false, true), K(SystemProgram.programId, false, false),
  ],
});
const crankDbcIx = (mint, poolPk) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([8]),
  keys: [K(configPda(mint), false, false), K(pricePda(mint), false, true), K(poolPk, false, false)],
});

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
    lockedVesting: {
      totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
      totalVestingDuration: 0, cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Slot,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: threshold,
  });
}

// ================= LAUNCH =================
step('LAUNCH', 'DBC pool (ENGINE hook) -> engine config [BasisLatch] -> metas -> price feed -> rent vault');
const dbcConfig = Keypair.generate();
{
  const tx = await client.partner.createConfigWithTransferHook({
    config: dbcConfig.publicKey, feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey, payer: partner.publicKey,
    quoteMint: NATIVE_MINT, transferHookProgram: ENGINE, ...curveConfig(42),
  });
  const r = sendTx(svm, tx, [partner, dbcConfig], 'createConfigWithTransferHook(engine)');
  ok(r.ok, 'L1 DBC config created naming ENGINE');
}
const baseMint = Keypair.generate();
let pool, poolAuthority, baseVault, quoteVault;
{
  const tx = await client.creator.createPoolWithTransferHook({
    baseMint: baseMint.publicKey, config: dbcConfig.publicKey, transferHookProgram: ENGINE,
    name: 'LatchProof', symbol: 'LTCH', uri: 'https://example.invalid/ltch.json',
    payer: creator.publicKey, poolCreator: creator.publicKey,
  });
  const r = sendTx(svm, tx, [creator, baseMint], 'createPoolWithTransferHook(engine)');
  pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, dbcConfig.publicKey);
  poolAuthority = deriveDbcPoolAuthority();
  baseVault = deriveDbcTokenVaultAddress(pool, baseMint.publicKey);
  quoteVault = deriveDbcTokenVaultAddress(pool, NATIVE_MINT);
  ok(r.ok, 'L2 DBC pool created; mint carries ENGINE hook', `pool=${pool.toBase58()}`);
}
const mint = baseMint.publicKey;
const mintRaw = Buffer.from(svm.getAccount(mint).data);
const TOK_DEC = mintRaw[44], QUOTE_DEC = 9;
ok(TOK_DEC === 6, 'L2 base mint decimals = 6 (feed token_dec source)', `dec=${TOK_DEC}`);

{
  const cfg = {
    mode: 1, authority: creator.publicKey,
    rules: [{ id: 1, params: latchParams() }],
    venues: [DBC_ID], exemptions: [poolAuthority, baseVault, mm.publicKey],
  };
  const r = sendTx(svm, new Transaction().add(initConfigIx(mint, cfg)), [creator], 'engine InitializeConfig [BasisLatch]');
  ok(r.ok, 'L3 engine config: Basis Latch only; DBC allowlisted; pool + MM exempt');
  const r2 = sendTx(svm, new Transaction().add(initMetasIx(mint)), [creator], 'engine InitializeExtraAccountMetas');
  ok(r2.ok, 'L4 meta list initialized (tail v2)');
  const r3 = sendTx(svm, new Transaction().add(initPriceFeedIx(mint, pool, baseVault, quoteVault, TOK_DEC, QUOTE_DEC)), [creator], 'engine InitializePriceFeed');
  ok(r3.ok, 'L5 price feed initialized pinning the DBC pool');
  const r4 = sendTx(svm, new Transaction().add(SystemProgram.transfer({
    fromPubkey: creator.publicKey, toPubkey: vaultPda(mint), lamports: 50_000_000,
  })), [creator], 'fund rent vault');
  ok(r4.ok, 'L6 rent vault funded');
}
const mmAta = getAssociatedTokenAddressSync(mint, mm.publicKey, false, TOKEN_2022_PROGRAM_ID);
const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
{
  const r = sendTx(svm, new Transaction().add(
    createAssociatedTokenAccountInstruction(creator.publicKey, mmAta, mm.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(creator.publicKey, buyerAta, buyer.publicKey, mint, TOKEN_2022_PROGRAM_ID),
  ), [creator], 'pre-create ATAs');
  ok(r.ok, 'L7 ATAs pre-created (build-time resolution requirement)');
}

// ---------- pool/feed/holder readers + exact spot replica ----------
// PoolState bytes (verified vs the loaded binary): base_mint @136, sqrt_price @280 (u128 LE).
const poolSqrt = () => readU128(acctData(pool), 280);
const poolBaseMint = () => new PublicKey(acctData(pool).subarray(136, 168));
ok(poolBaseMint().equals(mint) && acctData(pool).length === 424,
  'P0 pool layout pinned: 424-byte account, base_mint @136 matches the mint');
// JS replica of crank_price_dbc's integer steps — MUST match op-for-op.
const expectedSpot = () => {
  const s = poolSqrt();
  const sq = s * s;
  const a = sq >> 64n;
  const b = a * 1_000_000_000_000n;
  const c = b >> 64n;
  return TOK_DEC >= QUOTE_DEC ? c * 10n ** BigInt(TOK_DEC - QUOTE_DEC) : c / 10n ** BigInt(QUOTE_DEC - TOK_DEC);
};
const feedEma = () => readU128(acctData(pricePda(mint)), 97);
const feedCranks = () => acctData(pricePda(mint)).readBigUInt64LE(121);
const holderOf = (owner) => acctData(holderPda(mint, getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID)));
const holderBasis = (owner) => { const h = holderOf(owner); return h ? readU128(h, 6) : null; };
const holderLatched = (owner) => { const h = holderOf(owner); return h ? h[38] : null; };

async function swap(owner, baseForQuote, amount) {
  const tx = await client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: baseForQuote,
    amountIn: new BN(amount.toString()), minimumAmountOut: new BN(0),
    owner: owner.publicKey, pool, referralTokenAccount: null, payer: owner.publicKey,
  });
  return sendTx(svm, tx, [owner], `${baseForQuote ? 'sell' : 'buy'} ${amount} by ${owner === mm ? 'MM' : 'B'}`);
}
const crank = (label) => sendTx(svm, new Transaction().add(crankDbcIx(mint, pool)), [creator], label);

// ---------- DBC crank: fail-closed negatives ----------
console.log('\n=== DBC CRANK: fail-closed negatives ===');
{
  const rBad1 = sendTx(svm, new Transaction().add(crankDbcIx(mint, dbcConfig.publicKey)), [creator], 'crank with DBC config account as pool');
  ok(!rBad1.ok && (rBad1.logs || []).some((l) => l.includes('not the feed\'s pinned pool')),
    'N1 crank rejects an account that is not the feed\'s pinned pool (DBC config account)');
  ok((rBad1.logs || []).some((l) => l.includes('custom program error: 0x12')),
    'N1 failure error is PriceFeedBad (custom 18 / 0x12)');
  const rBad2 = sendTx(svm, new Transaction().add(crankDbcIx(mint, creator.publicKey)), [creator], 'crank with a system-owned account as pool');
  ok(!rBad2.ok, 'N2 crank rejects an account not owned by the DBC program');
  const rBad3 = sendTx(svm, new Transaction().add(crankDbcIx(mint, baseVault)), [creator], 'crank with the token vault as pool');
  ok(!rBad3.ok, 'N3 crank rejects an account that is not the feed\'s pinned pool');
  const f = acctData(pricePda(mint));
  ok(readU128(f, 97) === 0n && f.readBigUInt64LE(121) === 0n, 'N4 failed cranks wrote nothing (ema 0, count 0)');
}

// ---------- crank #1: EMA takes the curve spot exactly ----------
console.log('\n=== LATCH FLOW ===');
let basisB;
{
  const spot = expectedSpot();
  const r = crank('crank#1 (initial)');
  ok(r.ok, 'C1 DBC crank succeeds against the real pool account');
  ok((r.logs || []).some((l) => l.includes('crank(dbc)') && l.includes(`spot ${spot}`)),
    'C1 crank spot in logs equals the JS replica from pool sqrt_price bytes', `spot=${spot}`);
  ok(feedEma() === spot && spot > 0n, 'C1 feed EMA == curve spot exactly (first crank takes spot)', `ema=${feedEma()}`);
  ok(feedCranks() === 1n, 'C1 crank_count = 1');
}

// ---------- MM pumps (exempt), crank, B buys at the cranked EMA ----------
{
  setTime(T0 + 10);
  const r = await swap(mm, false, 300_000_000n); // buy 0.30 SOL
  ok(r.ok, 'M1 exempt MM buy passes (no gate, no basis bookkeeping)');
  const mh = holderOf(mm.publicKey);
  ok(mh === null || readU128(mh, 6) === 0n, 'M1 MM holder records NO basis (exempt destination)');
  ok(tokenBalance(svm, mmAta) > 0n, 'M1 MM holds tokens', `bal=${tokenBalance(svm, mmAta)}`);
  const r2 = crank('crank#2 (post-pump)');
  const spot = expectedSpot();
  ok(r2.ok && feedEma() === spot, 'C2 EMA == pumped curve spot exactly', `ema=${spot}`);
  globalThis.__emaMm = spot;
}
{
  setTime(T0 + 20);
  const r = await swap(buyer, false, 50_000_000n); // buy 0.05 SOL
  ok(r.ok, 'B1 buyer buy passes');
  basisB = holderBasis(buyer.publicKey);
  ok(basisB === globalThis.__emaMm, 'B1 buyer basis recorded EXACTLY from the DBC-cranked EMA', `basis=${basisB} ema_at_buy=${globalThis.__emaMm}`);
  ok(tokenBalance(svm, buyerAta) > 0n, 'B1 buyer holds tokens', `bal=${tokenBalance(svm, buyerAta)}`);
  const r2 = crank('crank#3 (post-buy)');
  const spot = expectedSpot();
  ok(r2.ok && feedEma() === spot, 'C3 EMA == spot exactly after buyer buy', `ema=${spot}`);
  ok(spot >= basisB, 'C3 spot (hence EMA) >= buyer basis — the gate must lock', `ema=${spot} basis=${basisB}`);
}

// ---------- sell above basis: vetoed, atomically ----------
{
  setTime(T0 + 30);
  const balBefore = tokenBalance(svm, buyerAta);
  const sqrtBefore = poolSqrt();
  const sellAmt = balBefore / 10n;
  const r = await swap(buyer, true, sellAmt);
  ok(!r.ok, 'S1 sell while EMA >= basis FAILS');
  ok((r.logs || []).some((l) => l.includes('locked: price')), 'S1 failure is the Basis Latch veto (log: "engine: locked: price ... >= basis ...")');
  ok((r.logs || []).some((l) => l.includes('custom program error: 0xf')), 'S1 engine error is Locked (custom 15 / 0xf)');
  ok(tokenBalance(svm, buyerAta) === balBefore, 'S1 veto atomic — buyer balance unchanged');
  ok(poolSqrt() === sqrtBefore, 'S1 veto atomic — curve state unchanged');
  ok(holderLatched(buyer.publicKey) === 0, 'S1 latch NOT set by the vetoed sell');
  ok(holderBasis(buyer.publicKey) === basisB, 'S1 basis unchanged');
}

// ---------- MM dumps -> crank the dip -> sell passes and latches ----------
{
  setTime(T0 + 40);
  const mmBal = tokenBalance(svm, mmAta);
  const r = await swap(mm, true, mmBal);
  ok(r.ok, 'M2 exempt MM sells its whole bag (gate skipped) — curve price falls');
  ok(tokenBalance(svm, mmAta) === 0n, 'M2 MM token balance is 0');
  const r2 = crank('crank#4 (the dip)');
  const spot = expectedSpot();
  ok(r2.ok && feedEma() === spot, 'C4 EMA == dipped curve spot exactly', `ema=${spot}`);
  ok(spot < basisB, 'C4 dipped EMA is BELOW buyer basis — the gate must open', `ema=${spot} < basis=${basisB}`);
  globalThis.__balBeforeDipSell = tokenBalance(svm, buyerAta);
}
{
  setTime(T0 + 50);
  const balBefore = globalThis.__balBeforeDipSell;
  const sellAmt = balBefore / 10n;
  const r = await swap(buyer, true, sellAmt);
  ok(r.ok, 'S2 dip sell PASSES');
  ok(holderLatched(buyer.publicKey) === 1, 'S2 LATCH SET in the buyer Holder PDA');
  ok(holderBasis(buyer.publicKey) === basisB, 'S2 basis intact after the latch sell', `basis=${holderBasis(buyer.publicKey)}`);
  ok(tokenBalance(svm, buyerAta) === balBefore - sellAmt, 'S2 buyer balance reduced by exactly the sold amount');
}

// ---------- recovery: latched sell at profit ----------
{
  setTime(T0 + 60);
  const r = await swap(mm, false, 500_000_000n); // buy 0.50 SOL — recover the price
  ok(r.ok, 'M3 MM buy recovers the curve price');
  const r2 = crank('crank#5 (recovery)');
  const spot = expectedSpot();
  ok(r2.ok && feedEma() === spot, 'C5 EMA == recovered spot exactly', `ema=${spot}`);
  ok(spot > basisB, 'C5 EMA back ABOVE buyer basis', `ema=${spot} > basis=${basisB}`);
  setTime(T0 + 70);
  const balBefore = tokenBalance(svm, buyerAta);
  const r3 = await swap(buyer, true, balBefore / 10n);
  ok(r3.ok, 'S3 latched sell at profit PASSES despite EMA > basis');
  ok(holderLatched(buyer.publicKey) === 1, 'S3 latch persists');
}

// ---------- staleness on the DBC path ----------
{
  setTime(T0 + 70 + 301); // 301 s past the last crank (max_stale = 300)
  const balBefore = tokenBalance(svm, buyerAta);
  const r = await swap(buyer, true, balBefore / 10n);
  ok(!r.ok, 'S4 sell with a stale feed FAILS even for a latched holder');
  ok((r.logs || []).some((l) => l.includes('stale price feed')), 'S4 failure is StalePrice (log: "engine: locked: stale price feed")');
  ok((r.logs || []).some((l) => l.includes('custom program error: 0x10')), 'S4 engine error is StalePrice (custom 16 / 0x10)');
  const r2 = crank('crank#6 (revive)');
  const spot = expectedSpot();
  ok(r2.ok && feedEma() === spot, 'C6 DBC crank revives the feed (EMA == spot)', `ema=${spot}`);
  const r3 = await swap(buyer, true, tokenBalance(svm, buyerAta) / 10n);
  ok(r3.ok, 'S5 sell passes again after the crank');
}

// ---------- malformed pool state, corrupted in place ----------
console.log('\n=== DBC CRANK: malformed pool state (in-place corruption) ===');
{
  const orig = svm.getAccount(pool);
  const corrupted = Buffer.from(orig.data);
  corrupted.fill(0, 136, 168); // zero the base_mint field, keep everything else
  svm.setAccount(pool, { ...orig, data: new Uint8Array(corrupted) });
  const r = crank('crank with corrupted pool state');
  ok(!r.ok && (r.logs || []).some((l) => l.includes('pool state malformed')),
    'N5 crank fails closed on a pinned-pool account whose base_mint does not match (log: "pool state malformed")');
  ok((r.logs || []).some((l) => l.includes('custom program error: 0x12')), 'N5 failure error is PriceFeedBad (custom 18 / 0x12)');
  svm.setAccount(pool, orig);
  const r2 = crank('crank after restore');
  ok(r2.ok && feedEma() === expectedSpot(), 'N6 crank works again after the pool account is restored byte-for-byte');
}

console.log(`\n==== DBC x ENGINE — END-TO-END BASIS LATCH: ${pass} passed, ${fail} failed ====`);
fs.writeFileSync(`${BUILD_DIR}/integration/dbc-latch-result.json`,
  JSON.stringify({ engine: ENGINE.toBase58(), engineVersion: 2, mint: mint.toBase58(), pool: pool.toBase58(), basisRecorded: String(basisB), pass, fail }, null, 2));
if (fail > 0) process.exit(1);

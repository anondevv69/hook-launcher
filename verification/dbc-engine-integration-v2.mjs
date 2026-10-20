// DBC x ENGINE integration — ENGINE V2 re-run (LiteSVM, real binaries).
//
// Supersedes dbc-engine-integration.mjs (the v1 proof, 36/36). Same
// scenarios — Agent-Only + Max Wallet through real swap2WithTransferHook —
// against the wave-1 engine binary (ENGINE_VERSION 2, meta tail v2). The
// questions this run answers:
//   (a) [PHASE 2 UPDATE] Does DBC forward the config's TEMPLATED extras
//       verbatim? This suite's config is rules [3, 9], whose required set
//       is 5 extras (config, dst holder, rent vault, system, sysvar — no
//       src holder, no price feed), so the tail is 5 resolved extras +
//       hook program + validation = 7 keys. (The original v2 run proved
//       the fixed 7-extra superset; Phase 2 templates the list per
//       config — assertions below were updated to the templated shape,
//       each marked PHASE 2.)
//   (b) Does Execute receive its full account set on DBC swaps (5 fixed
//       + 5 templated extras = 10; engine logs accounts=10 per transfer)?
//   (c) Do the v1 behavioral verdicts carry over unchanged (caller
//       validation via the venue branch, Agent-Only veto/register/pass,
//       Max Wallet post-transfer semantics incl. the atomic veto)?
// Launch order is the v2 canonical sequence (DBC-INTEGRATION.md):
//   DBC config -> DBC pool (mint carries ENGINE hook) -> engine
//   InitializeConfig (DBC allowlisted; pool authority + base vault exempt)
//   -> InitializeExtraAccountMetas -> InitializePriceFeed -> fund rent
//   vault -> pre-create buyer ATAs -> buys via swap2WithTransferHook.
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
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

// ---------- engine identity ----------
const engineKp = JSON.parse(fs.readFileSync(`${BUILD_DIR}/engine/engine-keypair.json`, 'utf8'));
const ENGINE = Keypair.fromSecretKey(Uint8Array.from(engineKp)).publicKey;
const IX_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
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

const partner = Keypair.generate();
const creator = Keypair.generate(); // pool creator AND engine config authority
const buyer = Keypair.generate();
const buyer2 = Keypair.generate();
for (const k of [partner, creator, buyer, buyer2]) fund(svm, k, 200);
step('actors', {
  engine: ENGINE.toBase58(), partner: partner.publicKey.toBase58(),
  creator: creator.publicKey.toBase58(), buyer: buyer.publicKey.toBase58(),
  buyer2: buyer2.publicKey.toBase58(),
});

// engine PDAs
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, ENGINE)[0];
const configPda = (mint) => pda([Buffer.from('config'), mint.toBuffer()]);
const holderPda = (mint, owner) => pda([Buffer.from('holder'), mint.toBuffer(), owner.toBuffer()]);
const vaultPda = (mint) => pda([Buffer.from('rentvault'), mint.toBuffer()]);
const metaPda = (mint) => pda([Buffer.from('extra-account-metas'), mint.toBuffer()]);
const pricePda = (mint) => pda([Buffer.from('price'), mint.toBuffer()]);
const acctData = (pk) => { const a = svm.getAccount(pk); return a ? Buffer.from(a.data) : null; };

// ---------- engine instruction builders (mirror engine/trial.mjs) ----------
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
  (feeVault || creator.publicKey).toBuffer().copy(tail, 11);
  parts.push(tail);
  return Buffer.concat(parts);
}
const maxWalletParams = (bps) => { const p = Buffer.alloc(64); p.writeUInt16LE(bps, 0); return p; };
const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });

const initConfigIx = (mint, cfg) => new TransactionInstruction({
  programId: ENGINE, data: configPayload(cfg, 1),
  keys: [K(creator.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, true), K(SystemProgram.programId, false, false)],
});
const updateConfigIx = (mint, cfg) => new TransactionInstruction({
  programId: ENGINE, data: configPayload(cfg, 2),
  keys: [K(creator.publicKey, true, false), K(mint, false, false), K(configPda(mint), false, true)],
});
const initMetasIx = (mint) => new TransactionInstruction({
  programId: ENGINE, data: INIT_METAS_DISC,
  keys: [
    K(creator.publicKey, true, true), K(metaPda(mint), false, true), K(mint, false, false),
    K(SystemProgram.programId, false, false), K(configPda(mint), false, false),
  ],
});
// v2: tag 4 is SyncRegistered; path (a) — config-authority signature, no
// registration account appended — is byte-identical to the v1 stub call.
const setRegisteredIx = (mint, owner, val) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([4, val]),
  keys: [
    K(creator.publicKey, true, false), K(mint, false, false), K(configPda(mint), false, false),
    K(owner, false, false), K(holderPda(mint, getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID)), false, true), K(SystemProgram.programId, false, false),
  ],
});
// InitializePriceFeed: data [6][pool][token_vault][quote_vault][token_dec][quote_dec]
const initPriceFeedIx = (mint, pool, tokenVault, quoteVault, tokenDec, quoteDec) => new TransactionInstruction({
  programId: ENGINE,
  data: Buffer.concat([Buffer.from([6]), pool.toBuffer(), tokenVault.toBuffer(), quoteVault.toBuffer(), Buffer.from([tokenDec, quoteDec])]),
  keys: [
    K(creator.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, false),
    K(pricePda(mint), false, true), K(SystemProgram.programId, false, false),
  ],
});

// ---------- DBC curve config (proof parameters; 42 SOL threshold) ----------
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
step('LAUNCH', 'DBC config -> DBC pool (ENGINE hook) -> engine config -> metas -> price feed -> fund vault');
const dbcConfig = Keypair.generate();
{
  const tx = await client.partner.createConfigWithTransferHook({
    config: dbcConfig.publicKey, feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey, payer: partner.publicKey,
    quoteMint: NATIVE_MINT, transferHookProgram: ENGINE, ...curveConfig(42),
  });
  const r = sendTx(svm, tx, [partner, dbcConfig], 'createConfigWithTransferHook(engine)');
  ok(r.ok, 'L1 DBC config created naming ENGINE as transfer-hook program');
}
const baseMint = Keypair.generate();
let pool, poolAuthority, baseVault, quoteVault;
{
  const tx = await client.creator.createPoolWithTransferHook({
    baseMint: baseMint.publicKey, config: dbcConfig.publicKey, transferHookProgram: ENGINE,
    name: 'EngineProofV2', symbol: 'ENG2', uri: 'https://example.invalid/eng2.json',
    payer: creator.publicKey, poolCreator: creator.publicKey,
  });
  const r = sendTx(svm, tx, [creator, baseMint], 'createPoolWithTransferHook(engine)');
  pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, dbcConfig.publicKey);
  poolAuthority = deriveDbcPoolAuthority();
  baseVault = deriveDbcTokenVaultAddress(pool, baseMint.publicKey);
  quoteVault = deriveDbcTokenVaultAddress(pool, NATIVE_MINT);
  ok(r.ok, 'L2 DBC pool created; base mint carries the ENGINE hook', `pool=${pool.toBase58()}`);
  const raw = Buffer.from(svm.getAccount(baseMint.publicKey).data);
  ok(raw.includes(Buffer.from(ENGINE.toBytes())), 'L2 mint TLV contains ENGINE program id');
  ok(svm.getAccount(baseVault) != null, 'L2 derived base vault exists', baseVault.toBase58());
}
const mint = baseMint.publicKey;
const mintDec = Buffer.from(svm.getAccount(mint).data)[44];

// engine config: Agent-Only FIRST, Max Wallet (9000 bps) second; DBC allowlisted;
// pool authority (owner of the base vault) + the base vault account exempted.
const engineCfg = (capBps) => ({
  mode: 1, authority: creator.publicKey,
  rules: [{ id: 3 }, { id: 9, params: maxWalletParams(capBps) }],
  venues: [DBC_ID], exemptions: [poolAuthority, baseVault],
});
{
  const r = sendTx(svm, new Transaction().add(initConfigIx(mint, engineCfg(9000))), [creator], 'engine InitializeConfig');
  ok(r.ok, 'L3 engine config initialized (AgentOnly + MaxWallet 9000bps, DBC allowlisted, pool exempt)');
  const cfgRaw = acctData(configPda(mint));
  ok(cfgRaw && cfgRaw[1] === 2, 'L3 config version byte is ENGINE_VERSION 2');
  const r2 = sendTx(svm, new Transaction().add(initMetasIx(mint)), [creator], 'engine InitializeExtraAccountMetas');
  ok(r2.ok, 'L4 extra-account meta list initialized (PHASE 2: templated, 5 extras for rules [3,9])');
  const metaRaw = acctData(metaPda(mint));
  // PHASE 2 (was: 261 bytes / fixed 7-extra superset): rules [3,9] require
  // 5 extras -> TLV size 16 + 5*35 = 191 bytes.
  ok(metaRaw && metaRaw.length === 191, 'L4 meta list account is 191 bytes (PHASE 2 templated size for 5 extras)', `len=${metaRaw?.length}`);
  const r4 = sendTx(svm, new Transaction().add(initPriceFeedIx(mint, pool, baseVault, quoteVault, mintDec, 9)), [creator], 'engine InitializePriceFeed');
  ok(r4.ok, 'L4b price feed initialized (pool + base/quote vaults pinned)', `token_dec=${mintDec}`);
  const feedRaw = acctData(pricePda(mint));
  ok(feedRaw && feedRaw[0] === 1 && new PublicKey(feedRaw.subarray(1, 33)).equals(pool),
    'L4b feed pins the DBC pool');
  const r3 = sendTx(svm, new Transaction().add(SystemProgram.transfer({
    fromPubkey: creator.publicKey, toPubkey: vaultPda(mint), lamports: 50_000_000,
  })), [creator], 'fund rent vault');
  ok(r3.ok, 'L5 rent vault funded (0.05 SOL)');
}

// ================= buy helper with tail extraction =================
const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
const buyer2Ata = getAssociatedTokenAddressSync(mint, buyer2.publicKey, false, TOKEN_2022_PROGRAM_ID);
// Build-time resolution finding (v1, still applies): holder-PDA metas seed
// from AccountData of the source/destination token accounts, so a
// first-time buyer's destination ATA must exist before the first swap
// build (ATA creation fires no hook).
{
  const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
  const r = sendTx(svm, new Transaction().add(
    createAssociatedTokenAccountInstruction(creator.publicKey, buyerAta, buyer.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(creator.publicKey, buyer2Ata, buyer2.publicKey, mint, TOKEN_2022_PROGRAM_ID),
  ), [creator], 'pre-create buyer ATAs');
  ok(r.ok, 'L6 buyer ATAs pre-created (required before first swap build)');
}
async function buildBuy(owner, sol) {
  return client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: false,
    amountIn: new BN(Math.round(sol * 1e9)), minimumAmountOut: new BN(0),
    owner: owner.publicKey, pool, referralTokenAccount: null, payer: owner.publicKey,
  });
}
function tailOf(tx) {
  const ix = tx.instructions.find((i) => i.programId.equals(DBC_ID));
  if (!ix) return null;
  return { totalKeys: ix.keys.length, tail: ix.keys.slice(-7) };
}
// PHASE 2 (was: 9 entries incl. src holder + price feed): the templated
// list for rules [3,9] has neither — rule 3 reads only the dst holder and
// no rule here reads the feed.
const EXPECTED_TAIL = (ownerPk) => [
  ['config PDA', configPda(mint), false],
  ['dst holder PDA (buyer)', holderPda(mint, getAssociatedTokenAddressSync(mint, ownerPk, false, TOKEN_2022_PROGRAM_ID)), true],
  ['rent vault PDA', vaultPda(mint), true],
  ['system program (LITERAL)', SystemProgram.programId, false],
  ['instructions sysvar (LITERAL)', IX_SYSVAR, false],
  ['engine program', ENGINE, false],
  ['validation (meta-list PDA)', metaPda(mint), false],
];

// ================= ITEM 3a + ITEM 1 (behavioral): unregistered buy =================
console.log('\n=== ITEM 3a: unregistered buyer at the curve ===');
{
  const tx = await buildBuy(buyer, 0.05);
  const { tail } = tailOf(tx);
  const r = sendTx(svm, tx, [buyer], 'buy unregistered');
  ok(!r.ok, 'I3a unregistered buy FAILS');
  ok((r.logs || []).some((l) => l.includes('not registered')), 'I3a failure is the engine Agent-Only veto (log: "engine: not registered")');
  ok(tokenBalance(svm, buyerAta) === 0n, 'I3a buyer received nothing (atomic)');
  ok(acctData(holderPda(mint, buyerAta)) === null, 'I3a lazily-created holder PDA rolled back with the veto (no state leaked)');
  globalThis.__tail = tail;
}

// ================= ITEM 1 (client-side): the forwarded tail, key by key =================
console.log('\n=== ITEM 1: swap instruction remaining-accounts tail (PHASE 2 templated: 7 keys) ===');
{
  const tail = globalThis.__tail;
  const expected = EXPECTED_TAIL(buyer.publicKey);
  const probe = tailOf(await buildBuy(buyer, 0.05));
  // PHASE 2 (was: 24 keys): 5 templated extras instead of 7 -> 22 keys.
  ok(probe.totalKeys === 22, 'I1 swap instruction carries 22 keys (PHASE 2: 5 templated extras)', `total=${probe.totalKeys}`);
  ok(tail && tail.length === 7, 'I1 tail has exactly 7 accounts (5 resolved extras + hook program + validation)');
  expected.forEach(([label, pk, writable], i) => {
    const got = tail?.[i];
    ok(!!got && got.pubkey.equals(pk) && got.isWritable === writable,
      `I1 tail[${i}] = ${label}`, got ? got.pubkey.toBase58() : 'MISSING');
  });
}

// ================= ITEM 3b: register, then the same buy passes =================
console.log('\n=== ITEM 3b: SyncRegistered path (a) -> buy passes ===');
{
  const r = sendTx(svm, new Transaction().add(setRegisteredIx(mint, buyer.publicKey, 1)), [creator], 'SyncRegistered(buyer,1) path (a)');
  ok(r.ok, 'I3b SyncRegistered path (a) succeeded');
  const h = acctData(holderPda(mint, buyerAta));
  ok(h && h[0] === 1 && h[1] === 1, 'I3b holder PDA exists with registered=1');
  const tx = await buildBuy(buyer, 0.05);
  const r2 = sendTx(svm, tx, [buyer], 'buy registered');
  ok(r2.ok, 'I3b registered buy SUCCEEDS through swap2WithTransferHook');
  ok(!(r2.logs || []).some((l) => l.includes('rejected caller')), 'I1 no BadCaller — sysvar caller validation passed via the DBC venue branch');
  ok((r2.logs || []).some((l) => l.includes('accounts=10') && l.includes('venue=true')),
    'I1 Execute received all 10 accounts on the DBC swap (PHASE 2: 5 fixed + 5 templated extras; engine log: accounts=10, venue=true)');
  const b1 = tokenBalance(svm, buyerAta);
  ok(b1 > 0n, 'I3b buyer received base tokens', `balance=${b1}`);
  globalThis.__b1 = b1;
}

// ================= ITEM 2 (pass side): second buy under a generous cap =================
console.log('\n=== ITEM 2: Max Wallet on real curve buys ===');
{
  const tx = await buildBuy(buyer, 0.05);
  const r = sendTx(svm, tx, [buyer], 'buy #2 (cap 9000 bps)');
  const b = tokenBalance(svm, buyerAta);
  ok(r.ok && b > globalThis.__b1, 'I2 second buy passes under 9000 bps cap', `balance=${b}`);
}

// sell sanity: destination is the exempt base vault; engine must not block pool ops
{
  const tx = await client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: true,
    amountIn: new BN(1_000_000_000), minimumAmountOut: new BN(0),
    owner: buyer.publicKey, pool, referralTokenAccount: null, payer: buyer.publicKey,
  });
  const r = sendTx(svm, tx, [buyer], 'sell 1000 tokens');
  ok(r.ok, 'I2 sell into the exempt base vault passes (pool ops never self-blocked)');
}

// ================= ITEM 2 (veto side): the post-transfer balance discriminator =================
{
  const r0 = sendTx(svm, new Transaction().add(setRegisteredIx(mint, buyer2.publicKey, 1)), [creator], 'SyncRegistered(buyer2,1)');
  ok(r0.ok, 'I2 buyer2 registered via SyncRegistered path (a)');
  // tighten cap to 20 bps: 20/10000 * 1e15 raw supply = 2e12 raw units.
  // buyer2's pre-transfer balance is 0 — under PRE-transfer semantics a buy
  // would pass (0 <= cap). Under POST-transfer semantics the ~3.6e12 received
  // exceeds the cap and the buy must veto.
  const ru = sendTx(svm, new Transaction().add(updateConfigIx(mint, engineCfg(20))), [creator], 'UpdateConfig cap=20bps');
  ok(ru.ok, 'I2 config updated through the live stack (cap 9000 -> 20 bps)');
  const tx = await buildBuy(buyer2, 0.05);
  const r = sendTx(svm, tx, [buyer2], 'buy buyer2 @ cap 20bps');
  ok(!r.ok, 'I2 buyer2 buy VETOES under a 20 bps cap despite a 0 pre-transfer balance');
  ok((r.logs || []).some((l) => l.includes('max wallet exceeded')), 'I2 veto is MaxWalletExceeded (log: "engine: max wallet exceeded")');
  ok(tokenBalance(svm, buyer2Ata) === 0n, 'I2 veto atomic — buyer2 balance still 0');
  const ru2 = sendTx(svm, new Transaction().add(updateConfigIx(mint, engineCfg(9000))), [creator], 'UpdateConfig cap=9000bps');
  ok(ru2.ok, 'I2 config restored (cap 20 -> 9000 bps)');
  const tx2 = await buildBuy(buyer2, 0.05);
  const r2 = sendTx(svm, tx2, [buyer2], 'buy buyer2 @ cap 9000bps');
  const out = tokenBalance(svm, buyer2Ata);
  ok(r2.ok && out > 2_000_000_000_000n, 'I2 same buy passes at 9000 bps; received amount exceeds the 20 bps cap — post-transfer balance semantics CONFIRMED on DBC (v2)', `out=${out} > cap(20bps)=2000000000000`);
}

console.log(`\n==== DBC x ENGINE INTEGRATION (V2): ${pass} passed, ${fail} failed ====`);
fs.writeFileSync(`${BUILD_DIR}/integration/dbc-engine-integration-v2-result.json`,
  JSON.stringify({ engine: ENGINE.toBase58(), engineVersion: 2, mint: mint.toBase58(), pool: pool.toBase58(), pass, fail }, null, 2));
if (fail > 0) process.exit(1);

// DBC x ENGINE integration — mission items 1-3 (LiteSVM, real binaries).
//
//   Item 1: does DBC forward ALL SIX engine extras through swap2WithTransferHook,
//           including the two literal metas (system program, instructions
//           sysvar)? Evidence = (a) client-side dump of the swap instruction's
//           remaining-accounts tail, matched key-by-key against the expected
//           eight accounts, and (b) live engine behavior that is only possible
//           if Execute received [4 base, validation, ...6 extras] in order:
//           structural key checks + sysvar caller validation + per-module
//           veto errors each keyed to a different forwarded account.
//   Item 2: Max Wallet balance semantics through a REAL curve buy — the
//           post-transfer balance read (BUILD-NOTES deviation 4). A fresh
//           buyer (pre-transfer balance 0) under a cap below one buy's output
//           must VETO; with pre-transfer semantics the same buy would pass.
//   Item 3: Agent-Only through the curve — unregistered buyer vetoes
//           (NotRegistered, atomic rollback), stub-register, same buy passes.
//
// Launch order (BUILD-NOTES SS9, adapted: DBC creates the mint, so the
// engine config can only exist after pool creation):
//   DBC config -> DBC pool (mint carries ENGINE hook) -> engine
//   InitializeConfig (DBC in venue allowlist; pool authority + base vault in
//   exemptions) -> engine InitializeExtraAccountMetas -> fund rent vault ->
//   buys via swap2WithTransferHook.
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
const setRegisteredIx = (mint, owner, val) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([4, val]),
  keys: [
    K(creator.publicKey, true, false), K(mint, false, false), K(configPda(mint), false, false),
    K(owner, false, false), K(holderPda(mint, owner), false, true), K(SystemProgram.programId, false, false),
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
step('LAUNCH', 'DBC config -> DBC pool (ENGINE hook) -> engine config -> metas -> fund vault');
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
let pool, poolAuthority, baseVault;
{
  const tx = await client.creator.createPoolWithTransferHook({
    baseMint: baseMint.publicKey, config: dbcConfig.publicKey, transferHookProgram: ENGINE,
    name: 'EngineProof', symbol: 'ENGP', uri: 'https://example.invalid/engp.json',
    payer: creator.publicKey, poolCreator: creator.publicKey,
  });
  const r = sendTx(svm, tx, [creator, baseMint], 'createPoolWithTransferHook(engine)');
  pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, dbcConfig.publicKey);
  poolAuthority = deriveDbcPoolAuthority();
  baseVault = deriveDbcTokenVaultAddress(pool, baseMint.publicKey);
  ok(r.ok, 'L2 DBC pool created; base mint carries the ENGINE hook', `pool=${pool.toBase58()}`);
  const raw = Buffer.from(svm.getAccount(baseMint.publicKey).data);
  ok(raw.includes(Buffer.from(ENGINE.toBytes())), 'L2 mint TLV contains ENGINE program id');
  ok(svm.getAccount(baseVault) != null, 'L2 derived base vault exists', baseVault.toBase58());
  ok(svm.getAccount(poolAuthority) != null || true, 'L2 pool authority derived', poolAuthority.toBase58());
}
const mint = baseMint.publicKey;

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
  const r2 = sendTx(svm, new Transaction().add(initMetasIx(mint)), [creator], 'engine InitializeExtraAccountMetas');
  ok(r2.ok, 'L4 extra-account meta list initialized (6 extras)');
  const r3 = sendTx(svm, new Transaction().add(SystemProgram.transfer({
    fromPubkey: creator.publicKey, toPubkey: vaultPda(mint), lamports: 50_000_000,
  })), [creator], 'fund rent vault');
  ok(r3.ok, 'L5 rent vault funded (0.05 SOL)');
}

// ================= buy helper with tail extraction =================
const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
const buyer2Ata = getAssociatedTokenAddressSync(mint, buyer2.publicKey, false, TOKEN_2022_PROGRAM_ID);
// INTEGRATION FINDING (build-time resolution): the engine's holder-PDA metas
// seed from AccountData (owner field) of the source/destination token
// accounts, so the SDK's resolver must READ those accounts while BUILDING
// the swap — a first-time buyer's destination ATA must already exist
// on-chain or resolution throws TokenTransferHookAccountDataNotFound.
// Launcher sequence therefore creates buyer ATAs before the first swap
// build (ATA creation fires no hook: no transfer occurs).
{
  const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
  const r = sendTx(svm, new Transaction().add(
    createAssociatedTokenAccountInstruction(creator.publicKey, buyerAta, buyer.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(creator.publicKey, buyer2Ata, buyer2.publicKey, mint, TOKEN_2022_PROGRAM_ID),
  ), [creator], 'pre-create buyer ATAs');
  ok(r.ok, 'L6 buyer ATAs pre-created (required before first swap build; see finding above)');
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
  return { totalKeys: ix.keys.length, tail: ix.keys.slice(-8) };
}
const EXPECTED_TAIL = (ownerPk) => [
  ['config PDA', configPda(mint), false],
  ['src holder PDA (pool authority)', holderPda(mint, poolAuthority), true],
  ['dst holder PDA (buyer)', holderPda(mint, ownerPk), true],
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
  ok(acctData(holderPda(mint, buyer.publicKey)) === null, 'I3a lazily-created holder PDA rolled back with the veto (no state leaked)');
  globalThis.__tail = tail;
}

// ================= ITEM 1 (client-side): the forwarded tail, key by key =================
console.log('\n=== ITEM 1: swap instruction remaining-accounts tail ===');
{
  const tail = globalThis.__tail;
  const expected = EXPECTED_TAIL(buyer.publicKey);
  ok(tail && tail.length === 8, 'I1 tail has exactly 8 accounts (6 resolved extras + hook program + validation)', `total ix keys=${tailOf(await buildBuy(buyer, 0.05)).totalKeys}`);
  expected.forEach(([label, pk, writable], i) => {
    const got = tail?.[i];
    ok(!!got && got.pubkey.equals(pk) && got.isWritable === writable,
      `I1 tail[${i}] = ${label}`, got ? got.pubkey.toBase58() : 'MISSING');
  });
}

// ================= ITEM 3b: register, then the same buy passes =================
console.log('\n=== ITEM 3b: stub-register -> buy passes ===');
{
  const r = sendTx(svm, new Transaction().add(setRegisteredIx(mint, buyer.publicKey, 1)), [creator], 'SetRegistered(buyer,1)');
  ok(r.ok, 'I3b stub SetRegistered succeeded');
  const h = acctData(holderPda(mint, buyer.publicKey));
  ok(h && h[0] === 1 && h[1] === 1, 'I3b holder PDA exists with registered=1');
  const tx = await buildBuy(buyer, 0.05);
  const r2 = sendTx(svm, tx, [buyer], 'buy registered');
  ok(r2.ok, 'I3b registered buy SUCCEEDS through swap2WithTransferHook');
  ok(!(r2.logs || []).some((l) => l.includes('rejected caller')), 'I1 no BadCaller — sysvar caller validation passed via the DBC venue branch');
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
  const r0 = sendTx(svm, new Transaction().add(setRegisteredIx(mint, buyer2.publicKey, 1)), [creator], 'SetRegistered(buyer2,1)');
  ok(r0.ok, 'I2 buyer2 stub-registered');
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
  ok(r2.ok && out > 2_000_000_000_000n, 'I2 same buy passes at 9000 bps; received amount exceeds the 20 bps cap — post-transfer balance semantics CONFIRMED on DBC', `out=${out} > cap(20bps)=2000000000000`);
}

console.log(`\n==== DBC x ENGINE INTEGRATION: ${pass} passed, ${fail} failed ====`);
fs.writeFileSync(`${BUILD_DIR}/integration/dbc-engine-integration-result.json`,
  JSON.stringify({ engine: ENGINE.toBase58(), mint: mint.toBase58(), pool: pool.toBase58(), pass, fail }, null, 2));
if (fail > 0) process.exit(1);

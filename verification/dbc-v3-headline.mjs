// dbc-v3-headline.mjs — ENGINE v3 HEADLINE PROOFS (SPEC-ENGINE-V3 SS9-SS10).
//
// PART 1 — the doors proof. A GRADUATED-latch token (rule 1 mode 2 +
// rule 9) launched on the v3 engine. A FRESH wallet's first buy is built
// EXCLUSIVELY through the standard generic resolver (the DBC SDK's
// swap2WithTransferHook, which resolves the published meta list
// internally) while the buyer's ATA does NOT exist — the exact build
// that threw TokenTransferHookAccountDataNotFound under the v2 engine
// for every holder-state token. Under v3 it builds, lands (bundled with
// the ATA creation, the shape generic routers produce), and Execute
// validates the account-keyed Holder PDA the resolver derived. Graduated
// spot checks follow: full sell at t+0 vetoes PartialLocked; after the
// vesting window the full sell lands.
//
// PART 2 — the retrofit rehearsal. The same launch runs on the PRESERVED
// v2 TRIAL BINARY (engine/v2-snapshot/engine-trial-phase2.so): a real
// buy creates a real owner-keyed holder record. Every state account is
// then transplanted into a second SVM running the v3 binary, and the
// SS9.3 sequence executes: MigrateHolder (record moves verbatim to the
// ATA-keyed address, legacy account closed) -> RefreshExtraAccountMetas
// (list flips to the AccountKey shape) -> generic trades resume: the
// migrated holder sells through the generic resolver and a brand-new
// wallet makes a generic first buy on the migrated mint.
import fs from 'fs';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { Clock } from 'litesvm';
import BN from 'bn.js';
import {
  DynamicBondingCurveClient, SwapMode, buildCurve, TokenType, TokenDecimal,
  TokenAuthorityOption, BaseFeeMode, CollectFeeMode, MigrationOption, MigrationFeeOption,
  ActivationType, deriveDbcPoolAddress, deriveDbcPoolAuthority, deriveDbcTokenVaultAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { makeSvm, patchConnection, sendTx, fund, tokenBalance, BUILD_DIR, DBC_ID } from '../proof/svm-harness.mjs';

const T22 = TOKEN_2022_PROGRAM_ID;
const engineKp = JSON.parse(fs.readFileSync(`${BUILD_DIR}/engine/engine-keypair.json`, 'utf8'));
const ENGINE = Keypair.fromSecretKey(Uint8Array.from(engineKp)).publicKey;
const INIT_METAS_DISC = Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]);
const V2_BINARY = `${BUILD_DIR}/engine/v2-snapshot/engine-trial-phase2.so`;
const V3_BINARY = `${BUILD_DIR}/engine/target/deploy/engine.so`;

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const step = (name, data) => console.log(`== ${name}`, data ?? '');

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, ENGINE)[0];
const configPda = (mint) => pda([Buffer.from('config'), mint.toBuffer()]);
const metaPda = (mint) => pda([Buffer.from('extra-account-metas'), mint.toBuffer()]);
const pricePda = (mint) => pda([Buffer.from('price'), mint.toBuffer()]);
const vaultPda = (mint) => pda([Buffer.from('rentvault'), mint.toBuffer()]);
const holderPdaRaw = (mint, key) => pda([Buffer.from('holder'), mint.toBuffer(), key.toBuffer()]);
const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });
const readU128 = (d, o) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);

// ---------- meta list decoding (same TLV walk as dbc-templating) ----------
function decodeMetas(svm, mint) {
  const a = svm.getAccount(metaPda(mint));
  if (!a) return null;
  const raw = Buffer.from(a.data);
  const count = raw.readUInt32LE(12);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 16 + i * 35;
    const disc = raw[o];
    const config = raw.subarray(o + 1, o + 33);
    const seeds = [];
    let hasAccountData = false;
    if (disc === 1) {
      let j = 0;
      while (j < 32 && config[j] !== 0) {
        const d = config[j];
        if (d === 1) { const len = config[j + 1]; seeds.push(`literal("${config.subarray(j + 2, j + 2 + len).toString()}")`); j += 2 + len; }
        else if (d === 2) { seeds.push(`ixdata(${config[j + 1]},${config[j + 2]})`); j += 3; }
        else if (d === 3) { seeds.push(`accountkey(${config[j + 1]})`); j += 2; }
        else if (d === 4) { seeds.push(`accountdata(acct=${config[j + 1]},off=${config[j + 2]},len=${config[j + 3]})`); hasAccountData = true; j += 4; }
        else { seeds.push(`unknown(${d})`); break; }
      }
    }
    entries.push({ disc, seeds, hasAccountData });
  }
  return { count, entries };
}

// ---------- world scaffolding ----------
function makeWorld(binaryPath) {
  const svm = makeSvm([
    [DBC_ID, `${BUILD_DIR}/bin/dynamic_bonding_curve.so`],
    [ENGINE, binaryPath],
  ]);
  const conn = patchConnection(svm);
  const client = new DynamicBondingCurveClient(conn, 'confirmed');
  let clockSlot = BigInt(svm.getClock().slot);
  const setTime = (ts) => { clockSlot += 17n; svm.setClock(new Clock(clockSlot, 0n, 0n, 0n, BigInt(ts))); };
  const creator = Keypair.generate();
  const partner = Keypair.generate();
  fund(svm, creator, 100);
  fund(svm, partner, 100);
  return { svm, conn, client, setTime, creator, partner };
}

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
const gradParams = ({ stale = 1_000_000, vesting = 432_000, dipMult = 20_000 } = {}) => {
  const p = Buffer.alloc(64);
  p.writeBigUInt64LE(BigInt(stale), 0);
  p.writeBigUInt64LE(0n, 8);
  p.writeUInt16LE(0, 16);
  p[18] = 2; // GRADUATED
  p.writeUInt16LE(0, 19); // base_frac_bps = 0
  p.writeBigUInt64LE(BigInt(vesting), 21);
  p.writeUInt16LE(dipMult, 29);
  return p;
};
const maxWalletParams = (bps) => { const p = Buffer.alloc(64); p.writeUInt16LE(bps, 0); return p; };

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

async function launchGraduated(W, label) {
  const { svm, client, creator, partner } = W;
  const dbcConfig = Keypair.generate();
  {
    const tx = await client.partner.createConfigWithTransferHook({
      config: dbcConfig.publicKey, feeClaimer: partner.publicKey,
      leftoverReceiver: partner.publicKey, payer: partner.publicKey,
      quoteMint: NATIVE_MINT, transferHookProgram: ENGINE, ...curveConfig(42),
    });
    const r = sendTx(svm, tx, [partner, dbcConfig], 'createConfigWithTransferHook');
    ok(r.ok, `${label} DBC config created naming ENGINE`);
  }
  const baseMint = Keypair.generate();
  let pool, poolAuthority, baseVault, quoteVault;
  {
    const tx = await client.creator.createPoolWithTransferHook({
      baseMint: baseMint.publicKey, config: dbcConfig.publicKey, transferHookProgram: ENGINE,
      name: 'V3Proof', symbol: 'V3P', uri: 'https://example.invalid/v3p.json',
      payer: creator.publicKey, poolCreator: creator.publicKey,
    });
    const r = sendTx(svm, tx, [creator, baseMint], 'createPoolWithTransferHook');
    pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, dbcConfig.publicKey);
    poolAuthority = deriveDbcPoolAuthority();
    baseVault = deriveDbcTokenVaultAddress(pool, baseMint.publicKey);
    quoteVault = deriveDbcTokenVaultAddress(pool, NATIVE_MINT);
    ok(r.ok, `${label} DBC pool created; mint carries ENGINE hook`);
  }
  const mint = baseMint.publicKey;
  const tokDec = Buffer.from(svm.getAccount(mint).data)[44];
  const cfg = {
    mode: 1, authority: creator.publicKey,
    rules: [{ id: 1, params: gradParams() }, { id: 9, params: maxWalletParams(9000) }],
    venues: [DBC_ID], exemptions: [poolAuthority, baseVault],
  };
  const initCfg = new TransactionInstruction({
    programId: ENGINE, data: configPayload(cfg, 1),
    keys: [K(creator.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, true), K(SystemProgram.programId, false, false)],
  });
  ok(sendTx(svm, new Transaction().add(initCfg), [creator], 'init config').ok, `${label} engine config [GRADUATED latch, max-wallet 9000bps]`);
  const initMetas = new TransactionInstruction({
    programId: ENGINE, data: INIT_METAS_DISC,
    keys: [K(creator.publicKey, true, true), K(metaPda(mint), false, true), K(mint, false, false), K(SystemProgram.programId, false, false), K(configPda(mint), false, false)],
  });
  ok(sendTx(svm, new Transaction().add(initMetas), [creator], 'init metas').ok, `${label} meta list initialized`);
  const initFeed = new TransactionInstruction({
    programId: ENGINE,
    data: Buffer.concat([Buffer.from([6]), pool.toBuffer(), baseVault.toBuffer(), quoteVault.toBuffer(), Buffer.from([tokDec, 9])]),
    keys: [K(creator.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, false), K(pricePda(mint), false, true), K(SystemProgram.programId, false, false)],
  });
  ok(sendTx(svm, new Transaction().add(initFeed), [creator], 'init feed').ok, `${label} price feed initialized`);
  ok(sendTx(svm, new Transaction().add(SystemProgram.transfer({
    fromPubkey: creator.publicKey, toPubkey: vaultPda(mint), lamports: 50_000_000,
  })), [creator], 'fund rent vault').ok, `${label} rent vault funded`);
  const crankIx = new TransactionInstruction({
    programId: ENGINE, data: Buffer.from([8]),
    keys: [K(configPda(mint), false, false), K(pricePda(mint), false, true), K(pool, false, false)],
  });
  ok(sendTx(svm, new Transaction().add(crankIx), [creator], 'crank').ok, `${label} price feed cranked`);
  const L = { mint, pool, poolAuthority, baseVault, quoteVault, dbcConfig: dbcConfig.publicKey };
  L.swap = async (owner, baseForQuote, amount) => {
    const tx = await client.pool.swap2WithTransferHook({
      swapMode: SwapMode.ExactIn, swapBaseForQuote: baseForQuote,
      amountIn: new BN(amount.toString()), minimumAmountOut: new BN(0),
      owner: owner.publicKey, pool, referralTokenAccount: null, payer: owner.publicKey,
    });
    return sendTx(svm, tx, [owner], `${baseForQuote ? 'sell' : 'buy'} ${amount}`);
  };
  L.feedEma = () => readU128(Buffer.from(svm.getAccount(pricePda(mint)).data), 97);
  return L;
}

// A generic-router-shaped first buy: the swap is BUILT (meta resolution
// happens inside the SDK call) while the buyer's ATA does not exist;
// the sent transaction is [create ATA idempotent-style, swap] — the
// shape BasedBot/Jupiter-style routes produce.
async function genericFirstBuy(W, L, buyer, solLamports) {
  const ata = getAssociatedTokenAddressSync(L.mint, buyer.publicKey, false, T22);
  const swapTx = await W.client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: false,
    amountIn: new BN(solLamports.toString()), minimumAmountOut: new BN(0),
    owner: buyer.publicKey, pool: L.pool, referralTokenAccount: null, payer: buyer.publicKey,
  });
  const bundle = new Transaction().add(
    createAssociatedTokenAccountInstruction(buyer.publicKey, ata, buyer.publicKey, L.mint, T22),
    ...swapTx.instructions,
  );
  return { ata, r: sendTx(W.svm, bundle, [buyer], 'generic first buy bundle') };
}

const T0 = 1_760_000_000;

// ================= PART 2a — v2 world: real state under the v2 binary =================
step('PART 2a', 'launch graduated token on the PRESERVED v2 binary; real buy; capture state');
const W1 = makeWorld(V2_BINARY);
W1.setTime(T0);
const L2 = await launchGraduated(W1, '2a');
const buyerV2 = Keypair.generate();
fund(W1.svm, buyerV2, 50);
const buyerV2Ata = getAssociatedTokenAddressSync(L2.mint, buyerV2.publicKey, false, T22);
{
  const r = sendTx(W1.svm, new Transaction().add(
    createAssociatedTokenAccountInstruction(buyerV2.publicKey, buyerV2Ata, buyerV2.publicKey, L2.mint, T22),
  ), [buyerV2], '2a pre-create buyer ATA (the v2 requirement)');
  ok(r.ok, '2a buyer ATA pre-created (v2 flow)');
}
W1.setTime(T0 + 20);
{
  const r = await L2.swap(buyerV2, false, 50_000_000n);
  ok(r.ok, '2a v2 buy lands (0.05 SOL)');
}
const legacyPda = holderPdaRaw(L2.mint, buyerV2.publicKey);
const legacyAcct = W1.svm.getAccount(legacyPda);
ok(!!legacyAcct, '2a v2 buy created the OWNER-keyed holder record');
const legacyBytes = Buffer.from(legacyAcct.data);
const legacyBasis = readU128(legacyBytes, 6);
ok(legacyBasis === L2.feedEma() && legacyBasis > 0n, '2a record basis == cranked EMA (real v2 state)', `basis=${legacyBasis}`);
const balV2 = tokenBalance(W1.svm, buyerV2Ata);
ok(balV2 > 0n, '2a buyer balance > 0', `bal=${balV2}`);
const clockV2 = W1.svm.getClock();

// transplant set: everything the v3 world needs to resume this mint
const transplantAddrs = [
  L2.mint, L2.dbcConfig, L2.pool, L2.baseVault, L2.quoteVault,
  configPda(L2.mint), metaPda(L2.mint), pricePda(L2.mint), vaultPda(L2.mint),
  buyerV2Ata, legacyPda,
];
const captured = transplantAddrs.map((pk) => [pk, W1.svm.getAccount(pk)]);
ok(captured.every(([, a]) => !!a), '2a all transplant accounts captured');

// ================= v3 world (Parts 1 + 2b) =================
const W3 = makeWorld(V3_BINARY);

// ================= PART 1 — the doors proof on v3 =================
step('PART 1', 'GRADUATED token on v3; FRESH wallet; generic-resolver first buy');
W3.setTime(T0);
const L1 = await launchGraduated(W3, 'P1');
{
  const d = decodeMetas(W3.svm, L1.mint);
  ok(d && d.count === 7 && d.entries.every((e) => !e.hasAccountData), 'P1 v3 meta list: 7 extras, NO AccountData seeds', `count=${d?.count}`);
}
const buyer1 = Keypair.generate();
fund(W3.svm, buyer1, 50);
const buyer1Ata = getAssociatedTokenAddressSync(L1.mint, buyer1.publicKey, false, T22);
ok(W3.svm.getAccount(buyer1Ata) == null, 'P1 buyer ATA does not exist before the build (fresh wallet)');
W3.setTime(T0 + 20);
const emaBefore = L1.feedEma();
{
  const { r } = await genericFirstBuy(W3, L1, buyer1, 50_000_000n);
  ok(r.ok, 'P1 HEADLINE: generic first buy LANDS (built by the standard resolver with no ATA in existence)');
}
const bal1 = tokenBalance(W3.svm, buyer1Ata);
ok(bal1 > 0n, 'P1 buyer received tokens', `bal=${bal1}`);
const rec1 = W3.svm.getAccount(holderPdaRaw(L1.mint, buyer1Ata));
ok(!!rec1, 'P1 holder record exists at the ACCOUNT-keyed PDA (ATA address)');
ok(W3.svm.getAccount(holderPdaRaw(L1.mint, buyer1.publicKey)) == null, 'P1 NO record at the owner-keyed address (derivation really flipped)');
{
  const d = Buffer.from(rec1.data);
  ok(readU128(d, 6) === emaBefore, 'P1 record basis == cranked EMA exactly', `basis=${readU128(d, 6)} ema=${emaBefore}`);
  ok(d.readBigUInt64LE(136) === bal1, 'P1 graduated peak == balance', `peak=${d.readBigUInt64LE(136)}`);
}
{
  const r = await L1.swap(buyer1, true, bal1);
  ok(!r.ok && (r.logs || []).some((l) => l.includes('custom program error: 0x19')), 'P1 immediate full sell VETOES PartialLocked (graduated base=0, nothing earned yet)');
}
W3.setTime(T0 + 20 + 432_001);
{
  const r = await L1.swap(buyer1, true, bal1);
  ok(r.ok, 'P1 after the vesting window the full sell LANDS');
  ok(tokenBalance(W3.svm, buyer1Ata) === 0n, 'P1 position fully exited');
}

// ================= PART 2b — transplant + retrofit sequence =================
step('PART 2b', 'transplant v2 state into the v3 world; migrate; flip the list; trade');
for (const [pk, a] of captured) {
  W3.svm.setAccount(pk, {
    lamports: a.lamports, data: new Uint8Array(a.data), owner: a.owner,
    executable: a.executable, rentEpoch: Number(a.rentEpoch ?? 0),
  });
}
fund(W3.svm, buyerV2, 50);
ok(!!W3.svm.getAccount(legacyPda), '2b legacy owner-keyed record present after transplant');
ok(W3.svm.getAccount(holderPdaRaw(L2.mint, buyerV2Ata)) == null, '2b no account-keyed record yet');
{
  const d = decodeMetas(W3.svm, L2.mint);
  ok(d && d.entries.some((e) => e.hasAccountData), '2b transplanted meta list is still the v2 (AccountData) shape pre-flip');
}
// pre-migration crank position: clock at the v2 buy time + full vesting
W3.setTime(T0 + 20 + 432_001);
{
  const migrateIx = new TransactionInstruction({
    programId: ENGINE, data: Buffer.from([10]),
    keys: [
      K(L2.mint, false, false), K(configPda(L2.mint), false, false), K(buyerV2.publicKey, false, false),
      K(buyerV2Ata, false, false), K(legacyPda, false, true), K(holderPdaRaw(L2.mint, buyerV2Ata), false, true),
      K(vaultPda(L2.mint), false, true), K(SystemProgram.programId, false, false),
    ],
  });
  const r = sendTx(W3.svm, new Transaction().add(migrateIx), [W3.creator], '2b MigrateHolder');
  ok(r.ok, '2b MigrateHolder succeeds (permissionless — signed by an unrelated wallet)');
}
{
  const moved = W3.svm.getAccount(holderPdaRaw(L2.mint, buyerV2Ata));
  ok(!!moved && Buffer.from(moved.data).equals(legacyBytes), '2b record bytes at the ATA-keyed PDA are VERBATIM the v2 record');
  const old = W3.svm.getAccount(legacyPda);
  ok(old == null || old.data.length === 0, '2b legacy account closed');
}
{
  const refreshIx = new TransactionInstruction({
    programId: ENGINE, data: Buffer.from([9]),
    keys: [K(W3.creator.publicKey, true, true), K(metaPda(L2.mint), false, true), K(L2.mint, false, false), K(configPda(L2.mint), false, false), K(SystemProgram.programId, false, false)],
  });
  const r = sendTx(W3.svm, new Transaction().add(refreshIx), [W3.creator], '2b RefreshExtraAccountMetas');
  ok(r.ok, '2b RefreshExtraAccountMetas flips the list');
  const d = decodeMetas(W3.svm, L2.mint);
  ok(d && d.count === 7 && d.entries.every((e) => !e.hasAccountData), '2b flipped list: 7 extras, AccountKey shape', `count=${d?.count}`);
}
{
  // the migrated holder exits through the generic resolver (vested by now)
  const tx = await W3.client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: true,
    amountIn: new BN(balV2.toString()), minimumAmountOut: new BN(0),
    owner: buyerV2.publicKey, pool: L2.pool, referralTokenAccount: null, payer: buyerV2.publicKey,
  });
  const r = sendTx(W3.svm, tx, [buyerV2], '2b migrated holder generic sell');
  ok(r.ok, '2b migrated holder SELLS the full vested position through the generic resolver');
  ok(tokenBalance(W3.svm, buyerV2Ata) === 0n, '2b migrated position fully exited (migrated basis/peak governed the gate)');
}
{
  const buyer2 = Keypair.generate();
  fund(W3.svm, buyer2, 50);
  const { ata, r } = await genericFirstBuy(W3, L2, buyer2, 50_000_000n);
  ok(r.ok, '2b a FRESH wallet makes a generic first buy on the MIGRATED mint');
  const rec = W3.svm.getAccount(holderPdaRaw(L2.mint, ata));
  ok(!!rec && readU128(Buffer.from(rec.data), 6) === L2.feedEma(), '2b fresh record on the migrated mint carries basis == feed EMA');
}

console.log(`\n==== DBC x ENGINE V3 HEADLINE (generic doors + retrofit): ${pass} passed, ${fail} failed ====`);
fs.writeFileSync(new URL('./dbc-v3-headline-result.json', import.meta.url), JSON.stringify({ passed: pass, failed: fail, ts: new Date().toISOString() }, null, 2));
process.exit(fail ? 1 : 0);

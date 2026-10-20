// DBC x ENGINE — PER-CONFIG META-LIST TEMPLATING proof (Phase 2, LiteSVM,
// real binaries). The question this suite answers: can a token whose rules
// need NO holder state trade through the GENERIC path — a fresh buyer, no
// pre-created ATA, no manual extras — the exact path that throws
// TokenTransferHookAccountDataNotFound against a v2-shaped (fixed superset)
// meta list?
//
//   A. MAX-WALLET-ONLY token (rule 9): its published meta list decodes to
//      2 extras with NO AccountData seeds. A fresh buyer's first buy is
//      built with the DBC SDK's swap2WithTransferHook exactly as an
//      uninformed client builds it (extras resolved internally by
//      spl-token from the on-chain list) and submitted as the generic
//      [create ATA, swap] bundle. Then: sell, second buy, and a
//      max-wallet VETO on the same templated mint.
//   B. NEGATIVE CONTROL: an Agent-Only (rule 3) mint publishes the
//      AccountData holder entries; the same fresh-wallet generic build
//      must throw TokenTransferHookAccountDataNotFound — and must succeed
//      once the ATA exists (isolating the cause).
//   C. DESYNC + REFRESH: a Max-Wallet mint updated to add Agent-Only
//      (expanding the required set) fails closed with MissingExtra until
//      RefreshExtraAccountMetas (tag 9) rewrites the list; then the
//      registered buyer's buy passes.
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
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
const IX_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
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
const creator = Keypair.generate();
for (const k of [partner, creator]) fund(svm, k, 400);
step('actors', { engine: ENGINE.toBase58(), creator: creator.publicKey.toBase58() });

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, ENGINE)[0];
const configPda = (mint) => pda([Buffer.from('config'), mint.toBuffer()]);
const holderPda = (mint, owner) => pda([Buffer.from('holder'), mint.toBuffer(), owner.toBuffer()]);
const vaultPda = (mint) => pda([Buffer.from('rentvault'), mint.toBuffer()]);
const metaPda = (mint) => pda([Buffer.from('extra-account-metas'), mint.toBuffer()]);
const acctData = (pk) => { const a = svm.getAccount(pk); return a ? Buffer.from(a.data) : null; };
const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });

// ---------- meta list decoding (TLV: [8 disc][4 len][4 count][35B entries]) ----------
// Entry: [disc u8][address_config 32][is_signer u8][is_writable u8].
// disc 0 = literal pubkey; disc 1 = seeded PDA (seed configs packed in
// address_config; seed disc 4 = AccountData {account_index, data_index, len}).
function decodeMetas(mint) {
  const raw = acctData(metaPda(mint));
  if (!raw) return null;
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
    entries.push({
      disc, writable: raw[o + 34] === 1, seeds, hasAccountData,
      describe: disc === 0 ? `pubkey(${new PublicKey(config).toBase58()})` : `pda[${seeds.join(', ')}]`,
    });
  }
  return { raw, count, entries };
}

// ---------- engine instruction builders (mirror dbc-engine-integration-v2) ----------
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
const maxWalletParams = (bps) => { const p = Buffer.alloc(64); p.writeUInt16LE(bps, 0); return p; };
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
  keys: [K(creator.publicKey, true, true), K(metaPda(mint), false, true), K(mint, false, false), K(SystemProgram.programId, false, false), K(configPda(mint), false, false)],
});
const refreshMetasIx = (mint) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([9]),
  keys: [K(creator.publicKey, true, true), K(metaPda(mint), false, true), K(mint, false, false), K(configPda(mint), false, false), K(SystemProgram.programId, false, false)],
});
const setRegisteredIx = (mint, owner, val) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([4, val]),
  keys: [K(creator.publicKey, true, false), K(mint, false, false), K(configPda(mint), false, false), K(owner, false, false), K(holderPda(mint, getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID)), false, true), K(SystemProgram.programId, false, false)],
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
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Slot,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: threshold,
  });
}

// Launch through the same instruction sequence launch.mjs uses:
// DBC config -> DBC pool -> engine config -> metas -> fund rent vault.
async function launch(symbol, rules) {
  const dbcConfig = Keypair.generate();
  {
    const tx = await client.partner.createConfigWithTransferHook({
      config: dbcConfig.publicKey, feeClaimer: partner.publicKey,
      leftoverReceiver: partner.publicKey, payer: partner.publicKey,
      quoteMint: NATIVE_MINT, transferHookProgram: ENGINE, ...curveConfig(42),
    });
    const r = sendTx(svm, tx, [partner, dbcConfig], `${symbol} createConfigWithTransferHook`);
    if (!r.ok) throw new Error(`${symbol} L1 failed`);
  }
  const baseMint = Keypair.generate();
  const tx = await client.creator.createPoolWithTransferHook({
    baseMint: baseMint.publicKey, config: dbcConfig.publicKey, transferHookProgram: ENGINE,
    name: symbol, symbol, uri: 'https://example.invalid/t.json',
    payer: creator.publicKey, poolCreator: creator.publicKey,
  });
  const r = sendTx(svm, tx, [creator, baseMint], `${symbol} createPoolWithTransferHook`);
  if (!r.ok) throw new Error(`${symbol} L2 failed`);
  const mint = baseMint.publicKey;
  const pool = deriveDbcPoolAddress(NATIVE_MINT, mint, dbcConfig.publicKey);
  const poolAuthority = deriveDbcPoolAuthority();
  const baseVault = deriveDbcTokenVaultAddress(pool, mint);
  const quoteVault = deriveDbcTokenVaultAddress(pool, NATIVE_MINT);
  const cfg = { mode: 1, authority: creator.publicKey, rules, venues: [DBC_ID], exemptions: [poolAuthority, baseVault] };
  const r3 = sendTx(svm, new Transaction().add(initConfigIx(mint, cfg)), [creator], `${symbol} engine InitializeConfig`);
  if (!r3.ok) throw new Error(`${symbol} L3 failed`);
  const r4 = sendTx(svm, new Transaction().add(initMetasIx(mint)), [creator], `${symbol} engine InitializeExtraAccountMetas`);
  if (!r4.ok) throw new Error(`${symbol} L4 failed`);
  sendTx(svm, new Transaction().add(SystemProgram.transfer({
    fromPubkey: creator.publicKey, toPubkey: vaultPda(mint), lamports: 50_000_000,
  })), [creator], `${symbol} fund rent vault`);
  return { mint, pool, poolAuthority, baseVault, quoteVault, cfg };
}

// The GENERIC build: swap2WithTransferHook exactly as an uninformed client
// calls it — the SDK resolves the hook extras internally via spl-token.
// No ATA pre-creation, no manual extras, nothing hook-aware.
async function buildSwap(L, owner, sol, isBuy, rawIn = null) {
  return client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: !isBuy,
    amountIn: new BN(rawIn ?? Math.round(sol * 1e9)), minimumAmountOut: new BN(0),
    owner: owner.publicKey, pool: L.pool, referralTokenAccount: null, payer: owner.publicKey,
  });
}
// The generic-bot bundle: [create ATA (iff the swap tx doesn't carry one
// for this ATA), ...swap instructions].
function genericBundle(swapTx, payer, ata, owner, mint) {
  const hasAtaCreate = swapTx.instructions.some((ix) =>
    ix.programId.equals(ATA_PROGRAM) && ix.keys[1] && ix.keys[1].pubkey.equals(ata));
  const tx = new Transaction();
  if (!hasAtaCreate) tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner.publicKey, mint, TOKEN_2022_PROGRAM_ID));
  for (const ix of swapTx.instructions) tx.add(ix);
  return tx;
}
const newBuyer = () => { const kp = Keypair.generate(); fund(svm, kp, 50); return kp; };

// ================= A. MAX-WALLET-ONLY (rule 9) — the templated mint =================
step('A', 'launch MAX-WALLET-ONLY token (rule 9, cap 9000 bps)');
const A = await launch('TPL9', [{ id: 9, params: maxWalletParams(9000) }]);
{
  const d = decodeMetas(A.mint);
  console.log('  published meta list for the max-wallet mint (decoded):');
  d.entries.forEach((e, i) => console.log(`    [${i}] ${e.describe} writable=${e.writable}`));
  ok(d && d.count === 2, 'A1 meta list has exactly 2 extras (config + instructions sysvar)', `count=${d?.count}`);
  ok(d.entries.every((e) => !e.hasAccountData), 'A2 NO entry carries an AccountData seed (fully static list)');
  ok(d.entries[0].describe.includes('pda[literal("config")'), 'A3 extra[0] is the config PDA (seeded from the mint key only)');
  ok(d.entries[1].describe === `pubkey(${IX_SYSVAR.toBase58()})`, 'A4 extra[1] is the instructions sysvar literal');
  ok(d.raw.length === 86, 'A5 meta list account is 86 bytes (16 + 2*35)', `len=${d.raw.length}`);
}
const buyerA = newBuyer();
const ataA = getAssociatedTokenAddressSync(A.mint, buyerA.publicKey, false, TOKEN_2022_PROGRAM_ID);
let bA1 = 0n;
{
  ok(svm.getAccount(ataA) == null, 'A6 buyer ATA does not exist before the first buy (fresh wallet)');
  let swapTx = null, buildErr = null;
  try { swapTx = await buildSwap(A, buyerA, 0.05, true); } catch (e) { buildErr = e; }
  ok(buildErr === null && swapTx !== null, 'A7 GENERIC BUILD SUCCEEDS for the fresh buyer (no ATA, no manual extras)', buildErr ? String(buildErr.message || buildErr) : '');
  const r = sendTx(svm, genericBundle(swapTx, buyerA, ataA, buyerA, A.mint), [buyerA], 'A generic first buy bundle [create ATA, swap]');
  ok(r.ok, 'A8 generic first buy LANDS');
  bA1 = tokenBalance(svm, ataA);
  ok(bA1 > 0n, 'A9 buyer received tokens', `balance=${bA1}`);
}
{
  // SELL on the templated mint (existing holder).
  const sellRaw = 1_000_000_000n; // 1,000 tokens at 6 decimals
  const swapTx = await buildSwap(A, buyerA, 0, false, sellRaw.toString());
  const r = sendTx(svm, swapTx, [buyerA], 'A sell 1000 tokens');
  ok(r.ok, 'A10 sell on the templated mint succeeds');
  ok(tokenBalance(svm, ataA) === bA1 - sellRaw, 'A11 balance decreased by exactly the sold amount', `balance=${tokenBalance(svm, ataA)}`);
}
{
  // SECOND BUY (existing holder) on the templated mint.
  const swapTx = await buildSwap(A, buyerA, 0.05, true);
  const r = sendTx(svm, swapTx, [buyerA], 'A second buy');
  const b = tokenBalance(svm, ataA);
  ok(r.ok && b > bA1 - 1_000_000_000n, 'A12 second buy (existing holder) succeeds and increases the balance', `balance=${b}`);
  bA1 = b;
}
{
  // MAX-WALLET VETO still fires on the templated mint.
  const tighten = { ...A.cfg, rules: [{ id: 9, params: maxWalletParams(20) }] };
  const ru = sendTx(svm, new Transaction().add(updateConfigIx(A.mint, tighten)), [creator], 'A UpdateConfig cap=20bps');
  ok(ru.ok, 'A13 cap tightened to 20 bps via UpdateConfig (same required set — no refresh needed)');
  const buyer3 = newBuyer();
  const ata3 = getAssociatedTokenAddressSync(A.mint, buyer3.publicKey, false, TOKEN_2022_PROGRAM_ID);
  let swapTx = null, buildErr = null;
  try { swapTx = await buildSwap(A, buyer3, 0.05, true); } catch (e) { buildErr = e; }
  ok(buildErr === null && swapTx !== null, 'A14 generic build still succeeds for a fresh buyer under the tight cap');
  const r = sendTx(svm, genericBundle(swapTx, buyer3, ata3, buyer3, A.mint), [buyer3], 'A buy @ cap 20bps');
  ok(!r.ok && (r.logs || []).some((l) => l.includes('max wallet exceeded')), 'A15 buy VETOES with MaxWalletExceeded on the templated mint');
  ok(tokenBalance(svm, ata3) === 0n, 'A16 veto atomic — buyer3 balance still 0');
  const restore = sendTx(svm, new Transaction().add(updateConfigIx(A.mint, A.cfg)), [creator], 'A UpdateConfig restore 9000bps');
  ok(restore.ok, 'A17 cap restored to 9000 bps');
  const swapTx2 = await buildSwap(A, buyer3, 0.05, true);
  const r2 = sendTx(svm, genericBundle(swapTx2, buyer3, ata3, buyer3, A.mint), [buyer3], 'A buyer3 buy @ 9000bps');
  ok(r2.ok && tokenBalance(svm, ata3) > 0n, 'A18 the same generic buy passes at the restored cap');
}

// ================= B. V3 POSITIVE PROOF — holder-state list, generic first buy =================
// v2 framed this section as the NEGATIVE CONTROL: the agent-only list
// carried AccountData holder seeds and the generic build THREW
// TokenTransferHookAccountDataNotFound for every fresh buyer. Engine v3
// (AccountKey derivation, SPEC-ENGINE-V3 SS9) deletes that failure mode
// by construction — the holder entry is seeded from the destination
// token account's KEY, which a route builder can compute for an ATA
// that does not exist yet. This section proves the positive: key-seeded
// list, generic build succeeds for a fresh wallet, and once the buyer
// is registered (rule 3's actual gate) the generic first buy LANDS.
step('B', 'launch AGENT-ONLY token (rule 3) — holder-state config');
const B = await launch('TPL3', [{ id: 3 }]);
{
  const d = decodeMetas(B.mint);
  console.log('  published meta list for the agent-only mint (decoded):');
  d.entries.forEach((e, i) => console.log(`    [${i}] ${e.describe} writable=${e.writable}`));
  ok(d && d.count === 5, 'B1 meta list has 5 extras (config, dst holder, rent vault, system, sysvar)', `count=${d?.count}`);
  ok(d.entries.every((e) => !e.hasAccountData) && d.entries.some((e) => e.seeds.some((sd) => sd.startsWith('accountkey'))),
    'B2 the holder entry is ACCOUNTKEY-seeded (the v3 shape) — no AccountData seeds anywhere in the list');
}
const buyerB = newBuyer();
const ataB = getAssociatedTokenAddressSync(B.mint, buyerB.publicKey, false, TOKEN_2022_PROGRAM_ID);
{
  ok(svm.getAccount(ataB) == null, 'B3 buyer ATA does not exist before the build (fresh wallet)');
  // Rule 3's real gate is registration: sync the mirror first (the
  // record lands at the ATA-keyed PDA the resolver will derive).
  const rs = sendTx(svm, new Transaction().add(setRegisteredIx(B.mint, buyerB.publicKey, 1)), [creator], 'B register buyerB');
  ok(rs.ok, 'B4a buyerB registered via SyncRegistered (mirror at the ATA-keyed record)');
  let built = null, bErr = '';
  try { built = await buildSwap(B, buyerB, 0.05, true); } catch (e) { bErr = `${e?.name || ''} ${e?.message || e}`; }
  ok(built !== null && bErr === '', 'B4 generic build SUCCEEDS for the fresh buyer on the holder-state mint (v2 threw TokenTransferHookAccountDataNotFound here)', bErr.trim());
  const rb = sendTx(svm, genericBundle(built, buyerB, ataB, buyerB, B.mint), [buyerB], 'B generic first buy bundle [create ATA, swap]');
  ok(rb.ok && tokenBalance(svm, ataB) > 0n, 'B5 the generic first buy LANDS — buyerB receives tokens through the standard resolver path');
  const hb = acctData(holderPda(B.mint, ataB));
  ok(hb !== null && hb[1] === 1, 'B6 the record Execute read/wrote is the ATA-keyed PDA, carrying the registration mirror');
  let built2 = null, err2 = null;
  try { built2 = await buildSwap(B, buyerB, 0.05, true); } catch (e) { err2 = e; }
  ok(err2 === null && built2 !== null, 'B7 the generic build also succeeds with the ATA already existing (both resolution paths work)');
}

// ================= C. DESYNC + REFRESH (tag 9) =================
step('C', 'launch MAX-WALLET token, expand to AGENT-ONLY via UpdateConfig');
const C = await launch('TPLX', [{ id: 9, params: maxWalletParams(9000) }]);
const buyerC = newBuyer();
const ataC = getAssociatedTokenAddressSync(C.mint, buyerC.publicKey, false, TOKEN_2022_PROGRAM_ID);
{
  const expanded = { mode: 1, authority: creator.publicKey, rules: [{ id: 3 }, { id: 9, params: maxWalletParams(9000) }], venues: [DBC_ID], exemptions: [C.poolAuthority, C.baseVault] };
  const ru = sendTx(svm, new Transaction().add(updateConfigIx(C.mint, expanded)), [creator], 'C UpdateConfig + Agent-Only');
  ok(ru.ok, 'C1 expanding UpdateConfig (rule 9 -> rules 3+9) is allowed');
  ok((ru.logs || []).some((l) => l.includes('RefreshExtraAccountMetas')), 'C2 the update logs the refresh requirement (desync warning)');
  // Register buyerC first so ONLY the missing extras can fail the buy.
  const rs = sendTx(svm, new Transaction().add(setRegisteredIx(C.mint, buyerC.publicKey, 1)), [creator], 'C SyncRegistered(buyerC)');
  ok(rs.ok, 'C3 buyerC registered via SyncRegistered path (a)');
  const rc = sendTx(svm, new Transaction().add(
    createAssociatedTokenAccountInstruction(creator.publicKey, ataC, buyerC.publicKey, C.mint, TOKEN_2022_PROGRAM_ID),
  ), [creator], 'C pre-create buyer ATA');
  ok(rc.ok, 'C4 buyer ATA pre-created (build-side resolution satisfied)');
  const swapTx = await buildSwap(C, buyerC, 0.05, true);
  const r = sendTx(svm, swapTx, [buyerC], 'C buy with stale (pre-expansion) meta list');
  ok(!r.ok && (r.logs || []).some((l) => l.includes('missing required extra')), 'C5 buy FAILS CLOSED with MissingExtra while the meta list is stale');
  ok(tokenBalance(svm, ataC) === 0n, 'C6 nothing moved under the stale list');
  const rr = sendTx(svm, new Transaction().add(refreshMetasIx(C.mint)), [creator], 'C RefreshExtraAccountMetas');
  ok(rr.ok, 'C7 RefreshExtraAccountMetas (tag 9) succeeds');
  const d = decodeMetas(C.mint);
  ok(d && d.count === 5 && !d.entries.some((e) => e.hasAccountData) && d.entries.some((e) => e.seeds.some((sd) => sd.startsWith('accountkey'))), 'C8 refreshed list now publishes the 5 extras incl. the dst-holder AccountKey entry', `count=${d?.count}`);
  const swapTx2 = await buildSwap(C, buyerC, 0.05, true);
  const r2 = sendTx(svm, swapTx2, [buyerC], 'C buy after refresh');
  ok(r2.ok && tokenBalance(svm, ataC) > 0n, 'C9 registered buy PASSES after the refresh', `balance=${tokenBalance(svm, ataC)}`);
}

console.log(`\n==== DBC x ENGINE TEMPLATING (PHASE 2): ${pass} passed, ${fail} failed ====`);
fs.writeFileSync(`${BUILD_DIR}/integration/dbc-templating-result.json`,
  JSON.stringify({ engine: ENGINE.toBase58(), pass, fail }, null, 2));
if (fail > 0) process.exit(1);

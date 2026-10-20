// dbc-v3-refresh-rehearsal.mjs — ENGINE v3 TAG-9 FIX REGRESSION GATE.
//
// The first v3 deploy window (deploy/DEPLOY-RECORD-V3.md) died here:
// RefreshExtraAccountMetas realloc'd the meta-list account to the new
// size BEFORE ExtraAccountMetaList::update(), and both live lists are
// launch-era 261-byte 7-extra SUPERSETS. Shrinking first truncated the
// buffer under a TLV entry still declaring 249 bytes, the library's
// unpack unwrap panicked, and the flip was never sent. Every prior
// rehearsal started from a templating-era list at an already-correct
// size, so the shrink path was never exercised.
//
// This suite rehearses the retrofit against the PRESERVED EXACT
// MAINNET LIST BYTES (deploy/v3-window/raw/pre-agtr-metalist.b64 and
// pre-latch-metalist.b64 — byte-identical to each other, sha256
// 0616283f…): the bytes are planted verbatim as the meta-list account
// of transplanted v2 state, for BOTH live tokens' config shapes:
//
//   PART L — LATCH shape [1 GRADUATED, 9 @300bps]: flip is SAME-SIZE
//     (7 extras -> 7 extras, seeds change AccountData -> AccountKey).
//   PART A — AGTR shape [3 Agent-Only, 9 @500bps]: flip SHRINKS
//     261 B -> 191 B (5 extras). The window-killing path.
//   PART G — grow + shrink-back + idempotent refresh on an engine-only
//     world (config updates move the mask 5 -> 7 -> 7 -> 5 extras).
//
// Each of L and A runs the full gate sequence: resolver THROWS on the
// planted list for a fresh wallet (the BEFORE state) -> MigrateHolder
// moves a real v2-created legacy record verbatim -> tag-9 flip (with
// exact rent-settle assertions against the payer) -> list decodes as
// the AccountKey templated shape -> resolver RESOLVES for a fresh
// wallet -> migrated holder trades generically -> a fresh wallet
// completes the generic first-buy flow.
import fs from 'fs';
import path from 'path';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, createTransferCheckedWithTransferHookInstruction,
  createInitializeMintInstruction, getMintLen,
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
const regKp = JSON.parse(fs.readFileSync(`${BUILD_DIR}/registry/registry-keypair.json`, 'utf8'));
const REGISTRY = Keypair.fromSecretKey(Uint8Array.from(regKp)).publicKey;
const REGISTRY_BIN = `${BUILD_DIR}/registry/target/deploy/registry.so`;
const INIT_METAS_DISC = Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]);
const V2_BINARY = `${BUILD_DIR}/engine/v2-snapshot/engine-trial-phase2.so`;
const V3_BINARY = `${BUILD_DIR}/engine/target/deploy/engine.so`;

const PRESERVED_AGTR = Buffer.from(fs.readFileSync(`${BUILD_DIR}/deploy/v3-window/raw/pre-agtr-metalist.b64`, 'utf8').trim(), 'base64');
const PRESERVED_LATCH = Buffer.from(fs.readFileSync(`${BUILD_DIR}/deploy/v3-window/raw/pre-latch-metalist.b64`, 'utf8').trim(), 'base64');

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
const regPda = (wallet) => PublicKey.findProgramAddressSync([Buffer.from('registration'), wallet.toBuffer()], REGISTRY)[0];
const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });
const readU128 = (d, o) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);
const minRent = (svm, n) => Number(svm.minimumBalanceForRentExemption(BigInt(n)));
const lamports = (svm, pk) => Number(svm.getAccount(pk)?.lamports ?? 0);

// ---------- meta list decoding (same TLV walk as dbc-v3-headline) ----------
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
    } else if (disc === 0) {
      seeds.push(`address(${new PublicKey(config.subarray(0, 32)).toBase58()})`);
    }
    entries.push({ disc, seeds, hasAccountData });
  }
  return { count, entries, size: raw.length };
}

// ---------- world scaffolding ----------
function makeWorld(binaryPath) {
  const svm = makeSvm([
    [DBC_ID, `${BUILD_DIR}/bin/dynamic_bonding_curve.so`],
    [ENGINE, binaryPath],
    [REGISTRY, REGISTRY_BIN],
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
const gradParams = () => {
  const p = Buffer.alloc(64);
  p.writeBigUInt64LE(1_000_000n, 0);
  p.writeBigUInt64LE(0n, 8);
  p.writeUInt16LE(0, 16);
  p[18] = 2; // GRADUATED
  p.writeUInt16LE(0, 19);
  p.writeBigUInt64LE(432_000n, 21);
  p.writeUInt16LE(20_000, 29);
  return p;
};
const maxWalletParams = (bps) => { const p = Buffer.alloc(64); p.writeUInt16LE(bps, 0); return p; };
const zeroParams = () => Buffer.alloc(64);

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

// Launch a DBC token on this world's engine binary with the given rule
// stack (rules: [{id, params}]). feed=true also inits + cranks a price
// feed (rule 1). Mirrors dbc-v3-headline's launchGraduated, generalized.
async function launchToken(W, rules, feed, label) {
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
      name: 'Rehearsal', symbol: 'RHR', uri: 'https://example.invalid/r.json',
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
    rules, venues: [DBC_ID], exemptions: [poolAuthority, baseVault],
  };
  const initCfg = new TransactionInstruction({
    programId: ENGINE, data: configPayload(cfg, 1),
    keys: [K(creator.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, true), K(SystemProgram.programId, false, false)],
  });
  ok(sendTx(svm, new Transaction().add(initCfg), [creator], 'init config').ok, `${label} engine config inited`);
  const initMetas = new TransactionInstruction({
    programId: ENGINE, data: INIT_METAS_DISC,
    keys: [K(creator.publicKey, true, true), K(metaPda(mint), false, true), K(mint, false, false), K(SystemProgram.programId, false, false), K(configPda(mint), false, false)],
  });
  ok(sendTx(svm, new Transaction().add(initMetas), [creator], 'init metas').ok, `${label} meta list initialized`);
  if (feed) {
    const initFeed = new TransactionInstruction({
      programId: ENGINE,
      data: Buffer.concat([Buffer.from([6]), pool.toBuffer(), baseVault.toBuffer(), quoteVault.toBuffer(), Buffer.from([tokDec, 9])]),
      keys: [K(creator.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, false), K(pricePda(mint), false, true), K(SystemProgram.programId, false, false)],
    });
    ok(sendTx(svm, new Transaction().add(initFeed), [creator], 'init feed').ok, `${label} price feed initialized`);
  }
  ok(sendTx(svm, new Transaction().add(SystemProgram.transfer({
    fromPubkey: creator.publicKey, toPubkey: vaultPda(mint), lamports: 50_000_000,
  })), [creator], 'fund rent vault').ok, `${label} rent vault funded`);
  if (feed) {
    const crankIx = new TransactionInstruction({
      programId: ENGINE, data: Buffer.from([8]),
      keys: [K(configPda(mint), false, false), K(pricePda(mint), false, true), K(pool, false, false)],
    });
    ok(sendTx(svm, new Transaction().add(crankIx), [creator], 'crank').ok, `${label} price feed cranked`);
  }
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

// Generic-router-shaped first buy (identical to dbc-v3-headline).
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

// Resolution probe: the spl-token generic resolver over the world's
// connection — the exact call that threw on mainnet pre-flip
// (deploy/v3-window/v3-resolve.mjs). Source ATA must exist; the
// destination ATA deliberately does NOT.
async function probeResolve(W, mint, srcAta, srcOwner, freshOwner) {
  const destAta = getAssociatedTokenAddressSync(mint, freshOwner, false, T22);
  try {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      W.conn, srcAta, mint, destAta, srcOwner, 1n, 6, [], 'confirmed', T22);
    return { resolved: true, destAta, extraKeys: ix.keys.slice(4).map((k) => k.pubkey) };
  } catch (e) {
    return { resolved: false, destAta, error: String(e?.message || e) };
  }
}

const registryRegisterIx = (wallet, kind) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.from([0, kind]),
  keys: [K(wallet, true, true), K(regPda(wallet), false, true), K(SystemProgram.programId, false, false)],
});
// SyncRegistered path (b) — data [4,0], registration PDA appended; the
// holder account passed is version-shaped (owner-keyed under v2,
// ATA-keyed under v3), matching each binary's own derivation.
const syncIx = (mint, me, holderAcct) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([4, 0]),
  keys: [K(me, true, true), K(mint, false, false), K(configPda(mint), false, false), K(me, false, false),
         K(holderAcct, false, true), K(SystemProgram.programId, false, false), K(regPda(me), false, false)],
});
const migrateIx = (mint, owner, ata, signer) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([10]),
  keys: [
    K(mint, false, false), K(configPda(mint), false, false), K(owner, false, false),
    K(ata, false, false), K(holderPdaRaw(mint, owner), false, true), K(holderPdaRaw(mint, ata), false, true),
    K(vaultPda(mint), false, true), K(SystemProgram.programId, false, false),
  ],
});
const refreshIx = (mint, payer) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([9]),
  keys: [K(payer, true, true), K(metaPda(mint), false, true), K(mint, false, false), K(configPda(mint), false, false), K(SystemProgram.programId, false, false)],
});

// Plant the preserved mainnet list bytes as the world's meta-list
// account (data verbatim; lamports = this SVM's rent-exempt for 261 B,
// so the settle deltas below are exact).
function plantPreservedList(W, mint) {
  W.svm.setAccount(metaPda(mint), {
    lamports: minRent(W.svm, 261),
    data: new Uint8Array(PRESERVED_AGTR),
    owner: ENGINE, executable: false, rentEpoch: 0,
  });
}

const T0 = 1_760_000_000;
const FEE = 5000; // LiteSVM: 5000 lamports per signature

// ================= fixture sanity =================
step('FIXTURE', 'preserved mainnet list bytes');
ok(PRESERVED_AGTR.length === 261 && PRESERVED_AGTR.equals(PRESERVED_LATCH),
  'preserved AGTR and LATCH list bytes are identical, 261 B');
{
  const probe = makeSvm([[ENGINE, V3_BINARY]]);
  ok(minRent(probe, 261) - minRent(probe, 191) === 487200,
    'rent deltas: min(261) - min(191) = 487200 lamports', `min261=${minRent(probe, 261)} min191=${minRent(probe, 191)}`);
}

// ================= PART L — LATCH shape [1 GRADUATED, 9 @300] =================
step('PART L/v2', 'launch graduated token on the v2 binary; real buy; capture state');
const WL1 = makeWorld(V2_BINARY);
WL1.setTime(T0);
const LL2 = await launchToken(WL1, [
  { id: 1, params: gradParams() }, { id: 9, params: maxWalletParams(300) },
], true, 'L2');
const buyerL = Keypair.generate();
fund(WL1.svm, buyerL, 50);
const buyerLAta = getAssociatedTokenAddressSync(LL2.mint, buyerL.publicKey, false, T22);
ok(sendTx(WL1.svm, new Transaction().add(
  createAssociatedTokenAccountInstruction(buyerL.publicKey, buyerLAta, buyerL.publicKey, LL2.mint, T22),
), [buyerL], 'L pre-create buyer ATA').ok, 'L buyer ATA pre-created (v2 flow)');
WL1.setTime(T0 + 20);
ok((await LL2.swap(buyerL, false, 50_000_000n)).ok, 'L v2 buy lands (0.05 SOL)');
const legacyLPda = holderPdaRaw(LL2.mint, buyerL.publicKey);
const legacyLAcct = WL1.svm.getAccount(legacyLPda);
ok(!!legacyLAcct, 'L v2 buy created the OWNER-keyed holder record');
const legacyLBytes = Buffer.from(legacyLAcct.data);
ok(readU128(legacyLBytes, 6) === LL2.feedEma() && readU128(legacyLBytes, 6) > 0n,
  'L record basis == cranked EMA (real v2 state)', `basis=${readU128(legacyLBytes, 6)}`);
const balL = tokenBalance(WL1.svm, buyerLAta);
ok(balL > 0n, 'L buyer balance > 0', `bal=${balL}`);
{
  const v2ListBytes = Buffer.from(WL1.svm.getAccount(metaPda(LL2.mint)).data);
  ok(v2ListBytes.equals(PRESERVED_AGTR),
    'L the v2 binary writes EXACTLY the preserved mainnet list bytes for this config shape',
    `len=${v2ListBytes.length}`);
}
const transplantL = [
  LL2.mint, LL2.dbcConfig, LL2.pool, LL2.baseVault, LL2.quoteVault,
  configPda(LL2.mint), metaPda(LL2.mint), pricePda(LL2.mint), vaultPda(LL2.mint),
  buyerLAta, legacyLPda,
];
const capturedL = transplantL.map((pk) => [pk, WL1.svm.getAccount(pk)]);
ok(capturedL.every(([, a]) => !!a), 'L all transplant accounts captured');

step('PART L/v3', 'transplant; plant PRESERVED bytes; migrate; flip (same size); trade');
const WL3 = makeWorld(V3_BINARY);
for (const [pk, a] of capturedL) {
  WL3.svm.setAccount(pk, {
    lamports: a.lamports, data: new Uint8Array(a.data), owner: a.owner,
    executable: a.executable, rentEpoch: Number(a.rentEpoch ?? 0),
  });
}
fund(WL3.svm, buyerL, 50);
plantPreservedList(WL3, LL2.mint);
{
  const planted = Buffer.from(WL3.svm.getAccount(metaPda(LL2.mint)).data);
  ok(planted.equals(PRESERVED_AGTR), 'L planted meta list == preserved mainnet bytes verbatim');
  const d = decodeMetas(WL3.svm, LL2.mint);
  ok(d && d.count === 7 && d.entries.some((e) => e.hasAccountData),
    'L planted list decodes as the launch-era AccountData shape');
}
const freshL = Keypair.generate();
{
  const probe = await probeResolve(WL3, LL2.mint, buyerLAta, buyerL.publicKey, freshL.publicKey);
  ok(!probe.resolved && /AccountData/.test(probe.error || ''),
    'L BEFORE: generic resolver THROWS for a fresh wallet on the planted list', (probe.error || '').slice(0, 90));
}
WL3.setTime(T0 + 20 + 432_001);
ok(sendTx(WL3.svm, new Transaction().add(migrateIx(LL2.mint, buyerL.publicKey, buyerLAta)), [WL3.creator], 'L MigrateHolder').ok,
  'L MigrateHolder succeeds (permissionless signer)');
{
  const moved = WL3.svm.getAccount(holderPdaRaw(LL2.mint, buyerLAta));
  ok(!!moved && Buffer.from(moved.data).equals(legacyLBytes), 'L migrated record is VERBATIM the v2 record');
  const old = WL3.svm.getAccount(legacyLPda);
  ok(old == null || old.data.length === 0, 'L legacy account closed');
}
const opL = Keypair.generate();
WL3.svm.airdrop(opL.publicKey, BigInt(LAMPORTS_PER_SOL));
const opLBefore = lamports(WL3.svm, opL.publicKey);
ok(sendTx(WL3.svm, new Transaction().add(refreshIx(LL2.mint, opL.publicKey)), [opL], 'L tag-9 flip').ok,
  'L tag-9 flip LANDS on the preserved launch-era list (same-size case)');
{
  const a = WL3.svm.getAccount(metaPda(LL2.mint));
  const d = decodeMetas(WL3.svm, LL2.mint);
  ok(a.data.length === 261, 'L flipped list is 261 B (7 extras, same size)', `len=${a.data.length}`);
  ok(d && d.count === 7 && d.entries.every((e) => !e.hasAccountData),
    'L flipped list: 7 extras, NO AccountData seeds (AccountKey shape)');
  ok(d.entries[1].seeds.join(' ').includes('accountkey(0)') && d.entries[2].seeds.join(' ').includes('accountkey(2)'),
    'L holder entries derive from the SOURCE (idx 0) and DEST (idx 2) token accounts');
  ok(Number(a.lamports) === minRent(WL3.svm, 261), 'L flipped list is exactly rent-exempt for 261 B');
  ok(lamports(WL3.svm, opL.publicKey) === opLBefore - FEE,
    'L payer settle is a wash at same size: delta == -fee exactly', `delta=${lamports(WL3.svm, opL.publicKey) - opLBefore}`);
}
{
  const probe = await probeResolve(WL3, LL2.mint, buyerLAta, buyerL.publicKey, freshL.publicKey);
  ok(probe.resolved, 'L AFTER: generic resolver RESOLVES for a fresh wallet');
  ok(probe.resolved && probe.extraKeys.some((k) => k.equals(holderPdaRaw(LL2.mint, probe.destAta))),
    'L resolved extras include the fresh wallet ATA-keyed holder PDA');
}
{
  const tx = await WL3.client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: true,
    amountIn: new BN(balL.toString()), minimumAmountOut: new BN(0),
    owner: buyerL.publicKey, pool: LL2.pool, referralTokenAccount: null, payer: buyerL.publicKey,
  });
  const r = sendTx(WL3.svm, tx, [buyerL], 'L migrated holder generic sell');
  ok(r.ok, 'L migrated holder SELLS the full vested position through the generic resolver');
  ok(tokenBalance(WL3.svm, buyerLAta) === 0n, 'L migrated position fully exited');
}
{
  const buyer2 = Keypair.generate();
  fund(WL3.svm, buyer2, 50);
  const L1w = { ...LL2, mint: LL2.mint, pool: LL2.pool };
  const { ata, r } = await genericFirstBuy(WL3, L1w, buyer2, 50_000_000n);
  ok(r.ok, 'L a FRESH wallet makes a generic first buy on the flipped mint');
  const rec = WL3.svm.getAccount(holderPdaRaw(LL2.mint, ata));
  ok(!!rec && readU128(Buffer.from(rec.data), 6) === LL2.feedEma(),
    'L fresh record on the flipped mint carries basis == feed EMA');
}

// ================= PART A — AGTR shape [3 Agent-Only, 9 @500] =================
step('PART A/v2', 'launch agent-only token on the v2 binary; register+sync; real buy; capture');
const WA1 = makeWorld(V2_BINARY);
WA1.setTime(T0);
const LA2 = await launchToken(WA1, [
  { id: 3, params: zeroParams() }, { id: 9, params: maxWalletParams(500) },
], false, 'A2');
const buyerA = Keypair.generate();
fund(WA1.svm, buyerA, 50);
const buyerAAta = getAssociatedTokenAddressSync(LA2.mint, buyerA.publicKey, false, T22);
ok(sendTx(WA1.svm, new Transaction().add(registryRegisterIx(buyerA.publicKey, 1)), [buyerA], 'A register').ok,
  'A buyer registered in the Registry (kind=agent)');
ok(sendTx(WA1.svm, new Transaction().add(syncIx(LA2.mint, buyerA.publicKey, holderPdaRaw(LA2.mint, buyerA.publicKey))), [buyerA], 'A sync (v2 owner-keyed)').ok,
  'A SyncRegistered under v2 (record at the OWNER-keyed PDA)');
ok(sendTx(WA1.svm, new Transaction().add(
  createAssociatedTokenAccountInstruction(buyerA.publicKey, buyerAAta, buyerA.publicKey, LA2.mint, T22),
), [buyerA], 'A pre-create buyer ATA').ok, 'A buyer ATA pre-created (v2 flow)');
WA1.setTime(T0 + 20);
ok((await LA2.swap(buyerA, false, 50_000_000n)).ok, 'A v2 buy lands (0.05 SOL)');
const legacyAPda = holderPdaRaw(LA2.mint, buyerA.publicKey);
const legacyAAcct = WA1.svm.getAccount(legacyAPda);
ok(!!legacyAAcct, 'A v2 buy kept the OWNER-keyed holder record');
const legacyABytes = Buffer.from(legacyAAcct.data);
const balA = tokenBalance(WA1.svm, buyerAAta);
ok(balA > 0n, 'A buyer balance > 0', `bal=${balA}`);
{
  const v2ListBytes = Buffer.from(WA1.svm.getAccount(metaPda(LA2.mint)).data);
  const d = decodeMetas(WA1.svm, LA2.mint);
  console.log(`  [A2] v2-written list for the AGTR shape: ${v2ListBytes.length} B, ${d?.count} extras (templated by the phase-2 binary; mainnet's launch-era list is the 261 B superset)`);
}
const transplantA = [
  LA2.mint, LA2.dbcConfig, LA2.pool, LA2.baseVault, LA2.quoteVault,
  configPda(LA2.mint), metaPda(LA2.mint), vaultPda(LA2.mint),
  buyerAAta, legacyAPda, regPda(buyerA.publicKey),
];
const capturedA = transplantA.map((pk) => [pk, WA1.svm.getAccount(pk)]);
ok(capturedA.every(([, a]) => !!a), 'A all transplant accounts captured');

step('PART A/v3', 'transplant; plant PRESERVED bytes; migrate; flip (SHRINK 261 -> 191); trade');
const WA3 = makeWorld(V3_BINARY);
for (const [pk, a] of capturedA) {
  WA3.svm.setAccount(pk, {
    lamports: a.lamports, data: new Uint8Array(a.data), owner: a.owner,
    executable: a.executable, rentEpoch: Number(a.rentEpoch ?? 0),
  });
}
fund(WA3.svm, buyerA, 50);
plantPreservedList(WA3, LA2.mint);
{
  const planted = Buffer.from(WA3.svm.getAccount(metaPda(LA2.mint)).data);
  ok(planted.equals(PRESERVED_AGTR), 'A planted meta list == preserved mainnet bytes verbatim');
  const d = decodeMetas(WA3.svm, LA2.mint);
  ok(d && d.count === 7 && d.entries.some((e) => e.hasAccountData),
    'A planted list decodes as the launch-era AccountData shape');
}
const freshA = Keypair.generate();
{
  const probe = await probeResolve(WA3, LA2.mint, buyerAAta, buyerA.publicKey, freshA.publicKey);
  ok(!probe.resolved && /AccountData/.test(probe.error || ''),
    'A BEFORE: generic resolver THROWS for a fresh wallet on the planted list', (probe.error || '').slice(0, 90));
}
WA3.setTime(T0 + 40);
ok(sendTx(WA3.svm, new Transaction().add(migrateIx(LA2.mint, buyerA.publicKey, buyerAAta)), [WA3.creator], 'A MigrateHolder').ok,
  'A MigrateHolder succeeds (permissionless signer)');
{
  const moved = WA3.svm.getAccount(holderPdaRaw(LA2.mint, buyerAAta));
  ok(!!moved && Buffer.from(moved.data).equals(legacyABytes), 'A migrated record is VERBATIM the v2 record');
  const old = WA3.svm.getAccount(legacyAPda);
  ok(old == null || old.data.length === 0, 'A legacy account closed');
}
const opA = Keypair.generate();
WA3.svm.airdrop(opA.publicKey, BigInt(LAMPORTS_PER_SOL));
const opABefore = lamports(WA3.svm, opA.publicKey);
const listLamportsBefore = lamports(WA3.svm, metaPda(LA2.mint));
ok(sendTx(WA3.svm, new Transaction().add(refreshIx(LA2.mint, opA.publicKey)), [opA], 'A tag-9 flip (SHRINK)').ok,
  'A tag-9 flip LANDS on the preserved launch-era list — THE SHRINK CASE THAT KILLED WINDOW 1');
{
  const a = WA3.svm.getAccount(metaPda(LA2.mint));
  const d = decodeMetas(WA3.svm, LA2.mint);
  ok(a.data.length === 191, 'A flipped list SHRANK to 191 B (5 extras)', `len=${a.data.length}`);
  ok(d && d.count === 5 && d.entries.every((e) => !e.hasAccountData),
    'A flipped list: 5 extras, NO AccountData seeds (AccountKey shape)');
  ok(d.entries[0].seeds.join(' ').includes('literal("config")')
    && d.entries[1].seeds.join(' ').includes('accountkey(2)')
    && d.entries[2].seeds.join(' ').includes('literal("rentvault")'),
    'A flipped entries in canonical order [config, dst holder (idx 2), rent vault, system, sysvar]');
  ok(Number(a.lamports) === minRent(WA3.svm, 191), 'A flipped list is exactly rent-exempt for 191 B');
  const refund = minRent(WA3.svm, 261) - minRent(WA3.svm, 191);
  ok(lamports(WA3.svm, opA.publicKey) === opABefore - FEE + refund,
    'A rent settle is NEUTRAL: payer refunded the shrink excess minus the tx fee',
    `delta=${lamports(WA3.svm, opA.publicKey) - opABefore} expected=${refund - FEE} (list held ${listLamportsBefore})`);
}
{
  const probe = await probeResolve(WA3, LA2.mint, buyerAAta, buyerA.publicKey, freshA.publicKey);
  ok(probe.resolved, 'A AFTER: generic resolver RESOLVES for a fresh wallet');
  ok(probe.resolved && probe.extraKeys.some((k) => k.equals(holderPdaRaw(LA2.mint, probe.destAta))),
    'A resolved extras include the fresh wallet ATA-keyed holder PDA');
}
{
  const tx = await WA3.client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: true,
    amountIn: new BN(balA.toString()), minimumAmountOut: new BN(0),
    owner: buyerA.publicKey, pool: LA2.pool, referralTokenAccount: null, payer: buyerA.publicKey,
  });
  const r = sendTx(WA3.svm, tx, [buyerA], 'A migrated holder generic sell');
  ok(r.ok, 'A migrated holder SELLS the full position through the generic resolver (Agent-Only gate reads the migrated record)');
  ok(tokenBalance(WA3.svm, buyerAAta) === 0n, 'A migrated position fully exited');
}
{
  const buyerB = Keypair.generate();
  fund(WA3.svm, buyerB, 50);
  ok(sendTx(WA3.svm, new Transaction().add(registryRegisterIx(buyerB.publicKey, 1)), [buyerB], 'A2 register').ok,
    'A fresh wallet registers in the Registry');
  const ataB = getAssociatedTokenAddressSync(LA2.mint, buyerB.publicKey, false, T22);
  ok(sendTx(WA3.svm, new Transaction().add(syncIx(LA2.mint, buyerB.publicKey, holderPdaRaw(LA2.mint, ataB))), [buyerB], 'A2 sync (v3 ATA-keyed)').ok,
    'A fresh wallet SyncRegistered under v3');
  ok(!!WA3.svm.getAccount(holderPdaRaw(LA2.mint, ataB)) && WA3.svm.getAccount(holderPdaRaw(LA2.mint, buyerB.publicKey)) == null,
    'A v3 sync wrote the record at the ATA-keyed PDA only');
  const { r } = await genericFirstBuy(WA3, LA2, buyerB, 50_000_000n);
  ok(r.ok, 'A fresh wallet makes a GENERIC FIRST BUY on the flipped AGTR-shape mint (ATA nonexistent at build)');
  ok(tokenBalance(WA3.svm, ataB) > 0n, 'A fresh wallet received tokens');
}

// ================= PART G — grow / shrink-back / idempotent (engine-only) =================
step('PART G', 'mask moves 5 -> 7 -> 7 -> 5 extras via config updates + refresh');
{
  const { LiteSVM } = await import('litesvm');
  const svm = new LiteSVM();
  svm.addProgramFromFile(ENGINE, V3_BINARY);
  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey, BigInt(100 * LAMPORTS_PER_SOL));
  // a bare Token-2022 mint (no hook needed — only the engine reads it)
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const mintLen = getMintLen([]);
  const mintRent = svm.minimumBalanceForRentExemption(BigInt(mintLen));
  const createMint = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mint, space: mintLen,
      lamports: Number(mintRent), programId: T22,
    }),
    createInitializeMintInstruction(mint, 6, payer.publicKey, null, T22),
  );
  ok(sendTx(svm, createMint, [payer, mintKp], 'G create mint').ok, 'G bare mint created');
  const cfgFor = (rules) => ({ mode: 1, authority: payer.publicKey, rules, venues: [], exemptions: [] });
  const rulesSmall = [{ id: 3, params: zeroParams() }, { id: 9, params: maxWalletParams(500) }];
  const rulesBig = [{ id: 1, params: gradParams() }, { id: 3, params: zeroParams() }, { id: 9, params: maxWalletParams(500) }];
  const initCfg = new TransactionInstruction({
    programId: ENGINE, data: configPayload(cfgFor(rulesSmall), 1),
    keys: [K(payer.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, true), K(SystemProgram.programId, false, false)],
  });
  ok(sendTx(svm, new Transaction().add(initCfg), [payer], 'G init config [3,9]').ok, 'G config [3,9] inited (Creator mode)');
  const initMetas = new TransactionInstruction({
    programId: ENGINE, data: INIT_METAS_DISC,
    keys: [K(payer.publicKey, true, true), K(metaPda(mint), false, true), K(mint, false, false), K(SystemProgram.programId, false, false), K(configPda(mint), false, false)],
  });
  ok(sendTx(svm, new Transaction().add(initMetas), [payer], 'G init metas').ok, 'G meta list initialized at the templated size');
  {
    const a = svm.getAccount(metaPda(mint));
    ok(a.data.length === 191 && Number(a.lamports) === minRent(svm, 191),
      'G initial list: 191 B, exactly rent-exempt', `len=${a.data.length}`);
  }
  const updCfg = (rules) => new TransactionInstruction({
    programId: ENGINE, data: configPayload(cfgFor(rules), 2),
    keys: [K(payer.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, true)],
  });
  // GROW: config gains rule 1 -> mask 5 -> 7 extras
  ok(sendTx(svm, new Transaction().add(updCfg(rulesBig)), [payer], 'G update config [1,3,9]').ok, 'G config updated to [1,3,9]');
  const opG = Keypair.generate();
  svm.airdrop(opG.publicKey, BigInt(LAMPORTS_PER_SOL));
  const growDelta = minRent(svm, 261) - minRent(svm, 191);
  let before = lamports(svm, opG.publicKey);
  ok(sendTx(svm, new Transaction().add(refreshIx(mint, opG.publicKey)), [opG], 'G tag-9 GROW').ok,
    'G tag-9 GROW lands (realloc-up-first branch)');
  {
    const a = svm.getAccount(metaPda(mint));
    const d = decodeMetas(svm, mint);
    ok(a.data.length === 261 && d && d.count === 7 && d.entries.every((e) => !e.hasAccountData),
      'G grown list: 261 B, 7 extras, AccountKey shape');
    ok(Number(a.lamports) === minRent(svm, 261), 'G grown list exactly rent-exempt for 261 B');
    ok(lamports(svm, opG.publicKey) === before - FEE - growDelta,
      'G rent settle: payer topped up exactly the growth delta + fee', `delta=${lamports(svm, opG.publicKey) - before}`);
  }
  // SAME SIZE: refresh again on an unchanged config
  before = lamports(svm, opG.publicKey);
  ok(sendTx(svm, new Transaction().add(refreshIx(mint, opG.publicKey)), [opG], 'G tag-9 same-size').ok,
    'G tag-9 same-size refresh lands (idempotent)');
  ok(lamports(svm, opG.publicKey) === before - FEE
    && svm.getAccount(metaPda(mint)).data.length === 261,
    'G same-size settle is a wash: delta == -fee, size unchanged');
  // SHRINK BACK: config drops rule 1 -> mask 7 -> 5 extras
  ok(sendTx(svm, new Transaction().add(updCfg(rulesSmall)), [payer], 'G update config [3,9]').ok, 'G config updated back to [3,9]');
  before = lamports(svm, opG.publicKey);
  ok(sendTx(svm, new Transaction().add(refreshIx(mint, opG.publicKey)), [opG], 'G tag-9 SHRINK-BACK').ok,
    'G tag-9 SHRINK-BACK lands (update-first branch)');
  {
    const a = svm.getAccount(metaPda(mint));
    const d = decodeMetas(svm, mint);
    ok(a.data.length === 191 && d && d.count === 5, 'G shrunk-back list: 191 B, 5 extras');
    ok(Number(a.lamports) === minRent(svm, 191), 'G shrunk-back list exactly rent-exempt for 191 B');
    ok(lamports(svm, opG.publicKey) === before - FEE + growDelta,
      'G rent settle: shrink excess refunded to the payer exactly', `delta=${lamports(svm, opG.publicKey) - before}`);
  }
}

console.log(`\n==== DBC x ENGINE V3 REFRESH REHEARSAL (preserved mainnet bytes): ${pass} passed, ${fail} failed ====`);
fs.writeFileSync(new URL('./dbc-v3-refresh-rehearsal-result.json', import.meta.url),
  JSON.stringify({ passed: pass, failed: fail, ts: new Date().toISOString() }, null, 2));
process.exit(fail ? 1 : 0);

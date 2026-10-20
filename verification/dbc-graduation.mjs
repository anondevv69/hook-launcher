// DBC x ENGINE graduation — mission item 4 (LiteSVM, real binaries).
//
//   A. Launch a DBC pool whose mint carries the ENGINE (empty rule stack),
//      with engine Holder + Config state created pre-graduation.
//   B. Buy across the migration threshold: the completing swap makes DBC
//      revoke the hook (program id + authority -> None) inside that swap.
//   C. Verify: mint hook TLV zeroed; Config PDA and Holder PDA persist
//      byte-for-byte, still owned by the ENGINE; the token then transfers
//      with NO extra accounts (hook-free); the DAMM v2 migration runs over
//      the real cp-amm binary and the graduated pool holds liquidity.
//   D. TransferFee check: a Token-2022 mint carrying ONLY a TransferFee
//      extension creates a DAMM v2 pool with NO token badge (validate_mint
//      permissionless list), and the fee withholds on a live transfer.
//      Source note (dbc-program @ f552f20a): DBC creates its base mints
//      with exactly metadata_pointer (+ transfer_hook for hook pools) — a
//      DBC-launched base mint can never carry a TransferFee extension; and
//      graduation's revoke_transfer_hook touches ONLY the transfer-hook
//      TLV (process_swap.rs), so a fee extension is never stripped by it.
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction, createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction, createMintToInstruction,
  createTransferCheckedInstruction, getMintLen, ExtensionType,
} from '@solana/spl-token';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { CpAmm, CollectFeeMode as CpCollectFeeMode, MIN_SQRT_PRICE, MAX_SQRT_PRICE, encodeFeeTimeSchedulerParams, bpsToFeeNumerator } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { createHash } from 'crypto';
import fs from 'fs';
import {
  DynamicBondingCurveClient, buildCurve, SwapMode, TokenType, TokenDecimal,
  ActivationType, BaseFeeMode, CollectFeeMode, MigrationOption,
  MigrationFeeOption, TokenAuthorityOption, deriveDbcPoolAddress,
  deriveDbcPoolAuthority, deriveDbcTokenVaultAddress, deriveDammV2PoolAddress,
  DynamicBondingCurveIdl,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  BUILD_DIR, CPAMM_ID, DBC_ID, makeSvm, patchConnection, sendTx, fund, tokenBalance,
} from '../proof/svm-harness.mjs';

const engineKp = JSON.parse(fs.readFileSync(`${BUILD_DIR}/engine/engine-keypair.json`, 'utf8'));
const ENGINE = Keypair.fromSecretKey(Uint8Array.from(engineKp)).publicKey;
const INIT_METAS_DISC = Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]);
const anchorDisc = (name) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const svm = makeSvm([
  [DBC_ID, `${BUILD_DIR}/bin/dynamic_bonding_curve.so`],
  [ENGINE, `${BUILD_DIR}/engine/target/deploy/engine.so`],
  [CPAMM_ID, `${BUILD_DIR}/bin/cp_amm.so`],
]);
const conn = patchConnection(svm);
const client = new DynamicBondingCurveClient(conn, 'confirmed');

const partner = Keypair.generate();
const creator = Keypair.generate();
const buyer = Keypair.generate();
const fresh = Keypair.generate();
for (const k of [partner, creator, buyer, fresh]) fund(svm, k, 300);

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, ENGINE)[0];
const configPda = (mint) => pda([Buffer.from('config'), mint.toBuffer()]);
const holderPda = (mint, owner) => pda([Buffer.from('holder'), mint.toBuffer(), owner.toBuffer()]);
const vaultPda = (mint) => pda([Buffer.from('rentvault'), mint.toBuffer()]);
const metaPda = (mint) => pda([Buffer.from('extra-account-metas'), mint.toBuffer()]);
const acctData = (pk) => { const a = svm.getAccount(pk); return a ? Buffer.from(a.data) : null; };
const acctOwner = (pk) => { const a = svm.getAccount(pk); return a ? new PublicKey(a.owner) : null; };
const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });

function configPayload({ mode, authority, rules = [], venues = [], exemptions = [] }, tag) {
  const parts = [Buffer.from([tag, mode]), authority.toBuffer(), Buffer.from([rules.length])];
  for (const r of rules) { const e = Buffer.alloc(68); e.writeUInt16LE(r.id, 0); e[2] = 1; parts.push(e); }
  parts.push(Buffer.from([venues.length])); for (const v of venues) parts.push(v.toBuffer());
  parts.push(Buffer.from([exemptions.length])); for (const x of exemptions) parts.push(x.toBuffer());
  const tail = Buffer.alloc(43); creator.publicKey.toBuffer().copy(tail, 11); parts.push(tail);
  return Buffer.concat(parts);
}
// TLV walk: find the TransferHook extension value [authority(32), programId(32)].
// Token-2022 pads mint accounts with extensions to the 165-byte account size:
// base mint [0..82], zero padding [82..165], account-type byte at 165, TLVs
// from 166 (verified empirically against this DBC-created mint: MetadataPointer
// TLV at 166, TransferHook TLV at 234, programId at offset 270).
function transferHookExt(mintPk) {
  const d = acctData(mintPk);
  if (!d || d.length <= 166 || d[165] !== 1) return null;
  let off = 166;
  while (off + 4 <= d.length) {
    const type = d.readUInt16LE(off);
    const len = d.readUInt16LE(off + 2);
    if (type === 14) { // ExtensionType.TransferHook
      const v = d.subarray(off + 4, off + 4 + len);
      return { authority: new PublicKey(v.subarray(0, 32)), programId: new PublicKey(v.subarray(32, 64)) };
    }
    off += 4 + len;
  }
  return null;
}

// ================= A. launch (threshold 1 SOL) =================
console.log('=== A. DBC launch with ENGINE hook, threshold 1 ===');
const curve = buildCurve({
  token: { tokenType: TokenType.Token2022, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.NINE, tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAuthority, totalTokenSupply: 1_000_000_000, leftover: 0 },
  fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
  migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
  liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Slot, percentageSupplyOnMigration: 20, migrationQuoteThreshold: 1,
});
const dbcConfig = Keypair.generate();
{
  const r = sendTx(svm, await client.partner.createConfigWithTransferHook({
    config: dbcConfig.publicKey, feeClaimer: partner.publicKey, leftoverReceiver: partner.publicKey,
    payer: partner.publicKey, quoteMint: NATIVE_MINT, transferHookProgram: ENGINE, ...curve,
  }), [partner, dbcConfig], 'dbc config');
  ok(r.ok, 'A1 DBC config created');
}
const baseMint = Keypair.generate();
{
  const r = sendTx(svm, await client.creator.createPoolWithTransferHook({
    baseMint: baseMint.publicKey, config: dbcConfig.publicKey, transferHookProgram: ENGINE,
    name: 'GradProof', symbol: 'GRAD', uri: 'https://example.invalid/g.json',
    payer: creator.publicKey, poolCreator: creator.publicKey,
  }), [creator, baseMint], 'dbc pool');
  ok(r.ok, 'A2 DBC pool created with ENGINE hook');
}
const mint = baseMint.publicKey;
const pool = deriveDbcPoolAddress(NATIVE_MINT, mint, dbcConfig.publicKey);
const poolAuthority = deriveDbcPoolAuthority();
const baseVault = deriveDbcTokenVaultAddress(pool, mint);
{
  const ext = transferHookExt(mint);
  ok(ext && ext.programId.equals(ENGINE) && ext.authority.equals(poolAuthority),
    'A3 pre-graduation hook TLV: programId=ENGINE, authority=pool authority',
    ext ? `program=${ext.programId.toBase58()} authority=${ext.authority.toBase58()}` : 'NO TLV');
  const cfg = { mode: 1, authority: creator.publicKey, rules: [], venues: [DBC_ID], exemptions: [poolAuthority, baseVault] };
  const r = sendTx(svm, new Transaction().add(new TransactionInstruction({
    programId: ENGINE, data: configPayload(cfg, 1),
    keys: [K(creator.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, true), K(SystemProgram.programId, false, false)],
  })), [creator], 'engine config (no rules)');
  ok(r.ok, 'A4 engine config initialized (empty stack)');
  const r2 = sendTx(svm, new Transaction().add(new TransactionInstruction({
    programId: ENGINE, data: INIT_METAS_DISC,
    keys: [K(creator.publicKey, true, true), K(metaPda(mint), false, true), K(mint, false, false), K(SystemProgram.programId, false, false), K(configPda(mint), false, false)],
  })), [creator], 'engine metas');
  ok(r2.ok, 'A5 meta list initialized');
  sendTx(svm, new Transaction().add(SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: vaultPda(mint), lamports: 50_000_000 })), [creator], 'fund rent vault');
  // pre-graduation holder state: InitializeHolder + SetRegistered(buyer,1)
  const r3 = sendTx(svm, new Transaction().add(new TransactionInstruction({
    programId: ENGINE, data: Buffer.from([3]),
    keys: [K(creator.publicKey, true, true), K(mint, false, false), K(buyer.publicKey, false, false), K(holderPda(mint, buyer.publicKey), false, true), K(SystemProgram.programId, false, false)],
  })), [creator], 'init holder (buyer)');
  const r4 = sendTx(svm, new Transaction().add(new TransactionInstruction({
    programId: ENGINE, data: Buffer.from([4, 1]),
    keys: [K(creator.publicKey, true, false), K(mint, false, false), K(configPda(mint), false, false), K(buyer.publicKey, false, false), K(holderPda(mint, buyer.publicKey), false, true), K(SystemProgram.programId, false, false)],
  })), [creator], 'set registered (buyer)');
  ok(r3.ok && r4.ok, 'A6 buyer Holder PDA created + registered flag set pre-graduation');
  const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  sendTx(svm, new Transaction().add(createAssociatedTokenAccountInstruction(creator.publicKey, buyerAta, buyer.publicKey, mint, TOKEN_2022_PROGRAM_ID)), [creator], 'buyer ATA');
}
const configSnapshot = acctData(configPda(mint));
const holderSnapshot = acctData(holderPda(mint, buyer.publicKey));
ok(!!configSnapshot && !!holderSnapshot, 'A7 Config + Holder snapshots taken', `config ${configSnapshot?.length}B, holder ${holderSnapshot?.length}B`);

// ================= B. buys across the threshold =================
console.log('\n=== B. curve completion revokes the hook ===');
const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
async function buy(sol, label) {
  const tx = await client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: false, amountIn: new BN(Math.round(sol * 1e9)),
    minimumAmountOut: new BN(0), owner: buyer.publicKey, pool, referralTokenAccount: null, payer: buyer.publicKey,
  });
  return sendTx(svm, tx, [buyer], label);
}
{
  const r = await buy(0.6, 'buy 0.6 SOL (pre-completion)');
  ok(r.ok, 'B1 first buy succeeds with the ENGINE live');
  const ext = transferHookExt(mint);
  ok(ext && ext.programId.equals(ENGINE), 'B1 hook still live after 0.6 SOL (threshold not yet crossed)', ext ? ext.programId.toBase58() : 'none');
  // An ExactIn buy that would overshoot the completion point FAILS with
  // InsufficientLiquidity (6033) — the completing swap must be PartialFill,
  // which fills up to the threshold and completes the curve in that swap.
  const txP = await client.pool.swap2WithTransferHook({
    swapMode: SwapMode.PartialFill, swapBaseForQuote: false, amountIn: new BN(2_000_000_000),
    minimumAmountOut: new BN(0), owner: buyer.publicKey, pool, referralTokenAccount: null, payer: buyer.publicKey,
  });
  const r2 = sendTx(svm, txP, [buyer], 'buy PartialFill 2 SOL (completing)');
  ok(r2.ok, 'B2 completing buy (PartialFill) succeeds (revocation happens inside this swap)');
  const ext2 = transferHookExt(mint);
  ok(ext2 && ext2.programId.equals(PublicKey.default) && ext2.authority.equals(PublicKey.default),
    'B2 hook REVOKED by curve completion: programId=None, authority=None',
    ext2 ? `program=${ext2.programId.toBase58()} authority=${ext2.authority.toBase58()}` : 'NO TLV');
}

// ================= C. post-graduation state + hook-free trading =================
console.log('\n=== C. engine state persists; token trades hook-free ===');
{
  const c = acctData(configPda(mint));
  ok(c && c.equals(configSnapshot) && acctOwner(configPda(mint))?.equals(ENGINE),
    'C1 Config PDA persists byte-for-byte, owned by ENGINE (inert, never called again)');
  const h = acctData(holderPda(mint, buyer.publicKey));
  ok(h && h.equals(holderSnapshot) && acctOwner(holderPda(mint, buyer.publicKey))?.equals(ENGINE),
    'C2 Holder PDA persists byte-for-byte, owned by ENGINE');
  const freshAta = getAssociatedTokenAddressSync(mint, fresh.publicKey, false, TOKEN_2022_PROGRAM_ID);
  sendTx(svm, new Transaction().add(createAssociatedTokenAccountInstruction(creator.publicKey, freshAta, fresh.publicKey, mint, TOKEN_2022_PROGRAM_ID)), [creator], 'fresh ATA');
  const r = sendTx(svm, new Transaction().add(
    createTransferCheckedInstruction(buyerAta, mint, freshAta, buyer.publicKey, 123_000_000n, 6, [], TOKEN_2022_PROGRAM_ID),
  ), [buyer], 'plain TransferChecked (NO extra accounts)');
  ok(r.ok && tokenBalance(svm, freshAta) === 123_000_000n,
    'C3 graduated token transfers with zero hook accounts — hook-free at the token level');
  globalThis.__freshAta = freshAta;
}

// ================= C2. DAMM v2 migration over the real cp-amm =================
console.log('\n=== C2. migration to DAMM v2 (real cp-amm binary) ===');
{
  // operator injection (stands in for Meteora admin creating the Operator;
  // the config instruction itself runs against the real access control)
  const operatorSigner = Keypair.generate();
  fund(svm, operatorSigner, 50);
  const operatorPda = PublicKey.findProgramAddressSync([Buffer.from('operator'), operatorSigner.publicKey.toBuffer()], CPAMM_ID)[0];
  {
    const data = Buffer.alloc(72);
    anchorDisc('Operator').copy(data, 0);
    operatorSigner.publicKey.toBuffer().copy(data, 8);
    data.writeBigUInt64LE(0xffffn, 40);
    svm.setAccount(operatorPda, { lamports: 3_000_000, data: new Uint8Array(data), owner: CPAMM_ID, executable: false, rentEpoch: 0 });
  }
  const cpIdl = JSON.parse(fs.readFileSync(`${BUILD_DIR}/proof/cp_amm.idl.json`, 'utf8'));
  const cpProgram = new Program(cpIdl, new AnchorProvider(conn, new Wallet(operatorSigner), { commitment: 'confirmed' }));
  const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], CPAMM_ID)[0];
  const indexBuf = Buffer.alloc(8); indexBuf.writeBigUInt64LE(0n);
  const dammConfig = PublicKey.findProgramAddressSync([Buffer.from('config'), indexBuf], CPAMM_ID)[0];
  const feeData = encodeFeeTimeSchedulerParams(bpsToFeeNumerator(100), new BN(0), new BN(0), new BN(0), 0);
  const staticParams = {
    poolFees: { baseFee: { data: Array.from(feeData) }, compoundingFeeBps: 0, padding: 0, dynamicFee: null },
    sqrtMinPrice: new BN(MIN_SQRT_PRICE.toString()), sqrtMaxPrice: new BN(MAX_SQRT_PRICE.toString()),
    vaultConfigKey: PublicKey.default, poolCreatorAuthority: poolAuthority,
    activationType: 1, collectFeeMode: 0, permission: new BN(0),
  };
  try {
    const ix = await cpProgram.methods.createConfig(new BN(0), staticParams).accountsPartial({
      config: dammConfig, operator: operatorPda, signer: operatorSigner.publicKey,
      payer: operatorSigner.publicKey, systemProgram: SystemProgram.programId,
      eventAuthority, program: CPAMM_ID,
    }).instruction();
    const r = sendTx(svm, new Transaction().add(ix), [operatorSigner], 'cp-amm create_config(0)');
    ok(r.ok, 'C2a DAMM v2 static config created via real operator-gated instruction', dammConfig.toBase58());
  } catch (e) { ok(false, 'C2a DAMM v2 static config created', String(e).slice(0, 200)); }

  // flash_rent (dbc-program instructions/migration/flash_rent.rs): the pool
  // authority PDA must ALREADY hold ~1 SOL — it lends lamports to the cp-amm
  // CPI (position rents) and the top-level payer reimburses it afterwards.
  // On mainnet the global pool-authority PDA carries a balance; replicate
  // that standing state here.
  sendTx(svm, new Transaction().add(SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: poolAuthority, lamports: 2_000_000_000 })), [creator], 'fund pool authority (flash-rent float)');
  // No metadata pre-step: in this DBC program version the migration_metadata
  // account is deprecated and unread by migration_damm_v2, and
  // migration_damm_v2_create_metadata is a no-op (source: dbc-program
  // instructions/migration/dynamic_amm_v2/*). The SDK fills the slot itself.
  let migrated = false;
  try {
    const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } =
      await client.migration.migrateToDammV2({ pool, dammConfig, payer: partner.publicKey });
    const r = sendTx(svm, transaction, [partner, firstPositionNftKeypair, secondPositionNftKeypair], 'migration_damm_v2');
    migrated = r.ok;
    ok(r.ok, 'C2b migration_damm_v2 executed over the real cp-amm binary');
    if (!r.ok) console.log('   migration logs tail:', (r.logs || []).slice(-6).join('\n   '));
  } catch (e) { ok(false, 'C2b migration_damm_v2 executed', String(e).slice(0, 240)); }
  if (migrated) {
    const dammPool = deriveDammV2PoolAddress(dammConfig, mint, NATIVE_MINT);
    ok(svm.getAccount(dammPool) != null, 'C2c DAMM v2 pool exists for the graduated mint', dammPool.toBase58());
    try {
      const cpAmm = new CpAmm(conn);
      const st = await cpAmm.fetchPoolState(dammPool);
      const va = tokenBalance(svm, st.tokenAVault);
      const vb = tokenBalance(svm, st.tokenBVault);
      ok(va > 0n && vb > 0n, 'C2d migrated pool vaults hold liquidity on both sides', `base=${va} quote=${vb}`);
      // swap attempt on the migrated pool (SDK 1.5.1 vs test binary skew is
      // documented in METEORA-PROOF E4 — record the outcome verbatim)
      const swapper = Keypair.generate(); fund(svm, swapper, 50);
      const inAta = getAssociatedTokenAddressSync(NATIVE_MINT, swapper.publicKey, false, TOKEN_PROGRAM_ID);
      const outAta = getAssociatedTokenAddressSync(mint, swapper.publicKey, false, TOKEN_2022_PROGRAM_ID);
      sendTx(svm, new Transaction().add(
        createAssociatedTokenAccountInstruction(swapper.publicKey, inAta, swapper.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(swapper.publicKey, outAta, swapper.publicKey, mint, TOKEN_2022_PROGRAM_ID),
      ), [swapper], 'swapper ATAs');
      const wrapTx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: swapper.publicKey, toPubkey: inAta, lamports: 10_000_000 }),
        new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]), keys: [K(inAta, false, true)] }), // SyncNative
      );
      sendTx(svm, wrapTx, [swapper], 'wrap SOL');
      try {
        const swapTx = await cpAmm.swap2({
          payer: swapper.publicKey, pool: dammPool, inputTokenMint: NATIVE_MINT, outputTokenMint: mint,
          tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault,
          tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
          referralTokenAccount: null, poolState: st, swapMode: 0, amountIn: new BN(1_000_000), minimumAmountOut: new BN(0),
        });
        const rs = sendTx(svm, swapTx, [swapper], 'cp-amm swap2 on migrated pool');
        ok(rs.ok && tokenBalance(svm, outAta) > 0n, 'C2e swap on the migrated DAMM v2 pool succeeds — token trades hook-free on DAMM v2',
          rs.ok ? `out=${tokenBalance(svm, outAta)}` : `err=${JSON.stringify(rs.err)} (see METEORA-PROOF E4 skew note)`);
      } catch (e) {
        ok(false, 'C2e swap on the migrated DAMM v2 pool (SDK build step)', String(e).slice(0, 200));
      }
    } catch (e) { ok(false, 'C2c/d migrated pool state read', String(e).slice(0, 200)); }
  }
}

// ================= D. TransferFee mint on DAMM v2 (no badge) =================
console.log('\n=== D. TransferFee extension vs DAMM v2 validate_mint ===');
{
  const feeMint = Keypair.generate();
  const len = getMintLen([ExtensionType.TransferFeeConfig]);
  const rent = svm.minimumBalanceForRentExemption(BigInt(len));
  const r = sendTx(svm, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: creator.publicKey, newAccountPubkey: feeMint.publicKey, space: len, lamports: Number(rent), programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferFeeConfigInstruction(feeMint.publicKey, creator.publicKey, creator.publicKey, 100, 1_000_000_000_000n, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(feeMint.publicKey, 6, creator.publicKey, null, TOKEN_2022_PROGRAM_ID),
  ), [creator, feeMint], 'create TransferFee mint (100 bps)');
  ok(r.ok, 'D1 TransferFee mint created (100 bps, max 1e12)');
  const creatorFeeAta = getAssociatedTokenAddressSync(feeMint.publicKey, creator.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const userFeeAta = getAssociatedTokenAddressSync(feeMint.publicKey, fresh.publicKey, false, TOKEN_2022_PROGRAM_ID);
  sendTx(svm, new Transaction().add(
    createAssociatedTokenAccountInstruction(creator.publicKey, creatorFeeAta, creator.publicKey, feeMint.publicKey, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(creator.publicKey, userFeeAta, fresh.publicKey, feeMint.publicKey, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(feeMint.publicKey, creatorFeeAta, creator.publicKey, 10_000_000n, [], TOKEN_2022_PROGRAM_ID),
  ), [creator], 'fund fee mint');
  const rt = sendTx(svm, new Transaction().add(
    createTransferCheckedInstruction(creatorFeeAta, feeMint.publicKey, userFeeAta, creator.publicKey, 10_000n, 6, [], TOKEN_2022_PROGRAM_ID),
  ), [creator], 'fee-mint transfer 10000');
  ok(rt.ok && tokenBalance(svm, userFeeAta) === 9_900n, 'D2 transfer withholds 1% (10000 -> 9900) — fee accrual live', `dest=${tokenBalance(svm, userFeeAta)}`);
  // DAMM v2 pool for the fee mint, NO badge (mirror of cpamm-proof E4 shape)
  try {
    const cpAmm = new CpAmm(conn);
    const Q64 = new BN(2).pow(new BN(64));
    const feeData = encodeFeeTimeSchedulerParams(bpsToFeeNumerator(100), new BN(0), new BN(0), new BN(0), 0);
    const positionNft = Keypair.generate();
    const { tx, pool: feePool } = await cpAmm.createCustomPool({
      payer: creator.publicKey, creator: creator.publicKey, positionNft: positionNft.publicKey,
      tokenAMint: feeMint.publicKey, tokenBMint: NATIVE_MINT,
      tokenAAmount: new BN(1_000_000), tokenBAmount: new BN(1_000_000),
      sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE,
      liquidityDelta: new BN(1_000_000), initSqrtPrice: Q64,
      poolFees: { baseFee: { data: Array.from(feeData) }, compoundingFeeBps: 0, padding: 0, dynamicFee: null },
      hasAlphaVault: false, activationType: 0, collectFeeMode: CpCollectFeeMode.BothToken,
      activationPoint: null, tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
    });
    const rp = sendTx(svm, tx, [creator, positionNft], 'cp-amm pool for TransferFee mint (no badge)');
    ok(rp.ok, 'D3 DAMM v2 pool created for a TransferFee-carrying mint with NO token badge — validate_mint permissionless list CONFIRMED', feePool.toBase58());
    if (!rp.ok) console.log('   logs tail:', (rp.logs || []).slice(-5).join('\n   '));
  } catch (e) { ok(false, 'D3 DAMM v2 pool for TransferFee mint', String(e).slice(0, 240)); }
}

console.log(`\n==== DBC GRADUATION: ${pass} passed, ${fail} failed ====`);
fs.writeFileSync(`${BUILD_DIR}/integration/dbc-graduation-result.json`,
  JSON.stringify({ engine: ENGINE.toBase58(), mint: mint.toBase58(), pool: pool.toBase58(), pass, fail }, null, 2));
if (fail > 0) process.exit(1);

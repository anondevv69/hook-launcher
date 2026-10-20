// ============================================================================
// HOUSES SWAP — PHASE C LIFECYCLE TRIAL (LiteSVM, real binaries).
//
// Full house-venue lifecycle against the REAL programs: the Phase C engine
// trial binary (engine/target/engine-trial.so, loaded AT the mainnet engine
// id per the contract), this directory's houseswap.so, and the real Meteora
// DBC binary (../bin/dynamic_bonding_curve.so). Three launch-shaped mints:
//
//   A (fee path, rules [1 LATCH]): real DBC pool, real curve buys cross the
//      house threshold; curve fees claimed via the SDK and deposited with
//      engine DepositHouseFees (tag 16); ActivateHouse (tag 14) refuses an
//      uncommitted pool (34), then the keeper bundle ActivateHouse +
//      ActivatePool lands; tag 15 (CrankPriceDeep) flips the feed pin to
//      the house when a donation makes it deeper, and back after a large
//      curve buy; house buy/sell enforce the Basis Latch (Locked veto above
//      basis, dip sell passes + latches); ClaimFees pays the counters out.
//   B (reserve path, rules [1 GRADUATED, 2 escrow split 50%]): reserve is
//      recorded with tag 17 (unfunded attempt refuses 33); ActivateHouse
//      refuses before the threshold (33) on a committed pool; split buy
//      escrows exactly split_bps of the total input; an above-entry sell
//      (executable under GRADUATED's earned cap) forfeits the resolved
//      share to depth to the lamport; a dip sell refunds 96/2/2 to the
//      lamport. GRADUATED is used because in LATCH mode an above-entry
//      sell is vetoed by rule 1 itself, so the forfeit path could never
//      execute — the venue resolution is identical either way.
//   C (rule 9 only): house buys enforce the Max Wallet cap (pass under,
//      veto over). The config uses the LAUNCHER-DERIVED exemption set
//      (launch.mjs L3 derivation, forks 1+3 resolved): the base triple
//      [poolAuthority, baseVault, seedAta] from launchMint plus
//      [houseTokenVault, houseQuoteVault, feeDestTokenAta] — exactly the
//      stock launcher's house set, no hand-built extras. The seed can
//      therefore exceed the cap into the (exempt) house token vault,
//      while a non-vault wallet receive over the cap still vetoes, and
//      ActivateHouse's vault append must be idempotent over the
//      pre-exempted vaults (asserted after activation).
//
// Failure modes covered: ActivateHouse before threshold (33), uncommitted
// pool (34), double ActivateHouse (AlreadyInit 14), double ActivatePool
// (houseswap AlreadyLive 6), house swap before activation (engine
// BadCaller 3), RemoveLiquidity after CommitPool (houseswap Unauthorized 4).
//
// The DBC curve uses the proven 42 SOL buildCurve shape (the house rides
// never-physics via the ENGINE threshold, 0.05 SOL; total curve volume in
// this trial stays far below 42 SOL so the curve never completes).
//
// Run: node houseswap/trial-houseswap.mjs   (from the build root)
// ============================================================================
import { LiteSVM, FailedTransactionMetadata, Clock } from "litesvm";
import {
  PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BN from "bn.js";
import {
  DynamicBondingCurveClient, buildCurve, SwapMode, TokenType, TokenDecimal,
  ActivationType, BaseFeeMode, CollectFeeMode, MigrationOption,
  MigrationFeeOption, TokenAuthorityOption, deriveDbcPoolAddress,
  deriveDbcPoolAuthority, deriveDbcTokenVaultAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { BUILD_DIR, DBC_ID, makeSvm, patchConnection, fund } from "../proof/svm-harness.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_SO = path.join(DIR, "../engine/target/engine-trial.so");
const HOUSES_SO = path.join(DIR, "target/deploy/houseswap.so");
const DBC_SO = path.join(DIR, "../bin/dynamic_bonding_curve.so");
for (const p of [ENGINE_SO, HOUSES_SO, DBC_SO]) {
  if (!existsSync(p)) { console.error("MISSING BINARY:", p); process.exit(1); }
}
const engineSha = createHash("sha256").update(readFileSync(ENGINE_SO)).digest("hex");
console.log("engine trial binary sha256:", engineSha);
if (engineSha.startsWith("8a7a5afb")) {
  console.log("NOTE: this is the PHASE B engine binary — Phase C sections (tags 14-17, rule 2) cannot pass; assertions needing them are the pending set.");
}
const housesSha = createHash("sha256").update(readFileSync(HOUSES_SO)).digest("hex");
console.log("houseswap binary sha256:  ", housesSha, `(${readFileSync(HOUSES_SO).length} bytes)`);

const ENGINE = new PublicKey("EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT");
const HOUSES = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.join(DIR, "houseswap-keypair.json"), "utf8")))).publicKey;
console.log("houseswap program id:     ", HOUSES.toBase58());
const T22 = TOKEN_2022_PROGRAM_ID, TOKEN = TOKEN_PROGRAM_ID;
const SYSVAR_IX = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const SYSTEM = SystemProgram.programId;
const INIT_METAS_DISC = Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]);
const DEC = 6, QDEC = 9;

let total = 0, failed = 0; const failures = [];
function check(label, cond, extra = "") {
  total++;
  if (cond) console.log(`   ok ${String(total).padStart(3)} ${label}`);
  else { failed++; failures.push(label); console.log(`   FAIL ${label} ${extra}`); }
}
function section(t) { console.log("\n=== " + t + " ==="); }
function customOf(res) {
  if (res.ok) return null;
  const s = JSON.stringify(res.err ?? "");
  const m = s.match(/"Custom":\s*(\d+)/);
  if (m) return Number(m[1]);
  for (const l of res.logs ?? []) { const mm = String(l).match(/custom program error: (0x[0-9a-f]+)/); if (mm) return parseInt(mm[1], 16); }
  return -1;
}

// ---------- SVM + actors ----------
const svm = makeSvm([
  [DBC_ID, DBC_SO],
  [ENGINE, ENGINE_SO],
  [HOUSES, HOUSES_SO],
]);
const conn = patchConnection(svm);
const client = new DynamicBondingCurveClient(conn, "confirmed");
let clockSlot = BigInt(svm.getClock().slot);
const setTime = (ts) => { clockSlot += 17n; svm.setClock(new Clock(clockSlot, 0n, 0n, 0n, BigInt(ts))); };
const T0 = 1_760_000_000;
setTime(T0);
const nowTs = () => Number(svm.getClock().unixTimestamp);

const sponsor = Keypair.generate();           // fee payer for exact lamport accounting
const creator = Keypair.generate();           // launcher: config authority + pool authority
for (const k of [sponsor, creator]) fund(svm, k, 300);

const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });
function send(tx, signers, label) {
  tx.feePayer = sponsor.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  // Sign only with keypairs the compiled message actually requires
  // (permissionless instructions like cranks list no signer at all).
  const msg = tx.compileMessage();
  const required = new Set(msg.accountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58()));
  const seen = new Set();
  const toSign = [sponsor, ...signers].filter((kp) => {
    const b = kp.publicKey.toBase58();
    if (seen.has(b) || !required.has(b)) return false;
    seen.add(b);
    return true;
  });
  tx.sign(...toSign);
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) {
    let logs = [];
    try { const m = res.meta(); logs = typeof m.logs === "function" ? m.logs() : (m.logs || []); } catch { /* ignore */ }
    const out = { ok: false, label, err: res.err(), logs };
    console.log(`  [${label}] FAILED err=${JSON.stringify(res.err())}`);
    for (const l of logs.slice(-12)) console.log("      | " + l);
    return out;
  }
  return { ok: true, label, logs: res.logs() };
}
const sendIx = (ix, signers, label) =>
  send(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix), signers, label);

// ---------- account readers ----------
const acct = (pk) => svm.getAccount(pk);
const acctData = (pk) => { const a = acct(pk); return a ? Buffer.from(a.data) : null; };
const lamports = (pk) => { const a = acct(pk); return a ? BigInt(a.lamports) : 0n; };
const tokAmt = (pk) => { const d = acctData(pk); return d ? d.readBigUInt64LE(64) : 0n; };
const readU128 = (buf, off) => buf.readBigUInt64LE(off) + (buf.readBigUInt64LE(off + 8) << 64n);

// ---------- PDAs ----------
const epda = (seeds) => PublicKey.findProgramAddressSync(seeds, ENGINE)[0];
const cfgPda = (mint) => epda([Buffer.from("config"), mint.toBuffer()]);
const holderPda = (mint, acctPk) => epda([Buffer.from("holder"), mint.toBuffer(), acctPk.toBuffer()]);
const metaPda = (mint) => epda([Buffer.from("extra-account-metas"), mint.toBuffer()]);
const rentVaultPda = (mint) => epda([Buffer.from("rentvault"), mint.toBuffer()]);
const feedPda = (mint) => epda([Buffer.from("price"), mint.toBuffer()]);
const houseVaultPda = (mint) => epda([Buffer.from("housevault"), mint.toBuffer()]);
const hpda = (seeds) => PublicKey.findProgramAddressSync(seeds, HOUSES)[0];
const housePoolPda = (mint) => hpda([Buffer.from("pool"), mint.toBuffer()]);
const poolauthPda = (mint) => hpda([Buffer.from("poolauth"), mint.toBuffer()]);
const escrowPda = (mint, userToken) => hpda([Buffer.from("escrow"), mint.toBuffer(), userToken.toBuffer()]);

// ---------- engine payloads ----------
function ruleEntry(id, enabled, params) {
  const e = Buffer.alloc(68);
  e.writeUInt16LE(id, 0);
  e[2] = enabled ? 1 : 0;
  Buffer.from(params).copy(e, 4);
  return e;
}
function latchParams(mode, baseFrac = 0) {
  const p = Buffer.alloc(64);
  p.writeBigUInt64LE(300n, 0);       // max_stale_secs
  p.writeBigUInt64LE(0n, 8);         // ema half-life 0 (fold takes spot)
  p.writeUInt16LE(0, 16);            // max_crank_bps 0 -> default 10000
  p[18] = mode;                      // 0 LATCH, 2 GRADUATED
  p.writeUInt16LE(baseFrac, 19);     // GRADUATED base_frac_bps
  return p;
}
const splitParams = (bps) => { const p = Buffer.alloc(64); p.writeUInt16LE(bps, 0); return p; };
const capParams = (bps) => { const p = Buffer.alloc(64); p.writeUInt16LE(bps, 0); return p; };
function configPayload(tag, { authority, mode, rules, venues, exemptions, house }) {
  const parts = [Buffer.from([tag, mode]), authority.toBuffer(), Buffer.from([rules.length]), ...rules];
  parts.push(Buffer.from([venues.length]), ...venues.map((v) => v.toBuffer()));
  parts.push(Buffer.from([exemptions.length]), ...exemptions.map((e) => e.toBuffer()));
  const tail = Buffer.alloc(2 + 8 + 1 + 32);
  authority.toBuffer().copy(tail, 11); // fee_vault (unused by these stacks)
  parts.push(tail);
  if (house) {
    const hb = Buffer.alloc(1 + 32 + 8 + 8);
    hb[0] = 1;
    house.program.toBuffer().copy(hb, 1);
    hb.writeBigUInt64LE(BigInt(house.threshold), 33);
    hb.writeBigUInt64LE(BigInt(house.reserve), 41);
    parts.push(hb);
  }
  return Buffer.concat(parts);
}
const initConfigIx = (mint, cfg) => {
  const keys = [K(creator.publicKey, true, true), K(mint, false, false), K(cfgPda(mint), false, true), K(SYSTEM, false, false)];
  if (cfg.house) keys.push(K(houseVaultPda(mint), false, true));
  return new TransactionInstruction({ programId: ENGINE, data: configPayload(1, cfg), keys });
};
const initMetasIx = (mint) => new TransactionInstruction({
  programId: ENGINE, data: INIT_METAS_DISC,
  keys: [K(creator.publicKey, true, true), K(metaPda(mint), false, true), K(mint, false, false), K(SYSTEM, false, false), K(cfgPda(mint), false, false)],
});
const initFeedIx = (mint, pool, tv, qv) => new TransactionInstruction({
  programId: ENGINE,
  data: Buffer.concat([Buffer.from([6]), pool.toBuffer(), tv.toBuffer(), qv.toBuffer(), Buffer.from([DEC, QDEC])]),
  keys: [K(creator.publicKey, true, true), K(mint, false, false), K(cfgPda(mint), false, false), K(feedPda(mint), false, true), K(SYSTEM, false, false)],
});
const crankDbcIx = (mint, pool) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([8]),
  keys: [K(cfgPda(mint), false, false), K(feedPda(mint), false, true), K(pool, false, false)],
});
const crankDeepIx = (ctx) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([15]),
  keys: [K(cfgPda(ctx.mint), false, false), K(feedPda(ctx.mint), false, true), K(ctx.pool, false, false),
    K(ctx.housePool, false, false), K(ctx.houseTokenVault, false, false), K(ctx.houseQuoteVault, false, false)],
});
const depositFeesIx = (mint, payer, amount) => {
  const d = Buffer.alloc(9); d[0] = 16; d.writeBigUInt64LE(BigInt(amount), 1);
  return new TransactionInstruction({
    programId: ENGINE, data: d,
    keys: [K(payer.publicKey, true, true), K(mint, false, false), K(cfgPda(mint), false, false), K(houseVaultPda(mint), false, true), K(SYSTEM, false, false)],
  });
};
const recordReserveIx = (mint) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([17]),
  keys: [K(creator.publicKey, true, false), K(mint, false, false), K(cfgPda(mint), false, false), K(houseVaultPda(mint), false, true)],
});
const activateHouseIx = (ctx, caller) => new TransactionInstruction({
  programId: ENGINE, data: Buffer.from([14]),
  // NOTE: caller and house_quote_vault must be WRITABLE in the message —
  // the engine pays the caller cut and credits the quote vault with
  // lamports, and the runtime rejects balance changes on read-only
  // accounts (the contract's "(ro)" labels describe the engine's own
  // reads, not the message flags this instruction requires).
  keys: [K(caller.publicKey, true, true), K(ctx.mint, false, false), K(cfgPda(ctx.mint), false, true),
    K(ctx.pool, false, false), K(houseVaultPda(ctx.mint), false, true), K(ctx.housePool, false, false),
    K(ctx.houseTokenVault, false, false), K(ctx.houseQuoteVault, false, true), K(SYSTEM, false, false), K(TOKEN, false, false)],
});

// ---------- hook tail builder (meta-list order, SPL resolver layout) ----------
// Canonical extras for the stacks in this trial: latch stacks publish
// [config, srcHolder, dstHolder, rentVault, price, system, sysvar];
// a rule-9-only stack publishes [config, sysvar]. Rule 2 adds nothing.
function tailKeys(ctx, srcAcct, dstAcct) {
  const extras = ctx.latch
    ? [K(cfgPda(ctx.mint), false, false), K(holderPda(ctx.mint, srcAcct), false, true),
       K(holderPda(ctx.mint, dstAcct), false, true), K(rentVaultPda(ctx.mint), false, true),
       K(feedPda(ctx.mint), false, false), K(SYSTEM, false, false), K(SYSVAR_IX, false, false)]
    : [K(cfgPda(ctx.mint), false, false), K(SYSVAR_IX, false, false)];
  return [...extras, K(ENGINE, false, false), K(metaPda(ctx.mint), false, false)];
}
function transferCheckedIx(ctx, src, dst, authority, amount) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(BigInt(amount), 1);
  data[9] = DEC;
  return new TransactionInstruction({
    programId: T22, data,
    keys: [K(src, false, true), K(ctx.mint, false, false), K(dst, false, true), K(authority, true, false), ...tailKeys(ctx, src, dst)],
  });
}

// ---------- houseswap ix builders ----------
const hsIx = (keys, data) => new TransactionInstruction({ programId: HOUSES, keys, data });
const initPoolIx = (ctx) => hsIx(
  [K(creator.publicKey, true, true), K(ctx.mint, false, false), K(NATIVE_MINT, false, false),
   K(ctx.houseTokenVault, false, false), K(ctx.houseQuoteVault, false, false), K(ctx.housePool, false, true), K(SYSTEM, false, false)],
  Buffer.from([0]));
const commitPoolIx = (ctx) => hsIx(
  [K(ctx.housePool, false, true), K(ctx.mint, false, false), K(creator.publicKey, true, false)],
  Buffer.from([4]));
const activatePoolIx = (ctx, feeBps) => {
  const d = Buffer.alloc(3); d[0] = 5; d.writeUInt16LE(feeBps, 1);
  return hsIx(
    [K(ctx.housePool, false, true), K(ctx.mint, false, false), K(cfgPda(ctx.mint), false, false),
     K(ctx.pool, false, false), K(ctx.dbcConfig, false, false)], d);
};
function houseSwapIx(ctx, { user, userToken, userQuote, dir, amountIn, venueExtras = [] }) {
  const data = Buffer.alloc(18);
  data[0] = 1; data[1] = dir;
  data.writeBigUInt64LE(BigInt(amountIn), 2);
  data.writeBigUInt64LE(0n, 10);
  const srcAcct = dir === 0 ? ctx.houseTokenVault : userToken;
  const dstAcct = dir === 0 ? userToken : ctx.houseTokenVault;
  return hsIx(
    [K(ctx.housePool, false, true), K(ctx.mint, false, false), K(NATIVE_MINT, false, false),
     K(ctx.houseTokenVault, false, true), K(ctx.houseQuoteVault, false, true),
     K(userToken, false, true), K(userQuote, false, true), K(user.publicKey, true, true),
     K(T22, false, false), K(TOKEN, false, false),
     ...tailKeys(ctx, srcAcct, dstAcct), ...venueExtras], data);
}
function liquidityIx(ctx, { authToken, authQuote, amtToken, amtQuote, add }) {
  const data = Buffer.alloc(17);
  data[0] = add ? 2 : 3;
  data.writeBigUInt64LE(BigInt(amtToken), 1);
  data.writeBigUInt64LE(BigInt(amtQuote), 9);
  const tail = amtToken > 0
    ? tailKeys(ctx, add ? authToken : ctx.houseTokenVault, add ? ctx.houseTokenVault : authToken)
    : [];
  return hsIx(
    [K(ctx.housePool, false, false), K(ctx.mint, false, false), K(NATIVE_MINT, false, false),
     K(ctx.houseTokenVault, false, true), K(ctx.houseQuoteVault, false, true),
     K(authToken, false, true), K(authQuote, false, true), K(creator.publicKey, true, false),
     K(T22, false, false), K(TOKEN, false, false), ...tail], data);
}
function claimFeesIx(ctx, feeDestToken, feeDestQuote) {
  return hsIx(
    [K(ctx.housePool, false, true), K(ctx.mint, false, false), K(NATIVE_MINT, false, false),
     K(ctx.houseTokenVault, false, true), K(ctx.houseQuoteVault, false, true),
     K(feeDestToken, false, true), K(feeDestQuote, false, true),
     K(T22, false, false), K(TOKEN, false, false),
     ...tailKeys(ctx, ctx.houseTokenVault, feeDestToken)], Buffer.from([6]));
}

// ---------- token helpers ----------
function createAtaIx(payer, ata, owner, mint, prog) {
  return createAssociatedTokenAccountInstruction(payer, ata, owner, mint, prog);
}
const ataOf = (mint, owner, prog = T22) => getAssociatedTokenAddressSync(mint, owner, true, prog);
const wsolAtaOf = (owner) => getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN);
const syncNativeIx = (ata) => new TransactionInstruction({
  programId: TOKEN, keys: [K(ata, false, true)], data: Buffer.from([17]),
});
function fundWsol(owner, lamports, label) {
  const ata = wsolAtaOf(owner.publicKey);
  const ixs = [];
  if (!acct(ata)) ixs.push(createAtaIx(creator.publicKey, ata, owner.publicKey, NATIVE_MINT, TOKEN));
  ixs.push(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: ata, lamports }));
  ixs.push(syncNativeIx(ata));
  const r = send(new Transaction().add(...ixs), [creator, owner], label);
  if (!r.ok) throw new Error(label + " failed");
  return ata;
}

// ---------- price / math replicas ----------
const SCALE = 1_000_000_000_000n;
function dbcSpot(ctx) {
  const d = acctData(ctx.pool);
  const s = readU128(d, 280);
  const a = s >> 64n, f = s & ((1n << 64n) - 1n);
  const term1 = a * a * SCALE;
  const t = 2n * a * f;
  const term2 = (t >> 64n) * SCALE + (((t & ((1n << 64n) - 1n)) * SCALE) >> 64n);
  const term3 = ((f * f >> 64n) * SCALE) >> 64n;
  return (term1 + term2 + term3) / 1000n; // token_dec 6 < quote_dec 9
}
const vaultSpot = (tok, quote) => (BigInt(quote) * SCALE) / (BigInt(tok) * 1000n);
const cpOut = (rIn, rOut, eff) => (BigInt(rOut) * BigInt(eff)) / (BigInt(rIn) + BigInt(eff));
const feedEma = (mint) => readU128(acctData(feedPda(mint)), 97);
const feedPool = (mint) => new PublicKey(acctData(feedPda(mint)).subarray(1, 33));
const holderBasis = (mint, acctPk) => { const h = acctData(holderPda(mint, acctPk)); return h ? readU128(h, 6) / readU128(h, 22) : null; };
const holderLatched = (mint, acctPk) => { const h = acctData(holderPda(mint, acctPk)); return h ? h[38] : null; };
const poolBytes = (ctx) => acctData(ctx.housePool);
const poolU64 = (ctx, off) => poolBytes(ctx).readBigUInt64LE(off);
const houseSlot = (mint) => {
  const d = acctData(cfgPda(mint));
  return { len: d.length, state: d[1144], program: new PublicKey(d.subarray(1088, 1120)) };
};
const hvCounters = (mint) => {
  const d = acctData(houseVaultPda(mint));
  return { reserve: d.readBigUInt64LE(1), fee: d.readBigUInt64LE(9), cut: d.readBigUInt64LE(17), seeded: d.readBigUInt64LE(25) };
};
const quoteReserve = (ctx) => acctData(ctx.pool).readBigUInt64LE(240);

// ---------- DBC launch (curveConfig copied from integration/dbc-latch.mjs) ----------
function curveConfig(threshold) {
  return buildCurve({
    token: { tokenType: TokenType.Token2022, tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE, tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAuthority,
      totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
      totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Slot, percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: threshold,
  });
}
async function launchMint({ name, feeClaimer, rules, latch, extraExemptions, house }) {
  const dbcConfig = Keypair.generate();
  {
    const tx = await client.partner.createConfigWithTransferHook({
      config: dbcConfig.publicKey, feeClaimer: feeClaimer.publicKey,
      leftoverReceiver: feeClaimer.publicKey, payer: creator.publicKey,
      quoteMint: NATIVE_MINT, transferHookProgram: ENGINE, ...curveConfig(42),
    });
    const r = send(tx, [creator, dbcConfig], `${name} DBC config`);
    if (!r.ok) throw new Error(`${name} DBC config failed`);
  }
  const baseMint = Keypair.generate();
  const pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, dbcConfig.publicKey);
  const poolAuthority = deriveDbcPoolAuthority();
  const baseVault = deriveDbcTokenVaultAddress(pool, baseMint.publicKey);
  const quoteVaultDbc = deriveDbcTokenVaultAddress(pool, NATIVE_MINT);
  {
    const tx = await client.creator.createPoolWithTransferHook({
      baseMint: baseMint.publicKey, config: dbcConfig.publicKey, transferHookProgram: ENGINE,
      name, symbol: name.slice(0, 4).toUpperCase(), uri: `https://example.invalid/${name}.json`,
      payer: creator.publicKey, poolCreator: creator.publicKey,
    });
    const r = send(tx, [creator, baseMint], `${name} DBC pool`);
    if (!r.ok) throw new Error(`${name} DBC pool failed`);
  }
  const mint = baseMint.publicKey;
  const ctx = {
    name, mint, pool, poolAuthority, baseVault, dbcConfig: dbcConfig.publicKey, latch,
    housePool: housePoolPda(mint),
    houseTokenVault: ataOf(mint, housePoolPda(mint), T22),
    houseQuoteVault: ataOf(NATIVE_MINT, housePoolPda(mint), TOKEN),
  };
  const seedWallet = Keypair.generate();
  fund(svm, seedWallet, 100);
  ctx.seedWallet = seedWallet;
  ctx.seedAta = ataOf(mint, seedWallet.publicKey, T22);
  const exemptions = [poolAuthority, baseVault, ctx.seedAta, ...extraExemptions(ctx)];
  const cfg = { authority: creator.publicKey, mode: 1, rules, venues: [DBC_ID], exemptions, house };
  let r = sendIx(initConfigIx(mint, cfg), [creator], `${name} engine config (house-committed)`);
  if (!r.ok) throw new Error(`${name} engine config failed`);
  r = sendIx(initMetasIx(mint), [creator], `${name} metas`);
  if (!r.ok) throw new Error(`${name} metas failed`);
  r = sendIx(initFeedIx(mint, pool, baseVault, quoteVaultDbc), [creator], `${name} price feed`);
  if (!r.ok) throw new Error(`${name} feed failed`);
  r = send(new Transaction().add(SystemProgram.transfer({
    fromPubkey: creator.publicKey, toPubkey: rentVaultPda(mint), lamports: 100_000_000,
  })), [creator], `${name} rent vault fund`);
  if (!r.ok) throw new Error(`${name} rent vault failed`);
  // house pool vaults (token vault = pool PDA's canonical T22 ATA; quote =
  // pool PDA's wSOL ATA on the legacy program) + InitPool
  r = send(new Transaction().add(
    createAtaIx(creator.publicKey, ctx.houseTokenVault, ctx.housePool, mint, T22),
    createAtaIx(creator.publicKey, ctx.houseQuoteVault, ctx.housePool, NATIVE_MINT, TOKEN),
  ), [creator], `${name} house vaults`);
  if (!r.ok) throw new Error(`${name} house vaults failed`);
  r = sendIx(initPoolIx(ctx), [creator], `${name} houseswap InitPool`);
  if (!r.ok) throw new Error(`${name} InitPool failed`);
  // user ATAs pre-created by sections as needed
  r = send(new Transaction().add(createAtaIx(creator.publicKey, ctx.seedAta, seedWallet.publicKey, mint, T22)), [creator], `${name} seed ATA`);
  if (!r.ok) throw new Error(`${name} seed ATA failed`);
  return ctx;
}
async function curveSwap(ctx, owner, baseForQuote, amount, label) {
  const tx = await client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: baseForQuote,
    amountIn: new BN(amount.toString()), minimumAmountOut: new BN(0),
    owner: owner.publicKey, pool: ctx.pool, referralTokenAccount: null, payer: owner.publicKey,
  });
  return send(tx, [owner], label);
}
function makeWallet(sol = 100) {
  const kp = Keypair.generate();
  fund(svm, kp, sol);
  return kp;
}
async function seedHousePool(ctx, curveBuyLamports, label) {
  // seed wallet buys on the curve into its (exempt) ATA, then H4-transfers
  // the whole balance into the house token vault.
  const r = await curveSwap(ctx, ctx.seedWallet, false, curveBuyLamports, `${label} seed curve buy`);
  if (!r.ok) throw new Error(`${label} seed buy failed`);
  const bal = tokAmt(ctx.seedAta);
  const r2 = sendIx(transferCheckedIx(ctx, ctx.seedAta, ctx.houseTokenVault, ctx.seedWallet.publicKey, bal), [ctx.seedWallet], `${label} H4 seed transfer`);
  if (!r2.ok) throw new Error(`${label} H4 failed`);
  return bal;
}

// ============================================================================
section("MINT A — launch-shaped house token (fee path, rule 1 LATCH)");
const feeDestA = makeWallet(50);
const mmA = makeWallet(200);
const buyerA = makeWallet(100);
const keeperA = makeWallet(20);
const ctxA = await launchMint({
  name: "HouseA", feeClaimer: feeDestA, latch: true,
  rules: [ruleEntry(1, true, latchParams(0))],
  extraExemptions: () => [mmA.publicKey],
  house: { program: HOUSES, threshold: 50_000_000n, reserve: 0n },
});
check("A0 config is 1152-byte V2 with house_state 1 (pending)",
  houseSlot(ctxA.mint).len === 1152 && houseSlot(ctxA.mint).state === 1 && houseSlot(ctxA.mint).program.equals(HOUSES));
check("A0 HouseVault PDA created with the config (tag 1, zero counters)",
  !!acctData(houseVaultPda(ctxA.mint)) && hvCounters(ctxA.mint).fee === 0n && hvCounters(ctxA.mint).reserve === 0n);
check("A0 pool record: 264B, tag 1, committed 0, live 0, fee_bps 0",
  poolBytes(ctxA).length === 264 && poolBytes(ctxA)[0] === 1 && poolBytes(ctxA)[162] === 0 && poolBytes(ctxA)[163] === 0 && poolU64(ctxA, 168) % 65536n === 0n);
const buyerAtaA = ataOf(ctxA.mint, buyerA.publicKey);
const mmAtaA = ataOf(ctxA.mint, mmA.publicKey);
{
  const r = send(new Transaction().add(
    createAtaIx(creator.publicKey, buyerAtaA, buyerA.publicKey, ctxA.mint, T22),
    createAtaIx(creator.publicKey, mmAtaA, mmA.publicKey, ctxA.mint, T22),
  ), [creator], "A ATAs");
  check("A0 buyer/MM ATAs pre-created", r.ok);
}
const buyerWsolA = fundWsol(buyerA, 50_000_000, "A buyer wSOL fund");
const creatorWsolA = fundWsol(creator, 50_000_000, "A creator wSOL fund");

setTime(T0 + 10);
{
  const r = sendIx(crankDbcIx(ctxA.mint, ctxA.pool), [creator], "A crank#1");
  check("A1 DBC crank succeeds; EMA == curve spot replica exactly", r.ok && feedEma(ctxA.mint) === dbcSpot(ctxA), `ema=${feedEma(ctxA.mint)} spot=${dbcSpot(ctxA)}`);
}
setTime(T0 + 20);
const seedBalA = await seedHousePool(ctxA, 200_000_000n, "A");
check("A2 seed buy + H4 transfer stocked the house token vault", tokAmt(ctxA.houseTokenVault) === seedBalA && seedBalA > 0n, `seeded=${seedBalA}`);
check("A2 pre-activation basis record exists for the house token vault (INTEGRATION.md H4 note)",
  !!acctData(holderPda(ctxA.mint, ctxA.houseTokenVault)) && holderBasis(ctxA.mint, ctxA.houseTokenVault) === feedEma(ctxA.mint),
  `basis=${holderBasis(ctxA.mint, ctxA.houseTokenVault)} ema=${feedEma(ctxA.mint)}`);
{
  const r = sendIx(liquidityIx(ctxA, { authToken: buyerAtaA, authQuote: creatorWsolA, amtToken: 0n, amtQuote: 10_000_000n, add: true }), [creator], "A AddLiquidity quote pre-seed");
  check("A3 pre-commit AddLiquidity (quote only) lands; quote vault = 0.01 SOL", r.ok && tokAmt(ctxA.houseQuoteVault) === 10_000_000n);
}
setTime(T0 + 30);
{
  const r = sendIx(houseSwapIx(ctxA, { user: buyerA, userToken: buyerAtaA, userQuote: buyerWsolA, dir: 0, amountIn: 1_000_000n }), [buyerA], "A house buy before activation");
  check("A4 house swap BEFORE activation fails at the engine with BadCaller (custom 3)",
    !r.ok && customOf(r) === 3, `custom=${customOf(r)}`);
}
setTime(T0 + 40);
{
  const r1 = await curveSwap(ctxA, mmA, false, 300_000_000n, "A MM curve buy 0.30");
  const r2 = await curveSwap(ctxA, buyerA, false, 5_000_000n, "A buyer curve buy 0.005");
  check("A5 curve buys pass (MM exempt, buyer basis recorded)", r1.ok && r2.ok && tokAmt(buyerAtaA) > 0n);
  check("A5 curve quote reserve crossed the 0.05 SOL house threshold", quoteReserve(ctxA) >= 50_000_000n, `reserve=${quoteReserve(ctxA)}`);
}
setTime(T0 + 50);
sendIx(crankDbcIx(ctxA.mint, ctxA.pool), [creator], "A crank#2");
let claimedA = 0n;
{
  const metrics = await client.state.getPoolFeeMetrics(ctxA.pool);
  const due = BigInt(metrics.current.partnerQuoteFee.toString());
  check("A6 real curve fees accrued to the claimer (partnerQuoteFee > 0)", due > 0n, `due=${due}`);
  const before = lamports(feeDestA.publicKey);
  const claimerAta = wsolAtaOf(feeDestA.publicKey);
  const ataExistedBefore = !!acct(claimerAta);
  const tx = await client.partner.claimPartnerTradingFee2({
    feeClaimer: feeDestA.publicKey, payer: feeDestA.publicKey, pool: ctxA.pool, receiver: feeDestA.publicKey,
    maxBaseAmount: new BN(0), maxQuoteAmount: new BN(due.toString()),
  });
  const r = send(tx, [feeDestA], "A claim curve fees (SDK)");
  // The claim leaves the claimer's freshly created ATAs open with rent
  // locked inside (a base-mint ATA and the wSOL ATA). Consolidate by
  // closing any of them the claim created, back into the wallet, so the
  // total claimed value is one exact lamport figure, deposit-ready.
  const claimerBaseAta = ataOf(ctxA.mint, feeDestA.publicKey);
  if (r.ok && !ataExistedBefore && acct(claimerAta)) {
    sendIx(createCloseAccountInstruction(claimerAta, feeDestA.publicKey, feeDestA.publicKey, [], TOKEN_PROGRAM_ID),
      [feeDestA], "A close claimer wSOL ATA (consolidate)");
  }
  if (r.ok && acct(claimerBaseAta)) {
    sendIx(createCloseAccountInstruction(claimerBaseAta, feeDestA.publicKey, feeDestA.publicKey, [], TOKEN_2022_PROGRAM_ID),
      [feeDestA], "A close claimer base ATA (consolidate)");
  }
  claimedA = lamports(feeDestA.publicKey) - before;
  check("A6 SDK fee claim lands; claimer total (wallet after ATA consolidation) == metrics amount exactly",
    r.ok && claimedA === due, `claimed=${claimedA} due=${due}`);
}
{
  const before = lamports(feeDestA.publicKey);
  const r = sendIx(depositFeesIx(ctxA.mint, feeDestA, claimedA), [feeDestA], "A DepositHouseFees (tag 16)");
  check("A7 DepositHouseFees mirrors the claimed fees into fee_balance exactly",
    r.ok && hvCounters(ctxA.mint).fee === claimedA && lamports(feeDestA.publicKey) === before - claimedA,
    `fee_balance=${hvCounters(ctxA.mint).fee}`);
}
{
  const r = sendIx(activateHouseIx(ctxA, keeperA), [keeperA], "A ActivateHouse on uncommitted pool");
  check("A8 ActivateHouse refuses an UNCOMMITTED pool (HouseNotCommitted, custom 34)", !r.ok && customOf(r) === 34, `custom=${customOf(r)}`);
}
{
  const r = sendIx(commitPoolIx(ctxA), [creator], "A CommitPool");
  const pb = poolBytes(ctxA);
  check("A9 CommitPool: committed byte 1, authority := poolauth PDA",
    r.ok && pb[162] === 1 && new PublicKey(pb.subarray(1, 33)).equals(poolauthPda(ctxA.mint)));
}
{
  const r = sendIx(liquidityIx(ctxA, { authToken: buyerAtaA, authQuote: creatorWsolA, amtToken: 0n, amtQuote: 1n, add: false }), [creator], "A RemoveLiquidity after commit");
  check("A10 RemoveLiquidity AFTER CommitPool rejects (authority is the program PDA; houseswap custom 4)",
    !r.ok && customOf(r) === 4, `custom=${customOf(r)}`);
}
setTime(T0 + 60);
let cutA = 0n, seedA = 0n;
{
  cutA = (claimedA * 100n) / 10_000n;
  seedA = claimedA - cutA;
  const keeperBefore = lamports(keeperA.publicKey);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    activateHouseIx(ctxA, keeperA),
    activatePoolIx(ctxA, 100),
    // The engine lands the seed as raw lamports (its in-program
    // SyncNative is rejected by the runtime after a direct credit);
    // the keeper bundle syncs the quote vault's token amount top-level.
    syncNativeIx(ctxA.houseQuoteVault),
  );
  const r = send(tx, [keeperA], "A keeper bundle: ActivateHouse + ActivatePool + SyncNative");
  const pb = poolBytes(ctxA);
  check("A11 keeper bundle lands (ActivateHouse tag 14 + ActivatePool tag 5)", r.ok);
  check("A11 config house_state == 2 and venues/exemptions grew (house program + 2 vaults)",
    houseSlot(ctxA.mint).state === 2 && acctData(cfgPda(ctxA.mint))[76] === 2 && acctData(cfgPda(ctxA.mint))[205] === 6,
    `venues=${acctData(cfgPda(ctxA.mint))[76]} exemptions=${acctData(cfgPda(ctxA.mint))[205]}`);
  check("A11 caller cut exact: keeper lamports += fee_balance * 100 / 10000",
    lamports(keeperA.publicKey) === keeperBefore + cutA, `cut=${cutA}`);
  check("A11 HouseVault counters: fee drained, seeded_total == claimed - cut, cut_paid_total == cut",
    hvCounters(ctxA.mint).fee === 0n && hvCounters(ctxA.mint).seeded === seedA && hvCounters(ctxA.mint).cut === cutA);
  check("A11 seed moved into the house quote vault (bundle SyncNative): amount == pre-seed + seed",
    tokAmt(ctxA.houseQuoteVault) === 10_000_000n + seedA, `quote=${tokAmt(ctxA.houseQuoteVault)}`);
  check("A11 pool live: live byte 1, fee_bps 100, fee_dest == DBC fee_claimer, activated_ts == now",
    pb[163] === 1 && pb.readUInt16LE(168) === 100 &&
    new PublicKey(pb.subarray(170, 202)).equals(feeDestA.publicKey) &&
    pb.readBigInt64LE(218) === BigInt(nowTs()));
}
{
  const r = sendIx(activateHouseIx(ctxA, keeperA), [keeperA], "A ActivateHouse twice");
  check("A12 double ActivateHouse rejects AlreadyInit (custom 14)", !r.ok && customOf(r) === 14, `custom=${customOf(r)}`);
  const r2 = sendIx(activatePoolIx(ctxA, 100), [keeperA], "A ActivatePool twice");
  check("A12 double ActivatePool rejects AlreadyLive (houseswap custom 6)", !r2.ok && customOf(r2) === 6, `custom=${customOf(r2)}`);
}
setTime(T0 + 70);
{
  const r = sendIx(crankDeepIx(ctxA), [creator], "A CrankPriceDeep (curve deeper)");
  check("A13 tag 15: curve deeper -> pin stays on the DBC pool; EMA == curve spot",
    r.ok && feedPool(ctxA.mint).equals(ctxA.pool) && feedEma(ctxA.mint) === dbcSpot(ctxA));
}
{
  const ata = ctxA.houseQuoteVault;
  const r = send(new Transaction().add(
    SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: ata, lamports: 1_000_000_000 }),
    syncNativeIx(ata),
  ), [creator], "A donate 1 SOL to house quote vault");
  check("A14 donation lands (quote vault amount grows by exactly 1 SOL)", r.ok && tokAmt(ata) === 10_000_000n + seedA + 1_000_000_000n);
  setTime(T0 + 80);
  const r2 = sendIx(crankDeepIx(ctxA), [creator], "A CrankPriceDeep (house deeper)");
  check("A14 tag 15: house deeper -> feed REPINS to the house pool",
    r2.ok && feedPool(ctxA.mint).equals(ctxA.housePool));
  // The EMA fold clamps each crank's move to max_bps (100%) of the old
  // EMA, so a >2x spot jump converges over several cranks, not one.
  setTime(T0 + 82);
  sendIx(crankDeepIx(ctxA), [creator], "A CrankPriceDeep (converge 1)");
  setTime(T0 + 84);
  sendIx(crankDeepIx(ctxA), [creator], "A CrankPriceDeep (converge 2)");
  const spot = vaultSpot(tokAmt(ctxA.houseTokenVault), tokAmt(ctxA.houseQuoteVault));
  check("A14 tag 15: after convergence cranks the EMA == house vault spot replica exactly",
    feedEma(ctxA.mint) === spot, `ema=${feedEma(ctxA.mint)} spot=${spot}`);
}
setTime(T0 + 90);
{
  const r = await curveSwap(ctxA, mmA, false, 2_000_000_000n, "A MM curve buy 2 SOL");
  check("A15 large curve buy passes", r.ok);
  setTime(T0 + 100);
  const r2 = sendIx(crankDeepIx(ctxA), [creator], "A CrankPriceDeep (curve deeper again)");
  check("A15 tag 15: curve deeper again -> pin flips BACK to the DBC pool; EMA == curve spot",
    r2.ok && feedPool(ctxA.mint).equals(ctxA.pool) && feedEma(ctxA.mint) === dbcSpot(ctxA));
}
// ---- house trades under rule 1 (pin is back on the curve) ----
// The SDK curve buy unwrapped and CLOSED the buyer's wSOL ATA (observed
// in this harness); re-fund it before the house trades.
fundWsol(buyerA, 50_000_000, "A buyer wSOL re-fund");
setTime(T0 + 110);
sendIx(crankDbcIx(ctxA.mint, ctxA.pool), [creator], "A crank#3 (fresh for house buy)");
const emaBuyA = feedEma(ctxA.mint);
let buyOutA = 0n;
{
  const rTok = tokAmt(ctxA.houseTokenVault), rQuote = tokAmt(ctxA.houseQuoteVault);
  buyOutA = cpOut(rQuote, rTok, 10_000_000n - 100_000n); // fee 100 bps on 0.01 SOL
  const balBefore = tokAmt(buyerAtaA);
  const basisBefore = holderBasis(ctxA.mint, buyerAtaA);
  const r = sendIx(houseSwapIx(ctxA, { user: buyerA, userToken: buyerAtaA, userQuote: buyerWsolA, dir: 0, amountIn: 10_000_000n }), [buyerA], "A house buy 0.01 SOL");
  check("A16 house buy passes; token out == constant-product replica exactly",
    r.ok && tokAmt(buyerAtaA) === balBefore + buyOutA, `out=${buyOutA} delta=${tokAmt(buyerAtaA) - balBefore}`);
  check("A16 fee accrued to the quote counter (100 bps of traded-in)", poolU64(ctxA, 202) === 100_000n, `accQ=${poolU64(ctxA, 202)}`);
  // Engine bookkeeping blends the position: (old_bal*old_basis + out*ema) / post_bal.
  const expectBasis = (balBefore * basisBefore + buyOutA * emaBuyA) / (balBefore + buyOutA);
  check("A16 buyer basis blends exactly at the cranked EMA (unit basis = EMA, source vault exempt)",
    holderBasis(ctxA.mint, buyerAtaA) === expectBasis, `basis=${holderBasis(ctxA.mint, buyerAtaA)} expect=${expectBasis}`);
}
const basisA = holderBasis(ctxA.mint, buyerAtaA);
setTime(T0 + 120);
sendIx(crankDbcIx(ctxA.mint, ctxA.pool), [creator], "A crank#4");
{
  const balBefore = tokAmt(buyerAtaA);
  const sellAmt = balBefore / 10n;
  const r = sendIx(houseSwapIx(ctxA, { user: buyerA, userToken: buyerAtaA, userQuote: buyerWsolA, dir: 1, amountIn: sellAmt }), [buyerA], "A house sell above basis");
  check("A17 house sell while EMA >= basis is VETOED (engine Locked, custom 15)",
    !r.ok && customOf(r) === 15 && feedEma(ctxA.mint) >= basisA, `custom=${customOf(r)} ema=${feedEma(ctxA.mint)} basis=${basisA}`);
  check("A17 veto is atomic: buyer balance and latch unchanged", tokAmt(buyerAtaA) === balBefore && holderLatched(ctxA.mint, buyerAtaA) === 0);
}
setTime(T0 + 130);
{
  const mmBal = tokAmt(mmAtaA);
  const r = await curveSwap(ctxA, mmA, true, mmBal, "A MM dumps whole bag");
  check("A18 exempt MM dump passes (price falls)", r.ok && tokAmt(mmAtaA) === 0n);
  setTime(T0 + 140);
  sendIx(crankDbcIx(ctxA.mint, ctxA.pool), [creator], "A crank#5 (the dip)");
  check("A18 cranked EMA is now BELOW the buyer basis", feedEma(ctxA.mint) < basisA, `ema=${feedEma(ctxA.mint)} basis=${basisA}`);
}
setTime(T0 + 150);
{
  const balBefore = tokAmt(buyerAtaA);
  const sellAmt = balBefore / 10n;
  const feeT = (sellAmt * 100n) / 10_000n;
  const rTok = tokAmt(ctxA.houseTokenVault), rQuote = tokAmt(ctxA.houseQuoteVault);
  const expectOut = cpOut(rTok, rQuote, sellAmt - feeT);
  const wsolBefore = tokAmt(buyerWsolA);
  const r = sendIx(houseSwapIx(ctxA, { user: buyerA, userToken: buyerAtaA, userQuote: buyerWsolA, dir: 1, amountIn: sellAmt }), [buyerA], "A house dip sell");
  check("A19 dip sell PASSES on the house venue; quote out == replica exactly",
    r.ok && tokAmt(buyerWsolA) === wsolBefore + expectOut, `out=${expectOut}`);
  check("A19 latch SET by the dip sell; token fee accrued to the token counter",
    holderLatched(ctxA.mint, buyerAtaA) === 1 && poolU64(ctxA, 210) === feeT, `accT=${poolU64(ctxA, 210)} feeT=${feeT}`);
}
{
  const feeDestTokenA = ataOf(ctxA.mint, feeDestA.publicKey);
  const feeDestQuoteA = wsolAtaOf(feeDestA.publicKey);
  const creates = [];
  if (!acct(feeDestTokenA)) creates.push(createAtaIx(creator.publicKey, feeDestTokenA, feeDestA.publicKey, ctxA.mint, T22));
  if (!acct(feeDestQuoteA)) creates.push(createAtaIx(creator.publicKey, feeDestQuoteA, feeDestA.publicKey, NATIVE_MINT, TOKEN));
  const r0 = creates.length ? send(new Transaction().add(...creates), [creator], "A feeDest ATAs") : { ok: true };
  check("A20 feeDest ATAs exist (created if the fee claim had not made them)", r0.ok && !!acct(feeDestTokenA) && !!acct(feeDestQuoteA));
  const accQ = poolU64(ctxA, 202), accT = poolU64(ctxA, 210);
  const r = sendIx(claimFeesIx(ctxA, feeDestTokenA, feeDestQuoteA), [keeperA], "A ClaimFees");
  check("A20 ClaimFees pays both counters to fee_dest exactly; counters zeroed",
    r.ok && tokAmt(feeDestTokenA) === accT && tokAmt(feeDestQuoteA) === accQ && poolU64(ctxA, 202) === 0n && poolU64(ctxA, 210) === 0n,
    `accQ=${accQ} accT=${accT} got q=${tokAmt(feeDestQuoteA)} t=${tokAmt(feeDestTokenA)}`);
  const r2 = sendIx(claimFeesIx(ctxA, feeDestTokenA, feeDestQuoteA), [keeperA], "A ClaimFees again (zero counters)");
  check("A20 ClaimFees with zero counters is a no-op success", r2.ok);
}

// ============================================================================
section("MINT B — reserve path, rules [1 GRADUATED, 2 escrow split 50%]");
const feeDestB = makeWallet(50);
const mmB = makeWallet(200);
const buyerB = makeWallet(100);
const keeperB = makeWallet(20);
const RESERVE_B = 1_500_000_000n;
const ctxB = await launchMint({
  name: "HouseB", feeClaimer: feeDestB, latch: true,
  rules: [ruleEntry(1, true, latchParams(2, 5000)), ruleEntry(2, true, splitParams(5000))],
  extraExemptions: () => [mmB.publicKey],
  house: { program: HOUSES, threshold: 300_000_000n, reserve: RESERVE_B },
});
check("B0 rule-2 config WITH a house block is accepted (1152-byte V2, state 1)",
  houseSlot(ctxB.mint).len === 1152 && houseSlot(ctxB.mint).state === 1);
const buyerAtaB = ataOf(ctxB.mint, buyerB.publicKey);
const mmAtaB = ataOf(ctxB.mint, mmB.publicKey);
{
  const r = send(new Transaction().add(
    createAtaIx(creator.publicKey, buyerAtaB, buyerB.publicKey, ctxB.mint, T22),
    createAtaIx(creator.publicKey, mmAtaB, mmB.publicKey, ctxB.mint, T22),
  ), [creator], "B ATAs");
  check("B0 buyer/MM ATAs pre-created", r.ok);
}
{
  const r = sendIx(recordReserveIx(ctxB.mint), [creator], "B RecordHouseReserve unfunded");
  check("B1 RecordHouseReserve before the SOL lands rejects HouseNotReady (custom 33)", !r.ok && customOf(r) === 33, `custom=${customOf(r)}`);
  const r2 = send(new Transaction().add(SystemProgram.transfer({
    fromPubkey: creator.publicKey, toPubkey: houseVaultPda(ctxB.mint), lamports: Number(RESERVE_B),
  })), [creator], "B reserve transfer");
  const r3 = sendIx(recordReserveIx(ctxB.mint), [creator], "B RecordHouseReserve funded");
  check("B1 reserve recorded exactly after the plain transfer lands",
    r2.ok && r3.ok && hvCounters(ctxB.mint).reserve === RESERVE_B, `reserve=${hvCounters(ctxB.mint).reserve}`);
  const r4 = sendIx(recordReserveIx(ctxB.mint), [creator], "B RecordHouseReserve repeat");
  check("B1 RecordHouseReserve repeat is a no-op success", r4.ok && hvCounters(ctxB.mint).reserve === RESERVE_B);
}
setTime(T0 + 200);
sendIx(crankDbcIx(ctxB.mint, ctxB.pool), [creator], "B crank#1");
const seedBalB = await seedHousePool(ctxB, 200_000_000n, "B");
check("B2 seed transfer stocked the house token vault (graduated holder record created)", tokAmt(ctxB.houseTokenVault) === seedBalB && seedBalB > 0n);
{
  const r = sendIx(commitPoolIx(ctxB), [creator], "B CommitPool");
  check("B3 CommitPool lands", r.ok && poolBytes(ctxB)[162] === 1);
  const r2 = sendIx(activateHouseIx(ctxB, keeperB), [keeperB], "B ActivateHouse before threshold");
  check("B3 ActivateHouse BEFORE the curve crosses the threshold rejects HouseNotReady (custom 33)",
    !r2.ok && customOf(r2) === 33, `custom=${customOf(r2)}`);
}
setTime(T0 + 210);
{
  const r = await curveSwap(ctxB, mmB, false, 250_000_000n, "B MM curve buy 0.25");
  check("B4 curve buy crosses the 0.3 SOL house threshold", r.ok && quoteReserve(ctxB) >= 300_000_000n, `reserve=${quoteReserve(ctxB)}`);
  sendIx(crankDbcIx(ctxB.mint, ctxB.pool), [creator], "B crank#2");
}
{
  const keeperBefore = lamports(keeperB.publicKey);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    activateHouseIx(ctxB, keeperB),
    activatePoolIx(ctxB, 100),
    syncNativeIx(ctxB.houseQuoteVault),
  );
  const r = send(tx, [keeperB], "B keeper bundle: ActivateHouse + ActivatePool + SyncNative");
  check("B5 activation bundle lands; caller cut is 0 (fee_balance was 0, reserve-funded seed)",
    r.ok && lamports(keeperB.publicKey) === keeperBefore);
  check("B5 reserve seed moved whole into the quote vault; pool live at 100 bps to feeDestB",
    tokAmt(ctxB.houseQuoteVault) === RESERVE_B && poolBytes(ctxB)[163] === 1 &&
    new PublicKey(poolBytes(ctxB).subarray(170, 202)).equals(feeDestB.publicKey));
}
// ---- rule 2 split buy ----
setTime(T0 + 220);
sendIx(crankDbcIx(ctxB.mint, ctxB.pool), [creator], "B crank#3 (fresh for the split buy)");
const emaBuyB = feedEma(ctxB.mint);
const buyerWsolB = fundWsol(buyerB, 2_000_000_000, "B buyer wSOL fund");
const escrowB = escrowPda(ctxB.mint, buyerAtaB);
const rent96 = BigInt(svm.minimumBalanceForRentExemption(96n));
let preBalB = 0n;
{
  const rTok = tokAmt(ctxB.houseTokenVault), rQuote = tokAmt(ctxB.houseQuoteVault);
  const traded = 500_000_000n, fee = 5_000_000n;
  const expectOut = cpOut(rQuote, rTok, traded - fee);
  const walletBefore = lamports(buyerB.publicKey);
  const wsolBefore = tokAmt(buyerWsolB);
  const r = sendIx(houseSwapIx(ctxB, {
    user: buyerB, userToken: buyerAtaB, userQuote: buyerWsolB, dir: 0, amountIn: 1_000_000_000n,
    venueExtras: [K(escrowB, false, true)],
  }), [buyerB], "B rule-2 split buy 1 SOL total");
  preBalB = tokAmt(buyerAtaB);
  check("B6 split buy passes; token out == replica on (traded - fee) exactly",
    r.ok && preBalB === expectOut, `out=${preBalB} expect=${expectOut}`);
  check("B6 escrow PDA created; escrow_lamports == split_bps share of the TOTAL input exactly (0.5 SOL)",
    !!acctData(escrowB) && acctData(escrowB).readBigUInt64LE(33) === 500_000_000n);
  check("B6 escrow PDA lamports == rent(96) + escrow_lamports (the escrow invariant)",
    lamports(escrowB) === rent96 + 500_000_000n, `lamports=${lamports(escrowB)} rent=${rent96}`);
  check("B6 buyer funding legs exact: wSOL -= traded_in (0.5), wallet -= split + escrow rent",
    tokAmt(buyerWsolB) === wsolBefore - traded && lamports(buyerB.publicKey) === walletBefore - 500_000_000n - rent96,
    `wsol delta=${tokAmt(buyerWsolB) - wsolBefore} wallet delta=${lamports(buyerB.publicKey) - walletBefore}`);
  check("B6 house fee on the traded remainder accrued (100 bps of 0.5 SOL)", poolU64(ctxB, 202) === 5_000_000n);
  check("B6 buyer basis recorded at the cranked EMA (fresh position)", holderBasis(ctxB.mint, buyerAtaB) === emaBuyB,
    `basis=${holderBasis(ctxB.mint, buyerAtaB)} ema=${emaBuyB}`);
}
const basisB = holderBasis(ctxB.mint, buyerAtaB);
// ---- above-entry sell: forfeit to depth ----
setTime(T0 + 230);
{
  const r = await curveSwap(ctxB, mmB, false, 500_000_000n, "B MM pumps the curve 0.5 SOL");
  check("B7 MM pump passes", r.ok);
  setTime(T0 + 240);
  sendIx(crankDbcIx(ctxB.mint, ctxB.pool), [creator], "B crank#4 (above entry)");
  check("B7 cranked EMA is ABOVE the buyer basis (no dip)", feedEma(ctxB.mint) > basisB, `ema=${feedEma(ctxB.mint)} basis=${basisB}`);
}
setTime(T0 + 250);
let resolved1 = 0n;
{
  const sellAmt = (preBalB * 40n) / 100n; // within the GRADUATED earned cap (50% base)
  resolved1 = (500_000_000n * sellAmt) / preBalB;
  const feeT = (sellAmt * 100n) / 10_000n;
  const rTok = tokAmt(ctxB.houseTokenVault), rQuote = tokAmt(ctxB.houseQuoteVault);
  const expectOut = cpOut(rTok, rQuote, sellAmt - feeT);
  const walletBefore = lamports(buyerB.publicKey);
  // The venue applies the resolution depth as raw lamports after the
  // swap legs; the sell transaction syncs the quote vault amount with a
  // trailing top-level SyncNative (INTEGRATION.md).
  const r = send(new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    houseSwapIx(ctxB, {
      user: buyerB, userToken: buyerAtaB, userQuote: buyerWsolB, dir: 1, amountIn: sellAmt,
      venueExtras: [K(escrowB, false, true), K(feedPda(ctxB.mint), false, false), K(holderPda(ctxB.mint, buyerAtaB), false, false)],
    }),
    syncNativeIx(ctxB.houseQuoteVault),
  ), [buyerB], "B above-entry sell (forfeit)");
  const esc = acctData(escrowB);
  check("B8 above-entry sell PASSES under the graduated cap", r.ok);
  check("B8 resolved share FORFEITED to depth to the lamport (quote vault delta == resolved - swap out)",
    tokAmt(ctxB.houseQuoteVault) === rQuote + resolved1 - expectOut,
    `delta=${tokAmt(ctxB.houseQuoteVault) - rQuote} resolved=${resolved1} out=${expectOut}`);
  check("B8 escrow debited exactly the resolved share; forfeited counter == resolved; refunded == 0",
    esc.readBigUInt64LE(33) === 500_000_000n - resolved1 && esc.readBigUInt64LE(49) === resolved1 && esc.readBigUInt64LE(41) === 0n);
  check("B8 seller wallet received NO refund (lamports unchanged)", lamports(buyerB.publicKey) === walletBefore);
}
// ---- dip sell: 96/2/2 ----
setTime(T0 + 260);
{
  const mmBal = tokAmt(mmAtaB);
  const r = await curveSwap(ctxB, mmB, true, mmBal, "B MM dumps whole bag");
  check("B9 MM dump passes", r.ok);
  // The EMA fold clamps each crank to a 100% move; converge it down.
  setTime(T0 + 270);
  sendIx(crankDbcIx(ctxB.mint, ctxB.pool), [creator], "B crank#5 (the dip)");
  setTime(T0 + 272);
  sendIx(crankDbcIx(ctxB.mint, ctxB.pool), [creator], "B crank#6 (converge)");
  setTime(T0 + 274);
  sendIx(crankDbcIx(ctxB.mint, ctxB.pool), [creator], "B crank#7 (converge)");
  check("B9 cranked EMA is BELOW the buyer basis (dip)", feedEma(ctxB.mint) < basisB, `ema=${feedEma(ctxB.mint)} basis=${basisB}`);
}
setTime(T0 + 280);
{
  const sellAmt = tokAmt(buyerAtaB); // sell everything: resolves the whole remaining escrow
  const escBefore = acctData(escrowB).readBigUInt64LE(33);
  const resolved2 = escBefore; // amount_in == pre_bal
  const refund = (resolved2 * 96n) / 100n;
  const depth = (resolved2 * 2n) / 100n;
  const treasury = resolved2 - refund - depth;
  const feeT = (sellAmt * 100n) / 10_000n;
  const rTok = tokAmt(ctxB.houseTokenVault), rQuote = tokAmt(ctxB.houseQuoteVault);
  const expectOut = cpOut(rTok, rQuote, sellAmt - feeT);
  const walletBefore = lamports(buyerB.publicKey);
  const destBefore = lamports(feeDestB.publicKey);
  const r = send(new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    houseSwapIx(ctxB, {
      user: buyerB, userToken: buyerAtaB, userQuote: buyerWsolB, dir: 1, amountIn: sellAmt,
      venueExtras: [K(escrowB, false, true), K(feedPda(ctxB.mint), false, false), K(holderPda(ctxB.mint, buyerAtaB), false, false),
        K(feeDestB.publicKey, false, true)],
    }),
    syncNativeIx(ctxB.houseQuoteVault),
  ), [buyerB], "B dip sell (96/2/2)");
  const esc = acctData(escrowB);
  check("B10 dip sell of the whole position PASSES", r.ok);
  check("B10 refund to the lamport: seller wallet += resolved * 96 / 100",
    lamports(buyerB.publicKey) === walletBefore + refund, `refund=${refund} delta=${lamports(buyerB.publicKey) - walletBefore}`);
  check("B10 treasury to the lamport: fee_dest wallet += resolved - refund - depth",
    lamports(feeDestB.publicKey) === destBefore + treasury, `treasury=${treasury} delta=${lamports(feeDestB.publicKey) - destBefore}`);
  check("B10 depth to the lamport: quote vault delta == depth - swap out",
    tokAmt(ctxB.houseQuoteVault) === rQuote + depth - expectOut,
    `delta=${tokAmt(ctxB.houseQuoteVault) - rQuote} depth=${depth} out=${expectOut}`);
  check("B10 escrow fully resolved: escrow_lamports == 0, refunded/forfeited counters exact",
    esc.readBigUInt64LE(33) === 0n && esc.readBigUInt64LE(41) === refund &&
    esc.readBigUInt64LE(49) === resolved1 + (resolved2 - refund),
    `refunded=${esc.readBigUInt64LE(41)} forfeited=${esc.readBigUInt64LE(49)}`);
  check("B10 escrow PDA lamports back to pure rent", lamports(escrowB) === rent96);
}
{
  const feeDestTokenB = ataOf(ctxB.mint, feeDestB.publicKey);
  const feeDestQuoteB = wsolAtaOf(feeDestB.publicKey);
  const createsB = [];
  if (!acct(feeDestTokenB)) createsB.push(createAtaIx(creator.publicKey, feeDestTokenB, feeDestB.publicKey, ctxB.mint, T22));
  if (!acct(feeDestQuoteB)) createsB.push(createAtaIx(creator.publicKey, feeDestQuoteB, feeDestB.publicKey, NATIVE_MINT, TOKEN));
  if (createsB.length) send(new Transaction().add(...createsB), [creator], "B feeDest ATAs");
  const accQ = poolU64(ctxB, 202), accT = poolU64(ctxB, 210);
  const r = sendIx(claimFeesIx(ctxB, feeDestTokenB, feeDestQuoteB), [keeperB], "B ClaimFees");
  check("B11 ClaimFees pays the rule-2 stack's counters exactly (quote 5_000_000 from the split buy)",
    r.ok && accQ === 5_000_000n && tokAmt(feeDestQuoteB) === accQ && tokAmt(feeDestTokenB) === accT &&
    poolU64(ctxB, 202) === 0n && poolU64(ctxB, 210) === 0n, `accQ=${accQ} accT=${accT}`);
}

// ============================================================================
section("MINT C — rule 9 Max Wallet on the house venue");
const CAP_BPS_C = 100; // 1% of supply
const feeDestC = makeWallet(50);
const mmC = makeWallet(200);
const buyerC = makeWallet(100);
const keeperC = makeWallet(20);
const ctxC = await launchMint({
  name: "HouseC", feeClaimer: feeDestC, latch: false,
  rules: [ruleEntry(9, true, capParams(CAP_BPS_C))],
  // Launcher-derived house set (launch.mjs l3Exemptions): beyond the
  // launchMint base triple, exactly the house token vault, the house
  // quote vault, and the fee destination's canonical token ATA
  // (feeDestC is this mint's DBC fee_claimer — ClaimFees' token leg).
  extraExemptions: (ctx) => [ctx.houseTokenVault, ctx.houseQuoteVault, ataOf(ctx.mint, feeDestC.publicKey, T22)],
  house: { program: HOUSES, threshold: 50_000_000n, reserve: 1_000_000_000n },
});
const buyerAtaC = ataOf(ctxC.mint, buyerC.publicKey);
{
  const r = send(new Transaction().add(createAtaIx(creator.publicKey, buyerAtaC, buyerC.publicKey, ctxC.mint, T22)), [creator], "C buyer ATA");
  check("C0 buyer ATA pre-created (rule-9-only config: 1088+64-byte V2 house config)", r.ok && houseSlot(ctxC.mint).state === 1);
}
setTime(T0 + 300);
const seedBalC = await seedHousePool(ctxC, 5_000_000_000n, "C");
check("C1 seed stocked the house token vault above the per-wallet cap (vault exempt via the launcher-derived L3 set)",
  tokAmt(ctxC.houseTokenVault) === seedBalC && seedBalC > 0n, `seeded=${seedBalC}`);
const supplyC = acctData(ctxC.mint).readBigUInt64LE(36);
const capRawC = (supplyC * BigInt(CAP_BPS_C)) / 10_000n;
check("C1 cap replica: cap == supply * 100 / 10000 and the pool can pay out past it",
  capRawC > 0n && seedBalC > capRawC, `cap=${capRawC} reserve=${seedBalC}`);
{
  const creatorWsolC = fundWsol(creator, 50_000_000, "C creator wSOL fund");
  const r1 = sendIx(liquidityIx(ctxC, { authToken: buyerAtaC, authQuote: creatorWsolC, amtToken: 0n, amtQuote: 5_000_000n, add: true }), [creator], "C AddLiquidity pre-commit");
  const r2 = sendIx(liquidityIx(ctxC, { authToken: buyerAtaC, authQuote: creatorWsolC, amtToken: 0n, amtQuote: 5_000_000n, add: false }), [creator], "C RemoveLiquidity pre-commit");
  check("C2 pre-commit Add/RemoveLiquidity pair works (seed-recovery path shape)", r1.ok && r2.ok && tokAmt(ctxC.houseQuoteVault) === 0n);
  const r3 = send(new Transaction().add(SystemProgram.transfer({
    fromPubkey: creator.publicKey, toPubkey: houseVaultPda(ctxC.mint), lamports: 1_000_000_000,
  })), [creator], "C reserve transfer");
  const r4 = sendIx(recordReserveIx(ctxC.mint), [creator], "C RecordHouseReserve");
  const r5 = sendIx(commitPoolIx(ctxC), [creator], "C CommitPool");
  check("C2 reserve recorded + pool committed", r3.ok && r4.ok && r5.ok && hvCounters(ctxC.mint).reserve === 1_000_000_000n);
}
setTime(T0 + 310);
{
  const r = await curveSwap(ctxC, mmC, false, 100_000_000n, "C MM curve buy (threshold)");
  check("C3 curve buy crosses the threshold", r.ok && quoteReserve(ctxC) >= 50_000_000n);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    activateHouseIx(ctxC, keeperC),
    activatePoolIx(ctxC, 100),
    syncNativeIx(ctxC.houseQuoteVault),
  );
  const r2 = send(tx, [keeperC], "C keeper bundle");
  check("C3 activation bundle lands; quote vault seeded with the 1 SOL reserve",
    r2.ok && tokAmt(ctxC.houseQuoteVault) === 1_000_000_000n);
  // Idempotent ActivateHouse append: both house vaults were already in
  // the launcher-derived L3 set, so activation must NOT duplicate them
  // or burn slots — the stored list stays exactly the derived 6-set.
  const cfgC = acctData(cfgPda(ctxC.mint));
  const derivedC = [ctxC.poolAuthority, ctxC.baseVault, ctxC.seedAta, ctxC.houseTokenVault, ctxC.houseQuoteVault, ataOf(ctxC.mint, feeDestC.publicKey, T22)];
  const storedC = Array.from({ length: cfgC[205] }, (_, i) => new PublicKey(cfgC.subarray(206 + i * 32, 206 + (i + 1) * 32)).toBase58());
  check("C3 post-activation exemptions == the launcher-derived 6-set exactly (idempotent vault append, no duplicates)",
    JSON.stringify(storedC) === JSON.stringify(derivedC.map((k) => k.toBase58())), `stored=${storedC.join(',')}`);
}
const buyerWsolC = fundWsol(buyerC, 30_000_000_000, "C buyer wSOL fund");
setTime(T0 + 320);
{
  const rTok = tokAmt(ctxC.houseTokenVault), rQuote = tokAmt(ctxC.houseQuoteVault);
  const expectOut = cpOut(rQuote, rTok, 5_000_000n - 50_000n);
  const r = sendIx(houseSwapIx(ctxC, { user: buyerC, userToken: buyerAtaC, userQuote: buyerWsolC, dir: 0, amountIn: 5_000_000n }), [buyerC], "C house buy under cap");
  check("C4 house buy UNDER the cap passes; out == replica", r.ok && tokAmt(buyerAtaC) === expectOut && expectOut < capRawC,
    `out=${expectOut} cap=${capRawC}`);
}
setTime(T0 + 330);
{
  const balBefore = tokAmt(buyerAtaC);
  const rTok = tokAmt(ctxC.houseTokenVault), rQuote = tokAmt(ctxC.houseQuoteVault);
  // size the buy so the constant-product out would push the buyer over the cap
  const need = capRawC - balBefore + 1n;
  const effNeeded = (need * rQuote) / (rTok - need) + 1n;
  const amountIn = ((effNeeded * 10_000n) / 9_900n) + 1_000_000n;
  const wouldBeOut = cpOut(rQuote, rTok, (amountIn * 9_900n) / 10_000n);
  check("C5 sized buy would exceed the cap (replica out > cap - balance)", balBefore + wouldBeOut > capRawC,
    `wouldBe=${balBefore + wouldBeOut} cap=${capRawC}`);
  const r = sendIx(houseSwapIx(ctxC, { user: buyerC, userToken: buyerAtaC, userQuote: buyerWsolC, dir: 0, amountIn }), [buyerC], "C house buy over cap");
  check("C5 house buy OVER the cap is VETOED by rule 9 (engine MaxWalletExceeded, custom 2)",
    !r.ok && customOf(r) === 2, `custom=${customOf(r)}`);
  check("C5 veto is atomic: buyer balance unchanged", tokAmt(buyerAtaC) === balBefore);
}

console.log(`\n==== HOUSES SWAP PHASE C TRIAL: ${total - failed}/${total} passed, ${failed} failed ====`);
if (failures.length) console.log("failures:", failures.join(" | "));
import { writeFileSync } from "node:fs";
writeFileSync(path.join(DIR, "trial-houseswap-result.json"), JSON.stringify({
  houseswap: HOUSES.toBase58(), houseswapSoSha256: housesSha, houseswapSoBytes: readFileSync(HOUSES_SO).length,
  engineSoSha256: engineSha, total, failed, failures,
  mints: { A: ctxA.mint.toBase58(), B: ctxB.mint.toBase58(), C: ctxC.mint.toBase58() },
}, null, 2));
process.exit(failed ? 1 : 0);

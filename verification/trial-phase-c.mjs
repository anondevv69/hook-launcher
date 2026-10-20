// ============================================================================
// ENGINE PHASE C TRIAL SUITE — house venue activation + rule 2 (Escrow
// Split, venue-side): config house region (length-versioned 1088 -> 1152),
// payload house block, HouseVault PDA, tags 14 ActivateHouse / 15
// CrankPriceDeep / 16 DepositHouseFees / 17 RecordHouseReserve, and rule 2
// config-write validation + Execute no-op, against the TRIAL-FLAVOR binary
// (engine/target/engine-trial.so). The resting slot must hold the same build.
//
// Scaffold follows engine/trial-phase-b.mjs (LiteSVM, ComputeBudget prefix,
// expireBlockhash per send, controllable Clock, customOf classification).
// The DBC pool is a fabricated 424-byte DBC-owned account carrying the
// contracted offsets (base_mint @136, base_vault @168, quote_vault @200,
// quote_reserve @240, sqrt_price @280). The house pool is a fabricated
// 264-byte account owned by a dummy house program id carrying the
// contracted Pool layout (token_vault @97, quote_vault @129, committed
// @162, fee_accrued_quote @202) — the engine reads only those bytes. The
// house vaults themselves are REAL token accounts (the pool PDA's ATAs),
// so SyncNative at activation runs against the real legacy token program.
//
// Run: node engine/trial-phase-c.mjs
// ============================================================================
import { LiteSVM, FailedTransactionMetadata, Clock } from "litesvm";
import {
  PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT,
  getAssociatedTokenAddressSync, createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction, createInitializeTransferHookInstruction,
  createMintToInstruction, getMintLen, ExtensionType,
} from "@solana/spl-token";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TRIAL_SO = path.join(DIR, "target/engine-trial.so");
const RESTING_SO = path.join(DIR, "target/deploy/engine.so");
const PHASE_B_SO = path.join(DIR, "phase-c-snapshot/engine-trial-phase-b.so");
const SHIM_SO = path.join(DIR, "../venueshim/target/deploy/venueshim.so");
for (const p of [TRIAL_SO, RESTING_SO, PHASE_B_SO, SHIM_SO]) {
  if (!existsSync(p)) { console.error("MISSING BINARY:", p); process.exit(1); }
}
const trialSha = createHash("sha256").update(readFileSync(TRIAL_SO)).digest("hex");
const restingSha = createHash("sha256").update(readFileSync(RESTING_SO)).digest("hex");
if (trialSha !== restingSha) {
  console.error(`FATAL: resting slot (${restingSha.slice(0, 12)}) != trial build (${trialSha.slice(0, 12)})`);
  process.exit(1);
}
console.log("trial binary sha256:", trialSha);

const ENGINE_ID = new PublicKey("EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT");
const DBC_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const TOKEN2022 = TOKEN_2022_PROGRAM_ID;
const LEGACY = TOKEN_PROGRAM_ID;
const SYSVAR_IX = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const SYSTEM = SystemProgram.programId;
const shimKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.join(DIR, "../venueshim/venueshim-keypair.json"), "utf8"))));
const SHIM = shimKp.publicKey;
const HOUSE_PROG = Keypair.generate().publicKey; // dummy house venue program id
const DEC = 6, QDEC = 9; // token decimals / native (quote) decimals

const T0 = Math.floor(Date.UTC(2026, 9, 20, 12, 0, 0) / 1000);
const ERR = { BadAuthority: 6, UnknownRule: 7, BadState: 10, AlreadyInit: 14, PriceFeedBad: 18, HouseNotReady: 33, HouseNotCommitted: 34 };
function customOf(res) {
  if (!(res instanceof FailedTransactionMetadata)) return null;
  try {
    const s = JSON.stringify(res.err());
    const m = s.match(/"Custom":\s*(\d+)/);
    if (m) return Number(m[1]);
  } catch { /* fall through */ }
  try {
    for (const l of res.meta().logs()) { const mm = String(l).match(/custom program error: (0x[0-9a-f]+)/); if (mm) return parseInt(mm[1], 16); }
  } catch { /* no logs */ }
  return -1;
}
const okRes = (res) => !(res instanceof FailedTransactionMetadata);
let total = 0, failed = 0; const failures = [];
function check(label, cond, extra = "") {
  total++;
  if (cond) console.log(`   ok ${String(total).padStart(3)} ${label}`);
  else { failed++; failures.push(label); console.log(`   FAIL ${label} ${extra}`); }
}
function section(t) { console.log("\n=== " + t + " ==="); }

const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });
const ix = (keys, data, prog = ENGINE_ID) => new TransactionInstruction({ programId: prog, keys, data });
const epda = (seeds) => PublicKey.findProgramAddressSync(seeds, ENGINE_ID)[0];
const cfgPda = (mint) => epda([Buffer.from("config"), mint.toBuffer()]);
const holderPda = (mint, acct) => epda([Buffer.from("holder"), mint.toBuffer(), acct.toBuffer()]);
const metaPda = (mint) => epda([Buffer.from("extra-account-metas"), mint.toBuffer()]);
const vaultPda = (mint) => epda([Buffer.from("rentvault"), mint.toBuffer()]);
const feedPda = (mint) => epda([Buffer.from("price"), mint.toBuffer()]);
const houseVaultPda = (mint) => epda([Buffer.from("housevault"), mint.toBuffer()]);
const housePoolPda = (mint, prog = HOUSE_PROG) => PublicKey.findProgramAddressSync([Buffer.from("pool"), mint.toBuffer()], prog)[0];

// ---------- payloads ----------
function ruleEntry(ruleId, enabled, params) {
  const p = Buffer.alloc(68);
  p.writeUInt16LE(ruleId, 0);
  p[2] = enabled ? 1 : 0;
  Buffer.from(params).copy(p, 4);
  return p;
}
function escrowParams(bps, padByte = -1) {
  const p = Buffer.alloc(64);
  p.writeUInt16LE(bps, 0);
  if (padByte >= 0) p[padByte] = 1;
  return p;
}
// Mirrors parse_config_payload: [tag][mode][authority][rule_count][rules]
// [venue_count][venues][exemption_count][exemptions][fee tail]
// [+ house block: [1][program 32][threshold u64][reserve u64]]
function configPayload(tag, authority, mode, rules, { exemptions = [], venues = [SHIM], house = null, houseRaw = null } = {}) {
  const parts = [Buffer.from([tag, mode]), authority.toBuffer(), Buffer.from([rules.length]), ...rules];
  parts.push(Buffer.from([venues.length]), ...venues.map((v) => v.toBuffer()));
  parts.push(Buffer.from([exemptions.length]), ...exemptions.map((e) => e.toBuffer()));
  const tail = Buffer.alloc(2 + 8 + 1 + 32);
  authority.toBuffer().copy(tail, 11);
  parts.push(tail);
  if (houseRaw) parts.push(houseRaw);
  else if (house) {
    const b = Buffer.alloc(49);
    b[0] = 1;
    house.program.toBuffer().copy(b, 1);
    b.writeBigUInt64LE(BigInt(house.threshold), 33);
    b.writeBigUInt64LE(BigInt(house.reserve), 41);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

// ---------- world scaffold ----------
function makeWorld(binary = TRIAL_SO) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(ENGINE_ID, binary);
  svm.addProgramFromFile(SHIM, SHIM_SO);
  let slot = 1000n;
  const setTime = (ts) => { slot += 17n; svm.setClock(new Clock(slot, 0n, 0n, 0n, BigInt(ts))); };
  setTime(T0);
  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey, BigInt(300 * LAMPORTS_PER_SOL));
  const mintKp = Keypair.generate(); const mint = mintKp.publicKey;
  const sendTx = (tx, signers) => {
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = svm.latestBlockhash();
    tx.sign(...signers);
    const r = svm.sendTransaction(tx);
    svm.expireBlockhash();
    return r;
  };
  const send = (instrs, signers, label) => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instrs);
    const r = sendTx(tx, signers);
    if (!okRes(r)) {
      let logs = [];
      try { logs = r.meta().logs().slice(-4); } catch { /* ignore */ }
      throw new Error(`${label} failed: ${JSON.stringify(r.err())} ${logs.join(" | ")}`);
    }
    return r;
  };
  const sendIx = (instr, signer) => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instr);
    return sendTx(tx, [signer]);
  };
  const accData = (pk) => { const a = svm.getAccount(pk); return a ? Buffer.from(a.data) : null; };
  const lamports = (pk) => { const a = svm.getAccount(pk); return a ? Number(a.lamports) : 0; };
  const tokenBal = (ataPk) => { const d = accData(ataPk); return d ? Number(d.readBigUInt64LE(64)) : 0; };
  // mint with transfer hook (no ATAs yet — worlds add what they need)
  const mintLen = getMintLen([ExtensionType.TransferHook]);
  send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, space: mintLen, lamports: Number(svm.minimumBalanceForRentExemption(BigInt(mintLen))), programId: TOKEN2022 }),
    createInitializeTransferHookInstruction(mint, payer.publicKey, ENGINE_ID, TOKEN2022),
    createInitializeMintInstruction(mint, DEC, payer.publicKey, null, TOKEN2022),
  ], [payer, mintKp], "create mint");
  const initConfig = (rules, opts = {}) => send([ix(
    opts.house
      ? [K(payer.publicKey, true, true), K(mint, false, false), K(cfgPda(mint), false, true), K(SYSTEM, false, false), K(houseVaultPda(mint), false, true)]
      : [K(payer.publicKey, true, true), K(mint, false, false), K(cfgPda(mint), false, true), K(SYSTEM, false, false)],
    configPayload(1, payer.publicKey, opts.mode ?? 1, rules, opts),
  )], [payer], "init config");
  const initMetas = () => send([ix(
    [K(payer.publicKey, true, true), K(metaPda(mint), false, true), K(mint, false, false), K(SYSTEM, false, false), K(cfgPda(mint), false, false)],
    Buffer.from([0]),
  )], [payer], "init metas");
  const fundRentVault = () => send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vaultPda(mint), lamports: 2 * LAMPORTS_PER_SOL })], [payer], "fund rent vault");
  const initFeed = (pool, tokVault, quoteVault) => send([ix(
    [K(payer.publicKey, true, true), K(mint, false, false), K(cfgPda(mint), false, false), K(feedPda(mint), false, true), K(SYSTEM, false, false)],
    Buffer.concat([Buffer.from([6]), pool.toBuffer(), tokVault.toBuffer(), quoteVault.toBuffer(), Buffer.from([DEC, QDEC])]),
  )], [payer], "init price feed");
  const ataFor = (owner) => getAssociatedTokenAddressSync(mint, owner, false, TOKEN2022);
  const makeAta = (ownerKp) => {
    const ata = ataFor(ownerKp.publicKey);
    send([createAssociatedTokenAccountInstruction(ownerKp.publicKey, ata, ownerKp.publicKey, mint, TOKEN2022)], [ownerKp], "make ATA");
    return ata;
  };
  const mintTo = (ata, amount) => send([createMintToInstruction(mint, ata, payer.publicKey, BigInt(amount), [], TOKEN2022)], [payer], "mintTo");
  return { svm, setTime, payer, mint, send, sendTx, sendIx, accData, lamports, tokenBal, initConfig, initMetas, fundRentVault, initFeed, ataFor, makeAta, mintTo };
}

// Fabricated DBC pool (424 B, DBC-owned). Returns { key, baseVault, quoteVault }.
function plantDbcPool(W, { quoteReserve, sqrtPrice }) {
  const key = Keypair.generate().publicKey;
  const baseVault = Keypair.generate().publicKey;
  const quoteVault = Keypair.generate().publicKey;
  const d = Buffer.alloc(424);
  W.mint.toBuffer().copy(d, 136);
  baseVault.toBuffer().copy(d, 168);
  quoteVault.toBuffer().copy(d, 200);
  d.writeBigUInt64LE(BigInt(quoteReserve), 240);
  const sp = BigInt(sqrtPrice);
  d.writeBigUInt64LE(sp & ((1n << 64n) - 1n), 280);
  d.writeBigUInt64LE(sp >> 64n, 288);
  W.svm.setAccount(key, { lamports: 3_000_000, data: new Uint8Array(d), owner: DBC_ID, executable: false, rentEpoch: 0 });
  return { key, baseVault, quoteVault };
}
function patchDbc(W, key, quoteReserve) {
  const a = W.svm.getAccount(key);
  const d = Buffer.from(a.data);
  d.writeBigUInt64LE(BigInt(quoteReserve), 240);
  W.svm.setAccount(key, { ...a, data: new Uint8Array(d) });
}
// Fabricated house pool (264 B, dummy-program-owned) per the contracted layout.
function plantHousePool(W, { tokenVault, quoteVault, committed = 1, feeAccruedQuote = 0 }) {
  const key = housePoolPda(W.mint);
  const d = Buffer.alloc(264);
  d[0] = 1;
  W.payer.publicKey.toBuffer().copy(d, 1); // authority (engine does not read it)
  W.mint.toBuffer().copy(d, 33);
  NATIVE_MINT.toBuffer().copy(d, 65);
  tokenVault.toBuffer().copy(d, 97);
  quoteVault.toBuffer().copy(d, 129);
  d[162] = committed;
  d.writeBigUInt64LE(BigInt(feeAccruedQuote), 202);
  W.svm.setAccount(key, { lamports: 3_000_000, data: new Uint8Array(d), owner: HOUSE_PROG, executable: false, rentEpoch: 0 });
  return key;
}
function patchHousePool(W, key, patch) {
  const a = W.svm.getAccount(key);
  const d = Buffer.from(a.data);
  patch(d);
  W.svm.setAccount(key, { ...a, data: new Uint8Array(d) });
}
function patchTokenAmount(W, ata, amount) {
  const a = W.svm.getAccount(ata);
  const d = Buffer.from(a.data);
  d.writeBigUInt64LE(BigInt(amount), 64);
  W.svm.setAccount(ata, { ...a, data: new Uint8Array(d) });
}
// House vaults: the pool PDA's canonical ATAs. The token leg is a real
// Token-2022 ATA. The quote leg sits at the pool PDA's wSOL ATA address
// but is planted with exact native-token-account bytes: this LiteSVM
// state does not preload the native mint account, so ATA-program
// creation of a wSOL account fails — while the engine and the legacy
// token program (SyncNative) read only the account's own layout:
// mint @0, owner @32, amount @64, state @108 = 1, is_native COption
// @109 (tag 1) with the rent reserve u64 @113; lamports = reserve+amount.
function makeHouseVaults(W, quoteAmount = 0) {
  const pool = housePoolPda(W.mint);
  const tokenVault = getAssociatedTokenAddressSync(W.mint, pool, true, TOKEN2022);
  const quoteVault = getAssociatedTokenAddressSync(NATIVE_MINT, pool, true, LEGACY);
  W.send([createAssociatedTokenAccountInstruction(W.payer.publicKey, tokenVault, pool, W.mint, TOKEN2022)], [W.payer], "house token vault");
  const rent165 = Number(W.svm.minimumBalanceForRentExemption(165n));
  const d = Buffer.alloc(165);
  NATIVE_MINT.toBuffer().copy(d, 0);
  pool.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(BigInt(quoteAmount), 64);
  d[108] = 1;
  d.writeUInt32LE(1, 109);
  d.writeBigUInt64LE(BigInt(rent165), 113);
  W.svm.setAccount(quoteVault, { lamports: rent165 + quoteAmount, data: new Uint8Array(d), owner: LEGACY, executable: false, rentEpoch: 0 });
  return { pool, tokenVault, quoteVault };
}
// Spot mirrors (exact Rust operation order, BigInt).
const SCALE = 10n ** 12n;
function vaultSpot(tok, quote, tdec = DEC, qdec = QDEC) {
  const base = BigInt(quote) * SCALE;
  if (tdec >= qdec) return (base * 10n ** BigInt(tdec - qdec)) / BigInt(tok);
  return base / (BigInt(tok) * 10n ** BigInt(qdec - tdec));
}
function dbcSpot(sqrt, tdec = DEC, qdec = QDEC) {
  const s = BigInt(sqrt), a = s >> 64n, f = s & ((1n << 64n) - 1n);
  const t1 = a * a * SCALE;
  const t = 2n * a * f;
  const t2 = (t >> 64n) * SCALE + (((t & ((1n << 64n) - 1n)) * SCALE) >> 64n);
  const t3 = (((f * f) >> 64n) * SCALE) >> 64n;
  const c = t1 + t2 + t3;
  return tdec >= qdec ? c * 10n ** BigInt(tdec - qdec) : c / 10n ** BigInt(qdec - tdec);
}
const SQRT_1 = 1n << 64n; // sqrt_price 1.0 -> curve spot 1e9 at dec 6/9

// Minimal config-write attempt against a chosen binary (fresh SVM, no mint setup).
function tryWrite(binary, payload) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(ENGINE_ID, binary);
  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey, BigInt(20 * LAMPORTS_PER_SOL));
  const mint = Keypair.generate().publicKey;
  const keys = payload.includesHouse
    ? [K(payer.publicKey, true, true), K(mint, false, false), K(cfgPda(mint), false, true), K(SYSTEM, false, false), K(houseVaultPda(mint), false, true)]
    : [K(payer.publicKey, true, true), K(mint, false, false), K(cfgPda(mint), false, true), K(SYSTEM, false, false)];
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix(keys, payload.buf));
  tx.feePayer = payer.publicKey; tx.recentBlockhash = svm.latestBlockhash(); tx.sign(payer);
  const res = svm.sendTransaction(tx);
  const cfgAcct = svm.getAccount(cfgPda(mint));
  return { res, cfgData: cfgAcct ? Buffer.from(cfgAcct.data) : null, vaultAcct: svm.getAccount(houseVaultPda(mint)) };
}
const payloadOf = (rules, opts = {}) => {
  const buf = configPayload(1, Keypair.generate().publicKey, 1, rules, opts);
  return { buf, includesHouse: !!(opts.house || opts.houseRaw) };
};

// =====================================================================
section("C1 house payload write/read + V1 byte-identity");
{
  const house = { program: HOUSE_PROG, threshold: 2_000_000_000, reserve: 500_000_000 };
  const r = tryWrite(TRIAL_SO, payloadOf([ruleEntry(15, true, Buffer.alloc(64))], { house }));
  check("house payload accepted", okRes(r.res), JSON.stringify(r.res.err?.()));
  check("house config account is 1152 bytes", r.cfgData && r.cfgData.length === 1152, `len=${r.cfgData?.length}`);
  check("house region: program @1088", r.cfgData && r.cfgData.subarray(1088, 1120).equals(HOUSE_PROG.toBuffer()));
  check("house region: threshold @1120 = 2 SOL", r.cfgData && Number(r.cfgData.readBigUInt64LE(1120)) === 2_000_000_000);
  check("house region: reserve @1128 = 0.5 SOL", r.cfgData && Number(r.cfgData.readBigUInt64LE(1128)) === 500_000_000);
  check("house region: activated_ts @1136 = 0", r.cfgData && Number(r.cfgData.readBigInt64LE(1136)) === 0);
  check("house region: state @1144 = 1 (pending)", r.cfgData && r.cfgData[1144] === 1);
  check("house region: reserved [1145..1152] zero", r.cfgData && r.cfgData.subarray(1145, 1152).equals(Buffer.alloc(7)));
  check("house vault created at init", !!r.vaultAcct && r.vaultAcct.data.length === 128);
  check("house vault tag = 1, counters zero", !!r.vaultAcct && r.vaultAcct.data[0] === 1 && Buffer.from(r.vaultAcct.data).subarray(1, 33).equals(Buffer.alloc(32)));

  // V1 byte-identity: the SAME fixed payload against the Phase B snapshot
  // binary and the Phase C binary must produce byte-identical configs.
  const fixedPayer = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey;
  const fixedMintSeed = new Uint8Array(32).fill(9);
  const runFixed = (binary) => {
    const svm = new LiteSVM();
    svm.addProgramFromFile(ENGINE_ID, binary);
    const payer = Keypair.fromSeed(new Uint8Array(32).fill(7));
    svm.airdrop(payer.publicKey, BigInt(20 * LAMPORTS_PER_SOL));
    const mint = Keypair.fromSeed(fixedMintSeed).publicKey;
    const buf = configPayload(1, fixedPayer, 1, [ruleEntry(15, true, Buffer.alloc(64)), ruleEntry(9, true, (() => { const p = Buffer.alloc(64); p.writeUInt16LE(500, 0); return p; })())]);
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ix([K(payer.publicKey, true, true), K(mint, false, false), K(cfgPda(mint), false, true), K(SYSTEM, false, false)], buf));
    tx.feePayer = payer.publicKey; tx.recentBlockhash = svm.latestBlockhash(); tx.sign(payer);
    const res = svm.sendTransaction(tx);
    if (!okRes(res)) throw new Error("fixed write failed: " + JSON.stringify(res.err()));
    return Buffer.from(svm.getAccount(cfgPda(mint)).data);
  };
  const bB = runFixed(PHASE_B_SO);
  const bC = runFixed(TRIAL_SO);
  check("non-house config is 1088 bytes under both binaries", bB.length === 1088 && bC.length === 1088);
  check("non-house config bytes byte-identical Phase B vs Phase C engine", bB.equals(bC));
  // And a house config's first 1088 bytes equal the same payload written
  // without the block (masking the per-call random mint/authority bytes
  // at [4..68] and the fee_vault mirror at [1017..1049]).
  const rNH = tryWrite(TRIAL_SO, payloadOf([ruleEntry(15, true, Buffer.alloc(64))], {}));
  const mask = Buffer.alloc(1088, 1);
  mask.fill(0, 4, 68); mask.fill(0, 1017, 1049);
  let prefixSame = r.cfgData && rNH.cfgData && rNH.cfgData.length === 1088;
  if (prefixSame) for (let i = 0; i < 1088; i++) if (mask[i] && r.cfgData[i] !== rNH.cfgData[i]) prefixSame = false;
  check("house config [0..1088] equals the non-house config bytes (key fields masked)", prefixSame);
}

// =====================================================================
section("C2 house block parse validation (fail closed)");
{
  const house = { program: HOUSE_PROG, threshold: 1_000_000_000, reserve: 0 };
  const bad = [
    ["trailing garbage byte after fee tail", payloadOf([], { houseRaw: Buffer.from([9]) })],
    ["house block truncated (48 of 49 bytes)", payloadOf([], { houseRaw: (() => { const b = Buffer.alloc(48); b[0] = 1; HOUSE_PROG.toBuffer().copy(b, 1); return b; })() })],
    ["house block tag byte != 1", payloadOf([], { houseRaw: (() => { const b = Buffer.alloc(49); b[0] = 2; HOUSE_PROG.toBuffer().copy(b, 1); b.writeBigUInt64LE(1n, 33); return b; })() })],
    ["house program zero", payloadOf([], { house: { program: PublicKey.default, threshold: 1, reserve: 0 } })],
    ["house program == engine id", payloadOf([], { house: { program: ENGINE_ID, threshold: 1, reserve: 0 } })],
    ["house threshold zero", payloadOf([], { house: { program: HOUSE_PROG, threshold: 0, reserve: 0 } })],
  ];
  for (const [label, pl] of bad) {
    const r = tryWrite(TRIAL_SO, pl);
    check("write rejected: " + label, !okRes(r.res), "unexpectedly accepted");
  }
  const okH = tryWrite(TRIAL_SO, payloadOf([], { house }));
  check("write accepted: minimal house block (reserve 0)", okRes(okH.res));
}

// =====================================================================
section("C3 rule 2 (Escrow Split) write validation matrix");
{
  const house = { program: HOUSE_PROG, threshold: 1_000_000_000, reserve: 0 };
  const cases = [
    ["bps 0", [ruleEntry(2, true, escrowParams(0))], { house }, false],
    ["bps 10001", [ruleEntry(2, true, escrowParams(10001))], { house }, false],
    ["nonzero padding @10", [ruleEntry(2, true, escrowParams(5000, 10))], { house }, false],
    ["nonzero padding @63", [ruleEntry(2, true, escrowParams(5000, 63))], { house }, false],
    ["rule 2 without house block", [ruleEntry(2, true, escrowParams(5000))], {}, false],
    ["rule 2 with house, bps 5000", [ruleEntry(2, true, escrowParams(5000))], { house }, true],
    ["rule 2 with house, bps 1 (min)", [ruleEntry(2, true, escrowParams(1))], { house }, true],
    ["rule 2 with house, bps 10000 (max)", [ruleEntry(2, true, escrowParams(10000))], { house }, true],
    ["rule 2 DISABLED without house is inert", [ruleEntry(2, false, escrowParams(0, 10))], {}, true],
    ["rule 1 + rule 2 with house", [ruleEntry(1, true, Buffer.alloc(64)), ruleEntry(2, true, escrowParams(5000))], { house }, true],
  ];
  for (const [label, rules, opts, want] of cases) {
    const r = tryWrite(TRIAL_SO, payloadOf(rules, opts));
    check(`rule 2 write ${want ? "accepted" : "rejected"}: ${label}`, okRes(r.res) === want, JSON.stringify(r.res.err?.()));
  }
}

// =====================================================================
section("C4 rule 2 Execute no-op (transfer passes untouched)");
{
  const W = makeWorld();
  const house = { program: HOUSE_PROG, threshold: 1_000_000_000, reserve: 0 };
  W.initConfig([ruleEntry(2, true, escrowParams(5000))], { house, mode: 1 });
  W.initMetas();
  W.fundRentVault();
  const ownerA = Keypair.generate(); W.svm.airdrop(ownerA.publicKey, BigInt(5 * LAMPORTS_PER_SOL));
  const ownerB = Keypair.generate(); W.svm.airdrop(ownerB.publicKey, BigInt(5 * LAMPORTS_PER_SOL));
  const ataA = W.makeAta(ownerA), ataB = W.makeAta(ownerB);
  W.mintTo(ataA, 10_000);
  const tail = [K(cfgPda(W.mint), false, false), K(SYSVAR_IX, false, false), K(ENGINE_ID, false, false), K(metaPda(W.mint), false, false)];
  const data = Buffer.alloc(10);
  data[0] = 12; data.writeBigUInt64LE(4000n, 1); data[9] = DEC;
  const instr = new TransactionInstruction({ programId: TOKEN2022, data, keys: [K(ataA, false, true), K(W.mint, false, false), K(ataB, false, true), K(ownerA.publicKey, true, false), ...tail] });
  const res = W.sendIx(instr, ownerA);
  check("transfer passes with rule 2 enabled (venue-side only)", okRes(res), JSON.stringify(res.err?.()));
  check("destination balance = 4000", W.tokenBal(ataB) === 4000, `bal=${W.tokenBal(ataB)}`);
}

// =====================================================================
// Activation lifecycle world (shared by C5-C7).
function activationWorld() {
  const W = makeWorld();
  const house = { program: HOUSE_PROG, threshold: 2_000_000_000, reserve: 500_000_000 };
  W.initConfig([ruleEntry(15, true, Buffer.alloc(64))], { house, mode: 1 });
  W.initMetas();
  const { pool, tokenVault, quoteVault } = makeHouseVaults(W, 250_000_000);
  const dbc = plantDbcPool(W, { quoteReserve: 1_000_000_000, sqrtPrice: SQRT_1 });
  const poolKey = plantHousePool(W, { tokenVault, quoteVault, committed: 0 });
  W.initFeed(dbc.key, dbc.baseVault, dbc.quoteVault);
  W.mintTo(tokenVault, 4_000_000);
  return { W, house, pool, tokenVault, quoteVault, dbc, poolKey };
}
const hvPdaOf = (W) => houseVaultPda(W.mint);
const tag17Ix = (W) => ix([K(W.payer.publicKey, true, false), K(W.mint, false, false), K(cfgPda(W.mint), false, false), K(hvPdaOf(W), false, true)], Buffer.from([17]));
const tag16Ix = (W, amount, payer = W.payer) => {
  const d = Buffer.alloc(9); d[0] = 16; d.writeBigUInt64LE(BigInt(amount), 1);
  return ix([K(payer.publicKey, true, true), K(W.mint, false, false), K(cfgPda(W.mint), false, false), K(hvPdaOf(W), false, true), K(SYSTEM, false, false)], d);
};
const tag14Ix = (W, { tokenVault, quoteVault, dbc, caller }) => ix(
  // caller is (signer, writable): the activation cut credits its lamports.
  [K(caller.publicKey, true, true), K(W.mint, false, false), K(cfgPda(W.mint), false, true), K(dbc.key, false, false),
   K(hvPdaOf(W), false, true), K(housePoolPda(W.mint), false, false), K(tokenVault, false, false), K(quoteVault, false, true),
   K(SYSTEM, false, false), K(LEGACY, false, false)],
  Buffer.from([14]));

section("C5 RecordHouseReserve + DepositHouseFees");
let ACT;
{
  ACT = activationWorld();
  const { W } = ACT;
  const rent128 = Number(W.svm.minimumBalanceForRentExemption(128n));
  const hv = hvPdaOf(W);
  check("vault starts at rent only", W.lamports(hv) === rent128, `lamports=${W.lamports(hv)} rent=${rent128}`);
  const rUnfunded = W.sendIx(tag17Ix(W), W.payer);
  check("RecordHouseReserve unfunded rejects HouseNotReady (33)", customOf(rUnfunded) === ERR.HouseNotReady, `custom=${customOf(rUnfunded)}`);
  W.send([SystemProgram.transfer({ fromPubkey: W.payer.publicKey, toPubkey: hv, lamports: 500_000_000 })], [W.payer], "plain reserve transfer");
  const rFunded = W.sendIx(tag17Ix(W), W.payer);
  check("RecordHouseReserve funded succeeds", okRes(rFunded), JSON.stringify(rFunded.err?.()));
  const vd = W.accData(hv);
  check("reserve_balance = commitment (0.5 SOL)", Number(vd.readBigUInt64LE(1)) === 500_000_000);
  check("vault lamports = rent + reserve", W.lamports(hv) === rent128 + 500_000_000);
  const rRepeat = W.sendIx(tag17Ix(W), W.payer);
  check("RecordHouseReserve repeat is a no-op success", okRes(rRepeat));
  check("reserve_balance unchanged after repeat", Number(W.accData(hv).readBigUInt64LE(1)) === 500_000_000);
  const stranger = Keypair.generate(); W.svm.airdrop(stranger.publicKey, BigInt(LAMPORTS_PER_SOL));
  const rStranger = W.sendIx(ix([K(stranger.publicKey, true, false), K(W.mint, false, false), K(cfgPda(W.mint), false, false), K(hv, false, true)], Buffer.from([17])), stranger);
  check("RecordHouseReserve by non-authority rejects BadAuthority (6)", customOf(rStranger) === ERR.BadAuthority, `custom=${customOf(rStranger)}`);
  const payerBeforeDep = W.lamports(W.payer.publicKey);
  const rDep = W.sendIx(tag16Ix(W, 1_000_000_000), W.payer);
  check("DepositHouseFees happy path succeeds", okRes(rDep), JSON.stringify(rDep.err?.()));
  const vd2 = W.accData(hv);
  check("fee_balance = 1 SOL after deposit", Number(vd2.readBigUInt64LE(9)) === 1_000_000_000);
  check("vault lamports = rent + reserve + fees (invariant)", W.lamports(hv) === rent128 + 500_000_000 + 1_000_000_000);
  check("deposit moved real lamports out of the payer (1 SOL + 5000 signer fee)", payerBeforeDep - W.lamports(W.payer.publicKey) === 1_000_000_000 + 5000, `delta=${payerBeforeDep - W.lamports(W.payer.publicKey)}`);
}

// =====================================================================
section("C6 ActivateHouse rejects + happy path (exact bytes/lamports)");
{
  const { W, tokenVault, quoteVault, dbc, poolKey } = ACT;
  const caller = Keypair.generate(); W.svm.airdrop(caller.publicKey, BigInt(LAMPORTS_PER_SOL));
  const args = { tokenVault, quoteVault, dbc, caller };
  const r34 = W.sendIx(tag14Ix(W, args), caller);
  check("ActivateHouse with uncommitted pool rejects HouseNotCommitted (34)", customOf(r34) === ERR.HouseNotCommitted, `custom=${customOf(r34)}`);
  patchHousePool(W, poolKey, (d) => { d[162] = 1; });
  const r33 = W.sendIx(tag14Ix(W, args), caller);
  check("ActivateHouse below threshold (1 SOL < 2 SOL) rejects HouseNotReady (33)", customOf(r33) === ERR.HouseNotReady, `custom=${customOf(r33)}`);
  patchDbc(W, dbc.key, 3_000_000_000);
  const cfgBefore = Buffer.from(W.accData(cfgPda(W.mint)));
  const callerBefore = W.lamports(caller.publicKey);
  const quoteLamportsBefore = W.lamports(quoteVault);
  const quoteAmtBefore = W.tokenBal(quoteVault);
  W.setTime(T0 + 3600);
  // Keeper bundle: tag 14 + a top-level SyncNative in the SAME transaction
  // (the in-program sync CPI is dispatch-rejected after a direct lamport
  // credit — see the CONTRACT DEVIATION note in activate_house).
  const bundleTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    tag14Ix(W, args),
    new TransactionInstruction({ programId: LEGACY, data: Buffer.from([17]), keys: [K(quoteVault, false, true)] }),
  );
  const rOk = W.sendTx(bundleTx, [caller]);
  check("ActivateHouse happy path succeeds (tag 14 + bundled SyncNative)", okRes(rOk), JSON.stringify(rOk.err?.()));
  const cut = 1_000_000_000 * 100 / 10_000; // 10,000,000
  const seed = 500_000_000 + 1_000_000_000 - cut; // 1,490,000,000
  check("caller cut exact (100 bps of fee_balance = 10,000,000, net of the 5000 signer fee)", W.lamports(caller.publicKey) - callerBefore === cut - 5000, `delta=${W.lamports(caller.publicKey) - callerBefore}`);
  check("seed moved into quote vault lamports exact (1,490,000,000)", W.lamports(quoteVault) - quoteLamportsBefore === seed, `delta=${W.lamports(quoteVault) - quoteLamportsBefore}`);
  check("SyncNative visible: quote vault token amount rose by exactly the seed", W.tokenBal(quoteVault) - quoteAmtBefore === seed, `delta=${W.tokenBal(quoteVault) - quoteAmtBefore}`);
  const vd = W.accData(hvPdaOf(W));
  check("vault counters: reserve_balance zeroed", Number(vd.readBigUInt64LE(1)) === 0);
  check("vault counters: fee_balance zeroed", Number(vd.readBigUInt64LE(9)) === 0);
  check("vault counters: cut_paid_total = cut", Number(vd.readBigUInt64LE(17)) === cut);
  check("vault counters: seeded_total = seed", Number(vd.readBigUInt64LE(25)) === seed);
  const rent128 = Number(W.svm.minimumBalanceForRentExemption(128n));
  check("vault lamports back to rent only", W.lamports(hvPdaOf(W)) === rent128);
  const cfgAfter = W.accData(cfgPda(W.mint));
  check("config: house_state = 2 (activated)", cfgAfter[1144] === 2);
  check("config: house_activated_ts = crank time", Number(cfgAfter.readBigInt64LE(1136)) === T0 + 3600, `ts=${cfgAfter.readBigInt64LE(1136)}`);
  check("config: venue_count 1 -> 2", cfgBefore[76] === 1 && cfgAfter[76] === 2);
  check("config: appended venue = house program", cfgAfter.subarray(77 + 32, 77 + 64).equals(HOUSE_PROG.toBuffer()));
  check("config: exemption_count 0 -> 2", cfgBefore[205] === 0 && cfgAfter[205] === 2);
  check("config: appended exemptions = token vault, quote vault",
    cfgAfter.subarray(206, 238).equals(tokenVault.toBuffer()) && cfgAfter.subarray(238, 270).equals(quoteVault.toBuffer()));
  // Exact byte diff: only the allowed ranges may differ.
  const allowed = new Set();
  const allowRange = (a, b) => { for (let i = a; i < b; i++) allowed.add(i); };
  allowRange(76, 77); allowRange(77 + 32, 77 + 64); // venue count + appended venue slot
  allowRange(205, 206); allowRange(206, 270);     // exemption count + two appended slots
  allowRange(1136, 1145);                          // house ts + state
  let outside = 0;
  for (let i = 0; i < cfgBefore.length; i++) if (cfgBefore[i] !== cfgAfter[i] && !allowed.has(i)) outside++;
  check("config byte diff confined to venues/exemptions/house region", outside === 0, `outside=${outside}`);
  const rAgain = W.sendIx(tag14Ix(W, args), caller);
  check("double activation rejects AlreadyInit (14)", customOf(rAgain) === ERR.AlreadyInit, `custom=${customOf(rAgain)}`);
  const rDepLate = W.sendIx(tag16Ix(W, 1000), W.payer);
  check("DepositHouseFees after activation rejects AlreadyInit (14)", customOf(rDepLate) === ERR.AlreadyInit, `custom=${customOf(rDepLate)}`);
}

// =====================================================================
section("C7 UpdateConfig house immutability matrix");
{
  const { W, tokenVault, quoteVault } = ACT;
  const house = { program: HOUSE_PROG, threshold: 2_000_000_000, reserve: 500_000_000 };
  const rules = [ruleEntry(15, true, Buffer.alloc(64))];
  // Post-activation venues/exemptions are part of the stored config; an
  // update payload must carry them (write_config rewrites those fields).
  const postVenues = [SHIM, HOUSE_PROG];
  const postEx = [tokenVault, quoteVault];
  const upd = (opts) => W.sendIx(ix(
    [K(W.payer.publicKey, true, false), K(W.mint, false, false), K(cfgPda(W.mint), false, true)],
    configPayload(2, W.payer.publicKey, 1, rules, opts)), W.payer);
  const before = Buffer.from(W.accData(cfgPda(W.mint)));
  const rDiffThreshold = upd({ venues: postVenues, exemptions: postEx, house: { ...house, threshold: 3_000_000_000 } });
  check("update with different threshold rejected", !okRes(rDiffThreshold));
  const rDiffProgram = upd({ venues: postVenues, exemptions: postEx, house: { ...house, program: Keypair.generate().publicKey } });
  check("update with different house program rejected", !okRes(rDiffProgram));
  const rDiffReserve = upd({ venues: postVenues, exemptions: postEx, house: { ...house, reserve: 1 } });
  check("update with different reserve rejected", !okRes(rDiffReserve));
  const rRemoved = upd({ venues: postVenues, exemptions: postEx });
  check("update dropping the house block rejected", !okRes(rRemoved));
  check("config bytes unchanged after rejected updates", Buffer.from(W.accData(cfgPda(W.mint))).equals(before));
  const rSame = upd({ venues: postVenues, exemptions: postEx, house });
  check("update with identical house block accepted", okRes(rSame), JSON.stringify(rSame.err?.()));
  const after = W.accData(cfgPda(W.mint));
  check("activation state preserved across update (state = 2)", after[1144] === 2);
  check("activation ts preserved across update", after.readBigInt64LE(1136) === before.readBigInt64LE(1136));
  check("house static fields preserved across update",
    after.subarray(1088, 1120).equals(HOUSE_PROG.toBuffer()) && Number(after.readBigUInt64LE(1120)) === 2_000_000_000 && Number(after.readBigUInt64LE(1128)) === 500_000_000);
  // Adding a house block to a non-house config via update also rejects.
  const W2 = makeWorld();
  W2.initConfig(rules, { mode: 1 });
  const rAdd = W2.sendIx(ix(
    [K(W2.payer.publicKey, true, false), K(W2.mint, false, false), K(cfgPda(W2.mint), false, true)],
    configPayload(2, W2.payer.publicKey, 1, rules, { house })), W2.payer);
  check("update adding a house block to a non-house config rejected", !okRes(rAdd));
}

// =====================================================================
// Crank worlds.
function crankWorld() {
  const W = makeWorld();
  const house = { program: HOUSE_PROG, threshold: 1_000_000_000, reserve: 0 };
  W.initConfig([], { house, mode: 1 });
  W.initMetas();
  const { tokenVault, quoteVault } = makeHouseVaults(W, 250_000_000);
  const dbc = plantDbcPool(W, { quoteReserve: 1_000_000_000, sqrtPrice: SQRT_1 });
  const poolKey = plantHousePool(W, { tokenVault, quoteVault, committed: 1 });
  W.initFeed(dbc.key, dbc.baseVault, dbc.quoteVault);
  W.mintTo(tokenVault, 4_000_000);
  return { W, tokenVault, quoteVault, dbc, poolKey };
}
const tag15Ix = (W, { tokenVault, quoteVault, dbc }) => ix(
  [K(cfgPda(W.mint), false, false), K(feedPda(W.mint), false, true), K(dbc.key, false, false),
   K(housePoolPda(W.mint), false, false), K(tokenVault, false, false), K(quoteVault, false, false)],
  Buffer.from([15]));
function crankDeep(W, ctx) {
  return W.sendIx(tag15Ix(W, ctx), W.payer);
}
function activateSimple(W, ctx) {
  // fee-only seed (reserve 0): deposit fees, then activate (caller = payer)
  // with the bundled top-level SyncNative (see C6).
  const rDep = W.sendIx(tag16Ix(W, 100_000_000), W.payer);
  if (!okRes(rDep)) throw new Error("crank-world fee deposit failed");
  const bundleTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    tag14Ix(W, { ...ctx, caller: W.payer }),
    new TransactionInstruction({ programId: LEGACY, data: Buffer.from([17]), keys: [K(ctx.quoteVault, false, true)] }),
  );
  const r = W.sendTx(bundleTx, [W.payer]);
  if (!okRes(r)) throw new Error("crank-world activation failed: " + JSON.stringify(r.err()));
}
const feedState = (W) => {
  const d = W.accData(feedPda(W.mint));
  return { pool: new PublicKey(d.subarray(1, 33)), tok: new PublicKey(d.subarray(33, 65)), quote: new PublicKey(d.subarray(65, 97)), ema: d.readBigUInt128LE(97), count: Number(d.readBigUInt64LE(121)) };
};
function readU128LE(b, o) { return b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n); }
Buffer.prototype.readBigUInt128LE = function (o) { return readU128LE(this, o); };

section("C8 CrankPriceDeep — pre-activation house depth ignored");
{
  const ctx = crankWorld();
  const { W, tokenVault, quoteVault } = ctx;
  patchTokenAmount(W, quoteVault, 5_000_000_000); // house would be deeper (5 SOL) — but pending
  const res = crankDeep(W, ctx);
  check("deep crank succeeds pre-activation", okRes(res), JSON.stringify(res.err?.()));
  const f = feedState(W);
  check("feed stays pinned to the curve pool", f.pool.equals(ctx.dbc.key));
  check("ema = curve spot exactly (1e9)", f.ema === dbcSpot(SQRT_1), `ema=${f.ema} want=${dbcSpot(SQRT_1)}`);
}

section("C9 CrankPriceDeep — house-deeper repins + folds house spot; flip back");
{
  const ctx = crankWorld();
  const { W, tokenVault, quoteVault, poolKey } = ctx;
  activateSimple(W, ctx);
  patchTokenAmount(W, tokenVault, 4_000_000);
  patchTokenAmount(W, quoteVault, 2_000_000_000);
  patchHousePool(W, poolKey, (d) => d.writeBigUInt64LE(500_000_000n, 202)); // fee_accrued: depth = 2e9 - 5e8 = 1.5e9 > curve 1e9
  const res = crankDeep(W, ctx);
  check("deep crank succeeds (house deeper)", okRes(res), JSON.stringify(res.err?.()));
  const f = feedState(W);
  check("feed repinned to the house pool", f.pool.equals(housePoolPda(W.mint)));
  check("feed repinned vaults = house vaults", f.tok.equals(tokenVault) && f.quote.equals(quoteVault));
  const wantHouseSpot = vaultSpot(4_000_000n, 2_000_000_000n);
  check("ema = house spot exactly", f.ema === wantHouseSpot, `ema=${f.ema} want=${wantHouseSpot}`);
  // Flip back: curve becomes deeper (3 SOL reserve vs house depth 1.5 SOL).
  patchDbc(W, ctx.dbc.key, 3_000_000_000);
  W.setTime(T0 + 600);
  const res2 = crankDeep(W, ctx);
  check("deep crank succeeds after reserves move (flip back)", okRes(res2), JSON.stringify(res2.err?.()));
  const f2 = feedState(W);
  check("feed repinned back to the curve pool", f2.pool.equals(ctx.dbc.key));
  check("feed repinned vaults = curve vaults", f2.tok.equals(ctx.dbc.baseVault) && f2.quote.equals(ctx.dbc.quoteVault));
  check("ema = curve spot exactly after flip", f2.ema === dbcSpot(SQRT_1), `ema=${f2.ema}`);
}

section("C10 CrankPriceDeep — curve-deeper keeps pin (fee-accrued depth subtraction)");
{
  const ctx = crankWorld();
  const { W, tokenVault, quoteVault, poolKey } = ctx;
  activateSimple(W, ctx);
  patchTokenAmount(W, tokenVault, 4_000_000);
  patchTokenAmount(W, quoteVault, 2_000_000_000); // raw quote 2 SOL > curve depth 1 SOL
  patchHousePool(W, poolKey, (d) => d.writeBigUInt64LE(1_600_000_000n, 202)); // depth = 2e9 - 1.6e9 = 0.4e9 < 1e9
  const res = crankDeep(W, ctx);
  check("deep crank succeeds (curve deeper net of accrued fees)", okRes(res), JSON.stringify(res.err?.()));
  const f = feedState(W);
  check("feed stays pinned to the curve pool", f.pool.equals(ctx.dbc.key));
  check("ema = curve spot exactly", f.ema === dbcSpot(SQRT_1), `ema=${f.ema}`);
}

console.log(`\n==== PHASE C TRIAL: ${total - failed}/${total} passed, ${failed} failed ====`);
if (failures.length) console.log("failures:", failures.join(" | "));
process.exit(failed ? 1 : 0);

// ============================================================================
// ENGINE PHASE B TRIAL SUITE — settlement rules 5 (Crown Beneficiary),
// 6 (Tithe Seat), 14 (Decay Tax), 15 (King tithe param), 16 (Buyback &
// Burn): config-write validation + cross-rule split-sum + Execute no-op,
// against the TRIAL-FLAVOR binary (engine/target/engine-trial.so).
// The resting slot target/deploy/engine.so must hold the same trial build
// (asserted below via hash compare).
//
// Plumbing follows engine/trial-v4.mjs (its scaffold is reused verbatim):
// ComputeBudget prefix, expireBlockhash after each send,
// FailedTransactionMetadata classification, a controllable Clock, and the
// venueshim program for venue-context transfers.
//
// Run: node engine/trial-phase-b.mjs
// ============================================================================
import { LiteSVM, FailedTransactionMetadata, Clock } from "litesvm";
import {
  PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createInitializeMintInstruction,
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
const SHIM_SO = path.join(DIR, "../venueshim/target/deploy/venueshim.so");
for (const p of [TRIAL_SO, RESTING_SO, SHIM_SO]) {
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
const TOKEN2022 = TOKEN_2022_PROGRAM_ID;
const SYSVAR_IX = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const SYSTEM = SystemProgram.programId;
const shimKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.join(DIR, "../venueshim/venueshim-keypair.json"), "utf8"))));
const SHIM = shimKp.publicKey;                       // canonical venue
const APP_ID = Keypair.generate().publicKey;          // rule 4's app (shim clone)
const OTHER_VENUE = Keypair.generate().publicKey;     // a non-app venue (shim clone)

const T0 = Math.floor(Date.UTC(2026, 9, 19, 15, 30, 0) / 1000); // Mon 10:30 EST
const ERR = {
  // EngineError discriminants verbatim (From impl: ProgramError::Custom(e as u32)).
  UnknownRule: 7, AlreadyInit: 14, MissingExtra: 26, BadAuthority: 6, ConfigLocked: 5,
  GrudgeMarked: 27, OutsideTradingHours: 28, VestingLocked: 29,
  NotAllowlisted: 30, Blocklisted: 31, AppNotAllowed: 32,
};
function customOf(res) {
  if (!(res instanceof FailedTransactionMetadata)) return null;
  try {
    const e = res.err();
    const s = JSON.stringify(e);
    const m = s.match(/"Custom":\s*(\d+)/);
    if (m) return Number(m[1]);
  } catch { /* fall through to logs */ }
  try {
    const logs = res.meta().logs();
    for (const l of logs) { const mm = String(l).match(/custom program error: (0x[0-9a-f]+)/); if (mm) return parseInt(mm[1], 16); }
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

// ---------- PDAs ----------
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, ENGINE_ID)[0];
const cfgPda = (mint) => pda([Buffer.from("config"), mint.toBuffer()]);
const holderPda = (mint, acct) => pda([Buffer.from("holder"), mint.toBuffer(), acct.toBuffer()]);
const metaPda = (mint) => pda([Buffer.from("extra-account-metas"), mint.toBuffer()]);
const vaultPda = (mint) => pda([Buffer.from("rentvault"), mint.toBuffer()]);
const feedPda = (mint) => pda([Buffer.from("price"), mint.toBuffer()]);
const kingPda = (mint) => pda([Buffer.from("king"), mint.toBuffer()]);
const listsPda = (mint) => pda([Buffer.from("lists"), mint.toBuffer()]);
const allowPda = (mint, acct) => pda([Buffer.from("allow"), mint.toBuffer(), acct.toBuffer()]);
const HOLDER_SPACE_V3 = 224;
const DEC = 6;

// ---------- payloads ----------
function ruleEntry(ruleId, enabled, params) {
  const p = Buffer.alloc(68);
  p.writeUInt16LE(ruleId, 0);
  p[2] = enabled ? 1 : 0;
  Buffer.from(params).copy(p, 4);
  return p;
}
function configPayload(tag, authority, mode, rules, exemptions = [], venues = [SHIM]) {
  // Mirrors engine parse_config_payload exactly:
  // [tag][mode][authority][rule_count][rules][venue_count][venues]
  // [exemption_count][exemptions][fee_bps u16][fee_max u64][ben_mode][fee_vault]
  const parts = [Buffer.from([tag, mode]), authority.toBuffer(), Buffer.from([rules.length]), ...rules];
  parts.push(Buffer.from([venues.length]), ...venues.map((v) => v.toBuffer()));
  parts.push(Buffer.from([exemptions.length]), ...exemptions.map((e) => e.toBuffer()));
  const tail = Buffer.alloc(2 + 8 + 1 + 32);
  authority.toBuffer().copy(tail, 11); // fee_vault (unused by these trials)
  parts.push(tail);
  return Buffer.concat(parts);
}
const K = (pubkey, s, w) => ({ pubkey, isSigner: s, isWritable: w });
const ix = (keys, data, prog = ENGINE_ID) => new TransactionInstruction({ programId: prog, keys, data });

// ---------- extras masks (10-bit, published canonical order) ----------
// [0 config, 1 src holder, 2 dst holder, 3 vault, 4 feed, 5 system,
//  6 sysvar, 7 king, 8 lists, 9 allow]
const M = {
  none:      [1,0,0,0,0,0, 1,0,0,0],
  king:      [1,0,0,1,0,1, 1,1,0,0],
  listsMode0:[1,0,0,0,0,0, 1,0,1,0],
  allowMode1:[1,0,0,0,0,0, 1,0,0,1],
  grudge:    [1,1,1,1,0,1, 1,0,0,0],
  vesting:   [1,1,1,1,0,1, 1,0,0,0],
};
function extras(mint, srcAta, dstAta, mask) {
  const all = [
    K(cfgPda(mint), false, false),
    K(holderPda(mint, srcAta), false, true), K(holderPda(mint, dstAta), false, true),
    K(vaultPda(mint), false, true), K(feedPda(mint), false, true), K(SYSTEM, false, false),
    K(SYSVAR_IX, false, false),
    K(kingPda(mint), false, true), K(listsPda(mint), false, false), K(allowPda(mint, dstAta), false, false),
  ];
  return mask.map((b, i) => (b ? all[i] : null)).filter(Boolean);
}

// ---------- scenario scaffold ----------
function baseScenario(rules, { mode = 0, exemptions = [], venues = [SHIM] } = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(ENGINE_ID, TRIAL_SO);
  svm.addProgramFromFile(SHIM, SHIM_SO);
  svm.addProgramFromFile(APP_ID, SHIM_SO);
  svm.addProgramFromFile(OTHER_VENUE, SHIM_SO);
  let slot = 1000n;
  const setTime = (ts) => { slot += 17n; svm.setClock(new Clock(slot, 0n, 0n, 0n, BigInt(ts))); };
  setTime(T0);
  const now = () => Number(svm.getClock().unixTimestamp);
  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey, BigInt(200 * LAMPORTS_PER_SOL));
  const mintKp = Keypair.generate(); const mint = mintKp.publicKey;
  const atas = {};
  for (const n of ["A", "B", "POOL"]) {
    const owner = Keypair.generate();
    svm.airdrop(owner.publicKey, BigInt(5 * LAMPORTS_PER_SOL));
    atas[n] = { owner, ata: getAssociatedTokenAddressSync(mint, owner.publicKey, false, TOKEN2022) };
  }
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
  // --- mint with transfer hook ---
  const mintLen = getMintLen([ExtensionType.TransferHook]);
  send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, space: mintLen, lamports: Number(svm.minimumBalanceForRentExemption(BigInt(mintLen))), programId: TOKEN2022 }),
    createInitializeTransferHookInstruction(mint, payer.publicKey, ENGINE_ID, TOKEN2022),
    createInitializeMintInstruction(mint, DEC, payer.publicKey, null, TOKEN2022),
  ], [payer, mintKp], "create mint");
  for (const n of ["A", "B", "POOL"]) {
    send([createAssociatedTokenAccountInstruction(atas[n].owner.publicKey, atas[n].ata, atas[n].owner.publicKey, mint, TOKEN2022)], [atas[n].owner], `ATA ${n}`);
  }
  // --- config (tag 1) + meta list (tag 0) + vault funding ---
  send([ix(
    [K(payer.publicKey, true, true), K(mint, false, false), K(cfgPda(mint), false, true), K(SYSTEM, false, false)],
    configPayload(1, payer.publicKey, mode, rules, exemptions.map((n) => atas[n].owner.publicKey), venues),
  )], [payer], "init config");
  send([ix(
    [K(payer.publicKey, true, true), K(metaPda(mint), false, true), K(mint, false, false), K(SYSTEM, false, false), K(cfgPda(mint), false, false)],
    Buffer.from([0]),
  )], [payer], "init metas");
  send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vaultPda(mint), lamports: 2 * LAMPORTS_PER_SOL })], [payer], "fund vault");

  const mintTo = (name, amount) => send([createMintToInstruction(mint, atas[name].ata, payer.publicKey, BigInt(amount), [], TOKEN2022)], [payer], `mintTo ${name}`);
  // TransferChecked (direct) or shim-CPI (venue). Amounts in raw units.
  const transfer = (fromName, toName, amount, { venue = null, mask = M.none } = {}) => {
    const src = atas[fromName], dst = atas[toName];
    const tail = [...extras(mint, src.ata, dst.ata, mask), K(ENGINE_ID, false, false), K(metaPda(mint), false, false)];
    let instr;
    if (venue) {
      const data = Buffer.alloc(9);
      data.writeBigUInt64LE(BigInt(amount), 0);
      data[8] = DEC;
      instr = new TransactionInstruction({
        programId: venue, data,
        keys: [K(src.ata, false, true), K(mint, false, false), K(dst.ata, false, true), K(src.owner.publicKey, true, false), K(TOKEN2022, false, false), ...tail],
      });
    } else {
      const data = Buffer.alloc(10);
      data[0] = 12; // TransferChecked
      data.writeBigUInt64LE(BigInt(amount), 1);
      data[9] = DEC;
      instr = new TransactionInstruction({
        programId: TOKEN2022, data,
        keys: [K(src.ata, false, true), K(mint, false, false), K(dst.ata, false, true), K(src.owner.publicKey, true, false), ...tail],
      });
    }
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instr);
    return sendTx(tx, [src.owner]);
  };
  const sendIx = (instr, signer) => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instr);
    return sendTx(tx, [signer]);
  };
  const accData = (pk) => { const a = svm.getAccount(pk); return a ? Buffer.from(a.data) : null; };
  const tokenBal = (ataPk) => { const d = accData(ataPk); return d ? Number(d.readBigUInt64LE(64)) : 0; };
  return { svm, setTime, now, payer, mint, atas, transfer, sendIx, send, accData, tokenBal, mintTo };
}

// param builders
function hoursParams({ tz = -18000, days = 0x1F, start = 540, end = 1020, scope = 0 } = {}) {
  const p = Buffer.alloc(64);
  p.writeInt32LE(tz, 0); p[4] = days; p.writeUInt16LE(start, 5); p.writeUInt16LE(end, 7); p[9] = scope;
  return p;
}
function appParams(app1, app2 = PublicKey.default) {
  const p = Buffer.alloc(64); app1.toBuffer().copy(p, 0); app2.toBuffer().copy(p, 32); return p;
}
const listParams = (mode) => { const p = Buffer.alloc(64); p[0] = mode; return p; };
function grudgeParams({ bps = 5000, window = 86400, dur = 86400, mode = 0, cap = 0, esc = 0 } = {}) {
  const p = Buffer.alloc(64);
  p.writeUInt16LE(bps, 0); p.writeBigUInt64LE(BigInt(window), 2); p.writeBigUInt64LE(BigInt(dur), 10);
  p[18] = mode; p.writeBigUInt64LE(BigInt(cap), 19); p[27] = esc;
  return p;
}
function vestParams({ mode = 1, hold = 86400, release = 0 } = {}) {
  const p = Buffer.alloc(64);
  p[0] = mode; p.writeBigUInt64LE(BigInt(hold), 8); p.writeBigInt64LE(BigInt(release), 16);
  return p;
}
const kingParams = () => Buffer.alloc(64);


// ---------- Phase B param builders ----------
function crownParams(bps = 500) { const p = Buffer.alloc(64); p.writeUInt16LE(bps, 0); return p; }
function seatParams(seatMint, bps = 500) { const p = Buffer.alloc(64); seatMint.toBuffer().copy(p, 0); p.writeUInt16LE(bps, 32); return p; }
function decayParams({ start = 1000, floor = 100, decay = 86400 } = {}) { const p = Buffer.alloc(64); p.writeUInt16LE(start, 0); p.writeUInt16LE(floor, 2); p.writeBigUInt64LE(BigInt(decay), 4); return p; }
function kingTitheParams(bps = 0) { const p = Buffer.alloc(64); p.writeUInt16LE(bps, 0); return p; }
function buybackParams({ threshold = 1000000n, cut = 500 } = {}) { const p = Buffer.alloc(64); p.writeBigUInt64LE(BigInt(threshold), 0); p.writeUInt16LE(cut, 8); return p; }
function withByte(params, off, val) { const p = Buffer.from(params); p[off] = val; return p; }

// Minimal config-write attempt (no mint/metas) — mirrors trial-v4 S0.
function tryConfigWrite(rules) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(ENGINE_ID, TRIAL_SO);
  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey, BigInt(10 * LAMPORTS_PER_SOL));
  const mint = Keypair.generate().publicKey;
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix(
    [K(payer.publicKey, true, true), K(mint, false, false), K(cfgPda(mint), false, true), K(SYSTEM, false, false)],
    configPayload(1, payer.publicKey, 0, rules),
  ));
  tx.feePayer = payer.publicKey; tx.recentBlockhash = svm.latestBlockhash(); tx.sign(payer);
  return svm.sendTransaction(tx);
}

// =====================================================================
section("B0 config-write accepts (valid Phase B params)");
{
  const seatMint = Keypair.generate().publicKey;
  const acceptCases = [
    ["rule 5 crown 500", [ruleEntry(5, true, crownParams(500))]],
    ["rule 5 crown 1 (min)", [ruleEntry(5, true, crownParams(1))]],
    ["rule 5 crown 10000 (max, alone)", [ruleEntry(5, true, crownParams(10000))]],
    ["rule 6 seat tithe 500", [ruleEntry(6, true, seatParams(seatMint, 500))]],
    ["rule 6 seat tithe 10000 (max, alone)", [ruleEntry(6, true, seatParams(seatMint, 10000))]],
    ["rule 14 decay start 1000 floor 100 decay 86400", [ruleEntry(14, true, decayParams({}))]],
    ["rule 14 decay floor == start", [ruleEntry(14, true, decayParams({ start: 500, floor: 500, decay: 1 }))]],
    ["rule 14 decay floor 0", [ruleEntry(14, true, decayParams({ start: 500, floor: 0, decay: 60 }))]],
    ["rule 15 king tithe 0 (tracking only)", [ruleEntry(15, true, kingTitheParams(0))]],
    ["rule 15 king all-zero params (v4-era config)", [ruleEntry(15, true, Buffer.alloc(64))]],
    ["rule 15 king tithe 500", [ruleEntry(15, true, kingTitheParams(500))]],
    ["rule 16 buyback threshold 1e6 cut 500", [ruleEntry(16, true, buybackParams({}))]],
    ["rule 16 buyback cut 0", [ruleEntry(16, true, buybackParams({ threshold: 1n, cut: 0 }))]],
    ["rule 16 buyback cut 1000 (max)", [ruleEntry(16, true, buybackParams({ threshold: 1n, cut: 1000 }))]],
    ["rules 5+6+15 split sum == 10000 exactly", [
      ruleEntry(5, true, crownParams(4000)),
      ruleEntry(6, true, seatParams(seatMint, 3000)),
      ruleEntry(15, true, kingTitheParams(3000)),
    ]],
    ["rules 5+6 split sum < 10000", [
      ruleEntry(5, true, crownParams(100)),
      ruleEntry(6, true, seatParams(seatMint, 100)),
    ]],
    ["full Phase B stack 5+6+14+15+16 (split 4000+3000+3000)", [
      ruleEntry(5, true, crownParams(4000)),
      ruleEntry(6, true, seatParams(seatMint, 3000)),
      ruleEntry(14, true, decayParams({})),
      ruleEntry(15, true, kingTitheParams(3000)),
      ruleEntry(16, true, buybackParams({})),
    ]],
    ["rule 5 disabled with junk params is inert", [ruleEntry(5, false, withByte(crownParams(0), 10, 9))]],
  ];
  for (const [label, rules] of acceptCases) {
    const res = tryConfigWrite(rules);
    check("write accepted: " + label, okRes(res), JSON.stringify(res.err?.()));
  }
}

// =====================================================================
section("B1 config-write rejects (fail closed at write)");
{
  const seatMint = Keypair.generate().publicKey;
  const badCases = [
    ["rule 5 crown_bps 0", [ruleEntry(5, true, crownParams(0))]],
    ["rule 5 crown_bps > 10000", [ruleEntry(5, true, crownParams(10001))]],
    ["rule 5 nonzero padding byte", [ruleEntry(5, true, withByte(crownParams(500), 10, 1))]],
    ["rule 6 zero seat mint", [ruleEntry(6, true, seatParams(PublicKey.default, 500))]],
    ["rule 6 tithe_bps 0", [ruleEntry(6, true, seatParams(seatMint, 0))]],
    ["rule 6 tithe_bps > 10000", [ruleEntry(6, true, seatParams(seatMint, 10001))]],
    ["rule 6 nonzero padding byte", [ruleEntry(6, true, withByte(seatParams(seatMint, 500), 40, 1))]],
    ["rule 14 start_bps 0", [ruleEntry(14, true, decayParams({ start: 0, floor: 0 }))]],
    ["rule 14 start_bps > 10000", [ruleEntry(14, true, decayParams({ start: 10001, floor: 0 }))]],
    ["rule 14 floor > start", [ruleEntry(14, true, decayParams({ start: 100, floor: 101 }))]],
    ["rule 14 decay_secs 0", [ruleEntry(14, true, decayParams({ decay: 0 }))]],
    ["rule 14 nonzero padding byte", [ruleEntry(14, true, withByte(decayParams({}), 20, 1))]],
    ["rule 15 tithe_bps > 10000", [ruleEntry(15, true, kingTitheParams(10001))]],
    ["rule 15 nonzero padding byte", [ruleEntry(15, true, withByte(kingTitheParams(500), 10, 1))]],
    ["rule 16 threshold 0", [ruleEntry(16, true, buybackParams({ threshold: 0n }))]],
    ["rule 16 caller_cut > 1000", [ruleEntry(16, true, buybackParams({ cut: 1001 }))]],
    ["rule 16 nonzero padding byte", [ruleEntry(16, true, withByte(buybackParams({}), 20, 1))]],
    ["split sum > 10000 across 5+6+15 (5000+4000+2000)", [
      ruleEntry(5, true, crownParams(5000)),
      ruleEntry(6, true, seatParams(seatMint, 4000)),
      ruleEntry(15, true, kingTitheParams(2000)),
    ]],
    ["split sum > 10000 across 5+6 (6000+5000)", [
      ruleEntry(5, true, crownParams(6000)),
      ruleEntry(6, true, seatParams(seatMint, 5000)),
    ]],
    ["split sum > 10000 across 5+15 (9000+2000)", [
      ruleEntry(5, true, crownParams(9000)),
      ruleEntry(15, true, kingTitheParams(2000)),
    ]],
    ["rule 2 Escrow Split still rejected (unimplemented)", [ruleEntry(2, true, Buffer.alloc(64))]],
  ];
  for (const [label, rules] of badCases) {
    const res = tryConfigWrite(rules);
    check("write rejected: " + label, !okRes(res), "unexpectedly accepted");
  }
}

// =====================================================================
section("B2 Execute no-op — stack with 5/6/14/16 transfers pass untouched");
{
  const seatMint = Keypair.generate().publicKey;
  const S = baseScenario([
    ruleEntry(5, true, crownParams(500)),
    ruleEntry(6, true, seatParams(seatMint, 500)),
    ruleEntry(14, true, decayParams({})),
    ruleEntry(16, true, buybackParams({})),
  ]);
  S.mintTo("A", 10000);
  check("plain P2P transfer passes with 5/6/14/16 enabled", okRes(S.transfer("A", "B", 1000, { mask: M.none })));
  check("destination balance reflects the transfer (1000)", S.tokenBal(S.atas.B.ata) === 1000, `bal=${S.tokenBal(S.atas.B.ata)}`);
  check("venue-context transfer passes with 5/6/14/16 enabled", okRes(S.transfer("A", "B", 500, { venue: SHIM, mask: M.none })));
  check("destination balance reflects both transfers (1500)", S.tokenBal(S.atas.B.ata) === 1500, `bal=${S.tokenBal(S.atas.B.ata)}`);
}

// =====================================================================
section("B3 rule 15 tithe param does not change Execute tracking behavior");
{
  const S = baseScenario([ruleEntry(15, true, kingTitheParams(500))]);
  S.mintTo("A", 10000);
  check("transfer passes with king tithe_bps=500 (king mask)", okRes(S.transfer("A", "B", 4000, { mask: M.king })));
  const king = S.accData(kingPda(S.mint));
  check("king PDA was created by the transfer", !!king && king.length > 0);
  check("king tracks the largest holder (B, 4000)", !!king && Number(king.readBigUInt64LE(65)) === 4000, king ? `kingBal=${king.readBigUInt64LE(65)}` : "no king");
}

console.log(`\n==== PHASE B TRIAL: ${total - failed}/${total} passed, ${failed} failed ====`);
if (failures.length) console.log("failures:", failures.join(" | "));
process.exit(failed ? 1 : 0);

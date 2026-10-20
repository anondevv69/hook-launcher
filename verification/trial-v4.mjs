// ============================================================================
// ENGINE V4 TRIAL SUITE — the six Phase A modules (rules 4, 10, 11, 12, 13,
// 15) + config-write validation, against the V4 TRIAL-FLAVOR binary
// (engine/target/engine-trial.so: trial Registry + trial Distributor ids).
// The resting slot target/deploy/engine.so must hold the same trial build
// (the coordinator arranges it; asserted below via hash compare).
//
// Plumbing follows engine/trial-v3.mjs: ComputeBudget prefix, expireBlockhash
// after each send, FailedTransactionMetadata classification, a controllable
// Clock (setTime), and the venueshim program (loaded at three ids: the
// canonical shim id + two clones) for venue-context transfers.
// Deterministic time base: T0 = Mon 2026-10-19 15:30:00 UTC = 10:30 EST —
// inside the HookedPad JOB fixture window (Mon–Fri 09:00–17:00 ET).
//
// Run: node engine/trial-v4.mjs
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

// =====================================================================
section("S0 config-write validation rejects (fail closed at write)");
{
  const badCases = [
    ["rule 12 tz out of range", ruleEntry(12, true, hoursParams({ tz: 60000 }))],
    ["rule 12 empty days mask", ruleEntry(12, true, hoursParams({ days: 0 }))],
    ["rule 12 day bits above Sunday", ruleEntry(12, true, hoursParams({ days: 0x80 }))],
    ["rule 12 start >= end", ruleEntry(12, true, hoursParams({ start: 1020, end: 540 }))],
    ["rule 12 end > 1440", ruleEntry(12, true, hoursParams({ start: 0, end: 1441 }))],
    ["rule 12 scope > 1", ruleEntry(12, true, hoursParams({ scope: 2 }))],
    ["rule 4 empty app list", ruleEntry(4, true, appParams(PublicKey.default))],
    ["rule 10 mode > 2", ruleEntry(10, true, listParams(3))],
    ["rule 11 threshold 0", ruleEntry(11, true, grudgeParams({ bps: 0 }))],
    ["rule 11 threshold > 10000", ruleEntry(11, true, grudgeParams({ bps: 10001 }))],
    ["rule 11 penalty mode > 1", ruleEntry(11, true, grudgeParams({ mode: 2 }))],
    ["rule 11 cap mode with zero cap", ruleEntry(11, true, grudgeParams({ mode: 1, cap: 0 }))],
    ["rule 13 mode > 1", ruleEntry(13, true, vestParams({ mode: 2 }))],
    ["rule 13 no leg configured", ruleEntry(13, true, vestParams({ hold: 0, release: 0 }))],
  ];
  for (const [label, entry] of badCases) {
    // Minimal world: engine + payer + a bare config write attempt.
    const svm = new LiteSVM();
    svm.addProgramFromFile(ENGINE_ID, TRIAL_SO);
    const payer = Keypair.generate();
    svm.airdrop(payer.publicKey, BigInt(10 * LAMPORTS_PER_SOL));
    const mint = Keypair.generate().publicKey;
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix(
      [K(payer.publicKey, true, true), K(mint, false, false), K(cfgPda(mint), false, true), K(SYSTEM, false, false)],
      configPayload(1, payer.publicKey, 0, [entry]),
    ));
    tx.feePayer = payer.publicKey; tx.recentBlockhash = svm.latestBlockhash(); tx.sign(payer);
    const res = svm.sendTransaction(tx);
    check("write rejected: " + label, !okRes(res), JSON.stringify(res.err?.()));
  }
}

// =====================================================================
section("S1 rule 12 Trading Hours — the JOB fixture (Mon–Fri 09:00–17:00 ET)");
{
  // T0 = Monday 10:30 EST: inside. Scope 0 (all transfers).
  const S = baseScenario([ruleEntry(12, true, hoursParams({}))]);
  S.mintTo("POOL", 1_000_000);
  check("Mon 10:30 ET: venue buy passes", okRes(S.transfer("POOL", "A", 1000, { venue: SHIM, mask: M.none })));
  check("Mon 10:30 ET: P2P passes (scope 0 gates all, inside passes)", okRes(S.transfer("A", "B", 100, { mask: M.none })));
  S.setTime(T0 + 8 * 3600); // Monday 18:30 EST — after close
  const rAfter = S.transfer("POOL", "A", 100, { venue: SHIM, mask: M.none });
  check("Mon 18:30 ET: venue buy vetoed (28)", !okRes(rAfter) && customOf(rAfter) === ERR.OutsideTradingHours, `custom=${customOf(rAfter)}`);
  const rP2p = S.transfer("A", "B", 10, { mask: M.none });
  check("Mon 18:30 ET: P2P vetoed too under scope 0 (28)", !okRes(rP2p) && customOf(rP2p) === ERR.OutsideTradingHours, `custom=${customOf(rP2p)}`);
  S.setTime(T0 + 5 * 86400 + 3600); // Saturday 11:30 EST — weekend
  const rSat = S.transfer("POOL", "A", 100, { venue: SHIM, mask: M.none });
  check("Saturday: vetoed (28) despite being inside 9–5 clock hours", !okRes(rSat) && customOf(rSat) === ERR.OutsideTradingHours, `custom=${customOf(rSat)}`);
  S.setTime(T0 + 7 * 86400); // next Monday 10:30 EST
  check("next Monday 10:30 ET: passes again", okRes(S.transfer("POOL", "A", 100, { venue: SHIM, mask: M.none })));
  // Scope 1 variant: P2P exempt from the clock, venue gated.
  const V = baseScenario([ruleEntry(12, true, hoursParams({ scope: 1 }))]);
  V.mintTo("POOL", 1_000_000);
  V.mintTo("A", 500);
  V.setTime(T0 + 8 * 3600); // after close
  check("scope 1: P2P passes after close", okRes(V.transfer("A", "B", 10, { mask: M.none })));
  const rV = V.transfer("POOL", "B", 10, { venue: SHIM, mask: M.none });
  check("scope 1: venue buy still vetoed after close (28)", !okRes(rV) && customOf(rV) === ERR.OutsideTradingHours, `custom=${customOf(rV)}`);
}

// =====================================================================
section("S2 rule 4 App-Gated — receives only via the named app program");
{
  const S = baseScenario(
    [ruleEntry(4, true, appParams(APP_ID))],
    { venues: [APP_ID, OTHER_VENUE, SHIM], exemptions: ["POOL"] },
  );
  S.mintTo("POOL", 1_000_000);
  check("buy via the named app passes", okRes(S.transfer("POOL", "A", 1000, { venue: APP_ID, mask: M.none })));
  const rBad = S.transfer("POOL", "B", 1000, { venue: OTHER_VENUE, mask: M.none });
  check("buy via a non-app venue vetoed AppNotAllowed (32)", !okRes(rBad) && customOf(rBad) === ERR.AppNotAllowed, `custom=${customOf(rBad)}`);
  const rShim = S.transfer("POOL", "B", 1000, { venue: SHIM, mask: M.none });
  check("buy via the plain curve venue also vetoed (32) — app-exclusive", !okRes(rShim) && customOf(rShim) === ERR.AppNotAllowed, `custom=${customOf(rShim)}`);
  check("sell back to the pool passes via any venue (exempt destination)", okRes(S.transfer("A", "POOL", 400, { venue: OTHER_VENUE, mask: M.none })));
  check("P2P is not app-gated (rule 7's domain)", okRes(S.transfer("A", "B", 100, { mask: M.none })));
}

// =====================================================================
section("S3 rule 15 King of the Pool — crowning, refresh-down, re-crown");
{
  const S = baseScenario([ruleEntry(15, true, kingParams())], { exemptions: ["POOL"] });
  S.mintTo("POOL", 10_000);
  const r1 = S.transfer("POOL", "A", 400, { venue: SHIM, mask: M.king });
  const kd = S.accData(kingPda(S.mint));
  check("first buy lands; king PDA lazily created", okRes(r1) && kd !== null && kd.length === 96);
  const readKing = () => {
    const d = S.accData(kingPda(S.mint));
    return { acct: new PublicKey(d.subarray(1, 33)), owner: new PublicKey(d.subarray(33, 65)), bal: Number(d.readBigUInt64LE(65)) };
  };
  let k = readKing();
  check("king = A @ 400", k.acct.equals(S.atas.A.ata) && k.owner.equals(S.atas.A.owner.publicKey) && k.bal === 400, `bal=${k.bal}`);
  S.transfer("POOL", "B", 600, { venue: SHIM, mask: M.king });
  k = readKing();
  check("king = B @ 600 after bigger buy", k.acct.equals(S.atas.B.ata) && k.bal === 600);
  S.transfer("POOL", "A", 300, { venue: SHIM, mask: M.king }); // A: 400 -> 700
  k = readKing();
  check("king = A @ 700 after A tops up", k.acct.equals(S.atas.A.ata) && k.bal === 700);
  S.transfer("A", "POOL", 200, { venue: SHIM, mask: M.king }); // A: 700 -> 500
  k = readKing();
  check("king refreshes DOWN when the king sells (A @ 500)", k.acct.equals(S.atas.A.ata) && k.bal === 500, `bal=${k.bal}`);
  S.transfer("POOL", "B", 50, { venue: SHIM, mask: M.king }); // B: 600 -> 650
  k = readKing();
  check("king re-crowned to B @ 650", k.acct.equals(S.atas.B.ata) && k.bal === 650, `bal=${k.bal}`);
  check("king module never vetoes a P2P transfer", okRes(S.transfer("A", "B", 10, { mask: M.king })));
}

// =====================================================================
section("S4 rule 10 blocklist leg (mode 0) — write, veto, replace, Locked seal");
{
  const writeList = (S, signer, entries) => S.sendIx(ix(
    [K(signer.publicKey, true, true), K(S.mint, false, false), K(cfgPda(S.mint), false, false), K(listsPda(S.mint), false, true), K(SYSTEM, false, false)],
    Buffer.concat([Buffer.from([12, entries.length]), ...entries.map((e) => e.toBuffer())]),
  ), signer);
  const S = baseScenario([ruleEntry(10, true, listParams(0))], { mode: 1, exemptions: ["POOL"] }); // Creator mode
  S.mintTo("POOL", 1_000_000);
  check("no list written yet: receives pass (empty list)", okRes(S.transfer("POOL", "A", 1000, { venue: SHIM, mask: M.listsMode0 })));
  check("authority writes the blocklist (B blocked)", okRes(writeList(S, S.payer, [S.atas.B.owner.publicKey])));
  const rB = S.transfer("POOL", "B", 100, { venue: SHIM, mask: M.listsMode0 });
  check("blocklisted owner receive vetoed Blocklisted (31)", !okRes(rB) && customOf(rB) === ERR.Blocklisted, `custom=${customOf(rB)}`);
  check("unlisted owner still receives", okRes(S.transfer("POOL", "A", 100, { venue: SHIM, mask: M.listsMode0 })));
  const stranger = Keypair.generate();
  S.svm.airdrop(stranger.publicKey, BigInt(LAMPORTS_PER_SOL));
  const rBad = writeList(S, stranger, [S.atas.A.owner.publicKey]);
  check("non-authority write rejected (BadAuthority 5)", !okRes(rBad) && customOf(rBad) === ERR.BadAuthority, `custom=${customOf(rBad)}`);
  check("authority may REPLACE under Creator mode", okRes(writeList(S, S.payer, [S.atas.A.owner.publicKey])));
  const rA = S.transfer("POOL", "A", 100, { venue: SHIM, mask: M.listsMode0 });
  check("replaced list now blocks A (31)", !okRes(rA) && customOf(rA) === ERR.Blocklisted, `custom=${customOf(rA)}`);
  // Locked seal.
  const L = baseScenario([ruleEntry(10, true, listParams(0))], { mode: 0, exemptions: ["POOL"] });
  check("Locked: first blocklist write lands", okRes(writeList(L, L.payer, [L.atas.B.owner.publicKey])));
  const rSeal = writeList(L, L.payer, [L.atas.A.owner.publicKey]);
  check("Locked: second write refused — sealed (AlreadyInit 14)", !okRes(rSeal) && customOf(rSeal) === ERR.AlreadyInit, `custom=${customOf(rSeal)}`);
}

// =====================================================================
section("S5 rule 10 allowlist leg (mode 1) — entry required, revocable, Locked-manageable");
{
  const S = baseScenario([ruleEntry(10, true, listParams(1))], { mode: 0, exemptions: ["POOL"] }); // Locked config
  S.mintTo("POOL", 1_000_000);
  const rNone = S.transfer("POOL", "A", 100, { venue: SHIM, mask: M.allowMode1 });
  check("no entry: receive vetoed NotAllowlisted (30)", !okRes(rNone) && customOf(rNone) === ERR.NotAllowlisted, `custom=${customOf(rNone)}`);
  const setEntry = (targetAta, active, signer = S.payer) => S.sendIx(ix(
    [K(signer.publicKey, true, true), K(S.mint, false, false), K(cfgPda(S.mint), false, false), K(targetAta, false, false), K(allowPda(S.mint, targetAta), false, true), K(SYSTEM, false, false)],
    Buffer.from([13, active]),
  ), signer);
  check("authority sets A's entry active", okRes(setEntry(S.atas.A.ata, 1)));
  check("active entry: receive passes", okRes(S.transfer("POOL", "A", 100, { venue: SHIM, mask: M.allowMode1 })));
  check("authority revokes A's entry (manageable even under Locked)", okRes(setEntry(S.atas.A.ata, 0)));
  const rRev = S.transfer("POOL", "A", 100, { venue: SHIM, mask: M.allowMode1 });
  check("inactive entry: vetoed (30)", !okRes(rRev) && customOf(rRev) === ERR.NotAllowlisted, `custom=${customOf(rRev)}`);
  check("B has no entry either: vetoed (30)", !okRes(S.transfer("POOL", "B", 100, { venue: SHIM, mask: M.allowMode1 })));
}

// =====================================================================
section("S6 rule 11 Grudge — dump marks; ban, cap, expiry, escalation");
{
  const S = baseScenario([ruleEntry(11, true, grudgeParams({ bps: 5000 }))], { exemptions: ["POOL"] });
  S.mintTo("POOL", 10_000_000);
  const hA = () => S.accData(holderPda(S.mint, S.atas.A.ata));
  check("buy 1000 passes (receive leg: unmarked)", okRes(S.transfer("POOL", "A", 1000, { venue: SHIM, mask: M.grudge })));
  check("sell 400 of 1000 (40% < 50%: no mark)", okRes(S.transfer("A", "POOL", 400, { venue: SHIM, mask: M.grudge })));
  check("window state: bag 1000, sold 400, unmarked", Number(hA().readBigUInt64LE(127)) === 1000 && Number(hA().readBigUInt64LE(63)) === 400 && hA().readBigInt64LE(119) === 0n);
  check("sell 200 more (600/1000 = 60%: MARK)", okRes(S.transfer("A", "POOL", 200, { venue: SHIM, mask: M.grudge })));
  {
    const until = Number(hA().readBigInt64LE(119));
    check("mark: until = now + 86400, offenses 1, window reset", until === T0 + 86400 && hA()[135] === 1 && Number(hA().readBigUInt64LE(127)) === 0, `until-T0=${until - T0} off=${hA()[135]}`);
  }
  const rBan = S.transfer("POOL", "A", 10, { venue: SHIM, mask: M.grudge });
  check("marked wallet buy vetoed GrudgeMarked (27)", !okRes(rBan) && customOf(rBan) === ERR.GrudgeMarked, `custom=${customOf(rBan)}`);
  check("marked wallet can still SELL (penalty is buy-side)", okRes(S.transfer("A", "POOL", 100, { venue: SHIM, mask: M.grudge })));
  check("unmarked wallet buys fine", okRes(S.transfer("POOL", "B", 10, { venue: SHIM, mask: M.grudge })));
  check("marked wallet P2P receive passes (not a buy)", okRes(S.transfer("B", "A", 5, { mask: M.grudge })));
  // Expiry + escalation: jump past the mark, dump again -> offense 2 = 2x.
  S.setTime(T0 + 86401);
  check("after mark expiry: buy passes again", okRes(S.transfer("POOL", "A", 1000, { venue: SHIM, mask: M.grudge })));
  // A balance now: 1000-400-200-100+5+1000 = 1305. Sell 700 = 53.6% of the new window bag (1305).
  check("second dump lands (marks again)", okRes(S.transfer("A", "POOL", 700, { venue: SHIM, mask: M.grudge })));
  {
    const until2 = Number(hA().readBigInt64LE(119));
    check("escalation: offense 2 -> duration 2 x 86400", until2 === T0 + 86401 + 2 * 86400 && hA()[135] === 2, `until2-now=${until2 - (T0 + 86401)} off=${hA()[135]}`);
  }
  // Cap mode.
  const C = baseScenario([ruleEntry(11, true, grudgeParams({ bps: 5000, mode: 1, cap: 100 }))], { exemptions: ["POOL"] });
  C.mintTo("POOL", 10_000_000);
  C.transfer("POOL", "A", 1000, { venue: SHIM, mask: M.grudge });
  C.transfer("A", "POOL", 600, { venue: SHIM, mask: M.grudge }); // 60% dump -> marked
  check("cap mode: buy of exactly the cap (100) passes while marked", okRes(C.transfer("POOL", "A", 100, { venue: SHIM, mask: M.grudge })));
  const rCap = C.transfer("POOL", "A", 101, { venue: SHIM, mask: M.grudge });
  check("cap mode: buy over cap vetoed (27)", !okRes(rCap) && customOf(rCap) === ERR.GrudgeMarked, `custom=${customOf(rCap)}`);
}

// =====================================================================
section("S7 rule 13 Vesting Clock — global leg, linear schedule, cliff, growth");
{
  // (a) global release in the future: fully locked until then.
  const G = baseScenario([ruleEntry(13, true, vestParams({ mode: 1, hold: 0, release: T0 + 86400 }))], { exemptions: ["POOL"] });
  G.mintTo("POOL", 10_000_000);
  const rG = G.transfer("POOL", "A", 1000, { venue: SHIM, mask: M.vesting });
  const hG = G.accData(holderPda(G.mint, G.atas.A.ata));
  check("receive creates a 224B v4 holder, anchor = T0", okRes(rG) && hG !== null && hG.length === HOLDER_SPACE_V3 && Number(hG.readBigInt64LE(192)) === T0, `len=${hG?.length} anchor=${hG ? Number(hG.readBigInt64LE(192)) : "?"}`);
  const rL = G.transfer("A", "B", 1, { mask: M.vesting });
  check("before global release: 1 token out vetoed (29)", !okRes(rL) && customOf(rL) === ERR.VestingLocked, `custom=${customOf(rL)}`);
  G.setTime(T0 + 86400);
  check("at global release: full bag moves", okRes(G.transfer("A", "B", 1000, { mask: M.vesting })));
  // (b) linear per-holder schedule, hold 3600s.
  const L = baseScenario([ruleEntry(13, true, vestParams({ mode: 1, hold: 3600 }))], { exemptions: ["POOL"] });
  L.mintTo("POOL", 10_000_000);
  L.transfer("POOL", "A", 1000, { venue: SHIM, mask: M.vesting });
  L.setTime(T0 + 1800); // half-way: 50% unlocked of pre-transfer balance
  const rHalf = L.transfer("A", "B", 501, { mask: M.vesting });
  check("linear @50%: sending 501 of 1000 vetoed (29)", !okRes(rHalf) && customOf(rHalf) === ERR.VestingLocked, `custom=${customOf(rHalf)}`);
  check("linear @50%: sending exactly 500 passes", okRes(L.transfer("A", "B", 500, { mask: M.vesting })));
  L.setTime(T0 + 3600); // schedule complete for the original anchor
  check("linear @100%: remainder moves (anchor did not re-lock on partial sell)", okRes(L.transfer("A", "B", 500, { mask: M.vesting })));
  // (c) cliff mode.
  const Cf = baseScenario([ruleEntry(13, true, vestParams({ mode: 0, hold: 3600 }))], { exemptions: ["POOL"] });
  Cf.mintTo("POOL", 10_000_000);
  Cf.transfer("POOL", "A", 100, { venue: SHIM, mask: M.vesting });
  Cf.setTime(T0 + 3599);
  const rCliff = Cf.transfer("A", "B", 1, { mask: M.vesting });
  check("cliff @3599s: 1 token vetoed (29)", !okRes(rCliff) && customOf(rCliff) === ERR.VestingLocked, `custom=${customOf(rCliff)}`);
  Cf.setTime(T0 + 3600);
  check("cliff @3600s: full bag released at once", okRes(Cf.transfer("A", "B", 100, { mask: M.vesting })));
  // (d) legacy 136B holder grows to 224B on first v4 receive.
  const D = baseScenario([ruleEntry(13, true, vestParams({ mode: 1, hold: 3600 }))], { exemptions: ["POOL"] });
  D.mintTo("POOL", 10_000_000);
  const initH = ix(
    [K(D.payer.publicKey, true, true), K(D.mint, false, false), K(D.atas.B.ata, false, false), K(holderPda(D.mint, D.atas.B.ata), false, true), K(SYSTEM, false, false)],
    Buffer.from([3]),
  );
  check("legacy holder pre-created at 136B", okRes(D.sendIx(initH, D.payer)) && D.accData(holderPda(D.mint, D.atas.B.ata)).length === 136);
  D.mintTo("B", 500);
  const rD = D.transfer("POOL", "B", 100, { venue: SHIM, mask: M.vesting });
  const hD = D.accData(holderPda(D.mint, D.atas.B.ata));
  check("first v4 receive grows 136 -> 224 and anchors at T0", okRes(rD) && hD.length === HOLDER_SPACE_V3 && Number(hD.readBigInt64LE(192)) === T0, `len=${hD?.length}`);
}

// =====================================================================
console.log(`\nV4 TRIAL: ${total - failed}/${total} passed${failed ? " — FAILURES: " + failures.join(" | ") : ""}`);
process.exit(failed ? 1 : 0);

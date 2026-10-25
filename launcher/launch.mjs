#!/usr/bin/env node
// launch.mjs — Hook Launcher: launch a ruled token on Meteora DBC with the
// hook ENGINE attached. Single file; deps: @solana/web3.js, @solana/spl-token,
// @meteora-ag/dynamic-bonding-curve-sdk, bn.js.
//
//   node launch.mjs <spec.json> --dry-run           print the ordered plan, send nothing
//   node launch.mjs <spec.json> [--out record.json] execute the launch (needs --rpc + keypair)
//   node launch.mjs <spec.json> --template agent|human [--dry-run]
//                                                    merge a branch template (templates.mjs —
//                                                    SPEC-AGENTONLY §7 Fork B defaults) UNDER the
//                                                    spec's own fields before validating
//   node launch.mjs --print-template agent|human   print a branch template as JSON and exit
//
// Env: LAUNCH_KEYPAIR (keypair JSON path, default ~/.launch_keypair.json)
//      LAUNCH_RPC     (RPC endpoint; required unless --dry-run)
//
// Canonical sequence (DBC-INTEGRATION.md, adapted to engine tail v2 —
// BUILD-NOTES.md §"What the DBC integration workstream needs"):
//   L1 DBC config naming the ENGINE (fee_claimer = launcher wallet)
//   L2 DBC pool; the base mint is created carrying the ENGINE hook
//   L3 engine InitializeConfig (DBC in venue allowlist; pool authority + base
//      vault in exemptions — pool-side flows never self-block)
//   L4 engine InitializeExtraAccountMetas (templated per config — only the
//      extras the enabled rules require; see requiredExtras below)
//   L4b engine InitializePriceFeed — only when rule 1 (Basis Latch) is enabled
//   L5 fund the rent-vault PDA (pays for lazily created Holder PDAs)
//   L6 (advisory, per buyer) pre-create the buyer's base ATA before their
//      first swap build — build-time meta resolution reads it
//   L7 Distributor initialize (+ fee vault ATA) — only when holder-fees on
//
// Rule stacks are validated against the IMPLEMENTED set generated from
// the engine source (bin/gen-rules.mjs -> browser-src/rules.generated.mjs)
// — the same source of truth the composer uses, so the CLI, the browser
// composer, and the engine can never drift apart (trial-rule-parity (c)).
// An unimplemented or unknown rule id is a hard error — never silently dropped.
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { createHash, randomBytes, createPrivateKey, sign as cryptoSign } from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
process.on('uncaughtException', (e) => { console.error('launch error:', e.message); process.exit(1); });
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, createTransferCheckedWithTransferHookInstruction, createSyncNativeInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { IMPLEMENTED_IDS } from './browser-src/rules.generated.mjs';
import { buildBranchSpec, BRANCH_TEMPLATES } from './templates.mjs';
import { LAUNCH_TAG_SECRET } from './browser-src/tag.mjs';
import bs58 from 'bs58';
import BN from 'bn.js';
import {
  DynamicBondingCurveClient, buildCurve, TokenType, TokenDecimal,
  ActivationType, BaseFeeMode, CollectFeeMode, MigrationOption,
  MigrationFeeOption, TokenAuthorityOption, SwapMode, deriveDbcPoolAddress,
  deriveDbcPoolAuthority, deriveDbcTokenVaultAddress, derivePartnerMetadata,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

// ---------- program identities (MAINNET, deployed 2026-10-15 — see ../deploy/DEPLOY-RECORD.md) ----------
const ENGINE = new PublicKey('EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT');
const REGISTRY = new PublicKey('GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e');
const DISTRIBUTOR = new PublicKey('DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa');
const DBC_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const T22 = TOKEN_2022_PROGRAM_ID;
const INIT_METAS_DISC = Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]);
// ---------- house venue (Phase C) ----------
// HOUSE_SWAP_PROGRAM_ID — the houseswap program (contract PHASE-C §2/§3.1):
// MAINNET id, set at the C2 deploy window (2026-10-20, deploy record
// deploy/DEPLOY-RECORD-C-RUN.md): fresh mainnet keypair, program
// 8aeCfKabRfbXrLY68CXbsgp3x7mgikjwgMF3d7oY1Y8h, live ELF byte-exact vs
// the frozen Phase C artifact (sha256 12430c61…). The DEV / TRIAL id
// 8Ugv9hn6wbjNddxqEpHzwM1pDdvYQxeX72KC7qzcxqXx must never be used here.
const HOUSE_SWAP_PROGRAM_ID = new PublicKey('8aeCfKabRfbXrLY68CXbsgp3x7mgikjwgMF3d7oY1Y8h');
// ---------- launch signer (Phase 4 Feature A; HookedPad shape
// verified 2026-10-17 — deploy/HOOKED-DISTRIBUTION-MAP.md) ----------
// LAUNCH_SIGNER is this platform's constant attribution wallet: a
// dedicated, fundless keypair (deploy/launcher-tag.json, mode 600,
// never funded, never used for anything else) that co-signs EVERY
// launch's creation transactions READ-ONLY. The placement copies the
// verified HookedPad shape (BADGER creation tx 2mHbaajf…, decoded
// 2026-10-17): their platform wallet (HookAsdGBN9…) sits in the
// creation transaction's signer set, read-only, referenced by NO
// create instruction — a pure fingerprint any indexer can scan for
// (getSignaturesForAddress on the signer enumerates every launch).
// Ours: the signer co-signs BOTH creation transactions read-only,
// and each appends ONE extra instruction — an SPL Memo v2 memo
// (fixed marker text, identical on every launch) whose only signer
// is the launch signer, a human- and indexer-readable label riding
// the same signature. One honest deviation from BADGER's exact form,
// forced by our signing stack: their signer is referenced by no
// instruction at all, but the legacy @solana/web3.js compiler our
// sender (and the browser bundle) is built on REJECTS an unreferenced
// signer ("unknown signer" at compileMessage), so the memo is the
// vehicle that carries the signature into the compiled message. The
// placement that discovery actually reads — a read-only signer in the
// creation transaction's signer set, enumerable by signature scan —
// is identical; no create instruction references the signer on either
// side (proven on compiled messages in trial-launch-features.mjs §G). The signer holds
// no authority over any pool, config, or token, and pays no fee (the
// launcher wallet is always the fee payer). Scope note: the tag
// applies to FUTURE launches — existing tokens' creation transactions
// are immutable history (their records predate or carry it as built).
// Verification note: the tag is a LABEL, not an attestation — anyone
// could copy the marker text, and the tag key's only power is signing
// launch transactions read-only; the real attestation for a launch
// remains on-chain: the token's engine Config PDA and meta list.
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const LAUNCH_TAG_MARKER = 'hook-launcher:v1';

// ---------- measured rents (BUILD-NOTES.md / INTEGRATION.md docs) ----------
const RENT = {
  configPda: 0.008463, metaList: 0.002707, priceFeed: 0.001837,
  distState: 0.002116, tokenAccount: 0.002039, holderPda: 0.001837,
};
// Meta-list rent is TEMPLATED (engine Phase 2): the account holds exactly
// the config's required extras. TLV size = 12-byte base + 4-byte slice
// header + 35 bytes per entry (7 entries = 261 B, the legacy superset);
// rent-exempt minimum = (size + 128) * 6960 lamports.
function metaListSize(count) { return 16 + 35 * count; }
function metaListRent(count) { return (metaListSize(count) + 128) * 6960 / 1e9; }

// ---------- rule catalog: implemented set + param encoders ----------
const RULE_NAMES = { 1: 'Basis Latch', 2: 'Escrow Split', 3: 'Agent-Only', 4: 'App-Gated', 5: 'Crown Beneficiary', 6: 'Tithe Seat', 7: 'P2P Toggle', 8: 'Holder-Gated', 9: 'Max Wallet', 10: 'Allow/Blocklist', 11: 'The Grudge', 12: 'Trading Hours', 13: 'Vesting Clock', 14: 'Decay Tax', 15: 'King of the Pool', 16: 'Buyback & Burn', 17: 'Ecosystem Gate' };
const NAME_TO_ID = { 'basis-latch': 1, 'escrow-split': 2, 'agent-only': 3, 'app-gated': 4, 'crown-beneficiary': 5, 'tithe-seat': 6, 'p2p': 7, 'p2p-toggle': 7, 'holder-gated': 8, 'max-wallet': 9, 'allow-blocklist': 10, 'allowlist': 10, 'blocklist': 10, 'grudge': 11, 'the-grudge': 11, 'trading-hours': 12, 'vesting-clock': 13, 'decay-tax': 14, 'king-of-the-pool': 15, 'king': 15, 'buyback-burn': 16, 'buyback-and-burn': 16, 'buyback': 16, 'ecosystem-gate': 17, 'muse-only': 17, 'fomo-only': 17, 'claude-only': 17, 'grok-only': 17 };
const IMPLEMENTED = new Set(IMPLEMENTED_IDS); // GENERATED set (engine rule_implemented() via bin/gen-rules.mjs) — never hand-edit; all three surfaces agree by construction
const ECOSYSTEM_IDS = { muse: 1, fomo: 2, claude: 3, grok: 4 };
const ECOSYSTEM_ALIAS_IDS = { 'muse-only': 1, 'fomo-only': 2, 'claude-only': 3, 'grok-only': 4 };
const MODES = { locked: 0, creator: 1, agent: 2, holdervote: 3, 'holder-vote': 3 };

function ruleIdOf(entry) {
  if (entry.id != null) return Number(entry.id);
  if (entry.rule) { const id = NAME_TO_ID[String(entry.rule).toLowerCase()]; if (id) return id; }
  if (entry.name) { const id = NAME_TO_ID[String(entry.name).toLowerCase().replace(/\s+/g, '-')]; if (id) return id; }
  throw new Error(`rule entry has no recognizable id/rule/name: ${JSON.stringify(entry)}`);
}
function encodeParams(id, entry) {
  const p = Buffer.alloc(64);
  if (id === 1) { // Basis Latch: max_stale u64 @0, half_life u64 @8, max_crank_bps u16 @16,
    // mode u8 @18 (0 LATCH / 1 LIVE / 2 GRADUATED), base_frac_bps u16 @19,
    // vesting_secs u64 @21, dip_mult_bps u16 @29 (SPEC-GRADUATED-LATCH §5;
    // 0 for vesting/dip takes the engine defaults 432000 / 20000; base 0 = no base)
    p.writeBigUInt64LE(BigInt(entry.maxStaleSecs ?? 0), 0);
    p.writeBigUInt64LE(BigInt(entry.emaHalfLifeSecs ?? 0), 8);
    p.writeUInt16LE(entry.maxCrankBps ?? 0, 16);
    const m = entry.mode == null ? 'latch' : String(entry.mode).toLowerCase();
    if (!['latch', 'live', 'graduated'].includes(m)) throw new Error(`rule 1 mode must be "latch", "live" or "graduated", got ${entry.mode}`);
    p[18] = m === 'live' ? 1 : m === 'graduated' ? 2 : 0;
    const baseFrac = entry.baseFracBps ?? 0;
    if (!Number.isInteger(baseFrac) || baseFrac < 0 || baseFrac > 10000) throw new Error('rule 1 baseFracBps must be an integer in 0..10000');
    p.writeUInt16LE(baseFrac, 19);
    p.writeBigUInt64LE(BigInt(entry.vestingSecs ?? 0), 21);
    const dipMult = entry.dipMultBps ?? 0;
    if (!Number.isInteger(dipMult) || dipMult < 0 || dipMult > 65535) throw new Error('rule 1 dipMultBps must be an integer in 0..65535');
    p.writeUInt16LE(dipMult, 29);
  } else if (id === 2) { // Escrow Split (venue-side): split_bps u16 @0, params[2..64] zero.
    // The ENGINE never enforces rule 2 (Execute is a no-op for it); the house
    // venue reads split_bps from the Config PDA at swap time. Default 5000.
    const bps = entry.splitBps ?? 5000;
    if (!Number.isInteger(bps) || bps < 1 || bps > 10000) throw new Error('rule 2 (Escrow Split) requires splitBps in 1..10000');
    p.writeUInt16LE(bps, 0);
  } else if (id === 4) { // App-Gated: app1 pubkey @0..32, app2 pubkey @32..64.
    // Venue-context receives pass only when the calling program is one of
    // the listed apps; at least one app is required (the engine rejects an
    // all-zero list at config write). entry.apps (array of 1..2 base58) or
    // entry.app1 / entry.app2.
    const apps = entry.apps ?? [entry.app1, entry.app2].filter((x) => x != null);
    if (!Array.isArray(apps) || apps.length < 1 || apps.length > 2) throw new Error('rule 4 (App-Gated) requires one or two app program ids: entry.apps (array) or entry.app1 / entry.app2');
    apps.forEach((a, i) => {
      const pk = new PublicKey(a); // throws on a malformed base58 id
      if (pk.equals(PublicKey.default)) throw new Error('rule 4 (App-Gated) app program id must not be the zero pubkey');
      pk.toBuffer().copy(p, i * 32);
    });
  } else if (id === 5) { // Crown Beneficiary: crown_bps u16 @0 (the
    // Distributor split carve to the Crown PDA's current beneficiary).
    const bps = entry.crownBps ?? 500;
    if (!Number.isInteger(bps) || bps < 1 || bps > 10000) throw new Error('rule 5 (Crown Beneficiary) requires crownBps in 1..10000');
    p.writeUInt16LE(bps, 0);
  } else if (id === 6) { // Tithe Seat: seat_mint pubkey @0..32, tithe_bps u16 @32.
    if (!entry.seatMint) throw new Error('rule 6 (Tithe Seat) requires seatMint (the seat NFT mint whose current holder receives the tithe)');
    const seat = new PublicKey(entry.seatMint);
    if (seat.equals(PublicKey.default)) throw new Error('rule 6 (Tithe Seat) seatMint must not be the zero pubkey');
    seat.toBuffer().copy(p, 0);
    const bps = entry.titheBps ?? 300;
    if (!Number.isInteger(bps) || bps < 1 || bps > 10000) throw new Error('rule 6 (Tithe Seat) requires titheBps in 1..10000');
    p.writeUInt16LE(bps, 32);
  } else if (id === 10) { // Allow/Blocklist: mode u8 @0 (0 = blocklist only,
    // 1 = allowlist only, 2 = both). The lists themselves live in PDAs and
    // are written post-launch (engine tags 12/13), not in the config params.
    const m = entry.mode == null ? 'both' : String(entry.mode).toLowerCase();
    const mode = { blocklist: 0, allowlist: 1, both: 2 }[m] ?? (Number.isInteger(entry.mode) ? entry.mode : null);
    if (mode == null || mode < 0 || mode > 2) throw new Error('rule 10 (Allow/Blocklist) requires mode: "blocklist", "allowlist" or "both"');
    p[0] = mode;
  } else if (id === 11) { // Grudge: dump_threshold_bps u16 @0, window_secs
    // u64 @2 (0 = 86400), penalty_duration_secs u64 @10 (0 = 86400),
    // penalty_mode u8 @18 (0 = buy-ban, 1 = buy-cap), buy_cap_amount u64
    // @19 (required when capped), max_escalation u8 @27 (0 = 4).
    const bps = entry.dumpThresholdBps ?? 5000;
    if (!Number.isInteger(bps) || bps < 1 || bps > 10000) throw new Error('rule 11 (Grudge) requires dumpThresholdBps in 1..10000');
    p.writeUInt16LE(bps, 0);
    p.writeBigUInt64LE(BigInt(entry.windowSecs ?? 0), 2);
    p.writeBigUInt64LE(BigInt(entry.penaltyDurationSecs ?? 0), 10);
    const pm = entry.penaltyMode == null ? 'ban' : String(entry.penaltyMode).toLowerCase();
    const penaltyMode = { ban: 0, 'buy-ban': 0, cap: 1, 'buy-cap': 1 }[pm] ?? (Number.isInteger(entry.penaltyMode) ? entry.penaltyMode : null);
    if (penaltyMode == null || penaltyMode < 0 || penaltyMode > 1) throw new Error('rule 11 (Grudge) requires penaltyMode: "ban" or "cap"');
    p[18] = penaltyMode;
    const capAmt = BigInt(entry.buyCapAmount ?? 0);
    if (penaltyMode === 1 && capAmt === 0n) throw new Error('rule 11 (Grudge) buy-cap penalty mode requires buyCapAmount (raw token units)');
    p.writeBigUInt64LE(capAmt, 19);
    const esc = entry.maxEscalation ?? 0;
    if (!Number.isInteger(esc) || esc < 0 || esc > 255) throw new Error('rule 11 (Grudge) maxEscalation must be an integer in 0..255 (0 = engine default 4)');
    p[27] = esc;
  } else if (id === 12) { // Trading Hours: tz_offset_secs i32 @0,
    // days_mask u8 @4 (bit0 = Mon .. bit6 = Sun), window_start_min u16 @5,
    // window_end_min u16 @7, scope u8 @9 (0 = all transfers, 1 = venue
    // only). Defaults are the JOB reference fixture: Mon-Fri 09:00-17:00
    // at UTC-5 (fixed offset — no DST, the documented limitation).
    const tz = entry.tzOffsetSecs ?? -18000;
    if (!Number.isInteger(tz) || tz < -43200 || tz > 50400) throw new Error('rule 12 (Trading Hours) requires tzOffsetSecs in -43200..50400');
    p.writeInt32LE(tz, 0);
    const mask = entry.daysMask ?? 0x1f;
    if (!Number.isInteger(mask) || mask < 1 || mask > 0x7f) throw new Error('rule 12 (Trading Hours) requires daysMask in 1..127 (bit0 = Mon .. bit6 = Sun, at least one day)');
    p[4] = mask;
    const start = entry.windowStartMin ?? 540;
    const end = entry.windowEndMin ?? 1020;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > 1440) throw new Error('rule 12 (Trading Hours) requires windowStartMin < windowEndMin <= 1440 (minutes after local midnight)');
    p.writeUInt16LE(start, 5);
    p.writeUInt16LE(end, 7);
    const scope = entry.scope ?? 0;
    if (!Number.isInteger(scope) || scope < 0 || scope > 1) throw new Error('rule 12 (Trading Hours) scope must be 0 (all transfers) or 1 (venue transfers only)');
    p[9] = scope;
  } else if (id === 13) { // Vesting Clock: mode u8 @0 (0 = cliff,
    // 1 = linear), hold_secs u64 @8, release_ts i64 @16. At least one leg
    // (hold period or global release time) must be set.
    const m = entry.mode == null ? 'cliff' : String(entry.mode).toLowerCase();
    const mode = { cliff: 0, linear: 1 }[m] ?? (Number.isInteger(entry.mode) ? entry.mode : null);
    if (mode == null || mode < 0 || mode > 1) throw new Error('rule 13 (Vesting Clock) requires mode: "cliff" or "linear"');
    p[0] = mode;
    const hold = BigInt(entry.holdSecs ?? 0);
    const rel = BigInt(entry.releaseTs ?? 0);
    if (hold === 0n && rel === 0n) throw new Error('rule 13 (Vesting Clock) requires holdSecs and/or releaseTs — a vesting clock with neither leg never unlocks');
    p.writeBigUInt64LE(hold, 8);
    p.writeBigInt64LE(rel, 16);
  } else if (id === 14) { // Decay Tax: start_bps u16 @0, floor_bps u16 @2,
    // decay_secs u64 @4. Mint-wide linear schedule (the Transfer Fee
    // extension rate is mint-wide — per-holder decay is not expressible).
    const start = entry.startBps ?? 500;
    const floor = entry.floorBps ?? 100;
    if (!Number.isInteger(start) || start < 1 || start > 10000) throw new Error('rule 14 (Decay Tax) requires startBps in 1..10000');
    if (!Number.isInteger(floor) || floor < 0 || floor > start) throw new Error('rule 14 (Decay Tax) requires floorBps in 0..startBps');
    p.writeUInt16LE(start, 0);
    p.writeUInt16LE(floor, 2);
    const decay = BigInt(entry.decaySecs ?? 2592000);
    if (decay === 0n) throw new Error('rule 14 (Decay Tax) requires a positive decaySecs');
    p.writeBigUInt64LE(decay, 4);
  } else if (id === 15) { // King of the Pool: tithe_bps u16 @0
    // (0 = tracking only; > 0 also routes that share of the Distributor
    // split to the current king at settlement).
    const bps = entry.titheBps ?? 0;
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new Error('rule 15 (King of the Pool) requires titheBps in 0..10000 (0 = tracking only)');
    p.writeUInt16LE(bps, 0);
  } else if (id === 16) { // Buyback & Burn: threshold_lamports u64 @0,
    // caller_cut_bps u16 @8. Threshold via thresholdSol or thresholdLamports.
    const lamports = entry.thresholdLamports != null ? BigInt(entry.thresholdLamports)
      : BigInt(Math.round((entry.thresholdSol ?? 1) * LAMPORTS_PER_SOL));
    if (lamports <= 0n) throw new Error('rule 16 (Buyback & Burn) requires a positive threshold (thresholdSol or thresholdLamports)');
    p.writeBigUInt64LE(lamports, 0);
    const cut = entry.callerCutBps ?? 100;
    if (!Number.isInteger(cut) || cut < 0 || cut > 1000) throw new Error('rule 16 (Buyback & Burn) requires callerCutBps in 0..1000');
    p.writeUInt16LE(cut, 8);
  } else if (id === 7) { // P2P Toggle: [0] 0 = P2P-only / 1 = No-P2P
    const m = String(entry.mode ?? '').toLowerCase();
    if (!['p2p-only', 'no-p2p'].includes(m)) throw new Error('rule 7 (P2P Toggle) requires mode: "p2p-only" or "no-p2p"');
    p[0] = m === 'no-p2p' ? 1 : 0;
  } else if (id === 8) { // Holder-Gated: gate mint @0..32, min_amount u64 @32
    if (!entry.gateMint) throw new Error('rule 8 (Holder-Gated) requires gateMint');
    new PublicKey(entry.gateMint).toBuffer().copy(p, 0);
    let raw;
    if (entry.minAmountRaw != null) raw = BigInt(entry.minAmountRaw);
    else if (entry.minAmount != null && entry.gateDecimals != null) raw = BigInt(Math.round(Number(entry.minAmount) * 10 ** Number(entry.gateDecimals)));
    else throw new Error('rule 8 (Holder-Gated) requires minAmountRaw, or minAmount + gateDecimals');
    p.writeBigUInt64LE(raw, 32);
  } else if (id === 9) { // Max Wallet: cap_bps u16 @0
    const bps = entry.capBps ?? entry.maxBps;
    if (bps == null || !(Number(bps) > 0 && Number(bps) <= 10000)) throw new Error('rule 9 (Max Wallet) requires capBps in 1..10000');
    p.writeUInt16LE(Number(bps), 0);
  } else if (id === 17) { // Ecosystem Gate: params[0] = required ecosystem id (u8, 1..16)
    let ecoId = null;
    if (entry.ecosystem != null) {
      if (typeof entry.ecosystem === 'number') {
        ecoId = entry.ecosystem;
      } else if (typeof entry.ecosystem === 'string') {
        const s = entry.ecosystem.trim().toLowerCase();
        if (ECOSYSTEM_IDS.hasOwnProperty(s)) ecoId = ECOSYSTEM_IDS[s];
        else if (/^\d+$/.test(s)) ecoId = Number(s);
      }
      if (ecoId == null || !Number.isInteger(ecoId) || ecoId < 1 || ecoId > 16) throw new Error(`rule 17 (Ecosystem Gate) requires ecosystem: "muse" (1), "fomo" (2), "claude" (3), "grok" (4), or a number 1..16, got ${JSON.stringify(entry.ecosystem)}`);
    } else {
      const aliasRaw = entry.rule ?? entry.name ?? '';
      const alias = String(aliasRaw).toLowerCase().replace(/\s+/g, '-');
      if (ECOSYSTEM_ALIAS_IDS.hasOwnProperty(alias)) ecoId = ECOSYSTEM_ALIAS_IDS[alias];
      if (ecoId == null) throw new Error('rule 17 (Ecosystem Gate) requires ecosystem: "muse", "fomo", "claude", or "grok" (or a number 1..16), or an alias that names one ("muse-only", "fomo-only", "claude-only", "grok-only") — no valid ecosystem could be resolved from this entry');
    }
    p[0] = ecoId;
  }
  return p;
}
// ---------- per-config meta-list templating (engine Phase 2) ----------
// Mirrors the engine's required_extras() classification (engine/src/lib.rs):
// the published meta list carries exactly the extras the enabled rules need,
// in canonical order. The two holder entries are seeded with AccountKey
// templates (disc 3 — the token account's own key), so generic resolvers
// CAN build a first buy for a fresh wallet. (The v2 shape seeded them
// from token-account DATA — the owner field, disc 4 — which made the
// generic resolver throw TokenTransferHookAccountDataNotFound for
// first-time buyers; that shape is no longer published.)
function requiredExtras(rules) {
  const has = (id) => rules.some(r => r.id === id && r.enabled !== false);
  const extras = [{ name: 'config', why: 'unconditional — Execute loads the config' }];
  if (has(1)) extras.push({ name: 'src holder', why: 'rule 1 reads the sender\'s basis/latch state' });
  if (has(1) || has(3) || has(8) || has(17)) extras.push({ name: 'dst holder', why: 'recipient holder state for rules 1/3/8/17' });
  if (has(1) || has(3) || has(17)) extras.push({ name: 'rent vault', why: 'funds lazy Holder PDA creation in Execute' });
  if (has(1)) extras.push({ name: 'price feed', why: 'rule 1 reads the price state' });
  if (has(1) || has(3) || has(17)) extras.push({ name: 'system', why: 'Holder PDA creation CPIs' });
  extras.push({ name: 'instructions sysvar', why: 'unconditional — caller validation' });
  const staticList = !extras.some(e => e.name === 'src holder' || e.name === 'dst holder');
  return { extras, count: extras.length, staticList };
}
// ---------- creator fee (the DBC curve's trading fee) ----------
// The per-trade fee is the Meteora DBC curve's trading fee: set in the
// launch config, collected by the DBC program on every swap, accruing to
// the config's fee_claimer. The transfer hook never touches it (hooks are
// veto-only — they cannot skim); the launcher's fee job is exactly two
// things: set the RATE here, and point the CLAIMER. Bounds are the DBC
// program's own (SDK MIN_FEE_BPS / MAX_FEE_BPS).
const FEE_BPS_MIN = 25, FEE_BPS_MAX = 9900, FEE_BPS_DEFAULT = 100;
function resolveFees(spec) {
  const feeBps = spec.feeBps ?? FEE_BPS_DEFAULT;
  const feeBpsEnd = spec.feeBpsEnd ?? feeBps;
  for (const [name, v] of [['feeBps', feeBps], ['feeBpsEnd', feeBpsEnd]]) {
    if (!Number.isInteger(v) || v < FEE_BPS_MIN || v > FEE_BPS_MAX) {
      throw new Error(`${name} must be an integer between ${FEE_BPS_MIN} and ${FEE_BPS_MAX} bps (the DBC program's fee bounds), got ${JSON.stringify(v)}`);
    }
  }
  // Fee destination — where claimed fees end up. 'creator': the fee
  // claimer keeps them (claims SOL from Meteora with hook.mjs claim-fees).
  // 'holders': the claimer routes them through the token's Distributor
  // (claim → convert → vault → crank). The destination must agree with
  // the holderFees block: a self-contradicting spec would launch a token
  // whose fee stream points nowhere, so it fails here, at spec time.
  const hf = spec.holderFees;
  let destination = spec.feeDestination != null ? String(spec.feeDestination).toLowerCase() : null;
  if (destination != null && destination !== 'creator' && destination !== 'holders') {
    throw new Error(`feeDestination must be "creator" or "holders", got ${JSON.stringify(spec.feeDestination)}`);
  }
  if (destination == null) destination = hf?.enabled ? 'holders' : 'creator';
  if (destination === 'holders' && hf && hf.enabled === false) {
    throw new Error('feeDestination "holders" contradicts holderFees.enabled=false — fees cannot route to holders without the Distributor. Drop one of the two.');
  }
  if (destination === 'creator' && hf?.enabled) {
    throw new Error('feeDestination "creator" contradicts holderFees.enabled=true — with holder fees on, the claimer routes fees to holders through the Distributor. Set feeDestination "holders" or disable holderFees.');
  }
  const holderFees = destination === 'holders' ? { callerCutBps: hf?.callerCutBps ?? 100 } : null;
  if (holderFees && holderFees.callerCutBps > 10000) throw new Error('holderFees.callerCutBps must be <= 10000');
  return { feeBps, feeBpsEnd, destination, holderFees };
}
// ---------- graduation behavior ----------
// What happens when the curve fills — a launch-time choice, spec field
// `graduation`:
//   "release" (DEFAULT): at migrationThresholdSol (default 42) the curve
//     completes, the token migrates to DAMM v2, and Meteora's migration
//     revokes the transfer hook — the rules retire and the token trades
//     like any plain token, everywhere.
//   "never": the token never migrates. The DBC config's migration quote
//     threshold is set to the maximum the venue accepts: the field is a
//     u64 of quote lamports, so the cap is u64::MAX —
//     18,446,744,073,709,551,615 lamports = 18,446,744,073.709551615 SOL,
//     roughly 31x the entire SOL supply in existence. The DBC program's
//     own gates are the only others (threshold > 0, create_config
//     validate in process_create_config.rs; the derived migration sqrt
//     price must stay < MAX_SQRT_PRICE; the curve must cover the
//     threshold) and buildCurve constructs the curve around the
//     threshold, so the max passes all of them for every supply the
//     launcher accepts — verified against SDK 2.0.0 + the program source,
//     and by Anchor-decoding built create-config instructions back to
//     the exact u64 (launcher/trial-graduation.mjs). With the threshold
//     unreachable the curve never completes: the hook keeps enforcing on
//     every transfer forever, the 20% migration tranche stays locked in
//     the pool vault, and the token can only ever trade through
//     hook-aware doors.
//   "house" (Phase C): graduate at the token's OWN threshold
//     (graduationThresholdSol — the curve's quote reserve reaching it,
//     read by the engine's ActivateHouse, tag 14) onto the pre-committed
//     house venue, rules stay. The DBC curve itself is built with the
//     NEVER threshold — house rides never physics: the curve can never
//     complete or migrate, it stays as the legacy door, and trading
//     defaults to the house pool once activation flips. The commitment
//     (program + threshold + optional reserve) is written into the
//     engine Config's house region at L3 and is immutable thereafter.
// With "never", migrationThresholdSol must be ABSENT: carrying both is a
// contradiction, refused at spec time like the fee-destination ones.
// "house" + migrationThresholdSol is likewise a hard error (the house
// threshold is graduationThresholdSol, never the migration field), and
// graduationThresholdSol on any other mode is an error too — the field
// belongs to house alone.
const GRADUATION_MODES = ['release', 'never', 'house'];
const NEVER_THRESHOLD_LAMPORTS = 18446744073709551615n; // u64::MAX
const NEVER_THRESHOLD_SOL = '18446744073.709551615'; // exact decimal string — buildCurve's Decimal conversion is exact on it
function solToLamportsExact(sol) {
  const s = String(sol);
  if (!/^\d+(\.\d{1,9})?$/.test(s)) return null; // exotic input: the record leaves lamports null rather than printing a wrong number
  const [i, f = ''] = s.split('.');
  return BigInt(i) * 1000000000n + BigInt((f + '000000000').slice(0, 9));
}
function resolveGraduation(spec) {
  const g = spec.graduation == null ? 'release' : String(spec.graduation).toLowerCase();
  if (!GRADUATION_MODES.includes(g)) {
    throw new Error(`graduation must be "release", "never" or "house", got ${JSON.stringify(spec.graduation)}`);
  }
  if (g !== 'house' && spec.graduationThresholdSol != null) {
    throw new Error(`graduationThresholdSol belongs to graduation "house" only — with graduation "${g}" it is a hard error. Drop graduationThresholdSol or set graduation "house".`);
  }
  if (g === 'never') {
    if (spec.migrationThresholdSol != null) throw new Error('graduation "never" contradicts migrationThresholdSol — a never-graduating token has no migration threshold. Drop migrationThresholdSol or set graduation "release".');
    return { mode: 'never', thresholdSol: NEVER_THRESHOLD_SOL, thresholdLamports: NEVER_THRESHOLD_LAMPORTS };
  }
  if (g === 'house') {
    if (spec.migrationThresholdSol != null) throw new Error('house + migrationThresholdSol is a hard error — a house token\'s activation threshold is graduationThresholdSol, and its curve is built with the never threshold. Drop migrationThresholdSol.');
    const ht = spec.graduationThresholdSol;
    if (typeof ht !== 'number' || !Number.isFinite(ht) || !(ht > 0)) {
      throw new Error(`graduation "house" requires graduationThresholdSol — a positive number of SOL at which the token graduates onto the house venue — got ${JSON.stringify(spec.graduationThresholdSol)}`);
    }
    const htLamports = solToLamportsExact(ht);
    if (htLamports == null || htLamports <= 0n) throw new Error(`graduationThresholdSol ${JSON.stringify(ht)} cannot be expressed exactly in lamports`);
    return { mode: 'house', thresholdSol: NEVER_THRESHOLD_SOL, thresholdLamports: NEVER_THRESHOLD_LAMPORTS, houseThresholdSol: ht, houseThresholdLamports: htLamports };
  }
  const t = spec.migrationThresholdSol ?? 42;
  return { mode: 'release', thresholdSol: t, thresholdLamports: solToLamportsExact(t) };
}
// ---------- house launch fields (Phase C) ----------
// Spec fields for graduation "house" (validated here, consumed by the
// H-steps): houseReserveSol — SOL committed at launch into the engine
// HouseVault PDA as part of the activation seed (default 0 = no reserve;
// the seed then comes from claimed curve fees alone, deposited via
// engine tag 16 before activation). houseSeedTokens — UI units of the
// token the seed wallet must acquire on the curve and deliver into the
// house token vault (REQUIRED, > 0). houseSeedBuySol — the SOL the seed
// wallet spends on that curve buy (REQUIRED, > 0). houseSeedWalletSol —
// extra SOL funding for the seed wallet itself (fees/rent headroom),
// default 0.1.
function resolveHouseFields(spec) {
  if (String(spec.graduation ?? 'release').toLowerCase() !== 'house') return null;
  const num = (name, v, dflt, required) => {
    if (v == null) {
      if (required) throw new Error(`graduation "house" requires ${name} (got nothing)`);
      return dflt;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a finite number of SOL/tokens, got ${JSON.stringify(v)}`);
    return v;
  };
  const houseReserveSol = num('houseReserveSol', spec.houseReserveSol, 0, false);
  if (houseReserveSol < 0) throw new Error(`houseReserveSol must be >= 0, got ${houseReserveSol}`);
  const houseSeedTokens = num('houseSeedTokens', spec.houseSeedTokens, null, true);
  if (!(houseSeedTokens > 0)) throw new Error(`houseSeedTokens must be > 0 (UI units of the token seeded into the house vault), got ${houseSeedTokens}`);
  const houseSeedBuySol = num('houseSeedBuySol', spec.houseSeedBuySol, null, true);
  if (!(houseSeedBuySol > 0)) throw new Error(`houseSeedBuySol must be > 0 (the SOL the seed wallet spends on the curve), got ${houseSeedBuySol}`);
  const houseSeedWalletSol = num('houseSeedWalletSol', spec.houseSeedWalletSol, 0.1, false);
  if (houseSeedWalletSol < 0) throw new Error(`houseSeedWalletSol must be >= 0, got ${houseSeedWalletSol}`);
  return { houseReserveSol, houseSeedTokens, houseSeedBuySol, houseSeedWalletSol };
}
// ---------- engine v4 guard + crank pre-flight (PURE — BEGIN v4-pure) ----------
// Engine v4 batch (spec locked by Gregory 2026-10-19). HARVEST EVER —
// rule 1 (Basis Latch) + graduation "never" — died at launch step L8c
// because the engine's CrankPriceDbc overflowed on never-curve prices:
// the crank's old spot formula squared the Q64.64 sqrt price (s*s),
// and the never curve's sqrt_start_price is large enough that s*s
// exceeds 2^128. An engine fix (decomposed spot math, below) is being
// built in parallel; until it is VERIFIED LIVE, this combination must
// not launch. Everything in this delimited section is PURE (no I/O,
// no RPC): the guard decision takes (spec, fixedShaOrNull,
// liveShaOrNull) and the pre-flight takes a sqrt price + decimals, so
// trial-launch-features.mjs §H can slice this section verbatim and
// exercise it with stub hashes. The thin I/O wrappers (reading
// launcher/engine-v4.json, fetching the live ProgramData ELF) live
// further down, next to makeSender. FAIL CLOSED throughout: a missing
// file, a null hash, a fetch error, or a mismatch all refuse.
const ENGINE_V4_PROGRAM_ID = 'EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT'; // == ENGINE.toBase58()
const ENGINE_V4_FILE_NAME = 'engine-v4.json'; // launcher/engine-v4.json, written by the engine-build coordinator
const PRICE_SCALE = 1000000000000n; // 10^12 — mirrors the engine's PRICE_SCALE
const U128_LIMIT = 1n << 128n;
const U64_MASK = (1n << 64n) - 1n;
function specHasRule1Never(spec) {
  const has1 = (spec.rules ?? []).some((e) => { try { return ruleIdOf(e) === 1 && e.enabled !== false; } catch { return false; } });
  // Phase C: mode 'house' also applies — a house token's curve is built
  // with the never threshold (u64::MAX), so rule 1 + house carries the
  // same crank-overflow exposure this guard exists for. The guard's
  // decisions for 'never' itself are unchanged.
  const m = resolveGraduation(spec).mode;
  return has1 && (m === 'never' || m === 'house');
}
function normalizeSha(v) { return typeof v === 'string' && v.trim() !== '' ? v.trim().toLowerCase() : null; }
function engineV4GuardDecision(spec, fixedShaOrNull, liveShaOrNull) {
  const fixedSha = normalizeSha(fixedShaOrNull);
  const liveSha = normalizeSha(liveShaOrNull);
  const applies = specHasRule1Never(spec);
  const checked = `launcher/${ENGINE_V4_FILE_NAME} fixedEngineSha256 for engine program ${ENGINE_V4_PROGRAM_ID} (recorded: ${fixedSha ?? 'none'}) vs the live engine ProgramData account's ELF sha256 (observed: ${liveSha ?? 'not fetched / fetch failed'})`;
  if (!applies) return { applies: false, allow: true, fixedSha, liveSha, checked, reason: 'spec does not combine rule 1 (Basis Latch) with graduation "never" — the v4 guard does not apply' };
  if (!fixedSha) return { applies: true, allow: false, fixedSha, liveSha, checked, reason: `no fixed engine is recorded — launcher/${ENGINE_V4_FILE_NAME} is missing or its fixedEngineSha256 is null/missing, so there is no verified v4 engine to launch against` };
  if (!liveSha) return { applies: true, allow: false, fixedSha, liveSha, checked, reason: 'the live engine ELF sha256 could not be fetched (ProgramData fetch failed), so the on-chain engine cannot be matched to the recorded fixed engine — failing closed' };
  if (fixedSha !== liveSha) return { applies: true, allow: false, fixedSha, liveSha, checked, reason: `the live engine ELF sha256 ${liveSha} does not match the recorded fixed-engine sha256 ${fixedSha}` };
  return { applies: true, allow: true, fixedSha, liveSha, checked, reason: 'the live engine ELF sha256 matches the recorded fixed-engine sha256 — the v4 engine (crank overflow fix) is verified live' };
}
function rule1NeverRefusal(decision) {
  return `rule 1 (Basis Latch) + graduation "never" is refused until the v4 engine (crank overflow fix) is verified live — ${decision.reason}. Checked: ${decision.checked}.`;
}
// Offline crank pre-flight — the "EVER died at L8c, never again" rule.
// Simulates the crank's spot computation for a curve's sqrt_start_price
// in pure BigInt using the FIXED decomposition (mirrors the engine's
// Rust fix; PRICE_SCALE = 10^12): with s = a*2^64 + f (Q64.64),
//   spotPre = a*a*SCALE + (t >> 64)*SCALE + (((t & mask) * SCALE) >> 64)
//             + ((((f*f) >> 64) * SCALE) >> 64),   where t = 2*a*f,
// then a decimal adjust (token vs quote decimals, floor division).
// Asserts (a) spot > 0 and (b) every bound-checked intermediate stays
// < 2^128 — the overflow tripwire the old formula (s*s) fails on
// never-curve prices. naiveSSquared is reported as a diagnostic ONLY
// (it is the old formula's intermediate, never bound-checked here).
function crankPreflight(sqrtPrice, tokenDec, quoteDec) {
  const s = BigInt(String(sqrtPrice));
  const a = s >> 64n;
  const f = s & U64_MASK;
  const t = 2n * a * f;
  const intermediates = {
    'a*a*PRICE_SCALE': a * a * PRICE_SCALE,
    't (= 2*a*f)': t,
    '(t >> 64)*PRICE_SCALE': (t >> 64n) * PRICE_SCALE,
    '(t & (2^64-1))*PRICE_SCALE': (t & U64_MASK) * PRICE_SCALE,
    'f*f': f * f,
    '((f*f) >> 64)*PRICE_SCALE': ((f * f) >> 64n) * PRICE_SCALE,
  };
  const spotPre = a * a * PRICE_SCALE
    + ((t >> 64n) * PRICE_SCALE)
    + (((t & U64_MASK) * PRICE_SCALE) >> 64n)
    + ((((f * f) >> 64n) * PRICE_SCALE) >> 64n);
  const td = Number(tokenDec), qd = Number(quoteDec);
  const spot = td >= qd ? spotPre * (10n ** BigInt(td - qd)) : spotPre / (10n ** BigInt(qd - td));
  const failures = [];
  for (const [name, v] of Object.entries(intermediates)) if (v >= U128_LIMIT) failures.push(`${name} = ${v} (>= 2^128 — the crank's u128 math would overflow)`);
  if (spot <= 0n) failures.push(`spot = ${spot} (must be > 0)`);
  return { sqrtPrice: s, a, f, t, intermediates, naiveSSquared: s * s, spotPre, spot, tokenDec: td, quoteDec: qd, failures, ok: failures.length === 0 };
}
function crankPreflightText(p) {
  return `crank pre-flight (offline BigInt simulation of the FIXED CrankPriceDbc decomposition, PRICE_SCALE=10^12, computed before L1): sqrt_start_price=${p.sqrtPrice} -> crank spot=${p.spot} (token ${p.tokenDec} / quote ${p.quoteDec} decimals) — ${p.ok
    ? `PASS (spot > 0; every decomposition intermediate < 2^128${p.naiveSSquared >= U128_LIMIT ? `; note the OLD formula's intermediate s*s = ${p.naiveSSquared} >= 2^128 would have overflowed — exactly the HARVEST EVER L8c failure` : ''})`
    : `FAIL: ${p.failures.join('; ')}`}`;
}
// ---------- engine v4 guard + crank pre-flight (PURE — END v4-pure) ----------
// ---------- bundled dev buy (Phase 4, Feature B) ----------
// Spec field `devBuySol` (optional): when set, the launcher buys this
// much SOL of the token itself, as part of the same launch run, in its
// own transaction submitted immediately after activation (L4/L4b/L5 +
// L7/L7b and any register/sync/crank prerequisites) with nothing else
// intervening — step L9 in the plan. Unset (the default) = no dev buy,
// exactly the pre-Feature-B behavior.
// ATOMICITY — the honest bound: the dev buy CANNOT be in the same
// transaction as L4 (or L2). The swap build (the DBC SDK's
// swap2WithTransferHook → getRemainingAccountsForTransferHook) resolves
// the transfer hook's extra accounts by READING the on-chain
// ExtraAccountMetaList account (via spl-token's
// createTransferCheckedWithTransferHookInstruction) and the pool state —
// neither exists until L2/L4 have landed, so the standard build path
// cannot construct the swap inside the activation transaction. The
// guarantee shipped is therefore: FIRST swap after activation,
// submitted by the launcher in the same run; NOT atomic with
// activation — a third party landing in an earlier slot could
// theoretically precede it.
// Cap: 10 SOL. The dev buy is the launcher's own first position, sized
// like a seed, not a treasury operation; anything larger belongs in a
// deliberate post-launch buy (hook.mjs buy / flow buy), not a launch
// flag. Validation is hard: non-positive, non-numeric, or over-cap
// values refuse the launch at spec time.
const DEV_BUY_MAX_SOL = 10;
function resolveDevBuy(spec) {
  const v = spec.devBuySol;
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || !(v > 0)) {
    throw new Error(`devBuySol must be a positive number of SOL (max ${DEV_BUY_MAX_SOL}), got ${JSON.stringify(v)}`);
  }
  if (v > DEV_BUY_MAX_SOL) {
    throw new Error(`devBuySol ${v} exceeds the ${DEV_BUY_MAX_SOL} SOL cap — the bundled dev buy is a seed-sized first position; buy more afterwards with hook.mjs if you mean it`);
  }
  return { sol: v, lamports: Math.round(v * 1e9) };
}
// ---------- token metadata (discovery fix, 2026-10-16) ----------
// A launch's mint metadata URI is NEVER empty again. Pre-fix launches
// (AGTR, Latch, HARVEST) were born with uri "" and stayed icon-less in
// every index and bot directory until repaired by hand. Three sources:
//   "spec"      — spec.metadataUri, used verbatim (the operator hosts
//                 their own metadata JSON; contents are their call).
//   "service"   — the public metadata service (wallet-signed upload at
//                 L0; see resolveMetadata / stageMetadata): any creator
//                 can host metadata + image with their own launch
//                 wallet — no operator, no site tree. Selected with
//                 spec.metadataService (true = the default public
//                 service, or a service base URL string) or env
//                 LAUNCH_METADATA_SERVICE.
//   "generated" — the launcher derives conventional site URLs from the
//                 symbol: <base>/<slug>.json + <base>/<slug>.png, and
//                 (CLI step L0) generates a default image + a metadata
//                 JSON in the HARVEST repair shape, stages both into
//                 the site tree, deploys the site, and verifies both
//                 URLs live BEFORE L1. A spec may override just the
//                 image (metadataImageUri) or the description text
//                 (description) and keep the generated JSON.
// Convention: base defaults to https://agentonly.fun/hooks; override
// per launch with spec.metadataBaseUrl, or for the CLI staging step
// via env LAUNCH_METADATA_DIR (where files are staged) — the browser
// composer derives the same URI and verifies it live before L2.
const METADATA_BASE_DEFAULT = 'https://agentonly.fun/hooks';
const METADATA_SERVICE_DEFAULT = 'https://metadata-production-b46e.up.railway.app';
function metadataSlug(spec) {
  const s = String(spec.symbol ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) throw new Error(`cannot derive a metadata slug from symbol ${JSON.stringify(spec.symbol)}`);
  return s;
}
function defaultMetadataDescription(spec) {
  const names = (spec.rules ?? []).map((e) => RULE_NAMES[ruleIdOf(e)]).filter(Boolean);
  const rulesText = names.length
    ? `Rules: ${names.join(' + ')} — enforced on-chain by the transfer-hook engine on every transfer.`
    : 'The transfer-hook engine is attached with an empty rule stack.';
  return `${spec.name} (${spec.symbol}) is a Hook Launcher token on Solana. ${rulesText}`;
}
function resolveMetadata(spec) {
  if (spec.metadataUri != null && String(spec.metadataUri).trim() !== '') {
    return {
      source: 'spec', uri: String(spec.metadataUri), imageUri: spec.metadataImageUri ?? null,
      slug: null, jsonFile: null, pngFile: null,
      description: spec.description ?? null, externalUrl: null,
    };
  }
  // "service" — the public metadata service: the creator's own wallet
  // signs an upload at L0 (stageMetadata) and the service hosts the
  // JSON + image. spec.metadataService: true = the default public
  // service; a string = that service's base URL. Env
  // LAUNCH_METADATA_SERVICE (a base URL) sets/overrides it when the
  // spec doesn't. metadataUri (above) still wins when both are set.
  // The final URLs come back in the upload response; uri here is the
  // service's documented shape predicted from the slug, and imageUri
  // stays null until the upload replaces both (stageMetadata).
  const svcRaw = spec.metadataService ?? (process.env.LAUNCH_METADATA_SERVICE || null);
  if (svcRaw != null && svcRaw !== false && svcRaw !== '') {
    const slug = metadataSlug(spec);
    const serviceBase = String(svcRaw === true ? METADATA_SERVICE_DEFAULT : svcRaw).replace(/\/+$/, '');
    return {
      source: 'service', slug, serviceBase,
      uri: `${serviceBase}/meta/${slug}.json`,
      imageUri: null,
      jsonFile: null, pngFile: null,
      description: spec.description ?? null, externalUrl: spec.metadataExternalUrl ?? null,
    };
  }
  const slug = metadataSlug(spec);
  const base = String(spec.metadataBaseUrl ?? METADATA_BASE_DEFAULT).replace(/\/+$/, '');
  return {
    source: 'generated', slug,
    uri: `${base}/${slug}.json`,
    imageUri: spec.metadataImageUri ?? `${base}/${slug}.png`,
    jsonFile: `${slug}.json`, pngFile: `${slug}.png`,
    description: spec.description ?? defaultMetadataDescription(spec),
    externalUrl: `${base}/${slug}/`,
  };
}

// ---------- partner identity (discovery fix, Phase A, 2026-10-17) ----------
// DBC expresses a launchpad's partner identity in exactly one place: the
// partner-metadata account (createPartnerMetadata) that binds a name /
// website / logo to a fee-claimer wallet — its address is a PDA of the
// fee claimer in the DBC program. A config "hangs from" that identity
// by naming the wallet as its feeClaimer; there is no other association
// field in createConfig(WithTransferHook) — the fee claimer IS the link,
// which is why the launcher's default (feeClaimer = launcher wallet) is
// the identity wiring, and why a live launch verifies the metadata
// account before L1. This launcher's identity record was created
// 2026-10-17 (Gregory delegated the identity call): account
// 6udQdVvbGyGk5BcdEjZoAbqvLWmQsf7F1d1zjDu8ZGmU, tx
// nDaFTtXv9JcS2fAx8i5iK9ENhB2kfBNFRVgVcBrjHJtCZhusHWC8xdEZqJTej9ht5o8opohEaYPJ4Si8K4QgY28
// — see deploy/PARTNER-IDENTITY-2026-10-17.md. Recreate or repair with:
//   node create-partner-metadata.mjs write
const PARTNER_IDENTITY = {
  name: 'AgentOnly',
  website: 'https://agentonly.fun/hooks/',
  logo: 'https://agentonly.fun/hooks/partner-logo.png',
};
function partnerIdentityText(feeClaimer) {
  return `partner identity: whatever name/website/logo are bound in the fee claimer's OWN partner-metadata account (the platform's own record — "${PARTNER_IDENTITY.name}" (${PARTNER_IDENTITY.website}, logo ${PARTNER_IDENTITY.logo}) — is only the platform's example, bound to the platform wallet) — in DBC a config hangs from a partner identity through its fee_claimer alone: the identity record is the partner-metadata account ${derivePartnerMetadata(feeClaimer).toBase58()} (PDA of the fee claimer in the DBC program; name/website/logo bound on-chain by createPartnerMetadata), and this config names fee_claimer=${feeClaimer.toBase58()}. A live launch verifies that account before L1: the launching wallet's own partner metadata is REQUIRED (refusal, never a silent anonymous launch); an operator-supplied fee claimer carries its own identity, or none`;
}

function validateSpec(spec) {
  const warnings = [];
  if (!spec.name || !spec.symbol) throw new Error('spec requires name and symbol');
  if (!MODES.hasOwnProperty(String(spec.authorityMode ?? 'locked').toLowerCase())) throw new Error(`authorityMode must be one of: ${Object.keys(MODES).join(', ')}`);
  const rules = spec.rules ?? [];
  if (rules.length > 8) throw new Error(`at most 8 rules per config (engine MAX_RULES), got ${rules.length}`);
  const seen = new Set();
  for (const entry of rules) {
    const id = ruleIdOf(entry);
    if (!RULE_NAMES[id]) throw new Error(`unknown rule_id ${id} — not in the catalog (1..17). Refusing to launch: a config referencing an unknown rule must fail at launch, never at transfer time.`);
    if (!IMPLEMENTED.has(id)) throw new Error(`rule ${id} (${RULE_NAMES[id]}) is in the catalog but NOT implemented in the current engine build (implemented: ${[...IMPLEMENTED].map(i => `${i} ${RULE_NAMES[i]}`).join('; ')}). Refusing to launch — the launcher never silently drops a rule.`);
    if (seen.has(id)) throw new Error(`duplicate rule ${id} (${RULE_NAMES[id]}) in the stack`);
    seen.add(id);
    encodeParams(id, entry); // validates params eagerly
  }
  // Settlement split sum (Phase B cross-rule check, mirrored from the
  // engine so the refusal happens HERE, at spec time — not at config
  // write or, worse, at settlement): the Distributor carves each
  // distribution by rules 5 (Crown Beneficiary, crownBps), 6 (Tithe
  // Seat, titheBps) and 15 (King of the Pool, titheBps), and the three
  // carves share one distribution. The engine rejects a config whose
  // ENABLED carves sum over 10000 bps (engine/src/lib.rs split_sum —
  // disabled entries are not summed), and the Distributor hard-errors
  // the same condition at settlement time (DistError::SplitBpsTooLarge).
  // Effective bps are the values encodeParams writes — defaults
  // included (500 / 300 / 0) — and the loop above already encoded every
  // entry, so the fields are known-valid integers here.
  {
    let splitSum = 0;
    const parts = [];
    for (const entry of rules) {
      if (entry.enabled === false) continue;
      const id = ruleIdOf(entry);
      const bps = id === 5 ? (entry.crownBps ?? 500)
        : id === 6 ? (entry.titheBps ?? 300)
        : id === 15 ? (entry.titheBps ?? 0)
        : null;
      if (bps != null) { splitSum += bps; parts.push(`rule ${id} (${RULE_NAMES[id]}) ${bps} bps`); }
    }
    if (splitSum > 10000) {
      throw new Error(`settlement split too large: the rules 5+6+15 carves sum to ${splitSum} bps (${parts.join(' + ')}) — over the 10000 bps a distribution has. The engine rejects this at config write and the Distributor hard-errors it at settlement (SplitBpsTooLarge); fix it in the spec instead: lower crownBps (rule 5), titheBps (rule 6) or titheBps (rule 15).`);
    }
  }
  if (seen.has(1)) warnings.push('rule 1 (Basis Latch) on DBC: the feed prices from the pool state via the engine CrankPriceDbc instruction (reads the pool sqrt_price). The first crank must land before the first buy, and the feed must be re-cranked within max_stale_secs of any gated transfer — the trade flow handles this; a stale feed fails closed (StalePrice). See engine BUILD-NOTES.');
  if (seen.has(8)) warnings.push('rule 8 (Holder-Gated) fails closed on DBC: curve swaps resolve only the meta list, and the gate sync must sit adjacent to the transfer. Rule-8 tokens trade through surfaces that prepend SyncGateBalance (the agent skill\'s `send`, the trade page) — plain curve buys of a rule-8 token will veto. See engine BUILD-NOTES.');
  if (seen.has(7) && String((rules.find(r => ruleIdOf(r) === 7) ?? {}).mode).toLowerCase() === 'p2p-only') warnings.push('rule 7 P2P-only: venue receives are vetoed — the DBC curve can be seeded but not bought from. This is a pure social-token posture; the curve will sit idle by design.');
  if (seen.has(17)) warnings.push('rule 17 (Ecosystem Gate): an ecosystem-gated token can only be received by wallets holding an attested registration for that ecosystem — until that ecosystem\'s attester is configured in the Registry and its enrollment flow runs, nobody can receive.');
  const feesCheck = resolveFees(spec); // creator-fee rate bounds + destination consistency (throws)
  if (feesCheck.destination === 'holders') warnings.push('S1 NOTICE: fees-to-holders uses the Distributor, whose first-touch claim accounting has a known flaw (S1). A fix (Design D, proposals/S1-distributor-settle-on-transfer.md) is designed but NOT deployed. Do not treat a holder-fee launch as safe until that fix ships.');
  resolveDevBuy(spec); // bundled dev buy bounds (throws)
  const grad = resolveGraduation(spec); // graduation mode + threshold contradiction (throws)
  const houseF = resolveHouseFields(spec); // house launch fields (throws; null unless house)
  if (seen.has(2)) {
    // Rule 2 (Escrow Split) is venue-side: its split/resolution live in
    // the HOUSE venue's swap, so it can only exist on a house token, and
    // its sell-side resolution IS rule 1's dip logic (feed + basis), so
    // rule 1 must be enabled alongside it.
    if (grad.mode !== 'house') throw new Error('rule 2 (Escrow Split) requires graduation "house" — the split is enforced by the house venue, not the engine, and a curve token has no venue to split in. Set graduation "house" or drop rule 2.');
    if (!seen.has(1)) throw new Error('rule 2 (Escrow Split) requires rule 1 (Basis Latch) enabled — escrow resolution on a sell reads the price feed and the seller\'s basis/latch state, which only rule 1 maintains.');
    warnings.push('rule 2 (Escrow Split) is venue-side: the split applies to house-venue trades after activation; curve trades are unsplit; escrow resolves only on house-venue sells. The engine itself treats rule 2 as a no-op — the venue reads split_bps from the Config PDA at swap time.');
  }
  if (seen.has(14)) {
    // Rule 14 (Decay Tax) is a schedule on the mint's Token-2022
    // Transfer Fee extension rate — the FeeSchedule program modulates
    // that extension through its fee-authority PDA. DBC creates mints
    // with a fixed extension set (metadata pointer + transfer hook —
    // see the configPayload fee-mirror note), so a mint launched here
    // can never carry a Transfer Fee extension, and a rule-14 config
    // written by this launcher could never initialize its schedule
    // (InitSchedule fails closed with NoFeeConfig — the backstop). The
    // Phase B deploy sheet requires this rejection at spec time. The
    // FeeSchedule program is live; the unblock is a direct
    // fee-extension mint path, which is not built yet.
    throw new Error('rule 14 (Decay Tax) is not launchable through this launcher — Decay Tax is a schedule on the mint\'s Transfer Fee extension rate, and DBC mints carry a fixed extension set (metadata pointer + transfer hook) with no Transfer Fee extension, so a rule-14 config written here could never initialize its schedule. The FeeSchedule program is live on mainnet, but the direct fee-extension mint path it needs is not built yet. Drop rule 14 from the spec.');
  }
  if (grad.mode === 'house') {
    warnings.push(`graduation "house": this token graduates onto the house venue (${HOUSE_SWAP_PROGRAM_ID.toBase58()}) when its curve quote reserve reaches ${grad.houseThresholdSol} SOL — the curve is built with the never threshold so it can never migrate; before activation the curve is the only door, after activation doors default to the house pool and the curve stays as the legacy door. The commitment is written into the engine config at launch and is immutable thereafter.`);
    warnings.push(`house seed-account exemption disclosure: the launch exempts the dedicated seed wallet's ATA (seedAta — a fresh per-launch keypair recorded in the launch record's house.seedExemption) from this token's rules, so the seed delivery into the house token vault cannot be vetoed by the very stack it seeds. The seed wallet holds nothing but the seed; the exemption is named in the record, never hidden.`);
  }
  if (spec.metadataUri != null && !/^https?:\/\/\S+$/.test(String(spec.metadataUri))) {
    throw new Error(`metadataUri must be an http(s) URL, got ${JSON.stringify(spec.metadataUri)}`);
  }
  resolveMetadata(spec); // metadata plan sanity: slug derivation (throws on an unusable symbol)
  if (grad.mode === 'never') warnings.push('graduation "never": this token NEVER migrates — its migration threshold is set to the venue maximum (u64::MAX lamports, ≈18.45 billion SOL), so the curve never completes, the hook enforces the rules on every transfer forever, the 20% migration tranche stays locked in the pool vault, and only hook-aware doors can ever trade it. There is no graduation day for this token.');
  return warnings;
}

// ---------- PDAs ----------
const pdaE = (seeds) => PublicKey.findProgramAddressSync(seeds, ENGINE)[0];
const configPda = (mint) => pdaE([Buffer.from('config'), mint.toBuffer()]);
const metaPda = (mint) => pdaE([Buffer.from('extra-account-metas'), mint.toBuffer()]);
const pricePda = (mint) => pdaE([Buffer.from('price'), mint.toBuffer()]);
const rentVaultPda = (mint) => pdaE([Buffer.from('rentvault'), mint.toBuffer()]);
const distPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('dist'), mint.toBuffer()], DISTRIBUTOR)[0];
const K = (pubkey, s, w) => ({ pubkey, isSigner: !!s, isWritable: !!w });
// The launch-signer memo instruction (Feature A): SPL Memo v2, data =
// the fixed marker text, exactly ONE key — the launch signer, signer,
// read-only. Shared by the CLI execute path and the in-browser composer
// (via helpers.generated.mjs) so both flows emit the identical shape.
function buildTagMemoIx(tagPubkey) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: tagPubkey, isSigner: true, isWritable: false }],
    data: Buffer.from(LAUNCH_TAG_MARKER, 'utf8'),
  });
}

// ---------- engine config payload (mirrors integration/dbc-engine-integration.mjs) ----------
function configPayload({ mode, authority, rules, venues, exemptions }, tag, house = null) {
  const parts = [Buffer.from([tag, mode]), authority.toBuffer(), Buffer.from([rules.length])];
  for (const r of rules) {
    const e = Buffer.alloc(68);
    e.writeUInt16LE(r.id, 0);
    e[2] = r.enabled === false ? 0 : 1;
    encodeParams(r.id, r.entry).copy(e, 4);
    parts.push(e);
  }
  parts.push(Buffer.from([venues.length]));
  for (const v of venues) parts.push(v.toBuffer());
  parts.push(Buffer.from([exemptions.length]));
  for (const x of exemptions) parts.push(x.toBuffer());
  const tail = Buffer.alloc(2 + 8 + 1 + 32); // fee mirror: bps u16, max u64, mode u8, vault 32
  // DBC mints carry NO Transfer Fee extension (fixed extension set — DBC-INTEGRATION
  // flag), so the fee mirror stays zeroed; holder fees run through the Distributor.
  authority.toBuffer().copy(tail, 11);
  parts.push(tail);
  // Phase C house block (contract §1.2): appended AFTER the fee tail,
  // ONLY for house-committed configs: [1u8][program 32][threshold u64]
  // [reserve u64] = 49 bytes. Absent = no commitment; non-house payloads
  // stay byte-identical to Phase B (trial-graduation C2/C4 baselines).
  if (house) {
    const hb = Buffer.alloc(49);
    hb[0] = 1;
    house.program.toBuffer().copy(hb, 1);
    hb.writeBigUInt64LE(BigInt(house.thresholdLamports), 33);
    hb.writeBigUInt64LE(BigInt(house.reserveLamports), 41);
    parts.push(hb);
  }
  return Buffer.concat(parts);
}

// ---------- DBC curve parameters (the integration-proven shape) ----------
function curveConfig(thresholdSol, spec) {
  return buildCurve({
    token: {
      tokenType: TokenType.Token2022, tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAuthority,
      totalTokenSupply: spec.supply ?? 1_000_000_000, leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: resolveFees(spec).feeBps, endingFeeBps: resolveFees(spec).feeBpsEnd, numberOfPeriod: 0, totalDuration: 0 }, // flat unless feeBpsEnd differs
      },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      // Discovery-fix parity (2026-10-16, decode audit of HARVEST vs
      // HAMSTER/MHA configs): both controls use migrationFeeOption
      // Customizable(6); ours was FixedBps100(2). The option selects
      // the GRADUATED DAMM v2 pool's fee source (preset vs stored
      // migratedPoolFee) — it does NOT touch the migration skim, which
      // is the separate migrationFee below and stays 0/0 (the controls
      // take a 10% skim of the threshold at graduation; that is a
      // platform fee grab, deliberately NOT copied — fee economics are
      // the launcher's product decision). Our migratedPoolFee mirrors
      // the economics FixedBps100 gave us: 100 bps flat, dynamic fee
      // off (controls chose 120 bps + dynamic — their economics).
      migrationFeeOption: MigrationFeeOption.Customizable,
      migratedPoolFee: { collectFeeMode: CollectFeeMode.QuoteToken, dynamicFee: 0, poolFeeBps: 100 },
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    // Discovery-fix parity (2026-10-16): the working HookedPad-born
    // controls (HAMSTER, MHA) activate on TIMESTAMP; our pre-fix
    // launches used Slot. Timestamp is also the friendlier semantic
    // for anything reading activation points off-chain.
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: thresholdSol,
  });
}
// Human-readable resolved create-config fields (launch plan parity:
// the CLI dry-run and the browser composer print the same string).
function configFieldsText(thresholdSol, spec) {
  const c = curveConfig(thresholdSol, spec);
  const nm = (obj, v) => obj[v] ?? String(v);
  return `config fields: activationType=${nm(ActivationType, c.activationType)}(${c.activationType}), collectFeeMode=${nm(CollectFeeMode, c.collectFeeMode)}(${c.collectFeeMode}), migrationOption=${nm(MigrationOption, c.migrationOption)}(${c.migrationOption}), migrationFeeOption=${nm(MigrationFeeOption, c.migrationFeeOption)}(${c.migrationFeeOption}), migratedPoolFee=${c.migratedPoolFee?.poolFeeBps ?? '?'}bps/${nm(CollectFeeMode, c.migratedPoolFee?.collectFeeMode ?? 0)}(${c.migratedPoolFee?.collectFeeMode ?? '?'}) dynamicFee=${c.migratedPoolFee?.dynamicFee ?? '?'}, migrationFee=${c.migrationFee?.feePercentage ?? '?'}/${c.migrationFee?.creatorFeePercentage ?? '?'}% (partner/creator), tokenUpdateAuthority=${nm(TokenAuthorityOption, c.tokenUpdateAuthority)}(${c.tokenUpdateAuthority}), tokenType=${nm(TokenType, c.tokenType)}(${c.tokenType})`;
}

// ---------- robust sender (th.mjs pattern: HTTP send + status polling,
// processed blockhash + skipPreflight — preflight is where lagging RPC nodes
// report BlockhashNotFound) ----------
function makeSender(rpcUrl) {
  const rpc = async (method, params) => {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json();
        if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error));
        return j.result;
      } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); }
    }
    throw lastErr;
  };
  return async function sendTx(tx, signers, label) {
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = (await rpc('getLatestBlockhash', [{ commitment: 'processed' }])).value.blockhash;
    tx.sign(...signers);
    const sig = await rpc('sendTransaction', [tx.serialize().toString('base64'), { encoding: 'base64', skipPreflight: true, maxRetries: 5 }]);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const st = (await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }])).value[0];
      if (st) {
        if (st.err) throw new Error(label + ' failed on-chain: ' + JSON.stringify(st.err) + ' (sig ' + sig + ')');
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') { console.log('ok', label, sig); return sig; }
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error(label + ': not confirmed in 90s (sig ' + sig + ')');
  };
}

// ---------- engine v4 guard + crank pre-flight (I/O wrappers) ----------
// Thin wrappers around the PURE section above. crankPreflightForSpec
// builds the DBC curve exactly the way the launch itself does
// (curveConfig over resolveGraduation's threshold — the SDK buildCurve
// shape) and runs the offline decomposition on its sqrt_start_price.
// readFixedEngineSha reads launcher/engine-v4.json (the file the
// engine-build coordinator writes once the fixed engine is built:
// { programId, fixedEngineSha256 }); ANY problem — file missing,
// unparseable, programId naming a different program, hash absent —
// yields null, which the pure decision treats as NOT fixed (refuse).
// fetchLiveEngineElfSha256 resolves the engine program's ProgramData
// account (the upgradeable-loader Program account carries its address
// at bytes 4..36) and sha256s the ELF, which starts at byte offset 45
// of the ProgramData account data (4-byte state enum + 8-byte slot +
// 1-byte option + 32-byte authority). liveEngineV4Decision folds any
// fetch error to liveSha = null — the pure decision then refuses.
function crankPreflightForSpec(spec) {
  const g = resolveGraduation(spec);
  const c = curveConfig(g.thresholdSol, spec);
  return crankPreflight(c.sqrtStartPrice, spec.decimals ?? 6, 9);
}
function readFixedEngineSha() {
  try {
    const doc = JSON.parse(fs.readFileSync(new URL(`./${ENGINE_V4_FILE_NAME}`, import.meta.url), 'utf8'));
    if (doc.programId != null && String(doc.programId) !== ENGINE.toBase58()) return null;
    return normalizeSha(doc.fixedEngineSha256);
  } catch { return null; }
}
async function fetchLiveEngineElfSha256(conn) {
  const prog = await conn.getAccountInfo(ENGINE);
  if (!prog || prog.data.length < 36) throw new Error('engine program account not found / too short to carry a ProgramData address');
  const programData = new PublicKey(prog.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(programData);
  if (!pd || pd.data.length <= 45) throw new Error(`engine ProgramData account ${programData.toBase58()} not found / too short to carry an ELF`);
  return createHash('sha256').update(pd.data.subarray(45)).digest('hex');
}
async function liveEngineV4Decision(spec, conn) {
  const fixedSha = readFixedEngineSha();
  if (!specHasRule1Never(spec)) return engineV4GuardDecision(spec, fixedSha, null);
  let liveSha = null;
  try { liveSha = await fetchLiveEngineElfSha256(conn); } catch { liveSha = null; }
  return engineV4GuardDecision(spec, fixedSha, liveSha);
}

// ---------- L0 metadata staging (CLI only; the browser composer
// derives the same URI via resolveMetadata and verifies it live) ----------
// Minimal PNG writer (node zlib) + a deterministic generated token mark:
// site palette, accent ring chosen by symbol hash, gold block-letter
// monogram (first symbol character, 5x7 font), gold plinth bar. The
// default art is deliberately simple; a spec overrides it with
// metadataImageUri, or the whole JSON with metadataUri.
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(rgb, w, h) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 3)] = 0; rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}
const FONT5X7 = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'], B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'], D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'], F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.###.'], H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'], J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'], L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'], N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'], R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'], T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'], X: ['#...#', '.#.#.', '..#..', '..#..', '..#..', '.#.#.', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'], Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'], '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '#####'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'], '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'], '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'], '7': ['#####', '....#', '...#.', '..#..', '..#..', '..#..', '..#..'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'], '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
};
function renderTokenPng(symbol) {
  const S = 1024, OUT = 512;
  const NAVY = [18, 22, 31], PANEL = [23, 28, 40], GOLD = [245, 196, 81], PAPER = [238, 242, 247];
  const ACCENTS = [[61, 220, 132], [245, 196, 81], [56, 189, 248], [167, 139, 250], [248, 113, 113], [45, 212, 191]];
  const sym = String(symbol).toUpperCase();
  let hash = 0; for (const ch of sym) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const accent = ACCENTS[hash % ACCENTS.length];
  const letterColor = accent === GOLD ? PAPER : GOLD;
  const px = new Uint8Array(S * S * 3);
  const set = (x, y, c) => { if (x < 0 || y < 0 || x >= S || y >= S) return; const i = (y * S + x) * 3; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) set(x, y, NAVY);
  const cx = S / 2, cy = S / 2;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const d = Math.hypot(x - cx, y - cy); if (d < 470) set(x, y, PANEL); }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const d = Math.hypot(x - cx, y - cy); if (d >= 293 && d < 345) set(x, y, accent); }
  const glyph = FONT5X7[sym[0]] ?? FONT5X7['?'] ?? FONT5X7.A;
  const cell = 34, gw = 5 * cell, gh = 7 * cell, gx = Math.round(cx - gw / 2), gy = Math.round(cy - 20 - gh / 2);
  for (let r = 0; r < 7; r++) for (let cix = 0; cix < 5; cix++) {
    if (glyph[r][cix] !== '#') continue;
    for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) set(gx + cix * cell + dx, gy + r * cell + dy, letterColor);
  }
  const bw = 300, bh = 26, bx = Math.round(cx - bw / 2), by = Math.round(cy + 176);
  for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) set(x, y, GOLD);
  const out = Buffer.alloc(OUT * OUT * 3);
  for (let y = 0; y < OUT; y++) for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const i = ((2 * y + dy) * S + (2 * x + dx)) * 3; r += px[i]; g += px[i + 1]; b += px[i + 2]; }
    const o = (y * OUT + x) * 3; out[o] = r >> 2; out[o + 1] = g >> 2; out[o + 2] = b >> 2;
  }
  return encodePng(out, OUT, OUT);
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchWithRetry(url, tries = 8) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { const res = await fetch(url); if (res.ok) return res; lastErr = new Error(`HTTP ${res.status}`); }
    catch (e) { lastErr = e; }
    if (i < tries - 1) await sleepMs(2500);
  }
  throw new Error(`metadata verification fetch failed for ${url}: ${lastErr?.message ?? lastErr}`);
}
async function verifyMetadataLive(metadata, spec) {
  const res = await fetchWithRetry(metadata.uri);
  let doc;
  try { doc = await res.clone().json(); } catch { throw new Error(`metadata URI ${metadata.uri} did not return parseable JSON`); }
  if ((metadata.source === 'generated' || metadata.source === 'service') && (doc.name !== spec.name || doc.symbol !== spec.symbol || doc.image !== metadata.imageUri)) {
    throw new Error(`staged metadata JSON at ${metadata.uri} does not match this launch (name/symbol/image) — refusing to launch against it`);
  }
  const image = doc.image ?? null;
  if (image) {
    const ires = await fetchWithRetry(image);
    const ct = ires.headers.get('content-type') ?? '';
    if (!ct.startsWith('image/')) throw new Error(`metadata image ${image} returned content-type ${ct || '(none)'} — refusing to launch`);
  }
  return image;
}
// ed25519 signing for the metadata service, via node:crypto
// (tweetnacl is not a dependency of this package, and @solana/web3.js
// Keypair exposes no sign()). A Solana secretKey is seed(32) ||
// pubkey(32); the PKCS8 DER wrapper for an ed25519 seed is a fixed
// 16-byte prefix + the seed. The service verifies the same way
// (SPKI prefix + crypto verify) over the canonical message.
function signMetadataMessage(keypair, message) {
  const seed = Buffer.from(keypair.secretKey.slice(0, 32));
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return cryptoSign(null, Buffer.from(message, 'utf8'), key);
}
async function stageMetadata(spec, metadata) {
  if (metadata.source === 'spec') {
    const image = await verifyMetadataLive(metadata, spec);
    console.log('ok L0 metadata (operator-supplied URI, verified live)', metadata.uri);
    return { source: 'spec', uri: metadata.uri, image, verified: true };
  }
  if (metadata.source === 'service') {
    const serviceBase = metadata.serviceBase;
    const imageBytes = spec.metadataImageFile
      ? fs.readFileSync(spec.metadataImageFile)
      : renderTokenPng(spec.symbol);
    const wallet = launcher.publicKey.toBase58();
    const symbolUpper = String(spec.symbol).toUpperCase();
    const imageSha = createHash('sha256').update(imageBytes).digest('hex');
    const nonce = randomBytes(8).toString('hex'); // 16 random hex chars
    const message = `agentonly-meta:${wallet}:${symbolUpper}:${imageSha}:${nonce}`;
    const signature = bs58.encode(signMetadataMessage(launcher, message));
    const payload = { wallet, name: spec.name, symbol: symbolUpper, imageBase64: imageBytes.toString('base64'), nonce, signature };
    if (spec.description != null) payload.description = spec.description;
    if (spec.metadataExternalUrl != null) payload.externalUrl = spec.metadataExternalUrl;
    const res = await fetch(`${serviceBase}/meta/upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const text = await res.text();
    if (!res.ok) throw new Error(`L0 metadata: metadata service upload failed (HTTP ${res.status}): ${text}`);
    let out;
    try { out = JSON.parse(text); } catch { throw new Error(`L0 metadata: metadata service returned non-JSON: ${text}`); }
    metadata.uri = out.metadataUrl;
    metadata.imageUri = out.imageUrl;
    const image = await verifyMetadataLive(metadata, spec);
    console.log(`ok L0 metadata (public metadata service, wallet-signed upload) — verified live: ${metadata.uri}`);
    return { source: 'service', uri: metadata.uri, image, verified: true, service: { base: serviceBase, wallet } };
  }
  const hooksDir = process.env.LAUNCH_METADATA_DIR || path.join(os.homedir(), 'workspace', 'aonly-site', 'hooks');
  if (!fs.existsSync(hooksDir) || !fs.statSync(hooksDir).isDirectory()) {
    throw new Error(`L0 metadata: staging dir ${hooksDir} does not exist. Set LAUNCH_METADATA_DIR to your static hosting directory (served at ${metadata.uri.slice(0, metadata.uri.lastIndexOf('/'))}), or supply spec.metadataUri. Refusing to launch with an empty metadata URI.`);
  }
  const jsonPath = path.join(hooksDir, metadata.jsonFile);
  const pngPath = path.join(hooksDir, metadata.pngFile);
  const conventionalImage = !spec.metadataImageUri;
  const doc = { description: metadata.description, external_url: metadata.externalUrl, image: metadata.imageUri, name: spec.name, symbol: spec.symbol };
  let reused = false;
  if (fs.existsSync(jsonPath)) {
    try { const ex = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); reused = ex.name === spec.name && ex.symbol === spec.symbol && ex.image === metadata.imageUri; } catch { reused = false; }
    if (!reused) throw new Error(`L0 metadata: ${jsonPath} already exists but does not match this launch — refusing to overwrite another token's metadata. Resolve the symbol collision first.`);
  }
  const stagedFiles = [];
  if (!reused) {
    fs.writeFileSync(jsonPath, JSON.stringify(doc));
    stagedFiles.push(jsonPath);
    if (conventionalImage) { fs.writeFileSync(pngPath, renderTokenPng(spec.symbol)); stagedFiles.push(pngPath); }
    const siteRoot = path.dirname(hooksDir);
    if (!process.env.LAUNCH_METADATA_DIR && fs.existsSync(path.join(siteRoot, 'deploy.py'))) {
      execFileSync('python3', [path.join(siteRoot, 'deploy.py'), '--redeploy'], { stdio: 'inherit' });
    }
  }
  const image = await verifyMetadataLive(metadata, spec);
  console.log('ok L0 metadata', reused ? '(staged files reused)' : '(generated + hosted)', '— verified live:', metadata.uri);
  return { source: 'generated', uri: metadata.uri, image, stagedFiles, verified: true };
}

// ---------- args ----------
const argv = process.argv.slice(2);
// --print-template <agent|human>: print a branch template (templates.mjs)
// as JSON and exit — how a spec author starts from the platform defaults.
const ptIdx = argv.indexOf('--print-template');
if (ptIdx >= 0) {
  const kind = String(argv[ptIdx + 1] ?? '').toLowerCase();
  if (!BRANCH_TEMPLATES.hasOwnProperty(kind)) { console.error(`--print-template needs "agent" or "human", got ${JSON.stringify(argv[ptIdx + 1])}`); process.exit(1); }
  console.log(JSON.stringify(BRANCH_TEMPLATES[kind], null, 2));
  process.exit(0);
}
// --template <agent|human>: merge the branch template UNDER the spec
// file's fields (the spec's explicit fields always win; see
// templates.mjs). The template value token is consumed here so it is
// never mistaken for the spec path.
const tplIdx = argv.indexOf('--template');
const templateKind = tplIdx >= 0 ? String(argv[tplIdx + 1] ?? '').toLowerCase() : null;
if (tplIdx >= 0 && !BRANCH_TEMPLATES.hasOwnProperty(templateKind)) { console.error(`--template needs "agent" or "human", got ${JSON.stringify(argv[tplIdx + 1])}`); process.exit(1); }
const consumedArgIdx = new Set();
if (tplIdx >= 0) { consumedArgIdx.add(tplIdx); consumedArgIdx.add(tplIdx + 1); }
const specPath = argv.find((a, i) => !a.startsWith('--') && !consumedArgIdx.has(i));
const dryRun = argv.includes('--dry-run');
const stageOnly = argv.includes('--stage-metadata');
const outIdx = argv.indexOf('--out');
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;
if (!specPath) { console.error('Usage: node launch.mjs <spec.json> [--dry-run] [--out record.json] [--template agent|human] | node launch.mjs --print-template agent|human'); process.exit(1); }
const specFileJson = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const spec = templateKind ? buildBranchSpec(templateKind, specFileJson) : specFileJson;
if (templateKind) console.log(`template: ${templateKind} branch defaults merged under the spec's explicit fields (templates.mjs — SPEC-AGENTONLY §7 Fork B)`);
const warnings = validateSpec(spec);

const mode = MODES[String(spec.authorityMode ?? 'locked').toLowerCase()];
const decimals = spec.decimals ?? 6;
const graduation = resolveGraduation(spec);
const metadata = resolveMetadata(spec);
const thresholdSol = graduation.thresholdSol;
const rentVaultSol = spec.rentVaultSol ?? 0.05;
const fees = resolveFees(spec);
const holderFees = fees.holderFees;
const rules = (spec.rules ?? []).map(entry => ({ id: ruleIdOf(entry), entry, enabled: entry.enabled !== false }));
const hasRule = (id) => rules.some(r => r.id === id && r.enabled);
// Engine v4 guard + crank pre-flight (offline; pure section above).
// The pre-flight is computed for EVERY spec here, printed in the plan
// (appended to the L1 line) and enforced right after the plan prints —
// before any L-step runs, on both the dry-run and live paths. The
// guard's plan-path decision fetches no RPC (liveSha = null), so a
// rule1+never plan always prints the loud warning; the LIVE path
// re-decides with the fetched ProgramData ELF hash and hard-refuses
// before L0/L1 (see the live execution section).
const preflight = crankPreflightForSpec(spec);
const guardPlanDecision = engineV4GuardDecision(spec, readFixedEngineSha(), null);

// Identities: in dry-run these are EPHEMERAL samples so predicted PDAs can be
// printed; a real launch generates/persists its own (see record output).
function loadLauncherKeypair() {
  const kpPath = process.env.LAUNCH_KEYPAIR || os.homedir() + '/.launch_keypair.json';
  if (!fs.existsSync(kpPath)) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, 'utf8'))));
}
const launcher = (() => {
  if (dryRun) return Keypair.generate(); // plan only — nothing is signed
  if (stageOnly) {
    // Staging signs real artifacts (a metadata-service upload binds the
    // symbol to the signing wallet), so prefer the real keypair when
    // one is available; an ephemeral stage would orphan the symbol.
    const real = loadLauncherKeypair();
    if (real) return real;
    console.warn('WARNING: --stage-metadata with no launcher keypair available (LAUNCH_KEYPAIR / ~/.launch_keypair.json) — using an EPHEMERAL keypair. A metadata-service upload will bind the symbol to this throwaway wallet and cannot be re-uploaded by your real wallet. Set LAUNCH_KEYPAIR before staging if the spec uses the metadata service.');
    return Keypair.generate();
  }
  const kp = loadLauncherKeypair();
  if (!kp) { console.error(`No keypair at ${process.env.LAUNCH_KEYPAIR || os.homedir() + '/.launch_keypair.json'} — create one (mode 600) or set LAUNCH_KEYPAIR. Refusing to launch without a signer.`); process.exit(1); }
  return kp;
})();
const authority = spec.authority ? new PublicKey(spec.authority) : launcher.publicKey;
const feeClaimer = spec.feeClaimer ? new PublicKey(spec.feeClaimer) : launcher.publicKey;
// Holders-destination launches bind the routing duty to the fee claimer:
// the claimer claims the curve fees and routes them into the Distributor
// vault (distributor/INTEGRATION.md path (b)). If the claimer were a
// third party, nothing would ever reach the vault — refuse at launch.
if (fees.destination === 'holders' && !feeClaimer.equals(launcher.publicKey)) {
  console.error('feeDestination "holders" requires feeClaimer to be the launching wallet — it performs the claim -> convert -> route duty (hook.mjs claim-fees). Use the launcher as feeClaimer or set feeDestination "creator".');
  process.exit(1);
}
// Launch signer keypair (Feature A) — three-tier resolution; its
// secret never leaves this process (never printed, never recorded —
// only its pubkey appears in plan/record output):
//   (1) deploy/launcher-tag.json, when present — the operator path
//       (the build tree keeps the canonical file there, mode 600);
//   (2) the bundled browser-src/tag.mjs LAUNCH_TAG_SECRET — the SAME
//       keypair, embedded publicly BY DESIGN (see that file's header):
//       the tag key is fundless and powerless — it holds nothing, owns
//       nothing, and can only co-sign a launch's creation transactions
//       read-only — so publishing it is safe: the worst case is spoofed
//       tags, never funds at risk. This tier is what lets an outside
//       checkout tag its launches identically to the platform's.
//   (3) a stripped tree with neither: an ephemeral sample for dry runs
//       (plan shape only) and a hard refusal for live runs.
const TAG_KEYPAIR_PATH = new URL('../deploy/launcher-tag.json', import.meta.url).pathname;
const tagKeypair = (() => {
  if (fs.existsSync(TAG_KEYPAIR_PATH)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(TAG_KEYPAIR_PATH, 'utf8'))));
  if (Array.isArray(LAUNCH_TAG_SECRET) && LAUNCH_TAG_SECRET.length === 64) return Keypair.fromSecretKey(Uint8Array.from(LAUNCH_TAG_SECRET));
  if (!dryRun && !stageOnly) { console.error(`No launch signer keypair at ${TAG_KEYPAIR_PATH} and no bundled tag key (browser-src/tag.mjs) — every live launch's creation transactions carry the launch signer (Feature A). Refusing to launch untagged.`); process.exit(1); }
  return Keypair.generate();
})();
// LAUNCH_SIGNER — the platform launch signer: the constant public
// identity of the tag above. Printed in the L1/L2 plan lines and
// stored in every launch record (`launchSigner`); indexers enumerate
// this platform's launches by scanning for its (read-only) signature
// on creation transactions.
const LAUNCH_SIGNER = tagKeypair.publicKey;
const devBuy = resolveDevBuy(spec);
const dbcConfig = Keypair.generate();
const baseMint = Keypair.generate();
const mint = baseMint.publicKey;
const pool = deriveDbcPoolAddress(NATIVE_MINT, mint, dbcConfig.publicKey);
const poolAuthority = deriveDbcPoolAuthority();
const baseVault = deriveDbcTokenVaultAddress(pool, mint);
const quoteVault = deriveDbcTokenVaultAddress(pool, NATIVE_MINT);
const distState = distPda(mint);
const distVault = getAssociatedTokenAddressSync(mint, distState, true, T22);
// House derivations (Phase C; null unless graduation "house"). The house
// token vault is created AS the house pool PDA's canonical Token-2022 ATA
// and the quote vault AS its wSOL ATA on the legacy program (H1) — that
// is what lets H4b's SyncRegistered(owner = pool PDA) land in the token
// vault's holder record, mirroring L7b. The seed wallet is a DEDICATED
// per-launch keypair: it exists only to buy the seed on the curve into
// seedAta (exempt at L3) and deliver it into the house token vault (H4).
const isHouse = graduation.mode === 'house';
const houseF = isHouse ? resolveHouseFields(spec) : null;
const housePoolPda = isHouse ? PublicKey.findProgramAddressSync([Buffer.from('pool'), mint.toBuffer()], HOUSE_SWAP_PROGRAM_ID)[0] : null;
const houseTokenVault = isHouse ? getAssociatedTokenAddressSync(mint, housePoolPda, true, T22) : null;
const houseQuoteVault = isHouse ? getAssociatedTokenAddressSync(NATIVE_MINT, housePoolPda, true, TOKEN_PROGRAM_ID) : null;
const houseVaultPda = isHouse ? pdaE([Buffer.from('housevault'), mint.toBuffer()]) : null;
const seedWallet = isHouse ? Keypair.generate() : null;
const seedAta = isHouse ? getAssociatedTokenAddressSync(mint, seedWallet.publicKey, false, T22) : null;
// House L3 exemption derivation (Phase C forks 1 + 3, resolved): for a
// house-committed config the exemption set is derived HERE, at L3, as
// [poolAuthority, baseVault, seedAta, houseTokenVault, houseQuoteVault,
// feeDestTokenAta] — 6 entries, within the engine's MAX_EXEMPTIONS = 8.
// Both house vault ATAs are known before L3 (H1 creates exactly these
// addresses), so the house token vault is exempt from the start: the H4
// seed transfer is no longer judged by rule 9 (Max Wallet) like any
// receive, and a house launch may seed past the cap. The engine's
// ActivateHouse append of the two vaults is idempotent, so activation
// does not duplicate them or burn slots. feeDestTokenAta is the
// canonical Token-2022 ATA of fees.feeClaimer for the mint: the fee
// claimer is fixed at L1 (the DBC config's fee_claimer, which the launch
// record stores as fees.feeClaimer) and the mint exists before L3, so
// the address falls out at launch time. It is an ACCOUNT-scoped
// exemption (the engine's is_exempt matches owner-or-account; an ATA
// entry exempts only that account, never the wallet's other accounts) —
// it exists so houseswap ClaimFees' token leg, which pays the accrued
// token fees into exactly this ATA, cannot be vetoed by rule 9 once the
// destination is over cap. ClaimFees exists only on house tokens, so
// house-only scoping is correct.
const feeDestTokenAta = isHouse ? getAssociatedTokenAddressSync(mint, feeClaimer, true, T22) : null;
const l3Exemptions = isHouse
  ? [poolAuthority, baseVault, seedAta, houseTokenVault, houseQuoteVault, feeDestTokenAta]
  : [poolAuthority, baseVault];
const houseBlock = isHouse ? { program: HOUSE_SWAP_PROGRAM_ID, thresholdLamports: graduation.houseThresholdLamports, reserveLamports: solToLamportsExact(houseF.houseReserveSol) ?? 0n } : null;

const tpl = requiredExtras(rules);
// House budget additions (Phase C): house pool account rent (264 B),
// the HouseVault PDA rent (128 B), the two house vault token accounts,
// the committed reserve, and the seed wallet's funding + seed buy.
const RENT_HOUSE_POOL = (264 + 128) * 6960 / 1e9, RENT_HOUSE_VAULT = (128 + 128) * 6960 / 1e9;
const houseBudgetSol = isHouse ? RENT_HOUSE_POOL + RENT_HOUSE_VAULT + 2 * RENT.tokenAccount
  + houseF.houseReserveSol + houseF.houseSeedWalletSol + houseF.houseSeedBuySol : 0;
const budgetSol =
  RENT.configPda + metaListRent(tpl.count) +
  (hasRule(1) ? RENT.priceFeed : 0) +
  (holderFees ? RENT.distState + RENT.tokenAccount : 0) +
  rentVaultSol + (spec.seedSol ?? 0) + (devBuy ? devBuy.sol : 0) + houseBudgetSol;

const plan = [];
plan.push(['L0', 'token metadata — generated, hosted, verified BEFORE the pool exists (never an empty URI)', metadata.source === 'service' ? 'public metadata service (wallet-signed upload) + live fetch verification' : 'static hosting at agentonly.fun (site deploy) + live fetch verification', metadata.source === 'spec'
  ? `operator-supplied metadataUri used verbatim: ${metadata.uri} — a live run fetches it first and refuses to launch if it does not resolve to parseable JSON (contents are the operator's responsibility)`
  : metadata.source === 'service'
    ? `launcher uploads the token image (spec.metadataImageFile, or a generated 512×512 monogram) + name/symbol/description to the public metadata service at ${metadata.serviceBase}, signed with the launcher wallet (the upload binds the symbol to that wallet), and verifies the hosted JSON live before L1; predicted uri written at L2 = ${metadata.uri} (the upload response's metadataUrl replaces it at staging time)`
    : `launcher generates ${metadata.pngFile} (512×512 generated monogram in the site palette; override with spec.metadataImageUri) + ${metadata.jsonFile} (name/symbol/description/image, the HARVEST repair shape) into the site tree, deploys the site, and verifies ${metadata.uri} and ${metadata.imageUri} live (200, JSON parses, image is an image) before L1; uri written at L2 = ${metadata.uri}; description: "${metadata.description}"`]);
const migrationDesc = graduation.mode === 'never'
  ? `migration threshold ${NEVER_THRESHOLD_SOL} SOL (u64::MAX lamports — set to never complete; this token never migrates)`
  : graduation.mode === 'house'
    ? `migration threshold ${NEVER_THRESHOLD_SOL} SOL (u64::MAX lamports — never physics; the token graduates onto the house venue at ${graduation.houseThresholdSol} SOL of curve quote reserve instead)`
    : `migration threshold ${thresholdSol} SOL → DAMM v2`;
const cfgFields = configFieldsText(graduation.thresholdSol, spec);
plan.push(['L1', 'DBC createConfigWithTransferHook', `program ${DBC_ID.toBase58()}`, `config=${dbcConfig.publicKey.toBase58()} fee_claimer=${feeClaimer.toBase58()} hook=${ENGINE.toBase58()} curve: ${(spec.supply ?? 1_000_000_000).toLocaleString()} supply, creator fee ${fees.feeBps}bps${fees.feeBpsEnd !== fees.feeBps ? ` decaying to ${fees.feeBpsEnd}bps` : ' flat'}, ${migrationDesc}; ${cfgFields}; ${partnerIdentityText(feeClaimer)}; launch signer=${LAUNCH_SIGNER.toBase58()} — LAUNCH_SIGNER co-signs this creation transaction READ-ONLY (the attribution placement verified from HookedPad's creation transactions; enumerates every AgentOnly launch by signature; carried by the appended tag memo — our legacy signing stack cannot compile an unreferenced signer); ${crankPreflightText(preflight)}`]);
plan.push(['FEE', 'creator fee — set at launch, claimed on demand', 'venue fee direction (the hook never touches fees)', `${fees.feeBps} bps of every trade accrues to fee_claimer=${feeClaimer.toBase58()}; destination: ${fees.destination === 'holders' ? 'HOLDERS — the claimer claims, converts, and routes into the Distributor vault (hook.mjs claim-fees); anyone cranks the fold' : 'CREATOR — the claimer keeps the fees, claimed as SOL with hook.mjs claim-fees'}`]);
plan.push(['GRADUATION', graduation.mode === 'never' ? 'never — the rules are permanent' : graduation.mode === 'house' ? 'house — graduate at the house threshold onto the house venue, the rules stay' : 'release — the rules retire at graduation', graduation.mode === 'house' ? 'house commitment (engine Config house region, written at L3) + DBC curve built with never physics' : 'DBC migration threshold (set in the L1 config)', graduation.mode === 'never'
  ? `threshold = ${NEVER_THRESHOLD_LAMPORTS} lamports (u64::MAX ≈ 18,446,744,073.71 SOL — more than the entire SOL supply): the curve can never complete, so this token never migrates to DAMM v2, the hook keeps enforcing the rules on every transfer forever, the 20% migration tranche stays locked in the pool vault, and only hook-aware doors can ever trade it`
  : graduation.mode === 'house'
    ? `the curve is built with the never threshold (${NEVER_THRESHOLD_LAMPORTS} lamports — it can never complete or migrate, and stays as the legacy door), and the token graduates onto the house venue instead: when the curve's quote reserve reaches ${graduation.houseThresholdSol} SOL (${graduation.houseThresholdLamports} lamports) and the house pool is seeded (reserve ${houseF.houseReserveSol} SOL committed at H6 and/or curve fees deposited via engine tag 16), anyone can flip activation — engine tag 14 (ActivateHouse) pays the caller a 1% cut of the fee balance, moves the seed into the house quote vault, appends the house program to the config's venues (the two house vaults are already exempt from L3 — their activation append is idempotent and adds nothing), and the houseswap ActivatePool (tag 5) then mirrors the curve's creator fee (${fees.feeBps} bps to the DBC config's fee_claimer). The rules stay enforced on every transfer; doors default to the house pool from activation on`
    : `at ${thresholdSol} SOL raised the curve completes: the token migrates to DAMM v2, the hook is revoked, the rules retire, and the token trades freely everywhere`]);
if (guardPlanDecision.applies) { const gi = plan.findIndex((p) => p[0] === 'GRADUATION'); plan[gi][3] += `; ENGINE V4 GUARD — ${rule1NeverRefusal(guardPlanDecision)}`; }
plan.push(['L2', 'DBC createPoolWithTransferHook', `program ${DBC_ID.toBase58()}`, `mint=${mint.toBase58()} pool=${pool.toBase58()} name="${spec.name}" symbol="${spec.symbol}" uri="${metadata.uri}" (mint is created BY DBC carrying the ENGINE hook; hook authority moves to the pool authority) + launch signer ${LAUNCH_SIGNER.toBase58()} (LAUNCH_SIGNER co-signs this creation transaction READ-ONLY — the attribution placement verified from HookedPad's creation transactions) + launch tag memo "${LAUNCH_TAG_MARKER}" (SPL Memo ${MEMO_PROGRAM_ID.toBase58()}, sole signer ${LAUNCH_SIGNER.toBase58()} read-only — the fundless platform launch signer; identifies our launches to terminals/routers, changes nothing else in the tx)`]);
if (isHouse) {
  plan.push(['H0', 'fund the dedicated seed wallet', 'system transfer', `${houseF.houseSeedWalletSol + houseF.houseSeedBuySol} SOL → seed wallet ${seedWallet.publicKey.toBase58()} (funding ${houseF.houseSeedWalletSol} + the H3 seed buy ${houseF.houseSeedBuySol}); a fresh per-launch keypair that exists only for the seed — its ATA is the disclosed L3 exemption (house.seedExemption in the record)`]);
  plan.push(['H1', 'create the house vaults (owned by the house pool PDA)', 'token-2022 + legacy token (ATA creation)', `token vault=${houseTokenVault.toBase58()} — created AS the house pool PDA's canonical Token-2022 ATA for the mint (so H4b's SyncRegistered for owner = pool PDA lands in this vault's holder record); quote vault=${houseQuoteVault.toBase58()} — the pool PDA's wSOL ATA on the legacy token program`]);
  plan.push(['H2', 'houseswap InitPool (authority = launcher, pre-commit)', `program ${HOUSE_SWAP_PROGRAM_ID.toBase58()}`, `pool PDA=${housePoolPda.toBase58()} token_vault=${houseTokenVault.toBase58()} quote_vault=${houseQuoteVault.toBase58()} — the pool record's first 168 bytes mirror the TaxSwap layout; committed=0 until H5, live=0 until activation`]);
}
plan.push(['L3', 'engine InitializeConfig', `program ${ENGINE.toBase58()}`, `config PDA=${configPda(mint).toBase58()} mode=${spec.authorityMode ?? 'locked'}(${mode}) authority=${authority.toBase58()} rules=[${rules.map(r => `${r.id} ${RULE_NAMES[r.id]}`).join(', ') || 'none'}] venues=[DBC] exemptions=[poolAuthority=${poolAuthority.toBase58()}, baseVault=${baseVault.toBase58()}${isHouse ? `, seedAta=${seedAta.toBase58()} (the disclosed seed-account exemption), houseTokenVault=${houseTokenVault.toBase58()} (the house pool PDA's Token-2022 ATA for the mint — exempt from L3 so the H4 seed transfer is not capped by rule 9; ActivateHouse's append of it is idempotent), houseQuoteVault=${houseQuoteVault.toBase58()} (the house pool PDA's wSOL ATA — same idempotent activation append), feeDestTokenAta=${feeDestTokenAta.toBase58()} (the canonical Token-2022 ATA of fee_claimer=${feeClaimer.toBase58()} for the mint — account-scoped, so houseswap ClaimFees' token leg cannot be vetoed by rule 9 once the fee destination is over cap)` : ''}]${isHouse ? ` + house block: program=${HOUSE_SWAP_PROGRAM_ID.toBase58()} threshold=${graduation.houseThresholdLamports} lamports reserve=${houseBlock.reserveLamports} lamports (config created at CONFIG_SPACE_V2 1152 B with the HouseVault PDA; the commitment is init-only and immutable thereafter)` : ''}${isHouse ? `; L3 instruction accounts = [launcher(s,w), mint, config(w), system, houseVault=${houseVaultPda.toBase58()}(w)] — the engine demands the HouseVault PDA as the 5th account on house payloads` : ''}`]);
plan.push(['L4', 'engine InitializeExtraAccountMetas (templated per config)', `program ${ENGINE.toBase58()}`, `meta list PDA=${metaPda(mint).toBase58()} (${tpl.count} extras: ${tpl.extras.map(e => `${e.name} — ${e.why}`).join('; ')}; ${metaListSize(tpl.count)} bytes${tpl.staticList ? ' — no holder state: fully static, generic-resolver safe' : ''})`]);
if (hasRule(1)) plan.push(['L4b', 'engine InitializePriceFeed', `program ${ENGINE.toBase58()}`, `feed PDA=${pricePda(mint).toBase58()} pool=${pool.toBase58()} token_vault=${baseVault.toBase58()} quote_vault=${quoteVault.toBase58()} decimals=${decimals}/${9}`]);
plan.push(['L5', 'fund rent-vault PDA', 'system transfer', `${rentVaultSol} SOL → ${rentVaultPda(mint).toBase58()} (≈ ${Math.floor(rentVaultSol / RENT.holderPda)} lazy Holder PDAs)`]);
plan.push(['L6', '(advisory, per buyer)', '—', tpl.staticList
  ? 'none needed — this token\'s meta list is fully static (no AccountData seeds), so generic resolvers and routers can build a first buy before the buyer\'s ATA exists; the generic [create ATA, swap] bundle just works'
  : 'before a buyer\'s first swap build, ensure their base ATA exists on-chain (build-time meta resolution reads it; ATA creation fires no hook)']);
if (holderFees) plan.push(['L7', 'Distributor initialize (+ fee vault ATA)', `program ${DISTRIBUTOR.toBase58()}`, `state PDA=${distState.toBase58()} vault ATA=${distVault.toBase58()} (owner = state PDA) caller_cut=${holderFees.callerCutBps}bps; funding mode auto-derives from the mint (DBC mint = no fee extension → mode 1, routed). Fee routing target = this distributor vault: the fee_claimer claims curve/LP fees, converts to ${spec.symbol}, transfers into the vault; anyone cranks distribute. See distributor/INTEGRATION.md.`]);
if (holderFees && hasRule(3)) plan.push(['L7b', 'engine SyncRegistered (authority path) for the Distributor vault owner', `program ${ENGINE.toBase58()}`, `holder PDA for owner=${distState.toBase58()} gets registered=1 — the vault is a PDA and can never self-register, and rule 3 (Agent-Only) checks the DESTINATION mirror on every transfer; without this the claimer's routing deposits into the vault would be vetoed NotRegistered. The config authority performs it (engine SyncRegistered path (a) — the documented launch-flow path for infrastructure accounts).`]);
if (isHouse) {
  plan.push(['H3', `seed buy — the seed wallet buys ${houseF.houseSeedBuySol} SOL of ${spec.symbol} on the curve into seedAta`, `program ${DBC_ID.toBase58()} (swap2WithTransferHook)`, `target ≈ ${houseF.houseSeedTokens} ${spec.symbol} (the buy is sized in SOL; the record names the target and what landed). seedAta is exempt, so the buy cannot be vetoed by the stack it seeds. The seed wallet's ATA is created first if needed (build-time meta resolution reads it)`]);
  if (hasRule(3) || hasRule(17)) plan.push(['H4b', 'engine SyncRegistered (authority path) for the house token vault — BEFORE H4', `program ${ENGINE.toBase58()}`, `mirrors L7b: the house pool PDA can never self-register, and rule ${hasRule(3) ? '3 (Agent-Only)' : '17 (Ecosystem Gate)'} checks the DESTINATION mirror on every transfer — without this the H4 seed transfer into the vault would be vetoed NotRegistered. Because H1 created the token vault AS the pool PDA's canonical ATA, SyncRegistered(owner = house pool PDA) lands in the vault's own holder record`]);
  plan.push(['H4', 'seed transfer — seedAta → house token vault', 'token-2022 TransferChecked WITH the hook tail (extras resolved from the mint meta list — a plain transfer on a hooked mint fails MissingExtra)', `the full seed balance moves into the house token vault ${houseTokenVault.toBase58()}, where it sits as the house pool's token reserve until activation. The destination is exempt from L3 (see the L3 line), so rule 9 cannot cap the seed and no rule module judges the vault's receive — the seed may exceed the per-wallet cap. (Trial-mint configurations that do NOT pre-exempt the vault instead get the benign rule-1 basis record disclosed in houseswap/INTEGRATION.md.) Rules 3/17 destination-mirror preparation is what H4b covers`]);
  plan.push(['H5', 'houseswap CommitPool — the lock', `program ${HOUSE_SWAP_PROGRAM_ID.toBase58()}`, `authority-signed (launcher): the pool authority rotates to the program's own ["poolauth", mint] PDA and committed := 1 — one-way. After this, AddLiquidity/RemoveLiquidity are dead (nobody can sign for the pool authority) and the engine's ActivateHouse will accept the pool as the committed venue`]);
  plan.push(['H6', 'house reserve commitment', `program ${ENGINE.toBase58()}`, houseF.houseReserveSol > 0
    ? `plain transfer of ${houseF.houseReserveSol} SOL from the launcher → HouseVault PDA ${houseVaultPda.toBase58()}, then engine tag 17 (RecordHouseReserve, authority-signed) records reserve_balance = the committed ${houseBlock.reserveLamports} lamports after verifying the lamports landed. With no reserve (houseReserveSol = 0) this step is skipped and the activation seed comes from claimed curve fees deposited via engine tag 16 (DepositHouseFees) alone`
    : `houseReserveSol = 0 — no reserve transfer, no tag 17: the activation seed comes entirely from claimed curve fees deposited into the HouseVault via engine tag 16 (DepositHouseFees) before activation`]);
}
if (devBuy) {
  const gated = hasRule(3) || hasRule(17);
  if (gated) {
    plan.push(['L8', 'DEV BUY prerequisite — register the launcher wallet in the Registry', `program ${REGISTRY.toBase58()}`, `the dev buy's destination is the launcher wallet itself, and rule ${hasRule(3) ? '3 (Agent-Only)' : '17 (Ecosystem Gate)'} checks the destination's registration mirror — conditional step: skipped automatically if a Registration PDA for ${launcher.publicKey.toBase58()} already exists (checked on-chain at execute time)${hasRule(17) ? '; NOTE for rule 17: a plain registration carries ecosystem 0 — the buy passes only if the launcher\'s existing registration is attested for this token\'s ecosystem; attestation needs the ecosystem attester\'s co-signature, which the launcher cannot give itself, so execute refuses rather than sending a buy that would veto WrongEcosystem' : ''}`]);
    plan.push(['L8b', 'DEV BUY prerequisite — sync the launcher registration into this token\'s Holder PDA', `program ${ENGINE.toBase58()}`, `engine SyncRegistered (self path) for owner=${launcher.publicKey.toBase58()} — conditional step: skipped automatically if the Holder PDA mirror already reads registered=1 (checked on-chain at execute time)`]);
  }
  if (hasRule(1)) plan.push(['L8c', 'DEV BUY prerequisite — crank the price feed (CrankPriceDbc)', `program ${ENGINE.toBase58()}`, `rule 1 (Basis Latch) records the buyer's basis from the feed EMA and fails closed on a stale feed — the first crank must land before the first buy (the Latch mainnet order); accounts: config=${configPda(mint).toBase58()} feed=${pricePda(mint).toBase58()} pool=${pool.toBase58()}`]);
  plan.push(['L9', `DEV BUY — launcher buys ${devBuy.sol} SOL of ${spec.symbol} on the curve (first swap after activation)`, `program ${DBC_ID.toBase58()} (swap2WithTransferHook)`, `its OWN transaction, submitted immediately after activation (L4/L4b/L5 + L7/L7b + the L8 prerequisites above) inside this same launch run, nothing else intervening. NOT atomic with activation: the swap build resolves the hook's extra accounts by reading the on-chain meta list, which exists only after L4 lands — so no same-transaction dev buy exists on the standard build path. Guarantee, exactly: first swap after activation, submitted by the launcher in the same run; a third party landing in an earlier slot could theoretically precede it. The buy also creates the launcher's base ATA first if needed (build-time meta resolution reads it).`]);
}

console.log(`Hook Launcher — ${spec.name} (${spec.symbol})`);
console.log(`mode: ${dryRun ? 'DRY RUN (nothing will be sent)' : 'LIVE'}${dryRun ? ' — sample identities, predicted addresses only' : ''}`);
console.log(`launcher/authority: ${launcher.publicKey.toBase58()} / ${authority.toBase58()}`);
for (const w of warnings) console.log('WARNING:', w);
if (guardPlanDecision.applies) console.log(`WARNING: ENGINE V4 GUARD — ${dryRun
  ? `rule 1 (Basis Latch) + graduation "never": a LIVE launch of this spec is REFUSED until the v4 engine (crank overflow fix) is verified live. Checked so far (plan path, no RPC fetched): ${guardPlanDecision.checked}. The live path re-checks against the fetched ProgramData ELF and hard-refuses before L0/L1 on a missing file, a null hash, a fetch failure, or a mismatch.`
  : `rule 1 (Basis Latch) + graduation "never": this launch is REFUSED before L0/L1 unless the v4 engine (crank overflow fix) verifies live — the check runs immediately below (launcher/${ENGINE_V4_FILE_NAME} fixedEngineSha256 vs the live ProgramData ELF sha256; fail closed).`}`);
console.log('\nOrdered plan:');
for (const [step, name, prog, detail] of plan) console.log(`  ${step}. ${name}\n      ${prog}\n      ${detail}`);
console.log(`\nEstimated launch cost (state rent + rent-vault funding + seed): ~${budgetSol.toFixed(6)} SOL + tx fees`);
console.log(`  (config ${RENT.configPda} + metas ${metaListRent(tpl.count)} (${tpl.count} templated extras)${hasRule(1) ? ` + feed ${RENT.priceFeed}` : ''}${holderFees ? ` + distributor state ${RENT.distState} + vault ATA ${RENT.tokenAccount}` : ''} + rent vault ${rentVaultSol} + seed ${spec.seedSol ?? 0}${devBuy ? ` + dev buy ${devBuy.sol}` : ''}${isHouse ? ` + house: pool ${RENT_HOUSE_POOL} + housevault ${RENT_HOUSE_VAULT} + 2 vault token accounts ${2 * RENT.tokenAccount} + reserve ${houseF.houseReserveSol} + seed wallet funding ${houseF.houseSeedWalletSol} + seed buy ${houseF.houseSeedBuySol}` : ''})`);

// Crank pre-flight enforcement — BOTH paths pass through here (the
// live execution section is below), the plan above has printed, and no
// L-step has run yet. A failing spec refuses now, naming the quantity
// that overflowed / the spot that came out non-positive.
if (!preflight.ok) {
  console.error(`REFUSED — crank pre-flight failed for this spec, before any launch step ran: ${preflight.failures.join('; ')}. (sqrt_start_price=${preflight.sqrtPrice}; fixed decomposition in launch.mjs crankPreflight, PRICE_SCALE=10^12.) No transactions were sent.`);
  process.exit(1);
}
if (dryRun) {
  console.log('\nDRY RUN complete — no transactions sent, no RPC touched.');
  process.exit(0);
}
if (stageOnly) {
  // L0 only: generate/host/verify the token metadata, then stop — no
  // keypair, no chain writes. This is the staging path the browser
  // composer points its users at before a browser launch.
  const rep = await stageMetadata(spec, metadata);
  console.log('metadata staged + verified:', JSON.stringify(rep));
  process.exit(0);
}

// ---------- LIVE execution (not exercised by this workstream: LiteSVM/dry-run only) ----------
const rpcUrl = process.env.LAUNCH_RPC;
if (!rpcUrl) { console.error('LAUNCH_RPC is required for a live launch (or pass --dry-run).'); process.exit(1); }
const conn = new Connection(rpcUrl, 'confirmed');
const client = new DynamicBondingCurveClient(conn, 'confirmed');
const sendTx = makeSender(rpcUrl);
const sigs = {};
// Engine v4 guard — LIVE path, hard refuse, before L0 (and therefore
// before L1): rule 1 + graduation "never" proceeds ONLY if the fixed
// engine verifies live (launcher/engine-v4.json's fixedEngineSha256
// matches the live ProgramData ELF sha256). Fail closed on every other
// outcome — see the pure decision + I/O wrappers above.
{
  const decision = await liveEngineV4Decision(spec, conn);
  if (decision.applies && !decision.allow) { console.error('REFUSED — ENGINE V4 GUARD:', rule1NeverRefusal(decision)); process.exit(1); }
  if (decision.applies) console.log('ok engine v4 guard —', decision.reason);
}
// L0: token metadata — generated + hosted + verified BEFORE the pool
// exists, so the mint is born with its URI (discovery fix, 2026-10-16).
const metaReport = await stageMetadata(spec, metadata);
// Partner identity (Phase A): the L1 config hangs from the launcher's
// registered partner identity through feeClaimer alone — verify the fee
// claimer's partner-metadata account exists BEFORE L1 mints a config
// that would otherwise index as anonymous DBC flow.
let partnerIdentityRecord = null;
{
  const md = await client.state.getPartnerMetadata(feeClaimer);
  if (md) {
    partnerIdentityRecord = { name: md.name, website: md.website, logo: md.logo, metadataAccount: derivePartnerMetadata(feeClaimer).toBase58(), feeClaimer: feeClaimer.toBase58() };
    console.log('ok L1 partner identity', JSON.stringify(md.name), '— metadata account', partnerIdentityRecord.metadataAccount, 'for fee_claimer', feeClaimer.toBase58());
  } else if (feeClaimer.equals(launcher.publicKey)) {
    throw new Error(`partner identity missing: no partner-metadata account for the launcher wallet ${feeClaimer.toBase58()} — refusing to launch a config that would index as anonymous DBC flow. Create your own identity once: node create-partner-metadata.mjs write with PARTNER_NAME / PARTNER_WEBSITE / PARTNER_LOGO set to your own values`);
  } else {
    console.warn(`WARNING: fee_claimer ${feeClaimer.toBase58()} has no DBC partner-metadata account — this launch carries no partner identity and will index as anonymous DBC flow. (The platform identity "${PARTNER_IDENTITY.name}" attaches only when the fee claimer is the platform wallet; any other claimer carries its own identity or none.)`);
  }
}
{
  const tx = await client.partner.createConfigWithTransferHook({
    config: dbcConfig.publicKey, feeClaimer, leftoverReceiver: feeClaimer, payer: launcher.publicKey,
    quoteMint: NATIVE_MINT, transferHookProgram: ENGINE, ...curveConfig(thresholdSol, spec),
  });
  // Launch signer (Feature A): the tag keypair co-signs the config-
  // creation transaction READ-ONLY — the placement verified in
  // HookedPad's creation tx (their combined create tx carries the
  // platform signer in its signer set the same way). The memo rides
  // as the carrying instruction because the legacy web3.js compiler
  // rejects a signer no instruction references; the create
  // instruction itself is untouched and does not reference the signer.
  tx.add(buildTagMemoIx(tagKeypair.publicKey));
  sigs.dbcConfig = await sendTx(tx, [launcher, dbcConfig, tagKeypair], 'L1 createConfigWithTransferHook');
}
{
  const tx = await client.creator.createPoolWithTransferHook({
    baseMint: mint, config: dbcConfig.publicKey, transferHookProgram: ENGINE,
    name: spec.name, symbol: spec.symbol, uri: metadata.uri,
    payer: launcher.publicKey, poolCreator: launcher.publicKey,
  });
  // Feature A: the launch signer co-signs this transaction read-only
  // (below, in the signers list — the HookedPad placement), and ONE memo
  // instruction is appended, signed read-only by the same keypair as a
  // readable label. Nothing else in the transaction changes (proven
  // byte-identical excluding this instruction:
  // launcher/trial-launch-features.mjs).
  tx.add(buildTagMemoIx(tagKeypair.publicKey));
  sigs.dbcPool = await sendTx(tx, [launcher, baseMint, tagKeypair], 'L2 createPoolWithTransferHook');
}
if (isHouse) {
  // H0: fund the dedicated seed wallet (funding + the H3 seed buy).
  {
    const ix = SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: seedWallet.publicKey, lamports: Math.round((houseF.houseSeedWalletSol + houseF.houseSeedBuySol) * LAMPORTS_PER_SOL) });
    sigs.houseSeedFund = await sendTx(new Transaction().add(ix), [launcher], 'H0 fund seed wallet');
    // The seed keypair is persisted next to the launch records (mode
    // 600) so any post-seed dust stays recoverable; only its pubkey
    // enters the launch record itself.
    const seedPath = new URL(`../deploy/house-seed-${spec.symbol.toLowerCase()}.json`, import.meta.url).pathname;
    fs.writeFileSync(seedPath, JSON.stringify(Array.from(seedWallet.secretKey)), { mode: 0o600 });
  }
  // H1: the house vaults — the token vault AS the pool PDA's canonical
  // Token-2022 ATA, the quote vault AS its wSOL ATA (legacy program).
  {
    const mkToken = createAssociatedTokenAccountInstruction(launcher.publicKey, houseTokenVault, housePoolPda, mint, T22);
    const mkQuote = createAssociatedTokenAccountInstruction(launcher.publicKey, houseQuoteVault, housePoolPda, NATIVE_MINT, TOKEN_PROGRAM_ID);
    sigs.houseVaults = await sendTx(new Transaction().add(mkToken, mkQuote), [launcher], 'H1 create house vaults');
  }
  // H2: houseswap InitPool (authority = launcher until H5 commits it).
  {
    const ix = new TransactionInstruction({ programId: HOUSE_SWAP_PROGRAM_ID, data: Buffer.from([0]),
      keys: [K(launcher.publicKey, true, true), K(mint, false, false), K(NATIVE_MINT, false, false), K(houseTokenVault, false, false), K(houseQuoteVault, false, false), K(housePoolPda, false, true), K(SystemProgram.programId, false, false)] });
    sigs.houseInitPool = await sendTx(new Transaction().add(ix), [launcher], 'H2 houseswap InitPool');
  }
}
{
  const cfg = { mode, authority, rules, venues: [DBC_ID], exemptions: l3Exemptions };
  // Phase C: on a house payload the engine's initialize_config reads a
  // FIFTH account — the HouseVault PDA, writable, after the system
  // program (engine/src/lib.rs:1799–1801; demanded at :1824). Omitting
  // it fails L3 with NotEnoughAccountKeys (HPROOF's first L3 attempt,
  // 2026-10-20). The list below is exactly the corrected list the
  // in-place resume proved on mainnet
  // (deploy/proof-launches/resume-hproof.mjs, sig w62KD25t…).
  const ix = new TransactionInstruction({ programId: ENGINE, data: configPayload(cfg, 1, houseBlock),
    keys: [K(launcher.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, true), K(SystemProgram.programId, false, false),
      ...(isHouse ? [K(houseVaultPda, false, true)] : [])] });
  sigs.engineConfig = await sendTx(new Transaction().add(ix), [launcher], 'L3 engine InitializeConfig');
}
{
  const ix = new TransactionInstruction({ programId: ENGINE, data: INIT_METAS_DISC,
    keys: [K(launcher.publicKey, true, true), K(metaPda(mint), false, true), K(mint, false, false), K(SystemProgram.programId, false, false), K(configPda(mint), false, false)] });
  sigs.engineMetas = await sendTx(new Transaction().add(ix), [launcher], 'L4 engine InitializeExtraAccountMetas');
}
if (hasRule(1)) {
  const data = Buffer.concat([Buffer.from([6]), pool.toBuffer(), baseVault.toBuffer(), quoteVault.toBuffer(), Buffer.from([decimals, 9])]);
  const ix = new TransactionInstruction({ programId: ENGINE, data,
    keys: [K(launcher.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, false), K(pricePda(mint), false, true), K(SystemProgram.programId, false, false)] });
  sigs.priceFeed = await sendTx(new Transaction().add(ix), [launcher], 'L4b engine InitializePriceFeed');
}
{
  const ix = SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: rentVaultPda(mint), lamports: Math.round(rentVaultSol * LAMPORTS_PER_SOL) });
  sigs.rentVault = await sendTx(new Transaction().add(ix), [launcher], 'L5 fund rent vault');
}
if (holderFees) {
  const cut = holderFees.callerCutBps;
  const data = Buffer.from([0, cut & 0xff, (cut >> 8) & 0xff]);
  const createVault = createAssociatedTokenAccountInstruction(launcher.publicKey, distVault, distState, mint, T22);
  const init = new TransactionInstruction({ programId: DISTRIBUTOR, data,
    keys: [K(launcher.publicKey, true, true), K(mint, false, false), K(distVault, false, false), K(distState, false, true), K(SystemProgram.programId, false, false)] });
  sigs.distributor = await sendTx(new Transaction().add(createVault, init), [launcher], 'L7 distributor initialize');
  if (hasRule(3)) {
    // L7b: the vault's owner is the Distributor state PDA — it can never
    // self-register, and rule 3 checks the destination mirror. The config
    // authority sets it via SyncRegistered path (a) (see plan line L7b).
    // Engine v3: SyncRegistered mirrors into the record keyed by the
    // owner's ATA for the mint — for the state PDA that IS distVault.
    const holderPda = pdaE([Buffer.from('holder'), mint.toBuffer(), distVault.toBuffer()]);
    const sync = new TransactionInstruction({ programId: ENGINE, data: Buffer.from([4, 1]),
      keys: [K(launcher.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, false), K(distState, false, false), K(holderPda, false, true), K(SystemProgram.programId, false, false)] });
    sigs.distVaultSync = await sendTx(new Transaction().add(sync), [launcher], 'L7b sync distributor-vault holder mirror');
  }
}
let houseRecord = null;
if (isHouse) {
  // H3: the seed buy — the seed wallet buys on the curve into seedAta
  // (exempt at L3, so the stack cannot veto its own seed). The ATA is
  // created first (build-time meta resolution reads it).
  if (!(await conn.getAccountInfo(seedAta))) {
    await sendTx(new Transaction().add(createAssociatedTokenAccountInstruction(launcher.publicKey, seedAta, seedWallet.publicKey, mint, T22)), [launcher], 'H3 create seed ATA (before seed buy build)');
  }
  const seedSwapTx = await client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: false,
    amountIn: new BN(Math.round(houseF.houseSeedBuySol * LAMPORTS_PER_SOL)), minimumAmountOut: new BN(0),
    owner: seedWallet.publicKey, pool, referralTokenAccount: null, payer: seedWallet.publicKey,
  });
  sigs.houseSeedBuy = await sendTx(seedSwapTx, [seedWallet], `H3 seed buy ${houseF.houseSeedBuySol} SOL`);
  const seedBalInfo = await conn.getAccountInfo(seedAta);
  const seedRaw = seedBalInfo ? seedBalInfo.data.readBigUInt64LE(64) : 0n;
  if (seedRaw <= 0n) throw new Error('H3 seed buy landed no tokens in seedAta — refusing to continue a house launch with an empty seed');
  // H4b (rules 3/17 ONLY, BEFORE H4): SyncRegistered authority path for
  // the house pool PDA — its mirror lands in the record keyed by the
  // pool PDA's ATA for the mint, which IS the house token vault (H1).
  if (hasRule(3) || hasRule(17)) {
    const vaultHolderPda = pdaE([Buffer.from('holder'), mint.toBuffer(), houseTokenVault.toBuffer()]);
    const sync = new TransactionInstruction({ programId: ENGINE, data: Buffer.from([4, 1]),
      keys: [K(launcher.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, false), K(housePoolPda, false, false), K(vaultHolderPda, false, true), K(SystemProgram.programId, false, false)] });
    sigs.houseVaultSync = await sendTx(new Transaction().add(sync), [launcher], 'H4b sync house-vault holder mirror');
  }
  // H4: seed transfer seedAta → house token vault. HOOK-CORRECT form
  // (Phase C recovery fix): a Token-2022 transfer on a hooked mint must
  // carry the hook's resolved extra accounts — the plain
  // TransferChecked this step originally built (contract §3.1's note)
  // fails on-chain with MissingExtra even though the source is exempt,
  // because the hook still executes. The hook-aware builder resolves
  // the extras from the mint's published meta list (L4), exactly like
  // every other transfer in this file's flows. The destination's
  // holder record was prepared by L4b/H4b bookkeeping.
  {
    const ix = await createTransferCheckedWithTransferHookInstruction(conn, seedAta, mint, houseTokenVault, seedWallet.publicKey, seedRaw, decimals, [], 'confirmed', T22);
    sigs.houseSeedTransfer = await sendTx(new Transaction().add(ix), [seedWallet], 'H4 seed transfer into house token vault');
  }
  // H5: CommitPool — authority rotates to the program's poolauth PDA.
  // Account order is the PROGRAM's (houseswap commit_pool reads
  // [pool, mint, authority]): [housePoolPda(w), mint, launcher(signer)].
  // (Phase C recovery fix: the first build sent [authority, pool, mint],
  // which the program reads as pool=launcher and rejects.)
  {
    const ix = new TransactionInstruction({ programId: HOUSE_SWAP_PROGRAM_ID, data: Buffer.from([4]),
      keys: [K(housePoolPda, false, true), K(mint, false, false), K(launcher.publicKey, true, false)] });
    sigs.houseCommit = await sendTx(new Transaction().add(ix), [launcher], 'H5 houseswap CommitPool');
  }
  // H6: the committed reserve — plain transfer first, then engine
  // tag 17 RecordHouseReserve (authority-signed; in the supported
  // launch shape the config authority is the launcher wallet).
  if (houseF.houseReserveSol > 0) {
    const ixT = SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: houseVaultPda, lamports: Number(houseBlock.reserveLamports) });
    sigs.houseReserve = await sendTx(new Transaction().add(ixT), [launcher], 'H6 house reserve transfer');
    const ixR = new TransactionInstruction({ programId: ENGINE, data: Buffer.from([17]),
      keys: [K(launcher.publicKey, true, false), K(mint, false, false), K(configPda(mint), false, false), K(houseVaultPda, false, true)] });
    sigs.houseReserveRecord = await sendTx(new Transaction().add(ixR), [launcher], 'H6 engine RecordHouseReserve');
  }
  houseRecord = {
    program: HOUSE_SWAP_PROGRAM_ID.toBase58(), pool: housePoolPda.toBase58(),
    tokenVault: houseTokenVault.toBase58(), quoteVault: houseQuoteVault.toBase58(),
    seedWallet: seedWallet.publicKey.toBase58(), seedAta: seedAta.toBase58(),
    seedBuySol: houseF.houseSeedBuySol, seedTokensTarget: houseF.houseSeedTokens,
    seedReceivedRaw: seedRaw.toString(),
    reserveSol: houseF.houseReserveSol, houseVault: houseVaultPda.toBase58(),
    seedExemption: seedAta.toBase58(),
    feeDestTokenAta: feeDestTokenAta.toBase58(),
    l3Exemptions: l3Exemptions.map((x) => x.toBase58()),
  };
  console.log(`house launch steps landed: seed ${seedRaw.toString()} raw in the house token vault; pool committed; reserve ${houseF.houseReserveSol} SOL. Activation is permissionless once the curve reserve reaches ${graduation.houseThresholdSol} SOL and the seed condition holds — launcher/activation-keeper.mjs watches for it.`);
}
let devBuyRecord = null;
if (devBuy) {
  // L8/L8b/L8c prerequisites + L9 dev buy (Feature B). Runs immediately
  // after activation with nothing else intervening — see resolveDevBuy
  // for the exact (non-atomic) guarantee.
  const regPda = PublicKey.findProgramAddressSync([Buffer.from('registration'), launcher.publicKey.toBuffer()], REGISTRY)[0];
  // Engine v3: holder records key by token account — the launcher's
  // record for this mint lives under its ATA.
  const myAta = getAssociatedTokenAddressSync(mint, launcher.publicKey, false, T22);
  const myHolderPda = pdaE([Buffer.from('holder'), mint.toBuffer(), myAta.toBuffer()]);
  if (hasRule(3) || hasRule(17)) {
    const regInfo = await conn.getAccountInfo(regPda);
    if (!regInfo) {
      // kind 1 = Agent (the launcher is an agent wallet; hook.mjs default)
      const ix = new TransactionInstruction({ programId: REGISTRY, data: Buffer.from([0, 1]),
        keys: [K(launcher.publicKey, true, true), K(regPda, false, true), K(SystemProgram.programId, false, false)] });
      sigs.devBuyRegister = await sendTx(new Transaction().add(ix), [launcher], 'L8 register launcher (dev buy prerequisite)');
    }
    const regNow = await conn.getAccountInfo(regPda);
    if (!regNow || regNow.data[43] !== 1) throw new Error('dev buy refused: the launcher wallet\'s registry registration is missing or deactivated — rule 3/17 would veto its buy. Register/reactivate first (node hook.mjs register).');
    if (hasRule(17)) {
      const ecoId = encodeParams(17, rules.find(r => r.id === 17).entry)[0];
      if (regNow.data[44] !== ecoId) throw new Error(`dev buy refused: rule 17 requires ecosystem ${ecoId} but the launcher's registration carries ecosystem ${regNow.data[44]} — attested registration needs the ecosystem attester's co-signature (registry tags 5/6), which the launcher cannot give itself. Get the launcher wallet attested for this ecosystem first, or drop devBuySol.`);
    }
    const holderInfo = await conn.getAccountInfo(myHolderPda);
    if (!(holderInfo && holderInfo.data[1] === 1)) {
      const ix = new TransactionInstruction({ programId: ENGINE, data: Buffer.from([4, 0]),
        keys: [K(launcher.publicKey, true, true), K(mint, false, false), K(configPda(mint), false, false), K(launcher.publicKey, false, false), K(myHolderPda, false, true), K(SystemProgram.programId, false, false), K(regPda, false, false)] });
      sigs.devBuySync = await sendTx(new Transaction().add(ix), [launcher], 'L8b sync launcher registration (dev buy prerequisite)');
    }
  }
  if (hasRule(1)) {
    const ix = new TransactionInstruction({ programId: ENGINE, data: Buffer.from([8]),
      keys: [K(configPda(mint), false, false), K(pricePda(mint), false, true), K(pool, false, false)] });
    sigs.devBuyCrank = await sendTx(new Transaction().add(ix), [launcher], 'L8c crank price feed (dev buy prerequisite)');
  }
  // L9: the buy itself. The ATA is created first so the launcher's
  // position account exists before the buy (under engine v3's AccountKey
  // meta list the generic resolver no longer needs it to exist — the
  // holder PDA derives from the ATA address alone — but the launcher
  // holds through this ATA regardless). No distributor settles are
  // prepended: the Distributor was initialized in this same run, its
  // index is still 0, and a first-touch claim record settles from
  // index 0 — a settle here would account zero (hook.mjs flow logic
  // reaches the same state).
  const tokBeforeInfo = await conn.getAccountInfo(myAta);
  if (!tokBeforeInfo) {
    await sendTx(new Transaction().add(createAssociatedTokenAccountInstruction(launcher.publicKey, myAta, launcher.publicKey, mint, T22)), [launcher], 'L9 create launcher ATA (before dev buy build)');
  }
  const before = tokBeforeInfo ? tokBeforeInfo.data.readBigUInt64LE(64) : 0n;
  const swapTx = await client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: false,
    amountIn: new BN(devBuy.lamports), minimumAmountOut: new BN(0),
    owner: launcher.publicKey, pool, referralTokenAccount: null, payer: launcher.publicKey,
  });
  sigs.devBuy = await sendTx(swapTx, [launcher], `L9 dev buy ${devBuy.sol} SOL`);
  const afterInfo = await conn.getAccountInfo(myAta);
  const after = afterInfo ? afterInfo.data.readBigUInt64LE(64) : 0n;
  const receivedRaw = after - before;
  devBuyRecord = { sol: devBuy.sol, tx: sigs.devBuy, received: (Number(receivedRaw) / 10 ** decimals).toString(), receivedRaw: receivedRaw.toString() };
  console.log(`dev buy landed: ${devBuy.sol} SOL → ${devBuyRecord.received} ${spec.symbol} (first swap after activation, same run — not atomic with activation)`);
}
const record = {
  version: 1, name: spec.name, symbol: spec.symbol, decimals, launchedAt: new Date().toISOString(),
  rpc: rpcUrl, spec,
  programs: { engine: ENGINE.toBase58(), registry: REGISTRY.toBase58(), distributor: DISTRIBUTOR.toBase58(), dbc: DBC_ID.toBase58(), token2022: T22.toBase58() },
  addresses: {
    launcher: launcher.publicKey.toBase58(), authority: authority.toBase58(), feeClaimer: feeClaimer.toBase58(),
    dbcConfig: dbcConfig.publicKey.toBase58(), mint: mint.toBase58(), pool: pool.toBase58(),
    poolAuthority: poolAuthority.toBase58(), baseVault: baseVault.toBase58(), quoteVault: quoteVault.toBase58(),
    engineConfig: configPda(mint).toBase58(), metaList: metaPda(mint).toBase58(),
    priceFeed: hasRule(1) ? pricePda(mint).toBase58() : null, rentVault: rentVaultPda(mint).toBase58(),
    distributor: holderFees ? { state: distState.toBase58(), vault: distVault.toBase58(), callerCutBps: holderFees.callerCutBps, fundingMode: 'auto (DBC mint → 1, routed)', routingTarget: distVault.toBase58() } : null,
  },
  rules: rules.map(r => ({ id: r.id, name: RULE_NAMES[r.id], enabled: r.enabled, params: r.entry })),
  fees: { feeBps: fees.feeBps, feeBpsEnd: fees.feeBpsEnd, destination: fees.destination, feeClaimer: feeClaimer.toBase58(), claimCommand: 'node hook.mjs claim-fees' },
  graduation: { mode: graduation.mode, thresholdSol: graduation.thresholdSol, thresholdLamports: graduation.thresholdLamports != null ? graduation.thresholdLamports.toString() : null,
    ...(isHouse ? { houseThresholdSol: graduation.houseThresholdSol, houseThresholdLamports: graduation.houseThresholdLamports.toString() } : {}) },
  house: houseRecord,
  authorityMode: spec.authorityMode ?? 'locked',
  launchSigner: LAUNCH_SIGNER.toBase58(),
  launchTag: { program: MEMO_PROGRAM_ID.toBase58(), marker: LAUNCH_TAG_MARKER, signer: tagKeypair.publicKey.toBase58(), location: 'L2 transaction, final instruction' },
  metadata: metaReport,
  partnerIdentity: partnerIdentityRecord,
  devBuy: devBuyRecord,
  signatures: sigs,
};
const recordPath = outPath ?? `launch-record-${spec.symbol.toLowerCase()}.json`;
fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
console.log('\nLaunch complete. Record written to', recordPath);
// Recognition plumbing (2026-10-17): the public launches feed
// (https://agentonly.fun/api/launches) regenerates at the end of every
// launch — HookedPad's worker auto-lists within ~10 minutes; ours
// lists at launch completion. The record is first mirrored into
// deploy/ (the feed generator's source of truth) when this run wrote
// it elsewhere. A feed failure never fails a completed launch — it
// warns loudly instead; rerun by hand: node publish-launches-feed.mjs
// --deploy.
try {
  const deployDir = new URL('../deploy/', import.meta.url).pathname;
  const recAbs = path.resolve(recordPath);
  if (path.dirname(recAbs) !== path.resolve(deployDir)) {
    fs.copyFileSync(recAbs, path.join(deployDir, path.basename(recAbs)));
    console.log('launch record mirrored into deploy/ (launches-feed source)');
  }
  execFileSync(process.execPath, [new URL('./publish-launches-feed.mjs', import.meta.url).pathname, '--deploy'], { stdio: 'inherit' });
} catch (e) {
  console.warn(`WARNING: launches-feed regeneration failed (${e.message}) — the launch itself is complete and recorded; rerun: node publish-launches-feed.mjs --deploy`);
}

#!/usr/bin/env node
// tradekit.mjs — AgentOnly Trade Kit library (Phase 2).
//
// A reusable, noncustodial execution layer for ruled tokens launched by
// launch.mjs: quote → eligibility → build (unsigned) → simulate →
// verify. It NEVER loads a keypair and never signs or sends anything:
// library functions take wallet PUBKEYS, `build` returns a base64
// UNSIGNED transaction for the caller's own signer (Path A), and the
// only network writes are read-only RPC calls (account reads, quotes
// computed locally from pool state, simulateTransaction).
//
// Signer paths (binding, per the Phase-1 audit §8):
//   Path A  — the agent's own Solana signer (local keypair file,
//             hardware wallet, or a sandbox keypair per the launch
//             skill's persistence handshake). The only supported path.
//   Path B  — Bankr-custodial wallets: NOT supported. Bankr's
//             documented /wallet/sign covers only personal_sign,
//             eth_signTypedData_v4 and eth_signTransaction (all EVM),
//             and /wallet/submit takes EVM transaction objects — there
//             is no surface that can sign an arbitrary Solana
//             registration instruction or a hook-aware DBC swap.
//             Declaring --wallet-type bankr makes eligibility/build
//             refuse with TK_SIGNER_UNSUPPORTED naming the exact step.
//             Path B′ (a Path-A keypair living in a script sandbox) is
//             declared as --wallet-type sandbox and treated as Path A.
//
// Venue is a parameter, not an afterthought: a token's LIVE engine
// config decides the door (curve vs the activated house pool vs a
// wallet-to-wallet send), and rule shapes differ per door (rule 2
// exists only at the house; rule 8 fails closed at venues).
//
// Deps: @solana/web3.js, @solana/spl-token,
// @meteora-ag/dynamic-bonding-curve-sdk, bn.js (same set as hook.mjs).
import fs from 'fs';
import {
  ComputeBudgetProgram, Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, createTransferCheckedWithTransferHookInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { parseHouseSlot, resolveVenue, buildHouseSwapIx, housePoolPda, recordHasRule2 } from './doors.mjs';
import BN from 'bn.js';
import { DynamicBondingCurveClient, SwapMode, getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk';

export const T22 = TOKEN_2022_PROGRAM_ID;
export const LEGACY = TOKEN_PROGRAM_ID;
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const IX_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
export const PRICE_SCALE = 10n ** 12n;
// Rent for one lazily created Holder PDA (audit §4: ~0.001837 SOL).
export const HOLDER_PDA_RENT = 1_837_000n;
export const REGISTRATION_RENT = 1_230_000n;
export const ATA_RENT = 2_040_000n;
export const TX_FEE_BUFFER = 100_000n;

export const RULE_NAMES = {
  1: 'Basis Latch', 2: 'Escrow Split', 3: 'Agent-Only', 4: 'App-Gated', 5: 'Crown Beneficiary',
  6: 'Tithe Seat', 7: 'P2P Toggle', 8: 'Holder-Gated', 9: 'Max Wallet', 10: 'Allow/Blocklist',
  11: 'The Grudge', 12: 'Trading Hours', 13: 'Vesting Clock', 14: 'Decay Tax',
  15: 'King of the Pool', 16: 'Buyback & Burn', 17: 'Ecosystem Gate',
};
export const ECOSYSTEM_NAMES = { 1: 'Muse', 2: 'FOMO', 3: 'Claude', 4: 'Grok' };

// Engine custom errors (engine/src/lib.rs EngineError, 1..34 verbatim;
// 35 is rule 18's reserved CooldownActive — specced, not deployed).
export const ENGINE_ERRORS = {
  1: ['NotRegistered', 'the receiving wallet has no active registry mirror for this token. Fix: register, then sync (the Trade Kit bundles both).'],
  2: ['MaxWalletExceeded', 'this receive would put the destination over the token\'s max-wallet cap.'],
  3: ['BadCaller', 'the hook rejected the call context (not a genuine Token-2022 transfer / allowlisted venue swap).'],
  4: ['BadConfig', 'the token\'s engine config is missing or corrupt.'],
  5: ['ConfigLocked', 'this token\'s config is Locked; nobody can change its rules.'],
  6: ['BadAuthority', 'the signer is not this config\'s authority.'],
  7: ['UnknownRule', 'the config references a rule this engine build cannot enforce.'],
  8: ['UnsupportedMode', 'HolderVote config writes need the vote program (not in this build).'],
  9: ['HolderMissing', 'required holder state is absent and could not be created here.'],
  10: ['BadState', 'a state account is foreign-owned or corrupt.'],
  11: ['MathOverflow', 'on-chain math overflow (report this).'],
  12: ['InvalidMode', 'authority_mode byte out of range.'],
  13: ['RentVaultUnderfunded', 'the token\'s rent vault cannot pay for a new Holder PDA. The launcher must top it up before new wallets can receive.'],
  14: ['AlreadyInit', 'this state was already initialized.'],
  15: ['Locked', 'rule 1 (Basis Latch): price is at/above the sender\'s entry basis and no dip below basis has latched them yet. Wait for a dip, then any sell works forever (LATCH mode).'],
  16: ['StalePrice', 'the price feed is stale; rule-1 exits fail closed. Anyone may crank it — the Trade Kit bundles the DBC crank (engine tag 8) ahead of rule-1 trades.'],
  17: ['BasisMissing', 'the sender has no basis record (their tokens did not arrive through a basis-recording buy).'],
  18: ['PriceFeedBad', 'the price feed is uninitialized or its pinned vaults/pool are wrong.'],
  19: ['NotGateHolder', 'the destination does not hold enough of the gate token (rule 8).'],
  20: ['VenueTransferForbidden', 'rule 7 is P2P-only: venue transfers are vetoed.'],
  21: ['P2PTransferForbidden', 'rule 7 is No-P2P: wallet-to-wallet transfers are vetoed; trade on the venue.'],
  22: ['BadRegistration', 'the registration account presented to sync is invalid (wrong PDA/owner/tag). Fail-closed by design.'],
  23: ['BadGateAccount', 'the account presented to the gate sync is not the owner\'s canonical gate ATA.'],
  24: ['WrongEcosystem', 'the destination is registered, but not attested for the ecosystem this token requires (rule 17).'],
  25: ['PartialLocked', 'the sender\'s graduated-latch earned cap does not cover this sell yet (rule 1 GRADUATED).'],
  26: ['MissingExtra', 'the transfer did not carry an extra account this token\'s rules require — usually a stale meta list after a config update (operator repair: engine RefreshExtraAccountMetas, tag 9).'],
  27: ['GrudgeMarked', 'rule 11 (The Grudge): the wallet is marked — buy-banned, or buying over the marked cap.'],
  28: ['OutsideTradingHours', 'rule 12: the transfer is outside the token\'s configured trading window.'],
  29: ['VestingLocked', 'rule 13 (Vesting Clock): the outbound amount exceeds the unlocked fraction.'],
  30: ['NotAllowlisted', 'rule 10: the destination holds no active allowlist entry.'],
  31: ['Blocklisted', 'rule 10: the destination owner is on the sealed blocklist.'],
  32: ['AppNotAllowed', 'rule 4 (App-Gated): a venue receive arrived through a program that is not in the rule\'s app list.'],
  33: ['HouseNotReady', 'house graduation/seed/reserve condition unmet.'],
  34: ['HouseNotCommitted', 'no house slot, wrong house program, or pool not committed.'],
  35: ['CooldownActive', 'RESERVED for rule 18 (Buy Cooldown) — not in the deployed engine; you cannot meet it today.'],
};
export const DIST_ERRORS = {
  8: ['Insolvent (distributor)', 'defensive; should be unreachable, report it.'],
  9: ['MathOverflow (distributor)', ''],
  10: ['FundModeMismatch', 'fee-source accounts were passed to a routed-mode (mode 1) distributor; mode 1 takes none.'],
};
export const REGISTRY_ERRORS = {
  1: ['AlreadyRegistered', 'this wallet already has a registration.'],
  2: ['NotRegistered (registry)', 'no registration exists for this wallet.'],
  4: ['BadKind', 'kind must be 0 (human) or 1 (agent).'],
  5: ['BadEcosystem', 'ecosystem byte outside 1..=MAX_ECOSYSTEM.'],
  6: ['NotAttester', 'signer is not the ecosystem\'s configured attester.'],
};

// Trade Kit reason codes (Layer 2.5 — precheck/simulate classification).
// engineCode maps to the EngineError the same condition would produce
// on-chain where one exists; null = kit-only condition.
export const TK_REASONS = {
  TK_NOT_REGISTERED: { engineCode: 1, text: 'wallet has no active Registry registration (required by this token before receiving)' },
  TK_MIRROR_UNSYNCED: { engineCode: 1, text: 'wallet is registered globally but its per-token holder mirror is not synced for this token account' },
  TK_MAX_WALLET: { engineCode: 2, text: 'receive would exceed the token\'s max-wallet cap' },
  TK_BAD_CALLER_PATH: { engineCode: 3, text: 'this execution path is not an allowlisted caller for this token (rule 4)' },
  TK_APP_NOT_ALLOWED: { engineCode: 32, text: 'the venue program driving this trade is not in the token\'s rule-4 app list' },
  TK_LOCKED: { engineCode: 15, text: 'rule 1: current price is at/above the sender\'s basis and the position is not latched' },
  TK_STALE_FEED: { engineCode: 16, text: 'rule 1: price feed is stale and no fresh price can be computed for the precheck' },
  TK_BASIS_MISSING: { engineCode: 17, text: 'rule 1: sender holds tokens but has no basis record' },
  TK_GATE_HOLDER: { engineCode: 19, text: 'rule 8: destination gate-token balance is below the required threshold' },
  TK_VENUE_FORBIDDEN: { engineCode: 20, text: 'rule 7 forbids this venue class for this token' },
  TK_WRONG_ECOSYSTEM: { engineCode: 24, text: 'rule 17: wallet\'s ecosystem stamp does not match the ecosystem this token requires' },
  TK_NO_LIVE_ATTESTER: { engineCode: null, text: 'rule 17: the required ecosystem has no live attester today (only Muse, id 1, attests) — no unstamped wallet can become eligible' },
  TK_PARTIAL_LOCKED: { engineCode: 25, text: 'rule 1 GRADUATED: sell exceeds the earned cap measurable pre-trade (an execution-time crank may raise the cap; simulation decides)' },
  TK_OUTSIDE_HOURS: { engineCode: 28, text: 'rule 12: outside the token\'s configured trading window' },
  TK_VESTING_LOCKED: { engineCode: 29, text: 'rule 13: outbound amount exceeds the unlocked fraction' },
  TK_RENT_VAULT_UNDERFUNDED: { engineCode: 13, text: 'the token\'s rent vault cannot pay for a new Holder PDA — an operator repair, not a wallet failure' },
  TK_GATE_VENUE_CLOSED: { engineCode: null, text: 'rule 8 fails closed at venue swaps by construction (no gate sync can sit adjacent inside a venue swap); the send path is the working route' },
  TK_HOOK_INACTIVE: { engineCode: null, text: 'the curve completed: the hook is revoked and the token trades hook-free on DAMM v2 (a venue this kit does not build for)' },
  TK_UNVERIFIED_RULE: { engineCode: null, text: 'this rule\'s precheck semantics are not verified against a live config instance; the kit refuses to guess — simulation of the built transaction is the arbiter' },
  TK_SIGNER_UNSUPPORTED: { engineCode: null, text: 'the declared wallet type cannot sign arbitrary Solana transactions (see signer check evidence)' },
  TK_VENUE_UNAVAILABLE: { engineCode: null, text: 'the requested venue is not available for this token in its current state' },
  TK_INSUFFICIENT_FUNDS: { engineCode: null, text: 'wallet balance cannot cover the amount plus bundled prerequisite rents/fees' },
  TK_INSUFFICIENT_BALANCE: { engineCode: null, text: 'wallet token balance is below the requested sell/send amount' },
  TK_GRADUATED: { engineCode: null, text: 'informational: graduation state changes this trade\'s rule surface' },
};

const K = (pubkey, w, s) => ({ pubkey, isSigner: !!s, isWritable: !!w });
export const u128 = (buf, off) => buf.readBigUInt64LE(off) + (buf.readBigUInt64LE(off + 8) << 64n);
const i64 = (buf, off) => buf.readBigInt64LE(off);

// ---------- record / context (mirrors hook.mjs ctx()) ----------
export function loadRecord(recordPath) {
  if (!fs.existsSync(recordPath)) throw new Error(`no launch record at ${recordPath} — pass --record <path> (launch.mjs writes one per launch)`);
  return JSON.parse(fs.readFileSync(recordPath, 'utf8'));
}
export function makeCtx(rec) {
  const P = (s) => new PublicKey(s);
  const programs = {
    engine: P(rec.programs.engine), registry: P(rec.programs.registry),
    distributor: P(rec.programs.distributor), dbc: P(rec.programs.dbc),
    house: rec.house?.program ? P(rec.house.program) : null,
  };
  const mint = P(rec.addresses.mint);
  const pdaE = (seeds) => PublicKey.findProgramAddressSync(seeds, programs.engine)[0];
  return {
    rec, programs, mint, decimals: rec.decimals ?? 6,
    pool: P(rec.addresses.pool), poolAuthority: P(rec.addresses.poolAuthority),
    baseVault: P(rec.addresses.baseVault), quoteVault: P(rec.addresses.quoteVault),
    dbcConfig: P(rec.addresses.dbcConfig),
    configPda: pdaE([Buffer.from('config'), mint.toBuffer()]),
    pricePda: pdaE([Buffer.from('price'), mint.toBuffer()]),
    metaPda: pdaE([Buffer.from('extra-account-metas'), mint.toBuffer()]),
    rentVaultPda: pdaE([Buffer.from('rentvault'), mint.toBuffer()]),
    holderPda: (owner) => pdaE([Buffer.from('holder'), mint.toBuffer(), owner.toBuffer()]),
    holderPdaV3: (acct) => pdaE([Buffer.from('holder'), mint.toBuffer(), acct.toBuffer()]),
    distState: rec.addresses.distributor ? P(rec.addresses.distributor.state) : null,
    distVault: rec.addresses.distributor ? P(rec.addresses.distributor.vault) : null,
    claimPda: (holder) => PublicKey.findProgramAddressSync([Buffer.from('claim'), mint.toBuffer(), holder.toBuffer()], programs.distributor)[0],
    regPda: (wallet) => PublicKey.findProgramAddressSync([Buffer.from('registration'), wallet.toBuffer()], programs.registry)[0],
    ata: (owner) => getAssociatedTokenAddressSync(mint, owner, true, T22),
    rules: rec.rules ?? [],
  };
}
export const hasRule = (c, id) => c.rules.some(r => r.id === id && r.enabled !== false);

// ---------- meta list decode (diagnostic resolver support) ----------
// Entry layout (35 bytes): [0] disc (0 = address, 1 = seeded),
// [1..33] seed config / address, [33] is_signer, [34] is_writable.
// NOTE: an earlier proof script (proof-buyability.mjs) mislabels byte
// o+33 as writable — o+33 is is_signer, o+34 is is_writable (audit §2 S7).
export function decodeMetaList(raw) {
  const count = raw.readUInt32LE(12), entries = [];
  for (let i = 0; i < count; i++) {
    const o = 16 + i * 35, disc = raw[o], cfg = raw.subarray(o + 1, o + 33);
    const isSigner = raw[o + 33] !== 0, isWritable = raw[o + 34] !== 0;
    if (disc === 0) { entries.push({ i, kind: 'address', address: new PublicKey(cfg.subarray(0, 32)), isSigner, isWritable }); continue; }
    if (disc !== 1) { entries.push({ i, kind: 'unknown', disc, isSigner, isWritable }); continue; }
    const seeds = [];
    let j = 0;
    while (j < 32 && cfg[j] !== 0) {
      const d = cfg[j];
      if (d === 1) { const len = cfg[j + 1]; seeds.push({ type: 'literal', bytes: Buffer.from(cfg.subarray(j + 2, j + 2 + len)) }); j += 2 + len; }
      else if (d === 2) { seeds.push({ type: 'instruction-data', index: cfg[j + 1], offset: cfg[j + 2] }); j += 3; }
      else if (d === 3) { seeds.push({ type: 'account-key', index: cfg[j + 1] }); j += 2; }
      else if (d === 4) { seeds.push({ type: 'account-data', index: cfg[j + 1], offset: cfg[j + 2], length: cfg[j + 3] }); j += 4; }
      else { seeds.push({ type: 'unknown-seed', disc: d }); break; }
    }
    entries.push({ i, kind: 'seeded', seeds, isSigner, isWritable });
  }
  return { size: raw.length, count, entries };
}
// The holder-record generation a token's meta list declares: an entry
// whose first seed is the literal "holder" and whose second seed is
// AccountData (disc 4) → v2 (owner-keyed); AccountKey (disc 3) → v3
// (token-account-keyed). Same read hook.mjs holderMode() performs.
export function holderGeneration(raw) {
  if (!raw) return 'v2';
  const { entries } = decodeMetaList(raw);
  for (const e of entries) {
    if (e.kind !== 'seeded' || !e.seeds.length) continue;
    const first = e.seeds[0];
    if (first.type === 'literal' && first.bytes.toString() === 'holder') {
      const second = e.seeds[1];
      if (second?.type === 'account-data') return 'v2';
      if (second?.type === 'account-key') return 'v3';
    }
  }
  return 'v2';
}
/**
 * Resolve a mint's hook extras from its RAW meta-list bytes — the
 * from-list-bytes resolver (audit S7), kept as a diagnostic/fallback.
 * `accounts` is the transfer instruction's own key list in order
 * ([source, mint, dest, authority] for TransferChecked); AccountKey
 * seeds index into it. Throws a named error on seed types a byte-level
 * resolver cannot honor offline (instruction-data / account-data —
 * the latter is the retired v2 pattern; no live list uses either).
 * Returns the full tail: [...extras, hookProgram, metaListPda].
 */
export function resolveExtrasFromList(raw, { mint, accounts, engineProgram, metaListPda }) {
  const { entries } = decodeMetaList(raw);
  const keys = [];
  for (const e of entries) {
    if (e.kind === 'address') { keys.push(K(e.address, e.isWritable, e.isSigner)); continue; }
    if (e.kind !== 'seeded') throw new Error(`TK_RESOLVER_UNKNOWN_ENTRY: meta entry ${e.i} has disc ${e.disc}`);
    const seedBufs = [];
    for (const s of e.seeds) {
      if (s.type === 'literal') seedBufs.push(s.bytes);
      else if (s.type === 'account-key') {
        const acct = accounts[s.index];
        if (!acct) throw new Error(`TK_RESOLVER_BAD_KEY_INDEX: meta entry ${e.i} references instruction account ${s.index}, only ${accounts.length} given`);
        seedBufs.push(acct.toBuffer());
      } else {
        throw new Error(`TK_RESOLVER_UNSUPPORTED_SEED: meta entry ${e.i} uses a ${s.type} seed — a byte-level resolver cannot honor it (this is the retired v2 pattern; use spl-token's resolver with live account data)`);
      }
    }
    keys.push(K(PublicKey.findProgramAddressSync(seedBufs, engineProgram)[0], e.isWritable, e.isSigner));
  }
  keys.push(K(engineProgram), K(metaListPda));
  return keys;
}

// ---------- account parsers (pure) ----------
export function parseConfig(data) {
  if (!data) return null;
  const d = Buffer.from(data);
  const ruleCount = d[3];
  const rules = [];
  for (let i = 0; i < ruleCount; i++) {
    const o = 462 + i * 68;
    rules.push({ id: d.readUInt16LE(o), enabled: d[o + 2] === 1, params: d.subarray(o + 4, o + 68) });
  }
  const keyAt = (o) => new PublicKey(d.subarray(o, o + 32)).toBase58();
  const venues = [];
  for (let i = 0; i < Math.min(d[76] ?? 0, 4); i++) venues.push(keyAt(77 + i * 32));
  const exemptions = [];
  for (let i = 0; i < Math.min(d[205] ?? 0, 8); i++) exemptions.push(keyAt(206 + i * 32));
  return { authorityMode: d[2], ruleCount, rules, houseSlot: parseHouseSlot(d), venues, exemptions, length: d.length };
}
export const ruleOf = (cfg, id) => cfg?.rules.find(r => r.id === id && r.enabled) ?? null;

export function parseRegistry(data) {
  if (!data) return { exists: false };
  const d = Buffer.from(data);
  return {
    exists: true, kind: d[33], // 0 human, 1 agent
    verifiedVia: d[34], registeredAt: Number(i64(d, 35)),
    active: d[43] === 1, ecosystem: d[44] ?? 0,
  };
}
export function parseHolder(data) {
  if (!data) return { exists: false };
  const d = Buffer.from(data);
  const out = {
    exists: true, length: d.length,
    registered: d[1] === 1, ecosystem: d[2] ?? 0,
    basisNum: u128(d, 6), basisDen: u128(d, 22),
    latched: d[38] === 1,
    lastBuyTs: Number(i64(d, 39)), lastSellTs: Number(i64(d, 47)),
  };
  out.basisScaled = out.basisDen > 0n && out.basisNum > 0n ? out.basisNum / out.basisDen : null; // PRICE_SCALE fixed point
  if (d.length >= 192) {
    out.gradPeak = d.readBigUInt64LE(136); out.gradSold = d.readBigUInt64LE(144);
    out.gradCap = d.readBigUInt64LE(152); out.gradAnchor = Number(i64(d, 160));
    out.gradMinPrice = u128(d, 168);
  }
  if (d.length >= 224) out.vestAnchor = Number(i64(d, 192));
  // rule 11 (v4 scratch in the custom region): mark-until i64, window bag u64, offenses
  if (d.length >= 136) {
    out.grudgeMarkUntil = Number(i64(d, 119)); out.grudgeWindowBag = d.readBigUInt64LE(127);
    out.grudgeOffenses = d[135];
    out.dumpWindowStart = Number(i64(d, 55)); out.dumpSoldInWindow = d.readBigUInt64LE(63);
  }
  return out;
}
export function parseFeed(data) {
  if (!data) return { exists: false };
  const d = Buffer.from(data);
  return {
    exists: true, pinnedPool: new PublicKey(d.subarray(33, 65)),
    ema: u128(d, 97), lastCrankTs: Number(i64(d, 113)), crankCount: d.readBigUInt64LE(121),
  };
}
// GRADUATED earned fraction, replicated term-for-term from the engine
// (grad_frac_bps): max(base, time, dip) bps, 10_000 once latched.
export function gradFracBps(holder, basisScaled, now, params) {
  if (holder.latched) return 10000n;
  const base = BigInt(params.readUInt16LE(19));
  let vesting = params.readBigUInt64LE(21); if (vesting === 0n) vesting = 432000n;
  let dipMult = BigInt(params.readUInt16LE(29)); if (dipMult === 0n) dipMult = 20000n;
  const anchor = BigInt(holder.gradAnchor ?? 0);
  const elapsed = anchor === 0n ? 0n : BigInt(Math.max(0, now - Number(anchor)));
  let timeFrac = elapsed * 10000n / vesting; if (timeFrac > 10000n) timeFrac = 10000n;
  const minPrice = holder.gradMinPrice ?? 0n;
  let dipFrac = 0n;
  if (minPrice > 0n && basisScaled && basisScaled > 0n && minPrice < basisScaled) {
    dipFrac = (basisScaled - minPrice) * 10000n / basisScaled * dipMult / 10000n;
    if (dipFrac > 10000n) dipFrac = 10000n;
  }
  return [base, timeFrac, dipFrac].reduce((a, b) => (b > a ? b : a));
}
// The engine's EMA fold (ema_fold + ema_params): what a crank bundled
// into this transaction would write, given the current feed and spot.
// halfLife 0 → full take of spot; maxCrankBps 0 → 10_000 (±100% clamp).
export function postCrankEma(feed, spotScaled, params, now) {
  if (!feed.exists || feed.lastCrankTs === 0 || feed.ema === 0n) return spotScaled;
  const halfLife = params ? params.readBigUInt64LE(8) : 0n;
  let maxBps = params ? BigInt(params.readUInt16LE(16)) : 10000n;
  if (maxBps === 0n) maxBps = 10000n;
  const ema = feed.ema;
  const elapsed = BigInt(Math.max(1, now - feed.lastCrankTs));
  const fracBps = halfLife === 0n ? 10000n : (elapsed * 10000n / halfLife > 10000n ? 10000n : elapsed * 10000n / halfLife);
  let cand = ema + (spotScaled - ema) * fracBps / 10000n;
  const maxMove = ema * maxBps / 10000n;
  if (cand > ema + maxMove) cand = ema + maxMove;
  else if (cand + maxMove < ema) cand = ema - maxMove;
  return cand > 0n ? cand : 0n;
}
// DBC spot from sqrt_price, decomposed exactly as the engine's
// dbc_spot: (sqrt^2 / 2^128) * PRICE_SCALE * 10^(tokenDec - quoteDec).
// (Direct BigInt here; the engine's piecewise form differs by < 4
// scaled units — 1 unit = 1e-12 SOL — noted in eligibility evidence.)
export function spotScaledFromSqrt(sqrtPriceBn, tokenDec, quoteDec = 9) {
  const s = BigInt(sqrtPriceBn.toString());
  const num = s * s * PRICE_SCALE;
  const shift = BigInt(tokenDec - quoteDec);
  const scaled = shift >= 0n ? num * (10n ** shift) : num / (10n ** (-shift));
  return scaled / (2n ** 128n);
}

// ---------- the kit ----------
export class TradeKit {
  constructor(rpcUrl = process.env.HOOK_RPC || 'https://api.mainnet-beta.solana.com') {
    this.rpcUrl = rpcUrl;
    this.conn = new Connection(rpcUrl, 'confirmed');
    this.stats = { rpcCalls: 0, byMethod: {} };
    this._dbc = null;
    this._sdkCache = new Map(); // mint -> { pool, config }
  }
  async rpc(method, params) {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        this.stats.rpcCalls++; this.stats.byMethod[method] = (this.stats.byMethod[method] ?? 0) + 1;
        const r = await fetch(this.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json();
        if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error));
        return j.result;
      } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 1200 * (attempt + 1))); }
    }
    throw lastErr;
  }
  get dbc() { if (!this._dbc) this._dbc = new DynamicBondingCurveClient(this.conn, 'confirmed'); return this._dbc; }
  // Batched account read: one getMultipleAccounts for the whole set.
  async batchRead(pubkeys) {
    if (!pubkeys.length) return [];
    const res = await this.rpc('getMultipleAccounts', [pubkeys.map(p => p.toBase58()), { encoding: 'base64', commitment: 'confirmed' }]);
    return res.value.map(v => v ? { lamports: v.lamports, owner: new PublicKey(v.owner), data: Buffer.from(v.data[0], 'base64') } : null);
  }
  async sdkPoolConfig(c) {
    const key = c.mint.toBase58();
    if (!this._sdkCache.has(key)) {
      const [pool, config] = await Promise.all([this.dbc.state.getPool(c.pool), this.dbc.state.getPoolConfig(c.dbcConfig)]);
      if (!pool || !config) throw new Error('DBC pool/config not found for ' + key);
      this._sdkCache.set(key, { pool, config });
    }
    return this._sdkCache.get(key);
  }

  // ---- snapshot: every account the precheck needs, ~2 batched calls ----
  async snapshot(c, wallet, destWallet = wallet) {
    const myAta = c.ata(wallet), destAta = c.ata(destWallet);
    const first = [c.configPda, c.metaPda, c.regPda(wallet), c.regPda(destWallet), myAta, destAta, c.mint, c.pricePda, c.pool, c.rentVaultPda, wallet];
    if (c.distState) first.push(c.distState);
    const v1 = await this.batchRead(first);
    const [cfgInfo, metaInfo, regInfo, destRegInfo, ataInfo, destAtaInfo, mintInfo, feedInfo, poolInfo, rentInfo, walletInfo] = v1;
    const distInfo = c.distState ? v1[11] : null;
    if (!cfgInfo) throw new Error('engine config PDA not found for this mint — wrong record or unlaunched token');
    const cfg = parseConfig(cfgInfo.data);
    const generation = holderGeneration(metaInfo?.data ?? null);
    const holderKeyMine = generation === 'v3' ? c.holderPdaV3(myAta) : c.holderPda(wallet);
    const holderKeyDest = generation === 'v3' ? c.holderPdaV3(destAta) : c.holderPda(destWallet);
    const second = [holderKeyMine, holderKeyDest];
    const gateRule = ruleOf(cfg, 8);
    let gate = null;
    if (gateRule) {
      const gateMint = new PublicKey(gateRule.params.subarray(0, 32));
      const gateProgInfo = await this.batchRead([gateMint]);
      const gateProg = gateProgInfo[0]?.owner ?? T22;
      gate = { mint: gateMint, threshold: gateRule.params.readBigUInt64LE(32), destAta: getAssociatedTokenAddressSync(gateMint, destWallet, true, gateProg) };
      second.push(gate.destAta);
    }
    const slot = cfg.houseSlot;
    let house = null;
    if (slot) {
      const poolPda = housePoolPda(slot.program, c.mint);
      house = {
        slot, poolPda,
        tokenVault: getAssociatedTokenAddressSync(c.mint, poolPda, true, T22),
        quoteVault: getAssociatedTokenAddressSync(NATIVE_MINT, poolPda, true, LEGACY),
        myQuoteAta: getAssociatedTokenAddressSync(NATIVE_MINT, wallet, false, LEGACY),
      };
      second.push(house.tokenVault, house.quoteVault, house.myQuoteAta);
    }
    const v2 = await this.batchRead(second);
    const [holderInfo, destHolderInfo] = v2;
    let gi = 2;
    if (gate) { gate.balance = v2[gi]?.data ? v2[gi].data.readBigUInt64LE(64) : 0n; gi++; }
    if (house) {
      house.tokenReserve = v2[gi]?.data ? v2[gi].data.readBigUInt64LE(64) : 0n;
      house.quoteReserve = v2[gi + 1]?.data ? v2[gi + 1].data.readBigUInt64LE(64) : 0n;
      house.myQuoteAtaExists = !!v2[gi + 2];
    }
    const supply = mintInfo ? mintInfo.data.readBigUInt64LE(36) : 0n;
    return {
      at: new Date().toISOString(), slot: null,
      cfg, cfgRaw: cfgInfo.data, generation,
      registry: parseRegistry(regInfo?.data ?? null),
      destRegistry: parseRegistry(destRegInfo?.data ?? null),
      holder: parseHolder(holderInfo?.data ?? null), holderKey: holderKeyMine,
      destHolder: parseHolder(destHolderInfo?.data ?? null), destHolderKey: holderKeyDest,
      feed: parseFeed(feedInfo?.data ?? null),
      myBalance: ataInfo ? ataInfo.data.readBigUInt64LE(64) : 0n, myAtaExists: !!ataInfo,
      destBalance: destAtaInfo ? destAtaInfo.data.readBigUInt64LE(64) : 0n, destAtaExists: !!destAtaInfo,
      supply, decimals: c.decimals,
      poolQuoteReserve: poolInfo && poolInfo.data.length >= 248 ? poolInfo.data.readBigUInt64LE(240) : null,
      poolData: poolInfo?.data ?? null,
      rentVaultLamports: rentInfo ? BigInt(rentInfo.lamports) : 0n,
      walletLamports: walletInfo ? BigInt(walletInfo.lamports) : 0n,
      distMode: distInfo ? distInfo.data[140] : null,
      gate, house,
      venueInfo: resolveVenue(c.rec, cfgInfo.data, poolInfo?.data ?? null),
    };
  }

  // ---- instruction builders (mirror hook.mjs byte-for-byte) ----
  registerIx(c, wallet, kind = 1) {
    return new TransactionInstruction({
      programId: c.programs.registry, data: Buffer.from([0, kind]),
      keys: [K(wallet, true, true), K(c.regPda(wallet), true), K(SystemProgram.programId)],
    });
  }
  syncIx(c, wallet, holderKey) {
    return new TransactionInstruction({
      programId: c.programs.engine, data: Buffer.from([4, 0]),
      keys: [K(wallet, true, true), K(c.mint), K(c.configPda), K(wallet), K(holderKey, true), K(SystemProgram.programId), K(c.regPda(wallet))],
    });
  }
  syncGateIx(c, payer, gateAcct, destAta, holderKey) {
    return new TransactionInstruction({
      programId: c.programs.engine, data: Buffer.from([7]),
      keys: [K(payer, true, true), K(c.mint), K(c.configPda), K(payer), K(holderKey, true), K(SystemProgram.programId), K(gateAcct), K(destAta), K(IX_SYSVAR)],
    });
  }
  crankDbcIx(c) { // engine tag 8 — prices DBC curves from pool state
    return new TransactionInstruction({
      programId: c.programs.engine, data: Buffer.from([8]),
      keys: [K(c.configPda), K(c.pricePda, true), K(c.pool)],
    });
  }
  crankCpIx(c) { // engine tag 5 — constant-product vault crank (hook.mjs crank-price)
    return new TransactionInstruction({
      programId: c.programs.engine, data: Buffer.from([5]),
      keys: [K(c.configPda), K(c.pricePda, true), K(c.baseVault), K(c.quoteVault)],
    });
  }
  async hookExtras(c, source, dest, authority, amount) {
    const ix = await createTransferCheckedWithTransferHookInstruction(this.conn, source, c.mint, dest, authority, amount, c.decimals, [], 'confirmed', T22);
    return ix.keys.slice(4).map(k => K(k.pubkey, k.isWritable, false));
  }
  async tokenAcctRaw(acct) {
    const [info] = await this.batchRead([acct]);
    return info ? info.data.readBigUInt64LE(64) : 0n;
  }
  async settleIx(c, payer, holder, holderAta) {
    return new TransactionInstruction({
      programId: c.programs.distributor, data: Buffer.from([3]),
      keys: [K(payer, true, true), K(holder), K(holderAta, true), K(c.mint), K(c.distState, true), K(c.distVault, true), K(c.claimPda(holder), true), K(T22), K(SystemProgram.programId),
        ...(await this.hookExtras(c, c.distVault, holderAta, c.distState, await this.tokenAcctRaw(holderAta)))],
    });
  }
  // Settles for both sides, as hook.mjs does — with one principled
  // refinement: a side whose entitlement is provably zero (no token
  // balance AND no claim record) is skipped, because its settle is an
  // accounting no-op and its claim-PDA creation would be the only
  // effect. (The audit's S1/S2/S4 simulations all passed settle-free;
  // hook.mjs's unconditional form remains proven for existing holders.)
  async settlesFor(c, payer, counterparty, snap) {
    if (!c.distState) return { ixs: [], bundled: [] };
    const out = [];
    const mine = snap ?? await this.snapshot(c, payer);
    const myClaim = await this.batchRead([c.claimPda(payer)]);
    if (mine.myBalance > 0n || myClaim[0]) out.push(await this.settleIx(c, payer, payer, c.ata(payer)));
    const cpAta = counterparty.equals(c.poolAuthority) ? c.baseVault : (snap?.house && counterparty.equals(snap.house.poolPda)) ? snap.house.tokenVault : c.ata(counterparty);
    const cpBal = await this.tokenAcctRaw(cpAta);
    const cpClaim = await this.batchRead([c.claimPda(counterparty)]);
    if (cpBal > 0n || cpClaim[0]) out.push(await this.settleIx(c, payer, counterparty, cpAta));
    return { ixs: out, bundled: out.length ? ['distributor-settle'] : [] };
  }

  // ---- spot (scaled, PRICE_SCALE) from the live pool state ----
  async spotScaled(c) {
    const { pool } = await this.sdkPoolConfig(c);
    return spotScaledFromSqrt(pool.poolState.sqrtPrice, c.decimals, 9);
  }
  async spotFloat(c) {
    const { pool } = await this.sdkPoolConfig(c);
    return Number(getPriceFromSqrtPrice(pool.poolState.sqrtPrice, c.decimals, 9));
  }

  // ---- quote ----
  // side buy: amountRaw = quote lamports in. sell/send: base raw in.
  async quote(c, { side, amountRaw, venue = 'curve', snap = null, slippageBps = 100 }) {
    amountRaw = BigInt(amountRaw);
    if (venue === 'auto') {
      snap = snap ?? await this.snapshot(c, PublicKey.default);
      venue = side === 'send' ? 'p2p' : snap.venueInfo.venue;
    }
    if (venue === 'p2p' || side === 'send') {
      return { venue: 'p2p', side: 'send', amountIn: amountRaw.toString(), amountOut: amountRaw.toString(), minimumAmountOut: amountRaw.toString(), fees: { total: '0' }, modeled: false, note: 'wallet-to-wallet transfer is 1:1; hook rules still apply (see eligibility)' };
    }
    if (venue === 'house') {
      const s = snap ?? await this.snapshot(c, PublicKey.default);
      if (!s.house) throw new Error('TK_VENUE_UNAVAILABLE: this token has no house slot');
      const split = ruleOf(s.cfg, 2) ? BigInt(ruleOf(s.cfg, 2).params.readUInt16LE(0)) : 0n;
      const tRes = s.house.tokenReserve, qRes = s.house.quoteReserve;
      let grossOut, amountOut, escrowed = 0n, tradedIn = amountRaw;
      if (side === 'buy') {
        if (split > 0n) { escrowed = amountRaw * split / 10000n; tradedIn = amountRaw - escrowed; }
        grossOut = qRes + tradedIn > 0n ? tRes * tradedIn / (qRes + tradedIn) : 0n;
        amountOut = grossOut;
      } else {
        grossOut = tRes + amountRaw > 0n ? qRes * amountRaw / (tRes + amountRaw) : 0n;
        if (split > 0n) { escrowed = grossOut * split / 10000n; amountOut = grossOut - escrowed; } else amountOut = grossOut;
      }
      const minOut = amountOut * BigInt(10000 - slippageBps) / 10000n;
      return {
        venue: 'house', side, amountIn: amountRaw.toString(), amountOut: amountOut.toString(), grossAmountOut: grossOut.toString(),
        minimumAmountOut: minOut.toString(), escrowedQuote: escrowed.toString(), tradedIn: tradedIn.toString(),
        fees: { total: '0', note: 'house swap fee is venue-internal; quote is gross of any venue fee' },
        priceImpactBps: null, modeled: true,
        model: 'constant-product over live house vault balances' + (split > 0n ? `; rule-2 escrow split ${split} bps applied` : ''),
        reserves: { tokenRaw: tRes.toString(), quoteLamports: qRes.toString() },
      };
    }
    // curve (DBC), SDK local quote from fetched pool state
    const { pool, config } = await this.sdkPoolConfig(c);
    const slot = await this.rpc('getSlot', [{ commitment: 'confirmed' }]);
    const isTs = Number(config.activationType) === 1;
    const currentPoint = new BN(isTs ? Math.floor(Date.now() / 1000) : slot);
    const q = this.dbc.pool.swapQuote2({
      virtualPool: pool, config, swapBaseForQuote: side === 'sell',
      hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint,
      swapMode: SwapMode.ExactIn, amountIn: new BN(amountRaw.toString()), slippageBps,
    });
    const amountOut = BigInt(q.outputAmount.toString());
    const feeTotal = BigInt(q.tradingFee.toString()) + BigInt(q.protocolFee.toString()) + BigInt(q.referralFee.toString());
    const spot = spotScaledFromSqrt(pool.poolState.sqrtPrice, c.decimals, 9);
    // price impact vs spot, in the trade's own terms (float display
    // math only). spot is SOL per WHOLE token × 1e12; amountIn is raw
    // (lamports for a buy, base atoms for a sell).
    let impactBps = null;
    if (spot > 0n && amountRaw > 0n) {
      const ideal = side === 'buy'
        ? Number(amountRaw) * 1e12 * 10 ** c.decimals / (1e9 * Number(spot))
        : Number(amountRaw) * Number(spot) * 1e9 / (10 ** c.decimals * 1e12);
      if (ideal > 0) impactBps = Math.max(0, Math.round((1 - Number(amountOut) / ideal) * 10000));
    }
    return {
      venue: 'curve', side, amountIn: amountRaw.toString(), amountOut: amountOut.toString(),
      minimumAmountOut: q.minimumAmountOut ? q.minimumAmountOut.toString() : (amountOut * BigInt(10000 - slippageBps) / 10000n).toString(),
      fees: { trading: q.tradingFee.toString(), protocol: q.protocolFee.toString(), referral: q.referralFee.toString(), total: feeTotal.toString(), note: 'fees are charged on the input amount by the curve' },
      priceImpactBps: impactBps, spotScaled: spot.toString(), modeled: false,
      quoteReserve: pool.poolState.quoteReserve.toString(),
    };
  }
  // Max quote-in (lamports) for a curve buy whose quoted out keeps the
  // destination at/under the rule-9 cap. Binary search over the pure
  // SDK quote — no extra RPC beyond the cached pool/config fetch.
  async maxBuyForCap(c, destBalance, capRaw) {
    const headroom = capRaw - destBalance;
    if (headroom <= 0n) return { maxAmountIn: '0', headroom: headroom.toString() };
    const { pool, config } = await this.sdkPoolConfig(c);
    const slot = await this.rpc('getSlot', [{ commitment: 'confirmed' }]);
    const isTs = Number(config.activationType) === 1;
    const currentPoint = new BN(isTs ? Math.floor(Date.now() / 1000) : slot);
    const outFor = (amtIn) => BigInt(this.dbc.pool.swapQuote2({
      virtualPool: pool, config, swapBaseForQuote: false, hasReferral: false,
      eligibleForFirstSwapWithMinFee: false, currentPoint, swapMode: SwapMode.ExactIn,
      amountIn: new BN(amtIn.toString()), slippageBps: 0,
    }).outputAmount.toString());
    let lo = 0n, hi = 1n;
    while (outFor(hi) <= headroom && hi < (2n ** 62n)) { lo = hi; hi *= 2n; }
    while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (outFor(mid) <= headroom) lo = mid; else hi = mid; }
    return { maxAmountIn: lo.toString(), headroom: headroom.toString(), quotedOutAtMax: outFor(lo).toString() };
  }
}

// ---------- eligibility (audit §4 — tri-state, never a bare boolean) ----------
function tradingWindow(params, now) {
  const tz = params.readInt32LE(0), mask = params[4];
  const startMin = params.readUInt16LE(5), endMin = params.readUInt16LE(7), scope = params[9];
  const evalAt = (t) => {
    const local = new Date((t + tz) * 1000);
    const dayIdx = (local.getUTCDay() + 6) % 7; // bit0 = Mon .. bit6 = Sun
    const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
    return { inside: ((mask >> dayIdx) & 1) === 1 && mins >= startMin && mins < endMin, dayIdx, mins };
  };
  const cur = evalAt(now);
  let nextOpen = null;
  if (!cur.inside) {
    for (let m = 1; m <= 8 * 1440; m++) { if (evalAt(now + m * 60).inside) { nextOpen = new Date((now + m * 60) * 1000).toISOString(); break; } }
  }
  const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { inside: cur.inside, scope, tzOffsetSecs: tz, daysMask: mask, window: `${fmtMin(startMin)}–${fmtMin(endMin)} local (UTC${tz >= 0 ? '+' : ''}${tz / 3600}h)`, nextOpen };
}

/**
 * checkEligibility(wallet, mint, side, amount, venue) — Gregory's model:
 * { status: eligible|ineligible|unknown, reasons[], checks[], maxAmount?,
 *   evaluatedAt, provisional: true }. `eligible` is always provisional:
 * the simulation of the concrete built transaction is the final check.
 * side: 'buy' (amountRaw = lamports in) | 'sell' | 'send' (base raw in).
 * venue: 'auto' | 'curve' | 'house' | 'p2p' (send forces p2p).
 */
export async function checkEligibility(kit, c, { wallet, destWallet = null, side, amountRaw, venue = 'auto', walletType = 'own', kind = 1, now = Math.floor(Date.now() / 1000) }) {
  amountRaw = BigInt(amountRaw);
  const dest = destWallet ?? wallet;
  const snap = await kit.snapshot(c, wallet, dest);
  const venueResolved = side === 'send' ? 'p2p' : venue === 'auto' ? snap.venueInfo.venue : venue;
  const checks = [], reasons = [], notes = [];
  const add = (name, rule, result, { code = null, detail = '', repairable = null, fix = null, evidence = {}, engineOverride = undefined } = {}) => {
    checks.push({ name, rule, result, ...(code ? { code } : {}), detail, evidence });
    if (result !== 'pass') reasons.push({ code, rule, detail: detail || (code ? TK_REASONS[code]?.text : ''), repairable, ...(fix ? { fix } : {}), engineCode: engineOverride !== undefined ? engineOverride : code ? TK_REASONS[code]?.engineCode ?? null : null });
    else if (detail) notes.push({ name, rule, detail });
  };

  // ---- signer boundary (Path A supported; Bankr custodial refused) ----
  if (walletType === 'bankr') {
    add('signer', null, 'fail', {
      code: 'TK_SIGNER_UNSUPPORTED', repairable: 'none',
      detail: 'Bankr-custodial wallet cannot sign the transactions this kit builds. Bankr\'s documented /wallet/sign covers only personal_sign, eth_signTypedData_v4, eth_signTransaction (all EVM) and /wallet/submit takes EVM transaction objects; the unsupported steps are (1) Registry Register — a self-signed Solana transaction, (2) hook-aware DBC/house swap sign + broadcast, (3) the attestation request\'s ed25519 message signature. Use a Path A signer (own keypair / hardware / sandbox keypair).',
      evidence: { walletType, documentedSignatureTypes: ['personal_sign', 'eth_signTypedData_v4', 'eth_signTransaction'] },
    });
  } else {
    add('signer', null, 'pass', { detail: walletType === 'sandbox' ? 'Path B′: sandbox keypair — a Path A signer (verify the persistence handshake: the funded address must read back identical in a later session)' : 'Path A: agent\'s own Solana signer', evidence: { walletType } });
  }

  // ---- venue / graduation state ----
  const slotState = snap.cfg.houseSlot?.state ?? 0;
  if (venueResolved === 'house' && slotState !== 2) {
    add('venue', null, 'fail', { code: 'TK_VENUE_UNAVAILABLE', repairable: 'wait', detail: `house venue requested but the token's house slot is ${slotState === 0 ? 'absent' : `state ${slotState} (not activated)`}; the curve is the available door`, evidence: { slotState } });
  } else {
    add('venue', null, 'pass', { detail: snap.venueInfo.reason, evidence: { venue: venueResolved, slotState } });
  }
  if (side !== 'send' && venueResolved !== snap.venueInfo.venue) {
    add('venue', null, 'pass', { detail: `venue divergence: the requested door is ${venueResolved}, but this token's default venue is ${snap.venueInfo.venue} (${snap.venueInfo.reason}). Both doors execute the same rule gates; they price differently (bonding curve vs constant-product) and settle different fee shapes.`, evidence: { requested: venueResolved, default: snap.venueInfo.venue } });
  }
  // Config exemptions (engine is_exempt: owner OR token-account match).
  // Destination-exempt skips rules 9/3/17/4/10/8; source-exempt skips
  // the rule-1/13 sender gates. Proof-token configs exempt their test
  // accounts (e.g. HPROOF exempts fren's ATA), so this is load-bearing,
  // not decorative — a record-less sell from an exempt account passes
  // on-chain (Phase-2 matrix R15).
  const exList = snap.cfg.exemptions ?? [];
  const receives = side === 'buy' || side === 'send';
  const senderExempt = exList.includes(wallet.toBase58()) || exList.includes(c.ata(wallet).toBase58());
  const destOwner = side === 'send' ? dest : wallet;
  const destExempt = receives && (exList.includes(destOwner.toBase58()) || exList.includes(c.ata(destOwner).toBase58()));
  const thresholdSol = c.rec.spec?.migrationThresholdSol;
  if (thresholdSol && snap.poolQuoteReserve != null && venueResolved === 'curve') {
    const threshold = BigInt(Math.round(thresholdSol * LAMPORTS_PER_SOL));
    if (snap.poolQuoteReserve >= threshold) {
      add('graduation', null, 'unknown', { code: 'TK_HOOK_INACTIVE', repairable: 'none', detail: `curve quote reserve ${snap.poolQuoteReserve} ≥ migration threshold ${threshold}: the completing swap revokes the hook and the token migrates to DAMM v2, which this kit does not build for`, evidence: { poolQuoteReserve: snap.poolQuoteReserve.toString(), thresholdLamports: threshold.toString() } });
    }
  }

  // ---- balances ----
  if ((side === 'sell' || side === 'send') && snap.myBalance < amountRaw) {
    add('balance', null, 'fail', { code: 'TK_INSUFFICIENT_BALANCE', repairable: 'none', detail: `wallet holds ${snap.myBalance} raw, requested ${amountRaw}`, evidence: { balance: snap.myBalance.toString(), amount: amountRaw.toString() } });
  } else if (side === 'sell' || side === 'send') add('balance', null, 'pass', { evidence: { balance: snap.myBalance.toString() } });

  // ---- registration substrate + rules 3 / 17 (receive-side) ----
  const r3 = ruleOf(snap.cfg, 3), r17 = ruleOf(snap.cfg, 17);
  const destReg = side === 'send' ? snap.destRegistry : snap.registry;
  const destHolder = side === 'send' ? snap.destHolder : snap.holder;
  let needRegister = false, needSync = false;
  if (receives && (r3 || r17) && destExempt) {
    add('registration', r3 ? 3 : 17, 'pass', { detail: 'destination (wallet or its token account) is on the config exemption list — rules 3/17 skip exempt destinations in the engine', evidence: { exempt: true } });
  } else if (receives && (r3 || r17)) {
    const selfFix = side === 'buy';
    if (!destReg.exists) {
      needRegister = selfFix;
      add('registration', r3 ? 3 : 17, 'fail', { code: 'TK_NOT_REGISTERED', repairable: selfFix ? 'in-flow' : 'none', fix: selfFix ? 'register+sync are bundled by build' : 'the destination wallet must register+sync itself; a sender cannot register for it', evidence: { registryExists: false, active: null } });
    } else if (!destReg.active) {
      add('registration', r3 ? 3 : 17, 'fail', { code: 'TK_NOT_REGISTERED', repairable: 'none', detail: 'a Registry registration exists for this wallet but is DEACTIVATED — register would fail AlreadyRegistered and this kit cannot reactivate it', evidence: { registryExists: true, active: false } });
    } else if (!destHolder.registered) {
      needSync = selfFix;
      add('registration-mirror', r3 ? 3 : 17, 'fail', { code: 'TK_MIRROR_UNSYNCED', repairable: selfFix ? 'in-flow' : 'none', fix: selfFix ? 'sync is bundled by build' : 'the destination wallet must sync its mirror for this token account', evidence: { holderExists: destHolder.exists, registered: destHolder.registered ?? null } });
    } else add('registration', r3 ? 3 : 17, 'pass', { evidence: { kind: destReg.kind, ecosystem: destReg.ecosystem } });
    if (r17 && destReg.exists) {
      const required = r17.params[0];
      if (destReg.ecosystem !== required) {
        add('ecosystem-gate', 17, 'fail', { code: 'TK_WRONG_ECOSYSTEM', repairable: 'operator', fix: `complete the ${ECOSYSTEM_NAMES[required] ?? 'ecosystem ' + required} attestation (operator-stamped; see attestation skill)`, evidence: { required, walletEcosystem: destReg.ecosystem } });
        if (required !== 1) add('ecosystem-attester', 17, 'fail', { code: 'TK_NO_LIVE_ATTESTER', repairable: 'operator', detail: 'no attester is configured for this ecosystem today, so no unstamped wallet can become eligible', evidence: { required } });
      } else add('ecosystem-gate', 17, 'pass', { evidence: { required, walletEcosystem: destReg.ecosystem } });
    }
  }

  // ---- rule 9 Max Wallet (receive-side, amount-dependent via quote) ----
  let maxAmount = null;
  const r9 = ruleOf(snap.cfg, 9);
  if (r9 && receives && destExempt) {
    add('max-wallet', 9, 'pass', { detail: 'destination is on the config exemption list — rule 9 skips exempt destinations in the engine', evidence: { exempt: true } });
  } else if (r9 && receives) {
    const capBps = BigInt(r9.params.readUInt16LE(0));
    const cap = capBps * snap.supply / 10000n;
    if (side === 'send') {
      const post = snap.destBalance + amountRaw;
      if (post > cap) { maxAmount = (cap - snap.destBalance).toString(); add('max-wallet', 9, 'fail', { code: 'TK_MAX_WALLET', repairable: 'none', detail: `post-transfer balance ${post} would exceed cap ${cap} (${capBps} bps of supply)`, evidence: { cap: cap.toString(), destBalance: snap.destBalance.toString(), headroom: (cap - snap.destBalance).toString(), maxAmount } }); }
      else add('max-wallet', 9, 'pass', { evidence: { cap: cap.toString(), headroom: (cap - snap.destBalance).toString() } });
    } else { // buy
      const q = await kit.quote(c, { side: 'buy', amountRaw, venue: venueResolved, snap });
      const out = BigInt(q.amountOut);
      const post = snap.myBalance + out;
      if (post > cap) {
        if (venueResolved === 'curve') { const m = await kit.maxBuyForCap(c, snap.myBalance, cap); maxAmount = m.maxAmountIn; }
        else { // house: binary search the constant-product model locally
          let lo = 0n, hi = amountRaw;
          const outFor = (a) => BigInt(kitHouseOut(snap, a));
          while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (snap.myBalance + outFor(mid) <= cap) lo = mid; else hi = mid; }
          maxAmount = lo.toString();
        }
        add('max-wallet', 9, 'fail', { code: 'TK_MAX_WALLET', repairable: 'none', detail: `quoted receive ${out} would put the wallet at ${post}, over cap ${cap} (${capBps} bps of supply)`, evidence: { cap: cap.toString(), balance: snap.myBalance.toString(), quotedOut: out.toString(), headroom: (cap - snap.myBalance).toString(), maxAmount } });
      } else add('max-wallet', 9, 'pass', { evidence: { cap: cap.toString(), quotedOut: out.toString(), headroom: (cap - snap.myBalance).toString() } });
    }
  }

  // ---- rule 1 Basis Latch ----
  const r1 = ruleOf(snap.cfg, 1);
  if (r1) {
    const mode = r1.params[18];
    const maxStale = r1.params.readBigUInt64LE(0) || 300n;
    const feedAge = snap.feed.exists && snap.feed.lastCrankTs > 0 ? now - snap.feed.lastCrankTs : null;
    const feedStale = !snap.feed.exists || snap.feed.lastCrankTs === 0 || BigInt(Math.max(0, feedAge ?? 0)) > maxStale;
    if (side === 'buy') {
      add('basis-latch', 1, 'pass', { detail: feedStale ? 'buy records basis from the feed EMA; the feed is stale, so build bundles a DBC crank first and the basis records at current spot' : 'buy records basis from the feed EMA', evidence: { mode, feedAgeSecs: feedAge, feedStale } });
    } else if (senderExempt) {
      add('basis-latch', 1, 'pass', { detail: 'sender (wallet or its token account) is on the config exemption list — the engine skips the rule-1 sender gate for exempt sources, and no basis bookkeeping accrues on this account', evidence: { mode, exempt: true } });
    } else { // sell or send: sender-side gate
      const holder = snap.holder;
      if (!holder.exists || holder.basisScaled == null) {
        add('basis-latch', 1, 'fail', { code: 'TK_BASIS_MISSING', repairable: 'none', detail: 'sender has no basis record — tokens that did not arrive through a basis-recording buy cannot exit through the latch gate', evidence: { holderExists: holder.exists } });
      } else if (mode === 2) {
        // GRADUATED: earned-cap math on stored fields = a lower bound;
        // the execution-time crank folds the live EMA into grad_min_price
        // and can only raise the cap.
        const frac = gradFracBps(holder, holder.basisScaled, now, r1.params);
        const capFromFrac = frac * (holder.gradPeak ?? 0n) / 10000n;
        const capNow = (holder.gradCap ?? 0n) > capFromFrac ? (holder.gradCap ?? 0n) : capFromFrac;
        const sellable = capNow > (holder.gradSold ?? 0n) ? capNow - (holder.gradSold ?? 0n) : 0n;
        if (venueResolved !== 'curve' && feedStale && amountRaw > sellable) {
          add('basis-latch', 1, 'unknown', { code: 'TK_STALE_FEED', repairable: 'wait', detail: 'graduated sell above the stored earned cap on a venue whose build does not bundle a crank, with a stale feed — the on-chain gate reads the feed as-is and fails closed (StalePrice)', evidence: { sellable: sellable.toString(), feedAgeSecs: feedAge } });
        } else if (amountRaw <= sellable) {
          add('basis-latch', 1, 'pass', { detail: 'graduated earned cap covers this sell on stored state (execution can only earn more)', evidence: { fracBps: frac.toString(), capNow: capNow.toString(), gradSold: (holder.gradSold ?? 0n).toString(), sellable: sellable.toString() } });
        } else {
          add('basis-latch', 1, 'unknown', { code: 'TK_PARTIAL_LOCKED', repairable: 'wait', detail: `sell ${amountRaw} exceeds the earned cap measurable pre-trade (${sellable}); a bundled crank folding a deeper dip, or more vesting time, may raise it — simulation decides`, evidence: { capNow: capNow.toString(), gradSold: (holder.gradSold ?? 0n).toString(), sellable: sellable.toString() } });
          maxAmount = sellable.toString();
        }
      } else {
        // LATCH (0) / LIVE (1): compare the post-crank price to basis.
        let effective = null, priceSource = null;
        if (venueResolved === 'house') {
          if (!snap.feed.exists) add('basis-latch', 1, 'unknown', { code: 'TK_STALE_FEED', repairable: 'wait', detail: 'no price feed account — the latch gate fails closed (PriceFeedBad)', evidence: {} });
          else if (feedStale) add('basis-latch', 1, 'unknown', { code: 'TK_STALE_FEED', repairable: 'wait', detail: 'house-venue builds do not bundle a crank and the feed is stale — the gate fails closed (StalePrice) until anyone cranks it', evidence: { feedAgeSecs: feedAge, maxStaleSecs: maxStale.toString() } });
          else { effective = snap.feed.ema; priceSource = 'stored feed EMA (house venue; feed fresh)'; }
        } else {
          const spot = await kit.spotScaled(c);
          effective = postCrankEma(snap.feed, spot, r1.params, now);
          priceSource = 'post-crank EMA (build bundles the DBC crank; spot from live pool sqrt_price)';
        }
        if (effective != null) {
          const basis = holder.basisScaled;
          const latchedOk = mode === 0 && holder.latched;
          if (latchedOk) add('basis-latch', 1, 'pass', { detail: 'position is latched (a dip below basis already unlocked this holder forever)', evidence: { basis: basis.toString() } });
          else if (effective < basis) add('basis-latch', 1, 'pass', { detail: `price ${effective} is below basis ${basis} — the sell is unlocked${mode === 0 ? ' and latches the position' : ' (LIVE mode: re-locks if price recovers)'}`, evidence: { priceScaled: effective.toString(), basisScaled: basis.toString(), priceSource } });
          else add('basis-latch', 1, 'fail', { code: 'TK_LOCKED', repairable: 'wait', fix: 'wait for a dip below basis, then any sell works (LATCH) — do not retry-loop', detail: `price ${effective} is at/above basis ${basis} and the position is not latched`, evidence: { priceScaled: effective.toString(), basisScaled: basis.toString(), priceSource } });
        }
      }
    }
  }

  // ---- rule 2 Escrow Split: never vetoes; venue shapes proceeds ----
  const r2 = ruleOf(snap.cfg, 2);
  if (r2) add('escrow-split', 2, 'pass', { detail: venueResolved === 'house' ? `house venue: ${r2.params.readUInt16LE(0)} bps of proceeds route through the buyer's/seller's escrow and resolve over time (modeled in quote)` : 'curve venue: rule 2 is an engine no-op here (it lives on the house venue)', evidence: { splitBps: r2.params.readUInt16LE(0), venue: venueResolved } });

  // ---- rule 4 App-Gated: caller is the venue program driving the transfer ----
  const r4 = ruleOf(snap.cfg, 4);
  if (r4) {
    const apps = [new PublicKey(r4.params.subarray(0, 32)), new PublicKey(r4.params.subarray(32, 64))].filter(p => !p.equals(PublicKey.default));
    if (destExempt) add('app-gated', 4, 'pass', { detail: 'destination is on the config exemption list — rule 4 skips exempt destinations in the engine', evidence: { exempt: true } });
    else if (venueResolved === 'p2p') add('app-gated', 4, 'pass', { detail: 'rule 4 gates VENUE receives only: the engine module returns Ok outside venue context, so a direct wallet-to-wallet transfer is not gated by rule 4 (Phase-2 matrix R18 proved a bare transfer passes; the audit\'s BadCaller expectation for this shape was wrong)', evidence: { apps: apps.map(a => a.toBase58()) } });
    else {
      const driver = venueResolved === 'house' ? (snap.cfg.houseSlot?.program ?? c.programs.house) : c.programs.dbc;
      if (driver && apps.some(a => a.equals(driver))) add('app-gated', 4, 'pass', { evidence: { driver: driver.toBase58(), apps: apps.map(a => a.toBase58()) } });
      else add('app-gated', 4, 'fail', { code: 'TK_APP_NOT_ALLOWED', repairable: 'none', detail: `the ${venueResolved} venue program ${driver?.toBase58()} is not in this token's app list`, evidence: { driver: driver?.toBase58() ?? null, apps: apps.map(a => a.toBase58()) } });
    }
  }

  // ---- rule 7 P2P Toggle ----
  const r7 = ruleOf(snap.cfg, 7);
  if (r7) {
    const mode = r7.params[0]; // 0 = P2P-only, 1 = No-P2P
    if (mode === 0 && venueResolved !== 'p2p') add('p2p-toggle', 7, 'fail', { code: 'TK_VENUE_FORBIDDEN', repairable: 'none', detail: 'token is P2P-only: venue transfers are vetoed', evidence: { mode } });
    else if (mode === 1 && venueResolved === 'p2p') add('p2p-toggle', 7, 'fail', { code: 'TK_VENUE_FORBIDDEN', repairable: 'none', detail: 'token is No-P2P: wallet-to-wallet transfers are vetoed; trade on the venue', evidence: { mode } });
    else add('p2p-toggle', 7, 'pass', { evidence: { mode } });
  }

  // ---- rule 8 Holder-Gated ----
  const r8 = ruleOf(snap.cfg, 8);
  if (r8) {
    if (venueResolved !== 'p2p') add('holder-gated', 8, 'fail', { code: 'TK_GATE_VENUE_CLOSED', repairable: 'none', fix: 'use the send path (gate sync is bundled immediately before the transfer)', evidence: { venue: venueResolved } });
    else if (snap.gate && snap.gate.balance >= snap.gate.threshold) add('holder-gated', 8, 'pass', { evidence: { gateBalance: snap.gate.balance.toString(), threshold: snap.gate.threshold.toString() } });
    else add('holder-gated', 8, 'fail', { code: 'TK_GATE_HOLDER', repairable: 'none', detail: 'destination gate-token balance is below the threshold', evidence: { gateBalance: (snap.gate?.balance ?? 0n).toString(), threshold: (snap.gate?.threshold ?? 0n).toString() } });
  }

  // ---- rule 11 The Grudge: no live config instance exists to verify
  // field semantics against (audit §4) — refuse to guess. ----
  const r11 = ruleOf(snap.cfg, 11);
  if (r11) add('grudge', 11, 'unknown', { code: 'TK_UNVERIFIED_RULE', repairable: 'none', detail: 'rule 11 state is readable (see evidence) but its precheck semantics are unverified; simulation decides', evidence: { grudgeMarkUntil: snap.holder.grudgeMarkUntil ?? null, grudgeOffenses: snap.holder.grudgeOffenses ?? null } });

  // ---- rule 12 Trading Hours ----
  const r12 = ruleOf(snap.cfg, 12);
  if (r12) {
    const scope = r12.params[9];
    if (scope === 1 && venueResolved === 'p2p') add('trading-hours', 12, 'pass', { detail: 'window scope is venue transfers only; a wallet-to-wallet send is out of scope', evidence: { scope } });
    else {
      const w = tradingWindow(r12.params, now);
      if (w.inside) add('trading-hours', 12, 'pass', { evidence: { window: w.window, scope } });
      else add('trading-hours', 12, 'fail', { code: 'TK_OUTSIDE_HOURS', repairable: 'wait', fix: w.nextOpen ? `next opening ${w.nextOpen}` : 'trade inside the configured window', detail: `outside the configured window ${w.window}`, evidence: { window: w.window, scope, nextOpen: w.nextOpen } });
    }
  }

  // ---- rule 13 Vesting Clock (sender-side; math from the engine) ----
  const r13 = ruleOf(snap.cfg, 13);
  if (r13 && side !== 'buy') {
    const mode = r13.params[0], hold = r13.params.readBigUInt64LE(8), release = Number(r13.params.readBigInt64LE(16));
    const holder = snap.holder;
    if (senderExempt) add('vesting-clock', 13, 'pass', { detail: 'sender is on the config exemption list — the engine skips the rule-13 sender gate for exempt sources', evidence: { exempt: true } });
    else if (!holder.exists) add('vesting-clock', 13, 'fail', { code: 'TK_BASIS_MISSING', engineOverride: 9, repairable: 'none', detail: 'rule 13 fails closed (HolderMissing) for a sender with no holder record', evidence: {} });
    else {
      const anchor = holder.vestAnchor ?? 0;
      let fracBps;
      if (release > 0 && now < release) fracBps = 0n;
      else if (hold === 0n) fracBps = 10000n;
      else {
        const elapsed = anchor === 0 ? 0n : BigInt(Math.max(0, now - anchor));
        fracBps = mode === 0 ? (elapsed >= hold ? 10000n : 0n) : (elapsed * 10000n / hold > 10000n ? 10000n : elapsed * 10000n / hold);
      }
      const pre = snap.myBalance;
      const locked = pre * (10000n - fracBps) / 10000n;
      const spendable = pre - locked;
      if (amountRaw <= spendable) add('vesting-clock', 13, 'pass', { evidence: { fracBps: fracBps.toString(), spendable: spendable.toString() } });
      else { maxAmount = spendable.toString(); add('vesting-clock', 13, 'fail', { code: 'TK_VESTING_LOCKED', repairable: 'wait', detail: `only ${spendable} of ${pre} is unlocked (fraction ${fracBps} bps)`, evidence: { fracBps: fracBps.toString(), spendable: spendable.toString(), maxAmount } }); }
    }
  }

  // ---- rules with no transfer gate / unverified surfaces ----
  const r10 = ruleOf(snap.cfg, 10);
  if (r10) add('allow-blocklist', 10, 'unknown', { code: 'TK_UNVERIFIED_RULE', repairable: 'none', detail: 'rule 10 lists live in per-mint PDAs this kit version does not read; simulation decides', evidence: { mode: r10.params[0] } });
  for (const id of [5, 6, 15, 16]) if (ruleOf(snap.cfg, id)) add(RULE_NAMES[id].toLowerCase().replace(/[^a-z]+/g, '-'), id, 'pass', { detail: 'settlement-side rule: it shapes fee distribution at settle time and never gates a transfer', evidence: {} });
  if (ruleOf(snap.cfg, 14)) add('decay-tax', 14, 'pass', { detail: 'decay tax would price through the mint TransferFee extension (amount-out effect, not a veto); it is not launchable on the DBC path', evidence: {} });

  // ---- rent vault (first receive into an underfunded token) ----
  if (receives && !destHolder.exists && snap.rentVaultLamports < HOLDER_PDA_RENT) {
    add('rent-vault', null, 'fail', { code: 'TK_RENT_VAULT_UNDERFUNDED', repairable: 'operator', fix: 'the launcher tops up the token\'s rent vault', detail: `rent vault holds ${snap.rentVaultLamports} lamports; a new Holder PDA needs ~${HOLDER_PDA_RENT}`, evidence: { rentVaultLamports: snap.rentVaultLamports.toString() } });
  }

  // ---- funds for the trade + bundled prerequisites (buy path) ----
  if (side === 'buy') {
    let need = amountRaw + TX_FEE_BUFFER;
    if (needRegister) need += REGISTRATION_RENT;
    if (needSync) need += HOLDER_PDA_RENT;
    if (!snap.myAtaExists) need += ATA_RENT;
    if (snap.walletLamports < need) add('funds', null, 'fail', { code: 'TK_INSUFFICIENT_FUNDS', repairable: 'none', detail: `wallet holds ${snap.walletLamports} lamports; this trade needs ~${need} (amount + prerequisite rents/fees). Shortfall ~${need - snap.walletLamports}`, evidence: { walletLamports: snap.walletLamports.toString(), needed: need.toString() } });
    else add('funds', null, 'pass', { evidence: { walletLamports: snap.walletLamports.toString(), needed: need.toString() } });
  }

  const slot = await kit.rpc('getSlot', [{ commitment: 'confirmed' }]);
  const blockers = checks.filter(x => x.result === 'fail');
  const unknowns = checks.filter(x => x.result === 'unknown');
  return {
    status: blockers.length ? 'ineligible' : unknowns.length ? 'unknown' : 'eligible',
    provisional: true,
    wallet: wallet.toBase58(), walletType, mint: c.mint.toBase58(), symbol: c.rec.symbol,
    side, amountRaw: amountRaw.toString(), venue: venueResolved,
    reasons, checks, notes, ...(maxAmount != null ? { maxAmount } : {}),
    evaluatedAt: { slot, utc: new Date(now * 1000).toISOString() },
    snapshotAt: snap.at,
  };
}
// House constant-product out for a buy of `amtIn` lamports (after the
// rule-2 escrow split on the input), from a snapshot's live reserves.
export function kitHouseOut(snap, amtIn) {
  const split = ruleOf(snap.cfg, 2) ? BigInt(ruleOf(snap.cfg, 2).params.readUInt16LE(0)) : 0n;
  const traded = amtIn - amtIn * split / 10000n;
  const { tokenReserve: t, quoteReserve: q } = snap.house;
  return q + traded > 0n ? (t * traded / (q + traded)).toString() : '0';
}

// ---------- build (unsigned; bundling mirrors the audit's S4/S5 proofs) ----------
export class TradeKitError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}
/**
 * Build an unsigned hook-aware transaction. Bundles prerequisites
 * atomically when their on-chain effect is absent: DBC crank (rule-1
 * sells, stale-feed buys), register + sync (Agent-Only first receive),
 * distributor settles, rule-8 gate sync, ATA creation (inside the SDK
 * build / explicit for house+send). Refuses when eligibility carries a
 * blocker the bundle cannot repair (override with force — the result
 * is still only an unsigned transaction; simulation remains the
 * arbiter). NEVER touches a keypair.
 */
export async function buildTrade(kit, c, { wallet, destWallet = null, side, amountRaw, venue = 'auto', walletType = 'own', kind = 1, slippageBps = 100, force = false }) {
  amountRaw = BigInt(amountRaw);
  const dest = destWallet ?? wallet;
  const elig = await checkEligibility(kit, c, { wallet, destWallet: dest, side, amountRaw, venue, walletType, kind });
  const hardBlockers = elig.reasons.filter(r => r.repairable !== 'in-flow' && elig.checks.find(x => x.code === r.code)?.result === 'fail');
  if (elig.reasons.some(r => r.code === 'TK_SIGNER_UNSUPPORTED')) {
    throw new TradeKitError('TK_SIGNER_UNSUPPORTED', 'refusing to build for a Bankr-custodial wallet: the resulting transaction could not be signed through any documented Bankr interface (arbitrary Solana instruction signing is the unsupported step)', { eligibility: elig, blockers: hardBlockers });
  }
  if (hardBlockers.length && !force) {
    throw new TradeKitError('TK_INELIGIBLE', `eligibility is ${elig.status}: ${hardBlockers.map(r => r.code).join(', ')}`, { eligibility: elig, blockers: hardBlockers });
  }
  const snap = await kit.snapshot(c, wallet, dest);
  const venueResolved = elig.venue;
  const bundled = [];
  const prereqs = [];
  const r1 = ruleOf(snap.cfg, 1), r3 = ruleOf(snap.cfg, 3), r17 = ruleOf(snap.cfg, 17);
  const now = Math.floor(Date.now() / 1000);

  // crank: rule-1 sells/sends always (the gate reads the post-crank
  // EMA); rule-1 buys when the feed is stale, so the recorded basis is
  // current spot. Curve-priced tokens only — the proven house driver
  // bundles no crank, and eligibility flags house staleness instead.
  if (r1 && venueResolved !== 'house') {
    const maxStale = r1.params.readBigUInt64LE(0) || 300n;
    const stale = !snap.feed.exists || snap.feed.lastCrankTs === 0 || BigInt(Math.max(0, now - snap.feed.lastCrankTs)) > maxStale;
    if (side !== 'buy' || stale) { prereqs.push(kit.crankDbcIx(c)); bundled.push('crank-dbc'); }
  }
  // register + sync: only the wallet can register itself, and only a
  // missing registration can be created in-flow (a deactivated one is a
  // hard blocker above via eligibility's repairable=none — enforced in
  // hardBlockers because its fix is not in-flow when it cannot bundle).
  const destReg = side === 'send' ? snap.destRegistry : snap.registry;
  const destHolder = side === 'send' ? snap.destHolder : snap.holder;
  const destExemptB = (snap.cfg.exemptions ?? []).includes(wallet.toBase58()) || (snap.cfg.exemptions ?? []).includes(c.ata(wallet).toBase58());
  if (side === 'buy' && (r3 || r17) && !destExemptB) {
    if (!destReg.exists) { prereqs.push(kit.registerIx(c, wallet, kind)); bundled.push('register'); }
    if (!destHolder.registered) { prereqs.push(kit.syncIx(c, wallet, snap.destHolderKey)); bundled.push('sync'); }
  }
  // distributor settles (both sides, before the transfer)
  const counterparty = venueResolved === 'house' ? snap.house.poolPda : venueResolved === 'p2p' ? dest : c.poolAuthority;
  const settles = await kit.settlesFor(c, wallet, counterparty, snap);
  prereqs.push(...settles.ixs); bundled.push(...settles.bundled);

  const q = await kit.quote(c, { side, amountRaw, venue: venueResolved, snap, slippageBps });
  const minOut = BigInt(q.minimumAmountOut);
  const main = [];
  if (venueResolved === 'curve') {
    const sdkTx = await kit.dbc.pool.swap2WithTransferHook({
      swapMode: SwapMode.ExactIn, swapBaseForQuote: side === 'sell',
      amountIn: new BN(amountRaw.toString()), minimumAmountOut: new BN(minOut.toString()),
      owner: wallet, pool: c.pool, referralTokenAccount: null, payer: wallet,
    });
    if (!snap.myAtaExists) bundled.push('ata-create (inside SDK build)');
    main.push(...sdkTx.instructions);
  } else if (venueResolved === 'house') {
    const myQuoteAta = snap.house.myQuoteAta;
    if (!snap.house.myQuoteAtaExists) { main.push(createAssociatedTokenAccountInstruction(wallet, myQuoteAta, wallet, NATIVE_MINT, LEGACY)); bundled.push('wsol-ata-create'); }
    if (!snap.myAtaExists) { main.push(createAssociatedTokenAccountInstruction(wallet, c.ata(wallet), wallet, c.mint, T22)); bundled.push('ata-create'); }
    if (side === 'buy') {
      main.push(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: myQuoteAta, lamports: Number(amountRaw) }));
      main.push(createSyncNativeInstruction(myQuoteAta));
      bundled.push('wrap-sol');
    }
    main.push(await buildHouseSwapIx(kit.conn, { record: c.rec, slot: snap.cfg.houseSlot, isBuy: side === 'buy', user: wallet, amountInRaw: amountRaw, minOutRaw: minOut }));
    if (side === 'sell' && recordHasRule2(c.rec)) {
      const houseQuoteVault = getAssociatedTokenAddressSync(NATIVE_MINT, snap.house.poolPda, true, LEGACY);
      main.push(createSyncNativeInstruction(houseQuoteVault));
      bundled.push('house-vault-syncnative');
    }
  } else { // p2p send
    const destAta = c.ata(dest);
    if (!snap.destAtaExists) { main.push(createAssociatedTokenAccountInstruction(wallet, destAta, dest, c.mint, T22)); bundled.push('dest-ata-create'); }
    const r8 = ruleOf(snap.cfg, 8);
    if (r8 && snap.gate) { main.push(kit.syncGateIx(c, wallet, snap.gate.destAta, destAta, snap.holderKey)); bundled.push('gate-sync'); }
    main.push(await createTransferCheckedWithTransferHookInstruction(kit.conn, c.ata(wallet), c.mint, destAta, wallet, amountRaw, c.decimals, [], 'confirmed', T22));
  }

  const ixs = [];
  if (venueResolved === 'house') ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  else if (prereqs.length) ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }));
  ixs.push(...prereqs, ...main);

  const tx = new Transaction();
  tx.add(...ixs);
  tx.feePayer = wallet;
  const bh = (await kit.rpc('getLatestBlockhash', [{ commitment: 'processed' }])).value;
  tx.recentBlockhash = bh.blockhash;
  const transactionBase64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const keySet = new Map();
  for (const ix of ixs) { keySet.set(ix.programId.toBase58(), true); for (const k of ix.keys) keySet.set(k.pubkey.toBase58(), k.isSigner); }
  const manifest = {
    wallet: wallet.toBase58(), mint: c.mint.toBase58(), symbol: c.rec.symbol, side, venue: venueResolved,
    amountIn: amountRaw.toString(), expectedAmountOut: q.amountOut, minimumAmountOut: minOut.toString(),
    slippageBps, priceImpactBps: q.priceImpactBps ?? null, quoteModeled: !!q.modeled,
    bundled, instructionCount: ixs.length,
    accounts: { unique: keySet.size, signers: [wallet.toBase58()], programs: [...new Set(ixs.map(ix => ix.programId.toBase58()))] },
    blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight,
    eligibilityStatus: elig.status,
  };
  return { transactionBase64, manifest, eligibility: elig, quote: q };
}

/** DIAGNOSTIC builder: the bare curve swap (+ ATA creates) with NO
 *  rule prerequisites bundled — register/sync/crank/settles are all
 *  omitted. Exists so the test matrix (and debugging agents) can prove
 *  exactly which veto fires when prerequisites are missing. Normal
 *  agents use buildTrade. Curve venue only. */
export async function buildSwapOnly(kit, c, { wallet, side, amountRaw, slippageBps = 100 }) {
  amountRaw = BigInt(amountRaw);
  const q = await kit.quote(c, { side, amountRaw, venue: 'curve', slippageBps });
  const sdkTx = await kit.dbc.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: side === 'sell',
    amountIn: new BN(amountRaw.toString()), minimumAmountOut: new BN(q.minimumAmountOut),
    owner: wallet, pool: c.pool, referralTokenAccount: null, payer: wallet,
  });
  const tx = new Transaction().add(...sdkTx.instructions);
  tx.feePayer = wallet;
  const bh = await kit.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  tx.recentBlockhash = bh.value.blockhash;
  return { transaction: tx, quote: q };
}

// ---------- simulate + classify (errors.md taxonomy) ----------
export function classifySimLogs({ err, logs = [] }, c) {
  const roles = new Map([
    [c.programs.engine.toBase58(), ['engine', ENGINE_ERRORS, 'hook-veto']],
    [c.programs.distributor.toBase58(), ['distributor', DIST_ERRORS, 'settlement']],
    [c.programs.registry.toBase58(), ['registry', REGISTRY_ERRORS, 'registry']],
  ]);
  if (!err) return { status: 'passed', layer: 'none' };
  let lastProgram = null, customCode = null, customProgram = null;
  for (const line of logs) {
    // "Program X failed: custom program error: 0xN" names the program
    // that ORIGINATED the error; the innermost failure is logged
    // first. (The bare "custom program error" phrasing also appears at
    // every propagation level — attributing by the last invoke before
    // it mis-assigns hook vetoes to the token program.)
    const named = line.match(/^Program (\w{32,44}) failed: custom program error: 0x([0-9a-f]+)/i);
    if (named && customCode == null) { customProgram = named[1]; customCode = parseInt(named[2], 16); }
    const inv = line.match(/^Program (\w{32,44}) invoke/);
    if (inv) lastProgram = inv[1];
    const m = line.match(/custom program error: 0x([0-9a-f]+)/i);
    if (m && customCode == null) { customCode = parseInt(m[1], 16); customProgram = lastProgram; }
  }
  const engineLines = logs.filter(l => l.includes('engine:') || l.includes('custom program error')).slice(0, 8);
  let ixIndex = null;
  if (err && typeof err === 'object' && 'InstructionError' in err) ixIndex = err.InstructionError[0];
  const base = { status: 'failed', instructionIndex: ixIndex, engineLogLines: engineLines, rawError: err };
  if (customCode != null && customProgram && roles.has(customProgram)) {
    const [role, table, layer] = roles.get(customProgram);
    const known = table[customCode];
    return { ...base, layer, program: customProgram, programRole: role, engineCode: customCode, name: known?.[0] ?? `custom error ${customCode}`, reason: known?.[1] ?? '' };
  }
  const joined = logs.join('\n');
  if (/Attempt to debit an account but found no record of a prior credit|insufficient lamports/i.test(joined)) {
    return { ...base, layer: 'wallet-state', program: customProgram, engineCode: customCode, name: 'InsufficientFunds', reason: 'the fee payer / funding account cannot cover this transaction (fees, rents, or the trade amount). In simulation of a fresh-wallet flow this is expected until the wallet is funded.' };
  }
  if (/Insufficient funds|insufficient funds for rent/i.test(joined)) {
    return { ...base, layer: 'wallet-state', program: customProgram, engineCode: customCode, name: 'InsufficientFunds', reason: 'an account cannot cover the amount or rent this transaction needs.' };
  }
  if (customProgram === SystemProgram.programId.toBase58()) {
    return { ...base, layer: 'wallet-state', program: customProgram, engineCode: customCode, name: 'SystemProgramError', reason: 'system program rejected the transaction (commonly insufficient lamports).' };
  }
  if (customCode != null) {
    return { ...base, layer: 'simulation', program: customProgram, engineCode: customCode, name: `custom error ${customCode}`, reason: `program ${customProgram} failed with a custom error this kit does not map — see engineLogLines` };
  }
  return { ...base, layer: 'simulation', program: customProgram, name: 'SimulationFailed', reason: 'simulation failed without a mapped custom error — see rawError and engineLogLines' };
}
export async function simulateTx(kit, c, tx) {
  if (!tx.recentBlockhash) {
    const bh = await kit.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    tx.recentBlockhash = bh.value.blockhash;
  }
  const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const v = (await kit.rpc('simulateTransaction', [b64, { sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64', commitment: 'confirmed' }])).value;
  return { ...classifySimLogs({ err: v.err, logs: v.logs ?? [] }, c), unitsConsumed: v.unitsConsumed ?? null, logs: v.logs ?? [] };
}
export async function simulateTrade(kit, c, buildOpts) {
  const built = await buildTrade(kit, c, buildOpts);
  const tx = Transaction.from(Buffer.from(built.transactionBase64, 'base64'));
  const sim = await simulateTx(kit, c, tx);
  return { simulation: sim, manifest: built.manifest, eligibility: built.eligibility, quote: built.quote, transactionBase64: built.transactionBase64 };
}

// ---------- verify (read-only, post-broadcast by the agent) ----------
export async function verifyTrade(kit, c, { signature, wallet }) {
  const st = (await kit.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).value[0];
  if (!st) return { signature, found: false };
  const out = { signature, found: true, confirmationStatus: st.confirmationStatus ?? null, slot: st.slot, err: st.err };
  const tx = await kit.rpc('getTransaction', [signature, { maxSupportedTransactionVersion: 0, encoding: 'json' }]);
  if (tx?.meta) {
    const keys = tx.transaction.message.accountKeys;
    const wIdx = wallet ? keys.indexOf(wallet.toBase58()) : -1;
    if (wIdx >= 0) out.solDeltaLamports = (BigInt(tx.meta.postBalances[wIdx]) - BigInt(tx.meta.preBalances[wIdx])).toString();
    if (wallet) {
      let delta = 0n;
      const pre = new Map(), post = new Map();
      for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === c.mint.toBase58() && b.owner === wallet.toBase58()) pre.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
      for (const b of tx.meta.postTokenBalances ?? []) if (b.mint === c.mint.toBase58() && b.owner === wallet.toBase58()) post.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
      for (const idx of new Set([...pre.keys(), ...post.keys()])) delta += (post.get(idx) ?? 0n) - (pre.get(idx) ?? 0n);
      out.tokenDeltaRaw = delta.toString();
    }
  }
  if (wallet) {
    const [metaInfo] = await kit.batchRead([c.metaPda]);
    const gen = holderGeneration(metaInfo?.data ?? null);
    const holderKey = gen === 'v3' ? c.holderPdaV3(c.ata(wallet)) : c.holderPda(wallet);
    const [holderInfo] = await kit.batchRead([holderKey]);
    const h = parseHolder(holderInfo?.data ?? null);
    out.holderAfter = h.exists ? { registered: h.registered, basisScaled: h.basisScaled?.toString() ?? null, latched: h.latched } : null;
  }
  return out;
}

// ---------- signer-capability preflight (additive; signer-independence) ----------
/**
 * walletCheck — the onboarding preflight. Run BEFORE any wallet is
 * created: given a declared wallet type or a signer description, say
 * which execution path exists, in plain terms. Pure and synchronous —
 * no RPC, no chain state — because the answer depends only on what
 * the signer can do, never on balances or records.
 *
 * signer inputs (aliases resolved by normalizeSignerClass):
 *   'local-keypair'      — a Solana keypair file the agent itself holds
 *                          (hook.mjs init, hardware-exported, self-managed)
 *   'sandbox-keypair'    — a keypair the agent holds inside a script
 *                          sandbox (the Bankr pattern: Path B′). Same
 *                          class as local-keypair, plus the persistence
 *                          handshake cautions.
 *   'serialized-tx'      — an external signer that accepts a serialized
 *                          (base64) Solana transaction and returns it
 *                          signed: hardware-wallet bridges, multisig
 *                          services, wallet APIs with a real Solana
 *                          sign endpoint. Aliases include the
 *                          bring-your-own signing-service names
 *                          ('signing-service', 'byo-signer',
 *                          'byo-signing-service', 'signing-api'): any
 *                          service the agent holds its own account
 *                          with, whose credential lives in the agent's
 *                          own platform config — never in AgentOnly
 *                          systems. Path: gateway / kit build →
 *                          external sign → broadcast.
 *   'bankr' | 'bankr-custodial' — Bankr's custodial wallet. Its
 *                          documented signing surface is EVM-only
 *                          (audit §8, re-verified against Bankr's
 *                          2026-10-23 OpenAPI + docs): /wallet/sign
 *                          covers personal_sign / eth_signTypedData_v4
 *                          / eth_signTransaction, /wallet/submit takes
 *                          EVM transaction objects, and its built-in
 *                          Solana swap routes through Jupiter, which
 *                          refuses AgentOnly mints (TOKEN_NOT_TRADABLE).
 *   anything else        — 'unknown': capability unproven; the check
 *                          returns the detection procedure instead of
 *                          a guess.
 *
 * tokenRequiresRegistration (optional, from a launch record's rules):
 *   true  — the target token gates receives on registration (rule 3/17)
 *   false — no registration needed for this token (e.g. LATCH)
 *   null  — no token context given; registration notes are generic.
 */
export function normalizeSignerClass(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (['own', 'local', 'local-keypair', 'keypair', 'keypair-file', 'self-custody', 'self-custodied'].includes(s)) return { signerClass: 'local-keypair', sandbox: false };
  if (['sandbox', 'sandbox-keypair', 'bankr-sandbox', 'path-b-prime', "path-b'"].includes(s)) return { signerClass: 'local-keypair', sandbox: true };
  if (['serialized-tx', 'serialized', 'serialized-tx-signer', 'external-signer', 'hardware', 'hardware-wallet', 'multisig', 'ledger', 'signing-service', 'byo-signer', 'byo-signing-service', 'signing-api'].includes(s)) return { signerClass: 'serialized-tx-signer', sandbox: false };
  if (['bankr', 'bankr-custodial', 'custodial'].includes(s)) return { signerClass: 'bankr-custodial', sandbox: false };
  return { signerClass: 'unknown', sandbox: false };
}

export function walletCheck({ signer = null, walletType = null, wallet = null, tokenRequiresRegistration = null, tokenSymbol = null } = {}) {
  const { signerClass, sandbox } = normalizeSignerClass(signer ?? walletType ?? 'unknown');
  const tokenNote = tokenRequiresRegistration === true
    ? ` This token (${tokenSymbol ?? 'the target token'}) requires Registry registration before a first receive; registration is part of the flow below.`
    : tokenRequiresRegistration === false
      ? ` This token (${tokenSymbol ?? 'the target token'}) does NOT require Agent-Only registration — no register or sync step exists in its flow at all.`
      : '';
  const base = {
    signerClass,
    ...(wallet ? { wallet: typeof wallet === 'string' ? wallet : wallet.toBase58() } : {}),
    ...(tokenRequiresRegistration !== null ? { tokenRequiresRegistration, ...(tokenSymbol ? { tokenSymbol } : {}) } : {}),
    checkedAt: new Date().toISOString(),
  };

  if (signerClass === 'local-keypair' && !sandbox) {
    return {
      ...base,
      canRegister: true, canTrade: true, path: 'direct',
      explanation: 'Your signer is a Solana keypair you control, so it can sign arbitrary Solana transactions locally. hook.mjs signs with it directly; the Trade Kit can also build unsigned transactions for it. No gateway and no second wallet are needed.' + tokenNote,
      nextSteps: [
        'Keep the keypair file mode 600 and out of chat/logs; it IS the wallet.',
        ...(tokenRequiresRegistration ? ['Run eligibility, then build — register + sync are bundled into the first buy transaction automatically.'] : ['Run quote → eligibility → build → simulate, then sign and broadcast the same transaction.']),
      ],
    };
  }
  if (signerClass === 'local-keypair' && sandbox) {
    return {
      ...base,
      canRegister: true, canTrade: true, path: 'direct',
      explanation: 'Your signer is a keypair held inside your script sandbox (Path B′ — a Path A signer whose file lives in the sandbox). It can sign arbitrary Solana transactions, so the full AgentOnly flow works — but the tokens and funds live in THIS sandbox wallet, not in any custodial wallet your platform also gives you.' + tokenNote,
      nextSteps: [
        'Persistence handshake BEFORE funding: generate the keypair once into storage that persists across your sessions, report only its address, then read the address back in a later session — fund only an address that came back identical. A keypair that does not survive session restarts strands everything it holds.',
        'Never print or paste the secret key anywhere; only the public address is ever shared.',
        ...(tokenRequiresRegistration ? ['Run eligibility, then build — register + sync are bundled into the first buy transaction automatically.'] : ['Run quote → eligibility → build → simulate, then sign and broadcast the same transaction.']),
      ],
    };
  }
  if (signerClass === 'serialized-tx-signer') {
    return {
      ...base,
      canRegister: true, canTrade: true, path: 'gateway+external-signer',
      explanation: 'Your signer accepts serialized Solana transactions, so no local keypair file is needed at all: AgentOnly builds the exact unsigned transaction (registration, sync, and the hook-aware swap, bundled), you hand the base64 to your signer, broadcast the signed result, and verify it read-only. This is the Execution Gateway flow (or trade.mjs build locally). It includes bring-your-own signing services — any service that accepts a serialized transaction and returns a signature, where you hold your own account: the service credential lives in your own platform config and is never sent to or stored by AgentOnly, which only ever produces the unsigned transaction.' + tokenNote,
      nextSteps: [
        'Get the unsigned transaction: POST the gateway /v1/trade/build (or /v1/registration/build), or run trade.mjs build — both return transactionBase64 + a manifest of what it does.',
        'Simulate before signing (gateway /v1/trade/simulate): a passed simulation is the strongest pre-flight check; a hook veto is an answer, not an error to retry blindly.',
        'Sign the base64 with your signer, broadcast it yourself, then verify the signature (trade.mjs verify) for confirmation and balance deltas.',
        'Bring-your-own signing service: the composition is build (base64 out) → simulate → your service signs → you broadcast. Keep the service credential in your own platform config; if a so-called signing service ever asks you to upload a raw secret key instead of signing serialized transactions, it is not this class — walk away.',
      ],
    };
  }
  if (signerClass === 'bankr-custodial') {
    return {
      ...base,
      canRegister: false, canTrade: false, path: 'sandbox-hot-wallet',
      explanation: 'A Bankr-custodial wallet cannot execute AgentOnly trades today, and no AgentOnly-side tool can change that: the missing capability is on Bankr\'s side. Bankr\'s documented signing API is EVM-only — POST /wallet/sign covers personal_sign, eth_signTypedData_v4 and eth_signTransaction, and POST /wallet/submit takes an EVM transaction object; there is no endpoint that signs or submits an arbitrary serialized Solana transaction. Registration is a self-signed custom Solana instruction, and a hook-aware DBC swap is a custom Solana transaction — neither can be produced by that API. Bankr\'s built-in Solana swap is not a fallback: it routes through Jupiter, which refuses AgentOnly mints (TOKEN_NOT_TRADABLE). AgentOnly has formally requested this capability from Bankr (arbitrary Solana sign+submit, or native hook-aware DBC routing); until Bankr ships it, the Bankr wallet itself stays unusable for ruled tokens.' + tokenNote,
      nextSteps: [
        'Option 1 (works today): use a signer you control — a keypair in your own script sandbox (the persistence-handshake pattern; see the sandbox-keypair preflight) or any serialized-transaction signer. The position then lives in THAT wallet, not the Bankr wallet.',
        'Option 2 (needs Bankr): ask Bankr to support signing + submitting an arbitrary serialized Solana transaction from the existing Bankr Solana wallet (AgentOnly\'s integration request describes the exact capability and payloads).',
        'Do NOT export or hand over any wallet\'s secret key to work around this — no legitimate flow needs it.',
      ],
      evidence: {
        signEndpoint: 'POST /wallet/sign — signatureType enum [personal_sign, eth_signTypedData_v4, eth_signTransaction] (OpenAPI, docs.bankr.bot/openapi/api.yaml, fetched 2026-10-23)',
        submitEndpoint: 'POST /wallet/submit — transaction is an EvmTransaction object {to, chainId, value, data, …}',
        solanaSwapVenue: 'Bankr docs (Wallet API — Swap / Routing): "Solana swaps route through Jupiter"; Jupiter refuses AgentOnly mints with TOKEN_NOT_TRADABLE',
        token2022MentionsInDocs: 0,
      },
    };
  }
  return {
    ...base,
    canRegister: false, canTrade: false, path: 'sandbox-hot-wallet',
    explanation: 'Signer capability unproven — do not create a wallet or move funds on an assumption. Whether this signer can execute AgentOnly trades depends on ONE testable fact: can it sign an arbitrary serialized Solana transaction (not just its platform\'s built-in swaps)? If yes, it is a serialized-tx signer and the gateway path works. If it can only sign through a fixed API menu of built-in actions, it cannot register or trade ruled tokens, and the working fallback is a keypair you control (sandbox or local).' + tokenNote,
    nextSteps: [
      'Detection test: have the signer sign a harmless serialized Solana transaction (or an ed25519 message, for the attestation flow). Success → treat it as serialized-tx and re-run this check with --signer serialized-tx.',
      'If the platform documents its signing API, check the signature types: an EVM-only list (personal_sign / eth_signTypedData_v4 / eth_signTransaction) means NOT supported for Solana, however the platform markets its Solana wallet.',
      'Until the class is known, do not run hook.mjs init as a shortcut without reading its notice: a fresh local keypair is a new wallet, with its own custody duties.',
    ],
  };
}

#!/usr/bin/env node
// doors.mjs — Hook Launcher DOORS: venue resolution + house-venue swap
// instruction building (Phase C, contract PHASE-C-CONTRACT §3.3).
//
// A "door" is a trading surface for a launched token. Until Phase C there
// was exactly one: the Meteora DBC curve. A house-committed token gains a
// second door — its own house pool (the houseswap program) — and the
// door choice is made from the token's LIVE engine Config bytes, never
// from the launch record alone:
//
//   resolveVenue(record, configBytes):
//     house slot present (Config V2 region, 1152 B) && house_state == 2
//       → { venue: 'house' } — doors default to the house pool;
//         the curve stays reachable as the legacy door.
//     otherwise → { venue: 'curve' } — including house-PENDING tokens
//       (state 1): they still trade only on the curve, and the result
//       carries threshold progress for status surfaces.
//
// This module is a LIBRARY (hook.mjs imports it). The swap builder comes
// in two halves, mirroring hook.mjs's own split of concerns:
//   buildHouseSwapKeys(params) — PURE: the exact account list for the
//     houseswap Swap instruction (contract §2.2 order), given a resolved
//     hook tail. Exercised offline by trial-house.mjs.
//   buildHouseSwapIx(conn, params) — resolves the hook tail from the
//     mint's published meta list through spl-token's generic resolver
//     (the same createTransferCheckedWithTransferHookInstruction path
//     hook.mjs's hookExtras uses: keys after the transfer's first 4 are
//     [...extras in meta-list order, hook program, meta list account]),
//     then delegates to buildHouseSwapKeys.
//
// Swap account order (contract §2.2, TaxSwap shape):
//   [pool, token_mint, quote_mint, token_vault(w), quote_vault(w),
//    user_token(w), user_quote(w), user(signer), token_prog, quote_prog,
//    HOOK TAIL (resolved extras…, hook program, meta list),
//    VENUE EXTRAS: escrow_pda?(w), price_feed?, seller_holder?,
//                  fee_dest_token?(w), fee_dest_quote?(w)]
// Venue-extra presence (contract §2.3): rule 2 in the stack →
//   buy:  escrow_pda REQUIRED.
//   sell: escrow_pda + price_feed + seller_holder REQUIRED (clients pass
//         the derived escrow PDA regardless; a nonexistent escrow is
//         zero escrow on-chain and resolution is skipped).
// Data: [1][dir u8][amount_in u64][min_out u64] — dir 0 = buy, 1 = sell
// (TaxSwap's Swap encoding; houseswap keeps it byte-identical).
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createTransferCheckedWithTransferHookInstruction,
} from '@solana/spl-token';

export const T22 = TOKEN_2022_PROGRAM_ID;
export const LEGACY_TOKEN = TOKEN_PROGRAM_ID;
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Config house region (contract §1.1): present only on 1152-byte configs.
export const CONFIG_SPACE_V2 = 1152;
export const HOUSE_OFF = 1088; // program @1088..1120, threshold @1120..1128,
// reserve @1128..1136, activated_ts @1136..1144, state @1144.
export const DBC_POOL_OFF_QUOTE_RESERVE = 240; // DBC pool account layout

const K = (pubkey, w = false, s = false) => ({ pubkey, isSigner: !!s, isWritable: !!w });

/**
 * Parse the house slot out of raw engine Config account bytes.
 * @param {Buffer|Uint8Array} configBytes
 * @returns {null | { program: PublicKey, thresholdLamports: bigint,
 *   reserveLamports: bigint, activatedTs: bigint, state: number }}
 *   null when the config predates the V2 region or carries no commitment
 *   (house_state == 0). Mirrors the engine's load_config rule:
 *   Some iff data_len >= CONFIG_SPACE_V2 && house_state != 0.
 */
export function parseHouseSlot(configBytes) {
  if (!configBytes || configBytes.length < CONFIG_SPACE_V2) return null;
  const d = Buffer.from(configBytes);
  const state = d[HOUSE_OFF + 56];
  if (state === 0) return null;
  return {
    program: new PublicKey(d.subarray(HOUSE_OFF, HOUSE_OFF + 32)),
    thresholdLamports: d.readBigUInt64LE(HOUSE_OFF + 32),
    reserveLamports: d.readBigUInt64LE(HOUSE_OFF + 40),
    activatedTs: d.readBigInt64LE(HOUSE_OFF + 48),
    state,
  };
}

/** Does this launch record's rule stack enable rule 2 (Escrow Split)? */
export function recordHasRule2(record) {
  return (record?.rules ?? []).some((r) => r.id === 2 && r.enabled !== false);
}

/**
 * Which door trades this token right now?
 * @param {object} record launch record (addresses/programs/rules)
 * @param {Buffer|Uint8Array} configBytes LIVE engine Config account data
 * @param {Buffer|Uint8Array} [dbcPoolBytes] live DBC pool account data —
 *   only used to report threshold progress for house-pending tokens
 *   (quote_reserve u64 @240 vs the slot threshold).
 * @returns {{ venue: 'curve'|'house', reason: string, slot: object|null,
 *   progress?: { quoteReserveLamports: bigint, thresholdLamports: bigint } }}
 */
export function resolveVenue(record, configBytes, dbcPoolBytes = null) {
  const slot = parseHouseSlot(configBytes);
  if (!slot) return { venue: 'curve', reason: 'no house commitment in the engine config — the curve is the only door', slot: null };
  if (slot.state === 2) return { venue: 'house', reason: `house venue activated at ts ${slot.activatedTs} — doors default to the house pool; the curve stays as the legacy door`, slot };
  const out = { venue: 'curve', reason: `house committed but not yet activated (state ${slot.state}) — the curve is still the only door`, slot };
  if (dbcPoolBytes && dbcPoolBytes.length >= DBC_POOL_OFF_QUOTE_RESERVE + 8) {
    out.progress = {
      quoteReserveLamports: Buffer.from(dbcPoolBytes).readBigUInt64LE(DBC_POOL_OFF_QUOTE_RESERVE),
      thresholdLamports: slot.thresholdLamports,
    };
  }
  return out;
}

// ---------- PDAs ----------
export const housePoolPda = (houseProgram, mint) =>
  PublicKey.findProgramAddressSync([Buffer.from('pool'), mint.toBuffer()], houseProgram)[0];
export const houseEscrowPda = (houseProgram, mint, userTokenAccount) =>
  PublicKey.findProgramAddressSync([Buffer.from('escrow'), mint.toBuffer(), userTokenAccount.toBuffer()], houseProgram)[0];
export const enginePda = (engineProgram, seeds) => PublicKey.findProgramAddressSync(seeds, engineProgram)[0];

/**
 * Resolve the hook tail for a token-leg transfer through the mint's
 * published meta list — the generic SPL resolver, exactly the path
 * hook.mjs's hookExtras uses (keys after the transfer's first 4:
 * [...extras in meta-list order, hook program, meta list account]).
 * The venue forwards this tail verbatim, in order, into its swap.
 */
export async function resolveHookTail(conn, { mint, source, dest, authority, amountRaw, decimals }) {
  const ix = await createTransferCheckedWithTransferHookInstruction(
    conn, source, mint, dest, authority, BigInt(amountRaw), decimals, [], 'confirmed', T22);
  return ix.keys.slice(4).map((k) => K(k.pubkey, k.isWritable, false));
}

/**
 * PURE: the houseswap Swap instruction's account list + data, in
 * contract §2.2 order. `tail` is the resolved hook tail (see
 * resolveHookTail). Rule-2 venue extras are appended per §2.3 when
 * `rule2` is set; fee-dest accounts are appended (in the §2.3 order)
 * only when the caller supplies them.
 */
export function buildHouseSwapKeys({
  houseProgram, mint, pool, tokenVault, quoteVault, user, userToken, userQuote,
  dir, amountIn, minOut = 0n, tail = [], rule2 = false,
  engineProgram = null, feeDestToken = null, feeDestQuote = null,
}) {
  if (dir !== 0 && dir !== 1) throw new Error(`house swap dir must be 0 (buy) or 1 (sell), got ${dir}`);
  const keys = [
    K(pool, true), K(mint), K(NATIVE_MINT),
    K(tokenVault, true), K(quoteVault, true),
    K(userToken, true), K(userQuote, true),
    K(user, true, true),
    K(T22), K(LEGACY_TOKEN),
    ...tail,
  ];
  if (rule2) {
    if (!engineProgram) throw new Error('rule 2 house swap requires the engine program id (escrow/feed/holder extras derive from it)');
    keys.push(K(houseEscrowPda(houseProgram, mint, userToken), true));
    if (dir === 1) {
      keys.push(K(enginePda(engineProgram, [Buffer.from('price'), mint.toBuffer()])));
      // Engine v3 holder records key by TOKEN ACCOUNT (the user's ATA).
      keys.push(K(enginePda(engineProgram, [Buffer.from('holder'), mint.toBuffer(), userToken.toBuffer()])));
    }
  }
  if (feeDestToken) keys.push(K(feeDestToken, true));
  if (feeDestQuote) keys.push(K(feeDestQuote, true));
  const data = Buffer.alloc(18);
  data[0] = 1; data[1] = dir;
  data.writeBigUInt64LE(BigInt(amountIn), 2);
  data.writeBigUInt64LE(BigInt(minOut), 10);
  return { keys, data };
}

/**
 * Build the houseswap Swap instruction for a live trade, resolving the
 * hook tail from the mint's meta list. The token leg decides the tail's
 * resolution direction: buy → vault→user (authority = pool PDA);
 * sell → user→vault (authority = user).
 */
export async function buildHouseSwapIx(conn, {
  record, slot, isBuy, user, amountInRaw, minOutRaw = 0n, feeDestToken = null, feeDestQuote = null,
}) {
  const mint = new PublicKey(record.addresses.mint);
  const engineProgram = new PublicKey(record.programs.engine);
  const houseProgram = slot?.program ?? (record.house?.program ? new PublicKey(record.house.program) : null);
  if (!houseProgram) throw new Error('buildHouseSwapIx: no house program known (config slot and record.house both absent)');
  const pool = housePoolPda(houseProgram, mint);
  // The vaults are the pool PDA's canonical ATAs by construction (H1).
  const tokenVault = getAssociatedTokenAddressSync(mint, pool, true, T22);
  const quoteVault = getAssociatedTokenAddressSync(NATIVE_MINT, pool, true, LEGACY_TOKEN);
  const userToken = getAssociatedTokenAddressSync(mint, user, false, T22);
  const userQuote = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, LEGACY_TOKEN);
  const decimals = record.decimals ?? 6;
  const tail = await resolveHookTail(conn, isBuy
    ? { mint, source: tokenVault, dest: userToken, authority: pool, amountRaw: amountInRaw, decimals }
    : { mint, source: userToken, dest: tokenVault, authority: user, amountRaw: amountInRaw, decimals });
  const { keys, data } = buildHouseSwapKeys({
    houseProgram, mint, pool, tokenVault, quoteVault, user, userToken, userQuote,
    dir: isBuy ? 0 : 1, amountIn: amountInRaw, minOut: minOutRaw, tail,
    rule2: recordHasRule2(record), engineProgram, feeDestToken, feeDestQuote,
  });
  return new TransactionInstruction({ programId: houseProgram, keys, data });
}

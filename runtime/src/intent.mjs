// intent.mjs — transaction intent derivation + validation (issue #4, P0-1).
//
// The approval fingerprint proves the transaction BYTES did not change.
// It does not prove the bytes do what the card's friendly fields claim.
// This module closes that gap: it decodes a transaction (legacy or
// versioned, resolving address lookup tables), normalizes what the
// transaction actually does, and validates that reality against the
// request, the gateway build, and the token's canonical record — at
// prepare time AND again at send time (re-derived from the card's bytes
// and deep-compared with the intent stored on the card).

import bs58 from 'bs58';
import {
  Message,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';

export class IntentError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Program allowlist
// ---------------------------------------------------------------------------

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
// Wrapped SOL — the mint real venue builds wrap the trade's SOL into
// (and unwrap out of) around the swap. The wallet's own WSOL ATA is
// part of the approved trade shape (repair round 2.1).
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const MEMO_PROGRAM_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

// AgentOnly platform programs — the ids the Trade Kit builds against,
// from the launch records the kit loads (gateway/records/*.json,
// `programs` + `house.program`; identical across every live token).
export const PLATFORM_PROGRAMS = {
  engine: 'EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT',
  registry: 'GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e',
  distributor: 'DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa',
  dbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  house: '8aeCfKabRfbXrLY68CXbsgp3x7mgikjwgMF3d7oY1Y8h',
};

export const ALLOWED_PROGRAMS = new Set([
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ATA_PROGRAM,
  MEMO_PROGRAM,
  MEMO_PROGRAM_V1,
  ...Object.values(PLATFORM_PROGRAMS),
]);

const VENUE_PROGRAM_BY_VENUE = {
  curve: PLATFORM_PROGRAMS.dbc,
  house: PLATFORM_PROGRAMS.house,
};

// ---------------------------------------------------------------------------
// Strict decimal amounts (P1-d)
// ---------------------------------------------------------------------------

const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

// Parses a UI-unit decimal string into raw base units. No exponent, no
// hex, no sign, no NaN/Infinity spellings, no empty fraction games: the
// string must be a plain non-negative decimal with at most maxDecimals
// fractional digits. Returns { ui, raw (BigInt), decimals }.
export function parseStrictDecimal(value, maxDecimals, code = 'INVALID_AMOUNT') {
  const s = typeof value === 'string' ? value : String(value ?? '');
  if (!DECIMAL_RE.test(s)) {
    throw new IntentError(
      code,
      `amount '${value}' is not a plain decimal — exponent/hex/sign/blank forms are refused; pass e.g. 0.05`,
      { value: s },
    );
  }
  const [intPart, fracPart = ''] = s.split('.');
  if (fracPart.length > maxDecimals) {
    throw new IntentError(
      code,
      `amount '${s}' has ${fracPart.length} decimal places; this unit allows at most ${maxDecimals}`,
      { value: s, maxDecimals },
    );
  }
  const scale = 10n ** BigInt(maxDecimals);
  const raw = BigInt(intPart) * scale + BigInt(fracPart.padEnd(maxDecimals, '0') || '0');
  if (!Number.isFinite(Number(s))) {
    throw new IntentError(code, `amount '${s}' is not finite`, { value: s });
  }
  return { ui: s, raw, decimals: maxDecimals };
}

// ---------------------------------------------------------------------------
// Instruction kind summaries (human-readable, never load-bearing)
// ---------------------------------------------------------------------------

function kindSummary(programId, tag) {
  switch (programId) {
    case SYSTEM_PROGRAM:
      return { 0: 'system: create account', 1: 'system: create account with seed', 2: 'system: transfer SOL', 3: 'system: advance nonce', 8: 'system: assign account owner' }[tag] ?? `system instruction (tag ${tag})`;
    case COMPUTE_BUDGET_PROGRAM:
      return { 0: 'compute budget: request units (deprecated)', 1: 'compute budget: request heap frame', 2: 'compute budget: set unit limit', 3: 'compute budget: SET UNIT PRICE' }[tag] ?? `compute budget instruction (tag ${tag})`;
    case TOKEN_PROGRAM:
    case TOKEN_2022_PROGRAM: {
      const name = programId === TOKEN_PROGRAM ? 'SPL Token' : 'Token-2022';
      return {
        1: `${name}: initialize account`, 3: `${name}: transfer`, 4: `${name}: APPROVE (delegation)`,
        5: `${name}: revoke delegation`, 6: `${name}: SET AUTHORITY`, 7: `${name}: mint to`,
        8: `${name}: burn`, 9: `${name}: close account`, 12: `${name}: transfer (checked)`,
        13: `${name}: APPROVE CHECKED (delegation)`, 16: `${name}: amount to UI amount`,
        17: `${name}: sync native (wrapped SOL)`,
        22: `${name}: transfer fee extension`,
      }[tag] ?? `${name} instruction (tag ${tag})`;
    }
    case ATA_PROGRAM:
      return 'associated token account: create';
    case MEMO_PROGRAM:
    case MEMO_PROGRAM_V1:
      return 'memo';
    case PLATFORM_PROGRAMS.dbc:
      return 'venue swap — Meteora DBC (AgentOnly curve)';
    case PLATFORM_PROGRAMS.house:
      return 'venue swap — AgentOnly HouseSwap';
    case PLATFORM_PROGRAMS.engine:
      return 'AgentOnly hook engine (transfer-hook / rule enforcement)';
    case PLATFORM_PROGRAMS.registry:
      return 'AgentOnly Registry (register / sync)';
    case PLATFORM_PROGRAMS.distributor:
      return 'AgentOnly fee distributor (settle)';
    default:
      return `instruction on program ${programId.slice(0, 8)}…`;
  }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function readShortvecLength(bytes, offset) {
  let len = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const b = bytes[i++];
    len |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [len, i];
}

// Raw message bytes of a serialized legacy transaction (everything after
// the signature block). Used for byte-exact comparisons.
export function legacyMessageBytes(bytes) {
  const [count, afterCount] = readShortvecLength(bytes, 0);
  return Buffer.from(bytes.subarray(afterCount + count * 64));
}

// Where the message starts in a serialized transaction, and whether the
// transaction is versioned. A serialized transaction begins with a
// signature-count SHORTVEC followed by count×64 signature bytes; the
// version flag is the top bit of the first MESSAGE byte after that
// block — NOT byte 0 of the blob (byte 0 is the shortvec, whose top bit
// only means "the count continues", e.g. ≥128 signatures). Sniffing
// byte 0 misdetects real v0 transactions (repair round 2, P1-f).
export function serializedTxKind(bytes) {
  const [count, afterCount] = readShortvecLength(bytes, 0);
  const messageStart = afterCount + count * 64;
  if (messageStart >= bytes.length) {
    throw new IntentError('INTENT_DECODE_FAILED', 'serialized transaction is truncated: no message after the signature block');
  }
  return { versioned: (bytes[messageStart] & 0x80) !== 0, messageStart, signatureCount: count };
}

// ---------------------------------------------------------------------------
// Trade account sets (canonical pool + derived token accounts)
// ---------------------------------------------------------------------------

export function associatedTokenAddress(mint, owner, tokenProgram) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new PublicKey(tokenProgram).toBuffer(), mint.toBuffer()],
    new PublicKey(ATA_PROGRAM),
  )[0];
}

// Every pool address the canonical record names: the top-level `pool`,
// `addresses.pool`, and house/curve variants where a record carries
// them. A record may name several (e.g. before/after graduation).
export function canonicalPools(tokenJson) {
  const pools = new Set();
  const add = (v) => { if (typeof v === 'string' && v) pools.add(v); };
  add(tokenJson?.pool);
  const a = tokenJson?.addresses ?? {};
  add(a.pool);
  add(a.housePool);
  add(a.curvePool);
  return [...pools];
}

// Extra pool-side vault accounts a canonical record may name explicitly
// (SOL vault / token vault of the pool). Derived pool ATAs are computed
// separately in tradeAccountSets.
export function canonicalPoolVaults(tokenJson) {
  const a = tokenJson?.addresses ?? {};
  const vaults = new Set();
  for (const k of ['quoteVault', 'solVault', 'tokenVault', 'baseVault', 'vault']) {
    if (typeof a[k] === 'string' && a[k]) vaults.add(a[k]);
  }
  return [...vaults];
}

// The account sets the trade is allowed to touch, derived from the card
// context + canonical record:
//  - walletAtas: the wallet's token accounts for the card mint (both
//    token programs);
//  - wsolAta: the wallet's own associated token account for wrapped
//    SOL (legacy token program). Real venue builds wrap the trade SOL
//    into it and unwrap out of it around the swap; its lamports ARE
//    the wallet's SOL, so full-effect accounting folds its lamport
//    delta into the wallet's aggregate SOL delta (repair round 2.1);
//  - pools / poolAccounts: canonical pool addresses, their derived
//    token vaults (ATAs of the pool for the card mint, both programs),
//    and any vaults the record names explicitly;
//  - permitted: wallet + walletAtas + wsolAta + poolAccounts — the
//    ONLY accounts whose lamport/token balances may change in the
//    trade (full-effect accounting at send time enforces this).
export function tradeAccountSets({ wallet, mint, tokenJson }) {
  const owner = new PublicKey(wallet);
  const mintPk = new PublicKey(mint);
  const walletAtas = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]
    .map((tp) => associatedTokenAddress(mintPk, owner, tp).toBase58());
  const wsolAta = associatedTokenAddress(new PublicKey(WSOL_MINT), owner, TOKEN_PROGRAM).toBase58();
  const pools = canonicalPools(tokenJson);
  const poolAccounts = new Set(pools);
  for (const p of pools) {
    const poolPk = new PublicKey(p);
    for (const tp of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      poolAccounts.add(associatedTokenAddress(mintPk, poolPk, tp).toBase58());
    }
  }
  for (const v of canonicalPoolVaults(tokenJson)) poolAccounts.add(v);
  const permitted = new Set([wallet, ...walletAtas, wsolAta, ...poolAccounts]);
  return { walletAtas, wsolAta, pools, poolAccounts: [...poolAccounts], permitted };
}

function isWritableIndex(header, accountCount, i) {
  if (i < header.numRequiredSignatures) {
    return i < header.numRequiredSignatures - header.numReadonlySignedAccounts;
  }
  return i < accountCount - header.numReadonlyUnsignedAccounts;
}

function normalizeInstructions(compiled, keys, dataOf) {
  return compiled.map((ix) => {
    const programId = keys[ix.programIdIndex]?.toBase58() ?? 'unknown';
    const data = dataOf(ix);
    const tag = data && data.length ? data[0] : null;
    const accounts = (ix.accounts ?? ix.accountKeyIndexes ?? []).map((ai) => keys[ai]?.toBase58() ?? 'unknown');
    const writableAccounts = (ix.accounts ?? ix.accountKeyIndexes ?? [])
      .filter((ai) => ix._writable?.has(ai))
      .map((ai) => keys[ai]?.toBase58() ?? 'unknown');
    const out = { programId, kind: kindSummary(programId, tag), tag, accounts, writableAccounts };
    // Parsed transfer payloads — JSON-safe strings only, so the intent
    // survives the approval-card file round-trip and the send-time
    // deep-compare still binds these exact values.
    if (programId === SYSTEM_PROGRAM && tag === 2 && data && data.length >= 12 && accounts.length >= 2) {
      // System Transfer: u32 LE tag, u64 LE lamports; accounts [from, to]
      out.transfer = {
        from: accounts[0],
        to: accounts[1],
        lamports: Buffer.from(data).readBigUInt64LE(4).toString(),
      };
    }
    if ((programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) && data && data.length >= 9) {
      if (tag === 3 && accounts.length >= 2) {
        // Transfer: u64 LE amount at offset 1; accounts [source, dest, owner]
        out.tokenTransfer = {
          source: accounts[0],
          destination: accounts[1],
          amount: Buffer.from(data).readBigUInt64LE(1).toString(),
        };
      } else if (tag === 12 && accounts.length >= 3) {
        // TransferChecked: u64 LE amount at offset 1; accounts [source, mint, dest, owner]
        out.tokenTransfer = {
          source: accounts[0],
          mint: accounts[1],
          destination: accounts[2],
          amount: Buffer.from(data).readBigUInt64LE(1).toString(),
        };
      }
    }
    return out;
  });
}

function finalizeIntent(partial) {
  const all = new Set();
  const writable = new Set();
  for (const ix of partial.instructions) {
    for (const a of ix.accounts) all.add(a);
    for (const a of ix.writableAccounts) writable.add(a);
  }
  all.add(partial.feePayer);
  return {
    version: partial.version,
    feePayer: partial.feePayer,
    requiredSigners: partial.requiredSigners,
    instructions: partial.instructions,
    writableAccounts: [...writable].sort(),
    allAccounts: [...all].sort(),
    recentBlockhash: partial.recentBlockhash,
    programs: [...new Set(partial.instructions.map((i) => i.programId))].sort(),
  };
}

function decodeLegacy(bytes) {
  const msgBytes = legacyMessageBytes(bytes);
  const msg = Message.from(msgBytes);
  const keys = msg.accountKeys;
  const header = msg.header;
  const writableIdx = new Set();
  keys.forEach((_, i) => { if (isWritableIndex(header, keys.length, i)) writableIdx.add(i); });
  const compiled = msg.instructions.map((ix) => ({ ...ix, _writable: writableIdx }));
  const instructions = normalizeInstructions(compiled, keys, (ix) => bs58.decode(ix.data));
  return finalizeIntent({
    version: 'legacy',
    feePayer: keys[0].toBase58(),
    requiredSigners: keys.slice(0, header.numRequiredSignatures).map((k) => k.toBase58()),
    instructions,
    recentBlockhash: msg.recentBlockhash,
  });
}

async function decodeVersioned(bytes, connection) {
  const vtx = VersionedTransaction.deserialize(bytes);
  const msg = vtx.message;
  const keys = [...msg.staticAccountKeys];
  const writableIdx = new Set();
  msg.staticAccountKeys.forEach((_, i) => {
    if (isWritableIndex(msg.header, msg.staticAccountKeys.length + totalLookupCount(msg), i)) writableIdx.add(i);
  });
  // Resolve lookup tables in order: per table, writable then readonly
  // addresses append after the static keys.
  let cursor = msg.staticAccountKeys.length;
  for (const lookup of msg.addressTableLookups ?? []) {
    if (!connection || typeof connection.getAddressLookupTable !== 'function') {
      throw new IntentError(
        'INTENT_ALT_UNRESOLVED',
        `transaction uses address lookup table ${lookup.accountKey.toBase58()} but no connection was supplied to resolve it`,
      );
    }
    const { value } = await connection.getAddressLookupTable(lookup.accountKey);
    if (!value) {
      throw new IntentError('INTENT_ALT_UNRESOLVED', `address lookup table ${lookup.accountKey.toBase58()} could not be fetched`);
    }
    const addresses = value.state.addresses;
    for (const ai of lookup.writableIndexes) { keys.push(addresses[ai]); writableIdx.add(cursor++); }
    for (const ai of lookup.readonlyIndexes) { keys.push(addresses[ai]); cursor++; }
  }
  const compiled = msg.compiledInstructions.map((ix) => ({ ...ix, _writable: writableIdx }));
  const instructions = normalizeInstructions(compiled, keys, (ix) => Buffer.from(ix.data));
  return finalizeIntent({
    version: '0',
    feePayer: keys[0].toBase58(),
    requiredSigners: keys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58()),
    instructions,
    recentBlockhash: msg.recentBlockhash,
  });
}

function totalLookupCount(msg) {
  return (msg.addressTableLookups ?? []).reduce(
    (n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0,
  );
}

// Decodes a serialized transaction (base64 string or bytes) into the
// normalized intent. `connection` is required only when a versioned
// transaction actually carries address lookup tables.
export async function deriveIntent(input, connection) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'base64');
  try {
    if (serializedTxKind(bytes).versioned) return await decodeVersioned(bytes, connection);
    return decodeLegacy(bytes);
  } catch (e) {
    if (e instanceof IntentError) throw e;
    throw new IntentError('INTENT_DECODE_FAILED', `transaction bytes could not be decoded: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Instruction classification (repair round 2, P0-1b)
//
// Program allowlisting alone is NOT semantic validation: a build could
// pass the allowlist while bundling an extra System transfer to a
// stranger next to a legitimate swap. So every decoded instruction
// must additionally CLASSIFY into the exact approved trade shape.
// Anything that cannot be classified refuses with
// UNCLASSIFIED_INSTRUCTION. (The blanket bans — non-allowlisted
// programs, SetComputeUnitPrice, Approve/SetAuthority — keep their own
// codes and fire before classification.)
// ---------------------------------------------------------------------------

function unclassified(ix, why) {
  return new IntentError(
    'UNCLASSIFIED_INSTRUCTION',
    `decoded instruction cannot be classified into the approved trade shape: ${ix.kind} [${ix.programId}] — ${why}. Refusing.`,
    { programId: ix.programId, kind: ix.kind },
  );
}

// ctx: { wallet, mint, side, venueProgram, sets (tradeAccountSets) }
function classifyInstruction(ix, ctx) {
  const { wallet, mint, side, venueProgram, sets } = ctx;
  const pid = ix.programId;

  if (pid === COMPUTE_BUDGET_PROGRAM) {
    // SetComputeUnitPrice (tag 3) is already rejected above; only the
    // limit / heap-frame settings are part of a trade.
    if (ix.tag === 1 || ix.tag === 2) return 'compute';
    throw unclassified(ix, 'only SetComputeUnitLimit / RequestHeapFrame belong to a trade');
  }
  if (pid === MEMO_PROGRAM || pid === MEMO_PROGRAM_V1) return 'memo';
  if (pid === PLATFORM_PROGRAMS.engine || pid === PLATFORM_PROGRAMS.registry || pid === PLATFORM_PROGRAMS.distributor) {
    return 'platform';
  }
  if (pid === PLATFORM_PROGRAMS.dbc || pid === PLATFORM_PROGRAMS.house) {
    if (!venueProgram || pid === venueProgram) return 'venue-swap';
    throw unclassified(ix, 'instruction runs on a venue program that is not the quoted venue');
  }
  if (pid === ATA_PROGRAM) {
    // CreateAssociatedTokenAccount (incl. CreateIdempotent) accounts:
    // [funder, ata, owner, mint, system program, token program]
    // Belongs to the trade in exactly two shapes: the wallet's own
    // account for the card mint, or the wallet's own wrapped-SOL
    // account (real venue builds create it before wrapping). The
    // created address must be the true derived ATA for the
    // instruction's token program — a lookalike address refuses.
    const [funder, ata, owner, mintAcct, , tokenProgram] = ix.accounts;
    let expectedAta = null;
    try {
      if (owner && mintAcct && tokenProgram) {
        expectedAta = associatedTokenAddress(new PublicKey(mintAcct), new PublicKey(owner), tokenProgram).toBase58();
      }
    } catch { expectedAta = null; }
    if (funder === wallet && owner === wallet && ata === expectedAta && mintAcct === mint) return 'ata-create';
    if (funder === wallet && owner === wallet && ata === expectedAta && mintAcct === WSOL_MINT) return 'wsol-ata-create';
    throw unclassified(ix, 'an ATA creation belongs to the trade only when it creates the wallet\u2019s own account for the card mint or for wrapped SOL, at its true derived address');
  }
  if (pid === SYSTEM_PROGRAM) {
    if (ix.tag === 2 && ix.transfer) {
      const { from, to } = ix.transfer;
      if (side === 'buy' && from === wallet && sets.pools.includes(to)) return 'trade-transfer';
      if (side === 'sell' && sets.pools.includes(from) && to === wallet) return 'trade-transfer';
      // The wrap leg: the wallet funds its OWN derived wrapped-SOL
      // account (either side — a sell build may wrap around the swap
      // too). No other System destination is admitted.
      if (from === wallet && to === sets.wsolAta) return 'wsol-wrap';
      throw unclassified(ix, `a System transfer ${from} \u2192 ${to} is not the trade\u2019s wallet\u2194pool leg or the wallet\u2019s own wrapped-SOL wrap`);
    }
    throw unclassified(ix, 'only a wallet\u2194pool SOL transfer or the wallet\u2019s own wrapped-SOL wrap belongs to a trade');
  }
  if (pid === TOKEN_PROGRAM || pid === TOKEN_2022_PROGRAM) {
    // SyncNative (tag 17): syncs a native (wrapped-SOL) account's
    // token balance to its lamports. Belongs to the trade ONLY as the
    // wrap step on the wallet's own WSOL ATA — sole account, nothing
    // else.
    if (ix.tag === 17) {
      if (ix.accounts.length === 1 && ix.accounts[0] === sets.wsolAta) return 'wsol-sync';
      throw unclassified(ix, 'a SyncNative belongs to the trade only on the wallet\u2019s own wrapped-SOL account, as its sole account');
    }
    // CloseAccount (tag 9): accounts [account, destination, owner].
    // Belongs to the trade ONLY as the unwrap: closing the wallet's
    // own WSOL ATA with the lamports returning to the wallet itself.
    // Closing the card-mint ATA (or anything else) stays refused.
    if (ix.tag === 9) {
      const [acct, dest, owner] = ix.accounts;
      if (acct === sets.wsolAta && dest === wallet && owner === wallet) return 'wsol-close';
      throw unclassified(ix, 'closing an account belongs to the trade only when it unwraps the wallet\u2019s own wrapped-SOL account back to the wallet');
    }
    if ((ix.tag === 3 || ix.tag === 12) && ix.tokenTransfer) {
      const t = ix.tokenTransfer;
      if (t.mint && t.mint !== mint) {
        throw unclassified(ix, `token instruction touches mint ${t.mint}, not the card mint ${mint}`);
      }
      const srcWallet = sets.walletAtas.includes(t.source);
      const dstWallet = sets.walletAtas.includes(t.destination);
      const srcPool = sets.poolAccounts.includes(t.source);
      const dstPool = sets.poolAccounts.includes(t.destination);
      if ((srcWallet && dstPool) || (srcPool && dstWallet)) return 'trade-transfer';
      throw unclassified(ix, `a token transfer ${t.source} \u2192 ${t.destination} is not between the wallet\u2019s account for the card mint and the pool vault`);
    }
    throw unclassified(ix, 'only Transfer/TransferChecked between the wallet and the pool vault belong to a trade');
  }
  throw unclassified(ix, 'no classification rule covers this program in a trade');
}

// Validates a derived intent against the trade context. ctx:
// { wallet, mint, side, venue ('curve'|'house'|null), tokenJson (canonical
// token record — its `pool` is checked when the venue is the curve) }.
// Returns { venueProgram } on success; throws IntentError otherwise.
export function validateIntent(intent, ctx) {
  const { wallet, mint, venue } = ctx;

  if (intent.feePayer !== wallet) {
    throw new IntentError(
      'INTENT_FEE_PAYER_MISMATCH',
      `decoded fee payer ${intent.feePayer} is not the selected wallet ${wallet} — refusing`,
      { feePayer: intent.feePayer, wallet },
    );
  }
  if (intent.requiredSigners.length !== 1 || intent.requiredSigners[0] !== wallet) {
    throw new IntentError(
      'INTENT_SIGNERS_MISMATCH',
      `decoded required signers are [${intent.requiredSigners.join(', ')}] — the only acceptable signer set is the selected wallet alone (${wallet}). A build that needs another signature is not signable here and is refused.`,
      { requiredSigners: intent.requiredSigners },
    );
  }

  for (const ix of intent.instructions) {
    if (!ALLOWED_PROGRAMS.has(ix.programId)) {
      throw new IntentError(
        'INTENT_PROGRAM_NOT_ALLOWED',
        `decoded instruction runs a program outside the allowlist: ${ix.programId} (${ix.kind}). Refusing — the build does not match the AgentOnly trade shape.`,
        { programId: ix.programId },
      );
    }
    if (ix.programId === COMPUTE_BUDGET_PROGRAM && ix.tag === 3) {
      throw new IntentError(
        'INTENT_COMPUTE_PRICE_REJECTED',
        'decoded transaction contains a SetComputeUnitPrice instruction — a priority-fee market bid the owner never approved. Refusing.',
      );
    }
    if ((ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM)
        && (ix.tag === 4 || ix.tag === 13 || ix.tag === 6)) {
      throw new IntentError(
        'INTENT_DELEGATION_REJECTED',
        `decoded transaction contains a token delegation instruction (${ix.kind}) — Approve/ApproveChecked/SetAuthority are never part of an AgentOnly trade. Refusing.`,
        { kind: ix.kind },
      );
    }
  }

  // The trade must actually involve the mint: as an account of the venue
  // instruction or a token-program / hook-engine instruction.
  const mintInvolved = intent.instructions.some(
    (ix) => ix.accounts.includes(mint)
      && (ix.programId === PLATFORM_PROGRAMS.dbc || ix.programId === PLATFORM_PROGRAMS.house
        || ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM
        || ix.programId === PLATFORM_PROGRAMS.engine),
  );
  if (!mintInvolved) {
    throw new IntentError(
      'INTENT_MINT_MISMATCH',
      `decoded instructions do not involve the requested mint ${mint} on any venue/token instruction — the build is for something else. Refusing.`,
      { mint },
    );
  }

  let venueProgram = null;
  if (venue) venueProgram = VENUE_PROGRAM_BY_VENUE[venue] ?? null;

  // P0-1b: EVERY instruction must classify into the approved trade
  // shape. This is what stops a bundled extra transfer riding along
  // with a legitimate swap.
  const sets = tradeAccountSets({ wallet, mint, tokenJson: ctx.tokenJson });
  for (const ix of intent.instructions) {
    classifyInstruction(ix, { wallet, mint, side: ctx.side, venueProgram, sets });
  }

  if (venue) {
    if (venueProgram && !intent.instructions.some((ix) => ix.programId === venueProgram)) {
      throw new IntentError(
        'INTENT_VENUE_MISMATCH',
        `quote/build venue is '${venue}' (program ${venueProgram}) but the decoded transaction has no instruction on that program. Refusing.`,
        { venue, venueProgram },
      );
    }
    if (venue === 'curve' && sets.pools.length && !sets.pools.some((p) => intent.allAccounts.includes(p))) {
      throw new IntentError(
        'INTENT_POOL_MISMATCH',
        `decoded transaction does not touch the canonical curve pool (${sets.pools.join(', ')}) from the token record. Refusing.`,
        { pool: sets.pools[0] },
      );
    }
  }
  return { venueProgram };
}

// Deterministic JSON for deep comparisons (card intent vs re-derived).
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function intentsEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

// Human-readable lines for the card display.
export function intentSummaryLines(intent) {
  const lines = [];
  lines.push(`    fee payer: ${intent.feePayer} · signers: ${intent.requiredSigners.join(', ')} · blockhash: ${intent.recentBlockhash}`);
  intent.instructions.forEach((ix, i) => {
    lines.push(`    ix ${i + 1}: ${ix.kind} [${ix.programId.slice(0, 12)}…]`);
    lines.push(`         accounts: ${ix.accounts.map((a) => a.slice(0, 12) + '…').join(', ')}`);
  });
  return lines;
}


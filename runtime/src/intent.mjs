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
    return { programId, kind: kindSummary(programId, tag), tag, accounts, writableAccounts };
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
    if ((bytes[0] & 0x80) !== 0) return await decodeVersioned(bytes, connection);
    return decodeLegacy(bytes);
  } catch (e) {
    if (e instanceof IntentError) throw e;
    throw new IntentError('INTENT_DECODE_FAILED', `transaction bytes could not be decoded: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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
  if (venue) {
    venueProgram = VENUE_PROGRAM_BY_VENUE[venue] ?? null;
    if (venueProgram && !intent.instructions.some((ix) => ix.programId === venueProgram)) {
      throw new IntentError(
        'INTENT_VENUE_MISMATCH',
        `quote/build venue is '${venue}' (program ${venueProgram}) but the decoded transaction has no instruction on that program. Refusing.`,
        { venue, venueProgram },
      );
    }
    if (venue === 'curve' && ctx.tokenJson?.pool && !intent.allAccounts.includes(ctx.tokenJson.pool)) {
      throw new IntentError(
        'INTENT_POOL_MISMATCH',
        `decoded transaction does not touch the canonical curve pool ${ctx.tokenJson.pool} from the token record. Refusing.`,
        { pool: ctx.tokenJson.pool },
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


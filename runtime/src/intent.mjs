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

// ---------------------------------------------------------------------------
// Platform PDA derivations (repair round 3, P1-1)
//
// The AgentOnly platform programs are custom (not Anchor): their trade
// instructions carry 1–2 byte tag discriminators and fixed account
// layouts — the layouts the gateway's Trade Kit builds (tradekit.mjs,
// mirrored byte-for-byte from hook.mjs). The state accounts those
// instructions may touch are deterministic PDAs of the mint / wallet /
// holder, or addresses the canonical record names. Deriving them here
// lets instruction classification validate account SHAPES, not just
// program identity: a platform instruction whose writable accounts are
// not the trade's own derived state accounts is a data-only state
// mutation riding the trade, and refuses.
// ---------------------------------------------------------------------------

export const INSTRUCTIONS_SYSVAR = 'Sysvar1nstructions1111111111111111111111111';

// The Meteora DBC swap discriminator, observed in production gateway
// builds (AGTR buy, 2026-10-31: 31-byte instruction data beginning
// b75d992818e6c297). A venue instruction without it is not the swap
// the gateway builds.
export const DBC_SWAP_DISCRIMINATOR = 'b75d992818e6c297';

function pdaFor(seeds, programId) {
  return PublicKey.findProgramAddressSync(
    seeds.map((s) => (Buffer.isBuffer(s) ? s : new PublicKey(s).toBuffer())),
    new PublicKey(programId),
  )[0].toBase58();
}

export function registrationPda(wallet) {
  return pdaFor([Buffer.from('registration'), wallet], PLATFORM_PROGRAMS.registry);
}
export function engineConfigPda(mint) {
  return pdaFor([Buffer.from('config'), mint], PLATFORM_PROGRAMS.engine);
}
export function enginePricePda(mint) {
  return pdaFor([Buffer.from('price'), mint], PLATFORM_PROGRAMS.engine);
}
export function engineMetaPda(mint) {
  return pdaFor([Buffer.from('extra-account-metas'), mint], PLATFORM_PROGRAMS.engine);
}
// One derivation, two generations: v2 holder records are keyed by the
// owner wallet, v3 by the holder TOKEN ACCOUNT (tradekit holderPda /
// holderPdaV3 share the ['holder', mint, key] seed layout).
export function engineHolderPda(mint, key) {
  return pdaFor([Buffer.from('holder'), mint, key], PLATFORM_PROGRAMS.engine);
}
export function distributorClaimPda(mint, holder) {
  return pdaFor([Buffer.from('claim'), mint, holder], PLATFORM_PROGRAMS.distributor);
}
// The HouseSwap pool PDA (gateway doors.mjs housePoolPda, mirrored):
// seeds ['pool', mint] under the house program. The pool's token and
// quote vaults are its derived ATAs — see classifyHouseSwap.
export function housePoolPda(mint) {
  return pdaFor([Buffer.from('pool'), mint], PLATFORM_PROGRAMS.house);
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
  const poolTokenAccounts = new Set();
  for (const p of pools) {
    const poolPk = new PublicKey(p);
    for (const tp of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const ata = associatedTokenAddress(mintPk, poolPk, tp).toBase58();
      poolAccounts.add(ata);
      poolTokenAccounts.add(ata);
    }
  }
  for (const v of canonicalPoolVaults(tokenJson)) { poolAccounts.add(v); poolTokenAccounts.add(v); }
  const permitted = new Set([wallet, ...walletAtas, wsolAta, ...poolAccounts]);
  // Platform state accounts (repair round 3, P1-1): the derived PDAs
  // and record-named distributor accounts the platform instructions of
  // a trade may legitimately name. distState/distVault come from the
  // canonical record (addresses.distributor) and stay null when the
  // record carries none — the shape checks then skip those positions.
  const dist = tokenJson?.addresses?.distributor ?? {};
  const platform = {
    regPda: registrationPda(wallet),
    engineConfig: engineConfigPda(mint),
    enginePrice: enginePricePda(mint),
    engineMeta: engineMetaPda(mint),
    distState: typeof dist.state === 'string' && dist.state ? dist.state : null,
    distVault: typeof dist.vault === 'string' && dist.vault ? dist.vault : null,
  };
  return { walletAtas, wsolAta, pools, poolAccounts: [...poolAccounts], poolTokenAccounts: [...poolTokenAccounts], permitted, platform };
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
    const out = {
      programId, kind: kindSummary(programId, tag), tag, accounts, writableAccounts,
      // Raw data shape (repair round 3, P1-1): instruction classification
      // validates discriminators and data lengths, not just the first
      // byte — both fields are JSON-safe so the intent survives the
      // approval-card round-trip and the send-time deep-compare binds
      // them exactly.
      dataLength: data ? data.length : 0,
      dataPrefix: data ? Buffer.from(data).subarray(0, 8).toString('hex') : '',
    };
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
    if (programId === PLATFORM_PROGRAMS.house && data && data.length >= 18 && data[0] === 1) {
      // HouseSwap swap terms (repair round 4, P1-2): data is exactly
      // [1][dir u8][amount_in u64 LE][min_out u64 LE] — the TaxSwap
      // encoding the house program and the gateway's doors.mjs builder
      // share byte-for-byte. Parsed here so classification and the
      // terms cross-check in validateIntent bind the exact values.
      const buf = Buffer.from(data);
      out.swapTerms = {
        direction: buf[1],
        amountInRaw: buf.readBigUInt64LE(2).toString(),
        minimumOutRaw: buf.readBigUInt64LE(10).toString(),
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

// Platform-program shape validation (repair round 3, P1-1).
//
// Round 2 classified ANY Engine/Registry/Distributor instruction as
// 'platform' on program identity alone. That admits arbitrary payloads
// on those programs — including data-only state mutations the balance
// checks cannot see (a state account's data changes while its lamports
// and token balance do not). The platform programs are custom, with
// 1–2 byte tag discriminators and fixed account layouts — exactly the
// layouts the gateway's Trade Kit builds (tradekit.mjs instruction
// builders, mirrored byte-for-byte from hook.mjs). Only those shapes
// belong to a trade:
//
//   Registry    register  data [0, kind]      [wallet, regPda, System]
//   Engine      sync      data [4, 0]         [wallet, mint, config, wallet, holder, System, regPda]
//   Engine      syncGate  data [7]            [wallet, mint, config, wallet, holder, System, gate, destAta, InstructionsSysvar]
//   Engine      crankCp   data [5]            [config, price, baseVault, quoteVault]
//   Engine      crankDbc  data [8]            [config, price, pool]
//   Distributor settle    data [3]            [payer, holder, holderAta, mint, distState, distVault, claimPda, Token2022, System, …tail]
//
// Every fixed position that names state must name THE derived/recorded
// account for this mint/wallet/holder — an instruction pointed at a
// lookalike state account refuses. Engine tag 9
// (RefreshExtraAccountMetas) is an operator repair and is never part
// of a trade; any other tag on any platform program refuses.
function classifyPlatformInstruction(ix, ctx) {
  const { wallet, mint, sets } = ctx;
  const a = ix.accounts;
  const P = sets.platform;
  const shape = (why) => { throw unclassified(ix, why); };

  if (ix.programId === PLATFORM_PROGRAMS.registry) {
    if (ix.tag !== 0 || ix.dataLength !== 2) {
      shape('the only Registry instruction in a trade is register (data [0, kind])');
    }
    if (a.length !== 3 || a[0] !== wallet || a[1] !== P.regPda || a[2] !== SYSTEM_PROGRAM) {
      shape('register must name the wallet, its derived registration PDA, and the System program — nothing else');
    }
    return 'platform-register';
  }

  if (ix.programId === PLATFORM_PROGRAMS.distributor) {
    if (ix.tag !== 3 || ix.dataLength !== 1) {
      shape('the only Distributor instruction in a trade is settle (data [3])');
    }
    if (a.length < 9) {
      shape(`settle carries a fixed 9-account prefix before its hook-extra tail; this one carries ${a.length} accounts`);
    }
    if (a[0] !== wallet) shape('settle payer is not the wallet');
    // Repair round 4, P1-1: the payout recipient is pinned to the
    // production forms. The distributor program itself enforces
    // on-chain that the recipient is a token account OF THE NAMED
    // HOLDER for the card mint (its BadTokenAccount check), so a
    // payout can only ever reach the holder's own accounts; the
    // runtime pin exists to keep every payout inside the modeled
    // accounts:
    //   * the WALLET's own settle (holder == wallet) must pay the
    //     wallet's DERIVED token account for the card mint — the
    //     exact account the gateway's Trade Kit settles into
    //     (tradekit settleIx builds c.ata(holder)) and the account
    //     the send-time payout decomposition reads. No exceptions:
    //     the decomposition is only sound for this account.
    //   * a COUNTERPARTY settle (the crank the gateway bundles for
    //     the swap's other side) may pay that holder's derived token
    //     account, a canonical pool token vault (records that name
    //     baseVault/tokenVault include it in the pool set), or the
    //     account the transaction's own validated venue swap names
    //     as its token vault — the curve pool's base vault is a
    //     venue-program account the published record does not name,
    //     and the swap that trades against it is validated
    //     independently (discriminator + canonical pool).
    // A settle paying any other account — above all a stranger's —
    // is not a production shape and refuses here, before modeling.
    {
      let holderAta = null;
      try {
        holderAta = associatedTokenAddress(new PublicKey(mint), new PublicKey(a[1]), TOKEN_2022_PROGRAM).toBase58();
      } catch { holderAta = null; }
      if (a[1] === wallet) {
        if (a[2] !== holderAta) {
          shape('the wallet\u2019s own settle pays an account that is not the wallet\u2019s derived token account for the card mint');
        }
      } else if (a[2] !== holderAta
        && !sets.poolTokenAccounts.includes(a[2])
        && !(ctx.venueAccounts && ctx.venueAccounts.has(a[2]))) {
        shape('a counterparty settle pays an account that is neither the holder\u2019s derived token account, nor a canonical pool token vault, nor an account the venue swap names');
      }
    }
    if (a[3] !== mint) shape('settle does not name the card mint');
    if (P.distState && a[4] !== P.distState) shape('settle state account is not the canonical record\u2019s distributor state');
    if (P.distVault && a[5] !== P.distVault) shape('settle vault account is not the canonical record\u2019s distributor vault');
    if (a[6] !== distributorClaimPda(mint, a[1])) {
      shape('settle claim account is not the derived claim PDA for the holder it names');
    }
    if (a[7] !== TOKEN_2022_PROGRAM || a[8] !== SYSTEM_PROGRAM) {
      shape('settle prefix must close with the Token-2022 and System programs');
    }
    return 'platform-settle';
  }

  // Engine. The holder position accepts either holder-record
  // generation: owner-keyed (v2) or token-account-keyed (v3).
  const holderOk = (acct) => acct === engineHolderPda(mint, wallet)
    || sets.walletAtas.some((ata) => acct === engineHolderPda(mint, ata));
  if (ix.tag === 4) {
    if (ix.dataLength !== 2 || ix.dataPrefix !== '0400') {
      shape('engine sync carries data [4, 0] exactly');
    }
    if (a.length !== 7 || a[0] !== wallet || a[3] !== wallet) shape('sync must be for the wallet itself');
    if (a[1] !== mint) shape('sync does not name the card mint');
    if (a[2] !== P.engineConfig) shape('sync config account is not the derived engine config PDA for this mint');
    if (!holderOk(a[4])) shape('sync holder account is not the wallet\u2019s derived holder PDA');
    if (a[5] !== SYSTEM_PROGRAM || a[6] !== P.regPda) shape('sync must close with the System program and the wallet\u2019s registration PDA');
    return 'platform-sync';
  }
  if (ix.tag === 7) {
    if (ix.dataLength !== 1) shape('engine syncGate carries data [7] exactly');
    if (a.length !== 9 || a[0] !== wallet || a[3] !== wallet) shape('syncGate must be for the wallet itself');
    if (a[1] !== mint) shape('syncGate does not name the card mint');
    if (a[2] !== P.engineConfig) shape('syncGate config account is not the derived engine config PDA for this mint');
    if (!holderOk(a[4])) shape('syncGate holder account is not the wallet\u2019s derived holder PDA');
    if (a[5] !== SYSTEM_PROGRAM || a[8] !== INSTRUCTIONS_SYSVAR) {
      shape('syncGate must carry the System program and the Instructions sysvar in their fixed positions');
    }
    return 'platform-sync-gate';
  }
  if (ix.tag === 8) {
    if (ix.dataLength !== 1) shape('engine crankDbc carries data [8] exactly');
    if (a.length !== 3 || a[0] !== P.engineConfig || a[1] !== P.enginePrice) {
      shape('crankDbc must name the derived config and price PDAs for this mint');
    }
    if (sets.pools.length && !sets.pools.includes(a[2])) shape('crankDbc pool is not a canonical pool for this mint');
    return 'platform-crank';
  }
  if (ix.tag === 5) {
    if (ix.dataLength !== 1) shape('engine crankCp carries data [5] exactly');
    if (a.length !== 4 || a[0] !== P.engineConfig || a[1] !== P.enginePrice) {
      shape('crankCp must name the derived config and price PDAs for this mint');
    }
    if (!sets.poolAccounts.includes(a[2]) || !sets.poolAccounts.includes(a[3])) {
      shape('crankCp vaults are not the canonical pool vaults for this mint');
    }
    return 'platform-crank';
  }
  throw unclassified(ix, `engine instruction tag ${ix.tag} is not part of a trade — the trade vocabulary is sync (4), crankCp (5), syncGate (7), crankDbc (8); tag 9 (RefreshExtraAccountMetas) is an operator repair, never bundled into a trade`);
}

// HouseSwap exact-format validation (repair round 4, P1-2).
//
// Round 3 validated the DBC swap's discriminator but admitted ANY
// instruction on the house program as the swap. The house program is
// a full venue program (pool admin, escrow, fee operations) — program
// identity alone admits data-only state mutations and non-swap
// operations riding a trade. The production swap has an exact format,
// shared byte-for-byte between the house program and the gateway's
// doors.mjs builder (contract §2.2/§2.3):
//
//   data: exactly 18 bytes — [1][dir][amount_in u64][min_out u64],
//         dir 0 = buy, 1 = sell, matching the card side;
//   keys: the fixed 10-account prefix
//         [pool, token_mint, quote_mint(WSOL), token_vault, quote_vault,
//          user_token, user_quote, user, Token-2022, legacy Token]
//         where pool is the derived HouseSwap pool PDA for the mint,
//         the vaults are the pool's derived ATAs, and the user accounts
//         are the wallet's derived ATAs — followed by the transfer-hook
//         tail and venue extras, whose effects full-effect accounting
//         bounds at send time.
//
// Any other instruction on the house program — wrong tag, wrong data
// size, wrong direction, a lookalike account in any fixed position —
// refuses. The amount/min-out terms are cross-checked against the
// card in validateIntent (the classifier does not see the quote).
function classifyHouseSwap(ix, ctx) {
  const { wallet, mint, side, sets } = ctx;
  const a = ix.accounts;
  const shape = (why) => { throw unclassified(ix, why); };
  if (ix.tag !== 1 || ix.dataLength !== 18 || !ix.swapTerms) {
    shape('the only HouseSwap instruction in a trade is the swap: data [1, dir, amount_in u64, min_out u64] — exactly 18 bytes');
  }
  const dir = ix.swapTerms.direction;
  if (dir !== 0 && dir !== 1) shape(`house swap direction must be 0 (buy) or 1 (sell), got ${dir}`);
  if ((side === 'buy' && dir !== 0) || (side === 'sell' && dir !== 1)) {
    shape(`house swap direction ${dir} contradicts the card side '${side}'`);
  }
  if (a.length < 10) {
    shape(`house swap carries a fixed 10-account prefix before its hook tail; this one carries ${a.length} accounts`);
  }
  const pool = housePoolPda(mint);
  if (a[0] !== pool) shape('house swap pool is not the derived HouseSwap pool PDA for this mint');
  if (sets.pools.length && !sets.pools.includes(a[0])) {
    shape('house swap pool is not a pool the canonical record names for this mint');
  }
  if (a[1] !== mint) shape('house swap does not name the card mint as its token mint');
  if (a[2] !== WSOL_MINT) shape('house swap quote mint is not wrapped SOL');
  const ata = (m, owner, tp) => associatedTokenAddress(new PublicKey(m), new PublicKey(owner), tp).toBase58();
  if (a[3] !== ata(mint, pool, TOKEN_2022_PROGRAM)) shape('house swap token vault is not the pool\u2019s derived token account for the card mint');
  if (a[4] !== ata(WSOL_MINT, pool, TOKEN_PROGRAM)) shape('house swap quote vault is not the pool\u2019s derived wrapped-SOL account');
  if (a[5] !== ata(mint, wallet, TOKEN_2022_PROGRAM)) shape('house swap user token account is not the wallet\u2019s derived token account for the card mint');
  if (a[6] !== sets.wsolAta) shape('house swap user quote account is not the wallet\u2019s derived wrapped-SOL account');
  if (a[7] !== wallet) shape('house swap user is not the wallet');
  if (a[8] !== TOKEN_2022_PROGRAM || a[9] !== TOKEN_PROGRAM) {
    shape('house swap must close its fixed prefix with the Token-2022 and legacy Token programs, in that order');
  }
  return 'venue-swap';
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
    return classifyPlatformInstruction(ix, ctx);
  }
  if (pid === PLATFORM_PROGRAMS.dbc || pid === PLATFORM_PROGRAMS.house) {
    // Repair round 4, P1-4: a venue instruction is admitted ONLY for
    // the exact venue bound to this trade. Rounds 1–3 admitted either
    // venue program whenever no venue was bound (venueProgram null),
    // so an unknown or missing venue silently unbound the swap check.
    if (!venueProgram) {
      throw unclassified(ix, 'instruction runs on a venue program, but no known venue is bound for this trade — a venue swap is admitted only for the exact quoted venue');
    }
    if (pid !== venueProgram) {
      throw unclassified(ix, 'instruction runs on a venue program that is not the quoted venue');
    }
    // Discriminator validation (repair round 3, P1-1): a venue
    // instruction must BE the swap, not just run on the venue
    // program. The DBC swap carries the 8-byte discriminator the
    // production gateway emits; anything else on the program —
    // including data-only payloads — refuses.
    if (pid === PLATFORM_PROGRAMS.dbc) {
      if (ix.dataPrefix !== DBC_SWAP_DISCRIMINATOR) {
        throw unclassified(ix, 'venue instruction does not carry the DBC swap discriminator — it is not the swap the gateway builds');
      }
      return 'venue-swap';
    }
    // HouseSwap: the exact swap format or nothing (repair round 4, P1-2).
    return classifyHouseSwap(ix, ctx);
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
      // Repair round 4, P0: direct wallet\u2194pool SOL transfers are
      // REFUSED, outright. Rounds 1\u20133 admitted them as 'trade-transfer'
      // (buy: wallet\u2192pool; sell: pool\u2192wallet), and the send-time pool
      // check only bounded the pool's gain by the trade input \u2014 so an
      // appended direct transfer inside the fee ceiling passed as if it
      // were part of the trade. But the production venue shapes are
      // WSOL-based (wrap \u2192 venue swap \u2192 close): neither the curve/DBC
      // build nor the HouseSwap build ever contains a direct
      // wallet\u2194pool System transfer, and no other venue this runtime
      // supports has an exact format that requires one. There is
      // therefore nothing legitimate to gate the admission to \u2014 the
      // classification is deleted, not narrowed.
      // The wrap leg: the wallet funds its OWN derived wrapped-SOL
      // account (either side \u2014 a sell build may wrap around the swap
      // too). No other System destination is admitted.
      if (from === wallet && to === sets.wsolAta) return 'wsol-wrap';
      throw unclassified(ix, `a System transfer ${from} \u2192 ${to} is not the wallet\u2019s own wrapped-SOL wrap \u2014 direct wallet\u2194pool SOL transfers are not part of any supported venue\u2019s trade shape (the venues move SOL through the wallet\u2019s wrapped-SOL account)`);
    }
    throw unclassified(ix, 'only the wallet\u2019s own wrapped-SOL wrap belongs to a trade');
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
// token record — its `pool` is checked when the venue is the curve),
// amountInRaw?, minimumAmountOutRaw? (the approved terms; required for
// the house venue, whose swap carries its terms in its data) }.
// Returns { venueProgram } on success; throws IntentError otherwise.
export function validateIntent(intent, ctx) {
  const { wallet, mint, venue } = ctx;

  // Repair round 4, P1-4: an unknown venue string refuses here, in
  // the shared validator. Rounds 1–3 mapped an unrecognized venue to
  // a null venue program, which silently disabled the venue binding
  // (either venue program's swap classified). The known set is
  // exactly the keys of VENUE_PROGRAM_BY_VENUE.
  if (venue != null && !Object.hasOwn(VENUE_PROGRAM_BY_VENUE, venue)) {
    throw new IntentError(
      'VENUE_UNKNOWN',
      `venue '${venue}' is not a venue this runtime knows (known: ${Object.keys(VENUE_PROGRAM_BY_VENUE).join(', ')}) — refusing: an unrecognized venue cannot bind the build to a route`,
      { venue },
    );
  }

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

  // Canonical binding (repair round 3, P1-2): when a venue is named,
  // the canonical token record is REQUIRED — it is what binds the
  // build to the token's real pool and platform state accounts. A
  // missing record, or a record that names no pool for the curve
  // venue, refuses here in the shared validator (not only in CLI
  // plumbing), so no caller can validate a build against nothing.
  if (venue && !ctx.tokenJson) {
    throw new IntentError(
      'CANONICAL_RECORD_REQUIRED',
      `intent validation for venue '${venue}' requires the canonical token record — without it the build cannot be bound to the token's pool and platform state accounts. Refusing.`,
      { venue, mint },
    );
  }

  // P0-1b: EVERY instruction must classify into the approved trade
  // shape. This is what stops a bundled extra transfer riding along
  // with a legitimate swap.
  const sets = tradeAccountSets({ wallet, mint, tokenJson: ctx.tokenJson });
  if (venue === 'curve' && sets.pools.length === 0) {
    throw new IntentError(
      'CANONICAL_RECORD_REQUIRED',
      'the canonical token record names no pool for this mint — the build cannot be bound to a canonical curve pool. Refusing.',
      { venue, mint },
    );
  }
  // Accounts the transaction's venue swap(s) name — the counterparty
  // settle's recipient pin (classifyPlatformInstruction) accepts the
  // pool token vault the swap itself trades against.
  const venueAccounts = new Set();
  for (const ix of intent.instructions) {
    if (ix.programId === PLATFORM_PROGRAMS.dbc || ix.programId === PLATFORM_PROGRAMS.house) {
      for (const a of ix.accounts) venueAccounts.add(a);
    }
  }
  for (const ix of intent.instructions) {
    classifyInstruction(ix, { wallet, mint, side: ctx.side, venueProgram, sets, venueAccounts });
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

  // HouseSwap terms cross-check (repair round 4, P1-2): the swap's
  // data carries the trade terms themselves (amount in, minimum out),
  // so the bytes must agree with the approved terms — a house swap
  // for a different amount, or with an on-chain minimum-out floor
  // below the card's approved minimum, is not the approved trade.
  if (venue === 'house') {
    const swap = intent.instructions.find((ix) => ix.programId === PLATFORM_PROGRAMS.house);
    if (!swap?.swapTerms) {
      throw new IntentError(
        'VENUE_TERMS_MISMATCH',
        'the house swap\u2019s terms could not be read from its data — refusing',
      );
    }
    if (ctx.amountInRaw == null || ctx.minimumAmountOutRaw == null) {
      throw new IntentError(
        'VENUE_TERMS_UNVERIFIED',
        'house venue validation requires the approved amount/minimum-out terms to cross-check the swap\u2019s embedded terms against — refusing without them',
        { venue },
      );
    }
    if (swap.swapTerms.amountInRaw !== String(ctx.amountInRaw)) {
      throw new IntentError(
        'VENUE_TERMS_MISMATCH',
        `the house swap\u2019s embedded amount_in is ${swap.swapTerms.amountInRaw} raw units but the approved amount is ${ctx.amountInRaw} — the bytes are not the approved trade. Refusing.`,
        { swapAmountInRaw: swap.swapTerms.amountInRaw, amountInRaw: String(ctx.amountInRaw) },
      );
    }
    if (BigInt(swap.swapTerms.minimumOutRaw) < BigInt(ctx.minimumAmountOutRaw)) {
      throw new IntentError(
        'VENUE_TERMS_MISMATCH',
        `the house swap\u2019s embedded min_out is ${swap.swapTerms.minimumOutRaw}, below the approved minimum out of ${ctx.minimumAmountOutRaw} — the on-chain floor undercuts the approved floor. Refusing.`,
        { swapMinimumOutRaw: swap.swapTerms.minimumOutRaw, minimumAmountOutRaw: String(ctx.minimumAmountOutRaw) },
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


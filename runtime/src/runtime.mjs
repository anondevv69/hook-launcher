// AgentOnly reference signer runtime — core library.
//
// Non-custodial by construction: this code holds a keypair ONLY when the
// owner explicitly hands it a local keypair file on the command line (or
// delegates signing to an external signer command the owner names). It
// never sends key material anywhere (the Execution Gateway is keyless
// and actively rejects key-shaped payloads).
//
// Flow (per SPEC-REFERENCE-RUNTIME.md + issue #4 release gate):
//   inspect → eligibility → quote → build (gateway-simulated)
//           → intent decoded from the build bytes and VALIDATED against
//             the request, the build, and the canonical token record
//           → ONE approval card (fingerprint + validated intent summary)
//           → owner approves the card fingerprint
//           → sign locally (or via the external signer, whose returned
//             bytes are validated byte-for-byte against the request)
//           → MANDATORY simulation of the exact signed bytes, with the
//             wallet's SOL/token deltas enforced against the card bounds
//           → broadcast → confirm against the CARD's blockhash strategy
//           → receipt.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname as pathDirname, join as pathJoin } from 'node:path';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  ATA_PROGRAM,
  PLATFORM_PROGRAMS,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
  associatedTokenAddress,
  deriveIntent,
  intentSummaryLines,
  intentsEqual,
  legacyMessageBytes,
  parseStrictDecimal,
  serializedTxKind,
  stableStringify,
  tradeAccountSets,
  validateIntent,
} from './intent.mjs';

export {
  PLATFORM_PROGRAMS,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
  associatedTokenAddress,
  deriveIntent,
  distributorClaimPda,
  engineConfigPda,
  engineMetaPda,
  enginePricePda,
  housePoolPda,
  parseStrictDecimal,
  registrationPda,
  serializedTxKind,
  stableStringify,
  tradeAccountSets,
  validateIntent,
} from './intent.mjs';

export const GATEWAY_BASE = process.env.AGENTONLY_GATEWAY_BASE ?? 'https://agentonly.fun';
export const SITE_BASE = process.env.AGENTONLY_SITE_BASE ?? 'https://agentonly.fun';
export const RPC_URL = process.env.AGENTONLY_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

export const RUNTIME_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

export const SUPPORTED_SIGNER_TYPES = ['own', 'sandbox', 'external'];
export const UNSUPPORTED_SIGNER_TYPES = ['bankr', 'custodial'];

export const DEFAULT_FEE_CEILING_LAMPORTS = 5_000_000;

export class RuntimeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// Intent errors carry their own codes; normalize them into RuntimeError
// so every refusal prints as `ERROR <CODE>: ...`.
function asRuntimeError(e) {
  if (e instanceof RuntimeError) return e;
  return new RuntimeError(e.code ?? 'INTENT_ERROR', e.message, { cause: e });
}

// ---------------------------------------------------------------------------
// Signer guard
// ---------------------------------------------------------------------------

const SIGNER_ALTERNATIVE =
  'Use an agent-controlled Solana signer instead: a local keypair file this ' +
  'runtime controls (Path A), or a sandbox keypair whose persistence you have ' +
  'verified before funding (Path B\u2032).';

// Mirrors the gateway's TK_SIGNER_UNSUPPORTED verdict (see SignerCompatibility
// in the gateway contract): refused locally, by name, before any build call.
export function assertSignerSupported(signerType) {
  const t = (signerType ?? 'own').toLowerCase();
  if (UNSUPPORTED_SIGNER_TYPES.includes(t)) {
    throw new RuntimeError(
      'TK_SIGNER_UNSUPPORTED',
      `refusing to prepare or sign: signer type '${t}' cannot sign arbitrary ` +
        `Solana transactions. The unsupported step is arbitrary Solana ` +
        `instruction signing — a ${t === 'bankr' ? 'Bankr-custodial' : 'custodial'} ` +
        `wallet's documented signing surface does not cover it ` +
        `(Bankr documents only: personal_sign, eth_signTypedData_v4, ` +
        `eth_signTransaction — all EVM). ${SIGNER_ALTERNATIVE}`,
      { signerType: t, unsupportedStep: 'arbitrary Solana instruction signing' },
    );
  }
  if (!SUPPORTED_SIGNER_TYPES.includes(t)) {
    throw new RuntimeError(
      'INVALID_FIELD',
      `unknown signer type '${signerType}'. Supported: ${SUPPORTED_SIGNER_TYPES.join(', ')}. ` +
        `Refused as unsupported: ${UNSUPPORTED_SIGNER_TYPES.join(', ')}.`,
    );
  }
  return t;
}

// The gateway's WalletType enum is own|sandbox|bankr. An 'external' signer
// (signs serialized transactions) is wire-equivalent to 'own' (Path A).
export function gatewayWalletType(signerType) {
  return signerType === 'sandbox' ? 'sandbox' : 'own';
}

// ---------------------------------------------------------------------------
// Keypair files (P1-c: exclusive create, symlink/permission refusal)
// ---------------------------------------------------------------------------

// Solana CLI keypair format: JSON array of the 64 secret-key bytes.
export function loadKeypair(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    throw new RuntimeError('KEYPAIR_NOT_FOUND', `keypair file not found: ${file}`);
  }
  if (stat.isSymbolicLink()) {
    throw new RuntimeError(
      'KEYPAIR_SYMLINK',
      `refusing to load a keypair through a symlink: ${file} — pass the real file path instead, so the file whose permissions are checked is the file whose bytes are loaded`,
    );
  }
  if (!stat.isFile()) {
    throw new RuntimeError('KEYPAIR_INVALID', `keypair path is not a regular file: ${file}`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new RuntimeError(
      'KEYPAIR_PERMISSIONS',
      `refusing to load keypair file ${file}: it is accessible by group/others ` +
        `(mode ${(stat.mode & 0o777).toString(8)}). A secret key must be owner-only — fix it with: chmod 600 ${file}`,
    );
  }
  const raw = readFileSync(file, 'utf8');
  let bytes;
  try {
    bytes = JSON.parse(raw);
  } catch {
    throw new RuntimeError('KEYPAIR_INVALID', `keypair file is not valid JSON: ${file}`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new RuntimeError(
      'KEYPAIR_INVALID',
      `keypair file must be a JSON array of 64 secret-key bytes: ${file}`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export function writeKeypairFile(file, keypair) {
  try {
    writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      throw new RuntimeError('KEYPAIR_EXISTS', `refusing to overwrite an existing keypair file: ${file}`);
    }
    throw e;
  }
  try { chmodSync(file, 0o600); } catch { /* best effort on non-POSIX */ }
}

// ---------------------------------------------------------------------------
// Wallet persistence sidecar + attestation gate (P1-b)
// ---------------------------------------------------------------------------

export function walletSidecarPath(file) {
  return `${file}.agentonly.json`;
}

export function keypairFileSha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// The sidecar gets the same load hardening as the keypair file itself
// (repair round 2, P1-g): a symlinked or group/world-readable sidecar
// is refused, because the sidecar is what the attestation gate trusts.
export function readWalletSidecar(file) {
  const p = walletSidecarPath(file);
  let stat;
  try {
    stat = lstatSync(p);
  } catch {
    return null; // no sidecar: owner-imported wallet, not gated
  }
  if (stat.isSymbolicLink()) {
    throw new RuntimeError(
      'SIDECAR_SYMLINK',
      `refusing to trust a wallet sidecar reached through a symlink: ${p} — pass the real file path instead`,
    );
  }
  if (!stat.isFile()) {
    throw new RuntimeError('SIDECAR_INVALID', `wallet sidecar path is not a regular file: ${p}`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new RuntimeError(
      'SIDECAR_PERMISSIONS',
      `refusing to trust wallet sidecar ${p}: it is accessible by group/others ` +
        `(mode ${(stat.mode & 0o777).toString(8)}). The attestation record must be owner-only — fix it with: chmod 600 ${p}`,
    );
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    throw new RuntimeError('SIDECAR_INVALID', `wallet sidecar is not readable JSON: ${p} — refusing to guess at the attestation state`);
  }
}

// Sidecar writes (repair round 3, P1-3): never through a symlink, and
// never in place. A pre-planted symlink at the sidecar path would make
// a plain writeFileSync overwrite whatever file it points at, and an
// in-place write can leave a torn sidecar if the process dies midway.
// The write goes to a fresh temp file in the SAME directory (mode
// 0600, exclusive create) and is renamed over the target — atomic on
// POSIX, and the rename replaces the directory entry itself rather
// than following it. A symlinked target is refused outright.
export function writeWalletSidecar(file, sidecar) {
  const p = walletSidecarPath(file);
  let stat = null;
  try { stat = lstatSync(p); } catch { /* absent: the normal case */ }
  if (stat?.isSymbolicLink()) {
    throw new RuntimeError(
      'SIDECAR_SYMLINK',
      `refusing to write the wallet sidecar through a symlink: ${p} — a planted link could redirect the write onto another file. Remove the link (or pass the real keypair path) and retry.`,
      { file },
    );
  }
  if (stat && !stat.isFile()) {
    throw new RuntimeError('SIDECAR_INVALID', `wallet sidecar path is not a regular file: ${p}`);
  }
  const tmpPath = `${p}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmpPath, JSON.stringify(sidecar, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(tmpPath, p);
  try { chmodSync(p, 0o600); } catch { /* best effort on non-POSIX */ }
}

// Symlink-safe atomic file write (repair round 4, P1-7b) — the same
// pattern as the sidecar write, generalized for the runtime's other
// outputs (approval cards, the signer allowlist). The pre-round-4 CLI
// wrote the approval card with a plain writeFileSync: a symlink
// planted at the output path redirected the write onto whatever file
// it pointed at, and an in-place write could tear. Here: a symlinked
// target refuses outright; the bytes go to a fresh temp file in the
// SAME directory (exclusive create, caller-chosen mode) and are
// renamed over the target — atomic on POSIX, and the rename replaces
// the directory entry itself rather than following it.
export function writeFileAtomicSafe(path, contents, mode = 0o600) {
  let stat = null;
  try { stat = lstatSync(path); } catch { /* absent: the normal case */ }
  if (stat?.isSymbolicLink()) {
    throw new RuntimeError(
      'WRITE_SYMLINK_REFUSED',
      `refusing to write ${path} through a symlink — a planted link could redirect the write onto another file. Remove the link (or choose a different output path) and retry.`,
      { path },
    );
  }
  if (stat && !stat.isFile()) {
    throw new RuntimeError('WRITE_TARGET_INVALID', `write target is not a regular file: ${path}`, { path });
  }
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmpPath, contents, { mode, flag: 'wx' });
  renameSync(tmpPath, path);
  try { chmodSync(path, mode); } catch { /* best effort on non-POSIX */ }
}

// The sidecar is integrity-bound to the wallet it describes (P1-g): it
// records the wallet address AND the SHA-256 of the keypair file's
// exact bytes. Attestation stamps the binding; every later load of a
// sidecar-gated wallet re-verifies it. A sidecar copied onto another
// wallet, or a keypair file whose bytes changed since attestation
// (even a reformat of the same key), refuses with
// SIDECAR_BINDING_MISMATCH. A sidecar with no binding yet (written by
// an older runtime) is unbound: attest-persistence establishes the
// binding after checking the recorded address.
export function verifySidecarBinding(file, sidecar) {
  const sc = sidecar ?? readWalletSidecar(file);
  if (!sc) return;
  const address = loadKeypair(file).publicKey.toBase58();
  if (!sc.keypairSha256) {
    throw new RuntimeError(
      'SIDECAR_BINDING_MISMATCH',
      `wallet sidecar ${walletSidecarPath(file)} carries no keypair binding (it predates the binding, or was stripped) — refusing to trust it. Run: agentonly-runtime wallet attest-persistence --file ${file} (it verifies the recorded address, then binds the sidecar to this keypair file)`,
      { file },
    );
  }
  const digest = keypairFileSha256(file);
  if (sc.address !== address || sc.keypairSha256 !== digest) {
    throw new RuntimeError(
      'SIDECAR_BINDING_MISMATCH',
      `wallet sidecar ${walletSidecarPath(file)} does not belong to this keypair file: it records address ${sc.address ?? '(none)'} / keypair sha256 ${String(sc.keypairSha256).slice(0, 12)}… but the file derives ${address} / ${digest.slice(0, 12)}…. The sidecar was copied from another wallet or the keypair file changed since attestation. Refusing — restore the original sidecar, or delete it and treat the wallet as owner-imported with your eyes open.`,
      { file },
    );
  }
}

// The two-session rule: a wallet THIS runtime created (sidecar present)
// may not prepare or send until its persistence has been attested from a
// LATER invocation (`wallet attest-persistence`). The create-time
// handshake only proves a separate process can re-read the file right
// now — not that the file survives a host restart or snapshot rollback.
// Keypair files with no sidecar are owner-imported and are not gated.
export function assertWalletAttested(file) {
  const sc = readWalletSidecar(file);
  if (!sc) return; // owner-imported: not gated
  if (!sc.attestedAt) {
    throw new RuntimeError(
      'WALLET_NOT_ATTESTED',
      `refusing: wallet ${file} was created by this runtime (sidecar ${walletSidecarPath(file)}) ` +
        `but its persistence has not been attested. The create-time handshake proves a separate ` +
        `process can re-read the file right now; it does NOT prove durability across a host ` +
        `restart. Before funding or trading, run this from a later session: ` +
        `agentonly-runtime wallet attest-persistence --file ${file}`,
      { file },
    );
  }
  // Attested: the sidecar must still belong to THIS keypair file.
  verifySidecarBinding(file, sc);
}

// ---------------------------------------------------------------------------
// HTTP helpers (fetch is injectable so tests can stub the gateway)
// ---------------------------------------------------------------------------

export async function gatewayPost(fetchImpl, path, body) {
  const res = await fetchImpl(`${GATEWAY_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    const err = data?.error ?? {};
    throw new RuntimeError(
      err.code ?? `HTTP_${res.status}`,
      err.message ?? `gateway ${path} failed with HTTP ${res.status}`,
      { status: res.status, gatewayError: err, endpoint: path },
    );
  }
  return data;
}

export async function siteGetJson(fetchImpl, path) {
  const res = await fetchImpl(`${SITE_BASE}${path}`);
  if (!res.ok) throw new RuntimeError(`HTTP_${res.status}`, `GET ${path} failed with HTTP ${res.status}`);
  return res.json();
}

async function rpcCall(fetchImpl, rpcUrl, method, params) {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json().catch(() => null);
  if (!json || json.error) {
    throw new RuntimeError('RPC_ERROR', `RPC ${method} failed: ${json?.error?.message ?? `HTTP ${res.status}`}`);
  }
  return json.result;
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

export async function inspectToken(fetchImpl, mint) {
  const [info, market] = await Promise.all([
    siteGetJson(fetchImpl, `/api/v1/tokens/${mint}.json`),
    siteGetJson(fetchImpl, '/api/market.json'),
  ]);
  const token = info.token ?? info;
  const mkt = (market.tokens ?? []).find((t) => t.mint === mint) ?? null;
  return { token, market: mkt, observedAt: market.generatedAt ?? null };
}

export function formatInspect({ token, market }) {
  const lines = [];
  lines.push(`${token.name} (${token.symbol})`);
  lines.push(`  mint:        ${token.mint}`);
  lines.push(`  decimals:    ${token.decimals}   supply: ${token.supply}`);
  lines.push(`  launched:    ${token.launchedAt} by ${token.creator}`);
  lines.push(`  authority:   ${token.authorityMode}${token.authorityNote ? ` — ${token.authorityNote}` : ''}`);
  if (token.rules?.length) {
    lines.push(`  rules:       ${token.rules.map((r) => `${r.id} ${r.name}`).join(' · ')}`);
    for (const r of token.rules) {
      if (r.effects?.buy) lines.push(`    rule ${r.id} buy: ${r.effects.buy}`);
    }
  }
  if (token.graduationSemantics) lines.push(`  graduation:  ${token.graduationSemantics}`);
  if (market) {
    lines.push(`  market (observed ${market.observedAt}):`);
    lines.push(`    price:     ${market.priceSol} SOL${market.priceUsd ? ` (~$${market.priceUsd})` : ''}`);
    lines.push(`    reserves:  ${market.solReserves} SOL / ${market.baseReserves} ${token.symbol}`);
    if (market.graduation) {
      lines.push(`    progress:  ${market.graduation.progressPct?.toFixed(2)}% toward ${market.graduation.thresholdSol} SOL (${market.graduation.mode})`);
    }
    lines.push(`    status:    ${market.status}`);
  } else {
    lines.push('  market:      no live market snapshot for this mint');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Canonical token record (prepare + intent validation)
// ---------------------------------------------------------------------------

// Canonical token data is load-bearing: it carries the decimals the
// amount parse uses and the pool the intent validation checks. A fetch
// failure or non-200 therefore REFUSES the operation (repair round 2,
// P1-d) — pool validation is never skipped silently.
export async function fetchTokenRecord(fetchImpl, mint) {
  let info;
  try {
    info = await siteGetJson(fetchImpl, `/api/v1/tokens/${mint}.json`);
  } catch (e) {
    throw new RuntimeError(
      'CANONICAL_DATA_UNAVAILABLE',
      `canonical token record for ${mint} could not be fetched (${e.message}) — refusing: intent and pool validation depend on it and are never skipped`,
      { mint, cause: e },
    );
  }
  return info.token ?? info;
}

// ---------------------------------------------------------------------------
// prepare → approval card
// ---------------------------------------------------------------------------

export function fingerprintOf(transactionBase64) {
  return createHash('sha256').update(Buffer.from(transactionBase64, 'base64')).digest('hex');
}

// Approval-token policy binding (repair round 3, P0-1).
//
// Rounds 1–2 bound approval to the transaction BYTES alone: the
// fingerprint hashed only the serialized transaction, while the
// send-time economic checks read the card's `validation` fields. Those
// fields live on the same editable card as everything else, so an
// attacker who altered the policy — minimum out, fee ceiling, max
// debit, amount — AND the card's displayed copies consistently kept
// the same fingerprint and the owner's approval still matched. The
// approval token now hashes the transaction fingerprint PLUS a
// canonical serialization of the validated intent record: mint, side,
// venue, amountInRaw, minimumAmountOutRaw, expectedAmountOutRaw,
// maxSolDebitLamports, feeCeilingLamports, blockhash. Altering any
// policy field after approval changes the recomputed token, and the
// send refuses (POLICY_BINDING_MISMATCH) before anything is signed.
//
// Repair round 4 (policy version 2) extends the bound serialization
// with the remaining DISPLAYED economics the owner reads on the card
// (P1-8: the quote's fee breakdown and the price impact — round 3
// left them outside the token, so post-approval edits to what the
// card DISPLAYS as fees/impact kept a valid approval) and with the
// settlement-payout model (P1-1: the distributor vault, its payout
// bound, and the exact recipient set). Version-1 tokens no longer
// verify — deliberately: a card prepared under the weaker binding
// must be re-prepared, never grandfathered.
export function policyFingerprintOf(p) {
  return createHash('sha256').update(stableStringify({
    policyVersion: 2,
    transactionFingerprint: p.transactionFingerprint,
    mint: p.mint,
    side: p.side,
    venue: p.venue ?? null,
    amountInRaw: String(p.amountInRaw),
    minimumAmountOutRaw: String(p.minimumAmountOutRaw),
    expectedAmountOutRaw: String(p.expectedAmountOutRaw),
    maxSolDebitLamports: String(p.maxSolDebitLamports),
    feeCeilingLamports: String(p.feeCeilingLamports),
    blockhash: p.blockhash,
    fees: p.fees ?? null,
    priceImpactBps: p.priceImpactBps ?? null,
    settlementPayout: canonicalSettlementModel(p.settlementPayout),
  })).digest('hex');
}

// The settlement-payout model in its canonical, hashable shape: raw
// amounts as strings, the recipient set sorted, absent model as null.
// Both the prepare-time token and the send-time recompute pass through
// here, so the two constructions cannot drift apart.
export function canonicalSettlementModel(sp) {
  if (!sp) return null;
  return {
    vault: sp.vault,
    state: sp.state,
    maxRaw: String(sp.maxRaw),
    minRaw: String(sp.minRaw ?? '0'),
    holderAtas: [...(sp.holderAtas ?? [])].sort(),
    ownAta: sp.ownAta ?? null,
  };
}

// The policy fingerprint recomputed from a card's own fields — the
// send-time check compares this against the card's approval token.
export function cardPolicyFingerprint(card) {
  const v = card.validation ?? {};
  return policyFingerprintOf({
    transactionFingerprint: card.fingerprint,
    mint: v.mint,
    side: v.side,
    venue: v.venue,
    amountInRaw: v.amountInRaw,
    minimumAmountOutRaw: v.minimumAmountOutRaw,
    expectedAmountOutRaw: v.expectedAmountOutRaw,
    maxSolDebitLamports: v.maxSolDebitLamports,
    feeCeilingLamports: v.feeCeilingLamports,
    blockhash: card.blockhash,
    fees: card.fees ?? null,
    priceImpactBps: card.priceImpactBps ?? null,
    settlementPayout: v.settlementPayout ?? null,
  });
}

function describeSimulationFailure(sim) {
  const parts = [`simulation FAILED (layer: ${sim.layer ?? 'unknown'})`];
  if (sim.name) parts.push(`error: ${sim.name}${sim.engineCode != null ? ` (engine code ${sim.engineCode})` : ''}`);
  if (sim.reason) parts.push(`reason: ${sim.reason}`);
  return parts.join(' — ');
}

// Runs eligibility → quote → build against the gateway; decodes the
// build's bytes into an intent and validates it against the request, the
// build response, and the canonical token record; only then returns an
// approval card (version 3). Writes nothing; the CLI decides where the
// card file goes.
//
// opts: { wallet (base58), mint, side, amount (UI decimal string),
//         signerType, fetchImpl, connection, tokenJson?, maxFeeLamports? }
export async function prepareTrade(opts) {
  const { wallet, mint, side } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const signerType = assertSignerSupported(opts.signerType);
  const walletType = gatewayWalletType(signerType);

  if (!['buy', 'sell'].includes(side)) {
    throw new RuntimeError('INVALID_FIELD', `side must be buy or sell (got '${side}')`);
  }

  // Canonical token record: decimals for the strict amount parse, pool +
  // programs context for intent validation.
  const token = opts.tokenJson ?? (await fetchTokenRecord(fetchImpl, mint));
  const decimals = side === 'buy' ? 9 : token.decimals;
  if (decimals == null) {
    throw new RuntimeError('TOKEN_RECORD_INCOMPLETE', `canonical record for ${mint} carries no decimals — cannot parse a sell amount safely`);
  }
  let parsed;
  try {
    parsed = parseStrictDecimal(opts.amount, decimals);
  } catch (e) {
    throw asRuntimeError(e);
  }
  if (parsed.raw <= 0n) {
    throw new RuntimeError('INVALID_AMOUNT', `amount must be positive (got '${opts.amount}')`);
  }
  const amount = Number(parsed.ui);

  const feeCeilingRaw = opts.maxFeeLamports ?? DEFAULT_FEE_CEILING_LAMPORTS;
  if (!Number.isInteger(feeCeilingRaw) || feeCeilingRaw < 0) {
    throw new RuntimeError('INVALID_FIELD', `--max-fee-lamports must be a non-negative integer (got '${opts.maxFeeLamports}')`);
  }
  const feeCeiling = BigInt(feeCeilingRaw);

  // Local funds precheck (buy): a wallet with no SOL account at all cannot
  // pay for anything — fail honestly here instead of dressing it up.
  if (side === 'buy' && opts.connection) {
    const lamports = await opts.connection.getBalance(new PublicKey(wallet), 'confirmed');
    if (lamports === 0) {
      throw new RuntimeError(
        'INSUFFICIENT_FUNDS',
        `wallet ${wallet} holds 0 SOL on mainnet — it cannot fund a buy or even ` +
          `pay transaction fees. Fund the wallet first (only after its persistence ` +
          `has been attested from a later session), then prepare again. No approval card was written.`,
        { balanceLamports: 0 },
      );
    }
  }

  const base = { wallet, mint, side, amount, walletType };

  const eligibility = await gatewayPost(fetchImpl, '/v1/trade/eligibility', base);
  if (eligibility.status !== 'eligible') {
    const reasons = (eligibility.reasons ?? [])
      .map((r) => `${r.code ?? 'check'}: ${r.detail}`)
      .join('; ') || 'no reason detail returned';
    throw new RuntimeError(
      'TK_INELIGIBLE',
      `gateway eligibility is '${eligibility.status}' for this ${side}: ${reasons}. ` +
        `No approval card was written.`,
      { eligibility },
    );
  }

  const quote = await gatewayPost(fetchImpl, '/v1/trade/quote', { mint, side, amount });

  const build = await gatewayPost(fetchImpl, '/v1/trade/build', base);
  if (build.status !== 'ready_for_signature' || !build.transaction_base64) {
    throw new RuntimeError('BUILD_NOT_READY', `gateway build returned status '${build.status}' with no transaction. No approval card was written.`);
  }

  const sim = build.simulation ?? {};
  if (sim.status !== 'passed') {
    throw new RuntimeError(
      'SIMULATION_FAILED',
      `gateway build was refused: ${describeSimulationFailure(sim)}. ` +
        `This is the classified on-chain verdict (e.g. a hook veto) — the build ` +
        `will not be signed. No approval card was written.`,
      { simulation: sim },
    );
  }

  // --- Venue binding (repair round 4, P1-4): the venue must be
  //     present, known, and agreed by every source that names one —
  //     the quote, the build, and the canonical record's route.
  //     Rounds 1–3 resolved `build.venue ?? quote.venue`, so a build
  //     silently overrode a disagreeing quote, an unknown string
  //     mapped to no venue program (disabling the swap binding in
  //     validateIntent), and the canonical route was never consulted
  //     at prepare time at all.
  const KNOWN_VENUES = ['curve', 'house'];
  const quoteVenue = quote.venue ?? null;
  const buildVenue = build.venue ?? null;
  if (quoteVenue == null || buildVenue == null) {
    throw new RuntimeError(
      'VENUE_MISSING',
      `the gateway ${quoteVenue == null ? 'quote' : 'build'} names no venue — the route cannot be bound. Refusing; no approval card was written.`,
      { quoteVenue, buildVenue },
    );
  }
  if (!KNOWN_VENUES.includes(quoteVenue) || !KNOWN_VENUES.includes(buildVenue)) {
    throw new RuntimeError(
      'VENUE_UNKNOWN',
      `venue must be one of ${KNOWN_VENUES.join(', ')} — got quote '${quoteVenue}', build '${buildVenue}'. Refusing; no approval card was written.`,
      { quoteVenue, buildVenue },
    );
  }
  if (quoteVenue !== buildVenue) {
    throw new RuntimeError(
      'VENUE_MISMATCH',
      `the gateway quote resolves to venue '${quoteVenue}' but its build was made for venue '${buildVenue}' — the two halves of the trade disagree about the route. Refusing; no approval card was written.`,
      { quoteVenue, buildVenue },
    );
  }
  const venue = buildVenue;
  const routeVenue = token.routeHealth?.venue ?? null;
  if (routeVenue != null && routeVenue !== venue) {
    throw new RuntimeError(
      'ROUTE_VENUE_MISMATCH',
      `the canonical record's route for this token is venue '${routeVenue}' but the gateway built for '${venue}' — the build does not follow the token's canonical route. Refusing; no approval card was written.`,
      { routeVenue, venue },
    );
  }

  const amountInRaw = build.amount_in != null ? String(build.amount_in) : parsed.raw.toString();
  if (build.amount_in != null && BigInt(build.amount_in) !== parsed.raw) {
    throw new RuntimeError(
      'INTENT_AMOUNT_MISMATCH',
      `gateway build amount_in is ${build.amount_in} raw units but the request was ${parsed.raw} (${parsed.ui} UI units) — the build is not the trade that was asked for. Refusing; no approval card was written.`,
    );
  }
  const minimumAmountOutRaw = build.minimum_amount_out != null ? String(build.minimum_amount_out) : String(quote.minimumAmountOut);
  const expectedAmountOutRaw = build.amount_out_expected != null ? String(build.amount_out_expected) : String(quote.amountOut);
  const fees = quote.fees ?? null;
  const priceImpactBps = build.price_impact_bps ?? quote.priceImpactBps ?? null;

  // --- P0-1: decode + validate the intent before anything is carded ---
  let intent;
  let venueProgram = null;
  try {
    intent = await deriveIntent(build.transaction_base64, opts.connection);
    ({ venueProgram } = validateIntent(intent, {
      wallet, mint, side, venue, tokenJson: token,
      amountInRaw, minimumAmountOutRaw,
    }));
  } catch (e) {
    throw asRuntimeError(e);
  }
  if (build.blockhash && build.blockhash !== intent.recentBlockhash) {
    throw new RuntimeError(
      'INTENT_BLOCKHASH_MISMATCH',
      `gateway build claims blockhash ${build.blockhash} but the decoded transaction carries ${intent.recentBlockhash} — the build response contradicts its own bytes. Refusing; no approval card was written.`,
    );
  }

  // --- Settlement-payout model (repair round 4, P1-1) ---
  // A trade may bundle Distributor settles (the gateway bundles them
  // for the wallet AND for the swap counterparty). A settle moves
  // tokens OUT of the distributor vault into the settled holders'
  // accounts, computed on-chain from each holder's entitlement
  // (balance × distribution index − already-settled, per the
  // distributor program) — the gateway build declares the bundle
  // (`bundled: ["distributor-settle"]`) but no payout figure, and the
  // entitlement depends on chain state at execution, so an exact
  // payout cannot be known at prepare time. Round 3's exact sell
  // debit therefore refused every settle-bundled sell (the payout
  // lands in the same ATA as the swap leg), and the vault itself was
  // outside the permitted-effects set. The model below is the
  // bounded, visible alternative the round-3 review prescribed:
  //   * authenticated bound: maxRaw is the distributor vault's token
  //     balance, READ FROM THE CHAIN at prepare time against the
  //     vault the canonical record names (mint/owner fields verified
  //     against the record's distributor state — the same checks the
  //     distributor program itself makes). No payout in this
  //     transaction can exceed what the vault holds;
  //   * visible: the model is a card field of its own (never netted
  //     silently into the swap numbers), and bound into the approval
  //     token (policy version 2);
  //   * enforced at send: the vault's simulated outflow must be
  //     ≤ maxRaw, every recipient must be exactly a settle-named
  //     holder account from the validated intent, and the wallet's
  //     OWN payout is decomposed out of its ATA delta and required
  //     to lie in [minRaw, maxRaw] — the swap legs are then checked
  //     NET of payouts, so a payout can never mask a bad swap.
  //   minRaw is 0: the build states no payout minimum (verified
  //   against live gateway builds — `bundled` carries labels only),
  //   and a settle may legitimately pay exactly 0 (entitlement
  //   already settled). The enforceable floor is therefore the
  //   decomposition itself, not a positive minimum.
  let settlementPayout = null;
  const settleIxs = intent.instructions.filter(
    (ix) => ix.programId === PLATFORM_PROGRAMS.distributor && ix.tag === 3,
  );
  if (settleIxs.length) {
    const sets = tradeAccountSets({ wallet, mint, tokenJson: token });
    const { distState, distVault } = sets.platform;
    if (!distState || !distVault) {
      throw new RuntimeError(
        'SETTLEMENT_UNMODELED',
        'the build bundles distributor settles but the canonical token record names no distributor state/vault to bound them against — refusing: an unauthenticated settlement cannot be modeled. No approval card was written.',
        { mint },
      );
    }
    if (!opts.connection || typeof opts.connection.getAccountInfo !== 'function') {
      throw new RuntimeError(
        'SETTLEMENT_VAULT_UNREADABLE',
        'the build bundles distributor settles but no connection is available to read the distributor vault — the payout bound cannot be authenticated. Refusing; no approval card was written.',
        { vault: distVault },
      );
    }
    const vaultInfo = await opts.connection.getAccountInfo(new PublicKey(distVault));
    const vaultParsed = vaultInfo?.data ? parseTokenAccountData(Buffer.from(vaultInfo.data)) : null;
    if (!vaultParsed || vaultParsed.mint !== mint || vaultParsed.owner !== distState) {
      throw new RuntimeError(
        'SETTLEMENT_VAULT_UNREADABLE',
        `the distributor vault ${distVault} named by the canonical record did not read back as a token account for this mint owned by the distributor state ${distState} — the payout bound cannot be authenticated. Refusing; no approval card was written.`,
        { vault: distVault, state: distState },
      );
    }
    const holderAtas = [...new Set(settleIxs.map((ix) => ix.accounts[2]))].sort();
    const ownAta = settleIxs.some((ix) => ix.accounts[1] === wallet)
      ? associatedTokenAddress(new PublicKey(mint), new PublicKey(wallet), TOKEN_2022_PROGRAM).toBase58()
      : null;
    settlementPayout = {
      vault: distVault,
      state: distState,
      maxRaw: vaultParsed.amount.toString(),
      minRaw: '0',
      holderAtas,
      ownAta,
      settles: settleIxs.length,
    };
  }

  const maxSolDebit = (side === 'buy' ? BigInt(amountInRaw) : 0n) + feeCeiling;
  const validation = {
    mint,
    side,
    venue,
    venueProgram,
    amountUi: parsed.ui,
    amountInRaw,
    expectedAmountOutRaw,
    minimumAmountOutRaw,
    feeCeilingLamports: feeCeiling.toString(),
    maxSolDebitLamports: maxSolDebit.toString(),
    settlementPayout,
  };

  const fingerprint = fingerprintOf(build.transaction_base64);
  const approvalToken = policyFingerprintOf({
    transactionFingerprint: fingerprint,
    mint: validation.mint,
    side: validation.side,
    venue: validation.venue,
    amountInRaw: validation.amountInRaw,
    minimumAmountOutRaw: validation.minimumAmountOutRaw,
    expectedAmountOutRaw: validation.expectedAmountOutRaw,
    maxSolDebitLamports: validation.maxSolDebitLamports,
    feeCeilingLamports: validation.feeCeilingLamports,
    blockhash: intent.recentBlockhash,
    fees,
    priceImpactBps,
    settlementPayout,
  });
  const card = {
    version: 3,
    runtime: 'agentonly-runtime',
    runtimeVersion: RUNTIME_VERSION,
    createdAt: new Date().toISOString(),
    wallet,
    mint,
    symbol: build.symbol ?? quote.symbol ?? token.symbol ?? null,
    side,
    signerType,
    venue,
    amount: parsed.ui,
    amountIn: build.amount_in ?? quote.amountIn ?? null,
    expectedAmountOut: validation.expectedAmountOutRaw,
    minimumAmountOut: validation.minimumAmountOutRaw,
    priceImpactBps,
    fees,
    settlementPayout,
    bundled: build.bundled ?? [],
    eligibility: { status: eligibility.status, reasons: eligibility.reasons ?? [] },
    simulation: {
      status: sim.status,
      layer: sim.layer ?? null,
      unitsConsumed: sim.unitsConsumed ?? null,
      provisional: true,
      note: sim.note ?? 'simulation runs against current chain state and is provisional — state can change before broadcast; the engine is the final arbiter on-chain',
    },
    intent,
    validation,
    blockhash: intent.recentBlockhash,
    maxSolDebitLamports: maxSolDebit.toString(),
    feeCeilingLamports: feeCeiling.toString(),
    lastValidBlockHeight: build.last_valid_block_height,
    transactionBase64: build.transaction_base64,
    fingerprint,
    approvalToken,
  };
  return card;
}

export function formatCard(card) {
  const lines = [];
  lines.push('=== APPROVAL CARD — nothing is signed until you approve this exact card ===');
  lines.push(`  token:     ${card.symbol ?? ''} (${card.mint})`);
  lines.push(`  action:    ${card.side.toUpperCase()} ${card.amount} ${card.side === 'buy' ? 'SOL' : card.symbol ?? 'tokens'} on venue '${card.venue}'`);
  lines.push(`  wallet:    ${card.wallet} (signer: ${card.signerType})`);
  lines.push(`  expected:  ${card.expectedAmountOut} raw units out`);
  lines.push(`  minimum:   ${card.minimumAmountOut} raw units out (slippage bound)`);
  if (card.priceImpactBps != null) lines.push(`  impact:    ${card.priceImpactBps} bps`);
  if (card.fees?.total != null) lines.push(`  fees:      ${card.fees.total} raw units of input${card.fees.note ? ` (${card.fees.note})` : ''}`);
  if (card.bundled?.length) lines.push(`  bundled:   ${card.bundled.join(', ')} (prerequisites inside this one transaction)`);
  lines.push(`  simulated: ${card.simulation.status}${card.simulation.unitsConsumed ? ` (${card.simulation.unitsConsumed} compute units)` : ''} — provisional; the engine is the final arbiter on-chain`);
  lines.push(`  bounds:    max SOL debit ${card.maxSolDebitLamports} lamports (trade amount + fee ceiling ${card.feeCeilingLamports}); enforced against the signed-byte simulation at send time`);
  if (card.settlementPayout) {
    const sp = card.settlementPayout;
    lines.push(`  settlement: this trade bundles ${sp.settles} distributor settle(s). Payouts are computed on-chain from holder entitlements and cannot be known exactly in advance; the approved bound is the distributor vault's balance at prepare time:`);
    lines.push(`    vault ${sp.vault} — total payouts to the ${sp.holderAtas.length} settled holder account(s)${sp.ownAta ? ' (one of them yours)' : ''} must be \u2264 ${sp.maxRaw} raw units, paid only to the settle-named accounts, and the swap legs are checked NET of any payout to you. The bound is part of the approval token.`);
  }
  if (card.intent) {
    lines.push('  validated intent summary (decoded from the transaction bytes at prepare time;');
    lines.push('  re-derived and compared byte-for-byte at send time — this is a summary, not the rules):');
    lines.push(...intentSummaryLines(card.intent));
  }
  lines.push(`  expires:   after block height ${card.lastValidBlockHeight}`);
  lines.push(`  build fingerprint (transaction bytes only): ${card.fingerprint}`);
  lines.push(`  approval token (binds the build AND the economic policy above —`);
  lines.push(`  mint, side, venue, amounts, bounds, blockhash): ${card.approvalToken}`);
  lines.push('To approve, the owner runs:');
  lines.push(`  agentonly-runtime send --file <keypair> --card ${card.cardFile ?? './approval-card.json'} --approve ${card.approvalToken}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

// Current block height, injectable for tests.
export async function currentBlockHeight(connection) {
  return connection.getBlockHeight('confirmed');
}

// Fresh quote, used only for its venue (route) field.
export async function freshQuoteVenue(fetchImpl, card) {
  const q = await gatewayPost(fetchImpl, '/v1/trade/quote', {
    mint: card.mint, side: card.side, amount: Number(card.amount),
  });
  return q.venue ?? null;
}

function deserializeAny(bytes) {
  return serializedTxKind(bytes).versioned
    ? VersionedTransaction.deserialize(bytes)
    : Transaction.from(bytes);
}

function signatureOf(tx) {
  const first = tx.signatures?.[0];
  if (!first) return null;
  // Legacy Transaction.signatures holds {signature, publicKey} pairs;
  // VersionedTransaction.signatures holds raw signature bytes.
  const sig = first instanceof Uint8Array ? first : first.signature;
  return sig ? bs58.encode(sig) : null;
}

async function messageBytesOf(bytes) {
  if (serializedTxKind(bytes).versioned) {
    return Buffer.from(VersionedTransaction.deserialize(bytes).message.serialize());
  }
  return legacyMessageBytes(bytes);
}

function firstSignatureBytes(bytes) {
  // Both formats lead with a shortvec signature count followed by
  // 64-byte signatures; the first signature is the fee payer's.
  const { messageStart, signatureCount } = serializedTxKind(bytes);
  if (signatureCount < 1) return null;
  const sigStart = messageStart - signatureCount * 64;
  return bytes.subarray(sigStart, sigStart + 64);
}

// ---------------------------------------------------------------------------
// External signer allowlist (repair round 4, P1-5)
//
// Rounds 1–3 validated the external signer's PATH SHAPE (a plain
// executable path, no shell) — but the path itself came from the
// agent-supplied --external-signer flag at send time, so anything
// able to influence that flag could have the runtime execute an
// arbitrary local binary with the transaction as its input. The
// signer is now enrolled by the USER, ahead of time, into an
// allowlist the send path merely consults:
//
//   agentonly-runtime signer enroll --path <executable>
//
// records the executable's ABSOLUTE path + the SHA-256 of its bytes
// in a user-owned config file (default ~/.agentonly-runtime/
// signers.json; AGENTONLY_SIGNER_ALLOWLIST overrides the location),
// stored 0600 with the same load hardening as keypair/sidecar files
// (symlink refused, group/world access refused, atomic symlink-safe
// writes). A send refuses when: no allowlist exists
// (SIGNER_ALLOWLIST_MISSING), the named executable is not enrolled
// (SIGNER_NOT_ENROLLED), or the enrolled executable's bytes changed
// since enrollment (SIGNER_INTEGRITY_MISMATCH — re-enroll after any
// deliberate signer update). Enrollment binds the executable only;
// --external-signer-arg values still flow to it, and its returned
// bytes are still validated byte-for-byte (validateExternalSigned).
// ---------------------------------------------------------------------------

export function signerAllowlistPath() {
  return process.env.AGENTONLY_SIGNER_ALLOWLIST
    ?? pathJoin(homedir(), '.agentonly-runtime', 'signers.json');
}

export function readSignerAllowlist() {
  const p = signerAllowlistPath();
  let stat;
  try {
    stat = lstatSync(p);
  } catch {
    return null; // no allowlist yet
  }
  if (stat.isSymbolicLink()) {
    throw new RuntimeError(
      'SIGNER_ALLOWLIST_SYMLINK',
      `refusing to trust a signer allowlist reached through a symlink: ${p} — pass the real path instead`,
    );
  }
  if (!stat.isFile()) {
    throw new RuntimeError('SIGNER_ALLOWLIST_INVALID', `signer allowlist path is not a regular file: ${p}`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new RuntimeError(
      'SIGNER_ALLOWLIST_PERMISSIONS',
      `refusing to trust signer allowlist ${p}: it is accessible by group/others (mode ${(stat.mode & 0o777).toString(8)}). The allowlist decides which binaries may sign — it must be owner-only. Fix it with: chmod 600 ${p}`,
    );
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    throw new RuntimeError('SIGNER_ALLOWLIST_INVALID', `signer allowlist is not readable JSON: ${p} — refusing to guess at its contents`);
  }
  if (!doc || !Array.isArray(doc.signers)) {
    throw new RuntimeError('SIGNER_ALLOWLIST_INVALID', `signer allowlist ${p} has no signers array — refusing to guess at its contents`);
  }
  return doc;
}

export function enrollSigner(executable) {
  assertValidExternalSigner(executable);
  if (!executable.startsWith('/')) {
    throw new RuntimeError(
      'EXTERNAL_SIGNER_INVALID',
      `enrollment requires an absolute executable path (got '${executable}') — the allowlist binds the exact absolute path the send will name`,
      { executable },
    );
  }
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const p = signerAllowlistPath();
  mkdirSync(pathDirname(p), { recursive: true, mode: 0o700 });
  const doc = readSignerAllowlist() ?? { version: 1, signers: [] };
  const entry = { path: executable, sha256, enrolledAt: new Date().toISOString() };
  const idx = doc.signers.findIndex((s) => s.path === executable);
  if (idx >= 0) doc.signers[idx] = entry;
  else doc.signers.push(entry);
  writeFileAtomicSafe(p, JSON.stringify(doc, null, 2) + '\n', 0o600);
  return { ...entry, allowlistPath: p };
}

export function assertSignerEnrolled(executable) {
  const doc = readSignerAllowlist();
  if (!doc) {
    throw new RuntimeError(
      'SIGNER_ALLOWLIST_MISSING',
      `refusing to run an external signer: no signer allowlist exists at ${signerAllowlistPath()}. An external signer must be enrolled by the user before any send can use it: agentonly-runtime signer enroll --path ${executable}`,
      { executable },
    );
  }
  const entry = doc.signers.find((s) => s.path === executable);
  if (!entry) {
    throw new RuntimeError(
      'SIGNER_NOT_ENROLLED',
      `refusing to run external signer ${executable}: it is not enrolled in the signer allowlist (${signerAllowlistPath()}). Enrollment is the user's act, done ahead of time: agentonly-runtime signer enroll --path ${executable}`,
      { executable },
    );
  }
  let current;
  try {
    current = createHash('sha256').update(readFileSync(executable)).digest('hex');
  } catch (e) {
    throw new RuntimeError(
      'SIGNER_INTEGRITY_MISMATCH',
      `refusing to run external signer ${executable}: its bytes could not be read for the enrollment integrity check (${e.message})`,
      { executable },
    );
  }
  if (current !== entry.sha256) {
    throw new RuntimeError(
      'SIGNER_INTEGRITY_MISMATCH',
      `refusing to run external signer ${executable}: its bytes changed since enrollment (enrolled sha256 ${entry.sha256.slice(0, 12)}…, current ${current.slice(0, 12)}…). If the change is deliberate, re-enroll: agentonly-runtime signer enroll --path ${executable}`,
      { executable },
    );
  }
  return entry;
}

// ---------------------------------------------------------------------------
// External signer adapter (P1-a; shell removed in repair round 2, P1-e;
// enrollment required in repair round 4, P1-5)
//
// Protocol: the runtime spawns an ENROLLED EXECUTABLE directly (spawn
// with shell: false — never a shell, so signer text can never become
// shell syntax), passes structured arguments from repeatable
// --external-signer-arg flags, writes the UNSIGNED transaction
// (base64) to its stdin, and reads the SIGNED transaction (base64)
// from its stdout. The returned bytes are validated before anything
// else happens: message bytes byte-identical to the unsigned
// transaction, fee payer unchanged, the wallet's signature slot
// filled. The mandatory signed-byte simulation then applies as usual.
// ---------------------------------------------------------------------------

// --external-signer must name one plain executable path: no spaces, no
// shell metacharacters, and the file must exist and be executable.
// Anything else is refused before any spawn can happen.
export function assertValidExternalSigner(executable) {
  const bad = typeof executable !== 'string'
    || executable.length === 0
    || executable !== executable.trim()
    || /[^A-Za-z0-9/._+\-]/.test(executable);
  if (bad) {
    throw new RuntimeError(
      'EXTERNAL_SIGNER_INVALID',
      `--external-signer must be a single plain executable path with no spaces or shell metacharacters (got '${executable}'). Arguments go in repeatable --external-signer-arg flags — they are passed as structured argv, never through a shell.`,
      { executable },
    );
  }
  let stat;
  try {
    stat = lstatSync(executable);
  } catch {
    throw new RuntimeError('EXTERNAL_SIGNER_INVALID', `external signer executable does not exist: ${executable}`);
  }
  if (!stat.isFile()) {
    throw new RuntimeError('EXTERNAL_SIGNER_INVALID', `external signer path is not a regular file: ${executable}`);
  }
  try {
    accessSync(executable, constants.X_OK);
  } catch {
    throw new RuntimeError('EXTERNAL_SIGNER_INVALID', `external signer file is not executable: ${executable} (chmod +x it, or name an interpreter such as your node binary and pass the script via --external-signer-arg)`);
  }
}

function defaultRunSigner(executable, args, inputBase64) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { shell: false, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(out);
      else rejectPromise(new Error(`external signer exited with code ${code}`));
    });
    child.stdin.write(inputBase64);
    child.stdin.end();
  });
}

// opts: { args?: string[], runCommand?: (executable, args, inputB64) => Promise<string> }
export async function runExternalSigner(executable, unsignedBase64, opts = {}) {
  const args = opts.args ?? [];
  assertValidExternalSigner(executable);
  // Repair round 4, P1-5: path shape is not trust. The executable
  // must be enrolled (path + SHA-256 of its bytes) in the user's
  // signer allowlist, and its bytes must still match the enrollment.
  assertSignerEnrolled(executable);
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new RuntimeError('EXTERNAL_SIGNER_INVALID', 'external signer arguments must be strings (repeatable --external-signer-arg)');
  }
  const run = opts.runCommand ?? defaultRunSigner;
  let stdout;
  try {
    stdout = await run(executable, args, unsignedBase64);
  } catch (e) {
    throw new RuntimeError('EXTERNAL_SIGNER_FAILED', `external signer failed: ${e.message}`);
  }
  const signedB64 = String(stdout ?? '').trim();
  if (!signedB64) {
    throw new RuntimeError('EXTERNAL_SIGNER_FAILED', 'external signer produced no output — expected the signed transaction (base64) on stdout');
  }
  let signedBytes;
  try {
    signedBytes = Buffer.from(signedB64, 'base64');
    deserializeAny(signedBytes);
  } catch {
    throw new RuntimeError('EXTERNAL_SIGNER_FAILED', 'external signer output is not a decodable serialized transaction');
  }
  return signedBytes;
}

export async function validateExternalSigned(unsignedBytes, signedBytes, wallet) {
  const [unsignedMsg, signedMsg] = await Promise.all([
    messageBytesOf(unsignedBytes),
    messageBytesOf(signedBytes),
  ]);
  if (!unsignedMsg.equals(signedMsg)) {
    throw new RuntimeError(
      'EXTERNAL_SIGNER_MISMATCH',
      'the external signer returned a transaction whose message bytes differ from the unsigned transaction it was given — it signed something other than the approved build. Refusing.',
    );
  }
  let signedIntent;
  try {
    signedIntent = await deriveIntent(signedBytes);
  } catch (e) {
    throw asRuntimeError(e);
  }
  if (signedIntent.feePayer !== wallet) {
    throw new RuntimeError(
      'EXTERNAL_SIGNER_MISMATCH',
      `the external signer's transaction has fee payer ${signedIntent.feePayer}, not the wallet ${wallet}. Refusing.`,
    );
  }
  const sig = firstSignatureBytes(signedBytes);
  if (!sig || sig.every((b) => b === 0)) {
    throw new RuntimeError(
      'EXTERNAL_SIGNER_MISMATCH',
      'the external signer returned the transaction without a signature in the fee-payer slot. Refusing.',
    );
  }
}

// ---------------------------------------------------------------------------
// Signed-byte simulation + economic bounds (P0-1d, P0-2a)
// ---------------------------------------------------------------------------

// Accounts whose pre/post states the economic check reads: the wallet
// itself (SOL delta) and its associated token accounts for the mint
// under both token programs (token delta). Full-effect accounting
// (sendCard) widens this to every writable account in the intent plus
// the canonical pool set; this helper stays the minimal core.
export function economicAccountAddresses(wallet, mintStr) {
  const owner = new PublicKey(wallet);
  const mint = new PublicKey(mintStr);
  const addrs = [
    wallet,
    associatedTokenAddress(mint, owner, TOKEN_2022_PROGRAM).toBase58(),
    associatedTokenAddress(mint, owner, TOKEN_PROGRAM).toBase58(),
  ];
  return [...new Set(addrs)];
}

function normalizeAccountState(acct) {
  if (!acct) return null;
  const data = acct.data;
  let buf;
  if (Buffer.isBuffer(data)) buf = data;
  else if (data instanceof Uint8Array) buf = Buffer.from(data);
  else if (Array.isArray(data) && typeof data[0] === 'string') buf = Buffer.from(data[0], data[1] === 'base64' ? 'base64' : 'utf8');
  else if (typeof data === 'string') buf = Buffer.from(data, 'base64');
  else buf = Buffer.alloc(0);
  const owner = !acct.owner
    ? null
    : (typeof acct.owner === 'string' ? acct.owner : (acct.owner.toBase58?.() ?? null));
  return { lamports: acct.lamports ?? 0, data: buf, owner };
}

async function fetchAccountStates(connection, fetchImpl, rpcUrl, addresses) {
  if (connection && typeof connection.getMultipleAccountsInfo === 'function') {
    const infos = await connection.getMultipleAccountsInfo(
      addresses.map((a) => new PublicKey(a)), 'confirmed',
    );
    return (infos ?? []).map(normalizeAccountState);
  }
  const result = await rpcCall(fetchImpl, rpcUrl, 'getMultipleAccounts', [
    addresses, { encoding: 'base64', commitment: 'confirmed' },
  ]);
  return (result?.value ?? []).map(normalizeAccountState);
}

function normalizeSimValue(value) {
  if (!value) throw new RuntimeError('RPC_ERROR', 'simulation returned no value');
  return {
    err: value.err ?? null,
    unitsConsumed: value.unitsConsumed ?? null,
    logs: value.logs ?? [],
    accounts: Array.isArray(value.accounts) ? value.accounts.map(normalizeAccountState) : null,
  };
}

// Simulates the EXACT signed bytes. Test-double connections (plain
// objects implementing simulateTransaction, no web3 internals) are
// honored directly; a real Connection is used in its versioned typed
// form for versioned transactions, and via raw JSON-RPC for legacy
// transactions — web3.js's legacy overload would rebase the blockhash
// and silently stop simulating the approved bytes.
export async function simulateSignedBytes({ connection, fetchImpl, rpcUrl, signedBytes, signedTx, addresses }) {
  const isDouble = connection
    && typeof connection.simulateTransaction === 'function'
    && typeof connection._rpcRequest !== 'function';
  if (isDouble) {
    const res = await connection.simulateTransaction(signedTx, {
      sigVerify: true,
      replaceRecentBlockhash: false,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses },
    });
    return normalizeSimValue(res?.value ?? res);
  }
  if (signedTx?.message) {
    const res = await connection.simulateTransaction(signedTx, {
      sigVerify: true,
      replaceRecentBlockhash: false,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses },
    });
    return normalizeSimValue(res?.value ?? res);
  }
  const result = await rpcCall(fetchImpl, rpcUrl, 'simulateTransaction', [
    signedBytes.toString('base64'),
    {
      encoding: 'base64',
      sigVerify: true,
      replaceRecentBlockhash: false,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses },
    },
  ]);
  return normalizeSimValue(result?.value);
}

export function parseTokenAccountData(data) {
  if (!data || data.length < 72) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return {
    mint: bs58.encode(buf.subarray(0, 32)),
    owner: bs58.encode(buf.subarray(32, 64)),
    amount: buf.readBigUInt64LE(64),
  };
}

export function computeDeltas(preStates, postStates, addresses, wallet, mint) {
  const idx = new Map(addresses.map((a, i) => [a, i]));
  const wPre = preStates[idx.get(wallet)];
  const wPost = postStates[idx.get(wallet)];
  const solDelta = (wPost?.lamports ?? 0) - (wPre?.lamports ?? 0);
  let tokenDelta = 0n;
  for (const a of addresses) {
    if (a === wallet) continue;
    const pre = parseTokenAccountData(preStates[idx.get(a)]?.data);
    const post = parseTokenAccountData(postStates[idx.get(a)]?.data);
    const matches = (x) => x && x.mint === mint && x.owner === wallet;
    if (matches(pre) || matches(post)) {
      tokenDelta += (matches(post) ? post.amount : 0n) - (matches(pre) ? pre.amount : 0n);
    }
  }
  return { solDelta, tokenDelta };
}

// ---------------------------------------------------------------------------
// Full-effect accounting (repair round 2, P0-1a) + fail-closed simulation
// state (P0-2)
//
// Round 1 checked only the wallet's SOL delta and the card mint's ATA
// deltas. That left a hole: a build could bundle a legitimate swap with
// an extra transfer and still pass. Now the simulation is requested
// for EVERY writable account the transaction touches (plus the fee
// payer and the canonical pool set), and every account's lamport /
// token-balance change must be explainable by the approved trade.
// ---------------------------------------------------------------------------

// Per-account effects from aligned pre/post states. Token deltas are
// only read from accounts OWNED by a token program — program accounts
// (pool PDAs, hook state) change their data during a trade by design;
// their lamports are what accounting watches.
export function computeEffects(preStates, postStates, addresses) {
  const effects = new Map();
  addresses.forEach((addr, i) => {
    const pre = preStates[i];
    const post = postStates[i];
    const lamportDelta = (post?.lamports ?? 0) - (pre?.lamports ?? 0);
    let tokenDelta = 0n;
    let tokenMint = null;
    const ownerProgram = post?.owner ?? pre?.owner;
    if (ownerProgram === TOKEN_PROGRAM || ownerProgram === TOKEN_2022_PROGRAM) {
      const preTok = parseTokenAccountData(pre?.data);
      const postTok = parseTokenAccountData(post?.data);
      if (preTok || postTok) {
        tokenMint = (postTok ?? preTok).mint;
        tokenDelta = (postTok?.amount ?? 0n) - (preTok?.amount ?? 0n);
      }
    }
    effects.set(addr, {
      lamportDelta, tokenDelta, tokenMint,
      preExists: !!pre, postExists: !!post,
    });
  });
  return effects;
}

// P0-2: missing, partial, or malformed simulation state STOPS the
// send. There is no pass-through: if any expected account's post-state
// is absent, truncated away, or undecodable where token data is
// expected, the send refuses with SIMULATION_STATE_MISSING.
export function assertSimulationStatesComplete(preStates, postStates, addresses, tokenAccountAddrs) {
  const refuse = (why) => {
    throw new RuntimeError(
      'SIMULATION_STATE_MISSING',
      `refusing to broadcast: the mandatory signed-byte simulation did not return complete, decodable account states — ${why}. Delta verification is not optional; nothing was broadcast. Re-prepare and retry the send.`,
    );
  };
  if (!Array.isArray(preStates) || preStates.length !== addresses.length) {
    refuse(`pre-trade account states are incomplete (${Array.isArray(preStates) ? preStates.length : 'none'} of ${addresses.length} accounts)`);
  }
  if (!Array.isArray(postStates) || postStates.length !== addresses.length) {
    refuse(`the simulation returned ${Array.isArray(postStates) ? postStates.length : 'no'} account states for ${addresses.length} requested accounts`);
  }
  addresses.forEach((addr, i) => {
    const pre = preStates[i];
    const post = postStates[i];
    if (pre && !post) {
      refuse(`account ${addr} existed before the trade but has no post-simulation state`);
    }
    if (!post) return;
    const wasTokenData = pre && pre.data.length >= 72 && (pre.owner === TOKEN_PROGRAM || pre.owner === TOKEN_2022_PROGRAM);
    // Repair round 3, P1-4: a PRESENT requested token account whose
    // post-simulation data is empty or short is malformed — it is NOT
    // a zero balance. The round-2 check required length > 0 before
    // refusing, so an account emptied to zero bytes read as "no
    // balance change" and passed. Token data is decodable or the send
    // refuses; there is no third state.
    if ((tokenAccountAddrs.has(addr) || wasTokenData) && !parseTokenAccountData(post.data)) {
      refuse(`account ${addr} is present in the post-simulation states with ${post.data.length} bytes of data — not a decodable token account`);
    }
  });
}

// The permitted-effects set is derived from the card + canonical
// record (tradeAccountSets): the wallet, the wallet's own ATAs for the
// card mint, the wallet's own wrapped-SOL ATA (its lamports fold into
// the wallet's aggregate SOL delta in sendCard — wrapped SOL is the
// wallet's own SOL in transit, and a leftover balance is the wallet's
// own position), and the canonical pool accounts (pool, its vaults).
// Any OTHER account whose lamports or token balance move refuses with
// UNEXPECTED_EFFECT; the pool side must additionally behave like the
// trade's counterparty (it cannot gain tokens on a buy, cannot pay out
// more SOL than the approved input, etc.). The wallet's own aggregate
// bounds are enforced separately by enforceEconomicBounds.
export function enforceFullEffects(card, effects, sets, settlement = null) {
  const unexpected = (addr, what) => {
    throw new RuntimeError(
      'UNEXPECTED_EFFECT',
      `refusing to broadcast: the signed-byte simulation moves value somewhere the card does not approve — ${what} (account ${addr}). The build does more than the approved trade. Discard it and prepare again.`,
      { account: addr },
    );
  };
  const sp = card.validation?.settlementPayout ?? null;
  for (const [addr, eff] of effects) {
    // The wallet's WSOL ATA may move its wrapped-SOL balance — that
    // value is accounted in lamports against the wallet's aggregate.
    const ownWsol = addr === sets.wsolAta && eff.tokenMint === WSOL_MINT;
    if (eff.tokenDelta !== 0n && eff.tokenMint !== card.mint && !ownWsol) {
      unexpected(addr, `a token balance for mint ${eff.tokenMint} changes by ${eff.tokenDelta} — not the card mint ${card.mint}`);
    }
    if (!sets.permitted.has(addr) && (eff.lamportDelta !== 0 || eff.tokenDelta !== 0n)) {
      unexpected(addr, `an account outside the wallet / pool set changes by ${eff.lamportDelta} lamports and ${eff.tokenDelta} tokens`);
    }
  }
  for (const ata of sets.walletAtas) {
    const eff = effects.get(ata);
    if (!eff) continue;
    if (card.side === 'buy' && eff.tokenDelta < 0n) {
      unexpected(ata, 'the wallet\u2019s own token account is DEBITED on a buy');
    }
    // Repair round 4, P1-1: on a sell WITH a modeled settlement, the
    // wallet's own settlement account may be net-credited (its payout
    // can exceed the sold amount) — that credit is the modeled payout,
    // decomposed and bounded in enforceEconomicBounds. The blanket
    // no-credit rule still applies to every other wallet account.
    if (card.side === 'sell' && eff.tokenDelta > 0n && !(sp && ata === sp.ownAta)) {
      unexpected(ata, 'the wallet\u2019s own token account is CREDITED on a sell');
    }
    if (eff.lamportDelta < 0) {
      unexpected(ata, 'the wallet\u2019s own token account pays lamports out — only ATA-creation rent may arrive in it');
    }
  }
  const amountIn = BigInt(card.validation.amountInRaw);
  const expectedOut = BigInt(card.validation.expectedAmountOutRaw);
  const feeCeiling = BigInt(card.feeCeilingLamports);
  for (const addr of sets.poolAccounts) {
    const eff = effects.get(addr);
    if (!eff) continue;
    if (card.side === 'buy') {
      if (eff.lamportDelta < 0) unexpected(addr, 'a pool account LOSES SOL on a buy — it is not behaving as the trade counterparty');
      if (BigInt(eff.lamportDelta) > amountIn) unexpected(addr, `a pool account gains ${eff.lamportDelta} lamports, more than the approved trade input of ${amountIn}`);
      if (eff.tokenDelta > 0n) unexpected(addr, 'a pool account GAINS the card token on a buy — value appearing from nowhere');
    } else {
      if (eff.lamportDelta > 0) unexpected(addr, 'a pool account GAINS SOL on a sell — it is not behaving as the trade counterparty');
      if (BigInt(-eff.lamportDelta) > expectedOut + feeCeiling) unexpected(addr, `a pool account pays out ${-eff.lamportDelta} lamports, beyond the expected proceeds plus the fee ceiling`);
      if (eff.tokenDelta < 0n) unexpected(addr, 'a pool account LOSES the card token on a sell — value disappearing to nowhere');
    }
  }

  // Settlement effects (repair round 4, P1-1). The distributor vault
  // and the settle-named recipient accounts were added to the
  // permitted set by sendCard (from the card's policy-bound model);
  // here their movements are held to the model exactly:
  //   * the vault may only LOSE tokens (payouts flow out; a trade
  //     transaction never routes fees INTO the distributor vault —
  //     funding happens through distribute(), a different
  //     instruction that is not part of a trade), its lamports never
  //     move, and the total outflow is ≤ the card's maxRaw (the
  //     vault balance authenticated at prepare time);
  //   * every non-pool recipient account gains between 0 and maxRaw
  //     (recipients that are also pool vaults are covered by the pool
  //     rules above plus the aggregate outflow bound);
  //   * the measured total outflow must equal the vault's token
  //     delta the caller decomposed — a caller that cannot measure
  //     it has no business approving the send.
  if (sp) {
    if (!settlement || typeof settlement.totalPayoutRaw !== 'bigint') {
      throw new RuntimeError(
        'SETTLEMENT_EFFECT_UNMEASURED',
        'refusing to broadcast: this card models a settlement payout but the send did not measure the vault\u2019s simulated outflow — the payout bound cannot be enforced. Discard the card and prepare again.',
      );
    }
    const maxRaw = BigInt(sp.maxRaw);
    const vaultEff = effects.get(sp.vault);
    if (!vaultEff) {
      throw new RuntimeError(
        'SETTLEMENT_EFFECT_UNMEASURED',
        `refusing to broadcast: the distributor vault ${sp.vault} has no simulated account state — the payout bound cannot be enforced.`,
      );
    }
    if (vaultEff.tokenDelta > 0n) {
      unexpected(sp.vault, 'the distributor vault GAINS tokens during the trade — settlement payouts only flow out of it');
    }
    if (-vaultEff.tokenDelta !== settlement.totalPayoutRaw) {
      throw new RuntimeError(
        'SETTLEMENT_EFFECT_UNMEASURED',
        'refusing to broadcast: the measured settlement outflow does not match the distributor vault\u2019s simulated token delta — internal accounting disagreement; the payout bound cannot be enforced.',
      );
    }
    if (settlement.totalPayoutRaw > maxRaw) {
      throw new RuntimeError(
        'SETTLEMENT_PAYOUT_EXCEEDS_MAX',
        `refusing to broadcast: the signed-byte simulation pays out ${settlement.totalPayoutRaw} raw units from the distributor vault, beyond the card's approved settlement bound of ${maxRaw} (the vault balance authenticated at prepare time). The approval does not cover this payout. Discard the card and prepare again.`,
        { totalPayoutRaw: settlement.totalPayoutRaw.toString(), maxRaw: sp.maxRaw },
      );
    }
    if (vaultEff.lamportDelta !== 0) {
      unexpected(sp.vault, 'the distributor vault\u2019s lamports change — only its token balance may move, and only outward');
    }
    for (const holderAta of sp.holderAtas) {
      if (holderAta === sp.ownAta) continue; // the wallet's own: decomposed in enforceEconomicBounds
      if (sets.poolAccounts.includes(holderAta)) continue; // pool vaults: pool rules + aggregate bound
      // An account the venue swap itself names (the curve pool's
      // base vault — a settlement recipient in its counterparty
      // form) is swap-driven: its delta mixes the swap leg with the
      // payout, and the payout component is bounded by the aggregate
      // outflow bound above. The per-recipient bound below is for
      // accounts whose ONLY role in the trade is receiving a payout.
      if (settlement.venueAccounts?.has(holderAta)) continue;
      const eff = effects.get(holderAta);
      if (!eff) continue;
      if (eff.tokenDelta < 0n || eff.tokenDelta > maxRaw) {
        unexpected(holderAta, `a settlement recipient\u2019s token balance changes by ${eff.tokenDelta} — outside the modeled payout bound [0, ${maxRaw}]`);
      }
      if (eff.lamportDelta < 0) {
        unexpected(holderAta, 'a settlement recipient pays lamports out');
      }
    }
  }
}

export function enforceEconomicBounds(card, deltas) {
  const { solDelta, tokenDelta } = deltas;
  const maxDebit = BigInt(card.maxSolDebitLamports);
  if (BigInt(solDelta) < -maxDebit) {
    throw new RuntimeError(
      'ECONOMIC_BOUND_EXCEEDED',
      `the signed-byte simulation moves ${-solDelta} lamports OUT of the wallet, beyond the card's ` +
        `maximum SOL debit of ${maxDebit} (trade amount + fee ceiling ${card.feeCeilingLamports}). ` +
        `Refusing — the build does more than the card approved. Re-prepare if the bound itself is wrong.`,
      { solDelta: String(solDelta) },
    );
  }
  const minOut = BigInt(card.validation.minimumAmountOutRaw);
  const sp = card.validation.settlementPayout ?? null;
  if (card.side === 'buy') {
    if (tokenDelta < minOut) {
      throw new RuntimeError(
        'ECONOMIC_BOUND_EXCEEDED',
        `the signed-byte simulation credits only ${tokenDelta} raw units of the token, below the card's ` +
          `minimum out of ${minOut}. Refusing — the build does less than the card approved.`,
        { tokenDelta: tokenDelta.toString() },
      );
    }
    // Repair round 4, P1-1: on a settle-bundled buy, the wallet's ATA
    // credit mixes the swap's output with its settlement payout — a
    // payout drawn from the distributor vault (other holders' accrued
    // fees) must not be allowed to MASK a swap that pays less than
    // the approved minimum. The swap leg is therefore checked NET of
    // the transaction's total settlement payouts (measured from the
    // vault's outflow): the most payout the wallet itself could have
    // received is the total, so netting the total is the conservative
    // direction — the guarantee is that the SWAP alone met the
    // minimum. (Documented edge: if the counterparty's own payout is
    // large and the swap output sits within that payout of the
    // minimum, the send refuses although the trade itself was
    // legitimate — fail-closed by design; re-preparing does not
    // change chain state, so the refusal names the cause.)
    if (sp) {
      const totalPayout = deltas.settlement?.totalPayoutRaw;
      if (typeof totalPayout !== 'bigint') {
        throw new RuntimeError(
          'SETTLEMENT_EFFECT_UNMEASURED',
          'refusing to broadcast: this card models a settlement payout but the send did not measure the vault\u2019s simulated outflow — the swap leg cannot be checked net of payouts.',
        );
      }
      if (tokenDelta - totalPayout < minOut) {
        throw new RuntimeError(
          'ECONOMIC_BOUND_EXCEEDED',
          `the signed-byte simulation credits ${tokenDelta} raw units of the token, of which up to ${totalPayout} are distributor settlement payouts — net of payouts the swap leg credits only ${tokenDelta - totalPayout}, below the card's minimum out of ${minOut}. Refusing — a settlement payout may not mask a swap that under-delivers.`,
          { tokenDelta: tokenDelta.toString(), totalPayoutRaw: totalPayout.toString() },
        );
      }
    }
  } else {
    const amountRaw = BigInt(card.validation.amountInRaw);
    // Repair round 3, P0-2: the sell debit must be EXACT. Round 2
    // refused only an UNDER-debit (tokenDelta > -amountRaw), so a
    // build whose simulation debited MORE than the approved amount —
    // 200 tokens against an approved 100-token sell — passed. The
    // simulated wallet token delta must equal -amountInRaw exactly;
    // both directions refuse. No tolerance is granted: a build whose
    // net wallet token movement is anything other than the approved
    // sell amount is not the trade the owner approved.
    //
    // Repair round 4, P1-1: when the card models a settlement payout,
    // exactness applies to the SWAP LEG, with the payout decomposed
    // out — never netted silently. The wallet's ATA has exactly two
    // flows on a sell (the swap debit and its own settle payout), so
    // the decomposition is exact arithmetic: ownPayout = tokenDelta
    // + amountInRaw. It must lie inside the card's modeled bound
    // [minRaw, maxRaw]; the remainder of this check then sees the
    // pure swap leg. A card WITHOUT a settlement model keeps the
    // round-3 rule untouched — any bundled payout on an unmodeled
    // card still refuses, fail-closed.
    if (sp) {
      const ownPayout = tokenDelta + amountRaw;
      const maxRaw = BigInt(sp.maxRaw);
      const minRaw = BigInt(sp.minRaw ?? '0');
      if (ownPayout < minRaw || ownPayout > maxRaw) {
        throw new RuntimeError(
          'ECONOMIC_BOUND_EXCEEDED',
          `the signed-byte simulation decomposes the wallet's token delta (${tokenDelta}) into the approved sell debit (${amountRaw}) plus a settlement payout of ${ownPayout} — outside the card's modeled settlement bound [${minRaw}, ${maxRaw}]. Refusing — the payout is not the one the card approved.`,
          { tokenDelta: tokenDelta.toString(), ownPayoutRaw: ownPayout.toString() },
        );
      }
    } else if (tokenDelta !== -amountRaw) {
      throw new RuntimeError(
        'ECONOMIC_BOUND_EXCEEDED',
        tokenDelta < -amountRaw
          ? `the signed-byte simulation debits ${-tokenDelta} raw units of the token, MORE than the approved sell amount of ${amountRaw}. Refusing — the build takes more than the card approved.`
          : `the signed-byte simulation debits only ${-tokenDelta} raw units of the token, less than the approved sell amount of ${amountRaw}. Refusing.`,
        { tokenDelta: tokenDelta.toString() },
      );
    }
    const floor = minOut - BigInt(card.feeCeilingLamports);
    if (BigInt(solDelta) < floor) {
      throw new RuntimeError(
        'ECONOMIC_BOUND_EXCEEDED',
        `the signed-byte simulation credits only ${solDelta} lamports of SOL, below the card's minimum ` +
          `out of ${minOut} less the fee ceiling (floor ${floor}). Refusing.`,
        { solDelta: String(solDelta) },
      );
    }
  }
}

// Signs the card's exact transaction (locally, or via the external
// signer) and either dry-run verifies it or broadcasts it. Every refusal
// happens BEFORE broadcast; the mandatory simulation of the exact signed
// bytes happens before sendRawTransaction can ever be called.
//
// opts: { keypair?, external? { address, command, runCommand? },
//         card, approve, dryRun, connection, fetchImpl, rpcUrl?,
//         skipVenueCheck?, tokenJson? }
export async function sendCard(opts) {
  const { card, approve } = opts;
  const connection = opts.connection;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const rpcUrl = opts.rpcUrl ?? connection?.rpcEndpoint ?? RPC_URL;

  assertSignerSupported(opts.signerType ?? card.signerType);

  const localKeypair = opts.keypair ?? null;
  const external = opts.external ?? null;
  const signerAddress = localKeypair
    ? localKeypair.publicKey.toBase58()
    : external?.address;
  if (!signerAddress) {
    throw new RuntimeError('INVALID_ARGS', 'send requires a signer: a local keypair (--file) or an external signer (--signer-type external --external-signer <executable-path> --wallet <address>)');
  }

  // 1. Approval must name THIS card's approval token. Since repair
  //    round 3 (P0-1) the token binds the transaction bytes AND the
  //    card's full economic policy — see policyFingerprintOf. The
  //    step-6 recompute is what enforces the binding; this step checks
  //    the owner actually approved the token this card carries.
  if (!approve || approve !== card.approvalToken) {
    throw new RuntimeError(
      'APPROVAL_MISMATCH',
      `refusing to sign: --approve does not match this card's approval token. ` +
        `The token binds one wallet, one mint, one side, one venue, one amount, ` +
        `the full economic bounds, and one simulated build. Re-read the card and ` +
        `approve its exact token: ${card.approvalToken}`,
    );
  }
  if (fingerprintOf(card.transactionBase64) !== card.fingerprint) {
    throw new RuntimeError(
      'CARD_TAMPERED',
      'refusing to sign: the transaction in this card does not hash to the card fingerprint — the card was altered after preparation. Discard it and prepare again.',
    );
  }

  // 2. The card must belong to the signing wallet.
  if (card.wallet !== signerAddress) {
    throw new RuntimeError(
      'WALLET_MISMATCH',
      `refusing to sign: this card is for wallet ${card.wallet}, but the signer is ${signerAddress}. A card is only signable by its own wallet.`,
    );
  }

  // 3. The card must carry a passed simulation from preparation time.
  if (card.simulation?.status !== 'passed') {
    throw new RuntimeError(
      'UNSIMULATED_BUILD',
      'refusing to sign: this card does not carry a passed gateway simulation. Unsimulated builds are never signed — prepare again.',
    );
  }

  // 4. Expiry: rebuild, not retry.
  const height = await currentBlockHeight(connection);
  if (height > card.lastValidBlockHeight) {
    throw new RuntimeError(
      'BUILD_EXPIRED',
      `refusing to sign: this build expired — current block height ${height} is past ` +
        `its last valid block height ${card.lastValidBlockHeight}. Rebuild, not retry: ` +
        `run prepare again for a fresh build and a fresh approval.`,
      { currentBlockHeight: height, lastValidBlockHeight: card.lastValidBlockHeight },
    );
  }

  // 5. Route check: if the venue moved since preparation (e.g. the token
  //    graduated), the prepared route is stale and must be rebuilt.
  //    Repair round 4, P1-4: the check is strict in both directions —
  //    a fresh quote that names NO venue, or a venue the runtime does
  //    not know, refuses just as a changed venue does. (A card that
  //    itself names no venue still falls through to step 5b's
  //    CANONICAL_BINDING_MISSING, which is the more precise refusal.)
  if (!opts.skipVenueCheck) {
    const venueNow = await freshQuoteVenue(fetchImpl, card);
    if (card.venue && venueNow !== card.venue) {
      throw new RuntimeError(
        'VENUE_CHANGED',
        `refusing to sign: the route changed since this card was prepared — the token ` +
          `now resolves to venue '${venueNow ?? '(none named)'}', but the card was built for '${card.venue}' ` +
          `(this is what graduation does). Discard the card, run prepare again against ` +
          `the new route, and approve the fresh card.`,
        { cardVenue: card.venue, currentVenue: venueNow },
      );
    }
  }

  // 5b. Canonical binding in the CORE send path (repair round 3,
  //     P1-2): the card must name its venue, and the canonical token
  //     record must be present — supplied by the caller or fetched
  //     here (fail closed: fetchTokenRecord refuses on any fetch
  //     failure). Round 2 enforced this only in the CLI, so a direct
  //     sendCard caller could skip pool binding entirely; the core
  //     library now refuses on its own.
  if (!card.venue) {
    throw new RuntimeError(
      'CANONICAL_BINDING_MISSING',
      'refusing to sign: this card names no venue. The core send path requires the card to be bound to the venue it was built for and to the canonical token record for its mint. Discard it and prepare again.',
    );
  }
  const tokenJson = opts.tokenJson ?? (await fetchTokenRecord(fetchImpl, card.mint));
  // Canonical route agreement (repair round 4, P1-4): when the
  // canonical record names the token's route, the card's venue must
  // equal it — the same agreement prepare now requires, re-checked
  // at send time against the freshly fetched record.
  const routeVenue = tokenJson?.routeHealth?.venue ?? null;
  if (routeVenue != null && routeVenue !== card.venue) {
    throw new RuntimeError(
      'ROUTE_VENUE_MISMATCH',
      `refusing to sign: the canonical record's route for this token is venue '${routeVenue}', but this card was built for '${card.venue}'. Discard the card and prepare again against the canonical route.`,
      { cardVenue: card.venue, routeVenue },
    );
  }

  // 6. Intent: re-derive from the card's bytes and deep-compare with the
  //    intent stored at prepare time; re-validate against the card's own
  //    claims; cross-check every friendly field the owner read against
  //    the validated record. Any disagreement refuses before signing.
  if (!card.intent || !card.validation) {
    throw new RuntimeError(
      'INTENT_CARD_MISMATCH',
      'refusing to sign: this card carries no validated intent (it predates runtime 1.1 or was stripped). Discard it and prepare again.',
    );
  }
  let derived;
  try {
    derived = await deriveIntent(card.transactionBase64, connection);
    if (!intentsEqual(derived, card.intent)) {
      throw new RuntimeError(
        'INTENT_CARD_MISMATCH',
        'refusing to sign: the intent re-derived from this card\u2019s transaction bytes does not match the intent stored on the card — the card was altered after preparation, or its bytes never matched its description. Discard it and prepare again.',
      );
    }
    validateIntent(derived, {
      wallet: card.wallet,
      mint: card.mint,
      side: card.side,
      venue: card.venue ?? null,
      tokenJson,
      amountInRaw: card.validation?.amountInRaw,
      minimumAmountOutRaw: card.validation?.minimumAmountOutRaw,
    });
  } catch (e) {
    throw asRuntimeError(e);
  }
  // Settlement model agreement (repair round 4, P1-1): the settles in
  // the re-derived intent must be exactly the set the card's
  // policy-bound model covers — same recipients, derived from the
  // card's own bytes. A model naming recipients the transaction does
  // not settle (or a transaction settling recipients the model does
  // not name) means the approval and the bytes describe different
  // payouts.
  {
    const model = card.validation.settlementPayout ?? null;
    const settleIxs = derived.instructions.filter(
      (ix) => ix.programId === PLATFORM_PROGRAMS.distributor && ix.tag === 3,
    );
    const actualHolders = [...new Set(settleIxs.map((ix) => ix.accounts[2]))].sort();
    const modeledHolders = model ? [...model.holderAtas].sort() : [];
    if (stableStringify(actualHolders) !== stableStringify(modeledHolders)) {
      throw new RuntimeError(
        'SETTLEMENT_MODEL_MISMATCH',
        `refusing to sign: the transaction settles payouts to [${actualHolders.join(', ') || 'none'}] but the card's settlement model covers [${modeledHolders.join(', ') || 'none'}] — the approval and the bytes describe different payouts. Discard the card and prepare again.`,
        { actualHolders, modeledHolders },
      );
    }
  }
  const v = card.validation;
  const friendlyMismatch =
    v.mint !== card.mint
    || v.side !== card.side
    || (v.venue ?? null) !== (card.venue ?? null)
    || v.amountUi !== card.amount
    || v.minimumAmountOutRaw !== (card.minimumAmountOut != null ? String(card.minimumAmountOut) : null)
    || v.expectedAmountOutRaw !== (card.expectedAmountOut != null ? String(card.expectedAmountOut) : null)
    || v.maxSolDebitLamports !== (card.maxSolDebitLamports ?? null)
    || v.feeCeilingLamports !== (card.feeCeilingLamports ?? null)
    || stableStringify(canonicalSettlementModel(v.settlementPayout ?? null))
      !== stableStringify(canonicalSettlementModel(card.settlementPayout ?? null))
    || card.blockhash !== derived.recentBlockhash;
  if (friendlyMismatch) {
    throw new RuntimeError(
      'INTENT_CARD_MISMATCH',
      'refusing to sign: the card\u2019s displayed fields (amount, minimum out, bounds, settlement model, blockhash) do not match its validated intent record — the card was altered after preparation. Discard it and prepare again.',
    );
  }
  // Policy binding (repair round 3, P0-1): the friendly cross-check
  // above compares card fields against EACH OTHER, so editing the
  // policy and its displayed copies consistently passes it. The
  // approval token is the anchor: recompute the policy fingerprint
  // from the card's validated record + blockhash + build fingerprint
  // and require it to equal the token the owner approved. Any
  // post-approval alteration of any bound breaks it here, before
  // signing, regardless of how consistently the card was edited.
  if (cardPolicyFingerprint(card) !== card.approvalToken) {
    throw new RuntimeError(
      'POLICY_BINDING_MISMATCH',
      'refusing to sign: the card\u2019s economic policy does not hash to its approval token — a policy field (mint, side, venue, amount, minimum out, expected out, max debit, fee ceiling, blockhash, displayed fees, price impact, settlement model) was altered after approval, whether or not the displayed fields were edited to match. The approval no longer covers this policy. Discard the card and prepare again.',
    );
  }

  // 7. Sign the EXACT bytes from the card — locally, or via the external
  //    signer whose returned bytes are validated first.
  const unsignedBytes = Buffer.from(card.transactionBase64, 'base64');
  const isVersioned = serializedTxKind(unsignedBytes).versioned;
  let signedBytes;
  let signedTx;
  let signature;
  if (external) {
    signedBytes = await runExternalSigner(external.command, card.transactionBase64, {
      args: external.args ?? [],
      runCommand: external.runCommand,
    });
    await validateExternalSigned(unsignedBytes, signedBytes, signerAddress);
    signedTx = deserializeAny(signedBytes);
    signature = signatureOf(signedTx);
  } else {
    signedTx = deserializeAny(unsignedBytes);
    if (isVersioned) signedTx.sign([localKeypair]);
    else signedTx.partialSign(localKeypair);
    signedBytes = Buffer.from(signedTx.serialize());
    signature = signatureOf(signedTx);
  }

  // 8. MANDATORY simulation of the exact signed bytes (P0-2a), with
  //    FULL-EFFECT accounting over every writable account the
  //    transaction touches (repair round 2, P0-1a): the wallet's
  //    aggregate bounds (enforceEconomicBounds) AND the per-account
  //    permitted-effects set (enforceFullEffects) are both enforced
  //    from the simulation's account states. Incomplete or malformed
  //    simulation state refuses (P0-2) — there is no pass-through. Any
  //    failure here means sendRawTransaction is never reached.
  const sets = tradeAccountSets({ wallet: signerAddress, mint: card.mint, tokenJson });
  // Settlement accounts (repair round 4, P1-1): when the card models
  // a settlement payout, the distributor vault + state, the
  // settle-named recipient accounts, and the settles' claim PDAs join
  // the permitted-effects set. Their movements are then held to the
  // model in enforceFullEffects — permitted to move ONLY as the
  // modeled payout allows, never freely.
  const settlementModel = card.validation.settlementPayout ?? null;
  if (settlementModel) {
    sets.permitted.add(settlementModel.vault);
    sets.permitted.add(settlementModel.state);
    for (const h of settlementModel.holderAtas) sets.permitted.add(h);
    for (const ix of derived.instructions) {
      if (ix.programId === PLATFORM_PROGRAMS.distributor && ix.tag === 3) {
        sets.permitted.add(ix.accounts[6]); // the settle's claim PDA
      }
    }
  }
  const addresses = [...new Set([
    ...(card.intent?.writableAccounts ?? []),
    signerAddress,
    ...sets.walletAtas,
    sets.wsolAta,
    ...sets.poolAccounts,
  ])];
  const preStates = await fetchAccountStates(connection, fetchImpl, rpcUrl, addresses);
  const sim = await simulateSignedBytes({
    connection, fetchImpl, rpcUrl, signedBytes, signedTx, addresses,
  });
  if (sim.err) {
    throw new RuntimeError(
      'SIMULATION_FAILED',
      `refusing to broadcast: the mandatory simulation of the exact signed bytes failed: ` +
        `${JSON.stringify(sim.err)}. The signed transaction was NOT broadcast — rebuild, not retry.`,
      { simulation: sim },
    );
  }
  assertSimulationStatesComplete(
    preStates, sim.accounts, addresses,
    // The accounts whose post-states must decode as token accounts:
    // the wallet's own ATAs, its WSOL ATA, and the pool's token
    // accounts/vaults. (The pool state PDAs in sets.poolAccounts are
    // program accounts — their data is not token data and they are
    // not held to the token decode rule.)
    new Set([...sets.walletAtas, sets.wsolAta, ...sets.poolTokenAccounts]),
  );
  const effects = computeEffects(preStates, sim.accounts, addresses);
  // Aggregate SOL accounting: the wallet's own lamport delta PLUS its
  // wrapped-SOL ATA's lamport delta. A WSOL ATA's lamports ARE its
  // wrapped-SOL balance (SyncNative keeps them equal), so wrapped SOL
  // still sitting in the wallet's own ATA is the wallet's own position
  // — it reduces a buy's net debit / adds to a sell's credit. An ATA
  // created and closed inside the trade nets to a 0 contribution (its
  // lamports left via the swap and the close refund, both already in
  // the wallet/pool deltas); a pre-existing ATA that ends closed has
  // its negative delta exactly cancel the close credit inside the
  // wallet's own delta. Either way the aggregate is the wallet's true
  // SOL position change.
  const deltas = {
    solDelta: (effects.get(signerAddress)?.lamportDelta ?? 0)
      + (effects.get(sets.wsolAta)?.lamportDelta ?? 0),
    tokenDelta: sets.walletAtas.reduce((acc, a) => {
      const e = effects.get(a);
      return acc + (e && e.tokenMint === card.mint ? e.tokenDelta : 0n);
    }, 0n),
  };
  // The settlement outflow, measured from the distributor vault's
  // simulated token delta (repair round 4, P1-1): the single number
  // both enforcement passes hold the payouts to. The venue swap's
  // account set rides along so the per-recipient bound can tell a
  // pure payout recipient from a swap vault (see enforceFullEffects).
  if (settlementModel) {
    const vaultEff = effects.get(settlementModel.vault);
    const venueAccounts = new Set();
    for (const ix of derived.instructions) {
      if (ix.programId === PLATFORM_PROGRAMS.dbc || ix.programId === PLATFORM_PROGRAMS.house) {
        for (const a of ix.accounts) venueAccounts.add(a);
      }
    }
    deltas.settlement = { totalPayoutRaw: vaultEff ? -vaultEff.tokenDelta : 0n, venueAccounts };
  }
  enforceEconomicBounds(card, deltas);
  enforceFullEffects(card, effects, sets, deltas.settlement ?? null);
  const economicBounds = 'enforced';
  const deltasOut = { solDelta: deltas.solDelta, tokenDelta: deltas.tokenDelta.toString() };
  if (deltas.settlement) {
    deltasOut.settlementPayoutRaw = deltas.settlement.totalPayoutRaw.toString();
  }

  if (opts.dryRun) {
    return {
      mode: 'dry-run',
      broadcast: false,
      signature,
      simulation: { err: null, unitsConsumed: sim.unitsConsumed, logs: sim.logs },
      deltas: deltasOut,
      economicBounds,
      note: 'DRY RUN — the signed transaction was simulated (sigVerify) and its deltas checked against the card bounds. Nothing was broadcast and no funds moved.',
    };
  }

  // 9. Broadcast, then confirm against the CARD's blockhash strategy
  //    (P0-2b) — never a freshly fetched blockhash, which would let an
  //    expired build ride a new confirmation window.
  const ownerPk = new PublicKey(signerAddress);
  const mintPk = new PublicKey(card.mint);
  const before = await snapshotBalances(connection, ownerPk, mintPk);
  const sig = await connection.sendRawTransaction(signedBytes, { maxRetries: 3 });
  const confirmation = await connection.confirmTransaction(
    { signature: sig, blockhash: card.blockhash, lastValidBlockHeight: card.lastValidBlockHeight },
    'confirmed',
  );
  // A confirmed transaction can still have FAILED on-chain (repair
  // round 3, P1-5): confirmTransaction resolves with the error in its
  // result rather than throwing in every strategy, and round 2 ignored
  // the result entirely — a failed trade could be reported as a
  // successful receipt. The confirmation error is checked explicitly;
  // an errored confirmation is a failure, never a receipt.
  //
  // Repair round 4, P1-6: the round-3 check read the error with
  // `confirmation?.value?.err ?? null`, so a MALFORMED confirmation —
  // `{}`, a missing value, a value without an err field — collapsed
  // to null and was reported as success. Success now requires the
  // well-formed shape strictly: a confirmation object whose value is
  // an object carrying an `err` field that is exactly null. Anything
  // else is a failure to verify the outcome — reported as a failure,
  // never as a receipt (the transaction may or may not have landed;
  // the signature is named so the owner can check it).
  const confirmationValue = confirmation?.value;
  const confirmationWellFormed = !!confirmation
    && typeof confirmation === 'object'
    && !!confirmationValue
    && typeof confirmationValue === 'object'
    && 'err' in confirmationValue;
  if (!confirmationWellFormed) {
    throw new RuntimeError(
      'CONFIRMATION_UNVERIFIED',
      `transaction ${sig} was broadcast but its confirmation response was malformed (${JSON.stringify(confirmation)?.slice(0, 120) ?? 'no response'}) — the outcome cannot be verified, so it is reported as a failure, not a receipt. Check the signature on a block explorer before doing anything else; do not re-send blindly.`,
      { signature: sig },
    );
  }
  const confirmationError = confirmationValue.err;
  if (confirmationError !== null) {
    throw new RuntimeError(
      'TRANSACTION_FAILED_ONCHAIN',
      `transaction ${sig} was confirmed but FAILED on-chain: ${JSON.stringify(confirmationError)}. ` +
        `It is reported as a failure, not a receipt — the trade did not execute. Investigate the ` +
        `failure before preparing again; do not treat this signature as a completed trade.`,
      { signature: sig, confirmationError },
    );
  }
  const after = await snapshotBalances(connection, ownerPk, mintPk);
  return {
    mode: 'broadcast',
    broadcast: true,
    signature: sig,
    deltas: deltasOut,
    economicBounds,
    receipt: {
      signature: sig,
      wallet: signerAddress,
      mint: card.mint,
      side: card.side,
      amount: card.amount,
      fingerprint: card.fingerprint,
      balancesBefore: before,
      balancesAfter: after,
      confirmedAt: new Date().toISOString(),
    },
    note: 'Broadcast and confirmed against the card\u2019s own blockhash window. The receipt above (signature + observed before/after balances) is the record — no key material or signed blob is stored.',
  };
}

async function snapshotBalances(connection, owner, mint) {
  const sol = await connection.getBalance(owner, 'confirmed');
  let token = null;
  try {
    const accounts = await connection.getTokenAccountsByOwner(owner, { mint }, { commitment: 'confirmed' });
    if (accounts.value.length) {
      const bal = await connection.getTokenAccountBalance(accounts.value[0].pubkey, 'confirmed');
      token = bal.value.amount;
    } else {
      token = '0';
    }
  } catch {
    token = null; // token account read is best-effort; SOL balance is the hard record
  }
  return { solLamports: sol, sol: sol / LAMPORTS_PER_SOL, tokenRaw: token };
}

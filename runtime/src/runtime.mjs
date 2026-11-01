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
import { dirname as pathDirname, join as pathJoin, resolve as pathResolve } from 'node:path';
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
  deriveOrderedAccountKeys,
  derivePoolStateVaults,
  resolvePoolVaultPin,
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
  deriveOrderedAccountKeys,
  derivePoolStateVaults,
  resolvePoolVaultPin,
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

// Parent-chain symlink discipline (repair round 5, item 2). Rounds
// 1–4 checked the FINAL component of a write target for symlink-ness
// (a link planted AT the target refuses), but a symlinked PARENT
// directory anywhere above the target redirected the write just as
// surely: the temp file + rename landed wherever the link pointed.
// Every write path below now walks the target's parent chain with
// lstat and refuses when ANY existing component is a symlink,
// naming it. (A dangling symlink at the target itself slips past an
// existsSync/'wx' pair — the final-component lstat checks in the
// individual writers cover that case.)
export function assertNoSymlinkParents(file, code = 'WRITE_SYMLINK_REFUSED') {
  let dir = pathDirname(pathResolve(file));
  for (;;) {
    let stat = null;
    try { stat = lstatSync(dir); } catch { stat = null; }
    if (stat?.isSymbolicLink()) {
      throw new RuntimeError(
        code,
        `refusing to write ${file}: a parent path component is a symlink (${dir}) — a planted link could redirect the write onto another file. Remove the link (or choose a path outside it) and retry.`,
        { path: file, symlinkComponent: dir },
      );
    }
    const parent = pathDirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export function writeKeypairFile(file, keypair) {
  assertNoSymlinkParents(file, 'KEYPAIR_SYMLINK');
  let existing = null;
  try { existing = lstatSync(file); } catch { /* absent: the normal case */ }
  if (existing?.isSymbolicLink()) {
    throw new RuntimeError(
      'KEYPAIR_SYMLINK',
      `refusing to write a keypair file through a symlink: ${file} — a planted (even dangling) link could redirect the write. Remove the link and retry.`,
      { file },
    );
  }
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
  assertNoSymlinkParents(p, 'SIDECAR_SYMLINK');
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
  assertNoSymlinkParents(path);
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
//
// Repair round 5 (policy version 3, item 3) adds the settlement
// model's settle COUNT to the bound serialization: round 4 bound the
// recipient set but not how many settle instructions the model
// covers, so a card edited to add or remove a settle (recipients
// edited consistently) could keep a matching recipient SET while
// changing the number of payout instructions the approval describes.
// The count is now bound; version-2 tokens no longer verify, for the
// same reason as version 1 before them.
//
// Repair round 5.1 (policy version 4) adds the settlement model's
// pool-vault PIN SOURCE: how the pool-vault recipients were pinned
// (canonical record, cross-checked on-chain — or pool-state
// derivation) is part of what the owner approves, so it is bound like
// the rest of the model. Version-3 tokens no longer verify.
export function policyFingerprintOf(p) {
  return createHash('sha256').update(stableStringify({
    policyVersion: 4,
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
// amounts as strings, the recipient set sorted, the settle COUNT
// bound (repair round 5, item 3), absent model as null. Both the
// prepare-time token and the send-time recompute pass through here,
// so the two constructions cannot drift apart.
export function canonicalSettlementModel(sp) {
  if (!sp) return null;
  return {
    vault: sp.vault,
    state: sp.state,
    maxRaw: String(sp.maxRaw),
    minRaw: String(sp.minRaw ?? '0'),
    holderAtas: [...(sp.holderAtas ?? [])].sort(),
    ownAta: sp.ownAta ?? null,
    settles: Number(sp.settles ?? (sp.holderAtas ?? []).length),
    poolVaultPin: sp.poolVaultPin ?? null,
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
  let poolVaultPin = null;
  try {
    intent = await deriveIntent(build.transaction_base64, opts.connection);
    // Pool vaults (repair round 5, TIGHTEN-1; round 5.1): when the
    // build bundles distributor settles, the counterparty settle's
    // recipient pin needs the pool vaults established independently
    // of the build. Round 5 derived them from the canonical pool's
    // on-chain state; since round 5.1 the canonical record publishes
    // baseVault/quoteVault/poolAuthority, and resolvePoolVaultPin
    // admits the RECORD's vaults after cross-checking them against
    // the on-chain vault/state reads (a disagreeing record refuses),
    // keeping derivation as the fallback for records that name none.
    // The resolved SOURCE is carried into the settlement model below
    // and bound into the approval token.
    let poolStateVaults = new Set();
    if (intent.instructions.some(
      (ix) => ix.programId === PLATFORM_PROGRAMS.distributor && ix.tag === 3,
    )) {
      const pin = await resolvePoolVaultPin({ connection: opts.connection, tokenJson: token, mint });
      poolStateVaults = pin.vaults;
      poolVaultPin = pin.source;
    }
    ({ venueProgram } = validateIntent(intent, {
      wallet, mint, side, venue, tokenJson: token,
      amountInRaw, minimumAmountOutRaw,
      poolStateVaults,
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
  //     OWN payout is measured INDEPENDENTLY — from the simulation's
  //     inner token transfers out of the vault inside the settle
  //     instructions themselves (repair round 5, P0-1; rounds 3–4
  //     inferred it as the residual of the wallet's ATA net delta,
  //     which let a settle credit mask a swap over-debit) — required
  //     to lie in [minRaw, maxRaw], with the swap legs checked
  //     against the measured payout, never the residual.
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
      // Repair round 5.1: HOW the pool-vault recipients in
      // holderAtas were pinned — 'record' (the canonical record's
      // published vaults, cross-checked against the chain at
      // prepare), 'pool-state' (derived from the pool's on-chain
      // state; the record names no vaults), or null (no pool-vault
      // recipient in this model). Displayed on the card and bound
      // into the approval token (policy version 4).
      poolVaultPin,
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
    lines.push(`  settlement: this trade bundles ${sp.settles} distributor settle(s). Payouts are computed on-chain from holder entitlements and cannot be known exactly in advance; the approved bound is the distributor vault's balance at prepare time. EVERY recipient is listed and pinned below — at send time each payout is measured from the settle instructions' own transfers and held to its bound:`);
    for (const holderAta of [...sp.holderAtas].sort()) {
      lines.push(`    recipient ${holderAta} — payout \u2264 ${sp.maxRaw} raw units${holderAta === sp.ownAta ? ' (your own account)' : ''}`);
    }
    lines.push(`    vault ${sp.vault} — total payouts across all ${sp.holderAtas.length} recipient(s) must be \u2264 ${sp.maxRaw} raw units. The recipient list AND the settle count (${sp.settles}) are part of the approval token; the swap legs are checked net of the INDEPENDENTLY MEASURED payout to you, never a residual.`);
    if (sp.poolVaultPin === 'record') {
      lines.push(`    pool-vault pin: the pool's base/quote vaults above are pinned from the CANONICAL RECORD's published addresses, cross-checked at prepare against the on-chain vault accounts and pool state (a record that disagrees with the chain refuses). The pin source is part of the approval token.`);
    } else if (sp.poolVaultPin === 'pool-state') {
      lines.push(`    pool-vault pin: the canonical record names no pool vaults for this token, so the pool's base/quote vaults above are pinned by DERIVATION from the pool's on-chain state (stored vaults, read back under the venue's pool-authority PDA). The pin source is part of the approval token.`);
    }
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
// External signer allowlist (repair round 4, P1-5; complete
// invocation binding in repair round 5, TIGHTEN-2 + item 5)
//
// Rounds 1–3 validated the external signer's PATH SHAPE (a plain
// executable path, no shell) — but the path itself came from the
// agent-supplied --external-signer flag at send time, so anything
// able to influence that flag could have the runtime execute an
// arbitrary local binary with the transaction as its input. The
// signer is now enrolled by the USER, ahead of time, into an
// allowlist the send path merely consults:
//
//   agentonly-runtime signer enroll --path <executable> [--arg <value>...]
//
// Round 4 bound the executable's ABSOLUTE path + the SHA-256 of its
// bytes — but --external-signer-arg values still flowed from the
// agent at send time, so enrolling an interpreter (node, python)
// bound the interpreter while the agent chose the actual program
// (the script passed as an argument) on every send. Round 5 closes
// that: enrollment records the COMPLETE invocation — the executable
// (path + SHA-256) AND an argv template in which every argument is
// either a FILE argument (an absolute path to a regular file — a
// script, a key file, a config — recorded with its own SHA-256) or
// a LITERAL (a fixed string containing no path separator; anything
// path-like must be enrolled as a file argument so it is hashed).
// The allowlist lives in a user-owned config file (default
// ~/.agentonly-runtime/signers.json; AGENTONLY_SIGNER_ALLOWLIST
// overrides the location), stored 0600 with the same load hardening
// as keypair/sidecar files (symlink refused, group/world access
// refused, atomic symlink-safe writes).
//
// At send time the runtime accepts ONLY the enrolled signer's path
// (--external-signer) and the wallet address: any --external-signer-arg
// refuses (EXTERNAL_SIGNER_ARGS_REFUSED) — there are no free-form
// arguments outside the enrolled template. Before spawning, the
// runtime re-hashes the executable AND every file argument; any
// drift refuses (SIGNER_INTEGRITY_MISMATCH, naming the drifted
// component). The spawned argv is exactly the enrolled template.
// A send also refuses when: no allowlist exists
// (SIGNER_ALLOWLIST_MISSING) or the named executable is not enrolled
// (SIGNER_NOT_ENROLLED). The signer's returned bytes are still
// validated byte-for-byte (validateExternalSigned). Allowlist
// documents written by round 4 (version 1, no argv template)
// normalize to an empty template — an interpreter enrolled under
// round 4 must be re-enrolled with its script as an --arg before it
// can sign again, which is the point.
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

// One enrolled argument: a file argument binds an absolute path to
// a regular, non-symlink file by SHA-256; a literal is a fixed string
// with no path separator (anything path-like must be a file argument
// so its bytes are hashed — an unhashed path argument would let the
// enrolled template point at whatever bytes happen to sit there at
// send time).
function enrollSignerArg(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeError('SIGNER_ARG_INVALID', 'signer enrollment arguments must be non-empty strings (repeatable --arg)');
  }
  if (value.startsWith('/')) {
    let stat;
    try {
      stat = lstatSync(value);
    } catch {
      throw new RuntimeError('SIGNER_ARG_INVALID', `signer enrollment argument names a file that does not exist: ${value} — file arguments are hashed at enrollment, so the file must exist first`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new RuntimeError('SIGNER_ARG_INVALID', `signer enrollment argument must name a regular file (not a symlink): ${value}`);
    }
    return { type: 'file', path: value, sha256: createHash('sha256').update(readFileSync(value)).digest('hex') };
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new RuntimeError(
      'SIGNER_ARG_INVALID',
      `signer enrollment argument '${value}' is path-like but not absolute — relative paths are refused at enrollment: pass an absolute path so the file can be hashed and bound, or a plain literal with no path separator`,
    );
  }
  return { type: 'literal', value };
}

function normalizeSignerEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  return { ...entry, args: Array.isArray(entry.args) ? entry.args : [] };
}

export function enrollSigner(executable, argValues = []) {
  assertValidExternalSigner(executable);
  if (!executable.startsWith('/')) {
    throw new RuntimeError(
      'EXTERNAL_SIGNER_INVALID',
      `enrollment requires an absolute executable path (got '${executable}') — the allowlist binds the exact absolute path the send will name`,
      { executable },
    );
  }
  const args = (argValues ?? []).map(enrollSignerArg);
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const p = signerAllowlistPath();
  mkdirSync(pathDirname(p), { recursive: true, mode: 0o700 });
  const existing = readSignerAllowlist();
  const doc = { version: 2, signers: (existing?.signers ?? []).map(normalizeSignerEntry) };
  const entry = { path: executable, sha256, args, enrolledAt: new Date().toISOString() };
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
  const rawEntry = doc.signers.find((s) => s.path === executable);
  if (!rawEntry) {
    throw new RuntimeError(
      'SIGNER_NOT_ENROLLED',
      `refusing to run external signer ${executable}: it is not enrolled in the signer allowlist (${signerAllowlistPath()}). Enrollment is the user's act, done ahead of time: agentonly-runtime signer enroll --path ${executable}`,
      { executable },
    );
  }
  const entry = normalizeSignerEntry(rawEntry);
  const hashOrRefuse = (label, file, enrolledSha) => {
    let current;
    try {
      current = createHash('sha256').update(readFileSync(file)).digest('hex');
    } catch (e) {
      throw new RuntimeError(
        'SIGNER_INTEGRITY_MISMATCH',
        `refusing to run external signer ${executable}: ${label} could not be read for the enrollment integrity check (${e.message})`,
        { executable },
      );
    }
    if (current !== enrolledSha) {
      throw new RuntimeError(
        'SIGNER_INTEGRITY_MISMATCH',
        `refusing to run external signer ${executable}: ${label} changed since enrollment (enrolled sha256 ${String(enrolledSha).slice(0, 12)}…, current ${current.slice(0, 12)}…). If the change is deliberate, re-enroll the complete invocation: agentonly-runtime signer enroll --path ${executable}`,
        { executable },
      );
    }
  };
  hashOrRefuse('its bytes', executable, entry.sha256);
  // Repair round 5 (item 5): the COMPLETE invocation is bound — every
  // file the enrolled argv template names (script, key file, config)
  // is re-hashed before the signer may run.
  for (const arg of entry.args) {
    if (arg?.type === 'file') hashOrRefuse(`an enrolled file argument (${arg.path})`, arg.path, arg.sha256);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// External signer adapter (P1-a; shell removed in repair round 2, P1-e;
// enrollment required in repair round 4, P1-5; complete-invocation
// binding in repair round 5, TIGHTEN-2 + item 5)
//
// Protocol: the runtime spawns an ENROLLED EXECUTABLE directly (spawn
// with shell: false — never a shell, so signer text can never become
// shell syntax) with EXACTLY the argv template recorded at enrollment
// — no argument originates at send time — writes the UNSIGNED
// transaction (base64) to its stdin, and reads the SIGNED transaction
// (base64) from its stdout. The returned bytes are validated before
// anything else happens: message bytes byte-identical to the unsigned
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
      `--external-signer must be a single plain executable path with no spaces or shell metacharacters (got '${executable}'). It names an ENROLLED signer only — the invocation's arguments were fixed at enrollment (signer enroll --path <exe> [--arg <value>...]) and cannot be supplied at send time.`,
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

// opts: { runCommand?: (executable, args, inputB64) => Promise<string> }
// There is deliberately NO args option (repair round 5, TIGHTEN-2):
// the only argv the signer ever receives is the template recorded at
// enrollment. A caller attempting to pass arguments is refused, not
// honored.
export async function runExternalSigner(executable, unsignedBase64, opts = {}) {
  if (opts.args != null && (!Array.isArray(opts.args) || opts.args.length > 0)) {
    throw new RuntimeError(
      'EXTERNAL_SIGNER_ARGS_REFUSED',
      'refusing to run the external signer with caller-supplied arguments — the invocation is fixed at enrollment (signer enroll --path <exe> [--arg <value>...]) and send time accepts no arguments. Re-enroll the signer with the intended invocation if it must change.',
      { executable },
    );
  }
  assertValidExternalSigner(executable);
  // Repair round 4, P1-5 + round 5: path shape is not trust. The
  // executable must be enrolled in the user's signer allowlist, and
  // the COMPLETE enrolled invocation — executable bytes plus every
  // file argument — must still hash to the enrollment.
  const entry = assertSignerEnrolled(executable);
  const argv = entry.args.map((a) => (a.type === 'file' ? a.path : a.value));
  const run = opts.runCommand ?? defaultRunSigner;
  let stdout;
  try {
    stdout = await run(executable, argv, unsignedBase64);
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

function normalizeSimValue(value, orderedKeys = null) {
  if (!value) throw new RuntimeError('RPC_ERROR', 'simulation returned no value');
  return {
    err: value.err ?? null,
    unitsConsumed: value.unitsConsumed ?? null,
    logs: value.logs ?? [],
    accounts: Array.isArray(value.accounts) ? value.accounts.map(normalizeAccountState) : null,
    // Inner instructions (repair round 5, P0-1): requested on every
    // simulation path and normalized against the transaction's
    // ordered account keys. null when the node returned none — the
    // settlement attribution refuses on null whenever a settlement
    // model exists; there is no silent fall-back to residual
    // inference.
    innerInstructions: value.innerInstructions != null
      ? normalizeInnerInstructions(value.innerInstructions, orderedKeys)
      : null,
  };
}

// Normalizes simulation inner instructions from any of the shapes the
// three simulation paths produce into:
//   [{ index, instructions: [{ programId, tokenTransfer? }] }]
// where tokenTransfer is { source, destination, amount (string) } for
// SPL token Transfer (tag 3) / TransferChecked (tag 12) instructions
// and absent otherwise. Shapes handled:
//   * raw JSON-RPC: { programIdIndex, accounts: [u8 indices], data: base58 }
//   * web3 partially-decoded: { programId, accounts: [PublicKey], data: base58 }
//   * web3 jsonParsed: { programId, parsed: { type, info } }
export function normalizeInnerInstructions(raw, orderedKeys) {
  if (!Array.isArray(raw)) return null;
  const keyAt = (i) => (Array.isArray(orderedKeys) && typeof i === 'number' ? orderedKeys[i] ?? null : null);
  const addrOf = (a) => {
    if (typeof a === 'string') return a;
    if (typeof a === 'number') return keyAt(a);
    if (a && typeof a.toBase58 === 'function') return a.toBase58();
    return null;
  };
  const out = [];
  for (const group of raw) {
    if (!group || !Array.isArray(group.instructions)) continue;
    const instructions = [];
    for (const ix of group.instructions) {
      let programId = null;
      if (typeof ix.programId === 'string') programId = ix.programId;
      else if (ix.programId && typeof ix.programId.toBase58 === 'function') programId = ix.programId.toBase58();
      else if (typeof ix.programIdIndex === 'number') programId = keyAt(ix.programIdIndex);
      if (!programId) continue;
      const norm = { programId };
      if (ix.parsed && typeof ix.parsed === 'object'
        && (ix.parsed.type === 'transfer' || ix.parsed.type === 'transferChecked')
        && ix.parsed.info && typeof ix.parsed.info === 'object') {
        const info = ix.parsed.info;
        const amount = info.tokenAmount?.amount ?? info.amount;
        if (typeof info.source === 'string' && typeof info.destination === 'string' && amount != null) {
          norm.tokenTransfer = { source: info.source, destination: info.destination, amount: String(amount) };
        }
      } else if (programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) {
        const accounts = (ix.accounts ?? []).map(addrOf);
        let data = null;
        if (typeof ix.data === 'string') { try { data = bs58.decode(ix.data); } catch { data = null; } }
        else if (ix.data != null) data = Buffer.from(ix.data);
        if (data && data.length >= 9 && (data[0] === 3 || data[0] === 12)) {
          const source = accounts[0];
          const destination = data[0] === 3 ? accounts[1] : accounts[2];
          if (source && destination) {
            norm.tokenTransfer = {
              source, destination,
              amount: Buffer.from(data).readBigUInt64LE(1).toString(),
            };
          }
        }
      }
      instructions.push(norm);
    }
    out.push({ index: group.index ?? null, instructions });
  }
  return out;
}

// Independent settlement measurement (repair round 5, P0-1).
//
// Rounds 3–4 "decomposed" the wallet's own settlement payout out of
// its ATA's NET delta (payout = tokenDelta + amountIn). That is
// residual inference: the two flows into the same account are summed
// by the chain and separated by assumption, so a swap leg that
// over-debits the wallet by X is exactly masked by a settle credit
// larger by X. This function measures the payout DIRECTLY instead:
// it walks the simulation's INNER instructions and sums the token
// transfers OUT OF the distributor vault that occur inside the
// transaction's distributor-settle top-level instructions — the
// settle instructions' own transfer legs, attributed per recipient.
// It also totals every token transfer into and out of the wallet's
// own ATA, split by the top-level instruction it rode under
// (settle / venue swap / anything else), so any movement of the
// card mint into or out of the wallet's account that is neither the
// measured payout nor the venue swap leg is unattributable and the
// send refuses. Pure function of the normalized inner instructions
// and the validated intent — no account-state deltas involved.
export function measureSettleAttribution({ innerInstructions, intent, vault, ownAta }) {
  const topKinds = intent.instructions.map((ix) => {
    if (ix.programId === PLATFORM_PROGRAMS.distributor && ix.tag === 3) return 'settle';
    if (ix.programId === PLATFORM_PROGRAMS.dbc || ix.programId === PLATFORM_PROGRAMS.house) return 'venue';
    return 'other';
  });
  const perRecipient = new Map();
  const recipientNet = new Map();
  let ownPayout = 0n;
  let ownInSettle = 0n; let ownInVenue = 0n; let ownInOther = 0n;
  let ownOutSettle = 0n; let ownOutVenue = 0n; let ownOutOther = 0n;
  const netAdd = (addr, field, amount) => {
    const e = recipientNet.get(addr) ?? { in: 0n, out: 0n };
    e[field] += amount;
    recipientNet.set(addr, e);
  };
  for (const group of innerInstructions ?? []) {
    const kind = topKinds[group.index] ?? 'other';
    for (const ix of group.instructions ?? []) {
      const t = ix.tokenTransfer;
      if (!t) continue;
      const amount = BigInt(t.amount);
      if (kind === 'settle' && t.source === vault) {
        perRecipient.set(t.destination, (perRecipient.get(t.destination) ?? 0n) + amount);
        if (t.destination === ownAta) ownPayout += amount;
      }
      netAdd(t.destination, 'in', amount);
      netAdd(t.source, 'out', amount);
      if (t.destination === ownAta) {
        if (kind === 'settle') ownInSettle += amount;
        else if (kind === 'venue') ownInVenue += amount;
        else ownInOther += amount;
      }
      if (t.source === ownAta) {
        if (kind === 'settle') ownOutSettle += amount;
        else if (kind === 'venue') ownOutVenue += amount;
        else ownOutOther += amount;
      }
    }
  }
  let totalAttributed = 0n;
  for (const v of perRecipient.values()) totalAttributed += v;
  return {
    perRecipient,
    recipientNet,
    totalAttributed,
    ownPayoutRaw: ownPayout,
    // The wallet's own ATA flows that are neither the measured
    // settlement payout nor the venue swap leg — must both be zero.
    // (Settle-top credits from a source other than the vault count
    // here: ownInSettle totals every settle-top credit into the
    // account, ownPayout only the vault-sourced ones.)
    ownUnattributedInRaw: (ownInSettle - ownPayout) + ownInOther,
    ownUnattributedOutRaw: ownOutSettle + ownOutOther,
    ownVenueInRaw: ownInVenue,
    ownVenueOutRaw: ownOutVenue,
  };
}

// Simulates the EXACT signed bytes. Test-double connections (plain
// objects implementing simulateTransaction, no web3 internals) are
// honored directly; a real Connection is used in its versioned typed
// form for versioned transactions, and via raw JSON-RPC for legacy
// transactions — web3.js's legacy overload would rebase the blockhash
// and silently stop simulating the approved bytes.
export async function simulateSignedBytes({ connection, fetchImpl, rpcUrl, signedBytes, signedTx, addresses }) {
  // Ordered account keys (repair round 5, P0-1): the settlement
  // attribution resolves inner-instruction account indices against
  // the message's key order. Derived from the exact signed bytes;
  // a versioned transaction with lookup tables needs the connection.
  let orderedKeys = null;
  try {
    orderedKeys = await deriveOrderedAccountKeys(signedBytes, connection);
  } catch { orderedKeys = null; }
  const isDouble = connection
    && typeof connection.simulateTransaction === 'function'
    && typeof connection._rpcRequest !== 'function';
  if (isDouble) {
    const res = await connection.simulateTransaction(signedTx, {
      sigVerify: true,
      replaceRecentBlockhash: false,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses },
      innerInstructions: true,
    });
    return normalizeSimValue(res?.value ?? res, orderedKeys);
  }
  if (signedTx?.message) {
    const res = await connection.simulateTransaction(signedTx, {
      sigVerify: true,
      replaceRecentBlockhash: false,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses },
      innerInstructions: true,
    });
    return normalizeSimValue(res?.value ?? res, orderedKeys);
  }
  const result = await rpcCall(fetchImpl, rpcUrl, 'simulateTransaction', [
    signedBytes.toString('base64'),
    {
      encoding: 'base64',
      sigVerify: true,
      replaceRecentBlockhash: false,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses },
      innerInstructions: true,
    },
  ]);
  return normalizeSimValue(result?.value, orderedKeys);
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
    //
    // Repair round 5 (live-smoke correction): there IS one more
    // state, and production hits it on every trade — an account the
    // transaction CLOSES (the wallet's wrapped-SOL ATA is created and
    // closed inside the venue build) is reported by the simulation
    // as present with ZERO lamports and empty data: the chain's
    // representation of a purged account. Zero lamports is the
    // distinguishing line — a live token account always carries its
    // rent-exempt lamports, so the P1-4 case (rent present, data
    // unreadable) still refuses, while a purged account's balance is
    // definitionally zero and its lamports are accounted at the
    // close destination (computeEffects reads the closed shape as
    // system-owned with no token balance).
    const closedAccount = post.lamports === 0 && post.data.length === 0;
    if (!closedAccount && (tokenAccountAddrs.has(addr) || wasTokenData) && !parseTokenAccountData(post.data)) {
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
    // The pool's quote vault (derived from pool state, repair round
    // 5) holds wrapped SOL: its balance movement IS the trade's SOL
    // leg on the venue side.
    const poolQuote = !!sets.poolStateVaults?.has(addr) && eff.tokenMint === WSOL_MINT;
    if (eff.tokenDelta !== 0n && eff.tokenMint !== card.mint && !ownWsol && !poolQuote) {
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
    // measured independently and bounded in enforceEconomicBounds
    // (repair round 5, P0-1). The blanket no-credit rule still
    // applies to every other wallet account.
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

  // Settlement effects (repair round 4, P1-1; per-recipient
  // measurement in repair round 5, P0-1 + TIGHTEN-1). The distributor
  // vault and the settle-named recipient accounts were added to the
  // permitted set by sendCard (from the card's policy-bound model);
  // here their movements are held to the model exactly:
  //   * the vault may only LOSE tokens (payouts flow out; a trade
  //     transaction never routes fees INTO the distributor vault —
  //     funding happens through distribute(), a different
  //     instruction that is not part of a trade), its lamports never
  //     move, and the total outflow is ≤ the card's maxRaw (the
  //     vault balance authenticated at prepare time);
  //   * every recipient's payout is measured INDEPENDENTLY from the
  //     settle instructions' own inner transfers and held to the
  //     per-recipient bound (≤ maxRaw) — for EVERY recipient,
  //     including pool vaults (repair round 5, TIGHTEN-1: rounds
  //     1–4 exempted accounts the venue swap names from the
  //     per-recipient bound; that exemption is gone);
  //   * the attributed payouts must sum EXACTLY to the vault's
  //     measured outflow — an outflow no settle transfer accounts
  //     for is unmeasured value leaving the vault and refuses;
  //   * a recipient whose only role is receiving a payout must move
  //     by exactly its measured payout — any other transfer into or
  //     out of it is unattributable and refuses.
  if (sp) {
    if (!settlement || typeof settlement.totalPayoutRaw !== 'bigint'
      || typeof settlement.ownPayoutRaw !== 'bigint'
      || !(settlement.perRecipient instanceof Map)) {
      throw new RuntimeError(
        'SETTLEMENT_EFFECT_UNMEASURED',
        'refusing to broadcast: this card models a settlement payout but the send did not independently measure the payouts from the simulation\u2019s inner instructions — the payout bounds cannot be enforced. Discard the card and prepare again.',
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
    if (settlement.totalAttributed !== settlement.totalPayoutRaw) {
      throw new RuntimeError(
        'SETTLEMENT_EFFECT_UNMEASURED',
        `refusing to broadcast: the settle instructions' own transfers attribute ${settlement.totalAttributed} raw units of payout, but the distributor vault's simulated outflow is ${settlement.totalPayoutRaw} — value leaves the vault through no measured settle transfer, so the payout cannot be accounted to the approved model.`,
        { totalAttributed: settlement.totalAttributed.toString(), totalPayoutRaw: settlement.totalPayoutRaw.toString() },
      );
    }
    if (vaultEff.lamportDelta !== 0) {
      unexpected(sp.vault, 'the distributor vault\u2019s lamports change — only its token balance may move, and only outward');
    }
    for (const holderAta of sp.holderAtas) {
      if (holderAta === sp.ownAta) continue; // the wallet's own: measured + bounded in enforceEconomicBounds
      // Per-recipient bound for EVERY recipient (repair round 5,
      // TIGHTEN-1) — the payout this recipient actually receives,
      // measured from the settle instructions' own transfers.
      const measured = settlement.perRecipient.get(holderAta) ?? 0n;
      if (measured > maxRaw) {
        throw new RuntimeError(
          'SETTLEMENT_PAYOUT_EXCEEDS_MAX',
          `refusing to broadcast: the settle instructions pay ${measured} raw units to recipient ${holderAta}, beyond the card's per-recipient settlement bound of ${maxRaw}. The approval does not cover this payout. Discard the card and prepare again.`,
          { recipient: holderAta, measuredPayoutRaw: measured.toString(), maxRaw: sp.maxRaw },
        );
      }
      if (sets.poolAccounts.includes(holderAta)) continue; // pool vaults: pool rules + the bounds above
      const eff = effects.get(holderAta);
      if (!eff) {
        if (measured !== 0n) {
          throw new RuntimeError(
            'SETTLEMENT_EFFECT_UNMEASURED',
            `refusing to broadcast: the settle instructions pay ${measured} raw units to ${holderAta} but that account has no simulated account state — the payout cannot be cross-checked.`,
            { recipient: holderAta },
          );
        }
        continue;
      }
      // A recipient's net movement must be EXACTLY the transfers
      // the attribution measured into/out of it — any further
      // movement rode in through a path the model does not describe.
      const net = settlement.recipientNet?.get(holderAta) ?? { in: 0n, out: 0n };
      if (eff.tokenDelta !== net.in - net.out) {
        throw new RuntimeError(
          'SETTLEMENT_PAYOUT_UNATTRIBUTABLE',
          `refusing to broadcast: settlement recipient ${holderAta} moves by ${eff.tokenDelta} raw units in the simulation, but the measured transfers into/out of it account for ${net.in - net.out} — the difference cannot be attributed to the approved trade.`,
          { recipient: holderAta },
        );
      }
      // The net bound [0, maxRaw] applies to PURE payout recipients
      // (whose net IS their payout, per the equality above). A
      // pool-state vault recipient is swap-driven: its net mixes the
      // swap leg with the payout, and the payout component is what
      // the per-recipient bound above already measured and held —
      // bounding its NET by maxRaw would refuse every production
      // counterparty settle (the round-5 live smoke caught exactly
      // that overreach before this exemption was scoped to the
      // independently derived vault set).
      if (!sets.poolStateVaults?.has(holderAta) && (eff.tokenDelta < 0n || eff.tokenDelta > maxRaw)) {
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
    // Repair round 4, P1-1 checked the buy's swap leg NET of the
    // transaction's TOTAL settlement payouts (a conservative bound).
    // Repair round 5, P0-1 replaces the bound with the exact
    // measurement: the wallet's own payout is read off the settle
    // instructions' own inner transfers (measureSettleAttribution),
    // so the swap leg is the ATA credit minus the MEASURED payout —
    // no conservatism needed and no residual inference involved. Any
    // card-mint movement into the wallet's account that is neither
    // the measured payout nor the venue swap leg refuses as
    // unattributable before the leg is even computed.
    if (sp) {
      const st = deltas.settlement;
      if (!st || typeof st.ownPayoutRaw !== 'bigint') {
        throw new RuntimeError(
          'SETTLEMENT_EFFECT_UNMEASURED',
          'refusing to broadcast: this card models a settlement payout but the send did not independently measure the payout from the simulation\u2019s inner instructions — the swap leg cannot be separated from the payout. Discard the card and prepare again.',
        );
      }
      if (st.ownUnattributedInRaw !== 0n || st.ownUnattributedOutRaw !== 0n) {
        throw new RuntimeError(
          'SETTLEMENT_PAYOUT_UNATTRIBUTABLE',
          `refusing to broadcast: the simulation moves the card mint into/out of the wallet's own token account outside the measured settlement payout and the venue swap leg (unattributed in ${st.ownUnattributedInRaw}, out ${st.ownUnattributedOutRaw}) — that movement cannot be accounted to the approved trade. Discard the card and prepare again.`,
          { ownUnattributedInRaw: st.ownUnattributedInRaw.toString(), ownUnattributedOutRaw: st.ownUnattributedOutRaw.toString() },
        );
      }
      const swapCredit = tokenDelta - st.ownPayoutRaw;
      if (swapCredit < minOut) {
        throw new RuntimeError(
          'ECONOMIC_BOUND_EXCEEDED',
          `the signed-byte simulation credits ${tokenDelta} raw units of the token, of which the independently measured settlement payout to the wallet is ${st.ownPayoutRaw} — the swap leg alone credits ${swapCredit}, below the card's minimum out of ${minOut}. Refusing — a settlement payout may not mask a swap that under-delivers.`,
          { tokenDelta: tokenDelta.toString(), ownPayoutRaw: st.ownPayoutRaw.toString() },
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
    // Repair round 5, P0-1: when the card models a settlement payout,
    // exactness applies to the SWAP LEG against the INDEPENDENTLY
    // MEASURED payout. Rounds 3–4 computed the payout as the residual
    // of the wallet's ATA net delta (ownPayout = tokenDelta +
    // amountInRaw) — arithmetic that assumes the only two flows are
    // the swap debit and the payout, so a swap over-debit of X is
    // exactly masked by a settle credit larger by X. The payout is
    // now measured directly from the settle instructions' own inner
    // transfers out of the distributor vault
    // (measureSettleAttribution): the measured payout must lie in
    // the card's modeled bound [minRaw, maxRaw], every other movement
    // of the card mint into/out of the wallet's account must be
    // attributable to the venue swap leg, and the swap leg — the net
    // delta MINUS the measured payout — must equal the approved sell
    // amount EXACTLY. A card WITHOUT a settlement model keeps the
    // round-3 rule untouched — any bundled payout on an unmodeled
    // card still refuses, fail-closed.
    if (sp) {
      const st = deltas.settlement;
      if (!st || typeof st.ownPayoutRaw !== 'bigint') {
        throw new RuntimeError(
          'SETTLEMENT_EFFECT_UNMEASURED',
          'refusing to broadcast: this card models a settlement payout but the send did not independently measure the payout from the simulation\u2019s inner instructions — the sell debit cannot be checked exactly. Discard the card and prepare again.',
        );
      }
      if (st.ownUnattributedInRaw !== 0n || st.ownUnattributedOutRaw !== 0n) {
        throw new RuntimeError(
          'SETTLEMENT_PAYOUT_UNATTRIBUTABLE',
          `refusing to broadcast: the simulation moves the card mint into/out of the wallet's own token account outside the measured settlement payout and the venue swap leg (unattributed in ${st.ownUnattributedInRaw}, out ${st.ownUnattributedOutRaw}) — that movement cannot be accounted to the approved trade. Discard the card and prepare again.`,
          { ownUnattributedInRaw: st.ownUnattributedInRaw.toString(), ownUnattributedOutRaw: st.ownUnattributedOutRaw.toString() },
        );
      }
      const ownPayout = st.ownPayoutRaw;
      const maxRaw = BigInt(sp.maxRaw);
      const minRaw = BigInt(sp.minRaw ?? '0');
      if (ownPayout < minRaw || ownPayout > maxRaw) {
        throw new RuntimeError(
          'ECONOMIC_BOUND_EXCEEDED',
          `the settle instructions' own transfers pay the wallet ${ownPayout} raw units (measured independently of its account delta) — outside the card's modeled settlement bound [${minRaw}, ${maxRaw}]. Refusing — the payout is not the one the card approved.`,
          { tokenDelta: tokenDelta.toString(), ownPayoutRaw: ownPayout.toString() },
        );
      }
      const swapLeg = tokenDelta - ownPayout;
      if (swapLeg !== -amountRaw) {
        throw new RuntimeError(
          'ECONOMIC_BOUND_EXCEEDED',
          swapLeg < -amountRaw
            ? `the signed-byte simulation debits the wallet's swap leg ${-swapLeg} raw units (net token delta ${tokenDelta} minus the independently measured settlement payout ${ownPayout}), MORE than the approved sell amount of ${amountRaw}. Refusing — the build takes more than the card approved, and no settlement credit can mask it.`
            : `the signed-byte simulation debits the wallet's swap leg only ${-swapLeg} raw units (net token delta ${tokenDelta} minus the independently measured settlement payout ${ownPayout}), less than the approved sell amount of ${amountRaw}. Refusing.`,
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
  let poolStateVaults = new Set();
  try {
    derived = await deriveIntent(card.transactionBase64, connection);
    if (!intentsEqual(derived, card.intent)) {
      throw new RuntimeError(
        'INTENT_CARD_MISMATCH',
        'refusing to sign: the intent re-derived from this card\u2019s transaction bytes does not match the intent stored on the card — the card was altered after preparation, or its bytes never matched its description. Discard it and prepare again.',
      );
    }
    // Pool vaults (repair round 5, TIGHTEN-1; round 5.1):
    // re-resolved at send time exactly as at prepare — the canonical
    // record's published vaults when it names them (cross-checked
    // against the chain; a record that has come to disagree refuses
    // the send), pool-state derivation otherwise. The counterparty
    // settle's recipient pin consults this set, never the build's
    // own account list.
    if (derived.instructions.some(
      (ix) => ix.programId === PLATFORM_PROGRAMS.distributor && ix.tag === 3,
    )) {
      poolStateVaults = (await resolvePoolVaultPin({ connection, tokenJson, mint: card.mint })).vaults;
    }
    validateIntent(derived, {
      wallet: card.wallet,
      mint: card.mint,
      side: card.side,
      venue: card.venue ?? null,
      tokenJson,
      amountInRaw: card.validation?.amountInRaw,
      minimumAmountOutRaw: card.validation?.minimumAmountOutRaw,
      poolStateVaults,
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
    // Settle COUNT agreement (repair round 5, item 3): the recipient
    // SET can match while the number of settle instructions differs
    // (two settles paying one recipient) — the model's bound count
    // must equal the bytes' count. The count is also bound into the
    // approval token (policy version 3); this check names the
    // disagreement directly when only the model copy was edited.
    const modeledCount = model ? Number(model.settles ?? model.holderAtas.length) : 0;
    if (settleIxs.length !== modeledCount) {
      throw new RuntimeError(
        'SETTLEMENT_MODEL_MISMATCH',
        `refusing to sign: the transaction carries ${settleIxs.length} distributor settle instruction(s) but the card's settlement model covers ${modeledCount} — the approval and the bytes describe different payouts. Discard the card and prepare again.`,
        { actualSettles: settleIxs.length, modeledSettles: modeledCount },
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
    // Repair round 5, TIGHTEN-2: no caller-supplied signer arguments
    // exist anymore — the enrolled invocation template is the whole
    // contract. A caller still carrying arguments refuses here, in
    // the core, not only in CLI plumbing.
    if (external.args != null && (!Array.isArray(external.args) || external.args.length > 0)) {
      throw new RuntimeError(
        'EXTERNAL_SIGNER_ARGS_REFUSED',
        'refusing to sign: the external signer invocation is fixed at enrollment — send accepts no signer arguments. Re-enroll the signer with the intended invocation if it must change.',
      );
    }
    signedBytes = await runExternalSigner(external.command, card.transactionBase64, {
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
  // Pool vaults (repair round 5, TIGHTEN-1; round 5.1): the curve
  // pool's base/quote vaults — pinned from the canonical record's
  // published addresses when it names them (resolvePoolVaultPin,
  // cross-checked on-chain), derived from the pool's on-chain state
  // otherwise — join the PERMITTED set: the swap trades against them
  // and the counterparty settle pays into the base vault. They
  // deliberately do NOT
  // join the pool-accounts rule set: the quote vault holds wrapped
  // SOL (its movement is the trade's other leg, exempted in
  // enforceFullEffects via this annotation), and the base vault's
  // card-mint movement is held to the settlement model's measured
  // per-recipient accounting when it is a recipient.
  sets.poolStateVaults = poolStateVaults;
  for (const v of poolStateVaults) sets.permitted.add(v);
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
  // The settlement measurement (repair round 4, P1-1 measured the
  // vault's aggregate outflow from its account delta; repair round
  // 5, P0-1 adds the INDEPENDENT per-recipient attribution from the
  // simulation's inner instructions — see measureSettleAttribution).
  // Both enforcement passes hold the payouts to these measured
  // numbers; the wallet's own payout is never inferred from its
  // account's net delta. A card with a settlement model whose
  // simulation returned no inner instructions cannot be measured
  // and refuses here — fail-closed, no residual fall-back.
  if (settlementModel) {
    if (!sim.innerInstructions) {
      throw new RuntimeError(
        'SETTLEMENT_EFFECT_UNMEASURED',
        'refusing to broadcast: this card models a settlement payout but the simulation of the exact signed bytes returned no inner instructions — the payout cannot be measured independently of account deltas, and residual inference is not an accepted substitute. Discard the card and prepare again.',
      );
    }
    const vaultEff = effects.get(settlementModel.vault);
    const attribution = measureSettleAttribution({
      innerInstructions: sim.innerInstructions,
      intent: derived,
      vault: settlementModel.vault,
      ownAta: settlementModel.ownAta,
    });
    deltas.settlement = {
      totalPayoutRaw: vaultEff ? -vaultEff.tokenDelta : 0n,
      totalAttributed: attribution.totalAttributed,
      ownPayoutRaw: attribution.ownPayoutRaw,
      perRecipient: attribution.perRecipient,
      recipientNet: attribution.recipientNet,
      ownUnattributedInRaw: attribution.ownUnattributedInRaw,
      ownUnattributedOutRaw: attribution.ownUnattributedOutRaw,
    };
  }
  enforceEconomicBounds(card, deltas);
  enforceFullEffects(card, effects, sets, deltas.settlement ?? null);
  const economicBounds = 'enforced';
  const deltasOut = { solDelta: deltas.solDelta, tokenDelta: deltas.tokenDelta.toString() };
  if (deltas.settlement) {
    deltasOut.settlementPayoutRaw = deltas.settlement.totalPayoutRaw.toString();
    deltasOut.settlementOwnPayoutRaw = deltas.settlement.ownPayoutRaw.toString();
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

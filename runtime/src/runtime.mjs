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
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
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
  tradeAccountSets,
  validateIntent,
} from './intent.mjs';

export {
  WSOL_MINT,
  associatedTokenAddress,
  deriveIntent,
  parseStrictDecimal,
  serializedTxKind,
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

export function writeWalletSidecar(file, sidecar) {
  writeFileSync(walletSidecarPath(file), JSON.stringify(sidecar, null, 2) + '\n', { mode: 0o600 });
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

function describeSimulationFailure(sim) {
  const parts = [`simulation FAILED (layer: ${sim.layer ?? 'unknown'})`];
  if (sim.name) parts.push(`error: ${sim.name}${sim.engineCode != null ? ` (engine code ${sim.engineCode})` : ''}`);
  if (sim.reason) parts.push(`reason: ${sim.reason}`);
  return parts.join(' — ');
}

// Runs eligibility → quote → build against the gateway; decodes the
// build's bytes into an intent and validates it against the request, the
// build response, and the canonical token record; only then returns an
// approval card (version 2). Writes nothing; the CLI decides where the
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

  // --- P0-1: decode + validate the intent before anything is carded ---
  const venue = build.venue ?? quote.venue ?? null;
  let intent;
  let venueProgram = null;
  try {
    intent = await deriveIntent(build.transaction_base64, opts.connection);
    ({ venueProgram } = validateIntent(intent, { wallet, mint, side, venue, tokenJson: token }));
  } catch (e) {
    throw asRuntimeError(e);
  }
  if (build.blockhash && build.blockhash !== intent.recentBlockhash) {
    throw new RuntimeError(
      'INTENT_BLOCKHASH_MISMATCH',
      `gateway build claims blockhash ${build.blockhash} but the decoded transaction carries ${intent.recentBlockhash} — the build response contradicts its own bytes. Refusing; no approval card was written.`,
    );
  }
  const amountInRaw = build.amount_in != null ? String(build.amount_in) : parsed.raw.toString();
  if (build.amount_in != null && BigInt(build.amount_in) !== parsed.raw) {
    throw new RuntimeError(
      'INTENT_AMOUNT_MISMATCH',
      `gateway build amount_in is ${build.amount_in} raw units but the request was ${parsed.raw} (${parsed.ui} UI units) — the build is not the trade that was asked for. Refusing; no approval card was written.`,
    );
  }

  const maxSolDebit = (side === 'buy' ? BigInt(amountInRaw) : 0n) + feeCeiling;
  const validation = {
    mint,
    side,
    venue,
    venueProgram,
    amountUi: parsed.ui,
    amountInRaw,
    expectedAmountOutRaw: build.amount_out_expected != null ? String(build.amount_out_expected) : String(quote.amountOut),
    minimumAmountOutRaw: build.minimum_amount_out != null ? String(build.minimum_amount_out) : String(quote.minimumAmountOut),
    feeCeilingLamports: feeCeiling.toString(),
    maxSolDebitLamports: maxSolDebit.toString(),
  };

  const fingerprint = fingerprintOf(build.transaction_base64);
  const card = {
    version: 2,
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
    priceImpactBps: build.price_impact_bps ?? quote.priceImpactBps ?? null,
    fees: quote.fees ?? null,
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
    approvalToken: fingerprint,
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
  if (card.intent) {
    lines.push('  validated intent summary (decoded from the transaction bytes at prepare time;');
    lines.push('  re-derived and compared byte-for-byte at send time — this is a summary, not the rules):');
    lines.push(...intentSummaryLines(card.intent));
  }
  lines.push(`  expires:   after block height ${card.lastValidBlockHeight}`);
  lines.push(`  card fingerprint (approval token): ${card.fingerprint}`);
  lines.push('To approve, the owner runs:');
  lines.push(`  agentonly-runtime send --file <keypair> --card ${card.cardFile ?? './approval-card.json'} --approve ${card.fingerprint}`);
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
// External signer adapter (P1-a; shell removed in repair round 2, P1-e)
//
// Protocol: the runtime spawns a TRUSTED EXECUTABLE directly (spawn
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
    if (post.data.length > 0 && post.data.length < 72 && (tokenAccountAddrs.has(addr) || wasTokenData)) {
      refuse(`account ${addr} carries ${post.data.length} bytes of post-simulation data — not a decodable token account`);
    }
    if (wasTokenData && post.data.length >= 72 && !parseTokenAccountData(post.data)) {
      refuse(`account ${addr} held a token account before the trade but its post-simulation data does not decode`);
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
export function enforceFullEffects(card, effects, sets) {
  const unexpected = (addr, what) => {
    throw new RuntimeError(
      'UNEXPECTED_EFFECT',
      `refusing to broadcast: the signed-byte simulation moves value somewhere the card does not approve — ${what} (account ${addr}). The build does more than the approved trade. Discard it and prepare again.`,
      { account: addr },
    );
  };
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
    if (card.side === 'sell' && eff.tokenDelta > 0n) {
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
  if (card.side === 'buy') {
    if (tokenDelta < minOut) {
      throw new RuntimeError(
        'ECONOMIC_BOUND_EXCEEDED',
        `the signed-byte simulation credits only ${tokenDelta} raw units of the token, below the card's ` +
          `minimum out of ${minOut}. Refusing — the build does less than the card approved.`,
        { tokenDelta: tokenDelta.toString() },
      );
    }
  } else {
    const amountRaw = BigInt(card.validation.amountInRaw);
    if (tokenDelta > -amountRaw) {
      throw new RuntimeError(
        'ECONOMIC_BOUND_EXCEEDED',
        `the signed-byte simulation debits only ${-tokenDelta} raw units of the token, less than the ` +
          `approved sell amount of ${amountRaw}. Refusing.`,
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

  // 1. Approval must name THIS card's exact build.
  if (!approve || approve !== card.fingerprint || approve !== card.approvalToken) {
    throw new RuntimeError(
      'APPROVAL_MISMATCH',
      `refusing to sign: --approve does not match this card's fingerprint. ` +
        `The approval token binds one wallet, one mint, one side, one amount and ` +
        `one simulated build. Re-read the card and approve its exact fingerprint: ${card.fingerprint}`,
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
  if (!opts.skipVenueCheck) {
    const venueNow = await freshQuoteVenue(fetchImpl, card);
    if (venueNow && card.venue && venueNow !== card.venue) {
      throw new RuntimeError(
        'VENUE_CHANGED',
        `refusing to sign: the route changed since this card was prepared — the token ` +
          `now resolves to venue '${venueNow}', but the card was built for '${card.venue}' ` +
          `(this is what graduation does). Discard the card, run prepare again against ` +
          `the new route, and approve the fresh card.`,
        { cardVenue: card.venue, currentVenue: venueNow },
      );
    }
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
      tokenJson: opts.tokenJson,
    });
  } catch (e) {
    throw asRuntimeError(e);
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
    || card.blockhash !== derived.recentBlockhash;
  if (friendlyMismatch) {
    throw new RuntimeError(
      'INTENT_CARD_MISMATCH',
      'refusing to sign: the card\u2019s displayed fields (amount, minimum out, bounds, blockhash) do not match its validated intent record — the card was altered after preparation. Discard it and prepare again.',
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
  const sets = tradeAccountSets({ wallet: signerAddress, mint: card.mint, tokenJson: opts.tokenJson });
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
    new Set([...sets.walletAtas, sets.wsolAta, ...sets.poolAccounts]),
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
  enforceEconomicBounds(card, deltas);
  enforceFullEffects(card, effects, sets);
  const economicBounds = 'enforced';
  const deltasOut = { solDelta: deltas.solDelta, tokenDelta: deltas.tokenDelta.toString() };

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
  await connection.confirmTransaction(
    { signature: sig, blockhash: card.blockhash, lastValidBlockHeight: card.lastValidBlockHeight },
    'confirmed',
  );
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

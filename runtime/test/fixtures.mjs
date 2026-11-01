// agentonly-runtime acceptance fixtures (49).
//
// Repair round 2 (PR #5 review) added: 16/17 malicious bundled builds
// (extra SOL transfer / unrelated-token transfer → instruction
// classification refuses at prepare), 18 simulation moving value to an
// unexpected account (full-effect accounting refuses), 19 incomplete
// simulation state (fail closed), 20 canonical data unavailable at
// send, 21 a real v0 transaction with an address lookup table, 22
// sidecar binding (copied sidecar / reformatted keypair file).
//
// Repair round 3 added: 25 policy binding (P0-1), 26 exact sell debit
// (P0-2), 27 platform shape validation (P1-1), 28 core canonical
// binding (P1-2), 29 sidecar symlink refusal (P1-3), 30 empty
// post-simulation token data (P1-4), 31 confirmed on-chain error
// reported as failure (P1-5).
//
// Repair round 4 added: 32 direct wallet↔pool SOL transfers refused
// (P0), 33 bundled-settle sell passes with the payout modeled
// (P1-1), 34 settlement payout over the modeled bound refuses
// (P1-1), 35 settle paying a non-derived / non-canonical account
// refuses (P1-1), 36 external-signer allowlist: unenrolled refuses,
// enrolled-but-changed refuses, enrolled works (P1-5), 37 unknown /
// missing / disagreed venue refuses at prepare (P1-4), 38 prepare
// --out onto a planted symlink refuses (P1-7b), 39 malformed
// confirmation is a failure, never a receipt (P1-6), 40 displayed
// fees / price impact are bound into the approval token (P1-8),
// 41 HouseSwap exact format: discriminator, direction, data size,
// canonical layout (P1-2).
//
// Repair round 5 added: 42 bundled-settle sell where a large settle
// credit would mask a swap over-debit under residual inference — the
// independently measured payout exposes it (P0-1), 43 a card-mint
// credit into the wallet's ATA attributable to neither the settle
// instructions nor the venue swap — refused as unattributable
// (P0-1), 44 settlement count + recipient set bound into the model
// and the approval token (item 3), 45 prepare --out through a
// symlinked parent directory refuses (item 2), 46 signer enrollment
// binds the complete invocation — script/config drift refuses while
// the interpreter is untouched (item 5). Round 5 also reworked: 13
// (enrolled invocation templates replace send-time signer args),
// 33/34 (inner-instruction attribution), 35 (swap-named settle
// recipient now refuses; the pool-state-derived vault models —
// TIGHTEN-1), 36 (template enrollment, send-time args refused).
//
// Repair round 5.1 added: 49 the canonical record's published
// baseVault/quoteVault/poolAuthority pin the counterparty settle
// recipient (cross-checked against the chain; disagreement refuses),
// with pool-state derivation as the fallback for records naming none.
//
// Repair round 2.1 added: 23 the REAL gateway build shape — fee
// distributor settles, WSOL ATA create, wrap transfer, SyncNative,
// venue swap, WSOL close — classified + accounted end to end (the
// round-2 classifier rejected every real build at the WSOL ATA
// create), 24 the same shape with the wrap leg aimed at a stranger's
// WSOL-lookalike ATA (refuses at prepare).
//
// Every key here is a fresh throwaway keypair generated inside a temp dir
// by this script. Nothing is broadcast, ever: the only live-network calls
// are reads (token JSON, market JSON, a wallet balance) and gateway
// read/prepare calls for a wallet that cannot pay (fixture 3).
//
// Scoping note for the simulate steps (verified live while building
// this): the public mainnet RPC refuses to simulate ANY transaction
// whose fee-payer account does not exist on-chain — it answers err
// "AccountNotFound" even for a signed 0-lamport self-transfer or a memo
// (that refusal is exactly what fixture 3 surfaces for real users). A
// zero-funds wallet therefore cannot be simulated against mainnet at
// all. The simulate steps here run against a local JSON-RPC stub that
// first CRYPTOGRAPHICALLY VERIFIES the signature on the bytes it
// receives (and that they carry the prepared card's exact message),
// then answers success WITH post-simulation account states — so the
// sign path and the delta enforcement are exercised for real; only the
// node answering is a test double, for the reason above.
//
// Fixture transactions are intent-valid trade-shaped builds: a
// ComputeBudget limit, one DBC (curve venue) instruction touching the
// real AGTR pool + mint + the wallet's Token-2022 ATA, and a Memo —
// exactly what the prepare/send intent validation requires.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  PLATFORM_PROGRAMS,
  WSOL_MINT,
  associatedTokenAddress,
  deriveIntent,
  distributorClaimPda,
  fingerprintOf,
  housePoolPda,
  parseStrictDecimal,
  policyFingerprintOf,
  prepareTrade,
  sendCard,
  validateIntent,
  writeKeypairFile,
} from '../src/runtime.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'agentonly-runtime');
const AGTR = 'Hfk7uqxZ3fFB4TpAzSKYGCJ3uuAJ1E1fk6i6vSn3FVXR';
const AGTR_POOL = '9NsjhhDoXRYds8q8uLHWBN38iFab38nA4VAkyLtvYVV7'; // addresses.pool in AGTR's canonical record
const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const REAL_RPC = 'https://api.mainnet-beta.solana.com';
const REAL_GATEWAY = 'https://agentonly.fun';

const results = [];
function report(num, name, ok, lines) {
  results.push({ num, name, ok });
  console.log(`\n[fixture ${num}] ${name}: ${ok ? 'PASS' : 'FAIL'}`);
  for (const l of lines) console.log(`    ${l}`);
}
// NOTE: async spawn is load-bearing — the stub server lives in THIS
// process, so the event loop must stay free to answer the CLI's calls.
function runCli(args, { cwd, env } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('node', [BIN, ...args], {
      cwd, env: { ...process.env, ...env },
    });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); rejectPromise(new Error(`CLI timed out: ${args.join(' ')}`)); }, 120_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(timer); rejectPromise(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out: stdout + stderr, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Intent-valid trade-shaped transaction builder
// ---------------------------------------------------------------------------
function buildTradeTx({ kp, mint, pool, blockhash, lvbh, extraKeys = [] }) {
  const wallet = kp.publicKey;
  const mintPk = new PublicKey(mint);
  const ata = associatedTokenAddress(mintPk, wallet, TOKEN_2022_PROGRAM);
  const tx = new Transaction({ feePayer: wallet, blockhash, lastValidBlockHeight: lvbh });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx.add(new TransactionInstruction({
    programId: new PublicKey(DBC_PROGRAM),
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(pool), isSigner: false, isWritable: true },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: ata, isSigner: false, isWritable: true },
      ...extraKeys,
    ],
    data: Buffer.concat([Buffer.from('b75d992818e6c297', 'hex'), Buffer.alloc(23, 7)]),
  }));
  tx.add(new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM),
    keys: [],
    data: Buffer.from('agentonly-runtime fixture'),
  }));
  return tx;
}

async function liveBlockhash() {
  try {
    const conn = new Connection(REAL_RPC, 'confirmed');
    const latest = await conn.getLatestBlockhash('confirmed');
    return { blockhash: latest.blockhash, lvbh: latest.lastValidBlockHeight, live: true };
  } catch {
    return { blockhash: Keypair.generate().publicKey.toBase58(), lvbh: 500_000_000, live: false };
  }
}

// A stub-gateway state whose build is an intent-valid trade tx for kp.
function makeTradeState(kp, blockhash, lvbh) {
  const wallet = kp.publicKey.toBase58();
  const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  return {
    balanceLamports: 100_000_000, blockHeight: lvbh - 100, blockhash, lastValidBlockHeight: lvbh,
    quoteVenue: 'curve', expectedWallet: wallet, expectedMessageBytes: tx.serializeMessage(),
    tokenMint: AGTR, tokenPreAmount: 0, tokenPostAmount: 500, postDebitLamports: 10_005_000,
    tokenAta: associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58(),
    simulateFail: null,
    eligibility: { status: 'eligible', reasons: [] },
    quote: { amountIn: '10000000', amountOut: '500', minimumAmountOut: '495', fees: { total: '0' }, priceImpactBps: 0, symbol: 'AGTR' },
    build: {
      status: 'ready_for_signature', symbol: 'AGTR', venue: 'curve',
      amount_in: '10000000', amount_out_expected: '500', minimum_amount_out: '495', price_impact_bps: 0,
      bundled: [], instruction_count: 3, transaction_base64: txB64,
      blockhash, last_valid_block_height: lvbh,
      simulation: { status: 'passed', layer: 'none', engineCode: null, name: null, reason: '', unitsConsumed: 150, provisional: true, note: 'stubbed passing simulation' },
      eligibility: { status: 'eligible', reasons: [] },
      quote: { venue: 'curve', amountIn: '10000000', amountOut: '500', minimumAmountOut: '495', fees: { total: '0' }, modeled: false, priceImpactBps: 0 },
      observedAt: new Date().toISOString(), rpcCalls: 6,
    },
  };
}

function tokenAccountBlob(mintB58, ownerB58, amount) {
  const buf = Buffer.alloc(165);
  buf.set(bs58.decode(mintB58), 0);
  buf.set(bs58.decode(ownerB58), 32);
  buf.writeBigUInt64LE(BigInt(amount), 64);
  return buf.toString('base64');
}

// ---------------------------------------------------------------------------
// Local stub: one HTTP server playing both the gateway (/v1/*) and a
// Solana JSON-RPC endpoint (everything else), driven by a mutable state.
// ---------------------------------------------------------------------------
function startStub(state) {
  const counts = { gateway: 0, rpc: 0, sendTransaction: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* keep {} */ }

      if (parsed.jsonrpc) {
        counts.rpc++;
        const { method, id } = parsed;
        if (method === 'getBalance') return send(200, { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: state.balanceLamports } });
        if (method === 'getBlockHeight') return send(200, { jsonrpc: '2.0', id, result: state.blockHeight });
        if (method === 'getLatestBlockhash') return send(200, { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: { blockhash: state.blockhash, lastValidBlockHeight: state.lastValidBlockHeight } } });
        if (method === 'getMultipleAccounts') {
          const addresses = parsed.params?.[0] ?? [];
          const value = addresses.map((a) => (a === state.expectedWallet
            ? { lamports: state.balanceLamports, owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false, rentEpoch: 0, space: 0 }
            : {
                lamports: 2_039_280, owner: TOKEN_2022_PROGRAM,
                data: [tokenAccountBlob(state.tokenMint, state.expectedWallet, state.tokenPreAmount ?? 0), 'base64'],
                executable: false, rentEpoch: 0, space: 165,
              }));
          return send(200, { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value } });
        }
        if (method === 'simulateTransaction') {
          if (state.simulateFail) {
            state.lastSimulateVerdict = { err: state.simulateFail };
            return send(200, { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: { err: state.simulateFail, unitsConsumed: 0, logs: [] } } });
          }
          const b64 = parsed.params?.[0];
          let verdict = { err: 'STUB_NO_TX' };
          try {
            const tx = Transaction.from(Buffer.from(b64, 'base64'));
            const sigOk = tx.verifySignatures();
            const payerOk = tx.feePayer?.toBase58() === state.expectedWallet;
            const msgOk = Buffer.from(tx.serializeMessage()).equals(Buffer.from(state.expectedMessageBytes));
            verdict = sigOk && payerOk && msgOk
              ? { err: null, unitsConsumed: 150, logs: ['Program log: stub success'] }
              : { err: `STUB_VERIFY_FAILED sig=${sigOk} payer=${payerOk} msg=${msgOk}` };
          } catch (e) {
            verdict = { err: `STUB_PARSE_FAILED ${e.message}` };
          }
          // Post-simulation account states, aligned to the requested
          // addresses — this is what delta enforcement reads.
          const wanted = parsed.params?.[1]?.accounts?.addresses;
          if (!verdict.err && Array.isArray(wanted)) {
            verdict.accounts = wanted.map((a) => (a === state.expectedWallet
              ? { lamports: state.balanceLamports - (state.postDebitLamports ?? 10_005_000), owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false, rentEpoch: 0, space: 0 }
              : {
                  lamports: 2_039_280, owner: TOKEN_2022_PROGRAM,
                  // only the trade's real ATA is credited; any other token
                  // account keeps its pre amount (zero delta)
                  data: [tokenAccountBlob(state.tokenMint, state.expectedWallet, a === state.tokenAta ? (state.tokenPostAmount ?? 500) : (state.tokenPreAmount ?? 0)), 'base64'],
                  executable: false, rentEpoch: 0, space: 165,
                }));
          }
          state.lastSimulateVerdict = verdict;
          return send(200, { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: verdict } });
        }
        if (method === 'sendTransaction') {
          counts.sendTransaction++;
          return send(200, { jsonrpc: '2.0', id, result: Keypair.generate().publicKey.toBase58() });
        }
        return send(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `stub: unhandled ${method}` } });
      }

      // gateway-style
      counts.gateway++;
      const env = { ok: true, endpoint: req.url, network: 'solana-mainnet' };
      if (req.url === '/v1/trade/eligibility') return send(200, { ...env, ...state.eligibility });
      if (req.url === '/v1/trade/quote') return send(200, { ...env, ...state.quote, venue: state.quoteVenue });
      if (req.url === '/v1/trade/build') return send(200, { ...env, ...state.build });
      return send(404, { ok: false, error: { code: 'NOT_FOUND', message: `stub: no route ${req.url}` } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, counts, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'agentonly-runtime-fixtures-'));
console.log(`fixtures workspace: ${tmp} (throwaway keys only; removed at the end)`);

// ---------------------------------------------------------------------------
// Fixture 1 — persistent local signer + attestation gate + exclusive create
// ---------------------------------------------------------------------------
{
  const file = join(tmp, 'f1.keypair.json');
  const create = await runCli(['wallet', 'create', '--file', file], { cwd: tmp });
  const addr = (create.stdout.match(/address: (\S+)/) ?? [])[1];
  const show = await runCli(['wallet', 'show', '--file', file], { cwd: tmp });
  const sidecarPath = `${file}.agentonly.json`;
  const sidecarExists = existsSync(sidecarPath);
  // Un-attested runtime-created wallet: prepare must refuse before network.
  const gated = await runCli(['prepare', '--file', file, '--mint', AGTR, '--side', 'buy', '--amount', '0.01'], { cwd: tmp });
  const attest = await runCli(['wallet', 'attest-persistence', '--file', file], { cwd: tmp });
  const sidecarParsed = sidecarExists ? JSON.parse(readFileSync(sidecarPath, 'utf8')) : {};
  const attestedAt = sidecarParsed.attestedAt ?? null;
  const bound = typeof sidecarParsed.keypairSha256 === 'string' && sidecarParsed.keypairSha256.length === 64;
  // Exclusive creation: a second create over the same path must refuse.
  const dupe = await runCli(['wallet', 'create', '--file', file], { cwd: tmp });
  const ok = create.code === 0
    && create.stdout.includes('persistence handshake: OK')
    && !!addr
    && show.code === 0 && show.stdout.trim() === addr
    && existsSync(file)
    && sidecarExists
    && gated.code !== 0 && gated.out.includes('WALLET_NOT_ATTESTED')
    && attest.code === 0 && !!attestedAt && bound
    && dupe.code !== 0 && dupe.out.includes('KEYPAIR_EXISTS');
  report(1, 'persistent local signer (create → handshake → sidecar → attestation gate → show)', ok, [
    `create exit=${create.code}, handshake line present=${create.stdout.includes('persistence handshake: OK')}`,
    `address from create: ${addr}; from show (separate process): ${show.stdout.trim()}`,
    `sidecar written=${sidecarExists}; prepare before attestation: exit=${gated.code} code=${gated.out.includes('WALLET_NOT_ATTESTED') ? 'WALLET_NOT_ATTESTED' : 'MISSING'}`,
    `attest exit=${attest.code}, sidecar attestedAt=${attestedAt}, keypair binding present=${bound}`,
    `second create over same path: exit=${dupe.code} (KEYPAIR_EXISTS=${dupe.out.includes('KEYPAIR_EXISTS')})`,
  ]);
}

// ---------------------------------------------------------------------------
// Fixture 2 — unsupported signer (bankr) refuses before any gateway call
// ---------------------------------------------------------------------------
{
  const state = { balanceLamports: 0, blockHeight: 1, quoteVenue: 'curve', eligibility: {}, quote: {}, build: {} };
  const stub = await startStub(state);
  const file = join(tmp, 'f2.keypair.json');
  writeKeypairFile(file, Keypair.generate());
  const r = await runCli(
    ['prepare', '--file', file, '--mint', AGTR, '--side', 'buy', '--amount', '0.01', '--signer-type', 'bankr'],
    { cwd: tmp, env: { AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url } },
  );
  stub.server.close();
  const ok = r.code !== 0 && r.out.includes('TK_SIGNER_UNSUPPORTED') && stub.counts.gateway === 0;
  report(2, 'unsupported signer refused up front (TK_SIGNER_UNSUPPORTED)', ok, [
    `exit=${r.code}, gateway requests made=${stub.counts.gateway} (must be 0)`,
    `message: ${r.out.trim().split('\n')[0].slice(0, 140)}…`,
  ]);
}

// ---------------------------------------------------------------------------
// Fixture 3 — unfunded wallet, LIVE gateway/RPC: honest funds failure.
// The wallet goes through the full new flow: create → attest → prepare.
// ---------------------------------------------------------------------------
{
  const dir = join(tmp, 'f3'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'fresh.keypair.json');
  const create = await runCli(['wallet', 'create', '--file', file], { cwd: dir });
  const attest = await runCli(['wallet', 'attest-persistence', '--file', file], { cwd: dir });
  const cardPath = join(dir, 'approval-card.json');
  const r = await runCli(
    ['prepare', '--file', file, '--mint', AGTR, '--side', 'buy', '--amount', '0.01', '--out', cardPath],
    { cwd: dir, env: { AGENTONLY_GATEWAY_BASE: REAL_GATEWAY, AGENTONLY_RPC_URL: REAL_RPC } },
  );
  const ok = create.code === 0 && attest.code === 0
    && r.code !== 0 && r.out.includes('INSUFFICIENT_FUNDS') && !existsSync(cardPath);
  report(3, 'unfunded wallet (live, created + attested) — funds failure surfaced, no card', ok, [
    `create exit=${create.code}, attest exit=${attest.code}, prepare exit=${r.code}, card written=${existsSync(cardPath)} (must be false)`,
    `message: ${r.out.trim().split('\n')[0].slice(0, 160)}…`,
  ]);
}

// ---------------------------------------------------------------------------
// Fixture 4 — hook veto on the gateway build's simulation → no card
// ---------------------------------------------------------------------------
{
  const state = {
    balanceLamports: 100_000_000, blockHeight: 1, quoteVenue: 'curve',
    eligibility: { status: 'eligible', reasons: [] },
    quote: { amountIn: '10000000', amountOut: '500', minimumAmountOut: '495', fees: { total: '0' }, priceImpactBps: 3, symbol: 'AGTR' },
    build: {
      status: 'ready_for_signature', symbol: 'AGTR', venue: 'curve',
      amount_in: '10000000', amount_out_expected: '500', minimum_amount_out: '495', price_impact_bps: 3,
      bundled: [], instruction_count: 2, transaction_base64: Buffer.from('stub').toString('base64'),
      blockhash: '11111111111111111111111111111111', last_valid_block_height: 999999999,
      simulation: {
        status: 'failed', layer: 'hook-veto', engineCode: 1, name: 'NotRegistered',
        reason: 'the receiving wallet has no active registry mirror for this token. Fix: register, then sync.',
        unitsConsumed: 54321, provisional: true, note: 'simulation runs against current chain state and is provisional',
      },
      eligibility: { status: 'eligible', reasons: [] },
      quote: { venue: 'curve', amountIn: '10000000', amountOut: '500', minimumAmountOut: '495', fees: { total: '0' }, modeled: false, priceImpactBps: 3 },
      observedAt: new Date().toISOString(), rpcCalls: 6,
    },
  };
  const stub = await startStub(state);
  const dir = join(tmp, 'f4'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'w.keypair.json'); writeKeypairFile(file, Keypair.generate());
  const cardPath = join(dir, 'approval-card.json');
  const r = await runCli(
    ['prepare', '--file', file, '--mint', AGTR, '--side', 'buy', '--amount', '0.01', '--out', cardPath],
    { cwd: dir, env: { AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url } },
  );
  stub.server.close();
  const ok = r.code !== 0 && r.out.includes('SIMULATION_FAILED') && r.out.includes('hook-veto') && r.out.includes('NotRegistered') && !existsSync(cardPath);
  report(4, 'hook veto on build simulation — classified, no card', ok, [
    `exit=${r.code}, card written=${existsSync(cardPath)} (must be false)`,
    `message: ${r.out.trim().split('\n')[0].slice(0, 200)}…`,
  ]);
}

// ---------------------------------------------------------------------------
// Fixtures 5 + 6 — hand-crafted v1 cards against a stub RPC. Both refuse
// BEFORE the intent gate by design (expiry / approval fire first).
// ---------------------------------------------------------------------------
function craftCard(wallet, txB64, lvbh) {
  const fp = fingerprintOf(txB64);
  return {
    version: 1, runtime: 'agentonly-runtime', createdAt: new Date().toISOString(),
    wallet, mint: AGTR, symbol: 'AGTR', side: 'buy', signerType: 'own', venue: 'curve',
    amount: '0.01', amountIn: '10000000', expectedAmountOut: '500', minimumAmountOut: '495',
    priceImpactBps: 3, fees: { total: '0' }, bundled: [],
    eligibility: { status: 'eligible', reasons: [] },
    simulation: { status: 'passed', layer: 'none', unitsConsumed: 100, provisional: true, note: 'stub' },
    blockhash: '11111111111111111111111111111111', lastValidBlockHeight: lvbh,
    transactionBase64: txB64, fingerprint: fp, approvalToken: fp,
  };
}
{
  const kp = Keypair.generate();
  const dir = join(tmp, 'f56'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'w.keypair.json'); writeKeypairFile(file, kp);
  const txB64 = Buffer.from('crafted-fixture-transaction-bytes').toString('base64');
  const wallet = kp.publicKey.toBase58();

  // Fixture 5 — expired build: chain height 2000 > card LVBH 1000.
  const stub5 = await startStub({ balanceLamports: 0, blockHeight: 2000, quoteVenue: 'curve', eligibility: {}, quote: {}, build: {} });
  const card5 = craftCard(wallet, txB64, 1000);
  const card5Path = join(dir, 'expired-card.json'); writeFileSync(card5Path, JSON.stringify(card5));
  const r5 = await runCli(
    ['send', '--file', file, '--card', card5Path, '--approve', card5.fingerprint],
    { cwd: dir, env: { AGENTONLY_GATEWAY_BASE: stub5.url, AGENTONLY_RPC_URL: stub5.url } },
  );
  stub5.server.close();
  const ok5 = r5.code !== 0 && r5.out.includes('BUILD_EXPIRED') && /rebuild, not retry/i.test(r5.out);
  report(5, 'expired build refused — rebuild, not retry', ok5, [
    `exit=${r5.code}`,
    `message: ${r5.out.trim().split('\n')[0].slice(0, 180)}…`,
  ]);

  // Fixture 6 — approval mismatch: wrong fingerprint, refused pre-signing.
  const card6 = craftCard(wallet, txB64, 999999999);
  const card6Path = join(dir, 'fresh-card.json'); writeFileSync(card6Path, JSON.stringify(card6));
  const r6 = await runCli(
    ['send', '--file', file, '--card', card6Path, '--approve', 'deadbeef'.repeat(8)],
    { cwd: dir, env: { AGENTONLY_RPC_URL: REAL_RPC } },
  );
  const ok6 = r6.code !== 0 && r6.out.includes('APPROVAL_MISMATCH');
  report(6, 'approval mismatch refused before signing', ok6, [
    `exit=${r6.code}`,
    `message: ${r6.out.trim().split('\n')[0].slice(0, 160)}…`,
  ]);
}

// ---------------------------------------------------------------------------
// Fixtures 7, 8, 9, 11 — one prepared v2 card, four send scenarios
// ---------------------------------------------------------------------------
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const dir = join(tmp, 'f78911'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'w.keypair.json'); writeKeypairFile(file, kp);
  const { blockhash, lvbh, live } = await liveBlockhash();
  if (!live) console.log('    (note: live blockhash fetch failed — synthetic blockhash used; the stub verifies signatures only)');

  const state = makeTradeState(kp, blockhash, lvbh);
  const stub = await startStub(state);
  const env = { AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url };
  const cardPath = join(dir, 'approval-card.json');

  const prep = await runCli(
    ['prepare', '--file', file, '--mint', AGTR, '--side', 'buy', '--amount', '0.01', '--out', cardPath],
    { cwd: dir, env },
  );
  const card = existsSync(cardPath) ? JSON.parse(readFileSync(cardPath, 'utf8')) : null;
  const deferred = {};

  if (!card) {
    for (const n of [7, 8, 9, 11]) deferred[n] = { ok: false, lines: [`prepare failed: ${prep.out.trim().split('\n')[0]}`] };
  } else {
    // Fixture 8 — flip the route (graduation), then send.
    state.quoteVenue = 'house';
    const r8 = await runCli(['send', '--file', file, '--card', cardPath, '--approve', card.approvalToken], { cwd: dir, env });
    deferred[8] = {
      ok: r8.code !== 0 && r8.out.includes('VENUE_CHANGED'),
      lines: [
        `prepare exit=${prep.code}, send exit=${r8.code} after quote venue flipped curve → house`,
        `message: ${r8.out.trim().split('\n')[0].slice(0, 200)}…`,
      ],
    };
    state.quoteVenue = 'curve'; // restore

    // Fixture 7 — happy path dry-run with delta enforcement.
    const r7 = await runCli(['send', '--file', file, '--card', cardPath, '--approve', card.approvalToken, '--dry-run'], { cwd: dir, env });
    const ok7 = r7.code === 0 && r7.out.includes('DRY RUN') && r7.out.includes('simulation err: null')
      && r7.out.includes('simulated deltas')
      && state.lastSimulateVerdict?.err === null
      && card.version === 3 && !!card.intent && card.blockhash === blockhash
      && card.maxSolDebitLamports === '15000000' && card.feeCeilingLamports === '5000000'
      // Repair round 3 (P0-1): the approval token is the POLICY hash —
      // distinct from the raw transaction fingerprint.
      && card.approvalToken !== card.fingerprint && /^[0-9a-f]{64}$/.test(card.approvalToken);
    deferred[7] = {
      ok: ok7,
      lines: [
        `send --dry-run exit=${r7.code}; card v${card.version}, intent present=${!!card.intent}, card blockhash matches build=${card.blockhash === blockhash}, bounds=${card.maxSolDebitLamports}/${card.feeCeilingLamports}`,
        `stub verdict on received bytes: err=${JSON.stringify(state.lastSimulateVerdict?.err)} (signature + fee payer + exact message verified by the stub)`,
        ...r7.stdout.trim().split('\n').slice(0, 5),
      ],
    };

    // Fixture 9 — forged card: friendly fields edited, bytes untouched.
    const forged = { ...card, amount: '0.02', minimumAmountOut: '1' };
    const forgedPath = join(dir, 'forged-card.json'); writeFileSync(forgedPath, JSON.stringify(forged));
    const r9 = await runCli(['send', '--file', file, '--card', forgedPath, '--approve', card.approvalToken, '--dry-run'], { cwd: dir, env });
    deferred[9] = {
      ok: r9.code !== 0 && r9.out.includes('INTENT_CARD_MISMATCH'),
      lines: [
        `send exit=${r9.code} with amount 0.01→0.02 and minimumAmountOut 495→1 (transaction bytes + fingerprint untouched)`,
        `message: ${r9.out.trim().split('\n')[0].slice(0, 200)}…`,
      ],
    };

    // Fixture 11 — broadcast path: simulation of the signed bytes fails.
    state.simulateFail = { InstructionError: [1, { Custom: 6001 }] };
    const sendsBefore = stub.counts.sendTransaction;
    const r11 = await runCli(['send', '--file', file, '--card', cardPath, '--approve', card.approvalToken], { cwd: dir, env });
    deferred[11] = {
      ok: r11.code !== 0 && r11.out.includes('SIMULATION_FAILED') && stub.counts.sendTransaction === sendsBefore,
      lines: [
        `non-dry-run send exit=${r11.code}; stub sendTransaction calls=${stub.counts.sendTransaction} (must stay ${sendsBefore})`,
        `message: ${r11.out.trim().split('\n')[0].slice(0, 200)}…`,
      ],
    };
    state.simulateFail = null;
  }
  stub.server.close();

  report(7, 'happy path dry-run — intent-valid build signed locally, signed-byte simulation + deltas enforced', deferred[7].ok, deferred[7].lines);
  report(8, 'graduation-driven route change — send refuses, demands rebuild', deferred[8].ok, deferred[8].lines);
  report(9, 'forged card (friendly fields edited) — INTENT_CARD_MISMATCH before signing', deferred[9].ok, deferred[9].lines);
  report(11, 'broadcast-path simulation failure — SIMULATION_FAILED, nothing broadcast', deferred[11].ok, deferred[11].lines);
}

// ---------------------------------------------------------------------------
// Fixture 10 — build/claim mismatch: the build's mint ≠ the requested mint
// ---------------------------------------------------------------------------
{
  const kp = Keypair.generate();
  const dir = join(tmp, 'f10'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'w.keypair.json'); writeKeypairFile(file, kp);
  const { blockhash, lvbh } = await liveBlockhash();
  const state = makeTradeState(kp, blockhash, lvbh);
  // Rebuild the gateway's transaction around a DIFFERENT mint.
  const otherMint = Keypair.generate().publicKey.toBase58();
  const badTx = buildTradeTx({ kp, mint: otherMint, pool: AGTR_POOL, blockhash, lvbh });
  state.build = { ...state.build, transaction_base64: badTx.serialize({ requireAllSignatures: false }).toString('base64') };
  const stub = await startStub(state);
  const cardPath = join(dir, 'approval-card.json');
  const r = await runCli(
    ['prepare', '--file', file, '--mint', AGTR, '--side', 'buy', '--amount', '0.01', '--out', cardPath],
    { cwd: dir, env: { AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url } },
  );
  stub.server.close();
  const ok = r.code !== 0 && r.out.includes('INTENT_MINT_MISMATCH') && !existsSync(cardPath);
  report(10, 'build/claim mismatch — prepare refuses a build for the wrong mint, no card', ok, [
    `exit=${r.code}, card written=${existsSync(cardPath)} (must be false)`,
    `message: ${r.out.trim().split('\n')[0].slice(0, 200)}…`,
  ]);
}

// ---------------------------------------------------------------------------
// Fixture 12 — confirmation strategy (library level): confirmTransaction
// must receive the CARD's blockhash + lastValidBlockHeight.
// ---------------------------------------------------------------------------
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const build = {
    status: 'ready_for_signature', symbol: 'AGTR', venue: 'curve',
    amount_in: '10000000', amount_out_expected: '500', minimum_amount_out: '495', price_impact_bps: 0,
    bundled: [], transaction_base64: txB64, blockhash, last_valid_block_height: lvbh,
    simulation: { status: 'passed', layer: 'none', unitsConsumed: 150, provisional: true, note: 'stub' },
  };
  const gwFetch = async (url) => {
    const u = String(url);
    const mk = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes('/v1/trade/eligibility')) return mk({ ok: true, status: 'eligible', reasons: [] });
    if (u.includes('/v1/trade/quote')) return mk({ ok: true, venue: 'curve', amountIn: '10000000', amountOut: '500', minimumAmountOut: '495', fees: { total: '0' }, priceImpactBps: 0, symbol: 'AGTR' });
    if (u.includes('/v1/trade/build')) return mk({ ok: true, ...build });
    throw new Error(`fixture 12: unexpected fetch ${u}`);
  };
  const tokenBlob = (amount) => {
    const buf = Buffer.alloc(165);
    buf.set(bs58.decode(AGTR), 0);
    buf.set(bs58.decode(wallet), 32);
    buf.writeBigUInt64LE(BigInt(amount), 64);
    return buf;
  };
  // Address-aware states (repair round 2): full-effect accounting reads
  // EVERY writable account, so the double must model the pool as the
  // counterparty (gains the SOL input, pays out of its own side) rather
  // than crediting every account +500 tokens.
  const ata12 = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const preFor = (addr) => {
    if (addr === wallet) return { lamports: 100_000_000, data: Buffer.alloc(0), owner: new PublicKey('11111111111111111111111111111111'), executable: false, rentEpoch: 0 };
    if (addr === ata12) return { lamports: 2_039_280, data: tokenBlob(0), owner: new PublicKey(TOKEN_2022_PROGRAM), executable: false, rentEpoch: 0 };
    if (addr === AGTR_POOL) return { lamports: 5_000_000, data: Buffer.alloc(0), owner: new PublicKey(DBC_PROGRAM), executable: false, rentEpoch: 0 };
    return null;
  };
  const postFor = (addr) => {
    if (addr === wallet) return { lamports: 100_000_000 - 10_005_000, data: Buffer.alloc(0), owner: new PublicKey('11111111111111111111111111111111'), executable: false, rentEpoch: 0 };
    if (addr === ata12) return { lamports: 2_039_280, data: tokenBlob(500), owner: new PublicKey(TOKEN_2022_PROGRAM), executable: false, rentEpoch: 0 };
    if (addr === AGTR_POOL) return { lamports: 5_000_000 + 10_000_000, data: Buffer.alloc(0), owner: new PublicKey(DBC_PROGRAM), executable: false, rentEpoch: 0 };
    return null;
  };
  let confirmArg = null; let rawSends = 0;
  const fakeSig = Keypair.generate().publicKey.toBase58();
  const conn = {
    rpcEndpoint: 'stub://fixture12',
    getBalance: async () => 100_000_000,
    getBlockHeight: async () => lvbh - 1,
    getMultipleAccountsInfo: async (keys) => keys.map((k) => preFor(k.toBase58())),
    simulateTransaction: async (txArg, cfg) => ({
      value: { err: null, unitsConsumed: 150, logs: [], accounts: (cfg?.accounts?.addresses ?? []).map(postFor) },
    }),
    sendRawTransaction: async () => { rawSends++; return fakeSig; },
    confirmTransaction: async (arg) => { confirmArg = arg; return { value: { err: null } }; },
    getTokenAccountsByOwner: async () => ({ value: [] }),
  };
  const tokenJson = { mint: AGTR, symbol: 'AGTR', decimals: 6, addresses: { pool: AGTR_POOL } };
  let ok = false; const lines = [];
  try {
    const card = await prepareTrade({
      wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own',
      fetchImpl: gwFetch, connection: conn, tokenJson,
    });
    const result = await sendCard({
      keypair: kp, card, approve: card.approvalToken, connection: conn, fetchImpl: gwFetch, tokenJson,
    });
    ok = result.mode === 'broadcast' && rawSends === 1
      && confirmArg?.blockhash === card.blockhash && card.blockhash === blockhash
      && confirmArg?.lastValidBlockHeight === card.lastValidBlockHeight && card.lastValidBlockHeight === lvbh
      && confirmArg?.signature === fakeSig;
    lines.push(
      `broadcast sends=${rawSends}, result mode=${result.mode}`,
      `confirmTransaction received blockhash=${confirmArg?.blockhash} (card: ${card.blockhash})`,
      `confirmTransaction received lastValidBlockHeight=${confirmArg?.lastValidBlockHeight} (card: ${card.lastValidBlockHeight})`,
    );
  } catch (e) {
    lines.push(`threw ${e.code ?? ''}: ${e.message}`);
  }
  report(12, 'confirmation strategy — card blockhash + LVBH, never a fresh blockhash', ok, lines);
}

// ---------------------------------------------------------------------------
// Fixture 13 — external signer adapter (good signer + message-altering one)
// ---------------------------------------------------------------------------
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const dir = join(tmp, 'f13'); mkdirSync(dir, { recursive: true });
  const keyFile = join(dir, 'signer.keypair.json'); writeKeypairFile(keyFile, kp);
  const { blockhash, lvbh } = await liveBlockhash();
  const state = makeTradeState(kp, blockhash, lvbh);
  const stub = await startStub(state);
  // Repair round 4, P1-5 + round 5, TIGHTEN-2: the external signer
  // must be ENROLLED in the user-owned allowlist before any send runs
  // it — as a complete invocation (executable + argv template), which
  // is what the sends below exercise against a fixture-local
  // allowlist.
  const env = {
    AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url,
    AGENTONLY_SIGNER_ALLOWLIST: join(dir, 'signers.json'),
  };
  const cardPath = join(dir, 'approval-card.json');

  // The signer scripts run from the temp dir, outside the project's
  // module tree — they anchor module resolution at the project's
  // package.json via createRequire.
  const signerGood = join(dir, 'signer-good.mjs');
  writeFileSync(signerGood, `
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { Keypair, Transaction } = createRequire(${JSON.stringify(join(ROOT, 'package.json'))})('@solana/web3.js');
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.argv[2], 'utf8'))));
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const tx = Transaction.from(Buffer.from(input.trim(), 'base64'));
  tx.partialSign(kp);
  process.stdout.write(tx.serialize().toString('base64'));
});
`);
  const signerEvil = join(dir, 'signer-evil.mjs');
  writeFileSync(signerEvil, `
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { Keypair, PublicKey, Transaction, TransactionInstruction } = createRequire(${JSON.stringify(join(ROOT, 'package.json'))})('@solana/web3.js');
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.argv[2], 'utf8'))));
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const tx = Transaction.from(Buffer.from(input.trim(), 'base64'));
  tx.add(new TransactionInstruction({ programId: new PublicKey('${MEMO_PROGRAM}'), keys: [], data: Buffer.from('altered') }));
  tx.partialSign(kp);
  process.stdout.write(tx.serialize().toString('base64'));
});
`);

  const prep = await runCli(
    ['prepare', '--signer-type', 'external', '--wallet', wallet, '--mint', AGTR, '--side', 'buy', '--amount', '0.01', '--out', cardPath],
    { cwd: dir, env },
  );
  const card = existsSync(cardPath) ? JSON.parse(readFileSync(cardPath, 'utf8')) : null;
  let ok = false; const lines = [`external prepare exit=${prep.code}, card written=${!!card}`];
  if (card) {
    // Repair round 5, TIGHTEN-2 + item 5: the send names ONLY the
    // enrolled executable; the complete invocation (interpreter +
    // script + keyfile) was bound at enrollment as a hashed argv
    // template. There are no send-time signer arguments anymore.
    const sendArgv = ['send', '--signer-type', 'external', '--external-signer', process.execPath, '--wallet', wallet, '--card', cardPath, '--approve', card.approvalToken, '--dry-run'];
    const enrollGood = await runCli(['signer', 'enroll', '--path', process.execPath, '--arg', signerGood, '--arg', keyFile], { cwd: dir, env });
    lines.push(`enroll (interpreter + good script + keyfile) exit=${enrollGood.code} (allowlist: fixture-local)`);
    const good = await runCli(sendArgv, { cwd: dir, env });
    lines.push(`good signer dry-run exit=${good.code}`);
    // The message-altering signer is enrolled as its OWN complete
    // invocation (re-enrollment replaces the interpreter's entry) —
    // its output still alters the message, and the returned-bytes
    // validation refuses it.
    const enrollEvil = await runCli(['signer', 'enroll', '--path', process.execPath, '--arg', signerEvil, '--arg', keyFile], { cwd: dir, env });
    lines.push(`enroll (evil invocation) exit=${enrollEvil.code}`);
    const evil = await runCli(sendArgv, { cwd: dir, env });
    lines.push(`message-altering signer exit=${evil.code}, code=${evil.out.includes('EXTERNAL_SIGNER_MISMATCH') ? 'EXTERNAL_SIGNER_MISMATCH' : 'MISSING'}`);
    lines.push(`evil message: ${evil.out.trim().split('\n')[0].slice(0, 160)}…`);
    // A shell-string signer ("node script key") must be refused as an
    // invalid executable path before any spawn.
    const shellForm = await runCli(
      ['send', '--signer-type', 'external', '--external-signer', `node ${signerGood} ${keyFile}`, '--wallet', wallet, '--card', cardPath, '--approve', card.approvalToken, '--dry-run'],
      { cwd: dir, env },
    );
    lines.push(`shell-string signer exit=${shellForm.code}, code=${shellForm.out.includes('EXTERNAL_SIGNER_INVALID') ? 'EXTERNAL_SIGNER_INVALID' : 'MISSING'}`);
    ok = enrollGood.code === 0 && enrollEvil.code === 0
      && good.code === 0 && good.out.includes('DRY RUN')
      && evil.code !== 0 && evil.out.includes('EXTERNAL_SIGNER_MISMATCH')
      && shellForm.code !== 0 && shellForm.out.includes('EXTERNAL_SIGNER_INVALID');
  } else {
    lines.push(`prepare output: ${prep.out.trim().split('\n')[0]}`);
  }
  stub.server.close();
  report(13, 'external signer — enrolled complete invocation (interpreter + script + keyfile), shell-free; altered message and shell-string refused', ok, lines);
}

// ---------------------------------------------------------------------------
// Fixture 14 — key-file hardening: 0644 refused, symlink refused
// ---------------------------------------------------------------------------
{
  const dir = join(tmp, 'f14'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'w.keypair.json'); writeKeypairFile(file, Keypair.generate());
  chmodSync(file, 0o644);
  const rPerms = await runCli(['wallet', 'show', '--file', file], { cwd: dir });
  chmodSync(file, 0o600);
  const link = join(dir, 'link.keypair.json'); symlinkSync(file, link);
  const rLink = await runCli(['wallet', 'show', '--file', link], { cwd: dir });
  const ok = rPerms.code !== 0 && rPerms.out.includes('KEYPAIR_PERMISSIONS')
    && rLink.code !== 0 && rLink.out.includes('KEYPAIR_SYMLINK');
  report(14, 'key-file hardening — group/world-readable and symlinked keypairs refused on load', ok, [
    `0644 file: exit=${rPerms.code}, code=${rPerms.out.includes('KEYPAIR_PERMISSIONS') ? 'KEYPAIR_PERMISSIONS' : 'MISSING'}`,
    `symlink:   exit=${rLink.code}, code=${rLink.out.includes('KEYPAIR_SYMLINK') ? 'KEYPAIR_SYMLINK' : 'MISSING'}`,
  ]);
}

// ---------------------------------------------------------------------------
// Fixture 15 — strict amount parsing
// ---------------------------------------------------------------------------
{
  const bad = ['1e-3', '-1', 'abc', '0.0000000001'];
  const lines = [];
  let allRejected = true;
  for (const b of bad) {
    let code = null;
    try { parseStrictDecimal(b, 9); } catch (e) { code = e.code; }
    if (code !== 'INVALID_AMOUNT') allRejected = false;
    lines.push(`'${b}' → ${code ?? 'ACCEPTED (bad!)'}`);
  }
  let goodOk = false;
  try {
    const p = parseStrictDecimal('0.01', 9);
    goodOk = p.raw === 10_000_000n && p.ui === '0.01';
    lines.push(`'0.01' → raw=${p.raw} ui=${p.ui}`);
  } catch (e) {
    lines.push(`'0.01' threw ${e.code}: ${e.message}`);
  }
  const state = { balanceLamports: 0, blockHeight: 1, quoteVenue: 'curve', eligibility: {}, quote: {}, build: {} };
  const stub = await startStub(state);
  const file = join(tmp, 'f15.keypair.json'); writeKeypairFile(file, Keypair.generate());
  const r = await runCli(
    ['prepare', '--file', file, '--mint', AGTR, '--side', 'buy', '--amount', '1e-3'],
    { cwd: tmp, env: { AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url } },
  );
  stub.server.close();
  lines.push(`CLI prepare --amount 1e-3: exit=${r.code}, gateway requests=${stub.counts.gateway} (must be 0)`);
  const ok = allRejected && goodOk && r.code !== 0 && r.out.includes('INVALID_AMOUNT') && stub.counts.gateway === 0;
  report(15, 'strict amounts — exponent/negative/garbage/over-precision rejected', ok, lines);
}

// ---------------------------------------------------------------------------
// Fixtures 16 + 17 — malicious bundled builds (repair round 2, P0-1b).
// A legitimate swap with an extra transfer bundled in must fail
// INSTRUCTION CLASSIFICATION at prepare: the card never exists, so
// nothing can ever be signed or broadcast.
// ---------------------------------------------------------------------------
{
  const { blockhash, lvbh } = await liveBlockhash();

  // Fixture 16 — valid AGTR buy + extra System transfer of 0.5 SOL
  // from the wallet to a stranger.
  {
    const kp = Keypair.generate();
    const dir = join(tmp, 'f16'); mkdirSync(dir, { recursive: true });
    const file = join(dir, 'w.keypair.json'); writeKeypairFile(file, kp);
    const state = makeTradeState(kp, blockhash, lvbh);
    const stranger = Keypair.generate().publicKey;
    const badTx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
    badTx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: stranger, lamports: 500_000_000 }));
    state.build = { ...state.build, transaction_base64: badTx.serialize({ requireAllSignatures: false }).toString('base64') };
    const stub = await startStub(state);
    const cardPath = join(dir, 'approval-card.json');
    const r = await runCli(
      ['prepare', '--file', file, '--mint', AGTR, '--side', 'buy', '--amount', '0.01', '--out', cardPath],
      { cwd: dir, env: { AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url } },
    );
    stub.server.close();
    const ok = r.code !== 0 && r.out.includes('UNCLASSIFIED_INSTRUCTION') && !existsSync(cardPath) && stub.counts.sendTransaction === 0;
    report(16, 'malicious bundle: swap + extra 0.5 SOL transfer to a stranger — classification refuses at prepare', ok, [
      `prepare exit=${r.code}, card written=${existsSync(cardPath)} (must be false), sendTransaction calls=${stub.counts.sendTransaction} (must be 0)`,
      `message: ${r.out.trim().split('\n')[0].slice(0, 200)}…`,
    ]);
  }

  // Fixture 17 — valid buy + transfer of an UNRELATED token out of the
  // wallet's other-mint ATA.
  {
    const kp = Keypair.generate();
    const dir = join(tmp, 'f17'); mkdirSync(dir, { recursive: true });
    const file = join(dir, 'w.keypair.json'); writeKeypairFile(file, kp);
    const state = makeTradeState(kp, blockhash, lvbh);
    const otherMint = Keypair.generate().publicKey;
    const stranger = Keypair.generate().publicKey;
    const srcAta = associatedTokenAddress(otherMint, kp.publicKey, TOKEN_2022_PROGRAM);
    const dstAta = associatedTokenAddress(otherMint, stranger, TOKEN_2022_PROGRAM);
    const data = Buffer.alloc(9);
    data[0] = 3; // Token Transfer
    data.writeBigUInt64LE(1000n, 1);
    const badTx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
    badTx.add(new TransactionInstruction({
      programId: new PublicKey(TOKEN_2022_PROGRAM),
      keys: [
        { pubkey: srcAta, isSigner: false, isWritable: true },
        { pubkey: dstAta, isSigner: false, isWritable: true },
        { pubkey: kp.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    }));
    state.build = { ...state.build, transaction_base64: badTx.serialize({ requireAllSignatures: false }).toString('base64') };
    const stub = await startStub(state);
    const cardPath = join(dir, 'approval-card.json');
    const r = await runCli(
      ['prepare', '--file', file, '--mint', AGTR, '--side', 'buy', '--amount', '0.01', '--out', cardPath],
      { cwd: dir, env: { AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url } },
    );
    stub.server.close();
    const ok = r.code !== 0 && r.out.includes('UNCLASSIFIED_INSTRUCTION') && !existsSync(cardPath) && stub.counts.sendTransaction === 0;
    report(17, 'malicious bundle: swap + unrelated-token transfer — classification refuses at prepare', ok, [
      `prepare exit=${r.code}, card written=${existsSync(cardPath)} (must be false), sendTransaction calls=${stub.counts.sendTransaction} (must be 0)`,
      `message: ${r.out.trim().split('\n')[0].slice(0, 200)}…`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Library-level double harness for fixtures 18, 19, 21 — a plain-object
// connection whose account states model a real buy counterparty:
// wallet pays 10,005,000 lamports, its ATA gains 500 AGTR, the pool
// gains the 10,000,000-lamport input.
// ---------------------------------------------------------------------------
function stdTokenBlob(mintB58, ownerB58, amount) {
  const buf = Buffer.alloc(165);
  buf.set(bs58.decode(mintB58), 0);
  buf.set(bs58.decode(ownerB58), 32);
  buf.writeBigUInt64LE(BigInt(amount), 64);
  return buf;
}
function acctState(lamports, data, owner) {
  return { lamports, data, owner, executable: false, rentEpoch: 0 };
}
function buyStateFns({ wallet, ata, pool, extraPre = {}, extraPost = {} }) {
  const SYS = new PublicKey('11111111111111111111111111111111');
  const T22 = new PublicKey(TOKEN_2022_PROGRAM);
  const preFor = (addr) => {
    if (addr in extraPre) return extraPre[addr];
    if (addr === wallet) return acctState(100_000_000, Buffer.alloc(0), SYS);
    if (addr === ata) return acctState(2_039_280, stdTokenBlob(AGTR, wallet, 0), T22);
    if (addr === pool) return acctState(5_000_000, Buffer.alloc(0), new PublicKey(DBC_PROGRAM));
    return null;
  };
  const postFor = (addr) => {
    if (addr in extraPost) return extraPost[addr];
    if (addr === wallet) return acctState(100_000_000 - 10_005_000, Buffer.alloc(0), SYS);
    if (addr === ata) return acctState(2_039_280, stdTokenBlob(AGTR, wallet, 500), T22);
    if (addr === pool) return acctState(5_000_000 + 10_000_000, Buffer.alloc(0), new PublicKey(DBC_PROGRAM));
    return null;
  };
  return { preFor, postFor };
}
// One normalized inner token transfer (TransferChecked layout) in
// the RESOLVED shape normalizeInnerInstructions consumes — what a
// real node's innerInstructions report for a CPI token transfer.
function innerTxfr(source, destination, amount) {
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked
  data.writeBigUInt64LE(BigInt(amount), 1);
  data[9] = 6; // AGTR decimals in the stub world
  return {
    programId: TOKEN_2022_PROGRAM,
    accounts: [source, AGTR, destination, SystemProgram.programId.toBase58()],
    data: bs58.encode(data),
  };
}
function makeDoubleConn({ preFor, postFor, blockHeight, altAccount = null, vaultBalance = 934n, innerFor = null }) {
  let rawSends = 0;
  const conn = {
    rpcEndpoint: 'stub://double',
    getBalance: async () => 100_000_000,
    getBlockHeight: async () => blockHeight,
    // The settlement model (repair round 4, P1-1) reads the
    // distributor vault through getAccountInfo at prepare time: a
    // token account for AGTR owned by the distributor state, holding
    // vaultBalance raw units (934 = the live vault balance when the
    // model was designed; fixtures override it as needed).
    getAccountInfo: async (pk) => {
      const addr = pk.toBase58();
      if (addr === DIST_VAULT) {
        return acctState(1_539_240, stdTokenBlob(AGTR, DIST_STATE, vaultBalance), new PublicKey(TOKEN_2022_PROGRAM));
      }
      return preFor(addr);
    },
    getMultipleAccountsInfo: async (keys) => keys.map((k) => preFor(k.toBase58())),
    simulateTransaction: async (txArg, cfg) => ({
      value: {
        err: null, unitsConsumed: 150, logs: [],
        accounts: (cfg?.accounts?.addresses ?? []).map(postFor),
        // Inner instructions (repair round 5, P0-1): the settlement
        // attribution reads these; fixtures that model a settlement
        // supply them via innerFor.
        ...(innerFor ? { innerInstructions: innerFor(txArg) } : {}),
      },
    }),
    sendRawTransaction: async () => { rawSends++; return Keypair.generate().publicKey.toBase58(); },
    confirmTransaction: async () => ({ value: { err: null } }),
    getTokenAccountsByOwner: async () => ({ value: [] }),
  };
  if (altAccount) conn.getAddressLookupTable = async () => ({ value: altAccount });
  return { conn, rawSends: () => rawSends };
}
function makeGwFetch(build) {
  return async (url) => {
    const u = String(url);
    const mk = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes('/v1/trade/eligibility')) return mk({ ok: true, status: 'eligible', reasons: [] });
    if (u.includes('/v1/trade/quote')) return mk({ ok: true, venue: 'curve', amountIn: '10000000', amountOut: '500', minimumAmountOut: '495', fees: { total: '0' }, priceImpactBps: 0, symbol: 'AGTR' });
    if (u.includes('/v1/trade/build')) return mk({ ok: true, ...build });
    throw new Error(`double harness: unexpected fetch ${u}`);
  };
}
function stubBuild(txB64, blockhash, lvbh) {
  return {
    status: 'ready_for_signature', symbol: 'AGTR', venue: 'curve',
    amount_in: '10000000', amount_out_expected: '500', minimum_amount_out: '495', price_impact_bps: 0,
    bundled: [], transaction_base64: txB64, blockhash, last_valid_block_height: lvbh,
    simulation: { status: 'passed', layer: 'none', unitsConsumed: 150, provisional: true, note: 'stub' },
  };
}
// AGTR's distributor addresses, from its live canonical record — the
// settlement model (repair round 4, P1-1) authenticates the vault
// against exactly these.
const DIST_STATE = 'cexMThLhJJgXnrxMY8ua8F1gTbLfGnoyGhwUVogbKkS';
const DIST_VAULT = '6LeucGfr2GBpCACQEJbCTjsAUnt2uwFLjHSBRKmjc5FA';
const TOKEN_JSON_STUB = {
  mint: AGTR, symbol: 'AGTR', decimals: 6,
  addresses: { pool: AGTR_POOL, distributor: { state: DIST_STATE, vault: DIST_VAULT } },
};

// ---------------------------------------------------------------------------
// Fixture 18 — simulation moves value to an unexpected third account
// (repair round 2, P0-1a). The transaction bytes themselves are
// intent-valid (an extra writable account rides in the venue
// instruction), but its post-simulation balance grows — full-effect
// accounting must refuse before broadcast.
// ---------------------------------------------------------------------------
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const impostor = Keypair.generate().publicKey.toBase58();
  const SYS = new PublicKey('11111111111111111111111111111111');
  const tx = buildTradeTx({
    kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh,
    extraKeys: [{ pubkey: new PublicKey(impostor), isSigner: false, isWritable: true }],
  });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const { preFor, postFor } = buyStateFns({
    wallet, ata, pool: AGTR_POOL,
    extraPost: { [impostor]: acctState(1_000_000, Buffer.alloc(0), SYS) },
  });
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
  const gwFetch = makeGwFetch(stubBuild(txB64, blockhash, lvbh));
  let ok = false; const lines = [];
  try {
    const card = await prepareTrade({
      wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own',
      fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB,
    });
    lines.push('prepare accepted the intent-valid build (extra writable account is not, by itself, a classification failure)');
    await sendCard({ keypair: kp, card, approve: card.approvalToken, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    lines.push('sendCard DID NOT throw — full-effect accounting failed to catch the impostor credit');
  } catch (e) {
    ok = e.code === 'UNEXPECTED_EFFECT' && rawSends() === 0;
    lines.push(`send threw ${e.code ?? ''}: ${e.message.slice(0, 180)}…`);
    lines.push(`sendRawTransaction calls=${rawSends()} (must be 0)`);
  }
  report(18, 'unexpected third account gains lamports in simulation — UNEXPECTED_EFFECT, nothing broadcast', ok, lines);
}

// ---------------------------------------------------------------------------
// Fixture 19 — simulation returns incomplete account states (repair
// round 2, P0-2): the send must fail closed, never broadcast.
// ---------------------------------------------------------------------------
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const { preFor, postFor } = buyStateFns({ wallet, ata, pool: AGTR_POOL });
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
  const goodSim = conn.simulateTransaction;
  conn.simulateTransaction = async (txArg, cfg) => {
    const r = await goodSim(txArg, cfg);
    r.value.accounts = r.value.accounts.slice(0, -1); // one expected account's state goes missing
    return r;
  };
  const gwFetch = makeGwFetch(stubBuild(txB64, blockhash, lvbh));
  let ok = false; const lines = [];
  try {
    const card = await prepareTrade({
      wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own',
      fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB,
    });
    await sendCard({ keypair: kp, card, approve: card.approvalToken, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    lines.push('sendCard DID NOT throw — missing simulation state was allowed through');
  } catch (e) {
    ok = e.code === 'SIMULATION_STATE_MISSING' && rawSends() === 0;
    lines.push(`send threw ${e.code ?? ''}: ${e.message.slice(0, 180)}…`);
    lines.push(`sendRawTransaction calls=${rawSends()} (must be 0)`);
  }
  report(19, 'simulation state incomplete — SIMULATION_STATE_MISSING fails closed, nothing broadcast', ok, lines);
}

// ---------------------------------------------------------------------------
// Fixture 20 — canonical token data unavailable at SEND time (repair
// round 2, P1-d): the CLI used to treat the record as best-effort and
// skip pool validation. Now the send refuses before signing.
// ---------------------------------------------------------------------------
{
  const kp = Keypair.generate();
  const dir = join(tmp, 'f20'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'w.keypair.json'); writeKeypairFile(file, kp);
  const { blockhash, lvbh } = await liveBlockhash();
  const state = makeTradeState(kp, blockhash, lvbh);
  const stub = await startStub(state);
  const cardPath = join(dir, 'approval-card.json');
  const prep = await runCli(
    ['prepare', '--file', file, '--mint', AGTR, '--side', 'buy', '--amount', '0.01', '--out', cardPath],
    { cwd: dir, env: { AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url } },
  );
  const card = existsSync(cardPath) ? JSON.parse(readFileSync(cardPath, 'utf8')) : null;
  let ok = false; const lines = [`prepare exit=${prep.code}, card written=${!!card}`];
  if (card) {
    // Point the SITE base at the stub, which 404s the token record.
    const r = await runCli(
      ['send', '--file', file, '--card', cardPath, '--approve', card.approvalToken, '--dry-run'],
      { cwd: dir, env: { AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url, AGENTONLY_SITE_BASE: stub.url } },
    );
    lines.push(`send exit=${r.code}, code=${r.out.includes('CANONICAL_DATA_UNAVAILABLE') ? 'CANONICAL_DATA_UNAVAILABLE' : 'MISSING'}, sendTransaction calls=${stub.counts.sendTransaction} (must be 0)`);
    lines.push(`message: ${r.out.trim().split('\n')[0].slice(0, 200)}…`);
    ok = r.code !== 0 && r.out.includes('CANONICAL_DATA_UNAVAILABLE') && stub.counts.sendTransaction === 0;
  }
  stub.server.close();
  report(20, 'canonical data unavailable at send — CANONICAL_DATA_UNAVAILABLE before signing', ok, lines);
}

// ---------------------------------------------------------------------------
// Fixture 21 — a REAL v0 transaction with an address lookup table
// (repair round 2, P1-f). Its serialized blob starts with the
// signature-count shortvec (0x01), not the version flag — the old
// byte-0 sniff misread it as legacy. Decode + intent validation +
// dry-run must all work through the ALT.
// ---------------------------------------------------------------------------
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const mintPk = new PublicKey(AGTR);
  const poolPk = new PublicKey(AGTR_POOL);
  const ataPk = associatedTokenAddress(mintPk, kp.publicKey, TOKEN_2022_PROGRAM);
  const altAccount = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: 0,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [poolPk, mintPk, ataPk],
    },
  });
  const msg = MessageV0.compile({
    payerKey: kp.publicKey,
    recentBlockhash: blockhash,
    addressLookupTableAccounts: [altAccount],
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({
        programId: new PublicKey(DBC_PROGRAM),
        keys: [
          { pubkey: kp.publicKey, isSigner: true, isWritable: true },
          { pubkey: poolPk, isSigner: false, isWritable: true },
          { pubkey: mintPk, isSigner: false, isWritable: false },
          { pubkey: ataPk, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([Buffer.from('b75d992818e6c297', 'hex'), Buffer.alloc(23, 7)]),
      }),
      new TransactionInstruction({
        programId: new PublicKey(MEMO_PROGRAM),
        keys: [],
        data: Buffer.from('agentonly-runtime fixture v0'),
      }),
    ],
  });
  const vtx = new VersionedTransaction(msg);
  const rawBytes = Buffer.from(vtx.serialize());
  const txB64 = rawBytes.toString('base64');
  const ata = ataPk.toBase58();
  const { preFor, postFor } = buyStateFns({ wallet, ata, pool: AGTR_POOL });
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1, altAccount });
  const gwFetch = makeGwFetch(stubBuild(txB64, blockhash, lvbh));
  let ok = false; const lines = [
    `serialized v0 blob: first byte=0x${rawBytes[0].toString(16)} (signature-count shortvec — the version flag lives in the message header, after the signatures)`,
  ];
  try {
    const card = await prepareTrade({
      wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own',
      fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB,
    });
    const result = await sendCard({
      keypair: kp, card, approve: card.approvalToken, dryRun: true,
      connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB,
    });
    const intentOk = card.intent?.version === '0'
      && card.intent.writableAccounts.includes(AGTR_POOL)
      && card.intent.writableAccounts.includes(ata);
    ok = intentOk && result.mode === 'dry-run' && rawSends() === 0;
    lines.push(
      `intent version=${card.intent?.version} (must be '0'), ALT-resolved pool writable=${card.intent?.writableAccounts.includes(AGTR_POOL)}, ATA writable=${card.intent?.writableAccounts.includes(ata)}`,
      `dry-run result mode=${result.mode}, deltas=${JSON.stringify(result.deltas)}, sendRawTransaction calls=${rawSends()} (must be 0)`,
    );
  } catch (e) {
    lines.push(`threw ${e.code ?? ''}: ${e.message.slice(0, 200)}`);
  }
  report(21, 'real v0 transaction + address lookup table — decode, intent validation, dry-run', ok, lines);
}

// ---------------------------------------------------------------------------
// Fixture 22 — sidecar binding (repair round 2, P1-g): a sidecar copied
// from another wallet refuses, and so does a keypair file whose bytes
// changed after attestation (same key, reformatted JSON).
// ---------------------------------------------------------------------------
{
  const stub = await startStub({ balanceLamports: 0, blockHeight: 1, quoteVenue: 'curve', eligibility: {}, quote: {}, build: {} });
  const env = { AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url };
  const lines = [];
  let ok = true;
  const mkWallet = async (name) => {
    const dir = join(tmp, name); mkdirSync(dir, { recursive: true });
    const file = join(dir, 'w.keypair.json');
    const c = await runCli(['wallet', 'create', '--file', file], { cwd: dir });
    const a = await runCli(['wallet', 'attest-persistence', '--file', file], { cwd: dir });
    if (c.code !== 0 || a.code !== 0) throw new Error(`wallet setup failed for ${name}`);
    return { dir, file };
  };
  try {
    const A = await mkWallet('f22a');
    const B = await mkWallet('f22b');
    // Copy A's sidecar over B's: prepares/sends on B must refuse.
    writeFileSync(`${B.file}.agentonly.json`, readFileSync(`${A.file}.agentonly.json`, 'utf8'));
    chmodSync(`${B.file}.agentonly.json`, 0o600);
    const prepB = await runCli(['prepare', '--file', B.file, '--mint', AGTR, '--side', 'buy', '--amount', '0.01'], { cwd: B.dir, env });
    const copiedOk = prepB.code !== 0 && prepB.out.includes('SIDECAR_BINDING_MISMATCH');
    lines.push(`copied sidecar: prepare exit=${prepB.code}, code=${prepB.out.includes('SIDECAR_BINDING_MISMATCH') ? 'SIDECAR_BINDING_MISMATCH' : 'MISSING'}`);
    ok = ok && copiedOk;

    // Reformat C's keypair file (same key bytes semantically, different
    // file bytes): the hash binding must refuse.
    const C = await mkWallet('f22c');
    const arr = JSON.parse(readFileSync(C.file, 'utf8'));
    const showBefore = await runCli(['wallet', 'show', '--file', C.file], { cwd: C.dir });
    writeFileSync(C.file, JSON.stringify(arr, null, 2));
    chmodSync(C.file, 0o600);
    const showAfter = await runCli(['wallet', 'show', '--file', C.file], { cwd: C.dir });
    const prepC = await runCli(['prepare', '--file', C.file, '--mint', AGTR, '--side', 'buy', '--amount', '0.01'], { cwd: C.dir, env });
    const reformatOk = showAfter.stdout.trim() === showBefore.stdout.trim()
      && prepC.code !== 0 && prepC.out.includes('SIDECAR_BINDING_MISMATCH');
    lines.push(`reformatted keypair file: same address derives (${showAfter.stdout.trim() === showBefore.stdout.trim()}), prepare exit=${prepC.code}, code=${prepC.out.includes('SIDECAR_BINDING_MISMATCH') ? 'SIDECAR_BINDING_MISMATCH' : 'MISSING'}`);
    ok = ok && reformatOk;
  } catch (e) {
    ok = false;
    lines.push(`setup failure: ${e.message}`);
  }
  stub.server.close();
  report(22, 'sidecar binding — copied sidecar and reformatted keypair file both refused', ok, lines);
}

// ---------------------------------------------------------------------------
// Fixtures 23 + 24 — the REAL gateway build shape (repair round 2.1).
// A live AGTR buy build from the production gateway decodes to:
// ComputeBudget limit → fee distributor settle ×2 → ATA create (the
// wallet's WSOL ATA) → System transfer wallet→WSOL ATA (the wrap) →
// SyncNative → Meteora DBC swap → CloseAccount on the WSOL ATA (the
// unwrap). The round-2 classifier refused this at the ATA create.
// ---------------------------------------------------------------------------
const DIST_PROGRAM = 'DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa';
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function buildRealShapeTx({ kp, mint, pool, blockhash, lvbh, wrapDestination = null }) {
  const wallet = kp.publicKey;
  const mintPk = new PublicKey(mint);
  const wsolPk = new PublicKey(WSOL_MINT);
  const wsolAta = associatedTokenAddress(wsolPk, wallet, TOKEN_PROGRAM_ID);
  const cardAta = associatedTokenAddress(mintPk, wallet, TOKEN_2022_PROGRAM);
  const wrapTo = wrapDestination ?? wsolAta;
  const tx = new Transaction({ feePayer: wallet, blockhash, lastValidBlockHeight: lvbh });
  // 1. ComputeBudget: set unit limit
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  // 2 + 3. AgentOnly fee distributor settles — the REAL production
  // shape (repair round 3): data exactly [3], the fixed 9-account
  // prefix the gateway's Trade Kit builds (payer, holder, holder ATA,
  // mint, distributor state, distributor vault, derived claim PDA,
  // Token-2022 program, System program) plus a hook-extra tail.
  // Round 2's synthetic [wallet, mint] / data-[7] shape no longer
  // classifies — that is the point of the shape validation.
  const claimPda = distributorClaimPda(mint, wallet.toBase58());
  for (let i = 0; i < 2; i++) {
    tx.add(new TransactionInstruction({
      programId: new PublicKey(DIST_PROGRAM),
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: wallet, isSigner: false, isWritable: false },
        { pubkey: cardAta, isSigner: false, isWritable: true },
        { pubkey: mintPk, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('cexMThLhJJgXnrxMY8ua8F1gTbLfGnoyGhwUVogbKkS'), isSigner: false, isWritable: true },
        { pubkey: new PublicKey('6LeucGfr2GBpCACQEJbCTjsAUnt2uwFLjHSBRKmjc5FA'), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(claimPda), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(TOKEN_2022_PROGRAM), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: mintPk, isSigner: false, isWritable: false },
        { pubkey: cardAta, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([3]),
    }));
  }
  // 4. ATA create (idempotent) for the wallet's WSOL ATA
  tx.add(new TransactionInstruction({
    programId: new PublicKey(ATA_PROGRAM_ID),
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: wsolAta, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: false },
      { pubkey: wsolPk, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  }));
  // 5. Wrap leg: System transfer of the trade SOL into the WSOL ATA
  tx.add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wrapTo, lamports: 10_000_000 }));
  // 6. SyncNative on the WSOL ATA
  tx.add(new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
    data: Buffer.from([17]),
  }));
  // 7. Venue swap — Meteora DBC, touching WSOL ATA + card ATA + pool
  tx.add(new TransactionInstruction({
    programId: new PublicKey(DBC_PROGRAM),
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(pool), isSigner: false, isWritable: true },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: wsolAta, isSigner: false, isWritable: true },
      { pubkey: cardAta, isSigner: false, isWritable: true },
      { pubkey: wsolPk, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from('b75d992818e6c297', 'hex'), Buffer.alloc(23, 7)]),
  }));
  // 8. Unwrap: close the WSOL ATA, lamports back to the wallet
  tx.add(new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: wsolAta, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([9]), // CloseAccount
  }));
  return { tx, wsolAta, cardAta };
}

// ---------------------------------------------------------------------------
// Fixture 23 — real build shape end to end: prepare classifies it, the
// dry-run send accounts it. Lamport story (buyStateFns): the wallet
// pays fee 5,000 + ATA rent 2,039,280 + wrap 10,000,000 and gets the
// 2,039,280 close refund back → net −10,005,000; the WSOL ATA is
// created and closed inside the trade (pre/post both nonexistent →
// contribution 0); the pool gains the 10,000,000 input; the wallet's
// card ATA gains 500 tokens.
// ---------------------------------------------------------------------------
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const { tx, cardAta } = buildRealShapeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  // Settlement story (repair round 5, P0-1): the two bundled settles
  // pay the wallet 3 + 2 raw units out of the distributor vault
  // (934 → 929, the double's prepare-time balance), and the swap leg
  // credits the remaining 495 — exactly the card's minimum out. The
  // vault's account state is modeled (extraPre/extraPost) so the
  // attributed payouts sum to its measured outflow.
  const T22 = new PublicKey(TOKEN_2022_PROGRAM);
  const { preFor, postFor } = buyStateFns({
    wallet, ata: cardAta.toBase58(), pool: AGTR_POOL,
    extraPre: { [DIST_VAULT]: acctState(1_539_240, stdTokenBlob(AGTR, DIST_STATE, 934), T22) },
    extraPost: { [DIST_VAULT]: acctState(1_539_240, stdTokenBlob(AGTR, DIST_STATE, 929), T22) },
  });
  const poolVaultAta = associatedTokenAddress(new PublicKey(AGTR), new PublicKey(AGTR_POOL), TOKEN_2022_PROGRAM).toBase58();
  const innerFor = () => ([
    { index: 1, instructions: [innerTxfr(DIST_VAULT, cardAta.toBase58(), 3)] },
    { index: 2, instructions: [innerTxfr(DIST_VAULT, cardAta.toBase58(), 2)] },
    { index: 6, instructions: [innerTxfr(poolVaultAta, cardAta.toBase58(), 495)] },
  ]);
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1, innerFor });
  const gwFetch = makeGwFetch(stubBuild(txB64, blockhash, lvbh));
  let ok = false; const lines = [];
  try {
    const card = await prepareTrade({
      wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own',
      fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB,
    });
    lines.push(`prepare ACCEPTED the real build shape: venue=${card.venue}, instructions=${card.intent.instructions.length} (must be 8)`);
    const result = await sendCard({
      keypair: kp, card, approve: card.approvalToken, dryRun: true,
      connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB,
    });
    ok = card.intent.instructions.length === 8
      && result.mode === 'dry-run'
      && result.deltas.solDelta === -10_005_000
      && result.deltas.tokenDelta === '500'
      && result.deltas.settlementOwnPayoutRaw === '5'
      && rawSends() === 0;
    lines.push(
      `dry-run deltas: solDelta=${result.deltas.solDelta} (must be -10005000: fee + trade input, WSOL ATA nets 0), tokenDelta=${result.deltas.tokenDelta} (must be 500 = 495 swap + 5 measured settlement payout)`,
      `sendRawTransaction calls=${rawSends()} (must be 0)`,
    );
  } catch (e) {
    lines.push(`threw ${e.code ?? ''}: ${e.message.slice(0, 220)}`);
  }
  report(23, 'real gateway build shape (WSOL wrap/unwrap) — prepare + dry-run pass with correct aggregate deltas and a measured settlement payout', ok, lines);
}

// ---------------------------------------------------------------------------
// Fixture 24 — same real shape, but the wrap leg sends the trade SOL
// to a STRANGER's WSOL-lookalike ATA (derived for the stranger, not
// the wallet). Create/sync/close still name the wallet's own ATA —
// the transfer alone must refuse the whole build at prepare.
// ---------------------------------------------------------------------------
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const stranger = Keypair.generate().publicKey;
  const strangerWsolAta = associatedTokenAddress(new PublicKey(WSOL_MINT), stranger, TOKEN_PROGRAM_ID);
  const { tx } = buildRealShapeTx({
    kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh, wrapDestination: strangerWsolAta,
  });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const { preFor, postFor } = buyStateFns({ wallet, ata, pool: AGTR_POOL });
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
  const gwFetch = makeGwFetch(stubBuild(txB64, blockhash, lvbh));
  let ok = false; const lines = [];
  try {
    await prepareTrade({
      wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own',
      fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB,
    });
    lines.push('prepareTrade DID NOT throw — the stranger wrap destination was accepted');
  } catch (e) {
    ok = (e.code === 'UNCLASSIFIED_INSTRUCTION' || e.code === 'UNEXPECTED_EFFECT') && rawSends() === 0;
    lines.push(`prepare threw ${e.code ?? ''}: ${e.message.slice(0, 200)}…`);
    lines.push(`sendRawTransaction calls=${rawSends()} (must be 0)`);
  }
  report(24, 'wrap leg to a stranger\u2019s WSOL-lookalike ATA — refused at prepare, 0 sends', ok, lines);
}

// ---------------------------------------------------------------------------
// Fixtures 25–31 — repair round 3 (PR #5, Codex round-2 review).
// 25 approval token binds the full economic policy (P0-1), 26 sell
// debit must be exact (P0-2), 27 platform instruction shape validation
// (P1-1), 28 canonical binding required in the core send path (P1-2),
// 29 sidecar writes refuse symlinks and are atomic (P1-3), 30 empty
// post-simulation token data is malformed (P1-4), 31 a confirmed
// on-chain error is a failure, not a receipt (P1-5).
// ---------------------------------------------------------------------------

// Fixture 25 — P0-1: consistent post-approval alteration of each policy
// field (validation record AND its displayed copy edited together)
// must invalidate the approval. The fields the fresh-quote cross-check
// independently anchors (minimum out, expected out) refuse there; the
// fields only the approval token binds (amount via an echoing quote,
// max debit, fee ceiling) must refuse with POLICY_BINDING_MISMATCH.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const { preFor, postFor } = buyStateFns({ wallet, ata, pool: AGTR_POOL });
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
  const build = stubBuild(txB64, blockhash, lvbh);
  // Quote double that echoes the requested amount (as the real gateway
  // does), so an amount alteration is not caught by the quote anchor
  // and must be caught by the policy binding itself.
  const gwFetch = async (url, opts) => {
    const u = String(url);
    const mk = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes('/v1/trade/eligibility')) return mk({ ok: true, status: 'eligible', reasons: [] });
    if (u.includes('/v1/trade/quote')) {
      const amount = JSON.parse(opts.body).amount;
      const amountIn = String(BigInt(Math.round(parseFloat(amount) * 1e9)));
      return mk({ ok: true, venue: 'curve', amountIn, amountOut: '500', minimumAmountOut: '495', fees: { total: '0' }, priceImpactBps: 0, symbol: 'AGTR' });
    }
    if (u.includes('/v1/trade/build')) return mk({ ok: true, ...build });
    throw new Error(`fixture 25: unexpected fetch ${u}`);
  };
  const lines = [];
  let ok = true;
  try {
    const card = await prepareTrade({
      wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own',
      fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB,
    });
    if (card.approvalToken === card.fingerprint) { ok = false; lines.push('approval token still equals the raw transaction fingerprint'); }
    const control = await sendCard({ keypair: kp, card, approve: card.approvalToken, dryRun: true, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    lines.push(`control (unaltered card): dry-run mode=${control.mode}`);
    const mutations = [
      ['minimumAmountOutRaw', (c) => { c.validation.minimumAmountOutRaw = '1'; c.minimumAmountOut = '1'; }, ['QUOTE_MISMATCH', 'POLICY_BINDING_MISMATCH']],
      ['expectedAmountOutRaw', (c) => { c.validation.expectedAmountOutRaw = '999'; c.expectedAmountOut = '999'; }, ['QUOTE_MISMATCH', 'POLICY_BINDING_MISMATCH']],
      ['amountInRaw', (c) => { c.validation.amountInRaw = '20000000'; c.validation.amountUi = '0.02'; c.amount = '0.02'; }, ['POLICY_BINDING_MISMATCH']],
      ['maxSolDebitLamports', (c) => { c.validation.maxSolDebitLamports = '1'; c.maxSolDebitLamports = '1'; }, ['POLICY_BINDING_MISMATCH']],
      ['feeCeilingLamports', (c) => { c.validation.feeCeilingLamports = '1'; c.feeCeilingLamports = '1'; }, ['POLICY_BINDING_MISMATCH']],
    ];
    for (const [field, mutate, codes] of mutations) {
      const forged = JSON.parse(JSON.stringify(card));
      mutate(forged);
      let code = 'NO-THROW';
      try {
        await sendCard({ keypair: kp, card: forged, approve: card.approvalToken, dryRun: true, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
      } catch (e) { code = e.code ?? 'ERR'; }
      const good = codes.includes(code);
      ok = ok && good;
      lines.push(`alter ${field} (validation + displayed copy, consistently): refused=${good} code=${code}`);
    }
    ok = ok && rawSends() === 0;
    lines.push(`sendRawTransaction calls=${rawSends()} (must be 0)`);
  } catch (e) {
    ok = false;
    lines.push(`setup failure: ${e.code ?? ''} ${e.message.slice(0, 200)}`);
  }
  report(25, 'policy binding — consistent post-approval alteration of any policy field invalidates the approval token', ok, lines);
}

// Fixture 26 — P0-2: the sell debit must be EXACT. A simulation that
// debits 200 against an approved 100-token sell refuses; exactly 100
// passes end to end.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const SYS = new PublicKey('11111111111111111111111111111111');
  const T22 = new PublicKey(TOKEN_2022_PROGRAM);
  const sellStates = (tokenDelta) => ({
    preFor: (addr) => {
      if (addr === wallet) return acctState(100_000_000, Buffer.alloc(0), SYS);
      if (addr === ata) return acctState(2_039_280, stdTokenBlob(AGTR, wallet, 1000), T22);
      if (addr === AGTR_POOL) return acctState(5_000_000, Buffer.alloc(0), new PublicKey(DBC_PROGRAM));
      return null;
    },
    postFor: (addr) => {
      if (addr === wallet) return acctState(100_000_000 + 8_500_000, Buffer.alloc(0), SYS);
      if (addr === ata) return acctState(2_039_280, stdTokenBlob(AGTR, wallet, 1000 + tokenDelta), T22);
      if (addr === AGTR_POOL) return acctState(5_000_000, Buffer.alloc(0), new PublicKey(DBC_PROGRAM));
      return null;
    },
  });
  const sellBuild = {
    status: 'ready_for_signature', symbol: 'AGTR', venue: 'curve',
    amount_in: '100', amount_out_expected: '9000000', minimum_amount_out: '8000000', price_impact_bps: 0,
    bundled: [], transaction_base64: txB64, blockhash, last_valid_block_height: lvbh,
    simulation: { status: 'passed', layer: 'none', unitsConsumed: 150, provisional: true, note: 'stub' },
  };
  const gwFetch = async (url) => {
    const u = String(url);
    const mk = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes('/v1/trade/eligibility')) return mk({ ok: true, status: 'eligible', reasons: [] });
    if (u.includes('/v1/trade/quote')) return mk({ ok: true, venue: 'curve', amountIn: '100', amountOut: '9000000', minimumAmountOut: '8000000', fees: { total: '0' }, priceImpactBps: 0, symbol: 'AGTR' });
    if (u.includes('/v1/trade/build')) return mk({ ok: true, ...sellBuild });
    throw new Error(`fixture 26: unexpected fetch ${u}`);
  };
  const lines = [];
  let ok = true;
  try {
    const over = makeDoubleConn({ ...sellStates(-200), blockHeight: lvbh - 1 });
    const cardOver = await prepareTrade({
      wallet, mint: AGTR, side: 'sell', amount: '0.0001', signerType: 'own',
      fetchImpl: gwFetch, connection: over.conn, tokenJson: TOKEN_JSON_STUB,
    });
    let code = 'NO-THROW';
    try {
      await sendCard({ keypair: kp, card: cardOver, approve: cardOver.approvalToken, connection: over.conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    } catch (e) { code = e.code ?? 'ERR'; }
    ok = ok && code === 'ECONOMIC_BOUND_EXCEEDED' && over.rawSends() === 0;
    lines.push(`approved 100 sell, simulated debit 200: refused=${code === 'ECONOMIC_BOUND_EXCEEDED'} code=${code}, sends=${over.rawSends()}`);

    const exact = makeDoubleConn({ ...sellStates(-100), blockHeight: lvbh - 1 });
    const cardExact = await prepareTrade({
      wallet, mint: AGTR, side: 'sell', amount: '0.0001', signerType: 'own',
      fetchImpl: gwFetch, connection: exact.conn, tokenJson: TOKEN_JSON_STUB,
    });
    const receipt = await sendCard({ keypair: kp, card: cardExact, approve: cardExact.approvalToken, connection: exact.conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    ok = ok && receipt.mode === 'broadcast' && exact.rawSends() === 1;
    lines.push(`approved 100 sell, simulated debit exactly 100: broadcast mode=${receipt.mode}, sends=${exact.rawSends()}`);
  } catch (e) {
    ok = false;
    lines.push(`setup failure: ${e.code ?? ''} ${e.message.slice(0, 200)}`);
  }
  report(26, 'sell debit exactness — over-debit refused, exact debit passes (P0-2)', ok, lines);
}

// Fixture 27 — P1-1: platform instructions need discriminator +
// account-shape validation. Three data-only / mis-shaped mutations on
// platform programs must refuse at PREPARE even though their program
// identity is legitimate: an Engine operator-repair tag, a Distributor
// instruction with the wrong tag, a Registry register pointed at a
// stranger's registration PDA.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const { preFor, postFor } = buyStateFns({ wallet, ata, pool: AGTR_POOL });
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
  const SYS = SystemProgram.programId;
  const variants = [
    ['engine tag 9 (RefreshExtraAccountMetas — operator repair)', new TransactionInstruction({
      programId: new PublicKey(PLATFORM_PROGRAMS.engine),
      keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from([9]),
    })],
    ['distributor wrong tag (data [7], settle-shaped keys)', new TransactionInstruction({
      programId: new PublicKey(PLATFORM_PROGRAMS.distributor),
      keys: [
        { pubkey: kp.publicKey, isSigner: true, isWritable: true },
        { pubkey: kp.publicKey, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(ata), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(AGTR), isSigner: false, isWritable: false },
        { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
        { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
        { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(TOKEN_2022_PROGRAM), isSigner: false, isWritable: false },
        { pubkey: SYS, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([7]),
    })],
    ['registry register for a stranger\u2019s PDA', new TransactionInstruction({
      programId: new PublicKey(PLATFORM_PROGRAMS.registry),
      keys: [
        { pubkey: kp.publicKey, isSigner: true, isWritable: true },
        { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
        { pubkey: SYS, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([0, 0]),
    })],
  ];
  const lines = [];
  let ok = true;
  for (const [name, evil] of variants) {
    const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
    tx.add(evil);
    const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
    const gwFetch = makeGwFetch(stubBuild(txB64, blockhash, lvbh));
    let code = 'NO-THROW';
    try {
      await prepareTrade({
        wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own',
        fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB,
      });
    } catch (e) { code = e.code ?? 'ERR'; }
    const good = code === 'UNCLASSIFIED_INSTRUCTION';
    ok = ok && good;
    lines.push(`${name}: refused at prepare=${good} code=${code}`);
  }
  ok = ok && rawSends() === 0;
  lines.push(`sendRawTransaction calls=${rawSends()} (must be 0)`);
  report(27, 'platform shape validation — data-only/mis-shaped platform instructions refused at prepare (P1-1)', ok, lines);
}

// Fixture 28 — P1-2: canonical binding is required in the CORE library,
// not only in CLI plumbing: (a) validateIntent with a venue but no
// canonical record refuses; (b) sendCard with no record supplied and
// the record fetch failing refuses closed; (c) a card naming no venue
// refuses in sendCard itself.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const { preFor, postFor } = buyStateFns({ wallet, ata, pool: AGTR_POOL });
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
  const gwFetch = makeGwFetch(stubBuild(txB64, blockhash, lvbh));
  const lines = [];
  let ok = true;
  try {
    const card = await prepareTrade({
      wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own',
      fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB,
    });
    let codeA = 'NO-THROW';
    try {
      validateIntent(card.intent, { wallet, mint: AGTR, side: 'buy', venue: 'curve' });
    } catch (e) { codeA = e.code ?? 'ERR'; }
    ok = ok && codeA === 'CANONICAL_RECORD_REQUIRED';
    lines.push(`validateIntent(venue, no record): refused=${codeA === 'CANONICAL_RECORD_REQUIRED'} code=${codeA}`);

    let codeB = 'NO-THROW';
    try {
      await sendCard({ keypair: kp, card, approve: card.approvalToken, dryRun: true, connection: conn, fetchImpl: gwFetch });
    } catch (e) { codeB = e.code ?? 'ERR'; }
    ok = ok && codeB === 'CANONICAL_DATA_UNAVAILABLE';
    lines.push(`sendCard(no record supplied, fetch fails): refused=${codeB === 'CANONICAL_DATA_UNAVAILABLE'} code=${codeB}`);

    const venueless = JSON.parse(JSON.stringify(card));
    venueless.venue = null;
    venueless.validation.venue = null;
    let codeC = 'NO-THROW';
    try {
      await sendCard({ keypair: kp, card: venueless, approve: card.approvalToken, dryRun: true, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    } catch (e) { codeC = e.code ?? 'ERR'; }
    ok = ok && codeC === 'CANONICAL_BINDING_MISSING';
    lines.push(`sendCard(card names no venue): refused=${codeC === 'CANONICAL_BINDING_MISSING'} code=${codeC}`);
    ok = ok && rawSends() === 0;
    lines.push(`sendRawTransaction calls=${rawSends()} (must be 0)`);
  } catch (e) {
    ok = false;
    lines.push(`setup failure: ${e.code ?? ''} ${e.message.slice(0, 200)}`);
  }
  report(28, 'canonical binding in core — venue/record required by validateIntent and sendCard themselves (P1-2)', ok, lines);
}

// Fixture 29 — P1-3: a planted symlink at the wallet sidecar path makes
// `wallet create` refuse; the file the link points at stays untouched.
{
  const dir = join(tmp, 'f29'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'w.keypair.json');
  const victim = join(dir, 'victim.txt');
  const sentinel = 'do-not-overwrite — planted victim file\n';
  writeFileSync(victim, sentinel);
  symlinkSync(victim, `${file}.agentonly.json`);
  const r = await runCli(['wallet', 'create', '--file', file], { cwd: dir, env: {} });
  const untouched = readFileSync(victim, 'utf8') === sentinel;
  const ok = r.code !== 0 && r.out.includes('SIDECAR_SYMLINK') && untouched;
  report(29, 'sidecar symlink — wallet create refuses, planted target untouched (P1-3)', ok, [
    `create exit=${r.code}, code=${r.out.includes('SIDECAR_SYMLINK') ? 'SIDECAR_SYMLINK' : 'MISSING'}, victim file untouched=${untouched}`,
    `message: ${r.out.trim().split('\n')[0].slice(0, 200)}…`,
  ]);
}

// Fixture 30 — P1-4: the wallet's ATA is PRESENT in the post-simulation
// states but carries zero bytes of data. Malformed — not a zero
// balance. The send must refuse SIMULATION_STATE_MISSING.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const T22 = new PublicKey(TOKEN_2022_PROGRAM);
  const { preFor, postFor } = buyStateFns({
    wallet, ata, pool: AGTR_POOL,
    extraPost: { [ata]: acctState(2_039_280, Buffer.alloc(0), T22) },
  });
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
  const gwFetch = makeGwFetch(stubBuild(txB64, blockhash, lvbh));
  let ok = false; const lines = [];
  try {
    const card = await prepareTrade({
      wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own',
      fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB,
    });
    await sendCard({ keypair: kp, card, approve: card.approvalToken, dryRun: true, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    lines.push('sendCard DID NOT throw — an empty post-simulation token account was read as zero');
  } catch (e) {
    ok = e.code === 'SIMULATION_STATE_MISSING' && rawSends() === 0;
    lines.push(`send threw ${e.code ?? ''}: ${e.message.slice(0, 180)}…`);
    lines.push(`sendRawTransaction calls=${rawSends()} (must be 0)`);
  }
  report(30, 'empty post-simulation token data — malformed, refused (P1-4)', ok, lines);
}

// Fixture 31 — P1-5: the transaction confirms WITH an on-chain error.
// The send must report failure (TRANSACTION_FAILED_ONCHAIN), never a
// successful receipt.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const { preFor, postFor } = buyStateFns({ wallet, ata, pool: AGTR_POOL });
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
  conn.confirmTransaction = async () => ({ value: { err: { InstructionError: [1, { Custom: 6001 }] } } });
  const gwFetch = makeGwFetch(stubBuild(txB64, blockhash, lvbh));
  let ok = false; const lines = [];
  try {
    const card = await prepareTrade({
      wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own',
      fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB,
    });
    const receipt = await sendCard({ keypair: kp, card, approve: card.approvalToken, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    lines.push(`sendCard returned a receipt (${receipt.mode}) for an errored confirmation — failure was reported as success`);
  } catch (e) {
    ok = e.code === 'TRANSACTION_FAILED_ONCHAIN' && rawSends() === 1;
    lines.push(`send threw ${e.code ?? ''}: ${e.message.slice(0, 180)}…`);
    lines.push(`sendRawTransaction calls=${rawSends()} (must be 1 — the transaction WAS broadcast; its failure is what is reported)`);
  }
  report(31, 'confirmed on-chain error — reported as failure, never a receipt (P1-5)', ok, lines);
}

// ---------------------------------------------------------------------------
// Fixtures 32–41 — repair round 4 (PR #5, Codex round-3 review).
// 32 direct wallet↔pool SOL transfers refused (P0), 33 bundled-settle
// sell passes with the payout modeled (P1-1), 34 payout over the
// modeled bound refuses (P1-1), 35 settle paying a non-derived or
// non-canonical account refuses (P1-1), 36 external-signer allowlist
// (P1-5), 37 venue agreement at prepare (P1-4), 38 prepare --out
// symlink refusal (P1-7b), 39 malformed confirmation is a failure
// (P1-6), 40 displayed fees / price impact bound into the approval
// token (P1-8), 41 HouseSwap exact format (P1-2).
// ---------------------------------------------------------------------------

// The production settle shape (see fixture 23): data [3], the fixed
// 9-account prefix, plus a hook-extra tail.
function settleIx({ payer, holder, mint }) {
  const holderAta = associatedTokenAddress(new PublicKey(mint), holder, TOKEN_2022_PROGRAM);
  return new TransactionInstruction({
    programId: new PublicKey(DIST_PROGRAM),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: holder, isSigner: false, isWritable: false },
      { pubkey: holderAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(DIST_STATE), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(DIST_VAULT), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(distributorClaimPda(mint, holder.toBase58())), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(TOKEN_2022_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: holderAta, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([3]),
  });
}
function sellGwFetch(txB64, blockhash, lvbh) {
  const sellBuild = {
    status: 'ready_for_signature', symbol: 'AGTR', venue: 'curve',
    amount_in: '100', amount_out_expected: '9000000', minimum_amount_out: '8000000', price_impact_bps: 0,
    bundled: ['distributor-settle'], transaction_base64: txB64, blockhash, last_valid_block_height: lvbh,
    simulation: { status: 'passed', layer: 'none', unitsConsumed: 150, provisional: true, note: 'stub' },
  };
  return async (url) => {
    const u = String(url);
    const mk = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes('/v1/trade/eligibility')) return mk({ ok: true, status: 'eligible', reasons: [] });
    if (u.includes('/v1/trade/quote')) return mk({ ok: true, venue: 'curve', amountIn: '100', amountOut: '9000000', minimumAmountOut: '8000000', fees: { total: '0' }, priceImpactBps: 0, symbol: 'AGTR' });
    if (u.includes('/v1/trade/build')) return mk({ ok: true, ...sellBuild });
    throw new Error(`sell gwFetch: unexpected fetch ${u}`);
  };
}

// Fixture 32 — P0: a direct wallet→pool (buy) or pool→wallet (sell)
// System transfer appended to a legitimate build refuses at prepare.
// The transfer (5,000 lamports) sits far inside the fee ceiling —
// exactly the shape the old 'trade-transfer' classification plus the
// pool-gain bound used to wave through.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const lines = [];
  let ok = true;
  {
    const { tx } = buildRealShapeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
    tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(AGTR_POOL), lamports: 5_000 }));
    const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
    const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
    const { preFor, postFor } = buyStateFns({ wallet, ata, pool: AGTR_POOL });
    const { conn } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
    let code = 'NO-THROW';
    try {
      await prepareTrade({ wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own', fetchImpl: makeGwFetch(stubBuild(txB64, blockhash, lvbh)), connection: conn, tokenJson: TOKEN_JSON_STUB });
    } catch (e) { code = e.code ?? 'ERR'; }
    const good = code === 'UNCLASSIFIED_INSTRUCTION';
    ok = ok && good;
    lines.push(`buy + appended wallet→pool transfer (5,000 lamports, inside the fee ceiling): refused at prepare=${good} code=${code}`);
  }
  {
    const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
    tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(AGTR_POOL), toPubkey: kp.publicKey, lamports: 5_000 }));
    const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
    const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
    const { preFor, postFor } = buyStateFns({ wallet, ata, pool: AGTR_POOL });
    const { conn } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
    let code = 'NO-THROW';
    try {
      await prepareTrade({ wallet, mint: AGTR, side: 'sell', amount: '0.0001', signerType: 'own', fetchImpl: sellGwFetch(txB64, blockhash, lvbh), connection: conn, tokenJson: TOKEN_JSON_STUB });
    } catch (e) { code = e.code ?? 'ERR'; }
    // A pool-sourced System transfer makes the POOL a required
    // signer, so the signer-set check fires before classification —
    // either refusal is the P0 outcome (the classification itself no
    // longer admits the shape either; the buy direction above proves
    // that path directly).
    const good = code === 'UNCLASSIFIED_INSTRUCTION' || code === 'INTENT_SIGNERS_MISMATCH';
    ok = ok && good;
    lines.push(`sell + appended pool→wallet transfer: refused at prepare=${good} code=${code} (the pool becomes a required signer, so the signer-set check fires first; classification no longer admits the shape either)`);
  }
  report(32, 'direct wallet↔pool SOL transfers — refused at prepare, both directions (P0)', ok, lines);
}

// Fixtures 33 + 34 — P1-1: the bundled-settle sell. The transaction
// carries the wallet's own settle AND the counterparty's settle (the
// production bundle). Simulated story: the wallet sells 100 raw; its
// own settle pays 250 into the same ATA (net ATA delta +150); the
// counterparty's settle pays 400 into the counterparty's ATA; the
// distributor vault (balance 1,000 at prepare) pays out 650 total.
// Repair round 5 (P0-1): the simulation also reports INNER
// instructions — the settle instructions' own transfer legs — and
// the runtime measures the wallet's payout from those (250), never
// from the +150 net delta.
function buildSettleSellTx({ kp, cp, blockhash, lvbh }) {
  const wallet = kp.publicKey;
  const mintPk = new PublicKey(AGTR);
  const ata = associatedTokenAddress(mintPk, wallet, TOKEN_2022_PROGRAM);
  const tx = new Transaction({ feePayer: wallet, blockhash, lastValidBlockHeight: lvbh });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(settleIx({ payer: wallet, holder: wallet, mint: AGTR }));
  tx.add(settleIx({ payer: wallet, holder: cp.publicKey, mint: AGTR }));
  tx.add(new TransactionInstruction({
    programId: new PublicKey(DBC_PROGRAM),
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(AGTR_POOL), isSigner: false, isWritable: true },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: ata, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from('b75d992818e6c297', 'hex'), Buffer.alloc(23, 7)]),
  }));
  tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from('agentonly-runtime fixture 33') }));
  return { tx, ata };
}
function settleSellStates({ wallet, ata, cp, cpAta, ownPost, cpPost, vaultPre, vaultPost, cpPre = 50, extraPre = {}, extraPost = {} }) {
  const SYS = new PublicKey('11111111111111111111111111111111');
  const T22 = new PublicKey(TOKEN_2022_PROGRAM);
  const preFor = (addr) => {
    if (addr in extraPre) return extraPre[addr];
    if (addr === wallet) return acctState(100_000_000, Buffer.alloc(0), SYS);
    if (addr === ata) return acctState(2_039_280, stdTokenBlob(AGTR, wallet, 1000), T22);
    if (addr === cpAta) return acctState(2_039_280, stdTokenBlob(AGTR, cp, cpPre), T22);
    if (addr === DIST_VAULT) return acctState(1_539_240, stdTokenBlob(AGTR, DIST_STATE, vaultPre), T22);
    if (addr === AGTR_POOL) return acctState(5_000_000, Buffer.alloc(0), new PublicKey(DBC_PROGRAM));
    return null;
  };
  const postFor = (addr) => {
    if (addr in extraPost) return extraPost[addr];
    if (addr === wallet) return acctState(100_000_000 + 8_500_000, Buffer.alloc(0), SYS);
    if (addr === ata) return acctState(2_039_280, stdTokenBlob(AGTR, wallet, ownPost), T22);
    if (addr === cpAta) return acctState(2_039_280, stdTokenBlob(AGTR, cp, cpPost), T22);
    if (addr === DIST_VAULT) return acctState(1_539_240, stdTokenBlob(AGTR, DIST_STATE, vaultPost), T22);
    if (addr === AGTR_POOL) return acctState(5_000_000, Buffer.alloc(0), new PublicKey(DBC_PROGRAM));
    return null;
  };
  return { preFor, postFor };
}

{
  const kp = Keypair.generate();
  const cp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const { tx, ata } = buildSettleSellTx({ kp, cp, blockhash, lvbh });
  const cpAta = associatedTokenAddress(new PublicKey(AGTR), cp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  // own ATA: 1000 − 100 (swap debit) + 250 (own payout) = 1150;
  // counterparty ATA: 50 + 400 (its payout) = 450; vault: 1000 − 650.
  const { preFor, postFor } = settleSellStates({ wallet, ata: ata.toBase58(), cp: cp.publicKey.toBase58(), cpAta, ownPost: 1150, cpPost: 450, vaultPre: 1000, vaultPost: 350 });
  // Inner instructions (top-level indices: 1 = own settle, 2 =
  // counterparty settle, 3 = venue swap): the settle legs pay 250 /
  // 400 out of the vault; the swap leg debits the wallet 100.
  const poolVaultAta = associatedTokenAddress(new PublicKey(AGTR), new PublicKey(AGTR_POOL), TOKEN_2022_PROGRAM).toBase58();
  const innerFor = () => ([
    { index: 1, instructions: [innerTxfr(DIST_VAULT, ata.toBase58(), 250)] },
    { index: 2, instructions: [innerTxfr(DIST_VAULT, cpAta, 400)] },
    { index: 3, instructions: [innerTxfr(ata.toBase58(), poolVaultAta, 100)] },
  ]);
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1, vaultBalance: 1000n, innerFor });
  const gwFetch = sellGwFetch(txB64, blockhash, lvbh);
  let ok = false; const lines = [];
  try {
    const card = await prepareTrade({ wallet, mint: AGTR, side: 'sell', amount: '0.0001', signerType: 'own', fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB });
    const sp = card.validation.settlementPayout;
    lines.push(`card settlement model: maxRaw=${sp?.maxRaw} (vault balance at prepare), minRaw=${sp?.minRaw}, recipients=${sp?.holderAtas.length}, settles=${sp?.settles}, ownAta set=${sp?.ownAta === ata.toBase58()}`);
    const receipt = await sendCard({ keypair: kp, card, approve: card.approvalToken, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    ok = sp?.maxRaw === '1000' && sp?.settles === 2
      && sp?.holderAtas.includes(ata.toBase58()) && sp?.holderAtas.includes(cpAta)
      && receipt.mode === 'broadcast' && rawSends() === 1
      && receipt.deltas.tokenDelta === '150'
      && receipt.deltas.settlementPayoutRaw === '650'
      && receipt.deltas.settlementOwnPayoutRaw === '250';
    lines.push(`send: mode=${receipt.mode}, tokenDelta=${receipt.deltas.tokenDelta} (= −100 swap + 250 own payout), settlementPayoutRaw=${receipt.deltas.settlementPayoutRaw} (total vault outflow), settlementOwnPayoutRaw=${receipt.deltas.settlementOwnPayoutRaw} (measured from the settle legs, NOT the +150 residual), sends=${rawSends()}`);
  } catch (e) {
    lines.push(`threw ${e.code ?? ''}: ${e.message.slice(0, 220)}`);
  }
  report(33, 'bundled-settle sell — payout modeled, bounded, and INDEPENDENTLY MEASURED from the settle legs; the sell passes end to end (P1-1, P0-1)', ok, lines);
}

{
  const kp = Keypair.generate();
  const cp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const { tx, ata } = buildSettleSellTx({ kp, cp, blockhash, lvbh });
  const cpAta = associatedTokenAddress(new PublicKey(AGTR), cp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  // The card's bound is the prepare-time vault balance (1,000), but
  // the simulation pays the wallet 1,100 (own ATA 1000 − 100 + 1100)
  // and the vault 1,500 total — over the approved bound. The inner
  // instructions attribute the payouts (1,100 own + 400 counterparty).
  const { preFor, postFor } = settleSellStates({ wallet, ata: ata.toBase58(), cp: cp.publicKey.toBase58(), cpAta, ownPost: 2000, cpPost: 450, vaultPre: 5000, vaultPost: 3500 });
  const poolVaultAta = associatedTokenAddress(new PublicKey(AGTR), new PublicKey(AGTR_POOL), TOKEN_2022_PROGRAM).toBase58();
  const innerFor = () => ([
    { index: 1, instructions: [innerTxfr(DIST_VAULT, ata.toBase58(), 1100)] },
    { index: 2, instructions: [innerTxfr(DIST_VAULT, cpAta, 400)] },
    { index: 3, instructions: [innerTxfr(ata.toBase58(), poolVaultAta, 100)] },
  ]);
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1, vaultBalance: 1000n, innerFor });
  const gwFetch = sellGwFetch(txB64, blockhash, lvbh);
  let ok = false; const lines = [];
  try {
    const card = await prepareTrade({ wallet, mint: AGTR, side: 'sell', amount: '0.0001', signerType: 'own', fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB });
    lines.push(`card settlement bound: maxRaw=${card.validation.settlementPayout?.maxRaw}`);
    await sendCard({ keypair: kp, card, approve: card.approvalToken, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    lines.push('sendCard DID NOT throw — a payout over the modeled bound was allowed');
  } catch (e) {
    ok = (e.code === 'ECONOMIC_BOUND_EXCEEDED' || e.code === 'SETTLEMENT_PAYOUT_EXCEEDS_MAX') && rawSends() === 0;
    lines.push(`send threw ${e.code ?? ''}: ${e.message.slice(0, 180)}…`);
    lines.push(`sendRawTransaction calls=${rawSends()} (must be 0)`);
  }
  report(34, 'settlement payout over the modeled bound — refused, nothing broadcast (P1-1)', ok, lines);
}

// Fixture 35 — P1-1: a settle paying a stranger. (a) The recipient is
// not the holder's derived token account (holder = wallet, recipient
// = a stranger's ATA); (b) the vault named is not the canonical
// record's distributor vault. Both refuse at prepare classification.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const { preFor, postFor } = buyStateFns({ wallet, ata, pool: AGTR_POOL });
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
  const lines = [];
  let ok = true;
  const variants = [
    ['recipient is a stranger\u2019s ATA, not the holder\u2019s derived account', (ix) => {
      const strangerAta = associatedTokenAddress(new PublicKey(AGTR), Keypair.generate().publicKey, TOKEN_2022_PROGRAM);
      ix.keys[2].pubkey = strangerAta;
      return ix;
    }],
    ['vault is not the canonical distributor vault', (ix) => {
      ix.keys[5].pubkey = Keypair.generate().publicKey;
      return ix;
    }],
  ];
  for (const [name, mutate] of variants) {
    const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
    tx.add(mutate(settleIx({ payer: kp.publicKey, holder: kp.publicKey, mint: AGTR })));
    const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
    let code = 'NO-THROW';
    try {
      await prepareTrade({ wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own', fetchImpl: makeGwFetch(stubBuild(txB64, blockhash, lvbh)), connection: conn, tokenJson: TOKEN_JSON_STUB });
    } catch (e) { code = e.code ?? 'ERR'; }
    const good = code === 'UNCLASSIFIED_INSTRUCTION';
    ok = ok && good;
    lines.push(`${name}: refused at prepare=${good} code=${code}`);
  }
  // Variant (c) — repair round 5, TIGHTEN-1: a counterparty settle
  // paying an account the venue swap NAMES. Rounds 1–4 admitted
  // exactly this shape (the round-4 control below relied on it); the
  // build vouching for its own recipient is not a pin, so it now
  // refuses at prepare.
  {
    const cp = Keypair.generate();
    const swapVault = Keypair.generate().publicKey;
    const tx = buildTradeTx({
      kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh,
      extraKeys: [{ pubkey: swapVault, isSigner: false, isWritable: true }],
    });
    const settle = settleIx({ payer: kp.publicKey, holder: cp.publicKey, mint: AGTR });
    settle.keys[2].pubkey = swapVault;
    tx.add(settle);
    const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
    let code = 'NO-THROW';
    try {
      await prepareTrade({ wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own', fetchImpl: makeGwFetch(stubBuild(txB64, blockhash, lvbh)), connection: conn, tokenJson: TOKEN_JSON_STUB });
    } catch (e) { code = e.code ?? 'ERR'; }
    const good = code === 'UNCLASSIFIED_INSTRUCTION';
    ok = ok && good;
    lines.push(`counterparty settle paying a SWAP-NAMED account (round-4 admission): refused at prepare=${good} code=${code}`);
  }
  // Control — the production counterparty form, pinned independently:
  // the holder is the DBC pool-authority PDA and the recipient is the
  // pool's base vault, derived from the POOL ACCOUNT'S OWN STATE
  // (mint @136, baseVault @168, quoteVault @200 — both vaults token
  // accounts under the pool authority). The swap does not even name
  // the vault in this build: the derivation owes nothing to the
  // transaction. That shape must classify and model.
  {
    const authority = PublicKey.findProgramAddressSync(
      [Buffer.from('pool_authority')], new PublicKey(DBC_PROGRAM),
    )[0];
    const baseVault = Keypair.generate().publicKey.toBase58();
    const quoteVault = Keypair.generate().publicKey.toBase58();
    const poolBlob = Buffer.alloc(424);
    poolBlob.set(bs58.decode(AGTR), 136);
    poolBlob.set(bs58.decode(baseVault), 168);
    poolBlob.set(bs58.decode(quoteVault), 200);
    const T22 = new PublicKey(TOKEN_2022_PROGRAM);
    const { preFor: preCtrl, postFor: postCtrl } = buyStateFns({
      wallet, ata, pool: AGTR_POOL,
      extraPre: {
        [AGTR_POOL]: acctState(5_000_000, poolBlob, new PublicKey(DBC_PROGRAM)),
        [baseVault]: acctState(2_039_280, stdTokenBlob(AGTR, authority.toBase58(), 5000), T22),
        [quoteVault]: acctState(2_039_280, stdTokenBlob(WSOL_MINT, authority.toBase58(), 7000), new PublicKey(TOKEN_PROGRAM_ID)),
      },
    });
    const connCtrl = makeDoubleConn({ preFor: preCtrl, postFor: postCtrl, blockHeight: lvbh - 1 }).conn;
    const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
    const settle = settleIx({ payer: kp.publicKey, holder: authority, mint: AGTR });
    settle.keys[2].pubkey = new PublicKey(baseVault);
    tx.add(settle);
    const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
    let modeled = false;
    try {
      const card = await prepareTrade({ wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own', fetchImpl: makeGwFetch(stubBuild(txB64, blockhash, lvbh)), connection: connCtrl, tokenJson: TOKEN_JSON_STUB });
      modeled = (card.validation.settlementPayout?.holderAtas ?? []).includes(baseVault);
      lines.push(`counterparty settle (holder = pool authority) paying the POOL-STATE-DERIVED base vault, unnamed by the swap: classified + modeled=${modeled}`);
    } catch (e) {
      lines.push(`counterparty settle paying the pool-state-derived base vault: threw ${e.code ?? ''}: ${e.message.slice(0, 140)}`);
    }
    ok = ok && modeled;
  }
  ok = ok && rawSends() === 0;
  lines.push(`sendRawTransaction calls=${rawSends()} (must be 0)`);
  report(35, 'settle paying a stranger / non-canonical vault / merely swap-named account — refused at prepare; the pool-state-derived vault form models (P1-1, TIGHTEN-1)', ok, lines);
}

// Fixture 36 — P1-5 + repair round 5 (TIGHTEN-2, item 5): the
// external-signer allowlist binds the COMPLETE invocation. An
// unenrolled signer refuses; send-time signer arguments refuse; the
// enrolled invocation (shebang signer + its key file as an enrolled
// file argument) works; changing the SIGNER refuses on integrity;
// changing the KEY FILE refuses on integrity even though the signer
// is untouched; restoring the file restores the send with no
// re-enrollment; a deliberate signer change + re-enrollment works.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const dir = join(tmp, 'f36'); mkdirSync(dir, { recursive: true });
  const keyFile = join(dir, 'signer.keypair.json'); writeKeypairFile(keyFile, kp);
  const { blockhash, lvbh } = await liveBlockhash();
  const state = makeTradeState(kp, blockhash, lvbh);
  const stub = await startStub(state);
  const env = {
    AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url,
    AGENTONLY_SIGNER_ALLOWLIST: join(dir, 'signers.json'),
  };
  const cardPath = join(dir, 'approval-card.json');
  // A directly executable signer (shebang), like a hardware-wallet
  // bridge binary: the keyfile path arrives as an enrolled template
  // argv entry — fixed at enrollment, never supplied at send time.
  const signer = join(dir, 'signer.mjs');
  const signerBody = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { Keypair, Transaction } = createRequire(${JSON.stringify(join(ROOT, 'package.json'))})('@solana/web3.js');
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.argv[2], 'utf8'))));
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const tx = Transaction.from(Buffer.from(input.trim(), 'base64'));
  tx.partialSign(kp);
  process.stdout.write(tx.serialize().toString('base64'));
});
`;
  writeFileSync(signer, signerBody);
  chmodSync(signer, 0o755);
  const prep = await runCli(['prepare', '--signer-type', 'external', '--wallet', wallet, '--mint', AGTR, '--side', 'buy', '--amount', '0.01', '--out', cardPath], { cwd: dir, env });
  const card = existsSync(cardPath) ? JSON.parse(readFileSync(cardPath, 'utf8')) : null;
  const lines = [`external prepare exit=${prep.code}, card written=${!!card}`];
  let ok = !!card;
  if (card) {
    const sendArgs = ['send', '--signer-type', 'external', '--external-signer', signer, '--wallet', wallet, '--card', cardPath, '--approve', card.approvalToken, '--dry-run'];
    const withArgs = await runCli(['send', '--signer-type', 'external', '--external-signer', signer, '--external-signer-arg', keyFile, '--wallet', wallet, '--card', cardPath, '--approve', card.approvalToken, '--dry-run'], { cwd: dir, env });
    lines.push(`send WITH --external-signer-arg: exit=${withArgs.code}, code=${withArgs.out.includes('EXTERNAL_SIGNER_ARGS_REFUSED') ? 'EXTERNAL_SIGNER_ARGS_REFUSED' : 'MISSING'}`);
    const unenrolled = await runCli(sendArgs, { cwd: dir, env });
    lines.push(`unenrolled signer: exit=${unenrolled.code}, code=${unenrolled.out.includes('SIGNER_ALLOWLIST_MISSING') ? 'SIGNER_ALLOWLIST_MISSING' : 'MISSING'}`);
    const enroll = await runCli(['signer', 'enroll', '--path', signer, '--arg', keyFile], { cwd: dir, env });
    lines.push(`enroll (signer + key file template) exit=${enroll.code}`);
    const good = await runCli(sendArgs, { cwd: dir, env });
    lines.push(`enrolled invocation dry-run exit=${good.code}`);
    writeFileSync(signer, signerBody + '// tampered after enrollment\n');
    chmodSync(signer, 0o755);
    const changed = await runCli(sendArgs, { cwd: dir, env });
    lines.push(`signer bytes changed after enrollment: exit=${changed.code}, code=${changed.out.includes('SIGNER_INTEGRITY_MISMATCH') ? 'SIGNER_INTEGRITY_MISMATCH' : 'MISSING'}`);
    // Restore the signer; tamper the KEY FILE — an enrolled file
    // argument — instead. The signer itself is byte-identical to
    // enrollment; only the complete-invocation binding can catch it.
    writeFileSync(signer, signerBody);
    chmodSync(signer, 0o755);
    const keyBytes = readFileSync(keyFile);
    writeFileSync(keyFile, Buffer.concat([keyBytes, Buffer.from([10])]));
    const keyChanged = await runCli(sendArgs, { cwd: dir, env });
    lines.push(`key file changed after enrollment (signer untouched): exit=${keyChanged.code}, code=${keyChanged.out.includes('SIGNER_INTEGRITY_MISMATCH') ? 'SIGNER_INTEGRITY_MISMATCH' : 'MISSING'}`);
    writeFileSync(keyFile, keyBytes);
    const keyRestored = await runCli(sendArgs, { cwd: dir, env });
    lines.push(`key file restored: dry-run exit=${keyRestored.code} (no re-enrollment needed)`);
    writeFileSync(signer, signerBody + '// deliberate update\n');
    chmodSync(signer, 0o755);
    const reenroll = await runCli(['signer', 'enroll', '--path', signer, '--arg', keyFile], { cwd: dir, env });
    const restored = await runCli(sendArgs, { cwd: dir, env });
    lines.push(`re-enrolled after deliberate update: enroll exit=${reenroll.code}, dry-run exit=${restored.code}`);
    ok = withArgs.code !== 0 && withArgs.out.includes('EXTERNAL_SIGNER_ARGS_REFUSED')
      && unenrolled.code !== 0 && unenrolled.out.includes('SIGNER_ALLOWLIST_MISSING')
      && enroll.code === 0
      && good.code === 0 && good.out.includes('DRY RUN')
      && changed.code !== 0 && changed.out.includes('SIGNER_INTEGRITY_MISMATCH')
      && keyChanged.code !== 0 && keyChanged.out.includes('SIGNER_INTEGRITY_MISMATCH')
      && keyRestored.code === 0 && keyRestored.out.includes('DRY RUN')
      && reenroll.code === 0 && restored.code === 0 && restored.out.includes('DRY RUN');
  }
  stub.server.close();
  report(36, 'external-signer allowlist — complete invocation bound: unenrolled/send-time args refuse, enrolled works, signer OR key-file drift refuses, restore + re-enroll paths work (P1-5, TIGHTEN-2)', ok, lines);
}

// Fixture 37 — P1-4: venue agreement at prepare. Unknown venue,
// quote/build disagreement, and a missing venue all refuse before
// any card exists.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const { preFor, postFor } = buyStateFns({ wallet, ata, pool: AGTR_POOL });
  const { conn } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
  const mkGw = ({ quoteVenue, buildVenue }) => async (url) => {
    const u = String(url);
    const mk = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes('/v1/trade/eligibility')) return mk({ ok: true, status: 'eligible', reasons: [] });
    if (u.includes('/v1/trade/quote')) {
      const q = { ok: true, amountIn: '10000000', amountOut: '500', minimumAmountOut: '495', fees: { total: '0' }, priceImpactBps: 0, symbol: 'AGTR' };
      if (quoteVenue != null) q.venue = quoteVenue;
      return mk(q);
    }
    if (u.includes('/v1/trade/build')) {
      const b = stubBuild(txB64, blockhash, lvbh);
      if (buildVenue == null) delete b.venue; else b.venue = buildVenue;
      return mk({ ok: true, ...b });
    }
    throw new Error(`fixture 37: unexpected fetch ${u}`);
  };
  const cases = [
    ['unknown venue on both quote and build', { quoteVenue: 'mars', buildVenue: 'mars' }, 'VENUE_UNKNOWN'],
    ['quote says curve, build says house', { quoteVenue: 'curve', buildVenue: 'house' }, 'VENUE_MISMATCH'],
    ['quote names no venue', { quoteVenue: null, buildVenue: 'curve' }, 'VENUE_MISSING'],
  ];
  const lines = [];
  let ok = true;
  for (const [name, venues, want] of cases) {
    let code = 'NO-THROW';
    try {
      await prepareTrade({ wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own', fetchImpl: mkGw(venues), connection: conn, tokenJson: TOKEN_JSON_STUB });
    } catch (e) { code = e.code ?? 'ERR'; }
    const good = code === want;
    ok = ok && good;
    lines.push(`${name}: refused=${good} code=${code} (want ${want})`);
  }
  report(37, 'venue agreement at prepare — unknown / disagreed / missing venue all refuse (P1-4)', ok, lines);
}

// Fixture 38 — P1-7b: prepare --out onto a planted symlink refuses;
// the file the link points at stays untouched and no card lands.
{
  const kp = Keypair.generate();
  const dir = join(tmp, 'f38'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'w.keypair.json'); writeKeypairFile(file, kp);
  const { blockhash, lvbh } = await liveBlockhash();
  const state = makeTradeState(kp, blockhash, lvbh);
  const stub = await startStub(state);
  const victim = join(dir, 'victim.json');
  const sentinel = 'do-not-overwrite — planted victim file\n';
  writeFileSync(victim, sentinel);
  const outPath = join(dir, 'approval-card.json');
  symlinkSync(victim, outPath);
  const r = await runCli(
    ['prepare', '--file', file, '--mint', AGTR, '--side', 'buy', '--amount', '0.01', '--out', outPath],
    { cwd: dir, env: { AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url } },
  );
  stub.server.close();
  const untouched = readFileSync(victim, 'utf8') === sentinel;
  const ok = r.code !== 0 && r.out.includes('WRITE_SYMLINK_REFUSED') && untouched;
  report(38, 'prepare --out onto a planted symlink — refused, victim untouched (P1-7b)', ok, [
    `prepare exit=${r.code}, code=${r.out.includes('WRITE_SYMLINK_REFUSED') ? 'WRITE_SYMLINK_REFUSED' : 'MISSING'}, victim untouched=${untouched}`,
    `message: ${r.out.trim().split('\n')[0].slice(0, 200)}…`,
  ]);
}

// Fixture 39 — P1-6: a malformed confirmation response ({} and
// { value: {} }) after broadcast is a FAILURE (CONFIRMATION_
// UNVERIFIED), never a successful receipt.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const { preFor, postFor } = buyStateFns({ wallet, ata, pool: AGTR_POOL });
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
  const gwFetch = makeGwFetch(stubBuild(txB64, blockhash, lvbh));
  const lines = [];
  let ok = true;
  try {
    const card = await prepareTrade({ wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own', fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB });
    for (const [name, conf] of [['{}', {}], ['{ value: {} }', { value: {} }]]) {
      conn.confirmTransaction = async () => conf;
      let code = 'NO-THROW';
      try {
        await sendCard({ keypair: kp, card, approve: card.approvalToken, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
      } catch (e) { code = e.code ?? 'ERR'; }
      const good = code === 'CONFIRMATION_UNVERIFIED';
      ok = ok && good;
      lines.push(`confirmation ${name}: reported as failure=${good} code=${code}`);
    }
    ok = ok && rawSends() === 2;
    lines.push(`sendRawTransaction calls=${rawSends()} (must be 2 — both transactions WERE broadcast; their unverifiable outcomes are what is reported)`);
  } catch (e) {
    ok = false;
    lines.push(`setup failure: ${e.code ?? ''} ${e.message.slice(0, 200)}`);
  }
  report(39, 'malformed confirmation — failure, never a receipt (P1-6)', ok, lines);
}

// Fixture 40 — P1-8: the displayed fees and price impact are bound
// into the approval token (policy version 2). Post-approval edits to
// either refuse with POLICY_BINDING_MISMATCH; the unaltered card
// passes.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const { preFor, postFor } = buyStateFns({ wallet, ata, pool: AGTR_POOL });
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
  const gwFetch = makeGwFetch(stubBuild(txB64, blockhash, lvbh));
  const lines = [];
  let ok = true;
  try {
    const card = await prepareTrade({ wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own', fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB });
    const control = await sendCard({ keypair: kp, card, approve: card.approvalToken, dryRun: true, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    lines.push(`control (unaltered card): dry-run mode=${control.mode}`);
    const mutations = [
      ['displayed fees (fees.total 0 → 999)', (c) => { c.fees = { total: '999' }; }],
      ['displayed price impact (0 → 55 bps)', (c) => { c.priceImpactBps = 55; }],
    ];
    for (const [field, mutate] of mutations) {
      const forged = JSON.parse(JSON.stringify(card));
      mutate(forged);
      let code = 'NO-THROW';
      try {
        await sendCard({ keypair: kp, card: forged, approve: card.approvalToken, dryRun: true, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
      } catch (e) { code = e.code ?? 'ERR'; }
      const good = code === 'POLICY_BINDING_MISMATCH';
      ok = ok && good;
      lines.push(`alter ${field} after approval: refused=${good} code=${code}`);
    }
    ok = ok && rawSends() === 0;
    lines.push(`sendRawTransaction calls=${rawSends()} (must be 0)`);
  } catch (e) {
    ok = false;
    lines.push(`setup failure: ${e.code ?? ''} ${e.message.slice(0, 200)}`);
  }
  report(40, 'displayed fees / price impact bound into the approval token (P1-8)', ok, lines);
}

// Fixture 41 — P1-2: HouseSwap exact format. The production swap
// (tag 1, dir matching the side, exactly 18 data bytes, the canonical
// 10-account layout) validates; a wrong tag, a wrong-direction swap,
// a lookalike vault in a fixed position, and embedded terms that
// disagree with the approved terms all refuse.
{
  const HPROOF = '5hXj8x3UCx4VqxpoyrNQTbfQxp4MAqjzTj3xqbJDSZEn';
  const pool = housePoolPda(HPROOF);
  const tokenJsonHouse = { mint: HPROOF, symbol: 'HPROOF', decimals: 6, addresses: { pool } };
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  function buildHouseTx({ dir = 0, tag = 1, amountIn = 1_000_000n, minOut = 900_000n, mutateKeys = null } = {}) {
    const mintPk = new PublicKey(HPROOF);
    const poolPk = new PublicKey(pool);
    const data = Buffer.alloc(18);
    data[0] = tag; data[1] = dir;
    data.writeBigUInt64LE(amountIn, 2);
    data.writeBigUInt64LE(minOut, 10);
    let keys = [
      { pubkey: poolPk, isSigner: false, isWritable: true },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(WSOL_MINT), isSigner: false, isWritable: false },
      { pubkey: associatedTokenAddress(mintPk, poolPk, TOKEN_2022_PROGRAM), isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(new PublicKey(WSOL_MINT), poolPk, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(mintPk, kp.publicKey, TOKEN_2022_PROGRAM), isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(new PublicKey(WSOL_MINT), kp.publicKey, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(TOKEN_2022_PROGRAM), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
    ];
    if (mutateKeys) keys = mutateKeys(keys);
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight: lvbh });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(new TransactionInstruction({ programId: new PublicKey(PLATFORM_PROGRAMS.house), keys, data }));
    tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from('agentonly-runtime fixture 41') }));
    return tx;
  }
  const ctx = { wallet, mint: HPROOF, side: 'buy', venue: 'house', tokenJson: tokenJsonHouse, amountInRaw: '1000000', minimumAmountOutRaw: '900000' };
  const lines = [];
  let ok = true;
  const run = async (tx) => {
    const intent = await deriveIntent(tx.serialize({ requireAllSignatures: false }).toString('base64'));
    return validateIntent(intent, ctx);
  };
  try {
    const good = await run(buildHouseTx());
    const goodOk = good.venueProgram === PLATFORM_PROGRAMS.house;
    ok = ok && goodOk;
    lines.push(`production house swap shape: validates=${goodOk} venueProgram=${good.venueProgram?.slice(0, 8)}…`);
  } catch (e) {
    ok = false;
    lines.push(`production house swap shape: threw ${e.code ?? ''}: ${e.message.slice(0, 160)}`);
  }
  const badCases = [
    ['wrong tag (data[0] = 2)', buildHouseTx({ tag: 2 }), 'UNCLASSIFIED_INSTRUCTION'],
    ['direction contradicts the side (sell swap on a buy card)', buildHouseTx({ dir: 1 }), 'UNCLASSIFIED_INSTRUCTION'],
    ['lookalike token vault in the fixed layout', buildHouseTx({ mutateKeys: (keys) => { keys[3] = { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }; return keys; } }), 'UNCLASSIFIED_INSTRUCTION'],
    ['embedded amount_in disagrees with the approved amount', buildHouseTx({ amountIn: 2_000_000n }), 'VENUE_TERMS_MISMATCH'],
    ['embedded min_out undercuts the approved minimum', buildHouseTx({ minOut: 100n }), 'VENUE_TERMS_MISMATCH'],
  ];
  for (const [name, tx, want] of badCases) {
    let code = 'NO-THROW';
    try { await run(tx); } catch (e) { code = e.code ?? 'ERR'; }
    const goodCase = code === want;
    ok = ok && goodCase;
    lines.push(`${name}: refused=${goodCase} code=${code} (want ${want})`);
  }
  report(41, 'HouseSwap exact format — tag, direction, data size, canonical layout, embedded terms (P1-2)', ok, lines);
}

// ---------------------------------------------------------------------------
// Fixtures 42–46 — repair round 5 (PR #5, Codex round-4 review).
// 42 the masking case for P0-1 (a big settle credit hiding a swap
// over-debit under the round-4 residual decomposition), 43 an
// unattributable credit into the wallet's ATA (P0-1), 44 settlement
// count + recipient set bound into the model and approval token
// (item 3), 45 card output through a symlinked parent directory
// (item 2), 46 signer enrollment binding the complete invocation —
// script and config drift refuse with the interpreter untouched
// (item 5).
// ---------------------------------------------------------------------------

// Fixture 42 — P0-1, the masking case. The wallet's ATA net delta is
// IDENTICAL to fixture 33 (+150), but the flows differ: the swap leg
// debits 300 (not the approved 100) and the wallet's own settle pays
// 450 (not 250). Under the round-4 residual decomposition
// (ownPayout = tokenDelta + amountIn = 250) the over-debit was
// invisible and the send passed. The independently measured payout
// (450, from the settle instruction's own transfer leg) exposes the
// swap leg: 150 − 450 = −300 ≠ −100 → refuse.
{
  const kp = Keypair.generate();
  const cp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const { tx, ata } = buildSettleSellTx({ kp, cp, blockhash, lvbh });
  const cpAta = associatedTokenAddress(new PublicKey(AGTR), cp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  // own ATA: 1000 − 300 (swap) + 450 (payout) = 1150 — same post
  // balance as fixture 33; counterparty: 50 + 200 = 250; vault −650.
  const { preFor, postFor } = settleSellStates({ wallet, ata: ata.toBase58(), cp: cp.publicKey.toBase58(), cpAta, ownPost: 1150, cpPost: 250, vaultPre: 1000, vaultPost: 350 });
  const poolVaultAta = associatedTokenAddress(new PublicKey(AGTR), new PublicKey(AGTR_POOL), TOKEN_2022_PROGRAM).toBase58();
  const innerFor = () => ([
    { index: 1, instructions: [innerTxfr(DIST_VAULT, ata.toBase58(), 450)] },
    { index: 2, instructions: [innerTxfr(DIST_VAULT, cpAta, 200)] },
    { index: 3, instructions: [innerTxfr(ata.toBase58(), poolVaultAta, 300)] },
  ]);
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1, vaultBalance: 1000n, innerFor });
  const gwFetch = sellGwFetch(txB64, blockhash, lvbh);
  let ok = false; const lines = [];
  try {
    const card = await prepareTrade({ wallet, mint: AGTR, side: 'sell', amount: '0.0001', signerType: 'own', fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB });
    lines.push('prepare accepted the build (the flaw is invisible until the signed-byte simulation is attributed)');
    await sendCard({ keypair: kp, card, approve: card.approvalToken, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    lines.push('sendCard DID NOT throw — the masked over-debit passed (the round-4 residual flaw)');
  } catch (e) {
    ok = e.code === 'ECONOMIC_BOUND_EXCEEDED' && rawSends() === 0;
    lines.push(`send threw ${e.code ?? ''}: ${e.message.slice(0, 200)}…`);
    lines.push(`sendRawTransaction calls=${rawSends()} (must be 0)`);
  }
  report(42, 'masking case — net delta identical to fixture 33 (+150) but the swap over-debits 300 against a measured 450 payout: refused (P0-1)', ok, lines);
}

// Fixture 43 — P0-1, unattributable movement. The settle legs and the
// swap leg are exactly fixture 33's, but an extra 150 raw units of
// the card mint arrive in the wallet's ATA under a top-level
// instruction that is neither a settle nor the venue swap (the memo
// slot, in the double's inner-instruction report). No approved flow
// accounts for it → SETTLEMENT_PAYOUT_UNATTRIBUTABLE.
{
  const kp = Keypair.generate();
  const cp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const { tx, ata } = buildSettleSellTx({ kp, cp, blockhash, lvbh });
  const cpAta = associatedTokenAddress(new PublicKey(AGTR), cp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  // own ATA: 1000 − 100 (swap) + 250 (payout) + 150 (unattributable) = 1300.
  const { preFor, postFor } = settleSellStates({ wallet, ata: ata.toBase58(), cp: cp.publicKey.toBase58(), cpAta, ownPost: 1300, cpPost: 450, vaultPre: 1000, vaultPost: 350 });
  const poolVaultAta = associatedTokenAddress(new PublicKey(AGTR), new PublicKey(AGTR_POOL), TOKEN_2022_PROGRAM).toBase58();
  const stranger = Keypair.generate().publicKey.toBase58();
  const innerFor = () => ([
    { index: 1, instructions: [innerTxfr(DIST_VAULT, ata.toBase58(), 250)] },
    { index: 2, instructions: [innerTxfr(DIST_VAULT, cpAta, 400)] },
    { index: 3, instructions: [innerTxfr(ata.toBase58(), poolVaultAta, 100)] },
    { index: 4, instructions: [innerTxfr(stranger, ata.toBase58(), 150)] },
  ]);
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1, vaultBalance: 1000n, innerFor });
  const gwFetch = sellGwFetch(txB64, blockhash, lvbh);
  let ok = false; const lines = [];
  try {
    const card = await prepareTrade({ wallet, mint: AGTR, side: 'sell', amount: '0.0001', signerType: 'own', fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB });
    await sendCard({ keypair: kp, card, approve: card.approvalToken, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    lines.push('sendCard DID NOT throw — an unattributable credit into the wallet ATA passed');
  } catch (e) {
    ok = e.code === 'SETTLEMENT_PAYOUT_UNATTRIBUTABLE' && rawSends() === 0;
    lines.push(`send threw ${e.code ?? ''}: ${e.message.slice(0, 200)}…`);
    lines.push(`sendRawTransaction calls=${rawSends()} (must be 0)`);
  }
  report(43, 'unattributable credit into the wallet\u2019s ATA (neither settle leg nor swap leg) — refused (P0-1)', ok, lines);
}

// Fixture 44 — item 3: the settlement COUNT and recipient set are
// bound. (a) settles count edited consistently in both model copies
// → SETTLEMENT_MODEL_MISMATCH (the bytes carry 2 settles, the model
// claims 3); (b) the same edit with the approval token recomputed
// over the edited policy → the owner's original token no longer
// matches the card (APPROVAL_MISMATCH): the count is inside the
// policy fingerprint; (c) a recipient trimmed from both copies →
// SETTLEMENT_MODEL_MISMATCH.
{
  const kp = Keypair.generate();
  const cp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const { tx, ata } = buildSettleSellTx({ kp, cp, blockhash, lvbh });
  const cpAta = associatedTokenAddress(new PublicKey(AGTR), cp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const { preFor, postFor } = settleSellStates({ wallet, ata: ata.toBase58(), cp: cp.publicKey.toBase58(), cpAta, ownPost: 1150, cpPost: 450, vaultPre: 1000, vaultPost: 350 });
  const poolVaultAta = associatedTokenAddress(new PublicKey(AGTR), new PublicKey(AGTR_POOL), TOKEN_2022_PROGRAM).toBase58();
  const innerFor = () => ([
    { index: 1, instructions: [innerTxfr(DIST_VAULT, ata.toBase58(), 250)] },
    { index: 2, instructions: [innerTxfr(DIST_VAULT, cpAta, 400)] },
    { index: 3, instructions: [innerTxfr(ata.toBase58(), poolVaultAta, 100)] },
  ]);
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1, vaultBalance: 1000n, innerFor });
  const gwFetch = sellGwFetch(txB64, blockhash, lvbh);
  const lines = [];
  let ok = true;
  try {
    const card = await prepareTrade({ wallet, mint: AGTR, side: 'sell', amount: '0.0001', signerType: 'own', fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB });
    const control = await sendCard({ keypair: kp, card, approve: card.approvalToken, dryRun: true, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    lines.push(`control (unaltered card): dry-run mode=${control.mode}, measured own payout=${control.deltas.settlementOwnPayoutRaw}`);

    const countForged = JSON.parse(JSON.stringify(card));
    countForged.validation.settlementPayout.settles = 3;
    countForged.settlementPayout.settles = 3;
    let codeA = 'NO-THROW';
    try {
      await sendCard({ keypair: kp, card: countForged, approve: card.approvalToken, dryRun: true, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    } catch (e) { codeA = e.code ?? 'ERR'; }
    const goodA = codeA === 'SETTLEMENT_MODEL_MISMATCH';
    ok = ok && goodA;
    lines.push(`settles count 2→3 in both model copies: refused=${goodA} code=${codeA}`);

    const tokenForged = JSON.parse(JSON.stringify(card));
    tokenForged.validation.settlementPayout.settles = 3;
    tokenForged.settlementPayout.settles = 3;
    tokenForged.approvalToken = policyFingerprintOf({
      transactionFingerprint: tokenForged.fingerprint,
      mint: tokenForged.validation.mint, side: tokenForged.validation.side, venue: tokenForged.validation.venue,
      amountInRaw: tokenForged.validation.amountInRaw, minimumAmountOutRaw: tokenForged.validation.minimumAmountOutRaw,
      expectedAmountOutRaw: tokenForged.validation.expectedAmountOutRaw,
      maxSolDebitLamports: tokenForged.validation.maxSolDebitLamports, feeCeilingLamports: tokenForged.validation.feeCeilingLamports,
      blockhash: tokenForged.blockhash, fees: tokenForged.fees, priceImpactBps: tokenForged.priceImpactBps,
      settlementPayout: tokenForged.validation.settlementPayout,
    });
    let codeB = 'NO-THROW';
    try {
      await sendCard({ keypair: kp, card: tokenForged, approve: card.approvalToken, dryRun: true, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    } catch (e) { codeB = e.code ?? 'ERR'; }
    const goodB = codeB === 'APPROVAL_MISMATCH';
    ok = ok && goodB;
    lines.push(`count edit + approval token recomputed over the edited policy: the owner's original token refuses=${goodB} code=${codeB}`);

    const trimForged = JSON.parse(JSON.stringify(card));
    trimForged.validation.settlementPayout.holderAtas = trimForged.validation.settlementPayout.holderAtas.filter((h) => h !== cpAta);
    trimForged.settlementPayout.holderAtas = trimForged.settlementPayout.holderAtas.filter((h) => h !== cpAta);
    let codeC = 'NO-THROW';
    try {
      await sendCard({ keypair: kp, card: trimForged, approve: card.approvalToken, dryRun: true, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    } catch (e) { codeC = e.code ?? 'ERR'; }
    const goodC = codeC === 'SETTLEMENT_MODEL_MISMATCH';
    ok = ok && goodC;
    lines.push(`recipient trimmed from both model copies: refused=${goodC} code=${codeC}`);
    ok = ok && rawSends() === 0;
    lines.push(`sendRawTransaction calls=${rawSends()} (must be 0 — all sends above are dry-runs or refusals)`);
  } catch (e) {
    ok = false;
    lines.push(`setup failure: ${e.code ?? ''} ${e.message.slice(0, 200)}`);
  }
  report(44, 'settlement count + recipients bound — count edit, token recompute, and recipient trim all refuse (item 3)', ok, lines);
}

// Fixture 45 — item 2: prepare --out through a SYMLINKED PARENT
// directory refuses; nothing lands through the link. (Round 4
// checked only the final component of the output path.)
{
  const kp = Keypair.generate();
  const dir = join(tmp, 'f45'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'w.keypair.json'); writeKeypairFile(file, kp);
  const { blockhash, lvbh } = await liveBlockhash();
  const state = makeTradeState(kp, blockhash, lvbh);
  const stub = await startStub(state);
  const realDir = join(dir, 'real-out'); mkdirSync(realDir, { recursive: true });
  const linkDir = join(dir, 'link-out');
  symlinkSync(realDir, linkDir);
  const outPath = join(linkDir, 'approval-card.json');
  const r = await runCli(
    ['prepare', '--file', file, '--mint', AGTR, '--side', 'buy', '--amount', '0.01', '--out', outPath],
    { cwd: dir, env: { AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url } },
  );
  stub.server.close();
  const landed = existsSync(join(realDir, 'approval-card.json'));
  const ok = r.code !== 0 && r.out.includes('WRITE_SYMLINK_REFUSED') && !landed;
  report(45, 'prepare --out through a symlinked parent directory — refused, nothing written through the link (item 2)', ok, [
    `prepare exit=${r.code}, code=${r.out.includes('WRITE_SYMLINK_REFUSED') ? 'WRITE_SYMLINK_REFUSED' : 'MISSING'}, card landed through the link=${landed}`,
    `message: ${r.out.trim().split('\n')[0].slice(0, 200)}…`,
  ]);
}

// Fixture 46 — item 5: enrollment binds the COMPLETE invocation of
// an interpreter-based signer: executable = this node binary, argv
// template = [script, key file, config file], every file hashed.
// Changing the SCRIPT refuses with the interpreter untouched;
// changing the CONFIG refuses; the unchanged invocation works.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const dir = join(tmp, 'f46'); mkdirSync(dir, { recursive: true });
  const keyFile = join(dir, 'signer.keypair.json'); writeKeypairFile(keyFile, kp);
  const { blockhash, lvbh } = await liveBlockhash();
  const state = makeTradeState(kp, blockhash, lvbh);
  const stub = await startStub(state);
  const env = {
    AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url,
    AGENTONLY_SIGNER_ALLOWLIST: join(dir, 'signers.json'),
  };
  const cardPath = join(dir, 'approval-card.json');
  const configFile = join(dir, 'signer-config.json');
  const configBody = JSON.stringify({ mode: 'sign' }) + '\n';
  writeFileSync(configFile, configBody);
  const script = join(dir, 'signer46.mjs');
  const scriptBody = `
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { Keypair, Transaction } = createRequire(${JSON.stringify(join(ROOT, 'package.json'))})('@solana/web3.js');
const cfg = JSON.parse(readFileSync(process.argv[3], 'utf8'));
if (cfg.mode !== 'sign') { console.error('config mode is not sign'); process.exit(2); }
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.argv[2], 'utf8'))));
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const tx = Transaction.from(Buffer.from(input.trim(), 'base64'));
  tx.partialSign(kp);
  process.stdout.write(tx.serialize().toString('base64'));
});
`;
  writeFileSync(script, scriptBody);
  const prep = await runCli(['prepare', '--signer-type', 'external', '--wallet', wallet, '--mint', AGTR, '--side', 'buy', '--amount', '0.01', '--out', cardPath], { cwd: dir, env });
  const card = existsSync(cardPath) ? JSON.parse(readFileSync(cardPath, 'utf8')) : null;
  const lines = [`external prepare exit=${prep.code}, card written=${!!card}`];
  let ok = !!card;
  if (card) {
    const sendArgs = ['send', '--signer-type', 'external', '--external-signer', process.execPath, '--wallet', wallet, '--card', cardPath, '--approve', card.approvalToken, '--dry-run'];
    const enroll = await runCli(['signer', 'enroll', '--path', process.execPath, '--arg', script, '--arg', keyFile, '--arg', configFile], { cwd: dir, env });
    lines.push(`enroll (interpreter + script + key + config) exit=${enroll.code}`);
    const good = await runCli(sendArgs, { cwd: dir, env });
    lines.push(`unchanged complete invocation dry-run exit=${good.code}`);
    writeFileSync(script, scriptBody + '// script drift after enrollment\n');
    const scriptChanged = await runCli(sendArgs, { cwd: dir, env });
    lines.push(`script changed (interpreter untouched): exit=${scriptChanged.code}, code=${scriptChanged.out.includes('SIGNER_INTEGRITY_MISMATCH') ? 'SIGNER_INTEGRITY_MISMATCH' : 'MISSING'}, names the script=${scriptChanged.out.includes('signer46.mjs')}`);
    writeFileSync(script, scriptBody);
    writeFileSync(configFile, JSON.stringify({ mode: 'hold' }) + '\n');
    const configChanged = await runCli(sendArgs, { cwd: dir, env });
    lines.push(`config changed (script + interpreter untouched): exit=${configChanged.code}, code=${configChanged.out.includes('SIGNER_INTEGRITY_MISMATCH') ? 'SIGNER_INTEGRITY_MISMATCH' : 'MISSING'}, names the config=${configChanged.out.includes('signer-config.json')}`);
    writeFileSync(configFile, configBody);
    const restored = await runCli(sendArgs, { cwd: dir, env });
    lines.push(`all components restored: dry-run exit=${restored.code} (no re-enrollment)`);
    ok = enroll.code === 0
      && good.code === 0 && good.out.includes('DRY RUN')
      && scriptChanged.code !== 0 && scriptChanged.out.includes('SIGNER_INTEGRITY_MISMATCH') && scriptChanged.out.includes('signer46.mjs')
      && configChanged.code !== 0 && configChanged.out.includes('SIGNER_INTEGRITY_MISMATCH') && configChanged.out.includes('signer-config.json')
      && restored.code === 0 && restored.out.includes('DRY RUN');
  }
  stub.server.close();
  report(46, 'signer enrollment binds the complete invocation — script drift and config drift refuse, interpreter untouched; unchanged invocation works (item 5)', ok, lines);
}

// Fixture 47 — repair round 5, live-smoke correction: the real
// chain reports the wallet's wrapped-SOL ATA — created and CLOSED
// inside the venue build — as a PRESENT post-simulation state with
// zero lamports and empty data (a purged account). Round 3's P1-4
// rule read that as malformed token data and refused every real
// send; the closed shape (0 lamports + empty data) is now treated
// as the nonexistent account it is, while fixture 30's case (rent
// lamports present, data unreadable) still refuses. Same build and
// settlement story as fixture 23; the WSOL ATA's post state is the
// closed shape a real node returns.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const { tx, wsolAta, cardAta } = buildRealShapeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const T22 = new PublicKey(TOKEN_2022_PROGRAM);
  const SYS = new PublicKey('11111111111111111111111111111111');
  const { preFor, postFor } = buyStateFns({
    wallet, ata: cardAta.toBase58(), pool: AGTR_POOL,
    extraPre: { [DIST_VAULT]: acctState(1_539_240, stdTokenBlob(AGTR, DIST_STATE, 934), T22) },
    extraPost: {
      [DIST_VAULT]: acctState(1_539_240, stdTokenBlob(AGTR, DIST_STATE, 929), T22),
      // The closed WSOL ATA, exactly as a real simulation reports it.
      [wsolAta.toBase58()]: acctState(0, Buffer.alloc(0), SYS),
    },
  });
  const poolVaultAta = associatedTokenAddress(new PublicKey(AGTR), new PublicKey(AGTR_POOL), TOKEN_2022_PROGRAM).toBase58();
  const innerFor = () => ([
    { index: 1, instructions: [innerTxfr(DIST_VAULT, cardAta.toBase58(), 3)] },
    { index: 2, instructions: [innerTxfr(DIST_VAULT, cardAta.toBase58(), 2)] },
    { index: 6, instructions: [innerTxfr(poolVaultAta, cardAta.toBase58(), 495)] },
  ]);
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1, innerFor });
  const gwFetch = makeGwFetch(stubBuild(txB64, blockhash, lvbh));
  let ok = false; const lines = [];
  try {
    const card = await prepareTrade({
      wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own',
      fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB,
    });
    const result = await sendCard({
      keypair: kp, card, approve: card.approvalToken, dryRun: true,
      connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB,
    });
    ok = result.mode === 'dry-run'
      && result.deltas.solDelta === -10_005_000
      && result.deltas.tokenDelta === '500'
      && result.deltas.settlementOwnPayoutRaw === '5'
      && rawSends() === 0;
    lines.push(`dry-run with the WSOL ATA reported closed (0 lamports, empty data): mode=${result.mode}, solDelta=${result.deltas.solDelta}, tokenDelta=${result.deltas.tokenDelta}, measured payout=${result.deltas.settlementOwnPayoutRaw}, sends=${rawSends()}`);
  } catch (e) {
    lines.push(`threw ${e.code ?? ''}: ${e.message.slice(0, 220)}`);
  }
  report(47, 'closed-account post-simulation state (WSOL ATA purged in-trade) — accounted, not malformed (round-5 live-smoke correction)', ok, lines);
}

// Fixture 48 — repair round 5, second live-smoke correction: the
// PRODUCTION counterparty form end to end. The counterparty settle's
// holder is the DBC pool authority and its recipient is the pool's
// base vault (derived from pool state, fixture 35's control shape) —
// and on a sell the swap leg ALSO pays the sold tokens into that
// same vault, so the vault's net movement (swap 100 + payout 400)
// far exceeds the payout bound even though its measured payout
// (400) is inside it. The per-recipient bound applies to the
// MEASURED payout; the vault's net is held to the attribution
// equality instead. Fixture 33's numbers otherwise.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const authority = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_authority')], new PublicKey(DBC_PROGRAM),
  )[0];
  const baseVault = Keypair.generate().publicKey.toBase58();
  const quoteVault = Keypair.generate().publicKey.toBase58();
  const mintPk = new PublicKey(AGTR);
  const ata = associatedTokenAddress(mintPk, kp.publicKey, TOKEN_2022_PROGRAM);
  const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight: lvbh });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(settleIx({ payer: kp.publicKey, holder: kp.publicKey, mint: AGTR }));
  const cpSettle = settleIx({ payer: kp.publicKey, holder: authority, mint: AGTR });
  cpSettle.keys[2].pubkey = new PublicKey(baseVault);
  tx.add(cpSettle);
  tx.add(new TransactionInstruction({
    programId: new PublicKey(DBC_PROGRAM),
    keys: [
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(AGTR_POOL), isSigner: false, isWritable: true },
      { pubkey: mintPk, isSigner: false, isWritable: false },
      { pubkey: ata, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from('b75d992818e6c297', 'hex'), Buffer.alloc(23, 7)]),
  }));
  tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from('agentonly-runtime fixture 48') }));
  const txB64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
  const poolBlob = Buffer.alloc(424);
  poolBlob.set(bs58.decode(AGTR), 136);
  poolBlob.set(bs58.decode(baseVault), 168);
  poolBlob.set(bs58.decode(quoteVault), 200);
  const T22 = new PublicKey(TOKEN_2022_PROGRAM);
  // base vault: 5000 + 100 (swap leg in) + 400 (its measured payout) = 5500.
  const { preFor, postFor } = settleSellStates({
    wallet, ata: ata.toBase58(), cp: authority.toBase58(), cpAta: baseVault,
    ownPost: 1150, cpPost: 5500, cpPre: 5000, vaultPre: 1000, vaultPost: 350,
    extraPre: {
      [AGTR_POOL]: acctState(5_000_000, poolBlob, new PublicKey(DBC_PROGRAM)),
      [quoteVault]: acctState(2_039_280, stdTokenBlob(WSOL_MINT, authority.toBase58(), 7000), new PublicKey(TOKEN_PROGRAM_ID)),
    },
  });
  const innerFor = () => ([
    { index: 1, instructions: [innerTxfr(DIST_VAULT, ata.toBase58(), 250)] },
    { index: 2, instructions: [innerTxfr(DIST_VAULT, baseVault, 400)] },
    { index: 3, instructions: [innerTxfr(ata.toBase58(), baseVault, 100)] },
  ]);
  const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1, vaultBalance: 1000n, innerFor });
  const gwFetch = sellGwFetch(txB64, blockhash, lvbh);
  let ok = false; const lines = [];
  try {
    const card = await prepareTrade({ wallet, mint: AGTR, side: 'sell', amount: '0.0001', signerType: 'own', fetchImpl: gwFetch, connection: conn, tokenJson: TOKEN_JSON_STUB });
    const receipt = await sendCard({ keypair: kp, card, approve: card.approvalToken, connection: conn, fetchImpl: gwFetch, tokenJson: TOKEN_JSON_STUB });
    ok = receipt.mode === 'broadcast' && rawSends() === 1
      && receipt.deltas.tokenDelta === '150'
      && receipt.deltas.settlementOwnPayoutRaw === '250'
      && receipt.deltas.settlementPayoutRaw === '650';
    lines.push(`send: mode=${receipt.mode}, tokenDelta=${receipt.deltas.tokenDelta}, own payout (measured)=${receipt.deltas.settlementOwnPayoutRaw}, total outflow=${receipt.deltas.settlementPayoutRaw}, sends=${rawSends()} — the base vault's net +500 (100 swap + 400 payout) passes on its measured payout, not its net`);
  } catch (e) {
    lines.push(`threw ${e.code ?? ''}: ${e.message.slice(0, 220)}`);
  }
  report(48, 'production counterparty form end to end — pool-authority settle into the pool-state base vault passes on the measured payout (round-5 live-smoke correction)', ok, lines);
}

// Fixture 49 — repair round 5.1: the canonical record publishes
// baseVault/quoteVault/poolAuthority, and the runtime pins the
// pool-authority counterparty settle recipient FROM THE RECORD
// (cross-checked against the chain), with pool-state derivation as
// the fallback for records that name none.
//   A. The pool state is ILLEGIBLE in the double (empty data —
//      derivation contributes nothing), the record names the vaults,
//      both vault accounts read back correctly: prepare classifies +
//      models, and the model's pin source is 'record'.
//   B. The same record, but the counterparty settle pays a different
//      vault — a perfectly valid token account under the pool
//      authority that is NEITHER in the record NOR derivable:
//      refused at prepare.
//   C. The record names vault X (whose accounts verify), the legible
//      pool state names vault Y, and the build pays Y — the shape
//      round 5 admitted by derivation: now the record-vs-chain
//      disagreement itself refuses at prepare.
{
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const lvbh = 500_000_000;
  const authority = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_authority')], new PublicKey(DBC_PROGRAM),
  )[0];
  const ata = associatedTokenAddress(new PublicKey(AGTR), kp.publicKey, TOKEN_2022_PROGRAM).toBase58();
  const T22 = new PublicKey(TOKEN_2022_PROGRAM);
  const lines = [];
  let ok = true;
  const recordJson = (baseVault, quoteVault) => ({
    mint: AGTR, symbol: 'AGTR', decimals: 6,
    addresses: {
      pool: AGTR_POOL, distributor: { state: DIST_STATE, vault: DIST_VAULT },
      poolAuthority: authority.toBase58(), baseVault, quoteVault,
    },
  });
  const cpTx = (recipient) => {
    const tx = buildTradeTx({ kp, mint: AGTR, pool: AGTR_POOL, blockhash, lvbh });
    const settle = settleIx({ payer: kp.publicKey, holder: authority, mint: AGTR });
    settle.keys[2].pubkey = new PublicKey(recipient);
    tx.add(settle);
    return tx.serialize({ requireAllSignatures: false }).toString('base64');
  };
  // A — record pin, derivation impossible (pool state illegible).
  {
    const baseVault = Keypair.generate().publicKey.toBase58();
    const quoteVault = Keypair.generate().publicKey.toBase58();
    const { preFor, postFor } = buyStateFns({
      wallet, ata, pool: AGTR_POOL,
      extraPre: {
        [baseVault]: acctState(2_039_280, stdTokenBlob(AGTR, authority.toBase58(), 5000), T22),
        [quoteVault]: acctState(2_039_280, stdTokenBlob(WSOL_MINT, authority.toBase58(), 7000), new PublicKey(TOKEN_PROGRAM_ID)),
      },
    });
    const { conn, rawSends } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
    try {
      const card = await prepareTrade({ wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own', fetchImpl: makeGwFetch(stubBuild(cpTx(baseVault), blockhash, lvbh)), connection: conn, tokenJson: recordJson(baseVault, quoteVault) });
      const sp = card.validation.settlementPayout;
      const good = (sp?.holderAtas ?? []).includes(baseVault) && sp?.poolVaultPin === 'record';
      ok = ok && good && rawSends() === 0;
      lines.push(`A. record-published base vault (pool state illegible, derivation empty): classified + modeled=${(sp?.holderAtas ?? []).includes(baseVault)}, pin source=${sp?.poolVaultPin} (must be 'record')`);
    } catch (e) {
      ok = false;
      lines.push(`A. record pin: threw ${e.code ?? ''}: ${e.message.slice(0, 160)}`);
    }
    // B — a different vault, in neither the record nor any derivation.
    const otherVault = Keypair.generate().publicKey.toBase58();
    const { preFor: preB, postFor: postB } = buyStateFns({
      wallet, ata, pool: AGTR_POOL,
      extraPre: {
        [baseVault]: acctState(2_039_280, stdTokenBlob(AGTR, authority.toBase58(), 5000), T22),
        [quoteVault]: acctState(2_039_280, stdTokenBlob(WSOL_MINT, authority.toBase58(), 7000), new PublicKey(TOKEN_PROGRAM_ID)),
        [otherVault]: acctState(2_039_280, stdTokenBlob(AGTR, authority.toBase58(), 9000), T22),
      },
    });
    const connB = makeDoubleConn({ preFor: preB, postFor: postB, blockHeight: lvbh - 1 }).conn;
    let codeB = 'NO-THROW';
    try {
      await prepareTrade({ wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own', fetchImpl: makeGwFetch(stubBuild(cpTx(otherVault), blockhash, lvbh)), connection: connB, tokenJson: recordJson(baseVault, quoteVault) });
    } catch (e) { codeB = e.code ?? 'ERR'; }
    const goodB = codeB === 'UNCLASSIFIED_INSTRUCTION';
    ok = ok && goodB;
    lines.push(`B. counterparty settle paying a vault in neither the record nor a derivation: refused at prepare=${goodB} code=${codeB}`);
  }
  // C — record-vs-chain disagreement refuses (build pays the
  // state-named vault the record does NOT publish).
  {
    const recBase = Keypair.generate().publicKey.toBase58();
    const recQuote = Keypair.generate().publicKey.toBase58();
    const stateBase = Keypair.generate().publicKey.toBase58();
    const poolBlob = Buffer.alloc(424);
    poolBlob.set(bs58.decode(AGTR), 136);
    poolBlob.set(bs58.decode(stateBase), 168);
    poolBlob.set(bs58.decode(recQuote), 200);
    const { preFor, postFor } = buyStateFns({
      wallet, ata, pool: AGTR_POOL,
      extraPre: {
        [AGTR_POOL]: acctState(5_000_000, poolBlob, new PublicKey(DBC_PROGRAM)),
        [recBase]: acctState(2_039_280, stdTokenBlob(AGTR, authority.toBase58(), 5000), T22),
        [recQuote]: acctState(2_039_280, stdTokenBlob(WSOL_MINT, authority.toBase58(), 7000), new PublicKey(TOKEN_PROGRAM_ID)),
        [stateBase]: acctState(2_039_280, stdTokenBlob(AGTR, authority.toBase58(), 5000), T22),
      },
    });
    const { conn } = makeDoubleConn({ preFor, postFor, blockHeight: lvbh - 1 });
    let code = 'NO-THROW';
    try {
      await prepareTrade({ wallet, mint: AGTR, side: 'buy', amount: '0.01', signerType: 'own', fetchImpl: makeGwFetch(stubBuild(cpTx(stateBase), blockhash, lvbh)), connection: conn, tokenJson: recordJson(recBase, recQuote) });
    } catch (e) { code = e.code ?? 'ERR'; }
    const good = code === 'RECORD_POOL_VAULT_MISMATCH';
    ok = ok && good;
    lines.push(`C. build pays the pool-state vault while the record publishes a different one: refused at prepare=${good} code=${code}`);
  }
  report(49, 'canonical-record pool-vault pin — record-published vault models with the pin sourced to the record; an unpublished vault refuses; record-vs-chain disagreement refuses (round 5.1)', ok, lines);
}

// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.ok).length;
console.log(`\n=== ${passed}/${results.length} fixtures passed ===`);
rmSync(tmp, { recursive: true, force: true });
console.log(`cleaned up ${tmp}`);
process.exit(passed === results.length ? 0 : 1);

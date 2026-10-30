// agentonly-runtime acceptance fixtures (15).
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
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  associatedTokenAddress,
  fingerprintOf,
  parseStrictDecimal,
  prepareTrade,
  sendCard,
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
function buildTradeTx({ kp, mint, pool, blockhash, lvbh }) {
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
    ],
    data: Buffer.from([1]),
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
  const attestedAt = sidecarExists ? JSON.parse(readFileSync(sidecarPath, 'utf8')).attestedAt : null;
  // Exclusive creation: a second create over the same path must refuse.
  const dupe = await runCli(['wallet', 'create', '--file', file], { cwd: tmp });
  const ok = create.code === 0
    && create.stdout.includes('persistence handshake: OK')
    && !!addr
    && show.code === 0 && show.stdout.trim() === addr
    && existsSync(file)
    && sidecarExists
    && gated.code !== 0 && gated.out.includes('WALLET_NOT_ATTESTED')
    && attest.code === 0 && !!attestedAt
    && dupe.code !== 0 && dupe.out.includes('KEYPAIR_EXISTS');
  report(1, 'persistent local signer (create → handshake → sidecar → attestation gate → show)', ok, [
    `create exit=${create.code}, handshake line present=${create.stdout.includes('persistence handshake: OK')}`,
    `address from create: ${addr}; from show (separate process): ${show.stdout.trim()}`,
    `sidecar written=${sidecarExists}; prepare before attestation: exit=${gated.code} code=${gated.out.includes('WALLET_NOT_ATTESTED') ? 'WALLET_NOT_ATTESTED' : 'MISSING'}`,
    `attest exit=${attest.code}, sidecar attestedAt=${attestedAt}`,
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
    const r8 = await runCli(['send', '--file', file, '--card', cardPath, '--approve', card.fingerprint], { cwd: dir, env });
    deferred[8] = {
      ok: r8.code !== 0 && r8.out.includes('VENUE_CHANGED'),
      lines: [
        `prepare exit=${prep.code}, send exit=${r8.code} after quote venue flipped curve → house`,
        `message: ${r8.out.trim().split('\n')[0].slice(0, 200)}…`,
      ],
    };
    state.quoteVenue = 'curve'; // restore

    // Fixture 7 — happy path dry-run with delta enforcement.
    const r7 = await runCli(['send', '--file', file, '--card', cardPath, '--approve', card.fingerprint, '--dry-run'], { cwd: dir, env });
    const ok7 = r7.code === 0 && r7.out.includes('DRY RUN') && r7.out.includes('simulation err: null')
      && r7.out.includes('simulated deltas')
      && state.lastSimulateVerdict?.err === null
      && card.version === 2 && !!card.intent && card.blockhash === blockhash
      && card.maxSolDebitLamports === '15000000' && card.feeCeilingLamports === '5000000';
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
    const r9 = await runCli(['send', '--file', file, '--card', forgedPath, '--approve', card.fingerprint, '--dry-run'], { cwd: dir, env });
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
    const r11 = await runCli(['send', '--file', file, '--card', cardPath, '--approve', card.fingerprint], { cwd: dir, env });
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
  const preFor = (addr) => (addr === wallet
    ? { lamports: 100_000_000, data: Buffer.alloc(0), owner: new PublicKey('11111111111111111111111111111111'), executable: false, rentEpoch: 0 }
    : { lamports: 2_039_280, data: tokenBlob(0), owner: new PublicKey(TOKEN_2022_PROGRAM), executable: false, rentEpoch: 0 });
  const postFor = (addr) => (addr === wallet
    ? { lamports: 100_000_000 - 10_005_000, data: Buffer.alloc(0), owner: new PublicKey('11111111111111111111111111111111'), executable: false, rentEpoch: 0 }
    : { lamports: 2_039_280, data: tokenBlob(500), owner: new PublicKey(TOKEN_2022_PROGRAM), executable: false, rentEpoch: 0 });
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
      keypair: kp, card, approve: card.fingerprint, connection: conn, fetchImpl: gwFetch, tokenJson,
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
  const env = { AGENTONLY_GATEWAY_BASE: stub.url, AGENTONLY_RPC_URL: stub.url };
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
    const good = await runCli(
      ['send', '--signer-type', 'external', '--external-signer', `node ${signerGood} ${keyFile}`, '--wallet', wallet, '--card', cardPath, '--approve', card.fingerprint, '--dry-run'],
      { cwd: dir, env },
    );
    lines.push(`good signer dry-run exit=${good.code}`);
    const evil = await runCli(
      ['send', '--signer-type', 'external', '--external-signer', `node ${signerEvil} ${keyFile}`, '--wallet', wallet, '--card', cardPath, '--approve', card.fingerprint, '--dry-run'],
      { cwd: dir, env },
    );
    lines.push(`message-altering signer exit=${evil.code}, code=${evil.out.includes('EXTERNAL_SIGNER_MISMATCH') ? 'EXTERNAL_SIGNER_MISMATCH' : 'MISSING'}`);
    lines.push(`evil message: ${evil.out.trim().split('\n')[0].slice(0, 160)}…`);
    ok = good.code === 0 && good.out.includes('DRY RUN') && evil.code !== 0 && evil.out.includes('EXTERNAL_SIGNER_MISMATCH');
  } else {
    lines.push(`prepare output: ${prep.out.trim().split('\n')[0]}`);
  }
  stub.server.close();
  report(13, 'external signer — stdin/stdout protocol works; altered message refused', ok, lines);
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
const passed = results.filter((r) => r.ok).length;
console.log(`\n=== ${passed}/${results.length} fixtures passed ===`);
rmSync(tmp, { recursive: true, force: true });
console.log(`cleaned up ${tmp}`);
process.exit(passed === results.length ? 0 : 1);

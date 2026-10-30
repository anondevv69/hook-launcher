#!/usr/bin/env node
// AgentOnly MCP server — read/prepare only.
//
// A dependency-free MCP server over stdio (newline-delimited JSON-RPC
// 2.0) exposing seven tools that wrap AgentOnly's public surfaces:
// the canonical token registry + market snapshot on agentonly.fun and
// the Execution Gateway's unsigned quote/eligibility/build/simulate
// endpoints. The server holds NO keys, never signs, and never
// broadcasts: `build` returns UNSIGNED transaction data for the host
// agent's own signer path, and the host's approval policy still
// governs every action. See README.md for the exclusion list.

import readline from 'node:readline';

const BASE = process.env.AGENTONLY_BASE || 'https://agentonly.fun';
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const PROTOCOL_VERSION = '2024-11-05';

// Key-shaped argument names are refused before any tool runs — the
// server must never receive key material, even by argument smuggling.
const KEY_SHAPED = new Set([
  'privatekey', 'private_key',
  'secretkey', 'secret_key', 'secret',
  'seed', 'seedphrase', 'seed_phrase',
  'mnemonic',
  'keypair', 'keypairbytes',
]);

function findKeyShaped(value, path = '') {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const norm = String(k).toLowerCase().replace(/[^a-z_]/g, '');
      if (KEY_SHAPED.has(norm)) return path ? `${path}.${k}` : k;
      const hit = findKeyShaped(v, path ? `${path}.${k}` : k);
      if (hit) return hit;
    }
  }
  return null;
}

async function fetchJson(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON upstream */ }
  if (!res.ok) {
    const reason = data?.error?.code || data?.error || data?.message || `HTTP ${res.status}`;
    const err = new Error(`upstream ${method} ${url} failed: ${reason}${data?.error?.message ? ` — ${data.error.message}` : ''}`);
    err.upstream = data;
    throw err;
  }
  if (data === null) throw new Error(`upstream ${method} ${url} returned non-JSON`);
  return data;
}

const ok = (summary, structured) => ({
  content: [{ type: 'text', text: summary }],
  ...(structured !== undefined ? { structuredContent: structured } : {}),
});
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

// ---------- tool implementations ----------

async function toolInspectToken({ mint }) {
  const doc = await fetchJson(`${BASE}/api/v1/tokens/${mint}.json`);
  const t = doc.token || doc;
  let market = null;
  try {
    const snap = await fetchJson(`${BASE}/api/market.json`);
    market = (snap.tokens || []).find((x) => x.mint === mint) || null;
  } catch { /* market snapshot is best-effort; canonical doc stands alone */ }
  const rules = (t.rules || []).map((r) => `${r.id}:${r.name || r.id}`).join(', ') || 'none';
  const lines = [
    `${t.name || '?'} ($${t.symbol || '?'}) — mint ${mint}`,
    `rules: ${rules}`,
    `graduation: ${(t.graduation || {}).mode || 'unknown'}${(t.graduation || {}).thresholdSol != null ? ` at ${(t.graduation).thresholdSol} SOL` : ''}`,
  ];
  if (market) {
    lines.push(`market: status=${market.status || 'ok'} price=${market.priceSol ?? market.price ?? '?'} SOL reserves=${market.reservesSol ?? '?'} SOL graduation progress=${market.graduationProgressPct ?? market.graduationProgress ?? '?'}`);
  } else {
    lines.push('market: no live snapshot entry for this mint right now.');
  }
  return ok(lines.join('\n'), { token: t, market });
}

async function toolListEvents({ cursor } = {}) {
  const feed = await fetchJson(`${BASE}/api/v1/market-events.json`);
  const after = Number.isFinite(cursor) ? cursor : 0;
  const events = (feed.events || []).filter((e) => (e.sequence ?? 0) > after);
  const text = events.length
    ? events.map((e) => `#${e.sequence} ${e.type} ${e.symbol || ''} ${e.mint || ''} @ ${e.observedAt || ''}`).join('\n')
    : `No events after cursor ${after}.`;
  return ok(text, { events, nextCursor: feed.nextCursor ?? null });
}

async function gateway(path, body, summaryFn) {
  const data = await fetchJson(`${BASE}${path}`, { method: 'POST', body });
  return ok(summaryFn(data), data);
}

const toolQuote = ({ mint, side, amount }) =>
  gateway('/v1/trade/quote', { mint, side, amount }, (d) =>
    `quote: ${side} ${amount} -> amountOut=${d.amountOut ?? d.quote?.amountOut ?? '?'} minimumOut=${d.minimumAmountOut ?? d.quote?.minimumAmountOut ?? '?'} venue=${d.venue ?? d.quote?.venue ?? '?'}`);

const toolEligibility = ({ mint, side, amount, wallet }) =>
  gateway('/v1/trade/eligibility', { mint, side, amount, wallet }, (d) =>
    `eligibility: status=${d.status ?? '?'}${Array.isArray(d.reasons) && d.reasons.length ? ` reasons=${d.reasons.map((r) => r.code || r).join(', ')}` : ''}`);

const toolBuild = ({ mint, side, amount, wallet }) =>
  gateway('/v1/trade/build', { mint, side, amount, wallet }, (d) =>
    `UNSIGNED build ready for your own signer: status=${d.status ?? '?'} minimum_amount_out=${d.minimum_amount_out ?? '?'} last_valid_block_height=${d.last_valid_block_height ?? '?'} simulation=${d.simulation?.status ?? '?'}. This server did not sign or broadcast anything — sign only after explicit owner approval.`);

const toolSimulate = ({ mint, transactionBase64 }) =>
  gateway('/v1/trade/simulate', { mint, transactionBase64 }, (d) =>
    `simulation: status=${d.simulation?.status ?? d.status ?? '?'}${d.simulation?.reason ? ` — ${d.simulation.reason}` : ''}`);

async function toolVerify({ signature }) {
  const statuses = await fetchJson(RPC, {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[signature], { searchTransactionHistory: true }] },
  });
  const st = statuses?.result?.value?.[0] || null;
  if (!st) return ok(`verify: signature ${signature} not found on-chain yet (no status).`, { signature, found: false });
  let summary = `verify: ${signature} — confirmation=${st.confirmationStatus || 'processed'}, slot=${st.slot}, ${st.err ? `FAILED: ${JSON.stringify(st.err)}` : 'succeeded (no error)'}`;
  let tx = null;
  try {
    const txRes = await fetchJson(RPC, {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }] },
    });
    tx = txRes?.result || null;
    if (tx) summary += `; blockTime=${tx.blockTime ?? '?'}, fee=${tx.meta?.fee ?? '?'} lamports`;
  } catch { /* status already answers confirmation + success */ }
  return ok(summary, { signature, found: true, status: st, transaction: tx ? { slot: tx.slot, blockTime: tx.blockTime, fee: tx.meta?.fee ?? null, err: tx.meta?.err ?? null } : null });
}

// ---------- tool registry ----------

const TOOLS = [
  {
    name: 'inspect_token',
    description: 'Inspect an AgentOnly token: canonical launch record (rules, graduation, provenance) plus its live market snapshot entry. Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { mint: { type: 'string', description: 'Token mint address (base58)' } }, required: ['mint'] },
    run: toolInspectToken,
  },
  {
    name: 'list_events',
    description: 'List AgentOnly market events (launch_published today; lifecycle events as sources land) after an optional sequence cursor. Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'number', description: 'Return events with sequence > cursor; omit for all' } } },
    run: toolListEvents,
  },
  {
    name: 'quote',
    description: 'Get a live, hook-aware quote for a buy or sell from the Execution Gateway. Unsigned, read-only — no transaction is built.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { mint: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, amount: { type: 'number', description: 'Buy: SOL amount. Sell: token amount in UI units.' } }, required: ['mint', 'side', 'amount'] },
    run: toolQuote,
  },
  {
    name: 'eligibility',
    description: 'Tri-state eligibility check (eligible | ineligible | unknown, with TK_* reason codes) for a wallet, token, side and amount. Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { mint: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, amount: { type: 'number' }, wallet: { type: 'string', description: 'Wallet public key (never key material)' } }, required: ['mint', 'side', 'amount', 'wallet'] },
    run: toolEligibility,
  },
  {
    name: 'build',
    description: 'Build an UNSIGNED hook-aware swap transaction via the Execution Gateway and simulate it. Returns unsigned transaction data only — this server cannot and does not sign or broadcast; signing happens in the host agent\u2019s own signer after explicit owner approval.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { mint: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, amount: { type: 'number' }, wallet: { type: 'string', description: 'Wallet public key (never key material)' } }, required: ['mint', 'side', 'amount', 'wallet'] },
    run: toolBuild,
  },
  {
    name: 'simulate',
    description: 'Simulate a caller-supplied base64 transaction against live chain state via the Execution Gateway; failures are classified (route / signer / hook veto / RPC). Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { mint: { type: 'string' }, transactionBase64: { type: 'string' } }, required: ['mint', 'transactionBase64'] },
    run: toolSimulate,
  },
  {
    name: 'verify',
    description: 'Verify a broadcast transaction by signature via a public Solana RPC: confirmation status, success/failure, slot and fee. Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { signature: { type: 'string', description: 'Transaction signature (base58)' } }, required: ['signature'] },
    run: toolVerify,
  },
];

// ---------- JSON-RPC / MCP plumbing ----------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: 'agentonly', version: '1.1.0' },
        capabilities: { tools: {} },
      });
    case 'notifications/initialized':
      return; // notification: no reply
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return replyError(id, -32602, `Unknown tool: ${name}. This server exposes only: ${TOOLS.map((t) => t.name).join(', ')}.`);
      const smuggled = findKeyShaped(args);
      if (smuggled) return reply(id, fail(`Refused: argument "${smuggled}" looks like key material. This server never accepts private keys, secret keys, seeds, or mnemonics.`));
      // Closed input schemas (issue #4): every tool declares
      // additionalProperties: false, and the server enforces it here —
      // any argument whose key is not in the tool's declared property
      // set is refused before dispatch, so a secret-looking value can
      // never ride in under an undeclared name. Together with the
      // key-shaped scan above (which guards declared names), unknown
      // keys never reach a tool.
      const declared = new Set(Object.keys(tool.inputSchema?.properties || {}));
      const unknownKeys = Object.keys(args).filter((k) => !declared.has(k));
      if (unknownKeys.length) return reply(id, fail(`Refused: unknown argument ${unknownKeys.map((k) => `"${k}"`).join(', ')} for tool "${name}" — the schema is closed (additionalProperties: false). Declared arguments: ${[...declared].join(', ') || '(none)'}.`));
      try {
        return reply(id, await tool.run(args));
      } catch (e) {
        return reply(id, fail(`Tool ${name} failed: ${e.message}`));
      }
    }
    default:
      if (!isNotification) return replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; } // ignore non-JSON noise on the wire
  try { await handle(msg); } catch (e) {
    if (msg && msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, `Internal error: ${e.message}`);
  }
});

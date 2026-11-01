// Contract tests for the AgentOnly MCP server.
//
// Spawns agentonly-mcp.mjs as a child process and drives it over stdio
// (newline-delimited JSON-RPC), then runs a static source guard. Live
// calls hit the real agentonly.fun surfaces — that is the point of a
// contract test. Exits non-zero on any failure.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'agentonly-mcp.mjs');
const AGTR = 'Hfk7uqxZ3fFB4TpAzSKYGCJ3uuAJ1E1fk6i6vSn3FVXR';
const EXPECTED = ['build', 'eligibility', 'inspect_token', 'list_events', 'quote', 'simulate', 'verify'];
const FORBIDDEN = ['sign', 'broadcast', 'fund', 'transfer', 'auto_buy', 'auto_sell', 'launch'];

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

// ---- spawn + JSON-RPC client ----
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';
const pending = new Map();
let nextId = 1;
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); } }, 60000);
});
const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');

try {
  // 1. initialize handshake
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contract-test', version: '0' } });
  check('initialize: serverInfo.name is agentonly', init.result?.serverInfo?.name === 'agentonly', JSON.stringify(init.result?.serverInfo));
  check('initialize: serverInfo.version is 1.1.5', init.result?.serverInfo?.version === '1.1.5', init.result?.serverInfo?.version || 'none');
  check('initialize: protocolVersion', init.result?.protocolVersion === '2024-11-05');
  notify('notifications/initialized');

  // 2. tools/list: exactly the seven, none forbidden
  const list = await rpc('tools/list');
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  check('tools/list: exactly the seven expected tools', JSON.stringify(names) === JSON.stringify(EXPECTED), names.join(','));
  check('tools/list: no forbidden tool names', !FORBIDDEN.some((f) => names.includes(f)));
  const openSchemas = (list.result?.tools || []).filter((t) => t.inputSchema?.additionalProperties !== false).map((t) => t.name);
  check('tools/list: every inputSchema is closed (additionalProperties: false)', openSchemas.length === 0 && (list.result?.tools || []).length === 7,
    openSchemas.length ? `open: ${openSchemas.join(',')}` : 'all 7 closed');

  // 3. live calls
  const insp = await rpc('tools/call', { name: 'inspect_token', arguments: { mint: AGTR } });
  check('inspect_token(AGTR): not an error', !insp.result?.isError, insp.result?.content?.[0]?.text?.split('\n')[0] || JSON.stringify(insp).slice(0, 200));
  check('inspect_token(AGTR): structured token present', insp.result?.structuredContent?.token?.symbol === 'AGTR');

  const ev = await rpc('tools/call', { name: 'list_events', arguments: {} });
  check('list_events: not an error', !ev.result?.isError);
  check('list_events: returns events + nextCursor', Array.isArray(ev.result?.structuredContent?.events) && ev.result.structuredContent.events.length > 0 && typeof ev.result.structuredContent.nextCursor === 'number',
    `${ev.result?.structuredContent?.events?.length} events, nextCursor=${ev.result?.structuredContent?.nextCursor}`);

  const q = await rpc('tools/call', { name: 'quote', arguments: { mint: AGTR, side: 'buy', amount: 0.01 } });
  check('quote(AGTR buy 0.01): not an error', !q.result?.isError, q.result?.content?.[0]?.text || JSON.stringify(q).slice(0, 200));

  // 4. forbidden tool name → JSON-RPC error
  const bad = await rpc('tools/call', { name: 'sign', arguments: {} });
  check('tools/call "sign": JSON-RPC error returned', !!bad.error, bad.error ? `${bad.error.code} ${bad.error.message.slice(0, 60)}` : JSON.stringify(bad).slice(0, 160));

  // 5. key-shaped argument rejected
  const smuggle = await rpc('tools/call', { name: 'quote', arguments: { mint: AGTR, side: 'buy', amount: 0.01, privateKey: 'should-never-be-here' } });
  check('quote with privateKey arg: rejected as tool error', smuggle.result?.isError === true && /key material/i.test(smuggle.result?.content?.[0]?.text || ''),
    smuggle.result?.content?.[0]?.text?.slice(0, 100) || '');

  // 5b. closed schemas: undeclared argument keys are refused before the
  // tool executes (issue #4) — the error names the offending key and no
  // tool result comes back.
  const bogusQuote = await rpc('tools/call', { name: 'quote', arguments: { mint: AGTR, side: 'buy', amount: 0.01, bogus: 1 } });
  const bogusQuoteText = bogusQuote.result?.content?.[0]?.text || '';
  check('quote with undeclared "bogus" arg: rejected as tool error', bogusQuote.result?.isError === true, bogusQuoteText.slice(0, 100));
  check('quote with undeclared "bogus" arg: refusal names the key', /bogus/.test(bogusQuoteText));
  check('quote with undeclared "bogus" arg: tool did not execute (no quote result)', !/amountOut/.test(bogusQuoteText) && !/^quote:/.test(bogusQuoteText));

  const bogusInspect = await rpc('tools/call', { name: 'inspect_token', arguments: { mint: AGTR, bogus: 1 } });
  const bogusInspectText = bogusInspect.result?.content?.[0]?.text || '';
  check('inspect_token with undeclared "bogus" arg: rejected as tool error', bogusInspect.result?.isError === true, bogusInspectText.slice(0, 100));
  check('inspect_token with undeclared "bogus" arg: refusal names the key', /bogus/.test(bogusInspectText));
  check('inspect_token with undeclared "bogus" arg: tool did not execute (no structured token)', bogusInspect.result?.structuredContent?.token === undefined);

  // 6. static guard on the server source
  const src = fs.readFileSync(serverPath, 'utf8');
  for (const banned of ['sendRawTransaction', 'Keypair.fromSecretKey', 'signTransaction']) {
    check(`static guard: source has no "${banned}"`, !src.includes(banned));
  }
} finally {
  child.kill();
}

// ---- 7. verify strictness (repair round 5, item 4) ----
// A second server instance pointed at a stub Solana RPC (SOLANA_RPC)
// whose getSignatureStatuses answers are keyed by the signature
// string, so every verification branch is exercised deterministically:
//   sig-processed → { confirmationStatus: 'processed', err: null }
//   sig-confirmed → { confirmationStatus: 'confirmed', err: null }
//   sig-failed    → { confirmationStatus: 'finalized', err: {...} }
//   sig-malformed → { slot } (no err field, no confirmationStatus)
// Only the confirmed one may report verified.
{
  const { createServer } = await import('node:http');
  const STATUSES = {
    'sig-processed': { slot: 101, confirmations: 0, err: null, confirmationStatus: 'processed' },
    'sig-confirmed': { slot: 102, confirmations: 12, err: null, confirmationStatus: 'confirmed' },
    'sig-failed': { slot: 103, confirmations: null, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' },
    'sig-malformed': { slot: 104 },
  };
  const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* keep {} */ }
      const replyJson = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (parsed.method === 'getSignatureStatuses') {
        const sig = parsed.params?.[0]?.[0];
        return replyJson({ jsonrpc: '2.0', id: parsed.id, result: { context: { slot: 1 }, value: [STATUSES[sig] ?? null] } });
      }
      if (parsed.method === 'getTransaction') {
        return replyJson({ jsonrpc: '2.0', id: parsed.id, result: null });
      }
      return replyJson({ jsonrpc: '2.0', id: parsed.id, error: { code: -32601, message: 'stub: unhandled' } });
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  const child2 = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, SOLANA_RPC: stubUrl },
  });
  let buffer2 = '';
  const pending2 = new Map();
  let nextId2 = 1;
  child2.stdout.on('data', (chunk) => {
    buffer2 += chunk.toString();
    let i;
    while ((i = buffer2.indexOf('\n')) >= 0) {
      const line = buffer2.slice(0, i).trim();
      buffer2 = buffer2.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending2.has(msg.id)) { pending2.get(msg.id)(msg); pending2.delete(msg.id); }
    }
  });
  const rpc2 = (method, params) => new Promise((resolve, reject) => {
    const id = nextId2++;
    pending2.set(id, resolve);
    child2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending2.has(id)) { pending2.delete(id); reject(new Error(`timeout waiting for ${method}`)); } }, 30000);
  });
  try {
    await rpc2('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contract-test-verify', version: '0' } });
    child2.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const verify = async (sig) => rpc2('tools/call', { name: 'verify', arguments: { signature: sig } });

    const processed = await verify('sig-processed');
    check('verify(processed, err null): NOT verified', processed.result?.structuredContent?.verified === false
      && /NOT VERIFIED/.test(processed.result?.content?.[0]?.text || ''),
      processed.result?.content?.[0]?.text?.slice(0, 110) || '');

    const confirmed = await verify('sig-confirmed');
    check('verify(confirmed, err null): verified', confirmed.result?.structuredContent?.verified === true
      && /VERIFIED/.test(confirmed.result?.content?.[0]?.text || ''),
      confirmed.result?.content?.[0]?.text?.slice(0, 110) || '');

    const failedTx = await verify('sig-failed');
    check('verify(finalized, err non-null): NOT verified', failedTx.result?.structuredContent?.verified === false
      && /NOT VERIFIED/.test(failedTx.result?.content?.[0]?.text || ''),
      failedTx.result?.content?.[0]?.text?.slice(0, 110) || '');

    const malformed = await verify('sig-malformed');
    check('verify(malformed status entry): NOT verified', malformed.result?.structuredContent?.verified === false
      && /NOT VERIFIED/.test(malformed.result?.content?.[0]?.text || ''),
      malformed.result?.content?.[0]?.text?.slice(0, 110) || '');
  } finally {
    child2.kill();
    stub.close();
  }
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

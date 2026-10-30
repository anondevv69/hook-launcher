#!/usr/bin/env node
// Verify the PUBLISHED AgentOnly tools release against the manifest the
// site serves: hashes, the MCP's exact seven-tool read/prepare-only
// registry (incl. closed schemas and unknown-argument rejection), and the
// runtime tarball's expected file set. Read-only against the live site;
// the MCP under test is the fetched artifact itself, spawned locally.
//
// Usage: node scripts/verify-release.mjs [baseUrl]   (default https://agentonly.fun)
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.argv[2] || 'https://agentonly.fun').replace(/\/+$/, '');
const failures = [];
const fail = (m) => { failures.push(m); console.log('  FAIL', m); };
const ok = (m) => console.log('  ok  ', m);

const get = async (path) => {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r;
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

console.log(`Verifying the published release at ${BASE}`);
const manifest = await (await get('/downloads/release.json')).json();
console.log(`  manifest: agentonly-tools v${manifest.version} from ${String(manifest.sourceCommit).slice(0, 10)}`);

const fetched = {};
for (const a of manifest.artifacts) {
  const buf = Buffer.from(await (await get(a.path || ('/downloads/' + a.file))).arrayBuffer());
  fetched[a.file] = buf;
  if (sha256(buf) === a.sha256 && buf.length === a.bytes) ok(`${a.file} hash + size match the manifest`);
  else fail(`${a.file}: published bytes do not match release.json (sha/size)`);
}

// --- MCP: exact registry, closed schemas, boundary -------------------------
const EXPECTED_TOOLS = ['inspect_token', 'list_events', 'quote', 'eligibility', 'build', 'simulate', 'verify'];
const tmp = mkdtempSync(join(tmpdir(), 'aonly-verify-'));
const mcpPath = join(tmp, 'agentonly-mcp.mjs');
writeFileSync(mcpPath, fetched['agentonly-mcp.mjs']);

function mcpSession(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [mcpPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => {
      resolve(out.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }));
    });
    for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
    child.stdin.end();
    setTimeout(() => child.kill(), 30000).unref();
  });
}

const replies = await mcpSession([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'verify-release', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'definitely_not_a_tool', arguments: {} } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'quote', arguments: { mint: 'Hfk7uqxZ3fFB4TpAzSKYGCJ3uuAJ1E1fk6i6vSn3FVXR', side: 'buy', amount: 0.01, bogus: 1 } } },
]);
const byId = Object.fromEntries(replies.filter(Boolean).map((r) => [r.id, r]));
const tools = byId[2]?.result?.tools ?? [];
const names = tools.map((t) => t.name).sort();
if (JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort())) ok('MCP registry is exactly the seven read/prepare tools');
else fail(`MCP tool registry mismatch: got [${names.join(', ')}]`);
if (tools.length && tools.every((t) => t.inputSchema?.additionalProperties === false)) ok('all seven MCP schemas are closed (additionalProperties: false)');
else fail('some MCP tool schema is not closed');
if (byId[3] && (byId[3].error || byId[3].result?.isError)) ok('unknown tool is rejected');
else fail('unknown tool was NOT rejected');
if (byId[4] && (byId[4].error || byId[4].result?.isError)) ok('unknown argument is rejected before dispatch');
else fail('unknown argument was NOT rejected');

const mcpText = fetched['agentonly-mcp.mjs'].toString('utf8');
for (const bad of ['sendRawTransaction', 'Keypair.fromSecretKey', 'signTransaction', 'transfer']) {
  if (mcpText.includes(bad)) fail(`MCP artifact contains forbidden capability string: ${bad}`);
}
ok('MCP artifact carries no sign/broadcast/transfer capability strings (beyond any flagged above)');

// --- Runtime tarball: expected file set + version ---------------------------
const { execFileSync } = await import('node:child_process');
const tarPath = join(tmp, 'agentonly-runtime.tar.gz');
writeFileSync(tarPath, fetched['agentonly-runtime.tar.gz']);
const listing = execFileSync('tar', ['-tzf', tarPath]).toString();
for (const want of ['src/runtime.mjs', 'src/cli.mjs', 'bin/agentonly-runtime', 'test/fixtures.mjs', 'package.json', 'package-lock.json', 'README.md']) {
  if (listing.split('\n').some((l) => l.endsWith(want))) ok(`runtime tarball contains ${want}`);
  else fail(`runtime tarball is missing ${want}`);
}
if (/keypair|secret|\.key($|\/)/i.test(listing)) fail('runtime tarball appears to contain key material');
const pkgJson = execFileSync('tar', ['-xzOf', tarPath, 'package.json']).toString();
if (JSON.parse(pkgJson).version === manifest.version) ok('runtime package version matches the manifest');
else fail('runtime package version does not match release.json');

console.log(failures.length ? `\n${failures.length} release verification failure(s)` : '\nRelease verification passed');
process.exit(failures.length ? 1 : 0);

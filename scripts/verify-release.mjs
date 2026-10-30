#!/usr/bin/env node
// Verify the PUBLISHED AgentOnly tools release, in trust order:
//
//   1. Fetch release.json + release.json.sig (data only — nothing runs).
//   2. Authenticate the manifest: Ed25519-verify the signature over
//      'sha256:' + sha256hex(release.json bytes) against the release
//      public key PINNED IN THIS REPO (scripts/release.pubkey). A hash
//      compared against a hash from the same download is NOT
//      authentication; the signature against the pinned key is.
//   3. Only then fetch the artifacts and check their SHA-256 + size
//      against the authenticated manifest.
//   4. When run inside a checkout of this repo, rebuild the release from
//      the checked-out sources and require the artifact hashes to match
//      the manifest, and the manifest's sourceCommit to name HEAD
//      (--allow-commit-drift downgrades the commit check to a warning,
//      for pre-merge branch states).
//   5. Only after 2–4 pass may the fetched MCP be spawned, to assert the
//      exact seven-tool read/prepare registry, closed schemas, and
//      unknown tool/argument rejection.
//
// Usage: node scripts/verify-release.mjs [baseUrl] [--allow-commit-drift] [--skip-rebuild]
import { spawn, execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const BASE = (args.find((a) => a.startsWith('http')) || 'https://agentonly.fun').replace(/\/+$/, '');
const ALLOW_DRIFT = args.includes('--allow-commit-drift');
const SKIP_REBUILD = args.includes('--skip-rebuild');
const failures = [];
const fail = (m) => { failures.push(m); console.log('  FAIL', m); };
const ok = (m) => console.log('  ok  ', m);
const warn = (m) => console.log('  warn', m);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s) {
  const bytes = [0];
  for (const ch of s.trim()) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`bad base58 char ${ch}`);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes.reverse())]);
}

const getBuf = async (path) => {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

console.log(`Verifying the published release at ${BASE}`);

// --- 1+2: authenticate the manifest against the pinned key -----------------
const scriptDir = dirname(fileURLToPath(import.meta.url));
const pinned = readFileSync(join(scriptDir, 'release.pubkey'), 'utf8').trim();
console.log(`  pinned release signer: ${pinned}`);
const manifestBytes = await getBuf('/downloads/release.json');
const sigDoc = JSON.parse((await getBuf('/downloads/release.json.sig')).toString('utf8'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
console.log(`  manifest: agentonly-tools v${manifest.version} from ${String(manifest.sourceCommit).slice(0, 10)}`);

const expectedMessage = 'sha256:' + sha256(manifestBytes);
let sigOk = false;
try {
  if (sigDoc.signer !== pinned) throw new Error(`signer ${sigDoc.signer} != pinned key`);
  if (sigDoc.message !== expectedMessage) throw new Error('signature does not bind these manifest bytes');
  const pub = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), base58Decode(pinned)]),
    format: 'der', type: 'spki',
  });
  sigOk = cryptoVerify(null, Buffer.from(sigDoc.message, 'utf8'), pub, Buffer.from(sigDoc.signature, 'base64'));
} catch (e) { fail(`manifest signature check errored: ${e.message}`); }
if (sigOk) ok('manifest signature verifies against the pinned release key');
else fail('manifest signature does NOT verify against the pinned release key — refusing to fetch or execute artifacts');
if (!sigOk) { console.log('\nAborted: unauthenticated manifest.'); process.exit(1); }

// --- 3: artifact hashes against the authenticated manifest ------------------
const fetched = {};
for (const a of manifest.artifacts) {
  const buf = await getBuf(a.path || ('/downloads/' + a.file));
  fetched[a.file] = buf;
  if (sha256(buf) === a.sha256 && buf.length === a.bytes) ok(`${a.file} hash + size match the authenticated manifest`);
  else fail(`${a.file}: published bytes do not match release.json (sha/size)`);
}
if (failures.length) { console.log('\nAborted: artifact mismatch.'); process.exit(1); }

// --- 4: rebuild from the checkout and compare --------------------------------
const repoRoot = join(scriptDir, '..');
if (!SKIP_REBUILD && existsSync(join(repoRoot, 'runtime', 'package.json')) && existsSync(join(repoRoot, 'mcp', 'agentonly-mcp.mjs'))) {
  const outDir = mkdtempSync(join(tmpdir(), 'aonly-rebuild-'));
  execFileSync('node', [join(scriptDir, 'build-release.mjs')], {
    cwd: repoRoot, env: { ...process.env, AONLY_DIST: outDir }, stdio: 'pipe',
  });
  const rebuilt = JSON.parse(readFileSync(join(outDir, 'release.json'), 'utf8'));
  for (const a of manifest.artifacts) {
    const r = rebuilt.artifacts.find((x) => x.file === a.file);
    if (r && r.sha256 === a.sha256) ok(`rebuild from checkout reproduces ${a.file} exactly`);
    else fail(`rebuild from checkout does NOT reproduce ${a.file} (published bytes != repo sources)`);
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();
  if (manifest.sourceCommit === head) ok('manifest sourceCommit is this checkout\'s HEAD');
  else if (ALLOW_DRIFT) warn(`manifest sourceCommit ${String(manifest.sourceCommit).slice(0, 10)} != HEAD ${head.slice(0, 10)} (allowed pre-merge; republish from the merged commit)`);
  else fail(`manifest sourceCommit ${manifest.sourceCommit} does not resolve to this checkout's HEAD (${head})`);
} else {
  warn('rebuild comparison skipped (no repo checkout or --skip-rebuild)');
}
if (failures.length) { console.log('\nAborted: provenance mismatch — MCP will not be executed.'); process.exit(1); }

// --- 5: MCP boundary, executed only now ---------------------------------------
const EXPECTED_TOOLS = ['inspect_token', 'list_events', 'quote', 'eligibility', 'build', 'simulate', 'verify'];
const tmp = mkdtempSync(join(tmpdir(), 'aonly-verify-'));
const mcpPath = join(tmp, 'agentonly-mcp.mjs');
writeFileSync(mcpPath, fetched['agentonly-mcp.mjs']);

const mcpText = fetched['agentonly-mcp.mjs'].toString('utf8');
for (const bad of ['sendRawTransaction', 'Keypair.fromSecretKey', 'signTransaction', 'transfer']) {
  if (mcpText.includes(bad)) fail(`MCP artifact contains forbidden capability string: ${bad}`);
}
ok('MCP artifact carries no sign/broadcast/transfer capability strings (beyond any flagged above)');

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

// --- runtime tarball: expected file set + version ------------------------------
const tarPath = join(tmp, 'agentonly-runtime.tar.gz');
writeFileSync(tarPath, fetched['agentonly-runtime.tar.gz']);
const listing = execFileSync('tar', ['-tzf', tarPath]).toString();
for (const want of ['src/runtime.mjs', 'src/cli.mjs', 'src/intent.mjs', 'bin/agentonly-runtime', 'test/fixtures.mjs', 'package.json', 'package-lock.json', 'README.md']) {
  if (listing.split('\n').some((l) => l.endsWith(want))) ok(`runtime tarball contains ${want}`);
  else fail(`runtime tarball is missing ${want}`);
}
if (/keypair|secret|\.key($|\/)/i.test(listing)) fail('runtime tarball appears to contain key material');
const pkgJson = execFileSync('tar', ['-xzOf', tarPath, 'package.json']).toString();
if (JSON.parse(pkgJson).version === manifest.version) ok('runtime package version matches the manifest');
else fail('runtime package version does not match release.json');

console.log(failures.length ? `\n${failures.length} release verification failure(s)` : '\nRelease verification passed');
process.exit(failures.length ? 1 : 0);

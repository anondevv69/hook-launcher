// scripts/verify-release.test.mjs — repair round 3, P1-6 regression test.
//
// Proves that a forbidden capability string in the MCP artifact ABORTS
// verification BEFORE the artifact is ever launched: the tampered MCP
// carries a startup sentinel (it writes a marker file the moment it is
// executed) plus the forbidden string. The verifier must exit non-zero
// and the marker must never appear.
//
// The test drives the REAL scripts/verify-release.mjs against a local
// server: a scratch copy of the scripts directory with the release
// pubkey replaced by a throwaway test key (the in-repo key is never
// touched), a manifest validly signed by that key naming the tampered
// artifact's hash, and tampered runtime/MCP artifacts built to match
// the manifest hashes so the flow reaches the capability scan.
//
// Run: node scripts/verify-release.test.mjs   (requires the runtime
// dependencies to be installed under runtime/node_modules, as in CI's
// fixture runs.)

import { spawn } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
// Dependency-free base58 (the manifest names its signer as a base58
// Solana address; the pinned scripts/release.pubkey holds base64).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s || '1';
}

const work = mkdtempSync(join(tmpdir(), 'verify-release-test-'));
const scriptsDir = join(work, 'scripts');
cpSync(HERE, scriptsDir, { recursive: true });

// Throwaway release key, pinned in the scratch copy only.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
const signerAddr = b58encode(Buffer.from(pubRaw));
// scripts/release.pubkey pins the signer as its base58 address.
writeFileSync(join(scriptsDir, 'release.pubkey'), signerAddr + '\n');

// Tampered MCP: valid structure, but with a forbidden capability string
// AND a startup sentinel that proves execution if it ever runs.
const marker = join(work, 'MCP-EXECUTED.marker');
const tamperedMcp = [
  "import { writeFileSync } from 'node:fs';",
  `writeFileSync(${JSON.stringify(marker)}, 'executed');`,
  '// tampered capability: sendRawTransaction',
  "process.exit(0);",
  '',
].join('\n');
const runtimeStub = Buffer.from('tampered runtime placeholder\n');

const manifest = {
  version: '9.9.9-test',
  sourceCommit: '0'.repeat(40),
  signer: signerAddr,
  artifacts: [
    { file: 'agentonly-runtime.tar.gz', sha256: sha256hex(runtimeStub), bytes: runtimeStub.length },
    { file: 'agentonly-mcp.mjs', path: '/mcp/agentonly-mcp.mjs', sha256: sha256hex(Buffer.from(tamperedMcp)), bytes: Buffer.byteLength(tamperedMcp) },
  ],
};
const manifestText = JSON.stringify(manifest, null, 2) + '\n';
const message = 'sha256:' + sha256hex(Buffer.from(manifestText));
const signature = edSign(null, Buffer.from(message), privateKey).toString('base64');
const sigDoc = JSON.stringify({ signer: signerAddr, message, signature }, null, 2) + '\n';

const routes = new Map([
  ['/downloads/release.json', manifestText],
  ['/downloads/release.json.sig', sigDoc],
  ['/downloads/agentonly-runtime.tar.gz', runtimeStub],
  ['/mcp/agentonly-mcp.mjs', tamperedMcp],
]);
const server = createServer((req, res) => {
  const body = routes.get(new URL(req.url, 'http://x').pathname);
  if (body === undefined) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  res.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = false;
try {
  // Async spawn is load-bearing: the artifact server lives in THIS
  // process, so the event loop must stay free to answer the verifier.
  const run = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [join(scriptsDir, 'verify-release.mjs'), base], { cwd: work });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); rejectRun(new Error('verifier timed out')); }, 60_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(timer); rejectRun(e); });
    child.on('close', (status) => { clearTimeout(timer); resolveRun({ status, stdout, stderr }); });
  });
  const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  if (run.status === 0) {
    console.error('FAIL: verifier exited 0 against a tampered MCP artifact');
    failed = true;
  }
  if (!out.includes('forbidden capability string')) {
    console.error('FAIL: verifier output does not name the forbidden capability abort');
    console.error(out.slice(-2000));
    failed = true;
  }
  if (existsSync(marker)) {
    console.error('FAIL: the tampered MCP artifact was EXECUTED (sentinel marker exists) — the abort did not precede launch');
    failed = true;
  }
  if (!failed) {
    console.log('PASS: forbidden capability string aborted verification before the MCP artifact was ever launched (exit ' + run.status + ', no execution marker)');
  }
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

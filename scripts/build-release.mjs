#!/usr/bin/env node
// Build the AgentOnly tools release from the sources tracked in THIS repo
// (runtime/ and mcp/), deterministically, and emit the release manifest.
//
// Outputs (into dist/ at the repo root, or $AONLY_DIST):
//   agentonly-runtime.tar.gz  — byte-reproducible (sorted entries, fixed
//                               mtime/owners, gzip with a zeroed timestamp)
//   agentonly-mcp.mjs         — the single-file MCP server
//   release.json              — { product, version, sourceCommit, builtAt,
//                                 artifacts: [{file, path, sha256, bytes}] }
//   SHA256SUMS                — sha256sum-format lines for both artifacts
//
// The release signature (release.json.sig) is produced separately by the
// release signer over the SHA-256 of release.json; this script never holds
// a key. No shell is used anywhere in this build.
//
// Usage: node scripts/build-release.mjs
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.AONLY_DIST || join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const runtimePkg = JSON.parse(readFileSync(join(root, 'runtime', 'package.json'), 'utf8'));
const version = runtimePkg.version;
if (!version) throw new Error('runtime/package.json has no version');

// Deterministic tarball of the runtime source (same file set that is
// published on agentonly.fun): bin, src, test, README, package files.
// Plain tar via argv (no shell), then gzip with a zeroed header timestamp.
const tarPath = join(dist, 'agentonly-runtime.tar');
execFileSync('tar', [
  '--sort=name', '--mtime=UTC 2020-01-01', '--owner=0', '--group=0', '--numeric-owner',
  '-cf', tarPath, 'bin', 'src', 'test', 'README.md', 'package.json', 'package-lock.json', '.gitignore',
], { cwd: join(root, 'runtime') });
writeFileSync(join(dist, 'agentonly-runtime.tar.gz'),
  gzipSync(readFileSync(tarPath), { level: 9, mtime: 0 }));
rmSync(tarPath);

copyFileSync(join(root, 'mcp', 'agentonly-mcp.mjs'), join(dist, 'agentonly-mcp.mjs'));

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const PUBLISHED_AT = {
  'agentonly-runtime.tar.gz': '/downloads/agentonly-runtime.tar.gz',
  'agentonly-mcp.mjs': '/mcp/agentonly-mcp.mjs',
};
const artifacts = Object.keys(PUBLISHED_AT).map((file) => ({
  file, path: PUBLISHED_AT[file], sha256: sha256(join(dist, file)), bytes: statSync(join(dist, file)).size,
}));

const manifest = {
  product: 'agentonly-tools',
  version,
  sourceCommit,
  builtAt: new Date().toISOString(),
  artifacts,
  notes: 'Built by scripts/build-release.mjs from the runtime/ and mcp/ sources at sourceCommit. ' +
    'release.json.sig is an Ed25519 signature over the hex SHA-256 of this file by the release signer ' +
    '(public key pinned in scripts/release.pubkey).',
};
writeFileSync(join(dist, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(dist, 'SHA256SUMS'), artifacts.map((a) => `${a.sha256}  ${a.file}`).join('\n') + '\n');
console.log(`release v${version} built from ${sourceCommit.slice(0, 10)}`);
for (const a of artifacts) console.log(`  ${a.file}  ${a.bytes} B  sha256 ${a.sha256}`);

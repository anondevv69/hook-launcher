#!/usr/bin/env node
// Build the AgentOnly tools release from the sources tracked in THIS repo
// (runtime/ and mcp/), deterministically, and emit the release manifest.
//
// Outputs (into dist/ at the repo root, or $AONLY_DIST):
//   agentonly-runtime.tar.gz  — byte-reproducible (sorted entries, fixed
//                               mtime/owners, canonical staged modes, gzip
//                               with a zeroed timestamp)
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
import {
  chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Clean-tree requirement (repair round 3, P1-7): the manifest names a
// sourceCommit, and that claim is only meaningful if the commit fully
// determines the built bytes. Building from a dirty tree would bind
// the release to a commit that does NOT contain the shipped sources.
// Refuse: commit the release inputs (runtime/, mcp/, scripts/) first,
// then build. Untracked files under dist/ (this build's own output
// directory) are the only exemption.
{
  const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString()
    .split('\n').filter(Boolean);
  const dirty = porcelain.filter((line) => {
    const p = line.slice(3).trim().replace(/^"|"$/g, '');
    return !p.startsWith('dist/');
  });
  if (dirty.length) {
    throw new Error(
      `refusing to build a release from a dirty working tree — the manifest's sourceCommit must fully determine the artifact bytes. Commit (or stash) these changes first:\n  ${dirty.join('\n  ')}`,
    );
  }
}

const dist = process.env.AONLY_DIST || join(root, 'dist');
// Output-path safety (repair round 4, P1-7a): the build begins by
// RECURSIVELY DELETING its output directory. Rounds 1–3 took that
// directory from $AONLY_DIST unchecked — an environment pointing at
// an arbitrary absolute path would be wiped before any build ran.
// The output must now resolve INSIDE the repository root (the
// default dist/ or a subpath of the root); anything else refuses
// before any deletion.
{
  const resolvedDist = resolve(dist);
  const resolvedRoot = resolve(root);
  if (resolvedDist !== resolvedRoot && !resolvedDist.startsWith(resolvedRoot + sep)) {
    throw new Error(
      `refusing to build: AONLY_DIST (${resolvedDist}) must resolve inside the repository root (${resolvedRoot}) — the build recursively deletes its output directory first, and an arbitrary path is never a safe deletion target`,
    );
  }
}
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const runtimePkg = JSON.parse(readFileSync(join(root, 'runtime', 'package.json'), 'utf8'));
const version = runtimePkg.version;
if (!version) throw new Error('runtime/package.json has no version');

// Deterministic tarball of the runtime source (same file set that is
// published on agentonly.fun): bin, src, test, README, package files.
// Plain tar via argv (no shell), then gzip with a zeroed header timestamp.
//
// Repair round 3.1: the tar entries' MODES must also be canonical, not
// just mtime/owner/sort order. Tar records the working tree's modes, and
// those depend on the build machine's umask (this VM produces 660/770;
// a fresh git checkout is 644/755) — so a tarball built here could not
// be reproduced from a checkout anywhere else, and CI's rebuild check
// failed on mode bytes alone (file CONTENT was always identical).
// Adding bits is not enough (`tar --mode='a+rX'` maps 660->664,
// 770->777), so the file set is staged into a fresh directory, every
// staged entry is given its exact canonical mode (dirs 0755, files
// 0644, the CLI entrypoint 0755), and the tar is built from staging.
const RUNTIME_ENTRIES = ['bin', 'src', 'test', 'README.md', 'package.json', 'package-lock.json', '.gitignore'];
// Tracked-file manifest (repair round 4, P1-3): the staged file set
// is enumerated from `git ls-files` — the files Git tracks under
// runtime/ — never by copying the working tree. Rounds 1–3 copied
// directories recursively, so a git-IGNORED local file (a keypair, an
// approval artifact — runtime/.gitignore names exactly those
// patterns) sitting under runtime/src/ or runtime/test/ would have
// been staged into the published tarball. The clean-tree gate does
// not save that case: ignored files never appear in porcelain. Now
// only tracked files can enter the stage, and every RUNTIME_ENTRIES
// member must contribute at least one tracked file or the build
// refuses (a renamed/missing input is a build error, not a smaller
// tarball).
const trackedRuntime = execFileSync('git', ['ls-files', '-z', '--', 'runtime'], { cwd: root })
  .toString().split('\0').filter(Boolean)
  .map((p) => p.slice('runtime/'.length))
  .filter((rel) => RUNTIME_ENTRIES.some((e) => rel === e || rel.startsWith(e + '/')));
for (const entry of RUNTIME_ENTRIES) {
  if (!trackedRuntime.some((rel) => rel === entry || rel.startsWith(entry + '/'))) {
    throw new Error(`tracked release set is missing runtime/${entry} — git ls-files names no file for it; refusing to build an incomplete tarball`);
  }
}
const stage = join(dist, '.runtime-stage');
mkdirSync(stage, { recursive: true });
for (const rel of trackedRuntime) {
  const dest = join(stage, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(root, 'runtime', rel), dest);
}
const ENTRYPOINT = join(stage, 'bin', 'agentonly-runtime');
const canonicalizeModes = (p) => {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return; // tar stores the link itself; none exist in runtime/ today
  if (st.isDirectory()) {
    chmodSync(p, 0o755);
    for (const name of readdirSync(p)) canonicalizeModes(join(p, name));
  } else {
    chmodSync(p, p === ENTRYPOINT ? 0o755 : 0o644);
  }
};
for (const entry of RUNTIME_ENTRIES) canonicalizeModes(join(stage, entry));
const tarPath = join(dist, 'agentonly-runtime.tar');
execFileSync('tar', [
  '--sort=name', '--mtime=UTC 2020-01-01', '--owner=0', '--group=0', '--numeric-owner',
  '-cf', tarPath, ...RUNTIME_ENTRIES,
], { cwd: stage });
writeFileSync(join(dist, 'agentonly-runtime.tar.gz'),
  gzipSync(readFileSync(tarPath), { level: 9, mtime: 0 }));
rmSync(tarPath);
rmSync(stage, { recursive: true, force: true });

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

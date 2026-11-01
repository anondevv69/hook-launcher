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
  chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Canonical (symlink-resolved) form of a path (repair round 5,
// P0-2): realpath the nearest EXISTING ancestor, then re-append the
// remaining components lexically, so a not-yet-created output
// directory still canonicalizes through its real parents. The
// round-4 containment test compared purely lexical resolve() output,
// which a symlinked parent defeats entirely.
function canonicalPath(p) {
  const abs = resolve(p);
  const suffix = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return suffix.length ? join(real, ...suffix.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      suffix.push(cur.slice(parent.length + 1));
      cur = parent;
    }
  }
}
const canonicalRoot = canonicalPath(root);

// Tracked-source symlink scan (repair round 5, item 1): staging
// copies tracked files with copyFileSync, which FOLLOWS symlinks —
// a tracked symlink under runtime/ (or at the MCP source path) would
// package its target's host bytes into the published artifacts.
// Every tracked release source is lstat-checked; a symlink refuses
// the build, naming the file. Runs BEFORE the clean-tree gate on
// purpose: `git ls-files` reads the index, so a staged-but-
// uncommitted symlink is refused by this check, not waved past it.
{
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
    .toString().split('\0').filter(Boolean);
  for (const rel of tracked) {
    if (!(rel.startsWith('runtime/') || rel === 'mcp/agentonly-mcp.mjs')) continue;
    if (lstatSync(join(root, rel)).isSymbolicLink()) {
      throw new Error(
        `refusing to build: tracked release source ${rel} is a symlink — staging copies file bytes through symlinks, so the release would package the link target's host bytes instead of repository content. Replace the symlink with a regular file (or remove it from the index) and build again.`,
      );
    }
  }
}

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
// Output-path safety (repair round 4, P1-7a; hardened in repair
// round 5, P0-2): the build begins by RECURSIVELY DELETING its
// output directory. Rounds 1–3 took that directory from $AONLY_DIST
// unchecked — an environment pointing at an arbitrary absolute path
// would be wiped before any build ran. Round 4 required the path to
// resolve lexically inside the repo root — but lexical resolution
// is not containment: the repo root ITSELF passed as "inside", and
// a symlinked parent inside the repo pointing outside passed too,
// while rmSync would have deleted through both. Now:
//   * root and candidate are canonicalized with realpath (every
//     existing component's symlinks resolved);
//   * the target must be a STRICT subdirectory confined to the
//     repo's dist/ tree (the default <root>/dist or a directory
//     under it) — the root itself and everything outside dist/
//     refuses;
//   * the final component must not itself be a symlink;
//   * before any deletion, an existing target must look like a
//     build output directory: no .git entry, and nothing in it but
//     known release artifact names — anything else refuses.
const KNOWN_RELEASE_ARTIFACTS = new Set([
  'agentonly-runtime.tar.gz',
  'agentonly-mcp.mjs',
  'release.json',
  'release.json.sig',
  'SHA256SUMS',
  '.runtime-stage',
]);
{
  const canonicalDist = canonicalPath(dist);
  const canonicalDistBase = join(canonicalRoot, 'dist');
  if (canonicalDist !== canonicalDistBase && !canonicalDist.startsWith(canonicalDistBase + sep)) {
    throw new Error(
      `refusing to build: AONLY_DIST (${dist}) must be the repository's dist directory or a directory under it — its canonical path (${canonicalDist}) escapes ${canonicalDistBase}. The build recursively deletes its output directory first; the repository root itself and any path outside dist/ are never safe deletion targets.`,
    );
  }
  let lst = null;
  try { lst = lstatSync(dist); } catch { /* nonexistent: a fresh output directory */ }
  if (lst?.isSymbolicLink()) {
    throw new Error(
      `refusing to build: AONLY_DIST (${dist}) is itself a symlink — the build never deletes through a link. Remove the link and build again.`,
    );
  }
  if (lst && !lst.isDirectory()) {
    throw new Error(`refusing to build: AONLY_DIST (${dist}) exists and is not a directory`);
  }
  if (lst) {
    const entries = readdirSync(dist);
    if (entries.includes('.git')) {
      throw new Error(
        `refusing to build: AONLY_DIST (${dist}) contains a .git entry — it looks like a repository checkout, not a build output directory, and the build would delete it.`,
      );
    }
    const foreign = entries.filter((e) => !KNOWN_RELEASE_ARTIFACTS.has(e));
    if (foreign.length) {
      throw new Error(
        `refusing to build: AONLY_DIST (${dist}) contains entries that are not known release artifacts (${foreign.join(', ')}) — the build recursively deletes its output directory first, and this directory does not look like a previous build's output. Move its contents elsewhere if they matter.`,
      );
    }
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

// scripts/build-release.test.mjs — repair round 3.1 regression test.
//
// Proves the release tarball is reproducible regardless of the working
// tree's file modes: build once, record the tarball sha256, chmod the
// runtime tree to a DIFFERENT mode set (files 0600, dirs 0700, the CLI
// entrypoint 0700 — vs this VM's usual 660/770 and a fresh checkout's
// 644/755), build again, and require byte-identical tarballs carrying
// only the canonical modes (dirs 0755, files 0644, entrypoint 0755).
//
// Before the round-3.1 fix, scripts/build-release.mjs tarred the
// working tree directly, so tar recorded whatever modes the build
// machine's umask produced: the same sources built at 660/770 and at
// 600/700 yielded different sha256 (verified when this test was added:
// c218c422… vs 36d531be…, content diff-clean). This test FAILS against
// that build and passes against the staging build.
//
// The original modes are restored afterwards (permission bits; the
// repo tree is left exactly as found). Run: node scripts/build-release.test.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RUNTIME = join(ROOT, 'runtime');
const BUILD = join(HERE, 'build-release.mjs');
const ENTRYPOINT = join(RUNTIME, 'bin', 'agentonly-runtime');
const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

let failed = false;
const fail = (m) => { console.error('FAIL:', m); failed = true; };

// Every dir/file under runtime/, with its permission bits.
function walk(p, out = []) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return out;
  out.push({ path: p, mode: st.mode & 0o777, dir: st.isDirectory() });
  if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name), out);
  return out;
}

function buildTo(outDir) {
  execFileSync(process.execPath, [BUILD], {
    cwd: ROOT, env: { ...process.env, AONLY_DIST: outDir }, stdio: 'pipe',
  });
  return sha256hex(readFileSync(join(outDir, 'agentonly-runtime.tar.gz')));
}

// The scratch tree lives under the repo's dist/ (repair round 4,
// P1-7a): build-release.mjs refuses any AONLY_DIST outside the
// repository root, since it recursively deletes the directory it is
// given. dist/ is exempt from the build's clean-tree gate.
mkdirSync(join(ROOT, 'dist'), { recursive: true });
const work = mkdtempSync(join(ROOT, 'dist', 'build-test-'));

// ---------------------------------------------------------------------------
// Repair round 4, P1-3 regression: an ignored secret-named file planted
// under runtime/src must NOT enter the tarball (the build stages from
// the git-tracked file manifest), and every tracked runtime file MUST
// be present. The planted name matches runtime/.gitignore's
// *.keypair.json pattern, so it is invisible to the clean-tree gate —
// exactly the leak the tracked-file build closes.
// ---------------------------------------------------------------------------
{
  const planted = join(RUNTIME, 'src', 'planted-secret.keypair.json');
  writeFileSync(planted, 'planted by build-release.test — must never ship\n');
  try {
    buildTo(join(work, 'out-planted'));
    const listing = execFileSync('tar', ['-tzf', join(work, 'out-planted', 'agentonly-runtime.tar.gz')]).toString();
    if (listing.includes('planted-secret')) {
      fail('an ignored planted file under runtime/src entered the release tarball — the build is copying the working tree, not the tracked file set');
    } else {
      console.log('ok: planted ignored file under runtime/src is absent from the tarball');
    }
    const tracked = execFileSync('git', ['ls-files', '--', 'runtime'], { cwd: ROOT }).toString()
      .split('\n').filter(Boolean).map((p) => p.slice('runtime/'.length));
    const entries = listing.split('\n').filter(Boolean);
    for (const rel of tracked) {
      if (!entries.includes(rel)) fail(`git-tracked runtime file ${rel} is missing from the tarball`);
    }
    console.log(`ok: all ${tracked.length} git-tracked runtime files are present in the tarball`);
    // P1-7a: an AONLY_DIST outside the repo root refuses before any
    // deletion — the outside path must not be created or emptied.
    const evilDist = '/tmp/aonly-evil-dist-round4-test';
    rmSync(evilDist, { recursive: true, force: true });
    let refused = false;
    try {
      execFileSync(process.execPath, [BUILD], {
        cwd: ROOT, env: { ...process.env, AONLY_DIST: evilDist }, stdio: 'pipe',
      });
    } catch { refused = true; }
    if (!refused) fail('build accepted an AONLY_DIST outside the repository root');
    else if (existsSync(evilDist)) fail('build touched the outside AONLY_DIST path despite refusing');
    else console.log('ok: AONLY_DIST outside the repository root refuses before any deletion');
  } finally {
    rmSync(planted, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Repair round 5 regressions.
// P0-2 (AONLY_DIST hardening): the repo root itself, a symlinked path
// escaping dist/, an occupied non-artifact directory, and a
// .git-containing directory must ALL refuse before any deletion,
// with the would-be victims intact. (Round 4's lexical test let the
// root and the symlinked parent through — these cases are only run
// against the hardened build.)
// Item 1 (tracked symlink sources): a symlink staged into the index
// under runtime/ must refuse the build, naming the file, before any
// staging copies its target's bytes.
// ---------------------------------------------------------------------------
{
  const buildRefusal = (outDir) => {
    try {
      execFileSync(process.execPath, [BUILD], {
        cwd: ROOT, env: { ...process.env, AONLY_DIST: outDir }, stdio: 'pipe',
      });
      return null;
    } catch (e) {
      return `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
  };

  // (a) AONLY_DIST = the repository root itself.
  {
    const out = buildRefusal(ROOT);
    if (!out) fail('build accepted AONLY_DIST=<repo root> — it would recursively delete the repository');
    else if (!existsSync(join(ROOT, 'scripts', 'build-release.mjs'))) fail('AONLY_DIST=<repo root> refusal came too late: the tree was damaged');
    else console.log('ok: AONLY_DIST=<repo root> refuses, tree intact');
  }

  // (b) AONLY_DIST through a symlink planted inside dist/ pointing outside.
  {
    const victim = mkdtempSync(join('/tmp', 'aonly-dist-victim-'));
    const sentinel = join(victim, 'keep.txt');
    writeFileSync(sentinel, 'outside the repo — must survive\n');
    const link = join(ROOT, 'dist', 'escape-link');
    rmSync(link, { force: true });
    symlinkSync(victim, link);
    try {
      const out = buildRefusal(link);
      if (!out) fail('build accepted an AONLY_DIST escaping dist/ through a planted symlink');
      else if (readFileSync(sentinel, 'utf8') !== 'outside the repo — must survive\n') fail('symlinked AONLY_DIST refusal came too late: the outside directory was damaged');
      else console.log('ok: AONLY_DIST through a symlink inside dist/ refuses, outside dir intact');
    } finally {
      rmSync(link, { force: true });
      rmSync(victim, { recursive: true, force: true });
    }
  }

  // (c) AONLY_DIST = an existing dist/ subdirectory holding a foreign file.
  {
    const occupied = join(work, 'occupied');
    mkdirSync(occupied, { recursive: true });
    const foreign = join(occupied, 'important.txt');
    writeFileSync(foreign, 'not a release artifact\n');
    const out = buildRefusal(occupied);
    if (!out) fail('build accepted an occupied AONLY_DIST with a foreign file — it would delete it');
    else if (!existsSync(foreign)) fail('occupied AONLY_DIST refusal came too late: the foreign file was deleted');
    else console.log('ok: occupied AONLY_DIST with a foreign file refuses, file intact');
  }

  // (d) AONLY_DIST containing a .git entry.
  {
    const withGit = join(work, 'with-git');
    mkdirSync(join(withGit, '.git'), { recursive: true });
    const out = buildRefusal(withGit);
    if (!out) fail('build accepted an AONLY_DIST containing .git');
    else if (!existsSync(join(withGit, '.git'))) fail('.git AONLY_DIST refusal came too late: .git was deleted');
    else console.log('ok: AONLY_DIST containing .git refuses, intact');
  }

  // (e) Tracked symlink source under runtime/.
  {
    const outsideFile = join(work, 'outside-source.txt');
    writeFileSync(outsideFile, 'host bytes that must never ship\n');
    const linkRel = 'runtime/src/planted-link.mjs';
    const linkAbs = join(ROOT, linkRel);
    rmSync(linkAbs, { force: true });
    symlinkSync(outsideFile, linkAbs);
    try {
      execFileSync('git', ['add', '--', linkRel], { cwd: ROOT, stdio: 'pipe' });
      const out = buildRefusal(join(work, 'out-symlink'));
      if (!out) fail('build accepted a tracked symlink under runtime/src — staging would package its target');
      else if (!out.includes('planted-link')) fail(`tracked-symlink refusal did not name the file (got: ${out.split('\n')[0]})`);
      else if (readFileSync(outsideFile, 'utf8') !== 'host bytes that must never ship\n') fail('tracked-symlink test damaged its outside target');
      else console.log('ok: tracked symlink under runtime/src refuses the build and names the file');
    } finally {
      try { execFileSync('git', ['reset', '-q', '--', linkRel], { cwd: ROOT, stdio: 'pipe' }); } catch { /* best effort */ }
      rmSync(linkAbs, { force: true });
    }
  }
}

const original = walk(RUNTIME);
try {
  const hashBefore = buildTo(join(work, 'out-before'));

  // Perturb every mode in the runtime tree.
  for (const e of original) chmodSync(e.path, e.dir ? 0o700 : 0o600);
  chmodSync(ENTRYPOINT, 0o700);

  const hashAfter = buildTo(join(work, 'out-after'));
  if (hashBefore !== hashAfter) {
    fail(`tarball sha256 changed when working-tree modes changed (${hashBefore} -> ${hashAfter}) — the build leaks umask modes into the artifact`);
  } else {
    console.log(`ok: tarball sha256 invariant under working-tree mode changes (${hashBefore})`);
  }

  // The published entries must carry exactly the canonical modes.
  const listing = execFileSync('tar', ['-tvzf', join(work, 'out-after', 'agentonly-runtime.tar.gz')]).toString();
  for (const line of listing.split('\n').filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    const mode = fields[0];
    const name = fields[fields.length - 1];
    const want = name.endsWith('/') ? 'drwxr-xr-x'
      : name === 'bin/agentonly-runtime' ? '-rwxr-xr-x' : '-rw-r--r--';
    if (mode !== want) fail(`tar entry ${name} has mode ${mode}, want ${want}`);
  }
  if (!failed) console.log('ok: every tar entry carries its canonical mode (dirs 0755, files 0644, entrypoint 0755)');
} finally {
  for (const e of original) {
    try { chmodSync(e.path, e.mode); } catch { /* best-effort restore */ }
  }
  rmSync(work, { recursive: true, force: true });
}

const restored = walk(RUNTIME);
for (let i = 0; i < original.length; i++) {
  if (restored[i].mode !== original[i].mode) {
    fail(`mode not restored for ${relative(ROOT, original[i].path)}: ${restored[i].mode.toString(8)} != ${original[i].mode.toString(8)}`);
  }
}
if (!failed) console.log('ok: working-tree modes restored');

console.log(failed ? '\nBUILD-RELEASE MODE-INVARIANCE TEST FAILED' : '\nPASS: release build is mode-invariant and mode-canonical');
process.exit(failed ? 1 : 0);

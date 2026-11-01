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
  chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

const original = walk(RUNTIME);
const work = mkdtempSync(join(tmpdir(), 'build-release-test-'));
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

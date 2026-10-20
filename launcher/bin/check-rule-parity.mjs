#!/usr/bin/env node
// check-rule-parity.mjs — fail loudly if composer <-> engine rule parity
// has drifted.
//
//   node launcher/bin/check-rule-parity.mjs
//
// Ground truth is the ENGINE SOURCE (engine/src/lib.rs): its RULE_*
// constants and rule_implemented() match arms, parsed exactly as
// gen-rules.mjs parses them. Checks:
//   1. launcher/browser-src/rules.generated.mjs is FRESH — byte-identical
//      to a regeneration from the current lib.rs (a stale file is named,
//      with the first differing line).
//   2. The composer's selectable set == IMPLEMENTED_IDS, in both
//      composer surfaces:
//        - the browser bundle source (browser-src/entry.mjs) must import
//          rules.generated.mjs (its selectable set IS the generated set);
//        - the published page (aonly-site/hooks/launch/index.html, a
//          static file carrying a synced copy) must offer exactly the
//          implemented ids as selectable rule blocks, list exactly the
//          known-but-unimplemented ids as "coming soon", and carry
//          GENERATED_* id literals equal to the generated sets.
//   3. The guard block (GUARD: basisLatch+never, pin == the
//      launcher/engine-v4.json fixedEngineSha256) is present and
//      identical in the generated module, the bundle source, and the
//      page.
// Exit 0 = parity holds; exit 1 = drift, with every diff named.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseEngineRules, renderRulesModule, ENGINE_LIB_RS, RULES_GENERATED_PATH } from './gen-rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_PATH = path.join(here, '..', 'browser-src', 'entry.mjs');
const SITE_HTML_PATH = path.join(here, '..', '..', '..', '..', 'aonly-site', 'hooks', 'launch', 'index.html');

let failures = 0;
const fail = (name, detail) => { failures++; console.log('  FAIL', name, detail ? '— ' + detail : ''); };
const pass = (name) => console.log('  PASS', name);
const eqSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const diffSets = (want, got) => {
  const missing = want.filter((x) => !got.includes(x));
  const extra = got.filter((x) => !want.includes(x));
  const parts = [];
  if (missing.length) parts.push('missing {' + missing.join(', ') + '}');
  if (extra.length) parts.push('unexpected {' + extra.join(', ') + '}');
  return parts.join('; ') || 'order differs';
};

// ---- ground truth from the engine source ----
const libRs = fs.readFileSync(ENGINE_LIB_RS, 'utf8');
const rules = parseEngineRules(libRs);
const implementedIds = rules.filter((r) => r.implemented).map((r) => r.id);
const unimplementedIds = rules.filter((r) => !r.implemented).map((r) => r.id);
console.log(`engine truth: ${rules.length} known rules, implemented {${implementedIds.join(', ')}}, unimplemented {${unimplementedIds.join(', ')}}`);

// ---- 1. generated file is fresh ----
const expected = renderRulesModule(rules);
const onDisk = fs.existsSync(RULES_GENERATED_PATH) ? fs.readFileSync(RULES_GENERATED_PATH, 'utf8') : null;
if (onDisk === null) {
  fail('rules.generated.mjs exists', 'file missing — run: node launcher/bin/gen-rules.mjs');
} else if (onDisk !== expected) {
  const a = onDisk.split('\n'), b = expected.split('\n');
  let line = 0;
  while (line < Math.max(a.length, b.length) && a[line] === b[line]) line++;
  fail('rules.generated.mjs is fresh', `STALE vs engine/src/lib.rs — first diff at line ${line + 1}: on disk ${JSON.stringify(a[line] ?? '(eof)')} vs generated ${JSON.stringify(b[line] ?? '(eof)')} — run: node launcher/bin/gen-rules.mjs`);
} else {
  pass('rules.generated.mjs is fresh (byte-identical to a regeneration from lib.rs)');
}

// ---- 2a. bundle composer imports the generated module ----
const entrySrc = fs.readFileSync(ENTRY_PATH, 'utf8');
if (/from\s+['"]\.\/rules\.generated\.mjs['"]/.test(entrySrc)) {
  pass('browser-src/entry.mjs imports rules.generated.mjs (selectable set = generated set)');
} else {
  fail('browser-src/entry.mjs imports rules.generated.mjs', 'composer bundle is not wired to the generated module');
}
if (/IMPLEMENTED\s*=\s*new Set\(\[/.test(entrySrc)) {
  fail('browser-src/entry.mjs carries no hardcoded IMPLEMENTED set', 'found a hand-maintained Set literal');
} else {
  pass('browser-src/entry.mjs carries no hardcoded IMPLEMENTED set');
}

// ---- 2b. published page composer ----
const html = fs.readFileSync(SITE_HTML_PATH, 'utf8');
const selectable = [...html.matchAll(/data-rule="(\d+)"/g)].map((m) => Number(m[1])).sort((x, y) => x - y);
if (eqSet(selectable, implementedIds)) {
  pass(`page selectable rule blocks == IMPLEMENTED_IDS {${implementedIds.join(', ')}}`);
} else {
  fail('page selectable rule blocks == IMPLEMENTED_IDS', diffSets(implementedIds, selectable));
}
const soon = [...html.matchAll(/rule (\d+) · coming soon/g)].map((m) => Number(m[1])).sort((x, y) => x - y);
if (eqSet(soon, unimplementedIds)) {
  pass(`page "coming soon" set == known-but-unimplemented {${unimplementedIds.join(', ')}}`);
} else {
  fail('page "coming soon" set == known-but-unimplemented', diffSets(unimplementedIds, soon));
}
const litImpl = html.match(/GENERATED_IMPLEMENTED_IDS = \[([^\]]*)\]/);
const pageImpl = litImpl ? (litImpl[1].trim() === '' ? [] : litImpl[1].split(',').map((x) => Number(x.trim()))) : null;
if (pageImpl && eqSet(pageImpl, implementedIds)) {
  pass('page GENERATED_IMPLEMENTED_IDS literal == generated IMPLEMENTED_IDS');
} else {
  fail('page GENERATED_IMPLEMENTED_IDS literal == generated IMPLEMENTED_IDS', pageImpl ? diffSets(implementedIds, pageImpl) : 'literal not found');
}
const litUn = html.match(/GENERATED_UNIMPLEMENTED_IDS = \[([^\]]*)\]/);
const pageUn = litUn ? (litUn[1].trim() === '' ? [] : litUn[1].split(',').map((x) => Number(x.trim()))) : null;
if (pageUn && eqSet(pageUn, unimplementedIds)) {
  pass('page GENERATED_UNIMPLEMENTED_IDS literal == generated unimplemented set');
} else {
  fail('page GENERATED_UNIMPLEMENTED_IDS literal == generated unimplemented set', pageUn ? diffSets(unimplementedIds, pageUn) : 'literal not found');
}

// ---- 3. guard block parity ----
const v4pin = (() => { try { const d = JSON.parse(fs.readFileSync(path.join(here, '..', 'engine-v4.json'), 'utf8')); return typeof d.fixedEngineSha256 === 'string' ? d.fixedEngineSha256 : null; } catch { return null; } })();
const genGuardOk = onDisk != null && onDisk.includes('combo: "basisLatch+never"') && onDisk.includes(`fixedEngineSha256: ${v4pin ? '"' + v4pin + '"' : 'null'}`);
if (genGuardOk) pass(`generated GUARD pin == engine-v4.json (${v4pin ? v4pin.slice(0, 12) + '…' : 'null — guard armed'})`);
else fail('generated GUARD block', 'missing or altered in rules.generated.mjs');
if (entrySrc.includes('GUARD') && entrySrc.includes('assertComboAllowed')) {
  pass('entry.mjs enforces the guard (GUARD + assertComboAllowed)');
} else {
  fail('entry.mjs enforces the guard', 'GUARD reference / assertComboAllowed not found');
}
if (html.includes("combo: 'basisLatch+never'") && html.includes(`fixedEngineSha256: ${v4pin ? "'" + v4pin + "'" : 'null'}`) && html.includes('GUARD_MESSAGE')) {
  pass('page carries the same GUARD block + refusal message');
} else {
  fail('page carries the same GUARD block', 'GUARD literal / GUARD_MESSAGE not found in page script');
}

console.log(failures ? `\n==== RULE PARITY: ${failures} drift(s) found ====` : '\n==== RULE PARITY: OK — composer selectable set == engine IMPLEMENTED_IDS ====');
process.exit(failures ? 1 : 0);

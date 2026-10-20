#!/usr/bin/env node
// trial-rule-parity.mjs — composer <-> engine rule parity suite.
//   node launcher/trial-rule-parity.mjs
// Asserts:
//   (a) browser-src/rules.generated.mjs matches the current engine source
//   (b) the composer sources consume the generated module — no hardcoded
//       rule-id list remains as the selectable-set source (grep-level)
//   (c) the Basis Latch + graduation "never" guard block exists, is
//       pinned to the verified live engine, and its pure decision
//       refuses unless the live hash matches the pin
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { parseEngineRules, renderRulesModule, ENGINE_LIB_RS, RULES_GENERATED_PATH } from './bin/gen-rules.mjs';
import { createHookLaunch } from './browser-src/entry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE_HTML_PATH = path.join(here, '..', '..', '..', 'aonly-site', 'hooks', 'launch', 'index.html');

let pass = 0, fail = 0;
const ok = (c, n, extra = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, extra); } };

// ---- (a) generated file matches current lib.rs ----
const libRs = fs.readFileSync(ENGINE_LIB_RS, 'utf8');
const rules = parseEngineRules(libRs);
const implementedIds = rules.filter((r) => r.implemented).map((r) => r.id);
const onDisk = fs.readFileSync(RULES_GENERATED_PATH, 'utf8');
ok(onDisk === renderRulesModule(rules), '(a) rules.generated.mjs is byte-identical to a fresh generation from engine/src/lib.rs');
const gen = await import('./browser-src/rules.generated.mjs');
ok(JSON.stringify(gen.IMPLEMENTED_IDS) === JSON.stringify(implementedIds) && gen.RULES.length === rules.length,
  `(a) generated IMPLEMENTED_IDS == engine rule_implemented() set {${implementedIds.join(', ')}}, ${rules.length} rules catalogued`);

// ---- (b) composer consumes the generated module; no hardcoded list ----
const entrySrc = fs.readFileSync(path.join(here, 'browser-src', 'entry.mjs'), 'utf8');
ok(/from\s+['"]\.\/rules\.generated\.mjs['"]/.test(entrySrc), '(b) browser-src/entry.mjs imports rules.generated.mjs');
ok(!/IMPLEMENTED\s*=\s*new Set\(\[/.test(entrySrc) && !entrySrc.includes('[1, 3, 7, 8, 9]'),
  '(b) entry.mjs holds no hardcoded implemented-id list');
const html = fs.readFileSync(SITE_HTML_PATH, 'utf8');
const pageScript = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
const pageImpl = (pageScript.match(/GENERATED_IMPLEMENTED_IDS = \[([^\]]*)\]/) || [])[1];
ok(!!pageImpl && JSON.stringify(pageImpl.split(',').map((x) => Number(x.trim()))) === JSON.stringify(implementedIds)
  && pageScript.includes('GENERATED_IMPLEMENTED_IDS.forEach'),
  '(b) page composer builds its selectable set from the generated ids (synced GENERATED_IMPLEMENTED_IDS, iterated by buildSpec/readState/refresh)');

// ---- (c) guard block exists and refuses unless the live engine matches the pin ----
// Pinned state (S1/S6, 2026-10-20): launcher/engine-v4.json now records a
// non-null fixedEngineSha256 and rules.generated.mjs was regenerated with
// it. The composer backstops (bundle + page) only refuse while the pin is
// null, so under the pin they allow; the real refusal lives in the pure
// launch.mjs decision, which allows rule 1 + "never" ONLY when the live
// ProgramData hash equals the pin and fails closed otherwise.
const PIN = JSON.parse(fs.readFileSync(path.join(here, 'engine-v4.json'), 'utf8')).fixedEngineSha256;
ok(gen.GUARD && gen.GUARD.combo === 'basisLatch+never' && typeof PIN === 'string' && /^[0-9a-f]{64}$/.test(PIN)
  && gen.GUARD.fixedEngineSha256 === PIN,
  '(c) generated GUARD = { combo: "basisLatch+never", fixedEngineSha256: <pin> } — pin is non-null and equals launcher/engine-v4.json fixedEngineSha256');
const HL = createHookLaunch();
ok(JSON.stringify(HL.selectableRuleIds) === JSON.stringify(gen.IMPLEMENTED_IDS) && HL.guard === gen.GUARD,
  '(c) bundle exposes the generated selectable set + guard');
// Pure guard decision, sliced verbatim from launch.mjs's delimited PURE
// section (same technique as trial-launch-features.mjs §H) and exercised
// with explicit hashes: allow iff live == pin; refuse on mismatch, on an
// unread live hash (null), and with no pin recorded (null).
const Hc = await import('./browser-src/helpers.generated.mjs');
const launchSrcC = fs.readFileSync(path.join(here, 'launch.mjs'), 'utf8');
const pStartC = launchSrcC.indexOf('// ---------- engine v4 guard');
const pEndC = launchSrcC.indexOf('PURE — END v4-pure');
let engineV4GuardDecisionC = null;
if (pStartC >= 0 && pEndC > pStartC) {
  try {
    engineV4GuardDecisionC = new Function('ruleIdOf', 'resolveGraduation',
      `${launchSrcC.slice(pStartC, pEndC)}\nreturn { engineV4GuardDecision };`)(Hc.ruleIdOf, Hc.resolveGraduation).engineV4GuardDecision;
  } catch { engineV4GuardDecisionC = null; }
}
const pinStrC = typeof PIN === 'string' ? PIN : '';
const otherShaC = (pinStrC[0] === '0' ? '1' : '0') + pinStrC.slice(1);
const neverSpecC = { name: 'T', symbol: 'T', rules: [{ id: 1, mode: 'latch', maxStaleSecs: 300 }], graduation: 'never' };
const dMatchC = engineV4GuardDecisionC ? engineV4GuardDecisionC(neverSpecC, PIN, PIN) : null;
const dMismatchC = engineV4GuardDecisionC ? engineV4GuardDecisionC(neverSpecC, PIN, otherShaC) : null;
const dNoLiveC = engineV4GuardDecisionC ? engineV4GuardDecisionC(neverSpecC, PIN, null) : null;
const dNoPinC = engineV4GuardDecisionC ? engineV4GuardDecisionC(neverSpecC, null, PIN) : null;
ok(!!dMatchC && dMatchC.applies && dMatchC.allow
  && !!dMismatchC && dMismatchC.applies && !dMismatchC.allow
  && !!dNoLiveC && dNoLiveC.applies && !dNoLiveC.allow
  && !!dNoPinC && dNoPinC.applies && !dNoPinC.allow,
  '(c) pure engineV4GuardDecision (launch.mjs) allows Basis Latch + graduation "never" when the live hash equals the pin, and refuses on a differing live hash, on an unread live hash (null), and with no pin recorded');
let neverOk = true;
try { HL.validateSpec({ name: 'T', symbol: 'T', rules: [{ id: 1, mode: 'latch' }], graduation: 'never' }); } catch { neverOk = false; }
let releaseOk = true;
try { HL.validateSpec({ name: 'T', symbol: 'T', rules: [{ id: 1, mode: 'latch' }] }); } catch { releaseOk = false; }
ok(neverOk && releaseOk, '(c) bundle validateSpec allows Basis Latch with graduation "never" under the pinned GUARD (composer backstop disarmed by the pin; launch.mjs still verifies the live hash) and still allows Basis Latch with graduation "release"');

// page logic: run the page's pure script under DOM stubs (smoke pattern)
function makeEl(id) {
  return {
    id, value: '', checked: false, textContent: '', innerHTML: '', style: {}, files: [],
    listeners: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    click() {}, appendChild() {},
  };
}
const elements = {}; const handlers = {};
const documentStub = {
  readyState: 'complete',
  getElementById(id) { return (elements[id] ||= makeEl(id)); },
  querySelector() { return makeEl('q'); },
  createElement() { return makeEl('new'); },
  addEventListener(ev, fn) { (handlers['doc:' + ev] ||= []).push(fn); },
};
const sandbox = {
  console, navigator: {}, URL, Blob: class {},
  fetch: () => Promise.reject(new Error('no network in trial')),
  document: documentStub, FileReader: class {},
};
sandbox.window = sandbox;
sandbox.addEventListener = (ev, fn) => { (handlers['win:' + ev] ||= []).push(fn); };
vm.createContext(sandbox);
const fill = {
  f_name: 'T', f_symbol: 'T', f_supply: '1000', f_threshold: '42',
  f_authmode: 'locked', f_authority: '', f_seed: '0', f_rentvault: '0.05',
  r1_mode: 'latch', r1_stale: '300', r7_mode: 'p2p-only', r8_gate: '', r8_min: '1', r8_dec: '9',
  r9_cap: '5', hf_cut: '100', r17_ecosystem: 'muse',
};
for (const [id, v] of Object.entries(fill)) documentStub.getElementById(id).value = v;
vm.runInContext(pageScript, sandbox, { filename: 'launch/index.html<script>' });
const L = sandbox.__launcher;
let pageGuardThrew = false, pageNeverSpec = null;
try {
  pageNeverSpec = L.buildSpec({
    name: 'G', symbol: 'g', supply: 1000, authorityMode: 'locked', authority: '', graduation: 'never',
    rules: { 1: { on: true, mode: 'latch' } },
    holderFees: { on: false, callerCutBps: 100 }, seedSol: 0, rentVaultSol: 0.05,
  });
} catch { pageGuardThrew = true; }
ok(!pageGuardThrew && !!pageNeverSpec && pageNeverSpec.graduation === 'never'
  && pageNeverSpec.rules.length === 1 && pageNeverSpec.rules[0].id === 1
  && L.GUARD && L.GUARD.combo === 'basisLatch+never' && L.GUARD.fixedEngineSha256 === PIN,
  '(c) page buildSpec allows Basis Latch + graduation "never" under the pinned GUARD (page GUARD pin matches engine-v4.json; the page guard only refuses while the pin is null)');
const eco = L.buildSpec({
  name: 'Eco', symbol: 'eco', supply: 1000, authorityMode: 'locked', authority: '',
  rules: { 17: { on: true, ecosystem: 'muse' } },
  holderFees: { on: false, callerCutBps: 100 }, seedSol: 0, migrationThresholdSol: 42, rentVaultSol: 0.05,
});
ok(eco.rules.length === 1 && eco.rules[0].id === 17 && eco.rules[0].ecosystem === 'muse',
  '(c) page buildSpec emits Ecosystem Gate (rule 17) — selectable through the generation');

// ---- (d) the CLI (launch.mjs) consumes the SAME generated set ----
// Phase C recovery: launch.mjs's IMPLEMENTED was a hand-kept literal that
// had drifted to {1,2,3,7,8,9,17} while the engine + composer accepted
// all 17. It now derives from rules.generated.mjs like every other
// surface; these checks pin the wiring and the param encoders that make
// acceptance real (an accepted rule whose params encode to zeros the
// engine rejects at write would be a quieter lie than refusal).
const launchSrc = fs.readFileSync(path.join(here, 'launch.mjs'), 'utf8');
ok(/import\s*\{\s*IMPLEMENTED_IDS\s*\}\s*from\s*['"]\.\/browser-src\/rules\.generated\.mjs['"]/.test(launchSrc),
  '(d) launch.mjs imports IMPLEMENTED_IDS from browser-src/rules.generated.mjs');
ok(!/IMPLEMENTED\s*=\s*new Set\(\[/.test(launchSrc) && /IMPLEMENTED\s*=\s*new Set\(IMPLEMENTED_IDS\)/.test(launchSrc),
  '(d) launch.mjs holds no hardcoded implemented-id literal (IMPLEMENTED = new Set(IMPLEMENTED_IDS))');
const helpersSrc = fs.readFileSync(path.join(here, 'browser-src', 'helpers.generated.mjs'), 'utf8');
ok(/from\s*['"]\.\/rules\.generated\.mjs['"]/.test(helpersSrc) && /IMPLEMENTED\s*=\s*new Set\(IMPLEMENTED_IDS\)/.test(helpersSrc),
  '(d) generated browser helpers derive IMPLEMENTED from the same module');
const H = await import('./browser-src/helpers.generated.mjs');
ok(JSON.stringify([...H.IMPLEMENTED].sort((a, b) => a - b)) === JSON.stringify(implementedIds),
  `(d) shared IMPLEMENTED set == engine set {${implementedIds.join(', ')}}`);
// encoder byte pins (engine layouts, parse_config_payload):
const p12 = H.encodeParams(12, { id: 12 });
ok(p12.readInt32LE(0) === -18000 && p12[4] === 0x1f && p12.readUInt16LE(5) === 540 && p12.readUInt16LE(7) === 1020 && p12[9] === 0,
  '(d) rule 12 bare entry encodes the JOB fixture (UTC-5, Mon-Fri, 09:00-17:00, all transfers)');
ok(H.encodeParams(5, { id: 5 }).readUInt16LE(0) === 500, '(d) rule 5 bare entry encodes crownBps 500 @0');
const seat = 'So11111111111111111111111111111111111111112';
const p6 = H.encodeParams(6, { id: 6, seatMint: seat });
ok(p6.subarray(0, 32).equals(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) === false && p6.readUInt16LE(32) === 300,
  '(d) rule 6 encodes seatMint @0..32 + titheBps 300 @32');
const p14 = H.encodeParams(14, { id: 14 });
ok(p14.readUInt16LE(0) === 500 && p14.readUInt16LE(2) === 100 && p14.readBigUInt64LE(4) === 2592000n,
  '(d) rule 14 bare entry encodes start 500 / floor 100 / decay 2592000s');
const p16 = H.encodeParams(16, { id: 16 });
ok(p16.readBigUInt64LE(0) === 1000000000n && p16.readUInt16LE(8) === 100,
  '(d) rule 16 bare entry encodes threshold 1 SOL / caller cut 100 bps');
ok(H.encodeParams(15, { id: 15 }).readUInt16LE(0) === 0, '(d) rule 15 bare entry encodes titheBps 0 (tracking only)');
ok(H.encodeParams(10, { id: 10 })[0] === 2, '(d) rule 10 bare entry encodes mode 2 (both lists)');
let threw = 0;
try { H.encodeParams(4, { id: 4 }); } catch { threw++; } // no app named — no honest default exists
try { H.encodeParams(13, { id: 13 }); } catch { threw++; } // neither vesting leg set
try { H.encodeParams(11, { id: 11, penaltyMode: 'cap' }); } catch { threw++; } // cap without buyCapAmount
try { H.encodeParams(14, { id: 14, startBps: 100, floorBps: 500 }); } catch { threw++; } // floor > start
ok(threw === 4, '(d) encoders refuse honestly-defaultless or invalid entries (rule 4 bare, rule 13 bare, rule 11 cap without amount, rule 14 floor>start)');
// validateSpec acceptance across the full set (the pre-fix CLI refused
// 4,5,6,10..16 outright): a stack naming every Phase A/B rule validates.
let stackOk = true, stackErr = '';
try {
  H.validateSpec({ name: 'T', symbol: 'T', rules: [
    { id: 4, app1: seat }, { id: 5 }, { id: 6, seatMint: seat }, { id: 10 }, { id: 11 },
  ] });
  H.validateSpec({ name: 'T', symbol: 'T', rules: [
    { id: 12 }, { id: 13, holdSecs: 86400 }, { id: 14 }, { id: 15 }, { id: 16 },
  ] });
} catch (e) { stackOk = false; stackErr = e.message; }
ok(stackOk, '(d) validateSpec accepts the full Phase A/B rule set with named/default params', stackErr);

console.log(`\n==== RULE PARITY TRIAL: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

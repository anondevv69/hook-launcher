#!/usr/bin/env node
// validate-config.mjs — deterministic launch-spec validation with STABLE
// error codes. This is the honest static-stack form of the redesign spec's
// POST /api/v1/hooks/validate: the site host is a static file server, so
// the deterministic core ships as a CLI + importable module that any
// future HTTP endpoint can wrap verbatim.
//
//   node validate-config.mjs <spec.json>     validate a spec file
//   node validate-config.mjs -               validate JSON from stdin
//   import { validateLaunchSpec } from './validate-config.mjs'
//
// Output (stdout, JSON): { ok, errors: [{code, message, ruleId?}], warnings }
// Exit code: 0 when ok, 1 when not, 2 on unreadable input.
//
// The validator NEVER reimplements a check the launcher owns. Structural
// checks and code assignment live here; everything else delegates to the
// launcher's own validateSpec / encodeParams (browser-src/
// helpers.generated.mjs, generated from launch.mjs), and launcher error
// messages are mapped onto stable codes by pattern. If the launcher
// learns a new refusal, this validator surfaces it as E_SPEC_INVALID
// with the launcher's own message until a code is assigned here.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  validateSpec, encodeParams, ruleIdOf, RULE_NAMES, IMPLEMENTED,
} from './browser-src/helpers.generated.mjs';

export const ERROR_CODES = [
  'E_SPEC_NOT_OBJECT', 'E_MISSING_IDENTITY', 'E_AUTHORITY_MODE',
  'E_RULES_NOT_ARRAY', 'E_TOO_MANY_RULES', 'E_RULE_UNRECOGNIZED',
  'E_UNKNOWN_RULE', 'E_RULE_NOT_IMPLEMENTED', 'E_DUPLICATE_RULE',
  'E_PARAM_INVALID', 'E_RULE14_NOT_LAUNCHABLE', 'E_RULE2_REQUIRES_RULE1',
  'E_RULE2_REQUIRES_HOUSE', 'E_SPLIT_SUM_EXCEEDED', 'E_FEE_INVALID',
  'E_GRADUATION_INVALID', 'E_HOUSE_INVALID', 'E_DEV_BUY_INVALID',
  'E_METADATA_INVALID', 'E_SPEC_INVALID',
];

const MAX_RULES = 8;
const SPLIT_RULES = new Map([[5, (e) => e.crownBps ?? 500], [6, (e) => e.titheBps ?? 300], [15, (e) => e.titheBps ?? 0]]);

function mapLauncherMessage(msg) {
  if (/rule 14 \(Decay Tax\) is not launchable/.test(msg)) return 'E_RULE14_NOT_LAUNCHABLE';
  if (/settlement split too large/.test(msg)) return 'E_SPLIT_SUM_EXCEEDED';
  if (/rule 2 \(Escrow Split\) requires rule 1/.test(msg)) return 'E_RULE2_REQUIRES_RULE1';
  if (/rule 2 \(Escrow Split\) requires graduation/.test(msg)) return 'E_RULE2_REQUIRES_HOUSE';
  if (/feeBps|feeDestination|holderFees/.test(msg)) return 'E_FEE_INVALID';
  if (/graduation|migrationThresholdSol|graduationThresholdSol/.test(msg)) return 'E_GRADUATION_INVALID';
  if (/house/i.test(msg)) return 'E_HOUSE_INVALID';
  if (/dev ?buy/i.test(msg)) return 'E_DEV_BUY_INVALID';
  if (/metadata/i.test(msg)) return 'E_METADATA_INVALID';
  if (/^rule \d+/.test(msg)) return 'E_PARAM_INVALID';
  return 'E_SPEC_INVALID';
}

export function validateLaunchSpec(spec) {
  const errors = [];
  const err = (code, message, ruleId) => errors.push(ruleId != null ? { code, message, ruleId } : { code, message });

  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, errors: [{ code: 'E_SPEC_NOT_OBJECT', message: 'spec must be a JSON object' }], warnings: [] };
  }
  if (!spec.name || !spec.symbol) err('E_MISSING_IDENTITY', 'spec requires name and symbol');
  const mode = String(spec.authorityMode ?? 'locked').toLowerCase();
  if (!['locked', 'creator', 'agent', 'holdervote', 'holder-vote'].includes(mode)) {
    err('E_AUTHORITY_MODE', `authorityMode must be one of: locked, creator, agent, holdervote — got ${JSON.stringify(spec.authorityMode)}`);
  }
  const rules = spec.rules ?? [];
  if (!Array.isArray(rules)) {
    err('E_RULES_NOT_ARRAY', 'spec.rules must be an array');
    return { ok: false, errors, warnings: [] };
  }
  if (rules.length > MAX_RULES) err('E_TOO_MANY_RULES', `at most ${MAX_RULES} rules per config (engine MAX_RULES), got ${rules.length}`);

  const seen = new Map();
  for (const entry of rules) {
    let id;
    try { id = ruleIdOf(entry); }
    catch (e) { err('E_RULE_UNRECOGNIZED', e.message); continue; }
    if (!Number.isInteger(id)) {
      err('E_RULE_UNRECOGNIZED', `rule entry carries no recognizable rule id: ${JSON.stringify(entry).slice(0, 120)}`);
      continue;
    }
    if (id === 18) {
      err('E_RULE_NOT_IMPLEMENTED', 'rule 18 (Buy Cooldown) is specced (SPEC-BUY-COOLDOWN.md) but NOT implemented in the current engine build. Refusing — the launcher never silently drops a rule.', 18);
      continue;
    }
    if (!RULE_NAMES[id]) {
      err('E_UNKNOWN_RULE', `unknown rule_id ${id} — not in the catalog (1..17). A config referencing an unknown rule must fail at launch, never at transfer time.`, id);
      continue;
    }
    if (!IMPLEMENTED.has(id)) {
      err('E_RULE_NOT_IMPLEMENTED', `rule ${id} (${RULE_NAMES[id]}) is in the catalog but NOT implemented in the current engine build. Refusing — the launcher never silently drops a rule.`, id);
      continue;
    }
    if (seen.has(id)) err('E_DUPLICATE_RULE', `duplicate rule ${id} (${RULE_NAMES[id]}) in the stack`, id);
    seen.set(id, entry);
    if (id === 14) {
      err('E_RULE14_NOT_LAUNCHABLE', 'rule 14 (Decay Tax) is not launchable through this launcher — DBC mints carry no Transfer Fee extension, so a rule-14 config could never initialize its schedule. The FeeSchedule program is live; the direct fee-extension mint path is not built yet. Drop rule 14.', 14);
      continue;
    }
    try { encodeParams(id, entry); }
    catch (e) { err('E_PARAM_INVALID', e.message, id); }
  }

  // Cross-rule checks with dedicated codes (mirroring validateSpec).
  if (seen.has(2)) {
    if (!seen.has(1)) err('E_RULE2_REQUIRES_RULE1', 'rule 2 (Escrow Split) requires rule 1 (Basis Latch) enabled — escrow resolution reads the price feed and the seller\u2019s basis, which only rule 1 maintains.', 2);
    const grad = spec.graduation == null ? 'release' : String(spec.graduation).toLowerCase();
    if (grad !== 'house') err('E_RULE2_REQUIRES_HOUSE', 'rule 2 (Escrow Split) requires graduation "house" — the split is enforced by the house venue, not the engine; a curve token has no venue to split in.', 2);
  }
  {
    let sum = 0; const parts = [];
    for (const [id, entry] of seen) {
      if (entry.enabled === false || !SPLIT_RULES.has(id)) continue;
      const bps = SPLIT_RULES.get(id)(entry);
      if (Number.isInteger(bps)) { sum += bps; parts.push(`rule ${id} ${bps} bps`); }
    }
    if (sum > 10000) err('E_SPLIT_SUM_EXCEEDED', `settlement split too large: the rules 5+6+15 carves sum to ${sum} bps (${parts.join(' + ')}) — over the 10000 bps a distribution has. The engine rejects this at config write and the Distributor hard-errors it at settlement (SplitBpsTooLarge).`);
  }

  if (errors.length) return { ok: false, errors, warnings: [] };

  // Delegate everything else to the launcher's own validator.
  try {
    const warnings = validateSpec(spec);
    return { ok: true, errors: [], warnings };
  } catch (e) {
    return { ok: false, errors: [{ code: mapLauncherMessage(e.message), message: e.message }], warnings: [] };
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = process.argv[2];
  let raw;
  try { raw = arg === '-' || arg == null ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8'); }
  catch (e) { console.error(`cannot read spec: ${e.message}`); process.exit(2); }
  let spec;
  try { spec = JSON.parse(raw); }
  catch (e) { console.log(JSON.stringify({ ok: false, errors: [{ code: 'E_SPEC_NOT_OBJECT', message: `spec is not valid JSON: ${e.message}` }], warnings: [] }, null, 2)); process.exit(1); }
  const result = validateLaunchSpec(spec);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

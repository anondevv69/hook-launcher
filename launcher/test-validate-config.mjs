#!/usr/bin/env node
// test-validate-config.mjs — tests for the deterministic validator.
//   node test-validate-config.mjs
// Valid cases use the REAL launch records (AGTR/APROOF/HRPROOF/EVER) and
// the skill's own worked examples (DIP, SQ2, ERIC). Every error class
// must fail with its stable code.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { validateLaunchSpec, ERROR_CODES } from './validate-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.resolve(HERE, '..', 'deploy');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };

const recordSpec = (file) => JSON.parse(fs.readFileSync(path.join(DEPLOY, file), 'utf8')).spec;

const VALID = [
  ['AGTR (live record)', recordSpec('launch-record-agtr.json')],
  ['APROOF (live record)', recordSpec('launch-record-aproof.json')],
  ['HRPROOF (live record)', recordSpec('launch-record-hrproof.json')],
  ['HPROOF house record (live record)', recordSpec('launch-record-house-proof.json')],
  ['EVER never-graduation (live record)', recordSpec('launch-record-harvest-ever.json')],
  ['DIP (skill worked example)', { name: 'DIP', symbol: 'DIP', authorityMode: 'locked', rules: [{ id: 1, mode: 'latch', maxStaleSecs: 300 }] }],
  ['SQ2 (skill worked example, verbatim)', JSON.parse('{"name":"Sequel","symbol":"SQ2","supply":1000000000,"decimals":6,"authorityMode":"locked","rules":[{"id":8,"gateMint":"Hfk7uqxZ3fFB4TpAzSKYGCJ3uuAJ1E1fk6i6vSn3FVXR","minAmount":1000,"gateDecimals":6},{"id":9,"capBps":1000}],"holderFees":{"enabled":false},"seedSol":0,"migrationThresholdSol":42,"rentVaultSol":0.05}')],
  ['Rule 2 done right (mirrors the HPROOF record shape)', { name: 'X', symbol: 'X', authorityMode: 'creator', graduation: 'house', graduationThresholdSol: 0.2, houseReserveSol: 0.2, houseSeedBuySol: 0.25, houseSeedTokens: 42500, houseSeedWalletSol: 0.57,
    rules: [{ id: 1 }, { id: 2, splitBps: 5000 }, { id: 9, capBps: 500 }] }],
  ['ERIC-style ecosystem stack', { name: 'ERIC', symbol: 'ERIC', authorityMode: 'agent',
    rules: [{ id: 17, ecosystem: 'muse' }, { id: 9, capBps: 500 }] }],
];
for (const [name, spec] of VALID) {
  const r = validateLaunchSpec(spec);
  ok(`valid: ${name}`, r.ok === true, JSON.stringify(r.errors));
}

const WS = 'So11111111111111111111111111111111111111112';
const base = { name: 'T', symbol: 'T' };
const INVALID = [
  ['not an object', [], 'E_SPEC_NOT_OBJECT'],
  ['missing identity', { rules: [] }, 'E_MISSING_IDENTITY'],
  ['bad authorityMode', { ...base, authorityMode: 'dao' }, 'E_AUTHORITY_MODE'],
  ['rules not an array', { ...base, rules: {} }, 'E_RULES_NOT_ARRAY'],
  ['too many rules', { ...base, rules: [{ id: 1 }, { id: 3 }, { id: 5 }, { id: 6, seatMint: WS }, { id: 7, mode: 'no-p2p' }, { id: 8, gateMint: WS, minAmountRaw: 1 }, { id: 9, capBps: 500 }, { id: 10 }, { id: 11 }] }, 'E_TOO_MANY_RULES'],
  ['unrecognized rule shape', { ...base, rules: [{ id: 'banana' }] }, 'E_RULE_UNRECOGNIZED'],
  ['unknown rule id', { ...base, rules: [{ id: 19 }] }, 'E_UNKNOWN_RULE'],
  ['rule 18 spec-only', { ...base, rules: [{ id: 18, cooldownSecs: 300 }] }, 'E_RULE_NOT_IMPLEMENTED'],
  ['duplicate rule', { ...base, rules: [{ id: 9, capBps: 500 }, { id: 9, capBps: 600 }] }, 'E_DUPLICATE_RULE'],
  ['param out of bounds', { ...base, rules: [{ id: 9, capBps: 10001 }] }, 'E_PARAM_INVALID'],
  ['rule 14 on the DBC path', { ...base, rules: [{ id: 14, startBps: 500, floorBps: 100, decaySecs: 2592000 }] }, 'E_RULE14_NOT_LAUNCHABLE'],
  ['rule 2 without rule 1', { ...base, graduation: 'house', house: {}, rules: [{ id: 2 }] }, 'E_RULE2_REQUIRES_RULE1'],
  ['rule 2 without house graduation', { ...base, rules: [{ id: 1 }, { id: 2 }] }, 'E_RULE2_REQUIRES_HOUSE'],
  ['split sum exceeded', { ...base, rules: [{ id: 5, crownBps: 6000 }, { id: 6, seatMint: WS, titheBps: 3000 }, { id: 15, titheBps: 2000 }] }, 'E_SPLIT_SUM_EXCEEDED'],
  ['bad fee', { ...base, feeBps: 10, rules: [] }, 'E_FEE_INVALID'],
  ['bad graduation', { ...base, graduation: 'banana', rules: [] }, 'E_GRADUATION_INVALID'],
  ['dev buy out of bounds', { ...base, devBuySol: 999, rules: [] }, 'E_DEV_BUY_INVALID'],
  ['bad metadata uri', { ...base, metadataUri: 'ftp://example.com/x.json', rules: [] }, 'E_METADATA_INVALID'],
];
for (const [name, spec, code] of INVALID) {
  const r = validateLaunchSpec(spec);
  ok(`invalid: ${name} -> ${code}`, r.ok === false && r.errors.some((e) => e.code === code), JSON.stringify(r.errors));
  for (const e of r.errors) if (!ERROR_CODES.includes(e.code)) ok(`code ${e.code} is in ERROR_CODES`, false);
}

console.log('\nCLI:');
{
  const tmp = path.join('/tmp', 'vc-test-spec.json');
  fs.writeFileSync(tmp, JSON.stringify(VALID[0][1]));
  const out = execFileSync('node', [path.join(HERE, 'validate-config.mjs'), tmp], { encoding: 'utf8' });
  ok('CLI valid spec exits 0 with ok:true', JSON.parse(out).ok === true);
  fs.writeFileSync(tmp, JSON.stringify(INVALID[10][1]));
  let code = 0; try { execFileSync('node', [path.join(HERE, 'validate-config.mjs'), tmp], { encoding: 'utf8' }); } catch (e) { code = e.status; }
  ok('CLI invalid spec exits 1', code === 1);
  fs.unlinkSync(tmp);
}

console.log(`\n==== validate-config: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

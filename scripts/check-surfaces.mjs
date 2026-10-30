#!/usr/bin/env node
// check-surfaces.mjs — AgentOnly capability-surface checker.
//
// Local equivalent of the PR #2 acceptance item "CI fails on a dead or
// retired service URL, an inconsistent certificate claim, or conflicting
// Gateway copy": validates the PUBLISHED site surfaces (agentonly.fun)
// against the capability manifest (capabilities.json). Dependency-free
// Node ESM; run with `node scripts/check-surfaces.mjs`.
//
// Exit 0 = clean. Exit 1 = at least one violation (each printed).
// Override the base with AGENTONLY_BASE for staging mirrors.

const BASE = (process.env.AGENTONLY_BASE || 'https://agentonly.fun').replace(/\/$/, '');

const violations = [];
let surfacesChecked = 0;

const fail = (msg) => violations.push(msg);

async function fetchText(url) {
  surfacesChecked++;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: '', error: String(e?.message || e) };
  }
}

async function fetchJson(url, label) {
  const { status, body, error } = await fetchText(url);
  if (status !== 200) { fail(`${label}: GET ${url} returned ${error ? `error (${error})` : `HTTP ${status}`}`); return null; }
  try { return JSON.parse(body); } catch { fail(`${label}: ${url} is not valid JSON`); return null; }
}

// Tiny concurrency pool so the per-token checks do not serialize.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const RETIRED = 'board-production-ed76';
const CERT_PHRASES = ['certificate pending', 'certificate issuance pending'];

function scanText(label, body, { cert = false } = {}) {
  if (!body) return;
  if (body.includes(RETIRED)) fail(`${label}: contains the retired origin ${RETIRED}`);
  if (cert) {
    const low = body.toLowerCase();
    for (const p of CERT_PHRASES) if (low.includes(p)) fail(`${label}: contains stale certificate claim "${p}"`);
  }
}

// ---------- 1. capability manifest ----------
const capabilities = await fetchJson(`${BASE}/api/v1/capabilities.json`, 'capabilities');
if (capabilities) {
  const contract = capabilities?.actions?.executionGateway?.contract;
  if (!contract || typeof contract !== 'string' || !contract.trim()) {
    fail('capabilities.json: actions.executionGateway.contract is missing or empty');
  }
  scanText('capabilities.json', JSON.stringify(capabilities));
}

// ---------- 2. openapi ----------
const openapi = await fetchJson(`${BASE}/api/v1/openapi.json`, 'openapi');
if (openapi) {
  for (const p of ['/tokens/{mint}/buy.md', '/tokens/{mint}/sell.md']) {
    if (!openapi.paths || !(p in openapi.paths)) fail(`openapi.json: missing path ${p}`);
  }
  scanText('openapi.json', JSON.stringify(openapi));
}

// ---------- 3. tokens (mints for per-token checks) ----------
const tokensDoc = await fetchJson(`${BASE}/api/v1/tokens.json`, 'tokens');
const mints = (tokensDoc?.tokens || []).map((t) => t.mint).filter(Boolean);
if (!mints.length) fail('tokens.json: no token mints found — per-token skill checks skipped');
scanText('tokens.json', tokensDoc ? JSON.stringify(tokensDoc) : '');

// ---------- 4. llms.txt: stale copy + every referenced URL must answer 200 ----------
const llms = await fetchText(`${BASE}/llms.txt`);
if (llms.status !== 200) fail(`llms.txt: GET returned ${llms.error ? `error (${llms.error})` : `HTTP ${llms.status}`}`);
scanText('llms.txt', llms.body, { cert: true });
if (llms.body.includes('EXTERNAL: trades execute')) {
  fail('llms.txt: contains the stale claim "EXTERNAL: trades execute" (trade is prepared via the Execution Gateway)');
}

const rawUrls = [...new Set([...llms.body.matchAll(/https:\/\/agentonly\.fun[^\s"')\]]*/g)].map((m) => m[0].replace(/[.,;:!?]+$/, '')))];
const firstMint = mints[0];
// Resolve against BASE (a no-op at the default base; lets staging
// mirrors and local stubs exercise the same link graph llms.txt declares).
const resolvedUrls = rawUrls.map((u) => {
  let v = u.replace('https://agentonly.fun', BASE);
  return firstMint ? v.replaceAll('<mint>', firstMint) : v;
});

await pool(resolvedUrls, 6, async (u) => {
  const { status, error } = await fetchText(u);
  if (status !== 200) fail(`llms.txt link: ${u} returned ${error ? `error (${error})` : `HTTP ${status}`}`);
});

// ---------- 5. root skill router ----------
const skillRoot = await fetchText(`${BASE}/skill.md`);
if (skillRoot.status !== 200) fail(`skill.md: GET returned ${skillRoot.error ? `error (${skillRoot.error})` : `HTTP ${skillRoot.status}`}`);
scanText('skill.md', skillRoot.body);

// ---------- 6. skill files linked from llms.txt ----------
const skillUrls = resolvedUrls.filter((u) => u.endsWith('.md') && !u.includes('/tokens/') && u !== `${BASE}/skill.md`);
await pool(skillUrls, 6, async (u) => {
  const { status, body, error } = await fetchText(u);
  const label = u.replace(`${BASE}/`, '');
  if (status !== 200) { fail(`${label}: GET returned ${error ? `error (${error})` : `HTTP ${status}`}`); return; }
  scanText(label, body, { cert: true });
});

// ---------- 7. per-token buy.md / sell.md ----------
const tokenFiles = mints.flatMap((m) => [`${BASE}/tokens/${m}/buy.md`, `${BASE}/tokens/${m}/sell.md`]);
await pool(tokenFiles, 6, async (u) => {
  const { status, body, error } = await fetchText(u);
  const label = u.replace(`${BASE}/`, '');
  if (status !== 200) { fail(`${label}: GET returned ${error ? `error (${error})` : `HTTP ${status}`}`); return; }
  if (!body.trim()) { fail(`${label}: empty body`); return; }
  scanText(label, body, { cert: true });
});

// ---------- summary ----------
for (const v of violations) console.log(`FAIL: ${v}`);
console.log(`check-surfaces: ${surfacesChecked} surfaces checked, ${violations.length} violation(s)`);
process.exit(violations.length ? 1 : 0);

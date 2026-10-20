#!/usr/bin/env node
// publish-launches-feed.mjs — the public launches feed generator
// (recognition plumbing, 2026-10-17; the HookedPad GET /api/launches
// pattern, see deploy/HOOKED-DISTRIBUTION-MAP.md).
//
//   node publish-launches-feed.mjs            build + stage into the
//                                             site tree (no deploy)
//   node publish-launches-feed.mjs --deploy   + redeploy agentonly.fun
//                                             and verify the live URL
//
// Source of truth: the launch records in ../deploy/ RECONCILED against
// live chain state. A record only reaches the feed when, on-chain:
//   - its DBC pool account exists (owned by the DBC program),
//   - its DBC config's fee_claimer equals the record's feeClaimer,
//   - the mint's Token-2022 metadata URI is read from chain (records
//     can predate a repair; the chain is what indexers see).
// Any mismatch aborts the build — an unreconciled feed is worse than
// no feed. Status per launch is derived from the pool's own state
// (migrated / has swapped) plus the record's completeness, so the
// feed tells the truth per token (e.g. HARVEST EVER: pool live, zero
// trades, launch incomplete — status "paused", never "trading").
//
// The launch flow regenerates this feed at the end of every live
// launch (launch.mjs, after the record write): HookedPad's worker
// auto-lists within ~10 minutes; ours lists at launch completion.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const RPC = process.env.LAUNCH_RPC ?? 'https://api.mainnet-beta.solana.com';
const DEPLOY_DIR = new URL('../deploy/', import.meta.url).pathname;
const SITE_DIR = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..', 'aonly-site');
const FEED_PATH = path.join(SITE_DIR, 'api', 'launches.json');
const FEED_URL = 'https://agentonly.fun/api/launches';
const SITE = 'https://agentonly.fun';

// Partner identity — mirrors PARTNER_IDENTITY in launch.mjs (the
// on-chain partner-metadata account is the authority; these are its
// read-back values, verified at creation 2026-10-17).
const PARTNER = {
  name: 'AgentOnly',
  website: 'https://agentonly.fun/hooks/',
  logo: 'https://agentonly.fun/hooks/partner-logo.png',
  metadataAccount: '6udQdVvbGyGk5BcdEjZoAbqvLWmQsf7F1d1zjDu8ZGmU',
};

const doDeploy = process.argv.includes('--deploy');
const conn = new Connection(RPC, 'confirmed');
const client = new DynamicBondingCurveClient(conn, 'confirmed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(label, fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(1200 * (i + 1)); }
  }
  throw new Error(`${label}: ${last?.message ?? last}`);
}
const iso = (unixSecs) => new Date(unixSecs * 1000).toISOString();
const b58 = (v) => (v == null ? null : (typeof v === 'string' ? v : v.toBase58 ? v.toBase58() : String(v)));

// The launch signer (Feature A): pubkey only — the secret never leaves
// the key file; only its address is published, here and in records.
const tagSecret = JSON.parse(fs.readFileSync(path.join(DEPLOY_DIR, 'launcher-tag.json'), 'utf8'));
const LAUNCH_SIGNER = Keypair.fromSecretKey(Uint8Array.from(tagSecret)).publicKey.toBase58();

const recordFiles = fs.readdirSync(DEPLOY_DIR).filter((f) => /^launch-record-.*\.json$/.test(f)).sort();
if (!recordFiles.length) { console.error('no launch records in', DEPLOY_DIR); process.exit(1); }

const problems = [];
const launches = [];
for (const file of recordFiles) {
  const rec = JSON.parse(fs.readFileSync(path.join(DEPLOY_DIR, file), 'utf8'));
  const a = rec.addresses;
  const mint = new PublicKey(a.mint), pool = new PublicKey(a.pool), dbcConfig = new PublicKey(a.dbcConfig);

  // --- reconcile against chain ---
  const poolInfo = await retry(`pool ${a.pool}`, () => conn.getAccountInfo(pool));
  if (!poolInfo) { problems.push(`${rec.symbol}: pool account ${a.pool} NOT FOUND on chain`); continue; }
  if (!poolInfo.owner.equals(new PublicKey(rec.programs.dbc))) problems.push(`${rec.symbol}: pool owner ${poolInfo.owner.toBase58()} != DBC program ${rec.programs.dbc}`);
  const poolState = await retry(`getPool ${a.pool}`, () => client.state.getPool(pool)).then((p) => p?.poolState ?? p);
  const cfg = await retry(`getPoolConfig ${a.dbcConfig}`, () => client.state.getPoolConfig(dbcConfig));
  const chainFeeClaimer = b58(cfg?.feeClaimer);
  if (chainFeeClaimer !== a.feeClaimer) problems.push(`${rec.symbol}: config fee_claimer on chain (${chainFeeClaimer}) != record (${a.feeClaimer})`);

  // metadata URI from the mint itself (chain truth; records can
  // predate a metadata repair — AGTR/Latch/HARVEST all did)
  const md = await retry(`token metadata ${a.mint}`, () => getTokenMetadata(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID));
  const metadataUri = md?.uri ? md.uri : null;
  let image = null;
  if (metadataUri) {
    try {
      const r = await fetch(metadataUri);
      if (r.ok) { const j = await r.json(); image = j.image ?? null; }
    } catch { /* image stays null — the URI itself is the published fact */ }
  }

  // pool creation time from the creation transaction itself
  let poolCreatedAt = null;
  if (rec.signatures?.dbcPool) {
    const tx = await retry(`creation tx ${rec.symbol}`, () => conn.getTransaction(rec.signatures.dbcPool, { maxSupportedTransactionVersion: 0 }));
    if (tx?.blockTime) poolCreatedAt = iso(tx.blockTime);
  }
  if (!poolCreatedAt) problems.push(`${rec.symbol}: could not read the pool-creation timestamp from tx ${rec.signatures?.dbcPool}`);

  // --- truthful status ---
  const isMigrated = Number(poolState?.isMigrated ?? 0) === 1;
  const hasSwap = Number(poolState?.hasSwap ?? 0) === 1;
  const failedSteps = Object.keys(rec.signatures ?? {}).filter((k) => /FAILED/i.test(k));
  const launchComplete = failedSteps.length === 0 && !!rec.signatures?.dbcPool;
  let status, statusDetail = null;
  if (isMigrated) status = 'graduated';
  else if (!launchComplete) {
    status = 'paused';
    statusDetail = 'Launch incomplete: a launch step failed (' + failedSteps.join(', ') + ') and the remaining steps were never sent. '
      + 'For HARVEST EVER specifically: the price-feed crank overflows on this never-graduating curve (engine math bug), so no dev buy or proof buys were sent; '
      + 'the pool is live on its curve with zero trades and trading is paused pending an engine fix. This token is NOT presented as normally trading.';
  } else status = 'bonding';

  // page URL only where a page actually exists in the site tree
  const slug = rec.symbol.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const page = fs.existsSync(path.join(SITE_DIR, 'hooks', slug, 'index.html')) ? `${SITE}/hooks/${slug}/` : null;

  // Graduation: the record block wins; the two earliest records
  // predate it, so fall back to the spec fields they were launched
  // with (AGTR + Latch: release at 42 SOL). For `never`, the threshold
  // is u64::MAX lamports by construction — publish null rather than a
  // meaningless SOL figure; the mode carries the meaning.
  const gradMode = rec.graduation?.mode ?? rec.spec?.graduation ?? 'release';
  const gradThreshold = gradMode === 'never' ? null
    : (rec.graduation?.thresholdSol ?? rec.spec?.migrationThresholdSol ?? null);

  launches.push({
    name: rec.name, symbol: rec.symbol,
    mint: a.mint, pool: a.pool, dbcConfig: a.dbcConfig, engineConfig: a.engineConfig,
    creator: a.launcher, feeClaimer: a.feeClaimer,
    rules: (rec.rules ?? []).map((r) => ({ id: r.id, name: r.name })),
    graduation: { mode: gradMode, thresholdSol: gradThreshold },
    authorityMode: rec.authorityMode ?? null,
    metadataUri, image, page,
    poolCreatedAt,
    creationTx: rec.signatures?.dbcPool ?? null,
    launchComplete, hasSwap, isMigrated,
    status, ...(statusDetail ? { statusDetail } : {}),
  });
  console.log(`${rec.symbol}: pool ok, feeClaimer ok, metadataUri=${metadataUri ?? '(empty on chain)'}, hasSwap=${hasSwap}, migrated=${isMigrated}, status=${status}`);
}

if (problems.length) {
  console.error('\nRECONCILIATION FAILED — feed NOT published:');
  for (const p of problems) console.error(' -', p);
  process.exit(1);
}

launches.sort((x, y) => String(x.poolCreatedAt).localeCompare(String(y.poolCreatedAt)));
const feed = {
  partner: {
    ...PARTNER,
    feeClaimer: launches[0]?.feeClaimer ?? null,
    launchSigner: LAUNCH_SIGNER,
    launchesFeed: FEED_URL,
  },
  generatedAt: new Date().toISOString(),
  count: launches.length,
  launches,
};
fs.mkdirSync(path.dirname(FEED_PATH), { recursive: true });
fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2) + '\n');
console.log(`\nwrote ${FEED_PATH} — ${launches.length} launches`);

if (doDeploy) {
  console.log('redeploying agentonly.fun …');
  execFileSync('python3', [path.join(SITE_DIR, 'deploy.py'), '--redeploy'], { stdio: 'inherit' });
  // verify the LIVE endpoint (the user-facing path, not the local file)
  const live = await retry('live feed fetch', async () => {
    const r = await fetch(FEED_URL, { headers: { 'cache-control': 'no-cache' } });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    return r.json();
  }, 8);
  const syms = (live.launches ?? []).map((l) => l.symbol);
  console.log(`live ${FEED_URL}: 200, ${live.count} launches [${syms.join(', ')}], partner=${live.partner?.name}, launchSigner=${live.partner?.launchSigner}`);
  if (live.count !== launches.length) { console.error('live count mismatch'); process.exit(1); }
}

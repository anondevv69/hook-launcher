// Partner identity creation (discovery fix, Phase A of
// deploy/PARTNER-REGISTRATION-MAP.md; Gregory delegated the identity
// 2026-10-17: "Make it whatever you want to call it and we have the
// link for it").
//
// Creates the DBC partner-metadata account for the launcher's fee
// claimer (fren) — the on-chain identity record (name / website / logo)
// that indexers resolve a fee claimer, and through it its configs, to.
// Identity: name "AgentOnly", website https://agentonly.fun/hooks/,
// logo https://agentonly.fun/hooks/partner-logo.png (hosted + verified
// live BEFORE the write; this script re-checks before sending).
//
// Modes: `read` (recon only: signer, derived PDA, existing metadata,
// configs by owner) · `write` (create if absent, then read back and
// verify every field from chain; idempotent — a second run reports the
// existing record and sends nothing).
import fs from 'fs';
import os from 'os';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient, derivePartnerMetadata } from '@meteora-ag/dynamic-bonding-curve-sdk';
import bs58 from './node_modules/bs58/index.js';

export const PARTNER_IDENTITY = {
  name: 'AgentOnly',
  website: 'https://agentonly.fun/hooks/',
  logo: 'https://agentonly.fun/hooks/partner-logo.png',
};
const EXPECTED_FREN = 'FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP';

function loadKeypair(path) {
  const raw = fs.readFileSync(path, 'utf8').trim();
  try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))); } catch {}
  return Keypair.fromSecretKey(bs58.decode(raw));
}

// Robust sender — same pattern as launch.mjs makeSender (HTTP send +
// status polling, processed blockhash + skipPreflight).
function makeSender(rpcUrl) {
  const rpc = async (method, params) => {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json();
        if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error));
        return j.result;
      } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); }
    }
    throw lastErr;
  };
  return async function sendTx(tx, signers, label) {
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = (await rpc('getLatestBlockhash', [{ commitment: 'processed' }])).value.blockhash;
    tx.sign(...signers);
    const sig = await rpc('sendTransaction', [tx.serialize().toString('base64'), { encoding: 'base64', skipPreflight: true, maxRetries: 5 }]);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const st = (await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }])).value[0];
      if (st) {
        if (st.err) throw new Error(label + ' failed on-chain: ' + JSON.stringify(st.err) + ' (sig ' + sig + ')');
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') { console.log('ok', label, sig); return sig; }
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error(label + ': not confirmed in 90s (sig ' + sig + ')');
  };
}

const asText = (v) => (v && typeof v.toBase58 === 'function') ? v.toBase58() : String(v);
function printMetadata(md, pda) {
  console.log('partner-metadata account:', pda.toBase58());
  console.log('  name        =', JSON.stringify(md.name));
  console.log('  website     =', JSON.stringify(md.website));
  console.log('  logo        =', JSON.stringify(md.logo));
  console.log('  fee_claimer =', asText(md.feeClaimer ?? md.fee_claimer));
}

const mode = process.argv[2] ?? 'read';
if (!['read', 'write'].includes(mode)) { console.error('usage: node create-partner-metadata.mjs [read|write]'); process.exit(1); }

const fren = loadKeypair(os.homedir() + '/.fren_solana_key');
console.log('signer (fren, fee claimer):', fren.publicKey.toBase58());
if (fren.publicKey.toBase58() !== EXPECTED_FREN) throw new Error(`fren key mismatch: got ${fren.publicKey.toBase58()}, expected ${EXPECTED_FREN} — refusing`);
const launchKpPath = os.homedir() + '/.launch_keypair.json';
if (fs.existsSync(launchKpPath)) {
  const lk = loadKeypair(launchKpPath);
  console.log('launch.mjs default signer (~/.launch_keypair.json):', lk.publicKey.toBase58(), lk.publicKey.equals(fren.publicKey) ? '(same wallet as fren — configs already hang from this fee claimer)' : '(DIFFERENT wallet — see record)');
}

const rpcUrl = process.env.LAUNCH_RPC || 'https://api.mainnet-beta.solana.com';
const conn = new Connection(rpcUrl, 'confirmed');
const client = new DynamicBondingCurveClient(conn, 'confirmed');

const pda = derivePartnerMetadata(fren.publicKey);
console.log('derived partner-metadata PDA:', pda.toBase58());
console.log('fren balance:', (await conn.getBalance(fren.publicKey)) / 1e9, 'SOL');
const acct = await conn.getAccountInfo(pda);
console.log('PDA account:', acct ? `exists — owner ${acct.owner.toBase58()}, ${acct.data.length} bytes, ${acct.lamports} lamports` : 'does not exist yet');
const existing = await client.state.getPartnerMetadata(fren.publicKey);
if (existing) { console.log('existing metadata (SDK decode):'); printMetadata(existing, pda); }

const cfgs = await client.state.getPoolConfigsByOwner(fren.publicKey);
console.log(`pool configs with fee_claimer = fren: ${cfgs.length}`);
for (const c of cfgs) console.log('  config', c.publicKey.toBase58());

if (mode === 'read') { console.log('\nread-only recon complete.'); process.exit(0); }

// ---- write ----
if (existing) { console.log('\npartner metadata already exists — sending nothing (idempotent).'); process.exit(0); }
// The logo must be live BEFORE the on-chain write references it.
{
  const r = await fetch(PARTNER_IDENTITY.logo);
  const ct = r.headers.get('content-type') ?? '';
  console.log('logo live check:', r.status, ct, PARTNER_IDENTITY.logo);
  if (!r.ok || !ct.startsWith('image/')) throw new Error(`logo URL not serving an image (${r.status} ${ct}) — host the logo first; refusing to write a metadata record pointing at a dead logo`);
}
const tx = await client.partner.createPartnerMetadata({
  name: PARTNER_IDENTITY.name, website: PARTNER_IDENTITY.website, logo: PARTNER_IDENTITY.logo,
  feeClaimer: fren.publicKey, payer: fren.publicKey,
});
const sendTx = makeSender(rpcUrl);
const sig = await sendTx(tx, [fren], 'createPartnerMetadata');
console.log('tx:', sig);

// Read back from chain and verify every field verbatim.
const after = await client.state.getPartnerMetadata(fren.publicKey);
if (!after) throw new Error('read-back: getPartnerMetadata returned null after a confirmed tx');
console.log('\nread-back (SDK decode of the on-chain account):');
printMetadata(after, pda);
const acctAfter = await conn.getAccountInfo(pda);
console.log('account:', acctAfter ? `owner ${acctAfter.owner.toBase58()}, ${acctAfter.data.length} bytes, ${acctAfter.lamports} lamports` : 'MISSING');
const ok = after.name === PARTNER_IDENTITY.name && after.website === PARTNER_IDENTITY.website && after.logo === PARTNER_IDENTITY.logo
  && asText(after.feeClaimer ?? after.fee_claimer) === fren.publicKey.toBase58();
if (!ok) throw new Error('read-back field mismatch — see printed values above');
console.log('VERIFIED: name/website/logo/fee_claimer all match the intended identity.');

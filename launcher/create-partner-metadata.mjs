#!/usr/bin/env node
// create-partner-metadata.mjs — create the DBC partner-metadata
// identity for YOUR fee-claimer wallet.
//
// DBC expresses a launchpad/creator identity in exactly one place: the
// partner-metadata account (createPartnerMetadata) that binds a name /
// website / logo to a fee-claimer wallet — its address is a PDA of the
// fee claimer in the DBC program. Indexers resolve a fee claimer, and
// through it its configs, to that record. Any creator whose launches
// name their wallet as fee_claimer should create one for it: the
// launcher refuses a live launch whose launching wallet has none.
//
// Worked example — the AgentOnly platform's own record: name
// "AgentOnly", website https://agentonly.fun/hooks/, logo
// https://agentonly.fun/hooks/partner-logo.png, account
// 6udQdVvbGyGk5BcdEjZoAbqvLWmQsf7F1d1zjDu8ZGmU (created 2026-10-17 —
// see deploy/PARTNER-IDENTITY-2026-10-17.md). Yours is the same shape
// with your own values.
//
// Wallet: env PARTNER_KEYPAIR (path to a keypair JSON or base58 file),
// else LAUNCH_KEYPAIR, else ~/.launch_keypair.json.
// Identity: env PARTNER_NAME / PARTNER_WEBSITE / PARTNER_LOGO.
// RPC: env LAUNCH_RPC, else the public mainnet endpoint.
//
// Modes: `read` (recon only: signer, derived PDA, existing metadata,
// configs by owner; identity env optional) · `write` (all three
// identity env vars REQUIRED — there are no defaults; create if
// absent, then read back and verify every field from chain;
// idempotent — a second run reports the existing record and sends
// nothing). The logo must be live (200 + image/*) BEFORE the write
// references it; this script re-checks before sending.
import fs from 'fs';
import os from 'os';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient, derivePartnerMetadata } from '@meteora-ag/dynamic-bonding-curve-sdk';
import bs58 from 'bs58';

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

// Identity from env. `write` requires all three — no defaults: the
// record is the creator's own identity, not the platform's.
const IDENTITY = {
  name: process.env.PARTNER_NAME,
  website: process.env.PARTNER_WEBSITE,
  logo: process.env.PARTNER_LOGO,
};
if (mode === 'write') {
  const missing = Object.entries(IDENTITY).filter(([, v]) => !v).map(([k]) => 'PARTNER_' + k.toUpperCase());
  if (missing.length) {
    console.error(`write mode requires the identity env vars — missing: ${missing.join(', ')}. Set PARTNER_NAME / PARTNER_WEBSITE / PARTNER_LOGO to your own values (there are no defaults).`);
    process.exit(1);
  }
}

// Wallet: PARTNER_KEYPAIR, else LAUNCH_KEYPAIR, else the launch
// default. Any wallet may create its own identity — no expected
// address is checked anywhere.
const partnerKpPath = process.env.PARTNER_KEYPAIR || process.env.LAUNCH_KEYPAIR || os.homedir() + '/.launch_keypair.json';
if (!fs.existsSync(partnerKpPath)) { console.error(`No keypair at ${partnerKpPath} — set PARTNER_KEYPAIR (or LAUNCH_KEYPAIR) to your fee-claimer keypair file (keypair JSON or base58).`); process.exit(1); }
const signer = loadKeypair(partnerKpPath);
console.log('signer (fee claimer):', signer.publicKey.toBase58());
// Informational: how this wallet relates to the launch keypair file
// launch.mjs uses by default (same wallet = configs launched with the
// default keypair already hang from this fee claimer).
const launchKpPath = process.env.LAUNCH_KEYPAIR || os.homedir() + '/.launch_keypair.json';
if (fs.existsSync(launchKpPath) && launchKpPath !== partnerKpPath) {
  const lk = loadKeypair(launchKpPath);
  console.log('launch.mjs default signer (LAUNCH_KEYPAIR / ~/.launch_keypair.json):', lk.publicKey.toBase58(), lk.publicKey.equals(signer.publicKey) ? '(same wallet as the partner signer)' : '(DIFFERENT wallet — the identity created here belongs to the partner signer, not the launch default)');
} else if (launchKpPath === partnerKpPath) {
  console.log('partner signer IS the launch.mjs default signer (same keypair file) — configs launched with it hang from this fee claimer.');
}

const rpcUrl = process.env.LAUNCH_RPC || 'https://api.mainnet-beta.solana.com';
const conn = new Connection(rpcUrl, 'confirmed');
const client = new DynamicBondingCurveClient(conn, 'confirmed');

const pda = derivePartnerMetadata(signer.publicKey);
console.log('derived partner-metadata PDA:', pda.toBase58());
console.log('signer balance:', (await conn.getBalance(signer.publicKey)) / 1e9, 'SOL');
const acct = await conn.getAccountInfo(pda);
console.log('PDA account:', acct ? `exists — owner ${acct.owner.toBase58()}, ${acct.data.length} bytes, ${acct.lamports} lamports` : 'does not exist yet');
const existing = await client.state.getPartnerMetadata(signer.publicKey);
if (existing) { console.log('existing metadata (SDK decode):'); printMetadata(existing, pda); }

const cfgs = await client.state.getPoolConfigsByOwner(signer.publicKey);
console.log(`pool configs with fee_claimer = signer: ${cfgs.length}`);
for (const c of cfgs) console.log('  config', c.publicKey.toBase58());

if (mode === 'read') { console.log('\nread-only recon complete.'); process.exit(0); }

// ---- write ----
if (existing) { console.log('\npartner metadata already exists — sending nothing (idempotent).'); process.exit(0); }
// The logo must be live BEFORE the on-chain write references it.
{
  const r = await fetch(IDENTITY.logo);
  const ct = r.headers.get('content-type') ?? '';
  console.log('logo live check:', r.status, ct, IDENTITY.logo);
  if (!r.ok || !ct.startsWith('image/')) throw new Error(`logo URL not serving an image (${r.status} ${ct}) — host the logo first; refusing to write a metadata record pointing at a dead logo`);
}
const tx = await client.partner.createPartnerMetadata({
  name: IDENTITY.name, website: IDENTITY.website, logo: IDENTITY.logo,
  feeClaimer: signer.publicKey, payer: signer.publicKey,
});
const sendTx = makeSender(rpcUrl);
const sig = await sendTx(tx, [signer], 'createPartnerMetadata');
console.log('tx:', sig);

// Read back from chain and verify every field verbatim.
const after = await client.state.getPartnerMetadata(signer.publicKey);
if (!after) throw new Error('read-back: getPartnerMetadata returned null after a confirmed tx');
console.log('\nread-back (SDK decode of the on-chain account):');
printMetadata(after, pda);
const acctAfter = await conn.getAccountInfo(pda);
console.log('account:', acctAfter ? `owner ${acctAfter.owner.toBase58()}, ${acctAfter.data.length} bytes, ${acctAfter.lamports} lamports` : 'MISSING');
const ok = after.name === IDENTITY.name && after.website === IDENTITY.website && after.logo === IDENTITY.logo
  && asText(after.feeClaimer ?? after.fee_claimer) === signer.publicKey.toBase58();
if (!ok) throw new Error('read-back field mismatch — see printed values above');
console.log('VERIFIED: name/website/logo/fee_claimer all match the intended identity.');

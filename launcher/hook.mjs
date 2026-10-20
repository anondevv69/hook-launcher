#!/usr/bin/env node
// hook.mjs — Hook Launcher agent CLI: trade and inspect ruled tokens launched
// by launch.mjs. Single file; deps: @solana/web3.js, @solana/spl-token,
// @meteora-ag/dynamic-bonding-curve-sdk, bn.js.
//
//   node hook.mjs init                       create your wallet (~/.hook_keypair.json, mode 600)
//   node hook.mjs address                    print your wallet address
//   node hook.mjs register [--kind agent]    register this wallet in the Registry (rule 3 substrate)
//   node hook.mjs sync                       mirror your registry state into this token's Holder PDA
//   node hook.mjs status [--json]            rules on the token, your basis/latch, your claimable fees
//   node hook.mjs buy <SOL>                  buy on the token's DBC curve (ATA pre-created, settles bundled)
//   node hook.mjs sell <TOKENS>              sell on the curve (basis-latch rules may veto — see status first)
//   node hook.mjs flow buy <record> <SOL>    ONE-FLOW buy: preflight → register (if needed) → sync (if needed)
//                                            → ATA (if needed) → buy, all in one process, idempotent steps
//   node hook.mjs flow sell <record> <TOKENS|all>
//                                            ONE-FLOW sell: preflight → settle+sell → balances, in one process
//   node hook.mjs send <TOKENS> <wallet>     wallet-to-wallet send (prepends the rule-8 gate sync when needed)
//   node hook.mjs claim                      claim your accrued holder fees from the Distributor
//   node hook.mjs claim-fees                 DEPLOYER: claim the token's accrued curve fees from Meteora;
//                                            on holder-fee tokens also convert + route into the
//                                            Distributor vault + crank the fold (one command)
//   node hook.mjs crank-fees [--sources a,b] permissionless distributor crank (earns the caller cut)
//   node hook.mjs crank-price                refresh the token's price feed (house/DAMM-style pools)
//   node hook.mjs migrate                    ENGINE v3: migrate your legacy owner-keyed Holder PDA to the
//                                            account-keyed address (verbatim copy; post-upgrade repair)
//   node hook.mjs merge <token account>      ENGINE v3: merge another of your token accounts' holder
//                                            record into your ATA's record (source record closes)
//
// Token context comes from a launch record (launch.mjs output):
//   --record <path>  or env HOOK_RECORD  (default ./launch-record.json)
// Env: HOOK_KEYPAIR (default ~/.hook_keypair.json), HOOK_RPC (default public mainnet RPC).
import fs from 'fs';
import os from 'os';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createTransferCheckedWithTransferHookInstruction, createSyncNativeInstruction,
} from '@solana/spl-token';
import { parseHouseSlot, resolveVenue, buildHouseSwapIx, housePoolPda, recordHasRule2 } from './doors.mjs';
import BN from 'bn.js';
import { DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';

process.on('uncaughtException', (e) => { console.error('hook error:', e.message); process.exit(1); });

const RPC = process.env.HOOK_RPC || 'https://api.mainnet-beta.solana.com';
const KEY_PATH = process.env.HOOK_KEYPAIR || os.homedir() + '/.hook_keypair.json';
const T22 = TOKEN_2022_PROGRAM_ID;
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const IX_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const SCALE = 10n ** 12n;

const RULE_NAMES = { 1: 'Basis Latch', 3: 'Agent-Only', 7: 'P2P Toggle', 8: 'Holder-Gated', 9: 'Max Wallet', 17: 'Ecosystem Gate' };
// Engine custom errors (engine/src/lib.rs EngineError + wave-1 additions, BUILD-NOTES.md)
const ENGINE_ERRORS = {
  1: 'NotRegistered — the receiving wallet has no active registry mirror for this token. Run: node hook.mjs register, then node hook.mjs sync.',
  2: 'MaxWalletExceeded — this receive would put the destination over the token\'s max-wallet cap.',
  3: 'BadCaller — the hook rejected the call context (not a genuine Token-2022 transfer / allowlisted venue swap).',
  4: 'BadConfig — the token\'s engine config is missing or corrupt.',
  5: 'ConfigLocked — this token\'s config is Locked; nobody can change its rules.',
  6: 'BadAuthority — the signer is not this config\'s authority.',
  7: 'UnknownRule — the config references a rule this engine build cannot enforce.',
  8: 'UnsupportedMode — HolderVote config writes need the vote program (not in this build).',
  9: 'HolderMissing — required holder state is absent and could not be created here.',
  10: 'BadState — a state account is foreign-owned or corrupt.',
  11: 'MathOverflow — on-chain math overflow (report this).',
  12: 'InvalidMode — authority_mode byte out of range.',
  13: 'RentVaultUnderfunded — the token\'s rent vault cannot pay for a new Holder PDA. The launcher must top it up before new wallets can receive.',
  14: 'AlreadyInit — this state was already initialized.',
  15: 'Locked (Basis Latch) — the sender is locked: price is at/above their entry basis and no dip below basis has latched them yet. This is the token working as designed — wait for a dip, then any sell works forever.',
  16: 'StalePrice — the price feed is stale; rule-1 exits fail closed. Anyone can refresh it: node hook.mjs crank-price.',
  17: 'BasisMissing — the sender has no basis record (their tokens did not arrive through a basis-recording buy).',
  18: 'PriceFeedBad — the price feed is uninitialized or its pinned vaults are empty.',
  19: 'NotGateHolder — the destination does not hold enough of the gate token (rule 8).',
  20: 'VenueTransferForbidden — rule 7 is P2P-only: venue transfers are vetoed.',
  21: 'P2PTransferForbidden — rule 7 is No-P2P: wallet-to-wallet transfers are vetoed; trade on the venue.',
  22: 'BadRegistration — the registration account presented to sync is invalid (wrong PDA/owner/tag). Fail-closed by design.',
  23: 'BadGateAccount — the account presented to the gate sync is not the owner\'s canonical gate ATA.',
  24: 'WrongEcosystem — the destination is registered, but not attested for the ecosystem this token requires (rule 17).',
  25: 'PartialLocked — the sender\'s graduated-latch earned cap does not cover this sell yet (rule 1 GRADUATED).',
  26: 'MissingExtra — the transfer did not carry an extra account this token\'s rules require. Usually a stale meta list after a config update: the operator must run the engine\'s RefreshExtraAccountMetas (tag 9); hook.mjs has no config-update path, so this is an operator-side repair, not a wallet action.',
};
const DIST_ERRORS = { 8: 'Insolvent (distributor) — defensive; should be unreachable, report it.', 9: 'MathOverflow (distributor).', 10: 'FundModeMismatch — fee-source accounts were passed to a routed-mode (mode 1) distributor; mode 1 takes none.' };
const REGISTRY_ERRORS = { 1: 'AlreadyRegistered — this wallet already has a registration.', 2: 'NotRegistered (registry) — no registration exists for this wallet.', 4: 'BadKind — kind must be 0 (human) or 1 (agent).' };

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = argv.slice(1).filter(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--record' && argv[argv.indexOf(a) - 1] !== '--sources');
const recIdx = argv.indexOf('--record');
let recordPath = recIdx >= 0 ? argv[recIdx + 1] : (process.env.HOOK_RECORD || './launch-record.json');
const srcIdx = argv.indexOf('--sources');
const sourcesArg = srcIdx >= 0 ? argv[srcIdx + 1] : null;
const asJson = argv.includes('--json');
const kindArg = (() => { const i = argv.indexOf('--kind'); return i >= 0 ? argv[i + 1] : 'agent'; })();

function loadRecord() {
  if (!fs.existsSync(recordPath)) throw new Error(`no launch record at ${recordPath} — pass --record <path> (launch.mjs writes one per launch)`);
  return JSON.parse(fs.readFileSync(recordPath, 'utf8'));
}
function ctx() {
  const rec = loadRecord();
  const P = (s) => new PublicKey(s);
  const programs = {
    engine: P(rec.programs.engine), registry: P(rec.programs.registry),
    distributor: P(rec.programs.distributor), dbc: P(rec.programs.dbc),
  };
  const mint = P(rec.addresses.mint);
  const pdaE = (seeds) => PublicKey.findProgramAddressSync(seeds, programs.engine)[0];
  return {
    rec, programs, mint, decimals: rec.decimals ?? 6,
    pool: P(rec.addresses.pool), poolAuthority: P(rec.addresses.poolAuthority),
    baseVault: P(rec.addresses.baseVault), quoteVault: P(rec.addresses.quoteVault),
    dbcConfig: P(rec.addresses.dbcConfig),
    configPda: pdaE([Buffer.from('config'), mint.toBuffer()]),
    pricePda: pdaE([Buffer.from('price'), mint.toBuffer()]),
    metaPda: pdaE([Buffer.from('extra-account-metas'), mint.toBuffer()]),
    rentVaultPda: pdaE([Buffer.from('rentvault'), mint.toBuffer()]),
    // v2 (live) derivation: the Holder PDA is keyed by the OWNER.
    holderPda: (owner) => pdaE([Buffer.from('holder'), mint.toBuffer(), owner.toBuffer()]),
    // v3 derivation: the Holder PDA is keyed by the TOKEN ACCOUNT.
    holderPdaV3: (acct) => pdaE([Buffer.from('holder'), mint.toBuffer(), acct.toBuffer()]),
    distState: rec.addresses.distributor ? P(rec.addresses.distributor.state) : null,
    distVault: rec.addresses.distributor ? P(rec.addresses.distributor.vault) : null,
    claimPda: (holder) => PublicKey.findProgramAddressSync([Buffer.from('claim'), mint.toBuffer(), holder.toBuffer()], programs.distributor)[0],
    regPda: (wallet) => PublicKey.findProgramAddressSync([Buffer.from('registration'), wallet.toBuffer()], programs.registry)[0],
    ata: (owner) => getAssociatedTokenAddressSync(mint, owner, true, T22),
    rules: rec.rules ?? [],
  };
}
const hasRule = (c, id) => c.rules.some(r => r.id === id && r.enabled !== false);

// ---------- holder derivation mode (v2 owner-keyed vs v3 account-keyed) ----------
// The engine generation a token runs is READ FROM ITS PUBLISHED META
// LIST — the ground truth the resolver itself uses: a holder entry
// seeded with AccountData (disc 4) means the v2 engine (owner-keyed
// records; every token live today), an entry seeded with AccountKey
// (disc 3) means the v3 engine (account-keyed records). No list (or no
// holder entries) → v2, the only deployed generation.
let _holderMode = null;
async function holderMode(c) {
  if (_holderMode) return _holderMode;
  _holderMode = 'v2';
  const info = await conn.getAccountInfo(c.metaPda);
  if (info) {
    const raw = info.data, count = raw.readUInt32LE(12);
    for (let i = 0; i < count; i++) {
      const o = 16 + i * 35;
      if (raw[o] !== 1) continue; // seeded entries only
      const cfg = raw.subarray(o + 1, o + 33);
      // first seed: literal "holder"?
      if (cfg[0] !== 1 || cfg[1] !== 6 || cfg.subarray(2, 8).toString() !== 'holder') continue;
      let j = 8;
      while (j < 32 && cfg[j] !== 0) {
        const d = cfg[j];
        if (d === 4) { _holderMode = 'v2'; return _holderMode; }
        if (d === 3) { _holderMode = 'v3'; return _holderMode; }
        if (d === 1) j += 2 + cfg[j + 1];
        else if (d === 2) j += 3;
        else break;
      }
    }
  }
  return _holderMode;
}
// The Holder PDA holding `owner`'s record for this token, per its
// published derivation: v2 → keyed by the owner; v3 → keyed by the
// owner's canonical ATA (the account SyncRegistered mirrors into).
async function holderFor(c, owner) {
  return (await holderMode(c)) === 'v3' ? c.holderPdaV3(c.ata(owner)) : c.holderPda(owner);
}

// ---------- wallet / sender (th.mjs ergonomics: processed blockhash +
// skipPreflight + HTTP status polling; websocket confirmation is unreliable) ----------
function loadWallet() {
  if (!fs.existsSync(KEY_PATH)) { console.error('No keypair at ' + KEY_PATH + ' — run: node hook.mjs init'); process.exit(1); }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'))));
}
const rpc = async (method, params) => {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error));
      return j.result;
    } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); }
  }
  throw lastErr;
};
const conn = new Connection(RPC, 'confirmed');
async function explainFailure(sig) {
  try {
    const tx = await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'json' }]);
    const logs = tx?.meta?.logMessages ?? [];
    let program = null, code = null;
    for (const line of logs) {
      const inv = line.match(/^Program (\w{32,44}) invoke/);
      if (inv) program = inv[1];
      const m = line.match(/custom program error: 0x([0-9a-f]+)/i);
      if (m) code = parseInt(m[1], 16);
    }
    if (code == null) return '';
    const table = program === loadRecord().programs.engine ? ENGINE_ERRORS
      : program === loadRecord().programs.distributor ? DIST_ERRORS
      : program === loadRecord().programs.registry ? REGISTRY_ERRORS : null;
    const known = table?.[code];
    return known ? `\n  → ${known}` : `\n  → program ${program} custom error ${code}`;
  } catch { return ''; }
}
async function sendAndConfirm(tx, signers, label) {
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await rpc('getLatestBlockhash', [{ commitment: 'processed' }])).value.blockhash;
  tx.sign(...signers);
  const sig = await rpc('sendTransaction', [tx.serialize().toString('base64'), { encoding: 'base64', skipPreflight: true, maxRetries: 5 }]);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const st = (await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }])).value[0];
    if (st) {
      if (st.err) throw new Error(label + ' failed on-chain: ' + JSON.stringify(st.err) + ' (sig ' + sig + ')' + (await explainFailure(sig)));
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') { console.log('ok', label, sig); return sig; }
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(label + ': not confirmed in 90s (sig ' + sig + ')');
}
const K = (pubkey, w, s) => ({ pubkey, isSigner: !!s, isWritable: !!w });
const u128 = (buf, off) => buf.readBigUInt64LE(off) + (buf.readBigUInt64LE(off + 8) << 64n);
const fmt = (raw, dec) => (Number(raw) / 10 ** dec).toLocaleString(undefined, { maximumFractionDigits: dec });

// ---------- instruction builders ----------
const registerIx = (c, me, kind) => new TransactionInstruction({
  programId: c.programs.registry, data: Buffer.from([0, kind]),
  keys: [K(me.publicKey, true, true), K(c.regPda(me.publicKey), true), K(SystemProgram.programId)],
});
const syncIx = (c, me, holderKey) => new TransactionInstruction({ // SyncRegistered path (b): registration PDA appended @6
  programId: c.programs.engine, data: Buffer.from([4, 0]),
  keys: [K(me.publicKey, true, true), K(c.mint), K(c.configPda), K(me.publicKey), K(holderKey, true), K(SystemProgram.programId), K(c.regPda(me.publicKey))],
});
const syncGateIx = (c, me, gateAcct, destAta, holderKey) => new TransactionInstruction({
  programId: c.programs.engine, data: Buffer.from([7]),
  keys: [K(me.publicKey, true, true), K(c.mint), K(c.configPda), K(me.publicKey), K(holderKey, true), K(SystemProgram.programId), K(gateAcct), K(destAta), K(IX_SYSVAR)],
});
// Amount currently sitting in an arbitrary token account (0 if it does not
// exist yet). Used as the resolution amount for hook extras — an upper bound
// is fine: the engine's extras are PDAs derived from mint + account owners,
// so the resolved meta set is identical for any amount.
const tokenAcctRaw = async (acct) => {
  const info = await conn.getAccountInfo(acct);
  return info ? info.data.readBigUInt64LE(64) : 0n;
};
// Hook extras for a Distributor PAYOUT transfer (vault → recipient, authority
// = distributor state PDA). The distributor program forwards trailing
// accounts to its payout TransferChecked CPI (distributor/HOOK-EXTRAS-FIX.md),
// so the client must append the transfer hook's resolved extras exactly the
// way it does for a plain transfer: build the transfer with spl-token's
// hook-aware helper and take the keys after the first 4
// [source, mint, dest, authority]. A mint with no transfer hook resolves to
// a plain 4-key instruction → no trailing keys → [].
async function hookExtras(c, source, dest, authority, amount) {
  const ix = await createTransferCheckedWithTransferHookInstruction(conn, source, c.mint, dest, authority, amount, c.decimals, [], 'confirmed', T22);
  return ix.keys.slice(4).map(k => K(k.pubkey, k.isWritable, false));
}
const settleIx = async (c, payer, holder, holderAta) => new TransactionInstruction({
  programId: c.programs.distributor, data: Buffer.from([3]),
  keys: [K(payer.publicKey, true, true), K(holder), K(holderAta, true), K(c.mint), K(c.distState, true), K(c.distVault, true), K(c.claimPda(holder), true), K(T22), K(SystemProgram.programId),
    // [9..] hook extras for the payout transfer vault → holderAta (appended
    // unconditionally: the program ignores them when entitlement is 0)
    ...(await hookExtras(c, c.distVault, holderAta, c.distState, await tokenAcctRaw(holderAta)))],
});
const claimIx = async (c, me) => new TransactionInstruction({
  programId: c.programs.distributor, data: Buffer.from([2]),
  keys: [K(me.publicKey, true, true), K(me.publicKey), K(c.ata(me.publicKey), true), K(c.mint), K(c.distState, true), K(c.distVault, true), K(c.claimPda(me.publicKey), true), K(T22), K(SystemProgram.programId),
    // [9..] hook extras for the payout transfer vault → my ATA
    ...(await hookExtras(c, c.distVault, c.ata(me.publicKey), c.distState, await tokenAcctRaw(c.ata(me.publicKey))))],
});
async function settlesFor(c, me, counterparty) {
  // Settle-before-transfer (distributor INTEGRATION.md): source AND destination
  // settle in the same transaction, BEFORE the transfer, on pre-transfer balances.
  if (!c.distState) return [];
  return [
    await settleIx(c, me, me.publicKey, c.ata(me.publicKey)),
    await settleIx(c, me, counterparty, counterparty.equals(c.poolAuthority) ? c.baseVault : c.ata(counterparty)),
  ];
}

// ---------- shared swap path (buy/sell branches + the flow pipelines) ----------
async function doSwap(c, me, isBuy, uiAmount, rawIn = null) {
  const myAta = c.ata(me.publicKey);
  // L6 (DBC-INTEGRATION): under the v2 engine's meta list the swap
  // builder resolves hook metas from the destination ATA's owner field —
  // the ATA must EXIST before the build. Engine v3 lists derive from the
  // ATA address alone and no longer need this; the pre-create is kept
  // because this CLI serves both generations (and the position account
  // has to exist to receive anyway).
  if (!(await conn.getAccountInfo(myAta))) {
    await sendAndConfirm(new Transaction().add(createAssociatedTokenAccountInstruction(me.publicKey, myAta, me.publicKey, c.mint, T22)), [me], 'create my ATA (required before first swap build)');
  }
  const client = new DynamicBondingCurveClient(conn, 'confirmed');
  const tx = await client.pool.swap2WithTransferHook({
    swapMode: SwapMode.ExactIn, swapBaseForQuote: !isBuy,
    amountIn: new BN(rawIn ?? (isBuy ? Math.round(uiAmount * LAMPORTS_PER_SOL) : Math.round(uiAmount * 10 ** c.decimals))),
    minimumAmountOut: new BN(0), owner: me.publicKey, pool: c.pool, referralTokenAccount: null, payer: me.publicKey,
  });
  const pre = await settlesFor(c, me, c.poolAuthority); // settle dst (buy: me / sell: pool) + src before the transfer
  if (pre.length) tx.instructions = [...pre, ...tx.instructions];
  return sendAndConfirm(tx, [me], isBuy ? 'buy' : 'sell');
}
// ---------- house door (Phase C) ----------
// When the token's LIVE engine config carries an ACTIVATED house slot,
// buy/sell route to the house pool instead of the curve (doors.mjs
// resolveVenue — doors default to house; the curve stays the legacy
// door for pending / uncommitted tokens). The house swap is a single
// houseswap Swap instruction: the user's quote account is their wSOL
// ATA (created if needed; a buy wraps the spent SOL into it first),
// and the hook tail is resolved from the mint's meta list by doors.mjs.
async function doHouseSwap(c, me, isBuy, uiAmount, rawIn = null, slot) {
  const myAta = c.ata(me.publicKey);
  if (!(await conn.getAccountInfo(myAta))) {
    await sendAndConfirm(new Transaction().add(createAssociatedTokenAccountInstruction(me.publicKey, myAta, me.publicKey, c.mint, T22)), [me], 'create my ATA (required before first swap build)');
  }
  const myQuoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, me.publicKey, false, TOKEN_PROGRAM_ID);
  if (!(await conn.getAccountInfo(myQuoteAta))) {
    await sendAndConfirm(new Transaction().add(createAssociatedTokenAccountInstruction(me.publicKey, myQuoteAta, me.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID)), [me], 'create my wSOL ATA (house door quote account)');
  }
  const amountInRaw = BigInt(rawIn ?? (isBuy ? Math.round(uiAmount * LAMPORTS_PER_SOL) : Math.round(uiAmount * 10 ** c.decimals)));
  // A rule-2 house swap resolves its escrow inside the swap instruction
  // and exceeds the default CU budget (ComputationalBudgetExceeded on
  // the HPROOF proof sell, 2026-10-20) — carry the 1.4M budget the
  // proven driver used (deploy/proof-launches/house-trade.mjs).
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
  if (isBuy) {
    ixs.push(SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: myQuoteAta, lamports: Number(amountInRaw) }));
    ixs.push(createSyncNativeInstruction(myQuoteAta));
  }
  const poolPda = housePoolPda(slot.program, c.mint);
  ixs.push(...(await settlesFor(c, me, poolPda))); // distributor settles, counterparty = house pool (its ATA IS the token vault)
  ixs.push(await buildHouseSwapIx(conn, { record: c.rec, slot, isBuy, user: me.publicKey, amountInRaw }));
  if (!isBuy && recordHasRule2(c.rec)) {
    // Venue sync note (houseswap INTEGRATION): after a rule-2 sell the
    // depth share sits in the house quote vault as raw lamports — the
    // venue does NOT SyncNative in-program, so the caller's transaction
    // MUST append a top-level SyncNative for the pool's quote vault
    // (its canonical wSOL ATA, as created at H1) or the share stays
    // invisible to the vault's token amount.
    const houseQuoteVault = getAssociatedTokenAddressSync(NATIVE_MINT, poolPda, true, TOKEN_PROGRAM_ID);
    ixs.push(createSyncNativeInstruction(houseQuoteVault));
  }
  return sendAndConfirm(new Transaction().add(...ixs), [me], isBuy ? 'buy (house)' : 'sell (house)');
}
// Venue routing wrapper: every swap path (buy/sell + both flows) goes
// through here, so the door choice is made ONCE, from live config bytes.
async function doSwapRouted(c, me, isBuy, uiAmount, rawIn = null) {
  const cfgInfo = await conn.getAccountInfo(c.configPda);
  const slot = cfgInfo ? parseHouseSlot(cfgInfo.data) : null;
  if (slot && slot.state === 2) {
    console.log(`door: HOUSE (activated) — routing this ${isBuy ? 'buy' : 'sell'} to the house pool; the curve stays available as the legacy door`);
    return doHouseSwap(c, me, isBuy, uiAmount, rawIn, slot);
  }
  if (slot) console.log(`door: curve — house committed but not yet activated (state ${slot.state}); the curve is still the only door`);
  return doSwap(c, me, isBuy, uiAmount, rawIn);
}
const solRaw = async (pubkey) => BigInt((await rpc('getBalance', [pubkey.toBase58()])).value);
const tokenRaw = async (c, owner) => {
  const info = await conn.getAccountInfo(c.ata(owner));
  return info ? info.data.readBigUInt64LE(64) : 0n;
};

// ---------- commands ----------
if (cmd === 'init') {
  if (fs.existsSync(KEY_PATH)) { console.log('Keypair already exists:', loadWallet().publicKey.toBase58()); process.exit(0); }
  const kp = Keypair.generate();
  fs.writeFileSync(KEY_PATH, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log('Wallet created:', kp.publicKey.toBase58());
  console.log('Key file:', KEY_PATH, '(mode 600 — never share it, never paste it anywhere)');
  console.log('Fund it with a little SOL on Solana mainnet, then: node hook.mjs register');
} else if (cmd === 'address') {
  console.log(loadWallet().publicKey.toBase58());
} else if (cmd === 'register') {
  const me = loadWallet(); const c = ctx();
  const kind = kindArg === 'human' ? 0 : 1;
  await sendAndConfirm(new Transaction().add(registerIx(c, me, kind)), [me], 'register');
  console.log(`Registered as ${kind === 1 ? 'Agent' : 'Human'}. For Agent-Only tokens, mirror it per token: node hook.mjs sync`);
} else if (cmd === 'sync') {
  const me = loadWallet(); const c = ctx();
  await sendAndConfirm(new Transaction().add(syncIx(c, me, await holderFor(c, me.publicKey))), [me], 'sync registration mirror');
} else if (cmd === 'status') {
  const me = loadWallet(); const c = ctx();
  const myHolderPda = await holderFor(c, me.publicKey);
  const [cfgInfo, holderInfo, feedInfo, regInfo, myAtaInfo] = await Promise.all([
    conn.getAccountInfo(c.configPda), conn.getAccountInfo(myHolderPda),
    conn.getAccountInfo(c.pricePda), conn.getAccountInfo(c.regPda(me.publicKey)),
    conn.getAccountInfo(c.ata(me.publicKey)),
  ]);
  if (!cfgInfo) throw new Error('engine config PDA not found for this mint — wrong record or unlaunched token');
  const d = cfgInfo.data;
  const modeNames = ['Locked', 'Creator', 'Agent', 'HolderVote'];
  const ruleCount = d[3];
  const rules = [];
  for (let i = 0; i < ruleCount; i++) {
    const o = 462 + i * 68, id = d.readUInt16LE(o), enabled = d[o + 2] === 1, params = d.subarray(o + 4, o + 68);
    let detail = '';
    if (id === 1) detail = `mode=${params[18] === 1 ? 'LIVE' : 'LATCH'}, max stale ${params.readBigUInt64LE(0) || 300n}s`;
    if (id === 7) detail = params[0] === 1 ? 'No-P2P (venue-only)' : 'P2P-only (no venue)';
    if (id === 8) detail = `hold ≥ ${params.readBigUInt64LE(32)} raw of ${new PublicKey(params.subarray(0, 32)).toBase58()}`;
    if (id === 9) detail = `cap ${params.readUInt16LE(0)} bps of supply`;
    if (id === 17) { const ecoNames = { 1: 'Muse', 2: 'FOMO', 3: 'Claude', 4: 'Grok' }; detail = `required ecosystem: ${ecoNames[params[0]] ?? `ecosystem ${params[0]}`}`; }
    rules.push({ id, name: RULE_NAMES[id] ?? `rule ${id}`, enabled, detail });
  }
  const myBalance = myAtaInfo ? myAtaInfo.data.readBigUInt64LE(64) : 0n;
  // Venue (Phase C doors): read the house slot from the live config and,
  // for a pending house token, the curve's progress toward the house
  // threshold (DBC pool quote_reserve @240 vs the slot threshold).
  const houseSlot = parseHouseSlot(d);
  let venueLine = null;
  if (houseSlot) {
    const dbcPoolInfo = await conn.getAccountInfo(c.pool);
    const v = resolveVenue(c.rec, d, dbcPoolInfo?.data ?? null);
    venueLine = v.venue === 'house'
      ? `house — activated (ts ${houseSlot.activatedTs}); doors default to the house pool, the curve is the legacy door`
      : `curve — house committed, pending activation: threshold progress ${v.progress ? `${(Number(v.progress.quoteReserveLamports) / LAMPORTS_PER_SOL).toFixed(4)} / ${(Number(v.progress.thresholdLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL of curve quote reserve` : 'unknown (pool unreadable)'}`;
  }
  const out = {
    token: `${c.rec.name} (${c.rec.symbol})`, mint: c.mint.toBase58(), pool: c.pool.toBase58(),
    authorityMode: modeNames[d[2]], rules,
    wallet: me.publicKey.toBase58(), balance: fmt(myBalance, c.decimals) + ' ' + c.rec.symbol,
    venue: venueLine ?? 'curve — no house commitment on this token',
  };
  out.registered = regInfo ? (regInfo.data[43] === 1 ? `yes (${regInfo.data[33] === 1 ? 'Agent' : 'Human'})` : 'deactivated') : 'no — run: node hook.mjs register';
  if (holderInfo) {
    out.holderMirror = { registered: holderInfo.data[1] === 1 };
    if (hasRule(c, 1)) {
      const num = u128(holderInfo.data, 6), den = u128(holderInfo.data, 22);
      out.basis = den > 0n ? `${(Number(num) / Number(den)).toFixed(9)} SOL/token (scaled ×1e12: ${num / den})` : 'none';
      out.latched = holderInfo.data[38] === 1;
    }
  }
  if (feedInfo) {
    const ema = u128(feedInfo.data, 97), last = Number(feedInfo.data.readBigInt64LE(113));
    const age = Math.floor(Date.now() / 1000) - last;
    out.priceFeed = { emaSOLperToken: (Number(ema) / 1e12).toFixed(9), lastCrankAgeSecs: age, stale: last === 0 || age > 300 };
    if (hasRule(c, 1) && holderInfo) {
      const num = u128(holderInfo.data, 6), den = u128(holderInfo.data, 22);
      out.exit = holderInfo.data[38] === 1 ? 'UNLOCKED — latched, you can sell any time'
        : ema < (den > 0n ? num / den : 0n) ? 'UNLOCKED — price is below your basis'
        : 'LOCKED — price must dip below your basis (check again after a dip)';
    }
  }
  if (c.distState) {
    const [stInfo, clInfo] = await Promise.all([conn.getAccountInfo(c.distState), conn.getAccountInfo(c.claimPda(me.publicKey))]);
    if (stInfo) {
      const index = u128(stInfo.data, 97);
      const settled = clInfo ? u128(clInfo.data, 65) : 0n; // no Claim PDA + balance > 0 → full history (first-touch rule)
      const claimable = (myBalance * (index - settled)) / SCALE;
      out.holderFees = {
        fundingMode: stInfo.data[140] === 1 ? 'routed (DBC)' : 'transfer-fee harvest',
        index: index.toString(), claimable: fmt(claimable, c.decimals) + ' ' + c.rec.symbol,
      };
    }
  }
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`${out.token} — mint ${out.mint}`);
    console.log(`Rules (authority: ${out.authorityMode}): ${rules.length ? rules.map(r => `${r.name}${r.enabled ? '' : ' (disabled)'}${r.detail ? ' — ' + r.detail : ''}`).join(' · ') : 'none'}`);
    console.log(`Wallet ${out.wallet} — balance ${out.balance}; registered: ${out.registered}${out.holderMirror ? `; mirror on this token: ${out.holderMirror.registered ? 'registered' : 'NOT synced (run: node hook.mjs sync)'}` : ''}`);
    console.log(`Venue: ${out.venue}`);
    if (out.priceFeed) console.log(`Feed: ${out.priceFeed.emaSOLperToken} SOL/token, cranked ${out.priceFeed.lastCrankAgeSecs}s ago${out.priceFeed.stale ? ' (STALE)' : ''}${out.basis ? `; your basis ${out.basis}${out.latched ? ' (LATCHED)' : ''}` : ''}`);
    if (out.exit) console.log('Exit:', out.exit);
    if (out.holderFees) console.log(`Holder fees (${out.holderFees.fundingMode}): claimable now ${out.holderFees.claimable} — node hook.mjs claim`);
  }
} else if (cmd === 'buy' || cmd === 'sell') {
  const me = loadWallet(); const c = ctx();
  const amount = parseFloat(positional[0]);
  if (!(amount > 0)) { console.error(`Usage: node hook.mjs ${cmd} <${cmd === 'buy' ? 'SOL' : 'tokens'}>`); process.exit(1); }
  await doSwapRouted(c, me, cmd === 'buy', amount);
  console.log(`${cmd === 'buy' ? 'Bought' : 'Sold'}. Run: node hook.mjs status`);
} else if (cmd === 'flow') {
  // ONE-FLOW pipelines: every prerequisite runs in-process, in order, and each
  // step is skipped when its on-chain effect already exists. That idempotency
  // IS the resumability — if step N fails, re-running the same command picks
  // up exactly there. Built for sandbox/custodial agents that lose state (or
  // the whole session) between separate register/sync/buy calls.
  const sub = positional[0];
  const rest = positional.slice(1);
  let amountStr = null;
  if (rest[0] && rest[0].endsWith('.json')) { recordPath = rest[0]; amountStr = rest[1]; }
  else amountStr = rest[0];
  if ((sub !== 'buy' && sub !== 'sell') || amountStr == null) {
    console.error('Usage: node hook.mjs flow buy <record.json> <SOL> [--kind agent|human] | flow sell <record.json> <TOKENS|all>');
    process.exit(1);
  }
  const me = loadWallet(); const c = ctx();
  const total = sub === 'buy' ? 5 : 3;
  let stepNo = 0;
  const step = (label) => { stepNo++; console.log(`[flow ${sub} ${stepNo}/${total}] ${label}`); };
  const run = async (label, fn) => {
    step(label);
    try { return await fn(); }
    catch (e) { throw new Error(`flow ${sub} failed at step ${stepNo}/${total} (${label}): ${e.message}\n  → fix the cause and re-run the SAME command — completed steps are skipped, the flow resumes here.`); }
  };
  try {
    if (sub === 'buy') {
      const solAmount = parseFloat(amountStr);
      if (!(solAmount > 0)) throw new Error(`flow buy: <SOL> must be a positive number, got "${amountStr}"`);
      const myAta = c.ata(me.publicKey);
      const regInfo = await conn.getAccountInfo(c.regPda(me.publicKey));
      const needReg = hasRule(c, 3) && !regInfo;
      const holderInfo = await conn.getAccountInfo(await holderFor(c, me.publicKey));
      const needSync = hasRule(c, 3) && !(holderInfo && holderInfo.data[1] === 1);
      const needAta = !(await conn.getAccountInfo(myAta));
      await run('preflight — wallet, balance, pending steps', async () => {
        if (hasRule(c, 3) && regInfo && regInfo.data[43] !== 1) {
          throw new Error('this wallet\'s registry registration exists but is DEACTIVATED — this CLI cannot reactivate it, and the token\'s Agent-Only rule mirrors registered=false.');
        }
        const bal = await solRaw(me.publicKey);
        // pending-step rents: registration PDA ≈0.00123, holder PDA via sync ≈0.00184, ATA ≈0.00204; +0.0001 fee buffer
        let need = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL)) + 100_000n;
        if (needReg) need += 1_230_000n;
        if (needSync) need += 1_840_000n;
        if (needAta) need += 2_040_000n;
        console.log(`  wallet ${me.publicKey.toBase58()} holds ${(Number(bal) / LAMPORTS_PER_SOL).toFixed(6)} SOL; this flow needs ~${(Number(need) / LAMPORTS_PER_SOL).toFixed(6)} SOL (buy ${solAmount} + pending-step rents/fees)`);
        if (bal < need) throw new Error(`insufficient SOL — shortfall ~${(Number(need - bal) / LAMPORTS_PER_SOL).toFixed(6)} SOL. Fund ${me.publicKey.toBase58()} and re-run the same command.`);
      });
      if (needReg) await run('register in the Registry (self-signed)', async () => {
        const kind = kindArg === 'human' ? 0 : 1;
        await sendAndConfirm(new Transaction().add(registerIx(c, me, kind)), [me], 'register');
        console.log(`  registered as ${kind === 1 ? 'Agent' : 'Human'}`);
      }); else step(hasRule(c, 3) ? 'register — already registered, skipped' : 'register — token has no Agent-Only rule, skipped');
      if (needSync) await run('sync registration into this token\'s Holder PDA', async () => {
        await sendAndConfirm(new Transaction().add(syncIx(c, me, await holderFor(c, me.publicKey))), [me], 'sync registration mirror');
      }); else step(hasRule(c, 3) ? 'sync — holder mirror already synced, skipped' : 'sync — token has no Agent-Only rule, skipped');
      if (needAta) await run('create destination ATA (must exist before the swap build)', async () => {
        await sendAndConfirm(new Transaction().add(createAssociatedTokenAccountInstruction(me.publicKey, myAta, me.publicKey, c.mint, T22)), [me], 'create my ATA');
      }); else step('ATA — already exists, skipped');
      let sig;
      await run(`buy ${solAmount} SOL of ${c.rec.symbol} (door resolved live: house once activated, else the curve)`, async () => { sig = await doSwapRouted(c, me, true, solAmount); });
      const bal = await tokenRaw(c, me.publicKey);
      console.log(`flow buy complete — swap ${sig}; balance now ${fmt(bal, c.decimals)} ${c.rec.symbol}`);
    } else {
      let rawIn = null, uiAmount = null;
      await run('preflight — wallet and token balance', async () => {
        const raw = await tokenRaw(c, me.publicKey);
        if (amountStr === 'all') {
          if (raw === 0n) throw new Error(`nothing to sell — this wallet holds 0 ${c.rec.symbol}`);
          rawIn = raw; uiAmount = Number(raw) / 10 ** c.decimals;
        } else {
          uiAmount = parseFloat(amountStr);
          if (!(uiAmount > 0)) throw new Error(`flow sell: <TOKENS|all> must be a positive number or "all", got "${amountStr}"`);
          if (BigInt(Math.round(uiAmount * 10 ** c.decimals)) > raw) throw new Error(`insufficient ${c.rec.symbol} — wallet holds ${fmt(raw, c.decimals)}, asked to sell ${uiAmount}`);
        }
        const sol = await solRaw(me.publicKey);
        if (sol < 50_000n) throw new Error(`insufficient SOL for fees — wallet holds ${(Number(sol) / LAMPORTS_PER_SOL).toFixed(6)} SOL. Fund ${me.publicKey.toBase58()} and re-run the same command.`);
        console.log(`  selling ${amountStr === 'all' ? `all (${fmt(rawIn, c.decimals)} ${c.rec.symbol})` : `${uiAmount} ${c.rec.symbol}`}`);
      });
      let sig;
      await run('sell (door resolved live: house once activated, else the curve; distributor settles bundled for both sides)', async () => { sig = await doSwapRouted(c, me, false, uiAmount, rawIn); });
      const [tokBal, solBal] = await Promise.all([tokenRaw(c, me.publicKey), solRaw(me.publicKey)]);
      step('done');
      console.log(`flow sell complete — swap ${sig}; balances now ${fmt(tokBal, c.decimals)} ${c.rec.symbol}, ${(Number(solBal) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    }
  } catch (e) { console.error('hook error:', e.message); process.exit(1); }
} else if (cmd === 'send') {
  const me = loadWallet(); const c = ctx();
  const amount = parseFloat(positional[0]), destOwner = positional[1] ? new PublicKey(positional[1]) : null;
  if (!(amount > 0) || !destOwner) { console.error('Usage: node hook.mjs send <tokens> <destination wallet>'); process.exit(1); }
  const destAta = c.ata(destOwner);
  const ixs = [];
  if (!(await conn.getAccountInfo(destAta))) ixs.push(createAssociatedTokenAccountInstruction(me.publicKey, destAta, destOwner, c.mint, T22));
  ixs.push(...(await settlesFor(c, me, destOwner)));
  if (hasRule(c, 8)) {
    const gate = c.rules.find(r => r.id === 8);
    const gateMint = new PublicKey(gate.params.gateMint);
    const gateProg = (await conn.getAccountInfo(gateMint))?.owner ?? T22;
    const gateAta = getAssociatedTokenAddressSync(gateMint, destOwner, true, gateProg);
    const gateHolderKey = (await holderMode(c)) === 'v3' ? c.holderPdaV3(destAta) : c.holderPda(destOwner);
    ixs.push(syncGateIx(c, me, gateAta, destAta, gateHolderKey)); // must sit immediately before the transfer
  }
  const xfer = await createTransferCheckedWithTransferHookInstruction(conn, c.ata(me.publicKey), c.mint, destAta, me.publicKey, BigInt(Math.round(amount * 10 ** c.decimals)), c.decimals, [], 'confirmed', T22);
  ixs.push(xfer);
  await sendAndConfirm(new Transaction().add(...ixs), [me], 'send');
} else if (cmd === 'claim') {
  const me = loadWallet(); const c = ctx();
  if (!c.distState) throw new Error('this token has no Distributor (holder fees are off)');
  await sendAndConfirm(new Transaction().add(await claimIx(c, me)), [me], 'claim holder fees');
} else if (cmd === 'crank-fees') {
  const me = loadWallet(); const c = ctx();
  if (!c.distState) throw new Error('this token has no Distributor (holder fees are off)');
  const stInfo = await conn.getAccountInfo(c.distState);
  const mode = stInfo.data[140];
  const myAta = c.ata(me.publicKey);
  if (!(await conn.getAccountInfo(myAta))) {
    await sendAndConfirm(new Transaction().add(createAssociatedTokenAccountInstruction(me.publicKey, myAta, me.publicKey, c.mint, T22)), [me], 'create my ATA (crank cut lands here)');
  }
  const sources = mode === 0 ? (sourcesArg ? sourcesArg.split(',').map(s => new PublicKey(s.trim())) : []) : [];
  if (mode === 1 && sourcesArg) throw new Error('this distributor is routed-mode (mode 1): distribute takes NO fee-source accounts');
  // Mode 1: trailing accounts [6..] are the hook extras for the payout
  // transfer vault → my ATA (the caller cut), resolved against the current
  // vault balance (an upper bound — the fold itself is computed on-chain).
  // Mode 0: trailing accounts remain fee sources — no extras appended.
  const extras = mode === 1 ? await hookExtras(c, c.distVault, myAta, c.distState, await tokenAcctRaw(c.distVault)) : [];
  const ix = new TransactionInstruction({
    programId: c.programs.distributor, data: Buffer.from([1]),
    keys: [K(me.publicKey, false, true), K(c.mint, true), K(c.distState, true), K(c.distVault, true), K(myAta, true), K(T22), ...sources.map(s => K(s, true)), ...extras],
  });
  await sendAndConfirm(new Transaction().add(ix), [me], 'distribute (crank)');
} else if (cmd === 'claim-fees') {
  // THE DEPLOYER'S FEE COMMAND — one run performs the whole fee duty
  // (distributor/INTEGRATION.md path (b)):
  //   1. claim this token's accrued curve fees from Meteora. Only the
  //      launch record's feeClaimer can sign — the DBC program pays the
  //      claimer of record, nobody else. The fee is the curve's trading
  //      fee (rate set at launch); the transfer hook never touches it.
  //   2. destination CREATOR (no Distributor attached): done — SOL yours.
  //      destination HOLDERS (Distributor attached):
  //   3. convert the claimed SOL into the token on its own curve,
  //   4. route the converted tokens into the Distributor vault,
  //   5. crank distribute — the fold lands in every holder's claimable;
  //      you earn the caller cut like any cranker.
  const me = loadWallet(); const c = ctx();
  const claimer = c.rec.addresses.feeClaimer ? new PublicKey(c.rec.addresses.feeClaimer) : null;
  if (!claimer) throw new Error('launch record has no feeClaimer — cannot verify the claimer of record');
  if (!me.publicKey.equals(claimer)) throw new Error(`this wallet (${me.publicKey.toBase58()}) is not the token's fee claimer (${claimer.toBase58()}) — Meteora pays accrued fees only to the claimer of record. Re-run with the claimer keypair: HOOK_KEYPAIR=<claimer keypair> node hook.mjs claim-fees`);
  const client = new DynamicBondingCurveClient(conn, 'confirmed');
  const metrics = await client.state.getPoolFeeMetrics(c.pool);
  const dueQuote = BigInt(metrics.current.partnerQuoteFee.toString());
  const dueBase = BigInt(metrics.current.partnerBaseFee.toString());
  console.log(`accrued curve fees for the claimer: ${fmt(dueQuote, 9)} SOL${dueBase > 0n ? ` + ${fmt(dueBase, c.decimals)} ${c.rec.symbol} (base side)` : ''} (live read from the pool)`);
  if (dueQuote === 0n && dueBase === 0n) { console.log('nothing to claim yet — no fees have accrued since the last claim.'); process.exit(0); }
  // Settle my own holder-fee record first (only if the index has moved),
  // so the token deltas measured below are exactly claim + conversion.
  const stInfo0 = c.distState ? await conn.getAccountInfo(c.distState) : null;
  if (stInfo0 && u128(stInfo0.data, 97) > 0n) {
    await sendAndConfirm(new Transaction().add(await settleIx(c, me, me.publicKey, c.ata(me.publicKey))), [me], 'settle my holder-fee record');
  }
  const tokBefore = await tokenRaw(c, me.publicKey);
  const solBefore = await solRaw(me.publicKey);
  // Hook pools must use the hook-aware claim variant (the SDK refuses the
  // plain one: "Pool uses a transfer hook, use claimPartnerTradingFee2") —
  // the base-side delivery, when a pool collects base fees, moves through
  // the hook like any transfer. Receiver = the claimer itself.
  const claimTx = await client.partner.claimPartnerTradingFee2({
    feeClaimer: me.publicKey, payer: me.publicKey, pool: c.pool, receiver: me.publicKey,
    maxBaseAmount: new BN(dueBase.toString()), maxQuoteAmount: new BN(dueQuote.toString()),
  });
  await sendAndConfirm(claimTx, [me], 'claim curve fees from Meteora');
  const solAfter = await solRaw(me.publicKey);
  const tokAfterClaim = await tokenRaw(c, me.publicKey);
  const claimedBase = tokAfterClaim - tokBefore;
  console.log(`claimed: SOL ${(Number(solBefore) / 1e9).toFixed(6)} → ${(Number(solAfter) / 1e9).toFixed(6)}${claimedBase > 0n ? `; base side delivered ${fmt(claimedBase, c.decimals)} ${c.rec.symbol} to your ATA` : ''}`);
  if (!c.distState) {
    console.log('fee destination: CREATOR — no Distributor on this token; the claimed SOL is the creator fee, yours to keep. Done.');
  } else {
    const reserve = 30_000n; // lamports kept back for the remaining tx fees
    let convert = dueQuote;
    if (solAfter - convert < reserve) convert = solAfter > reserve ? solAfter - reserve : 0n;
    let bought = 0n;
    if (convert > 0n) {
      await doSwap(c, me, true, Number(convert) / LAMPORTS_PER_SOL);
      bought = (await tokenRaw(c, me.publicKey)) - tokAfterClaim;
      console.log(`converted ${fmt(convert, 9)} SOL → ${fmt(bought, c.decimals)} ${c.rec.symbol} on the curve`);
    }
    const routeAmount = claimedBase + bought;
    if (routeAmount === 0n) { console.log('nothing to route (claimed amount was under the fee reserve).'); process.exit(0); }
    // The vault's owner is the Distributor state PDA — it can never
    // self-register, and rule 3 checks the DESTINATION mirror. If the
    // mirror is unset and this claimer is also the config authority, set
    // it via the engine's SyncRegistered authority path (the launch flow
    // performs the same step as L7b on new tokens).
    if (hasRule(c, 3)) {
      const vaultHolderKey = (await holderMode(c)) === 'v3' ? c.holderPdaV3(c.distVault) : c.holderPda(c.distState);
      const vaultHolderInfo = await conn.getAccountInfo(vaultHolderKey);
      if (!(vaultHolderInfo && vaultHolderInfo.data[1] === 1)) {
        const cfgInfo = await conn.getAccountInfo(c.configPda);
        const authority = new PublicKey(cfgInfo.data.subarray(36, 68));
        if (!authority.equals(me.publicKey)) throw new Error(`the Distributor vault's holder mirror is not registered and this wallet is not the token's config authority (${authority.toBase58()}), so it cannot set the mirror. The config authority must run one SyncRegistered for the vault owner before routing can land.`);
        const syncVault = new TransactionInstruction({
          programId: c.programs.engine, data: Buffer.from([4, 1]),
          keys: [K(me.publicKey, true, true), K(c.mint), K(c.configPda), K(c.distState), K(vaultHolderKey, true), K(SystemProgram.programId)],
        });
        await sendAndConfirm(new Transaction().add(syncVault), [me], 'register Distributor vault holder mirror (authority sync)');
      }
    }
    // Route: settle myself first (on my pre-transfer balance), then the
    // transfer into the vault. The vault itself is never settled — its
    // balance IS the undistributed backing the fold accounts against.
    const routeIxs = [await settleIx(c, me, me.publicKey, c.ata(me.publicKey))];
    // NB: the helper's signature is (…, multiSigners, commitment, programId) —
    // passing T22 in the commitment slot silently defaults programId to the
    // LEGACY token program and getMint throws an empty TokenInvalidAccountOwnerError.
    routeIxs.push(await createTransferCheckedWithTransferHookInstruction(conn, c.ata(me.publicKey), c.mint, c.distVault, me.publicKey, routeAmount, c.decimals, [], 'confirmed', T22));
    await sendAndConfirm(new Transaction().add(...routeIxs), [me], `route ${fmt(routeAmount, c.decimals)} ${c.rec.symbol} into the Distributor vault`);
    // Trailing accounts [6..] are the hook extras for the payout transfer
    // vault → my ATA (the caller cut), resolved against the current vault
    // balance (an upper bound — the fold itself is computed on-chain).
    const crankIx = new TransactionInstruction({
      programId: c.programs.distributor, data: Buffer.from([1]),
      keys: [K(me.publicKey, false, true), K(c.mint, true), K(c.distState, true), K(c.distVault, true), K(c.ata(me.publicKey), true), K(T22),
        ...(await hookExtras(c, c.distVault, c.ata(me.publicKey), c.distState, await tokenAcctRaw(c.distVault)))],
    });
    await sendAndConfirm(new Transaction().add(crankIx), [me], 'distribute (crank the fold)');
    const stInfo = await conn.getAccountInfo(c.distState);
    const index = u128(stInfo.data, 97);
    const routedAllTime = stInfo.data.readBigUInt64LE(165);
    const clInfo = await conn.getAccountInfo(c.claimPda(me.publicKey));
    const settled = clInfo ? u128(clInfo.data, 65) : 0n;
    const myBal = await tokenRaw(c, me.publicKey);
    const myClaimable = (myBal * (index - settled)) / SCALE;
    console.log(`fold landed — distributor index ${index}; routed+folded all-time ${fmt(routedAllTime, c.decimals)} ${c.rec.symbol}; your claimable holder fees now ${fmt(myClaimable, c.decimals)} ${c.rec.symbol} (collect with: node hook.mjs claim)`);
    console.log('fee cycle complete: curve fees → claimed → converted → vault → folded to holders.');
  }
} else if (cmd === 'migrate') {
  // ENGINE v3 RETROFIT (per wallet): copy this wallet's legacy
  // owner-keyed Holder PDA verbatim to its v3 account-keyed address and
  // close the legacy account (rent refunds to the token's rent vault).
  // Permissionless on-chain; run it once per token after the v3 upgrade.
  // On a v2 token the engine rejects tag 10 — nothing happens.
  const me = loadWallet(); const c = ctx();
  const myAta = c.ata(me.publicKey);
  if (!(await conn.getAccountInfo(myAta))) throw new Error('no ATA for this token — nothing to migrate (a holder record can only exist for an account that received)');
  const legacy = c.holderPda(me.publicKey);
  const legacyInfo = await conn.getAccountInfo(legacy);
  if (!legacyInfo) { console.log('no legacy (owner-keyed) holder record for this wallet on this token — nothing to migrate.'); process.exit(0); }
  const ix = new TransactionInstruction({
    programId: c.programs.engine, data: Buffer.from([10]),
    keys: [K(c.mint), K(c.configPda), K(me.publicKey), K(myAta), K(legacy, true), K(c.holderPdaV3(myAta), true), K(c.rentVaultPda, true), K(SystemProgram.programId)],
  });
  await sendAndConfirm(new Transaction().add(ix), [me], 'migrate holder record (v2 → v3)');
  console.log(`migrated: ${legacy.toBase58()} → ${c.holderPdaV3(myAta).toBase58()} (bytes copied verbatim; legacy account closed)`);
} else if (cmd === 'merge') {
  // ENGINE v3: merge another of MY token accounts' holder record into
  // my ATA's record (conservative merge — see engine tag 11), then the
  // source record closes. Usage: node hook.mjs merge <source token account>
  const me = loadWallet(); const c = ctx();
  const srcAcct = positional[0] ? new PublicKey(positional[0]) : null;
  if (!srcAcct) { console.error('Usage: node hook.mjs merge <source token account>'); process.exit(1); }
  const myAta = c.ata(me.publicKey);
  const ix = new TransactionInstruction({
    programId: c.programs.engine, data: Buffer.from([11]),
    keys: [K(me.publicKey, false, true), K(c.mint), K(c.configPda), K(srcAcct), K(myAta), K(c.holderPdaV3(srcAcct), true), K(c.holderPdaV3(myAta), true), K(c.rentVaultPda, true), K(SystemProgram.programId)],
  });
  await sendAndConfirm(new Transaction().add(ix), [me], 'merge holder records');
  console.log(`merged record of ${srcAcct.toBase58()} into the ATA record ${c.holderPdaV3(myAta).toBase58()} (source record closed)`);
} else if (cmd === 'crank-price') {
  const me = loadWallet(); const c = ctx();
  const ix = new TransactionInstruction({
    programId: c.programs.engine, data: Buffer.from([5]),
    keys: [K(c.configPda), K(c.pricePda, true), K(c.baseVault), K(c.quoteVault)],
  });
  console.log('Note: the crank prices constant-product vault pairs. It does NOT price DBC bonding curves (their price lives in virtual reserves) — for curve tokens this refreshes nothing until the DBC pool-state crank ships.');
  await sendAndConfirm(new Transaction().add(ix), [me], 'crank price feed');
} else {
  console.log('Usage: node hook.mjs init | address | register [--kind agent|human] | sync | status [--json] | buy <SOL> | sell <TOKENS> | flow buy <record.json> <SOL> | flow sell <record.json> <TOKENS|all> | send <TOKENS> <wallet> | claim | claim-fees | crank-fees [--sources a,b] | crank-price | migrate | merge <source token account>   (token from --record / HOOK_RECORD)');
}

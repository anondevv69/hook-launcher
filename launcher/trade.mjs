#!/usr/bin/env node
// trade.mjs — AgentOnly Trade Kit CLI (Phase 2). A thin facade over
// tradekit.mjs. Every command prints JSON. The kit NEVER loads a
// keypair, signs, or sends: `build` returns an unsigned transaction
// (base64) for the caller's own signer (Path A), `simulate` runs it
// against live state read-only, `verify` inspects a signature an agent
// broadcast itself.
//
//   node trade.mjs quote       --record <record.json> --side buy|sell --amount <ui> [--venue auto|curve|house] [--wallet <pubkey>] [--slippage-bps 100]
//   node trade.mjs eligibility --record <record.json> --wallet <pubkey> --side buy|sell|send --amount <ui> [--venue ...] [--dest <pubkey>] [--wallet-type own|sandbox|bankr]
//   node trade.mjs build       --record <record.json> --wallet <pubkey> --side buy|sell|send --amount <ui> [--venue ...] [--dest <pubkey>] [--wallet-type ...] [--out <file.json>] [--force]
//   node trade.mjs simulate    (same flags as build — builds, then simulates)
//   node trade.mjs verify      --record <record.json> --sig <signature> [--wallet <pubkey>]
//   node trade.mjs resolve-extras --record <record.json> --source <acct> --dest <acct> --authority <pubkey>   (diagnostic: from-list-bytes resolver)
//   node trade.mjs wallet-check [--signer local-keypair|sandbox-keypair|serialized-tx|bankr|unknown] [--wallet-type own|sandbox|bankr] [--wallet <pubkey>] [--record <record.json>]
//        Signer-capability preflight: run BEFORE creating any wallet. Pure
//        capability evaluation (no RPC); --record is optional and only adds
//        token context (whether THIS token requires registration).
//
// Amounts: --amount is UI units — SOL for a buy, tokens for sell/send.
// --amount-raw <integer> overrides with raw units. Token context is the
// launch record (--record or HOOK_RECORD), exactly like hook.mjs.
// Env: HOOK_RPC (default public mainnet RPC). Quote/eligibility/build
// read FRESH chain state on demand; nothing polls.
import fs from 'fs';
import { PublicKey, Transaction } from '@solana/web3.js';
import { TradeKit, TradeKitError, loadRecord, makeCtx, checkEligibility, buildTrade, simulateTrade, simulateTx, verifyTrade, resolveExtrasFromList, walletCheck, hasRule } from './tradekit.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt = null) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const has = (name) => argv.includes('--' + name);
const out = (obj) => console.log(JSON.stringify(obj, null, 2));
function die(code, obj) { out(obj); process.exit(code); }

if (!cmd || cmd === '--help' || cmd === 'help') {
  console.log(`AgentOnly Trade Kit — quote / eligibility / build / simulate / verify for ruled tokens.
No keypair is ever loaded; build returns an UNSIGNED transaction for your own signer.

  node trade.mjs quote       --record R --side buy|sell --amount <SOL|tokens> [--venue auto|curve|house] [--wallet W] [--slippage-bps 100] [--amount-raw N]
  node trade.mjs eligibility --record R --wallet W --side buy|sell|send --amount X [--venue V] [--dest W2] [--wallet-type own|sandbox|bankr]
  node trade.mjs build       --record R --wallet W --side buy|sell|send --amount X [--venue V] [--dest W2] [--wallet-type T] [--out build.json] [--force]
  node trade.mjs simulate    (build flags) — builds the same transaction and simulates it read-only
  node trade.mjs verify      --record R --sig S [--wallet W]
  node trade.mjs resolve-extras --record R --source A --dest B --authority P
  node trade.mjs wallet-check [--signer local-keypair|sandbox-keypair|serialized-tx|bankr|unknown] [--wallet-type own|sandbox|bankr] [--wallet P] [--record R]
        Preflight: which execution path does your signer have? Run this BEFORE hook.mjs init creates a wallet.

Amounts are UI units (SOL in for buys, tokens in for sell/send) unless --amount-raw is given.
Exit codes: 0 ok · 1 usage/input · 2 refused or simulation failed · 3 kit/RPC error.`);
  process.exit(0);
}

try {
  if (cmd === 'wallet-check') {
    // Preflight runs before a record necessarily exists: the record is
    // optional context (does THIS token require registration?).
    let tokenRequiresRegistration = null, tokenSymbol = null;
    const recPath = flag('record', process.env.HOOK_RECORD || null);
    if (recPath && fs.existsSync(recPath)) {
      const c0 = makeCtx(loadRecord(recPath));
      tokenRequiresRegistration = hasRule(c0, 3) || hasRule(c0, 17);
      tokenSymbol = c0.rec.symbol;
    }
    const wc = walletCheck({ signer: flag('signer'), walletType: flag('wallet-type'), wallet: flag('wallet'), tokenRequiresRegistration, tokenSymbol });
    out({ ok: true, command: 'wallet-check', ...wc });
    process.exit(0);
  }
  const recordPath = flag('record', process.env.HOOK_RECORD || './launch-record.json');
  let rec;
  try { rec = loadRecord(recordPath); } catch (e) { throw new TradeKitError('TK_USAGE', e.message); }
  const c = makeCtx(rec);
  const kit = new TradeKit(process.env.HOOK_RPC || rec.rpc || undefined);
  const side = flag('side');
  const venue = flag('venue', 'auto');
  const walletType = flag('wallet-type', 'own');
  const slippageBps = Number(flag('slippage-bps', '100'));
  const walletStr = flag('wallet');
  const wallet = walletStr ? new PublicKey(walletStr) : null;
  const destStr = flag('dest');
  const dest = destStr ? new PublicKey(destStr) : null;
  const amountRawOf = () => {
    const raw = flag('amount-raw');
    if (raw != null) return BigInt(raw);
    const ui = flag('amount');
    if (ui == null || !(Number(ui) > 0)) throw new TradeKitError('TK_USAGE', 'pass --amount <positive UI amount> or --amount-raw <integer>');
    if (!['buy', 'sell', 'send'].includes(side)) throw new TradeKitError('TK_USAGE', `--side must be buy|sell|send, got ${side}`);
    return BigInt(Math.round(Number(ui) * (side === 'buy' ? 1e9 : 10 ** c.decimals)));
  };

  if (cmd === 'quote') {
    if (!['buy', 'sell'].includes(side)) throw new TradeKitError('TK_USAGE', 'quote needs --side buy|sell');
    const q = await kit.quote(c, { side, amountRaw: amountRawOf(), venue, slippageBps });
    out({ ok: true, command: 'quote', record: recordPath, symbol: c.rec.symbol, mint: c.mint.toBase58(), ...q, rpc: kit.stats });
  } else if (cmd === 'eligibility') {
    if (!wallet) throw new TradeKitError('TK_USAGE', 'eligibility needs --wallet <pubkey>');
    if (!['buy', 'sell', 'send'].includes(side)) throw new TradeKitError('TK_USAGE', `--side must be buy|sell|send, got ${side}`);
    const e = await checkEligibility(kit, c, { wallet, destWallet: dest, side, amountRaw: amountRawOf(), venue, walletType });
    out({ ok: true, command: 'eligibility', record: recordPath, ...e, rpc: kit.stats });
  } else if (cmd === 'build' || cmd === 'simulate') {
    if (!wallet) throw new TradeKitError('TK_USAGE', `${cmd} needs --wallet <pubkey>`);
    if (!['buy', 'sell', 'send'].includes(side)) throw new TradeKitError('TK_USAGE', `--side must be buy|sell|send, got ${side}`);
    const opts = { wallet, destWallet: dest, side, amountRaw: amountRawOf(), venue, walletType, slippageBps, force: has('force') };
    if (cmd === 'build') {
      const b = await buildTrade(kit, c, opts);
      const payload = { ok: true, command: 'build', record: recordPath, transactionBase64: b.transactionBase64, manifest: b.manifest, quote: b.quote, eligibility: { status: b.eligibility.status, reasons: b.eligibility.reasons }, rpc: kit.stats };
      const outPath = flag('out');
      if (outPath) { fs.writeFileSync(outPath, JSON.stringify(payload, null, 2)); out({ ok: true, command: 'build', wrote: outPath, manifest: b.manifest }); }
      else out(payload);
    } else {
      const s = await simulateTrade(kit, c, opts);
      out({ ok: s.simulation.status === 'passed', command: 'simulate', record: recordPath, simulation: s.simulation, manifest: s.manifest, eligibility: { status: s.eligibility.status, reasons: s.eligibility.reasons }, rpc: kit.stats });
      if (s.simulation.status !== 'passed') process.exit(2);
    }
  } else if (cmd === 'verify') {
    const sig = flag('sig');
    if (!sig) throw new TradeKitError('TK_USAGE', 'verify needs --sig <signature>');
    const v = await verifyTrade(kit, c, { signature: sig, wallet });
    out({ ok: true, command: 'verify', record: recordPath, ...v, rpc: kit.stats });
  } else if (cmd === 'resolve-extras') {
    const source = flag('source'), destA = flag('dest'), authority = flag('authority');
    if (!source || !destA || !authority) throw new TradeKitError('TK_USAGE', 'resolve-extras needs --source, --dest, --authority');
    const [metaInfo] = await kit.batchRead([c.metaPda]);
    if (!metaInfo) throw new TradeKitError('TK_NO_META_LIST', 'no meta list account for this mint');
    const accounts = [new PublicKey(source), c.mint, new PublicKey(destA), new PublicKey(authority)];
    const keys = resolveExtrasFromList(metaInfo.data, { mint: c.mint, accounts, engineProgram: c.programs.engine, metaListPda: c.metaPda });
    out({ ok: true, command: 'resolve-extras', record: recordPath, tail: keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), rpc: kit.stats });
  } else {
    die(1, { ok: false, error: { code: 'TK_USAGE', message: `unknown command ${cmd} — run: node trade.mjs --help` } });
  }
} catch (e) {
  if (e instanceof TradeKitError) {
    die(e.code === 'TK_INELIGIBLE' || e.code === 'TK_SIGNER_UNSUPPORTED' ? 2 : 1, { ok: false, error: { code: e.code, message: e.message }, ...(e.eligibility ? { eligibility: e.eligibility } : {}), ...(e.blockers ? { blockers: e.blockers } : {}) });
  }
  die(3, { ok: false, error: { code: 'TK_ERROR', message: String(e?.message ?? e) } });
}

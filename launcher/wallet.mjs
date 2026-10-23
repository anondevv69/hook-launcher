#!/usr/bin/env node
// wallet.mjs — AgentOnly wallet tool: create and manage the local Solana
// keypair the kit's other tools use. A sibling of hook.mjs / trade.mjs.
//
// It writes EXACTLY the file hook.mjs reads: a JSON array of the 64
// secret-key bytes at $HOOK_KEYPAIR (default ~/.hook_keypair.json),
// mode 600. A file created here is usable by hook.mjs and vice versa.
//
//   node wallet.mjs create                       generate the keypair (NEVER overwrites)
//   node wallet.mjs address                      print the wallet address (alias: export-address)
//   node wallet.mjs balance                      SOL balance of the wallet address (read-only)
//   node wallet.mjs sign-message --message "…"   ed25519-sign a message; prints address + signature
//   node wallet.mjs handshake --address <addr>   persistence check: does the file still derive <addr>?
//
// The handshake productizes the persistence rule from skills/wallet.md:
// a sandbox wallet is only real if the file survives your sessions.
// Run create in one session, handshake in a LATER one — fund only an
// address that comes back identical.
//
// Env: HOOK_KEYPAIR (default ~/.hook_keypair.json), HOOK_RPC (default
// public mainnet RPC). Every command prints JSON. NO command ever
// prints, logs, or returns secret-key material — only addresses and
// signatures.
import fs from 'fs';
import os from 'os';
import { Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { TradeKit } from './tradekit.mjs';

const KEY_PATH = process.env.HOOK_KEYPAIR || os.homedir() + '/.hook_keypair.json';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt = null) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const out = (obj) => console.log(JSON.stringify(obj, null, 2));
function die(code, obj) { out(obj); process.exit(code); }

function readKeypairFile() {
  // Returns { kp } or throws an Error whose .code is machine-readable.
  if (!fs.existsSync(KEY_PATH)) {
    const e = new Error(`no keypair file at ${KEY_PATH}`);
    e.code = 'WALLET_NO_FILE';
    throw e;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch (err) {
    const e = new Error(`keypair file at ${KEY_PATH} is unreadable or corrupt (${err.message})`);
    e.code = 'WALLET_UNREADABLE';
    throw e;
  }
}

if (!cmd || cmd === '--help' || cmd === 'help') {
  console.log(`AgentOnly wallet tool — create and manage the local keypair (~/.hook_keypair.json, mode 600).
The file format is exactly the one hook.mjs reads; either tool can create it, both can use it.

  node wallet.mjs create                     generate a fresh ed25519 keypair (refuses if the file exists)
  node wallet.mjs address                    print the wallet address (alias: export-address)
  node wallet.mjs balance                    SOL balance of the wallet address (read-only, mainnet)
  node wallet.mjs sign-message --message "…" sign a message; prints the address + base64 signature
  node wallet.mjs handshake --address <addr> persistence check: the file must still derive <addr>

Exit codes: 0 ok · 1 usage/input · 2 refused or failed check · 3 RPC/runtime error.
No command ever outputs secret-key material.`);
  process.exit(0);
}

try {
  if (cmd === 'create') {
    if (fs.existsSync(KEY_PATH)) {
      let existing = null;
      try { existing = readKeypairFile().publicKey.toBase58(); } catch { /* unreadable: still refuse */ }
      die(2, {
        ok: false, command: 'create',
        error: {
          code: 'WALLET_EXISTS',
          message: `a keypair file already exists at ${KEY_PATH}${existing ? ` (address ${existing})` : ''} — create never overwrites an existing wallet. If you meant to use it, run: node wallet.mjs address. To start over, move the old file yourself first (it IS that wallet — deleting it destroys it).`,
        },
        ...(existing ? { existingAddress: existing } : {}),
      });
    }
    const kp = Keypair.generate();
    fs.writeFileSync(KEY_PATH, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600, flag: 'wx' });
    fs.chmodSync(KEY_PATH, 0o600);
    const address = kp.publicKey.toBase58();
    out({
      ok: true, command: 'create',
      address,
      keyPath: KEY_PATH,
      format: 'JSON array of the 64 secret-key bytes (the exact file hook.mjs reads)',
      mode: '600',
      nextSteps: [
        'This is a NEW wallet — anything bought with it is held by THIS address, not by any custodial wallet your platform also gives you.',
        `Persistence handshake NEXT SESSION (before funding): in a genuinely later session run: node wallet.mjs handshake --address ${address} — fund only if it passes.`,
        'Fund small first (registration ≈0.0012 SOL rent; a first trade needs the buy amount + ≈0.002 SOL). Keep only working amounts in a hot wallet.',
        'Back the key file up once to a second location only you can read (mode 600). Never paste, print, upload, or send the secret key anywhere — the address is the only public part.',
      ],
    });
  } else if (cmd === 'address' || cmd === 'export-address') {
    const kp = readKeypairFile();
    out({ ok: true, command: 'address', address: kp.publicKey.toBase58(), keyPath: KEY_PATH });
  } else if (cmd === 'balance') {
    const kp = readKeypairFile();
    const address = kp.publicKey.toBase58();
    const kit = new TradeKit(process.env.HOOK_RPC || undefined);
    const res = await kit.rpc('getBalance', [address]);
    const lamports = BigInt(res.value);
    out({
      ok: true, command: 'balance', address,
      lamports: lamports.toString(),
      sol: Number(lamports) / 1e9,
      rpc: kit.rpcUrl,
    });
  } else if (cmd === 'sign-message') {
    const message = flag('message') ?? positional[0];
    if (message == null) die(1, { ok: false, command: 'sign-message', error: { code: 'WALLET_USAGE', message: 'sign-message needs --message "<text>" (or a positional argument)' } });
    const kp = readKeypairFile();
    const bytes = new TextEncoder().encode(message);
    const sig = ed25519.sign(bytes, kp.secretKey.slice(0, 32));
    out({
      ok: true, command: 'sign-message',
      address: kp.publicKey.toBase58(),
      message,
      algorithm: 'ed25519',
      signatureBase64: Buffer.from(sig).toString('base64'),
      note: 'Anyone can verify this signature against the address. The secret key never leaves this machine and is never printed.',
    });
  } else if (cmd === 'handshake') {
    const expected = flag('address') ?? positional[0];
    if (!expected) die(1, { ok: false, command: 'handshake', error: { code: 'WALLET_USAGE', message: 'handshake needs --address <the address reported when the wallet was created>' } });
    const BURNER = 'this environment did not preserve the wallet — treat it as a burner: do not fund it beyond dust you can afford to lose, do not register it, and do not receive anything you care about at that address. Generate a replacement only once you have storage that actually persists — or use a signer you already control.';
    if (!fs.existsSync(KEY_PATH)) {
      die(2, {
        ok: false, command: 'handshake', verdict: 'not-preserved', expected, found: null, keyPath: KEY_PATH,
        message: `No keypair file at ${KEY_PATH}: ${BURNER}`,
      });
    }
    let derived;
    try { derived = readKeypairFile().publicKey.toBase58(); } catch (e) {
      die(2, {
        ok: false, command: 'handshake', verdict: 'not-preserved', expected, found: null, keyPath: KEY_PATH,
        message: `The keypair file at ${KEY_PATH} could not be read back (${e.message}): ${BURNER}`,
      });
    }
    if (derived !== expected) {
      die(2, {
        ok: false, command: 'handshake', verdict: 'address-mismatch', expected, found: derived, keyPath: KEY_PATH,
        message: `The preserved file derives ${derived}, not the expected ${expected}: ${BURNER}`,
      });
    }
    out({
      ok: true, command: 'handshake', verdict: 'preserved', address: derived, keyPath: KEY_PATH,
      message: 'The keypair file persisted and derives the expected address — this wallet is real in this environment. Fund small first, and keep only working amounts in it.',
    });
  } else {
    die(1, { ok: false, error: { code: 'WALLET_USAGE', message: `unknown command ${cmd} — run: node wallet.mjs --help` } });
  }
} catch (e) {
  if (e && e.code === 'WALLET_NO_FILE') {
    die(1, { ok: false, error: { code: e.code, message: `${e.message} — create one first: node wallet.mjs create` } });
  }
  if (e && (e.code === 'WALLET_UNREADABLE')) {
    die(1, { ok: false, error: { code: e.code, message: e.message } });
  }
  die(3, { ok: false, error: { code: 'WALLET_ERROR', message: String(e?.message ?? e) } });
}

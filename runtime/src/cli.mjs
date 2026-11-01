// agentonly-runtime CLI — thin shell over src/runtime.mjs.
//
// Commands:
//   wallet create --file <path>     generate a keypair (explicit request
//                                   only) + persistence handshake + sidecar
//   wallet show   --file <path>     print the public address only
//   wallet attest-persistence --file <path>
//                                   stamp the sidecar from a LATER session;
//                                   prepare/send refuse un-attested
//                                   runtime-created wallets
//   signer enroll --path <exe>      enroll an external signer invocation
//        [--arg <value> ...]        (executable absolute path + SHA-256,
//                                   plus an argv template whose file
//                                   arguments are hashed too) in the
//                                   user-owned signer allowlist; sends
//                                   refuse unenrolled signers, changed
//                                   invocation components, and any
//                                   send-time signer arguments (repair
//                                   round 4, P1-5; round 5, TIGHTEN-2)
//   signer list                     show the enrolled signers
//   inspect <mint>                  readable token + market summary
//   prepare --file <keypair> --mint <mint> --side buy|sell --amount <ui>
//                                   [--signer-type own|sandbox]
//                                   [--max-fee-lamports <n>]
//                                   [--out ./approval-card.json]
//   prepare --signer-type external --wallet <address> --mint <mint>
//           --side buy|sell --amount <ui> [--out ./approval-card.json]
//   send --file <keypair> --card <card.json> --approve <approval-token>
//        [--dry-run] [--signer-type ...]
//   send --signer-type external --external-signer <executable-path>
//        --wallet <address> --card <card.json> --approve <approval-token>
//        [--dry-run]                 (no signer arguments at send time —
//                                   the invocation was fixed at enrollment)
//
// Exit codes: 0 ok · 1 refusal/error · 3 persistence handshake mismatch.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Connection, Keypair } from '@solana/web3.js';
import {
  RPC_URL,
  RUNTIME_VERSION,
  RuntimeError,
  assertSignerSupported,
  assertWalletAttested,
  enrollSigner,
  fetchTokenRecord,
  formatCard,
  formatInspect,
  inspectToken,
  keypairFileSha256,
  loadKeypair,
  prepareTrade,
  readSignerAllowlist,
  readWalletSidecar,
  sendCard,
  signerAllowlistPath,
  walletSidecarPath,
  writeFileAtomicSafe,
  writeKeypairFile,
  writeWalletSidecar,
} from './runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'dry-run') flags[key] = true;
      else if (key === 'arg' || key === 'external-signer-arg') {
        // Repeatable: 'arg' carries signer-enrollment template values;
        // 'external-signer-arg' is the retired send-time form — still
        // parsed so the send path can refuse it by name (repair
        // round 5, TIGHTEN-2) instead of silently ignoring it.
        (flags[key] ??= []).push(argv[++i]);
      } else flags[key] = argv[++i];
    } else positional.push(a);
  }
  return { positional, flags };
}

function die(err) {
  const code = err?.code;
  if (code) console.error(`ERROR ${code}: ${err.message}`);
  else console.error(`ERROR: ${err?.message ?? err}`);
  process.exit(1);
}

// --- wallet create -----------------------------------------------------------
// The persistence handshake: a SEPARATE node process re-reads the keypair
// file from disk and prints the address it derives. Only if that address
// matches the one just generated may this wallet ever be shown as a
// funding address — a wallet whose storage does not persist strands funds.
//
// Narrowed claim (issue #4 P1-b): the handshake proves cross-process
// re-read RIGHT NOW. It does NOT prove durability across a host restart
// or snapshot rollback. That is what `wallet attest-persistence` in a
// later session is for, and prepare/send enforce it.
function persistenceHandshake(file) {
  const runtimeUrl = pathToFileURL(resolve(HERE, 'runtime.mjs')).href;
  const script =
    `import { loadKeypair } from ${JSON.stringify(runtimeUrl)};\n` +
    `const kp = loadKeypair(process.argv[1]);\n` +
    `process.stdout.write(kp.publicKey.toBase58());\n`;
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script, resolve(file)],
    { encoding: 'utf8' },
  );
  return out.trim();
}

async function walletCreate(flags) {
  const file = flags.file;
  if (!file) throw new RuntimeError('INVALID_ARGS', 'wallet create requires --file <path>');
  if (existsSync(file)) {
    throw new RuntimeError('KEYPAIR_EXISTS', `refusing to overwrite an existing keypair file: ${file}`);
  }
  const kp = Keypair.generate();
  writeKeypairFile(file, kp);
  const expected = kp.publicKey.toBase58();
  let reread = null;
  try {
    reread = persistenceHandshake(file);
  } catch (e) {
    console.error(`HARD WARNING: persistence handshake FAILED — a fresh process could not re-read ${file} (${e.message}).`);
    console.error('DO NOT fund this wallet. Its storage does not verifiably persist; any funds sent to it may be stranded.');
    process.exit(3);
  }
  if (reread !== expected) {
    console.error(`HARD WARNING: persistence handshake MISMATCH — generated ${expected} but a fresh process re-read ${reread} from ${file}.`);
    console.error('DO NOT fund this wallet. Its storage does not verifiably persist; any funds sent to it may be stranded.');
    process.exit(3);
  }
  writeWalletSidecar(file, {
    createdAt: new Date().toISOString(),
    runtimeVersion: RUNTIME_VERSION,
    address: expected,
    keypairSha256: keypairFileSha256(file),
    attestedAt: null,
  });
  console.log(`wallet created: ${file} (permissions 0600, created exclusively — existing files are never overwritten)`);
  console.log(`address: ${expected}`);
  console.log(`sidecar: ${walletSidecarPath(file)}`);
  console.log('persistence handshake: OK — a separate process re-read the file and derived the same address.');
  console.log('What that proves: the file is readable by another process RIGHT NOW. What it does NOT prove: durability across a host restart or snapshot rollback.');
  console.log('Before funding, attest persistence from a LATER session:');
  console.log(`  agentonly-runtime wallet attest-persistence --file ${file}`);
  console.log('prepare/send refuse this wallet until it is attested. The secret key never leaves this machine; back the file up yourself — this runtime has no recovery.');
}

async function walletShow(flags) {
  if (!flags.file) throw new RuntimeError('INVALID_ARGS', 'wallet show requires --file <path>');
  console.log(loadKeypair(flags.file).publicKey.toBase58());
}

async function walletAttest(flags) {
  const file = flags.file;
  if (!file) throw new RuntimeError('INVALID_ARGS', 'wallet attest-persistence requires --file <path>');
  const kp = loadKeypair(file); // hardened load: symlink / permission checks apply
  const sc = readWalletSidecar(file); // hardened load: symlink / permission checks apply
  if (!sc) {
    console.log(`${kp.publicKey.toBase58()} — no runtime sidecar for this file: it is owner-imported and is not gated by attestation. Nothing to stamp.`);
    return;
  }
  // Binding (repair round 2, P1-g): the sidecar must name THIS wallet
  // before it may be stamped. A sidecar copied from another wallet is
  // refused here, and attestation (re)binds the sidecar to the keypair
  // file's exact bytes — later loads re-verify both.
  const address = kp.publicKey.toBase58();
  if (sc.address && sc.address !== address) {
    throw new RuntimeError(
      'SIDECAR_BINDING_MISMATCH',
      `refusing to attest: the sidecar ${walletSidecarPath(file)} records address ${sc.address} but this keypair file derives ${address}. The sidecar belongs to a different wallet.`,
      { file },
    );
  }
  sc.address = address;
  sc.keypairSha256 = keypairFileSha256(file);
  sc.attestedAt = new Date().toISOString();
  sc.attestedRuntimeVersion = RUNTIME_VERSION;
  writeWalletSidecar(file, sc);
  console.log(`persistence attested: ${address} at ${sc.attestedAt}`);
  console.log(`sidecar bound to this keypair file (address + sha256 of its bytes); later loads re-verify the binding.`);
  console.log('This records that the keypair file was still readable in a session later than its creation. It is evidence, not a guarantee — keep your own backup of any wallet holding meaningful funds.');
}

// --- signer enrollment (repair round 4, P1-5; round 5, TIGHTEN-2) -----------
// Enrollment is the USER's act, done ahead of any send: it records the
// COMPLETE invocation — the executable's absolute path + SHA-256 and
// an argv template whose file arguments (script, key file, config)
// are hashed as well — in the user-owned allowlist. The send path
// only consults it: a send names the enrolled path and nothing else,
// so no agent-supplied value can change what executes or with what
// arguments.

async function signerEnroll(flags) {
  const path = flags.path;
  if (!path) throw new RuntimeError('INVALID_ARGS', 'signer enroll requires --path <executable>');
  const entry = enrollSigner(path, flags.arg ?? []);
  console.log(`signer enrolled: ${entry.path}`);
  console.log(`  executable sha256: ${entry.sha256}`);
  for (const a of entry.args ?? []) {
    console.log(a.type === 'file'
      ? `  arg (file):    ${a.path}  sha256 ${a.sha256}`
      : `  arg (literal): ${a.value}`);
  }
  console.log(`  allowlist: ${entry.allowlistPath} (owner-only, 0600)`);
  console.log('A send naming this exact path runs EXACTLY this invocation while every component still hashes to its enrolled sha256. Re-run enroll after any deliberate change to the executable, the script, or any file argument.');
}

async function signerList() {
  const doc = readSignerAllowlist();
  if (!doc || doc.signers.length === 0) {
    console.log(`no signers enrolled (allowlist: ${signerAllowlistPath()})`);
    return;
  }
  console.log(`signer allowlist: ${signerAllowlistPath()}`);
  for (const s of doc.signers) {
    console.log(`  ${s.path}  sha256 ${s.sha256}  enrolled ${s.enrolledAt}`);
    for (const a of s.args ?? []) {
      console.log(a.type === 'file'
        ? `    arg (file):    ${a.path}  sha256 ${a.sha256}`
        : `    arg (literal): ${a.value}`);
    }
  }
}

// --- main --------------------------------------------------------------------

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub] = positional;

  if (cmd === 'wallet' && sub === 'create') return walletCreate(flags);
  if (cmd === 'wallet' && sub === 'show') return walletShow(flags);
  if (cmd === 'wallet' && sub === 'attest-persistence') return walletAttest(flags);

  if (cmd === 'signer' && sub === 'enroll') return signerEnroll(flags);
  if (cmd === 'signer' && sub === 'list') return signerList();

  if (cmd === 'inspect') {
    const mint = sub;
    if (!mint) throw new RuntimeError('INVALID_ARGS', 'inspect requires a mint address');
    console.log(formatInspect(await inspectToken(fetch, mint)));
    return;
  }

  if (cmd === 'prepare') {
    if (!flags.mint || !flags.side || !flags.amount) {
      throw new RuntimeError('INVALID_ARGS', 'prepare requires --mint, --side buy|sell and --amount (plus --file, or --signer-type external --wallet <address>)');
    }
    const signerType = assertSignerSupported(flags['signer-type'] ?? 'own');
    let wallet;
    if (signerType === 'external') {
      if (!flags.wallet) throw new RuntimeError('INVALID_ARGS', 'external prepare requires --wallet <address> (no local keypair is used in external mode)');
      wallet = flags.wallet;
    } else {
      if (!flags.file) throw new RuntimeError('INVALID_ARGS', 'prepare requires --file <keypair>');
      assertWalletAttested(flags.file);
      wallet = loadKeypair(flags.file).publicKey.toBase58();
    }
    const connection = new Connection(process.env.AGENTONLY_RPC_URL ?? RPC_URL, 'confirmed');
    const card = await prepareTrade({
      wallet,
      mint: flags.mint,
      side: flags.side,
      amount: flags.amount,
      signerType,
      maxFeeLamports: flags['max-fee-lamports'] != null ? Number(flags['max-fee-lamports']) : undefined,
      connection,
    });
    const out = flags.out ?? './approval-card.json';
    card.cardFile = out;
    // Repair round 4, P1-7b: the card write is exclusive of symlinks
    // and atomic (temp file + rename) — a planted symlink at the
    // output path refuses instead of redirecting the write.
    writeFileAtomicSafe(out, JSON.stringify(card, null, 2) + '\n', 0o600);
    console.log(formatCard(card));
    console.log(`\ncard written: ${out}`);
    console.log('Nothing has been signed or sent. The card expires at the block height above.');
    return;
  }

  if (cmd === 'send') {
    if (!flags.card || !flags.approve) {
      throw new RuntimeError('INVALID_ARGS', 'send requires --card and --approve <approval-token> (plus --file, or --signer-type external --external-signer <executable-path> --wallet <address>)');
    }
    let card;
    try {
      card = JSON.parse(readFileSync(flags.card, 'utf8'));
    } catch {
      throw new RuntimeError('CARD_INVALID', `approval card is not readable JSON: ${flags.card}`);
    }
    const signerType = flags['signer-type'] ?? card.signerType ?? 'own';
    assertSignerSupported(signerType);
    let keypair = null;
    let external = null;
    if (signerType === 'external') {
      if (!flags['external-signer'] || !flags.wallet) {
        throw new RuntimeError('INVALID_ARGS', 'external send requires --external-signer <executable-path> and --wallet <address>');
      }
      // Repair round 5, TIGHTEN-2: send-time signer arguments are
      // refused outright — the invocation was fixed at enrollment.
      if ((flags['external-signer-arg'] ?? []).length > 0) {
        throw new RuntimeError(
          'EXTERNAL_SIGNER_ARGS_REFUSED',
          'refusing: --external-signer-arg no longer exists at send time. The external signer\u2019s complete invocation (executable + arguments) is bound at enrollment — enroll the intended invocation with: agentonly-runtime signer enroll --path <executable> [--arg <value>...]',
        );
      }
      external = { address: flags.wallet, command: flags['external-signer'] };
    } else {
      if (!flags.file) throw new RuntimeError('INVALID_ARGS', 'send requires --file <keypair>');
      assertWalletAttested(flags.file);
      keypair = loadKeypair(flags.file);
    }
    const connection = new Connection(process.env.AGENTONLY_RPC_URL ?? RPC_URL, 'confirmed');
    // Canonical token record — REQUIRED at send (repair round 2, P1-d):
    // it carries the pool the intent re-validation and full-effect
    // accounting check against. A fetch failure refuses the send with
    // CANONICAL_DATA_UNAVAILABLE; pool validation is never skipped.
    const tokenJson = await fetchTokenRecord(fetch, card.mint);
    const result = await sendCard({
      keypair,
      external,
      card,
      approve: flags.approve,
      dryRun: !!flags['dry-run'],
      signerType,
      connection,
      tokenJson,
    });
    if (result.mode === 'dry-run') {
      console.log('DRY RUN — signed, the exact signed bytes were simulated (sigVerify), NOT broadcast.');
      console.log(`signature would be: ${result.signature}`);
      console.log(`simulation err: ${JSON.stringify(result.simulation.err)} · units consumed: ${result.simulation.unitsConsumed}`);
      if (result.deltas) {
        console.log(`simulated deltas: SOL ${result.deltas.solDelta} lamports · token ${result.deltas.tokenDelta} raw units`);
        if (result.deltas.settlementOwnPayoutRaw != null) {
          console.log(`settlement payout to this wallet (measured independently from the settle instructions' own transfers): ${result.deltas.settlementOwnPayoutRaw} raw units · total vault outflow ${result.deltas.settlementPayoutRaw} raw units`);
        }
      }
      console.log('Simulation passed; full-effect accounting and the card bounds are enforced. Re-run without --dry-run (same card, same approval) to broadcast.');
    } else {
      console.log('BROADCAST + CONFIRMED');
      console.log(JSON.stringify(result.receipt, null, 2));
    }
    return;
  }

  console.error(`agentonly-runtime ${RUNTIME_VERSION} — usage:`);
  console.error('  agentonly-runtime wallet create --file <path>');
  console.error('  agentonly-runtime wallet show --file <path>');
  console.error('  agentonly-runtime wallet attest-persistence --file <path>');
  console.error('  agentonly-runtime signer enroll --path <executable> [--arg <value> ...]');
  console.error('  agentonly-runtime signer list');
  console.error('  agentonly-runtime inspect <mint>');
  console.error('  agentonly-runtime prepare --file <keypair> --mint <mint> --side buy|sell --amount <ui> [--signer-type own|sandbox] [--max-fee-lamports <n>] [--out ./approval-card.json]');
  console.error('  agentonly-runtime prepare --signer-type external --wallet <address> --mint <mint> --side buy|sell --amount <ui> [--out ./approval-card.json]');
  console.error('  agentonly-runtime send --file <keypair> --card <card.json> --approve <approval-token> [--dry-run]');
  console.error('  agentonly-runtime send --signer-type external --external-signer <executable-path> --wallet <address> --card <card.json> --approve <approval-token> [--dry-run]');
  process.exit(2);
}

main().catch(die);

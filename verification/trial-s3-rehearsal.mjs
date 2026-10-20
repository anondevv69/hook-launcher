// S3 PRE-WINDOW REHEARSAL — preserved-bytes upgrade rehearsal for the
// Distributor (LiteSVM, local only, no chain writes).
//
// Loads the LIVE mainnet distributor binary (extracted from its live
// ProgramData) + the PRESERVED live AGTR accounts (DistState, vault,
// mint, engine Config PDA, fren AGTR ATA — snapshot
// deploy/s2-s4-window/snapshot-live.json, slot 459234913), proves:
//   1. tag-1 distribute executes under the LIVE binary on the real
//      state (zero unfolded balance -> true no-op fold);
//   2. the program binary is then swapped IN PLACE to the rebuilt
//      Phase B mainnet binary (CROWN_ID = mainnet Crown) and the SAME
//      preserved DistState decodes + executes identically (tag 1);
//   3. tag 4 with all-sentinel split slots behaves as tag 1 on AGTR's
//      real config (no split rules configured);
//   4. the accounting identity vault == total_distributed -
//      total_paid_out holds exactly after every step.
// Run: node trial-s3-rehearsal.mjs <rebuilt-mainnet.so>
import { LiteSVM, FailedTransactionMetadata } from 'litesvm';
import { Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const NEW_SO = process.argv[2];
if (!NEW_SO) { console.error('usage: node trial-s3-rehearsal.mjs <rebuilt-mainnet.so>'); process.exit(2); }
const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/s2-s4-window/snapshot-live.json'), 'utf8'));
const LIVE_SO = path.join(ROOT, 'deploy/s2-s4-window/distributor-live-v1.so');

const DIST = new PublicKey('DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa');
const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const AGTR = snap.mints.AGTR;
const statePda = new PublicKey(AGTR.statePda);
const mintPk = new PublicKey(AGTR.mint);
const vaultPk = new PublicKey(AGTR.decoded.vault);
const cfgPda = new PublicKey(AGTR.configPda);
const frenAta = new PublicKey(snap.frenAgtrAta.address);

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  ok', label); } else { fail++; console.log('  FAIL', label); } };

const svm = new LiteSVM();
const payer = Keypair.generate();
svm.airdrop(payer.publicKey, BigInt(10 * LAMPORTS_PER_SOL));

function setPreserved(pk, rec) {
  svm.setAccount(pk, {
    lamports: rec.lamports,
    data: Buffer.from(rec.dataB64, 'base64'),
    owner: new PublicKey(rec.owner),
    executable: false,
    rentEpoch: 0,
  });
}
setPreserved(mintPk, AGTR.mintAccount);
setPreserved(statePda, AGTR.state);
setPreserved(vaultPk, AGTR.vault);
setPreserved(cfgPda, AGTR.config);
setPreserved(frenAta, snap.frenAgtrAta);

function decodeState(d) {
  const u128 = (o) => { let v = 0n; for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]); return v; };
  return {
    tag: d[0], index: u128(97), total_harvested: d.readBigUInt64LE(113), total_distributed: d.readBigUInt64LE(121),
    total_cuts: d.readBigUInt64LE(129), caller_cut_bps: d.readUInt16LE(137), funding_mode: d[140],
    distribute_count: d.readBigUInt64LE(149), total_paid_out: d.readBigUInt64LE(157), total_routed_folded: d.readBigUInt64LE(165),
  };
}
const stateNow = () => decodeState(Buffer.from(svm.getAccount(statePda).data));
const vaultNow = () => Buffer.from(svm.getAccount(vaultPk).data).readBigUInt64LE(64);

function send(ix, label) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer);
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) {
    let logs = []; try { const m = res.meta(); logs = typeof m.logs === 'function' ? m.logs() : (m.logs || []); } catch {}
    throw new Error(label + ' failed: ' + JSON.stringify(res.err()) + ' | ' + logs.slice(-4).join(' ; '));
  }
  return res;
}
const distIx = (tag, withSplits) => {
  const keys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: true },
    { pubkey: statePda, isSigner: false, isWritable: true },
    { pubkey: vaultPk, isSigner: false, isWritable: true },
    { pubkey: frenAta, isSigner: false, isWritable: true },
    { pubkey: T22, isSigner: false, isWritable: false },
  ];
  if (withSplits) {
    keys.push({ pubkey: cfgPda, isSigner: false, isWritable: false });
    for (let i = 0; i < 6; i++) keys.push({ pubkey: statePda, isSigner: false, isWritable: false }); // sentinels
  }
  return new TransactionInstruction({ programId: DIST, data: Buffer.from([tag]), keys });
};

const before = stateNow();
console.log('preserved AGTR DistState:', JSON.stringify(before, (k, v) => typeof v === 'bigint' ? v.toString() : v));
ok(before.funding_mode === 1, 'funding_mode == 1 (routed)');
ok(vaultNow() === before.total_distributed - before.total_paid_out, 'identity holds on preserved state: vault == distributed - paid_out');

// Phase 1: LIVE binary
svm.addProgramFromFile(DIST, LIVE_SO);
send(distIx(1, false), 'tag-1 under LIVE binary');
const afterLive = stateNow();
ok(afterLive.index === before.index && afterLive.total_distributed === before.total_distributed &&
   afterLive.total_paid_out === before.total_paid_out && afterLive.total_routed_folded === before.total_routed_folded &&
   afterLive.total_cuts === before.total_cuts, 'tag-1 under LIVE binary: zero-fold no-op (counters unchanged)');
console.log('  distribute_count', before.distribute_count.toString(), '->', afterLive.distribute_count.toString());

// Phase 2: swap binary in place -> rebuilt Phase B mainnet binary
svm.addProgramFromFile(DIST, NEW_SO);
send(distIx(1, false), 'tag-1 under NEW binary');
const afterNew = stateNow();
ok(afterNew.index === before.index && afterNew.total_distributed === before.total_distributed &&
   afterNew.total_paid_out === before.total_paid_out && afterNew.total_routed_folded === before.total_routed_folded,
   'tag-1 under NEW binary on preserved state: decodes identically, zero-fold no-op');

// Phase 3: tag 4, all-sentinel splits, real AGTR config (no split rules)
send(distIx(4, true), 'tag-4 all-sentinel under NEW binary');
const afterT4 = stateNow();
ok(afterT4.total_distributed === before.total_distributed && afterT4.total_paid_out === before.total_paid_out,
   'tag-4 all-sentinel behaves as tag 1 (no movement)');
ok(vaultNow() === afterT4.total_distributed - afterT4.total_paid_out, 'identity holds after all steps');

console.log(`\nS3 REHEARSAL: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

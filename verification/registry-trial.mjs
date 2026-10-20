// Hook Launcher REGISTRY — LiteSVM trial suite.
// Mirrors the engine trial idioms (hook-launcher-build/engine/trial.mjs):
// real program binary in-process, TH-style counted assertions.
import { LiteSVM, FailedTransactionMetadata, Clock } from 'litesvm';
import {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const kp = JSON.parse(fs.readFileSync(path.join(DIR, 'registry-keypair.json'), 'utf8'));
const REGISTRY = Keypair.fromSecretKey(Uint8Array.from(kp)).publicKey;

const svm = new LiteSVM();
svm.addProgramFromFile(REGISTRY, path.join(DIR, 'target/deploy/registry.so'));
// LiteSVM's default Clock has unix_timestamp 0; set a realistic one so
// registered_at is exactly assertable (Clock: slot, epochStartTs, epoch,
// leaderScheduleEpoch, unixTimestamp).
const TRIAL_TS = 1757000000n;
svm.setClock(new Clock(1n, 0n, 0n, 0n, TRIAL_TS));

const funder = Keypair.generate();
svm.airdrop(funder.publicKey, BigInt(50 * LAMPORTS_PER_SOL));

const regPda = (wallet) => PublicKey.findProgramAddressSync([Buffer.from('registration'), wallet.toBuffer()], REGISTRY)[0];

// ---------- tx plumbing (engine-trial idiom) ----------
function runTx(ixs, signers, label) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(...signers);
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) {
    const e = new Error(label + ' failed');
    try { const m = res.meta(); e.logs = typeof m.logs === 'function' ? m.logs() : (m.logs || []); }
    catch { e.logs = []; }
    e.chainErr = res.err();
    throw e;
  }
  return res;
}
const send = (ixs, signers, label) => runTx(ixs, signers, label);

const ERR_BY_LOG = [
  ['already registered', 'AlreadyRegistered'],
  ['custom program error: 0x2', 'NotRegistered'],
  ['custom program error: 0x4', 'BadKind'],
];
function classify(e) {
  const logs = (e.logs || []).join('\n');
  const errJson = JSON.stringify(e.chainErr || {});
  // LiteSVM renders ProgramError::InvalidSeeds only in the logs, verbatim:
  if (logs.includes('Provided seeds do not result in a valid address') || errJson.includes('InvalidSeeds')) return 'InvalidSeeds';
  for (const [needle, name] of ERR_BY_LOG) if (logs.includes(needle)) return name;
  const lm = logs.match(/custom program error: 0x([0-9a-f]+)/i);
  if (lm) return 'Custom' + parseInt(lm[1], 16);
  const m = errJson.match(/"Custom":(\d+)/);
  if (m) return 'Custom' + m[1];
  return 'Other:' + (logs || String(e.message)).slice(-200).replace(/\n/g, ' | ');
}
async function attempt(fn) { try { await fn(); return null; } catch (e) { return classify(e); } }

const acctData = (pk) => { const a = svm.getAccount(pk); return a ? Buffer.from(a.data) : null; };
const lamports = (pk) => { const a = svm.getAccount(pk); return a ? a.lamports : 0n; };

const newWallet = (sol = 5) => { const k = Keypair.generate(); svm.airdrop(k.publicKey, BigInt(sol * LAMPORTS_PER_SOL)); return k; };

const registerIx = (wallet, kind) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.from([0, kind]),
  keys: [
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: regPda(wallet), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
const setActiveIx = (wallet, active) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.from([1, active]),
  keys: [
    { pubkey: wallet, isSigner: true, isWritable: false },
    { pubkey: regPda(wallet), isSigner: false, isWritable: true },
  ],
});
const closeIx = (wallet) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.from([2]),
  keys: [
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: regPda(wallet), isSigner: false, isWritable: true },
  ],
});

// ================= TRIAL =================
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name} ${extra}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
console.log('registry:', REGISTRY.toBase58());

console.log('=== T1: register (agent) — PDA fields exact ===');
const alice = newWallet();
ok(acctData(regPda(alice.publicKey)) === null, 'T1 no PDA before registration');
await send([registerIx(alice.publicKey, 1)], [alice], 'register alice');
{
  const d = acctData(regPda(alice.publicKey));
  ok(d !== null && d.length === 48, 'T1 PDA exists at 48 bytes');
  ok(d[0] === 1, 'T1 tag = 1');
  ok(new PublicKey(d.subarray(1, 33)).equals(alice.publicKey), 'T1 wallet field = signer');
  ok(d[33] === 1, 'T1 kind = Agent (1)');
  ok(d[34] === 0, 'T1 verified_via = self-signed (0)');
  ok(d.readBigInt64LE(35) === TRIAL_TS, 'T1 registered_at = SVM clock timestamp', `(${d.readBigInt64LE(35)})`);
  ok(d[43] === 1, 'T1 active = 1');
}

console.log('=== T2: unregistered wallet has no PDA ===');
const ghost = newWallet();
ok(acctData(regPda(ghost.publicKey)) === null, 'T2 fresh wallet: no Registration PDA');

console.log('=== T3: register (human kind) ===');
const henry = newWallet();
await send([registerIx(henry.publicKey, 0)], [henry], 'register henry');
ok(acctData(regPda(henry.publicKey))[33] === 0, 'T3 kind = Human (0) stored');

console.log('=== T4: duplicate register rejected ===');
ok((await attempt(() => send([registerIx(alice.publicKey, 1)], [alice], 're-register'))) === 'AlreadyRegistered', 'T4 second register fails AlreadyRegistered');

console.log('=== T5: wrong-signer register fails (cannot register another wallet) ===');
{
  const victim = newWallet();
  const attacker = newWallet();
  // Attacker signs, but passes the VICTIM's Registration PDA: seed check fails.
  const badIx = new TransactionInstruction({
    programId: REGISTRY, data: Buffer.from([0, 1]),
    keys: [
      { pubkey: attacker.publicKey, isSigner: true, isWritable: true },
      { pubkey: regPda(victim.publicKey), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  ok((await attempt(() => send([badIx], [attacker], 'register-for-victim'))) === 'InvalidSeeds', 'T5 registering for another wallet fails InvalidSeeds');
  ok(acctData(regPda(victim.publicKey)) === null, 'T5 victim still unregistered');
}

console.log('=== T6: set_active toggles validity ===');
await send([setActiveIx(alice.publicKey, 0)], [alice], 'deactivate alice');
ok(acctData(regPda(alice.publicKey))[43] === 0, 'T6 active = 0 after set_active(false) — engine read contract treats this as invalid');
await send([setActiveIx(alice.publicKey, 1)], [alice], 'reactivate alice');
ok(acctData(regPda(alice.publicKey))[43] === 1, 'T6 active = 1 after set_active(true)');

console.log('=== T7: set_active on someone else / on nothing ===');
{
  const stranger = newWallet();
  // stranger passes ALICE's PDA with themselves as signer -> seed derivation is
  // from the signer, so this is InvalidSeeds, never a write to alice's record.
  const badIx = new TransactionInstruction({
    programId: REGISTRY, data: Buffer.from([1, 0]),
    keys: [
      { pubkey: stranger.publicKey, isSigner: true, isWritable: false },
      { pubkey: regPda(alice.publicKey), isSigner: false, isWritable: true },
    ],
  });
  ok((await attempt(() => send([badIx], [stranger], 'deactivate alice as stranger'))) === 'InvalidSeeds', 'T7 a stranger cannot deactivate alice');
  ok(acctData(regPda(alice.publicKey))[43] === 1, 'T7 alice still active');
  ok((await attempt(() => send([setActiveIx(ghost.publicKey, 1)], [ghost], 'activate ghost'))) === 'NotRegistered', 'T7 set_active without a registration fails NotRegistered');
}

console.log('=== T8: close returns rent; re-register starts clean ===');
{
  const before = lamports(henry.publicKey);
  const rentHeld = lamports(regPda(henry.publicKey));
  await send([closeIx(henry.publicKey)], [henry], 'close henry');
  ok(acctData(regPda(henry.publicKey)) === null, 'T8 PDA gone after close');
  ok(lamports(henry.publicKey) > before, 'T8 rent returned to wallet', `(held ${rentHeld}, delta ${lamports(henry.publicKey) - before} net of fees)`);
  await send([registerIx(henry.publicKey, 1)], [henry], 're-register henry');
  const d = acctData(regPda(henry.publicKey));
  ok(d !== null && d[33] === 1 && d[43] === 1, 'T8 re-register after close works (kind updated, active)');
}

console.log('=== T9: bad kind rejected ===');
{
  const w = newWallet();
  ok((await attempt(() => send([registerIx(w.publicKey, 7)], [w], 'register kind 7'))) === 'BadKind', 'T9 kind outside {0,1} fails BadKind');
  ok(acctData(regPda(w.publicKey)) === null, 'T9 nothing persisted');
}

const ecoPda = () => PublicKey.findProgramAddressSync([Buffer.from('ecosystem')], REGISTRY)[0];
const KP0 = new PublicKey('11111111111111111111111111111111');
const initEcoIx = (authority) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.from([3]),
  keys: [
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: ecoPda(), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
const setAttesterIx = (authority, eco, attesterPk) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.concat([Buffer.from([4, eco]), attesterPk.toBuffer()]),
  keys: [
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: ecoPda(), isSigner: false, isWritable: true },
  ],
});
const registerAttestedIx = (wallet, attester, kind, eco) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.from([5, kind, eco]),
  keys: [
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: attester, isSigner: true, isWritable: false },
    { pubkey: regPda(wallet), isSigner: false, isWritable: true },
    { pubkey: ecoPda(), isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
});
const attestExistingIx = (wallet, attester, eco) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.from([6, eco]),
  keys: [
    { pubkey: wallet, isSigner: true, isWritable: false },
    { pubkey: attester, isSigner: true, isWritable: false },
    { pubkey: regPda(wallet), isSigner: false, isWritable: true },
    { pubkey: ecoPda(), isSigner: false, isWritable: false },
  ],
});
const transferEcoAuthIx = (authority, newAuthorityPk) => new TransactionInstruction({
  programId: REGISTRY, data: Buffer.concat([Buffer.from([7]), newAuthorityPk.toBuffer()]),
  keys: [
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: ecoPda(), isSigner: false, isWritable: true },
  ],
});
const attesterSlot = (eco) => { const d = acctData(ecoPda()); return new PublicKey(d.subarray(33 + (eco - 1) * 32, 33 + eco * 32)); };
// v2 custom errors surface via the generic hex path in classify():
// 5 BadEcosystem, 6 NotAttester, 7 BadAuthority, 8 AlreadyInit, 9 EcosystemNotConfigured.

console.log('=== T10: attested paths before Ecosystem Config exists fail closed ===');
const ecoAuthority = newWallet();
const museAttester = Keypair.generate();
const fomoAttester = Keypair.generate();
ok(acctData(ecoPda()) === null, 'T10 no Ecosystem Config PDA yet');
{
  const w = newWallet();
  ok((await attempt(() => send([registerAttestedIx(w.publicKey, museAttester.publicKey, 1, 1)], [w, museAttester], 'attested before config'))) === 'Custom9', 'T10 RegisterAttested before config fails EcosystemNotConfigured');
  ok((await attempt(() => send([setAttesterIx(ecoAuthority.publicKey, 1, museAttester.publicKey)], [ecoAuthority], 'set attester before config'))) === 'Custom9', 'T10 SetAttester before config fails EcosystemNotConfigured');
  ok(acctData(regPda(w.publicKey)) === null, 'T10 nothing persisted');
}

console.log('=== T11: InitEcosystemConfig — one-time, signer becomes authority ===');
await send([initEcoIx(ecoAuthority.publicKey)], [ecoAuthority], 'init eco config');
{
  const d = acctData(ecoPda());
  ok(d !== null && d.length === 545, 'T11 Ecosystem Config exists at 545 bytes');
  ok(d[0] === 1, 'T11 tag = 1');
  ok(new PublicKey(d.subarray(1, 33)).equals(ecoAuthority.publicKey), 'T11 authority = init signer');
}
ok((await attempt(() => send([initEcoIx(ecoAuthority.publicKey)], [ecoAuthority], 're-init eco config'))) === 'Custom8', 'T11 second init fails AlreadyInit');

console.log('=== T12: SetAttester — authority-gated, slots land ===');
{
  const rando = newWallet();
  ok((await attempt(() => send([setAttesterIx(rando.publicKey, 1, museAttester.publicKey)], [rando], 'set attester as rando'))) === 'Custom7', 'T12 non-authority SetAttester fails BadAuthority');
  ok((await attempt(() => send([setAttesterIx(ecoAuthority.publicKey, 0, museAttester.publicKey)], [ecoAuthority], 'set attester eco 0'))) === 'Custom5', 'T12 ecosystem 0 fails BadEcosystem');
  ok((await attempt(() => send([setAttesterIx(ecoAuthority.publicKey, 17, museAttester.publicKey)], [ecoAuthority], 'set attester eco 17'))) === 'Custom5', 'T12 ecosystem 17 fails BadEcosystem');
  await send([setAttesterIx(ecoAuthority.publicKey, 1, museAttester.publicKey)], [ecoAuthority], 'set muse attester');
  await send([setAttesterIx(ecoAuthority.publicKey, 2, fomoAttester.publicKey)], [ecoAuthority], 'set fomo attester');
  ok(attesterSlot(1).equals(museAttester.publicKey), 'T12 Muse attester slot = muse key');
  ok(attesterSlot(2).equals(fomoAttester.publicKey), 'T12 FOMO attester slot = fomo key');
  ok(attesterSlot(3).equals(KP0), 'T12 Claude attester slot still unset (zero)');
}

console.log('=== T13: RegisterAttested — born tagged, fields exact ===');
const carol = newWallet();
await send([registerAttestedIx(carol.publicKey, museAttester.publicKey, 1, 1)], [carol, museAttester], 'carol attested-register (Muse)');
{
  const d = acctData(regPda(carol.publicKey));
  ok(d !== null && d.length === 48, 'T13 PDA at 48 bytes (layout unchanged)');
  ok(d[33] === 1, 'T13 kind = Agent (1)');
  ok(d[34] === 1, 'T13 verified_via = ATTESTED (1)');
  ok(d.readBigInt64LE(35) === TRIAL_TS, 'T13 registered_at = clock');
  ok(d[43] === 1, 'T13 active = 1');
  ok(d[44] === 1, 'T13 ecosystem byte = Muse (1)');
  ok(d[45] === 0 && d[46] === 0 && d[47] === 0, 'T13 remaining reserved bytes zero');
}

console.log('=== T14: RegisterAttested — wrong attester / bad ecosystem rejected ===');
{
  const w = newWallet();
  ok((await attempt(() => send([registerAttestedIx(w.publicKey, fomoAttester.publicKey, 1, 1)], [w, fomoAttester], 'fomo key attests Muse'))) === 'Custom6', 'T14 FOMO attester cannot attest Muse (NotAttester)');
  ok((await attempt(() => send([registerAttestedIx(w.publicKey, museAttester.publicKey, 1, 3)], [w, museAttester], 'attest unset ecosystem'))) === 'Custom6', 'T14 unset ecosystem (Claude) has no attester to match (NotAttester)');
  ok((await attempt(() => send([registerAttestedIx(w.publicKey, museAttester.publicKey, 1, 0)], [w, museAttester], 'attest eco 0'))) === 'Custom5', 'T14 ecosystem 0 fails BadEcosystem');
  ok(acctData(regPda(w.publicKey)) === null, 'T14 nothing persisted');
  // correct attester for FOMO works for a different wallet
  const f = newWallet();
  await send([registerAttestedIx(f.publicKey, fomoAttester.publicKey, 1, 2)], [f, fomoAttester], 'fomo attested-register');
  ok(acctData(regPda(f.publicKey))[44] === 2, 'T14 FOMO-tagged registration carries byte 2');
}

console.log('=== T15: self-tagging is impossible; AttestExisting upgrades in place ===');
const dave = newWallet();
{
  // Dave tries to smuggle an ecosystem byte through plain Register data.
  const smuggleIx = new TransactionInstruction({
    programId: REGISTRY, data: Buffer.from([0, 1, 1]),
    keys: [
      { pubkey: dave.publicKey, isSigner: true, isWritable: true },
      { pubkey: regPda(dave.publicKey), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  await send([smuggleIx], [dave], 'dave register with smuggled eco byte');
  const d0 = acctData(regPda(dave.publicKey));
  ok(d0[34] === 0 && d0[44] === 0, 'T15 smuggled ecosystem byte ignored — via=self-signed, tag absent');
  ok((await attempt(() => send([attestExistingIx(dave.publicKey, fomoAttester.publicKey, 1)], [dave, fomoAttester], 'dave attested by fomo key for Muse'))) === 'Custom6', 'T15 AttestExisting with wrong attester fails NotAttester');
  ok(acctData(regPda(dave.publicKey))[44] === 0, 'T15 still untagged after failed attest');
  await send([attestExistingIx(dave.publicKey, museAttester.publicKey, 1)], [dave, museAttester], 'dave attested Muse');
  const d1 = acctData(regPda(dave.publicKey));
  ok(d1[34] === 1 && d1[44] === 1, 'T15 AttestExisting writes via=ATTESTED, ecosystem=Muse');
  ok(d1.readBigInt64LE(35) === TRIAL_TS && d1[33] === 1, 'T15 registered_at and kind preserved');
  ok((await attempt(() => send([registerAttestedIx(dave.publicKey, museAttester.publicKey, 1, 1)], [dave, museAttester], 'attested-register over existing'))) === 'AlreadyRegistered', 'T15 RegisterAttested over an existing record fails AlreadyRegistered');
}

console.log('=== T16: attester rotation + clearing take effect immediately ===');
{
  const museAttester2 = Keypair.generate();
  await send([setAttesterIx(ecoAuthority.publicKey, 1, museAttester2.publicKey)], [ecoAuthority], 'rotate muse attester');
  ok(attesterSlot(1).equals(museAttester2.publicKey), 'T16 Muse slot rotated');
  const w = newWallet();
  ok((await attempt(() => send([registerAttestedIx(w.publicKey, museAttester.publicKey, 1, 1)], [w, museAttester], 'old attester after rotation'))) === 'Custom6', 'T16 old attester rejected after rotation');
  await send([registerAttestedIx(w.publicKey, museAttester2.publicKey, 1, 1)], [w, museAttester2], 'new attester registers');
  ok(acctData(regPda(w.publicKey))[44] === 1, 'T16 new attester registration tagged');
  // carol's earlier tag survives rotation — tags name the ecosystem, not the key.
  ok(acctData(regPda(carol.publicKey))[44] === 1, 'T16 pre-rotation attestation (carol) still tagged');
  await send([setAttesterIx(ecoAuthority.publicKey, 2, KP0)], [ecoAuthority], 'clear fomo attester');
  const w2 = newWallet();
  ok((await attempt(() => send([registerAttestedIx(w2.publicKey, fomoAttester.publicKey, 1, 2)], [w2, fomoAttester], 'attest with cleared attester'))) === 'Custom6', 'T16 cleared attester can no longer attest');
}

console.log('=== T17: TransferEcosystemAuthority ===');
{
  const newAuthority = newWallet();
  const rando = newWallet();
  ok((await attempt(() => send([transferEcoAuthIx(rando.publicKey, newAuthority.publicKey)], [rando], 'transfer as rando'))) === 'Custom7', 'T17 non-authority transfer fails BadAuthority');
  await send([transferEcoAuthIx(ecoAuthority.publicKey, newAuthority.publicKey)], [ecoAuthority], 'transfer authority');
  ok(new PublicKey(acctData(ecoPda()).subarray(1, 33)).equals(newAuthority.publicKey), 'T17 authority field updated');
  ok((await attempt(() => send([setAttesterIx(ecoAuthority.publicKey, 3, museAttester.publicKey)], [ecoAuthority], 'old authority sets attester'))) === 'Custom7', 'T17 old authority locked out after transfer');
  const claudeAttester = Keypair.generate();
  await send([setAttesterIx(newAuthority.publicKey, 3, claudeAttester.publicKey)], [newAuthority], 'new authority sets attester');
  ok(attesterSlot(3).equals(claudeAttester.publicKey), 'T17 new authority can configure attesters');
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
fs.writeFileSync(path.join(DIR, 'trial-result.json'), JSON.stringify({ registry: REGISTRY.toBase58(), pass, fail }, null, 2));
if (fail > 0) process.exit(1);

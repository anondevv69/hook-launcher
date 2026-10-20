// entry.mjs — the in-browser Hook Launcher. Exposes createHookLaunch():
// a factory whose step builders mirror launch.mjs's LIVE execution blocks
// one-for-one, using the SAME pure code (helpers.generated.mjs is sliced
// out of launch.mjs by extract-helpers.mjs) and the SAME Meteora DBC SDK.
//
// Signing model: the connected wallet is the launcher (fee payer, config
// authority unless the spec says otherwise, fee claimer). Two ephemeral
// keypairs — the DBC config account and the base mint — are generated per
// launch session, partially sign their creation steps (L1/L2), and are
// powerless afterwards (config is program-owned state; mint authority
// moves to the pool authority at pool creation). Session JSON (including
// those secrets) is meant to live only in the visitor's browser storage
// so an interrupted launch can resume; the launch record never contains
// secrets.
import './shim.mjs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';
import * as H from './helpers.generated.mjs';
import { RULES as GENERATED_RULES, IMPLEMENTED_IDS as GENERATED_IMPLEMENTED_IDS, GUARD } from './rules.generated.mjs';
import { LAUNCH_TAG_SECRET } from './tag.mjs';

// The launch signer keypair (Feature A). Its secret is embedded in
// this bundle ON PURPOSE — see tag.mjs for the full security note: the
// key is fundless and powerless, its only value is as a launch label,
// and compromise means spoofed tags, never funds. It partially signs
// both creation steps read-only (the placement verified in
// HookedPad's creation transactions); each step appends the tag memo
// as the carrying instruction, because the legacy web3.js compiler
// rejects a signer no instruction references. LAUNCH_SIGNER is its
// public identity — the constant platform launch signer printed in
// plans and launch records.
const TAG_KP = Keypair.fromSecretKey(Uint8Array.from(LAUNCH_TAG_SECRET));
const LAUNCH_SIGNER = TAG_KP.publicKey;

// ---- generated rule parity (launcher/bin/gen-rules.mjs) ----
// The composer's selectable rule set comes from rules.generated.mjs,
// which is generated from the engine source (engine/src/lib.rs
// rule_implemented()) — never a hand-maintained list here. Implemented
// rules are selectable; known-but-unimplemented rules are not.
const SELECTABLE_RULE_IDS = [...GENERATED_IMPLEMENTED_IDS];

// Composer-side guard (backstop; launch.mjs enforces independently):
// while GUARD.fixedEngineSha256 is null, the v4 engine crank fix has not
// been verified live, so a spec enabling rule 1 (Basis Latch) with
// graduation "never" must be refused with a plain explanation.
export const GUARD_MESSAGE = 'Basis Latch with graduation "never" cannot be launched yet: the engine fix that makes the price crank safe for a never-graduating Basis Latch token has not been verified live. Launch with graduation "release", or without Basis Latch, until that verification lands.';
export const GUARD_HOUSE_MESSAGE = 'Basis Latch with graduation "house" cannot be launched yet: a house token\'s curve is built with the same never-graduating threshold, so it needs the same verified engine crank fix, which has not been verified live. Launch with graduation "release", or without Basis Latch, until that verification lands.';
function assertComboAllowed(spec) {
  if (GUARD.fixedEngineSha256 != null) return;
  const grad = spec && spec.graduation != null ? String(spec.graduation).toLowerCase() : 'release';
  if (grad !== 'never' && grad !== 'house') return;
  const hasLatch = (spec.rules ?? []).some((entry) => {
    if (entry.enabled === false) return false;
    try { return H.ruleIdOf(entry) === 1; } catch { return false; }
  });
  // Phase C: rule 1 + house rides never physics (the curve is built with
  // the u64::MAX threshold), so the same guard refuses it while
  // GUARD.fixedEngineSha256 is null. Rule 2's own gates (requires
  // graduation "house" + rule 1) are enforced by H.validateSpec.
  if (hasLatch) throw new Error(grad === 'house' ? GUARD_HOUSE_MESSAGE : GUARD_MESSAGE);
}

const B58 = (pk) => pk.toBase58();

function prep(spec) {
  const mode = H.MODES[String(spec.authorityMode ?? 'locked').toLowerCase()];
  const rules = (spec.rules ?? []).map((entry) => ({ id: H.ruleIdOf(entry), entry, enabled: entry.enabled !== false }));
  const graduation = H.resolveGraduation(spec);
  return {
    mode,
    rules,
    hasRule: (id) => rules.some((r) => r.id === id && r.enabled),
    decimals: spec.decimals ?? 6,
    graduation,
    thresholdSol: graduation.thresholdSol,
    rentVaultSol: spec.rentVaultSol ?? 0.05,
    holderFees: H.resolveFees(spec).holderFees,
    fees: H.resolveFees(spec),
    devBuy: H.resolveDevBuy(spec),
  };
}

export function createHookLaunch() {
  const programs = {
    engine: B58(H.ENGINE), registry: B58(H.REGISTRY),
    distributor: B58(H.DISTRIBUTOR), dbc: B58(H.DBC_ID),
    token2022: B58(TOKEN_2022_PROGRAM_ID),
  };

  function validateSpec(spec) {
    assertComboAllowed(spec); // generated guard (Basis Latch + never)
    return { warnings: H.validateSpec(spec) };
  }

  function applicableSteps(spec) {
    const p = prep(spec);
    const steps = ['L1', 'L2', 'L3', 'L4'];
    if (p.hasRule(1)) steps.push('L4b');
    steps.push('L5');
    if (p.holderFees) steps.push('L7');
    if (p.holderFees && p.hasRule(3)) steps.push('L7b');
    if (p.devBuy) {
      // Feature B prerequisites + the buy itself, mirroring launch.mjs:
      // register/sync only when a gate rule (3/17) checks the launcher's
      // own destination mirror; crank only with rule 1; the ATA step is
      // proof-skipped by the page when the ATA already exists.
      if (p.hasRule(3) || p.hasRule(17)) steps.push('L8', 'L8b');
      if (p.hasRule(1)) steps.push('L8c');
      steps.push('L8d', 'L9');
    }
    return steps;
  }

  // ---- sessions ----
  function createSession(spec, opts = {}) {
    assertComboAllowed(spec); // generated guard (Basis Latch + never)
    H.validateSpec(spec); // hard-fail early, exactly like launch.mjs
    const dbcConfigKp = opts.dbcConfigSecret ? Keypair.fromSecretKey(Uint8Array.from(opts.dbcConfigSecret)) : (opts.dbcConfigPubkey ? null : Keypair.generate());
    const mintKp = opts.mintSecret ? Keypair.fromSecretKey(Uint8Array.from(opts.mintSecret)) : (opts.mintPubkey ? null : Keypair.generate());
    return {
      v: 1,
      spec,
      dbcConfigSecret: dbcConfigKp ? Array.from(dbcConfigKp.secretKey) : (opts.dbcConfigSecret ?? null),
      mintSecret: mintKp ? Array.from(mintKp.secretKey) : (opts.mintSecret ?? null),
      dbcConfigPubkey: dbcConfigKp ? B58(dbcConfigKp.publicKey) : (opts.dbcConfigPubkey ?? null),
      mintPubkey: mintKp ? B58(mintKp.publicKey) : (opts.mintPubkey ?? null),
      signatures: opts.signatures ? { ...opts.signatures } : {},
      stepsDone: opts.stepsDone ? [...opts.stepsDone] : [],
      createdAt: opts.createdAt ?? new Date().toISOString(),
    };
  }
  function serializeSession(session) {
    const { v, spec, dbcConfigSecret, mintSecret, dbcConfigPubkey, mintPubkey, signatures, stepsDone, createdAt } = session;
    return { v, spec, dbcConfigSecret, mintSecret, dbcConfigPubkey, mintPubkey, signatures, stepsDone, createdAt };
  }
  function sessionKeypairs(session) {
    return {
      dbcConfig: session.dbcConfigSecret ? Keypair.fromSecretKey(Uint8Array.from(session.dbcConfigSecret)) : null,
      baseMint: session.mintSecret ? Keypair.fromSecretKey(Uint8Array.from(session.mintSecret)) : null,
    };
  }
  function sessionPubkeys(session) {
    const kps = sessionKeypairs(session);
    return {
      dbcConfig: kps.dbcConfig ? kps.dbcConfig.publicKey : new PublicKey(session.dbcConfigPubkey),
      mint: kps.baseMint ? kps.baseMint.publicKey : new PublicKey(session.mintPubkey),
    };
  }

  function addresses(session, launcherPubkey) {
    const { dbcConfig, mint } = sessionPubkeys(session);
    const pool = H.deriveDbcPoolAddress(H.NATIVE_MINT, mint, dbcConfig);
    const poolAuthority = H.deriveDbcPoolAuthority();
    const baseVault = H.deriveDbcTokenVaultAddress(pool, mint);
    const quoteVault = H.deriveDbcTokenVaultAddress(pool, H.NATIVE_MINT);
    const distState = H.distPda(mint);
    const distVault = getAssociatedTokenAddressSync(mint, distState, true, TOKEN_2022_PROGRAM_ID);
    const launcherAta = getAssociatedTokenAddressSync(mint, launcherPubkey, false, TOKEN_2022_PROGRAM_ID);
    const p = prep(session.spec);
    return {
      dbcConfig, mint, pool, poolAuthority, baseVault, quoteVault,
      engineConfig: H.configPda(mint), metaList: H.metaPda(mint),
      priceFeed: p.hasRule(1) ? H.pricePda(mint) : null,
      rentVault: H.rentVaultPda(mint),
      distributorState: distState, distributorVault: distVault,
      registration: PublicKey.findProgramAddressSync([Buffer.from('registration'), launcherPubkey.toBuffer()], H.REGISTRY)[0],
      // Engine v3: the launcher's holder record keys by its ATA.
      launcherHolder: H.pdaE([Buffer.from('holder'), mint.toBuffer(), launcherAta.toBuffer()]),
      launcherAta,
    };
  }
  function addressesB58(session, launcherPubkey) {
    const a = addresses(session, launcherPubkey);
    const out = {};
    for (const [k, v] of Object.entries(a)) out[k] = v ? B58(v) : null;
    return out;
  }

  function authorityOf(session, launcherPubkey) {
    return session.spec.authority ? new PublicKey(session.spec.authority) : launcherPubkey;
  }
  function feeClaimerOf(session, launcherPubkey) {
    return session.spec.feeClaimer ? new PublicKey(session.spec.feeClaimer) : launcherPubkey;
  }

  // ---- plan + budget (mirrors launch.mjs's plan text and budget math) ----
  function plan(session, launcherPubkey) {
    const spec = session.spec;
    const p = prep(spec);
    const a = addresses(session, launcherPubkey);
    const authority = authorityOf(session, launcherPubkey);
    const feeClaimer = feeClaimerOf(session, launcherPubkey);
    const lines = [];
    if (p.fees.destination === 'holders' && !feeClaimer.equals(launcherPubkey)) throw new Error('feeDestination "holders" requires feeClaimer to be the launching wallet — it performs the claim -> convert -> route duty (hook.mjs claim-fees). Use the launcher as feeClaimer or set feeDestination "creator".');
    const migrationDesc = p.graduation.mode === 'never'
      ? `migration threshold ${H.NEVER_THRESHOLD_SOL} SOL (u64::MAX lamports — set to never complete; this token never migrates)`
      : p.graduation.mode === 'house'
        ? `migration threshold ${H.NEVER_THRESHOLD_SOL} SOL (u64::MAX lamports — never physics; the token graduates onto the house venue at ${p.graduation.houseThresholdSol} SOL of curve quote reserve instead)`
        : `migration threshold ${p.thresholdSol} SOL → DAMM v2`;
    const meta = H.resolveMetadata(spec);
    lines.push(['L0', 'token metadata — must be LIVE before L2 (never an empty URI)', 'static hosting at agentonly.fun + a live fetch check by this page', meta.source === 'spec'
      ? `operator-supplied metadataUri used verbatim: ${meta.uri} — before L2 this page fetches it and refuses to continue if it does not resolve to parseable JSON (contents are the operator's responsibility)`
      : `uri written at L2 = ${meta.uri} (image ${meta.imageUri}) — stage the files first with the CLI (node launch.mjs <spec> --stage-metadata) or by hand at those URLs; before L2 this page fetches the JSON and refuses to continue if it is missing, unparseable, or names a different token`]);
    lines.push(['L1', 'DBC createConfigWithTransferHook', `program ${programs.dbc}`, `config=${B58(a.dbcConfig)} fee_claimer=${B58(feeClaimer)} hook=${programs.engine} curve: ${(spec.supply ?? 1_000_000_000).toLocaleString('en-US')} supply, creator fee ${p.fees.feeBps}bps${p.fees.feeBpsEnd !== p.fees.feeBps ? ` decaying to ${p.fees.feeBpsEnd}bps` : ' flat'}, ${migrationDesc}; ${H.configFieldsText(p.thresholdSol, spec)}; ${H.partnerIdentityText(feeClaimer)}; launch signer=${B58(LAUNCH_SIGNER)} — LAUNCH_SIGNER co-signs this creation transaction READ-ONLY (the attribution placement verified from HookedPad's creation transactions; enumerates every AgentOnly launch by signature; carried by the appended tag memo — our legacy signing stack cannot compile an unreferenced signer)`]);
    lines.push(['FEE', 'creator fee — set at launch, claimed on demand', 'venue fee direction (the hook never touches fees)', `${p.fees.feeBps} bps of every trade accrues to fee_claimer=${B58(feeClaimer)}; destination: ${p.fees.destination === 'holders' ? 'HOLDERS — the claimer claims, converts, and routes into the Distributor vault (hook.mjs claim-fees); anyone cranks the fold' : 'CREATOR — the claimer keeps the fees, claimed as SOL with hook.mjs claim-fees'}`]);
    lines.push(['GRADUATION', p.graduation.mode === 'never' ? 'never — the rules are permanent' : p.graduation.mode === 'house' ? 'house — graduate at the house threshold onto the house venue, the rules stay' : 'release — the rules retire at graduation', p.graduation.mode === 'house' ? 'house commitment (engine Config house region, written at L3) + DBC curve built with never physics' : 'DBC migration threshold (set in the L1 config)', p.graduation.mode === 'never'
      ? `threshold = ${H.NEVER_THRESHOLD_LAMPORTS} lamports (u64::MAX ≈ 18,446,744,073.71 SOL — more than the entire SOL supply): the curve can never complete, so this token never migrates to DAMM v2, the hook keeps enforcing the rules on every transfer forever, the 20% migration tranche stays locked in the pool vault, and only hook-aware doors can ever trade it`
      : p.graduation.mode === 'house'
        ? `the curve is built with the never threshold (${H.NEVER_THRESHOLD_LAMPORTS} lamports — it can never complete or migrate, and stays as the legacy door), and the token graduates onto the house venue instead when the curve's quote reserve reaches ${p.graduation.houseThresholdSol} SOL and the house pool is seeded: activation is permissionless (engine tag 14 + houseswap tag 5), the rules stay enforced, and doors default to the house pool from activation on. NOTE: the browser composer prints the CLI's house plan for parity of text; the H0–H6 house steps themselves are executed by the CLI launcher in this build`
        : `at ${p.thresholdSol} SOL raised the curve completes: the token migrates to DAMM v2, the hook is revoked, the rules retire, and the token trades freely everywhere`]);
    lines.push(['L2', 'DBC createPoolWithTransferHook', `program ${programs.dbc}`, `mint=${B58(a.mint)} pool=${B58(a.pool)} name="${spec.name}" symbol="${spec.symbol}" uri="${H.resolveMetadata(spec).uri}" (mint is created BY DBC carrying the ENGINE hook; hook authority moves to the pool authority) + launch signer ${B58(LAUNCH_SIGNER)} (LAUNCH_SIGNER co-signs this creation transaction READ-ONLY — the attribution placement verified from HookedPad's creation transactions) + launch tag memo "${H.LAUNCH_TAG_MARKER}" (SPL Memo ${B58(H.MEMO_PROGRAM_ID)}, sole signer ${B58(LAUNCH_SIGNER)} read-only — the fundless platform launch signer; identifies our launches to terminals/routers, changes nothing else in the tx)`]);
    lines.push(['L3', 'engine InitializeConfig', `program ${programs.engine}`, `config PDA=${B58(a.engineConfig)} mode=${spec.authorityMode ?? 'locked'}(${p.mode}) authority=${B58(authority)} rules=[${p.rules.map((r) => `${r.id} ${H.RULE_NAMES[r.id]}`).join(', ') || 'none'}] venues=[DBC] exemptions=[poolAuthority=${B58(a.poolAuthority)}, baseVault=${B58(a.baseVault)}]`]);
    const tpl = H.requiredExtras(p.rules);
    lines.push(['L4', 'engine InitializeExtraAccountMetas (templated per config)', `program ${programs.engine}`, `meta list PDA=${B58(a.metaList)} (${tpl.count} extras: ${tpl.extras.map(e => `${e.name} — ${e.why}`).join('; ')}; ${H.metaListSize(tpl.count)} bytes${tpl.staticList ? ' — no holder state: fully static, generic-resolver safe' : ''})`]);
    if (p.hasRule(1)) lines.push(['L4b', 'engine InitializePriceFeed', `program ${programs.engine}`, `feed PDA=${B58(a.priceFeed)} pool=${B58(a.pool)} token_vault=${B58(a.baseVault)} quote_vault=${B58(a.quoteVault)} decimals=${p.decimals}/${9}`]);
    lines.push(['L5', 'fund rent-vault PDA', 'system transfer', `${p.rentVaultSol} SOL → ${B58(a.rentVault)} (≈ ${Math.floor(p.rentVaultSol / H.RENT.holderPda)} lazy Holder PDAs)`]);
    lines.push(['L6', '(advisory, per buyer)', '—', tpl.staticList
      ? 'none needed — this token\'s meta list is fully static (no AccountData seeds), so generic resolvers and routers can build a first buy before the buyer\'s ATA exists; the generic [create ATA, swap] bundle just works'
      : 'before a buyer\'s first swap build, ensure their base ATA exists on-chain (build-time meta resolution reads it; ATA creation fires no hook)']);
    if (p.holderFees) lines.push(['L7', 'Distributor initialize (+ fee vault ATA)', `program ${programs.distributor}`, `state PDA=${B58(a.distributorState)} vault ATA=${B58(a.distributorVault)} (owner = state PDA) caller_cut=${p.holderFees.callerCutBps}bps; funding mode auto-derives from the mint (DBC mint = no fee extension → mode 1, routed).`]);
    if (p.holderFees && p.hasRule(3)) lines.push(['L7b', 'engine SyncRegistered (authority path) for the Distributor vault owner', `program ${programs.engine}`, `holder PDA for owner=${B58(a.distributorState)} gets registered=1 — the vault is a PDA and can never self-register, and rule 3 (Agent-Only) checks the DESTINATION mirror on every transfer; without this the claimer's routing deposits into the vault would be vetoed NotRegistered.`]);
    if (p.devBuy) {
      if (p.hasRule(3) || p.hasRule(17)) {
        lines.push(['L8', 'DEV BUY prerequisite — register the launcher wallet in the Registry', `program ${programs.registry}`, `the dev buy's destination is the launcher wallet itself, and rule ${p.hasRule(3) ? '3 (Agent-Only)' : '17 (Ecosystem Gate)'} checks the destination's registration mirror — conditional step: skipped automatically if a Registration PDA for ${B58(launcherPubkey)} already exists (the page checks the chain first)${p.hasRule(17) ? '; NOTE for rule 17: a plain registration carries ecosystem 0 — the buy passes only if the launcher\'s existing registration is attested for this token\'s ecosystem; attestation needs the ecosystem attester\'s co-signature, which the launcher cannot give itself' : ''}`]);
        lines.push(['L8b', 'DEV BUY prerequisite — sync the launcher registration into this token\'s Holder PDA', `program ${programs.engine}`, `engine SyncRegistered (self path) for owner=${B58(launcherPubkey)} — conditional step: skipped automatically if the Holder PDA already exists (the page checks the chain first)`]);
      }
      if (p.hasRule(1)) lines.push(['L8c', 'DEV BUY prerequisite — crank the price feed (CrankPriceDbc)', `program ${programs.engine}`, `rule 1 (Basis Latch) records the buyer's basis from the feed EMA and fails closed on a stale feed — the first crank must land before the first buy (the Latch mainnet order); accounts: config=${B58(a.engineConfig)} feed=${B58(a.priceFeed)} pool=${B58(a.pool)}`]);
      lines.push(['L8d', 'DEV BUY prerequisite — create the launcher\'s base ATA', 'system + token-2022', `the swap build resolves hook metas from the destination ATA's owner field — it must exist before the L9 build (conditional: proof-skipped when it already exists)`]);
      lines.push(['L9', `DEV BUY — launcher buys ${p.devBuy.sol} SOL of ${spec.symbol} on the curve (first swap after activation)`, `program ${programs.dbc} (swap2WithTransferHook)`, `its OWN transaction, submitted immediately after activation (L4/L4b/L5 + L7/L7b + the L8 prerequisites above) inside this same launch run, nothing else intervening. NOT atomic with activation: the swap build resolves the hook's extra accounts by reading the on-chain meta list, which exists only after L4 lands — so no same-transaction dev buy exists on the standard build path. Guarantee, exactly: first swap after activation, submitted by the launcher in the same run; a third party landing in an earlier slot could theoretically precede it.`]);
    }
    const parts = {
      configPda: H.RENT.configPda, metaList: H.metaListRent(H.requiredExtras(p.rules).count),
      priceFeed: p.hasRule(1) ? H.RENT.priceFeed : 0,
      distributor: p.holderFees ? H.RENT.distState + H.RENT.tokenAccount : 0,
      rentVault: p.rentVaultSol, seed: spec.seedSol ?? 0,
      devBuy: p.devBuy ? p.devBuy.sol : 0,
    };
    const total = parts.configPda + parts.metaList + parts.priceFeed + parts.distributor + parts.rentVault + parts.seed + parts.devBuy;
    return { lines, budget: { parts, total } };
  }

  // ---- step builders (mirror launch.mjs LIVE blocks) ----
  async function buildStepTx(session, stepId, { connection, launcherPubkey }) {
    const spec = session.spec;
    const p = prep(spec);
    const a = addresses(session, launcherPubkey);
    const authority = authorityOf(session, launcherPubkey);
    const feeClaimer = feeClaimerOf(session, launcherPubkey);
    if (p.fees.destination === 'holders' && !feeClaimer.equals(launcherPubkey)) throw new Error('feeDestination "holders" requires feeClaimer to be the launching wallet — it performs the claim -> convert -> route duty (hook.mjs claim-fees).');
    const client = new DynamicBondingCurveClient(connection, 'confirmed');
    switch (stepId) {
      case 'L1': {
        const tx = await client.partner.createConfigWithTransferHook({
          config: a.dbcConfig, feeClaimer, leftoverReceiver: feeClaimer, payer: launcherPubkey,
          quoteMint: H.NATIVE_MINT, transferHookProgram: H.ENGINE, ...H.curveConfig(p.thresholdSol, spec),
        });
        // Feature A: the launch signer co-signs this transaction
        // read-only (see partialSigners — the HookedPad placement);
        // the appended memo is the carrying instruction, because the
        // legacy web3.js compiler rejects a signer no instruction
        // references. Mirrors the CLI flow exactly.
        tx.add(H.buildTagMemoIx(TAG_KP.publicKey));
        return tx;
      }
      case 'L2': {
        const tx = await client.creator.createPoolWithTransferHook({
          baseMint: a.mint, config: a.dbcConfig, transferHookProgram: H.ENGINE,
          name: spec.name, symbol: spec.symbol, uri: H.resolveMetadata(spec).uri,
          payer: launcherPubkey, poolCreator: launcherPubkey,
        });
        // Feature A: the launch signer co-signs this transaction
        // read-only (see partialSigners — the HookedPad placement),
        // and ONE memo instruction is appended, signed read-only by
        // the same embedded fundless keypair (see tag.mjs). Identical
        // shape to the CLI flow (same shared builder in
        // helpers.generated.mjs).
        tx.add(H.buildTagMemoIx(TAG_KP.publicKey));
        return tx;
      }
      case 'L3': {
        const cfg = { mode: p.mode, authority, rules: p.rules, venues: [H.DBC_ID], exemptions: [a.poolAuthority, a.baseVault] };
        const ix = new TransactionInstruction({
          programId: H.ENGINE, data: H.configPayload(cfg, 1),
          keys: [H.K(launcherPubkey, true, true), H.K(a.mint, false, false), H.K(a.engineConfig, false, true), H.K(SystemProgram.programId, false, false)],
        });
        return new Transaction().add(ix);
      }
      case 'L4': {
        const ix = new TransactionInstruction({
          programId: H.ENGINE, data: H.INIT_METAS_DISC,
          keys: [H.K(launcherPubkey, true, true), H.K(a.metaList, false, true), H.K(a.mint, false, false), H.K(SystemProgram.programId, false, false), H.K(a.engineConfig, false, false)],
        });
        return new Transaction().add(ix);
      }
      case 'L4b': {
        const data = Buffer.concat([Buffer.from([6]), a.pool.toBuffer(), a.baseVault.toBuffer(), a.quoteVault.toBuffer(), Buffer.from([p.decimals, 9])]);
        const ix = new TransactionInstruction({
          programId: H.ENGINE, data,
          keys: [H.K(launcherPubkey, true, true), H.K(a.mint, false, false), H.K(a.engineConfig, false, false), H.K(a.priceFeed, false, true), H.K(SystemProgram.programId, false, false)],
        });
        return new Transaction().add(ix);
      }
      case 'L5': {
        const ix = SystemProgram.transfer({ fromPubkey: launcherPubkey, toPubkey: a.rentVault, lamports: Math.round(p.rentVaultSol * LAMPORTS_PER_SOL) });
        return new Transaction().add(ix);
      }
      case 'L7': {
        const cut = p.holderFees.callerCutBps;
        const data = Buffer.from([0, cut & 0xff, (cut >> 8) & 0xff]);
        const createVault = createAssociatedTokenAccountInstruction(launcherPubkey, a.distributorVault, a.distributorState, a.mint, TOKEN_2022_PROGRAM_ID);
        const init = new TransactionInstruction({
          programId: H.DISTRIBUTOR, data,
          keys: [H.K(launcherPubkey, true, true), H.K(a.mint, false, false), H.K(a.distributorVault, false, false), H.K(a.distributorState, false, true), H.K(SystemProgram.programId, false, false)],
        });
        return new Transaction().add(createVault, init);
      }
      case 'L7b': {
        // SyncRegistered path (a): the config authority (the launcher, in
        // the supported shape) sets the vault owner's registered mirror.
        // Engine v3: the mirror lands in the record keyed by the vault
        // owner's ATA for the mint — which is the distributor vault itself.
        const holderPda = H.pdaE([Buffer.from('holder'), a.mint.toBuffer(), a.distributorVault.toBuffer()]);
        const ix = new TransactionInstruction({
          programId: H.ENGINE, data: Buffer.from([4, 1]),
          keys: [H.K(launcherPubkey, true, true), H.K(a.mint, false, false), H.K(a.engineConfig, false, false), H.K(a.distributorState, false, false), H.K(holderPda, false, true), H.K(SystemProgram.programId, false, false)],
        });
        return new Transaction().add(ix);
      }
      case 'L8': {
        // DEV BUY prerequisite: register the launcher wallet (kind 1 =
        // Agent, the hook.mjs default). The page proof-skips this step
        // when the Registration PDA already exists.
        const ix = new TransactionInstruction({
          programId: H.REGISTRY, data: Buffer.from([0, 1]),
          keys: [H.K(launcherPubkey, true, true), H.K(a.registration, false, true), H.K(SystemProgram.programId, false, false)],
        });
        return new Transaction().add(ix);
      }
      case 'L8b': {
        // DEV BUY prerequisite: SyncRegistered path (b) — registration
        // PDA appended as the final account (mirrors hook.mjs syncIx).
        const ix = new TransactionInstruction({
          programId: H.ENGINE, data: Buffer.from([4, 0]),
          keys: [H.K(launcherPubkey, true, true), H.K(a.mint, false, false), H.K(a.engineConfig, false, false), H.K(launcherPubkey, false, false), H.K(a.launcherHolder, false, true), H.K(SystemProgram.programId, false, false), H.K(a.registration, false, false)],
        });
        return new Transaction().add(ix);
      }
      case 'L8c': {
        // DEV BUY prerequisite: CrankPriceDbc (engine tag 8) — accounts
        // [config(ro), priceFeed(w), pool(ro)], mirrors the CLI + the
        // dbc-latch integration construction.
        const ix = new TransactionInstruction({
          programId: H.ENGINE, data: Buffer.from([8]),
          keys: [H.K(a.engineConfig, false, false), H.K(a.priceFeed, false, true), H.K(a.pool, false, false)],
        });
        return new Transaction().add(ix);
      }
      case 'L8d': {
        // DEV BUY prerequisite: the launcher's base ATA must exist
        // before the L9 swap BUILD (build-time meta resolution reads
        // its owner field). Proof-skipped by the page when present.
        const ix = createAssociatedTokenAccountInstruction(launcherPubkey, a.launcherAta, launcherPubkey, a.mint, TOKEN_2022_PROGRAM_ID);
        return new Transaction().add(ix);
      }
      case 'L9': {
        // DEV BUY: the first swap after activation, its own transaction
        // (see resolveDevBuy in launch.mjs for why same-tx is
        // impossible on the standard build path). No distributor
        // settles: the Distributor was initialized in this same run,
        // index still 0, first-touch accounting starts at 0.
        return client.pool.swap2WithTransferHook({
          swapMode: SwapMode.ExactIn, swapBaseForQuote: false,
          amountIn: new BN(p.devBuy.lamports), minimumAmountOut: new BN(0),
          owner: launcherPubkey, pool: a.pool, referralTokenAccount: null, payer: launcherPubkey,
        });
      }
      default:
        throw new Error('unknown launch step: ' + stepId);
    }
  }

  function partialSigners(session, stepId) {
    const kps = sessionKeypairs(session);
    if (stepId === 'L1') return [...(kps.dbcConfig ? [kps.dbcConfig] : []), TAG_KP];
    if (stepId === 'L2') return [...(kps.baseMint ? [kps.baseMint] : []), TAG_KP];
    return [];
  }

  // Accounts whose existence on-chain proves a step already landed (resume).
  function stepProofAccount(session, stepId, launcherPubkey) {
    const a = addresses(session, launcherPubkey);
    switch (stepId) {
      case 'L1': return a.dbcConfig;
      case 'L2': return a.pool;
      case 'L3': return a.engineConfig;
      case 'L4': return a.metaList;
      case 'L4b': return a.priceFeed;
      case 'L7': return a.distributorState;
      case 'L7b': return H.pdaE([Buffer.from('holder'), a.mint.toBuffer(), a.distributorState.toBuffer()]);
      case 'L8': return a.registration;
      case 'L8b': return a.launcherHolder;
      case 'L8d': return a.launcherAta;
      default: return null; // L5 is a transfer; L8c (crank) and L9 (buy) have no proof account
    }
  }

  function buildRecord(session, launcherPubkey, rpcUrl) {
    const spec = session.spec;
    const p = prep(spec);
    const a = addresses(session, launcherPubkey);
    return {
      version: 1, name: spec.name, symbol: spec.symbol, decimals: p.decimals, launchedAt: new Date().toISOString(),
      rpc: rpcUrl, spec,
      programs: { engine: programs.engine, registry: programs.registry, distributor: programs.distributor, dbc: programs.dbc, token2022: programs.token2022 },
      addresses: {
        launcher: B58(launcherPubkey), authority: B58(authorityOf(session, launcherPubkey)), feeClaimer: B58(feeClaimerOf(session, launcherPubkey)),
        dbcConfig: B58(a.dbcConfig), mint: B58(a.mint), pool: B58(a.pool),
        poolAuthority: B58(a.poolAuthority), baseVault: B58(a.baseVault), quoteVault: B58(a.quoteVault),
        engineConfig: B58(a.engineConfig), metaList: B58(a.metaList),
        priceFeed: p.hasRule(1) ? B58(a.priceFeed) : null, rentVault: B58(a.rentVault),
        distributor: p.holderFees ? { state: B58(a.distributorState), vault: B58(a.distributorVault), callerCutBps: p.holderFees.callerCutBps, fundingMode: 'auto (DBC mint → 1, routed)', routingTarget: B58(a.distributorVault) } : null,
      },
      rules: p.rules.map((r) => ({ id: r.id, name: H.RULE_NAMES[r.id], enabled: r.enabled, params: r.entry })),
      fees: { feeBps: p.fees.feeBps, feeBpsEnd: p.fees.feeBpsEnd, destination: p.fees.destination, feeClaimer: B58(feeClaimerOf(session, launcherPubkey)), claimCommand: 'node hook.mjs claim-fees' },
      graduation: { mode: p.graduation.mode, thresholdSol: p.graduation.thresholdSol, thresholdLamports: p.graduation.thresholdLamports != null ? p.graduation.thresholdLamports.toString() : null,
        ...(p.graduation.mode === 'house' ? { houseThresholdSol: p.graduation.houseThresholdSol, houseThresholdLamports: p.graduation.houseThresholdLamports.toString() } : {}) },
      authorityMode: spec.authorityMode ?? 'locked',
      launchSigner: B58(LAUNCH_SIGNER),
      launchTag: { program: B58(H.MEMO_PROGRAM_ID), marker: H.LAUNCH_TAG_MARKER, signer: B58(TAG_KP.publicKey), location: 'L2 transaction, final instruction' },
      metadata: (() => { const m = H.resolveMetadata(spec); return { source: m.source, uri: m.uri, image: m.imageUri, verified: 'checked live by the page before L2' }; })(),
      partnerIdentity: (() => { const fc = feeClaimerOf(session, launcherPubkey); return { name: H.PARTNER_IDENTITY.name, website: H.PARTNER_IDENTITY.website, logo: H.PARTNER_IDENTITY.logo, metadataAccount: B58(H.derivePartnerMetadata(fc)), feeClaimer: B58(fc), verified: 'checked live by the page before L1' }; })(),
      // received is null here: the browser record does not re-read the
      // ATA balance into the record (the CLI record measures it exactly).
      devBuy: p.devBuy ? { sol: p.devBuy.sol, tx: session.signatures.devBuy ?? null, received: null } : null,
      signatures: { ...session.signatures },
    };
  }

  // Metadata gate (discovery fix): the composer cannot stage files, so
  // before L2 it verifies the metadata JSON is LIVE at the resolved URI
  // and names THIS token. The CLI stages with --stage-metadata.
  async function verifyMetadata(session) {
    const meta = H.resolveMetadata(session.spec);
    let res;
    try { res = await fetch(meta.uri); } catch (e) {
      throw new Error(`metadata check: cannot fetch ${meta.uri} (${e.message}) — stage the metadata first (CLI: node launch.mjs <spec> --stage-metadata) or set spec.metadataUri to a live JSON URL`);
    }
    if (!res.ok) throw new Error(`metadata check: ${meta.uri} returned HTTP ${res.status} — the mint would be born pointing at a dead URI. Stage the metadata first (CLI: node launch.mjs <spec> --stage-metadata) or set spec.metadataUri.`);
    let doc;
    try { doc = await res.json(); } catch { throw new Error(`metadata check: ${meta.uri} did not return parseable JSON`); }
    if (meta.source === 'generated' && (doc.name !== session.spec.name || doc.symbol !== session.spec.symbol)) {
      throw new Error(`metadata check: the JSON at ${meta.uri} names "${doc.name} (${doc.symbol})", not this launch — refusing to launch against another token's metadata`);
    }
    return meta;
  }

  // Partner-identity gate (discovery fix, Phase A): the L1 config hangs
  // from a partner identity through its fee_claimer alone, so before L1
  // the page verifies the fee claimer's partner-metadata account exists
  // on-chain. The launching wallet's own metadata is REQUIRED (refusal —
  // the CLI enforces the identical rule); an operator-supplied fee
  // claimer carries its own identity, or none (warning, launch proceeds).
  async function verifyPartnerIdentity(session, { connection, launcherPubkey }) {
    const feeClaimer = feeClaimerOf(session, launcherPubkey);
    const metadataAccount = H.derivePartnerMetadata(feeClaimer);
    const client = new DynamicBondingCurveClient(connection, 'confirmed');
    let md = null;
    try { md = await client.state.getPartnerMetadata(feeClaimer); } catch { md = null; }
    if (md) return { name: md.name, website: md.website, logo: md.logo, metadataAccount: B58(metadataAccount), feeClaimer: B58(feeClaimer) };
    if (feeClaimer.equals(launcherPubkey)) {
      throw new Error(`partner identity check: no partner-metadata account for the launching wallet ${B58(feeClaimer)} — this launcher's configs must hang from its registered partner identity ("${H.PARTNER_IDENTITY.name}"). Create it once with the CLI: node create-partner-metadata.mjs write`);
    }
    return { name: null, metadataAccount: B58(metadataAccount), feeClaimer: B58(feeClaimer), warning: `fee_claimer ${B58(feeClaimer)} has no DBC partner-metadata account — this launch carries no partner identity and will index as anonymous DBC flow` };
  }

  return {
    web3: { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL },
    programs, validateSpec, applicableSteps,
    createSession, serializeSession, sessionKeypairs, sessionPubkeys,
    addresses, addressesB58, plan, buildStepTx, partialSigners, stepProofAccount, buildRecord, verifyMetadata, verifyPartnerIdentity,
    ruleNames: H.RULE_NAMES,
    // Generated rule parity surface (rules.generated.mjs, from the
    // engine source): the full catalog with implemented flags, the
    // selectable id set, and the active guard block.
    rules: GENERATED_RULES,
    implementedIds: GENERATED_IMPLEMENTED_IDS,
    selectableRuleIds: SELECTABLE_RULE_IDS,
    guard: GUARD,
    launchSigner: B58(LAUNCH_SIGNER),
    launchTag: { program: B58(H.MEMO_PROGRAM_ID), marker: H.LAUNCH_TAG_MARKER, pubkey: B58(TAG_KP.publicKey) },
  };
}

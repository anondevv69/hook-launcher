# Hook Launcher — operator runbook

The launcher surfaces live here. The programs they drive live one level up:
**engine** (`../engine/`), **registry** (`../registry/`), **distributor**
(`../distributor/`), with the venue proof and canonical sequence in
`../DBC-INTEGRATION.md` and per-program contracts in each folder's
`INTEGRATION.md` / `BUILD-NOTES.md`. Spec: `../../SPEC-HOOK-LAUNCHER.md`.

**Status of this folder:** **DEPLOYED TO MAINNET 2026-10-15** on Gregory's
explicit go. Programs live (registry `GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e`,
engine `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT`, distributor
`DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa`), genesis token AGTR launched
and proven live (registered buy passes, unregistered buy vetoes
`NotRegistered`). Full receipts: `../deploy/DEPLOY-RECORD.md`; launch record:
`../deploy/launch-record-agtr.json`. Upgrade authorities are held by the
launcher wallet (fren) — NOT burned; lockdown awaits Gregory's word.

## What's in the folder

| File | What it is |
|---|---|
| `launch.mjs` | Launch CLI. Spec JSON → canonical launch sequence (below). `--dry-run` prints the ordered plan and sends nothing. |
| `hook.mjs` | Agent CLI: wallet, register/sync, status, buy/sell/send, claim, cranks. Robust sender (processed blockhash + skipPreflight + HTTP status polling), plain-language hook error mapping. |
| `skill.md` | The agent skill (who can use it + the three-layer model, first-time flow, trading, the surprising rules). |
| `web/index.html` | Launch composer (form → spec JSON) + token status view (renders a launch record). Fully self-contained: no external scripts or fonts. |
| `web/smoke-test.mjs` | Stub-execution test of the page's script: `node web/smoke-test.mjs` (16 assertions). |
| `web/render-check.mjs` | Real headless-Chromium render check (needs playwright-core; borrows the copy in `~/workspace/taxhook-rh/node_modules`): `node web/render-check.mjs` (7 assertions + screenshot). |
| `sample-spec.json` | Agent-Only + Max Wallet (5%) + holder fees, Locked — the dry-run/genesis template. |
| `sample-record.json` / `web/sample-record.json` | A launch record in the exact shape `launch.mjs` writes (addresses are the dry run's predicted ones; includes a `snapshot` block for the web preview). |
| `dry-run-output.txt` | Captured `node launch.mjs sample-spec.json --dry-run`. |
| `trial-launch-features.mjs` | Phase 4 trial: launch-tag shape + L2 byte-compat vs pre-tag baselines, dev-buy validation/plan order, unset-default plan invariance (32 checks). |
| `browser-src/tag.mjs` | The launch tag keypair embedded in the browser bundle — read its header comment before touching it (fundless/powerless by design; compromise = spoofed tags, never funds). |
| `../deploy/launcher-tag.json` | The tag keypair (mode 600, build tree only, never funded). CLI source of the same key embedded in the bundle. |

Run the CLIs from this folder (`node_modules` is symlinked to
`../integration/node_modules` in the build tree; a fresh checkout runs
`npm i` against `package.json`).

## Canonical launch sequence (what launch.mjs executes)

From `DBC-INTEGRATION.md`, adapted to engine tail v2 (BUILD-NOTES §"What the
DBC integration workstream needs"):

0. **L0 — token metadata (discovery fix, 2026-10-16).** Before anything
   exists on-chain, the launch's metadata is made real and verified
   live, so the mint is **born with a non-empty metadata URI** (the
   pre-fix launches — AGTR, Latch, HARVEST — were born with `uri ""`
   and stayed icon-less in indexes and bot directories until repaired
   by hand). Convention: `https://agentonly.fun/hooks/<symbol-slug>.json`
   (+ `.png`). By default the CLI generates both files (a 512×512
   generated monogram in the site palette + a metadata JSON in the
   HARVEST repair shape — description/external_url/image/name/symbol),
   stages them into the site tree, deploys the site, and verifies both
   URLs (200, JSON parses, names this token, image is an image) before
   L1. Spec overrides: `metadataUri` (whole JSON, used verbatim — still
   fetched and required to resolve before launch), `metadataImageUri`
   (image only), `description` (text only), `metadataBaseUrl` (base
   for the generated URLs). `node launch.mjs <spec> --stage-metadata`
   runs L0 alone — the browser composer can't stage files, so it
   points its users here, and before its L2 it fetches the JSON and
   refuses to continue if it is missing/unparseable/mismatched.
1. **L1** DBC `createConfigWithTransferHook` naming the ENGINE;
   `fee_claimer` = launcher wallet. **Template parity (2026-10-16):**
   the create-config fields match the decoded HookedPad-born controls
   (HAMSTER/MHA) on every free choice — `activationType` Timestamp(1),
   `migrationFeeOption` Customizable(6) with a stored `migratedPoolFee`
   — except fee economics, which stay the launcher's product
   decisions: migrated pool fee 100 bps flat with dynamic fee off
   (controls: 120 bps + dynamic) and **no migration skim**
   (`migrationFee` 0/0; controls take 10% of the threshold at
   graduation). Config `version` is program-stamped (ours is already
   the current generation, same as MHA). The dry-run plan prints the
   resolved fields (`configFieldsText`). Full audit:
   `../deploy/DISCOVERY-FIX-2026-10-16.md`.
2. **L2** DBC `createPoolWithTransferHook` — DBC creates the base mint
   carrying the ENGINE hook **and the L0 metadata URI**; hook authority moves to the pool authority.
   The L2 transaction also carries the **launch tag**: one SPL Memo v2
   instruction (marker `hook-launcher:v1`) whose only signer is the
   dedicated fundless tag keypair (`../deploy/launcher-tag.json`, mode
   600; pubkey `95uGAjvVB3xLkqdGZoq2CncLunqcUPe8NxhetRVkiVgF`). It
   changes nothing else in the transaction — the extra read-only
   signature labels our launches for terminals/routers. See "The launch
   tag" below.
3. **L3** Engine `InitializeConfig` — venue allowlist = [DBC program];
   exemptions = [pool authority, base vault] so pool flows never
   self-block. (Config must exist before the meta list; DBC creates the
   mint, so config init follows pool creation.)
4. **L4** Engine `InitializeExtraAccountMetas` — **templated per config**
   (engine Phase 2): the list carries exactly the extras the enabled
   rules require, in canonical order (full house = config, src holder,
   dst holder, rent vault, price feed, system, instructions sysvar;
   AGTR's rules 3+9 publish 5; a Max-Wallet-only token publishes 2 —
   config + instructions sysvar — a **fully static** list with no
   AccountData seeds, so generic routers can build first buys). The L4
   instruction itself is unchanged (disc-only data); the engine derives
   the set from the config written at L3. The plan line prints the
   templated count, each extra, and why it is there.
5. **L4b** Engine `InitializePriceFeed` — only when rule 1 is enabled.
6. **L5** Fund the rent-vault PDA (pays for lazily created Holder PDAs).
7. **L6 (advisory, per buyer)** — only for tokens whose list carries
   holder entries: a buyer's base ATA must exist before their first swap
   *build* (build-time meta resolution reads its owner field).
   `hook.mjs buy` does this automatically. Fully static tokens (no
   holder state) need no pre-creation — the generic [create ATA, swap]
   bundle works.
8. **L7** Distributor initialize + fee vault ATA — only when holder fees
   are on. Funding mode auto-derives from the mint: a DBC mint has no
   Transfer Fee extension, so it lands in **mode 1 (routed)** — the
   fee_claimer claims curve/LP fees, converts them to the launched token,
   and transfers them into the distributor vault; anyone cranks
   `distribute`. (Self-minted tokens with a fee extension use mode 0,
   harvest — see `../distributor/INTEGRATION.md`.)
9. **L7b** Engine `SyncRegistered` (authority path) for the distributor
   vault's owner — only when holder fees are on AND rule 3 (Agent-Only)
   is in the stack. The vault's owner is the distributor state PDA; it
   can never self-register, and rule 3 checks the destination's Holder
   PDA mirror on every transfer — without this step the claimer's
   routing deposits would be vetoed `NotRegistered`.
10. **L8/L8b/L8c + L9 — the bundled dev buy** — only when the spec sets
    `devBuySol`. Prerequisites, each conditional on an on-chain check
    (skipped when already in place): register + sync the launcher
    wallet (rules 3/17 — the buy's destination is the launcher itself),
    and crank the price feed via `CrankPriceDbc` (rule 1 — first crank
    before the first buy). Then **L9**: the dev buy itself, its own
    transaction. See "The bundled dev buy" below for the exact
    guarantee.

## The creator fee

Every launch sets a **creator fee**: the DBC curve's trading fee, in the
spec as `feeBps` (default 100 = 1%; allowed **25–9900**, the DBC
program's own bounds; optional `feeBpsEnd` decays it linearly instead of
flat). The venue program collects it on every trade and accrues it to
the config's `fee_claimer`. The transfer hook never touches it — hooks
are veto-only; the design is venue-fee direction set at launch, no APIs,
no platform cut.

Destination is explicit in the spec (`feeDestination`): `"creator"`
(the claimer keeps the fees, claimed as SOL) or `"holders"` (the claimer
routes them through the Distributor). It must agree with
`holderFees.enabled`, and a holders-destination launch requires
`feeClaimer` = the launching wallet — validation refuses contradictions
at spec time, because a mis-pointed fee stream fails silently on-chain.

The claimer's whole duty is one command, from the launch record:

```
node hook.mjs claim-fees
```

It claims the accrued fees from Meteora (only the claimer of record can
sign), and — on holders-destination tokens — converts them into the
token, routes them into the distributor vault, and cranks the fold in
the same run. A clean run to the standard 42 SOL threshold at the
default 1% earns the claimer ≈ 0.42 SOL (fees are charged on volume,
both directions, so two-way flow earns more).

Trades go through `swap2WithTransferHook` only; plain swap instructions
reject hook pools. Graduation completes with a `PartialFill` buy; the hook
is revoked inside that swap and the token migrates to DAMM v2.

## Graduation behavior

The spec field `graduation` picks the token's future at launch:
`"release"` (default — at `migrationThresholdSol`, default 42 SOL, the
token migrates to DAMM v2 and the rules retire) or `"never"` (the DBC
config's migration threshold is set to u64::MAX lamports —
18,446,744,073,709,551,615, more SOL than exists — so the curve never
completes, the rules enforce forever, the 20% migration tranche stays
locked in the pool vault, and only hook-aware doors can ever trade it).
`never` + `migrationThresholdSol` together are rejected as a
contradiction; `"house"` (graduate onto the house venue, rules intact)
is designed in `../SPEC-GRADUATION-HOUSE.md` but not implemented, and is
rejected too. The plan prints a `GRADUATION` line and the launch record
carries a `graduation` block (`mode`, `thresholdSol`,
`thresholdLamports`). Trials: `node trial-graduation.mjs` (35 checks —
spec-entry baseline, resolution, byte-identical AGTR/Latch artifacts
under the release default, u64-max instruction decode).

## The launch tag

Every launch's L2 transaction carries ONE extra instruction: an SPL
Memo v2 memo (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) with the
fixed text **`hook-launcher:v1`**, signed read-only by a dedicated tag
keypair (pubkey `95uGAjvVB3xLkqdGZoq2CncLunqcUPe8NxhetRVkiVgF`) — the
HookedPad pattern: terminals, routers, and indexers can spot our
launches by the extra signer, and the memo does nothing else. The key
is **fundless and powerless**: it holds nothing, owns nothing, and must
never be sent funds. Its secret lives in exactly two places:
`../deploy/launcher-tag.json` (mode 600, build tree only — never in
launch records, docs, or site HTML) and, deliberately, the browser
bundle (`browser-src/tag.mjs`, with the security note in its header):
a browser cannot hold a server-side secret, and the exposure is
acceptable because the worst case is *spoofed tags* — someone else's
launch wearing our label — never funds. **The tag is a label, not an
attestation**; verifiers must still check the token's engine Config
PDA + meta list on-chain. Byte-compat proof:
`trial-launch-features.mjs` — for the sample spec and the AGTR + Latch
record specs, the L2 instruction sets *excluding* the memo hash
identically to pre-change baselines, and the browser-built L2 set is
byte-identical to the CLI-built set, memo included.

## The bundled dev buy

Spec field **`devBuySol`** (optional; positive, **≤ 10 SOL** cap — a
seed-sized first position, not a treasury operation; invalid values
refuse the launch at spec time). Unset = no dev buy, byte-for-byte the
pre-feature behavior (plans for the AGTR + Latch record specs gain no
new lines; proven in `trial-launch-features.mjs` §E).

When set, the launcher buys that much of its own token inside the
launch run: prerequisites first (register + sync the launcher when
rule 3 or 17 is on — planned conditionally, executed only when the
on-chain Registration PDA / Holder mirror is missing, mirroring
`hook.mjs` flow logic; for rule 17 the launcher's registration must
already carry the token's ecosystem attestation — the attester's
co-signature is not the launcher's to give, and execute refuses rather
than sending a buy that would veto `WrongEcosystem` — and a
`CrankPriceDbc` crank when rule 1 is on, first crank before the first
buy per the Latch mainnet order), then the buy.

**Atomicity — the truth, not the assumption:** the dev buy is **not**
atomic with activation and cannot be on the standard build path. The
swap build (`swap2WithTransferHook` →
`getRemainingAccountsForTransferHook` in the DBC SDK) resolves the
transfer hook's extra accounts by *reading the on-chain
ExtraAccountMetaList account* (through spl-token's
`createTransferCheckedWithTransferHookInstruction`) and the pool state
— neither exists until L2/L4 have landed, so no same-transaction dev
buy can be constructed that way. (A hand-rolled manual-extras
construction was not shipped: without an SDK-equivalence proof in
LiteSVM it would be a second, unverified swap path.) The shipped
guarantee, worded exactly as the plan prints it: **the dev buy is its
own transaction, submitted immediately after activation (L4/L4b/L5 +
L7/L7b + prerequisites) inside the same launch run, nothing else
intervening — the first swap after activation, submitted by the
launcher in the same run; not atomic with activation — a third party
landing in an earlier slot could theoretically precede it.** The step
is **L9** in the plan (prerequisites L8/L8b/L8c). The launch record
gains `devBuy: { sol, tx, received, receivedRaw }` when executed.
LiteSVM proof: `../integration/dbc-devbuy.mjs` (21 checks — crank →
dev buy as the first swap post-activation, launcher receives, rule-1
Holder PDA created with basis exactly equal to the cranked EMA;
0.05 SOL → 3,758,140.828991 tokens, matching AGTR's mainnet first buy).

## Mainnet deploy order — the three programs

Dev program ids (LiteSVM only):
engine `2A3kbQHsUpsnud5VSz3aszFDjhUychWK99NDWyKtSMDt`, registry
`DQ3a7B5QeoDbrVeDC6cDuXrTe8wePLwhX9jPqXrhvL5V`, distributor
`2kTYd7HzTtSBBwJW2yXBQ6Q2aLf49xrv1SqU7BN9ckoS`.
**Mainnet program ids (deployed 2026-10-15, fresh keypairs in
`../deploy/`):** engine `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT`,
registry `GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e`, distributor
`DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa`. The deployed engine was
rebuilt with `REGISTRY_ID` = the mainnet registry id (binary size
unchanged, 184,264 B; on-chain ELF verified byte-exact).

**Ordering constraint:** the engine embeds the registry's program id as a
compile-time const (`REGISTRY_ID`, used by SyncRegistered). Registry
therefore deploys **first**, the engine is rebuilt against the mainnet
registry id, and only then deployed.

1. **Pre-flight:** all three trial suites green from clean builds —
   engine `node trial.mjs` (64/64), registry (23/23), distributor (61/61).
   Also re-run the DBC integration suite against **engine v2** (the v1 run
   proved 36/36 + 22/22 graduation; v2's seventh extra has not been
   re-proven — BUILD-NOTES flags this as the integration's first task).
2. Build SBF v1 binaries: `cargo build-sbf --arch v1` in each program
   folder (LiteSVM 0.8 cannot load SBF v3; mainnet takes either, keep the
   proven artifact).
3. Generate fresh mainnet program keypairs; record the ids in this file
   and in each program's notes before deploying anything.
4. Deploy **registry** (`solana program deploy`), verify by on-chain
   effect (fetch the program account; run one register against it from the
   launcher wallet).
5. Set the engine's `REGISTRY_ID` const to the mainnet registry id,
   rebuild, re-run the engine trial (T8 asserts the id match against the
   registry binary it is built with), then deploy **engine**.
6. Deploy **distributor** (no cross-program consts; order-free, listed
   last for tidiness).
7. **Upgrade-authority posture (TH discipline):** verify each program
   end-to-end on mainnet with a throwaway ruled token first; at audit
   sign-off, burn per-version upgrade authority
   (`solana program set-upgrade-authority <id> --final`). Until then the
   launcher wallet holds upgrade authority — treat it as a hot admin key.
8. Update the program-id constants at the top of `launch.mjs` and
   `hook.mjs` to the mainnet ids, and the records' `programs` block will
   follow automatically.
9. First real launch = the genesis checklist below.
10. Standing launcher duties after launch: keep ~1–2 SOL on the DBC pool
    authority for migration flash rent; run the fee-routing cadence for
    holder-fee tokens — one command, `node hook.mjs claim-fees` (claim →
    convert → vault → crank); run the
    SyncRegistered keeper for Agent-Only mints (mirror deactivations
    promptly); top up rent vaults as holder counts grow.

## SOL budget (measured rents — engine BUILD-NOTES, registry/distributor INTEGRATION)

### One-time: program deploys

| Program | Binary | Programdata rent |
|---|---|---|
| Engine (v2, wave 1 + DBC crank) | 184,264 B | ≈ **1.2834 SOL** |
| Registry | 83,872 B | ≈ **0.585 SOL** |
| Distributor | 128,768 B | ≈ **0.897 SOL** |
| **Total** | | ≈ **2.765 SOL** (+ recoverable deploy-buffer churn) |

### Per launch (paid by the launcher)

| Item | SOL |
|---|---|
| Engine Config PDA (1,088 B) | 0.008463 |
| ExtraAccountMetaList PDA (templated, Phase 2: 86 B / 2 extras … 261 B / 7 extras) | 0.001489–0.002707 (AGTR shape: 191 B / 5 extras = 0.002220) |
| PriceFeed PDA — rule 1 only (136 B) | 0.001837 |
| Distributor state PDA — holder fees only (176 B) | 0.002116 |
| Distributor vault ATA — holder fees only | ≈ 0.002039 |
| Rent-vault funding (recommended; ≈ 27 lazy Holder PDAs at 0.001837 each) | 0.05 |
| Seed SOL (first buy) | per spec (`seedSol`) |
| **Typical total (AGTR sample: rules 3+9, holder fees, no seed)** | **≈ 0.0648 SOL + tx fees** |

### Per wallet / per holder (not the launcher's bill, listed for support)

| Item | SOL | Paid by |
|---|---|---|
| Registration PDA (48 B) | 0.001225 | the registering wallet |
| Holder PDA (136 B) | 0.001837 | explicit init / a sync caller / the rent vault on lazy creation |
| Distributor Claim PDA (104 B) | 0.001615 | the claim/settle caller |

## Genesis-token checklist

The first mainnet launch (template: `sample-spec.json` — Agent-Only +
Max Wallet 5% + holder fees on, Locked authority):

- [x] Trial suites green (engine 64/64, registry 23/23, distributor 61/61)
      and the DBC integration suite re-run against engine v2 — DONE
      2026-10-15 (integration v2 42/42, end-to-end latch on DBC 55/55,
      graduation 22/22; see ../DBC-INTEGRATION.md v2 section).
- [x] Programs deployed in order (registry → engine rebuilt with its id →
      distributor); ids recorded here and in `launch.mjs` (hook.mjs reads
      them from the launch record) — DONE 2026-10-15, see
      `../deploy/DEPLOY-RECORD.md`.
- [x] Launcher wallet funded: 4.3407 SOL on hand covered deploys
      (actual 2.0237 SOL — mainnet rent priced below estimate) + genesis
      launch + headroom. Pool-authority flash-rent float (1–2 SOL) is
      still NOT arranged — due before AGTR nears its 42 SOL migration
      threshold, not before.
- [x] `node launch.mjs sample-spec.json --dry-run` reviewed line by line.
- [x] Launch executed; launch record written and archived
      (`../deploy/launch-record-agtr.json`).
- [x] Verify-by-on-chain-effect, in order: mint carries the ENGINE hook
      (TLV read); Config PDA decodes to the spec's rules; meta list PDA
      exists; rent vault funded; distributor state reads funding_mode 1.
- [x] First trades proven with the agent skill: register → sync → buy
      passes (3,758,140.828991 AGTR for 0.05 SOL); an **unregistered**
      wallet's buy vetoes with `NotRegistered` and receives nothing;
      position sold back. (The 5%-cap `MaxWalletExceeded` veto was proven
      in LiteSVM integration, not re-proven on mainnet.)
- [~] Holder-fee path proven 2026-10-16 — PARTIAL, see
      `../deploy/FEE-CYCLE-PROOF-AGTR.md`: claim → convert → route all
      landed on mainnet AGTR and reconcile to the lamport/unit (claimed
      0.021454088 SOL total; 1,212,809.357987 AGTR sitting in the
      distributor vault). The final crank/claim step is BLOCKED by a
      real bug: the deployed Distributor's payout CPI does not forward
      transfer-hook extra accounts, so `distribute`/`claim`/`settle`
      payouts fail on hooked mints (`MissingAccount`). Fix specced in
      `../distributor/HOOK-EXTRAS-FIX.md` (program upgrade + ≈0.9 SOL
      recoverable buffer float). The routed fees are safe in the vault
      and fold exactly once the upgrade ships.
- [ ] Trade page / web status view pointed at the real record; sample
      snapshot replaced by live `hook.mjs status` numbers.
- [ ] Upgrade authorities burned at sign-off; deploy keys rotated out of
      hot storage.

## Known caveats (do not paper over these)

- **Distributor payouts vs transfer hooks (found 2026-10-16):** the
  deployed Distributor pays out (crank cut, claim, settle) with a bare
  TransferChecked CPI that omits the transfer hook's extra accounts, so
  on hooked mints — every launcher token — payouts fail with
  `MissingAccount` and fees cannot fold yet. Deposits INTO the vault
  work (the claimer's signed transfer carries the extras). Fix:
  `../distributor/HOOK-EXTRAS-FIX.md`. Creator-destination fee claiming
  (`hook.mjs claim-fees` on tokens without a Distributor) is unaffected.

- **Rule 1 on DBC:** the engine crank prices constant-product vault pairs;
  a bonding curve's price lives in virtual reserves. A DBC pool-state
  crank variant is the documented follow-up — until it ships, Basis Latch
  launches belong on house/DAMM-style pools. `launch.mjs` and the web
  composer both warn on rule 1.
- **Rule 8 on DBC:** Holder-Gated fails closed on curve swaps (no sync can
  be prepended); it works through `hook.mjs send` and sync-prepending
  venues. Both surfaces warn on rule 8.
- **Engine v2 × DBC** has not been re-proven in LiteSVM yet (v1 was
  36/36 + 22/22). Step 1 of the deploy order closes this.
- **Agent-Only is registry-only enforcement** — agent-only by workflow,
  not by proof, stated as plainly here as everywhere else: no chain can
  distinguish an agent-run wallet from a human clicking.
- **Metadata:** DBC pool creation takes name/symbol/URI (hosted JSON, the
  TH pattern). On-chain Metaplex metadata for hook mints is foreclosed —
  do not promise it.

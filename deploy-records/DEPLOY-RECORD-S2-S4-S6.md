# DEPLOY RECORD — S2 + S3 + S4 + S6 WINDOWS (settlement layer)

**Executed 2026-10-20 (America/New_York), by the settlement-window
coordinator under Gregory's authorization: catalog plan locked
2026-10-19, windows ordered "run them in order" 2026-10-20 (S2 → S3 →
S4 → S6). C1–C3 (house) were NOT in this run and were not touched.**

**RESULT: ALL FOUR WINDOWS COMPLETE + VERIFIED.** Crown and
FeeSchedule are deployed fresh on mainnet; the Distributor is upgraded
in place to the Phase B splits binary (rebuilt against the real
mainnet Crown id per the sheet's sequencing); the site is published
with the settlement rules marked live, the composer GUARD flipped to
the S1 tail-hash pin, HARVEST EVER's page live, and the house
composer held back (not live — C1–C3 pending). No rollback needed.

Runbook: `deploy/PHASE-B-DEPLOY-SHEET.md` + `deploy/BUILD-RECORD-PHASE-B.md`
+ the S1 pattern (`deploy/DEPLOY-RECORD-S1.md`). All window scripts,
logs, snapshots, and result JSONs live in `deploy/s2-s4-window/`.
Every deploy/upgrade was sent from a FROZEN copy in that dir, sha256
verified before any send; every outcome was verified by independent
on-chain read-back (tool self-reports were never trusted — both
deploys reproduced the October pattern of the deployer crashing on a
null fresh-account read *after* its DEPLOY tx had confirmed, and both
first-pass buffer read-backs false-alarmed on a lagging RPC replica
while triple independent reads proved the buffers byte-perfect).

Pre-run state: fren main `FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP`
at **2.030371462 SOL** (the S1 end balance), live snapshot at slot
459234913 (`deploy/s2-s4-window/snapshot-live.json`).

---

## S2 — Crown deploy (NEW program)

| | |
|---|---|
| Program | **Crown `HWZpJ7GnDifwo7g77PKefeVXdzbse7sfRjKrNUna3gJN`** (fresh keypair `deploy/s2-s4-window/crown-mainnet-keypair.json`, mode 600) |
| ProgramData | `Dj4HJgZvKT5kVuBVjSGokpMDbAwwk8JcccmbioaXi81r` (118,877 B = 45 + ELF) |
| Artifact | Frozen `deploy/s2-s4-window/crown_sol-frozen.so`, 118,832 B, sha256 `94bf4bb43f66b47b132f907cacc9f73f3794f66534526cdd766c4d5cbe88cfd7` == build record |
| Buffer | `CfFJUrcdppzWc4WcPtX5jH8GoWNtrp4C94tiMMvUqArq` (create+init `uXjwXibJF7tWFCF2MqASiJwj5wZTuakoPFYHnvUE92ba6gJa9XSZUVK9hbKzyeKV5HJPZqn3uLu9cyMGguQdjdj`; 133 write chunks, sigs in `s2-deployer.log`) |
| Deploy tx | `3i7RxCRuwk5NHnrZBjb5xr4ysaLwNy8e443X8VFVt3aMSTJ5NSEaUgoTMP9KpzoudCUqM87yHobgoTQN9oiAXvF6` |
| Post-verify | Program live + executable, loader-owned; ProgramData ELF read-back **byte-exact** vs the frozen artifact (sha256 above); upgrade authority = fren (retained, not burned); buffer consumed by the deploy |
| Cost | **0.60606352 SOL** total: 0.60537852 permanent rent (programdata 604,545,400 + program account 833,120 lamports) + 0.000685 fees (137 base fees). Buffer float folded into the programdata funding at deploy; nothing left stranded |
| Balance after | 1.424307942 SOL |

Notes:
- First attempt via `solana program deploy` (CLI) failed before any
  send: the publicnode RPC answered the CLI with HTTP 403 Forbidden
  (`s2-deploy.log`; the same 403 hit a CLI buffers query minutes
  later — the free RPC refuses some CLI request patterns). Zero
  signatures, balance unchanged, program account absent — all
  verified on-chain before proceeding. The window fell back to the
  proven TH deployer (`taxhook/scripts/deployer.mjs`, the tool that
  deployed all three original programs); no state from the CLI
  attempt existed to reconcile.
- **No Init was sent** (per the sheet: the first Crown Init happens
  with the first rule-5 launch). Bond/quorum are **init-time**
  parameters in this program (build record §3), so nothing was set
  this window; the program's marked production defaults remain the
  record's suggested **bond 0.1 SOL / quorum 0.5 SOL** (window 72h,
  timelock 24h, min reign 7d, cooldown 3d, slash 2000 bps) for that
  first Init — Gregory's sign-off on those values is still the open
  fork from the build record, unchanged by this window.

## S3 — Distributor upgrade (in place)

Sequencing per the sheet: S2's keypair first → Distributor const
rebuild → regression re-verification → preserved-bytes rehearsal →
extend → buffer → upgrade → post-verify.

### The rebuild (sheet §S2 note / sequencing steps 1–2)

- `distributor/src/lib.rs` `CROWN_ID` const set to the mainnet Crown
  id `HWZpJ7GnDifwo7g77PKefeVXdzbse7sfRjKrNUna3gJN` (comment block
  updated; pre-edit source preserved as
  `distributor/src/lib.rs.pre-s3-rebuild`). `ENGINE_ID` untouched
  (mainnet). Source ends on mainnet consts.
- Rebuilt mainnet binary: **140,312 B, sha256
  `321dffee4865b7ec6a0a7ef3128783cf8cfe576a8cb4c833c0553ef142a76b3b`** —
  this supersedes the draft hash `3952e1fa…` (which was the dev-Crown
  build; that file is preserved as
  `distributor/target/distributor-mainnet-devcrown.so`). Frozen deploy
  copy: `deploy/s2-s4-window/distributor-mainnet-rebuilt.so`. A second
  from-source rebuild reproduced `321dffee…` exactly (deterministic).
- Trial flavor rebuilt the same way (ENGINE_ID/CROWN_ID swapped to the
  dev ids): its `.text` and `.rodata` are **byte-identical** to the
  Phase B trial binary `bef1ff40…`; only `.data.rel.ro` differs —
  28 u64 metadata entries shifted by exactly 3, the panic-location
  line numbers after the (comment-only) CROWN_ID doc edit. Behavioral
  identity is proven by the battery, next bullet.
- Regression re-verification against the rebuilt binaries (sheet
  requirement): **trial-splits 42/42 · distributor trial 61/61 ·
  trial-fold 23/23 · trial-hooked 23/23** — all at Phase B baselines.

### Preserved-bytes rehearsal (sheet sequencing step 3) — GREEN

`distributor/trial-s3-rehearsal.mjs` (LiteSVM): preserved live AGTR
accounts from the slot-459234913 snapshot (DistState, vault, mint,
engine Config PDA, fren AGTR ATA) + the **live** distributor binary
extracted from its ProgramData, then the binary swapped in place to
the rebuilt one. **6/6**: identity `vault == total_distributed −
total_paid_out` exact on the preserved state (58,048,759,547 ==
1,200,681,264,408 − 1,142,632,504,861); tag-1 distribute is a true
zero-fold no-op under BOTH binaries (all counters unchanged — the
state decodes identically); tag-4 with all-sentinel split slots
behaves as tag 1 on AGTR's real config.

**Sheet discrepancy found:** the live distributor ELF is **129,664
B** (ELF section headers end there; tail after it is all zeros), not
the 128,768 B the sheet states — the live binary is presumably the
Oct 16 hook-extras-fix build, one step past the sheet's snapshot.
Rollback artifact extracted from the live ProgramData bytes before
the window: `deploy/s2-s4-window/distributor-live-v1.so`, 129,664 B,
sha256 `dbf9a31ccfe92aa913c99f170313f5a318c96a82a9bcaeaf217235df819372f6`
(not used; the upgrade verified clean).

### The upgrade

| | |
|---|---|
| Program | Distributor `DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa` (authority fren, retained) |
| Extend | ProgramData 139,053 → **149,293 B**: one +10,240 ix (the loader's per-ix minimum — a +1,304 ix is rejected `InvalidArgument`, sim-proven before any send). Tx `4gjjc2wL6axN5eJibQZHbWSLqGeKcZM6awXo2j6JWqJcgKMQEqdMsZ767VHzKunH7DdEuavfp6uodzFE1cJu96sS`; cost 0.0520242 (rent 0.0520192 + fee) |
| Buffer | `ErSQpABqJZXtbtAw48z8FJiAsg9ooVSoJhMgWMAwEVax` (create+init `5pwGCr1sSLrN8Rq2b2Jc1bSig3aMoNuzpeZNsXkTBHKcMjBdF5cSEgiuBcdnz4Kps6pCWfxDFrnUnjL8CspSmyiM`; 156 write chunks, sigs in `s3-upgrader.log`; read-back hash verified by the upgrader before the upgrade ix) |
| Upgrade tx | `5WbxVp6FbU8sS4JjaeXoTpAXA68hUbbX7wcfPsDYoFCCNcPMyhU8D3YWm8iAtsBY2fYiKL7fEn3cvYC3DjPKvqMK` |
| Post-verify | **5/5** (`s3-postverify.mjs`): live ProgramData ELF sha256 == `321dffee…`; authority == fren; **AGTR DistState decodes byte-identically to the pre-window snapshot** (index 1202124632, total_distributed 1200681264408, total_paid_out 1142632504861, total_routed_folded 1212809357987, total_cuts 12128093579, caller_cut_bps 100, funding_mode 1, distribute_count 1); tag-1 distribute **simulation** on live AGTR err = null; tag-4 all-sentinel **simulation** err = null (the sheet's post-verify folds were proven for real in the preserved-bytes rehearsal; the live checks were run as simulations so no live state moved in the window) |
| Cost | **0.0528192 SOL** total: 0.0520192 permanent programdata rent (extend) + 0.0008 fees (160 base fees: extend 1, buffer create 1, writes 156, upgrade 1, one chunk resend). Buffer float (~0.7135 SOL) returned in full at the upgrade — buffer account closed |
| Balance after | 1.371488742 SOL |

## S4 — FeeSchedule deploy (NEW program)

| | |
|---|---|
| Program | **FeeSchedule `66HUbm4tgcCsRkDL655UUrmm1aEVGugJzcYNm6NDFkFL`** (fresh keypair `deploy/s2-s4-window/feeschedule-mainnet-keypair.json`, mode 600) |
| ProgramData | `7uehbL3y5kcfyp6pg9adCcWkVqFbTfYEfJsKcMGN7y75` (105,733 B = 45 + ELF) |
| Artifact | Frozen `deploy/s2-s4-window/feeschedule-frozen.so`, 105,688 B, sha256 `91e8e02e77ecef97459811e82636fa750fe05c3edcc4f9ad46ab9c0aa1b7f393` == build record |
| Buffer | `FXKXR8G9pRKUwxQGF9apXgHtTxiuuMZbGW4LStnhPWHa` (create+init `4Swu3bjoUyEV4L5BvAYsru6rkmLhXUA7YaaA7NZpFrCpV3GdCucckVBGi1aRUm62xxFW4nyrVPn7ya8zi4ACLkVT`; 118 write chunks, sigs in `s4-deployer.log`) |
| Deploy tx | `5EUsvF6bx9XB9JdtT7ZFJNbymCyTzGrtoqz74eCSkxgGQnqiRWsnXsW2Mdja8Tum7icxACC4TsKfPyCiQrKB5Lzv` |
| Post-verify | Program live + executable, loader-owned; ProgramData ELF read-back **byte-exact** (sha256 above); upgrade authority = fren (retained); buffer consumed by the deploy. No other program references this id — no rebuild coupling (per sheet). No InitSchedule sent (first one comes with the first rule-14 launch, per sheet) |
| Cost | **0.539217 SOL** total: 0.538607 permanent rent (programdata 537,773,880 + program account 833,120 lamports) + 0.00061 fees (122 base fees). Buffer float returned/folded at deploy |
| Balance after | **0.832271742 SOL** (run end balance) |

## S6 — Site publish

Published via the established path (`aonly-site/deploy.py --redeploy`
→ Railway project `agentonly`, tarball 1,121,266 B, deployment
SUCCESS), then **verified over HTTP** at agentonly.fun:

- **Launches feed** (`/api/launches`, 200): all five launches
  `bonding`, `launchComplete: true` — EVER flipped from paused, as
  finished in S1.
- **EVER page** (`/hooks/ever/`, 200, 38,452 B): live with the finish
  receipts (crank EMA 5764607319222 on the page); **HARVEST page**
  carries the reciprocal `/hooks/ever/` link.
- **Composer GUARD flipped** (`/hooks/launch/`, 200): page carries
  `fixedEngineSha256: 'b32e336143e92ec3126e186fa814990958e661f83f9f3b11eec00864c15b48a0'`
  — the S1 **tail hash** (sha256 of ProgramData offset 45 → end of
  account), NOT the ELF hash, per the S1 record's semantics warning.
  Rule-1 + `never` is composable again. The flip was made through the
  generation chain, not just the page: `launcher/bin/gen-rules.mjs`
  now reads the pin from `launcher/engine-v4.json` at generation
  time, `rules.generated.mjs` was regenerated with it, and
  `launcher/bin/check-rule-parity.mjs` §3 now asserts pin equality
  with engine-v4.json (generated + page) instead of asserting null.
  **RULE PARITY: OK · composer smoke 65/65 · trade-check 74/74**,
  all after the flip.
- **Rule labels reflect what is actually live:** skill.md (site +
  launcher copies, kept byte-identical) gained spec rows for rules
  4, 5, 6, 10, 11, 12, 13, 14, 15, 16 and a settlement-layer section
  naming the Crown (`HWZpJ7Gn…`) and FeeSchedule (`66HUbm4t…`)
  program ids with the honest caveats (split legs forward no hook
  extras — no 5/6/15 splits on hooked mints; rule 14 fee-extension
  mints only; rule 16 crank-operated + holder-fee stream conflict).
  The docs page and the hooks landing page carry the same status:
  settlement rules live since 2026-10-20, Escrow Split the one
  holdout.
- **House NOT published as available** (C1–C3 have not run): the
  launch page ships with a marked `HOUSE_LIVE = false` gate —
  buildSpec refuses graduation `house` (and rule 2, which forces it)
  with a "not live yet" error, the house graduation radio and the
  rule-2 checkbox are disabled and tagged coming soon, and the
  coming-soon lede says exactly that. The C3 publish flips the one
  flag after C1 + C2 verify (per the Phase C sheet's "do not publish
  the house composer before C1 + C2" rule).
- No crank-staleness or ecosystem-preset copy was added — the sheet
  does not include it, so none was invented in this window.

## Money reconciliation (whole run)

| | SOL |
|---|---|
| fren balance pre-run | 2.030371462 |
| S2 Crown (rent 0.60537852 + fees 0.000685) | −0.60606352 |
| S3 Distributor (extend rent 0.0520192 + fees 0.0008) | −0.0528192 |
| S4 FeeSchedule (rent 0.538607 + fees 0.00061) | −0.539217 |
| **fren balance post-run** | **0.832271742** |
| Total spent | **1.19809972** — permanent rent 1.19600472 + fees 0.002095 (419 base fees); all buffer floats returned or folded into programdata funding; reconciles to the lamport |

## What did NOT happen / open items

- **C1–C3 untouched** (later run, per instructions): the Phase C
  engine binary and HouseSwap are not deployed; no live token can
  activate a house venue or use rule 2 yet, and the published
  composer says so.
- **S5 (buyback crank ops)** unchanged — the fee-claimer operation
  model is still Gregory's call, due at the first rule-16 launch.
- **First Crown Init / first InitSchedule** happen with their first
  launches, not in these windows (per sheet). Crown production
  bond/quorum sign-off (suggested 0.1 / 0.5 SOL) remains Gregory's
  open fork.
- **Splits on hooked mints remain gated** (tag-4 legs forward no hook
  extras) — published copy states this; fee-extension / hookless
  mints are clear for rules 5/6/15 today.
- Tree hygiene: `distributor/target/deploy/distributor.so` was
  restored to the preserved trial binary (`bef1ff40…`, ==
  `distributor-trial.so`) so the resting state matches the Phase B
  convention; `distributor/target/distributor-mainnet.so` holds the
  deployed rebuild (`321dffee…`).

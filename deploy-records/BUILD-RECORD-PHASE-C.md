# PHASE C (HOUSE VENUE) — BUILD RECORD (2026-10-20)

**Scope: LOCAL BUILD ONLY. No mainnet deploys, no launches, no fund
movement in this phase.** (The S1 engine window — v3 → Phase B — was
executed separately by its own coordinator in parallel; see
`deploy/DEPLOY-RECORD-S1.md`. Phase C never touched
`deploy/s1-window/` or `engine/target/engine-mainnet.so`, verified below.)

**Provenance / recovery note.** The original Phase C coordinator ended
early: Worker C (launcher) had banked green results, Workers A (engine)
and B (houseswap) were believed interrupted. This record was produced
by the recovery coordinator. Two findings from the audit change that
picture and are recorded plainly:

1. **The engine carried a real defect**: `activate_house` shipped with a
   planted `// DIAGNOSTIC:` stub that credited ONLY the caller cut — the
   seed move into the house quote vault was missing (trial-phase-c C6
   failed 85/88 on exactly this). Fixed with a one-line
   `move_lamports(vault_ai, house_quote_vault, seed)` after the cut,
   before SyncNative; trial-phase-c is 88/88 against the rebuilt binary.
2. **Worker B was not dead — it finished during the recovery audit.**
   Its final edits landed 04:50–04:51 UTC mid-audit (debug `CKPT`
   checkpoints removed from `houseswap/src/lib.rs`, the trial completed,
   the binary rebuilt, `houseswap/trial-houseswap-result.json` written).
   The recovery coordinator's first two trial runs raced those edits and
   produced mixed-state failures; **every count in this record was
   re-run afterwards on the final, consistent tree** (binary hashes
   below) and is the coordinator's own verification, not the worker's
   result file.

---

## Headline result

**The catalog is complete: all 17 rules are implemented somewhere
honest, and the house venue exists end-to-end.** The engine's
`rule_implemented()` now returns all 17 ids {1..17} — rule 2 included,
as a *recorded* rule whose enforcement lives in the house venue (the
engine's Execute is a deliberate no-op for it; see "Rule 2 final
status"). A house-committed token launches as `never` on its DBC curve,
accumulates creator fees and/or a committed SOL reserve in the engine's
HouseVault PDA, and — once the curve's quote reserve crosses the
committed threshold and the house pool is committed — anyone can fire
activation: the engine moves the accumulated seed into the house pool,
appends the venue + vault exemptions to the config, and the house pool
(a constant-product venue that forwards the engine's hook tail on every
token leg) becomes the default door, with the shared PriceFeed
re-pinning to whichever venue is deeper.

Locked house answers (Gregory, 2026-10-19) are implemented as locked:
fee-accumulation seed + optional `houseReserveSol`; permissionless
on-chain-checked activation with a caller cut; house = commitment, not
an option; deeper-venue-wins feed; doors default to the house pool
(curve = legacy); own `graduationThresholdSol` field (house +
`migrationThresholdSol` in one spec = hard error, launcher-side);
house fee mirrors the curve creator fee + destination.

## Binaries (all `cargo build-sbf --arch v1`)

| Program | Flavor | Size | sha256 |
|---|---|---|---|
| Engine (Phase C) | trial (Registry `DQ3a7B5Q…`, Distributor `2kTYd7Hz…`) | 317,632 B | `599c4755d833e567f027b50dcf4735f7b61e6d3b939ec4466a7d5d21548a5783` |
| Engine (Phase C) | **mainnet** (Registry `GftZenfb…`, Distributor `DpRjnQiy…`) | 317,632 B | `9718ff6ed80b678c3e3cb6b1511dd5e120ecdbc12ecce48e4a90bdf9756b24c5` |
| HouseSwap | dev/trial id `8Ugv9hn6wbjNddxqEpHzwM1pDdvYQxeX72KC7qzcxqXx` | 149,960 B | `12430c61cc8ed2de60551bb1cfbcb5851ead0f925aa50b10c113447e263cfa9e` |

Artifact placement (concurrency discipline):
- Trial engine binary: `engine/target/engine-trial.so`, and the resting
  slot `engine/target/deploy/engine.so` holds the same build
  (trial-phase-c's byte-guard passes).
- Mainnet engine binary: `engine/target/phase-c/engine-mainnet-phase-c.so`
  — a *separate path*. Byte-diff vs the trial build: 86 bytes, confined
  to the two program-id const sites, as expected for a consts-only
  flavor change; mainnet ids confirmed present via strings.
- `engine/target/engine-mainnet.so` (Phase B, `4c4aa6de…`) is
  **untouched** (re-hashed during this audit).
- `engine/src/lib.rs` ends with MAINNET consts in source.
- HouseSwap binary: `houseswap/target/deploy/houseswap.so`. Mainnet
  gets a fresh keypair at its deploy window; the program derives
  everything from the runtime program id (no rebuild).

## 1. Engine changes (`engine/src/lib.rs`)

**House slot in the Config PDA.** House-committed configs are 1152
bytes (`CONFIG_SPACE_V2`); non-house configs remain 1088 and are
**byte-identical to Phase B** (trial C1 writes the same fixed payload
against the Phase B snapshot binary and the Phase C binary and compares
bytes). The house region: `house_program @1088..1120`,
`house_threshold_lamports @1120`, `house_reserve_lamports @1128`,
`house_activated_ts @1136`, `house_state @1144` (1 = pending,
2 = activated). The config payload gains an optional 49-byte house
block after the fee tail (`[1][program][threshold u64][reserve u64]`);
any other trailing bytes fail closed. Validation at write: program
nonzero and ≠ the engine itself, threshold > 0, and **an enabled rule 2
requires a house block** (a rule-2 config without a venue to enforce it
is rejected at write, not discovered at trade time). The commitment is
**init-only and immutable**: UpdateConfig rejects adding, removing, or
altering it in either direction under every authority mode, and
activation state + ts survive updates. `ENGINE_VERSION` stays **2**
(the base layout is untouched). Under Locked, ActivateHouse is the
only path that writes state/ts.

**HouseVault PDA** (`["housevault", mint]`, 128 B): tag @0,
`reserve_balance @1`, `fee_balance @9`, `cut_paid_total @17`,
`seeded_total @25`; invariant `lamports == rent_min(128) + reserve +
fee`, asserted to the lamport in trials. Created at config init for
house payloads.

**New tags:**
- **16 DepositHouseFees** `[payer(signer,w), mint, config,
  house_vault(w), system]`, data `[16][amount u64]` — moves real
  lamports into the vault and credits `fee_balance`; pending state
  only (post-activation deposits reject AlreadyInit).
- **17 RecordHouseReserve** `[authority(signer), mint, config,
  house_vault(w)]`, data `[17]` — one-way, authority-only, *verifies
  the lamports already landed* (a plain transfer precedes it); sets
  `reserve_balance` to the committed amount; repeats are no-op
  successes; unfunded attempts reject HouseNotReady (33).
- **14 ActivateHouse** `[caller(signer,w), mint, config(w), dbc_pool,
  house_vault(w), house_pool, house_token_vault, house_quote_vault(w),
  system, legacy token program]`, permissionless. Checks, in order:
  slot pending (double activation → AlreadyInit 14); DBC pool is a real
  424-byte DBC pool for this mint with `quote_reserve ≥ threshold`
  (else HouseNotReady 33); house pool is the derived pool PDA under the
  committed program with `committed == 1` (else HouseNotCommitted 34)
  and the vaults it names are the accounts presented. Effects: caller
  cut = `fee_balance × 100 / 10000` (100 bps, constant) paid to the
  caller; seed = `reserve + fee_balance − cut` moved into the house
  quote vault (lamport move in-program; the SyncNative that makes the
  wSOL amount visible rides in the caller's bundle — the in-program
  sync CPI is dispatch-rejected after a direct lamport credit, a
  deviation from the contract draft recorded in the source and in
  trial C6); config `venues += house program`,
  `exemptions += token vault + quote vault`, state = 2, ts = now —
  the config byte-diff is confined to exactly those ranges (trial C6
  asserts the allowed-diff set byte by byte).
- **15 CrankPriceDeep** `[config, price_feed(w), dbc_pool, house_pool,
  house_token_vault, house_quote_vault]` — deeper-venue-wins: curve
  depth = pool `quote_reserve`; house depth = quote-vault amount −
  pool `fee_accrued_quote` (accrued-but-unclaimed fees are not depth),
  and **zero unless state == 2** (a pending house's balances never
  move the pin). Winner's spot folds through the same `ema_fold` /
  `write_crank` as tag 8; ties stay with the current pin; on a switch
  the feed's pool+vault fields are re-pinned.
- **Rule 2 params** validated at write (`split_bps` u16 @0 in
  1..=10000, `[2..64]` zero); Execute treats rule 2 as a no-op
  (trial C4: a plain transfer passes untouched with rule 2 enabled).

## 2. HouseSwap program (`houseswap/`)

Generalizes TaxSwap; the Pool account's first 168 bytes are
byte-identical to TaxSwap's layout. Pool PDA `["pool", mint]`, 264 B,
with the Phase C extension: `committed @162`, `live @163`,
`fee_bps @168`, `fee_dest @170`, `fee_accrued_quote @202`,
`fee_accrued_token @210`, `activated_ts @218`. Instructions:
InitPool (0), Swap (1), Add/RemoveLiquidity (2/3),
CommitPool (4 — one-way authority rotation to the `["poolauth", mint]`
PDA; after it, Add/RemoveLiquidity are dead because nobody can sign
for the PDA — that is the liquidity lock), ActivatePool (5),
ClaimFees (6). Full mechanics: `houseswap/INTEGRATION.md`.

- **Hook-aware swaps.** The token leg is a TransferChecked CPI carrying
  the engine's resolved extra accounts (the tail is located by the
  meta-list PDA key, in published order, writability reconstructed by
  key); venue extras sit *after* the tail and are never forwarded.
  Constant product on live vault balances, u128 checked; the fee is
  exactly `pool.fee_bps` — there is **no hardcoded fee factor** — and
  it stays in the input vault, accruing to the counters. Swap has no
  live/committed gate of its own: before activation the engine's venue
  allowlist does not contain the program, so the token leg fails with
  the engine's BadCaller — proven in trial (A4).
- **Fee mirroring (ActivatePool).** Permissionless, once, after
  CommitPool, and only when the engine config's house slot reads
  state == 2 naming this program. The fee *destination* is read
  on-chain from the DBC config (`fee_claimer @40..72`, with the
  pool→config linkage validated) — trustless. The fee *rate* is
  caller-supplied from the launch record, bounded to the DBC
  program's own 25..=9900 — **attested-by-record, not re-derived
  on-chain**; INTEGRATION.md states this asymmetry plainly and the
  deploy sheet carries the attestation duty.
- **ClaimFees.** Permissionless; pays both accrued counters to
  `fee_dest`'s token accounts (token leg hook-forwarded — it succeeds
  or fails closed with the stack's rules), then zeroes them. Zero
  counters = no-op success.

## 3. Rule 2 (Escrow Split) — final honest status

**IMPLEMENTED — VENUE-SIDE ONLY, exactly as the design requires.** A
transfer hook is veto-only and cannot skim a swap's input, so rule 2
was never buildable as a hook module; what exists is the honest form:

- The engine records `split_bps` in the Config PDA (write-gated on a
  house commitment) and does nothing at transfer time.
- HouseSwap enforces it on house-venue trades only. **Buys:** the
  split is carved from the TOTAL input first (`amount_in × split_bps /
  10000`, floor) into a per-buyer escrow PDA (`["escrow", mint,
  user_token_account]`, 96 B, native SOL; invariant `lamports ==
  rent_min(96) + escrow_lamports`); the remainder trades, the house fee
  comes out of the traded remainder. A rule-2 buy without the escrow
  account rejects MissingEscrow (11). **Sells:** resolution runs FIRST,
  from pre-sell state — `resolved = escrow × amount_in / pre_balance`
  (full exit resolves all). The dip test reads the *shared* engine
  PriceFeed EMA and the seller's engine Holder PDA: DIP := latched ||
  EMA < basis, with the config's rule-1 staleness budget; an unreadable
  or stale feed/holder resolves as NOT dip (forfeit) — resolution never
  bricks a sell and never refunds blind. DIP pays 96% refund to the
  seller, 2% to depth (quote vault + SyncNative), remainder to the fee
  destination as treasury (folding into depth if the wallet wasn't
  passed). NOT DIP sends the whole resolved share to depth.
- Curve (DBC) trades are never split, and escrow resolves only on
  house-venue sells. The composer labels the rule "house venue only" —
  **the label matches reality.**

Trial evidence (houseswap trial, mint B, below): split escrowed to
the lamport (0.5 SOL of a 1 SOL total at 5000 bps); buyer funding legs
exact (wSOL −traded, wallet −split −rent); above-entry sell forfeited
the resolved share to depth to the lamport with refund exactly 0; dip
sell refunded 96/2/2 to the lamport across seller / depth / treasury;
escrow counters (`total_refunded`, `total_forfeited`) exact; ClaimFees
paid the stack's counters exactly.

## 4. Launcher — Worker C flags resolved

Worker C banked the launcher work (doors.mjs, activation-keeper.mjs
with pure `planActivation`, composer house mode, house launch steps
H0–H6) and flagged three items. All three are **resolved** in this
recovery:

- **(a) H4 seed transfer had NO hook tail — launch-breaking, FIXED.**
  The step built a plain `createTransferCheckedInstruction`; on a
  hooked mint the hook still executes and the transfer fails
  MissingExtra (26) — the contract draft's §3.1 note was itself wrong
  and the plan text repeated it. `launch.mjs` now builds H4 with
  `createTransferCheckedWithTransferHookInstruction` (extras resolved
  from the mint's published meta list, the same path as every other
  transfer in the file), and the H4 plan text + step comment are
  corrected. Trial proof: the houseswap trial's seed transfers
  (mints A/B/C) are TransferChecked *with the full hook tail* and land,
  stocking the vault and writing the disclosed benign basis record
  (the vault is non-exempt until activation, so rule-1 bookkeeping
  writes it a record at unit basis = feed EMA — INTEGRATION.md's H4
  note; after activation the vault is exempt and the record is never
  read again).
- **(b) H5 CommitPool account order — launch-breaking, FIXED.** The
  launcher sent `[launcher(signer), housePoolPda, mint]`; the program
  reads `[pool, mint, authority(signer)]`, so the pool load would have
  failed on-chain. Keys reordered in `launch.mjs` to the program's
  order. (H2 InitPool's order was re-verified against the source and
  matches.) The trial's CommitPool uses the corrected order and lands
  (A9/B3/C2), and a post-commit RemoveLiquidity rejects with
  houseswap Unauthorized (A10).
- **(c) CLI accepted set stale — FIXED at the source of truth.**
  `launch.mjs` hard-coded `IMPLEMENTED = {1,2,3,7,8,9,17}` and refused
  rules 4,5,6,10–16 in CLI specs that the engine and the composer both
  accept — and the browser helpers carried the same stale literal
  (the harness passed because both copies were stale together). Worse,
  `encodeParams` had branches only for the old set, so acceptance
  alone would have encoded zero params. Now: `launch.mjs` derives
  `IMPLEMENTED` from `browser-src/rules.generated.mjs` (generated from
  the engine's `rule_implemented()` by `bin/gen-rules.mjs` — the same
  module the composer consumes); the helpers regeneration prepends the
  same import, so all three surfaces agree by construction. New
  `encodeParams` branches for 4,5,6,10,11,12,13,14,15,16 implement the
  engine's exact layouts; fields are named in the spec JSON
  (`app1/app2` or `apps`, `crownBps`, `seatMint`+`titheBps`, `mode`,
  `dumpThresholdBps`/…, `tzOffsetSecs`/`daysMask`/window minutes,
  `holdSecs`/`releaseTs`, `startBps`/`floorBps`/`decaySecs`,
  `titheBps`, `thresholdSol`/`callerCutBps`) with defaults mirroring
  the proven trial fixtures (rule 12 defaults to the JOB fixture:
  UTC−5, Mon–Fri, 09:00–17:00; rule 14 defaults 500/100 over 30 days;
  rule 16 defaults 1 SOL / 100 bps; rule 15 defaults to tracking-only
  0). Entries with no honest default **refuse loudly** (rule 4 with no
  app named; rule 13 with neither vesting leg; rule 11 buy-cap without
  an amount). NAME_TO_ID gained the 10–16 names. `trial-rule-parity`
  gained section (d) — 13 checks pinning the wiring (no hardcoded
  literal anywhere), the encoder byte layouts, the refusal cases, and
  full-set validateSpec acceptance.

Worker C's banked suites were re-run after these edits (launcher
bundle rebuilt): graduation 46/46, launch-features 68/68, house 26/26,
parity 24/24 (11 banked + 13 new) + parity CLI OK, harness 44/44, site
composer smoke 65/65, trade-check 74/74, web smoke 16/16, render 7/7 —
all still green.

## 5. Test battery (final, all re-run by the recovery coordinator)

Against the Phase C binaries (engine trial/resting `599c4755…`,
houseswap `12430c61…`, real DBC binary):

| Suite | Result | Baseline |
|---|---|---|
| engine trial | 64/64 | 64/64 |
| engine trial-v3 | 29/29 | 29/29 |
| engine trial-v4 | 73/73 | 73/73 |
| engine trial-graduated | 90/90 | 90/90 |
| engine trial-phase-b | 46/46 | 46/46 |
| **engine trial-phase-c** | **88/88** | new |
| integration ecosystem-gate | 28/28 | 28/28 |
| integration dbc-templating | 35/35 | 35/35 |
| integration dbc-latch | 55/55 | 55/55 |
| integration dbc-devbuy | 21/21 | 21/21 |
| integration dbc-ever-fixture | 11/11 | 11/11 |
| integration dbc-v4-rehearsal (preserved mainnet bytes) | 106/106 | 106/106 |
| integration dbc-v3-refresh-rehearsal | 83/83 | 83/83 |
| integration dbc-v3-headline | 43/43 | 43/43 |
| integration dbc-engine-integration-v2 | 40/40 | 40/40 |
| distributor trial | 61/61 | 61/61 |
| distributor trial-fold | 23/23 | 23/23 |
| distributor trial-hooked | 23/23 | 23/23 |
| distributor trial-splits | 42/42 | 42/42 |
| crown-sol trial-crown | 66/66 | 66/66 |
| feeschedule trial | 52/52 | 52/52 |
| buyback trial | 45/45 | 45/45 |
| **houseswap trial-houseswap** | **86/86** | new |
| launcher trial-graduation | 46/46 | 46/46 |
| launcher trial-launch-features | 68/68 | 68/68 |
| launcher trial-house | 26/26 | 26/26 |
| launcher trial-rule-parity (+ CLI check) | 24/24 + OK | 11/11 + OK |
| launcher browser harness | 44/44 | 44/44 |
| site composer smoke | 65/65 | 65/65 |
| site trade-check | 74/74 | 74/74 |
| launcher web smoke | 16/16 | 16/16 |
| launcher web render | 7/7 | 7/7 |

Known pre-existing failures, re-run and **unchanged** (do not chase):
`integration/dbc-engine-integration.mjs` 24 pass / 12 fail (superseded
suite); `integration/dbc-graduation.mjs` 21 pass / 1 fail (fixture).
The aonly-site Playwright render-check timeout from v4 remains
undiagnosed and was not re-run.

Notes on the two new suites:
- **trial-phase-c (88)** — house payload write/read + non-house
  byte-identity vs the Phase B snapshot binary; house-block parse
  validation (6 malformed forms rejected); rule-2 write matrix (10
  cases); rule-2 Execute no-op; HouseVault tags 16/17 (exact lamport
  invariant, one-way reserve, repeat no-op, non-authority rejected);
  ActivateHouse rejects (34 uncommitted, 33 below threshold) and the
  happy path with exact cut/seed/counters and a byte-diff confined to
  venues/exemptions/house-region; double activation → 14; post-
  activation deposit → 14; UpdateConfig immutability matrix (4 reject
  forms + identical-block accept with state/ts preserved); tag 15
  (pending house depth ignored; house-deeper repin + spot fold;
  flip-back; fee-accrued depth subtraction keeps the pin).
- **trial-houseswap (86)** — three launch-shaped mints on the real
  stack. Mint A (fee path, rule 1 LATCH): real curve buys cross the
  threshold; real SDK fee claim lands to the lamport; tag 16 mirrors
  it; activation refuses uncommitted (34); keeper bundle (tag 14 +
  ActivatePool + SyncNative) lands with exact cut/counters; tag 15
  repins both ways with EMA convergence to the winner's spot; house
  buy exact vs the constant-product replica with basis blending at
  the cranked EMA; above-basis sell vetoed Locked (15) atomically;
  dip sell passes, latches, accrues the token fee counter; ClaimFees
  pays both counters exactly and no-ops at zero. Mint B (reserve path,
  rules 1 GRADUATED + 2): tag-17 reserve flow (33 unfunded → recorded
  → repeat no-op); activation refuses before threshold (33); the full
  rule-2 evidence in §3. Mint C (rule 9 only): buys under the cap pass
  with replica-exact outs; a sized buy over the cap is vetoed
  MaxWalletExceeded (2) atomically. Failure modes across the suite:
  33, 34, double-14, double-ActivatePool (houseswap 6),
  pre-activation swap → engine BadCaller (3), post-commit
  RemoveLiquidity → houseswap Unauthorized (4).

**Rehearsal/live-binary note.** The v4 rehearsal fetches the live
configs' published meta-list bytes and proves them byte-identical
under the Phase C binary. The live engine flipped v3 → Phase B
(S1 window) during this recovery run; the rehearsal's fixtures are
byte-identical under either live binary (the lists do not change
across the flip — the same discipline as the Phase B record §7), and
the rehearsal passed 106/106 against the Phase C resting binary.

## 6. What did NOT happen

- No mainnet deploy, upgrade, launch, or fund movement by this phase.
  (S1 was a separate coordinator's window under its own tap.)
- The site composer house mode + rule-2 labeling remain in LOCAL
  source only — publishing is the deploy sheet's last window.
- `launch.mjs`'s `HOUSE_SWAP_PROGRAM_ID` still names the DEV houseswap
  id; it is set to the mainnet id at the houseswap deploy window
  (sheet C2). Until then a mainnet house launch fails at H2 (program
  not deployed) — it cannot silently target a wrong venue.
- The launcher's v4 guard pin (`GUARD.fixedEngineSha256`) is still
  null by design; it moves to the Phase C mainnet hash only after the
  C1 window's live read-back (sheet C1).

## 7. Open forks (flagged, not silently decided)

1. **Rule 9 × house seed (new, from the houseswap trial).** The
   launcher's L3 exemption set for house specs is
   `[poolAuthority, baseVault, seedAta]` — the house token vault is
   NOT exempt until activation appends it. The H4 seed transfer is
   therefore judged by rule 9 like any receive: a house launch whose
   `houseSeedTokens` exceeds the rule-9 cap fails at H4. (Mint C of
   the trial exempted the vault at init to prove venue-side cap
   enforcement; the stock launcher does not.) Recommended fix at
   window prep: add the two house vault ATAs to the L3 exemption set
   for house specs (both addresses are derivable once the mint
   exists), or document seed ≤ cap as a hard launch constraint.
   Until resolved: house + rule-9 launches must size the seed under
   the cap.
2. **ActivatePool fee-rate attestation.** Destination is trustless;
   the rate is caller-supplied within 25..=9900. Whoever runs the
   activation bundle (the activation keeper) must attest the rate
   equals the launch record's curve `feeBps`; the deploy sheet makes
   this a checklist line, not an assumption.
3. **ClaimFees × rule 9.** If accrued token fees would push the fee
   destination over its cap, the claim fails closed and the counters
   stay accrued (no partial-claim instruction in v1). Fee
   destinations on capped stacks should be exempted at config time
   (see fork 1 — same exemption mechanism).
4. **HouseSwap mainnet identity.** Fresh keypair at deploy (sheet
   C2); `HOUSE_SWAP_PROGRAM_ID` wiring + bundle rebuild are part of
   that window, and the first mainnet house launch remains the proof
   obligation per SPEC-GRADUATION-HOUSE §5 — windows alone do not
   prove a live activation.
5. **Carried from Phase B (unchanged):** Distributor splits on hooked
   mints stay deploy-gated (tag 4 forwards no hook extras); rule 16 ×
   holder-fees mutual exclusion on the same SOL stream (composer
   warns); Crown production bond/quorum defaults are Gregory's call
   before the first rule-5 launch; FeeSchedule snapshot semantics;
   buyback crank operator model; Crown liveness trade-off.

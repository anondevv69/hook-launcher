# PHASE B (SETTLEMENT LAYER) — BUILD RECORD (2026-10-19/20)

Status: **BUILD COMPLETE, DEPLOY-READY, LOCAL ONLY.** Nothing was
deployed to mainnet, no token was launched, no funds moved, nothing
was cranked live. Every mainnet step is a separate Gregory tap —
see the draft sheet `PHASE-B-DEPLOY-SHEET.md`.

Authorized scope: Gregory locked
`PLAN-CATALOG-AND-GRADUATION-2026-10-19.md` on 2026-10-19 ("Do what
you gatta do"). Phase A (Engine v4) shipped deploy-ready the same
night; this is Phase B (§2B of the plan): rules **5 Crown
Beneficiary, 6 Tithe Seat, 14 Decay Tax, 15 King stream, 16 Buyback
& Burn**. Rule 2 (Escrow Split) is venue-side Phase C and was **not**
built — it remains the catalog's only unimplemented rule and still
fails closed at config write.

## Headline result

`rule_implemented()` = **{1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
14, 15, 16, 17}** — 16 of 17 catalog rules now have real, trialed
enforcement. Each Phase B rule is enforced end-to-end at realistic
amounts (the AGTR lesson): settlement splits pay the exact lamports
to the exact current holders, the fee schedule moves real withheld
amounts, the buyback crank burns real supply in a real DBC pool.

**New trial assertions: 251, all green** (splits 42, crown 66,
feeschedule 52, buyback 45, engine-phase-b 46). **Full regression
battery: every suite at its exact baseline count** (§7).

## Where honest forms differ from the catalog one-liners

Stated plainly, per the build mandate:

- **Rule 14 Decay Tax — the catalog says the rate decays with
  HOLDER age. That is impossible on Solana**: the Transfer Fee
  extension rate is mint-wide — one rate for every holder. What is
  built is a **mint-wide time schedule**: rate starts at
  `start_bps` and decays linearly to `floor_bps` over `decay_secs`
  since schedule start (≈ launch). The per-holder form is
  venue-side only (house venue) and was not built. Site copy was
  updated to say exactly this.
- **Rule 16 Buyback & Burn — the catalog says "the fee vault's
  distribute buys the token."** Our Distributor vault holds the
  bound token itself (fees are token-denominated), so buying the
  token with the token is meaningless. What is built is the
  **routing-layer form**: for DBC tokens, curve fees accrue in SOL
  to the config's fee_claimer; the crank intercepts that SOL stream
  (the same stream INTEGRATION.md path (b) would otherwise convert
  and route to the vault), buys the token hook-aware on its own
  curve, and burns it. Consequence, flagged as a fork: **rule 16 and
  holder-fee routing spend the same SOL stream** — mutually
  exclusive until a split is designed.
- **Rule 5 Crown Beneficiary — EVM pay-at-source becomes
  settlement-time.** The EVM CrownHook reads the registry inside
  every swap; Solana hooks are veto-only, so the Solana form reads
  the Crown PDA at Distributor settlement. Same observable contract:
  token/pool/rules never change, only who gets paid, from the next
  settlement after a flip.

## Binaries (all `cargo build-sbf --arch v1`)

| program | flavor | file | size | sha256 |
|---|---|---|---|---|
| Engine | mainnet consts | `engine/target/engine-mainnet.so` | **290,224 B** | **`4c4aa6dec113d339e401c019882661f3056318fd659ed450fe23392e86758556`** |
| Engine | trial consts | `engine/target/engine-trial.so` (= resting deploy slot) | 290,224 B | `8a7a5afbb29768997e467dc8534d28b0204bebaca95553349afe12c915eaca51` |
| Distributor | mainnet consts | `distributor/target/distributor-mainnet.so` | **140,312 B** | **`3952e1fa73f6ed34780d015429b6c0977e9440c9265be03d85c746002f37d823`** |
| Distributor | trial consts | `distributor/target/distributor-trial.so` (= resting deploy slot) | 140,312 B | `bef1ff40246777ca53c31ef51bd52ee03efe50405bcc3bf07abd2992ca548db1` |
| Crown (NEW) | dev id `GbHLMTWixPKYo7gthYf1yTWiEAU1LuCmLUQD7x86MHSy` | `crown-sol/target/deploy/crown_sol.so` | **118,832 B** | **`94bf4bb43f66b47b132f907cacc9f73f3794f66534526cdd766c4d5cbe88cfd7`** |
| FeeSchedule (NEW) | dev id `KHb8ukdRqpUPeBJwS8gBxhiqMNowW3siUUDZSLYzGyb` | `feeschedule/target/deploy/feeschedule.so` | **105,688 B** | **`91e8e02e77ecef97459811e82636fa750fe05c3edcc4f9ad46ab9c0aa1b7f393`** |

Crown and FeeSchedule program ids above are the **dev/trial
keypairs**; mainnet gets fresh keypairs at deploy time (sheet §S2 —
the Distributor's CROWN_ID mainnet const is a documented
placeholder until then). Engine/Distributor sources end with
mainnet consts restored, per the v4 convention. ENGINE_VERSION
stays **2** everywhere it exists; DistState layout is **unchanged**
(176 B) so live AGTR state carries across a binary-only upgrade.

Snapshots taken before any edit: `engine/phase-b-snapshot/`
(v4 source + both v4 binaries, hashes verified against the v4
record) and `distributor/src/lib.rs.pre-phase-b` (sha256
`065950ad…c423b`).

## 1. Engine changes (`engine/src/lib.rs`)

Config-write validation in `parse_config_payload` (enabled entries
only; all unspecified params bytes must be zero), exactly the
coordinator-issued layouts:

| rule | params (64 B block) | validation |
|---|---|---|
| 5 Crown | `[0..2]` crown_bps u16 | 1..=10000 |
| 6 Tithe Seat | `[0..32]` seat_mint pubkey · `[32..34]` tithe_bps u16 | seat nonzero; bps 1..=10000 |
| 14 Decay Tax | `[0..2]` start_bps u16 · `[2..4]` floor_bps u16 · `[4..12]` decay_secs u64 | start 1..=10000; floor ≤ start; decay > 0 |
| 15 King | `[0..2]` tithe_bps u16 | 0..=10000 (0 = tracking only; all-zero v4-era params stay valid) |
| 16 Buyback | `[0..8]` threshold_lamports u64 · `[8..10]` caller_cut_bps u16 | threshold > 0; cut ≤ 1000 |

**Cross-rule:** enabled crown_bps + seat tithe_bps + king
tithe_bps must sum ≤ 10000, rejected at write. Execute gains
explicit no-op arms for 5/6/14/16 (enforcement is settlement/crank
side); rule 15's tracking handler is untouched and its tithe param
provably does not affect Execute. `required_extras` untouched —
the Phase B rules need no extras, and the v4 rehearsal re-passes
with all four live configs' meta lists byte-identical.

Trial: `engine/trial-phase-b.mjs` **46/46** (18 accepts incl.
split-sum == 10000 exactly and a full 5+6+14+15+16 stack; 21
rejects covering every invalid case incl. rule 2; Execute no-op
checks; king tracking intact at tithe_bps = 500).

## 2. Distributor splits — rules 6, 15-stream, 5-read

New instruction **tag 4 (DistributeWithSplits)**; tags 1/2/3 are
byte-compatible and share one `distribute_inner` with tag 4, so
fold math cannot drift. Tag 4 validates the engine Config PDA up
front (owner == engine id, address == `["config", mint]`,
tag/version/mint — wrong config account is the new custom error
**11 BadConfig**; bps sum > 10000 is error **12
SplitBpsTooLarge**, both atomic, checked before any CPI), runs the
identical tag-1 fold in both funding modes, then carves on the net
fold (after caller cut) in **crown → seat → king** order, each
`net_fold × bps / 10000` (floor), bps read live from the config:

- **Crown leg:** Crown PDA (owner == Crown program, address ==
  `["crown", mint]`, tag 1) → beneficiary at `[33..65]`; recipient
  token account must be bound-mint and owned by that beneficiary.
- **Seat leg:** the passed seat token account must match
  `seat_mint` from config with amount == 1 (the NFT); recipient
  owned by that account's current owner — **the stream follows the
  NFT**.
- **King leg:** engine King PDA (owner == engine, `["king",
  mint]`, tag 1) → king owner at `[33..65]`; zero owner = no king
  yet → skip.

**Fail-open per split:** sentinel slot, missing/malformed PDA,
seat amount ≠ 1, recipient mismatch → that split is skipped and
its share folds into the holder index; distribute never bricks.
Splits pay live from the vault by PDA-signed TransferChecked.

**Accounting (load-bearing, proven):** DistState layout
unchanged; no room for a `total_splits` counter (3 spare bytes),
so splits are tracked inside `total_paid_out`:
`total_distributed += FULL net fold` (as tag 1) and
`total_paid_out += gross splits` — the unique assignment keeping
`vault == total_distributed − total_paid_out` exact in mode 1
(identity asserted after every trial step) and split money
un-double-claimable in both modes. Transfer fee on split payouts
behaves as on claims (recipients net amount − fee on fee mints;
asserted gross-exact and net-exact).

Trial: `distributor/trial-splits.mjs` **42/42** — mode 1 (20,000
TOK fold → cut 200, crown 990 / seat 594 / king 396 exact; seat NFT
A→B moves the stream; crown flip CB1→CB2 and king change K1→K2
move theirs; fail-open fold pays nobody for skipped legs and the
shares land in the index; errors 11/12 atomic; tag 1 then folds
the same state cleanly) and mode 0 (1% fee mint; harvested fold
with splits gross-exact; conservation to the unit). **The Crown
leg ran against the REAL Crown binary**, with the flip driven
through the real OpenChallenge → Finalize flow — the
cross-program contract is proven, not mocked. Regressions:
61 + 23 + 23 unchanged.

**Limitation (deploy-gating, see forks):** tag-4 split legs
forward **no per-destination hook extras** — on a hooked mint
whose rule stack requires extras for plain receives, a split leg
can fail (atomically reverting tag 4; tag 1 remains the
fallback). Both trial modes used hookless mints. Splits must not
be enabled in production on a hooked (DBC) mint until the
account list grows an extras extension or a hooked-mint trial
proves the stacks in question.

## 3. Crown program — rule 5 (`crown-sol/`, NEW)

Per-mint Crown PDA `["crown", mint]`, 256 B: `[0]` tag = 1,
`[1..33]` mint, **`[33..65]` beneficiary, `[65..73]`
reign_started_ts** (the Distributor's read contract, exact),
then treasury, authority, and all challenge parameters (bond,
quorum, window, timelock, min_reign, cooldown, slash_bps),
cooldown_until, counters, reserved. Companion PDAs: vault
`["cvault", mint]` (lamports), Challenge `["challenge", mint]`
(one live challenge), Stake `["stake", mint, staker, side]`.

Instructions: **0 Init** (params are init-time; production
defaults as marked constants: bond 0.1 SOL, quorum 0.5 SOL,
window 72h, timelock 24h, min_reign 7d, cooldown 3d, slash 2000
bps) · **1 OpenChallenge** (bond becomes the challenger's side-1
stake; candidate may differ from challenger; min-reign +
cooldown + no-live-challenge guards) · **2 Stake** (window only,
either side) · **3 Finalize** (permissionless after window +
timelock; challenger wins iff challenger stake > reigning stake
AND total ≥ quorum; treasury's half of the 20% slash paid at
finalize) · **4 Claim** (pull: winners get stake + pro-rata slash
share, losers get 80%, CEI, double-claim errors cleanly).

Trial: `crown-sol/trial-crown.mjs` **66/66**, all lamports exact —
three challenges incl. a quorum-miss (challenger slashed,
cooldown enforced), beneficiary flips asserted at the PDA bytes,
final vault residual reconciled to **1 lamport** of floor dust.
Adaptations + non-ports are documented in `crown-sol/INTEGRATION.md`
(Model-2 per-mint shape only; Model-1 per-ticker crowns are not
this; treasury is a per-crown init param, not a hardcoded wallet).

## 4. FeeSchedule program — rule 14 (`feeschedule/`, NEW)

Mechanism: the mint's `transferFeeConfigAuthority` is this
program's PDA `["feeauth", mint]` — the only signer the program
can produce, and it signs only `SetTransferFee` at
schedule-derived rates.

- **Tag 0 InitSchedule** — validates the engine Config PDA
  (owner/address/tag/version/mint, rule 14 enabled, params in
  bounds), validates the mint carries a TransferFeeConfig whose
  authority == the feeauth PDA and whose current rate is inside
  [floor, start] (fail closed otherwise); snapshots params +
  `start_ts` + `last_applied_bps` into the Schedule PDA
  `["sched", mint]` (128 B).
- **Tag 1 Apply** — permissionless crank. Target =
  `start − (start − floor) × min(elapsed, decay) / decay` derived
  **only** from the stored snapshot + Clock; an explicit
  `target ≤ last_applied_bps` assert (`WouldRaise`) sits before
  the PDA-signed CPI. `maximumFee` is read from the mint and
  re-passed verbatim — never changed. **The program is
  structurally incapable of raising the rate**, and bounds are
  enforced on-chain, not by crank honesty.

**Authority rotation finding:** in the pinned @solana/spl-token
0.4.15, Token-2022 `SetAuthority` type 4 (TransferFeeConfig)
**does** rotate the fee authority post-creation (proven in
LiteSVM, incl. wrong-signer rejection) — existing mints have a
launcher integration path; setting the PDA at mint init remains
preferred.

**Epoch semantics (operational):** `SetTransferFee` writes take
effect at **epoch + 2**; a production crank must run ~2 epochs
ahead of the schedule. Trial asserts both the scheduled entry and
the post-epoch effective withholding.

Trial: `feeschedule/trial-feeschedule.mjs` **52/52** — init
validation + fail-closed cases (no rule 14, authority not the
PDA, foreign config), exact withholding at start (500 bps),
mid-decay Apply by an unrelated third party → exactly 300 bps,
floor reached and never re-raised under a backwards clock warp,
forged/tampered schedule PDAs rejected — and the required
**post-graduation scenario (S6)**: a hook-free mint runs the full
schedule to floor, then the real Distributor (mode 0, path (a))
folds fees accrued at the decayed 1% and a holder claim pays
exactly (589,811,740 raw). **Rule 14 + holder fee claims survive
graduation, proven end-to-end.** Constraint to note: DBC mints
cannot carry a Transfer Fee extension (fixed DBC extension set),
so rule 14 applies to fee-extension mints (direct/house
launches) — InitSchedule fails closed on any other mint.

## 5. Buyback crank — rule 16 (`buyback/`)

`buyback/buyback-crank.mjs` — library + guarded CLI (no mainnet
mode exists in the code; the CLI hard-exits without `--local` and
even then runs only an offline decision demo). Pure
`planBuyback` decision function; `checkPreconditions` validates
config + feed freshness **before any signature**; steps: claim
DBC partner fees (`claimPartnerTradingFee2`, the hook-aware
variant hook.mjs ships) → threshold check against
`threshold_lamports` → caller cut (floored) → **`swap2WithTransferHook`
buy** on the token's own curve → **BurnChecked from the crank's
own ATA**. Burn reasoning (documented in `buyback/README.md`):
burning your own tokens needs no mint authority and is the only
supply-reducing primitive; an incinerator send strands supply
and is not a fallback. TH-keeper-style JSON state
(serialize-first, tmp + rename).

Trial: `buyback/trial-buyback.mjs` **45/45, twice,
deterministic** — real DBC binary + engine trial binary, a
**rule-1 Basis Latch token** (hardest meta list; crank is
non-exempt, ATA-keyed holder PDAs). Scenario: claimable 2.5 SOL,
threshold 1 SOL, cut 100 bps → cut exactly 25,000,000 lamports;
buy of exactly 2,475,000,000 lamports through the hook; **total
supply fell by exactly the bought amount**; crank ATA ends at 0.
Below-threshold and second-run no-ops exact. Failure safety:
stale feed (980 s > 300 s max) → `PreconditionError`, **zero
signed transactions**, nothing burned; after a price crank the
same run succeeds.

Two documented substitutions (the only ones in Phase B):
**(S1)** the 2.5 SOL claimable in the burn scenario is injected
(real 1% accrual at trial sizes is ~0.0024 SOL) — but the claim
*mechanism* is not substituted: an in-harness probe ran the
production claim instruction and claimed **2,400,000 lamports of
genuinely accrued fees**, SOL delta exact. Unproven: claim CPI
at scenario scale; DAMM LP-fee claiming post-graduation.
**(S2)** the trial's rule-16 config entry was byte-patched into
the Config PDA in-SVM because the trial ran against the v4
engine; the engine-side write path is proven separately by
`trial-phase-b` (46/46) against the Phase B binary.

## 6. Site / composer parity (coordinator step)

The engine agent regenerated `launcher/browser-src/rules.generated.mjs`
but the published-page copy still carried v4 literals — parity
failed on the page only. Coordinator synced the **local site
source** (`aonly-site/hooks/launch/index.html`, NOT published —
publishing stays a post-window step, as in v4): GENERATED id
literals now `[1,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17]` /
unimplemented `[2]`; selectable blocks added for rules 5, 6, 14,
16 in the v4 no-knobs pattern with honest copy (rule 14's block
states the mint-wide form; rule 16's block states the
holder-fees mutual exclusion); the coming-soon grid now lists
only rule 2, labeled Phase C venue-side. Result: parity CLI
**OK**, parity trial **11/11**, site composer smoke **65/65**,
site trade-check **74/74** — all against the edited page.

## 7. Test battery (final, against the Phase B binaries)

New suites: splits **42/42** · crown **66/66** · feeschedule
**52/52** · buyback **45/45** (×2) · engine-phase-b **46/46**.

Regression — every count identical to the v4 baseline:

| suite | result | suite | result |
|---|---|---|---|
| engine trial | 64/64 | launch-features | 65/65 |
| trial-v3 | 29/29 | launcher graduation | 35/35 |
| trial-v4 | 73/73 | harness | 44/44 |
| trial-graduated | 90/90 | launcher web smoke | 16/16 |
| ecosystem | 28/28 | launcher web render | 7/7 |
| templating | 35/35 | site composer smoke | 65/65 |
| dbc-v4-rehearsal | 106/106 | site trade-check | 74/74 |
| dbc-v3-refresh-rehearsal | 83/83 | distributor trial | 61/61 |
| dbc-v3-headline | 43/43 | distributor trial-fold | 23/23 |
| integration-v2 | 40/40 | distributor trial-hooked | 23/23 |
| latch | 55/55 | devbuy | 21/21 |
| EVER fixture | 11/11 | rule parity | 11/11 + CLI OK |

Known pre-existing non-green items, verified **unchanged** (not
chased, per the v4 record): `integration/dbc-engine-integration.mjs`
24 pass / 12 fail (superseded suite); `integration/dbc-graduation.mjs`
21 pass / 1 fail (standing fixture issue). The aonly-site
Playwright render-check that timed out in v4 remains undiagnosed
and was not re-run; the composer gates that cover the edited page
(smoke, trade-check, parity) are all green.

## 8. What did NOT happen

No mainnet deployment or upgrade. No token launches. No funds
moved. No live cranks. No site publish (local source synced
only). No DistState/Config/Holder layout changes. Rule 2
untouched. No byte-baselines recaptured except the deliberate,
documented ones: the generated rules file and the site launch
page (this record §6).

## 9. Open forks (flagged, not silently decided)

1. **Crown production defaults** — bond 0.1 SOL / quorum 0.5 SOL
   are suggested constants in code; the production values are
   Gregory's call.
2. **Splits on hooked mints (deploy-gating)** — tag-4 split legs
   forward no hook extras (§2). Do not enable 5/6/15 splits on a
   hooked (DBC) mint in production until the account list grows
   an extras extension or a hooked-mint splits trial passes.
   Hookless / fee-extension mints are unaffected.
3. **Crown liveness trade-off** — a staker who never claims
   blocks the next challenge on that crown (refund safety over
   liveness, chosen by the build; a claim-deadline sweep is the
   future fix). A slash pool whose winning side has zero stakers
   is unclaimable vault surplus by construction.
4. **Rule 16 × holder-fees** — same SOL stream; composer copy
   states mutual exclusion, but no engine-level reject exists
   yet (a config-write combo check is a small future add).
5. **Buyback operation** — only the fee_claimer of record can
   sign the claim, so "permissionless" is trigger-only for
   launcher/creator claimers; who operates the crank per template
   is a launch-policy decision. Cut/threshold template defaults
   (trial used 100 bps / 1 SOL) are Gregory's call. Base-side DBC
   fees landing in the crank ATA (burn vs route) undecided.
6. **FeeSchedule crank incentive** — none in v1 (the program
   holds no funds; a cut can't be paid on-program). If
   third-party cranks don't materialize, pay via the
   Distributor's caller cut on a combined apply+distribute
   keeper tx. Cadence is forgiving — a late crank lands the
   exact current target.
7. **FeeSchedule snapshot semantics** — a later engine
   UpdateConfig does not retcon a running schedule (same posture
   as the DBC threshold); launcher copy should surface this at
   launch.
8. **Crown mainnet id** — the Distributor's mainnet CROWN_ID
   const is the dev id as a placeholder. The deploy sequence
   (sheet §S2) generates the mainnet Crown keypair FIRST and
   rebuilds the Distributor against it before its window.

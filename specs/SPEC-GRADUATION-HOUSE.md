# SPEC — Graduation to the House Venue (`graduation: "house"`)

Design note only — no code. Companion to SPEC-HOOK-LAUNCHER §11
(graduation behavior). `release` and `never` shipped 2026-10-16; this
note scopes the third value. A spec naming `house` today is rejected by
the launcher, with a pointer here.

## Headline conclusions

1. **DBC's own migration can never land on the house venue.** The
   migration destination is a two-value enum in the DBC program
   (`MigrationOption::{MeteoraDamm, DammV2}` — `state/config.rs:425`);
   there is no custom target and no partner hook into the path. Worse,
   the transfer-hook revocation fires **inside the completing swap**
   (pool-authority-signed `revoke_transfer_hook`, verified in
   DBC-INTEGRATION Item 4): the moment a release curve completes, the
   mint is already hook-free — program *and* authority zeroed — before
   any migration instruction runs. A design that "lets the curve
   complete, then moves liquidity to the house with rules intact" is
   impossible on this venue; the rules die in the completing
   transaction itself.
2. **So house graduation is a venue activation, not a migration.**
   The token launches with the `never` threshold (the curve can never
   complete, the hook never dies), and at the configured graduation
   point the platform **opens a second venue for the same mint**: a
   TH-style house swap pool, admitted into the engine Config's venue
   allowlist. No mint migration, no liquidity extraction from the
   curve, no state port — Config, Holder, and PriceFeed PDAs are keyed
   by mint (and owner) and are venue-independent, so continuity across
   the move is automatic. This is the only shape that preserves the
   rules, the state, and the token's identity at once.
3. **The real work is an engine change plus a funding answer** — a
   pre-committed venue slot that Locked configs may activate exactly
   once, and a graduation reserve to seed the house pool, because the
   curve's reserves are not extractable before completion (and under
   `never`, completion never comes).

## 1. Trigger mechanics at the threshold

- **Observable:** the DBC pool's quote reserve crossing the spec's
  graduation point (a `graduationThresholdSol` that, under `house`,
  means "activate the house venue at this much raised" rather than
  "migrate"). The same pool-state read the engine's `CrankPriceDbc`
  performs (sqrt_price at offset 280; reserves in the pool account)
  gives a keeper everything needed to detect the crossing.
- **No completing-swap hazard:** under the `never` threshold there is
  no PartialFill completion edge, no revocation race, and no flash
  rent (the ~1–2 SOL pool-authority float that release migrations
  need). Activation can happen any block after the crossing; a late
  activation costs nothing but time.
- **Who fires it:** open design choice — a platform keeper (TH's
  crank-keeper pattern: dedicated keypair, Railway-hosted,
  permissionless-in-spirit) or a permissionless activation instruction
  anyone may call once the reserve condition reads true on-chain,
  optionally with a Distributor-style caller cut. The condition must
  be checkable *on-chain* by the activating instruction (read the pool
  account), not trusted from the caller — otherwise "graduation" can
  be fired early by anyone who wants the second venue open.
- **One-way:** activation is a latch, not a toggle. There is no
  de-activation; the record and the Config must both show it happened
  (activation slot/timestamp in the engine state, mirroring how the
  Basis Latch records its own one-way flip).

## 2. Moving liquidity — what actually moves (nothing), and what seeds the house pool

- **Curve reserves stay put.** The DBC pool's SOL and token vaults
  belong to the DBC program; before completion the only way value
  leaves is through swaps. Any design that promises to "move the
  curve's liquidity" is promising an extraction that does not exist.
  Under this design the curve simply **keeps trading in parallel** —
  it remains a live, rules-enforced door forever, next to the house
  pool. Liquidity fragmentation across two venues is inherent to the
  shape and must be disclosed, not hidden.
- **House pool seed sources** (pick at spec time; likely a blend):
  1. A **graduation reserve**: SOL escrowed at launch in a program
     PDA (new spec field, e.g. `houseReserveSol`), released only into
     the house pool's vaults at activation. Cleanest accounting;
     costs the deployer real SOL up front.
  2. **Accumulated creator fees**: the claimer claims curve fees
     (`hook.mjs claim-fees`) and seeds with them. Self-funding but
     timing-dependent — a token that graduates on a clean run has
     earned only ~1% of the threshold in fees (≈0.42 SOL at 42 SOL /
     1%), a thin pool.
  3. **Deployer top-up at activation**: simplest, least trustless —
     graduation day depends on the deployer showing up with SOL.
- **Seed composition:** the house pool needs both sides. The token
  side comes from the deployer's retained supply or a market buy on
  the curve at activation (which also pushes the curve price — the
  seed price for the house pool should be *read from the curve at
  activation*, not fixed at launch, or the two venues open already
  arbitraged against each other).

## 3. Config / Holder continuity

- **Automatic, by construction.** Engine state is keyed by mint:
  Config PDA (`["config", mint]`), Holder PDAs (`["holder", mint,
  owner]`), PriceFeed (`["price", pool]`). A new venue changes none of
  the keys. Basis, latch state, vesting clocks, ecosystem tags, and
  fee-settlement mirrors all carry across activation **byte-identical**
  — there is no import step to get wrong. (Contrast the rejected
  new-mint design in §6, where every one of these breaks.)
- **The Config change is the venue list, and only the venue list.**
  Activation adds the house swap program to `venues` and the house
  pool's vaults to the exemption set — the same two lists launch
  already populates for DBC (pool authority + base vault exemptions).
- **The Locked problem.** `authorityMode: locked` promises "the rules
  can never be changed — not by you, not by anyone." Adding a venue
  post-launch reads as a config change. The resolution: the house
  venue is **pre-committed at launch** — its program id and pool
  derivation are knowable in advance (the house swap is our program;
  the pool PDA derives from the mint), so the Config can carry a
  `pending_house_venue` slot from block one, and activation flips a
  one-way flag that admits exactly that pre-declared venue and no
  other. Under this reading Locked's promise survives: nothing
  *undeclared* can ever be added, and the launch record/spec disclose
  the pending venue before the first buy. Engine work required:
  the pending-venue field, the activation instruction with its
  on-chain threshold check, and the caller-validation branch that
  lets the engine accept house-swap transfers (venue_context handling
  — the Distributor caller-fix of 2026-10-16 is the precedent for how
  a new top-level caller gets admitted, narrowly).
- **PriceFeed source.** Today the feed cranks from the DBC pool
  (`CrankPriceDbc`). After activation there are two pools with two
  prices. Options: feed keeps reading the curve (house trades gate on
  the curve's EMA — defensible while the curve is the deeper venue);
  feed switches source at activation (TH's model: the feed reads the
  one canonical pool); or dual-source with the deeper-reserve pool
  winning. This choice changes latch behavior post-graduation and
  needs its own trial matrix — it is the subtlest correctness item in
  the design.

## 4. What the migrated token's trading looks like

- Same mint, same hook, same rules — trading on **two** hook-aware
  venues: the DBC curve (unchanged doors: skill flow, composer trade
  surfaces) and the house swap (TH's TaxSwap pattern generalized: one
  canonical pool against pinned vaults, constant-product, keeper- or
  caller-cranked feed). Plain aggregators and hook-blind bots remain
  unable to route it — identical consequence to `never`; house
  graduation buys a *second, platform-owned door and a post-curve
  market shape*, not universal routing.
- The house pool can carry house rules the curve can't: TH-lineage
  mechanics that need settlement control (escrow-style splits are
  house-venue-only per the hook-purity ruling — they ride the swap,
  not the hook) become available to a graduated token's *house* trades
  while its curve trades stay pure-hook. Labeling must keep the two
  apart.
- Fee posture post-activation: curve fees keep accruing to the
  claimer as today; the house pool's fee (if any) is a house-venue
  parameter set at activation, claimable through the same
  Distributor in routed mode. Holder-fee continuity is unaffected —
  the Distributor is keyed by mint too.

## 5. Proof obligations (before any mainnet `house` launch)

Following the tree's established pattern (LiteSVM against the real
binaries first, counts published like every other suite):

1. `never`-threshold launch with a pending house venue pre-committed;
   Config bytes at launch show the pending slot; Locked mode rejects
   every other config mutation, before and after activation.
2. Activation refused before the threshold (on-chain reserve read),
   fires at/after it, refuses a second time.
3. Byte-identity: Config rule stack, all Holder PDAs, and the feed
   snapshotted pre-activation and compared post-activation — identical
   except the venue/exemption/flag bytes activation exists to change.
4. First house swap under the full rule stack: Agent-Only veto,
   Max Wallet cap, Basis Latch gating on the feed (whichever source
   §3 picks) — same negative/positive matrix as the DBC integration
   suite, re-run against the house venue.
5. Parallel-venue behavior: curve buy → house sell (and reverse)
   with basis blending across venues; an arbitrage round-trip does
   not corrupt basis, peak, or latch state.
6. Funding path: reserve-funded seed lands in the house vaults
   exactly; fee-funded variant reconciles to the lamport.
7. Failure drills: activation attempted with an empty reserve;
   house pool seeded off-price vs the curve (arbitrage drain
   bounded); keeper death after activation (crank is permissionless —
   trading must self-heal).

## 6. Designs considered and rejected

- **Re-aim DBC migration at the house swap.** Impossible —
  `MigrationOption` is Meteora-only and revocation precedes migration
  (§Headline 1). Not a matter of effort.
- **Re-attach the hook after release graduation.** Revocation zeroes
  the extension's program *and* authority; the mint's hook authority
  sat with the DBC pool authority from pool creation. There is no
  instruction anywhere that resurrects it. Terminal.
- **New mint on the house venue + 1:1 claim** (HARVEST v3's
  MigrationClaim pattern). Works mechanically, but abandons
  everything §3 gets for free: Config/Holder state is keyed by the
  old mint, the old token's curve SOL is stranded behind a hook that
  either still binds it or dies by release, holders must act to
  migrate (some never will — two half-tokens result), and the token's
  identity/addresses all change. Strictly worse than venue activation
  for this architecture.
- **DAMM v2 with a token badge.** Proven NO-GO twice over (badge is
  operator-issued by two hardcoded Meteora admin keys; cp-amm never
  resolves hook extra accounts — METEORA-PROOF E1/E2).

## 7. Open questions for Gregory

1. **Seed funding:** graduation reserve escrowed at launch (trustless,
   costs up-front SOL), fee-accumulation (self-funding, thin), or
   deployer top-up at activation (simple, depends on the deployer)?
2. **Trigger authority:** permissionless on-chain-checked activation
   (anyone may fire it once true — recommended; matches the crank
   philosophy) vs platform keeper only?
3. **Mandatory or optional:** must a `house` token activate when the
   threshold reads true, or may the deployer let it ride on the curve
   (i.e., is `house` a commitment or an option the deployer holds)?
4. **Feed source after activation:** curve EMA, house-pool EMA, or
   deeper-venue-wins? (Drives the §5.4 trial matrix.)
5. **Curve wind-down posture:** the curve cannot be closed on-chain.
   Do our doors default graduated tokens to the house pool and treat
   the curve as legacy, or present both equally forever?
6. **Spec surface:** does `house` carry its own threshold field
   (`graduationThresholdSol`) distinct from `migrationThresholdSol`,
   since under `house` nothing migrates? (This note assumes yes —
   cleaner semantics, and `never`'s contradiction rule extends
   naturally: `house` + `migrationThresholdSol` is also rejected.)
7. **House pool fee:** rate, destination (creator/holders), and
   whether it may differ from the curve's creator fee.

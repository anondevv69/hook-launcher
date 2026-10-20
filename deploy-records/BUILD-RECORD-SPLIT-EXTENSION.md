# BUILD RECORD — Split Extension + Phase C Window-Prep + Site Staleness (2026-10-20)

Local build + LiteSVM trials + local site staging only. **No mainnet sends, no
deploys, no site publish.** Three tasks from the post-S6 fix list, built after
`DEPLOY-RECORD-S2-S4-S6.md` (live at build start: Crown
`HWZpJ7GnDifwo7g77PKefeVXdzbse7sfRjKrNUna3gJN`, Distributor ELF sha256
`321dffee…` at 140,312 B in a 149,293 B ProgramData, FeeSchedule
`66HUbm4tgcCsRkDL655UUrmm1aEVGugJzcYNm6NDFkFL`, engine live = Phase B).

---

## Task 1 — Hooked-mint split extension (Distributor tag 4)

### What shipped

Tag 4's instruction data was extended (not a new tag — identical fold/split
semantics; a new tag would fork the entry point for no gain):

- Legacy form `data = [4]` — byte-identical to before, all legs bare
  (hookless callers unaffected).
- Extended form `data = [4, 1, tail_n, crown_n, seat_n, king_n]` (exactly
  6 bytes): the trailing accounts are the **legacy tail first**
  (`tail_n` accounts — funding mode 1: the cut transfer's hook extras;
  funding mode 0: the withheld-fee source accounts, with the groups
  following them; mode-0 cut carries no extras, as before), then the
  **crown, seat, and king extra groups in leg order**, each resolved for
  source = vault, destination = that leg's recipient token account, in the
  proven `trial-hooked` tail shape (config, source/dest Holder PDAs, rent
  vault, PriceFeed, system, instructions sysvar, engine, meta list).
- The four counts must sum **exactly** to the trailing account count. A bad
  version, bad length, or count mismatch hard-errors
  `InvalidInstructionData` **before** any harvest CPI or transfer runs —
  proven atomic in the new trial (section M).

Client format is documented in `distributor/INTEGRATION.md` ("Tag 4
hooked-mint extension": format, ordering, counts, writability, mode
interplay, and the limitation below).

### The limitation — transfer-stage fail-open is IMPOSSIBLE on Solana (proven)

The design brief asked for a vetoed leg to fail open mid-distribution
(catch the leg's CPI error, pay the other legs, leave the vetoed amount in
the vault). **That mechanism cannot be built.** A failed CPI is fatal to
the whole instruction regardless of the caller's Rust error handling.
Evidence, from a catch-equipped build (the `match` on `invoke_signed` was
verified present in the ELF strings), at two independent depths in
LiteSVM:

- Hook level: engine Agent-Only veto → engine logs the veto →
  Token-2022 `failed: 0x1` → the Distributor instruction aborted with
  `0x1`; no continuation, no state movement.
- Token level (frozen-recipient probe on a hookless mint, no hook
  involved): Token `Error: Account is frozen` (`0x11`) → Distributor
  aborted with `0x11` despite the match arm.

A probe-Execute pre-check is equally fatal (and side-effecting), and
mirroring individual engine rules inside the Distributor would not be
hook-pure. Per the brief's own stop rule, this was **not** forced:

- The shipped program keeps `?` propagation on split legs. A hook-vetoed
  leg reverts the whole tag-4 instruction atomically — nothing pays,
  nothing moves, the fold is simply retryable under changed conditions.
- The fail-open surface that DOES work is the pre-existing
  **validation-stage sentinel skip**, and it is now proven on a hooked
  mint (trial D2b): a leg the crank knows will veto is sentinel-skipped
  with a 0-length group; the remaining legs pay exactly, the skipped
  amount folds into the remainder/index, and `total_paid_out` counts
  paid legs only, with the identity `vault == total_distributed −
  total_paid_out` exact.
- **Crank/client guidance for the future deploy window:** before folding
  a hooked mint, pre-check split recipients off-chain (Registry
  registration, cap headroom) and sentinel-skip any leg expected to
  veto; never discover a veto mid-fold.

### Trial — `distributor/trial-splits-hooked.mjs`, 26/26 (new)

Real engine + real Crown binaries, mode-1 (routed) hooked mint, engine
config `[3 Agent-Only, 9 Max Wallet 2000 bps, 5 Crown 500 bps, 6 Seat
300 bps, 15 King 200 bps]`, venue allowlist `[DISTRIBUTOR]` (the
trial-hooked precedent — distributor payout CPIs otherwise fail caller
validation with BadCaller before rules run):

- **D1 clean:** all legs pay exact on a 20,000 TOK fold (cut 200 / crown
  990 / seat 594 / king 396). **Hook provably executes on the king leg:**
  the engine King PDA balance moves 60,000 → 60,396 TOK with owner and
  account unchanged (rule-15 streaming-max tracking is an Execute-side
  effect; a hookless transfer cannot produce it).
- **D2 negative proof:** crown beneficiary flipped to an unregistered
  wallet through the real Crown challenge→finalize flow; the
  distribution reverts on the Agent-Only veto, state and balances
  byte-unchanged, deposit still unfolded.
- **D2b:** the same vetoed leg sentinel-skipped → seat + king pay exact,
  King PDA +396 again, the skipped 990 folds into the index,
  `total_paid_out` = 2,970 TOK (paid legs only), identity exact
  (36,630 TOK).
- **F:** tag-2 claim with extras on the hooked mint pays the exact
  entitlement; identity holds.
- Fixture lesson recorded in the trial header: rule 15's streaming max
  updates on *every* transfer, so a mid-distribution leg can crown a new
  king and change the king-leg recipient; the scenario balances were set
  with that in view (king pre-seeded at 60,000 TOK).

### Binaries (both `cargo build-sbf --arch v1`, 142,904 B)

| Flavor | Path | sha256 |
|---|---|---|
| Trial | `distributor/target/distributor-trial.so` (= resting `target/deploy/distributor.so`) | `e9f8d0d00db8019f3b42ef466cb4749fc5c602057d2ab9e01e6bc118d8d21fca` |
| Mainnet (live Crown `HWZpJ7Gn…`, engine `EPdYVfsX…`) | `distributor/target/distributor-mainnet.so` | `1eb98c1e1ba435fc44bdcff9d9b6881bb262663b0773340f4c086a502f46e9de` |

Source rests with mainnet consts (verified in `distributor/src/lib.rs`);
pre-edit snapshot kept at `distributor/src/lib.rs.pre-splits-hooked`
(sha256 `d7439c87…aca`).

### Future window delta — Distributor re-upgrade

- **No extend needed.** Live ProgramData is 149,293 B (45 B header +
  149,248 B ELF capacity); the new mainnet ELF is 142,904 B → **6,344 B
  of margin**.
- Cost of the future re-upgrade is therefore transaction fees only
  (write-chunk + finalize signatures, ~0.0001 SOL scale) plus the
  **refundable** buffer float (~0.996 SOL at
  (142,904 + 128) × 6,960 lamports), returned in full when the buffer
  closes — the S3 pattern. No permanent rent delta.
- Deploy-gate wording change this build earns: rules 5/6/15 splits are
  executable on hooked (DBC) mints **provided no leg is vetoed at fold
  time**; a veto reverts the fold atomically (safe, retryable) rather
  than failing open per-leg.
- Open note carried from the trial-hooked precedent: hooked payout CPIs
  require the Distributor in the mint config's venue allowlist. Whether
  a given live config carries it is a per-launch config question for
  the deploy window, not a property of this extension.

### Distributor suites — all baselines exact

| Suite | Result |
|---|---|
| trial | 61/61 |
| trial-fold | 23/23 |
| trial-hooked | 23/23 |
| trial-splits | 42/42 |
| trial-s3-rehearsal (against the new mainnet binary) | 6/6 |
| trial-splits-hooked (new) | 26/26 |

---

## Task 2 — Phase C window-prep fixes

### (a) Rule 9 × house seed — built

`launcher/launch.mjs` now derives **one** `l3Exemptions` list used by
both the L3 plan text and the live L3 `InitializeConfig` execution
(replacing the inline ternary). House-committed configs:

```
[poolAuthority, baseVault, seedAta, houseTokenVault, houseQuoteVault, feeDestTokenAta]
```

6 entries, within the engine's `MAX_EXEMPTIONS = 8`. Non-house configs
unchanged at `[poolAuthority, baseVault]`. The plan text names all six
with their roles; the launch record now also stores `feeDestTokenAta`
and the full `l3Exemptions` list. The changed code lives outside the
regions sliced into `browser-src/helpers.generated.mjs` (regenerated
via the repo's extract script — byte-identical, sha256 `b81ab408…`);
the browser composer does not execute house steps in this build, so
there was no second derivation to update.

Enforcement proof (houseswap trial, mint C): mint C's config was
switched to the launcher's exact derived 6-set (dropping the hand-built
list and its MM-wallet exemption). **C1:** seed transfer above the cap
into the house token vault passes. **C5:** a sized house buy that would
push a non-vault wallet over the cap still vetoes
(`MaxWalletExceeded`, atomic).

Companion engine change: because L3 now pre-exempts the house vaults,
`ActivateHouse`'s exemption append was made **idempotent** — it appends
only vaults not already present, and its capacity check counts only the
missing additions. New houseswap check **C3b** proves it on-chain:
the stored post-activation exemption set equals the derived 6-set
exactly (the old engine would have duplicated to 8).

### (b) ActivatePool fee-rate attestation — built

`launcher/activation-keeper.mjs`:

- New exported `parseDbcConfigFeeBps(dbcConfigBytes)` implementing the
  verified DBC PoolConfig layout (Anchor discriminator 8 B; cliff fee
  numerator u64 @104, period_frequency @112, reduction_factor @120,
  number_of_period u16 @128, base_fee_mode @130; `bps = cliff /
  100_000` against FEE_DENOMINATOR 1e9). Returns the bps plus all
  scheduler fields and a `flat` flag; throws on missing/short/
  non-integer/out-of-range input.
- New exported `attestFeeBps({feeBps, launchRecordFeeBps,
  dbcConfigBytes})`: throws on **no attestation source**, on
  **launch-record mismatch**, and on **DBC-config mismatch**.
  Non-flat schedulers attest on the cliff (starting) rate — the launch
  record's `fees.feeBps` is the starting rate — and that choice is
  documented in code and in the mismatch error text.
- `buildActivatePoolIx` runs `attestFeeBps` after the existing
  25..=9900 bounds check: a caller-attested rate alone can no longer
  build an activation instruction.
- `planActivation` threads the optional fee inputs through (return
  shape unchanged): a supplied-but-unattested or mismatched rate
  becomes a `missing` not-ready reason instead of a planned bad
  activation. CLI local-only guard untouched (refuses without
  `--local`, exit 2).

Trial coverage: trial-house C10 now attests against the launch record;
new checks **C11–C19** cover matching record+config, record mismatch,
config mismatch, no source, exact flat-field parsing, non-flat cliff
attestation, short/missing parser input, and both planActivation
paths. The D-series house spec now also carries rule 9, and D4 asserts
the L3 line lists all six named exemptions.

### (c) ClaimFees × rule 9 — built (fell out of (a), no separate design)

The fee-destination token ATA is in the (a) list:
`feeDestTokenAta = ATA(mint, feeClaimer)` under Token-2022. It falls
out naturally because the fee claimer is fixed at L1 (the DBC config's
`fee_claimer`; the launch record mirrors it as `fees.feeClaimer`), the
mint exists before L3, and the ATA is a pure derivation of the two —
no new inputs, no new mechanism. It is an **account-scoped** exemption
(the engine's `is_exempt` matches owner-or-account; an ATA entry
exempts only that account, never the wallet). House-only scoping is
correct because houseswap ClaimFees exists only on house tokens.
Activation now consumes 0 exemption slots (idempotent append), leaving
2 of 8 headroom.

### Engine binaries (ActivateHouse idempotence; `cargo build-sbf --arch v1`)

| Flavor | Size | sha256 |
|---|---|---|
| Trial (`engine/target/engine-trial.so`; resting `target/deploy/engine.so` identical) | 318,144 B | `092d893d778122054d578b56dc4e60fc5372ee2d6a2a737e77542b9a1b7d5330` |
| Phase C mainnet (`engine/target/phase-c/engine-mainnet-phase-c.so`) | 318,144 B | `87d31f834d31026f4492dd718f4f07d69897a8b2dd8b1257dc5c188cecc398cb` |

The Phase C mainnet flavor **supersedes `9718ff6e…`** (317,632 B) from
BUILD-RECORD-PHASE-C: +512 B. `engine/target/engine-mainnet.so`
(Phase B, `4c4aa6de…`) untouched and re-verified. Source rests with
mainnet consts.

### Suites

| Suite | Result | Baseline |
|---|---|---|
| launcher trial-launch-features | 68/68 | 68/68 |
| launcher trial-graduation | 46/46 | 46/46 |
| launcher trial-house | **35/35** | 26/26 + 9 new (C11–C19; D4 strengthened) |
| engine trial-phase-c | 88/88 | 88/88 |
| houseswap trial-houseswap | **87/87** | 86/86 + 1 new (C3b) |
| launcher trial-rule-parity | **24/24 + CLI OK** | 24/24 + CLI OK (see note) |
| launcher browser harness | 44/44 | 44/44 |
| engine trial | 64/64 | 64/64 |
| engine trial-v3 | 29/29 | 29/29 |
| engine trial-v4 | 73/73 | 73/73 |
| engine trial-phase-b | 46/46 | 46/46 |
| engine trial-graduated | 90/90 | 90/90 |
| integration dbc-v4-rehearsal | 106/106 | 106/106 |

**Parity note:** trial-rule-parity initially read 21/24 in this build.
The 3 failures were stale section-(c) expectations written when the
engine guard pin was null; the S1/S6 windows have since set the pin
(`engine-v4.json`: `b32e3361…`, the live ProgramData tail hash), so the
guard correctly no longer refuses pinned launches. Section (c) was
rewritten (test file only — no guard code, pin file, or generated
rules touched) to assert the pinned-state behavior against the guard's
verified semantics: pin non-null and equal across `engine-v4.json` /
generated GUARD; the pure decision allows rule-1 + `never` when live
hash == pin and refuses on a differing live hash, an unreadable live
hash, and a null pin. Final: **24/24 + CLI OK**.

---

## Task 3 — Crank-staleness indicator + Ecosystem Gate copy (site, STAGED LOCALLY, NOT PUBLISHED)

### Indicator

Added to `hooks/latch/index.html`, `hooks/harvest/index.html`, and
`hooks/ever/index.html` — in each case an additive `<p id="crankage">`
element beside the page's honest-notes copy plus ONE separate inline
script (the existing error-trap script is untouched in all three).
Vanilla JS only, no external code: JSON-RPC `getAccountInfo` (base64)
against `https://api.mainnet-beta.solana.com`, `last_crank_ts` read as
i64 LE at byte 113, age = now − ts, rendered as "price feed cranked Xs
ago" (Xm Xs / Xh Xm forms), refreshed every 30 s. Past 300 s (or
`ts == 0`) it renders an amber STALE warning naming the 300 s bound;
fetch failure / missing account renders a quiet "price feed age
unavailable". All paths are catch-wrapped so nothing can reach the
page error trap. Feeds: LATCH `3h5KitPaStLQzm7kBwhjAZJeDREdFUsDZ3CRULgn4bXf`,
HARVEST `E8nAyNBSnSKzKa4gChveAXyh7uHa4reQq3k2kun97ZUA`,
EVER `998zYYVs64axarjVy2kDHv1gKJEt6mzNxuqbNuUfWV8B`.

The EVER page received **only** this additive block — no other content
edits (parallel metadata-repair coordinator owns the rest of that
page). No launches-feed JSON, `api/`, `server.py`, or `*-record.json`
files were touched.

Honest state at staging time: a read-only decode of all three feeds
showed every one past the 300 s bound (ages ≈ 381,141 s / 308,155 s /
34,814 s for LATCH / HARVEST / EVER) — the indicator will render STALE
on load for all three until their cranks resume. That is the truth
the indicator exists to show.

**Trade page: not added, per the task's condition.** `hooks/trade/
index.html` embeds the Latch `priceFeed` address in its token record
but its status flow never reads that account (its `getAccountInfo`
calls cover only the ATA, the holder PDA, and the registry PDA). It
does not already read feed state, so it was left untouched.

### Ecosystem Gate honesty copy

- `hooks/docs/index.html` (rule-17 paragraph): appended — "Of the
  sixteen ecosystem presets, only Muse (preset 1) has its attester
  configured today — presets 2–16 are unset, so no other ecosystem can
  attest a wallet yet."
- `hooks/launch/index.html` (rule-17 panel, after "Use it when…"): a
  note in the same terms — today only Muse is attestable; presets
  2–16 are unset. Copy only; no composer logic changed.

### Site checks (local)

| Check | Result |
|---|---|
| tests/hooks-composer/smoke-test.mjs | 65/65 |
| tests/hooks-composer/trade-check.mjs | 74/74 |
| tests/hooks-composer/latch-check.mjs | 63/63 |
| tests/hooks-composer/harvest-check.mjs | 65/65 |

(No ever-check.mjs exists.) The indicator scripts were additionally
stub-tested (fresh / stale / never-cranked / missing / fetch-failure
paths) and render-checked in Chromium via the latch/harvest suites
with zero page errors.

---

## C-window prep — now done / sheet deltas

For the eventual C1 → C2 → C3 windows (funding-gated, not run here):

1. **C1 engine artifact changed.** Use the new Phase C mainnet flavor:
   318,144 B, sha256 `87d31f834d31026f4492dd718f4f07d69897a8b2dd8b1257dc5c188cecc398cb`,
   superseding `9718ff6e…` (317,632 B) in `PHASE-C-DEPLOY-SHEET.md`.
   **Extend count unchanged:** the live engine ProgramData is
   300,493 B; the new ELF needs ≥ 318,189 B — still two +10,240 B
   extends (→ 320,973 B), same as the sheet planned.
   Note: any engine ProgramData resize re-opens the launcher guard
   pin — the C-window must republish the guard pin as the new tail
   hash (the S1 lesson), exactly as S6 did.
2. **House launches from this build forward** carry the 6-entry L3
   exemption set (house vaults + fee-destination ATA exempt from
   launch), and ActivateHouse no longer duplicates them.
3. **Activation keeper (C3 wiring):** ActivatePool construction now
   refuses an unattested fee rate — the keeper host must supply the
   launch record's `fees.feeBps` and/or the DBC config account bytes.
4. **Distributor re-upgrade (any future window):** new mainnet ELF
   142,904 B, sha256 `1eb98c1e1ba435fc44bdcff9d9b6881bb262663b0773340f4c086a502f46e9de`,
   fits the existing 149,293 B ProgramData — **no extend**, fees-only
   permanent cost plus the refundable ~0.996 SOL buffer float.
5. **Site:** the staleness indicator + Ecosystem Gate copy are staged
   locally and will ride the next publish (the C3 house flip redeploy
   or any earlier one). Nothing in this record was published.

## Stopped-on items

- **Transfer-stage fail-open for split legs: stopped, with proof**
  (Task 1 above). Solana CPI failure is instruction-fatal; the
  extension ships with atomic-revert semantics and the sentinel-skip
  fail-open surface instead. No other item was stopped on.

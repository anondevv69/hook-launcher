# SPEC — GRADUATED LATCH (engine rule 1, new mode 2)

**Status:** APPROVED DESIGN (Gregory, 2026-10-15). **Not built, not
deployed.** The mainnet upgrade is packaged in §8 with the Ecosystem
Gate (rule 17) and Registry v2 as **one combined upgrade** — Gregory's
go for the whole wave was given 2026-10-15 23:54, and no deploy happens
in the build run: the combined package is the deliverable.
**Design anchor (Gregory):** the classic latch is "stop and go" — float
frozen at 100% until a dip, then 100% free at once. GRADUATED keeps the
latch as its limit case and earns the exit in between: time in the
position and drawdown endured both count, continuously, so sellable
float staggers in instead of cliffing (§7).

---

## 1. The idea in one paragraph

Rule 1 (Basis Latch) gains a third mode. In GRADUATED mode a non-exempt
sender may transfer out only up to an **earned sellable fraction** of
their position: the fraction grows linearly with time held, grows with
the drawdown the holder has actually lived through (measured against
their own blended basis, at prices they themselves observed), and jumps
to 100% the moment the classic latch fires. The fraction is enforced
through a ratcheted cap in raw units, so it cannot be leaked around
with many small sells and just-bought tokens do not inherit an old
fraction. LATCH (mode 0) and LIVE (mode 1) are untouched — GRADUATED is
a new branch on the mode byte, nothing more.

## 2. Mechanism

### 2.1 The mode byte

Rule-1 params byte `[18]` (mode) gains value **2 = GRADUATED**:

| Value | Mode | Status |
|---|---|---|
| 0 | LATCH | existing, unchanged |
| 1 | LIVE | existing, unchanged |
| 2 | GRADUATED | **new in this spec** |

Config writes validate the mode byte `0..=2` (new write-time check;
previously only the gate read it). A config carrying any other value is
rejected at write, in the same fail-at-write discipline as rules 7/8/17.

### 2.2 The earned fraction

At a graduated evaluation for a holder, with `basis` = the holder's
**current** blended basis and `latched` = the holder's persisted latch
flag:

```
frac_bps = 10000                                if latched
         = max(base_frac_bps, time_frac, dip_frac)   otherwise
```

- **Time fraction.** `elapsed = max(0, now − anchor)`, where `anchor`
  is the holder's balance-weighted position-start timestamp (see §3 —
  it blends on receives exactly like basis does):

  ```
  time_frac = min(10000, elapsed_secs × 10000 / vesting_secs)
  ```

- **Dip fraction.** `min_price` is the minimum feed EMA this holder has
  observed at their own transfer evaluations since position entry
  (§4):

  ```
  drawdown_bps = (basis − min_price) × 10000 / basis   if min_price < basis
               = 0                                      otherwise
  dip_frac     = min(10000, drawdown_bps × dip_mult_bps / 10000)
  ```

  All arithmetic is checked integer arithmetic in the engine's existing
  fixed-point price scale; overflow fails closed (`MathOverflow`, 11),
  never wraps.

### 2.3 The classic latch still fires

GRADUATED does not replace the latch — it contains it. At a sender-gate
evaluation with `EMA < basis`, `latched` is set and persisted in the
Holder PDA exactly as in LATCH mode, and from that evaluation on the
fraction is 100% permanently. A holder who endures the full dip below
basis is fully unlocked forever, at any later price, including profit —
identical semantics to mode 0. LATCH is the limit case of GRADUATED
where the earned fraction is 0 until the latch and 100% after it.

### 2.4 Anti-leak: the ratcheted cap

A fraction alone leaks: sell the earned slice, and a naive
fraction-of-current-balance check hands out a fresh slice of the
remainder, forever. GRADUATED therefore carries its accounting in
**raw units**, in three extended fields (§6): `peak` (the largest
position size the current position has reached), `sold` (raw units
transferred out of the current position), and `cap` (raw units the
holder has earned the right to sell).

At **every** graduated evaluation — sender gate **and** recipient
bookkeeping:

```
cap = max(cap, frac_bps × peak / 10000)
```

A sender transfer then passes iff:

```
sold + amount ≤ cap
```

else it is vetoed with the new error **`PartialLocked` (25)** — the
next free code after `WrongEcosystem` (24). On a pass, `sold += amount`
(§3). Consequences, by construction:

- **Earned sellable never decreases.** `cap` only ratchets up. A price
  recovery, a basis change, or the passage of a bad week cannot un-earn
  what was earned.
- **No one-click out.** Until the fraction reaches 100% (latch, full
  vest, or full dip-earning), no single transfer — and no sequence of
  transfers — can move more than `cap − sold`.
- **No many-small-sells leak.** `sold` accumulates against the one cap;
  splitting a transfer changes nothing.
- **Just-bought tokens do not inherit an old fraction.** The cap is
  computed over **peak** balance, and `sold` counts against it. Buying
  more raises `peak` (and so can raise the cap by the *current*
  fraction of the new peak) — it never re-bases `sold` to zero or
  applies a previously higher fraction retroactively.

Exempt sources/destinations (pool vaults et al.) skip the graduated
path exactly as they skip the existing gate and bookkeeping. The
pool/venue side is never gated (§7).

## 3. Accounting — position lifecycle

The graduated fields describe **one open position** per holder. A
position opens on a receive into a zero balance and closes on a full
exit. Basis and `latched` are **not** graduated fields: they keep their
existing semantics throughout, including across a close.

| Event | Graduated accounting |
|---|---|
| **Fresh position** — receive into zero balance | `anchor = now`; `peak = post-transfer balance`; `sold = 0`; `cap` ratchets from the entry fraction (§2.4, evaluated at this receive); `min_price = EMA` |
| **Receive while holding** | `anchor` blends balance-weighted against post-transfer balances — the same formula shape as basis blending: `new_anchor = (old_bal × old_anchor + amount × now) / post_bal`; `peak = max(peak, post-transfer balance)`; `sold` unchanged; `min_price = min(min_price, EMA)` |
| **Sell** (sender transfer that passes the gate) | `basis` / `anchor` / `peak` unchanged; `min_price` updated (§4); `sold += amount` |
| **Full exit** — source post-transfer balance == 0 | After the gate check: the graduated fields (`peak` / `sold` / `cap` / `anchor` / `min_price`) reset to 0 — the position is closed. Basis / `latched` records keep existing semantics (a later re-entry blends/carries exactly as mode 0 does today) |
| **Wallet-to-wallet receive** | **Vesting never transfers.** The recipient's `anchor` / `peak` are their own: basis carries from the sender (existing rule-1 bookkeeping, unchanged), time-in-position does not. A recipient holding nothing opens a fresh position per row 1; a recipient already holding blends per row 2 — with *their* anchor, never the sender's |
| **Self-transfer** | Skipped entirely by the graduated path — not an exit, not a receive, no field moves. Max Wallet precedent: the engine already treats `src_holder == dst_holder` as a no-op for bookkeeping |
| **Migrated legacy holder** (`anchor` unset — see §6) | Lazily opens their position at their first graduated evaluation: `anchor = now`, `min_price = EMA`, `peak = current position size`. No retroactive time or dip credit: the engine cannot reconstruct observations it never made (§4), and pretending otherwise would hand out unearned fraction |

Worked lifecycle, briefly: buy 1,000 at t₀ → `anchor = t₀`,
`peak = 1,000`, `sold = 0`, `cap` = entry fraction × 1,000. Five days
pass with no dip → `time_frac = 10000`, next evaluation ratchets
`cap = 1,000`; the whole position is sellable. Or: at day 1
(`time_frac = 2000`) the price halves and the holder is evaluated →
`dip_frac = 10000` (§5 table), `cap = 1,000` — fully earned by the dip
long before the vest completes. Or: sell 150 of the day-1 pre-dip cap
of 200 (`sold = 150`, 50 of headroom left); a further 100 transfer is
vetoed `PartialLocked` until time or a dip ratchets the cap past 250.

## 4. Observation points — stated precisely

`min_price` updates **only** at transfer evaluations involving that
holder: the sender gate and recipient bookkeeping. Nothing else touches
it.

- **Price cranks never touch holder state.** Holder PDAs are not
  enumerable — there is no instruction that could walk every holder on
  a crank, and GRADUATED does not invent one. The crank's job is
  unchanged: it maintains the feed EMA that evaluations read.
- **A dip that starts and ends entirely between a holder's transfers
  is invisible to that holder.** Their `min_price` never saw it, so it
  earns no dip fraction from it. This is the same limitation the
  classic latch has today — a dip between a holder's evaluations does
  not fire their latch either — and GRADUATED inherits it honestly
  rather than papering over it with feed-side history the holder never
  experienced.
- The stale-feed fail-closed check is inherited unchanged: a graduated
  evaluation on a stale feed vetoes (`StalePrice`, 16) before any
  fraction is computed, and a sender with no basis record vetoes
  (`BasisMissing`, 17), exactly as in modes 0/1.

## 5. Params

Rule-1 params are 64 B. Bytes `[19..64]` were unused before this spec.

| Bytes | Field | Default when 0 | Notes |
|---|---|---|---|
| `[0..8]` | `max_stale_secs` u64 | 300 | existing |
| `[8..16]` | `ema_half_life_secs` u64 | — | existing, crank-side |
| `[16..18]` | `max_crank_bps` u16 | 10000 in crank | existing |
| `[18]` | `mode` u8: 0 LATCH, 1 LIVE, 2 GRADUATED | — | write-time validated `0..=2` (new) |
| `[19..21]` | `base_frac_bps` u16 | the param itself — no substitution; **0 is valid** and means no base | write-validated ≤ 10000 |
| `[21..29]` | `vesting_secs` u64 | 0 → **432,000 (5 days)** | full time-vest at 5 days = 20%/day |
| `[29..31]` | `dip_mult_bps` u16 | 0 → **20,000 (2×)** | 50% drawdown ⇒ 100% dip-earned |
| `[31..64]` | reserved | — | must stay zero at write until assigned |

**GREGORY TUNING CALLS** — flagged as his, set to the approved values,
changeable per-launch at config write without a program change:

- **Vesting: 5 days** (`vesting_secs` default 432,000).
- **Dip multiplier: 2×** (`dip_mult_bps` default 20,000).
- **Base fraction: 0** (`base_frac_bps` — no free slice at entry; every
  unit of sellable is earned by time or by dip).

**Dip alternatives, documented so the call is legible:** with
`dip_mult_bps = 10,000` (1×), the dip fraction *equals* the drawdown —
endure a 50% dip, earn 50%. The chosen 20,000 (2×) doubles it, so
enduring a halving fully earns the exit: a holder who sat through −50%
has, by any honest accounting, paid for their liquidity.

Worked examples at the default 2× (before the `min(10000, …)` cap and
before `max()` against time/base):

| Drawdown vs own basis | `drawdown_bps` | `dip_frac` at 2× |
|---|---|---|
| 10% | 1,000 | **20%** |
| 25% | 2,500 | **50%** |
| 50% | 5,000 | **100%** |

## 6. State layout — the extended Holder region

### 6.1 Why an extension, not a reclaim

The graduated state needs **48 B** of new fields:

| Field | Size |
|---|---|
| `grad_peak` u64 | 8 B |
| `grad_sold` u64 | 8 B |
| `grad_cap` u64 | 8 B |
| `grad_anchor` i64 | 8 B |
| `grad_min_price` u128 | 16 B |
| **Total** | **48 B** |

The legacy 136 B Holder layout has **no contiguous 48 B** to give.
Its two candidate regions are spoken for by other workstreams and are
**not reclaimed** by this spec: the dump-window region `[55..71]`
(`dump_window_start` / `dump_sold_in_window`, rule 11's future home)
and the reward region `[71..103]` (`reward_debt` /
`reward_settled_index`, Distributor lazy settlement). The
`custom [103..135]` scratch is likewise namespaced per-rule (rule 8
already occupies part of it) and is the wrong home for permanent
rule-1 accounting. Squeezing graduated state into borrowed bytes would
couple three workstreams to one layout — the extension avoids that
entirely.

### 6.2 The decision

`HOLDER_SPACE` **stays 136** — it names the legacy layout length, and
every existing read keeps it as its minimum. An **extended region is
appended** after it:

| Offset | Field |
|---|---|
| `[136..144]` | `grad_peak` u64 |
| `[144..152]` | `grad_sold` u64 |
| `[152..160]` | `grad_cap` u64 |
| `[160..168]` | `grad_anchor` i64 |
| `[168..184]` | `grad_min_price` u128 |
| `[184..192]` | reserved |
| | **Extended length: 192** |

**`ENGINE_VERSION` stays 2.** Rationale: the version byte versions the
**Config** layout, which this spec does not touch — bumping it would
make the new binary reject AGTR's live v2 config (`BadConfig`) and
orphan a live token for a change that has nothing to do with configs.
The Holder layout is instead **length-versioned**: all pre-existing
reads accept length ≥ 136 (they already check `len < HOLDER_SPACE`,
never equality); only graduated code requires ≥ 192, and only after the
migration in §6.3. A 136 B holder read by graduated code before
migration is a bug the migration ordering prevents, not a state the
gate tolerates silently.

### 6.3 Lazy migration

A legacy 136 B holder account touched by a GRADUATED evaluation is
**grown in place**, in this order:

1. **Rent top-up** transferred from the mint's rent vault:
   `(192 − 136) × 6,960 = 389,760 lamports ≈ 0.00039 SOL` per holder.
   Vault underfunded fails the transfer **explicitly** with the
   existing `RentVaultUnderfunded` (13) — the same loud failure as lazy
   holder creation today, never a silent skip.
2. **Realloc** the account to 192 B.
3. **Initialize** the extended region (zeroed, then the lazy position
   opening of §3: `anchor = now`, `min_price = EMA`, `peak = current
   position size`).

Discipline around migration:

- **Non-graduated configs NEVER migrate.** A token whose config has no
  enabled GRADUATED rule 1 never runs a graduated evaluation, so its
  holders are never grown. AGTR is Locked with rules 3 + 9: its holders
  stay 136 B forever, byte-identical behavior (§7).
- **Holder creation size:** 192 **only** when the config carries an
  enabled GRADUATED rule 1, else 136. Explicit `InitHolder` creates
  136; the first graduated touch grows it via the path above. (A holder
  created under a graduated config by the lazy destination path is born
  at the config's size directly — creation and migration converge on
  the same 192 B end state.)
- **Launcher budgeting note:** graduated launches should fund the rent
  vault with ~0.00039 SOL × expected holders of migration headroom.
  Holders created under the new binary under a graduated config are
  born 192 B; the delta applies to every holder either way — the vault
  is where it is paid from, so the vault is where it must be budgeted.

## 7. Liquidity rationale + regression guarantees

**Why graduated, in liquidity terms.** The classic latch can freeze
100% of float until a dip — Gregory's "stop and go" worry: nothing can
sell, then everything can, and the pool discovers both facts at once.
GRADUATED staggers sellable float instead:

- Every holder **continuously** earns sellable fraction with time — at
  the default tuning, 20% of peak per day — so sellable supply seeps
  in on a schedule anyone can compute, not on a price event nobody can
  schedule.
- Dips **accelerate everyone's earning simultaneously without a
  cliff**: a 25% drawdown moves every evaluated holder to ≥ 50%
  earned; there is no threshold price at which the float flips from
  frozen to free.
- **Nobody can one-click out** (§2.4): the maximum any holder can move
  is what they have earned, enforced in raw units.
- **The pool/venue side is never gated.** Sells that are allowed
  always execute; the hook rate-limits *per holder, by what they've
  earned* — it never halts the market. Liquidity is continuous, just
  rate-limited.

**Regression guarantees** (proven, not asserted — §9):

- **LATCH and LIVE modes: byte-identical behavior.** Mode 0/1 configs
  execute the existing code path; no graduated field is read or
  written, no holder is migrated.
- **AGTR-shape configs (rules 3 + 9): byte-identical.** No rule 1 at
  all — the graduated branch is unreachable.
- **The Ecosystem Gate (rule 17) is untouched** by this spec: no
  change to its params, mirror bytes, sync paths, or verdicts. Both
  changes ride one binary (§8) and are regression-proven against each
  other on that binary.

## 8. Packaging — one combined upgrade

Gregory's 2026-10-15 23:54 update: deploy go is given for the whole
wave, and mainnet takes **ONE combined upgrade, not two**:

| Component | Contents |
|---|---|
| **Engine** (one upgrade) | Rule 17 Ecosystem Gate (previously built at 186,392 B, undeployed) **and** the Graduated Latch mode (§§2–6), in a single binary |
| **Registry v2** | The attestation changes of SPEC-ECOSYSTEM-GATE §3 |
| **Distributor** | Untouched |

One engine upgrade means AGTR crosses exactly one binary boundary,
with both regression suites (§9) run against the exact binary that
ships. Program ids and upgrade authorities are unchanged (fren's
wallet, deliberately unburned). Sequence, costing, and live proofs for
the combined package follow the runbook shape of
SPEC-ECOSYSTEM-GATE §7, extended with the graduated live proofs (a
graduated test token: partial sell passes, over-cap sell vetoed
`PartialLocked`, AGTR buy/sell sanity on the new engine).

**No deploy happens in the build run.** Building, proving, and
packaging the combined upgrade is the deliverable of the build run;
the mainnet session is its own step.

### 8.1 TaxHarvest launch spec (packaged)

The first graduated token ships with the wave, specified here so the
launch is a execution of this document, not a new design:

| Item | Value |
|---|---|
| Token | TaxHarvest — **name/symbol still pending Gregory's pick** |
| Venue | Launched via the launcher on **Meteora DBC** |
| Rule stack | **[Rule 1 Basis Latch in GRADUATED mode, Rule 9 Max Wallet at 300 bps]** — rule 1 with the default tuning of §5 (base 0, vesting 5 days, dip multiplier 2×); rule 9 is a hard per-wallet cap of 3% of supply = **30,000,000 tokens** on the 1B supply (Gregory, 2026-10-16 00:03 — deliberately tighter than AGTR's 500 bps) |
| Authority mode | **Locked** |
| Bonding threshold | **42 SOL** (standard launcher curve) |
| DBC fee claimer | fren's wallet `FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP` — the deployer collects the 1% curve fee |
| Holder-fees routing (Distributor) | **OFF** for this token |
| Launch gate | **Gregory's SOL top-up to fren** — fren holds ~0.05 SOL; the launch does not proceed until the top-up lands. No other blocker |

## 9. Proof (LiteSVM, real binaries — house method)

Results (2026-10-15 run, all four suites against the ONE combined
binary — rule 17 + Graduated Latch in a single build):

| Suite | Result | Covers |
|---|---|---|
| `engine/trial-graduated.mjs` (new) | **90/90** | G1 time-vesting exact boundaries (0% at entry — a 1-raw-unit sell vetoes `PartialLocked`; 50% at vesting/2 sells exactly, +1 raw vetoes; 100% at duration end; full-exit zeroing of [136..192]); G2 dip-earned fractions at 10% / 25% / 50% drawdowns observed via recipient-side receives during the dip, boundaries computed exactly from read state (replica math), ≥99% earned after the 50% dip; G3 latch crossing during a dip ⇒ 100% permanent after recovery; G4 anti-leak (2,000 + 2,000 + 1,000 whole sells land exactly on the cap, the next raw unit vetoes atomically); G5 blended rebuy (basis 2e9, anchor exactly T0+300, peak/sold exact; veto at the blended 50% point, pass at 100%); G6 base fraction 1000 bps at entry; G7 lazy migration (crafted 136 B holder grown to 192 B on its first graduated evaluation with basis preserved, unfunded vault ⇒ `RentVaultUnderfunded` and no growth, LATCH-config holder never migrated); G8 write validation (mode 3 and base_frac 10001 rejected, nothing persisted) + graduated self-transfer skip |
| `engine/trial.mjs` (regression) | **64/64** | Full existing suite on the combined binary — modes 0/1 and rules 3/7/8/9 byte-identical |
| `integration/dbc-latch.mjs` (regression) | **55/55** | DBC launch-phase latch behavior on the combined binary, unchanged |
| `integration/ecosystem-gate.mjs` (regression) | **28/28** | Rule 17 on the **combined** binary — the two changes proven not to interfere |

Binaries: trial build (`REGISTRY_ID` = dev id) `engine/target/engine-trial.so`,
197,280 B, sha256 `bc93010376697d920d2c8e3534cc143f7fe0111ac71f36b6d78ce04a9c0cfc80`;
mainnet-const deploy build `engine/target/deploy/engine.so`, 197,280 B,
sha256 `b2bd27d2276acf293c6df8f22e0b30f8284c4b68cd90e6a23e91ce71be602269`
(the two differ only in the `REGISTRY_ID` const). **Not deployed** —
the combined upgrade package waits on §8's sequencing (and the
TaxHarvest launch on Gregory's name pick + SOL top-up).

## 10. The honest boundary

GRADUATED proves exactly one claim: **this holder may sell what their
own recorded history says they have earned — time held since their
blended position start, and drawdown observed at their own
evaluations, capped in raw units that only ratchet up.** It does not
observe prices between a holder's transfers (§4), it does not know
what a dip did to a holder who never transacted through it, and its
lazy opening for migrated holders (§3) deliberately grants no credit
for a past the engine never witnessed. Within those bounds the
accounting is exact and leak-proof by construction (§2.4); outside
them, this spec says so rather than rounding the claim up.

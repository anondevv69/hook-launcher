# FEE SCHEDULE — integration contract (rule 14, "Decay Tax")

**Program:** `KHb8ukdRqpUPeBJwS8gBxhiqMNowW3siUUDZSLYzGyb` (dev keypair,
`feeschedule-keypair.json`, chmod 600 — keep it. The
`target/deploy/feeschedule-keypair.json` file is an unused cargo-build-sbf
artifact with a different pubkey; the authoritative keypair is the one in
this directory, and the trial loads the binary under it explicitly.)
**Binary:** `target/deploy/feeschedule.so`, **105,688 bytes** (SBF v1,
`cargo build-sbf --arch v1`), sha256
`91e8e02e77ecef97459811e82636fa750fe05c3edcc4f9ad46ab9c0aa1b7f393`.
**Trial:** `trial-feeschedule.mjs`, LiteSVM, **52/52** (see §Trial).
**Status:** LOCAL BUILD ONLY — no mainnet deployment, no funds moved.

Spec: `SPEC-HOOK-LAUNCHER.md` §4.1 + rule 14;
`deploy/PLAN-CATALOG-AND-GRADUATION-2026-10-19.md` §2B rule 14 (settlement
layer — the fee extension is the one mechanism that survives DAMM
graduation).

## The honesty note (read first)

The catalog one-liner says the transfer-fee rate decays **with holder
age**. That form is **impossible on Solana**: the Token-2022 Transfer Fee
extension rate is **mint-wide** — one rate for everyone at any moment —
and a transfer hook is veto-only, so no program can charge holders
different rates by age. What this program builds is the honest buildable
form:

> **A mint-wide time schedule.** The rate starts at `start_bps` at
> schedule start (≈ launch) and decays **linearly** to `floor_bps` over
> `decay_secs`, for every holder equally:
> `rate(t) = start_bps − (start_bps − floor_bps) × min(elapsed, decay_secs) / decay_secs`
> (floor integer math; `elapsed = now − start_ts`, saturating).

The per-holder form (rate keyed to each Holder PDA's age) is **venue-side
only** — a house-venue swap can compute a per-trade tax at settlement —
and is **NOT built** here. Site/launcher copy for rule 14 must say
"decays over time since launch", never "decays the longer you hold".

## Mechanism

1. **Authority as a PDA.** At mint creation the mint's
   `transferFeeConfigAuthority` is set to a PDA of this program,
   seeds `["feeauth", mint]`. That PDA has no private key; only this
   program can sign as it, and this program signs only one thing:
   `SetTransferFee` at a rate derived from a stored schedule (below).
2. **InitSchedule (tag 0)** reads the rule-14 params out of the engine
   Config PDA (`["config", mint]` under the engine program
   `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT`), validates them and the
   mint (below), snapshots them into a Schedule PDA (`["sched", mint]`
   under this program) with `start_ts = Clock.unix_timestamp`, and
   records `last_applied_bps` = the mint's **current effective** bps
   (the epoch-effective fee entry, spl-token's `getEpochFee` rule).
   Init also fails closed if the mint's current rate sits outside
   `[floor_bps, start_bps]` — the crank can only lower a rate, so such a
   mint could never be scheduled honestly.
3. **Apply (tag 1) — the permissionless crank.** Any signer may call it;
   there is nothing to steal and no discretion to abuse. It recomputes
   the target **only** from the stored snapshot + Clock, range-checks it
   against `[floor_bps, start_bps]`, re-validates the stored schedule on
   every call (tampered state fails closed), and:
   - `target >= last_applied_bps` **or** `target ==` the mint's current
     effective bps → success no-op (no CPI);
   - otherwise it asserts `target <= last_applied_bps` immediately before
     the CPI (custom error `WouldRaise`, defensive/unreachable by
     construction) and CPIs Token-2022 `SetTransferFee`
     (TokenInstruction 26, sub-instruction 5; data
     `[26, 5, bps u16 LE, maximumFee u64 LE]`; accounts `[mint (w),
     feeauth PDA (signer)]`) via `invoke_signed` with the feeauth seeds.
   `maximumFee` is read from the mint's existing **newer** fee entry —
   the entry `SetTransferFee` overwrites — and re-passed verbatim. This
   program never changes `maximumFee` (in every launcher mint
   older == newer `maximumFee`: mint init sets both, and this program is
   the only fee writer).
   It then stores `last_applied_bps = target`, `last_apply_ts`,
   `apply_count += 1`.

**Snapshot semantics (deliberate):** Apply trusts the InitSchedule
snapshot, not the live engine config. A later engine `UpdateConfig` does
**not** retcon a running schedule; changing a token's decay means a new
schedule/mint story, surfaced by the launcher — the same posture as the
DBC graduation threshold living outside the engine.

### Epoch delay — Token-2022 semantics, measured

`SetTransferFee` does **not** change the rate holders pay immediately.
It writes the **newer** fee entry with `epoch = current_epoch + 2`; the
new rate takes effect only when the chain epoch reaches that entry
(spl-token 0.4.15, measured byte-by-byte in the trial, S4: Apply at
epoch 2 schedules 300 bps @ epoch 4; transfers still pay 500 bps at
epoch 2 and exactly 300 bps at epoch 4). Consequences for integrators:

- `last_applied_bps` tracks the latest **scheduled** rate; the
  **effective** rate at any moment is the epoch-effective entry.
- A production crank should run **ahead** of the schedule (the wall-clock
  target it sets will only bite ~2 epochs later). Calling Apply more
  often is safe: a second Apply before the epoch lands either no-ops or
  supersedes the pending newer entry with a still-lower target.
- Trial time-travel sets the LiteSVM Clock's epoch and unix timestamp
  independently to expose both halves of this behavior.

### Authority setup + rotation finding

- **Launcher path (preferred):** set `transferFeeConfigAuthority =
  ["feeauth", mint]` PDA directly in the `InitializeTransferFeeConfig`
  instruction at mint creation (the PDA is computable before the mint
  exists once the mint keypair is known).
- **Rotation works too (investigated, proven in LiteSVM against the
  pinned `@solana/spl-token` 0.4.15):** Token-2022 `SetAuthority` with
  authority type **4 = TransferFeeConfig** rotates the fee-config
  authority post-creation, signed by the then-current authority
  (`createSetAuthorityInstruction(mint, currentAuthority,
  AuthorityType.TransferFeeConfig, newAuthority, [], TOKEN_2022)`).
  Trial S2 proves the full path: a mint created with a plain keypair as
  fee authority fails InitSchedule with `NotFeeAuthority`; after the
  keypair signs the rotation to the feeauth PDA, InitSchedule succeeds
  for the same mint. A wrong-signer rotation attempt fails in the token
  program (`owner does not match`). So a launcher that created the mint
  before this program existed can still adopt the schedule — provided
  the current fee authority is available to sign once.

### Post-graduation (the point of riding the fee extension)

Graduation on Meteora revokes the transfer **hook**; the Transfer Fee
**extension** is untouched, so this program — which never touches the
hook — keeps working on a hook-free mint, and the Distributor's mode-0
harvest path keeps functioning with it. Trial S6 proves the composition
end-to-end on a mint carrying **only** TransferFeeConfig (no hook):
schedule init → decay to floor → fees accrue at the decayed 1% rate →
Distributor (trial binary, id `2kTYd7HzTtSBBwJW2yXBQ6Q2aLf49xrv1SqU7BN9ckoS`)
initialized in funding mode 0 with `withdraw_withheld_authority` = its
DistState PDA per `distributor/INTEGRATION.md` path (a) → permissionless
`distribute` folds exactly (index/cut/net mirror) → holder `claim` pays
exactly. Rule 14 + holder fee claims are graduation-proof by
construction.

## Accounts & layouts

**Schedule PDA** — seeds `["sched", mint]`, 128 B:
tag u8 @0 = 1; sched_bump @1; feeauth_bump @2; mint @4..36;
start_ts i64 @36; decay_secs u64 @44; start_bps u16 @52; floor_bps u16 @54;
last_applied_bps u16 @56; last_apply_ts i64 @58; apply_count u64 @66;
reserved @74..128. Rent-exempt ≈ (128 + 128) × 6,960 = **1,781,760
lamports**, paid by the InitSchedule payer.

**Fee-auth PDA** — seeds `["feeauth", mint]`. No account is created for
it; it exists only as the mint's fee-config authority address and as the
CPI signer. It is passed (readonly) as an account on Apply so the
runtime can hand it to `invoke_signed`.

**Engine Config PDA (read-only)** — seeds `["config", mint]` under the
engine id; layout byte-copied from `engine/src/lib.rs`: 1088 B, tag @0,
version @1 (= 2), rule_count @3, mint @4..36, rules @462 (68 B each:
rule_id u16 @+0, enabled u8 @+2, params[64] @+4). **Rule-14 params**
(coordinator-fixed): `[0..2] start_bps u16 LE (1..=10000)`,
`[2..4] floor_bps u16 LE (<= start_bps)`, `[4..12] decay_secs u64 LE
(> 0)`; the rest of the 64-byte block is zero and ignored here.
InitSchedule validates: config address == derived PDA, owner == engine
id, tag/version, config's mint field == mint, rule 14 present **and**
enabled, params in bounds.

**Mint TransferFeeConfig TLV (read-only)** — TLV starts at byte 166
(mints are padded to the 165-byte account base + type byte); extension
type 1, 108 B: config authority @0, withdraw authority @32,
withheld_amount u64 @64, older fee @72 (epoch u64 @72, maximum_fee u64
@80, bps u16 @88), newer fee @90 (epoch @90, maximum_fee @98, bps @106).
OptionalNonZeroPubkey fields (all-zero = None). Same verified facts as
`distributor/INTEGRATION.md`.

## Instructions (tag = data[0])

| Tag | Name | Data | Accounts | Semantics |
|---|---|---|---|---|
| 0 | InitSchedule | `[0]` | [payer (signer, w), mint, engine Config PDA, schedule PDA (w), system] | Validates config + rule 14 + mint fee authority == feeauth PDA + current rate in bounds; creates the Schedule PDA and snapshots params / start_ts / current bps. |
| 1 | Apply | `[1]` | [cranker (signer — anyone), mint (w), schedule PDA (w), feeauth PDA, Token-2022] | Permissionless decay crank. No-op when the target is not below `last_applied_bps` (or equals the mint's current effective bps); otherwise PDA-signed `SetTransferFee` at the computed target, `maximumFee` unchanged. Structurally incapable of raising the rate. |

## Errors (custom codes)

| Code | Name | Meaning |
|---|---|---|
| 1 | AlreadyInit | schedule PDA already exists |
| 2 | BadState | schedule account foreign-owned or corrupt |
| 3 | NoFeeConfig | mint carries no TransferFeeConfig extension |
| 4 | NotFeeAuthority | mint's fee-config authority is not the feeauth PDA (at init, or rotated away before an Apply) |
| 5 | BadConfig | engine Config PDA missing/corrupt/foreign/wrong mint |
| 6 | RuleNotEnabled | rule 14 absent or disabled in the engine config |
| 7 | BadParams | start/floor/decay outside `1..=10000 start`, `floor <= start`, `decay > 0` (config at init, or stored schedule at Apply) |
| 8 | OutOfBounds | a rate outside `[floor_bps, start_bps]` (mint's current rate at init; stored `last_applied_bps` or computed target at Apply) |
| 9 | WouldRaise | target > last_applied at the CPI gate (defensive; unreachable by construction) |
| 10 | MathOverflow | checked-math overflow |

PDA-address mismatches use `ProgramError::InvalidSeeds` (family idiom).

## Crank economics

Apply is permissionless and **costs only the cranker its own transaction
fee** (~5,000 lamports per signature on mainnet, plus compute well
inside a default budget — the CPI is one `SetTransferFee`). There is
**no caller cut in v1**: this program holds no funds and has no access
to the withheld fees (the mint's withdraw authority belongs to the
Distributor by design), so there is nothing on-program to pay a cut
from. The schedule is also forgiving about cadence — decay is a wall
clock function, so a late crank lands the exact current target, never a
stale one; nothing is lost by cranking daily instead of hourly, except
that each step change is quantized by when cranks happen (+ the ~2-epoch
token-side delay). **Fork flagged:** if production experience shows
third-party cranks don't materialize, the caller-incentive belongs in
the Distributor layer (its `distribute` already pays a `caller_cut_bps`
from harvested fees — a keeper folding "apply the decay, then
distribute" in one transaction earns that cut), not in this program.

## Trial coverage (`trial-feeschedule.mjs`, 52/52)

Realistic values throughout: 500 → 100 bps over 30 days, 6 decimals,
1,000,000-token supply, maximumFee 10^15 raw.

- **S1 (8)** — mint with fee authority = feeauth PDA; constructed
  engine-shaped Config PDA (1088 B, rule-14 params block byte-checked);
  InitSchedule snapshots (start_ts, params, bumps, last_applied = 500);
  second init → `AlreadyInit`.
- **S2 (8)** — init fails closed: config without rule 14 and with rule
  14 disabled → `RuleNotEnabled`; mint whose fee authority is a plain
  keypair → `NotFeeAuthority`; foreign-owned config → `BadConfig`.
  Then the rotation proof: `SetAuthority` type 4 rotates that same
  keypair-authority mint to the PDA and init succeeds.
- **S3 (3)** — transfers withhold exactly at start_bps (100k TOK → 5,000
  TOK; odd-amount ceil formula exact).
- **S4 (6)** — mid-decay (15 d): Apply called by an **unrelated
  third-party keypair**; scheduled newer entry = exactly 300 bps @
  epoch+2 with maximumFee unchanged; effective rate still 500 until the
  epoch lands, then exactly 300; transfers withhold exactly 3,000/100k.
- **S5 (6)** — past decay: floor 100 bps scheduled and effective;
  transfers withhold 1,000/100k; further Apply = successful no-op; clock
  warped **backwards** → Apply still no-ops and the rate does **not**
  rise.
- **S6 (14) — post-graduation scenario.** Hook-free fee mint (TLV scan:
  TransferFeeConfig only): full schedule flow to the floor; Distributor
  mode-0 init against it (withdraw authority = DistState PDA);
  fees accrue at the decayed 1%; `distribute` folds 3,000 TOK withheld
  with exact index/cut/net mirror, cranker cut received net of the
  payout fee; holder `claim` debits the vault by exactly the formula
  entitlement and the holder receives it (net + withheld).
- **S7 (7)** — forged schedule address → `InvalidSeeds`, rate unchanged;
  schedule PDA tampered in place (floor > start) → `BadParams`; tampered
  `last_applied_bps` = 9999 → `OutOfBounds`; rate unchanged in both;
  restored schedule Applies cleanly again.

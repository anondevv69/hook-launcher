# DBC × ENGINE INTEGRATION — verdicts

**Date:** 2026-10-15 · **Environment:** LiteSVM against the real binaries —
DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, cp-amm
`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`, ENGINE
`2A3kbQHsUpsnud5VSz3aszFDjhUychWK99NDWyKtSMDt` (the exact binary from the
26/26 engine trial). No mainnet, no mainnet SOL.

**Runs:** `integration/dbc-engine-integration.mjs` — **36 passed, 0 failed**
(3 consecutive runs) · `integration/dbc-graduation.mjs` — **22 passed,
0 failed**. Raw outputs: `integration/dbc-engine-integration-output.txt`,
`integration/dbc-graduation-output.txt`; machine-readable results alongside.

**Engine changes: NONE.** No redesign was needed; the engine binary is
untouched, so the BUILD-NOTES trial still stands at 26/26 and no re-trial
was required.

---

## Item 1 — Does DBC forward all six resolved extras? **PROVEN — yes, verbatim, literals included**

A DBC pool was created with the ENGINE as the mint's transfer hook
(`createConfigWithTransferHook` → `createPoolWithTransferHook`), the engine
was configured (Agent-Only + Max Wallet, DBC program id allowlisted as a
venue, pool authority + base vault exempt), the meta list initialized, the
rent vault funded — then buys ran through `swap2WithTransferHook`. The
built swap instruction carries 23 account keys; its **last 8 keys are
exactly**:

| # | account | writable | identity |
|---|---------|----------|----------|
| tail 0 | Config PDA | no | engine config for the mint |
| tail 1 | src Holder PDA | **yes** | holder of the pool authority (base vault owner) |
| tail 2 | dst Holder PDA | **yes** | holder of the buyer |
| tail 3 | rent vault PDA | **yes** | engine rent vault |
| tail 4 | **system program** | no | `11111111111111111111111111111111` — LITERAL, forwarded |
| tail 5 | **instructions sysvar** | no | `Sysvar1nstructions1111111111111111111111111` — LITERAL, forwarded |
| tail 6 | ENGINE program | no | appended by Token-2022's resolver |
| tail 7 | validation (meta-list) PDA | no | appended by Token-2022's resolver |

Mechanism (traced through SDK dist + `spl-token` + pinned dbc-program
source): the SDK resolves the mint's meta list via
`createTransferCheckedWithTransferHookInstruction`; `spl-token`'s
`addExtraAccountMetasForExecute` resolves PDA-seeded **and literal** metas
in meta-list order and appends them (plus hook program + validation) to the
TransferChecked it embeds; DBC's `parse_transfer_hook_accounts` forwards
the slice positionally with no filtering, and its swap CPI calls
`add_extra_accounts_for_execute_cpi`. Nothing is dropped or reordered.

**Caller validation works as-is.** Successful buys and sells produced no
`BadCaller`: the top-level instruction at the sysvar is DBC's swap, which
the engine accepts via its venue-allowlist branch (the engine's strict mode
confines the Token-2022-top-level path to sells, so the allowlist entry is
required — see Launch notes). Engine Execute consumed ≈ 33–46k CU on DBC
paths (veto path 45,631 CU in the unregistered-buy tx; total swap tx
≈ 150k CU of a ~790k budget).

**One integration finding (build-time, not on-chain):** the engine's
holder-PDA metas are seeded from `AccountData` — the *owner field of the
source/destination token accounts* — so the client-side resolver must READ
those accounts while *building* the swap transaction. A first-time buyer's
destination ATA does not exist yet at build time and resolution throws
`TokenTransferHookAccountDataNotFound`. **Launcher rule: create the
buyer's base ATA in a prior transaction (or confirm it exists) before
building the first swap.** ATA creation fires no hook (no transfer). This
step is part of the canonical sequence below (step L6) and applies to any
integrator using the standard resolver, not just DBC's SDK.

## Item 2 — Max Wallet balance semantics through a real curve buy — **PROVEN**

Same pool, cap = 9000 bps of the 1e15-raw supply:

- Two 0.05 SOL buys pass; a sell of 1,000 tokens into the exempt base vault
  passes (pool-side flows never self-block).
- Cap tightened by `UpdateConfig` to **20 bps** (= 2,000,000,000,000 raw).
  A fresh, registered buyer2 with a **zero pre-transfer balance** buys
  0.05 SOL → **vetoed atomically** with engine error `0x2`
  (`MaxWalletExceeded`); buyer2's balance stays 0.
- The engine's veto log line is the semantic proof:
  `engine: max wallet exceeded (3705647150730 of 1000000000000000 over 20 bps)`
  — the balance the engine observed *inside Execute during the vetoed
  transfer* is **3,705,647,150,730**, and when the cap is restored to
  9000 bps the identical buy delivers **exactly 3,705,647,150,730** to
  buyer2. The vetoed observation equals the delivered amount to the unit:
  on DBC, as in the engine trial, Token-2022 has already applied the
  transfer when Execute runs, and the engine's post-transfer read is the
  correct semantic. No engine change.

## Item 3 — Agent-Only through DBC — **PROVEN**

- Unregistered buyer, 0.05 SOL buy: the swap fails inside the DBC CPI with
  engine error `0x1` (`NotRegistered`; log `engine: not registered: <buyer>`
  — the named owner is exactly the buyer across runs). The buyer's
  lazily-created Holder PDA **rolls back with the transaction** (absent
  afterwards), the buyer receives nothing, no state leaks.
- After the stub `SetRegistered(buyer, 1)`: the same buy succeeds
  (0.05 SOL → 3,758,140,828,991 raw), the Holder PDA shows `registered = 1`,
  and no caller-validation rejection appears. The Registry program later
  replaces only the stub instruction's authorization path (BUILD-NOTES §5);
  nothing about the DBC path changes.

## Item 4 — Graduation characterization — **PROVEN (executable), with one design flag**

Fresh pool, migration threshold 1 SOL, engine attached with an empty rule
stack; buyer Holder PDA created and registered *before* graduation;
Config/Holder bytes snapshotted.

- **Completion mechanics:** an `ExactIn` buy that would overshoot the
  completion point fails `InsufficientLiquidity` (6033) — the completing
  swap must be `PartialFill`. The PartialFill buy (2 SOL offered) fills to
  the threshold and completes the curve **in that swap**.
- **Revocation:** inside the completing swap, DBC's `revoke_transfer_hook`
  (pool-authority signed) sets the mint's TransferHook extension to
  program = None **and** authority = None. Verified by parsing the mint's
  TLVs (mint accounts with extensions are padded to the 165-byte account
  size: account-type byte at 165, TLVs from 166; TransferHook value =
  `[authority, programId]`, both zero after completion; pre-completion
  they read authority = pool authority, program = ENGINE).
- **Engine state persists, inert:** post-graduation, the Config PDA
  (1,088 B) and the buyer's Holder PDA (136 B) are **byte-for-byte
  identical** to their pre-graduation snapshots and still owned by the
  ENGINE. They are simply never called again; nothing cleans them up and
  nothing needs to. (Their rent — ≈ 0.0085 + 0.0018 SOL per holder — stays
  locked in the PDAs; a launcher that cares can add a post-graduation
  close-out instruction later. Not required for correctness.)
- **Hook-free trading:** a plain `TransferChecked` with **zero** extra
  accounts succeeds post-graduation. The full migration then ran over the
  real cp-amm binary (see below) and a real `swap2` on the migrated DAMM v2
  pool succeeded: 0.001 SOL → 197,801,801,821 raw base out, no hook
  accounts involved. (Contrast METEORA-PROOF E4, where SDK-1.5.1-built
  swaps against an SDK-created pool hit the 6007 skew artifact; a pool
  created by the on-chain migration CPI swaps cleanly with the same SDK.)
- **Migration prerequisites observed:** (a) the DAMM v2 config is created
  through the operator-gated `create_config` — in LiteSVM an Operator PDA
  was injected as account state (standing in for a Meteora admin), and the
  real instruction + access control executed against it; on mainnet the
  launcher uses one of Meteora's published migration configs instead.
  (b) `flash_rent`: the DBC pool-authority PDA must already hold ~1 SOL —
  it lends lamports to the cp-amm CPI for position rents and the migration
  payer reimburses it; the test funded it 2 SOL to mirror mainnet's
  standing state. With the float at 0 the migration fails inside
  InitializePool (`insufficient lamports 0, need 2770080`).
  (c) `migration_metadata` is deprecated and unread in this program
  version; `migration_damm_v2_create_metadata` is a no-op. No pre-step.

### TransferFee — PROVEN on DAMM v2, but READ THE FLAG for DBC launches

Executable: a Token-2022 mint carrying a 100 bps TransferFee extension
withholds on transfer (10,000 → 9,900 received) and **creates a DAMM v2
pool with no token badge** — `validate_mint`'s permissionless extension
list confirmed end-to-end (assertion D3). Source: DBC's revocation touches
only the TransferHook TLV, so a fee extension is never stripped by
graduation.

**⚠ Design flag for the Distributor workstream:** the composition "launch
on DBC with a TransferFee, graduate, keep accruing holder fees from the
transfer fee" is **not available**. DBC creates its base mints with a
fixed extension set — `metadata_pointer` (+ `transfer_hook` for hook
pools) — and a mint's extensions are fixed at creation. A DBC-launched
base token can therefore never carry a TransferFee extension, before or
after graduation. Consequences:

- For **DBC-launched** tokens, post-graduation "holders get the fees" must
  be funded from **DAMM v2 pool-fee mechanics** (pool fee shares /
  position-based claims), not from a token transfer fee.
- The **TransferFee + Distributor** path remains valid for mints we create
  ourselves — i.e. the house venue (TH model), or a DAMM v2 pool created
  directly (D3 above) without the DBC curve phase.

## Canonical launch sequence (executable)

`integration/dbc-engine-integration.mjs` (v1) and
`integration/dbc-engine-integration-v2.mjs` (v2, current) are the canonical
sequence; they run the whole flow against the real binaries and assert
each step:

1. `createConfigWithTransferHook(engine)` — DBC config naming the ENGINE.
2. `createPoolWithTransferHook(engine)` — pool + base mint (hook = ENGINE;
   hook authority moves to the DBC pool authority).
3. ENGINE `InitializeConfig` — rules, authority mode, **venue allowlist
   must contain the DBC program id**, exemptions must contain the pool
   authority PDA and the pool's base vault (pool-side flows stay
   unobstructed).
4. ENGINE `InitializeExtraAccountMetas` — the fixed superset list
   (tail v2: 7 extras, incl. the PriceFeed PDA).
5. ENGINE `InitializePriceFeed` — pin the DBC pool + its base/quote
   vaults (token_dec read from the mint; quote_dec 9 for SOL).
   Structurally, Execute only checks the feed PDA's *key* until rule 1 is
   active, but the canonical sequence always initializes the feed at
   launch so rule 1 can be enabled later without a gap. **If rule 1 is
   enabled, also land the first `CrankPriceDbc` before the first buy** —
   buys record basis from the feed EMA, and an uncranked feed is 0.
6. Fund the rent-vault PDA (≈ 0.001837 SOL × expected holder count).
7. **Per buyer, before their first swap build: ensure their base ATA
   exists** (Item 1 finding — build-time resolution reads it).
8. Trade via `swap2WithTransferHook` only; plain `swap`/`swap2` reject
   hook pools.
9. Graduation (when the curve completes): hook is revoked inside the
   completing swap (use `PartialFill` for the completing buy); engine PDAs
   persist inert; migrate with `migrateToDammV2` using a Meteora migration
   config, with ~1 SOL standing on the pool-authority PDA for flash rent.
   Full lifecycle script: `integration/dbc-graduation.mjs`.

## Deviations, blockers, notes

- **No deviations from the engine design.** The two literal metas — the
  mission's critical unknown — arrive exactly as the engine expects; the
  sysvar-based caller validation needs no DBC-specific redesign.
- **No blockers.** All four mission items are PROVEN with run output; the
  only source-only components are the ones already settled in
  METEORA-PROOF (badge administration on mainnet) plus the two process
  notes above (Operator-gated config creation is Meteora-admin territory
  on mainnet; production migrations use their published configs).
- Sequencing rule reconfirmed: the first buy must not be bundled into pool
  creation (the meta list does not exist yet); engine init instructions
  are payer-agnostic, so the DBC pool-authority handover does not disturb
  them.
- Execute CU on DBC ≈ 33–46k — comfortably inside swap budgets.

---

## ENGINE V2 RE-RUN + DBC CRANK + END-TO-END LATCH (2026-10-15, later)

The v1 verdicts above were proven against engine v1 (6 extras, no price
feed). Engine v2 (wave 1) changed the tail — a seventh extra (PriceFeed
PDA) — and added the module set; the wave-1 notes therefore required this
re-proof. A follow-up hardening pass then added the DBC crank
(`CrankPriceDbc`, engine tag 8) and the flagship latch proof. Engine
binary for everything below: 184,264 bytes (tail/layout/version unchanged
from wave 1 — ENGINE_VERSION still 2). No mainnet, no mainnet SOL.

**Runs:** `integration/dbc-engine-integration-v2.mjs` — **42 passed,
0 failed** · `integration/dbc-latch.mjs` — **55 passed, 0 failed** ·
`integration/dbc-graduation.mjs` re-run against the v2 binary —
**22 passed, 0 failed** · engine suite `trial.mjs` — **64 passed,
0 failed**. Raw outputs alongside the scripts.

### Item 1 (v2) — extras forwarding: **PROVEN — all seven, verbatim**

Same pool shape as the v1 run (Agent-Only + Max Wallet, DBC allowlisted,
pool exempt), launched in the v2 canonical order (config → metas →
**InitializePriceFeed** → rent vault → ATAs). The built swap instruction
carries **24 keys** (v1: 23); its **last 9 keys are exactly**:

| # | account | writable | identity |
|---|---------|----------|----------|
| tail 0 | Config PDA | no | engine config for the mint |
| tail 1 | src Holder PDA | **yes** | holder of the pool authority |
| tail 2 | dst Holder PDA | **yes** | holder of the buyer |
| tail 3 | rent vault PDA | **yes** | engine rent vault |
| tail 4 | **PriceFeed PDA** | no | **new in tail v2 — seeded `["price", mint]`, forwarded verbatim** |
| tail 5 | **system program** | no | LITERAL, forwarded |
| tail 6 | **instructions sysvar** | no | LITERAL, forwarded |
| tail 7 | ENGINE program | no | appended by Token-2022's resolver |
| tail 8 | validation (meta-list) PDA | no | appended by Token-2022's resolver |

Execute now receives its full **12 accounts** on DBC swaps — asserted
from the engine's own log line (`accounts=12, venue=true`) on a live buy,
which also re-confirms caller validation via the venue-allowlist branch
(no `BadCaller`). Config version byte reads 2; meta list account is
261 bytes (tail v2 size).

### Items 2–3 (v2) — behavior carries over unchanged

- **Agent-Only:** unregistered buy fails inside the DBC CPI with engine
  error `0x1` (`NotRegistered`), lazily-created Holder PDA rolls back,
  nothing received. Registration now goes through **SyncRegistered
  path (a)** (tag 4's v2 form: config-authority signature, no registration
  account appended — the call is byte-identical to the v1 stub call, and
  the real Registry sync path (b) is covered by the engine suite's T8).
  The same buy then succeeds.
- **Max Wallet:** second buy passes at 9000 bps; cap tightened to 20 bps
  → a zero-balance buyer's buy vetoes atomically (`MaxWalletExceeded`,
  error `0x2`); restored cap → the identical buy delivers
  **3,705,647,150,730** raw — the same number the v1 veto observed,
  re-confirming post-transfer balance semantics on engine v2.
- Sell into the exempt base vault passes throughout.

### DBC PriceFeed crank (engine tag 8, `CrankPriceDbc`)

The vault-balance crank (tag 5) cannot price a bonding curve, so the
engine gained a pool-state crank: accounts `[config(ro), price_feed(w),
dbc_pool(ro)]`, permissionless like tag 5. It validates the pool
fail-closed (`PriceFeedBad`, custom 18): feed's pinned pool == the passed
account; pool owned by the DBC program; account length exactly 424 with
`base_mint` (@136) == the config mint; `sqrt_price` (@280) non-zero.

**On the "virtual reserves" naming:** the pinned DBC program stores no
`virtual_token_reserves` / `virtual_sol_reserves` fields (checked in the
program source and the SDK). PoolState's `base_reserve`/`quote_reserve`
are cumulative swap accounting — their ratio is an average fill level,
not the marginal price. The curve's implied virtual reserves at the
current point are L/√P and L·√P (active segment liquidity L), whose ratio
is exactly `sqrt_price² / 2^128` — the curve's own spot. The crank reads
`sqrt_price` and converts to the feed convention
(`quote per whole token × 1e12`, same decimal treatment as tag 5); the
EMA fold is the shared TH discipline (first crank takes spot; half-life
step; per-update clamp). Offsets were verified empirically against the
loaded binary (the latch trial asserts the pool account's layout and
every cranked EMA bit-exactly).

### Item 3 (mission) — END-TO-END BASIS LATCH ON DBC: **PROVEN (55/55)**

`integration/dbc-latch.mjs`: a fresh pool with engine config
`[Basis Latch]` (max_stale 300 s, half-life 0 → crank takes spot; pool
authority + base vault + an exempt market-maker wallet in exemptions —
the launcher ops-wallet pattern, which is how the price is moved both
ways, since an exempt source skips gate + bookkeeping):

1. **Crank #1** sets the feed EMA to the curve spot **exactly** (JS
   replica of the crank's integer steps, fed from the pool's sqrt_price
   bytes — asserted on every crank in the run, 6 cranks total).
2. Exempt MM buys 0.30 SOL (records **no** basis) → crank → buyer B buys
   0.05 SOL; B's Holder PDA basis == the cranked EMA **exactly**
   (13,687 — a scaled spot, asserted against the feed bytes).
3. Crank (EMA 13,782 ≥ basis) → B's sell **fails with engine `Locked`
   (custom 15)**, atomically: buyer balance, curve sqrt_price, latch
   byte, and basis all unchanged.
4. MM sells its whole bag → crank the dip (EMA 13,214 < basis 13,687) →
   B's sell **passes**, `latched = 1` persists in the Holder PDA, basis
   intact, balance reduced by exactly the sold amount.
5. MM buys 0.50 SOL → crank (EMA 14,152 > basis) → B's **latched sell at
   a profit passes**, latch persists.
6. Clock advanced 301 s past the last crank → B's sell **fails
   `StalePrice` (custom 16)**, even latched → DBC crank revives the feed
   → sell passes.
7. Crank fail-closed negatives: a non-pinned account, a non-DBC-owned
   account, and the vault passed as "pool" all reject; the pinned pool
   account with its `base_mint` field corrupted in place rejects with
   the malformed-state error; restoring the account byte-for-byte makes
   the crank succeed again. Failed cranks write nothing.

**Conclusion:** DBC launches are proven against engine **v2**, including
the flagship rule end-to-end. Remaining known DBC limitation is unchanged
from the engine notes: rule 8 (Holder-Gated) fails closed on DBC because
venue-built transfers carry no sync instruction.

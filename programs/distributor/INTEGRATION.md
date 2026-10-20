# DISTRIBUTOR — integration contract

**Program:** `2kTYd7HzTtSBBwJW2yXBQ6Q2aLf49xrv1SqU7BN9ckoS` (dev keypair, `distributor-keypair.json`)
**MAINNET (2026-10-15):** deployed as `DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa` (fresh keypair, same binary, on-chain ELF byte-exact; upgrade authority = fren, not burned). Genesis AGTR distributor initialized live in funding_mode 1. See `../deploy/DEPLOY-RECORD.md`.
**Binary:** `target/deploy/distributor.so`, **128,768 bytes** (SBF v1) → programdata rent-exempt ≈ **0.897 SOL** ((128,768 + 128) × 6,960 = 897,116,160 lamports). Built + proven 2026-10-15, LiteSVM trial **61/61** (`trial.mjs`, output `trial-output.txt`) — 36 assertions on funding path (a) + 25 on funding path (b), both below. No mainnet deployment.
**Per-account rent:** DistState PDA (176 B) = 2,115,840 lamports; Claim PDA (104 B) = 1,614,720 lamports.

Spec: `SPEC-HOOK-LAUNCHER.md` §4 (fee plumbing), §4.3 (holders get the fees).

## What the program is

An index-accounting fee distributor bound to ONE mint. Fees accumulate in a **vault** token account owned by the DistState PDA; a permissionless crank folds new fee amounts into a cumulative **index** (fees per token, SCALE 1e12); any holder's entitlement is `balance × (index − settled_index)`, paid by `claim()` (holder-signed) or `settle()` (permissionless). **The index/entitlement math is source-agnostic: it distributes whatever lands in the vault.** What differs by launch type is only how fees REACH the vault — the two funding paths below, selected at initialize as the state's **funding mode** (derived from the mint's extension set, so a mode can never disagree with what the mint can do).

## Accounts

**DistState PDA** — seeds `["dist", mint]`, 176 B: tag @0; mint @1; vault @33; admin @65; index u128 @97; total_harvested u64 @113 (mode-0 gross pulled from the mint; stays 0 in mode 1); total_distributed u64 @121 (net folded into the index, both modes); total_cuts u64 @129; caller_cut_bps u16 @137; bump @139; **funding_mode u8 @140** (0 = harvest, 1 = routed); created_slot @141; distribute_count @149; **total_paid_out u64 @157** (gross payouts debited from the vault, both tags); **total_routed_folded u64 @165** (gross routed principal folded).

**Claim PDA** — seeds `["claim", mint, holder]`, 104 B: tag @0; mint @1; holder @33; settled_index u128 @65; total_claimed u64 @81; last_claim_slot @89. Created lazily by claim/settle (payer = the claim/settle caller).

**Vault** — a token account of the bound mint whose **owner is the DistState PDA** (an ATA with the PDA as owner works). Only this program can move funds out of it (PDA-signed TransferChecked).

## Instructions (tag = data[0])

| Tag | Name | Data | Accounts | Semantics |
|---|---|---|---|---|
| 0 | Initialize | `[0][caller_cut_bps u16]` | [admin (signer, w), mint, vault, state PDA (w), system] | Binds mint + vault; validates vault is a token account of the mint owned by the state PDA. caller_cut_bps ≤ 10,000. Records the **funding mode** derived from the mint: TransferFeeConfig present → mode 0 (harvest); absent → mode 1 (routed). A present-but-malformed fee config still fails init (`BadState`); a missing one no longer does. |
| 1 | Distribute (crank) | `[1]` | [cranker (signer), mint (w), state (w), vault (w), cranker token account (w), Token-2022, …remaining = withheld-fee source accounts (w) — **mode 0 only**] | Permissionless. Fold amount = `W_harvested + U_routed`, where W is the mint's withheld total after harvest (**mode 0 only**; mode 1 skips the fee-config read, the authority gate, and both CPIs, and **rejects** any remaining accounts with `FundModeMismatch`, custom 10) and `U = vault_balance − (total_distributed − total_paid_out)` is the unfolded routed balance (exact by conservation; identically 0 in pure mode-0 operation, so mode-0 folds are unchanged). Pays the cranker `fold × caller_cut_bps / 10_000` (floor) from the vault — the cut applies to the **total** folded amount in both modes; advances index by `net × SCALE / eligible_supply`, eligible = total supply − post-fold vault balance. `total_routed_folded += U`. Fold = 0 = successful no-op (no index change, no cut, no count bump). All-or-nothing (CPIs roll back with the instruction). |
| 2 | Claim | `[2]` | [holder (signer, w), holder, holder token account (w), mint, state (w), vault (w), claim PDA (w), Token-2022, system] | Holder-signed payout of the full current entitlement. Zero entitlement = successful no-op. Every payout increments state `total_paid_out` by the gross entitlement (the vault debit) — distribute's routed accounting depends on it. |
| 3 | Settle | `[3]` | same as Claim, but accounts[0] is ANY signer (pays Claim-PDA rent if created) | Permissionless payout to the holder's own token account — funds can only ever land with the holder. This is the lazy-settlement surface (§"Engine/venue integration"). |

Payouts advance `settled_index` to the current index BEFORE transferring (CEI). Payout and cut transfers are plain TransferChecked from the vault, so **the mint's transfer fee applies to them too** when the mint carries one: the recipient nets `amount − fee`, and the withheld part recycles as future fees (path (a)). Trial assertions are conservation-exact with this included.

## Tag 4 hooked-mint extension — per-leg hook extras (2026-10-20)

Tag 4's split legs are transfers OUT of the vault to three different destinations, and transfer-hook extras are destination-specific, so the legacy single trailing tail cannot serve them. The extension extends tag 4's **data** (no new tag; tags 1/2/3 untouched):

- **Legacy (unchanged):** data = `[4]`. Trailing accounts exactly as before (mode 1: cut-transfer extras; mode 0: withheld-fee sources). Split legs are attempted with no extras.
- **Extended:** data = `[4, 1, tail_n, crown_n, seat_n, king_n]` — exactly 6 bytes. Accounts after the 13 core+split accounts are, in order: the **legacy tail** (`tail_n` accounts, same meaning as above — this is what keeps mode 1's cut extras unambiguous), then the **crown group** (`crown_n`), **seat group** (`seat_n`), **king group** (`king_n`). Each group is the hook-extra set resolved for source = vault ATA, authority = DistState PDA, destination = that leg's recipient token account (i.e. the accounts spl-token's `addExtraAccountMetasForExecute` appends after the 4 core TransferChecked keys, incl. the hook program and the ExtraAccountMetaList PDA). Group lengths vary with the mint's published meta list (a subset stack resolves shorter); a **0-length group** = leg attempted bare. Writability follows the resolved metas (config/feed/engine/meta-list read-only; source/dest Holder PDAs, rent vault, and the King PDA when listed, writable).
- **Validation:** the four counts must sum EXACTLY to the trailing account count; any other data length, a version byte ≠ 1, or a sum mismatch hard-errors `InvalidInstructionData` BEFORE any harvest CPI or transfer — malformed clients fail atomically with no partial state. In **mode 0** the groups follow the `tail_n` withheld-fee source accounts the same way; the mode-0 cut transfer itself still carries no extras (its tail slot is the fee sources).
- **Proven in LiteSVM** (`trial-splits-hooked.mjs`, 26/26; real engine + real Crown binaries, rules [3, 9, 5, 6, 15]): a clean hooked split distribution pays all legs exactly, the king leg's hook execution is visible in the engine King PDA (balance 60,000 → 60,396 TOK), and a validation-skipped leg's share folds into the index with the identity `vault == total_distributed − total_paid_out` exact.

**LIMITATION (proven, not assumed): there is no transfer-stage fail-open on Solana.** A failed CPI is always fatal to the instruction — matching on `invoke_signed`'s `Result` does not recover (proven at two depths: engine Agent-Only veto `custom 0x1` "not registered" and a Token-level frozen-recipient failure `custom 0x11` each aborted the distributor with the callee's error). A split leg the hook vetoes therefore **reverts the whole tag-4 instruction atomically** — no leg pays, no state moves, the fold can be retried. The fail-open surface is the **validation stage only**: clients on hooked mints must skip legs they know the hook will veto by passing sentinel slots (+ a 0-length group) for them; the skipped share folds into the index exactly as before.

**First-touch rule (load-bearing):** a Claim PDA created for a holder whose balance is **> 0** starts at `settled_index = 0` (full history on the current balance — correct for holders present since before the first distribute). A Claim PDA created at balance **== 0** (the venue's pre-receive settle) starts at the **current index**, so that wallet earns only later distributions. Integrators MUST settle a destination before its first receive, or that wallet's first later claim reaches back over index growth it never held through (bounded windfall; the trial's payer/D cases show the intended full-history behavior for day-one holders).

**Settle-before-send discipline:** entitlement lives on the holder's record, NOT on the tokens. Sending tokens without settling first strands the accrual on the moved amount in the vault (it remains as solvency surplus; it is not re-spread). The trial measured this exactly in T10: 99,353,081 raw stranded across two unsettled sends (94,858,031 from one 10,000-token send whose destination had been pre-settled). Venues/skill must settle the source before a transfer out and the destination before a receive.

## Funding path (a) — Transfer Fee harvest (self-minted tokens) — BUILT + TRIALED

For mints the launcher creates itself (house venue, or direct DAMM v2 pool creation — the DBC workstream proved TransferFee passes DAMM v2 `validate_mint` badge-free):

1. Create the mint with the **Transfer Fee extension**; set the fee config's **withdraw_withheld_authority = the DistState PDA** (computable before the distributor is initialized). Fee bps/max are the launcher's choice (keep them mirrored in the engine Config's fee fields).
2. Create the vault ATA owned by the state PDA; call Initialize.
3. Anyone cranks `distribute` passing, as remaining accounts, token accounts holding withheld fees (venue vaults, active holder accounts — any subset; partial harvests are fine). The program CPIs `HarvestWithheldTokensToMint`, reads the mint's withheld total W, CPIs `WithdrawWithheldTokensFromMint` (PDA-signed) into the vault, pays the cut, folds `net = W − cut`.

**On-chain layout facts any other fee-mint reader must reuse** (verified byte-by-byte in LiteSVM, both encoded in the program's `parse_fee_config`): extension mints are padded to the 165-byte account base, so **TLV data starts at byte 166**; TransferFeeConfig data is 108 bytes of `OptionalNonZeroPubkey` fields (all-zero = None) — config authority @0, **withdraw authority @32, withheld_amount u64 @64**; TransferFee sub-instruction discriminants are **WithdrawFromMint = 2, WithdrawFromAccounts = 3, HarvestToMint = 4** (enum order, cross-checked against @solana/spl-token 0.4.15).

## Funding path (b) — fee-claimer routing (DBC-launched tokens) — BUILT + TRIALED (mode 1)

**Constraint (proven by the DBC integration workstream):** DBC creates base mints with a FIXED extension set (metadata_pointer + transfer_hook only). **A DBC-launched token can never carry a TransferFee extension**, so path (a) does not exist for it. Its fee flows are:

- **Curve phase:** DBC trading fees accrue to the DBC config's `fee_claimer`. The launcher operates the configs, so `fee_claimer` = a launcher-controlled wallet.
- **Post-graduation:** the token migrates to a DAMM v2 pool; ongoing fees are **LP-position fees**, claimable by the position owner (the launcher, for launcher-held positions).

**How mode 1 works (on-program):** the distributor initializes against the fee-less mint (funding_mode = 1). `distribute` takes **no** remaining accounts, performs no harvest/withdraw CPI and no withdraw-authority check, and folds the routed balance `U = vault_balance − (total_distributed − total_paid_out)` — the tokens that arrived by plain transfer and have not been folded yet. The identity is exact by conservation (every vault flow is counter-tracked: withdraws/cuts/payouts/folds), so a second routed deposit folds **only its own delta**, residual backing is never re-folded, and nothing strands. The crank cut applies to the total folded amount, same as mode 0. Payouts are in the bound mint and — the mint being fee-less — recipients net the full entitlement. Mixed operation is also exact: a mode-0 distributor folds `W + U`, so plain transfers into a harvest-mode vault are distributed too rather than acting as inert backing.

**Routing contract (integrator duties — off-program, the launcher/keeper does this):** on a cadence, the fee_claimer must
1. claim curve fees / LP fees;
2. deliver them **denominated in the launched token** into the distributor vault — where fees are already token-denominated they transfer directly; where fees accrue in the quote currency, the keeper **converts (market buy of the launched token) before transfer**. This step is mandatory, not optional: the **same-mint binding** (`state.mint` == vault mint == holder-account mint, validated in every instruction) means payouts are denominated in the bound mint, pro-rata to balances OF the bound mint, and quote-currency fees cannot be distributed raw. A cross-mint variant (hold X, paid in Y) would be a different program shape and is NOT specced here;
3. leave folding to any cranker calling `distribute` (no remaining accounts), earning the caller cut.

Holders then claim/settle exactly as in path (a) — during the curve phase AND after graduation, since the vault + index never depended on the hook.

## Engine / venue integration (lazy settlement)

**Ownership decision: the Distributor owns ALL reward state** (DistState + Claim PDAs). The engine Holder PDA's `reward_debt` / `reward_settled_index` fields (offsets 71/87) stay **reserved and unused**: a program cannot write another program's accounts, and an engine-CPI settle during Execute would require distributor accounts in the hook's fixed meta tail (a meta-list v2 — possible later, not needed for v1). This costs the engine nothing; its reserved bytes remain available if that variant is ever built.

**v1 integration (no engine change):** transaction builders (venue, trade page, skill) place `settle` instructions for the **source and destination immediately BEFORE the transfer instruction in the same transaction**. Settlement pays out on pre-transfer balances and advances `settled_index`; the following transfer's tokens then accrue from the current index. Atomic, and the same discipline as the settle-before-send rule above. Post-graduation (hook revoked), claim/settle keep working unchanged — the fee extension (path (a)) and vault routing (path (b)) both survive the hook.

**Mock-engine CPI trial:** not built (mission-scoped as bonus). The settle account shape is CPI-compatible as-is: accounts[0] is a fee-paying signer (a calling program would sign with its own PDA seeds), and no other signer is required.

## Rounding, dust, solvency (measured, trial T2/T7/T10)

- `index_delta` and entitlements floor at every step; the crank cut floors. Rounding remainder stays in the vault forever as unclaimable dust (measured: **47,309 raw** of spread/floor remainder after 4 distributes and a complete claim-out on a 1,000,000-token supply at 6 decimals).
- Solvency is by construction: index increments are calibrated to eligible supply, so Σ entitlements ≤ Σ net folded; the `Insolvent` error (custom 8) is a defensive unreachable. Stranded accrual (§settle-before-send) only adds surplus.
- Index uses u128 throughout (SCALE 1e12); `MathOverflow` (custom 9) guards the multiplications.

## Trial coverage (`trial.mjs`, 61/61)

**Path (a) — 36 assertions (T1–T10), unchanged against the mode-aware binary.** Setup on a real TransferFee mint (1% fee, 6 decimals, 1M supply): withheld accrual read by independent TLV oracles; distribute #1 harvests two sources with exact state/index/cut/vault assertions (cranker cut received gross, net of the fee on the cut transfer); pro-rata claims for two holders to the unit; double-claim pays 0; permissionless settle pays a third party's entitlement exactly; second distribute + delta-only claim; zero-harvest distribute is a no-op; odd-amount (1,000,001 raw) dust distribute matches the mirror to the unit; first-touch rule proven both branches (zero-balance settle starts at current index and earns only the next distribute; positive-balance first touch reaches full history); wrong-signer claim rejected; claim-everything finale decomposes the residual into stranded accrual (exact) + bounded remainder.

**Path (b) — 25 assertions (T11–T12).** Setup on a fee-LESS Token-2022 mint (no extensions, 6 decimals, 1M supply): initialize succeeds and records funding_mode 1 (mode-0 state cross-reads funding_mode 0, and the conservation identity `total_distributed − total_paid_out == vault balance` is asserted on the mode-0 mint after its full T1–T10 life); fee-less transfers land exact; a routed deposit of 9,000 TOK (plain transfer into the vault) folds with a 90-TOK crank cut received exactly (no fee haircut on a fee-less mint) and `total_harvested` stays 0; passing fee-source accounts to a mode-1 distribute fails with `FundModeMismatch`; two holders claim/settle pro-rata to the unit with `total_paid_out` tracking every payout; a second routed deposit (500 TOK) folds **only** the new delta (`total_routed_folded` 9,500 TOK lifetime); a zero-fold distribute is a no-op (nothing double-folds); the claim-everything finale pays every actor's formula amount exactly and the residual satisfies the identity `vault == total_distributed − total_paid_out` to the unit, decomposing as eligible-spread + floors only (4,450,103 raw ≈ 4.45 TOK; stranded accrual 0 — no unsettled sends occur in the scenario).

# Distributor fix — forward transfer-hook extra accounts in payout CPIs

**Status:** SPEC ONLY — not implemented. Found 2026-10-16 during AGTR's
first real holder-fee routing cycle (proof record:
`../deploy/FEE-CYCLE-PROOF-AGTR.md`). Needs a program upgrade of the
deployed Distributor (`DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa`,
upgrade authority = the launcher wallet, retained) and a buffer float of
≈ 0.9 SOL (rent for the deploy buffer; fully recoverable on buffer
close — the permanent cost is transaction fees only).

## The bug

`cpi_vault_transfer` (distributor/src/lib.rs) builds a bare
`TransferChecked` CPI with exactly four accounts
`[vault, mint, dest, state_pda]`. For a mint carrying a **transfer
hook**, Token-2022 must execute the hook program during the transfer,
which requires the hook's extra accounts (the ExtraAccountMetaList
validation PDA + the resolved extras + the hook program account itself)
to be present **in the transfer instruction's account list**. A CPI-ing
program must supply them; the Distributor never does.

Consequence on every hooked mint (i.e. every launcher token):

- `Distribute` (tag 1) fails whenever the fold's caller cut is > 0
  (any fold ≥ 100 raw units at the default 100 bps cut) — the cut
  transfer is the first payout CPI it attempts. Tx fails atomically;
  the index never advances.
- `Claim` (tag 2) / `Settle` (tag 3) fail for any nonzero entitlement
  (zero-entitlement calls succeed — they skip the transfer — which is
  why bundled settles during swaps never exposed this).
- Plain transfers INTO the vault are unaffected (the claimer's own
  wallet signs those, and the client appends the extras), so routed
  fees accumulate safely in the vault, unfolded. The fold identity
  (`U = vault_balance − (total_distributed − total_paid_out)`) counts
  them exactly once whenever the fix ships. **No funds are at risk and
  no accounting is corrupted by the delay.**

Evidence (mainnet, 2026-10-16): distribute tx
`12GT2jemmkgghraDekDqzXoiH3zbzFm8PGzrMKquLgJTz97anXqgEn1m143XaijTiVaEtrXmgRG6YHxyzmApbWB`
— logs show Token-2022 invoking TransferChecked, then
`Unknown program EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT` (the
engine) and `failed: An account required by the instruction is missing`.

Why the trials missed it: the distributor suite (61/61) runs on a
hookless mint, and the DBC integration suites run swaps on hooked mints
but never a distributor payout. The composition was never exercised
until AGTR's first real cycle.

## The fix (program)

Thread trailing accounts through to the payout CPI:

- `cpi_vault_transfer` gains an `extras: &[AccountInfo]` parameter:
  append `AccountMeta`s for each extra after the four core metas, and
  include the infos in the `invoke_signed` set.
- `Distribute` (tag 1): in **mode 1** (routed), accounts `[6..]` are
  hook extras (mode 1 takes no fee sources — the FundModeMismatch check
  becomes mode-0-only). In mode 0, `[6..]` remain fee sources exactly
  as today; the mode-0 cut transfer passes no extras (mode-0 mints are
  self-minted; a hooked mode-0 mint stays unsupported, as it is today —
  its sources mechanism already occupies the trailing slots).
- `payout` (tags 2/3): accounts `[9..]` are hook extras for the
  entitlement transfer.
- No state-layout change, no instruction-format change when extras are
  absent: a caller that passes no extras gets byte-identical behavior
  on hookless mints (the existing 61/61 trial must pass unchanged).

Validation posture: forward verbatim, no distributor-side validation of
the extras beyond what exists. Token-2022 itself validates the
validation account against the mint's hook configuration (owner +
seeds), and the engine validates the resolved extras during Execute;
malformed extras simply fail the transfer. This is the standard
passthrough pattern for hook-composing programs.

## The fix (clients)

`hook.mjs` (and any other caller) must append the resolved extras for
the specific payout transfer whenever the mint is hooked:

- Distribute: extras for source = vault, dest = cranker's ATA,
  authority = state PDA — resolve with spl-token's
  `createTransferCheckedWithTransferHookInstruction` machinery (or
  `addExtraAccountMetasForExecute`) and append the resulting trailing
  accounts (validation PDA, resolved extras, hook program) after the
  six fixed keys.
- Claim/Settle: same, with dest = the holder's ATA.
- `claim-fees` already builds its crank instruction inline; update it
  and `crank-fees` / `claim` / the settle bundling in `doSwap`/`send`
  (settles only *need* extras when an entitlement is actually payable —
  appending unconditionally is simpler and harmless).

## Proof obligations for the fix

1. Distributor trial re-run: 61/61 unchanged (hookless path untouched).
2. New LiteSVM case: hooked mint (real engine binary + meta list) —
   route a deposit, distribute with extras, assert the fold lands and
   the cut arrives; settle/claim a nonzero entitlement with extras.
3. Mainnet: upgrade (buffer float ≈ 0.9 SOL, recovered on close), then
   AGTR's pending fold — 1,212,809.357987 AGTR already sitting in the
   vault from the 2026-10-16 cycle — lands with the first crank:
   expected index delta 1,202,124,632, total_distributed
   1,200,681.264408 AGTR, cut 12,128.093579 AGTR to the cranker
   (figures from the proof record; recompute at run time).

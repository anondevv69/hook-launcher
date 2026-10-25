# Proposal: S1 — Distributor settle-on-transfer fix (Design D)

- **ID:** `S1-distributor-settle-on-transfer`
- **Track:** security
- **Status:** in review
- **Proposer:** fren (AgentOnly operator agent) — wallet
  `FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP`
- **Date proposed:** 2026-10-23
- **Spec:** [`specs/SPEC-S1-DISTRIBUTOR-FIX.md`](../specs/SPEC-S1-DISTRIBUTOR-FIX.md)
- **Implementation PR:** —
- **Trial evidence:** the *defect* is reproduced by a passing LiteSVM
  exploit test (9/9 assertions in the operator's security
  investigation, 2026-10-23); the *fix* has not been implemented or
  trialed.

## The defect, stated exactly

In the Distributor's holder-fee accounting, a wallet-keyed Claim PDA
is created on first touch with `settled_index = 0` whenever the
wallet already holds a balance. Entitlement is then computed as
`balance × (index − settled_index)`, so a wallet whose first claim
follows a receive can claim fee-index growth from *before it held
anything* (pre-ownership accrual), a send → re-acquire cycle can
double-count the same index history, and aggregate obligations can
exceed what was actually folded in — at which point a legitimate
holder's claim can fail insolvent.

Live scope today: **AGTR is the only live holder-fee token**, and its
books balance exactly (totalDistributed − totalPaidOut = vault
balance, verified 2026-10-23). The exposure is a first-touch claim
from a large, still-unsettled position; it is not a discrepancy that
has occurred.

## The fix (Design D, summary)

Creation floor (`settled_index := index` at Claim PDA creation —
necessary but provably insufficient alone) **plus** MasterChef-style
`reward_debt` settle-on-transfer, written by the Engine into reserved
Holder-record bytes via a Distributor-signed CPI write-back (new
Engine tag 19). No account resizes, no new client instructions; the
transfer-hook meta list grows to 7 extras. Migration is a rehearsed
sequence (LiteSVM rehearsal gate → Engine upgrade → Distributor
upgrade, inert → arm → meta refresh → debt-mode flip → enumeration
snapshot), detailed in the spec.

One decision is explicitly open: Claim records with
`settled_index == 0` are on-chain-indistinguishable between legit
day-1 holders and windfall claimants. The spec recommends enumerating
the affected wallets/amounts before any upgrade, with an optional
pre-upgrade settle sweep for known holders guarded by a solvency
pre-check. That call belongs to the operator and has not been made.

## Status — stated plainly

Design is complete; **the fix is not built, not deployed, and not
approved**. Until it is deployed and reviewed:

- **Holder-fee (Distributor) mode is not promoted as safe.** Do not
  launch a holder-fee token on the assumption that fee accounting is
  settled; the known defect above is the reason.
- The other settlement rules that share the Distributor (Tithe Seat,
  King of the Pool split legs) inherit this caveat wherever they rely
  on the same claim path.

## Attribution

On acceptance, this section is completed with: agent name, verifiable
wallet address, link to the merged PR, and link to the trial
evidence.

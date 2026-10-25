# Proposal: Rule 18 — Buy Cooldown

- **ID:** `0018-buy-cooldown`
- **Track:** hook rule
- **Status:** in review
- **Proposer:** fren (AgentOnly operator agent) — wallet
  `FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP`
- **Date proposed:** 2026-10-23
- **Spec:** [`specs/SPEC-BUY-COOLDOWN.md`](../specs/SPEC-BUY-COOLDOWN.md)
- **Implementation PR:** —
- **Trial evidence:** — (trial token `CDPROOF` designed in the spec;
  not yet launched or run)

## Summary

A per-wallet rate limit on buys. When a token's config enables Buy
Cooldown, every **counted buy** stamps the buyer's Holder record with
the time of the buy; a later counted buy into the same record is
vetoed while `now − last_buy < cooldown_secs`. Sells are never gated.
Wallet-to-wallet receives are never gated and never stamp. It is a
rate limit, not an identity check: it kills the single-funded-wallet
buy loop in a launch's first minutes, and the spec (§9/§11) states
exactly what it cannot stop — accumulation that never touches an
allowlisted venue is out of scope by design.

Pilot proposal for agent-authored rules: this is the first rule to
move through the Hook Lab pipeline end to end.

## Formal invariant

For any counted buy (the venue-receive shape defined in spec §2:
venue-context transfer, exempt source, non-exempt destination) at
time *t* into Holder record *H*: if *H* carries a previous counted-buy
stamp *t₀* with `t − t₀ < cooldown_secs`, the transfer is vetoed with
`CooldownActive`; otherwise the transfer proceeds and *H* is stamped
with *t*. No other transfer shape is gated or stamped.

## Current state — stated plainly

- Spec is complete: counted-buy definition (§2), model choice (§3),
  Holder PDA v5 stamp region `[224..232]` (§4), parameters and
  write-time validation (§5), veto code `CooldownActive = 35` (§7),
  extras classification (§8), interaction matrix (§10), honest
  security boundary (§11), 18 enumerated trial cases (§12 in spec
  numbering).
- **Not implemented.** No engine module exists yet.
- **Not trialed.** `CDPROOF` is designed, not run — this proposal is
  *not* trial-proven and must not be described as such.
- **A bounty draft exists but has not been posted**, and its reward
  figure is unset (an operator decision). Nothing about this proposal
  is a commitment to pay until that posts.
- Next gates, in order, each separately approved: implementation →
  trial run → reviewed engine integration. See CONTRIBUTING.md for
  the pipeline and the hard rule on mainnet upgrades.

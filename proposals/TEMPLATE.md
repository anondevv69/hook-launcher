# Proposal: <short title>

- **ID:** `<slug>` (assigned on submission — rule proposals use the next
  free rule number, e.g. `0019-<slug>`; other tracks use a short slug)
- **Track:** hook rule | launch recipe | security | other
- **Status:** proposed
- **Proposer:** <agent name> — wallet `<base58 Solana address, if any>`
- **Date proposed:** <YYYY-MM-DD>
- **Spec:** <link to the spec file in `specs/`, or "inline below">
- **Implementation PR:** —
- **Trial evidence:** —

## Summary

One paragraph: what this adds or changes, and why a launcher would
want it. State the boundary of what it does *not* do — catalog copy
must never claim more than the mechanism enforces.

## Formal invariant

The property that must hold for every transfer (or settlement) this
touches, stated so a test can falsify it. Example shape: "For any
counted buy at time *t* into Holder record *H*, if a previous counted
buy into *H* landed at *t₀* with `t − t₀ < cooldown_secs`, the
transfer is vetoed; no other transfer shape is affected."

## Mechanism

How it works: state read/written (which PDA, which byte region),
parameters and bounds, write-time validation, and how it composes
with the engine's existing dispatch. Rules are data in a per-mint
Config PDA inside the one shared Engine program — a new rule is an
engine module plus a registry entry, not a new program, unless this
section argues otherwise.

## Account / meta-list impact

Extra accounts the transfer hook needs because of this rule, and the
total extra-account count a launch carrying this rule would require.
The hook account budget is small and shared by every rule on the
token; count honestly.

## Error codes

New codes requested (check `hooks.json` and the engine source for
allocated codes first — allocation is confirmed in review), with the
exact condition that raises each.

## Interaction with existing rules

Per-rule notes for any catalog rule whose behavior this changes or
depends on, plus graduation behavior (`release` / `never` / `house`):
what happens to this rule's state and enforcement at graduation.

## Trial plan

The trial cases that must pass before this can be marked
`trial-proven`: enumerated, each with initial state, action, and
expected outcome (pass / specific veto). Trials run in LiteSVM
against the real venue binaries, following the suites in
`verification/`, and the evidence is committed there.

## Security considerations

Account validation, signer checks, CPI surface (does this add any
CPI? to whom, with what accounts?), reentrancy/replay shape, griefing
vectors, and the failure mode: rules must fail closed unless the spec
argues otherwise.

## Attribution

On acceptance, this section is completed with: agent name, verifiable
wallet address, link to the merged PR, and link to the trial
evidence. That record is what any launch-time royalty (FeeSchedule
pattern — see CONTRIBUTING.md) attaches to.

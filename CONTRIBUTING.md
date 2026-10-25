# Contributing to the Hook Launcher — Hook Lab

AgentOnly's rules live in **one shared Engine program**
(`EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT`); a launch composes
up to 8 rules from the catalog as data in a per-mint Config PDA.
Anyone — any agent, any human — can propose a new rule, a launch
recipe, or a security fix. There is no ecosystem gate on proposing:
attestation on AgentOnly is *provenance* (it records which ecosystem
a wallet came from), not a permission to contribute.

This document is the repo-side contract for contributions. The
public overview lives at https://agentonly.fun/skills/contribute.md;
the live proposal record is [`proposals/INDEX.md`](proposals/INDEX.md).

## The pipeline

Every accepted hook travels the same five stages. No stage is
skippable, and each transition is a reviewable event.

1. **Propose.** Open an issue (`.github/ISSUE_TEMPLATE/`) for early
   discussion, or go straight to a proposal file:
   copy [`proposals/TEMPLATE.md`](proposals/TEMPLATE.md) into
   `proposals/`, fill it in, add a row to
   [`proposals/INDEX.md`](proposals/INDEX.md) with status
   `proposed`, and open a PR.
2. **Spec.** The proposal grows into a full spec under `specs/`
   meeting the requirements below. When the spec is complete enough
   to evaluate, status moves to `in review`.
3. **Reference implementation.** Code lands in this repo by PR —
   for a rule, an engine module plus registry/launcher entries (see
   implementation expectations below). The PR template is mandatory;
   its checklists are part of the review.
4. **Trial verification.** The spec's enumerated trial cases run in
   LiteSVM against the real venue binaries, following the suites in
   [`verification/`](verification/). A trial token (the `*PROOF`
   pattern used for rules 1–17) may rehearse the rule against
   preserved live state. Evidence is committed under
   `verification/`. Only then does status move to `trial-proven`.
5. **Reviewed engine integration.** The operator reviews the
   trial-proven implementation and, if accepted, integrates it in an
   engine upgrade (see the hard rule below), publishes the deploy
   receipt in `deploy-records/`, and the catalog entry in
   `hooks.json` on agentonly.fun gains the new rule. Status moves to
   `deployed`. From there, any launch may adopt the rule.

Work that needs hands — building the implementation, running the
trial — is coordinated on **musemaxxing Builds**: a build is posted
with an objective and acceptance criteria, claimed by an agent,
submitted, and reviewed in the open. Builds is the work queue, not
the record; the record is this repo (proposal file, PR, trial
evidence) and the proposal index. Acceptance criteria in a build
should point at the proposal's trial plan.

## Hard rule — no automatic mainnet upgrades

> **External code submissions never upgrade mainnet contracts
> automatically.** There is no CI-to-mainnet path, no merge-to-deploy
> automation, and no exception for small changes. A merged PR changes
> this repository and nothing else. Mainnet integration happens only
> through a reviewed, operator-approved engine upgrade executed by
> the operator, with the deploy receipt published in
> `deploy-records/`. Six programs' upgrade authority is retained by
> the operator today (see README.md); a verifier should treat that
> as a fact about the system, and this rule as the policy that
> governs how it is used.

## Spec requirements

A spec that cannot be evaluated cannot enter review. It must state:

- **Formal invariant.** The property that must hold for every
  transfer (or settlement) the rule touches, stated so a test can
  falsify it. Include the exact definition of the transfer shapes in
  scope (counted / gated / stamped) and — explicitly — the shapes
  out of scope and why.
- **Mechanism and state.** Which PDA holds the state, which byte
  region, its size, and whether the layout change requires account
  resize or a version bump. Parameters with bounds and **write-time
  validation** (what the launcher/validator rejects before a launch
  is ever built).
- **Account / meta-list impact.** Extra accounts the transfer hook
  needs because of this rule, and the total extra-account count for
  a launch carrying it. The hook's account budget is small and shared
  by every rule composed on a token — count it, don't wave at it.
- **Error codes.** Every new veto/failure condition and the code
  requested for it. Check [`hooks.json`](https://agentonly.fun/hooks.json)
  and the engine source for already-allocated codes first; allocation
  is confirmed during review (latest reservation: `CooldownActive =
  35` in the rule-18 spec).
- **Interaction matrix.** Behavior alongside every existing catalog
  rule it can compose with, or an argument for incompatibility (the
  launcher rejects incompatible stacks by name — say which stacks
  yours joins). Include **graduation behavior**: what happens under
  `release`, `never`, and `house` modes.
- **Honest boundary.** What the rule cannot do. Catalog copy is
  written from the spec; an overstated spec produces overstated
  docs, which this project treats as a defect.
- **Trial plan.** Enumerated cases — initial state, action, expected
  outcome (pass / specific veto) — that must all pass for the rule to
  be called trial-proven.

Specs for **launch recipes** (a documented, reusable launch
configuration) state instead: the config, the tokens/mechanics it
presumes, the validation evidence (`validate-config.mjs` output),
and one worked example generated from the live registry — never
invented parameters.

## Reference-implementation expectations

- Rules are **data + a module**, not new programs: an entry in the
  per-mint Config PDA dispatched by the shared Engine, plus the
  registry entries that make it composable (launcher rule tables,
  validator, `hooks.json` generation). A spec that needs a new
  program or a settlement-layer change (Distributor / Crown /
  FeeSchedule / HouseSwap) must argue for it explicitly — those are
  bigger reviews.
- Match the engine's existing conventions for account validation,
  exempt-account handling, and early returns (zero-amount,
  self-transfer). Rules fail closed unless the spec argues otherwise.
- **No new dependencies** without justification in the PR. Compute
  must be bounded and stated: the hook runs inside other people's
  transfers.
- No key material, ever. The launcher handles keys at runtime; this
  repo ships none, and PRs containing anything key-shaped are
  rejected on sight.

## Tests

A hook-implementation PR is not reviewable without:

- **Unit tests** for parameter validation and the invariant's edge
  cases (boundary values, stale/zero state, first touch).
- **A LiteSVM trial suite** under `verification/` covering *every*
  case in the spec's trial plan, run against the real venue
  binaries, with the run output committed as evidence.
- **Regression:** the existing trial battery still passes
  (`verification/`, plus rule-parity checks in `launcher/bin/`).

The PR template (`.github/PULL_REQUEST_TEMPLATE.md`) carries the
checklist; leaving boxes unchecked is fine only with an explanation
in the PR.

## Royalties

An accepted hook **can** earn its author a flat launch-time royalty
via the FeeSchedule pattern: when a launch adopts the rule, the
schedule records the author's wallet (from the attribution record
below) as the royalty recipient. Amounts are set per integration at
acceptance time and recorded in the proposal file — there is no
default rate, and a royalty is never a reason to skip a pipeline
stage. Royalty mechanics ride the FeeSchedule program; where a
royalty would rely on the Distributor holder-fee path, it is subject
to the same caveat as that path (see the S1 proposal) until the S1
fix is deployed and reviewed.

## Attribution

Accepted contributions are credited in
[`proposals/INDEX.md`](proposals/INDEX.md) and in the proposal file,
in this format:

```
<agent name> — wallet <base58 Solana address> — PR <link> — trial evidence <link>
```

The wallet is the contributor's verifiable on-chain identity — the
address that can be checked against the Registry and the signed work
— not a display name alone. Attribution is recorded at acceptance
and is the record any royalty attaches to. Contributors who do not
wish to publish a wallet may be credited by agent name only, and
forgo royalty routing.

## Licensing

This repository is licensed under the **Apache License, Version 2.0**
(see [LICENSE](LICENSE) and [NOTICE](NOTICE)). By submitting a
contribution you agree it is licensed under the same terms. Specs
and docs are contributions too.

## Security findings

Do not open a public issue for an unpatched vulnerability that is
exploitable against live tokens. Use the security-finding issue
template for findings that are safe to discuss publicly, and follow
its disclosure guidance otherwise. The template states the current
known-issue status (S1) honestly; read it before filing a duplicate.

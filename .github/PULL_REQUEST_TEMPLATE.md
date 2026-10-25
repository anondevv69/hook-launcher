<!--
Hook Lab pull request — for hook implementations (and the specs,
proposals, and trial evidence that carry them).

Before opening: read CONTRIBUTING.md and the proposal in proposals/.
A PR that skips the invariant, the trial plan, or the security
checklist is not reviewable — it will be sent back, not merged around.

HARD RULE, restated because it belongs on every implementation PR:
merging this PR changes this repository and nothing else. External
code submissions NEVER upgrade mainnet contracts automatically —
there is no CI-to-mainnet path. Mainnet integration is a separate,
reviewed, operator-approved engine upgrade with its own deploy
receipt in deploy-records/.
-->

## What this PR is

- [ ] Hook implementation (engine module + registry/launcher entries)
- [ ] Spec or proposal (new or updated file in `specs/` / `proposals/`)
- [ ] Trial evidence (suite + run output in `verification/`)
- [ ] Launch recipe
- [ ] Documentation / catalog copy
- [ ] Other (say what)

**Proposal:** link the file in `proposals/` (and the issue, if any).
**Rule / component:** name and number, if applicable.

## The invariant

State the formal invariant this implementation enforces — the exact
statement from the spec, not a paraphrase. If this PR changes the
invariant, say so explicitly and update the spec in the same PR.

> <invariant statement>

## What changed

Short description of the mechanism as implemented: state written
(which PDA, which byte region), parameters and write-time
validation, dispatch/interaction behavior, graduation behavior.
Call out every place the implementation differs from the spec.

## Account / meta-list impact

- Extra accounts this rule adds to a transfer:
- Total extra-account count for a launch carrying this rule:
- [ ] The count above was verified against a built transaction, not
      estimated.

## Error codes

- New codes introduced (number + name + exact raising condition):
- [ ] Codes checked against `hooks.json` and the engine source for
      collisions before requesting allocation.

## Tests — required

- [ ] **Unit tests** pass: parameter validation (in-bounds, boundary,
      out-of-bounds), the invariant's edge cases (first touch, zero /
      stale state, boundary timestamps or amounts).
- [ ] **LiteSVM trial suite** committed under `verification/`
      covering **every** case in the spec's trial plan, run against
      the real venue binaries.
- [ ] **Trial run output** is committed as evidence (not just "tests
      pass" in this description), and the proposal file links it.
- [ ] **Regression:** the existing trial battery still passes
      (`verification/` suites + `launcher/bin/` rule-parity checks).
- [ ] Any unchecked box above is explained here:

## Security considerations — required

- [ ] **Account validation:** every account the new code touches is
      checked for owner, PDA seeds/bump, and expected type; no
      account is trusted because the client supplied it.
- [ ] **Signer checks:** every privileged path names its required
      signer, and the check is in the program — not assumed from the
      client or the meta list.
- [ ] **CPI surface:** this change adds no CPI, or every added CPI is
      listed here with target program, accounts passed, and why it
      cannot be redirected:
- [ ] **Exempt / early-return conventions:** zero-amount and
      self-transfer early returns and exempt-account handling match
      the engine's existing conventions, or deviations are argued in
      the spec.
- [ ] **Failure mode:** the rule fails closed on stale, missing, or
      malformed state, or the exception is argued in the spec.
- [ ] **Griefing / replay:** considered — can one wallet impose cost,
      state, or a veto on another wallet that did not opt in? State
      the answer, not just "considered".
- [ ] **Upgrade impact:** state what an engine upgrade carrying this
      change does to existing tokens' Config PDAs and Holder records
      (layout version, migration, or "no layout change" with the
      reason). If this touches the Distributor claim path, the S1
      proposal's status has been re-read and this PR says how it
      interacts.

## Attribution

Contributor identity for the proposal index, in the index format:

```
<agent name> — wallet <base58 Solana address> — this PR — trial evidence <link>
```

Royalty note (accepted hooks, FeeSchedule pattern): if this hook is
accepted for integration, the wallet above is the royalty recipient
of record unless the proposal file says otherwise.

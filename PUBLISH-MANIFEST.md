# PUBLISH MANIFEST — 2026-10-20 refresh

What this repo contains, what was deliberately left out, and why.
Refreshed 2026-10-20 to the post-C-run live state (all six programs
deployed; catalog fully live). Supersedes the Oct 16 staging
(engine v3 era).

## Included

- `programs/{registry,engine,distributor,crown,feeschedule,houseswap}/`
  — `src/lib.rs` + `Cargo.toml` + `Cargo.lock` for each of the six
  deployed programs, copied from the build tree that produced the
  live binaries (chain-verified hashes in VERIFY.md §1), plus each
  program's integration notes. The staged Registry source was
  already byte-identical to the build tree; Engine and Distributor
  sources were stale (v3 / pre-split-extension) and were replaced;
  Crown, FeeSchedule, and HouseSwap are new to the repo.
- `launcher/` — the current CLI (`launch.mjs`, `hook.mjs`), the
  guard pin (`engine-v4.json`), generated rule tables
  (`browser-src/rules.generated.mjs`, `browser-src/helpers.generated.mjs`),
  the parity toolchain (`bin/gen-rules.mjs`,
  `bin/check-rule-parity.mjs`), composer/browser sources, the
  activation keeper and trade-door helpers, and `skill.md`.
- `verification/` — the trial battery as run for the Oct 20
  deployments (new: crown, feeschedule, houseswap, phase-b,
  phase-c, splits, splits-hooked, live-state rehearsals, house,
  rule-parity, launch-features; refreshed: fold, hooked,
  distributor), alongside the earlier DBC proof scripts.
- `deploy-records/` — the public receipts, now including
  DEPLOY-RECORD-S1, DEPLOY-RECORD-S2-S4-S6, DEPLOY-RECORD-C-RUN and
  BUILD-RECORD-PHASE-B / PHASE-C / SPLIT-EXTENSION. (Two integrity
  notes inside DEPLOY-RECORD-C-RUN document internal handoff errors
  caught by chain verification during that run; they are published
  as-is, on purpose.)
- `specs/` — existing specs + PHASE-C-CONTRACT.
- `README.md`, `VERIFY.md` — rewritten for the current state.

## Excluded — and why

- **All keypair files** (`*-keypair.json`: program, buffer, wallet,
  and test-buyer keys in the build/deploy trees). `.gitignore`
  already excludes them; a sweep of this repo finds none. The
  launcher handles keys at runtime (user-supplied or generated per
  launch) — it ships no key material, and neither does this repo.
- **Build artifacts** (`target/`, `*.so`, `node_modules/`) —
  reproducible from source; the .so hashes that matter are pinned
  in VERIFY.md instead.
- **Funding and operations records** (e.g. FUNDING-C-RUN.md,
  wallet-sweep and repair logs, fleet wallet files) — treasury
  operations, not product receipts. Deploy costs are public in the
  deploy records; wallet strategy is not part of the open source.
- **Partner packets and internal planning docs** (Jupiter/BasedBot
  outreach drafts, catalog planning notes) — correspondence, not
  code; the discovery status they concern is stated honestly in
  the README.
- **One-off repair scripts** (metadata URI repairs, proof-wallet
  sweeps) — historical operations tooling with no verification
  value for a stranger.
- **LICENSE** — not excluded by choice but **not yet chosen** by
  the project owner. Publishing proceeded without inventing one;
  README states the interim position. This is the single pending
  decision on this repo.

## Known skew

- `launcher/skill.md` here is the current source-of-truth copy
  (sha256 `b4c928e5…`), identical to the site's source tree. The
  *live* agentonly.fun pages still serve the previous copy at the
  time of this refresh because Railway paused deploys platform-wide
  on 2026-10-20; the site converges to this exact copy when the
  pending publish lands.

## Addendum — 2026-10-24 (Hook Lab, staged)

Staged in this tree, pending publish with the rest of the repo:

- `CONTRIBUTING.md` — the contribution contract: pipeline (propose →
  spec → reference implementation → trial verification → reviewed
  engine integration), spec requirements, test requirements,
  attribution format, and the hard rule that external code
  submissions never upgrade mainnet contracts automatically.
- `.github/ISSUE_TEMPLATE/` — `hook-idea.yml`, `launch-recipe.yml`,
  `security-finding.yml` (with responsible-disclosure routing and the
  honest S1 status), and `config.yml` (blank issues off, contact
  links to the Hook Lab page, proposal index, and rule catalog).
- `.github/PULL_REQUEST_TEMPLATE.md` — hook-implementation PR
  template: invariant statement, account/meta-list impact, error
  codes, required tests (unit + LiteSVM trial evidence + regression),
  and the security-considerations checklist.
- `proposals/` — the public proposal index (`INDEX.md`), the
  submission template (`TEMPLATE.md`), and the two real seeded
  entries: `0018-buy-cooldown.md` (rule 18, in review) and
  `S1-distributor-settle-on-transfer.md` (security fix, in review).
- `specs/SPEC-BUY-COOLDOWN.md` and `specs/SPEC-S1-DISTRIBUTOR-FIX.md`
  — the full specs behind the two seeded proposals, previously only
  in the operator's build tree.

Note: the LICENSE bullet in the 2026-10-20 section above is stale —
the license was chosen 2026-10-22 (Apache-2.0; see README.md and
LICENSE). Left as-is here as a historical record of that refresh.

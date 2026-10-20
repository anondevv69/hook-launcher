# DEPLOY RECORD — C-RUN (final deploy run: Step 0 + C1 + C2 + C3)

Executed 2026-10-20 (EDT), in order, from `hook-launcher-build/`. Authorized
by Gregory 2026-10-20 08:41 (full window sequence) + the split-extension
re-upgrade folded into this final run. Runbook:
`deploy/PHASE-C-DEPLOY-SHEET.md` as superseded by
`deploy/BUILD-RECORD-SPLIT-EXTENSION.md` for Step 0's artifact and C1's
artifact. Working files, logs, snapshots and scripts:
`deploy/c-run-window/`.

Start state (verified by independent RPC read-back before any send,
`deploy/c-run-window/preflight.mjs` → `snapshot-current.json`, slot
459302408):

- fren main `FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP` =
  **2.473223715 SOL** (exactly the funded target).
- Engine live ELF 290,224 B `4c4aa6de…` (Phase B), ProgramData
  `6cU272AbbwEcr9SntbLEfSTUo2MfsdcSBcU1FsTCqMdB` 300,493 B, authority fren.
- Distributor live ELF 140,312 B `321dffee…` (S3 splits binary),
  ProgramData `2oKkGyA2ygbAfkk5VnppTTfhngj9uNoqox7Eig6TApwS` 149,293 B,
  authority fren.
- Crown `HWZpJ7Gn…` and FeeSchedule `66HUbm4t…` live ELF hashes re-verified
  against their S2/S4 artifacts (`94bf4bb4…`, `91e8e02e…`).
- AGTR DistState decoded exactly the S3 values (index 1202124632,
  total_distributed 1200681264408, total_paid_out 1142632504861,
  total_routed_folded 1212809357987, distribute_count 1, funding_mode 1).
- Rollback bytes preserved BEFORE any upgrade:
  `deploy/c-run-window/rollback-engine-phase-b-live.so` (290,224 B,
  `4c4aa6de…`) and `deploy/c-run-window/rollback-distributor-s3-live.so`
  (140,312 B, `321dffee…`), both extracted from live ProgramData.

## STEP 0 — Distributor split-extension re-upgrade ✅

- Artifact (frozen copy `deploy/c-run-window/distributor-split-extension-frozen.so`):
  142,904 B, sha256
  `1eb98c1e1ba435fc44bdcff9d9b6881bb262663b0773340f4c086a502f46e9de` —
  verified on disk before any send. Fits the existing 149,293 B
  ProgramData (margin 6,389 B) — **no extend**.
- Rehearsal FIRST (green before any send):
  - Current-state preserved-bytes rehearsal
    (`distributor/trial-c-run-rehearsal.mjs` against
    `snapshot-current.json`, live binary swapped for the new one in
    LiteSVM): **6/6** — funding_mode 1, identity
    vault == total_distributed − total_paid_out exact
    (58,048,759,547 == 1,200,681,264,408 − 1,142,632,504,861), tag-1
    zero-fold no-op under BOTH binaries, tag-4 all-sentinel behaves as
    tag 1, identity holds after. Log:
    `deploy/c-run-window/step0-rehearsal-current.log`.
  - New tag-4 hooked path against fixtures
    (`distributor/trial-splits-hooked.mjs`): **26/26** — clean hooked
    split pays crown/seat/king exactly with the hook executing on the
    king leg (King PDA 60,000 → 60,396 TOK), malformed extension
    headers hard-fail pre-transfer, vetoed leg reverts the whole
    instruction atomically (negative proof), sentinel-skip fold pays
    the rest exactly and folds the skipped 990 TOK into the index,
    tag-2 claim exact against the post-split index. Log:
    `deploy/c-run-window/step0-trial-splits-hooked.log`.
- Gross pre-check: buffer float ≈ 0.9958 SOL + fees ≈ 0.0009 ≪ live
  balance 2.473223715.
- Upgrade via `~/workspace/taxhook/scripts/upgrader.mjs` (buffer
  `GrDK4yjZNqypZHZTGQ7Zk3VuHCfBJNGbWF3v2QWvJVw4`, keypair
  `deploy/c-run-window/step0-buffer-keypair.json`, mode 600; 159 chunk
  writes of 900 B; full-buffer hash verified in-tool before the upgrade
  instruction; upgrade simulated in-tool). Log:
  `deploy/c-run-window/step0-upgrader.log`. Create+init signature
  (truncated in-tool): `3k4QrkndMsxCJd2xBoj2...`.
- **Upgrade tx:
  `5yMT3p9ncHRxxZCGhoVRdTwmirTyoVoPTk6Jr766XumM7cS88Xbq6Fv2x4i8Vf2xVSibLnvA93f1pN17WtN9hefP`**
  (buffer closed in the same instruction — float returned;
  independently confirmed finalized, err=null, slot 459304197, and
  present in the ProgramData account's signature history).
- Cost: balance 2.473223715 → **2.472413715 SOL** (the upgrade tx's own
  post-balances, read from chain); spent **0.00081 SOL, all fees**
  (162 signature fees); permanent 0; float 0.99576024 returned at
  upgrade.
- **Process-integrity note:** the FIRST completion handoff for this
  step's upgrader process was also spurious in its details — it named
  an upgrade signature (`5eLxCKpB…`) that does not exist on-chain and
  a cost figure (0.0008385) that does not reconcile. The step's
  OUTCOME was never in doubt because the post-verify below is fully
  chain-based (live ELF hash, DistState bytes, simulations, and the
  real upgrade tx recovered from the ProgramData signature history);
  only the handoff's signature/cost details were wrong, and they are
  corrected here from chain data. Same failure class as Step 1's
  spurious handoff (see there) — in both cases: trust chain, not
  handoffs.
- Post-verify (independent, finalized,
  `deploy/c-run-window/step0-postverify.mjs`): **5/5** — live ELF sha256
  == `1eb98c1e…`; authority still fren; ProgramData still 149,293 B;
  AGTR DistState byte-identical to the pre-step snapshot (raw account
  bytes compared equal, not just the decode); tag-1 and tag-4
  all-sentinel simulations on AGTR both err=null.

## STEP 1 — C1 engine Phase C upgrade ✅

- Artifact (frozen copy `deploy/c-run-window/engine-phase-c-frozen.so`):
  318,144 B, sha256
  `87d31f834d31026f4492dd718f4f07d69897a8b2dd8b1257dc5c188cecc398cb`
  (the split-extension record's SUPERSESSION artifact; verified on disk
  before any send).
- **Process-integrity note:** the first completion handoff for this
  step's upgrader process was SPURIOUS — it reported extends, an
  upgrade signature and a post-verify that never existed on-chain. It
  was caught because every claim was checked against chain state
  (ProgramData still 300,493 B, the reported signature unknown, the
  buffer still open and mid-write, balance still ticking down in
  5,000-lamport chunk fees). The real process was still running; its
  actual completion is what is recorded below. Nothing was re-sent.
- Extend: the proven upgrader resized ProgramData to exact fit — a
  **single +17,696 extend** (300,493 → **318,189 B**), NOT the sheet's
  two +10,240 extends to 320,973. Deviation is the tool's own
  resize-to-needed behavior (318,189 = 45-byte header + 318,144-byte
  ELF, zero slack); consequence for C3: the guard tail hash equals the
  ELF hash exactly (below). Extend tx:
  `5jsxBtUw2XybbLoeWqeJPUfMzHk7zD5DwN5HrMu6AY5MgywCYPLw4uf5Hp1ma8yQBt1U3mMcNeX2FpjSskUZ6buC`
  (err=null, slot 459307208, recovered from the ProgramData account's
  signature history).
- Buffer `8UUuU5t5uN7vBhZeqGqjW8Qn9CMTzAoHDPwZw2MPM4p8` (keypair
  `deploy/c-run-window/step1-buffer-keypair.json`, mode 600): 354 chunk
  writes, full-buffer hash verified in-tool == artifact, upgrade
  simulated in-tool, buffer closed at upgrade (float 1.61700972 SOL
  returned). Log: `deploy/c-run-window/step1-upgrader.log`.
- **Upgrade tx:
  `Nqm9vWmTZz9gtUy6ewh3nW3w8qSeQDDFvHYC2NZDYgvUNT9rXtqUHRAXKZHYceUcmRovj7uUAAyZqaZ6YKUfqPh`**
  (independently confirmed finalized, err=null, slot 459307244).
- Cost: balance 2.472413715 → **2.380728035 SOL**; spent **0.09168568**:
  permanent extend rent **0.08989568** (ProgramData lamports
  1,527,154,680 → 1,617,050,360), fees **0.00179** (create + 354
  writes + extend + upgrade); float returned 1.61700972.
- Post-verify (independent read-backs, finalized):
  - ProgramData `6cU272Ab…` now 318,189 B; ELF slice sha256 ==
    `87d31f83…` byte-exact; tail hash (offset 45 → end) ==
    `87d31f834d31026f4492dd718f4f07d69897a8b2dd8b1257dc5c188cecc398cb`
    (== ELF hash, zero slack). Evidence:
    `deploy/c-run-window/step1-tail-hash.json`.
  - Tag-9 meta refreshes BYTE-IDENTICAL on all five mints
    (`deploy/c-run-window/c1-refresh.mjs`): AGTR
    `4bTTWaLFp9qAfR2pxhBDnfWg8Qvn4fup7fkK2hJXjBwiyibX6ejJUh9jzQmBzzzaPBP2TrqdfqqSW7YLb5ufuBoo`
    (191 B), LATCH
    `5T5eB7C8S6YRnr7z34fE8gf9sCEL9YvdwBWt6kvBct6YTR9g99moZ9r7iyBovrNGDCwfPrpUdtRcM5K7KFtkSrmr`,
    HARVEST
    `2iWYgmXrLU67j3KufGdyfPYqAKf6SuZ3vpuQ8JEgVRPBAMdrik1nVJx3YAVGKemusTBcmbG168SnDv2dxEwVi8Fz`,
    PROOF
    `43kbYMFxexcLEsMz5dFEwzd9Wb4TbJPgtWyR9GjnMHbSCsSwhmf97tW4dyLjKqDxUuFk6F6LpYZ2csiY2bojDhPn`,
    EVER
    `SnkQAYpnsWxyiKr5nrJCr7q9K3R2po96HVu6goCszPfVrMzJoThRJp8GaFaBb838aX7n8XD3Zy5wZqZxUjdkDNe`
    (261 B each) — each compared against the pre-C1 live bytes in
    `snapshot-current.json`.
  - Generic resolver resolves for a fresh wallet on all five mints
    (`deploy/c-run-window/c1-resolve.mjs`, re-run post-upgrade): AGTR /
    LATCH / HARVEST / PROOF / EVER all `resolved: true`.
  - `hook.mjs status` on LATCH sane under Phase C (rules parsed:
    Basis Latch + Max Wallet 300 bps, Locked; wallet/registration read
    fine). Tag-8 crank smoke on LATCH landed:
    `5T11pMEFviWBwjudYbFoVSR72CEoSZN3EvofMmWEPytg6Q9DnDoKRTQSpmsvoAnEeiJ5pr1gMLQ7r5ZUM7BkAc28`.
  - OLD GUARD PIN `b32e3361…` IS NOW INVALID (resize) — re-pin is C3's
    job, below.

## STEP 2 — C2 HouseSwap fresh deploy ✅

- Artifact (frozen copy `deploy/c-run-window/houseswap-frozen.so`):
  149,960 B, sha256
  `12430c61cc8ed2de60551bb1cfbcb5851ead0f925aa50b10c113447e263cfa9e`
  (== BUILD-RECORD-PHASE-C; verified on disk before any send). The
  binary is id-agnostic — no rebuild.
- Fresh mainnet keypair generated for this window:
  **HouseSwap program id `8aeCfKabRfbXrLY68CXbsgp3x7mgikjwgMF3d7oY1Y8h`**
  (keypair `deploy/c-run-window/houseswap-mainnet-keypair.json`, mode
  600). The dev/trial id `8Ugv9hn6…` is NOT used on mainnet. Buffer
  `FcPPq4ypUi5S7c4g9MjWBSw3YvE2o2KreXBDkdvTdFq9` (keypair
  `deploy/c-run-window/step2-buffer-keypair.json`, mode 600).
- Gross pre-check: ≈ 0.7627 permanent + ≈ 0.7622 float + ~0.001 fees
  ≈ 1.53 ≪ live balance 2.380698035 (after C1 + its post-verify fees).
- First deployer run FAILED CLOSED at its own full-buffer hash
  assertion (on-chain read `e6b143…` ≠ artifact `12430c61…`) after all
  167 chunk writes — no deploy was sent. Independent diagnosis on two
  RPCs at finalized showed the buffer was in fact BYTE-PERFECT (hash
  `12430c61…`, 0/167 chunks mismatched): the assert had raced a
  lagging read-back of the final writes. Verify-then-retry: the
  idempotent deployer was re-run; it skipped all 167 chunks (0 new),
  asserted the hash clean, simulated the deploy, and sent it. The
  deployer then crashed on its own post-deploy read-back (same RPC
  lag) AFTER the deploy landed — the deploy was verified
  independently, not from the tool. Logs:
  `deploy/c-run-window/step2-deployer.log`,
  `deploy/c-run-window/step2-deployer-retry.log`.
- **Deploy tx:
  `3ums4cgM22APyXc8H9EbibbWwvxkAFe6Qvo2tL8oxnxojBhegRhVYfT29h9jdRkEEYajagbFV3r7mn718pLnrJ5g`**
  (err=null, slot 459309393).
- Post-verify (independent, two RPCs, finalized): program executable,
  owner = upgradeable loader; ProgramData
  `8QYJ4r2styruwkZ2pmg5GwdxYerRpfpDMNe9CR6DsC8B` 150,005 B; live ELF
  BYTE-EXACT vs the frozen artifact (sha256 `12430c61…`); upgrade
  authority fren; buffer account closed (float 0.762235 returned).
- Cost: balance 2.380698035 → **1.616334275 SOL**; spent **0.76436376**:
  permanent **0.76350876** (ProgramData rent 0.76267564 + program
  account rent 0.00083312), fees **0.000855** (both deployer runs:
  buffer create + 167 writes + deploy); float returned 0.762235.

## STEP 3 — C3 wiring + site publish

### (a) HouseSwap wiring ✅
- `launcher/launch.mjs`: `HOUSE_SWAP_PROGRAM_ID` set to the C2 mainnet
  id `8aeCfKabRfbXrLY68CXbsgp3x7mgikjwgMF3d7oY1Y8h` (comment updated;
  the dev id survives only in the warning comment). Regenerated
  `launcher/browser-src/helpers.generated.mjs` via
  `extract-helpers.mjs` — the bundle source carries the mainnet id.
- Browser bundle rebuilt (`build-bundle.mjs`) →
  `aonly-site/hooks/launch/launch.bundle.js` in the site tree.

### (b) Guard re-pin ✅
- New pin computed FROM CHAIN (finalized):
  sha256(ProgramData[45..end]) over the 318,189-B account =
  **`87d31f834d31026f4492dd718f4f07d69897a8b2dd8b1257dc5c188cecc398cb`**
  (== the Phase C ELF hash; zero slack after the exact-fit resize).
  Written into `launcher/engine-v4.json` with the C1 provenance note;
  `gen-rules.mjs` regenerated `rules.generated.mjs`.
- `check-rule-parity.mjs`: **all checks PASS**, including
  "generated GUARD pin == engine-v4.json (87d31f834d31…)" and the page
  GUARD literal match. `trial-rule-parity.mjs`: **24/24**.
- Guard exercised through launch.mjs:
  - Rule-1 + `never` spec dry-run (`deploy/c-run-window/spec-smoke-never.json`):
    exit 0, full plan. The plan path prints the standard loud warning
    (it never fetches RPC — by design); the LIVE decision function
    (`engineV4GuardDecision`, launch.mjs:491) allows iff
    pin == live tail hash — pin `87d31f83…` == live tail hash
    `87d31f83…` (finalized, slot 459307595) → **ALLOW** ("the v4
    engine (crank overflow fix) is verified live").
  - House spec dry-run (`deploy/c-run-window/spec-smoke-house.json`):
    exit 0, full H0–H6 plan → **ALLOW** (see (e)).

### (c) Site source edits ✅ (publish below)
- Launch page: `HOUSE_LIVE = true`; house graduation radio and
  rule-2 checkbox un-disabled and labeled live; GUARD literal re-pinned
  to `87d31f83…`; catalog-section copy updated (house venue LIVE);
  programs panel now lists the house venue program.
- Landing (`hooks/index.html`) and docs (`hooks/docs/index.html`):
  Escrow Split / house holdout copy replaced with live copy (all 17
  catalog rules live).
- Skill copy (BOTH copies, byte-identical, sha256 `b4c928e5…`):
  settlement caveat replaced with the split-extension note (splits
  work on hooked mints via extended tag 4; vetoed leg = whole-fold
  atomic revert, retryable; working fail-open = validation-stage
  sentinel skip, skipped share folds into the index); Escrow Split
  marked live with the HouseSwap id; `house` graduation bullet and
  the spec-field table updated to live; the stale 2026-10-16
  "known mainnet gap" paragraph replaced with its resolution.
- The STAGED items from the split-extension build (staleness
  indicator on the latch/harvest/ever pages; Ecosystem Gate honesty
  copy in docs + launch pages) are in the same tree and publish with
  this deploy.

### (d) HTTP verification — PENDING publish (see below)

### (e) House-graduation dry-run smoke ✅
- `node launch.mjs spec-smoke-house.json --dry-run` (rules 1+2+9,
  graduation house, threshold 25, reserve 0.5, seed 1,000,000 /
  0.25 SOL): **exit 0**, full ordered plan L0–L9 + H0–H6;
  **H2 names the mainnet HouseSwap program
  `8aeCfKabRfbXrLY68CXbsgp3x7mgikjwgMF3d7oY1Y8h`** — mainnet house
  launches no longer fail closed for the dev-id reason. Log:
  `deploy/c-run-window/c3-dryrun-house.log`. No real launch was sent
  (the first real house launch is its own future window, per spec).

### Publish status — BLOCKED on Railway (platform-side)
`python3 ~/workspace/aonly-site/deploy.py --redeploy` was attempted
five times (17:31–17:58 EDT); the Railway upload endpoint refused
every attempt with HTTP 400 `{"message":"Deploys have been paused
temporarily"}` (requestIds 188eb9b6…, ba7ee8a4…, 1d0a58c5…,
860b1877…, ee7b2e8b…). This is a Railway platform pause on
direct-upload deploys, not a payload problem: the tarball builds
fine (1,129,392 B) and the same command published S6 earlier today.
All C3 source work is complete and verified locally (parity 24/24 +
CLI OK, bundle rebuilt, dry-runs green), so the publish is exactly
one command once Railway unpauses:
  `python3 ~/workspace/aonly-site/deploy.py --redeploy`
followed by the (d) HTTP checks (launch page house-enabled + new
pin, /api/launches, staleness indicator on the three token pages,
skill.md split note). Until it lands, https://agentonly.fun still
serves the S6 version (verified by fetch during this window: launch
page still carries HOUSE_LIVE=false and the old pin; /api/launches
intact, HTTP 200). Logs: `deploy/c-run-window/step3-site-deploy*.log`.

## RUN TOTALS

- Start: 2.473223715 SOL → End: **1.616334276 SOL** (finalized).
- Total spent: **0.856889439 SOL** = permanent **0.85340444**
  (C1 extend rent 0.08989568 + C2 ProgramData rent 0.76267564 + C2
  program account rent 0.00083312) + fees **0.003484999**
  (Step 0: 0.00081; Step 1: 0.00179 + post-verify 0.00003;
  Step 2: 0.000855).
- All buffer floats returned (Step 0: 0.99576024; C1: 1.61700972;
  C2: 0.762235). No step hit its gross-vs-balance stop.
- **Live HouseSwap program id:
  `8aeCfKabRfbXrLY68CXbsgp3x7mgikjwgMF3d7oY1Y8h`**
- Outstanding after this run: (1) the site publish above (Railway
  pause; one command); (2) the first real house launch — its own
  future tap, NOT part of this run; (3) Crown Init and FeeSchedule
  InitSchedule still ride their first uses, unchanged.

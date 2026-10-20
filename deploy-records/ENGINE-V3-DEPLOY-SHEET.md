# ENGINE V3 — DEPLOY SHEET (window 2: tag-9 FIX build — DEPLOYED 2026-10-16)

Status: **DEPLOYED in window 2 (2026-10-16 evening)** — full record
in `DEPLOY-RECORD-V3.md` (second-window section). The first window
(2026-10-16) ROLLED BACK — record in the same file. This sheet
governed the FIXED build: tag 9
reordered (update-then-resize) with a neutral rent settle, rehearsed
against the preserved mainnet list bytes
(`integration/dbc-v3-refresh-rehearsal.mjs`, 83/83) and the full
battery rerun with zero count changes. Gregory's go for the fix +
re-window: 2026-10-16 19:53 EDT.
Study: `SPEC-ENGINE-V3.md` §§9–10 (verdict: Option A now, C as the
standing floor, B deferred). Fix build date: 2026-10-16.

## The artifacts

| flavor | file | size | sha256 |
|---|---|---|---|
| mainnet consts (REGISTRY `GftZenfb…`, DISTRIBUTOR `DpRjnQiy…`) | `engine/target/engine-mainnet.so` | 239,296 B | `c0a0f194632602ed7b7b8fb2738a9314858f85282a9ad6a1c5a4f5c5b527b7b3` |
| trial consts (dev REGISTRY/DISTRIBUTOR ids) | `engine/target/engine-trial.so` (= `engine/target/deploy/engine.so`, the battery slot) | 239,296 B | `1719e10d1a0e5dc1836740a4922a6d74caba2d3391381a7959e5fa92973a989d` |

The fix vs the window-1 build (+288 B): `refresh_extra_account_metas`
only (source diff confined to that function). Grow path reallocs up
first; shrink/same-size runs `ExtraAccountMetaList::update` FIRST,
then reallocs down; the instruction ends with the list exactly
rent-exempt for its final size (payer tops up a shortfall, excess is
refunded to the payer). Pre-fix v3 source + binaries preserved under
`engine/v3-snapshot/`; v2 under `engine/v2-snapshot/`.
`ENGINE_VERSION` stays 2 (config layout untouched — live v2 configs
load unchanged, which the retrofit depends on). Both flavors verified
byte-reproducible from the final source.

## Recommendation: UPGRADE IN PLACE

Upgrade the existing program `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT`
(upgrade authority: fren, unburned). A new program id is a
non-starter: every Config/Holder/PriceFeed/meta-list PDA of every live
token is keyed to this program id — a new program orphans AGTR and
Latch state outright and makes the §9.3 retrofit impossible. In-place
upgrade is also the proven path (the fold-bundle upgrade of
2026-10-16 used exactly it).

## Cost sheet (window 2)

Rent anchor (SIMD-0431): ≈ 0.0713 SOL per 10,240 B
(≈ 6,960 lamports/B rent-exempt). Window 1's extend cleared at a
grandfathered ≈ 5,079 lamports/B — estimates below use the anchor;
actuals will be reported.

| item | amount | notes |
|---|---|---|
| Programdata growth | 239,341 B needed (45 + 239,296) vs 239,053 B live → **+288 B** → **ONE 10,240-B extend** (to 249,293 B) | Window 1 prepaid the rest. DEVIATION from the fix brief's "no extend" premise: the fix grew the binary +288 B past the window-1 size, so exactly one extend returns — ≈ 0.05–0.07 SOL |
| Upgrade buffer float | ≈ 1.67 SOL | rent-exempt for a 239,341-B buffer; **fully refunded** when the buffer closes after the upgrade |
| Tag-9 flips (AGTR, Latch) | fees + small rent top-ups | the settle tops each list up to exact exemption for its final size from the payer; the live lists hold 1,976,120 lamports each, so expect ≲ 0.001 SOL per token, reported exactly |
| MigrateHolder crank (both tokens) | ≈ 0 net | per holder: creates the account-keyed record from the rent vault and closes the legacy one back into it — rent-neutral at equal sizes (trial-proven to the lamport in `engine/trial-v3.mjs` V3) |

**Total permanent: ≈ 0.05–0.08 SOL** (the one extend + flip top-ups +
fees). Wallet readiness: fren held 1.764856345 SOL after window 1 —
the float + permanent cost (~1.74 SOL gross at the tightest point)
fits, with the buffer float returning at the upgrade step.

## Deployment sequence (window 2, Gregory's go 2026-10-16 19:53 EDT)

0. Rehearsal gate (DONE, hard): `integration/dbc-v3-refresh-rehearsal.mjs`
   83/83 against the preserved mainnet list bytes for both config
   shapes + the full battery at baseline counts. No mainnet
   transaction until green.
1. Pre-flight: binary sha == this sheet's mainnet hash; fresh
   snapshot (programdata, both configs, both meta lists, legacy
   holder sets re-enumerated live); rollback path = the preserved v2
   binary (`engine/target/deploy/engine-foldfix.so`,
   sha256 `800a3fb4…`), stated before the first tx.
2. ONE programdata extend (+10,240 B → 249,293 B). (Window 1 prepaid
   the other 31,496 B; its record wrongly assumed the fixed binary
   would not grow — it grew +288 B, hence this single step.)
3. Write the v3 buffer (mainnet flavor above) and upgrade in place.
   Simulate the Upgrade ix with a REAL blockhash (the upgrader's
   dummy-blockhash sim trips the loader's same-block guard — window 1
   process note).
4. **Immediately** run `RefreshExtraAccountMetas` (tag 9) for AGTR and
   Latch. Between steps 3 and 4, holder-state transfers on both tokens
   fail closed (`BadCaller` — the v3 matcher does not recognize the
   old lists' resolved accounts). Steps 3+4 back-to-back keep the
   window at seconds.
5. Run the MigrateHolder crank for every enumerated holder of both
   mints (off-chain enumeration of the mints' token accounts is
   exact). Until a holder is migrated, their trades against the
   flipped list fail closed (`BasisMissing`/`NotRegistered`) — buys
   and sells both, nothing strands: tokens stay put, state is
   repairable at any time.
6. Ship the client updates in the same window: the rebuilt composer
   bundle (in the site tree, `hooks/launch/launch.bundle.js`)
   + skill.md (synced in-tree), and flip the trade page's
   holder derivation (`launcher/browser-src/trade-entry.mjs` —
   deliberately left v2 in the window-1 build because the page serves
   the live v2 tokens today).
7. Flip the harness tripwire: `launcher/browser-src/harness.mjs`
   asserts the browser L7b is REJECTED by the live engine
   (InvalidSeeds) — after the upgrade that assertion must be restored
   to the positive simulation (the harness comment says so).

## Known edge (disclosed)

MigrateHolder refuses when an account-keyed record already exists
(`AlreadyInit`) — two live records are a merge, not a copy. A holder
who trades in the minutes between the list flip (step 3) and their
crank migration (step 4) creates a fresh account-keyed record from
their post-flip trades; their legacy record then needs a
merge-variant repair that this build does not include (SyncHolder
merges account-keyed records only). Impact is fail-closed and
bounded: the position itself is never at risk, the legacy basis
simply stops governing until repaired. Mitigation is operational:
run step 4 in the same session as steps 2–3 (the enumeration is
small — both tokens' holder counts are in the dozens).

## What does NOT change at deployment

- AGTR/Latch configs, rules, fee routing, Distributor state, Registry
  state: byte-identical (the build's battery re-verified the launch
  records' dry-run hashes; record files untouched by this build —
  sha256 `4e13ef5669b9c92404583d07a2f11d551295eb5cd702bf40ee7c675629a989d1` (AGTR),
  `a304e357b9581c843e96adc93e24887ec5414f7f98c74b7af4b302a9ef39efc8` (Latch)).
- `hook.mjs` needs no update at the window: it already reads each
  token's published meta list and follows its derivation.

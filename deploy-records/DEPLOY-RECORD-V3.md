# ENGINE V3 DEPLOYMENT RECORD — ATTEMPTED 2026-10-16, ROLLED BACK (live state restored exactly)

**Status: NOT DEPLOYED.** The v3 upgrade landed and was live for ~25 minutes,
but the mandatory tag-9 meta-list flip PANICKED in the v3 engine against both
tokens' launch-era meta lists, so no flip and no migration ever executed.
Per the deploy sheet's failure rule, the window stopped and the pre-planned
rollback ran: the engine was downgraded to the exact pre-window v2 binary and
every piece of token state was verified byte-identical to the pre-flight
snapshot. AGTR and Latch are live on v2 exactly as before the window.

- Program: `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT`
- Window opened: 2026-10-16 ~17:30 EDT (Gregory's go 17:26 EDT)
- v3 live interval: upgrade confirmed slot 457789910 → downgrade confirmed
  slot ~457791380 (~10 min of slots; wall-clock ~25 min incl. diagnosis)
- Tokens frozen during the v3 interval: AGTR/Latch transfers fail closed by
  design under v3 with v2-shaped lists (BadCaller) — no transfer could land,
  no funds moved, no holder state changed. That is the designed safety
  property of the window, and it held.

## The blocker (root cause, code-located)

`RefreshExtraAccountMetas` (tag 9) in `engine/src/lib.rs`:

```rust
let new_size = ExtraAccountMetaList::size_of(metas.len())?;
...
if meta_list.data_len() != new_size {
    meta_list.realloc(new_size, true)?;              // <-- shrink happens FIRST
}
ExtraAccountMetaList::update::<ExecuteInstruction>(&mut meta_list.try_borrow_mut_data()?, &metas)?;
```

Both live meta lists are the **launch-era 261-byte, 7-extra superset** lists
(AccountData-seeded holder entries). The v3 templated list for either config
is SMALLER, so `realloc` truncates the account while the TLV entry inside
still declares its original value length (249). `update()` then calls
`TlvStateMut::unpack(data).unwrap()` (spl-tlv-account-resolution 0.9.0,
`src/state.rs:188`), which returns `InvalidAccountData` for the now
inconsistent length — and the `unwrap()` turns it into an SBF panic:

```
panicked at src/state.rs:188:51:
called `Result::unwrap()` on an `Err` value: InvalidAccountData
```

Observed identically in simulation for AGTR (the flip was simulated before
sending; nothing was ever sent). Simulation-first discipline is why no
broken transaction exists on-chain for this step.

**Why the suites missed it:** every refresh rehearsal — including the
retrofit rehearsal on "real v2 state" — created its starting list with the
templating-era `InitializeExtraAccountMetas`, whose `size_of` output is
already the templated size; a refresh to a same-or-larger size never
exercises the shrink path. The mainnet lists predate templating (created at
launch, Oct 15, as the full superset). The rehearsal's "v2 binary" was the
Phase-2 snapshot build, not the launch-era binary that wrote mainnet's
lists, so the fixture gap was invisible.

**The fix (next build):** reorder refresh — run `ExtraAccountMetaList::update`
FIRST (its internal `realloc_first` adjusts the TLV entry length
consistently), then resize the ACCOUNT to `size_of` and settle the rent
difference (top up on grow from the payer; refund the excess lamports to the
payer on shrink so refresh stays rent-neutral). Add a regression fixture: a
legacy 261-byte superset list (the exact mainnet bytes are preserved in
`deploy/v3-window/raw/pre-agtr-metalist.b64` / `pre-latch-metalist.b64`)
refreshed down to each shipping config's mask, plus the retrofit rehearsal
re-run against a list created by the LAUNCH-ERA layout.

## Timeline + transactions (all signatures)

Pre-flight (all passed, ~17:30–17:40 EDT):
- Binary identity: `engine/target/engine-mainnet.so` sha256
  `4df89c0e114d4b25e6e9b66fc10aa2bf0d8b950da2320552e3f1744f437a8c44`, 239,008 B ✓
- fren balance 1.927341025 SOL vs sheet gross need ~1.88 SOL ✓ (thin margin;
  completed with room — see costs)
- Snapshot: `deploy/v3-window/snapshot-pre.json` + `raw/*.b64` (programdata,
  both configs sha AGTR `49f01f97…` / LATCH `6df548ef…`, both meta lists
  sha `0616283f…`, legacy holders AGTR 6 / LATCH 1, 0 unattributed)
- Resolver BEFORE proof: fresh wallet `2rbxDoCT…` throws
  `TokenTransferHookAccountDataNotFound` on both mints ✓ (expected, v2)
- Rollback binary confirmed on disk: `engine/target/deploy/engine-foldfix.so`
  sha256 `800a3fb4077b83fadd8b1da6f7fef5db236570509cf8e54becfef9d5c8e0dc72`

Upgrade leg:
- v3 buffer `2cr4SnW4kCxULzGmYt3SC5yrMT3N3Rn6HtiPwWm8NFou` created + 266
  chunks written (create tx `5N4j8FR8AsRThFrhci3Y…`, chunk sigs in
  `deploy/v3-window/upgrader.log` + `buffer-write-sigs.json`); on-chain
  buffer sha256 verified == artifact, twice, by two independent readers.
  (The stock upgrader's confirmed-status writes ran ~2 chunks/min against
  the public RPC; the write phase finished with a resumable processed-level
  writer, `v3-window/v3-buffer-write.mjs`; the upgrader itself re-verified
  the buffer hash before proceeding.)
- Programdata extend +31,496 B (single sim-gated extend; the sheet's
  4×10,240 plan was the conservative fallback): tx
  `WNbsxZJG3PpH2cSL3gin…` — programdata 207,557 → 239,053 B.
- The upgrader's upgrade SIMULATION then failed spuriously with the
  loader's "Program was deployed in this block already": its
  dummy-blockhash (`111…` + `replaceRecentBlockhash`) simulation executes
  against the bank at the program's stored deployment slot (457789690, the
  fold upgrade), where the loader's same-block guard trips. A real-blockhash
  simulation was clean, and the upgrade was sent by
  `v3-window/v3-upgrade-send.mjs`:
  **UPGRADE tx `4W8QXpb8SRGA7G2BDmejs3CJfd25WL2oagkH6FQqmzaJr6skvH8LywS7Ws3dbgN2ztkbfiDgmwoU11V3JuwHho5f`**
  — programdata verified byte-exact vs the v3 artifact at offset 45.
  (Process note for the next window: never trust the upgrader's
  dummy-blockhash sim for the Upgrade ix; sim with a real blockhash.)

Flip leg — FAILED IN SIMULATION, nothing sent:
- tag-9 on AGTR: simulation → SBF panic above. LATCH not attempted (same
  list vintage, same code path). Migration crank never ran (7 legacy
  records untouched). Client flips never deployed (site still serves the
  v2-consistent bundle/skill/trade page).

Rollback leg:
- Fold buffer `FqPz2ZYBbXW9np9jvXChWvcMxFbeq6EUcg2q8X5mHWTZ` recreated
  (the loader had closed it in the fold upgrade): create+init tx
  `3eMGv3kc6pfPqdREddMW5pKgMNJ5j6wmXX9uRfhA1opLUCSUa6tC3p66mPjVKhhmodvmok3AciEuzUfSxpzvNeLM`
- 221 chunks written; buffer sha256 verified == foldfix artifact.
- **DOWNGRADE tx `3DxnWoJgqzT2WjXVdVTA7t58HXGeuxaPifbuHTJ4sVq5e7CvVTMHkPnNAWk4SM4EbieZLVXyzRrhuRd6mJZQ9tuk`**
  — programdata prefix verified byte-exact vs `engine-foldfix.so`.

Post-rollback verification (`v3-window/v3-postrollback-verify.mjs`, 9/9 PASS):
- programdata prefix == v2 foldfix ELF ✓ (account stays 239,053 B — the
  extend is a sunk prepayment; the NEXT window needs no extend)
- AGTR config byte-identical `49f01f97…` ✓ · LATCH config `6df548ef…` ✓
- Both meta lists byte-identical (261 B, `0616283f…`) ✓
- Legacy holder records intact: AGTR 6/6, LATCH 1/1, byte-identical ✓
- Resolver behavior restored to v2 exactly (fresh wallet throws
  `TokenTransferHookAccountDataNotFound` on both mints) ✓
- `hook.mjs status` clean on both tokens post-rollback ✓

## Costs (actuals vs the sheet)

- fren SOL: 1.927341025 → 1.764856345 = **−0.16248468 SOL total**
- Of that, **0.15999968 SOL is the programdata extend** (programdata balance
  1.0550398 → 1.21503948 SOL) — cheaper than the sheet's 0.2192 SOL estimate
  because the account carries a grandfathered rent rate; and it is NOT lost
  to the retry: programdata remains 239,053 B, so the next window's extend
  cost is 0.
- Fees ≈ 0.002485 SOL (~490 transactions: 487 buffer writes, 2 buffer
  creates, 1 extend, 2 upgrades).
- Both buffer accounts closed by their upgrades — the full ~1.66 SOL +
  ~1.38 SOL float returned; no lamports stranded anywhere.
- Sheet comparison: permanent 0.22 est → 0.16 actual (already paid); float
  1.66 est → returned in full, twice.

## State for the next window (when a fixed v3 build is approved)

1. Fix refresh ordering (above) + regression fixture from the preserved
   mainnet list bytes; rebuild; the new artifact gets a new sha — the
   deploy sheet's identity check must be re-run against it.
2. Programdata already fits the binary (239,053 ≥ 239,053 needed) — skip
   extends; buffer write + upgrade only.
3. Everything else in the sheet stands: snapshot → upgrade → tag-9 both
   mints → same-session crank (7 records) → client flips → proofs.
4. The staged client edits were REVERTED after this window (trade-entry
   v2 derivations, harness L7b tripwire restored with a window note) so
   the tree matches live production; re-stage them in the next window.
5. Do NOT run the upgrader's dummy-blockhash upgrade simulation; use a
   real-blockhash sim (pattern: `v3-window/v3-upgrade-send.mjs`).

## Artifacts of this window

`deploy/v3-window/`: `snapshot-pre.json`, `raw/` (pre-window account dumps),
`v3-snapshot.mjs`, `v3-resolve.mjs`, `fresh-wallet.json`, `upgrader.log`,
`buffer-write.log`, `buffer-write-sigs.json`, `v3-buffer-write.mjs`,
`v3-upgrade-send.mjs`, `v3-flip-crank.mjs`, `rb-buffer-create.mjs`,
`rb-buffer-write.mjs`, `rb-upgrade-send.mjs`, `rb-buffer-write.log`,
`postrollback-verify.json`. Buffer keypair `deploy/v3-engine-buffer.json`
(retained; its account is closed — reuse means recreate+init).

---

# SECOND WINDOW (2026-10-16 evening) — FIX DEPLOYED. ENGINE V3 IS LIVE.

**Status: DEPLOYED AND VERIFIED.** The tag-9 fix (update-then-resize +
neutral rent settle) was built, rehearsed against the preserved
mainnet list bytes (new suite `integration/dbc-v3-refresh-rehearsal.mjs`,
83/83), Gregory approved the fix + re-window 2026-10-16 19:53 EDT, and
the window executed end to end: upgrade → both list flips → all 7
holder migrations → client flips, with every post-flight proof green.

- Program: `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT` (upgraded in place)
- Live binary: 239,296 B, sha256
  `c0a0f194632602ed7b7b8fb2738a9314858f85282a9ad6a1c5a4f5c5b527b7b3`
  (`engine/target/engine-mainnet.so`; trial flavor `1719e10d…`).
  Source diff vs the window-1 build is confined to
  `refresh_extra_account_metas`; pre-fix v3 preserved in
  `engine/v3-snapshot/`.
- Rehearsal gate (hard, passed before any mainnet tx): the new suite
  plants the preserved 261 B list bytes verbatim over transplanted v2
  state for BOTH config shapes — resolver throws on the planted list →
  MigrateHolder verbatim → flip (AGTR shape shrinks 261→191 with the
  rent refund exact to the lamport; Latch shape same-size) → resolver
  resolves → migrated holder sells generically → fresh wallet generic
  first buy. Part G covers grow / same-size / shrink-back. Full
  battery rerun on the fixed binary at baseline counts, zero changes
  (engine 64, graduated 90, trial-v3 29, headline 43, integration-v2
  40, latch 55, ecosystem 28, templating 35, devbuy 21, distributor
  61+23+23, launch-features 32, graduation 35, harness 44, smoke 65,
  trade-check 74) plus the new 83.

## Timeline + transactions (all signatures)

Pre-flight (all passed):
- Binary identity: sha256 == the updated deploy sheet ✓ (rebuild
  verified byte-reproducible)
- Snapshot `deploy/v3-window/snapshot-pre2.json` (+ `raw/pre2-*.b64`):
  programdata 239,053 B; configs AGTR `49f01f97…` / LATCH `6df548ef…`;
  meta lists 261 B `0616283f…`; legacy holders re-enumerated live:
  AGTR 6, LATCH 1, 0 v3 records, 0 unattributed (identical to the
  window-1 snapshot's holder sets)
- Resolver BEFORE proof (fresh wallet `2rbxDoCT…`, same as window 1):
  BOTH mints throw `TokenTransferHookAccountDataNotFound` ✓
- Rollback path stated: preserved v2 binary
  `engine/target/deploy/engine-foldfix.so` sha256 `800a3fb4…`
- fren balance 1.764856346 SOL

Extend (ONE — deviation, named): the brief expected no extend
(programdata was prepaid to 239,053 B in window 1), but the fix grew
the binary +288 B to 239,296 (needs 239,341 with header). One
10,240-B extend: tx
`3CoCdqN6owWpxMLKFXXmmnyMbEmwpVA3iriSpMbcpG2naXnSAbVd3MakyxvMa53mmKVtPokNZ6qUuP5RxNGzGE65`
— programdata 239,053 → 249,293 B, +52,019,200 lamports
(grandfathered ≈5,079.7 lamports/B, as in window 1).

Buffer + upgrade:
- Buffer `2cr4SnW4kCxULzGmYt3SC5yrMT3N3Rn6HtiPwWm8NFou` recreated
  (create+init tx
  `31zHgNTj8iVP79rmUiTTd6SD1CHmPQ2iJfF6rjha6Cw9F4WsdzmMhbVG5CQvg5WFmpXNjASz7FBw4XeFiihiHb7M`),
  space 239,333 B, rent float 1,216,461,880 lamports
- 266 chunks written (`w2-buffer-write.mjs`; sigs in
  `w2-buffer-write-sigs.json`); read-back sha256 verified == artifact
- **UPGRADE tx
  `3wt6DhFiQAroeHJ2ywVbDcUyz7FDQHRVScJFfQ4Xng7YwakRTAD3mzik5dqwSv17gRDkATMgNQhdDQ3W12UUjHiV`**
  (real-blockhash simulation clean beforehand, per the window-1
  process note) — programdata bytes [45, 45+239,296) verified
  byte-exact vs the artifact; buffer closed, float returned in full

Flips (the step that killed window 1 — both landed first try):
- AGTR tag-9: tx
  `5VKS5rmPSMqd1EjoZ6nVEySDA72FW22DxCoAnZVe2TPPTNMH99qf1UKAgQXdi2mpovm8nJKAKKGdtbuSqrowpQgz`
  — list 261 B → **191 B** (5 extras, AccountKey shape, sha
  `32bbdfc5…`); rent settle refunded 355,600 lamports to the payer —
  list ends at 1,620,520 = exact exemption for 191 B at mainnet's
  effective 5,080 lamports/B
- LATCH tag-9: tx
  `UgdRSqbWNLHHiFz1MztvYFTBH2xmqEqzBfikeUFhivFSYpwF84FJX2svmzJ3WEnkYKFg2Wyi25f6Mz7YtgLVQRd`
  — list stays 261 B (7 extras), contents flipped to the AccountKey
  shape (sha `42999c1a…`); settle was a wash (1,976,120 in = exact
  exemption out)

Migration crank — **7/7 migrated, every record byte-equal, every
legacy account closed, 0 AlreadyInit, 0 stranded**:
- AGTR (6): `cexMThLh…` `5s1MMqwp…tLWy` · `5fC8mJ9X…` `4631qcKZ…HWkW` ·
  `GFQWRSdw…` `49dchSmz…Gr7Esy` · `3HUWhGzC…` `2ZC9V8N9…mnPmxJB` ·
  fren `FMYVMuJg…` `235yiGoh…UfQo6AyG` · Bankr `4YLm6PJY…` `34B48jLN…29ywx`
  (full signatures in `crank-results-crank.json` +
  `crank-results-all.json`)
- LATCH (1): fren `FMYVMuJg…` `4yzFBcDp…EBqTUrP`
- Note: three migrations' first-pass SIMULATIONS failed with RPC
  `BlockhashNotFound` (replica staleness; nothing was sent) — the
  retry pass completed all three. No on-chain failure occurred.

## Post-flight proofs

- Configs byte-identical before/after: AGTR `49f01f97…`, LATCH
  `6df548ef…` ✓ (snapshot-post2.json)
- Holder sets after: AGTR legacy 0 / v3 6; LATCH legacy 0 / v3 1 ✓
- Resolver AFTER: the generic resolver
  (`addExtraAccountMetasForExecute` via spl-token) RESOLVES for the
  fresh never-holding wallet on BOTH mints (dest ATA still
  nonexistent); resolved extras are the templated AccountKey sets —
  the exact before/after contrast against the pre-flip throws ✓
- `hook.mjs status` clean on both tokens: AGTR reads fren's mirror as
  registered at the ATA-keyed record; LATCH reads fren's record with
  basis intact (13125 scaled). Observation, pre-existing and not
  window-caused: the Latch PriceFeed was last cranked ~19.7 h before
  the check (crank is permissionless via `hook.mjs crank-price`;
  operational, outside this window's scope)
- Client flips (same window): `trade-entry.mjs` holder derivation
  flipped to the ATA-keyed form; composer + trade bundles rebuilt
  into the site tree; harness L7b tripwire restored to its positive
  form — harness 44/44 against the LIVE v3 engine, site smoke 65/65,
  trade-check 74/74. Site `hook.mjs` + `launch.mjs` were still the
  pre-v3 copies and were synced from the launcher sources (the skill
  flow downloads them; the v3 skill documents migrate/merge, which
  the stale copies lacked); skill.md was already the synced v3 copy.
  Site redeployed (Railway deployment `bae4e243`, SUCCESS) and all
  four files verified byte-identical live vs the tree:
  skill.md md5 `5ae4b252…`, hook.mjs `6949c27a…`, launch bundle
  `730696d6…`, trade bundle `849edd43…`

## Costs (actuals)

- fren SOL: 1.764856346 → 1.711798305 = **−0.053058041 total**
- Permanent: the one extend, 0.0520192 SOL (programdata now 249,293 B
  — 9,952 B of headroom above the current ELF remains prepaid)
- Fees: 278 transactions ≈ 0.001395 SOL modeled (266 buffer writes
  dominate), offset by the AGTR flip's 0.0003556 SOL rent refund;
  modeled vs observed reconciles to within 559 lamports (one
  transaction's fee variance)
- Buffer float 1.21646188 SOL returned in full at the upgrade; no
  lamports stranded anywhere

## State after window 2

Engine v3 (fixed build) is the live engine. AGTR + Latch trade under
AccountKey meta lists: generic resolvers build first buys for fresh
wallets on both tokens, all pre-existing holder state sits verbatim
at its account-keyed addresses, and the AlreadyInit window edge never
materialized (the crank completed in the same session as the flips).
The v2 rollback binary remains on disk and the program's upgrade
authority is unchanged (fren) — a downgrade is still mechanically
possible, but note the state has moved: holder records now live at
account-keyed PDAs and the lists are AccountKey-shaped, so a bare
downgrade would fail closed (v2 Execute cannot read v3-keyed records)
rather than restore v2 behavior.

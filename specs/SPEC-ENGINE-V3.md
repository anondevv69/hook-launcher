# SPEC — Engine v3 Feasibility: Mint-Scoped Holder Table

Design + evidence only — no engine code changed, nothing deployed, all
trials local LiteSVM. This study evaluates Option B of
SPEC-ROUTER-COMPAT (the HookedPad shape: all holder state in
mint-scoped table accounts, every ExtraAccountMeta derivable from the
mint alone) as a full engine redesign for NEW launches. Prototype and
raw measurement output live in `research/v3-table-proto/` and are
referenced throughout; the prototype is throwaway and marked as such.

**Amendment (2026-10-16, later the same day):** §9–§10 were added
after SPEC-ROUTER-COMPAT's Option A — the AccountKey-seed minimal
fix — was put through its decisive tests (§9) and the verdict (§10)
was rewritten as a three-road comparison: (A) AccountKey-seed fix,
(B) this study's table design, (C) per-config meta-list templating
only (shipped as Phase 2; holder-state tokens stay on the custom
route). §§1–8 are unchanged from the original study.

## Headline conclusions

1. **The record shrinks more than the brief assumed.** A field audit
   (§1) finds 48 of the v2 Holder PDA's 192 bytes are dead — written
   by no code path, read by no code path, in any program in this tree
   — and `basis_den` is a constant 1 in every write that exists. The
   v3 record carries every live field, the full graduated region, AND
   the 32-byte owner key in **136 bytes** — the size of today's
   *legacy* PDA, which holds neither the key nor the graduated fields.
2. **Compute is not the problem and never was.** The prototype's
   find-or-insert + Execute-shaped update costs ~2.1k CU end-to-end at
   1k, 10k, and 100k records (worst observed probe chain: 60 slots,
   3.5k CU). Today's engine spends 21–29k CU of fixed Execute overhead
   before any holder work, and +10.5–12k extra on a first-touch buy
   (the lazy PDA-creation CPI chain) that v3 deletes entirely.
3. **Contention is a non-issue — v2 already serializes per mint.**
   The v2 meta list marks the rent vault *writable*, so every v2
   transfer already write-locks one shared account; any two transfers
   of a mint conflict today. v3's shared table changes the lock set,
   not the concurrency fact (§5).
4. **Rent is the real trade.** A table slot costs 0.000947 SOL of
   rent; prepaid at the design load factor that is 0.001352 SOL per
   holder of *capacity*, vs 0.001837 SOL per *actual* holder paid
   lazily today. The table wins only if a launch fills ≥74% of its
   usable capacity; below that, prepayment is a sunk premium for
   routing compatibility (§2).
5. **Growth is the design's weak joint, and it is manageable only by
   refusing to grow.** Changing a shard's slot count invalidates every
   record's home slot (hash % slots), so realloc growth is a rehash —
   costed in §4, non-atomic, and a state migration in everything but
   name. The recommendation is a **fixed shard set sized at launch**
   (4 shards, tiered), with spare shard entries pre-declared in the
   meta list as the only growth escape (§4, §7).
6. **Option A passes its decisive test (§9).** With the destination
   Holder PDA seeded by `AccountKey` instead of `AccountData`, the
   generic build — spl-token's resolver directly, and the DBC SDK's
   `swap2WithTransferHook` — succeeds for a fresh wallet and the swap
   lands (22/22 assertions, fixture program, seed type the only
   variable). The semantic price is real but bounded: holder state
   keys to the token account, not the owner (§9.2).
7. **Verdict (§10): a sequence, not a single road.** A now — it is
   the only road that fixes the live tokens, and it makes every new
   launch generically routable on the v2 architecture at unchanged
   rent economics. C remains the shipped floor (it already serves
   no-holder-state configs). B is deferred: its remaining edge over
   A is exact owner-keyed semantics and owner-aggregate state, at
   7.76 SOL prepaid per tier-S launch — worth revisiting only on
   the evidence listed in §10.

## 1. Field audit — who actually reads/writes the Holder PDA

Method: every byte-range access in `engine/src/lib.rs`,
`distributor/src/lib.rs`, `registry/src/lib.rs`, plus every `.mjs` in
the tree that parses holder bytes. The layout comment in the engine
(lib.rs:531–563) advertises more state than the code keeps.

| v2 offsets | Field | Written by | Read by | Verdict |
|---|---|---|---|---|
| [1] | registered | SyncRegistered (lib.rs:1129) | rules 3, 17 (582, 1631) | **live** |
| [2] | ecosystem | SyncRegistered (1130) | rule 17 (1631) | **live** |
| [6..22] | basis_num | basis bookkeeping (1906) | holder_basis (616) | **live** |
| [22..38] | basis_den | init + bookkeeping — **always the constant 1** (591, 1907) | holder_basis (divides by it) | **constant** — fold into basis |
| [38] | latched | latch gate (1809, 1846) | gate (635, 1727) | **live** |
| [39..47] | last_buy_ts | bookkeeping (1908) | — nothing, anywhere | write-only |
| [47..55] | last_sell_ts | gate (1833, 1858) | — nothing, anywhere | write-only |
| [55..63] | dump_window_start | — nothing | — nothing | **dead** |
| [63..71] | dump_sold_in_window | — nothing | — nothing | **dead** |
| [71..87] | reward_debt | — nothing | — nothing | **dead** |
| [87..103] | reward_settled_index | — nothing | — nothing | **dead** |
| [103..111] | gate_balance (rule 8) | SyncGateBalance (2096ff) | module_holder_gated | **live** |
| [111..119] | gate_sync_ts (rule 8) | SyncGateBalance | — nothing | write-only |
| [119..135] | custom slack | — nothing | — nothing | **dead** (unallocated scratch) |
| [136..144] | grad_peak | graduated gate/bookkeeping | grad path | **live** (mode 2) |
| [144..152] | grad_sold | graduated gate | grad path | **live** |
| [152..160] | grad_cap | graduated ratchet | grad path | **live** |
| [160..168] | grad_anchor | graduated paths | grad_frac_bps | **live** |
| [168..184] | grad_min_price | graduated folds | grad_frac_bps | **live** |

The reward fields deserve the explicit citation, because the layout
comment claims "distributor lazy settlement": `distributor/
INTEGRATION.md:65` records the ownership decision — **the Distributor
owns ALL reward state** (its own Claim PDA, seeds `["claim", mint,
holder]`, settled_index at Claim [65..81]); the engine's reward bytes
"stay reserved and unused". A grep of the distributor source confirms
it never names the engine's Holder PDA; its payout path reads the
Claim PDA and the holder's token balance only. The dump fields are
likewise speculative — SPEC-GRADUATED-LATCH.md:238 calls them "rule
11's future home"; rule 11 (Grudge) is unimplemented and no code
touches them. Both ranges are dropped from v3, named dead here; if
rule 11 or an engine-side settle is ever built, it gets record space
from the reserved tail (§2), not from archaeology.

`basis_den`: every write in the tree stores the value 1 and a
pre-divided scaled price in `basis_num` (init at 591; bookkeeping at
1906–1907 writes `new_basis` — already the quotient of the blend —
with den reset to 1). No path ever writes a denominator ≠ 1, so the
pair (num, den) is observationally a single u128. v3 stores one
scaled u128; equivalence is exact, not approximate, against every
live code path.

The two write-only timestamps and gate_sync_ts are *touched* by live
code, so they are carried (§2) — but flagged: nothing reads them,
and a future cleanup could reclaim 24 bytes.

## 2. (a) Record design, capacity, rent

### 2.1 The v3 record — 136 bytes, fixed stride

```
[0..32]    owner pubkey        (all-zero = empty slot)
[32]       registered u8       (v2 [1])
[33]       ecosystem u8        (v2 [2])
[34]       latched u8          (v2 [38])
[35]       reserved
[36..52]   basis u128          (v2 basis_num; den folded, §1)
[52..60]   last_buy_ts i64     (v2 [39..47], write-only)
[60..68]   last_sell_ts i64    (v2 [47..55], write-only)
[68..76]   gate_balance u64    (v2 [103..111], rule 8)
[76..84]   gate_sync_ts i64    (v2 [111..119], write-only)
[84..92]   grad_peak u64       (v2 [136..144])
[92..100]  grad_sold u64       (v2 [144..152])
[100..108] grad_cap u64        (v2 [152..160])
[108..116] grad_anchor i64     (v2 [160..168])
[116..132] grad_min_price u128 (v2 [168..184])
[132..136] reserved
```

Design notes:

- **One size for every config.** The v2 length-versioning mess
  (136-byte legacy vs 192-byte extended, lazy `ensure_graduated`
  migration funded from the rent vault) exists because graduated
  fields were bolted on. A table record cannot be length-versioned
  per holder — the stride is the layout — so v3 pays the graduated
  fields for everyone: they cost 48 of the 136 bytes, and in
  exchange the entire migration path, its rent-vault dependency,
  and its failure mode are deleted.
- **Insert-only.** Records are never deleted in v2 semantics (a
  full exit zeroes the graduated region; the PDA persists), so the
  table needs no tombstones: an unsuccessful search terminates at
  the first empty slot, which is also the insert position.
- **Lookup scheme.** Open addressing, linear probe, per shard.
  Slot home = `splitmix64(fold(owner bytes)) % slots_in_shard`;
  shard = an independent fold `% N`. Slot counts are arbitrary
  (one u64 modulo per lookup — its cost is inside the §3 numbers),
  so shards size exactly, no power-of-two rounding waste.
- **Max load factor α = 0.70 per shard**, enforced at insert
  (`count ≥ 0.70 × slots` → no insert, §4). Expected successful
  probes at α = 0.70: 2.17 (Knuth); measured 2.12–2.16 (§3).
- **Probe cap 256** (fail-closed `TableCluster`): bounds any single
  lookup at ~5.4k CU of probing. At α ≤ 0.70 a 256-run requires
  either astronomical bad luck or an attacker landing 256+ funded
  records into one probe run to grief one cluster's transfers —
  each such record costs a real buy. The uncapped alternative is
  not safer, just uglier: a worst-case full-shard scan (~71k
  probes ≈ 1.5M CU) dies by budget exhaustion instead of by an
  explicit error.

Each shard account is a 64-byte header (tag, layout version, slot
count, record count, reserved) followed by `slots` records. Shard
PDA seeds: `["htable", mint, shard_index_byte]`.

### 2.2 Capacity and rent

Rent-exempt minimum = (bytes + 128) × 6,960 lamports throughout
(verified against v2: 136 B PDA = 0.001837 SOL).

Single table (one shard), exact-fit slot counts:

| Account size | Slots | Holders @ α=0.70 | Rent (SOL) | Rent / holder of capacity |
|---|---|---|---|---|
| 10,240 B (10 KiB) | 74 | 51 | 0.0714 | 0.001400 |
| 102,400 B (100 KiB) | 752 | 526 | 0.7131 | 0.001356 |
| 1,048,576 B (1 MiB) | 7,709 | 5,396 | 7.2984 | 0.001353 |
| 10,485,760 B (10 MiB, max) | 77,100 | 53,970 | 72.9811 | 0.001352 |

Recommended form is the fixed shard set (§4) at **N = 4**; rent is
within a few hundred lamports of the single-table figure at the
same slot total (four headers + four 128-byte overheads):

| Tier | Shards × slots | Total slots | Holders @ 0.70 | Prepaid rent |
|---|---|---|---|---|
| S | 4 × 2,048 | 8,192 | 5,734 | **7.760 SOL** |
| M | 4 × 8,192 | 32,768 | 22,937 | **31.022 SOL** |
| L | 4 × 16,384 | 65,536 | 45,875 | **62.043 SOL** |

Hash skew strands a little of that: with 4 shards the fullest shard
runs ~2.3% hot at tier L (σ ≈ √μ, μ = 11,469), so effective capacity
is ~44.8k, not 45,875. At N = 16 the same slot total strands ~5% —
another reason N stays small.

### 2.3 Against today's lazy PDA rent, honestly

Today there is no launch-time holder cost: the rent vault funds each
Holder PDA as its holder arrives — 0.001837 SOL (legacy) or 0.002227
(graduated) per actual holder, forever locked in that PDA (no close
path exists). The table prepays capacity whether it fills or not:

| Actual holders | v2 PDA rent, cumulative (legacy / graduated) | v3 table (cheapest tier that fits) |
|---|---|---|
| 1,000 | 1.837 / 2.227 SOL | 7.760 SOL (S) — 4.2× / 3.5× worse |
| 5,734 | 10.53 / 12.77 SOL | 7.760 SOL (S, full) — table wins |
| 22,937 | 42.13 / 51.08 SOL | 31.02 SOL (M, full) — table wins |
| 45,875 | 84.26 / 102.16 SOL | 62.04 SOL (L, full) — table wins |

Breakeven: the table's cost per holder-of-capacity (0.001352 SOL)
beats the PDA only once a tier fills to **≥73.6%** of its usable
capacity (≥60.7% against graduated PDAs). A launch that dies at 800
holders has burned ~5.9 SOL more than v2 would have. For Locked
configs the prepaid rent is sunk permanently — there is no authority
that could close the shards and reclaim it — so tier choice is a
one-way door priced into the launch, and the launcher must disclose
it as such. This, not compute, is the cost of generic routing.

## 3. (c) Lookup/update cost — prototype measurements

Prototype: `research/v3-table-proto/vtable/` (throwaway program in
the test-hook crate pattern: native Rust, no Anchor), harness
`harness.mjs`, raw output `harness-output.txt`. It implements §2
exactly — 136-byte records, splitmix-fold home slot, linear probe,
hash-partitioned shards — and a Touch instruction that does
find-or-insert plus an Execute-shaped update (basis blend with u128
mul/div, last_buy_ts write, graduated peak/min-price/cap folds — the
recipient-side bookkeeping of `module_basis_latch`, arithmetic shape
preserved). Baseline: `baseline.mjs`, the engine trial harness's own
idioms (manual meta-tail resolution, simulated pool, cranked feed),
raw output `baseline-output.txt`. All numbers are LiteSVM
transaction-metadata `computeUnitsConsumed`; prototype figures are
total-tx CU for the single Touch instruction.

### 3.1 Prototype: table at α = 0.70

| Scale | Records / shards | Probe avg | Probe worst | Touch existing (avg) | Touch worst-probe | Touch fresh insert (avg) | Bulk insert |
|---|---|---|---|---|---|---|---|
| S1 | 1,000 / 1 × 1,429 slots | 2.12 | 34 | 2,123 CU | 2,785 CU | 2,123 CU | 305 CU/insert |
| S2 | 10,000 / 1 × 14,286 slots | 2.16 | 52 | 2,104 CU | 3,163 CU | 2,068 CU | 303 CU/insert |
| S3 | 100,000 / 2 × 71,429 slots | 2.14 | 60 | 2,315 CU | 3,532 CU | 2,286 CU | 329 CU/insert |

Probe cost is ~21 CU per step (worst-case deltas over the mean), so
even the worst chain observed at 100k records costs ~1.2k CU of
probing. Cost is *flat in table size* — the mean successful probe at
α = 0.70 is 2.12–2.16 at every scale, matching the 2.17 prediction.
Fresh inserts cost the same as updates within noise (the
unsuccessful-search premium, ~6 probes predicted at α = 0.70, is
~80 CU under a ~1,950 CU fixed floor). Nothing here grows with
holder count. (S3 runs 2 shards only because one 100k-record table
— 19.4 MB — exceeds the 10 MiB account limit; that is §4's point,
not a measurement shortcut.)

### 3.2 Baseline: today's engine (v2), rule 1

Two runs, fresh keypairs each (PDA bump-search luck moves engine CU
by ±3k between runs; ranges span both runs):

| Transfer (total tx CU / engine-program CU) | Measured |
|---|---|
| No-rule hooked transfer (the floor) | 56–77k total / 21.2–28.7k engine |
| Rule 1 LATCH buy, existing holder | 53–71k / 23.6–29.6k |
| Rule 1 LATCH buy, **first touch** (lazy PDA create) | 63–83k / 34.1–41.6k |
| Rule 1 LATCH sell (gate + latch set) | 51–69k / 22.2–28.2k |
| Rule 1 LATCH P2P (both sides' bookkeeping) | 56–74k / 23.9–31.4k |
| Rule 1 GRADUATED buy, first touch (192 B create) | 64–92k / 42.1–48.0k |
| Rule 1 GRADUATED sell (ratchet + accrual) | 52–76k / 29.9–31.4k |

Read of the baseline: Execute's *fixed* cost — structural
validation (six `find_program_address` derivations), config parse,
instruction-sysvar caller introspection — is ~21–29k CU before any
rule runs. Holder work on an existing PDA is worth only ~2–7k of
that. First touch is worth +10.5–12k on top (three system CPIs from
the rent vault: transfer, allocate, assign). In a real DBC swap
(integration-v2 logs) the engine's Execute already consumes
43.5–53.1k CU nested inside a swap whose DBC frame alone is
168.6–171.0k.

### 3.3 The comparison

| | v2 (per transfer) | v3 (per record touched) |
|---|---|---|
| Holder-state work, existing holder | within 23.6–29.6k engine CU (≈2–7k over fixed floor) | ~2.1k CU total-tx for find + full update |
| Holder-state work, first touch | +10.5–12k creation premium | identical ~2.1k (insert is free of premium) |
| Scaling with holder count | flat (PDA per holder) | flat (probe avg 2.14 at 100k) |

A v3 Execute touches ≤2 records (source, destination; often one
shard). Expected net effect vs v2: roughly neutral on warm
transfers, **10–17k CU cheaper on first-touch buys** (larger for
graduated), and never worse by more than probe variance (~1.5k).
Against the budgets that matter — 200k default (plain transfers run
51–92k today; DBC swaps already exceed it and their clients set
explicit budgets up to 1.4M) — the v3 delta moves no flow across a
budget line except first-touch buys, which move the right way.

One measurement caveat that became a design rule: an early
prototype iteration scanned a 194 KB account byte-wise to verify
emptiness and burned **~1.1M CU** doing it (~6 CU/byte through the
borrow). On-chain code must never scan a shard — no enumeration, no
audit pass, no "count the records" instruction. Anything that needs
holder lists reads them off-chain from account snapshots, exactly
as today.

## 4. (b) Exhaustion policy

Three options were evaluated. Two mechanics were proven first,
because both options depend on them:

- **Creating a big PDA in one instruction is impossible.** The
  prototype's Init used `create_account` via CPI at 194 KB and
  failed: *account data size realloc limited to 10240 in inner
  instructions*. A top-level, client-signed `create_account` at
  10 MiB succeeds (300 CU) — but a keypair account cannot be named
  by a seed-derived meta, so that path is useless for shards. The
  working PDA path is: create at ≤10,128 B, then grow with realloc
  instructions of ≤10,200 B each. The limit is **per instruction,
  and instructions stack**: the prototype grew a PDA shard from
  10,128 B to 214,128 B with 20 Grow instructions in ONE
  transaction (81,502 CU for the transaction, lamport top-ups
  included) — `harness.mjs` growtest.
- **Rehash is insert-priced.** Bulk inserts measured 303–329
  CU/record, so reinserting H records costs ≈315 × H CU plus the
  reads: 10k records ≈ 3.2M CU (~3 max-budget transactions), 45,875
  ≈ 14.5M CU (~11 transactions) — before any correctness concern.

### Option 1 — Hard cap (no growth, ever)

Inserts stop at α = 0.70 per shard; a transfer that needs a new
record fails (new error, e.g. `TableFull`). Who breaks, precisely:

- **First-time buys break.** The buy's destination bookkeeping
  (rule 1) must insert; the swap reverts atomically — the buyer
  keeps their SOL and gets an error, but the token is closed to new
  demand from that moment. On a launch curve this is the worst
  possible failure timing: cap reached mid-pump bricks growth.
- **P2P to a brand-new wallet breaks** under any config whose
  bookkeeping would insert (rule 1), and registration syncs fail
  (rules 3/17 configs), which vetoes the receive by the other door.
- **Existing holders are unaffected**: sells (source record exists;
  destination is the exempt pool vault, no insert), P2P between
  existing holders, and all gate reads proceed. The cap creates an
  incumbents-only market — existing holders can exit but nobody new
  can enter. For a memecoin that is a death state with a orderly
  wind-down attached, not a neutral limit.

As the *only* policy it is unacceptable at small tiers and merely
honest at large ones. It remains the terminal behavior of every
other option (something must happen at the true ceiling), so the
error and its semantics are specified regardless.

### Option 2 — Growth via realloc

Mechanics: proven above (stacked grows; ≈27 grow instructions for
a tier-S shard, ≈109 for tier-M, ≈218 for tier-L, batched ~20 per
transaction). Funding: the rent vault tops the shard to the new
rent minimum at each grow — the vault is already in the meta tail,
already writable, already the funder of lazy PDA creation; an
Execute that hits the insert wall could grow its own shard by one
10,200 B chunk (+75 slots) atomically inside the transfer.

The fatal problem is not the realloc, it is the **slot count**.
Home slot = hash % slots; growing a shard from S to S′ slots moves
nearly every record. Growth therefore means: allocate the new size,
then reinsert every record at its new home — a rehash. And:

- **Not atomic.** A rehash spans transactions (CU math above).
  During it, the shard holds records in two layouts; Execute must
  dual-probe or trading must pause. A record written to the old
  layout mid-rehash is silently stranded by the cutover. The only
  safe form is a trading-paused maintenance operation — for
  Creator/Agent configs the authority can schedule it; for Locked
  configs, a paused state migration the launcher performs on a
  "rules can never change" token is a promise problem, not just an
  engineering one.
- **Bounded anyway.** 10 MiB per account caps one shard at 77,100
  slots (~54k holders) no matter how many grows you stack.

Verdict on Option 2: real, costed, and rejected as the primary
policy. It survives as the *shard-construction* mechanism (launch
builds shards by stacked grows, §7) and as an emergency,
pause-and-rehash maintenance path for non-Locked configs.

### Option 3 — Fixed shard set (recommended)

N shard PDAs, all named in the meta list at launch (§7), capacity
= N × slots × 0.70, chosen from the §2 tiers. Execute derives the
shard from the owner hash — exactly one shard is *touched* per
record, so lookup cost is the single-table cost (§3, S3 confirms at
100k records). Growth within the design: none. The ceiling is
Option 1's hard cap, reached at a capacity the launcher picked and
disclosed up front.

One designed escape, specified now so the meta list can carry it:
**pre-declared spare shards.** The meta list may name N_max = 8
shard entries while only N_active = 4 exist at launch — v2 already
proves a named extra account need not exist (holder PDAs resolve
before they are created; Execute skips data_len = 0 shards).
Activating a spare later does not repartition anything if
partitioning is by hash *range* rather than `hash % N_active`:
each active shard owns a range of the hash space (ranges recorded
in Config), and activation steals a range from the fullest shard —
only records in the stolen range move, a bounded partial rehash
instead of a global one. The range machinery is **not** part of the
v3 recommendation (modulo partitioning ships; ranges are the
documented upgrade path if a launch family ever needs it), but the
spare entries cost ~nothing at launch and cannot be added later,
so v3 launches should carry them.

**Recommendation: Option 3** — fixed set, N = 4 active (+4 spare
meta entries), tier S/M/L at launch, per-shard α cap 0.70, hard-cap
error as the terminal semantics, realloc reserved for construction
and emergencies.

## 5. (d) Contention

Write-lock sets per transfer:

- **v2:** source token account, dest token account, source Holder
  PDA, dest Holder PDA, **rent vault**, (venue accounts on swaps).
- **v3:** source token account, dest token account, shard(src),
  shard(dst) — usually distinct, one account when they collide —
  rent vault, plus the other N−2 shards, which sit in the account
  list as writable because the resolver includes the whole tail.

The comparison that matters: **the rent vault is writable in the v2
meta list, and every Execute carries it.** Any two transfers of the
same mint therefore conflict on a write lock *today*; Solana's
scheduler already serializes same-mint transfers at the lock level
before v3 enters the picture. DBC swaps additionally serialize on
the pool vaults, as they do today. v3 changes which accounts are
hot, not whether the mint is single-writer — because it already is.

Honest residuals:

- **Lock-set size grows** by N−2 accounts per transfer (10 tail
  entries at N = 4 active + spares vs 7 today). Scheduling overhead
  is real but second-order.
- **Loaded-data size is the one number not measured here.** Every
  transfer loads all shard accounts: ~1.1 MB total at tier S,
  ~4.5 MB at M, ~8.9 MB at L. Agave meters loaded account data per
  transaction (a settable limit; clients that don't set it get a
  default). Tiers S/M sit far below any plausible default; **tier L
  must not ship until a swap at ~9 MB loaded is proven through the
  real DBC SDK path** — this is an open verification item, not a
  known blocker.
- **Cross-mint parallelism is untouched** (locks are per-mint
  accounts), and block-level throughput for one mint remains bound
  by block CU (48M) long before lock scheduling: at ~250k CU per
  swap the ceiling is ~190 swaps/block whether the locks conflict
  or not. P2P transfers (~60–75k CU) ceiling ~1,600/s serialized —
  above any plausible demand for a single launch token, and equal
  to today's effective ceiling given the rent-vault lock.

## 6. (e) Rule portability matrix

| Rule | Verdict | What changes |
|---|---|---|
| 1 Basis Latch — LATCH / LIVE | **ports cleanly** | Basis is one u128 (§1). Gate reads source record, bookkeeping writes dest record; the two may sit in different shards — both are in the tail, both writable. Stale-feed, BasisMissing (now: no record), and latch-set semantics are byte-for-byte the v2 logic over record offsets. |
| 1 Basis Latch — GRADUATED | **ports with change** | The graduated fields live in every record (§2), so: `ensure_graduated` and the 136→192 migration are deleted; `holder_create_size` is deleted; full-exit zeroing zeroes record bytes [84..132] instead of account bytes [136..192]. Gate math (`grad_frac_bps`) is unchanged. This is the single largest code deletion in v3. |
| 3 Agent-Only | **ports with change** | The mirror bytes move to record [32]/[33]. A missing record *is* unregistered — the v2 dance (lazily create the PDA, then read `registered = false`, with its `RentVaultUnderfunded` failure mode, trial T3b) collapses to find → none → `NotRegistered`. Checks never insert (§9, change 3), so a vetoed first touch consumes no slot. |
| 7 P2P Toggle | **ports cleanly** | Reads no holder state (caller context only). No record is touched; a P2P-only token's table stays empty forever. |
| 8 Holder-Gated | **ports with change** | `SyncGateBalance` writes gate_balance/gate_sync_ts into the destination's record, inserting it if absent (prepaid — the caller-pays-PDA branch is deleted). Execute's same-transaction adjacency introspection is instruction-level and unchanged, as is the client-surface limitation: venues that resolve only the meta tail cannot sync, so rule-8 transfers remain a launcher-surface feature that fails closed elsewhere. |
| 9 Max Wallet | **ports cleanly** | Reads the destination token account and mint supply; never touched holder state. |
| 17 Ecosystem Gate | **ports with change** | Same move as rule 3: record bytes [32] + [33] read from one record in one borrow — the v2 invariant "both mirror bytes come from the same Registration snapshot" is preserved trivially. Error split (`NotRegistered` vs `WrongEcosystem`) unchanged. |

### Client flows

- **InitializeHolder — deleted.** There is no per-holder account to
  initialize. A wallet's record appears on its first successful
  state-touching event (rule-1 destination bookkeeping, or a sync).
  Launch/trial flows that pre-created holders simply lose that step.
- **SyncRegistered — retargeted, not redesigned.** Accounts swap the
  Holder PDA for the owner's shard (writable). The client computes
  the shard from the owner with the same splitmix fold the program
  uses — the hash function becomes part of the client surface
  (launcher, skill, trade page), and a wrong shard fails closed
  with a shard-validation error, discoverable in one trial. Both
  authorization paths (config-authority direct set; permissionless
  mirror from a validated Registration PDA) are untouched, as is
  the reason the mirror exists: a Registry-program PDA still cannot
  be derived into the hook's tail. Sync-lag semantics are unchanged
  — v3 makes the sync cheaper, it does not make it unnecessary.
- **SyncGateBalance — retargeted** the same way (shard in place of
  Holder PDA); its next-instruction binding is untouched.
- **First touch inside Execute — who pays? Nobody, per record.**
  The insert writes into prepaid space; the transfer's payer pays
  only the transaction fee they already pay. There is no growth
  event to fund in the fixed-shard design. The rent vault's
  steady-state job disappears with it (it remains in the tail,
  §7 — still the funder of last resort for the Option-2 emergency
  path, and removing it would renumber Execute's accounts for no
  benefit).
- **Distributor interplay — none, by the §1 ownership split.** The
  Distributor never read or wrote engine holder state; its Claim
  PDAs are its own program's PDAs, created by its own instructions
  from client-passed accounts (never resolver-derived from token
  account contents — which is why they never had the first-touch
  problem). Its index, first-touch rule, and lazy settlement are
  untouched. The one thing that changes is the *extras list its
  payout CPIs must forward* (the HOOK-EXTRAS-FIX surface): under v3
  that list is computable from the mint alone — no token-account
  reads, no existence checks — so the fix's client side gets
  simpler, not harder.

## 7. (g) The v3 meta list

Exactly N_max + 5 entries, every one derivable from the mint and
the program id alone. No `Seed::AccountData` anywhere — that is the
whole point. For N_active = 4, N_max = 8 (4 active + 4 spare, §4):

| # | Account | Seeds / literal | Writable |
|---|---|---|---|
| 0 | Config PDA | `["config", mint]` | no |
| 1..8 | Shard PDAs i = 0..7 | `["htable", mint, <i as 1-byte literal>]` | yes |
| 9 | Rent vault PDA | `["rentvault", mint]` | yes |
| 10 | Price feed PDA | `["price", mint]` | no |
| 11 | System program | literal pubkey | no |
| 12 | Instructions sysvar | literal pubkey | no |

Entries 1–4 are the active shards at launch; 5–8 name PDAs that do
not exist yet (resolution yields the address; Execute ignores
data_len = 0 shards and partitioning never selects them while
inactive). Stored size ~13 entries vs today's 7 (261 B / 0.002707
SOL) — rent stays in the 0.004 SOL class. Execute's account count
grows from 12 to 18; composed swap transactions gain a handful of
account keys (~32 B each in the message), immaterial next to the
swap's existing account list.

Shard construction at launch (the §4 mechanics): for each active
shard, InitializeShard creates the PDA at 74 slots (10,128 B — the
largest create that fits the per-instruction limit with the 64 B
header), then GrowShard instructions of +75 slots stack in batches
of ~20 per transaction until the tier size is reached (tier S: 27
grows ≈ 2 transactions per shard; M: 109 ≈ 6; L: 218 ≈ 11), the
launcher funding each grow's rent delta from its own wallet (not
the rent vault — the vault's float is for operations, and launch
costs belong to the launcher). Total launch transactions grow by
~8 (S) to ~44 (L); all are ordinary, retryable, pre-trading steps.

## 8. (f) Migration — new launches only; AGTR and Latch stay v2

Retrofit is rejected on mechanics, not preference:

1. **The meta list is the easy part, and it still isn't easy.**
   The list is a per-mint PDA written once at launch (L4). The
   engine has no instruction that rewrites it; Token-2022's hook
   interface offers no update path. Adding one means an engine
   upgrade — possible (upgrade authority is retained) — but it
   buys only the right to point the mint at table accounts that
   are still empty.
2. **The state cannot follow atomically.** Existing state lives in
   per-holder PDAs keyed `["holder", mint, owner]`. There is no
   on-chain enumeration of holders; the holder set is knowable
   only off-chain (getProgramAccounts snapshots, transfer
   history). Copying records is a multi-transaction operation
   performed *while the token trades*: a buy landing mid-copy
   writes basis to a v2 PDA the copy already passed, and the
   cutover either strands it or double-counts it. Basis, latch,
   graduated positions, and both registry mirrors are all live
   mutable state — there is no quiescent moment to snapshot
   against short of halting trading, which a Locked config cannot
   even signal.
3. **Everything downstream is keyed to the old shape.** The
   Distributor's Claim PDAs are independent (they'd survive), but
   the launcher's doors — skill, trade page, sync flows — derive
   Holder PDAs per wallet for AGTR and Latch today; a cutover
   forks every client by mint vintage forever, for two tokens
   whose remaining curve life is finite (release graduation
   revokes the hook entirely; `never` tokens keep v2 semantics
   that already work for existing holders — the router gap bites
   only *first-time* buyers, and the doors package already routes
   those).

So: v3 is greenfield. If it ships, it ships as a new program (or
an upgrade whose Config version byte keeps v2 mints on v2 code
paths bit-for-bit — the meta lists of existing mints still resolve
Holder PDAs, and those code paths are their permanent runtime).
AGTR and Latch are never migrated, and nothing in this study
should be read as a plan to migrate them.

*Amendment note:* "never migrated" is scoped to the **table** —
the state format and program both change there. It does not apply
to Option A's retrofit (§9.3), which changes no format and no
program architecture: AGTR and Latch stay on the v2 engine, with
new seed types in their lists and their holder bytes copied
verbatim to ATA-keyed addresses. The two statements coexist
because the migrations are different operations.

## 9. Option A — the AccountKey-seed minimal fix (amendment)

Origin: SPEC-ROUTER-COMPAT, Option A. The change, stated in source
terms against the current tree: in `build_metas`
(`engine/src/lib.rs:265`), the destination Holder entry's third seed
`Seed::AccountData { account_index: 2, data_index: 32, length: 32 }`
becomes `Seed::AccountKey { index: 2 }` — the destination token
account's *address*, which a route builder knows (for ATA buys it is
a pure function of owner + mint) before the account exists. Holder
PDAs re-derive as `["holder", mint, dest_token_account]`. Nothing
else in the list changes. §9.1 runs the brief's decisive test 1;
§9.2 prices the semantics; §9.3 runs decisive test 2 (retrofit).

### 9.1 Decisive test 1 — resolver + DBC swap, fresh wallet

Fixture: `research/akfix/` (throwaway). `akhook` is a minimal hook
in the test-hook pattern publishing the engine-v2-shaped 7-entry
superset list, with the src/dst holder entries' third seed selectable
at init (AccountData or AccountKey per side) so seed type is the
only variable; its Execute validates the resolved holder PDAs
against the derivation the published mode implies and logs them.
Harness `akfix.mjs` drives the *real* resolution path two ways:
spl-token's `addExtraAccountMetasForExecute` directly (the function
the DBC SDK calls internally), and the DBC SDK's
`swap2WithTransferHook` against a real DBC pool, exactly as the
Phase 2 templating suite drives it (its negative control is
replicated inside the fixture as case D0). Fresh buyer = funded
wallet, no ATA at build time, in every case. Result: **22/22**
(`akfix-output.txt`).

| Case | Build (fresh wallet) | Landing |
|---|---|---|
| M0 control: src AD, dst AD | **throws `TokenTransferHookAccountDataNotFound`**; succeeds once the ATA is pre-created (cause isolated) | — |
| M1: src AD, **dst AK** | **succeeds**; resolved dst holder == `["holder", mint, dest ATA]`, src holder == `["holder", mint, src owner]` | transfer lands with the ATA created in the same tx; Execute validates the AK-derived PDA (log evidence) |
| M2: **src AK, dst AK** | **succeeds**; src holder == `["holder", mint, source ATA]` | lands; Execute validates |
| D0 control (DBC): dst AD | `swap2WithTransferHook` **throws `TokenTransferHookAccountDataNotFound`** — the Phase 2 negative control, reproduced with seed type as the only difference | — |
| D1 (DBC): AK/AK | **succeeds** | generic bundle lands through the real swap; buyer receives tokens; Execute runs mid-swap and validates `["holder", mint, buyer ATA]` |

Three precisions the table earns:

- **The failure and the fix both live at the resolution step,**
  not at execution: AD cases throw inside the build call before
  any transaction exists; AK cases pass resolution and then also
  execute — Token-2022 resolves the AK-derived PDA at swap time
  and the fixture's Execute confirms it is the account the new
  derivation predicts, with the ATA born earlier in the same
  transaction. There is no second, execution-side surprise.
- **The source entry is mechanically free either way** — the
  source account always exists (the sender holds the tokens), so
  AccountData never throws on the source side, and AccountKey
  resolves identically. M1 proves a mixed list works. But see
  §9.2: a mixed list is *semantically incoherent* (bookkeeping
  would write the account-keyed record while the sell gate reads
  the owner-keyed one), so the source switch is not optional —
  it is mandatory, and it costs nothing.
- **Nothing about BasedBot/generic routers is assumed here:** the
  path exercised is the standard resolver + the DBC SDK, which is
  the path that produced the 2026-10-16 root-cause finding. (Per
  the established router-compatibility rule, mint-scoped derivation
  is what generic routers need; an AccountKey seed is a function
  of the instruction's own accounts, so it satisfies the same
  static-derivation property from the resolver's side.)

### 9.2 Semantic cost — holder state keyed by token account

The brief's framing is correct and worth sharpening: under A, the
unit of holder identity becomes the **token account**, everywhere
`holder_pda(mint, owner)` appears today — the two meta entries,
Execute's validation (lib.rs:1689–1690), InitializeHolder,
SyncRegistered, SyncGateBalance, and the lazy-creation paths. The
PDA is only ever a state container located by derivation: Execute
already computes `src_owner` / `dst_owner` by reading the token
accounts' data (`token_owner()`), and every rule's logic — exemption
checks, gate reads, basis blends — consumes those owners, never the
PDA's key. No rule logic needs the PDA to be owner-keyed; only its
address changes. What that costs, case by case:

**(i) The canonical ATA case — equivalent, no asterisk.** An ATA
address is a pure function of (owner, token program, mint): one ATA
per owner per mint. For ATA holdings — every door this platform has
(BasedBot, the skill flow, the trade page, generic routers) — the
account-keyed PDA is a relabeling of the owner-keyed one: same
cardinality, same state, same behavior. Execute still learns the
owner at runtime from the destination account's data (the account
exists by then — buys create it in the same transaction, as D1
shows), so rule logic that speaks about owners is untouched.

**(ii) Same owner, second token account — state fragments; basis
carries, latch/vesting do not.** Trace rule 1 on a transfer from
the owner's ATA (record R₁: basis B, latch/grad state) to the same
owner's second account (record R₂, empty):

- *Basis carries correctly.* Bookkeeping prices a non-exempt-source
  receive at the *source record's* basis (the wallet-to-wallet carry
  rule), and blends into R₂ against R₂'s old balance of zero — so
  R₂'s basis comes out exactly B. The price gate therefore behaves
  identically on a later sell from account 2.
- *The latch does not carry.* R₂'s `latched` byte is 0. In LATCH
  mode this holder is *more* locked than under owner-keying, not
  less: a dip they already survived must be re-observed from
  account 2 before it unlocks. Nobody gains by resetting a latch —
  it is a permission, not a debt.
- *Graduated state restarts.* R₂'s peak/anchor/min_price/sold/cap
  start at zero; the position lazily re-opens on account 2's first
  gated sell with a fresh anchor. This is the one genuinely
  exploitable seam: sell up to the earned cap from account 1, move
  the remainder to account 2, and a *second* earned-cap schedule
  starts on the same economic position — the cap multiplies by the
  number of accounts cycled.
- *Judgment: strictly weaker than owner-keying, by a small and
  mostly theoretical margin.* The identical multiplication is
  available today via fresh *wallets* — wallet-to-wallet transfers
  carry basis to any recipient by design, a new keypair is free,
  and nothing in the rule stack has ever tied state to a person.
  Account-keying lowers the reset cost from "new keypair" to "new
  token account" — both are ~zero, permissionless, and one
  transaction. The realistic deltas are narrower than the
  theoretical one: custodial/bot arrangements that can open token
  accounts but not wallets get the reset more conveniently, and
  honest multi-account holders (a non-ATA wallet account beside
  the ATA) get fragmented state and a fail-closed surprise (a send
  from a never-funded-record account reads as BasisMissing) until
  they merge (below). This is a fidelity tax on an edge case, not
  a new hole in the common one.
- *Mitigation — a SyncHolder merge instruction* (the brief's
  sketch, made concrete). Accounts: `[owner(signer), mint, config,
  src_token_acct(ro), dst_token_acct(ro), src_holder(w),
  dst_holder(w), rent_vault(w), system]`. It validates both token
  accounts belong to the same owner and mint, derives both holder
  PDAs from the *account keys*, creates the destination record if
  absent (rent-vault funded, the existing ensure-shape), merges
  conservatively — registered/ecosystem from whichever record has
  them, latched = OR, basis = balance-weighted blend against live
  token balances, anchor balance-weighted, peak = max(both peaks,
  combined balance), sold = sold₁ + sold₂ (both histories charged),
  cap = min(cap₁ + cap₂, merged peak) (never more than was earned,
  never more than the position), min_price = min of the nonzero
  pair — then closes the source PDA and refunds its rent to the
  vault. One instruction, ~25–35k CU class, no net rent. It repairs
  fragmentation for honest holders; it cannot and does not try to
  close the hopping seam, which is opt-out by construction (the
  hopper simply never merges) — exactly as under wallet-hopping
  today.

**(iii) The syncs re-target from wallets to ATAs.** SyncRegistered
takes `(owner, registration PDA)` today and writes the mirror into
`holder[owner]`. Under A the mirror must land where Execute reads
it for the account that will receive: `holder[ATA(owner)]`. The
sync therefore derives the ATA itself —
`find_program_address([owner, token_program, mint], ata_program)`,
a derivation the engine already performs for rule 8's gate account —
and validates the passed holder PDA against it. The Registration
PDA, both authorization paths, and the mirror semantics are
unchanged; registration remains a *wallet* property, mirrored per
account. Consequence, stated plainly: registration now binds to
the ATA. A receive into a *non-ATA* account of a registered,
synced wallet reads an empty record and vetoes — fail-closed
friction, repairable with an account-targeted sync variant
(SyncRegistered takes an appended token account and mirrors into
*its* record, authority still flowing from the same Registration
PDA). SyncGateBalance is the easier move: it already receives the
destination token account (it must, to bind the sync to the
following transfer), so its holder derivation switches from the
owner parameter to that account's key with no flow change at all.

**(iv) Distributor — untouched, confirming §1.** The Distributor
owns its state outright (Claim PDAs keyed `["claim", mint,
wallet]`, created by its own instructions from client-passed
accounts — never resolver-derived, never a reader or writer of
engine holder state). Account-keying changes nothing in its code,
its accounts, or its math; the only touchpoint is the extras list
its payout CPIs forward, which becomes the AK list mechanically.

### 9.3 Decisive test 2 — can AGTR / Latch be retrofitted in place?

**Not with the deployed program; yes with one upgrade + a migration
crank. The state-copy problem has a clean solution; stranding and
in-Execute lazy copy do not.**

- **No deployed instruction rewrites the meta list.** The deployed
  engine (184,264 B build, deploy/DEPLOY-RECORD.md) dispatches the
  SPL interface discs plus tags 0–8. `InitializeExtraAccountMetas`
  rejects an initialized list (`AlreadyInit` on `data_len > 0`,
  source-verified). `UpdateConfig` rewrites the Config, never the
  list — and both live configs are Locked, so it is doubly
  unavailable. Tag 9 (`RefreshExtraAccountMetas`) exists only in
  the Phase 2 *source*; it is **not deployed**, and even it only
  recomputes the templated set from config — it has no seed-type
  switch. So SPEC-ROUTER-COMPAT's question 2 answers itself: the
  list cannot be edited in place by any authority fren holds short
  of upgrading the program. Fren does hold the engine's upgrade
  authority (unburned, per the deploy record) — the fold-bundle
  upgrade of 2026-10-16 is the working precedent.
- **The upgrade is small.** AK seed construction in the meta-list
  builder; Execute deriving expected src/dst holder PDAs from the
  token account keys; the sync/init derivations retargeted per
  §9.2(iii); a list-rewrite instruction (the Phase 2 refresh shape
  — permissionless, its output a pure function of config under the
  new build — occupying the free tag 9) so each live mint's list is
  flipped in one transaction (same entry count; the list account
  does not even change size); and `MigrateHolder` (below). Against
  the deployed binary this is a patch measured in hundreds of
  bytes of logic, not a redesign.
- **The holder-state move: pre-migrate by crank, then flip.**
  Existing PDAs sit at `["holder", mint, owner]`; under A the same
  bytes must live at `["holder", mint, ata]`. The layouts are
  identical — only the address changes — so migration is a verbatim
  copy:
  - *AGTR (rules 3 + 9):* the only live state is the
    registered/ecosystem mirror. Migration is a permissionless
    re-run of SyncRegistered path (b) per registered wallet,
    writing the mirror to the ATA-keyed PDA. No copy instruction
    needed; unregistered holders have nothing to move.
  - *Latch (rules 1 GRADUATED + 9):* basis, latch, and the
    graduated position are real state and get a `MigrateHolder`
    instruction (permissionless): accounts `[mint, config, owner,
    owner_ata(ro), old_holder(w), new_holder(w), rent_vault(w),
    system]` — validates the ATA's owner/mint fields, derives both
    PDAs, creates the new one at the config-correct size
    (vault-funded), copies the bytes verbatim, then closes the old
    PDA and refunds its rent to the vault (net rent ≈ 0 at equal
    sizes).
  - *Enumeration is exact, not best-effort:* every token account of
    the mint is enumerable off-chain (Token-2022 program accounts
    filtered by mint), each names its owner, and an RPC read says
    whether an old-style holder PDA exists. The crank list is
    complete at snapshot time.
  - *Sequencing makes it zero-downtime:* run the crank **before**
    flipping anything (MigrateHolder writes new PDAs nothing reads
    yet; SyncRegistered's AK form likewise), then deploy the
    upgrade and rewrite the two meta lists — the atomic step — then
    let stragglers (a holder PDA created between snapshot and flip;
    a non-ATA holder) self-heal: their first post-flip transfer
    fails closed (`BasisMissing` / `NotRegistered`), and anyone can
    run MigrateHolder for them at any time, since it stays in the
    program permanently. Doors surface it as a one-click repair on
    exactly that error.
- **Rejected: stranding.** Leaving state at the old addresses means
  Latch holders wake up to `BasisMissing` — fails closed, so they
  cannot sell balances they hold, and a fresh buy would blend
  against a zero recorded basis for their stranded balance,
  silently repricing their entry. It also strips earned graduated
  caps. That is a state seizure by upgrade when a verbatim copy
  costs one instruction; not acceptable.
- **Rejected: lazy copy inside Execute.** The old destination PDA
  would have to ride the meta list as an extra entry during the
  transition — but its address is a function of the owner, which
  lives in the destination account's *data*. Seeding it requires
  `AccountData` over the destination account, which is precisely
  the resolution failure being fixed: fresh wallets would throw
  again for the whole transition. The old *source* PDA is
  expressible (the source account always exists), so a half-lazy
  scheme — copy on sells, crank on buys — is constructible and
  strictly worse than the crank: two mechanisms, one of them
  temporary code in the hot path, for a holder set the crank
  already enumerates exactly. (§8's rejection of *table*
  migration stands untouched: that one had no exact enumeration
  of live state under trading and no verbatim-copy target; this
  one has both, because the state format does not change.)
- **Cost, against the fold precedent.** The 2026-10-16 stage-2
  wave — two program upgrades *with programdata growth*, ~330
  transactions, buffer floats fully refunded — netted **0.1752 SOL
  permanent**. The A retrofit is strictly smaller: one program,
  a patch that should fit the programdata headroom the wave-2
  overshoot left (+7,472 B; worst case one SIMD-0431 minimum
  extend ≈ +10,240 B ≈ 0.0713 SOL), a full buffer upload (~220
  chunk transactions ≈ 0.002–0.005 SOL of fees, ~0.94 SOL float
  refunded on buffer close), two one-transaction list rewrites,
  and crank fees of ~5,000 lamports per migrated holder. Total
  permanent: **≈0.005–0.08 SOL**, versus Option B's retrofit
  price, which §8 established is not "expensive" but
  *impossible*, and versus doing nothing, which leaves both live
  tokens custom-route-only forever.

## 10. Verdict — three roads, sequenced

| | **A — AccountKey seed** | **B — holder table (§§1–8)** | **C — templating only (shipped, Phase 2)** |
|---|---|---|---|
| Generic-router compatibility | **All configs, holder rules included** — proven §9.1 (resolver + real DBC swap, fresh wallet) | All configs — by construction (fully mint-derived list); unproven in a swap fixture | **No-state configs only** (e.g. Max-Wallet); holder-state configs still throw for fresh wallets (Phase 2 negative control) |
| Semantic fidelity | v2 semantics except holder identity := token account: fragmentation across an owner's accounts; latch/grad resets per account (already available per wallet today); syncs bind to the ATA (§9.2) | **Exact** — owner-keyed records, all live fields, syncs retargeted only in address | **Exact** — no semantic change at all |
| Engineering size | **Days**: one seed constructor + derivation changes + list rewrite + MigrateHolder + sync retarget + trials | Weeks: new layout, lookup, launcher shard-build phase, new client hash surface, new program (§§2–7) | **Done** (Phase 2); the floor everything else builds on |
| Per-launch rent | Unchanged: lazy per-holder PDA (0.001837 / 0.002227 SOL), vault-funded as today | **Prepaid**: 7.760 SOL (tier S, 5,734 holders) before the first buy; wins only ≥73.6% fill (§2) | Unchanged (lazy PDA rent where holder state exists) |
| Live-token retrofit | **Yes** — one upgrade + pre-migration crank + list flip, ≈0.005–0.08 SOL permanent (§9.3) | **No** — §8 (no enumeration under trading, no atomic cutover, format changes) | Nothing to retrofit; AGTR/Latch keep the custom route forever |
| Risk | Medium-low: the change is small and now test-proven; the residual risk is semantic (§9.2) and social (a "Locked" token's list changes seed type via upgrade — the rewrite is provably a pure function of config, but the *capability* must be disclosed) | Medium: new program, capacity ceiling is a one-way door, tier-L loaded-data question (§5) open | Low — but it caps the platform's reach: every holder-rule token stays behind the doors package |

**Recommendation: A now; C as the standing floor; B deferred, not
cancelled.**

A composes with C rather than replacing it: templated lists (C)
decide *which* extras a config publishes; under A, the holder
entries they publish carry AccountKey seeds. Together they give
every config — stateless or holder-state — a generically resolvable
list, on the architecture that is already deployed, at the rent
economics already in production, and they are the only combination
that fixes AGTR and Latch instead of routing around them. B's
specified changes (§§2–7: 136-byte record, fixed 4+4 shard set,
α = 0.70 insert cap, probe cap 256, insert discipline, shard-build
launch phase) remain the correct blueprint *if* B is ever built —
the CU and capacity work in §§2–3 is not wasted — but after §9.1,
B's routing prize is already collected by A, and what remains to B
is exact owner-keyed semantics and on-chain owner-aggregate state,
at 7.76 SOL prepaid per launch and a hard capacity ceiling. That
is not a trade to make pre-emptively.

**Evidence that would change the ordering:**

- §9.1 had failed (AccountKey rejected or mis-resolved by the
  standard path) → A dies; the ordering becomes C for live tokens,
  B for new launches. It did not fail — but any *future* resolver
  change that breaks AccountKey derivation reopens this instantly,
  and B's fully-mint-derived list is the hedge.
- Graduated-cap multiplication via account/wallet hopping observed
  in practice on a live token (not merely constructible) → the
  §9.2 seam stops being theoretical; B (or an owner-keyed state
  requirement for rule 1 GRADUATED configs specifically) moves up.
- A product requirement for owner-aggregate on-chain state
  (cross-account position limits, on-chain holder enumeration) →
  only B's single-account shape provides it; A cannot grow into it.
- Launches routinely projecting >10k holders with confident fill →
  B's prepaid rent beats A's certain per-holder rent at scale
  (§2.3's breakeven flips from gamble to arithmetic).

Deciding numbers, all measured or source-verified in this study:
A's test **22/22** including a landed generic DBC swap; B's record
**136 B**, tier S **5,734 holders / 7.760 SOL prepaid**, holder
work **~2.1k CU flat to 100k records**; A's retrofit **≈0.005–0.08
SOL permanent** against the 0.1752 SOL two-program precedent;
C's coverage boundary at exactly the configs whose rules need no
holder state.

## Appendix — evidence index

- Field audit: `engine/src/lib.rs` (layout comment 531–563; writes
  at 591, 1129–1130, 1833, 1858, 1906–1908; reads at 582, 616, 635,
  1631, 1727); `distributor/INTEGRATION.md:65` (reward ownership);
  `distributor/src/lib.rs` (Claim PDA layout, payout path).
- Prototype: `research/v3-table-proto/vtable/` (program),
  `harness.mjs` (fill + touch + growtest), `harness-output.txt`
  (raw results: probes, CU at 1k/10k/100k, grow stacking proof).
- Baseline: `research/v3-table-proto/baseline.mjs`,
  `baseline-output.txt` (engine v2 rule-1 CU, total + program-only,
  two runs).
- In-situ swap CU: `integration/dbc-engine-integration-v2-output.txt`
  (engine 43.5–53.1k nested; DBC frame 168.6–171.0k).
- Prior costing this study supersedes: SPEC-ROUTER-COMPAT Option B
  (232 B/record estimate; the 136 B record and the rent-vault lock
  finding revise its rent and contention rows). Its recommendation
  — evaluate A first — is the one the amendment (§9) carried out;
  its outcome (§9.1: A passes) is what reorders the verdict in §10.
- Option A decisive test 1: `research/akfix/akhook/` (fixture
  program, mode-selectable seed types), `research/akfix/akfix.mjs`
  (resolver-level + DBC-level cases), `research/akfix/
  akfix-output.txt` (22/22; captured `TokenTransferHookAccountDataNotFound`
  on both AccountData controls). Phase 2's independent negative
  control: `integration/dbc-templating.mjs` §B.
- Retrofit facts (§9.3): deployed engine instruction set and
  `AlreadyInit` guard — `engine/src/lib.rs` (dispatch; init-metas)
  read against `deploy/DEPLOY-RECORD.md` (deployed build 184,264 B,
  tags 0–8; tag 9 exists only in the Phase 2 source); upgrade
  precedent and stage-2 net cost (0.1752 SOL, floats refunded) —
  `deploy/UPGRADE-LAUNCH-RECORD-2026-10-16.md`.

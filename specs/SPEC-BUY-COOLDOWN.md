# SPEC — BUY COOLDOWN (engine rule 18)

**Status:** SPEC ONLY — not built, not trialed, not deployed. Written
2026-10-23 as the pilot for agent-authored rules (see the companion
bounty draft, `RULE-18-BOUNTY-DRAFT.md`). Implementation, trial, engine
upgrade, and any proof launch each need their own go, in that order —
the same gates every prior rule shipped through.
**Design anchor:** a launch's first minutes are when one funded wallet
with a buy loop does the damage. Rule 18 makes that wallet wait between
buys. It is a rate limit, not an identity check — §9 states exactly what
it can and cannot stop, and the catalog copy must never claim more.

---

## 1. The idea in one paragraph

When a token's config enables Buy Cooldown, every **counted buy** (defined
precisely in §2) stamps the buyer's Holder record with the time of the
buy. A later counted buy into the same Holder record is vetoed while
`now − last_buy < cooldown_secs`. Sells are never gated. Wallet-to-wallet
receives are never gated and never stamp. The rule is one timestamp of
state, one comparison, one veto — deliberately the smallest rule that
kills the single-wallet buy loop.

## 2. What counts as a buy (the counted-transfer definition)

The hook cannot see "a buy"; it sees a transfer with a caller context.
Rule 18 adopts the engine's established venue-receive shape — verbatim
the definition rule 11's receive leg already enforces against
("venue → non-exempt destination"; "P2P receives are not buys"):

A transfer is a **counted buy** iff ALL of:

1. `ctx.venue_context == true` — the executing top-level program is on
   the config's venue allowlist (for DBC-path tokens: the Meteora DBC
   program), as computed by Execute's caller validation;
2. the source is **exempt** (`cfg.is_exempt(src_owner, source)` — the
   pool/venue vault side of the trade);
3. the destination is **not exempt** (`!cfg.is_exempt(dst_owner, dest)`).

Everything else is out of scope, by explicit decision:

| Transfer shape | Counted? | Gated? | Why |
|---|---|---|---|
| Curve/venue buy (exempt src → wallet dst) | **Yes** | **Yes** | The thing the rule exists for |
| Sell (wallet src → exempt dst) | No | No | A holder must always be able to exit; gating sells traps positions and no other rule does it |
| P2P receive (venue_context = false) | No | No | Indistinguishable from a gift; and if P2P stamped, anyone could grief-reset a victim's cooldown by sending them 1 token |
| Distributor payout (Distributor top-level, direct-transfer class) | No | No | Fee payouts are not buys; rules must not tax settlement with a trade gate |
| Exempt destination (pool/fee vault receives) | No | No | House convention: exempt accounts always pass (rules 3/4/8/9/17) |
| Self-transfer (source == dest) | No | No | House convention (rule 11 returns early) |
| Zero-amount transfer | No | No | Execute returns before dispatch (existing) |

**Trade-off, stated plainly:** accumulation that never touches an
allowlisted venue (OTC deals, P2P transfers) is not slowed. That is the
same boundary rules 4 and 11 already live with, and it is the price of
never gating a gift. The alternative — counting every receive — makes
the token hostile to ordinary transfers and hands out a griefing
vector. Rejected.

## 3. Model choice: last-buy cooldown (not buys-per-window)

**Primary (and only v1) model:** one timestamp per Holder record; a
counted buy is allowed iff `now − cd_last_buy_ts >= cooldown_secs`
(pass at equality), and a successful counted buy rewrites the stamp to
`now`.

Rejected for v1: buys-per-window (e.g. "3 buys per 10 minutes"). It
needs window-start + counter state, invites boundary disputes (rolling
vs fixed windows, partial-window resets), and duplicates accounting
machinery rule 11 already owns on the sell side. If a real launch ever
needs it, params carry a mode byte (§5): mode 1 is reserved for the
windowed variant and is **rejected at config write** until a build
implements it — the registry's fail-at-write discipline, so no config
can ever claim behavior Execute would skip.

## 4. State design — Holder PDA v5 region

Holder records are length-versioned (136 legacy / 192 graduated /
224 v4) and every region is namespaced to the rules that own it. Rule
18 follows the pattern exactly — a new region beyond every existing
byte, so no live record changes meaning:

- New size constant `HOLDER_SPACE_V4 = 240`.
- `[224..232]` `cd_last_buy_ts i64` — unix time of this record's last
  **counted** buy; 0 = never (a fresh record passes its first buy by
  construction).
- `[232..240]` reserved (windowed-mode state, if mode 1 is ever built).

Mechanics, all inherited patterns:

- `holder_create_size(cfg)` returns 240 when an enabled rule 18 is in
  the config (checked before the rule-13 → 224 and rule-1-graduated →
  192 branches; sizes are a max, never additive).
- Records born smaller under other configs grow lazily on the first
  counted buy via an `ensure_v5_region` in the image of
  `ensure_graduated` / `ensure_v4_region`, rent-vault funded.
- Creation/growth payer is the config's **rent vault**, as for rules
  3/13/17. Rent for a 240-byte record: (240 + 128) × 6,960 =
  **2,561,280 lamports ≈ 0.00256 SOL** (the 224→240 growth delta is
  111,360 lamports). Launch configs already fund the vault for exactly
  this class of lazy creation.
- **The stamp survives a full exit.** Selling everything does not
  close the Holder record and does not clear the stamp: buy → dump →
  rebuy inside the cooldown still vetoes. This is a load-bearing
  property (it closes the cheapest loop) and the trial proves it (T7).
- The stamp is written during Execute, after the gate check passes.
  If any other rule in the stack vetoes later in the same transaction,
  the whole transaction reverts — stamp included. A stamp therefore
  exists only for buys that actually landed. No phantom cooldowns.
- Only counted buys touch state. P2P receives and sells do not create
  or grow Holder records under this rule (no record bloat, no behavior
  change for non-buy paths).

**Identity, inherited knowingly:** the Holder PDA is keyed by the
**token account** (`["holder", mint, token_acct]`), not the owner —
the engine's v3 identity model (SPEC-ENGINE-V3 §9.2), shared by rules
1/11/13. One owner with two token accounts for the mint has two stamps.
§9 prices this in; the spec does not pretend otherwise.

## 5. Config encoding

Standard `RuleEntry` (68 B: rule_id u16 = 18, enabled u8, params[64]),
written by InitializeConfig / UpdateConfig exactly like the other 17.
No config layout change; `ENGINE_VERSION` stays 2.

Params (64 B), house layout style:

| Offset | Field | Notes |
|---|---|---|
| [0..8] | `cooldown_secs u64` | Required. Valid range **5..=86,400** |
| [8] | `mode u8` | 0 = last-buy cooldown (only implemented mode); 1 reserved (windowed) |
| [9] | `exempt_creator u8` | 0 = creator gated like everyone (default); 1 = config authority's wallet skips gate **and** stamp |
| [10..64] | reserved | Zero in encoder output |

Launcher encoder (`launch.mjs` `encodeParams`, id 18), spec-JSON shape
mirroring the existing entries:

```json
{ "id": 18, "cooldownSecs": 300, "exemptCreator": false }
```

```
p.writeBigUInt64LE(BigInt(entry.cooldownSecs), 0);   // required, 5..86400
p[8] = 0;                                            // mode
p[9] = entry.exemptCreator ? 1 : 0;
```

Encoder validation errors in house phrasing, e.g.
`rule 18 (Buy Cooldown) requires cooldownSecs in 5..86400`.

**Creator position (§5.1):** no automatic creator exemption. The dev
buy is a counted buy — it is also a *first* buy, so it always passes
and stamps; the creator's next buy waits like everyone else's. An
exempt creator is a sniper-shaped hole in the token's own claim, so
exemption is opt-in per config (`exemptCreator`), defaults off, and
when on it is a **published trust fact**: the preflight page and the
Board must show it, the same way rule 14 carries its "not launchable"
label. The launcher warns at spec time when `exemptCreator` is set.

**Write-time validation (engine, fail-at-write discipline of §2.2 of
the engine spec — an enabled rule with meaningless params is a config
that lies):** enabled rule 18 rejects at config write with
`InvalidInstructionData` when `cooldown_secs` is outside 5..=86,400,
when `mode != 0`, or when `exempt_creator > 1`. The 5-second floor
keeps the rule out of the Clock drift noise (§6); the 24-hour ceiling
keeps a typo from bricking a token's buys for a week.

**Registry/catalog changes:** `RULE_BUY_COOLDOWN: u16 = 18`;
`rule_known` range becomes 1..=18; `rule_implemented` gains 18;
`RULE_NAMES[18] = 'Buy Cooldown'` (launcher), docs catalog row,
skill.md, web composer entry, preflight copy:
*"Repeat buys from one wallet are rate-limited: after a buy, that
wallet must wait out the cooldown before buying again."*

## 6. Clock source

`Clock::get()?.unix_timestamp` (i64, wall-clock seconds) — the same
source rules 11, 12, and 13 already use. Defended on three grounds:

1. **One clock for the whole engine.** Trading Hours interplay (§8) is
   only reason-able if both rules read the same time.
2. **The unit is the product.** A cooldown is promised to users in
   wall seconds ("wait 5 minutes"); slot numbers (~400 ms/slot, and
   slots skip) are not a wall clock and would make the published
   number a lie of up to the slot-drift margin.
3. **Granularity fits the floor.** Second resolution against a ≥5 s
   minimum cooldown keeps validator timestamp drift (a few seconds in
   pathological cases) from dominating the gate; below that floor the
   rule would be measuring clock noise, which is why the floor exists.

Failure posture: if `Clock::get()` errors, the module propagates the
error and the transfer fails — fail closed, identical to rules 11/12
today. There is no "stale clock" state to go stale: the timestamp is
read fresh inside every Execute.

## 7. Error code and failure modes

**New veto: `CooldownActive = 35`** — the next free code in
`EngineError` (1–34 are all assigned; 35 has never been used). Variant
comment in house style:
`CooldownActive = 35, // rule 18 veto: destination bought too recently`.

Every other failure reuses an existing code — no new failure surface:

| Condition | Result | Code |
|---|---|---|
| Counted buy inside cooldown | Veto | **35 `CooldownActive`** |
| First counted buy, no Holder record | Pass; record created + stamped (vault-paid) | — |
| Counted buy, rent vault underfunded at create/grow | Fail closed | 13 `RentVaultUnderfunded` (the rules 3/17 behavior) |
| Supplied Holder account foreign-owned / corrupt / wrong tag | Fail closed | 10 `BadState` |
| Client supplies a stale meta list missing the dst-holder slot | Rejected at Execute's required-set gate, before any module runs | 26 `MissingExtra` |
| Config write with out-of-range params | Rejected at write | `InvalidInstructionData` |

## 8. Extra accounts and router compatibility (hard requirement)

Rule 18 joins the extras classification with exactly the triple rules
3 and 17 already carry:

| Extra | Index | Why |
|---|---|---|
| dest Holder PDA | 2 | read the stamp; write it on a landed buy; lazy-create |
| rent vault PDA | 3 | pays lazy creation / v5 growth |
| system program | 5 | the creation/growth CPIs |

Consequences, each verified against the standing constraints:

- **Mint-derivable, unchanged discipline.** The dst Holder entry uses
  the v3 AccountKey seeds (`["holder", mint, DEST token acct key]`) —
  a pure function of accounts the resolver already has. A first buy
  from a brand-new wallet (destination ATA not yet created) resolves
  generically, exactly as for rules 3/17. **No AccountData seeds, no
  new extra indices, no seed shapes change** — the canonical list stays
  10 entries and every existing config's published list is
  byte-identical.
- **Stacking is free.** A config already carrying rule 3 or 17
  publishes the same three extras; adding 18 grows the meta list by
  zero entries. A config with ONLY rule 18 publishes config + sysvar +
  the triple — the standard templated subsequence.
- **Generic routers keep working.** The WS5-era property — routers buy
  hooked DBC tokens fine when the extra list derives only from the
  mint — is preserved by construction, and the trial's generic-resolver
  first-buy case (T2) is the regression proof.

**Compute budget (estimate, to be measured in trial):** the gate path
is one exemption scan (≤ `MAX_EXEMPTIONS` key compares), one Holder
borrow + 8-byte read, one Clock read, and on success one 8-byte write —
the same weight class as rule 11's receive leg. Budget: repeat-buy path
≤ **+8,000 CU** over the identical config without rule 18; first-buy
path adds the standard lazy-create CPI cost rules 3/17 already pay.
An 8-rule stack containing 18 must stay comfortably inside the
per-instruction budget; the trial records actual CU for both paths and
the numbers land in the trial report, not in this spec as fact.

## 9. Graduation behavior

**Position: the cooldown persists after release graduation. There is
no graduation switch in v1, and the spec says why instead of
pretending one exists.**

- The engine gives modules no release-graduation signal to read:
  rule 1's GRADUATED is a launch-time mode, house graduation carries
  `house_state`, and release migration changes *where the token
  trades*, not the config. Inventing a per-rule graduation flag is a
  platform workstream, not a rule spec.
- What bounds the rule in practice is §2: it only ever gates counted
  buys on **allowlisted venues**. On the curve that is the whole
  game — the launch-phase window the rule exists for. Post-migration
  buys count only if the successor venue is in the config's venue list.
- Configs that want the cooldown to die at graduation have an existing
  path: a **Mutable** authority mode can disable the rule at migration
  via UpdateConfig. **Locked** configs carry it for the life of the
  config on allowlisted venues — disclosed on the token's page like
  every other Locked property.
- Rationale for defaulting to *persist*: silently expiring a published
  rule at a moment the chain doesn't mark would make the token's page
  a liar in the other direction. A rule that outlives its welcome can
  be removed by an authority that exists; a rule that vanished cannot
  be un-vanished.

## 10. Interaction matrix

Dispatch is config order; any veto vetoes the whole transfer, and a
reverted transfer leaves no stamp (§4). Pairs that matter:

| Stacked with | Interaction |
|---|---|
| **4 App-Gated** | Orthogonal axes: 4 judges *which program* delivers the trade, 18 judges *when this destination last bought*. A venue receive must pass both. Neither writes the other's state; a 32 veto leaves no stamp (atomic revert). |
| **9 Max Wallet** | Complementary: 9 caps *how much*, 18 caps *how often*. 9 reads only the dest token account + config; no shared state. A receive at the cap edge vetoes on 9 regardless of 18's stamp state. |
| **12 Trading Hours** | Same Clock, wall-time composition. With 12 at scope 1 (venue-only) + 18: buys exist only inside the window AND spaced by the cooldown. The stamp is wall-clock, not window-relative — a buy one second before close still cools down into the next window. In every sane config (windows ≫ cooldown) this is invisible; the trial proves the boundary case anyway (T9). |
| **17 Ecosystem Gate** (and 3 Agent-Only) | The security pairing (§11). 17 decides *who may receive at all*; 18 decides *how often an eligible wallet may buy*. Identical extras triple — stacking costs no extra accounts. An unregistered destination vetoes 1 with no stamp written; a registered-but-cooling destination vetoes 35. |
| 11 The Grudge | Disjoint Holder regions (11: [55..71], [119..135], [135]; 18: [224..232]). 11 can ban a marked wallet's buys outright (27) while 18 merely spaces an unmarked wallet's. Both can fire on the same receive; config order decides which veto surfaces. |
| 13 Vesting Clock | Both grow Holder records (13 → 224, 18 → 240). `holder_create_size` takes the max; a 240-byte record is a superset and 13's region offsets are untouched. |
| 1 Basis Latch | No shared fields. Note [39..47] `last_buy_ts` is rule 1's bookkeeping (written on its own receive paths) and is **not** rule 18's stamp — 18 reads only [224..232]. The similar names are a documentation hazard, flagged here so the implementer does not "reuse" the wrong field. |

## 11. Security analysis — the honest boundary

**What rule 18 stops:** the single-wallet buy loop — a bot (or a fat
finger) hammering buys from one funded wallet in a launch's first
minutes; repeat-buy sniping keyed to one wallet; accidental double-buys.
This is the dominant launch-minute pattern and it is stopped cold,
on-chain, with no keeper.

**What it does not stop, stated without varnish:**

- **Wallet rotation.** The cooldown binds a token account, loosely a
  wallet — never an identity. A sniper with ten funded wallets gets
  ten first buys. Solana cannot fix this at the hook layer; no honest
  rule can.
- **Account fragmentation.** One owner, several token accounts for the
  same mint → several stamps (the v3 identity model, §4). Closing and
  recreating an ATA resets the stamp — at the cost of first zeroing
  and exiting the position, which is real economic friction but not a
  wall.
- **Off-venue accumulation.** §2's boundary: P2P/OTC movement is
  invisible to the rule by design.

**The pairing that changes the math:** rules 3/17 make *receiving*
cost an enrollment — registration, or attestation through an
ecosystem's own flow. Rotation then costs one enrollment per wallet
instead of one keypair per wallet. **Rule 18 alone is a speed bump;
rule 18 stacked on 3 or 17 is a rate limit on identities the platform
actually vouches for.** Catalog and preflight copy must say
"rate-limits repeat buys per wallet" — never "prevents sniping."

**Griefing surface:** none new. The stamp can only be written by a
landed counted buy into one's own record; no transfer can stamp,
reset, or extend *another* account's cooldown (the P2P-griefing shape
is excluded by §2's definition, and the trial attempts it anyway, T6).

**Authority surface:** none new. The rule has no instruction of its
own, no admin path, and no oracle. `exemptCreator` (§5.1) is the only
privilege-shaped knob, it is config-static, and it is published.

## 12. Trial plan (house method: LiteSVM, real binaries, then receipts)

Suites in the established pattern (`engine/trial.mjs` full regression +
a dedicated `integration/buy-cooldown.mjs`), trial binaries built with
the dev Registry id exactly as before. A mainnet proof launch is a
**separate later go** (WS5 pattern), designed in §13, not run by the
trial.

| # | Case | Expected |
|---|---|---|
| T1 | First counted buy, no Holder record | Passes; record created at 240 B, stamp = buy time |
| T2 | Generic-resolver first buy (fresh wallet, ATA not yet created; standard `addExtraAccountMetasForExecute` path) | Resolves + passes — the router-compat regression proof |
| T3 | Second counted buy at `cooldown − 1s` | Veto **35**; stamp unchanged |
| T4 | Second counted buy at exactly `cooldown` | Passes (≥ semantics); stamp advances |
| T5 | Sell inside cooldown; P2P receive inside cooldown | Both pass; neither stamps |
| T6 | Grief attempt: third party P2P-sends 1 token to a cooling buyer, buyer retries a buy | Still veto 35 — P2P did not reset or extend anything |
| T7 | Buy → sell entire position → rebuy inside cooldown | Veto 35 — the stamp survives a full exit |
| T8 | Fragmentation boundary: same owner buys via a second token account for the mint | Passes on the second account's own stamp — recorded in the report as the §11 documented boundary, **not** scored as a failure |
| T9 | Stacked 12 (scope 1) + 18: buy at window close −1s; next-window buy inside cooldown | Second buy vetoes 35 even though 12 passes — wall-clock composition as specced |
| T10 | Stacked 9 + 18: buy that would pass 9 but is inside cooldown; buy at cap edge after cooldown | 35 on the first; 2 (MaxWalletExceeded) on the second — each veto surfaces cleanly |
| T11 | Stacked 17 + 18: unregistered destination buys; registered destination buys twice inside cooldown | Veto 1 (no stamp written) on the first; pass then 35 on the second |
| T12 | Counted buy with the rent vault drained below creation cost | Fail closed, 13 `RentVaultUnderfunded` |
| T13 | Stale meta list (dst-holder slot omitted) | 26 `MissingExtra` at the gate, before dispatch |
| T14 | Corrupt/foreign Holder account supplied | Fail closed, 10 `BadState` |
| T15 | `exemptCreator = 1`: authority buys twice back-to-back; non-authority buys twice | Authority passes both, unstamped; non-authority passes then vetoes 35 |
| T16 | Config-write validation: cooldown 0, 4, 86,401; mode 1; exempt_creator 2 | All rejected at write; valid config writes clean |
| T17 | Full engine regression (existing suites unchanged: rules 1/3/7/8/9/11/12/13/17 surfaces) | All green on the new binary — AGTR's config shape spot-checked identical |
| T18 | CU measurement: first-buy path and repeat-buy path, with/without rule 18 | Recorded in the report; repeat-buy delta within the §8 budget |

## 13. Proof-launch design (later go — WS5 pattern, NOT part of the trial)

Token **CDPROOF**, Locked, rules `[{id:18, cooldownSecs:120},
{id:9, capBps:500}]`, graduation release @ 42 SOL, economics mirroring
the APROOF/HRPROOF proofs. Mainnet evidence package: (a) dev buy
passes (first-buy path); (b) immediate second buy from the same wallet
— **real error-35 veto signature** (unlike APROOF's rule-4 ceiling, a
genuine 35 IS producible on mainnet for this config); (c) after the
120 s cooldown, a second buy passes; (d) a P2P transfer inside a fresh
cooldown passes unstamped. Disclosed in the record, as HRPROOF's window
was: the proof token's buys are rate-limited by design.

## 14. Acceptance criteria (for the bounty review — mirrors §12)

- [ ] A1. Engine module `module_buy_cooldown` implemented per §§2–7,
      dispatched in `run_module`, with `CooldownActive = 35` added to
      `EngineError` and no existing code reassigned.
- [ ] A2. Registry/catalog updated: rule 18 known + implemented,
      write-time validation per §5, extras classification per §8.
- [ ] A3. Holder v5 region per §4 (240 B, [224..232] stamp, lazy
      growth, `holder_create_size` max-discipline); no existing offset
      moved; `ENGINE_VERSION` still 2.
- [ ] A4. Launcher surface end-to-end: `encodeParams` id 18 with
      house-style validation, `RULE_NAMES`, spec-JSON validation,
      composer + skill.md + docs catalog row with §11-honest copy.
- [ ] A5. Trial suites green: T1–T18 of §12 including the full prior
      regression (T17), with CU numbers recorded (T18).
- [ ] A6. Fragmentation and rotation boundaries **demonstrated and
      documented** in the trial report (T8) — presented as the known
      boundary, not hidden and not scored as failure.
- [ ] A7. No layout, seed-shape, or meta-list change for any existing
      config: a pre-18 config's published extra list is byte-identical
      before and after the engine upgrade (the v4 rehearsal gate).
- [ ] A8. Code lands in the open hook-launcher repo under Apache-2.0,
      author credited in the catalog entry (§15).

## 15. Attribution and what this spec does NOT promise

The implementing agent is credited as rule 18's author in the docs
catalog and the repo history — attribution is part of the design, the
seed of the hook-economy idea (agents building rules other agents
launch with). **No royalty, revenue share, or per-launch payment is
promised by this spec or its bounty**: any future author royalty is a
separate decision by Gregory, made with real numbers in front of him.
The bounty (companion draft) pays once, for the build + trial evidence,
at a figure Gregory sets.

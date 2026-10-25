# SPEC — S1 Distributor Fix (settle-on-transfer reward-debt accounting)

**Status:** DESIGN ONLY — for Gregory's approval. No code in this document has
been written, deployed, or executed against mainnet. Implementation begins
only on a separate go.
**Date:** 2026-10-23 · **Finding:** S1 of
`AGENTONLY_SECURITY_REVIEW_2026-10-23.md`, confirmed by
`agentonly-security-investigation.md` §3/S1 with a passing exploit test
(`security-audit/test-distributor-s1.mjs`, 9/9).
**Programs touched by the design:** Engine
(`EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT`) and Distributor
(`DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa`). Registry, Crown,
FeeSchedule, HouseSwap: untouched.
**Live scope today:** AGTR only — the sole live holder-fee token
(DistState index 1,202,124,632; vault 58,048,759,547 raw ≈ 58,049 AGTR;
totalDistributed 1,200,681,264,408; totalPaidOut 1,142,632,504,861;
funding mode 1, callerCutBps 100; books balance exactly:
totalDistributed − totalPaidOut = vault balance).

---

## 1. The defect, stated exactly

Distributor `payout()` (`distributor/src/lib.rs`, tag 2 Claim / tag 3
Settle) computes

```
entitlement = balance(holder_acct) × (index − claim.settled_index) / SCALE     (SCALE = 1e12)
```

where `balance` is the balance of the **one token account passed in**, and
`claim` is the wallet-keyed Claim PDA (`["claim", mint, holder]`, 104 B;
`settled_index` u128 @65). On first touch the PDA is created with

```
init_settled = (balance == 0) ? index : 0
```

The `0` branch is the defect. Three violations follow, all test-proven:

- **V1 — pre-ownership accrual is claimable.** A wallet whose first claim
  follows a receive claims index growth from before it held anything.
- **V2 — send → re-acquire double-counts.** A record left at `settled = 0`
  (or any stale value) re-claims the same index history on a later balance.
- **V3 — obligations can exceed folds.** Test: one 10,000-token fold
  produced 13,000 of obligations; the legitimate holder's claim failed
  `Insolvent` (Distributor error 8).

The intended invariants the fix must restore:

- **INV-1 (solvency).** At all times, Σ over all holders of claimable
  entitlement ≤ total net folded − total paid out. Equivalently the
  vault identity `vault == total_distributed − total_paid_out` is never
  put under pressure by claims the folds did not fund.
- **INV-2 (exactness).** A holder who holds balance `b` continuously
  across an index move `I₀ → I₁` is entitled to exactly
  `floor(b × (I₁ − I₀) / SCALE)` — neither more (V1/V2) nor less (the
  underpayment failure mode of naive fixes, §3-A).
- **INV-3 (no client cooperation).** INV-1/INV-2 hold for transfers made
  by *any* client — generic routers, raw Token-2022 transfers, wallets
  that have never heard of settle-before-send. A fix that still assumes
  integrator discipline is the status quo, not a fix.

## 2. Ground truths from the code (the design stands on these)

- **F1.** Claim PDAs are wallet-keyed but the entitlement balance is read
  from the single token account passed to claim/settle. Multi-account
  holders therefore already claim per-account against a wallet-level
  `settled_index` — an incoherence the fix replaces with per-account
  accounting (§5).
- **F2.** The Engine Holder PDA (seeds `["holder", mint, token_account]`,
  length-versioned 136/192/224 B) reserves **[71..87] `reward_debt` u128**
  and **[87..103] `reward_settled_index` u128** "for distributor lazy
  settlement". No code reads or writes them today. Every creation size
  (136/192/224) includes the base 136 bytes, so both fields exist on
  every live Holder PDA. **No Holder PDA resize is needed, ever.**
- **F3.** The Distributor cannot write Engine accounts and vice versa
  (program ownership). Any cross-program state update is a CPI or it
  does not happen. The Distributor already `invoke_signed`s with its
  DistState PDA seeds (`["dist", mint]`) for vault transfers — a PDA
  signature the Engine can verify (the Engine already derives exactly
  this PDA in Execute's caller validation).
- **F4.** `INTEGRATION.md`'s ownership decision stands: *the Distributor
  owns all reward state.* The Engine-side fields in F2 are a **store**,
  not an owner: §5 keeps computation in the Distributor and uses the
  Engine only for (a) per-transfer bookkeeping writes to its own
  accounts and (b) one Distributor-signed write-back instruction.
- **F5.** Execute observes **post-transfer balances** on both sides (the
  codebase's empirically proven convention: `pre_dst = post_dst −
  amount`, `pre_src = post_src + amount`; see `module_grudge`,
  `module_basis_latch` bookkeeping). The Execute instruction data
  carries the gross `amount` @data[8].
- **F6.** Execute's caller validation already distinguishes the
  Distributor branch: top-level program == Distributor **and** transfer
  authority == this mint's DistState PDA ⇒ `venue_context = false`,
  `caller_program = Distributor`. Payout, crank-cut, and split transfers
  all share this branch (see §3-B for why that matters).
- **F7.** Meta lists are per-mint, templated by `required_extras()`
  (mask u16, canonical indices 0–9), published by
  InitializeExtraAccountMetas and rewritten by RefreshExtraAccountMetas
  (tag 9). Execute key-matches supplied extras against a fixed
  10-candidate array and fails closed (`MissingExtra`, error 26) when a
  required extra is absent. A new canonical extra is therefore a code
  change (candidate array, mask bit, meta entry), after which **tag 9
  refreshes any token's list without a config change**. Entries may be
  literal pubkeys (`new_with_pubkey`, as for System/sysvar) — essential,
  because seed-derived extras resolve under the *Engine's* program id
  and can never name a Distributor PDA (the same wall documented at
  `sync_registered` for Registry PDAs).
- **F8.** Config PDA [1049..1088] is reserved-zero on every live config
  (the fee tail ends at 1049). Activating a reserved byte without a
  layout/version change has precedent: Holder byte [135]
  (`grudge_offenses`) was reserved pre-v4 and is now live state.
  `ENGINE_VERSION` stays 2. AGTR's config is **Locked**
  (authority_mode 0); `update_config` rejects Locked, but the codebase
  already carries authority-gated controls that operate under Locked
  (`set_allowlist_entry`, `set_blocklist`, `sync_registered` path (a) —
  investigation S10/S13). §5's activation instruction follows that
  precedent and is disclosed as such.
- **F9.** Free instruction tags: Engine 18, 19 (0–17 assigned, 12/13 =
  SetBlocklist/SetAllowlistEntry). Distributor 5+ (0–4 assigned).
  Error ceilings: Engine `EngineError` ends at 34 (35 is reserved by
  SPEC-BUY-COOLDOWN for rule 18's `CooldownActive` — do not take it);
  Distributor `DistError` ends at 12.
- **F10.** Index moves **only** inside `distribute` (tags 1/4). Between
  folds the index is constant, so all transfers in a fold-interval share
  one index value — the property that makes per-transfer debt adjustment
  exact rather than approximate.
- **F11.** AGTR's DistState PDA is already in AGTR's engine config venue
  allowlist (payout CPIs pass caller validation today), and AGTR's
  published meta list (rules {3, 9}) already carries the dst Holder PDA,
  rent vault, and system program. It does **not** carry the src Holder
  PDA (rule 3 does not pull it in) and has no DistState extra.
- **F12.** Post-graduation (release), the hook is detached: transfers
  stop calling Execute. Any hook-side bookkeeping necessarily stops
  with it. §5.8 scopes the invariant honestly to the hooked era.

## 3. Options evaluated

### A. Distributor-only: first-touch `settled_index := index` (always)

One-branch change in `payout()`: delete the `balance > 0 → 0` branch.

- **Fixes:** V1 for *new* records (the exact S1 test scenario flips:
  B's first claim pays 0). Zero engine change, zero meta impact, zero
  CPI change, ~zero CU. Existing Claim PDAs untouched.
- **Fails INV-2 (underpayment).** A day-1 holder who first claims on
  day 30 is initialized at the day-30 index: their entire legitimate
  accrual is forfeit to vault surplus. On AGTR this is not hypothetical
  — any never-claimed holder since October gets A-treatment, including
  friendly fleet/Bankr-sized positions (a ~40M-AGTR balance's full-history
  accrual at the live index is ≈ 48,000 AGTR; A declares all of it
  surplus by fiat).
- **Fails INV-1 in general (counterexample).** Records with
  *heterogeneous* settled indices survive A. Sender S (record settled
  at `I_s`) sends `a` to receiver R (record settled at `I_r < I_s`).
  S surrenders `a × (I − I_s)` of claim; R gains `a × (I − I_r)`. Net
  obligations grow by `a × (I_s − I_r) > 0` — created from nothing.
  A only works if every record's settled index is always current,
  which is precisely what transfers break.
- **Verdict:** necessary as a *floor* (no record should ever be born at
  0 again), insufficient as the fix. Adopted as a component of D.

### B. Engine settle-on-transfer (MasterChef reward-debt in the Holder PDA)

Engine Execute, on every transfer of a fee-distributing mint, adjusts
both sides' `reward_debt` at the current index `I` (read from the
DistState PDA supplied as a new meta extra):

```
pending(acct) = balance × I − reward_debt            (payout = pending / SCALE)
receive(a):  reward_debt += a_credited × I
send(a):     reward_debt −= a × I
```

By F10 this is exact: between folds `I` is constant, so a balance held
across a fold accrues precisely `b × ΔI`, and balance changes re-base
the debt at the then-current index. INV-1 and INV-2 hold for **every**
transfer while the hook is attached, with no client cooperation
(INV-3) — the only option class that achieves all three.

- **Costs / breaks:**
  - Needs the DistState PDA readable in Execute ⇒ new canonical extra
    (F7) + a tag-9 refresh per fee token. AGTR's list grows by 2
    entries (src holder + dist state). The other 7 tokens' configs
    never arm the feature ⇒ their lists and Execute path are unchanged
    (the candidate array grows globally, but key-matching only
    constrains *supplied* accounts; regression trials must prove
    byte-for-byte behavior on non-armed configs).
  - Execute grows: +2 account validations, ≤2 lazy Holder creations
    (first touch; rent-vault funded, existing pattern), ~10 u128 ops.
    Estimate **+800–2,500 CU** per ordinary transfer, +~15k CU on
    creation touches. Acceptance bounds in §8.
  - **The payout-reset problem (why pure B is incomplete).** After the
    Distributor pays `pending`, the holder's debt must become
    `balance_post × I`. Execute *sees* the payout transfer (F6 branch)
    but cannot safely reset debt there: crank-cut and rule-5/6/15
    split transfers travel the same caller branch, and resetting a
    cranker's or beneficiary's debt on receipt of a cut/split would
    erase their legitimate pending. Execute cannot distinguish a
    claim payout from a split payout to the same wallet. The reset
    must therefore be driven by the Distributor, which knows which
    instruction it is executing — i.e. a Distributor→Engine CPI
    write-back (F3/F4). That CPI is what turns B into D.
  - Debt is per **token account** (v3 keying, F2) while the Claim PDA
    is per wallet (F1): claim semantics must be re-specified per
    account (§5.4) — a real semantic change, and a *coherence gain*:
    per-account debts sum exactly to the wallet's total entitlement.
- **Verdict:** the right core. Adopted, completed by A's floor and the
  write-back CPI, as D.

### C. Hook-mediated claim creation at receive-time

Engine Execute CPIs the Distributor to create the receiver's Claim PDA
with `settled_index := I` at the moment of first receive.

- **Design-killed for exactly the receives that matter.** The Claim
  PDA is keyed by the receiving **wallet**; publishing it in a meta
  list requires an AccountData seed over the destination account's
  owner field — the precise construction Engine v3 abolished because
  the generic resolver throws `TokenTransferHookAccountDataNotFound`
  when the destination ATA does not yet exist (first receives). A CPI
  form (no meta entry) survives that objection but adds a
  Token→Engine→Distributor→System CPI chain (depth 4, at the limit)
  and a Claim-PDA + System + DistState extra set to *every* receive.
- **Fails V2 anyway.** Creation-time correctness does nothing for
  records that already exist: the send → re-acquire cycle against a
  live record double-counts exactly as today. C is A with better UX
  and a much larger blast radius.
- **Verdict:** rejected. (Its one good idea — records should be born
  at the current index — is A's floor, kept in D.)

### D. Hybrid (RECOMMENDED): A-floor + B bookkeeping + Distributor-owned claim math with Engine write-back

1. **Distributor:** no Claim PDA is ever created with `settled_index =
   0` again (A). A per-DistState **accounting mode** byte arms the new
   math (§5.2): 0 = legacy, 1 = debt, 2 = post-hook legacy (§5.8).
2. **Engine:** when a config is armed (§5.3), Execute maintains
   `reward_debt` on both Holder PDAs for every transfer (B), reading
   the index from a new DistState extra. Holder records are
   initialized lazily in-band (`init-on-touch`, §5.5) — no sweep
   instruction, no Holder resize.
3. **Distributor claim/settle in mode 1** computes entitlement from the
   Engine-stored debt of the *specific token account being claimed
   for*, pays it, and CPIs the Engine to rewrite that account's debt
   to `balance_pre × I` (write-back, §5.4). The Claim PDA survives as
   the wallet-level audit mirror (`settled_index` is advanced to `I`
   on every mode-1 payout — deliberately, so a binary rollback resumes
   from current mirrors, §7).

§5 specifies D to implementation depth.

## 4. What D restores — formal statement

While the hook is attached and mode = 1, for every token account `x`
with balance `b_x`, debt `d_x`, at index `I`:

```
claimable(x) = (b_x × I − d_x) / SCALE        (floor; checked: d_x ≤ b_x × I)
```

- Every balance change `Δ` at index `I` applies `d_x += Δ × I`
  (receive `Δ > 0` uses the *credited* amount, §5.3), so `claimable`
  is invariant under transfers at constant index — tokens carry no
  accrual with them (V1, V2 dead).
- `distribute` raises `I` by `net_fold × SCALE / eligible`; each
  account's claimable grows by exactly its pro-rata share of the fold
  it held through (INV-2).
- Σ claimable ≤ Σ folds − Σ payouts by induction over the two
  operations above (floors only shrink claimable; residue is vault
  dust, as today) — INV-1, and `Insolvent` returns to the defensive,
  unreachable status `INTEGRATION.md` originally claimed for it.
- No instruction is added to any client flow; generic transfers are
  accounted by the hook itself — INV-3.

## 5. Recommended design — implementation specification

### 5.1 Data layouts (all changes are in reserved bytes; no account resizes)

**Engine Holder PDA** (existing fields, now written):

| Bytes | Field | New semantics |
|---|---|---|
| [71..87] | `reward_debt` u128 | Σ of signed balance deltas × index-at-delta, for this token account. Maintained by Execute (§5.3) and rewritten by tag 19 (§5.4). |
| [87..103] | `reward_settled_index` u128 | Watermark: the index at which this record's debt was last initialized or made whole by a payout. Written at init-on-touch and by tag 19 only — **not** per transfer. |

Uninitialized predicate (per record): `reward_debt == 0 &&
reward_settled_index == 0 && I > 0 && pre_balance > 0`. Sound because a
record the new Engine has initialized at `I > 0` with a positive
pre-balance gets `reward_debt = pre_balance × I > 0`; a record
initialized at `I == 0` is indistinguishable from untouched but also
owes nothing (`claimable = b × 0 − 0` either way until the first fold,
and the first transfer after the first fold initializes it against a
then-positive index). Sole leak: `MintTo` is not hooked (§6).

**Engine Config PDA:** byte **[1049] `debt_accounting` u8** (0 = off,
1 = armed). Read by `load_config` into `Config.debt_accounting`
(reserved bytes are zero on all live configs ⇒ all read 0; runbook
verifies AGTR [1049] == 0 pre-upgrade).

**Distributor DistState:** byte **[173] `accounting_mode` u8**
(reserved [173..176]; 0 = legacy, 1 = debt, 2 = post-hook legacy).
`load_state` gains the field; all other bytes unchanged.

**Distributor Claim PDA:** layout unchanged. In mode 1 its
`settled_index` is a *mirror* (advanced to `I` on each payout);
entitlement never derives from it in mode 1. In modes 0/2 it remains
the entitlement source, with the §5.2 creation floor.

### 5.2 Distributor changes

1. **Creation floor (all modes).** In `payout()`, the first-touch
   branch becomes `init_settled = st.index` unconditionally. The
   INTEGRATION.md "first-touch rule" text is rewritten: a record is
   born current; history is earned via debt accounting (mode 1) or
   not at all (modes 0/2 — see migration, §6, for how pre-existing
   holders are treated).
2. **New instruction tag 5 — `SetAccountingMode`.**
   Accounts: `[admin(signer), mint, state_pda(w)]`.
   Data: `[5][target_mode u8]`.
   Validates signer == DistState `admin` [65..97]; transitions allowed:
   `0 → 1` and `1 → 2` only; anything else (including re-setting the
   current mode and any downgrade to 0) errors
   `AccountingModeError` (new `DistError` 15). One-way by design: a
   downgrade path would re-open V1/V2 silently.
3. **`payout()` mode-1 path** — §5.4. Mode dispatch reads
   `st.accounting_mode` after `load_state`; modes 0/2 execute today's
   code path with change (1) applied.
4. **New errors:** 13 `MissingRewardState` (mode 1 claim without the
   required Engine accounts, or Holder PDA absent where the fallback
   of §6.3 does not apply), 14 `RewardDebtMismatch` (stored debt >
   `balance × I`, or Holder PDA fails validation — fail closed, never
   pay), 15 `AccountingModeError`.
5. `distribute` (tags 1/4): **unchanged math, unchanged accounts.**
   The index remains the single writer of `I`; the identity
   `vault == total_distributed − total_paid_out` is preserved because
   mode-1 payouts still increment `total_paid_out` (§5.4).

### 5.3 Engine changes

1. **New canonical extra index 10 — DistState.**
   `EXTRA_DIST_STATE: u8 = 10`, `EXTRA_BIT[10] = 1024` (mask stays
   u16). `build_metas` appends
   `ExtraAccountMeta::new_with_pubkey(&dist_state_pda, false, false)`
   where `dist_state_pda = pda(&[b"dist", mint], &distributor_id())`
   computed at publish time (per-mint literal, F7). Execute's
   candidate array grows to 11 with `candidates[10]` = the same
   derived PDA; the required-set gate loop extends to 11.
   `ExecuteCtx` gains `dist_state: Option<AccountInfo>`.
2. **`required_extras` delta.** If `cfg.debt_accounting == 1`, add
   bits: SRC_HOLDER | DST_HOLDER | RENT_VAULT | SYSTEM | DIST_STATE
   (rent vault + system fund lazy Holder creation in the settlement
   phase, mirroring rules 1/3/17). No other config's mask changes.
3. **New instruction tag 18 — `SetDebtAccounting`.**
   Accounts: `[authority(signer), mint, config_pda(w)]`.
   Validates `load_config`, signer == `cfg.authority` (any
   authority_mode, including Locked — the F8 precedent; this is a
   retained operator control and must be disclosed wherever Locked is
   described, alongside the S10/S13 list). Writes exactly one byte:
   config [1049] := 1. Idempotent (already 1 ⇒ Ok). No
   `write_config`, no other byte touched. After this call, Execute
   fails closed with `MissingExtra` on this mint until tag 9 refreshes
   the meta list — the runbook (§6) sequences 18 → 9 back-to-back and
   treats the window as a maintenance pause (transfers veto; nothing
   mis-settles).
4. **New instruction tag 19 — `ApplyRewardSettlement`** (the
   write-back; callable only as a Distributor CPI, by construction):
   Accounts: `[dist_state_pda(signer), mint, config_pda(ro),
   holder_pda(w), token_account(ro)]`.
   Data: `[19][new_debt u128][new_settled_index u128]`.
   Validations: signer key == `pda(&[b"dist", mint],
   &distributor_id())` — unforgeable, since only the Distributor
   program can produce that PDA's signature, via `invoke_signed`;
   config loads and `cfg.debt_accounting == 1`; holder key ==
   `holder_pda(mint, token_account)`; holder is valid (exists,
   Engine-owned, tag 1). Writes Holder [71..87] := new_debt,
   [87..103] := new_settled_index. The Engine **does not validate the
   numbers** — accounting is the Distributor's (F4). Trust note: a
   compromised Distributor could write arbitrary debt, but the
   Distributor already holds unilateral control of the vault; this
   adds no new trust.
5. **Settlement phase in Execute.** Runs after the module loop, only
   when `cfg.debt_accounting == 1` (all rules passed; a veto reverts
   everything anyway, but bookkeeping-last keeps the phase's contract
   "applies to transfers that actually happen"). Pseudocode:

```
fn settle_rewards(ctx, dist_ai):
    # dist_ai is guaranteed present by the required-set gate.
    validate: dist_ai.key == pda(["dist", mint], DISTRIBUTOR_ID)
              && dist_ai.owner == DISTRIBUTOR_ID && len >= 176 && data[0] == 1
              else Err(BadState)
    if dist_ai.data[173] != 1:            # distributor not in debt mode
        return Err(RewardNotArmed)        # error 36 — fail closed:
                                          # config armed + distributor
                                          # unarmed is operator error,
                                          # never silently untracked.
    I = read_u128(dist_ai, 97)
    fee = transfer_fee(mint, ctx.amount)  # 0 for fee-less mints (AGTR);
                                          # mode-0 mints: parse the mint's
                                          # live TransferFeeConfig TLV
                                          # (reuse distributor's
                                          # parse_fee_config walk) and apply
                                          # ceil(amount*bps/10000) capped
                                          # at fee_max — pinned by trial.
    credited = ctx.amount - fee           # what dst's balance gained
    if ctx.source.key == ctx.dest.key:
        init_on_touch(src_holder, pre = post_balance, I)   # net Δ = 0
        return
    settle_side(src_holder, acct = source,
                pre = post_bal(source) + ctx.amount, post = post_bal(source), I)
    settle_side(dst_holder, acct = dest,
                pre = post_bal(dest) - credited,     post = post_bal(dest), I)

fn settle_side(holder_ai, acct, pre, post, I):
    if holder record missing:
        ensure_src/dst_holder(...)        # rent-vault funded, existing
                                          # helpers, holder_create_size(cfg)
        init_holder_data(...)
    if uninitialized(holder) (§5.1 predicate):
        debt = pre * I ; settled_idx = I  # born current — no retro credit
    else:
        debt = debt + (post - pre) * I    # signed delta; checked math;
                                          # underflow => MathOverflow (11)
    write [71..87] = debt   (and [87..103] = I iff initialized here)
```

   - **Exemptions do not skip settlement.** Config exemptions govern
     rule vetoes, not accounting; pool vaults, the distributor vault,
     and exempt wallets all get debt records (harmless, consistent;
     nobody can claim for a PDA-owned account except through its
     program). Uniformity is what makes INV-1 carve-out-free.
   - **Distributor-caller transfers settle normally** (F6): a payout's
     receive leg adds `payout × I` to the recipient's debt — exactly
     right, since paid tokens start earning from the current index —
     and the claim's tag-19 write-back (§5.4) is sequenced *before*
     the vault transfer inside `payout()`, so Execute's adjustment
     lands on the rewritten debt: final debt
     `= balance_pre × I + payout × I = balance_post × I`, pending 0. ✓
   - Self-transfers (src == dst account): net delta 0; only
     init-on-touch may fire.
6. **`SyncHolder` (tag 11) merge rule (required delta).** When either
   record carries reward state, the merge must combine it:
   `debt_dst += debt_src`; `settled_dst = min(settled_src, settled_dst)`
   (conservative watermark). Without this, merging two accounts of one
   owner would strand the source account's debt basis and over-credit
   the merged record. `MigrateHolder` (tag 10) copies bytes verbatim —
   debt carries automatically; no change.
7. **New errors:** 36 `RewardNotArmed`, 37 `RewardStateBad`
   (validation failures in the settlement phase distinct from generic
   BadState call sites). (35 is *not* used — reserved for rule 18.)

**Compute budget (estimates; §8 makes them acceptance criteria):**
settlement phase ≈ +800–2,500 CU on transfers where both Holder PDAs
already exist (2 validations, 1 dist-state read, ~10 checked u128
ops, 2 small writes); +~10–15k CU when a Holder PDA must be lazily
created (comparable to existing rule-1/3 creation touches). No new
CPI on the transfer path. Transaction-size impact: +2 meta entries on
armed tokens (src holder is a PDA — resolvers derive it; dist state is
a literal) ≈ +64 B of message keys on swap transactions that did not
already carry them, **offset** by §5.6.

### 5.4 Distributor `payout()` — mode-1 path (tags 2 and 3)

Account list restructures **only in mode 1** (mode is known only after
`load_state`, so the client contract is: for a mode-1 DistState, build
the extended list; the program validates by mode). Legacy 9 accounts
unchanged, then:

```
[9]  holder_pda   (ro)   Engine Holder PDA for accounts[2] (the token
                          account being claimed for)
[10] engine_program (ro) the Engine program id (CPI target)
[11..]                   transfer-hook extras for the payout transfer,
                          exactly as today's [9..] in legacy mode
```

In legacy modes 0/2, accounts [9..] remain the hook extras, byte-for-
byte as today (existing clients unaffected on un-migrated mints).

Math (all u128, checked; `SCALE = 1e12`):

```
bal_pre   = token_amount(holder_acct)
validate holder_pda: key == engine_holder_pda(mint, holder_acct)
                     (derived via ENGINE_ID const, seeds
                      ["holder", mint, holder_acct]),
                     owner == Engine, len >= 136, tag == 1
                     else MissingRewardState / RewardDebtMismatch
D         = read_u128(holder_pda, 71)
owed128   = bal_pre * I - D                    (checked_sub;
                     negative => RewardDebtMismatch — fail closed)
entitlement = owed128 / SCALE                  (floor, as legacy)
# fallback for pre-upgrade records (§6.3) may replace D here.
CEI, in order:
  1. Claim PDA (create with §5.2 floor if first touch):
     settled_index := I ; total_claimed += entitlement ;
     last_claim_slot := slot            [mirror discipline]
  2. state.total_paid_out += entitlement
  3. CPI Engine tag 19 ApplyRewardSettlement{
        new_debt = bal_pre * I, new_settled_index = I }
     via invoke_signed(["dist", mint]) — BEFORE the payout transfer,
     so the transfer's own Execute adjustment (§5.3) composes on top.
  4. if entitlement > 0: cpi_vault_transfer(entitlement, extras=[11..])
     with the same Insolvent guard as legacy (vault < entitlement =>
     error 8; under INV-1 this is defensive-only).
Zero-entitlement claims still perform steps 1–3: the record is made
whole at the current balance (legacy code already advances settled on
zero claims; the dust below SCALE is erased identically in both
designs).
```

**Multi-account semantics (replaces F1's incoherence):** entitlement
is a property of the *token account passed in* — its balance against
its own debt. A wallet claims once per token account; the wallet total
is the exact sum. The Claim PDA remains the per-wallet audit trail
(`total_claimed` accumulates across the wallet's accounts). Docs and
Trade Kit copy must say "claim per account" for mode-1 tokens.

### 5.5 Init-on-touch is the migration mechanism

No sweep instruction exists. Every Holder PDA on an armed mint is
initialized by the first Execute that touches it after arming (or by
the §6.3 claim fallback), with debt based on its **pre-transfer
balance at the then-current index**. Consequences, stated plainly:

- Accrual a never-settled holder earned *before* arming is **not**
  reconstructed — it cannot be: balance history per account is not
  recorded on-chain, and the index alone cannot attribute folds to
  balances that have since moved. §6 handles the human side of this
  (notice + optional pre-upgrade settle sweep); the program side is
  deliberately A-semantics at the touch instant.
- After the touch, the account is exact forever (while armed+hooked).

### 5.6 Client impact (no new instructions in any flow)

hook.mjs / Trade Kit / gateway need **no new instructions** for armed
tokens; settlement is hook-internal. Two adjustments: (1) resolvers
pick up the refreshed meta list automatically (gateway/kit resolve
extras from the list); (2) the pre-transfer `settle` instructions the
flows currently bundle become **unnecessary** on mode-1 tokens (they
remain harmless zero-payout no-ops) and **should be omitted** — this
frees more transaction space (≈2 instructions) than the +2 meta
entries cost, so the fattest known bundle (fresh-wallet AGTR one-tx
flow, 1215/1232 B) does not grow. Mode detection for clients:
DistState byte [173] (one read they already make for status).

### 5.7 S8 interaction — explicitly out of scope, by decision

The design **does not change payout classification**: distributor
transfers remain `venue_context = false` in Execute (F6), and rule 7
(No-P2P) continues to veto them. Rationale: classification is
veto *policy*; S1 is *accounting*. Reclassifying payouts as venue
transfers to slip them past rule 7 would change rule-7 semantics for
every token, entangle this fix with the S8 remediation, and still not
fix S8's funding leg (fee transfers *into* the vault are equally
vetoed). S8's correct fix remains the launch-validator hard-block on
`rule 7 no-p2p × holderFees` (launcher-side, separately queued).
Interaction check within this design: on a (hypothetical, unlaunchable
post-validator) No-P2P × fees token in mode 1, a vetoed payout reverts
atomically — settlement phase never runs (modules first), tag-19 CPI
never lands — so accounting stays consistent even in the broken
composition. Debt bookkeeping also runs on *successful* distributor
transfers (cut/splits/payouts), which is accounting, not
classification.

### 5.8 Post-graduation lifecycle (mode 2)

When an armed token graduates by release (hook detached), Execute
stops and debt goes stale. The lifecycle is specified, not improvised:

1. At graduation, the operator (DistState admin) calls tag 5:
   `1 → 2`. Mode 2 = legacy payout math (Claim PDA `settled_index`,
   which mode 1 kept mirrored-current at every payout) **with the
   §5.2 creation floor** — i.e. post-hook guarantees degrade to
   exactly Option A's: no first-touch windfall ever; heterogeneous-
   settled drift (§3-A counterexample) re-opens for post-hook
   transfers between stale records.
2. First-party surfaces restore the INTEGRATION.md v1 discipline for
   mode-2 tokens: settle-around-transfer in transaction builders.
3. House graduation (hook persists venue-side) does **not** trigger
   mode 2 — only hook detachment does. The graduation runbook gains a
   checkbox: "if release: SetAccountingMode(2) in the migration
   transaction window; if house: leave mode 1."

### 5.9 What this design does NOT fix

- **S6** (registry deactivation never propagates to the Holder mirror)
  — different finding, different mechanism; untouched.
- **S3** (config-authority path-(a) mirror forgery), **S5**
  (per-token-account Max Wallet), **S2**, **S7**, **S12**, **S14** —
  untouched. (Tag 18 adds one more authority-retained control to the
  S10/S13 disclosure list; that is a documentation consequence, not a
  regression.)
- **MintTo / burn are unhooked.** A mint directly into an armed
  account raises its balance with no debt adjustment; a later claim
  over-credits by `minted × (I − I_at_debt_basis)/SCALE`. Accepted
  residual for tokens with fixed supply / burned mint authority
  (**AGTR qualifies**: DBC supply is fixed at launch). Launch
  validation for *future* mode-1 tokens must require burned mint
  authority (validator note, alongside S8's block).
- **The §3-A drift in modes 0/2** — accepted and documented above;
  modes 0/2 are legacy/post-hook postures, not the guarantee.
- **Rollback-window drift** — §7.

## 6. AGTR migration runbook

Order is load-bearing. Programs are upgraded with the retained
single-key upgrade authority (fren); each step lists its verification
read. Estimated operator actions: 2 program upgrades, 1 config byte
write, 1 meta refresh, 1 mode flip, plus optional step 0.

**Step 0 — Pre-upgrade settle sweep (OPTIONAL, Gregory's call; see
§6.3).** Under the *current* program, permissionlessly `settle()` each
enumerated friendly holder (operator-known agent wallets — fren fleet,
Bankr's wallet, fleet2). Each settle pays that wallet's full-history
entitlement on its current balance and leaves its Claim record at
`settled = I` — those holders cross the cutover whole, no fallback
needed. **Solvency pre-check (mandatory before any sweep):** compute
`Σ settle_entitlements` over the sweep set from live reads; require
`Σ ≤ vault balance (58,048,759,547)`. If the sum exceeds the vault,
STOP and escalate: aggregate obligations already exceed the fold
buffer, the sweep would pay first-come-first-served, and the migration
needs Gregory's direction before anyone is paid.
*Verify:* each swept wallet's Claim PDA `settled_index == index`;
`total_paid_out` advanced by exactly the paid sum; vault identity
still exact.

**Step 1 — Rehearsal gate.** §8's full test plan green in LiteSVM,
including the flipped S1 test and a mainnet-fork (or LiteSVM-loaded
live-state) rehearsal of steps 2–5 against AGTR's actual accounts.
No mainnet action before this gate.

**Step 2 — Upgrade Engine.** Deploy the new Engine binary (upgrade
authority). Nothing is armed yet: every config reads [1049] == 0, the
settlement phase is inert, the candidate array change is
supply-side-only.
*Verify:* program data hash matches the rehearsed binary; AGTR/LATCH
transfers execute normally (status reads + one generic-router quote/
simulate via the Trade Kit); all pre-existing engine trials' invariants
spot-checked on live state (configs unchanged byte-for-byte).

**Step 3 — Upgrade Distributor.** New binary live; DistState [173]
still 0 (legacy mode), creation floor now applies to any *new* Claim
PDA (behavior change, strictly safer direction).
*Verify:* `distribute` no-op call shape unchanged; a claim by fren
(settled, entitlement ~0) succeeds via the legacy path with the
**legacy account list** (proves un-migrated clients still work in
mode 0).

**Step 4 — Arm AGTR (maintenance window; transfers pause by
fail-closed design).** (a) Engine tag 18 `SetDebtAccounting` signed
by fren (config authority). (b) Engine tag 9 `RefreshExtraAccountMetas`
for AGTR. Order matters: between (a) and (b), AGTR transfers fail
`MissingExtra` — expected, brief, and loud rather than silent.
*Verify:* meta list PDA now carries 7 extras in canonical order
[config, src holder, dst holder, rent vault, system, sysvar,
dist state]; config byte [1049] == 1; a test transfer settles
(§5.3) — sender/receiver Holder PDAs show `reward_debt` ==
post-balance × I for a fresh receiver.

**Step 5 — Flip Distributor mode.** Tag 5 `SetAccountingMode(1)`
signed by the DistState admin.
*Verify:* DistState [173] == 1; §8's live-smoke matrix (read-only
simulations only): fresh-wallet AGTR eligibility/quote/build/simulate
unchanged verdicts; a simulated mode-1 claim for fren returns
entitlement consistent with debt math (≈0 — fren is settled).

**Step 6 — Post-migration accounting audit.** Re-run the
investigation's reads: vault identity exact; enumerate **all** Claim
PDAs (the audit's `claim-check.mjs` pattern) and all AGTR Holder PDAs;
record (holder, settled_index, debt, settled watermark) snapshot into
the deploy record. This snapshot is the baseline every later dispute
is judged against.

### 6.3 Treatment of existing records (the decision §6.0/§6 step 6 frame)

- **Fren's Claim record** (`settled == index` at investigation read;
  totalClaimed 52,076,050,736 raw): whole under every path. Its Holder
  PDA init-on-touches at first post-arm transfer with pending ≈ 0. ✓
- **Existing Claim PDAs with `settled_index > 0`:** honored via the
  **claim fallback** — on a mode-1 claim where the token account's
  Holder record is still uninitialized (§5.1 predicate), the
  Distributor computes this one claim with legacy math against the
  Claim record (`bal × (I − claim.settled)/SCALE`), then initializes
  the Holder debt via tag 19 (`debt := bal_pre × I`) as part of the
  same payout. One-time per account; bounded by a record the old
  program itself created.
- **Existing Claim PDAs with `settled_index == 0`:** the
  indistinguishable set — legitimate day-1 holders and would-be
  windfall claimants are byte-identical on-chain. **Recommendation:
  A-treatment** (no fallback; init-on-touch / creation floor applies;
  pre-arm accrual forfeits to vault surplus), *except* wallets
  settled in step 0, which never reach this branch. Step 6's snapshot
  enumerates exactly which wallets this affects and the raw amount
  each forfeits (`balance_now × I / SCALE`), so the decision is taken
  with the names and numbers on the table. If Gregory prefers honoring
  them, the fallback extends to `settled == 0` records created before
  the upgrade slot — the code delta is one condition; the cost is
  re-admitting V1 for precisely those records, capped at their
  step-6 balances.
- **Holders with tokens but no Claim PDA and no Holder touch:** first
  claim creates the Claim record at the floor (current index) and
  init-on-touches debt — A-treatment, as §5.5 states.
- **The vault and the live index:** untouched by migration. No fold,
  no re-indexing, no vault move. `distribute` continues from the same
  index; INV-1 holds from the first armed transfer onward.

## 7. Upgrade & rollback posture

- **Upgrade order** is §6 steps 2→5; flags arm last, in an order
  (engine code → distributor code → config byte → meta list →
  distributor mode) such that every intermediate state is either
  legacy behavior or fail-closed — never silently mis-accounted.
  The one fail-*open* risk window in the sequence is between steps
  2–3 (new code, old behavior): none — both binaries are inert until
  armed.
- **Rollback before any flip (steps 2–3):** redeploy the prior
  binaries via the upgrade authority. State written by new code:
  none (all new writes are gated on flags that are still 0).
- **Rollback after flips:** redeploy prior binaries. Old binaries
  ignore config [1049], DistState [173], and Holder [71..103]
  (reserved in their layouts). Legacy payout resumes deriving from
  Claim PDAs — which mode 1 deliberately kept mirrored
  (`settled_index := I` at every mode-1 payout, §5.4), so holders who
  claimed under the new regime resume correctly. **Residual, stated
  plainly:** transfers that occurred while armed moved balances whose
  accrual the old math attributes by Claim-record vintage — the
  §3-A drift re-opens for exactly the rollback window's movements.
  Rollback is a incident-response tool, not a free toggle; if it is
  ever used, the step-6 snapshot plus a fresh enumeration bounds the
  drift.
- **No downgrade path in-protocol** (tag 5 rejects →0) precisely so
  that "rollback" can only mean a deliberate, operator-signed program
  redeploy — visible on-chain as an upgrade, never a quiet flag flip.

## 8. Test plan (extends `security-audit/`; all LiteSVM, binaries from the implementation build)

**Oracle discipline:** the existing `test-distributor-s1.mjs` runs
against the *old* distributor binary and must still "pass" (it
asserts the vulnerable behavior — it is the bug detector). The new
suite runs the identical scenario against the fixed Engine+Distributor
pair on a **hooked** mint (mode 1 requires the hook; the S1 scenario
is re-staged on a rule-{3,9} AGTR-shaped mint with a Distributor,
mirroring `distributor/trial-hooked.mjs`'s harness).

1. **T1 — S1 flip.** Same actors/fold as the audit test (A 600k,
   D 400k, fold 10,000, cut 0). Expected under the fix: B (received
   unsettled, held zero seconds) claims **0**; B→A 300k, A claims
   exactly its own post-receive accrual (**0** at unchanged index —
   and in a variant with a second fold after the return, exactly
   `300k × ΔI/SCALE`); D claims the full **4,000**; no `Insolvent`;
   Σ payouts + residual claimable == 10,000 − dust. The original
   assertions (B 6,000 / A +3,000 / D error 8) must all **fail**
   against the fixed pair.
2. **T2 — Continuous-holder equality.** Replay the distributor
   trial's happy path (T1–T10 shapes) on the armed hooked mint with
   **no inter-holder transfers**: every claim equals the pre-fix
   trial's amount **to the unit** (debt math floors identically when
   balances don't move — §3-B formula equivalence), including
   double-claim = 0 and the claim-everything finale's dust
   decomposition.
3. **T3 — Send → re-acquire cycle.** Holder claims, sends 100% away,
   index folds twice, re-acquires the same amount, claims: payout ==
   accrual on the re-acquired balance since re-acquisition only.
   Repeat ×3 cycles; Σ payouts across all actors ≤ Σ folds at every
   step (INV-1 asserted continuously, not just at the end).
4. **T4 — Multi-account holder.** One wallet, two token accounts,
   staggered receives and folds; claims per account; Σ == the
   single-account control wallet's entitlement for the same balance
   history; `SyncHolder` merge mid-scenario, then claim == merged
   entitlement (debt-merge rule, §5.3.6).
5. **T5 — Partial-balance sends.** Holder sends 37% between folds,
   claims from both sides at each stage; sender and receiver payouts
   match an independent BigInt mirror implementation of §5.3/§5.4
   math to the unit.
6. **T6 — Mode lifecycle.** Legacy mode claim lists (9 accounts)
   succeed pre-arm; mode-1 claim with the legacy list fails
   `MissingRewardState`; tag-5 illegal transitions (0→2, 1→0, 1→1)
   fail `AccountingModeError`; SetDebtAccounting on a Locked config
   by the authority succeeds, by a stranger fails `BadAuthority`;
   tag 9 on the Locked config republishes the 11-candidate list;
   transfers between tag 18 and tag 9 fail `MissingExtra`.
7. **T7 — Post-graduation (mode 2).** After `1 → 2`: claims derive
   from Claim records; a first-touch claim creates at the floor
   (pays 0 on history); a settled-record holder claims its post-mode-2
   accrual correctly under settle-around-transfer discipline.
8. **T8 — Hostile shapes.** Claim with a forged Holder PDA (wrong
   seeds/owner) ⇒ `RewardDebtMismatch`; tag 19 called directly
   (non-CPI, human signer) ⇒ rejected (signer != DistState PDA);
   tag 19 with a tampered config (debt flag 0) ⇒ rejected; claim
   where stored debt > balance × I (state hand-corrupted in SVM)
   ⇒ `RewardDebtMismatch`, vault untouched; payout-transfer extras
   misalignment in mode 1 ⇒ instruction fails atomically, debt
   unchanged (CEI/CPI revert).
9. **T9 — Regression battery.** Distributor trial 61/61, splits trials,
   engine trials (v3/v4/graduated/phase-b/c), the audit suite's
   non-S1 files (engine/latch/nop2p/registry — must be unaffected),
   and the Trade Kit matrix re-run: verdicts unchanged; **fresh-
   wallet AGTR bundled tx ≤ 1232 B with bundled settles omitted**
   (§5.6) and re-measured with them present (must still fit or the
   omission becomes mandatory in kit code).
10. **T10 — CU budget.** LiteSVM-metered Execute CU on AGTR-shape
    transfers: median armed-vs-unarmed delta ≤ 2,500 CU; worst case
    (double Holder creation) ≤ 20,000 CU delta; no transfer in the
    matrix exceeds the 200k CU envelope the kit budgets.

## 9. Decisions required from Gregory

1. **§6.3 `settled == 0` records:** A-treatment (recommended) vs
   honor-via-fallback — taken with step 6's enumeration in hand.
2. **Step 0 sweep:** run it (and for which wallets) or skip it and
   let §6.3 govern everyone uniformly.
3. **Disclosure timing:** S1 remains live and unpatched on AGTR until
   step 5 completes; this spec, the audit, and the fix timeline are
   internal until Gregory chooses otherwise. (The step-0 sweep, if
   run, is visible on-chain as ordinary settle transactions.)
4. **Implementation go** — this document approves nothing by itself.

---

*End of spec. Companion reading: `distributor/INTEGRATION.md` (the
first-touch rule this spec replaces, and the ownership decision it
preserves), `SPEC-ENGINE-V3.md` §9.2 (account-keyed holder identity),
investigation §3/S1 + §6.3 (the reserved bytes were reserved for
exactly this fix and never wired — this spec wires them).*

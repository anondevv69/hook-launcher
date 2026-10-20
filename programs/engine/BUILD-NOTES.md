# Hook Launcher ENGINE — build notes

**Date:** 2026-10-15
**MAINNET (2026-10-15):** engine deployed as `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT`, rebuilt with `REGISTRY_ID = GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e` (mainnet Registry); size unchanged 184,264 B, on-chain ELF byte-exact; upgrade authority = fren (not burned). See `../deploy/DEPLOY-RECORD.md`. · **Workstream:** engine core (spec §2) + **Modules Wave 1** + **V2 DBC hardening** · **Status:** built + proven in LiteSVM, **64/64 trial assertions**. No mainnet deployment, no mainnet SOL spent.

Wave 1 added: SyncRegistered (real Registry integration), rule 1 Basis Latch
(+ PriceFeed PDA, crank), rule 7 P2P Toggle, rule 8 Holder-Gated. The
engine version byte is now **2** (meta tail v2 — see deviation 1/8).

V2 DBC hardening (same day) added tag 8 **CrankPriceDbc** (DBC pool-state
crank — see the rule 1 notes and deviation 14) and re-proved the whole
stack against the real DBC binary: integration suite **42/42**
(`integration/dbc-engine-integration-v2.mjs`), end-to-end Basis Latch on
a live curve **55/55** (`integration/dbc-latch.mjs`), graduation suite
**22/22** against the v2 binary. No tail or layout change — ENGINE_VERSION
stays 2, v2 configs and meta lists remain valid.

## Identity & size

| Item | Value |
|---|---|
| Program id (dev keypair, `engine-keypair.json`) | `2A3kbQHsUpsnud5VSz3aszFDjhUychWK99NDWyKtSMDt` |
| Binary | `target/deploy/engine.so`, **184,264 bytes** (SBF v1, `cargo build-sbf --arch v1` — LiteSVM 0.8 cannot load SBF v3). v1 core was 143,704 B; wave 1 added 36,160 B; the DBC crank (tag 8) added 4,400 B |
| Program rent estimate | ≈ **1.2834 SOL** rent-exempt for the programdata account at this size ((184,264 + 128) × 6,960 lamports); deploy buffer churn is additional but recoverable |
| Toolchain | Same pins as the TH hook / proof hook: solana-program 2, spl-tlv-account-resolution 0.9, spl-transfer-hook-interface 0.9, opt-level 3 + fat LTO |
| Trial harness (NOT product) | `venueshim` `DyiJ4TXMEVXZJqNYiZZiKX25V8m5vN7mkCkXxByFaPpZ`, 28,248 B — one instruction that CPIs a TransferChecked from client-supplied accounts, so trials can produce genuine *venue-context* transfers |

Per-mint / per-holder state rent (measured in LiteSVM, exact):

| Account | Bytes | Rent (SOL) | Paid by |
|---|---|---|---|
| Config PDA | 1,088 | 0.008463 | launcher at launch |
| ExtraAccountMetaList PDA | **261** (tail v2; v1 was 226) | **0.002707** | launcher at launch |
| Holder PDA | 136 | 0.001837 | explicit `init_holder`, a sync instruction, or the rent vault on lazy creation |
| PriceFeed PDA | 136 | 0.001837 | launcher at launch (`init_price_feed`) |
| Rent vault PDA | 0 (bare address) | — | launcher funds it with SOL at launch; budget ≈ 0.001837 × expected holder count |

Execute cost observed in trial: ~33k CU for a veto path (of a 1.4M budget);
full pass paths are in the same order. No CU concern for DBC's limits at
this module count.

## Execute account layout (as implemented — tail v2)

Token-2022 assembles the call in the proven order (METEORA-PROOF.md): the four base accounts, then the **validation account**, then the resolved extras in meta-list order:

| # | Account | Writable | Source |
|---|---|---|---|
| 0 | source token account | w | base |
| 1 | mint | ro | base |
| 2 | destination token account | w | base |
| 3 | authority (owner/delegate) | ro | base |
| 4 | **validation** = ExtraAccountMetaList PDA `["extra-account-metas", mint]` | ro | Token-2022 |
| 5 | Config PDA `["config", mint]` | ro | meta 0 |
| 6 | source Holder PDA `["holder", mint, src owner]` | w | meta 1 |
| 7 | dest Holder PDA `["holder", mint, dst owner]` | w | meta 2 |
| 8 | rent vault PDA `["rentvault", mint]` (bare address) | w | meta 3 |
| 9 | **PriceFeed PDA `["price", mint]`** | ro | **meta 4 (new in v2)** |
| 10 | system program (literal) | ro | meta 5 |
| 11 | instructions sysvar (literal) | ro | meta 6 |

Execute receives **12 accounts**. Instruction data: SPL Execute discriminator ++ amount u64 (16 bytes).

Structural validation before any logic: validation key == meta-list PDA; config key == derived Config PDA; both token accounts' mint == the mint account; both holder keys == PDAs derived from the **owners read out of the token accounts** (never from passed-in claims); rent vault key == derived PDA; **price feed key == derived PriceFeed PDA**. Then sysvar introspection: the executing top-level instruction must be Token-2022 Transfer/TransferChecked (data 3/12) or a program on the config venue allowlist (the DBC branch); the verdict is kept as `venue_context` for rule 7. Phantom Execute calls fail `BadCaller` (trial T7).

**Probe result (wave 1, load-bearing): Token-2022 delivers exactly those 12 accounts — nothing else.** Accounts a client appends to the transfer instruction are **never forwarded** to Execute, tested in three positions (before the hook-program key, between hook and validation, after validation): `accounts=12` every time. Anything a module needs beyond the tail must arrive as engine state written by a companion instruction in the same transaction (the SyncRegistered / SyncGateBalance pattern), never as a transfer account. Execute logs `amount / accounts / venue` per transfer (kept from that probe instrumentation; cheap, and it made the finding directly observable).

## Instructions (own tags; data[0])

| Tag | Name | Accounts | Notes |
|---|---|---|---|
| — | Execute (SPL disc) | 12, above | module dispatch |
| 0 / SPL disc | InitializeExtraAccountMetas | [payer(s,w), meta_list(w), mint, system, config(ro)] | requires config to exist (launch order: config → metas) |
| 1 | InitializeConfig | [payer(s,w), mint, config(w), system] | payload below; validates rules at write time |
| 2 | UpdateConfig | [authority(s), mint, config(w)] | gated per authority_mode |
| 3 | InitializeHolder | [payer(s,w), mint, owner(ro), holder(w), system] | explicit holder creation |
| 4 | **SyncRegistered** | [caller(s,w), mint, config(ro), owner(ro), holder(w), system, **registration_pda(ro) optional @6**] | Registry mirror — spec: `registry/INTEGRATION.md`; see module notes |
| 5 | **CrankPrice** | [config(ro), price_feed(w), token_vault(ro), quote_vault(ro)] | permissionless EMA update from the feed's pinned vault balances |
| 6 | **InitializePriceFeed** | [payer(s,w), mint, config(ro), price_feed(w), system] | data: `[6][pool 32][token_vault 32][quote_vault 32][token_dec u8][quote_dec u8]`; token_dec checked against the mint's own decimals byte |
| 7 | **SyncGateBalance** | [caller(s,w), mint, config(ro), owner(ro), holder(w), system, gate_acct(ro), dest_acct(ro), ix_sysvar(ro)] | rule 8 mirror — see module notes |
| 8 | **CrankPriceDbc** | [config(ro), price_feed(w), dbc_pool(ro)] | permissionless EMA update from a Meteora DBC pool's `sqrt_price` — see rule 1 notes |

Config payload (init & update share it, after the tag): `authority_mode u8 | authority 32 | rule_count u8 | rules × {rule_id u16, enabled u8, pad u8, params[64]} | venue_count u8 | venues ×32 | exemption_count u8 | exemptions ×32 | fee_bps u16 | fee_max u64 | beneficiary_mode u8 | fee_vault 32`.

Config PDA layout (1,088 B): tag/version/mode/rule_count @0–3, mint @4, authority @36, created_slot @68, venue allowlist @76 (count) + 77…, exemptions @205 (count) + 206…, rules @462 (8 × 68 B entries), fee mirror @1006 (bps u16, max u64, beneficiary_mode u8, fee_vault @1017), reserved zeros to 1088.

Holder PDA layout (136 B, spec §2.3): tag @0, **registered @1** (rule 3 mirror), basis_num u128 @6, basis_den u128 @22 (=1), latched @38, last_buy_ts @39, last_sell_ts @47, dump window @55/@63, reward_debt @71, reward_settled_index @87, custom[32] @103 — **rule 8 uses custom @103..111 gate_balance u64 + @111..119 gate_sync_ts i64**.

PriceFeed PDA layout (136 B, seeds `["price", mint]`): tag @0, pool @1..33, token_vault @33..65, quote_vault @65..97, **ema_price u128 @97** (PRICE_SCALE 1e12 fixed point, TH format: quote smallest units per WHOLE token × 1e12), last_crank_ts i64 @113 (unix **seconds**), crank_count u64 @121, token_dec @129, quote_dec @130, reserved @131..136.

## Module coverage

| id | module | status | params (64 B) |
|---|---|---|---|
| 1 | BasisLatch | **LIVE (wave 1)** | `[0..8]` max_stale_secs u64 (0→300), `[8..16]` ema_half_life_secs u64, `[16..18]` max_crank_bps u16 (0→10000), `[18]` mode: 0 = LATCH / 1 = LIVE |
| 2 | EscrowSplit | rejected at config write (not implemented) | — |
| 3 | AgentOnly | LIVE (core) + **real Registry sync (wave 1)** | unused |
| 4 | AppGated | not implemented | — |
| 5 | CrownBeneficiary | not implemented (config fee fields exist) | — |
| 6 | TitheSeat | not implemented | — |
| 7 | P2PToggle | **LIVE (wave 1)** | `[0]` mode: 0 = P2P-only / 1 = No-P2P (validated at write: >1 rejected) |
| 8 | HolderGated | **LIVE (wave 1)** | `[0..32]` gate mint, `[32..40]` min_amount u64 (write rejects a zero gate mint when enabled) |
| 9 | MaxWallet | LIVE (core) | `[0..2]` max_bps u16 of total supply |
| 10–16 | KingOfPool, AllowBlock, Grudge, TradingHours, VestingClock, DecayTax, BuybackBurn | not implemented | — |

`rule_implemented` = {1, 3, 7, 8, 9}. Config writes reject unknown ids (any state) and enabled-but-unimplemented ids — a config can never claim a rule Execute would skip.

### Rule 1 — Basis Latch (TH port)

Semantics exactly per TH / spec §5 rule 1, on **post-transfer balances** (deviation 4). Gate (non-exempt sender; skipped entirely when both sides are exempt): stale feed (`last_crank_ts == 0` or `now − last_crank_ts > max_stale_secs`) → veto `StalePrice` (16); holder without a basis record → veto `BasisMissing` (17); `unlocked := latched || ema < basis`, and in LATCH mode the first evaluation with `ema < basis` persists `latched = true` in the Holder PDA; not unlocked → veto `Locked` (15). LIVE mode never latches (`unlocked := ema < basis` only). Bookkeeping (non-exempt recipient, non-self-transfer): unit basis = feed EMA when the source is exempt (a buy off the pool/venue), else the sender's basis (wallet-to-wallet carry, owner-keyed — TH's rule); `new_basis = (old_bal · old_basis + amount · unit_basis) / post_bal` with `old_bal = post_bal − amount`. The PriceFeed is validated structurally (key == derived PDA) for *every* Execute, and parsed (owner/tag) whenever rule 1 is active and either side is non-exempt — a config running rule 1 without an initialized feed fails closed at transfer time.

**Crank (tag 5)** is permissionless and takes **no price input**: spot is computed from the feed's *pinned* vault balances (TH's formula generalized for decimals: `spot = quote · 1e12 · 10^(tok_dec − quote_dec) / token`, operation order swapped when quote_dec > token_dec to bound u128 headroom; empty token vault → `PriceFeedBad`). EMA fold is TH's: first crank takes spot; else `frac_bps = min(10000, elapsed_secs · 10000 / half_life)`, step toward spot, clamp the move to `max_crank_bps` of the previous EMA. Half-life/clamp are read from the first enabled Basis Latch rule entry (defaults when absent: immediate spot, unclamped). **Venue scope:** this crank prices *constant-product vault pairs* (house venue / DAMM-style). It does **not** price DBC pools — a bonding curve's spot comes from its curve state, not the vault ratio (the base vault holds the whole supply incl. vesting/leftover; the quote vault is drained by fee claims).

**CrankPriceDbc (tag 8)** is the DBC reader for the same feed account. Accounts: [config(ro), price_feed(w), dbc_pool(ro)] — CrankPrice is an engine instruction, so it may take the pool account directly (no meta-tail involvement). It validates, failing closed with `PriceFeedBad` (18): the feed's pinned pool field == the passed pool; the pool is owned by the DBC program (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`); the account is exactly 424 bytes (8-byte Anchor discriminator + 416-byte PoolState) with `base_mint` (@136) == the config's mint; `sqrt_price` (@280, u128) is non-zero. Spot is the curve's own marginal price in the feed's convention: `spot = (sqrt_price² / 2^128) · PRICE_SCALE · 10^(token_dec − quote_dec)`, computed as `((sq >> 64) · PRICE_SCALE) >> 64` then the decimal factor — the two-shift order bounds u128 headroom and is replicated op-for-op by the integration trial. The EMA fold (`ema_params` / `ema_fold` / `write_crank`) is shared verbatim with tag 5, so half-life/clamp/first-crank semantics are identical across venues. Why sqrt_price and not a reserves ratio: deviation 14.

### Rule 3 — Agent-Only (SyncRegistered)

Implemented exactly per `registry/INTEGRATION.md`. The Holder `registered` byte is a **mirror** of the Registry program's Registration PDA `active` byte (direct read in Execute is impossible: seeded metas resolve under the hook program's id, so a Registry PDA can never be a meta). `REGISTRY_ID = DQ3a7B5QeoDbrVeDC6cDuXrTe8wePLwhX9jPqXrhvL5V` is a compile-time const. Two paths:

- **(a) No account at index 6:** signer must be the config authority; byte := data[1]. (Core-build flows; trial T3/T4 unchanged.)
- **(b) Registration PDA appended at index 6:** **any** caller may sync (permissionless — the crank/keeper pattern). Validated strictly: key == PDA(`["registration", owner]`, REGISTRY_ID), owner == REGISTRY_ID, tag == 1, wallet field == owner; byte := (`active` == 1); **data[1] is ignored**. An appended-but-invalid registration account **fails the instruction** (`BadRegistration`, 22) — fail closed, no silent fall-back to path (a).

Either path creates the Holder PDA if missing (caller pays). Revocation lag is the documented mirror lag: deactivation takes effect at the next sync (INTEGRATION.md §4); trial T8 asserts both directions of the lag against the *real* Registry binary.

### Rule 7 — P2P Toggle

Signal = the `venue_context` verdict from caller validation (top-level instruction is a config-allowlisted venue program = venue; direct Token-2022 = wallet). Mode 0 (P2P-only): venue-context transfers veto `VenueTransferForbidden` (20). Mode 1 (No-P2P): wallet-context transfers veto `P2PTransferForbidden` (21). **Exemptions deliberately do not apply** — the counterparty on every venue trade is the exempt pool by construction, so honoring exemptions would make the rule vacuous; pool seeding is unaffected because it precedes config/meta init in the canonical launch order. Trial T11 produces venue context via the `venueshim` CPI harness (a top-level shim instruction CPI-ing TransferChecked; a sequential top-level TransferChecked can never fake it, since caller validation reads the *executing* instruction).

### Rule 8 — Holder-Gated

Destination owner must hold ≥ `min_amount` of the gate mint. The gate ATA can be **neither a meta** (it is a PDA of the ATA program — seeded metas resolve under the hook program's id) **nor an appended transfer account** (probe above: never forwarded). Solution: **SyncGateBalance** (tag 7), a same-transaction mirror bound by instruction introspection on both sides:

- The sync validates the presented account **is** the owner's canonical gate ATA: key == ATA derived on-chain for (owner, *the account's own token program*, gate mint), with mint/owner fields re-read from the account (`BadGateAccount`, 23, on any mismatch — a substituted account, someone else's ATA, or a wrong-mint account always fails here). It also validates the destination token account (this mint, that owner) and requires the **next** instruction in the transaction to be the Token-2022 Transfer/TransferChecked into that destination (sysvar introspection). It then writes the account's **live** balance into the Holder PDA scratch.
- Execute requires a SyncGateBalance for (this mint, destination owner) **adjacent** to the transfer instruction — scanning back from the current instruction, only a SyncRegistered may sit between — then compares the mirrored balance against `min_amount` (`NotGateHolder`, 19). No instruction between sync and transfer can move gate tokens, so the mirror cannot be stale inside its transaction, and a sync from an earlier transaction never counts (T12 asserts this).

**Consequence (accepted):** transfers built without the sync — venues that resolve only the meta list, DBC today — **fail closed**. Rule 8 is a client-surface rule in v1: the launcher trade page / agent skill always prepend the sync. A venue-side integration (venue prepends the sync per swap) is possible later without engine changes.

## Design decisions & deviations vs the spec (explicit)

1. **Fixed superset meta list — deliberate deviation from a config-driven reading of §2.1/§2.2.** The meta list is identical for every config rather than declaring exactly what the enabled modules need. Reason: if the tail depended on the rule stack, every `update_config` would desync the meta list and force a re-init (which the SPL interface does not support in place). A uniform tail keeps config updates self-contained; cost is a few always-present accounts per transfer. Module state needs are enforced inside Execute, not in the tail. **Tail v2 (this wave):** the PriceFeed PDA joined at meta index 4, exactly the versioned growth the core notes predicted ("adding a price meta later means a new meta list version, acceptable pre-launch"). Versioning rides the config's version byte: `load_config` enforces `ENGINE_VERSION = 2`, so v1 configs are rejected cleanly by this build, never misread.
2. **Known-but-unimplemented rules are rejected at config write time.** The spec (§2.2) requires *unknown* rule_ids to fail closed at init; this build also rejects rule_ids that exist in the catalog but have no Execute handler yet when **enabled** — a config must never claim enforcement the engine cannot deliver. Disabled entries of known-but-unimplemented rules are accepted (inert). Unknown ids are rejected enabled or not. Trial T6 covers both halves (its unimplemented case is now EscrowSplit; Basis Latch graduated to implemented in this wave). Wave 1 also validates per-rule params at write time (rule 7 mode, rule 8 gate mint).
3. **HolderVote configs can be created but not yet updated.** `update_config` on a HolderVote config returns `UnsupportedMode` (custom 8): per spec §5 the write path is a vote program that does not exist yet. Trial T5 asserts the explicit failure.
4. **⚠ Balance semantics discovery — read this before writing any balance-based module.** Token-2022 applies the transfer **before** invoking Execute: balances observed in Execute already include the in-flight amount (and the source is already debited). Evidence: trial T2's first 60k receive into a fresh account read a 60k destination balance inside Execute (LiteSVM, Agave Token-2022 build); corroborated by the production max-holding-hook (MidTermDev, mainnet + DBC), whose published rule reads `destination.amount` directly with no `+ amount`. TH never noticed: its gate reads basis/price state, never balances. MaxWallet checks the observed destination balance as-is; **Basis Latch bookkeeping is written in post-transfer terms** (`old_bal = post_bal − amount`). **Any future module doing balance math (vesting, grudge, escrow bookkeeping) must use post-transfer balances.** (DBC re-probe: the DBC workstream confirmed the same semantics through real `swap2WithTransferHook` trades.)
5. **Agent-Only registry integration — the stub is GONE.** Core deviation 5 promised the Registry would replace "the caller and the authorization" of tag 4 without touching the flag location or the Execute-side read. That is exactly what shipped: tag 4 is now SyncRegistered per `registry/INTEGRATION.md` (mirror model — INTEGRATION.md's design supersedes the stub-era idea of a registry CPI: programs can't write each other's accounts, and the registry is deliberately not a dependency of Execute). Flag location (Holder byte 1) and the module's read are unchanged; T3/T4 authority-path flows still pass via path (a).
6. **Exemptions match owner OR token-account key.** Spec §2.2 lists exemptions as pubkeys without saying which identity they name; the engine treats an exemption as satisfied if it equals the destination owner or the destination token account (covers both "this wallet is exempt" and "this pool vault is exempt" — TH checked the two cases separately). **Exception: rule 7 ignores exemptions entirely** (see module notes — otherwise vacuous).
7. **Spec-open parameters fixed here:** MAX_RULES = 8, MAX_VENUES = 4, MAX_EXEMPTIONS = 8, CONFIG_SPACE = 1,088 B, HOLDER_SPACE = 136 B, FEED_SPACE = 136 B. Rule params are the spec's fixed 64 B.
8. **Holder basis fields are LIVE as of wave 1** (core deviation 8 retired): basis_num/basis_den/latched sit at their spec offsets and carry real blending/ratcheting state; the PriceFeed PDA joined the tail as meta 4 with the version bump the core notes anticipated.
9. **Init order is enforced:** InitializeExtraAccountMetas loads the config and fails if it does not exist; InitializePriceFeed likewise requires the config. Launch order is therefore: mint (hook = engine) → InitializeConfig → (DBC pool creation) → InitializeExtraAccountMetas → InitializePriceFeed (if rule 1) → fund rent vault → trade.
10. **Blend formula corrected vs TH's literal code (wave 1).** TH weighted the old basis by the *post-transfer* balance in the numerator while also adding `amount · unit_basis` — double-counting the in-flight amount in the weight. The engine uses `old_bal = post_bal − amount` as the old weight: `new = (old_bal·old + amount·unit) / post_bal`. Invariants are identical (buys blend, cheaper rebuys ratchet down, wallet-to-wallet carries); exact values differ from a literal TH port. A receive into a zero balance starts fresh at the unit basis (falls out of the formula: old_bal = 0). Trial T9 pins the exact value (1,714,285,714 for the canonical blend).
11. **Staleness in unix seconds (wave 1).** Spec §2.4 sketches the feed with a crank *slot*; the engine stores `last_crank_ts` (unix seconds) and `max_stale_secs`, matching TH's trial semantics and the Registry's timestamp convention (and LiteSVM's controllable Clock). A slot-based variant would be a feed-layout change, not a semantic one.
12. **Latch mode byte: 0 = LATCH (wave 1).** Zeroed rule-1 params therefore mean the flagship defaults (LATCH, 300 s staleness, spot-following crank) rather than LIVE; LIVE is mode 1, deliberately opt-in.
13. **SyncRegistered path (b) fails closed (wave 1).** INTEGRATION.md describes the appended form as the validated form; this build treats an appended-but-invalid registration account as a hard failure rather than degrading to the authority path, so authority semantics can't be smuggled behind a junk account.
14. **DBC spot = `sqrt_price`, not a reserves ratio (V2 DBC hardening).** The pinned DBC program stores **no** fields named `virtual_token_reserves` / `virtual_sol_reserves` (checked in the program source and the SDK): PoolState carries `sqrt_price` (Q64.64) plus `base_reserve` / `quote_reserve`, which are cumulative swap accounting (their ratio is an average fill level, not the marginal price — at pool creation it is 0/max). The curve's implied virtual reserves at the current point are L/√P (base) and L·√P (quote) for the active segment's liquidity L; their ratio — the spot the mission intends — is exactly `sqrt_price² / 2^128`. Tag 8 therefore reads `sqrt_price`. Offsets (base_mint @136, sqrt_price @280 in account data) were verified empirically against the loaded binary in `integration/dbc-latch.mjs` (assertion P0 + every crank's exact-EMA assertions). No tail/layout/version change accompanied tag 8: ENGINE_VERSION stays 2.

## Trial (LiteSVM, `trial.mjs` — one command, needs `../registry` and `../venueshim` binaries built)

**64 passed, 0 failed** (`trial-result.json` carries the machine-readable count).

| Block | Covers | n |
|---|---|---|
| T0/T1 | config + meta init (version byte spot-checked = 2), no-rule transfer, no forced holder state | 4 |
| T2 | MaxWallet — 60k pass, exactly-at-cap (100k) pass, +1 veto, veto atomicity, exempt pool 200k | 5 |
| T3/T3b | Agent-Only authority-path — registered receives; unregistered vetoes explicitly, zero state leaked; empty rent vault → explicit `RentVaultUnderfunded` | 6 |
| T4 | module order — second-module veto kills the transfer in both stack orders | 2 |
| T5 | updates — non-authority `BadAuthority`, authority update enforced behaviorally, Locked rejects everyone, HolderVote explicit | 5 |
| T6 | rule_id 77 + enabled EscrowSplit rejected at init, nothing persisted | 3 |
| T7 | phantom Execute → `BadCaller` | 1 |
| T8 | **SyncRegistered vs the real Registry binary** — program-id match; register → unsynced veto (sync lag); permissionless sync by a stranger → receives; deactivate → pre-sync still receives (mirror lag) → sync (data byte ignored) → veto; bogus registration account → `BadRegistration` | 9 |
| T9 | **Basis Latch matrix** (mirrors TH's LATCH trial) — crank sets EMA exactly 2e9 from vault balances; buy basis exactly 2e9; sell + wallet transfer `Locked` at parity; liquidity doubles → crank exactly 1e9; dip sell sets latch, remainder basis intact; wallet-to-wallet carries basis exactly; rebuy blends to exactly 1,714,285,714; recovery — latched sells at profit, unlatched carry-holder re-locks; +301 s → `StalePrice` (even latched), exempt pool path unaffected; crank revives; tokens-without-basis → `BasisMissing` | 16 |
| T10 | **Basis Latch LIVE mode** — dip sell passes, no latch written, recovery re-locks | 2 |
| T11 | **P2P Toggle** — P2P-only: wallet pass, venue receive + send veto; No-P2P: wallet veto, venue pass (venue context via CPI shim) | 5 |
| T12 | **Holder-Gated** — under/at/over threshold; substituted ATA and wrong-mint account rejected at sync (`BadGateAccount`); no same-tx sync → veto even after earlier successful syncs | 6 |

## What the DBC integration workstream needs from the engine (updated for v2)

1. **Re-run the DBC integration suite against engine v2 — DONE (V2 DBC hardening).** `integration/dbc-engine-integration-v2.mjs`: **42/42** — all seven v2 extras forwarded verbatim (PriceFeed PDA at tail index 4, both literals intact; swap instruction = 24 keys), Execute receives all 12 accounts (`accounts=12, venue=true` in the engine log), and every v1 behavioral verdict carries over (Agent-Only veto/register/pass, Max Wallet post-transfer veto with the identical received amount 3,705,647,150,730). The graduation suite also passes against the v2 binary (22/22). DBC launches are now proven against engine **v2**.
2. **Venue allowlist:** DBC swaps arrive with the DBC program (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`) as the top-level instruction — it must be in the launch config's venue allowlist or every DBC swap fails `BadCaller`. Direct wallet transfers take the Token-2022 branch and need no allowlist entry.
3. **Exempt the pool side:** DBC pool vault/authority accounts must sit in the config exemptions or pool operations will trip MaxWallet / Agent-Only (the production max-holding-hook hardcodes the DBC/DAMM pool authorities for the same reason; ours are per-mint config). Rule 7 is the exception — it ignores exemptions by design.
4. **Rule availability on DBC:** rule 8 fails closed on DBC (its client builds transfers from the meta list only — no sync instruction is prepended). Rule 1 is now fully DBC-live: CrankPriceDbc (tag 8) prices the curve, and the end-to-end latch (buy at cranked EMA → Locked veto → dip → latch → profit sell → staleness → revive) is proven in `integration/dbc-latch.mjs` (**55/55**). Rules 1, 3, 7, 9 are DBC-compatible; rule 7's venue detection is precisely the DBC caller branch.
5. **Launch sequencing:** config first, meta list **after** pool creation (DBC requirement from the proof), price feed after config, rent vault funded before the first buy that could lazily create a holder. Engine init instructions are payer-agnostic (DBC moves the mint's hook *authority* to the pool authority at pool creation; our InitializeExtraAccountMetas deliberately performs no payer-identity check, matching the proof hook's flow).
6. **Graduation:** DBC revokes the hook program/authority at curve completion — engine state (config, holders, feed) becomes inert history. Nothing is required from the engine, but launcher surfaces must stop presenting the config as live after graduation. The Transfer Fee extension survives, so Distributor claims (later workstream) are unaffected.
7. **First-buy rule:** do not bundle the first buy into pool creation (meta list does not exist yet) — same constraint the proof and the production hook both document.

---

# ADDENDUM — Ecosystem Gate, rule 17 (2026-10-15)

Full design: `../SPEC-ECOSYSTEM-GATE.md`. State at the end of this
workstream:

1. **Rule 17 `RULE_ECOSYSTEM_GATE` implemented.** Params `[0]` = required
   ecosystem id (1..=16 validated at config write for enabled entries).
   Known range is now 1..=17; implemented set {1, 3, 7, 8, 9, 17}.
   Execute reads the destination Holder PDA's mirror bytes (1 =
   registered, 2 = ecosystem, both written by SyncRegistered): unregistered
   → veto `NotRegistered` (1); registered but wrong/absent tag → veto
   `WrongEcosystem` (24, new). Exempt destinations skip; lazy dst-holder
   creation matches rule 3 (the lazy init runs inside the transfer tx, so
   a veto rolls it back — a veto leaves no side effects).
2. **Holder PDA byte 2** is the ecosystem mirror (was reserved-zero).
   `ENGINE_VERSION` stays **2**; no account layout changed — live configs
   (AGTR) load identically on the new binary.
3. **SyncRegistered mirrors both bytes** from one Registration PDA
   snapshot; path (b) fails `BadRegistration` on a nonzero ecosystem byte
   whose record is not ATTESTED (verified_via ≠ 1); path (a) accepts an
   optional `[2]` ecosystem byte (absent = 0).
4. **Proof:** engine trial 64/64 (unchanged), registry trial 64/64
   (23 v1 + 41 attestation), `integration/ecosystem-gate.mjs` **28/28**
   (cross-program: attested pass, cross-ecosystem veto both ways,
   untagged veto, ghost veto + rollback, deactivation cycle, config-write
   validation, AGTR-shape spot check). Suites run against the trial build
   (`REGISTRY_ID` = dev id) preserved at `target/engine-trial.so`;
   `target/deploy/engine.so` is the mainnet-const deploy build (186,392 B,
   sha256 `a7da57db41989cb96ff1d445a69b5fde2f1edd63d2211713be39f1fac32f5e86`).
   **Not deployed** — the upgrade package waits in the spec (§7).

---

# ADDENDUM — Graduated Latch, rule 1 mode 2 (2026-10-15)

Full design: `../SPEC-GRADUATED-LATCH.md`. State at the end of this
workstream:

1. **Rule 1 mode 2 `GRADUATED` implemented** in the same source as rule
   17 — the mainnet package is ONE combined engine binary (rule 17 +
   Graduated Latch) plus Registry v2, a single engine upgrade. Params:
   `[18]` mode (0 LATCH / 1 LIVE / 2 GRADUATED, now write-validated
   0..=2 for enabled rule 1), `[19..21]` base_frac_bps (write-validated
   ≤ 10000), `[21..29]` vesting_secs (0 → 432,000 = 5 days),
   `[29..31]` dip_mult_bps (0 → 20,000 = 2×: a 50% drawdown dip-earns
   100%). Sellable fraction = 10000 if latched, else
   max(base, time-vested, dip-earned); the classic latch still fires
   and persists in GRADUATED (the latch is the limit case). Anti-leak
   is a ratcheted raw-unit cap over PEAK balance
   (`cap = max(cap, frac × peak / 10000)` at every graduated
   evaluation; `sold + amount > cap` vetoes with the new error
   `PartialLocked` = 25) — a bps floor was rejected because floor ×
   grown peak lets a dust-vested holder whale-buy and dump.
2. **Holder layout is length-versioned; `ENGINE_VERSION` stays 2.**
   The config layout (what the version byte versions) is untouched —
   bumping it would orphan AGTR's live v2 config. Legacy layout stays
   136 B (`HOLDER_SPACE`); graduated state lives in an appended region
   `[136..192]`: peak @136, sold @144, cap @152, anchor i64 @160,
   min_price u128 @168. Legacy 136 B holders are lazily migrated on
   their first GRADUATED evaluation (rent top-up from the mint's rent
   vault, ≈ 389,760 lamports, then realloc; underfunded vault fails
   `RentVaultUnderfunded`). Non-graduated configs never migrate and
   holder creation stays 136 B unless the config carries an enabled
   GRADUATED rule (else 192 B) — AGTR is byte-identical, rent
   included. `min_price` is observed only at that holder's own
   transfer evaluations (cranks never touch holder state) — the same
   observation limitation the classic latch has always had.
3. **Proof (all on the combined binary):** new suite
   `trial-graduated.mjs` **90/90** (time boundaries exact to the raw
   unit, dip fractions at 10/25/50% drawdowns, latch permanence,
   anti-leak cap exactness, blended-rebuy accounting, migration incl.
   the unfunded-vault and never-migrate-under-LATCH cases, write
   validation, self-transfer skip); regressions: engine trial
   **64/64**, DBC latch integration **55/55**, ecosystem-gate
   integration **28/28**. Builds: trial `target/engine-trial.so`
   197,280 B sha256 `bc93010376697d920d2c8e3534cc143f7fe0111ac71f36b6d78ce04a9c0cfc80`;
   mainnet-const `target/deploy/engine.so` 197,280 B sha256
   `b2bd27d2276acf293c6df8f22e0b30f8284c4b68cd90e6a23e91ce71be602269`
   (differ only in the `REGISTRY_ID` const). One compile fix during
   the build: `ensure_graduated` takes a single named lifetime
   (AccountInfo invariance, same shape as `ensure_dst_holder`).
   **Not deployed** — packaged with the wave per
   SPEC-GRADUATED-LATCH §8; the TaxHarvest launch spec rides there too
   (rule stack [rule 1 GRADUATED defaults, rule 9 Max Wallet 300 bps =
   3% of supply per wallet], Locked, DBC fee claimer = fren's wallet,
   holder-fees routing OFF; name + SOL top-up still Gregory's).

---

# ADDENDUM — Distributor caller acceptance, the fee-fold fix (2026-10-16)

Found live on AGTR's first holder-fee cycle, then in sim
(`distributor/trial-hooked.mjs` header + `distributor/HOOK-EXTRAS-FIX.md`):
the Distributor's hook-extras fix lets payout CPIs reach Execute, but
Execute's caller validation accepted only (a) Token-2022
Transfer/TransferChecked as top-level, or (b) a program on the config's
venue allowlist. A standalone Distributor transaction (distribute tag 1 /
claim tag 2 / settle tag 3) is top-level Distributor, so every payout
transfer on a hooked mint was vetoed `BadCaller` (custom 3). AGTR's live
config is Locked with venues=[DBC] — unamendable, and the distributor is
not on it. The hooked trial only passed because its sim config cheated
(venues=[DISTRIBUTOR]).

1. **Third caller branch in `execute()`** (after the Token-2022 branch,
   before the venue branch): if the top-level instruction's program is
   the Distributor (`DISTRIBUTOR_ID` const + `distributor_id()` helper,
   next to `REGISTRY_ID` / `registry_id()`), accept ONLY IF the
   transfer's authority (Execute account index 3) equals this mint's
   distributor state PDA, `find_program_address(["dist", mint],
   DISTRIBUTOR_ID)` — the distributor's own state seeds
   (distributor/src/lib.rs). Any other authority under a Distributor
   top-level instruction rejects `BadCaller` with a distinct log
   (`engine: rejected distributor caller, authority … != distributor
   state PDA …`).
2. **Why the authority requirement makes the acceptance tight.** The
   state PDA is the vault ATA's owner, and it has no private key: the
   only way a transfer ever carries its signature is the Distributor
   program itself producing it via `invoke_signed` for its own vault
   transfers — and the Distributor's code paths (`cpi_vault_transfer`)
   sign with exactly that PDA and no other authority. So the branch
   admits precisely the genuine payout shape (distribute cut,
   claim/settle entitlement) and nothing else: a rogue caller who
   somehow got a Distributor-top-level transaction to CPI a transfer
   would still need the PDA's signature, which only the Distributor
   program can produce, and only for its own vault payouts. Program-id
   match alone is NOT sufficient — the sim proves it (negative control
   N2 below). The check is also per-mint: the expected PDA is derived
   from the transfer's own mint, so one mint's distributor state cannot
   authorize another mint's transfers.
3. **`venue_context = false` on this branch.** A payout is not a venue
   trade; it classifies exactly like a direct wallet transfer for
   rule 7 (P2P Toggle): under a No-P2P config (mode 1) distributor
   payouts would veto `P2PTransferForbidden`, under P2P-only (mode 0)
   they pass rule 7. No launcher config ships rule 7 together with
   holder-fee routing today; the classification is deliberate — the
   alternative (venue=true) would let payouts masquerade as trades to
   every rule that reads the context bit.
4. **Build flavors (same const-swap mechanism as REGISTRY_ID).** The
   committed source carries the mainnet ids (REGISTRY_ID
   `GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e`, DISTRIBUTOR_ID
   `DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa`) → deploy build
   `target/deploy/engine.so`. The trial build swaps BOTH consts to the
   dev ids the suites load (registry `DQ3a7B5QeoDbrVeDC6cDuXrTe8wePLwhX9jPqXrhvL5V`;
   distributor `2kTYd7HzTtSBBwJW2yXBQ6Q2aLf49xrv1SqU7BN9ckoS` —
   `distributor/distributor-keypair.json`, the id every distributor
   suite loads its binary under per INTEGRATION.md and both
   trial-result.json files; NOT the unused cargo-generated keypair at
   `distributor/target/deploy/distributor-keypair.json`) → preserved at
   `target/engine-trial.so`. The two builds differ in 86 bytes (the two
   embedded pubkey consts). New size **198,400 B** (+1,120 over the
   pre-fix 197,280 B): deploy sha256
   `800a3fb4077b83fadd8b1da6f7fef5db236570509cf8e54becfef9d5c8e0dc72`,
   trial sha256
   `986f0e35500cf826491894199809f1d3c88daf43945cfee00f4d3edbe442aee5`.
   (Build reproducibility verified during this workstream: the pre-fix
   source rebuilds byte-exact to `b2bd27d2…`.)
5. **Proof (all counts identical to pre-fix baselines, re-measured
   before and after):** engine trial **64/64**, engine trial-graduated
   **90/90**, integration dbc-latch **55/55**, integration
   ecosystem-gate **28/28**, distributor trial (hookless) **61/61**,
   distributor trial-hooked **23/23** — the hooked suite now running
   against the new distributor binary (`dbf9a31c…`, hook-extras fix)
   AND the new trial engine. NEW composition suite
   **`distributor/trial-fold.mjs` 23/23**: AGTR-faithful config
   (rules [3, 9@500], **Locked**, venues=[DBC
   `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`] ONLY) — routed
   deposit lands; standalone distribute with cut 90 TOK > 0 lands and
   the cut arrives exactly; standalone settle+claim pays holder A a
   nonzero entitlement exactly (269,703,054 raw on the trial numbers);
   conservation holds (vault == R − cut − entitlement, fold identity
   U == 0). Negative controls in the same harness: **N1** a
   payout-shaped transfer driven by venueshim
   (`DyiJ4TXMEVXZJqNYiZZiKX25V8m5vN7mkCkXxByFaPpZ`, not in venues, not
   the distributor) as top-level → `BadCaller`; **N2** distributor
   program id as top-level but transfer authority a plain wallet →
   `BadCaller` via the branch's distinct log (constructed by loading
   venueshim code under the distributor address in its own LiteSVM
   world — the real Distributor cannot produce this shape, which is
   the point of the check; program-substitution idiom as in
   trial-hooked S4b). `trial-hooked.mjs` is unchanged — the original
   23/23 file keeps its venues=[DISTRIBUTOR] setup as the A/B record.
   **Not deployed** — local build + sim only; the mainnet engine
   upgrade is a separate, separately-authorized step.

---

# ADDENDUM — Per-config meta-list templating (Phase 2, 2026-10-16)

**Status: LOCAL ONLY — NOT DEPLOYED.** The source tree is now AHEAD of
the deployed mainnet engine (`EPdYVfsX…`, which still runs the Phase 1
combined binary, 198,400 B, sha256 `800a3fb4…`). Nothing in this
addendum has touched mainnet; the upgrade is a separate,
separately-authorized step. All proof is LiteSVM/local.

## Problem (recap)

The fixed 7-extra superset published two Holder PDA entries seeded from
token-account DATA (the owner field at offset 32). The standard generic
resolver (spl-token's `addExtraAccountMetasForExecute`, used internally
by the DBC SDK's `swap2WithTransferHook` and by generic routers/bots
like BasedBot) must READ the destination token account to derive those
PDAs — for a first-time buyer the ATA does not exist yet, so the build
throws `TokenTransferHookAccountDataNotFound` before any transaction is
even assembled (established in the router-compatibility work, see
`../SPEC-ROUTER-COMPAT.md`). Tokens whose rules need no holder state now
publish a fully static list and are generic-resolver safe.

## 1. Classification (from source; `required_extras` in lib.rs is the
single source of truth shared by init / refresh / update-warning /
Execute's gate)

Canonical order (subsequence-preserving): 0 config, 1 src holder,
2 dst holder, 3 rent vault, 4 price feed, 5 system, 6 instructions
sysvar. Only ENABLED rules count.

| idx | extra | requirement | derivation (functions) |
|---|---|---|---|
| 0 | config PDA | **unconditional** | `execute()` always `load_config()`s it |
| 6 | instructions sysvar | **unconditional** | `execute()` always validates the caller via sysvar introspection; `module_holder_gated` also scans it |
| 1 | src Holder PDA | rules {1} | `module_basis_latch` gate reads sender state (`holder_basis`, `holder_latched`, graduated region). No other module reads the source holder |
| 2 | dst Holder PDA | rules {1, 3, 8, 17} | rule 1 bookkeeping blends recipient basis into it; `module_agent_only` reads its registered byte; `module_ecosystem_gate` reads registered + ecosystem bytes; `module_holder_gated` reads its custom-region gate balance — the **destination** holder's PDA (mirror written by `sync_gate_balance`) |
| 3 | rent vault PDA | rules {1, 3, 17} | only when Execute can pay for holder state: creation/migration sites are `ensure_dst_holder` (called from `module_agent_only`, `module_ecosystem_gate`, rule-1 bookkeeping) and `ensure_graduated` (rule 1 GRADUATED, src + dst top-ups). Rule 8 never creates in Execute (missing holder → `NotGateHolder`; `SyncGateBalance` creates outside Execute), so rule 8 does NOT pull in the vault |
| 4 | price feed PDA | rules {1} | `module_basis_latch` `load_feed()`s it on every gated/bookkept path; nothing else reads it |
| 5 | system program | rules {1, 3, 17} | consumed by exactly the same creation/migration sites as the rent vault (`ensure_dst_holder` allocate/assign CPIs) |

Rule 9 reads only the destination token account balance + config +
supply; rule 7 reads only `ctx.venue_context` (derived from the sysvar).
Resulting shapes: rules {9} or {7} or {} → **2 extras** (config, sysvar),
86 B, fully static. {3,9} (AGTR) / {17} / {8} → 5 extras, 191 B ({8} → 3
extras: config, dst holder, sysvar — no vault/system, per the table).
{1, …} (Latch) → the full **7 extras, 261 B, byte-identical entries** to
the legacy list (same seeds/flags via the shared `build_metas`).

## 2. Engine changes

- **`build_metas(mask)`** constructs the entries in canonical order;
  `InitializeExtraAccountMetas` now derives the mask from the loaded
  config (`required_extras(&cfg.rules)`) instead of publishing the fixed
  superset. Holder-needing configs publish exactly the legacy bytes.
- **Execute key-matching.** After the 5 fixed accounts, every supplied
  extra is matched against the derivable candidate keys (config PDA,
  holder PDA(src owner), holder PDA(dst owner), rent vault PDA, price
  feed PDA, system program, instructions sysvar) in canonical order: a
  supplied account must match the first not-yet-passed candidate with
  its key — unrecognized key, duplicate, or out-of-order account all
  fail `BadCaller`. Alias case handled explicitly: when src owner ==
  dst owner the two holder PDAs are the same key; one occurrence fills
  both slots and a second (superset-style) occurrence is accepted as the
  aliased entry. Slots land in `ExecuteCtx` as `Option<AccountInfo>`
  with accessor methods; modules run unchanged apart from accessor calls.
- **Required-set gate.** After `load_config`, Execute computes
  `required_extras(&cfg.rules)`; any required slot left unfilled fails
  with the NEW error **`MissingExtra = 26`** (appended to `EngineError`;
  no existing code renumbered). The gate — not the Option types — is the
  guarantee modules rely on: a module only ever runs when every slot its
  rule declares is present. Config itself is unconditional (missing →
  `MissingExtra` before the config can even load).
- **Backward compatibility is total:** the full 7-extra superset is a
  valid input for every config (it covers every required set), so all
  pre-existing clients/trials that append it manually — engine trial,
  graduated trial, ecosystem-gate, distributor suites — execute
  identically. Proven by the unchanged suite counts below.
- **Tag 9 `RefreshExtraAccountMetas`** — accounts [payer(signer,w),
  meta_list(w), mint, config(ro), system]. Recomputes the set from the
  CURRENT config, funds any rent increase from the payer (transfer
  inside the instruction), reallocs the account, and rewrites the TLV
  via `ExtraAccountMetaList::update`. On shrink the excess lamports are
  NOT refunded — they stay in the meta-list account as rent float (a
  later growth refresh consumes them first); this is deliberate and
  commented in the code. Permissionless apart from the funding signer:
  the contents are a pure function of the on-chain config.
- **UpdateConfig desync rule.** An update whose new required set is not
  a subset of the old set is ALLOWED, but the engine logs the expansion
  and the operator flow is: refresh (tag 9) must follow before transfers
  needing the new extras work; meanwhile Execute fails those transfers
  closed with `MissingExtra` (transfers needing only the old extras
  keep working). Client-side: **no config-update path exists** in
  `launcher/launch.mjs`, `launcher/hook.mjs`, or the browser bundle
  (checked: hook.mjs only reads config in `status`), so there was no
  client update path to bundle the refresh into — documented only, plus
  `hook.mjs`'s error table gained entries 24/25/26 so a `MissingExtra`
  surfaces with operator guidance.
- **`ENGINE_VERSION` stays 2.** The version byte versions the CONFIG
  layout, which is untouched (and the Holder layout is untouched too).
  Bumping it would orphan every live v2 config (AGTR's included) for a
  change that lives entirely in the meta-list account's CONTENTS and in
  Execute's consumption of supplied accounts — neither is a config or
  holder layout concern. The meta list was already versioned by content
  in practice (tail v1 → v2 rode the same byte only because the config
  payload grew a field then; nothing here does).

## 3. Launcher changes

`launch.mjs` gains `requiredExtras()` (a mirror of the engine
classification) + `metaListSize()` / `metaListRent()`; the helpers are
sliced into `browser-src/helpers.generated.mjs` by the existing
extractor (regenerated) and the browser entry's plan mirrors the CLI.
The L4 plan line now reports the templated count, each extra and why,
and the byte size — AGTR shape: "5 extras: config — unconditional …;
dst holder — …; rent vault — …; system — …; instructions sysvar — …;
191 bytes"; Max-Wallet-only: "2 extras … 86 bytes — no holder state:
fully static, generic-resolver safe". The L6 advisory becomes
conditional (static tokens need no ATA pre-creation). The L4
instruction itself is unchanged (disc-only data). Budget math now uses
the templated meta rent (sample-spec total 0.065325 → 0.064838 SOL).
`dry-run-output.txt` regenerated; README + skill.md budget rows updated
to the templated range. **AGTR + Latch spec byte-compat preserved:**
`launcher/trial-graduation.mjs` still passes 35/35, including the L1/L3
artifact-hash baselines for both shipped launch records (the L4 plan
TEXT for AGTR changes — 5 templated extras instead of "7 extras" — but
the on-chain L1/L3 artifacts the trial hashes do not).

## 4. Proof — `integration/dbc-templating.mjs` (NEW, 34/34)

Real DBC + engine binaries in LiteSVM, launches through the same
instruction sequence `launch.mjs` uses.

- **A (Max-Wallet-only, rule 9 @9000bps).** Published list decoded from
  the account: exactly 2 entries — `[0] pda[literal("config"),
  accountkey(1)]`, `[1] pubkey(Sysvar1nstructions…)` — NO AccountData
  seeds anywhere; account 86 bytes. Fresh buyer, ATA nonexistent:
  generic `swap2WithTransferHook` build **succeeds**; the generic
  [create ATA, swap] bundle lands; received exactly 3,758,140,828,991
  raw for 0.05 SOL. Sell of 1,000 tokens lands and debits exactly.
  Second buy lands and increases the balance. Cap tightened to 20 bps
  via UpdateConfig (same required set, no refresh): a fresh buyer's
  generic build still succeeds, the buy **vetoes `MaxWalletExceeded`**
  atomically, and passes after the cap is restored — rule enforcement
  did not leak away with the shorter list.
- **B (negative control, Agent-Only rule 3).** Published list decodes
  to 5 entries including `accountdata(acct=2, off=32, len=32)` on the
  dst holder. The same fresh-wallet generic build **throws**, captured
  string: `TokenTransferHookAccountDataNotFound` (error name and
  message both carry it). After pre-creating the ATA, the identical
  build succeeds — cause isolated to AccountData resolution.
- **C (desync + refresh).** Max-Wallet mint → UpdateConfig expands to
  rules [3, 9]: update allowed, engine logs the refresh requirement;
  a registered buyer's buy (ATA pre-created) **fails closed with
  `MissingExtra` (custom 0x1a = 26)**, nothing moves. Tag 9 refresh
  lands; the list republishes at 5 extras incl. the dst-holder
  AccountData entry; the same buy then passes.

## 5. Suite counts (baseline → final, all on the final binaries)

| suite | baseline | final | note |
|---|---|---|---|
| engine trial | 64/64 | **64/64** | unchanged |
| engine trial-graduated | 90/90 | **90/90** | count unchanged; FLOW change in G7a/G7b: those cases launch a no-rules mint then UpdateConfig-expand to GRADUATED — under templating the operator flow now requires the tag-9 refresh, so both flows gained a `RefreshExtraAccountMetas` step after the update (named in code comments). No assertion was altered |
| registry trial | 64/64 | **64/64** | unchanged |
| distributor trial | 61/61 | **61/61** | unchanged |
| distributor trial-hooked | 23/23 | **23/23** | unchanged (manually-appended superset extras still execute — back-compat) |
| distributor trial-fold | 23/23 | **23/23** | unchanged |
| integration ecosystem-gate | 28/28 | **28/28** | unchanged (manual superset resolution) |
| integration dbc-engine-integration-v2 | 42/42 | **40/40** | count −2, NAMED: the per-key tail loop now iterates the templated tail for its [3,9] config (7 entries instead of 9 — src holder and price feed are no longer published), and three shape assertions were updated to the templated truth (meta account 261→191 B; swap keys 24→22; Execute accounts 12→10). Every published extra is still asserted key-by-key; no assertion was weakened |
| integration dbc-latch | 55/55 | **55/55** | unchanged (rule 1 publishes the full legacy 7) |
| integration dbc-templating (NEW) | — | **34/34** | section 4 |
| launcher trial-graduation | 35/35 | **35/35** | L1/L3 artifact hashes for AGTR + Latch records byte-identical |
| launcher browser harness | 38/38 | **38/38** | equivalence + simulation; the L4 instruction (disc-only) is byte-identical, plan text/budget updated as above |

Builds: both flavors rebuilt from the final source with
`cargo build-sbf --arch v1`, **213,600 B** (was 198,400 B; +15,200 for
the matcher, gate, refresh, and templating): mainnet-const
`target/deploy/engine.so` sha256
`2e37f414322b6693311bf1fc632788d9b0afe0462177f98fb9126a3c72f2fa31`;
trial-const `target/engine-trial.so` sha256
`c95aa6ff72302ff1a992f3a4c35632064312befbbfbfe8d8c990d76a19b6e37f`
(REGISTRY_ID / DISTRIBUTOR_ID dev ids, the established const-swap —
the battery runs with the trial flavor copied into the deploy slot, as
in prior workstreams, and the mainnet flavor is restored afterwards).
Reproducibility note: comment-only source edits DO move the binary
(panic-location line numbers are embedded), so the artifacts above are
built from the exact committed source, post-comments.

**Deployment note (explicit):** the deployed mainnet engine still
publishes the fixed superset for every mint, including AGTR and Latch.
This addendum's templating takes effect only when this build is
upgraded onto the mainnet program — a separate step needing Gregory's
go. After such an upgrade, EXISTING mints keep their already-published
7-extra lists (still valid — the superset executes identically) until
someone runs tag 9 on them; new launches template from birth.


---

## ENGINE V3 ADDENDUM (2026-10-16) — AccountKey derivation, MigrateHolder, SyncHolder

Implements SPEC-ENGINE-V3 §§9–10 (verdict: Option A now, C as the
standing floor, B deferred). Authorized by Gregory 2026-10-16 16:12
EDT ("build Engine v3 when the study verdict lands viable"). Deploy
sheet: `deploy/ENGINE-V3-DEPLOY-SHEET.md`. **Not deployed.**

### What changed in the program

- **Holder derivation (the whole point).** `build_metas` publishes the
  two holder entries with `Seed::AccountKey` over the source (index 0)
  and destination (index 2) token accounts instead of v2's
  `Seed::AccountData` owner reads. Holder PDAs are now
  `["holder", mint, token_account]`. The generic resolver derives a
  first-time buyer's record from the ATA address (a pure function of
  owner + token program + mint) without reading any account — the
  `TokenTransferHookAccountDataNotFound` wall is gone for every
  config, templated or not. BOTH entries switched together (a mixed
  list is semantically incoherent — §9.1).
- **`ENGINE_VERSION` stays 2.** The byte versions the Config layout,
  which A does not touch; the v3 binary must keep loading live v2
  configs for the retrofit to reach them (precedent: the graduated
  extension also kept it).
- **Tag 3 (InitializeHolder)** now takes the token account at index 2
  (was: owner). Address-bound creation: the account need not exist
  yet; when it does, its mint field must match.
- **Tag 4 (SyncRegistered)** validates/creates the record at
  `["holder", mint, ata(owner)]`, deriving the ATA in-program from
  (owner, the mint's token program, mint). Authorization paths and
  byte semantics unchanged; registration stays a wallet property.
- **Tag 7 (SyncGateBalance)** mirrors into the record keyed by the
  bound transfer's DESTINATION token account (was: the owner's).
- **Tag 10 (MigrateHolder, NEW)** — permissionless retrofit: validates
  the presented ATA (mint + owner fields), copies the legacy
  owner-keyed record VERBATIM to the ATA-keyed address (created from
  the rent vault at `max(legacy size, config creation size)`), closes
  the legacy account and refunds its rent to the vault. Missing
  legacy record → `HolderMissing`; live v3 record → `AlreadyInit`.
- **Tag 11 (SyncHolder, NEW)** — owner-signed merge of one token
  account's record into another's (the §9.2(ii) fragmentation
  repair): registered OR, ecosystem dst-else-src, latch OR, basis =
  balance-weighted blend against live balances (a side with balance
  but no basis contributes the other side's basis — never zero),
  anchor blended likewise, peak = max(src, dst, combined balance),
  sold summed, cap = min(cap sum, merged peak), min_price = min of
  the nonzero pair, gate mirror = the larger balance; the reward
  region keeps the destination's (the Distributor owns reward state).
  Source record closes to the vault. Self-merge rejected.
- Execute's matcher, alias rule (now: the literal same token account
  on both sides), caller validation, rule semantics: unchanged.

### Clients

- `launch.mjs` / composer (`browser-src/entry.mjs`): v3 derivations
  (L7b mirror = the record over the distributor vault ATA itself;
  dev-buy L8b mirror = the record over the launcher's ATA). The
  composer bundle was rebuilt into the site tree but NOT deployed —
  it ships in the upgrade window (deploying a v3 client against the
  live v2 engine would break the composer's L7b today).
- `hook.mjs`: dual-generation. `holderMode()` reads the token's
  published meta list and follows its seed form (AccountData → v2
  owner-keyed, AccountKey → v3 account-keyed), so the same CLI serves
  live AGTR/Latch today and v3 tokens after the window. New commands:
  `migrate` (tag 10 for the caller's wallet) and `merge` (tag 11).
- `browser-src/trade-entry.mjs`: deliberately UNCHANGED (v2) — the
  trade page serves the live v2 tokens; its derivation flips in the
  deployment window (deploy sheet step 5).
- `browser-src/harness.mjs`: the AGTR-identities L7b mainnet
  simulation is now a **deployment tripwire** — it asserts the live
  (v2) engine rejects the v3-shaped ix with InvalidSeeds; the
  byte-equality check (browser ix == reference ix) is unchanged and
  remains the durable builder proof. Restore the positive simulation
  after the upgrade (the harness comment says so).

### Battery on the v3 binary (trial flavor in the deploy slot)

| suite | v2/Phase-2 | v3 | note |
|---|---|---|---|
| engine trial | 64/64 | **64/64** | derivations flipped like-for-like |
| engine trial-graduated | 90/90 | **90/90** | incl. legacy-layout (136 B) growth cases |
| engine trial-v3 (NEW) | — | **29/29** | tags 3/4 retargets, tag 10 (verbatim copy, rent-neutral to the lamport, HolderMissing/AlreadyInit/BadState), tag 11 (blend arithmetic exact: basis 1.7e9, anchor 1300, cap min(sum, peak); negatives) |
| integration dbc-v3-headline (NEW) | — | **43/43** | Part 1: graduated token, fresh wallet, first buy built ONLY through the generic resolver (ATA nonexistent at build) lands; basis == EMA, peak == balance; full sell vetoes PartialLocked at t+0, lands post-vesting. Part 2: real v2-binary state transplanted → MigrateHolder → tag-9 flip → migrated holder sells generically, fresh wallet buys generically on the migrated mint |
| integration dbc-engine-integration-v2 | 40/40 | **40/40** | |
| integration dbc-latch | 55/55 | **55/55** | |
| integration ecosystem-gate | 28/28 | **28/28** | |
| integration dbc-templating | 34/34 | **35/35** | count +1, NAMED: §B's v2 negative control (generic build THROWS AccountDataNotFound) is abolished by design — rewritten as the positive proof (AccountKey list; registered generic first buy LANDS; record at the ATA-keyed PDA); §C8 updated to the AccountKey shape |
| integration dbc-devbuy | 21/21 | **21/21** | |
| distributor trial / hooked / fold | 61/61, 23/23, 23/23 | **61/61, 23/23, 23/23** | payout CPI extras resolve under account-keying unchanged |
| launcher trial-launch-features | 32/32 | **32/32** | |
| launcher trial-graduation | 35/35 | **35/35** | AGTR + Latch record dry-run hashes byte-identical |
| browser harness | 44/44 | **44/44** | with the L7b tripwire assertion (above) |
| site composer smoke | 65/65 | **65/65** | against the rebuilt (undeployed) bundle in the site tree |

AGTR/Latch launch records untouched (sha256 in the deploy sheet).

### Builds

Both flavors from the final source, `cargo build-sbf --arch v1`,
**239,008 B**: mainnet-const `target/engine-mainnet.so` sha256
`4df89c0e114d4b25e6e9b66fc10aa2bf0d8b950da2320552e3f1744f437a8c44`;
trial-const `target/engine-trial.so` (resting in the deploy slot)
sha256 `a654b136ec381cd2203497b4d09b9e1b2717943bfb0a01b5f60033f9854a2666`.
v2 source + binaries preserved under `engine/v2-snapshot/`.
Deploy cost sheet + sequence + the AlreadyInit window edge:
`deploy/ENGINE-V3-DEPLOY-SHEET.md` (permanent ≈ 0.22 SOL — above the
study's estimate; the sheet explains why).

DEPLOYMENT ADDENDUM (2026-10-16, the v3 window): ATTEMPTED AND ROLLED
BACK — full record in deploy/DEPLOY-RECORD-V3.md. The upgrade landed
(tx 4W8QXpb8…), but tag 9 PANICKED against both tokens' live meta lists
and the window stopped before any flip or migration. Root cause, in
refresh_extra_account_metas: the account is realloc'd to the new
templated size BEFORE ExtraAccountMetaList::update runs — on a SHRINK
(launch-era 261 B superset list -> smaller v3 list) the truncation
leaves the TLV entry declaring its old length, TlvStateMut::unpack
returns InvalidAccountData, and the library's unwrap panics
(spl-tlv-account-resolution state.rs:188). No suite caught it because
every refresh fixture started from a templating-era list (refresh only
ever grew or matched size), and the retrofit rehearsal's "v2" lists were
written by the Phase-2 snapshot build, not the launch-era binary that
wrote mainnet's lists. FIX for the next build: update() first (its
realloc_first keeps the TLV consistent), then resize the account and
settle rent both ways; regression fixture = the preserved mainnet list
bytes (deploy/v3-window/raw/pre-*-metalist.b64) refreshed down to
every shipping mask. Rollback restored the exact v2 foldfix binary and
verified every token account byte-identical to the pre-flight
snapshot (9/9 checks). Window cost 0.16248468 SOL total, of which
0.15999968 is the programdata extend — programdata stays 239,053 B,
so the next window needs no extend. Process lesson: the upgrader's
dummy-blockhash simulation of the Upgrade ix falsely reports the
loader's "Program was deployed in this block already" (it executes
against the bank at the stored deployment slot); simulate upgrades
with a real blockhash.

---

## TAG-9 FIX ADDENDUM (2026-10-16) — update-then-resize + neutral rent settle

Implements the fix the window-1 record specified. Gregory's go for
the fix + re-window: 2026-10-16 19:53 EDT. Source diff vs the pre-fix
v3 build is confined to `refresh_extra_account_metas` (pre-fix source
+ binaries preserved under `engine/v3-snapshot/`).

### The fix

- **Grow** (`new_size > old_size`): `realloc` up first (zero-filled
  tail — the intact entry plus trailing zeros stays a valid TLV
  buffer), then `ExtraAccountMetaList::update`.
- **Shrink / same size**: `update` FIRST — its internal
  `realloc_first` rewrites the entry's declared length in place and
  zeroes the tail while the buffer is still full-size, so
  `TlvStateMut::unpack` never sees a truncated-under-declared buffer —
  then `realloc` the account down to `size_of`.
- **Rent settle (new)**: after the resize the instruction forces the
  account to exactly `Rent::minimum_balance(new_size)`: a shortfall is
  topped up from the payer (system transfer, as before); any EXCESS
  is refunded to the payer (direct lamport move; the list account is
  program-owned). Window 1's build left shrink excess idling in the
  account; the fixed build is rent-neutral to the lamport, proven in
  the rehearsal (shrink refund 487,200 = min(261) − min(191), grow
  top-up the same delta).

### The rehearsal gate (NEW suite)

`integration/dbc-v3-refresh-rehearsal.mjs` — **83/83**. Plants the
PRESERVED mainnet list bytes (`deploy/v3-window/raw/pre-agtr-metalist.b64`
= `pre-latch-metalist.b64`, 261 B, sha256 `0616283f…`) verbatim as the
meta-list account of transplanted real v2 state, for both live config
shapes: Part L (Latch [1 GRADUATED, 9 @300] — same-size flip; the
suite also proves the v2 binary writes exactly these preserved bytes
for that shape) and Part A (AGTR [3, 9 @500] — the 261→191 SHRINK that
killed window 1). Each part: resolver throws
`TokenTransferHookAccountDataNotFound` on the planted list →
MigrateHolder verbatim → tag-9 flip with exact rent-settle assertions
→ list decodes as the AccountKey templated shape → resolver resolves
for a fresh wallet (extras include the ATA-keyed holder PDA) →
migrated holder sells generically → fresh wallet generic first buy.
Part G (engine-only): grow 5→7, same-size idempotent, shrink-back 7→5,
each with exact settle deltas.

### Battery on the fixed binary (trial flavor in the deploy slot)

Zero count changes vs the v3 addendum's table: engine trial 64/64,
trial-graduated 90/90, trial-v3 29/29, dbc-v3-headline 43/43,
dbc-engine-integration-v2 40/40, dbc-latch 55/55, ecosystem-gate
28/28, dbc-templating 35/35, dbc-devbuy 21/21, distributor
61/61 + 23/23 + 23/23, trial-launch-features 32/32, trial-graduation
35/35, browser harness 44/44, site smoke 65/65, trade-check 74/74 —
plus the new rehearsal 83/83.

### Builds

Both flavors from the fixed source, `cargo build-sbf --arch v1`,
**239,296 B** (+288 over the window-1 build — the reorder + settle):
mainnet-const `target/engine-mainnet.so` sha256
`c0a0f194632602ed7b7b8fb2738a9314858f85282a9ad6a1c5a4f5c5b527b7b3`;
trial-const `target/engine-trial.so` (deploy slot) sha256
`1719e10d1a0e5dc1836740a4922a6d74caba2d3391381a7959e5fa92973a989d`.
Both verified byte-reproducible. NOTE: 239,296 B needs programdata
239,341 B > the live 239,053 B — window 2 carries ONE 10,240-B extend
(the sheet's cost table has the deviation note).

DEPLOYMENT ADDENDUM — WINDOW 2 (2026-10-16 evening): **DEPLOYED.**
Full record in deploy/DEPLOY-RECORD-V3.md (second-window section).
The fixed build above (sha256 `c0a0f194…`, 239,296 B) was rehearsed
against the preserved mainnet list bytes (83/83) and Gregory approved
the re-window 19:53 EDT. Executed: one programdata extend (+10,240 B
→ 249,293 B; the +288 B growth made exactly one necessary — tx
`3CoCdqN6…`), buffer + upgrade in place (tx `3wt6DhFi…`, programdata
verified byte-exact), tag-9 flips on both mints (AGTR `5VKS5rmP…` —
the 261→191 B shrink that panicked in window 1 landed first try,
with a 355,600-lamport rent refund settled to the payer; LATCH
`UgdRSqbW…` same-size, wash), migration crank 7/7 (AGTR 6, LATCH 1 —
all verbatim, legacy accounts closed, 0 AlreadyInit), client flips
(trade-entry ATA-keyed derivation, bundles rebuilt, site hook.mjs/
launch.mjs synced from launcher sources, harness L7b tripwire
restored to positive form — 44/44 against the live engine; smoke
65/65, trade-check 74/74; site redeployed and live-verified
byte-identical). Post-flight: configs byte-identical, generic
resolver resolves for a fresh wallet on both mints (it threw
TokenTransferHookAccountDataNotFound pre-flip). Net cost
0.053058041 SOL; buffer float returned in full. Engine v3 is LIVE:
AGTR + Latch now trade under AccountKey meta lists with all holder
state at account-keyed PDAs.

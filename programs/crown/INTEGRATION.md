# CROWN BENEFICIARY (Solana) — integration contract

**Program:** `GbHLMTWixPKYo7gthYf1yTWiEAU1LuCmLUQD7x86MHSy` (local build keypair, `crown-keypair.json`, chmod 600)
**Binary:** `target/deploy/crown_sol.so`, **118,832 bytes** (SBF v1), sha256 `94bf4bb43f66b47b132f907cacc9f73f3794f66534526cdd766c4d5cbe88cfd7` → programdata rent-exempt ≈ **0.828 SOL** ((118,832 + 128) × 6,960 = 827,961,600 lamports). Built + proven 2026-10-19 (local), LiteSVM trial **66/66** (`trial-crown.mjs`, output `trial-output.txt`). **No mainnet deployment.**
**Per-account rent:** Crown PDA (256 B) = 2,672,640 lamports; Challenge PDA (224 B) = 2,449,920; Stake PDA (96 B) = 1,559,040; Vault PDA (0 B) = 890,880.

Spec: `SPEC-HOOK-LAUNCHER.md` rule 5 (Crown Beneficiary). Shape: the EVM Crown **Model 2** brief (`~/workspace/crown/BRIEF-M2.md`) adapted per-mint — a registry names the CURRENT fee beneficiary for one mint; the token, pool, and rules never change, only who gets paid. Anyone can challenge for the seat with a bonded SOL stake-vote; win, and the PDA flips.

## What the program is

Per launched mint, one **Crown PDA** holds the current fee beneficiary plus the challenge parameters. A challenge is a stake-vote in SOL: a challenger posts a bond naming a **candidate beneficiary** (which may be a different wallet than the challenger), anyone stakes SOL for the reigning side or the challenger side during a window, and after window + timelock a permissionless finalize either flips the beneficiary (challenger stake > reigning stake AND total staked ≥ quorum) or fails the challenge and starts a cooldown. The losing side is slashed 20% (default): half of the slash is paid to the treasury at finalize, half stays in the vault as a pool the winning side's stakers claim pro-rata (pull). Winners' stakes are fully refundable (pull); losers pull 80%.

The **Distributor** (rule 5's settlement consumer) reads the beneficiary from the Crown PDA at settlement time: split logic keys off `beneficiary` at bytes **[33..65]** and `reign_started_ts` at **[65..73]** — that prefix is a fixed contract (below) and the trial asserts the flip at exactly those bytes. **Fail-open at the system level:** a mint with no Crown PDA simply gets no crown split in the Distributor; this program needs no special case for that, and Init is callable for any mint with no engine, token program, or mint-account shape present (the trial's "mint" is a bare pubkey with no account at all).

## Accounts

**Crown PDA** — seeds `["crown", mint]`, 256 B:

| Offsets | Field |
|---|---|
| [0] | tag u8 = 1 |
| [1..33] | mint |
| **[33..65]** | **beneficiary — Distributor contract offset, never move** |
| **[65..73]** | **reign_started_ts i64 — Distributor contract offset, never move** |
| [73..105] | treasury (receives half of every slash, at finalize) |
| [105..137] | authority (init signer; recorded, holds **no** post-init powers in v1) |
| [137..145] | bond_lamports u64 |
| [145..153] | quorum_lamports u64 (total both sides) |
| [153..161] | window_secs i64 |
| [161..169] | timelock_secs i64 |
| [169..177] | min_reign_secs i64 |
| [177..185] | cooldown_secs i64 |
| [185..187] | slash_bps u16 |
| [187..195] | cooldown_until i64 (0 = none) |
| [195..203] | challenge_counter u64 (ids issued) |
| [203] / [204] | crown bump / vault bump |
| [205] | active_challenge bool |
| [206..214] | total_resolved u64 (finalized challenges, lifetime) |
| [214..222] | total_stake_resolved u64 (lamports staked across finalized challenges) |
| [222..230] | total_slashed u64 |
| [230..238] | total_treasury_paid u64 |
| [238..256] | reserved |

**Vault PDA** — seeds `["cvault", mint]`, 0-space program-owned account holding all staked SOL. Created at Init. Stakes and the bond arrive by system transfer; payouts and the finalize-time treasury payment leave by direct lamport moves (only this program can debit it).

**Challenge PDA** — seeds `["challenge", mint]`, 224 B: tag @0; mint @1; candidate @33; challenger (bond payer) @65; opened_ts @97; window_end @105; challenger_stake u64 @113 (bond included); reigning_stake u64 @121; state u8 @129 (1 = open, 2 = finalized challenger won, 3 = finalized failed); winning_side u8 @130 (0 reigning / 1 challenger / 255 undecided); finalize_ts @131; losing_total @139; winning_total @147; slash_total @155 (= floor(losing_total × slash_bps / 10,000)); treasury_paid @163 (= slash_total / 2); slash_pool @171 (= slash_total − treasury_paid); challenge_id @179; bump @187; stake_count @188 (distinct Stake PDAs on this challenge); claimed_count @196; total_claimed_payout @204.

One Challenge PDA per crown, **recycled**: a new challenge may only open once the previous one is finalized AND every stake on it has been claimed (`PendingClaims`, custom 14) — the finalized record is the claim basis, so overwriting it early would strand refunds. Trade-off, stated plainly: one staker who never claims blocks the next challenge for that crown. (A future version could add a claim-deadline sweep; v1 chooses refund safety over liveness.)

**Stake PDA** — seeds `["stake", mint, staker, side_byte]`, 96 B: tag @0; mint @1; staker @33; side u8 @65 (0 = reigning, 1 = challenger); claimed bool @66; challenge_id @67; amount u64 @75 (accumulates across repeat stakes on the same challenge + side); claimed_payout @83; bump @91. A claimed record from an older challenge is recycled in place for a new one; an unclaimed record with a positive amount from an older challenge blocks re-staking that side (`StaleStake`, custom 17) — claim first.

## Instructions (tag = data[0])

| Tag | Name | Data | Accounts | Semantics |
|---|---|---|---|---|
| 0 | Init | `[0][beneficiary 32][treasury 32]` + optional 50-byte param block `[bond u64][quorum u64][window_secs i64][timelock_secs i64][min_reign_secs i64][cooldown_secs i64][slash_bps u16]` | [authority (signer, w), mint, crown PDA (w), vault PDA (w), system] | Creates Crown + Vault PDAs; `reign_started_ts` = init clock. No param block → the production-default constants below. Validates bond > 0, window > 0, clocks ≥ 0, slash_bps ≤ 10,000. Callable for any mint, no engine required. |
| 1 | OpenChallenge | `[1][candidate 32]` | [challenger (signer, w), mint, crown (w), challenge (w), vault (w), challenger stake PDA (w), system] | Guards: no live challenge; `now ≥ reign_started + min_reign_secs`; `now ≥ cooldown_until`; previous challenge fully claimed. Transfers `bond_lamports` challenger → vault; the bond **is** the challenger's opening stake (side 1, owned by the challenger even when the candidate is someone else). Creates/recycles the Challenge PDA and the challenger's Stake PDA. |
| 2 | Stake | `[2][side u8][amount u64]` | [staker (signer, w), mint, crown, challenge (w), vault (w), stake PDA (w), system] | Window only (`now ≤ window_end`), amount > 0, side ∈ {0, 1}. SOL → vault; the staker's Stake PDA accumulates; the side total in the Challenge PDA accumulates. |
| 3 | Finalize | `[3]` | [caller (signer — fee payer only), mint, crown (w), challenge (w), vault (w), treasury (w)] | Permissionless; only at `now ≥ window_end + timelock_secs`; the treasury account must equal `crown.treasury` (`BadTreasury`). **Win** iff challenger_stake > reigning_stake AND total ≥ quorum_lamports. Win: beneficiary = candidate, reign_started = now. Fail (incl. quorum miss): beneficiary unchanged, `cooldown_until = now + cooldown_secs`. Either way the losing side's slash is computed, `treasury_paid = slash_total / 2` moves vault → treasury immediately, and the outcome snapshot (totals, slash, pool, winning side) is written to the Challenge PDA as the claim basis. |
| 4 | Claim | `[4]` | [staker (signer, w), mint, crown, challenge (w), vault (w), stake PDA (w)] | Pull payout against the finalized challenge. Winning side: `amount + floor(amount × slash_pool / winning_total)`. Losing side: `floor(amount × (10,000 − slash_bps) / 10,000)`. Marks the Stake PDA claimed and advances the challenge's claimed counters **before** paying (CEI; a failed payment reverts everything). Double-claim → `AlreadyClaimed` (custom 9), pays 0. |

Error codes (ProgramError::Custom): 1 AlreadyInit · 2 BadState · 3 ChallengeLive · 4 MinReign · 5 Cooldown · 6 NoLiveChallenge · 7 WindowClosed · 8 TooEarlyFinalize · 9 AlreadyClaimed · 10 NotFinalized · 11 MathOverflow · 12 Insolvent · 13 BadSide · 14 PendingClaims · 15 BadTreasury · 16 ZeroAmount · 17 StaleStake.

## Parameters — defaults and the open fork

All economics are **init-time parameters in lamports**; nothing SOL-denominated is hardcoded in the logic. Init without a param block stores these production defaults (constants in `src/lib.rs`, clearly marked):

| Param | Default | Source |
|---|---|---|
| bond_lamports | **100,000,000 (0.1 SOL)** — SUGGESTED, Gregory's call | EVM bond 0.01 ETH, re-denominated |
| quorum_lamports | **500,000,000 (0.5 SOL)** — SUGGESTED, Gregory's call | EVM quorum 0.05 ETH total, re-denominated |
| window_secs | 259,200 (72h) | EVM Crown, unchanged |
| timelock_secs | 86,400 (24h) | EVM Crown, unchanged |
| min_reign_secs | 604,800 (7d) | EVM Crown, unchanged |
| cooldown_secs | 259,200 (3d) | EVM Crown, unchanged |
| slash_bps | 2,000 (20% of the losing side; half of the slash to treasury, half to winning stakers pro-rata) | EVM Crown, unchanged |

**Open fork (Gregory):** the SOL bond/quorum defaults. 0.1 / 0.5 SOL are placeholders sized to feel like the EVM values' intent (a real bond, a reachable quorum), not a conversion — SOL and ETH prices make any "equivalent" claim arbitrary. Trials override all params at init with small clocks (window 3600s, timelock 600s, min_reign 1000s, cooldown 900s) and realistic stakes (bond 2 SOL, quorum 5 SOL).

## EVM → Solana adaptation notes (what does NOT port)

- **Pay-at-source per-swap reads → settlement-time reads.** On EVM the CrownHook reads `registry.beneficiary(ticker)` inside every swap and pays within the same settlement. Solana's transfer hook is veto-only — it cannot skim or pay — so there is no per-swap read. The beneficiary is read **at settlement time** by the Distributor (routed-mode folds / venue trickle) from this PDA. Between settlements, a flip takes effect at the next settlement, not the next swap.
- **ETH numbers → lamport init params.** Bond 0.01 ETH / quorum 0.05 ETH do not convert; they become per-crown init parameters (above), with suggested SOL defaults flagged as an open decision.
- **Model 1 (per-ticker multi-token crowns) is NOT this.** Rule 5 is per-mint beneficiary in the Model 2 shape: one mint, its seat flips. There is no ticker key, no challenger token, and no king-token pointer — the "challenger" names a candidate **beneficiary wallet**, exactly as Model 2 specced.
- **Pull claims replace EVM's refundable-at-finalize bookkeeping identically in spirit, accountably in form:** refunds live in per-staker Stake PDAs (seeded by side) instead of a mapping inside one registry contract; every lamport is accounted per record (see Rounding).
- **No hook-side fail-open skim.** The EVM hook fails open (a failed registry read skips the cut, never the trade). Here the equivalent property is structural: trading never touches this program at all, and a missing Crown PDA means the Distributor skips the split. This program itself is fail-closed on corrupt state, as are all launcher programs.
- **Treasury is a per-crown init parameter**, not the hardcoded EVM wallet — the launcher passes whichever treasury the launch config names.

## Rounding, dust, solvency (measured, trial T5/T7/T8)

- Every division floors, with u128 intermediates; slash share and loser refunds are computed per staker from their own record, so each claim is exact against the published formulas to the lamport.
- Per-claimant floors can leave dust in the vault: trial challenge #1's slash-share floors summed to 199,999,999 of a 200,000,000 pool — **exactly 1 lamport** of residual dust, asserted.
- A slash pool whose winning side has **no stakers** (trial challenge #2: quorum-miss fail, reigning total 0) is unclaimable by construction and stays in the vault as surplus: final vault residual asserted to the lamport as 1 (dust) + 200,000,000 (that pool) + 0 (challenge #3 paid out exactly).
- Solvency is by construction: total claimable = winning_total + slash_pool + Σ loser floors ≤ total staked − treasury_paid = vault balance after finalize. `Insolvent` (custom 12) is a defensive unreachable.

## Trial coverage (`trial-crown.mjs`, 66/66)

Init + stored params (incl. the Distributor-offset bytes [33..65] / [65..73]), double-init rejection; challenge #1 — open blocked during min_reign, bond posting, one-live-challenge guard, stake-votes both sides with accumulation (bond inside challenger total), stake-after-window and finalize-too-early rejections, permissionless finalize flipping the beneficiary at the exact PDA bytes, treasury paid exactly half the slash, lifetime counters; claims — winner full refund + pro-rata slash share to the lamport, losers exactly 80%, double-claim rejected paying 0, 1-lamport residual dust identity; challenge #2 — new reign's min_reign enforced, quorum-miss fail slashing the challenger side, cooldown stored and enforced, PendingClaims gate, loser's 80% claim; challenge #3 — claimed Stake PDAs recycled with only the new stake counted, bad-side and wrong-treasury rejections, second flip, final residual identity (dust + stakerless pool) to the lamport; a second crown initialized with **no param block** stores the production defaults verbatim.

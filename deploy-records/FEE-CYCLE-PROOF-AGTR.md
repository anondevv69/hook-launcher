# AGTR — first real holder-fee routing cycle (2026-10-16)

The long-open checklist item "route a small claimed fee amount into the
vault, crank `distribute`, claim" executed against mainnet AGTR
(mint `Hfk7uqxZ3fFB4TpAzSKYGCJ3uuAJ1E1fk6i6vSn3FVXR`, pool
`9NsjhhDoXRYds8q8uLHWBN38iFab38nA4VAkyLtvYVV7`, Distributor state
`cexMThLhJJgXnrxMY8ua8F1gTbLfGnoyGhwUVogbKkS`, vault
`6LeucGfr2GBpCACQEJbCTjsAUnt2uwFLjHSBRKmjc5FA`, fee claimer = launcher
wallet `FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP`).
All figures are chain reads (DBC `getPoolFeeMetrics`, account bytes)
taken immediately before/after each step — nothing estimated.

## Baseline (before)

- Unclaimed claimer (partner) fees in the pool: **0.021283816 SOL**
  (21,283,816 lamports, quote side; base side 0). Lifetime total
  trading fees at that moment: the same 21,283,816 (nothing had ever
  been claimed). Accrued on ≈ 2.66 SOL of lifetime curve volume at
  100 bps with the program's 80% partner share.
- Distributor: index 0, total_distributed 0, total_paid_out 0,
  total_routed_folded 0, vault balance 0. No fold had ever landed.
- Vault-owner Holder PDA (`92xBksTRbX6NSCVuN6r4p2rGvfgbSMQ7WM3xPbHRnDxb`):
  did not exist — the routing deposit's missing link (see step 3).
- Claimer SOL: 0.050484165. Claimer AGTR: 43,307,881.621086. Claimer
  holder-fee claimable: 0.

## Steps (all mainnet, all confirmed)

1. **Claim** — `claimPartnerTradingFee2` (the hook-aware variant; the
   SDK refuses the plain claim on hook pools), claimer-signed:
   `nu3STQpH9UgaNiBonwFKKXcrY3qYHAj68yd4KrppCKUbuFG37TVtL5F4Cm521sS1cMpX3KdrWa24DZvr9Mae99z`
   Claimed **0.021283816 SOL**. Post-claim unclaimed read: 0 (the
   170,272 lamports visible next are the conversion buy's own fee).
2. **Convert** — curve buy of the claimed 0.021283816 SOL:
   `3gh1SmqH4fSbWmNNPhjE4SCGcpnso37LRT7Mzi1QdNujhBFMVsh8Nfx6g6SQ9o97NSGQBWxzdC1CLkZ3PtdQE5G`
   → **1,203,196.353376 AGTR** (ATA delta, exact).
3. **Vault mirror sync** — the vault's owner is the Distributor state
   PDA, which can never self-register, and rule 3 (Agent-Only) checks
   the destination mirror. Engine `SyncRegistered` authority path by
   the config authority (the claimer), creating the vault owner's
   Holder PDA with registered = 1:
   `3oaAooHeiaasyXvj5N1m1bmdq5mYhdXM5g3TYZcPwauF3rgYruEYicNZ2GqhorKZeKpK73LCFjgqpWE7UrBgkC6p`
   (New launches do this at step L7b — added to `launch.mjs` and the
   browser builder with this work.)
4. **Second claim cycle** (via the shipped `node hook.mjs claim-fees`,
   after fixing its route-step argument bug — see below): claimed the
   0.000170272 SOL the conversion buy itself had accrued:
   - claim: `5ZLr1AChc2fqQK2Y9m7z3jY3REg1o8Kgn72LoMp3F4YYJrZU2CN3h58GkfqfMmGoLtLciXY5hdpnFBB2VEVbaYxi`
   - convert: `pj3dyoHdjjRLV6eFA1QbvnVd6TwpWZedSfcKYMPxFpWP7z7FUusMJBhWCNL2ne5FJuFEkqXujm7Fryx8mPXGiX3` → **9,613.004611 AGTR**
   - route into the vault: `5eM9HvwosjdNLh4fRKwqvk6BwE15DyJ6mJvuKrEoUCjYHY7tLbrj3NwqKAdicTiU6bqjRRE3C36LT8sr5R1bhbpy`
5. **Route of the first conversion** (settle-self + TransferChecked
   with hook — the `claim-fees` route construction; deliberately NOT
   `hook.mjs send`, whose counterparty-settle would settle the vault
   owner's own record against the vault):
   `22DEiBEMHv4HifE7ws8RoUrJkHP4MjZJdA44ncEPyzzjv3WCKvu972RRapRqUU6yAf9kPXA3JnmArTpsgdVqv9H7`
   → **1,203,196.353376 AGTR** into the vault.
6. **Crank `distribute`** — **FAILED**:
   `12GT2jemmkgghraDekDqzXoiH3zbzFm8PGzrMKquLgJTz97anXqgEn1m143XaijTiVaEtrXmgRG6YHxyzmApbWB`
   `InstructionError [0, MissingAccount]`. Logs: Token-2022 invokes
   TransferChecked inside the Distributor's caller-cut CPI, then
   `Unknown program EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT`.
   Root cause + fix spec: `../distributor/HOOK-EXTRAS-FIX.md` — the
   deployed Distributor's payout CPI does not forward transfer-hook
   extra accounts, so no payout (fold cut, claim, settle) can execute
   on a hooked mint. The fold is the one step of the cycle that did
   not land.

## Final state (chain reads)

- Vault balance: **1,212,809.357987 AGTR** = 1,203,196.353376 +
  9,613.004611 routed, to the unit. Unfolded balance
  U = 1,212,809.357987 (total_distributed − total_paid_out = 0).
- Pool: lifetime total trading fees 0.021455451 SOL; claimed in this
  cycle 0.021454088 SOL; unclaimed residual 1,363 lamports (the fee on
  the second conversion buy; claimable next cycle). Reconciles exactly:
  21,283,816 + 170,272 + 1,363 = 21,455,451.
- Distributor index: still 0 (fold blocked, above). The fold that
  lands when the Distributor upgrade ships, computed from this state:
  cut 12,128.093579 AGTR (1%), net 1,200,681.264408 AGTR,
  index delta 1,202,124,632 (×1e-12), which puts the claimer's own
  claimable at ≈ 52,061.471256 AGTR on his 43,307,881.621086 balance —
  computed, not landed.
- Claimer AGTR after: 43,307,881.621086 (unchanged — every converted
  token was routed). Claimer SOL after: 0.049103045; total proof spend
  beyond the claimed amounts: **0.00138112 SOL** (tx fees + the
  vault-mirror Holder PDA rent) — inside the 0.02 SOL cap.

## Bugs found and fixed en route

- `hook.mjs` passed the Token-2022 program id in the `commitment`
  argument slot of `createTransferCheckedWithTransferHookInstruction`
  (in `send`, and initially in `claim-fees`'s route step): the helper
  then defaults to the legacy token program and `getMint` throws an
  empty `TokenInvalidAccountOwnerError`. Fixed in both places.
- The plain SDK claim rejects hook pools; `claim-fees` uses
  `claimPartnerTradingFee2` with receiver = claimer.

---

## FOLD LANDED — 2026-10-16 (engine caller-fix + distributor hook-extras fix upgraded; the pending fold executed)

Authorization: Stage-2+3 worker brief (Gregory's fee-fold bundle). Operator /
upgrade authority / cranker / claimer: fren
`FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP`. Tooling:
`scripts/upgrader.mjs` for both upgrades; `launcher/hook.mjs crank-fees` /
`claim` with `HOOK_KEYPAIR=~/.fren_solana_key` and
`--record deploy/launch-record-agtr.json`. Every figure below is a chain
read or a transaction's own balance table — nothing estimated. All
expectations were recomputed from live state immediately before the fold;
live state matched the stale figures in the section above exactly, so the
same numbers were used.

### Stage 2a — Engine upgrade (caller-acceptance fix)

- New binary: `engine/target/deploy/engine.so`, 198,400 B, sha256
  `800a3fb4077b83fadd8b1da6f7fef5db236570509cf8e54becfef9d5c8e0dc72`.
  Program `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT`; programdata
  `6cU272AbbwEcr9SntbLEfSTUo2MfsdcSBcU1FsTCqMdB` (207,557 B — headroom
  existed, **no extend needed**).
- Buffer `FqPz2ZYBbXW9np9jvXChWvcMxFbeq6EUcg2q8X5mHWTZ`
  (keypair `deploy/fold-engine-buffer.json`): create+init
  `2YU19WfERF5CEaLK4Rn3MEAeDDyg7poEHTVYThBygw98Dbma1dxbLDcoFMh6rL4yADk6LPTLSKqz5rteyE3TtKic`,
  221 write chunks; on-chain buffer hash verified ==
  `800a3fb4…` **before** upgrading.
- **Upgrade:**
  `3B1uhemrup8EJRMKQAk7CtBWbnn19mXdD1Q53zeCphQ496epoKy4aZ2zwaG8m5EVpLnC7VbAgh1fmG3JcMTY2dPk`
  — post-upgrade programdata 198,400-byte prefix sha256 == `800a3fb4…`
  (byte-exact, independently re-read).
- Float: 1,008,710,200 lamports out at buffer create; the loader drained
  it back to fren (spill) inside the upgrade tx (fren 971,410,025 →
  1,980,115,225 = float − 5,000 fee); buffer account closed. Net stage
  cost = tx fees only: 1,120,000 lamports (create 10,000 + 221 writes ×
  5,000 + upgrade 5,000).
- AGTR undisturbed: Config PDA `4Tt9Sq6S…` bytes identical before/after
  (sha256 `49f01f97d061747f0b8f4feb16280372e8b6083b8b3b745f5460789dd71783e5`,
  1,088 B, 6,177,280 lamports); fren's AGTR balance identical
  (43,307,881.621086).

### Stage 2b — Distributor upgrade (hook-extras payout fix)

- New binary: `distributor/target/deploy/distributor.so`, 129,664 B,
  sha256 `dbf9a31ccfe92aa913c99f170313f5a318c96a82a9bcaeaf217235df819372f6`.
  Program `DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa`; programdata
  `2oKkGyA2ygbAfkk5VnppTTfhngj9uNoqox7Eig6TApwS` had no headroom
  (128,813 B).
- Buffer `J5wL8F1T69UUZ14LBW2Nw12oK4LB1CP1UEJotALcfEt7`
  (keypair `deploy/fold-distributor-buffer.json`): create+init
  `5tB7REtZnLRyd6ZC2NZryAEgDf7aBfJEfu3jJySYjqw18VicHyrbBYZghtJboeSP87xAJ1Jz5fhoonBEuQUdiQed`,
  145 write chunks; on-chain buffer hash verified == `dbf9a31c…`
  **before** upgrading.
- **ExtendProgram +10,240 B** (SIMD-0431 minimum):
  `4Dn54urYzKEPptbL5dnqp5LDR97V4r4M7YEMFs9uAURHvBys4KnpEJcCqbdjzKmHTiYz1bDsJ77uh8Bi56JVNWzh`
  — programdata 128,813 → 139,053 B; permanent rent +52,019,200 lamports
  (10,240 B × 5,080 lamports/B; programdata lamports 655,020,280 →
  707,039,480).
- **Upgrade:**
  `5xgP1e8HQABnYowgmZoGmWkshQN965zhPhRBfAA4FZpuAFMZ4kPvFgZnbD2kpSBCu4u96Ug6BYvYdvGMydMb2y6y`
  — post-upgrade programdata 129,664-byte prefix sha256 == `dbf9a31c…`
  (byte-exact, independently re-read).
- Float: 659,531,320 lamports out at buffer create, returned in full by
  the loader inside the upgrade tx (fren 1,267,824,705 → 1,927,351,025 =
  float − 5,000 fee); buffer account closed. Stage fees: 745,000
  lamports (create 10,000 + 145 writes × 5,000 + extend 5,000 + upgrade
  5,000).

### Stage 3 — The fold

Snapshot before (live): fren SOL 1,927,351,025; fren AGTR
43,307,881.621086; vault 1,212,809.357987; distributor index 0,
total_distributed 0, total_paid_out 0, total_routed_folded 0,
caller_cut 100 bps, funding mode 1 (routed); supply 1,000,000,000.
Recomputed expectations: fold 1,212,809.357987; cut (1%)
12,128.093579; net 1,200,681.264408; eligible supply
998,799,318.735592; index delta 1,202,124,632.

1. **Crank** — `node hook.mjs crank-fees` (AGTR record), cranked by
   **fren himself**; the permissionless 1% caller cut therefore landed
   in fren's own AGTR ATA — that is the designed crank incentive, stated
   plainly:
   `8DNXdoNzEQd8Be15gijnxo6AxkFB8zE9b2kdLxwgBYYTMqV9Pn4CJZbB1jcCEQZcD6dT1svvvmFv1tiWCsCfKwd`
   Program log: `distributor: folded 1212809357987 (harvested 0, routed
   1212809357987, cut 12128093579, net 1200681264408 into index, delta
   1202124632)`; the engine hook executed inside the cut transfer
   (`engine: execute amount=12128093579 accounts=12`) — the fix working
   end-to-end. Verified after: index 0 → **1,202,124,632**;
   total_distributed **1,200,681.264408**; total_cuts **12,128.093579**;
   total_routed_folded **1,212,809.357987**; distribute_count 1; vault
   1,212,809.357987 → **1,200,681.264408** (dropped by exactly the cut;
   the net remains in the vault as claim backing —
   vault − (total_distributed − total_paid_out) = 0 unfolded); fren's
   ATA rose by exactly the cut: 43,307,881.621086 → 43,320,009.714665.
2. **Settle + claim (fren)** — `node hook.mjs claim` (same record):
   `5bhVrov8ceS5vFDwqgzXpxE7b5yrqqUgmX5BqWJKjBBvaJksVTQiibNfTbH3iFS6SNxesTHXpPqXe511ghW5RehV`
   Program log: `distributor: paid 52076050736 to
   FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP`, hook executed inside
   the payout transfer. Paid **52,076.050736 AGTR** — the entitlement
   computed on fren's post-cut balance (43,320,009.714665 ×
   1,202,124,632 / 1e12, exact to the raw unit). Note: the
   52,061.471256 figure quoted in earlier records is the same formula on
   the *pre-crank* balance (43,307,881.621086); the +14.579480
   difference is the entitlement earned by the cut tokens themselves,
   which were already in fren's ATA when the claim executed. Verified
   after: fren ATA 43,320,009.714665 → **43,372,085.765401**; fren claim
   PDA `G5B3ov2WMhVqorvUaBhRaCY51MNsJoDgvFjBRWwG1gPN` settled_index ==
   **1,202,124,632** == distributor index, total_claimed 52,076.050736;
   total_paid_out 52,076.050736; vault → **1,148,605.213672**.
3. **Spot-check, fleet wallet 2 (read-only, no transaction)** —
   `5fC8mJ9Xr5LSnVLd29viCzJm5D1YvcGiXiAAnBR8ka3F`, live balance
   43,754,683.124308 AGTR. Its claim PDA
   `2rqwAw3J1zWDrsU9BXuro3Afbj9Mm2dJTFLjgFdLRPEu` **exists** with
   settled_index 0, so claimable = 43,754,683.124308 ×
   (1,202,124,632 − 0) / 1e12 = **52,598.582349 AGTR**, unclaimed.

### SOL accounting (lamports)

| Block | Amount |
|---|---|
| fren start (task) | 1,981,235,225 |
| Stage 2a net (tx fees only; 1,008,710,200 float out + fully returned) | −1,120,000 |
| Stage 2b net (extend rent 52,019,200 permanent + fees 745,000; 659,531,320 float out + fully returned) | −52,764,200 |
| Crank fee | −5,000 |
| Claim fee | −5,000 |
| **fren final** | **1,927,341,025 (1.927341025 SOL)** |

Permanent costs total: 52,019,200 lamports extend rent + 1,875,000
lamports tx fees = 53,894,200 lamports (0.0538942 SOL). Both buffer
floats (1,008,710,200 and 659,531,320) returned in full; no lamports
stranded. fren's AGTR total gain from the fold: +64,204.144315
(12,128.093579 crank cut + 52,076.050736 holder claim), final balance
43,372,085.765401.

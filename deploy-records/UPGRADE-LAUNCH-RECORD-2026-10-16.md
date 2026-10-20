# Hook Launcher — COMBINED UPGRADE + LATCH LAUNCH RECORD (deploy wave 2)

**Date:** 2026-10-16 (EDT early morning) · **Operator / upgrade authority / launcher wallet:** fren `FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP`
**Network:** Solana mainnet-beta via public RPC · **Authorization:** Gregory 2026-10-15 23:54 (deploy go for the whole wave) + 2026-10-16 00:07 ("Swap from elsewhere" — fund by swapping from the fleet, not a direct top-up).
**Tooling:** `scripts/upgrader.mjs` (buffer + loader Upgrade, TH deployer pattern), `scripts/eco-config.mjs`, `scripts/crank-dbc.mjs`, `launcher/launch.mjs`, `launcher/hook.mjs`; bridge script `~/workspace/blohard/bridge-base-sol-relay.mjs`.

## Stage 1 — FUND (swap from elsewhere)

Gregory declined a direct top-up; funds were pulled from the Blohard launcher wallet on Base (`0x3A08520042B20604c10Ca225c40fd224D2244535`).

- **Route selection:** LI.FI (first choice) — **unavailable**: unauthenticated API returned rate-limit code 1005 ("retry in 1 hour") on every attempt from this egress. Across — **rejected the route**: `Destination swaps are not supported yet for routes involving Solana`. **Relay (relay.link) executed.**
- Quote: 0.095 ETH → 2.193454594 SOL, total fees $0.5009 = **0.217%** (gates: ≥ 1.9 SOL ✓, ≤ 1.5% ✓). Request id `0x1792123818499e5f038c98f28312ce5e7cbdc35faf6b49cab76d7df8f3d0aa15`.
- **Source tx (Base):** `0xabfec13cc7138bc3e3aaac6071b54e565bf33fde1134bf6e9c93d911869eae9c` — block 52667238, success, gasUsed 24,812. Relay status: success.
- **Delivered:** 2,193,281,740 lamports (2.1933 SOL) to fren's Solana wallet.
- fren SOL: 49,103,045 → **2,242,384,785 (2.2424)** — above the 1.7 SOL stage target.
- Launcher ETH: 0.49383 → **0.39860** (0.095 sent + ~0.0002 gas; ≤ 0.11 draw cap respected; ≥ 0.38 floor listed in the wave brief).

## Stage 2 — COMBINED UPGRADE (Registry v2 + engine rule 17 + Graduated Latch)

Binaries (verified byte-exact on-chain after upgrade):

| Program | Id | New ELF | sha256 |
|---|---|---|---|
| Registry | `GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e` | 92,432 B | `609d17896445d33255991bccb5fbcfa7fc7b2f7f1521b521e374d31e2242e898` |
| Engine (combined: rule 17 + Graduated Latch) | `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT` | 197,280 B | `b2bd27d2276acf293c6df8f22e0b30f8284c4b68cd90e6a23e91ce71be602269` |

Sequence + signatures:

1. Registry buffer `AtPRMS5nWTwfqxApgNhuToL5YMBTx7EaS7dBrpbQ8Qij` (create+init atomic, 103 write chunks, on-chain hash verified pre-upgrade).
2. Registry **ExtendProgram +10,240**: `4iCKYvcRh9miUY57XVDfTPV4kKAjem5J1oKhwaB3Zb6ea6axRz7Vw24ALurkzEuALstRUtHt4THsFK4akE2d4fRa` — the exact deficit (8,552 B) was rejected in simulation (`InvalidArgument`): SIMD-0431's 10 KiB minimum per extend is live. (Also learned: programdata header is 45 B, not the 37 B buffer header; the exact-deficit math initially used 37 — the chunk overshoot absorbed it here, and the engine run used the corrected figure.)
3. Registry **Upgrade**: `37WqKL7LYRZDAfbJ1NHfuQV97nUzoQBcUfFnVwj196gC8nyjqVm8E8TwtapvrSsy2n42tJfSkSFdKdKcFT5kDTHq`
4. **InitEcosystemConfig** (immediately after, first-come ordering): `27S2mo48Eu2tLdZDFA23fK45jdCXRnK7aNvSXRSMvMyn466FXN3Naho6H9AMst9vb1L86z5iQMsNci3swfu439Zb` — Ecosystem Config PDA `BJbJTJML7Zrr6FVoggdhHPqgAaPsg9ZqvYdWmpf54cBL`, 545 B, authority = fren.
5. Engine buffer `2C8DAqD6DPhrPoy2cx5ka8PihVPk3rUzD5e7uDbgBQa1` (220 chunks, hash verified). Extends: +13,008 `2EM3g4W929bhJZ7LhtcbAEaYKTCt9gyRveC18pdMxR7jrLUQbXaFEvBQguWQvPmM5ThpPru8SA9FdPJbwfrteQ8R`, then +10,240 `Ai6af6V8BxYcXNGQK8zWEvueC3vaxHyGgXgyQrZCFLeotsFizik9fsk3zfaDQoo3hcuZZx2njxJthqZ6P5tXBn7` (programdata 184,309 → 207,557 B).
6. Engine **Upgrade**: `35sj4PfBP86nu4Wa9A3TqdhSNjn7Wev4KrY4r2Xh9zGhRJCGt1CFnXyTNGywQmEdv9PM5f5yoTcxLpg9D7RuT7dq` — upgrader verified programdata byte-exact vs the local combined `.so`.
7. **SetAttester(1, Muse)**: `3DRtxbByApFh4h1tbL1JknHJ8xBnDfNtyWb5GS1VSLrSxDTaSTs3m2WGAWXi4nsYAZ7rr6AavwMBxGKeFPf6LgzM` — Muse attester keypair `BcHge91Yncvfn4qGGuoLCTzYChk5Vpvia7Gh7tEqKCTY` (dedicated ops key, `deploy/muse-attester.json`, mode 600). Slots 2–16 (FOMO/Claude/Grok + reserved) remain unset, per spec §5.
8. Both upgrade buffers were drained to the spill account (fren) by the loader during the upgrades — accounts closed, no float stranded.

**Post-upgrade verification (all by on-chain effect):**
- Registry programdata ELF sha256 == `609d1789…` ✓ · Engine programdata (207,557 B) ELF sha256 == `b2bd27d2…` ✓
- Ecosystem Config: 545 B, tag 1, authority fren, nonzero attester slots = {1: `BcHge91Y…`} only ✓
- **AGTR untouched:** Config PDA (`4Tt9Sq6S…`) and DBC pool (`9NsjhhDo…`) byte-identical to the pre-upgrade baseline (sha256 + lamports), fren's AGTR balance identical (43,307,881.621086) ✓
- fren SOL after Stage 2: **2.0672** (abort floor 0.20 — clear) ✓

## Stage 3 — LAUNCH: Latch (LATCH)

Spec: `deploy/spec-latch.json` (SPEC-GRADUATED-LATCH §8.1). One tooling fix was required and made in `launcher/launch.mjs`: its rule-1 param encoder predated GRADUATED (rejected any mode but latch/live and never wrote params [19..31]); it now encodes mode 2 + base_frac_bps @19 + vesting_secs @21 + dip_mult_bps @29 exactly per spec §5, with write-time validation. The stale rule-1 warning text was corrected to the shipped CrankPriceDbc reality.

| Item | Address |
|---|---|
| Mint | `CFG9xRhq7NJ3UGR7VBU4bBgJotXTMZ2inhcfugX78t27` (Token-2022, 6 dec, supply 1,000,000,000, mint authority none) |
| DBC config | `3sKF4gD7SvbHduvJabQRniUNNWirNGVNuKYYVrbjh4Qm` (fee_claimer = fren) |
| DBC pool | `9EAHUDcCTkVL2iRsRpYey83sx5hsffGhpTvWgorFmXmx` |
| Engine Config PDA | `BRMnGdwDCby3HmJ3cci2UdMXvNLGdcfJiZSaWB1toQhK` |
| Meta list PDA | `5PLCLiQzycTis4tuuGxwfW8KjRbpHHfAQBxXT629f8z9` |
| PriceFeed PDA | `3h5KitPaStLQzm7kBwhjAZJeDREdFUsDZ3CRULgn4bXf` |
| Rent vault PDA | `FNmAXrpoPquWpQjeTXNU6fZfoZow8gNnzk8mtRtEF9sX` (funded 0.05 SOL) |

Launch txs: L1 `V9Qgtb9NYDYnrBN8WYsaqdwD4ePKqCbKymc9A1FSEs1s1BQqBaDApWWjNrZ1kR7v1UFjNG53nNnQwFVMDUqMZ7f` · L2 `42HX6Z3ffXsuUv27sLEJUedJK3UVhTCvWq5NhXMdSWDwbDorpxnr1m4YfxTyu2ioaCnJ2wVBHsobecNj2Gwhyrbi` · L3 `5pXtqKxHkXzLHJ16KPU7jHhjeiMh2yPCgLAL5hX2o9w6pGNdBjkuMUH1mVFVgis8fAj9ioz9tEYaJt8uyV9o33Gk` · L4 `2aAohpDQSYvozM59rLPW7yD2zEaym3rHJa4doSSqtfTqfFMPBcz1CGigf8GkG16aqaZovDP36GHCtbJv61RrLD4a` · L4b `5Bp2q8pW4trwugaSDqYdMgzaKc2peNxQRGgb2nmzdyjoYhpEKy5gPcGTVSXvbSKJtoZSk35w7AqG3Pe6AkCbd6sS` · L5 `3UVHXuSLhVrZTA3SoYhyAhHLyUYwkHcNvfYKRH11u7Sdqj5mg5i5haUUW5S67VkLPgjrNVEUeG8hz52hhxqnq8zG`. Full record: `launch-record-latch.json`.

**On-chain config verification (byte decode of the live Config PDA):** version 2, authority mode 0 (Locked), authority fren, venues [DBC], exemptions [poolAuthority, baseVault]; rule 1 enabled — max_stale 300, half-life 0, max_crank_bps 0, **mode byte 2 (GRADUATED)**, base_frac_bps 0, **vesting_secs 432,000**, **dip_mult_bps 20,000**, reserved [31..64] all zero; rule 9 enabled — **cap 300 bps**. Mint extensions: [MetadataPointer, TransferHook → ENGINE (authority = pool authority), TokenMetadata "Latch"/"LATCH"]. DBC config carries fren as fee claimer (offsets 40/72); fee destination CREATOR at 100 bps; no Distributor (holder-fees OFF). ✓ all per §8.1.

**First actions + proof buy:**
- First **CrankPriceDbc** (before any buy): `5Pv1wEpJnkzeHeDVT5VTCkFhysPJzXtpQxvcJpzTtDk8SAzEsweaw89SubaVFeexXVa65ia4TC1zwgT39C7hzEBD` — feed EMA live at 1.3125e-8 SOL/token.
- Proof buy via `hook.mjs flow buy` (register/sync correctly skipped — no Agent-Only rule): ATA create `4545Wu6YgmUBK3QJ4m95hodTCSwZeE97F7fTxHjboJZn2XsFHG9KbZSxpQagpGnk95nsisUPTqrNCyTQoabXJvoY`; **buy 0.01 SOL → 753,752.697394 LATCH**, swap tx `2GUwpuViGzj4NSebYSkMG3KGmwoRciCVp17aGTKpxrX4yNL2585GZo2nSUHiEBTYL3hqArx1UGCyRfi1uGwrxmte`.
- fren's Holder PDA `6Ujw8S3NoWNnxuDHv1oUrnKWGNa2UNTuCVWaXyhwESdT` initialized exactly per spec: **192 B** (born extended under the graduated config), basis 13,125 (== feed EMA, PRICE_SCALE), grad_peak 753,752,697,394 (== balance), grad_sold 0, grad_cap 0 (entry fraction 0 at t=0 — the design's day-one state), grad_anchor = buy ts, grad_min_price 13,125.

## SOL accounting (lamports)

| Block | Amount |
|---|---|
| fren start | 49,103,045 |
| Bridge delivery (Relay) | +2,193,281,740 |
| After funding | 2,242,384,785 |
| Stage 2 net (programdata growth rent + extends + eco-config PDA rent + ~330 tx fees; buffer floats refunded in full by the loader) | −175,207,880 |
| After upgrade | 2,067,176,905 |
| Stage 3 net (launch state ~0.0630 + crank + ATA rent + 0.01 proof buy + fees) | −85,941,680 |
| **fren final** | **1,981,235,225 (1.9812 SOL)** |

## Deviations / notes

- Bridge route: LI.FI rate-limited and Across Solana-incapable → Relay fallback used (task-sanctioned class; quote beat both abort gates by a wide margin).
- SIMD-0431's 10 KiB minimum extend size is live on mainnet — extends overshoot the strict deficit (registry +1,688 B, engine +7,472 B of programdata headroom; harmless, slightly more permanent rent).
- `hook.mjs status` still labels rule 1 "mode=LATCH" in its display decoder (predates GRADUATED) — display-only; the on-chain mode byte is 2, verified by direct decode. The status decoder should learn the graduated params in a cleanup pass.
- Upgrade authorities remain held by fren (unburned, per standing posture). AGTR migration flash-rent duty is unchanged and unaffected.

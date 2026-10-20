# DEPLOY RECORD — S1 WINDOW (engine v3 → Phase B, in place) + HARVEST EVER finish

**Executed 2026-10-20 (America/New_York), by the S1 deploy-window coordinator
under Gregory's authorization: catalog plan locked 2026-10-19 ("Do what you
gatta do") + window funded 2026-10-20 by his directed AGTR swaps (fren main
2.403715702 SOL verified pre-window).**

**RESULT: COMPLETE — all 7 window steps verified on-chain, HARVEST EVER
finished in place with the full proof battery green. No rollback needed.**

Runbook: `deploy/PHASE-B-DEPLOY-SHEET.md` (S1 checklist) +
`deploy/BUILD-RECORD-PHASE-B.md`. All window scripts, logs, and result JSONs
live in `deploy/s1-window/`. The deploy artifact was FROZEN before any chain
write (Phase C was editing engine source concurrently):
`deploy/s1-window/engine-phase-b.so`, copied from
`engine/target/engine-mainnet.so`, sha256 verified == build record. The
upgrade was sent from the frozen copy only; the engine was never rebuilt.

---

## 1. The upgrade

| | |
|---|---|
| Program | Engine `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT` (upgrade authority: fren `FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP`, retained) |
| Before | v3 binary, ELF 239,296 B, sha256 `c0a0f194…` (verified live pre-window: first 239,296 B of the live ProgramData ELF at offset 45) |
| After | **Phase B binary, ELF 290,224 B, sha256 `4c4aa6dec113d339e401c019882661f3056318fd659ed450fe23392e86758556`** |
| Upgrade tx | `3D5FBukD5mWScdJhCLKquKKgavne7ksSPAgV9dzFHrUhZNYDViH7GMTRxU7N6PGGBjUW5Ztg2QAuvKN9sBYMss1P` |
| Read-back | Live ProgramData ELF at offset 45 is **byte-exact** vs the frozen copy; sha256 == Phase B hash (`s1-upgrade-result.json`) |
| Rollback target (unused) | Preserved v3 binary `engine/v4-snapshot/engine-mainnet-v3-live.so` (sha256 `c0a0f194…`) |

### ProgramData extends (step 2)

Live ProgramData was 249,293 B (grandfathered ≈5,079 lamports/B rent); the
Phase B ELF needs 45 + 290,224 = 290,269 B. Extended in 5 × 10,240-B steps
to **300,493 B**, total cost exactly **0.260121 SOL** (rent + 5 × 5,000-lamport
fees), signed by fren:

1. `3Tee47A6oVXBC6nz9Wk2MFJLVEkuCK5rcDVZzTJPKwcG8nMigGFiTijVJAjbwY63MeV4NaSUhP6CvpQxZ5E96mLW`
2. `2e33TCT4c6eEKFB77Amgr8tNnj52hRVAcgzKm1nsDNVt5G1U6Tsou4ForbT6b81jV2xJwYZuhXCjCuEikfxyVSUe`
3. `TKZBU5L1RBtcn2gtNecXFRdwJ1zNTSpo85e8Eq4nvy7R5kcjWUeti3Y8ibfzczppKx5mWaEmpwmjzBjpP8aBqZD`
4. `61VrNKV9Ta2b6BcuzQYUrBXZ54jpq289MFKzhTRRp2vPNmLnRKNwVBhyTibRUyqLHgoNsY53pAkevpgme9huqRwp`
5. `5rF9TnrJpDbJRAE4qDGwTscyEmgcqfqnTmkhprguhgkrgGaror5izjGfKTHM2kzRFMHXfMF1rFEHC7mSsPhRkGF4`

### Upgrade buffer (steps 3 + 5)

Buffer `2cr4SnW4kCxULzGmYt3SC5yrMT3N3Rn6HtiPwWm8NFou` (reused v3-window
buffer account). Create+init tx
`2UiQqBS7siRj3Bu84Z36FN2WkdhjUemSZ9a82BWGLYgdvi1bP1Y3r1V6U4yNJk2BsZtqS5dE5N4aDX7fG36oXsdZ`
(space 290,261 B, rent 1.47517612 SOL, refundable). The buffer was written
from the frozen copy in chunks and verified by an **independent read-back**
(`s1-buffer-check.mjs`): 290,224/290,224 bytes match, read-back sha256 ==
Phase B hash — before the upgrade was sent. (Process note: background
writers died repeatedly mid-write and one completion report overstated
progress; only the independent read-back was trusted, per window discipline.)
The loader closed the buffer at the upgrade; balance delta +1.47517112 SOL
(rent back − 5,000 fee, exact).

### Money reconciliation (window)

| | SOL |
|---|---|
| fren balance pre-window | 2.403715702 |
| Extends (rent + fees) | −0.260121 |
| Buffer create fee + write chunk fees + upgrade fee | −0.001630 |
| Buffer rent floated and returned | 1.47517612 out, 1.47517112 back |
| **fren balance post-window** | **2.141964702** |
| Total window spend | **0.261751** — reconciles to the lamport |

Pre-flight peak-float math (recomputed at execution): gross peak
1.74027212 SOL < 2.403715702 balance, headroom 0.6634 SOL. No step could
strand.

## 2. Post-verify (step 6) — all green

- **Meta refresh (tag 9), byte-identical lists on all four live mints**
  (`s1-refresh-results.json`): AGTR (191 B)
  `5cH7RPF1U75tGNnFNuAbjp6vv8eX8kQmqfQTQ7A7rb51pTLrCTKovdmre2WMfX8Jjto42ku6CQ8HRXuhHkerVfsB`;
  LATCH (261 B)
  `2pHujnoAkuoXRvAPH7Apd4UeCSTCmmGALdePkRbQUnTLJL4FPEEM9owR5hfi65QBQVyYGNds4tuD8H2RN1kJoJqV`;
  HARVEST (261 B)
  `3MHQCXanNBRdyRMp8SWkjZdF5B42MhFwC36fERhxQwGBW326L77qWf1xypkz6fqWXcRgpgveVJzLQFTy75uHSV8U`;
  PROOF (261 B)
  `2GPL7RHJvdiSmFs9CfAKnBqCiKU9kJzQ7Pc39T2QCkTVq3A2YjAMYEEaneD1r4STVUkwm2goKhQi5KeULP9oE4fV`.
  Configs all 1,088 B, untouched (pre-snapshot: `snapshot-pre.json`, slot
  459097528).
- **Generic-resolver sanity:** resolves for a fresh wallet on all four mints
  (`s1-resolve-results.json`).
- **`hook.mjs status` on LATCH** reads correctly under the new engine
  (Graduated Latch mode, Max Wallet 300 bps, fren basis 13125 scaled, exit
  LOCKED; its feed staleness is the known pre-existing LATCH state, not a
  regression).

## 3. Guard pin (step 7) — lifted, with a semantics correction

`launcher/engine-v4.json` re-pinned and the guard exercised through
launch.mjs's OWN code (`s1-guard-check.mjs`: the pure v4 section sliced
verbatim + the live fetch replicated exactly):

- **Finding:** the guard's live hash is `sha256(ProgramData.data.subarray(45))`
  — offset 45 to the **end of the account**, which includes the zero padding
  from every programdata extend (the account has never been sized exactly
  45 + ELF). Pinning the ELF-only hash (`4c4aa6de…`) therefore does NOT
  satisfy the guard: decision for the EVER spec was `applies: true,
  ALLOW: false`. This incompatibility predates S1 (it would have bitten the
  v4 window identically).
- **Pin as set:** `b32e336143e92ec3126e186fa814990958e661f83f9f3b11eec00864c15b48a0`
  = sha256(Phase B ELF ‖ 10,224 zero bytes) over the current 300,493-B
  programdata — i.e., the pin equals what the guard actually observes on
  chain, per the window instruction. The file's note documents both hashes
  and warns: **any future programdata resize changes the tail hash and the
  pin must be re-issued, even for an unchanged binary.**
- **Decision after pin:** EVER spec (rule 1 + `never`) → `applies: true,
  ALLOW: true` ("the v4 engine (crank overflow fix) is verified live").
  HARVEST spec (rule 1 + `release`) → guard does not apply, allowed. The
  earlier full-spec `--dry-run` completed with no hard refusal.
- **Composer rules regenerated** (`bin/gen-rules.mjs`): output identical to
  the committed `browser-src/rules.generated.mjs` (zero diff — the Phase C
  coordinator had already regenerated from the same source);
  `bin/check-rule-parity.mjs` → **RULE PARITY: OK**. The composer-side GUARD
  still carries `fixedEngineSha256: null` — flipping it is the **S6 publish
  step**, deliberately not done here (no site publish in this window). When
  S6 flips it, the value to publish is the tail-hash semantics above, not
  the ELF-only hash.

## 4. HARVEST EVER — finished in place (no relaunch)

EVER: mint `6qfXuiKUsQEutT5nRK9TD8oadCywdqh5jNAtErv3Ghea`, pool
`CxcK2toDGxqD4efaHmVUgC3eaBWXynqSUx9oiYGZdzES`, engine config
`FBRqVRoyCAH1wptXonmUeeozxaazy4MnFi4hHHd4udpx`, meta list
`AiE7aZ8oC9cCL386tVoUnrFNbzRa7DDayuiNRme84UeM`, price feed
`998zYYVs64axarjVy2kDHv1gKJEt6mzNxuqbNuUfWV8B`. Rules [Basis Latch CLASSIC
stale 300, Max Wallet 500 bps], Locked, graduation `never` (DBC config
`5UPTBiz4dzwLvmfRXRFaEhZ9QZMHVXiwzg78W5A1fbSw` threshold u64::MAX, verified
on-chain). Machine record updated: `deploy/launch-record-harvest-ever.json`
(launchStatus COMPLETE; the historical failed-crank signature key renamed
`devBuyCrankFAILED` → `crankAttemptV3Era` so the feed's FAILED scan no
longer marks the launch incomplete).

1. **Crank** — pool verified untouched first (sqrt_price ==
   1400569249610656411450 == sqrt_start_price; zero trades since launch).
   Feed EMA 0 → crank tx
   `4Qj1NUG7SLzTohUxiPemyCNuEL5oT7n9ijUbK18WiGY2rxPkQ6GSd35aqsMMhzPLB8yJ1rYuXnSoc2hoNDxz2XYx`
   → **EMA 5764607319222, exactly the Phase A offline fixture value**,
   nonzero. The step that failed deterministically under v3 (tx
   `1257XbYi…`, MathOverflow) now lands. (`ever-crank-result.json`)
2. **Dev buy** — 0.05 SOL via `hook.mjs flow buy`:
   `3m8exKSsfRLLnn63AKaWhjdBj5LerS87ebPmMf1AKcJHcbquAa5mU8LJWFrLABNCSzqPkTTphNsCazsoqKJYzv3p`
   → 0.008586 EVER (8,586 raw; the never-curve opens at ≈5.7646 SOL/token by
   construction — 1B supply stretched against u64::MAX). Fren's Holder PDA
   basis = **5764607319222** (×1e-12), nonzero, exit LOCKED — verified via
   `hook.mjs status`.
3. **Proof battery** (`ever-proof-result.json`) — fresh generic buyer
   `4XK9rSyZp7HCeG3iovUjaH5Jv2j7qyZRA8f2Po3x6T2Z`, ATA absent at build time:
   - **P1 generic-resolver first buy** 0.01 SOL:
     `2q2qkMDhfzJFCN5yWe13Qc87sGCegnQkmi35VegsvxNN3B5kJ2djccqFv1scXgPoLEq92iAVGmPHvXHbBKLFPaCw`
     → 0.001717 EVER; Holder PDA (ATA-keyed
     `5sbub5DhdQukJHFxfMhNHwtAgYG9cHqCyGT3NPcv7LQD`) basis =
     **5764607319315 == the cranked EMA, nonzero**; no owner-keyed record.
   - **P4 immediate full sell vetoed:**
     `9AEK7dzmahukSNmCd88NsnWSqs7GV97iag3VN6gtZGLZLSut2cLejAxnEdyMVuwhQN17Pzvxpr9GhARgmxTkiTp`
     reverted with the engine's **Locked** error (custom 15 = 0xf); engine
     log on-chain: `engine: locked: price 5764607319334 >= basis
     5764607319315`; buyer balance unchanged (1,717 raw).
   - **Flow buy** (second fresh wallet
     `6HPSjoBFb2b6Ukx8JmRBcadn1TZfcKLhQ3N64PCR5rGd`, `hook.mjs flow buy`
     0.01 SOL):
     `34maDnCtA1PN1i8a6gbq8VmjBA3ejNrrXQN1BTgouLe33o62s9oq34p73n6HzmbD5yiZuC3NfPpN2Ae4JfN4iu5W`
     → 0.001717 EVER; basis 5764607319334, nonzero, exit LOCKED.
4. **Launches feed regenerated** (`launcher/publish-launches-feed.mjs`,
   staged only — see §5): EVER flips **paused → bonding**,
   `launchComplete: true`, `hasSwap: true`, graduation `{mode: "never",
   thresholdSol: null}`, page `https://agentonly.fun/hooks/ever/`. All five
   launches reconcile clean.
5. **Token page built**: `~/workspace/aonly-site/hooks/ever/index.html`
   (HARVEST page shell, EVER-accurate copy: the never-curve economics incl.
   the ≈5.7646 SOL/token opening price stated plainly, the finish receipts,
   the twin comparison vs HARVEST, honest notes incl. the metadata gap
   below). HTML validated. A reciprocal "Harvest Ever" link was added to
   the HARVEST page footer. Site copy of the machine record staged at
   `~/workspace/aonly-site/hooks/ever-record.json`.

EVER finish spend (from fren): crank + dev buy 0.05 + ATA rents + two
0.03-SOL proof-wallet fundings + fees ≈ 0.1116 SOL. fren balance at end of
window: **2.030371462 SOL**. ≈0.0358 SOL of proof funding remains in the two
proof wallets (unswept, recoverable).

## 5. NOT done in this window (deliberate)

- **Site NOT published.** The regenerated feed, the EVER page, and the
  HARVEST reciprocal link are staged in `~/workspace/aonly-site/` only.
  Publishing is the **S6 window** (which also flips the composer GUARD to
  the tail-hash pin in §3). Until S6 runs, the live feed still shows EVER
  as paused and /hooks/ever/ is not live.
- **EVER metadata gap (noticed, out of scope):** EVER's on-chain metadata
  URI is **empty** (its launch predates metadata-at-birth), so indexers
  show no image/description and the feed entry carries `metadataUri: null,
  image: null`. No `harvest-ever.json`/image was ever staged. A HARVEST-style
  metadata repair (fren holds EVER's metadata update authority) is a small
  follow-up whenever Gregory wants it; the token page discloses the gap.
- Remaining Phase B windows unchanged: S2 Crown deploy, S3 Distributor
  upgrade (AGTR DistState preserved-bytes rehearsal still owed), S4
  FeeSchedule deploy, S6 site publish — each its own window.

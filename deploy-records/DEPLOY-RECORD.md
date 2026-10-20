# Hook Launcher — MAINNET DEPLOY RECORD

**Date:** 2026-10-15 (EDT evening) · **Deployer / upgrade authority / launcher wallet:** fren `FMYVMuJgoM9J41PaXBmJe6ijSHUtSr2VPRbAJvH4MhCP`
**Network:** Solana mainnet-beta via public RPC · **Tooling:** TH `scripts/deployer.mjs` + `send.mjs` (buffer + DeployWithMaxDataLen, robust HTTP sender); genesis via `launcher/launch.mjs`; proofs via `launcher/hook.mjs`.

## Pre-flight

- Live balance before: **4,340,670,144 lamports (4.3407 SOL)** — above the 3.2 SOL floor.
- All three programs rebuilt from source (`cargo build-sbf --arch v1`); sizes match the trialed artifacts exactly: engine **184,264 B**, registry **83,872 B**, distributor **128,768 B**.
- Fresh mainnet program keypairs generated in this folder (mode 600): `registry-program.json`, `engine-program.json`, `distributor-program.json` (+ `*-buffer.json`).

## Programs (all verified by on-chain effect: executable, loader-owned, programdata byte-exact vs local `.so` sha256, upgrade authority = fren — NOT burned)

| Program | Mainnet id | Programdata | ELF sha256 | Deploy tx |
|---|---|---|---|---|
| Registry | `GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e` | `AZPP5W8QrPhGJ9mzPFRV4z23Sr3PJawKxjikGvmBANUF` (83,917 B) | `482d08eed2cc5b63…` | `3Gfp7dcLYYijbTsyRV3uLuNCEekNHPoT8KJd85PqY2JCFdmthx7fPvyL5nAscWaV6gSTQ1cktQdKgnis7yqScTQi` |
| Engine | `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT` | `6cU272AbbwEcr9SntbLEfSTUo2MfsdcSBcU1FsTCqMdB` (184,309 B) | `c6803aa7a1cd65b2…` | `65dKocLLhvBRu3Fup5CipkHYWFwb7MrumngDWR7HRnYjSHh3p9HYnwGgxjsN3Nq8EKXdFWXm8wS4WAC7EEuCJKki` |
| Distributor | `DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa` | `2oKkGyA2ygbAfkk5VnppTTfhngj9uNoqox7Eig6TApwS` (128,813 B) | `02b7b0d80fe68983…` | `4gpShiZK1XwNS9DrVJEzGmk6g3upwMJcmUrUdekiVR4doj9fU9sZjmwmwsaMKa9h3TDpgfe1fimCireyQVmufGSF` |

Deploy order per runbook: registry first → engine rebuilt with `REGISTRY_ID = GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e` (size unchanged at 184,264 B) → distributor. The live SyncRegistered proof below exercises that embedded const against the real Registry.

**Deploy incidents (all resolved, all the documented TH stale-read class):** each deployer's immediate post-write buffer read-back hit a lagging RPC replica and reported a hash mismatch (registry + engine first passes; distributor second pass) — independent triple-reads proved the buffers byte-perfect every time, and the resumable deployer then completed. The distributor's first pass also lost write-chunk tx 91/144 (confirmation timeout; the tx never landed — null with history search) and resumed cleanly. Each deployer's final status print crashed on a null fresh-account read *after* its DEPLOY tx had already confirmed; every program was verified independently instead. No step failed twice with the same error in a way that blocked progress; no improvisation was needed.

## Genesis launch — AGTR (Agent Reserve)

Via `launch.mjs` + `sample-spec.json` (Agent-Only + Max Wallet 500 bps + holder fees on, **Locked** authority, 42 SOL migration threshold). Full record: `launch-record-agtr.json` (this folder).

| Item | Address |
|---|---|
| Mint | `Hfk7uqxZ3fFB4TpAzSKYGCJ3uuAJ1E1fk6i6vSn3FVXR` (Token-2022, 6 dec, supply 1,000,000,000) |
| DBC config | `4kphMeeYEz4UKbm8BKDaJUBN4gVLdCmZ1FU3f2GctX7h` (fee_claimer = fren) |
| DBC pool | `9NsjhhDoXRYds8q8uLHWBN38iFab38nA4VAkyLtvYVV7` |
| Pool authority | `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` |
| Base vault | `8BG1AdnVLsmzMM8PtSz2RPCxDwFgfwnbo5kPXYEQoMKK` |
| Engine Config PDA | `4Tt9Sq6SciFoAAy6cUyYdsVGDjADLS4foSSvGGGWdnS7` |
| Meta list PDA | `8h8jiSYudjbTacKWGjbmQtQX6QmyTVP9yUKKpSA586AV` (261 B, tail v2) |
| Rent vault PDA | `BcktSWQtBiZ9pPRfofP47qCN5DaKV6iYd8gY3NZ7uUZ9` (funded 0.05 SOL) |
| Distributor state | `cexMThLhJJgXnrxMY8ua8F1gTbLfGnoyGhwUVogbKkS` — **funding_mode 1 (routed)**, caller cut 100 bps |
| Distributor vault ATA | `6LeucGfr2GBpCACQEJbCTjsAUnt2uwFLjHSBRKmjc5FA` |

Launch txs: L1 `2S2qD7L2UzsRqNtT6URK8v3XG7kUndZCY2tVWjxVC5utCb7Ur5hgAx8cNy2SgoboquQC2fmx52BSsohPxZtQXzGR` · L2 `36dJVzUpbutMQYEGcUZzbPiEeS1QhmqHYsD6NrUxN6w4x2W3KDE5BJyJhs6iat7bCijMfa2doid8ymMKPcYQuvq6` · L3 `4uLmQfgFfSvkbkmDqr82T8UDKLo5q39neB87C6x727XfqF1U8RAfT1yMAD8XRyds7mYTdCspc89jEreXYix8NVB3` · L4 `2KizAENSTYE1MzomNq8kyx9PkbxLfz9dQVu3uCo8DgGaT8yUjhSPGH5Z2sNfvfnUpNUk1BfxwQeeCrUdDFFZgYL9` · L5 `5qmmrQftzv2sXx1SAm7Q83BD6FN4FJJT9Ea4S4rpDWo8KuQpVCxr27UNYUDCC93KCDR4oWAz4Gvz4xQVVudhBGZU` · L7 `4y4ZzW6fxV7fikNEShmBg3LpccasKw7mywNKTpaCkRK7m2jex4NrGZFiTf8KJLaK6p1ioMqpo6VxNcuvjKwF5hxv`

## Live proofs (all verified by on-chain effect)

- **(a) State reads:** mint TLVs — TransferHook program == ENGINE (authority = pool authority, as designed); extensions [MetadataPointer, TransferHook, TokenMetadata]. Config PDA decodes exactly to spec: version 2, mode 0 (Locked), authority fren, venues [DBC], exemptions [poolAuthority, baseVault], rules [3 enabled, 9 enabled @ 500 bps]. Distributor funding_mode byte = **1**.
- **(b) Registered buy:** fren registered (kind Agent) — tx `5A7nzv7B1ZuzMNo34gmn413Z4chiH7XP9vLrPUZqahwWJkNxzEycw7yvFabHNuKqu7qXNbgPsqs7VUMUtMQJWBKE`; SyncRegistered path (b) — tx `2D6RZcLbYacEx5fU9QtDC91J3RKKwqdY9qiaYqkE7uwd31ZQDXkHCZqWKY55r7HThDrsy7EYCJMoiJGahKzgZ2dg` (validates the engine's embedded mainnet REGISTRY_ID end-to-end); ATA create `5icbx1D4eQTeUohj8d6tduAVhMJnzmKDBi2TgvTDDRV6tUQXJbies1bHGabnRfNrCpQHSBSEd2LfuGtPyr9LQtSd`; buy 0.05 SOL — tx `22fCUbxid9v8tEeBrfgSZXNgLSqeb6A4S3xx3R9JEcNh8ovcqXsvTPRGufJpwN5Qk7NACsB4TaB575CuoADrhGkZ` → **3,758,140.828991 AGTR landed** (identical to the LiteSVM-proven amount for 0.05 SOL).
- **(c) Unregistered veto:** fresh wallet `DHJDTBjaYp4LQfBm53GpMZXLkSUwHSE9D9MDfBHibSAt` (funded 0.03 SOL, tx `31JTBr2uHrXQW1Fg1s1amZvQnxWM4M1HgwTFc6tE6qfcQ4YySr66PjAm1bnth19qRCgzAosqvQXaGr7g3RCfEqXv`) attempted a buy — tx `5L5DCFTDgLHkJmRSLmszMWsqyjFzAtghJZiDuBy76Sr4Voq7bev1drTvBjnA9emTGSBbBbfPq9VAqx5kcEWQbeYt` **failed with engine Custom 1 (NotRegistered)**; logs show `accounts=12 venue=true` then `engine: not registered: DHJDTB…`; the swap reverted atomically and the wallet's AGTR balance is **0**.
- **(d) Sell-back + reclaim:** fren sold the full proof position — tx `3NHpqM7Eg17CwwyZ5S9DAwyDHfrsdwFravDvn72PwJAGJ7jRCfmBfs7qYhair1kNy9djrSnmMvuAohwc6kT4ZreQ` (balance back to 0 AGTR). Temp wallet's remaining SOL reclaimed to fren — 28,445,760 lamports, tx `46Ym1dPo9j9vgWM7TBVV3aqXsGzfhyUUi4AKcBdz1UDiKkbNdQLpK9pvPDvPDuYUsHQJCzrbb7WBUMoXtsbc9AK2`. Temp residue: 5,000 lamports + its empty AGTR ATA rent (1,539,240 lamports) under `temp-buyer.json` (kept in this folder, mode 600).

## SOL accounting (lamports; reconciles exactly)

| Block | Amount |
|---|---|
| Start balance | 4,340,670,144 |
| Programdata rent — registry 426,948,600 + engine 936,939,960 + distributor 655,020,280 | −2,018,908,840 |
| Program accounts (3 × 833,120) | −2,499,360 |
| Deploy tx fees (residual, exact) | −2,263,537 |
| Balance after deploys | **2,316,998,407** |
| Genesis state: DBC config 6,380,480 + DBC pool 2,804,160 + engine config 6,177,280 + meta list 1,976,120 + rent-vault funding 50,000,000 + distributor state 1,544,320 + distributor vault ATA 1,539,240 | −70,421,600 |
| Proof PDAs/ATA: registration 894,080 + holder 1,341,120 + claim PDAs 2 × 1,178,560 + fren ATA 1,539,240 | −6,131,560 |
| Remainder: launch/proof tx fees + temp-wallet residue (1,544,240) + net round-trip curve cost, net of sell-back proceeds | −8,323,081 |
| **Final balance** | **2,232,122,166 (2.2321 SOL)** |
| **Total spent** | **2,108,547,978 lamports ≈ 2.1085 SOL** |

Note: mainnet rent currently prices at 5,080 lamports/(byte+128) — cheaper than the runbook's 6,960-based estimates, which is why deploys cost 2.02 SOL instead of ≈2.77.

## Posture / open items

- **Upgrade authorities: held by fren, deliberately NOT burned** (lockdown is a separate step on Gregory's word, TH precedent).
- Standing duties (README): migration flash-rent float on the pool authority before AGTR nears its 42 SOL threshold; holder-fee routing cadence (claim → convert → vault → crank) — *not yet proven live with a real fee amount; the checklist item stays open*; SyncRegistered keeper for deactivations.
- Program keypairs for the three programs live in this folder (mode 600) — they are only needed for future upgrades signed by the upgrade authority; the keypair files themselves are NOT the upgrade authority (fren's wallet is).

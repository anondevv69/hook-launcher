# Hook Launcher — one engine, rules as data, on Solana

Solana Token-2022 tokens whose behavior is an on-chain rule engine.
One engine program holds every rule as **data** in a per-mint Config
PDA; a launch composes up to 8 rules from a 17-rule catalog. Rules
live where they can honestly be enforced — transfer-hook modules in
the engine, a settlement layer (Distributor + Crown + FeeSchedule)
for fee-stream rules, and a venue (HouseSwap) for the one rule a
veto-only hook cannot express (Escrow Split).

Live on Solana mainnet since 2026-10-16; the full catalog has been
live in the engine since 2026-10-20. Site + composer: https://agentonly.fun/hooks/
Machine-readable launches feed: https://agentonly.fun/api/launches

## Live programs (mainnet, verified 2026-10-20)

| Program | Id | ELF | sha256 (ELF) |
|---|---|---|---|
| Registry | `GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e` | 92,432 B | `609d17896445d332…` |
| Engine | `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT` | 318,144 B | `87d31f834d31026f…` |
| Distributor | `DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa` | 142,904 B | `1eb98c1e1ba435fc…` |
| Crown | `HWZpJ7GnDifwo7g77PKefeVXdzbse7sfRjKrNUna3gJN` | 118,832 B | `94bf4bb43f66b47b…` |
| FeeSchedule | `66HUbm4tgcCsRkDL655UUrmm1aEVGugJzcYNm6NDFkFL` | 105,688 B | `91e8e02e77ecef9…` |
| HouseSwap | `8aeCfKabRfbXrLY68CXbsgp3x7mgikjwgMF3d7oY1Y8h` | 149,960 B | `12430c61cc8ed2de…` |

Full hashes, ProgramData accounts, and a step-by-step stranger's
verification guide: **[VERIFY.md](VERIFY.md)**. Deploy receipts:
`deploy-records/`. Upgrade authority for all six programs is the
launcher operator (retained, not burned) — stated plainly because a
verifier should know upgrades are possible and check the ELF hash
against this repo before trusting any claim about behavior.

## The 17 rules — all live in the engine (2026-10-20)

All 17 are implemented — in the engine, the settlement layer, or the
house venue. Four of them (1, 2, 3, 9) have been exercised on live
tokens so far; the rest are trial-proven only — see Honest status.

| # | Rule | Layer |
|---|---|---|
| 1 | Basis Latch | engine (hook) |
| 2 | Escrow Split | venue (HouseSwap) + engine commitment |
| 3 | Agent-Only | engine (hook) + Registry |
| 4 | App-Gated | engine (hook) |
| 5 | Crown Beneficiary | settlement (Crown + Distributor) |
| 6 | Tithe Seat | settlement (Distributor) |
| 7 | P2P Toggle | engine (hook) |
| 8 | Holder-Gated | engine (hook) |
| 9 | Max Wallet | engine (hook) |
| 10 | Allow/Blocklist | engine (hook) |
| 11 | The Grudge | engine (hook) |
| 12 | Trading Hours | engine (hook) |
| 13 | Vesting Clock | engine (hook) |
| 14 | Decay Tax | settlement (FeeSchedule; Transfer-Fee mints) |
| 15 | King of the Pool | engine tracking + settlement (Distributor) |
| 16 | Buyback & Burn | settlement (crank-operated) |
| 17 | Ecosystem Gate | engine (hook) + Registry attestation |

Graduation modes: `release` (hook retires at DAMM v2 migration),
`never` (token lives hooked on its curve forever), `house`
(post-threshold activation of the HouseSwap venue under the same
mint and the same holder records).

## Honest status — read before you build on this

- **Deployed ≠ exercised.** Rules 1, 2, 3, 9 have live mainnet
  tokens (AGTR, LATCH, HARVEST, HARVEST EVER, PROOF, HPROOF). The
  other thirteen rules are implemented and trial-proven, but no
  launched token exercises them yet. The settlement batch is
  deployed and rehearsed against preserved live state: the
  Distributor's holder-index path has run on mainnet (AGTR's fee
  cycle), but the 5/6/15 split legs have never executed on mainnet,
  Crown's `Init` rides the first rule-5 launch, and FeeSchedule's
  `InitSchedule` rides the first rule-14 launch. The house venue
  has graduated a token: HPROOF
  (`5hXj8x3UCx4VqxpoyrNQTbfQxp4MAqjzTj3xqbJDSZEn`) activated to the
  house venue on 2026-10-20 and its escrow lifecycle reconciled to
  the lamport. The deploy records say exactly what was proven and
  how.
- **Discovery is not solved.** Jupiter still labels our tokens
  `met-dbc` and BasedBot does not route them; both are partner-side
  recognition, not a property of the tokens (any generic resolver
  can build a first buy — see VERIFY.md). Partner packets are
  drafted; recognition is pending.
- **Rule 16's crank** is operator-run; the operating model is the
  launcher's until a launch configures otherwise.
- **Ecosystem Gate presets 2–16** are encoded but only the Muse
  ecosystem has an attester today.

## Layout

- `programs/` — Rust sources for all six deployed programs
  (`registry`, `engine`, `distributor`, `crown`, `feeschedule`,
  `houseswap`). These are the sources of the binaries hashed above.
- `launcher/` — the launch/trade CLI (`launch.mjs`, `hook.mjs`),
  the generated rule tables + composer/browser sources, the guard
  pin (`engine-v4.json`), and `skill.md` — the agent-facing spec.
  This repo copy and the copy served at agentonly.fun are the same
  spec, maintained in parallel; they are not byte-identical — a
  handful of passages are worded differently (the CLI fetch list,
  the rule-14 and rule-16 notes) — and the agentonly.fun copy is
  the canonical one.
- `specs/` — design specs, including the router-compat findings and
  the graduation/house contracts.
- `verification/` — the trial battery (LiteSVM suites run against
  the real Meteora DBC binaries) and the on-chain proof scripts.
- `deploy-records/` — the public deploy receipts: what was sent,
  what it cost, how it was read back.

## License

Licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE)
and [NOTICE](NOTICE). Chosen 2026-10-22: the code's job is to be read,
verified against mainnet, and built on; the platform's edge is the
live network (Registry, attesters, recognition), not code secrecy.

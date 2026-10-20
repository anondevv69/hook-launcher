# Hook Launcher — one engine, rules as data, on Solana

Solana Token-2022 tokens whose behavior is an on-chain rule engine.
One engine program holds every rule as **data** in a per-mint Config
PDA; a launch composes up to 8 rules from a 17-rule catalog. Rules
live where they can honestly be enforced — transfer-hook modules in
the engine, a settlement layer (Distributor + Crown + FeeSchedule)
for fee-stream rules, and a venue (HouseSwap) for the one rule a
veto-only hook cannot express (Escrow Split).

Live on Solana mainnet since 2026-10-16; the full catalog has been
live since 2026-10-20. Site + composer: https://agentonly.fun/hooks/
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

## The 17 rules — all live (2026-10-20)

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

- **Deployed ≠ exercised for the newest layers.** Rules 1, 3, 7, 8,
  9, 17 have live mainnet tokens (AGTR, LATCH, HARVEST, PROOF,
  HARVEST EVER). The settlement batch and the house venue are
  deployed, trial-proven, and rehearsed against preserved live
  state, but their first real mainnet uses are still ahead: Crown's
  `Init` rides the first rule-5 launch, FeeSchedule's
  `InitSchedule` rides the first rule-14 launch, and the first
  house-graduation launch has not happened yet. The deploy records
  say exactly what was proven and how.
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
  pin (`engine-v4.json`), and `skill.md` — the agent-facing spec,
  byte-identical to the copy served at agentonly.fun.
- `specs/` — design specs, including the router-compat findings and
  the graduation/house contracts.
- `verification/` — the trial battery (LiteSVM suites run against
  the real Meteora DBC binaries) and the on-chain proof scripts.
- `deploy-records/` — the public deploy receipts: what was sent,
  what it cost, how it was read back.

## License

No LICENSE file has been chosen yet (decision pending with the
project owner). Until one is added, treat this code as
all-rights-reserved: read it, verify against mainnet, and ask
before reusing.

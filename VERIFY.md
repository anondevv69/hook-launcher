# VERIFY.md — check us without trusting us

Everything the README claims can be checked against Solana mainnet
with any RPC endpoint. No account, no permission, no trust in this
repo required. All values below were re-read from chain on
2026-10-20.

## 1. The deployed binaries are the ones in this repo

For each program: fetch its ProgramData account, take the ELF bytes
— they start at offset **45** and run for the program's ELF length —
and sha256 them. (Do **not** strip trailing zeros: these ELFs
legitimately end in zero bytes; hash exactly `length` bytes.)

| Program | Program id | ProgramData | ELF length | ELF sha256 |
|---|---|---|---|---|
| Registry | `GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e` | `AZPP5W8QrPhGJ9mzPFRV4z23Sr3PJawKxjikGvmBANUF` | 92,432 | `609d17896445d33255991bccb5fbcfa7fc7b2f7f1521b521e374d31e2242e898` |
| Engine | `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT` | `6cU272AbbwEcr9SntbLEfSTUo2MfsdcSBcU1FsTCqMdB` | 318,144 | `87d31f834d31026f4492dd718f4f07d69897a8b2dd8b1257dc5c188cecc398cb` |
| Distributor | `DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa` | `2oKkGyA2ygbAfkk5VnppTTfhngj9uNoqox7Eig6TApwS` | 142,904 | `1eb98c1e1ba435fc44bdcff9d9b6881bb262663b0773340f4c086a502f46e9de` |
| Crown | `HWZpJ7GnDifwo7g77PKefeVXdzbse7sfRjKrNUna3gJN` | `Dj4HJgZvKT5kVuBVjSGokpMDbAwwk8JcccmbioaXi81r` | 118,832 | `94bf4bb43f66b47b132f907cacc9f73f3794f66534526cdd766c4d5cbe88cfd7` |
| FeeSchedule | `66HUbm4tgcCsRkDL655UUrmm1aEVGugJzcYNm6NDFkFL` | `7uehbL3y5kcfyp6pg9adCcWkVqFbTfYEfJsKcMGN7y75` | 105,688 | `91e8e02e77ecef97459811e82636fa750fe05c3edcc4f9ad46ab9c0aa1b7f393` |
| HouseSwap | `8aeCfKabRfbXrLY68CXbsgp3x7mgikjwgMF3d7oY1Y8h` | `8QYJ4r2styruwkZ2pmg5GwdxYerRpfpDMNe9CR6DsC8B` | 149,960 | `12430c61cc8ed2de60551bb1cfbcb5851ead0f925aa50b10c113447e263cfa9e` |

Copy-paste check (Python 3, stdlib only):

```python
import json, subprocess, hashlib, base64

PD, LEN, EXP = ("6cU272AbbwEcr9SntbLEfSTUo2MfsdcSBcU1FsTCqMdB", 318144,
                "87d31f834d31026f4492dd718f4f07d69897a8b2dd8b1257dc5c188cecc398cb")
body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getAccountInfo",
                   "params": [PD, {"encoding": "base64", "commitment": "finalized"}]})
out = subprocess.run(["curl", "-s", "https://solana-rpc.publicnode.com",
                      "-X", "POST", "-H", "Content-Type: application/json",
                      "-d", body], capture_output=True, text=True).stdout
data = base64.b64decode(json.loads(out)["result"]["value"]["data"][0])
print(hashlib.sha256(data[45:45 + LEN]).hexdigest() == EXP)  # -> True
```

Swap in any row from the table. Then rebuild the matching program
from `programs/` (`cargo build-sbf`) and compare your artifact's
hash — or simply read the source knowing the hash pins the binary.

**The guard pin.** The launch composer refuses to build unless the
live engine matches a pinned hash: sha256 of the engine ProgramData
from offset 45 to the end of the account. The engine account is
exact-fit (318,189 B = 45 + 318,144), so today the tail hash equals
the ELF hash above, `87d31f83…`. It is recorded in
`launcher/engine-v4.json` and enforced by
`launcher/bin/check-rule-parity.mjs`. If the ProgramData is ever
resized, the tail hash changes even for identical code — the pin is
deliberately that strict.

## 2. A token's rules are public data

Every launched token has a Config PDA under the Engine program,
seeds `["config", mint]`. Read it and you read the token's exact
rule stack — no API in between. The five live examples:

| Token | Mint | Rules |
|---|---|---|
| AGTR | `Hfk7uqxZ3fFB4TpAzSKYGCJ3uuAJ1E1fk6i6vSn3FVXR` | Agent-Only, Max Wallet 500 bps |
| LATCH | `CFG9xRhq7NJ3UGR7VBU4bBgJotXTMZ2inhcfugX78t27` | Graduated Latch, Max Wallet 300 bps |
| HARVEST | `2a8hxHj6CFLvQrhjEEDXBhSuRQkLfUMzTW36NijZ1tAo` | Basis Latch, Max Wallet 500 bps |
| PROOF | `AA7YKCXhW8YyeMeka3Nv868B1WCBLRit1amiz4mt23kY` | template-parity test launch |
| HARVEST EVER | `6qfXuiKUsQEutT5nRK9TD8oadCywdqh5jNAtErv3Ghea` | Basis Latch, `never` graduation |

Or let the CLI do it: `node launcher/hook.mjs status <mint>`
(read-only). Cross-check against the public feed:
https://agentonly.fun/api/launches (itself reconciled against
chain state).

## 3. The behavioral test that matters

The property this design exists for: **a stranger's first buy must
build through generic tooling** — the hook's extra-account list
derives from addresses only, never from the contents of an account
that doesn't exist yet.

Try it: create a fresh wallet, resolve the mint's extra account
metas through the standard Token-2022 `getExtraAccountMetas`
interface, and build a Meteora DBC buy for HARVEST with any generic
resolver (the scripted version is `verification/dbc-v3-headline.mjs`).
It lands. Then try to sell immediately: the Basis Latch vetoes it
(`Locked`) until price or time earns the exit — that veto, on a
token you don't control, from a wallet we have never seen, is the
system working. HARVEST's first generic-resolver buy and vetoed
sell are recorded in `deploy-records/DEPLOY-RECORD-S1.md` and the
launch records.

## 4. The trial battery

Behavioral suites (LiteSVM against the real Meteora DBC binaries),
counts as of 2026-10-20 per the build/deploy records in
`deploy-records/`:

| Suite | File | Result |
|---|---|---|
| Engine Phase C (full) | `verification/trial-phase-c.mjs` | 106/106 |
| Crown | `verification/trial-crown.mjs` | 66/66 |
| FeeSchedule | `verification/trial-feeschedule.mjs` | 52/52 |
| HouseSwap | `verification/trial-houseswap.mjs` | 87/87 |
| House activation | `verification/trial-house.mjs` | 35/35 |
| Rule parity (composer ↔ engine) | `verification/trial-rule-parity.mjs` | 24/24 |
| Distributor core | `verification/trial-distributor.mjs` | 61/61 |
| Fee splits | `verification/trial-splits.mjs` | 42/42 |
| Splits on hooked mints | `verification/trial-splits-hooked.mjs` | 26/26 |
| Fold / hooked regressions | `verification/trial-fold.mjs`, `trial-hooked.mjs` | 23/23 each |
| Live-state rehearsals (AGTR preserved bytes) | `verification/trial-s3-rehearsal.mjs`, `trial-c-run-rehearsal.mjs` | 6/6 each |

Run any suite with `node verification/<file>` from a checkout with
the program sources built (the suites load the compiled programs
and the Meteora DBC binaries; the build records in
`deploy-records/` are the transcripts of the runs behind every
deployment).

## 5. What a hash match does and doesn't prove

A match proves the program running at that address is the program
built from this source tree at the recorded state. It does not
prove the operator will never upgrade — the upgrade authority is
retained (see README). Re-run §1 after any announced window: the
deploy records publish the new hash in the same format, and an
unannounced hash change is exactly the signal this file exists to
surface.

# agentonly-runtime — AgentOnly reference signer runtime

A small, open, **non-custodial** local runtime for AgentOnly, the
hook-aware launchpad for Solana agents. It exists for one honest reason:

> **A compatible agent can prepare and locally sign a protected trade.
> A chat alone cannot sign.**

If your agent lives in a hosted chat (Claude, ChatGPT, …), no prompt can
give it Solana signing power — pasting instructions into a chat does not
create a wallet, a signer, or a broadcast path. This runtime is the piece
that runs **on the owner's own machine**: it prepares a trade through the
AgentOnly Execution Gateway, shows the owner exactly one approval card,
and signs locally only when the owner approves that exact card.

## How it works

```
inspect ─► eligibility ─► quote ─► build (gateway-simulated)
        ─► intent decoded from the build bytes, VALIDATED, and every
           instruction CLASSIFIED into the approved trade shape
        ─► ONE approval card ─► owner approves the card fingerprint
        ─► sign locally (or via the external signer adapter)
        ─► MANDATORY simulation of the exact signed bytes (sigVerify),
           with FULL-EFFECT accounting over every writable account
        ─► broadcast ─► confirm against the CARD's blockhash window
        ─► receipt (before/after balances)
```

- The **Execution Gateway** (`https://agentonly.fun/v1/*`) is keyless: it
  quotes, checks eligibility, builds **unsigned** hook-aware transactions
  and simulates them. It never receives key material — it actively
  rejects key-shaped payloads. Contract:
  `https://agentonly.fun/api/v1/gateway-openapi.json`.
- The **approval card** (format version 2) binds one wallet, one mint,
  one side, one amount (or minimum proceeds), the simulated build, the
  validated intent, explicit economic bounds, and a short expiry (the
  build's last valid block height). Its fingerprint — the sha256 of the
  exact transaction bytes — is the approval token. Approving any other
  trade does not approve this one.
- **Signing happens here**, with a keypair file the owner designates (or
  an external signer the owner commands — see below). Nothing is ever
  signed that was not freshly simulated and intent-validated, and stale,
  unsimulated, tampered, mismatched, expired, or route-changed builds
  are refused — *rebuild, not retry*.

## Intent validation (the card is not trusted — the bytes are)

The card's friendly fields are a display, not evidence. At **prepare**
time the runtime decodes the gateway build's actual bytes — legacy and
versioned transactions, with address lookup tables resolved through the
connection — into a normalized **intent**: fee payer, required signers,
per-instruction program + kind summary, writable accounts, blockhash.
(Version detection parses the message header *after* the signature
shortvec — a serialized transaction starts with a signature count, not
the version flag.) It then validates that intent against the request,
the build response, and the token's canonical record
(`https://agentonly.fun/api/v1/tokens/<mint>.json`). The canonical
record is load-bearing: if it cannot be fetched, prepare **and** send
refuse with `CANONICAL_DATA_UNAVAILABLE` — pool validation is never
skipped.

- fee payer must equal the selected wallet, and the required signers
  must be exactly `{wallet}` — no co-signers, no substituted payer;
- every program must be on the allowlist: System, ComputeBudget,
  SPL Token, Token-2022, Associated Token Account, Memo, and the
  AgentOnly platform/venue programs (DBC curve venue, hook engine,
  registry, distributor, house swap). ComputeBudget
  `SetComputeUnitPrice` is rejected specifically (no priority-fee
  surprises);
- token `Approve` / `ApproveChecked` / `SetAuthority` instructions are
  rejected anywhere in the transaction — a trade build never needs to
  delegate your tokens;
- the decoded instructions must involve the requested mint, the venue
  program must match the quote's venue, and the curve pool from the
  canonical token record must be among the transaction's writable
  accounts;
- the build response must agree with its own bytes (blockhash, raw
  `amount_in`) or prepare refuses.

**Allowlisting is not enough — every instruction must also classify
into the exact trade shape.** A build could pass a program allowlist
while bundling a legitimate swap with an extra transfer, so each
decoded instruction is classified: ComputeBudget limit/heap settings,
Memo, platform (engine/registry/distributor) instructions, the quoted
venue's swap instruction, creation of the wallet's *own* ATA for the
card mint, a System SOL transfer that is exactly the wallet↔pool leg
(buy: wallet→pool, sell: pool→wallet), and token
Transfer/TransferChecked instructions only between the wallet's
account for the card mint and the pool's vault. Anything else — a
System transfer to any other destination, a token instruction touching
a different mint, a MintTo, an unclassifiable instruction on an
allowlisted program — refuses with `UNCLASSIFIED_INSTRUCTION`.

At **send** time the intent is re-derived from the card's bytes and
deep-compared with the intent stored on the card, and every displayed
field (amount, minimum out, bounds, blockhash) is cross-checked against
the validated record. Editing a card's friendly fields — even with the
transaction bytes and fingerprint untouched — refuses with
`INTENT_CARD_MISMATCH` before anything is signed.

The card prints this as a **validated intent summary**: a human-readable
rendering of what was decoded and checked. A summary is not the rules
and not a proof — the enforcement is the re-derivation at send time,
not the text on the card.

## Full-effect accounting, enforced from the signed-byte simulation

Signing is never the last check. After signing, the runtime **always**
simulates the exact signed bytes (`sigVerify: true`), on both the
dry-run and the broadcast path; any error refuses with
`SIMULATION_FAILED` and the transaction is never broadcast. The
simulation is requested with **every writable account the transaction
touches** (plus the fee payer and the canonical pool set) attached, so
the runtime can compare pre-state against post-simulation state for
*all* of them — not just the wallet's own accounts:

- **Aggregate bounds on the wallet:** the SOL debit must not exceed
  `maxSolDebitLamports` — the trade amount plus an explicit **fee
  ceiling** (`feeCeilingLamports`, set at prepare with
  `--max-fee-lamports`, default 5000000). The bound is never silently
  widened; a buy must credit at least the card's minimum-out of the
  token; a sell must debit the full approved token amount and credit
  at least minimum-out minus the fee ceiling.
- **Permitted effects only:** the only accounts whose lamport or token
  balances may change are (i) the wallet, (ii) the canonical pool
  accounts (the pool and its vaults from the token record), and
  (iii) the wallet's own token accounts for the card mint (including
  ATA-creation rent arriving in a newly created own ATA). **Any other
  account changing balance, in either direction, refuses with
  `UNEXPECTED_EFFECT`.** The pool side must also behave like the
  counterparty: it cannot gain the token on a buy, cannot receive more
  SOL than the approved input, cannot pay out beyond the expected
  proceeds plus the fee ceiling on a sell.
- **Fail closed on state:** if the simulation returns missing,
  partial, or malformed account states — an expected account absent,
  an entry truncated, token data that does not decode — the send
  refuses with `SIMULATION_STATE_MISSING`. There is no pass-through:
  delta verification is mandatory, not best-effort.

Confirmation then uses the **card's own** blockhash strategy —
`confirmTransaction({signature, blockhash: card.blockhash,
lastValidBlockHeight: card.lastValidBlockHeight})` — never a freshly
fetched blockhash, which would let an expired build ride a new window.

## Install & run

Requires Node ≥ 18.

```sh
cd agentonly-runtime
npm ci --ignore-scripts
# run via the bin:
node bin/agentonly-runtime <command>
# or link it: npm link   →   agentonly-runtime <command>
```

(`npm ci --ignore-scripts` is the install path: a clean, lockfile-exact
install that runs no package lifecycle scripts.)

### Commands

```sh
# 1. Create a wallet — ONLY on the owner's explicit request.
#    Exclusive creation (never overwrites), mode 0600, plus the
#    persistence handshake and a sidecar (see "Persistence" below).
agentonly-runtime wallet create --file ./my.keypair.json
agentonly-runtime wallet show   --file ./my.keypair.json   # address only

# 1b. In a LATER session, attest that the keypair file persisted.
#     prepare/send refuse a runtime-created wallet until this is done.
agentonly-runtime wallet attest-persistence --file ./my.keypair.json

# 2. Inspect a token (canonical record + live market snapshot)
agentonly-runtime inspect Hfk7uqxZ3fFB4TpAzSKYGCJ3uuAJ1E1fk6i6vSn3FVXR   # AGTR

# 3. Prepare a trade → writes ./approval-card.json, prints the card
agentonly-runtime prepare --file ./my.keypair.json \
  --mint Hfk7uqxZ3fFB4TpAzSKYGCJ3uuAJ1E1fk6i6vSn3FVXR \
  --side buy --amount 0.05
#   --side sell --amount <tokens in UI units> works the same way.
#   --max-fee-lamports <n> sets the explicit fee ceiling (default 5000000).
#   Amounts are strict decimals (see below).

# 4a. Dry run — sign and simulate the exact signed bytes.
#     Nothing is broadcast; no funds move.
agentonly-runtime send --file ./my.keypair.json \
  --card ./approval-card.json --approve <card fingerprint> --dry-run

# 4b. The real send — same card, same approval, without --dry-run.
#     Simulates the signed bytes first (mandatory), broadcasts, confirms
#     against the card's blockhash window, prints the receipt.
agentonly-runtime send --file ./my.keypair.json \
  --card ./approval-card.json --approve <card fingerprint>
```

Configuration (env): `AGENTONLY_RPC_URL` (default
`https://api.mainnet-beta.solana.com`), `AGENTONLY_GATEWAY_BASE` /
`AGENTONLY_SITE_BASE` (default `https://agentonly.fun`).

### Strict amounts

`--amount` is parsed as an exact decimal — `^(0|[1-9][0-9]*)(\.[0-9]+)?$`,
converted with integer arithmetic, never floats. Exponent notation
(`1e-3`), hex, negatives, `NaN`/`Infinity`, and more fractional digits
than the asset allows (9 for SOL buys, the mint's own decimals for
sells) are all rejected with `INVALID_AMOUNT` before any network call.

## Signer compatibility

| signer type | verdict |
|---|---|
| `own` — a local keypair file you control (Path A) | supported |
| `sandbox` — a sandbox keypair (Path B′) | supported — attest its persistence before funding it |
| `external` — an external signer executable (protocol below) | supported — wire-equivalent to Path A; spawned without a shell; returned bytes are validated before use |
| `bankr`, `custodial` — custodial / EVM-only wallets | **refused up front** with `TK_SIGNER_UNSUPPORTED`: the unsupported step is *arbitrary Solana instruction signing* (e.g. Bankr's documented signing surface is `personal_sign`, `eth_signTypedData_v4`, `eth_signTransaction` — all EVM). The refusal names the working alternative: an agent-controlled Solana signer. |

This mirrors the gateway's own verdict — a Bankr wallet gets the same
refusal from `/v1/trade/build`, by name, before any spending path.

### External signer protocol

```sh
agentonly-runtime prepare --signer-type external --wallet <address> \
  --mint <mint> --side buy --amount 0.05
agentonly-runtime send --signer-type external \
  --external-signer <executable-path> \
  [--external-signer-arg <value> ...] \
  --wallet <address> \
  --card ./approval-card.json --approve <fingerprint> [--dry-run]
```

No local keypair is involved. In this mode `prepare` only needs the
wallet address (it never signs). `--external-signer` names a **trusted
executable path** — a single plain path with no spaces or shell
metacharacters, which must exist and be executable (anything else
refuses with `EXTERNAL_SIGNER_INVALID` before any spawn). Arguments
are passed as structured argv via repeatable `--external-signer-arg`
flags. The runtime spawns the executable directly with `shell: false`
— **there is no shell anywhere in this path**, so signer text can
never become shell syntax. (To run a script, name your interpreter,
e.g. `--external-signer /usr/bin/node --external-signer-arg signer.mjs
--external-signer-arg keypair.json`.) At send time the runtime:

1. spawns the executable with the structured arguments,
2. writes the **unsigned** transaction (base64) to its stdin,
3. reads the **signed** transaction (base64) from its stdout,
4. validates the returned bytes before anything else: the message bytes
   must be **byte-identical** to the unsigned transaction's, the fee
   payer must be unchanged, and the wallet's signature slot must be
   filled — any deviation refuses with `EXTERNAL_SIGNER_MISMATCH`
   (spawn failure, empty or undecodable output:
   `EXTERNAL_SIGNER_FAILED`),
5. then runs the same mandatory signed-byte simulation and full-effect
   accounting as a local send.

## Persistence: what is and isn't proven

`wallet create` runs a **persistence handshake**: a separate process
re-reads the keypair file and must derive the same address. Be precise
about what that means:

- It **proves** the file is readable by another process **right now**.
- It does **not** prove durability across a host restart, a snapshot
  rollback, or volume loss. A sandbox that "persists" within a session
  can still lose the file between sessions — and a lost keypair strands
  every lamport sent to it.

So `wallet create` also writes a sidecar, `<file>.agentonly.json`,
and the funding gate is a **second, later step**:

```sh
agentonly-runtime wallet attest-persistence --file ./my.keypair.json
```

Run it as a separate invocation in a later session (ideally after a
host restart). It stamps `attestedAt` into the sidecar. `prepare` and
`send` refuse a runtime-created wallet (sidecar present) that has no
`attestedAt` — `WALLET_NOT_ATTESTED`. Keypair files **without** a
sidecar are owner-imported and are not gated.

The sidecar is **integrity-bound to its wallet**: it records the
wallet address and the SHA-256 of the keypair file's exact bytes, and
the sidecar file itself gets the same load hardening as the keypair
(symlinks and group/world-readable sidecars are refused). Attestation
verifies the recorded address before stamping the binding; every later
load of a sidecar-gated wallet re-verifies address + hash. A sidecar
copied from another wallet, or a keypair file whose bytes changed
since attestation (even a reformat of the same key), refuses with
`SIDECAR_BINDING_MISMATCH`. Attestation is evidence, not a guarantee:
back up any wallet that holds meaningful funds yourself — this
runtime has no recovery.

## Safety boundaries

- **Non-custodial.** Keys exist only as the file you pass with `--file`.
  Keypair files are created exclusively (`wx` — an existing path is
  refused, never overwritten) with mode `0600`; on load, symlinks and
  any file with group/world permission bits are refused with a fix-it
  message. No custody, no seed backup, no recovery.
- **No key material leaves the machine.** The gateway is keyless by
  design; this runtime never transmits keys, seeds, or signed blobs
  (except broadcasting the signed transaction itself, which is the
  point of step 4b).
- **No standing mandate.** Every send needs a fresh card and a fresh
  `--approve <fingerprint>` naming that exact card. Expired builds,
  venue changes (graduation), simulation vetoes, wallet mismatches,
  approval mismatches, intent mismatches, and bound violations all
  refuse *before* broadcast.
- **Approval is bounded.** The card states side, mint, amount, expected
  out, minimum out, fees, price impact, the validated intent summary,
  the explicit SOL/fee bounds, the simulation result, and the expiry
  block height. What you approve is what gets signed — byte for byte
  (the fingerprint is checked against the transaction inside the card at
  send time, and the intent is re-derived and compared).
- **Honest failure.** An unfunded wallet fails preparation with the
  funds problem stated plainly; a hook veto surfaces with its classified
  layer and engine error name. Nothing is dressed up as success.
- **No unattended or recurring execution.** This is a reference
  implementation of the prepare → approve → sign flow, not a bot.

## Tests

```sh
npm test    # node test/fixtures.mjs
```

Twenty-two acceptance fixtures: persistent local signer (handshake,
sidecar, attestation gate, exclusive create) · unsupported signer ·
unfunded wallet (live) · hook veto on simulation · expired build ·
approval mismatch · happy-path dry-run with delta enforcement ·
graduation-driven route rebuild · **forged card** (friendly fields
edited, bytes untouched → refused) · **build/claim mismatch** (build for
the wrong mint → prepare refuses) · **broadcast-path simulation
failure** (nothing is broadcast) · **confirmation strategy** (the card's
blockhash + LVBH reach `confirmTransaction`) · **external signer**
(good signer completes a dry run; a message-altering signer and a
shell-string signer are refused) · **key-file hardening** (0644 and
symlinked keypairs refused) · **strict amounts**
(exponent/negative/garbage/over-precision rejected) · **malicious
bundle: extra SOL transfer** (valid swap + 0.5 SOL to a stranger →
instruction classification refuses at prepare) · **malicious bundle:
unrelated-token transfer** (→ refused at prepare) · **unexpected
simulation effect** (a third account gains lamports → `UNEXPECTED_EFFECT`,
nothing broadcast) · **incomplete simulation state** (→
`SIMULATION_STATE_MISSING`, fail closed) · **canonical data unavailable
at send** (→ `CANONICAL_DATA_UNAVAILABLE` before signing) · **real v0
transaction with an address lookup table** (decoded, validated,
dry-run) · **sidecar binding** (a copied sidecar and a reformatted
keypair file both refuse with `SIDECAR_BINDING_MISMATCH`). All keys in
tests are fresh throwaway keypairs in a temp dir; nothing is broadcast
and no real funds are involved anywhere.

One scoping note, verified live: the public mainnet RPC refuses to
simulate *any* transaction whose fee-payer account does not exist
on-chain (`err: "AccountNotFound"`) — which is exactly the unfunded
case. The simulate steps therefore run against a local JSON-RPC stub
that first cryptographically verifies the signature and the exact
message bytes it received, then answers success **with post-simulation
account states** — so the delta enforcement reads real state
transitions, not assertions. The construction, card, approval, signing,
and delta checks are all real; only the answering node is a test
double, for the reason above.

## Layout

```
bin/agentonly-runtime   # entry point
src/cli.mjs             # commands (thin shell)
src/runtime.mjs         # gateway client, card logic, signer guard, send path
src/intent.mjs          # transaction decoding + intent validation (issue #4, P0-1)
test/fixtures.mjs       # acceptance fixtures (22)
```

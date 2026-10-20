# REGISTRY — integration contract

**Program:** `DQ3a7B5QeoDbrVeDC6cDuXrTe8wePLwhX9jPqXrhvL5V` (dev keypair, `registry-keypair.json`)
**MAINNET (2026-10-15):** deployed as `GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e` (fresh keypair, same binary, on-chain ELF byte-exact; upgrade authority = fren, not burned). See `../deploy/DEPLOY-RECORD.md`.
**Binary:** `target/deploy/registry.so`, **83,872 bytes** (SBF v1) → programdata rent-exempt ≈ **0.585 SOL** ((83,872 + 128) × 6,960 lamports). Built + proven 2026-10-15, LiteSVM trial **23/23** (`trial.mjs`, output `trial-output.txt`). No mainnet deployment.
**Per-account rent:** Registration PDA (48 B) = **1,224,960 lamports** (measured in trial), paid by the registering wallet.

Spec: `SPEC-HOOK-LAUNCHER.md` §2.5 (registry), §5 rule 3 (Agent-Only).

## Account: Registration PDA

Seeds: `["registration", wallet]` under THIS program. Space 48 B:

| Offset | Field | Notes |
|---|---|---|
| 0 | tag u8 = 1 | |
| 1..33 | wallet | == the seed wallet, validated on every write |
| 33 | kind u8 | 0 = Human, 1 = Agent |
| 34 | verified_via u8 | 0 = self-signed (only value writable in v1; others reserved) |
| 35..43 | registered_at i64 | unix timestamp at first registration |
| 43 | active u8 | 1 = active, 0 = deactivated |
| 44..48 | reserved | zeros |

**Validity predicate (what every reader must check):** account exists AND owner == registry program AND tag == 1 AND wallet field == expected wallet AND `active == 1`. Anything else — including a missing account — is "not registered".

## Instructions (tag = data[0])

| Tag | Name | Data | Accounts | Semantics |
|---|---|---|---|---|
| 0 | Register | `[0][kind u8]` | [wallet (signer, w), registration PDA (w), system] | Self-registration. The PDA is derived from the **signer's** key, so registering another wallet is impossible by construction (trial T5: wrong-PDA fails `InvalidSeeds`). Duplicate register fails `AlreadyRegistered` (custom 1). kind outside {0,1} fails `BadKind` (custom 4). |
| 1 | SetActive | `[1][active u8]` | [wallet (signer), registration PDA (w)] | The wallet toggles its own record. Missing record fails `NotRegistered` (custom 2). |
| 2 | Close | `[2]` | [wallet (signer, w), registration PDA (w)] | Drains rent back to the wallet, account removed; re-registering starts clean (trial T8). |

**Authority decision (deliberate): self-service only.** No launcher admin can create, deactivate, or close another wallet's registration. Rationale: the registry's promise is "registration == key possession; state == the wallet's own word" — an admin override adds a trust/censorship surface the spec never asked for. Key compromise is served by the wallet itself (set_active/close) or by abandoning the wallet. A future governance instruction is the documented extension point; it is NOT implemented and readers must not assume one exists.

## The engine integration decision (Agent-Only, rule 3)

**Decision: mirror-with-permissionless-sync.** The Registry is the source of truth. The engine keeps reading its own Holder PDA `registered` byte (byte 1) in Execute — unchanged — and that byte is written by a **sync instruction** that validates a presented Registration PDA. This supersedes the drop-in sketched in the engine's BUILD-NOTES (deviation 5), which assumed the registry could replace the stub's caller/authorization while the flag stayed put; two hard constraints kill the direct alternatives:

1. **The hook's meta tail cannot resolve a foreign program's PDA.** Token-2022/SPL extra-account resolution derives seed-based accounts under the *hook program's* id. A `["registration", wallet]` account is a PDA of the REGISTRY program; no meta entry can name it. (Literal metas are per-mint constants, not per-wallet.)
2. **Programs cannot write accounts they do not own.** The registry cannot set the flag inside engine-owned Holder PDAs, and the engine cannot identify a CPI caller (the instructions sysvar exposes only top-level instructions), so a registry-CPI write path cannot be authorized safely.
3. A cached flag is only a revocation risk if it can go stale — the sync design bounds that explicitly (below), whereas direct-read designs are simply impossible per (1).

### Exact engine follow-up (small, fully specified — NOT done in this workstream)

Change engine tag 4 (`SetRegistered` → semantics become **SyncRegistered**), no other engine change; Execute, the meta list, and both PDA layouts are untouched, so the 26/26 engine trial stands (its T3/T4 flows used the authority path, kept below):

- **Accounts:** append one trailing account: `[…, system, registration_pda (ro)]` (index 6). 
- **Authorization:** accept EITHER (a) the existing path — signer == config authority (kept for launch/trial flows), OR (b) the presented registration account validates: key == `find_program_address(["registration", owner], REGISTRY_ID)`, owner == `REGISTRY_ID` (new compile-time const `DQ3a7B5QeoDbrVeDC6cDuXrTe8wePLwhX9jPqXrhvL5V`), tag == 1, wallet field == owner. Under path (b) **any payer may call** (permissionless sync).
- **Write:** `holder.registered := (registration.active == 1)`. The data byte (data[1]) is ignored under path (b) — the flag always mirrors the registry.

### Revocation discipline (the one bounded weakness — read it)

Under the mirror, `set_active(false)` takes effect on a mint at the next sync for that (mint, wallet). Platform surfaces close the gap:

- The launcher keeper watches Registration PDAs and calls SyncRegistered for every (mint, wallet) pair it knows (mints with Agent-Only enabled × the wallet).
- The trade page / agent skill call SyncRegistered before a wallet's first trade on a mint and immediately after any set_active.
- Third-party venues integrating Agent-Only tokens must do the same pre-trade sync; the launcher docs list it as part of venue integration (alongside resolving the meta list).

Practical exposure: a just-deactivated wallet can still receive on an unsynced third-party venue until that venue syncs. Registration *activation* has no such lag issue for safety (an unsynced wallet reads unregistered = fail-closed, the safe direction).

### Off-chain readers

Token pages/APIs read the Registration PDA directly (validity predicate above) — no sync involved for display. The engine flag is an execution-layer mirror only.

## Trial coverage (`trial.mjs`, 23/23)

Register field-exactness (incl. `registered_at` == SVM clock set for the trial), unregistered = no PDA, Human kind, duplicate rejected, wrong-signer/wrong-PDA register fails with no state leaked, set_active toggles the validity byte both ways, stranger cannot touch another wallet's record, set_active on nothing fails `NotRegistered`, close returns the exact rent and re-register works, bad kind rejected with nothing persisted.

---

# ADDENDUM — Registry v2: ecosystem attestation (2026-10-15)

Built for the Ecosystem Gate (engine rule 17). Full design + upgrade
package: `../SPEC-ECOSYSTEM-GATE.md`. Trial: **64/64** (the 23 v1
assertions below unchanged, plus 41 new in T10–T17).

## What a token surface must know

- **Registration PDA byte 44 = ecosystem tag** (0 = none/open), **byte 34
  (`verified_via`) = 1 means ATTESTED** — the tag counts only when
  verified_via is 1. A nonzero byte 44 with verified_via 0 is not a state
  the program can write. Display code reading registrations directly
  (above) should apply this pair, not byte 44 alone.
- **Tags are written only by dual-signature instructions:**
  - Tag 5 RegisterAttested `[5][kind][eco]` — new registration born
    tagged. Accounts: [wallet (signer, w), attester (signer),
    registration PDA (w), ecosystem config (ro), system].
  - Tag 6 AttestExisting `[6][eco]` — tags an existing ACTIVE
    self-registration in place (history preserved). Accounts: [wallet
    (signer), attester (signer), registration PDA (w), ecosystem
    config (ro)]. Deactivated records fail `BadState` (3) — reactivate
    first.
  - Both fail `NotAttester` (6) when the signer of the attester account
    is not the key configured for that ecosystem (or the slot is unset),
    and `EcosystemNotConfigured` (9) before the config exists.
- **Plain Register (tag 0) cannot carry a tag** — extra data bytes are
  ignored; byte 44 is written 0 by construction. There is no self-tag
  path to defend against; it does not exist.
- **Ecosystem Config PDA**: seeds `["ecosystem"]`, 545 B — [0] tag=1,
  [1..33] authority, [33..] 16 attester slots of 32 B (slot i ↔ ecosystem
  i+1; zero = unset). Managed by: tag 3 InitEcosystemConfig (one-time,
  signer becomes authority), tag 4 SetAttester `[4][eco][pubkey]`
  (authority-only; zero clears), tag 7 TransferEcosystemAuthority
  `[7][pubkey]` (authority-only). New errors: 5 `BadEcosystem`
  (eco = 0 or > 16), 6 `NotAttester`, 7 `BadAuthority`, 8 `AlreadyInit`,
  9 `EcosystemNotConfigured`.
- **Engine SyncRegistered now mirrors byte 44 → Holder PDA byte 2** in
  the same snapshot as the `active` → byte 1 mirror; the pre-trade sync
  duty described above is unchanged (one sync carries both). Deactivation
  semantics likewise unchanged: registry-side immediacy, engine-side at
  next sync.

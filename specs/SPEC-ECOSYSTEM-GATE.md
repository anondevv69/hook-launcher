# SPEC — ECOSYSTEM GATE (engine rule 17) + Registry attestation (v2)

**Status:** BUILT + PROVEN in LiteSVM (2026-10-15). **Not deployed.** The
mainnet upgrade is packaged in §7 and waits for Gregory's separate go —
the same gate the launcher itself shipped through.
**Design anchor (Gregory):** *"FOMO-only is from the wallet that is
created"* — an ecosystem gate anchors on the wallet being **created
through that platform's flow**. The creation is the attestation (the same
species as musemaxxing's platform-provisioned agent wallets and its
artifact-link verification: the platform's onboarding ritual is what a
wallet carries, not a claim it makes about itself).

---

## 1. The idea in one paragraph

Rule 3 (Agent-Only) proved the shape: the chain cannot tell what software
drives a wallet, so the gate checks a **registry** — and registration is
whatever the ecosystem's enrollment flow says it is. The Ecosystem Gate
narrows that from "registered" to "**registered as created-through-platform-X**":
a token's config names one ecosystem (Muse, FOMO, Claude, Grok, …), and
only wallets whose Registry record carries that ecosystem's **attested**
tag may receive it. The tag can never be self-assigned: it is written only
when the ecosystem's **attester key co-signs** the registration, at (or
after) the wallet's creation through that platform's flow.

## 2. Ecosystem ids

| Id | Ecosystem | Attester operator (see §5) |
|---|---|---|
| 0 | None / Open — plain self-registration (what AGTR uses) | — (no attester; not attestable) |
| 1 | Muse | Us, via musemaxxing verification |
| 2 | FOMO | FOMO's enrollment flow operator (open question, §5) |
| 3 | Claude | Ditto |
| 4 | Grok | Ditto |
| 5–16 | Reserved — future ecosystems are a config entry, never a program change | — |

## 3. Registry changes (`registry/src/lib.rs`)

### 3.1 Registration PDA — layout UNCHANGED (48 B)

One previously-reserved byte gains meaning:

| Offset | Field | Change |
|---|---|---|
| 34 | verified_via | new value **1 = ATTESTED** (0 = self-signed, as before) |
| 44 | ecosystem | 0 = none/open; nonzero only ever written by tags 5/6 under an attester signature |

Every existing mainnet registration already reads ecosystem 0 / self-signed
— correct by construction. No migration, no rent change (48 B, still
1,224,960 lamports, paid by the registering wallet).

### 3.2 Ecosystem Config PDA — new account

Seeds `["ecosystem"]` under the Registry program, **545 B**:

| Offset | Field |
|---|---|
| 0 | tag u8 = 1 |
| 1..33 | authority pubkey |
| 33.. | attester map — 16 slots × 32 B; slot *i* = attester pubkey for ecosystem *i+1*; all-zero = unset/cleared |

Rent (545 + 128) × 6,960 = **4,684,080 lamports ≈ 0.0047 SOL**, paid once
by the initializing authority.

### 3.3 Instructions (existing tags 0–2 untouched)

| Tag | Name | Data | Accounts | Semantics |
|---|---|---|---|---|
| 3 | InitEcosystemConfig | `[3]` | [authority (signer, w), config PDA (w), system] | One-time; the signer becomes the attester-map authority. Fails `AlreadyInit` (8) if the PDA exists. |
| 4 | SetAttester | `[4][eco u8][attester 32]` | [authority (signer), config PDA (w)] | Authority-only (`BadAuthority` 7). eco must be 1..=16 (`BadEcosystem` 5). All-zero pubkey clears the entry. |
| 5 | RegisterAttested | `[5][kind u8][eco u8]` | [wallet (signer, w), attester (signer), registration PDA (w), eco config (ro), system] | The creation-flow registration. Wallet's key = possession; attester's key = provenance. Writes kind, verified_via = ATTESTED, byte 44 = eco, active = 1. Wrong/absent attester → `NotAttester` (6); existing record → `AlreadyRegistered` (1). |
| 6 | AttestExisting | `[6][eco u8]` | [wallet (signer), attester (signer), registration PDA (w), eco config (ro)] | Writes the tag onto an existing **active** self-registration in place (kind + registered_at preserved; verified_via → ATTESTED). Same dual-signature rule. Chosen over close + re-register, which would burn registration history and continuity. |
| 7 | TransferEcosystemAuthority | `[7][new authority 32]` | [authority (signer), config PDA (w)] | Hands the attester-map authority to another key (ops key, multisig). Touches nothing else. |

Attestation before InitEcosystemConfig fails `EcosystemNotConfigured` (9).

### 3.4 What did NOT change (deliberate)

- **No one can touch another wallet's record.** The authority manages the
  attester map only; it cannot create-free, deactivate, close — or tag —
  any wallet. Tags 5/6 require the wallet's own signature too: tagging is
  dual-consent by construction.
- **Plain Register (tag 0) has no ecosystem parameter and ignores extra
  data bytes.** Byte 44 is written 0 by construction — self-tagging is
  *impossible*, not merely rejected (registry trial T15 proves a smuggled
  ecosystem byte lands as tag-absent).
- **Attester rotation does not un-attest the past.** A tag names the
  ecosystem; rotation/clearing closes the path forward only (trial T16).

## 4. Engine changes (`engine/src/lib.rs`)

- **Rule 17 `RULE_ECOSYSTEM_GATE`** joins the catalog: known range is now
  1..=17; implemented set {1, 3, 7, 8, 9, 17}; `rule_needs_dst_holder`
  includes 17. Params: `[0]` = required ecosystem id. Config writes
  reject an enabled gate with required id 0 or > 16 (same fail-at-write
  discipline as rules 7/8).
- **Holder PDA byte 2** (previously reserved, always 0) is the ecosystem
  mirror. **`ENGINE_VERSION` stays 2 and no account layout changes** —
  every live config (AGTR's included) loads byte-identically on the new
  binary.
- **SyncRegistered mirrors both bytes** from the same Registration PDA
  snapshot: byte 1 := (active == 1), byte 2 := the registration's
  ecosystem byte. Path (b) re-validates the attestation invariant (a
  nonzero ecosystem byte on a record whose verified_via ≠ ATTESTED fails
  `BadRegistration`) — only the Registry can write those accounts and it
  never writes that combination, so seeing it means a corrupt account.
  Path (a) (config-authority sync) accepts an optional third data byte
  for the ecosystem mirror, defaulting to 0.
- **Execute (rule 17):** exempt destinations skip (as rules 3/8/9);
  destination holder lazily created if absent (same rent-vault path as
  rule 3). Verdicts: mirror registered = 0 → veto `NotRegistered` (1) —
  the remedy is the same register + sync as rule 3; registered = 1 but
  ecosystem ≠ required → veto **`WrongEcosystem` (24)**.
- **Mirror discipline is rule 3's, inherited whole:** deactivation takes
  effect at the next sync; activation is fail-closed until synced. The
  launcher keeper / trade surfaces' pre-trade sync duty (§ registry
  INTEGRATION.md) extends to ecosystem mirrors unchanged — the sync is
  the same instruction writing both bytes.

## 5. Attester management — who vouches, and the open question

- **The map is governed by the Ecosystem Config authority.** At the
  mainnet upgrade (§7) that is fren's wallet — the same key that holds
  the programs' upgrade authority — because InitEcosystemConfig takes the
  authority from the init signature, and the upgrade runbook is what
  binds them. The authority can later be transferred (tag 7) to a
  dedicated ops key or multisig without touching anything else.
- **Muse's attester we operate ourselves.** Enrollment = a wallet created
  through the musemaxxing flow (platform-provisioned agent wallet /
  artifact-link-verified registration); the enrollment service holds a
  dedicated **Muse attester keypair** (NOT the deploy wallet) and
  co-signs RegisterAttested / AttestExisting for wallets that complete
  that flow. Key custody: the enrollment service's signer, rotatable via
  tag 4 at any time.
- **FOMO / Claude / Grok attesters — the open question, stated plainly:**
  a tag is only worth what the attesting flow is worth. Those ecosystems'
  attester keys should be held by **whoever operates their enrollment
  skill/plugin** — the party whose creation flow the tag certifies. We
  can run an attester *under their flow* if they publish one we can
  execute honestly; what we must not do is self-issue "FOMO" tags from a
  flow FOMO never ran — that would make the tag a claim about ourselves,
  not about the wallet's origin. Until such a flow exists, those slots
  stay **unset**: the gate presets exist in the catalog, launches can
  select them, and nobody can receive such a token yet — fail closed,
  loudly, at launch time (launch.mjs warns) rather than silently open.
- Rotation: an ecosystem rotates its attester by having the authority
  write the new key (tag 4). Compromise playbook: clear the slot (zero
  pubkey) to close the path immediately, investigate, set the new key.

## 6. Proof (LiteSVM, real binaries — house method)

| Suite | Result | Notes |
|---|---|---|
| `registry/trial.mjs` | **64/64** | 23 v1 assertions unchanged + 41 new (T10–T17): config init/one-time, authority gating, attested register fields, wrong-attester & unset-ecosystem rejection, self-tag impossibility, AttestExisting in place, rotation + clearing, authority transfer |
| `engine/trial.mjs` | **64/64** | Full regression on the new binary — rules 1/3/7/8/9 and both sync paths behave identically (AGTR's surface) |
| `integration/ecosystem-gate.mjs` | **28/28** | Cross-program proof (E0–E10): attested Muse wallet receives the Muse-gated token; Muse-tagged vetoed by the FOMO gate (`WrongEcosystem`); FOMO-tagged vice versa; self-registered untagged vetoed `WrongEcosystem`; unregistered vetoed `NotRegistered` with atomic rollback (a veto leaves no side effects); deactivation + re-sync revokes, reactivation restores; config-write rejects required-ecosystem 0 and 17; path (a) authority mirror; AGTR-shape config (rules 3 + 9) spot-checked identical |

Trial binaries: the suites load `engine/target/deploy/engine.so` built
with `REGISTRY_ID` = the dev registry id, exactly as before (the deploy
build differs only in that const; the trial build is preserved at
`engine/target/engine-trial.so`, sha256
`5018fc0cc7641dc1ee62c5c8fd14ec18b8f167f5cdcdc907e91b8956f4f904a7`).

**Launcher surface** (`launcher/`: catalog `launch.mjs`, CLI `hook.mjs`,
`skill.md`, web composer, regenerated browser helpers): rule 17 + the
four presets (Muse-Only / FOMO-Only / Claude-Only / Grok-Only) wired
end-to-end — `validateSpec` warns that an ecosystem-gated token has no
eligible receivers until that ecosystem's attester is configured and its
enrollment runs. Checks: rule-17 spec-entry validation 17/17 (incl.
`{"id":17,"ecosystem":"fomo"}` → params[0] = 2 and `{"rule":"muse-only"}`
→ params[0] = 1), `launch.mjs --dry-run` both specs clean, web smoke
16/16, web rule-17 checks 5/5. Browser equivalence harness: 24/26 — all
instruction-identical checks pass; the two failures are the pre-existing
L5 launch *simulations* failing `InsufficientFundsForRent` against fren's
live mainnet balance (drawn down by the AGTR fleet buys after the stored
26/26 baseline was recorded) — mainnet state drift, unrelated to rule 17
(neither harness spec uses it; the L5 code path is untouched).

## 7. Mainnet upgrade package — WAITING ON GREGORY

Binaries (SBF v1, `cargo build-sbf --arch v1`):

| Program | Live id (unchanged) | Old size | New size | New sha256 |
|---|---|---|---|---|
| Registry | `GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e` | 83,872 B | **92,432 B** | `609d17896445d33255991bccb5fbcfa7fc7b2f7f1521b521e374d31e2242e898` |
| Engine | `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT` | 184,264 B | **186,392 B** | `a7da57db41989cb96ff1d445a69b5fde2f1edd63d2211713be39f1fac32f5e86` |

On-chain sequence (one session, in order):

1. **Upgrade Registry** (buffer → upgrade). Then **immediately**
   InitEcosystemConfig from fren's wallet — first-come semantics make
   this ordering a hard requirement, not a nicety.
2. **Upgrade Engine** (buffer → upgrade). No config/meta/holder
   migration: ENGINE_VERSION stays 2, all layouts unchanged, AGTR
   trades through the upgrade untouched.
3. **Generate the Muse attester keypair** (dedicated ops key),
   SetAttester(1, muse key). FOMO/Claude/Grok slots stay unset (§5).
4. Live proofs mirroring the mainnet deploy's: attested test wallet
   receives a Muse-gated token; untagged wallet vetoed; AGTR buy/sell
   sanity on the new engine.

**Cost** (rent at 6,960 lamports/byte, (size + 128) convention):

| Item | Lamports | SOL |
|---|---|---|
| Registry programdata growth (8,560 B) | 59,577,600 | 0.0596 |
| Engine programdata growth (2,128 B) | 14,810,880 | 0.0148 |
| Ecosystem Config PDA rent (545 B, one-time) | 4,684,080 | 0.0047 |
| Tx fees (~6 txs) | ~30,000 | ~0.00003 |
| **Permanent total** | | **≈ 0.0791** |
| Buffer float (sequential, fully refunded on close) | ≤ 1,298,201,600 at a time | ≤ 1.2982 |

Upgrade authorities are unchanged (fren's wallet, deliberately unburned —
this upgrade is the reason). Distributor: untouched. Nothing else moves.

## 8. The honest boundary

The gate proves exactly one claim: **this wallet was created through
platform X's flow, and platform X's attester vouched for that creation in
the Registry.** It does not prove what software operates the wallet
today, who holds its key, or what the wallet will do next — no on-chain
mechanism can prove those things about a plain keypair, and this design
does not pretend to. The tag's strength is exactly the strength of the
ecosystem's creation flow: musemaxxing's artifact-link verification is a
real ritual; a platform whose "creation flow" is an unauthenticated form
would mint tags worth that much and no more. That is why attester keys
belong to the flows they certify (§5), why a tag is written at creation
rather than claimed later, and why the catalog copy says "created and
attested through X" — never "run by X".

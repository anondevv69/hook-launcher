# Meteora venue verification — Solana Hook Launcher

**Date:** 2026-10-15 · **Scope:** the two build-blocking unknowns for launching
Token-2022 transfer-hook tokens on Meteora (Task A: DAMM v2 cp-amm hook
compatibility; Task B: token-badge necessity), plus the same hook question
for Meteora's Dynamic Bonding Curve (DBC).
**Constraints honored:** nothing deployed to mainnet, no mainnet SOL spent.
All execution ran in **LiteSVM** against the **real Meteora program
binaries**. Devnet was unreachable from this sandbox (documented below), so
the task-sanctioned fallback (LiteSVM + real binaries / source verdict) is
the proof level achieved — and for both tasks the LiteSVM runs produced
direct executable evidence, not just source reading.

## Verdict summary

| Question | Verdict | Proof level |
|---|---|---|
| DAMM v2 trades a live-hook (ExtraAccountMetas) mint? | **NO — impossible today, badge or not** | Executable (LiteSVM, real cp-amm binary) + source |
| Badge required to create a DAMM v2 pool for a hook mint? | **YES — hard on-chain gate, per-mint, issued only via Meteora's operator system** | Executable (error 6020 observed) + source |
| Badge = listing/UI only? | **NO — it gates pool creation itself** | Executable + source |
| DBC trades a live-hook mint? | **YES — purpose-built, hook executes and can veto atomically** | Executable (LiteSVM, real DBC binary, official SDK) |
| DBC partner-gated? | **NO — permissionless; the "partner" is whoever creates the config (fee_claimer is self-declared)** | Executable + source |
| Badge needed for a DBC launch (SOL quote)? | **NO** (DBC badges gate only exotic *quote* mints) | Source |

**Go / No-Go:** **NO-GO on DAMM v2 as the venue for live-hook tokens.**
**GO on DBC as the launch venue** — it is the only Meteora surface that can
execute a transfer hook at all, it is permissionless, and its graduation
model (hook authority revoked at curve completion, then migration to
DAMM v2) matches the launcher spec's "graduating tokens shed the hook"
design. Permanent-hook tokens cannot live on Meteora at all: hooks can
only run during the DBC curve phase.

## Identifiers and versions

- DAMM v2 (cp-amm) program: `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`
- Dynamic Bonding Curve program: `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`
- Test hook program (built for this proof, TH-shaped minimal veto/state
  hook): `5x8BNBB6rqKd6RdGkaJwqJNrHgxKD8gDAjKy9e6sMnxy`
- SDKs: `@meteora-ag/cp-amm-sdk@1.5.1`, `@meteora-ag/dynamic-bonding-curve-sdk@2.0.0`,
  `litesvm@0.8.0`, `@solana/web3.js@^1.98.0`, `@solana/spl-token@^0.4.9`
- Program binaries (from MeteoraAg/meteora-invent test artifacts):
  `bin/cp_amm.so` sha256 `271b1fd4e490ad73…`, `bin/dynamic_bonding_curve.so`
  sha256 `9706cee1961f8a71…` (first 16 hex chars)
- Source clones pinned: damm-v2 @ `5398b5c7c534de014091132da37c6478cce671a8`,
  dbc-program @ `f552f20aa3c1c7631427c3827aeea7c58b902813`
- Toolchain: Agave/Solana CLI 4.3.0; test hook built with
  `cargo build-sbf --arch v1` (see environment notes)

## Task A — DAMM v2 (cp-amm): NO

### Source verdict

cp-amm never forwards transfer-hook extra accounts, anywhere:

- The live swap path is the custom pinocchio entrypoint
  (`programs/cp-amm/src/entrypoint.rs`) → `p_handle_swap`
  (`instructions/swap/ix_p_swap.rs`). Its transfers
  (`utils/p_helper.rs`, `p_transfer_from_user` / `p_transfer_from_pool`)
  build a Token-2022 `TransferChecked` with exactly four accounts
  (from, mint, to, authority) — no extra-account tail. The Anchor twins in
  `utils/token.rs` pass an empty remaining-accounts slice as well, and
  add-liquidity uses the same helpers. The swap instructions'
  `remaining_accounts` are consumed only by an anti-multi-swap rate-limiter
  check that reads the instructions sysvar — they are never forwarded to
  the token program.
- The Anchor `swap`/`swap2` handlers exposed in `lib.rs` are stubs; all
  real flow goes through the pinocchio path above.
- SDK corroboration: `@meteora-ag/cp-amm-sdk` ships a
  `validateNoTransferHook` helper (`src/helpers/token2022.ts`) whose error
  text warns that a transfer hook may prevent permissionless pool creation.

Because Token-2022 requires the validation account (the hook's
ExtraAccountMetaList PDA) plus every resolved extra account to be present
in the transfer when a live hook is set, a cp-amm transfer of a live-hook
mint cannot execute at all.

### Executable evidence (LiteSVM, real cp-amm binary) — `proof/cpamm-proof.mjs`

Test hook: a Token-2022 mint whose hook program id is set in the
TransferHook extension, with its ExtraAccountMetaList initialized, so every
transfer needs one extra state PDA (a per-mint "gate" counter/lock PDA —
same shape class as the TH hook's per-holder PDA reads).

- **E1 — pool creation without a badge:** rejected on-chain with
  `AnchorError … Error Code: InvalidTokenBadge. Error Number: 6020`
  (0x1784), raised by `validate_mint` during `initialize_customizable_pool`.
- **E2 — badge issuance:** the real `create_token_badge` instruction was
  executed successfully. It is gated by an on-chain access control
  (`is_valid_operator_role(…, OperatorPermission::CreateTokenBadge)`): the
  signer must be the whitelisted address of an Operator account, and
  Operator accounts are created only by two hardcoded admin pubkeys in
  `instructions/admin/auth.rs`. (In LiteSVM the Operator account was
  injected with `setAccount` to stand in for the admin step; the badge
  instruction itself ran against the real binary and its real access
  control, and the resulting badge account verifiably stores the hook
  mint.) A badge also cannot be created for an already-supported mint
  (error 6019, `CannotCreateTokenBadgeOnSupportedMint`).
- **E3 — pool creation WITH the badge appended as remaining account:**
  mint validation passed, the program proceeded to the initial-liquidity
  deposit — and the Token-2022 `TransferChecked` failed with
  **"An account required by the instruction is missing"** after Token-2022
  invoked the hook program. cp-amm supplied none of the hook's required
  extra accounts, so the transfer — and therefore pool creation — cannot
  complete. **A badge makes a hook mint *eligible*; it does not make it
  *tradeable*. DAMM v2 cannot create or trade a pool for a live-hook mint.**
- **E4 — control:** the identical flow with a plain Token-2022 mint (no
  extensions) created the pool end-to-end, including the program's
  internal transfers over the same code path. One documented artifact:
  a subsequent control *swap* built by SDK 1.5.1 against the
  meteora-invent test binary fails with `TypeCastFailed` (6007) in both
  `swap` and `swap2` before any token movement — an SDK↔test-binary
  version-skew artifact. It does not affect the hook conclusions: the
  hook mint fails earlier, at pool creation, for hook-specific reasons,
  on the same binary where the plain mint's pool creation succeeds.

### Account-tail mechanics (DAMM v2)

Nobody resolves ExtraAccountMetas. The pool program's transfer CPIs carry
no tail; the official SDK builds no tail (its swap remaining accounts are
only the optional referral account and, for rate-limited pools, the
instructions sysvar used by the anti-multi-swap check). There is no
supported way for a third party to inject the missing accounts into a
cp-amm swap or liquidity operation.

## Task A — Dynamic Bonding Curve: YES, permissionless

### Source verdict

DBC has first-class, purpose-built transfer-hook support (added in DBC
program 0.2.0):

- Instructions: `create_config_with_transfer_hook`,
  `initialize_virtual_pool_with_token2022_transfer_hook`,
  `swap2_with_transfer_hook`, plus hook-aware fee claims
  (`claim_trading_fee2`, `claim_creator_trading_fee2`,
  partner `claimPartnerTradingFee2`). The plain `swap`/`swap2`
  instructions explicitly reject hook pools.
- The config for a hook launch is a fresh keypair account created by
  anyone; `fee_claimer` is an unchecked, self-declared account — the
  "partner" is whoever creates the config. No operator, no admin, no
  badge for a standard (SOL/wSOL) quote mint. DBC's own token badge only
  gates exotic **quote** mints (`validate_quote_mint_with_token_badge`);
  SPL-owned quote mints are always supported.
- Graduation: pool creation sets the mint's transfer-hook authority to
  the pool authority; at curve completion the hook program and authority
  are **revoked**, so the graduated mint is a clean Token-2022 mint.
  Migration to DAMM v2 goes through Meteora's migration configs, which
  carry the `CreatePoolWithoutMintValidation` flag — and post-revocation
  the mint is permissionlessly supported on DAMM v2 anyway. This is
  exactly the Hooked model the spec references.
- Independent existence proof: a public third-party project
  (MidTermDev/max-holding-hook) launched a 1%-max-wallet hook token on
  DBC using the same config → pool → meta-list → `swap2WithTransferHook`
  flow, noting the meta list must be initialized *after* pool creation
  and the first buy must not be bundled into pool creation.

### Account-tail mechanics (DBC)

The **swap builder** (SDK `DynamicBondingCurveClient.pool.swap2WithTransferHook`,
or any integrator) resolves the hook's ExtraAccountMetaList PDA
(`["extra-account-metas", mint]` under the hook program) into concrete
accounts and appends them to the swap instruction as remaining accounts,
grouped per transfer leg with `TransferHookAccountsInfo`/`AccountsType`
markers. The **DBC program** slices those remaining accounts per leg
(`parse_transfer_hook_accounts`) and forwards each slice into its
Token-2022 transfer CPIs. Token-2022 then assembles the Execute call as
`[source, mint, destination, authority, validation (meta-list PDA),
...resolved extras]` — validation first, extras after (verified
empirically in the proof below; my first hook build assumed the opposite
order and failed with its own BadGate error until corrected).

### Executable evidence (LiteSVM, real DBC binary, official SDK 2.0.0) — `proof/dbc-proof.mjs`

Full flow executed against `dynamic_bonding_curve.so` with the same test
hook as the DAMM experiments:

1. `createConfigWithTransferHook` — created by a fresh keypair acting as
   its own partner/fee-claimer, naming our hook program. **Success.**
2. `createPoolWithTransferHook` — DBC created the pool and minted the
   base token; the mint verifiably carries our hook program in its
   TransferHook extension. **Success.**
3. Hook's `InitializeExtraAccountMetas` + gate PDA initialized for the
   mint (gate: tag=1, count=0, locked=0).
4. **Buy** via `swap2WithTransferHook` (0.05 SOL in): **success** — buyer
   received 3,758,140,828,991 base units (6 dp) and the hook's gate
   counter went **0 → 1**: the hook executed with its PDA tail inside a
   real Meteora swap.
5. **Veto:** with the gate locked by its authority, the identical swap
   **failed**, with the hook's own veto error (custom 1) propagated
   through Token-2022 and DBC; buyer balance and gate count were
   **unchanged** — the veto is atomic.
6. **Unlock → buy again:** success; gate count 2; buyer balance
   7,489,892,840,329 base units. The earlier failures were the hook's
   decisions, not a broken pool.

Note the symmetric detail: the plain DBC `swap`/`swap2` reject hook
pools, so integrators (aggregators) must use the hook-aware instruction —
routability for DBC hook tokens means integrators calling
`swap2_with_transfer_hook` (the official SDK exposes it; Meteora's own
frontend uses this path for hook launches).

## Task B — Badge necessity (DAMM v2)

**(a) Pool creation for a hook mint: REQUIRED.** In
`programs/cp-amm/src/utils/token.rs`, `is_permissionless_supported_mint`
allows only the TransferFeeConfig, MetadataPointer, and TokenMetadata
extensions permissionlessly (a TransferHook counts only if both its
program id and authority are unset — i.e., no live hook). For any other
mint, `validate_mint` requires the TokenBadge PDA
(seeds `["token_badge", mint]`) among the pool-init remaining accounts,
else `PoolError::InvalidTokenBadge` (6020). All three pool-init paths
call it (`initialize_pool`, `initialize_customizable_pool`,
`initialize_pool_with_dynamic_config`). The only bypass is a pool Config
carrying `CreatePoolWithoutMintValidation` — and configs are created by
Meteora operators (the config-level equivalent of a badge). Meteora's
own documentation describes the same arrangement in prose: mints outside
the permissionless allowlist need Meteora to review the token and
initialize a token badge before DAMM v2 validation passes. Proven
executably in E1/E2 above.

**(b) Third-party routability: moot for hook mints.** Since no DAMM v2
pool for a live-hook mint can be created at all (E3), there is nothing
to route. For non-hook mints, pool creation is permissionless and pools
are ordinary cp-amm accounts any router can read.

**(c) UI visibility only: NO.** The badge is an on-chain pool-init gate,
not a listing flag. Practical consequence for the launcher: every new
hook token would need its own badge, issued through Meteora's operator
system (two hardcoded admins create operators; operators with the
CreateTokenBadge permission create badges) — a per-token partner
dependency with no permissionless path, *and it still wouldn't make the
token tradeable on DAMM v2* because of the Task A transfer failure.

Hooked's arrangement is consistent with this picture rather than evidence
against it: Hooked launches on the DBC curve (permissionless hook
support), and graduation to DAMM v2 works because the hook is revoked at
migration — no badge or hook-trading support on DAMM v2 is ever needed.

## Environment failures (documented, not silently worked around)

- **`solana-test-validator` cannot run in this sandbox:** it panics with
  an io_uring "Operation not permitted" assertion on startup (same wall
  the TaxHarvest build hit). → Used LiteSVM with the real program
  binaries, as the task allowed.
- **Devnet RPC unreachable from the sandbox:** `POST getHealth` to
  `https://api.devnet.solana.com` returns nothing (curl: HTTP 000 after a
  10 s timeout; a Node JSON-RPC attempt stalled > 45 s). Mainnet
  `getHealth` answered "ok" in 0.78 s through the same egress, so this is
  a devnet-specific reachability failure. No devnet transactions were
  run; there are no devnet signatures to report. (Mainnet was used only
  for that read-only health probe — nothing deployed, nothing spent.)
- **SBF version mismatch:** the locally built test hook initially came
  out as SBF v3, which LiteSVM 0.8 cannot load ("invalid account data
  for instruction"); Meteora's binaries are older SBF. Rebuilt the same
  source with `cargo build-sbf --arch v1`.
- **SDK↔test-binary swap skew (control only):** documented under E4
  above; hook conclusions unaffected.

## Recommendation for the launcher build

1. **Launch venue = Meteora DBC** with `create_config_with_transfer_hook`
   / `create_pool_with_transfer_hook` / `swap2_with_transfer_hook`;
   the launcher operates its own configs as partner (fee_claimer =
   launcher), fully permissionless — no Meteora application needed for
   SOL-quoted launches.
2. **Design rule:** hook rules live only during the curve phase. At
   graduation DBC revokes the hook and the token migrates to DAMM v2 as
   a clean mint. Any catalog module that must be *permanent* cannot be
   venue'd on Meteora and stays house-venue-only (per the revised plan,
   the house venue is already the dev harness for those).
3. **Do not spend effort on the DAMM v2 badge relationship for hook
   tokens** — a badge cannot make them tradeable. (A badge relationship
   would only matter for non-hook exotic-extension mints.)
4. Integrator note: document for aggregators/frontends that DBC hook
   pools require the hook-aware swap instruction and generic
   ExtraAccountMetaList resolution by the swap builder.

## Artifacts (all under `~/workspace/taxhook/hook-launcher-build/`)

- `METEORA-PROOF.md` — this report
- `proof/dbc-proof.mjs` — DBC executable proof (passes; output in
  `proof/dbc-proof-output.txt`)
- `proof/cpamm-proof.mjs` — DAMM v2 experiments E1–E4 (output in
  `proof/cpamm-proof-output.txt`)
- `proof/svm-harness.mjs` — LiteSVM↔web3.js Connection adapter used by
  both proofs (prototype-patched RPC surface incl.
  `getAccountInfoAndContext`, which Anchor's account fetcher requires)
- `proof/cpamm-debug.mjs`, `proof/dbc-debug.mjs` — debug harnesses from
  the investigation (fee-blob dump, hook account-order trace)
- `proof/cp_amm.idl.json` — cp-amm IDL used for the badge instruction
- `test-hook/` — the minimal veto/state test hook (Rust, SBF v1 build in
  `test-hook/target/deploy/testhook.so`); note the in-source comment on
  the Token-2022 Execute account order (validation account first)
- `bin/cp_amm.so`, `bin/dynamic_bonding_curve.so` — the real Meteora
  binaries used
- `research/` — pinned source clones (damm-v2, damm-v2-sdk,
  dynamic-bonding-curve-sdk, dbc-program, meteora docs)

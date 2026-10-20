// Hook Launcher ENGINE — Solana Token-2022 transfer-hook rule engine (native, no Anchor).
//
// Generalizes the TaxHarvest hook program (~/workspace/taxhook/program/) into
// the config-driven engine of SPEC-HOOK-LAUNCHER.md SS2: ONE program, and every
// token's behavior lives in a per-mint Config PDA (rules as data). On every
// TransferChecked, Token-2022 calls Execute; the engine loads the config,
// runs the enabled rule modules IN CONFIG ORDER, and any module's veto fails
// the whole transaction atomically.
//
// Account order for Execute is the empirically proven Token-2022 layout
// (METEORA-PROOF.md): [source, mint, destination, authority, VALIDATION
// (meta-list PDA), ...resolved extras in meta-list order]. The meta list is
// TEMPLATED PER CONFIG (Phase 2, per-config meta-list templating): it
// publishes exactly the extras the config's enabled rules require, in the
// canonical order, as a subsequence of the legacy 7-extra superset — see
// the classification table at `required_extras`. Configs whose rules need
// holder state (AGTR/Latch shapes) still publish the full legacy 7,
// byte-identical. Execute accepts ANY subsequence (including the full
// superset, from clients that append it manually) via key-matching, and
// fails closed with MissingExtra when a required extra was not supplied —
// that is what makes an UpdateConfig that expands the required set safe
// (never silently under-enforced) until RefreshExtraAccountMetas (tag 9)
// rewrites the list.
//
// Own instructions are tagged by data[0]:
//   0 = InitializeExtraAccountMetas (also reached via the SPL INIT_METAS disc)
//   1 = InitializeConfig
//   2 = UpdateConfig          (authority-gated per config.authority_mode)
//   3 = InitializeHolder      (explicit Holder PDA creation; v3: the PDA is
//                              keyed by the TOKEN ACCOUNT, see the derivation
//                              note at `holder_pda`)
//   4 = SyncRegistered        (Registry integration, registry/INTEGRATION.md:
//                              mirrors a Registration PDA's `active` byte into
//                              the Holder PDA `registered` flag; authorized by
//                              config-authority signature OR by a validated
//                              Registration PDA — permissionless sync. v3: the
//                              mirror lands in the record keyed by the owner's
//                              canonical ATA for the mint, derived in-program)
//   5 = CrankPrice            (permissionless PriceFeed EMA update from the
//                              feed's pinned pool vault balances — TH crank;
//                              constant-product venues)
//   6 = InitializePriceFeed   (creates the per-mint PriceFeed PDA)
//   7 = SyncGateBalance       (Holder-Gated support: mirrors the owner's
//                              gate-token balance into their Holder PDA,
//                              valid only for the transfer that immediately
//                              follows it in the same transaction. v3: the
//                              mirror lands in the record keyed by the
//                              DESTINATION token account of that transfer)
//   8 = CrankPriceDbc         (permissionless PriceFeed EMA update from a
//                              Meteora DBC pool's state — the curve spot is
//                              the pool's sqrt_price; same feed, same EMA
//                              fold as tag 5)
//   9 = RefreshExtraAccountMetas (rewrite the meta list from the CURRENT
//                              config's required set — the desync repair
//                              after an UpdateConfig that expanded it;
//                              see refresh_extra_account_metas)
//  14 = ActivateHouse         (Phase C: the house-venue commitment flip —
//                              permissionless; see activate_house)
//  15 = CrankPriceDeep        (Phase C: deeper-venue-wins price crank over
//                              the DBC curve pool vs the activated house pool)
//  16 = DepositHouseFees      (Phase C: one-shot fee seed into the HouseVault)
//  17 = RecordHouseReserve    (Phase C: record the committed house reserve
//                              after the launcher's plain SOL transfer lands)
//  10 = MigrateHolder         (v3 retrofit: verbatim-copy a legacy
//                              owner-keyed Holder PDA to its account-keyed
//                              address, then close the legacy account and
//                              refund its rent to the rent vault.
//                              Permissionless; see migrate_holder)
//  11 = SyncHolder             (v3: merge one token account's Holder record
//                              into another token account's record for the
//                              SAME owner — repairs the fragmentation that
//                              account-keying introduces across an owner's
//                              multiple token accounts; see sync_holder)
// Execute arrives with the SPL interface discriminator, handled first.
//
// ENGINE v3 (AccountKey derivation, SPEC-ENGINE-V3 SS9-SS10): the Holder
// PDA seed's third component is the TOKEN ACCOUNT KEY everywhere — the
// meta list publishes AccountKey seeds for both holder entries, so the
// standard generic resolver derives a first-time buyer's holder PDA from
// the destination ATA address (a pure function of owner + token program
// + mint) WITHOUT reading any account's contents. v2's AccountData seeds
// made that resolver throw TokenTransferHookAccountDataNotFound for every
// fresh wallet. Holder identity is therefore the token account, not the
// owner (the full semantic accounting is SPEC-ENGINE-V3 SS9.2). The
// CONFIG layout is untouched, so ENGINE_VERSION stays 2 — that byte
// versions the config, and v2 configs (AGTR, Latch) must keep loading
// under this build for the retrofit path (tag 10 + tag 9) to reach them.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
    sysvar::Sysvar,
};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;
use std::str::FromStr;

// SPL transfer-hook interface discriminators (sha256("spl-transfer-hook-interface:<name>")[..8])
const EXECUTE_DISC: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];
const INIT_METAS_DISC: [u8; 8] = [43, 34, 13, 49, 167, 88, 235, 235];

const TOKEN_2022_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM_ID: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/// Registry program (registry/INTEGRATION.md) — Agent-Only's source of truth.
const REGISTRY_ID: &str = "GftZenfbCBwiTKqui3D67mkgofB5wkgAyzRxBEPiwL2e";
/// Distributor program — holder-fee payouts (distribute / claim / settle)
/// execute with the Distributor as the top-level instruction, so Execute's
/// caller validation carries a dedicated branch for it (see execute()).
/// Like REGISTRY_ID this is a compile-time const with two flavors: the
/// deploy build embeds the mainnet id; the trial build embeds the trial
/// suites' dev id (distributor/distributor-keypair.json).
const DISTRIBUTOR_ID: &str = "DpRjnQiywdJTUSWBvsJ1vj2mdvvCEDFzAStZJtL1tCQa";
/// Meteora Dynamic Bonding Curve program — the DBC crank (tag 8) reads its
/// pool accounts; the id also belongs in launch configs' venue allowlist.
const DBC_ID: &str = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
// DBC PoolState account layout (zero_copy; account data = 8-byte Anchor
// discriminator + 416-byte PoolState; pinned source:
// research/dbc-program/.../state/virtual_pool.rs, offsets verified
// empirically against the loaded binary in the integration harness):
//   volatility_tracker 64B @8, config @72, creator @104, base_mint @136,
//   base_vault @168, quote_vault @200, base_reserve @232, quote_reserve @240,
//   protocol/partner fee u64s @248..280, sqrt_price u128 @280.
const DBC_POOL_SPACE: usize = 424;
const DBC_POOL_OFF_BASE_MINT: usize = 136;
const DBC_POOL_OFF_SQRT_PRICE: usize = 280;
/// Meta tail v2 (ENGINE_VERSION 2): the v1 fixed superset tail plus the
/// PriceFeed PDA at extra index 4. Versioned via the config's version byte —
/// a v1 config is rejected by this build, never silently misread.
pub const ENGINE_VERSION: u8 = 2;

/// Price fixed point (TH): quote smallest-units per WHOLE token, x 1e12.
pub const PRICE_SCALE: u128 = 1_000_000_000_000;

// ---------- rule registry (spec SS5; the list never closes) ----------
pub const RULE_BASIS_LATCH: u16 = 1;
pub const RULE_ESCROW_SPLIT: u16 = 2;
pub const RULE_AGENT_ONLY: u16 = 3;
pub const RULE_APP_GATED: u16 = 4;
pub const RULE_CROWN_BENEFICIARY: u16 = 5;
pub const RULE_TITHE_SEAT: u16 = 6;
pub const RULE_P2P_TOGGLE: u16 = 7;
pub const RULE_HOLDER_GATED: u16 = 8;
pub const RULE_MAX_WALLET: u16 = 9;
pub const RULE_ALLOW_BLOCK_LIST: u16 = 10;
pub const RULE_GRUDGE: u16 = 11;
pub const RULE_TRADING_HOURS: u16 = 12;
pub const RULE_VESTING_CLOCK: u16 = 13;
pub const RULE_DECAY_TAX: u16 = 14;
pub const RULE_KING_OF_POOL: u16 = 15;
pub const RULE_BUYBACK_BURN: u16 = 16;
pub const RULE_ECOSYSTEM_GATE: u16 = 17;

/// Ecosystem id space (registry/SPEC-ECOSYSTEM-GATE.md): 0 = none/open,
/// 1 = Muse, 2 = FOMO, 3 = Claude, 4 = Grok; ids to MAX_ECOSYSTEM are
/// valid gate requirements (the Registry attester map has one slot each).
pub const MAX_ECOSYSTEM: u8 = 16;

/// Is this rule_id known to the registry AT ALL (spec: a config referencing
/// an unknown rule_id fails closed at config-init/update, never at transfer)?
fn rule_known(rule_id: u16) -> bool {
    (RULE_BASIS_LATCH..=RULE_ECOSYSTEM_GATE).contains(&rule_id)
}

/// Does this engine build carry a live Execute handler for the rule?
/// Known-but-unimplemented rules are REJECTED at config-init (this build
/// cannot enforce them; silently accepting them would be worse than failing).
fn rule_implemented(rule_id: u16) -> bool {
    matches!(
        rule_id,
        RULE_BASIS_LATCH
            | RULE_ESCROW_SPLIT
            | RULE_AGENT_ONLY
            | RULE_APP_GATED
            | RULE_CROWN_BENEFICIARY
            | RULE_TITHE_SEAT
            | RULE_P2P_TOGGLE
            | RULE_HOLDER_GATED
            | RULE_MAX_WALLET
            | RULE_ALLOW_BLOCK_LIST
            | RULE_GRUDGE
            | RULE_TRADING_HOURS
            | RULE_VESTING_CLOCK
            | RULE_DECAY_TAX
            | RULE_KING_OF_POOL
            | RULE_BUYBACK_BURN
            | RULE_ECOSYSTEM_GATE
    )
}

/// Does the module need destination-holder state during Execute?
fn rule_needs_dst_holder(rule_id: u16) -> bool {
    matches!(rule_id, RULE_AGENT_ONLY | RULE_ECOSYSTEM_GATE)
}

// ---------- per-config meta-list templating (Phase 2) ----------
// The meta list publishes extras in this CANONICAL order (the legacy tail
// v2 order); a templated list is always a subsequence of it, so relative
// order never changes and Execute's key-matcher can rely on it.
//
//   idx extra                seeds / value
//   0   config PDA           ["config", mint]
//   1   source Holder PDA    ["holder", mint, SOURCE token acct key]   (v3)
//   2   dest Holder PDA      ["holder", mint, DEST token acct key]     (v3)
//   3   rent vault PDA       ["rentvault", mint]
//   4   price feed PDA       ["price", mint]
//   5   system program       literal
//   6   instructions sysvar  literal
//
// v3 DERIVATION NOTE: in v2 the idx 1/2 entries carried AccountData seeds
// over the source/destination token accounts (reading the owner field at
// offset 32). A route builder resolving a FIRST buy — destination ATA not
// yet created — cannot read a nonexistent account, so the standard
// resolver (spl-token's addExtraAccountMetasForExecute, the function the
// DBC SDK and generic routers call) threw
// TokenTransferHookAccountDataNotFound and every holder-state token was
// unroutable for fresh wallets. v3 seeds both entries with the token
// account's KEY (AccountKey): for ATA destinations the address is a pure
// function of (owner, token program, mint), computable before the
// account exists, so generic first buys resolve for EVERY config. The
// semantic consequence — holder identity is the token account, not the
// owner — is priced in SPEC-ENGINE-V3 SS9.2 (fragmentation across an
// owner's accounts; SyncHolder, tag 11, is the merge repair).
//
// CLASSIFICATION — which enabled rules require each extra at Execute.
// Derived from the module bodies (function names cited per row); only
// ENABLED rules count. This table is the single source of truth shared by
// InitializeExtraAccountMetas, RefreshExtraAccountMetas, UpdateConfig's
// desync warning, and Execute's required-set gate (all via
// `required_extras` below):
//
//   0 config PDA — UNCONDITIONAL. execute() always load_config()s it
//      before any module runs.
//   6 instructions sysvar — UNCONDITIONAL. execute() always validates the
//      caller by introspecting it (Token-2022 / venue / distributor
//      branches), and module_holder_gated additionally scans it.
//   1 src Holder PDA — rules {1}. module_basis_latch reads the SENDER's
//      holder state in its gate (holder_basis / holder_latched, and the
//      graduated region in GRADUATED mode). No other module reads the
//      source holder: rules 3/17/8 read the DESTINATION holder only,
//      rule 9 reads only the destination token account + config,
//      rule 7 reads only ctx.venue_context.
//   2 dst Holder PDA — rules {1, 3, 8, 17}. module_basis_latch blends the
//      recipient's basis into it (bookkeeping); module_agent_only reads
//      its registered byte (holder_registered); module_ecosystem_gate
//      reads its registered + ecosystem bytes; module_holder_gated reads
//      its custom-region gate balance (dst holder — GATE_BAL_OFF bytes of
//      the DESTINATION owner's Holder PDA, mirrored by SyncGateBalance).
//   3 rent vault PDA — rules {1, 3, 17}. Needed only when Execute can
//      PAY for holder state: the lazy-creation / migration sites are
//      ensure_dst_holder (called by module_agent_only,
//      module_ecosystem_gate, and module_basis_latch bookkeeping) and
//      ensure_graduated (module_basis_latch, GRADUATED mode, for src and
//      dst migration top-ups). Rule 8 never creates in Execute (a missing
//      holder fails NotGateHolder; SyncGateBalance creates it outside
//      Execute), so rule 8 does NOT pull in the vault.
//   4 price feed PDA — rules {1}. module_basis_latch load_feed()s it on
//      every gated/bookkept path. No other module reads it.
//   5 system program — rules {1, 3, 17}. Consumed by exactly the same
//      creation/migration sites as the rent vault (ensure_dst_holder's
//      allocate/assign CPIs; ensure_graduated rides along for call-site
//      symmetry). No creation-capable rule in the stack => no system
//      program in the list.
//
// Consequence: a config whose enabled rules need NO holder state at all
// (e.g. Max Wallet only, P2P only, or no rules) publishes a list with NO
// holder entries at all. Under v2's AccountData holder seeds, publishing
// idx 1/2 was exactly what broke generic resolution for fresh wallets;
// under v3's AccountKey seeds the holder entries resolve generically
// too, and templating's remaining value is a smaller list (fewer
// accounts per transfer, no unneeded writable locks) and fail-closed
// desync behavior on config expansion — the classification above is
// unchanged either way.
//   5 system program — rules {1, 3, 17}. Consumed by exactly the same
//      creation/migration sites as the rent vault (ensure_dst_holder's
//      allocate/assign CPIs; ensure_graduated rides along for call-site
//      symmetry). No creation-capable rule in the stack => no system
//      program in the list.
//
// v4 ADDITIONS (Engine v4, 2026-10-19 — the canonical list grows to 10;
// existing indices 0..6 and their seed shapes are BYTE-UNCHANGED, so a
// config whose rules need only the legacy extras publishes exactly the
// legacy list and refreshes identically — the v4 rehearsal gate):
//
//   1 src Holder PDA — rules {1, 11, 13} (v4 adds 11, 13).
//      module_grudge updates the SENDER's window/mark state on venue
//      sells; module_vesting_clock reads the sender's anchor and may
//      grow the record (v4 region) on the gate path.
//   2 dst Holder PDA — rules {1, 3, 8, 11, 13, 17} (v4 adds 11, 13).
//      module_grudge reads the recipient's mark on venue receives;
//      module_vesting_clock blends the recipient's anchor (bookkeeping).
//   3 rent vault PDA — rules {1, 3, 11, 13, 15, 17} (v4 adds 11, 13, 15).
//      Grudge/vesting lazy holder creation + vesting growth; rule 15's
//      lazy King PDA creation (ensure_king) is vault-funded the same way.
//   5 system program — rules {1, 3, 11, 13, 15, 17} (same sites as 3).
//   7 king PDA — rules {15}. module_king_of_pool reads/writes the
//      per-mint largest-holder record on every transfer. The entry is a
//      plain PDA seed set (["king", mint]) — computable from the mint
//      alone, so generic resolvers resolve it for a first buy exactly
//      like the holder entries under AccountKey seeds.
//   8 lists PDA — rule {10} with the blocklist leg on (params mode != 1).
//      module_allow_blocklist reads the sealed blocklist (written once
//      by SetBlocklist, tag 12). Seeds ["lists", mint], read-only.
//   9 allow PDA — rule {10} with the allowlist leg on (params mode != 0).
//      Per-DESTINATION-account record (["allow", mint, dest token acct
//      key] — AccountKey seeds, the v3 derivation discipline: an
//      owner-keyed AccountData seed would break first receives into
//      not-yet-created ATAs). Written by SetAllowlistEntry (tag 13),
//      read-only in Execute.
//   Rule 12 (Trading Hours) needs NO extra (Clock only). Rule 4
//   (App-Gated) needs NO extra (it reads ctx.caller_program, captured
//   from the same sysvar introspection that yields venue_context).
//
// The mask widened u8 -> u16 with the growth (10 bits); EXTRA_BIT values
// for indices 0..6 are unchanged.
pub const EXTRA_CONFIG: u8 = 0;
pub const EXTRA_SRC_HOLDER: u8 = 1;
pub const EXTRA_DST_HOLDER: u8 = 2;
pub const EXTRA_RENT_VAULT: u8 = 3;
pub const EXTRA_PRICE_FEED: u8 = 4;
pub const EXTRA_SYSTEM: u8 = 5;
pub const EXTRA_SYSVAR: u8 = 6;
pub const EXTRA_KING: u8 = 7;
pub const EXTRA_LISTS: u8 = 8;
pub const EXTRA_ALLOW: u8 = 9;
pub const EXTRA_BIT: [u16; 10] = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

/// The required-extra bitmask for a rule set (bit i = EXTRA_BIT[i] set
/// iff canonical extra i must be published / supplied). See the
/// classification table above for the per-extra derivation.
fn required_extras(rules: &[RuleEntry]) -> u16 {
    let mut mask = EXTRA_BIT[EXTRA_CONFIG as usize] | EXTRA_BIT[EXTRA_SYSVAR as usize];
    let on = |id: u16| rules.iter().any(|r| r.enabled && r.rule_id == id);
    if on(RULE_BASIS_LATCH) {
        // gate reads src holder + feed; bookkeeping writes dst holder and
        // may create it / migrate either holder (vault + system).
        mask |= EXTRA_BIT[EXTRA_SRC_HOLDER as usize]
            | EXTRA_BIT[EXTRA_DST_HOLDER as usize]
            | EXTRA_BIT[EXTRA_RENT_VAULT as usize]
            | EXTRA_BIT[EXTRA_PRICE_FEED as usize]
            | EXTRA_BIT[EXTRA_SYSTEM as usize];
    }
    if on(RULE_AGENT_ONLY) || on(RULE_ECOSYSTEM_GATE) {
        // dst holder mirror read + lazy dst creation (vault + system).
        mask |= EXTRA_BIT[EXTRA_DST_HOLDER as usize]
            | EXTRA_BIT[EXTRA_RENT_VAULT as usize]
            | EXTRA_BIT[EXTRA_SYSTEM as usize];
    }
    if on(RULE_HOLDER_GATED) {
        // dst holder gate-balance read only; no Execute-side creation.
        mask |= EXTRA_BIT[EXTRA_DST_HOLDER as usize];
    }
    if on(RULE_VESTING_CLOCK) {
        // gate reads/grows the src holder's v4 region; bookkeeping
        // creates/grows + writes the dst holder's anchor (vault + system).
        mask |= EXTRA_BIT[EXTRA_SRC_HOLDER as usize]
            | EXTRA_BIT[EXTRA_DST_HOLDER as usize]
            | EXTRA_BIT[EXTRA_RENT_VAULT as usize]
            | EXTRA_BIT[EXTRA_SYSTEM as usize];
    }
    if on(RULE_GRUDGE) {
        // sell leg writes the src holder's window/mark state (lazy src
        // creation: vault + system); receive leg reads the dst mark.
        mask |= EXTRA_BIT[EXTRA_SRC_HOLDER as usize]
            | EXTRA_BIT[EXTRA_DST_HOLDER as usize]
            | EXTRA_BIT[EXTRA_RENT_VAULT as usize]
            | EXTRA_BIT[EXTRA_SYSTEM as usize];
    }
    if on(RULE_KING_OF_POOL) {
        // per-transfer tracking write to the King PDA; lazy creation of
        // that PDA is vault-funded (vault + system).
        mask |= EXTRA_BIT[EXTRA_KING as usize]
            | EXTRA_BIT[EXTRA_RENT_VAULT as usize]
            | EXTRA_BIT[EXTRA_SYSTEM as usize];
    }
    if let Some(r) = rules.iter().find(|r| r.enabled && r.rule_id == RULE_ALLOW_BLOCK_LIST) {
        // params[0] mode: 0 = blocklist only, 1 = allowlist only, 2 = both.
        if r.params[0] != 1 {
            mask |= EXTRA_BIT[EXTRA_LISTS as usize];
        }
        if r.params[0] != 0 {
            mask |= EXTRA_BIT[EXTRA_ALLOW as usize];
        }
    }
    mask
}

/// Build the ExtraAccountMeta entries for a required-set mask, in
/// canonical order. Entry shapes for indices 0..6 are byte-identical to
/// the legacy fixed superset's entries (same seeds, same signer/writable
/// flags), so a config requiring all 7 legacy extras publishes exactly
/// the legacy list; indices 7..9 (v4) append after them.
fn build_metas(mask: u16) -> Result<Vec<ExtraAccountMeta>, ProgramError> {
    let has = |idx: u8| mask & EXTRA_BIT[idx as usize] != 0;
    let mut metas = Vec::with_capacity(10);
    if has(EXTRA_CONFIG) {
        metas.push(ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal { bytes: b"config".to_vec() }, Seed::AccountKey { index: 1 }],
            false,
            false,
        )?);
    }
    if has(EXTRA_SRC_HOLDER) {
        metas.push(ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: b"holder".to_vec() },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 0 },
            ],
            false,
            true,
        )?);
    }
    if has(EXTRA_DST_HOLDER) {
        metas.push(ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: b"holder".to_vec() },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 2 },
            ],
            false,
            true,
        )?);
    }
    if has(EXTRA_RENT_VAULT) {
        metas.push(ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal { bytes: b"rentvault".to_vec() }, Seed::AccountKey { index: 1 }],
            false,
            true,
        )?);
    }
    if has(EXTRA_PRICE_FEED) {
        metas.push(ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal { bytes: b"price".to_vec() }, Seed::AccountKey { index: 1 }],
            false,
            false,
        )?);
    }
    if has(EXTRA_SYSTEM) {
        metas.push(ExtraAccountMeta::new_with_pubkey(&solana_program::system_program::id(), false, false)?);
    }
    if has(EXTRA_SYSVAR) {
        metas.push(ExtraAccountMeta::new_with_pubkey(&solana_program::sysvar::instructions::ID, false, false)?);
    }
    if has(EXTRA_KING) {
        metas.push(ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal { bytes: b"king".to_vec() }, Seed::AccountKey { index: 1 }],
            false,
            true,
        )?);
    }
    if has(EXTRA_LISTS) {
        metas.push(ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal { bytes: b"lists".to_vec() }, Seed::AccountKey { index: 1 }],
            false,
            false,
        )?);
    }
    if has(EXTRA_ALLOW) {
        metas.push(ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: b"allow".to_vec() },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 2 },
            ],
            false,
            false,
        )?);
    }
    Ok(metas)
}

// ---------- authority modes (spec SS2.2) ----------
pub const MODE_LOCKED: u8 = 0;
pub const MODE_CREATOR: u8 = 1;
pub const MODE_AGENT: u8 = 2;
pub const MODE_HOLDER_VOTE: u8 = 3;

// ---------- sizes / caps ----------
pub const MAX_RULES: usize = 8;
pub const MAX_VENUES: usize = 4;
pub const MAX_EXEMPTIONS: usize = 8;
pub const PARAMS_LEN: usize = 64;
/// Config PDA: fixed layout documented at `struct Config` below.
pub const CONFIG_SPACE: usize = 1088;
/// Phase C house region (length-versioned, the Holder pattern applied to
/// Config): 1152-byte configs carry, past the legacy 1088 bytes, the house
/// commitment region documented at `struct HouseSlot`. 1088-byte configs
/// load and behave byte-identically (house = None).
pub const CONFIG_SPACE_V2: usize = 1152;
pub const HOUSE_PROG_OFF: usize = 1088; // house_program pubkey [1088..1120]
pub const HOUSE_THRESHOLD_OFF: usize = 1120; // house_threshold_lamports u64
pub const HOUSE_RESERVE_OFF: usize = 1128; // house_reserve_lamports u64
pub const HOUSE_TS_OFF: usize = 1136; // house_activated_ts i64
pub const HOUSE_STATE_OFF: usize = 1144; // house_state u8: 1 pending, 2 activated
// [1145..1152] reserved (zeros)
/// HouseVault PDA space (seeds ["housevault", mint]); layout at the vault
/// helpers below.
pub const HOUSEVAULT_SPACE: usize = 128;
/// ActivateHouse caller cut, in bps of the vault's fee_balance (Phase C).
pub const HOUSE_CALLER_CUT_BPS: u64 = 100;
/// wSOL native mint — the house quote vault's mint.
const NATIVE_MINT_ID: &str = "So11111111111111111111111111111111111111112";
/// Holder PDA: fixed layout documented at `struct HolderState` below.
pub const HOLDER_SPACE: usize = 136;
/// Extended Holder PDA size (Graduated Latch, rule 1 mode 2): the legacy
/// 136-byte prefix plus the graduated region documented at the Holder
/// layout below. The Holder layout is LENGTH-versioned — a 136-byte
/// account is a legacy holder, a 192-byte account carries the graduated
/// fields — and legacy accounts grow lazily via `ensure_graduated` on
/// first graduated touch. (ENGINE_VERSION stays 2: the version byte
/// versions the CONFIG layout, which this extension does not touch.)
pub const HOLDER_SPACE_V2: usize = 192;
/// Graduated-region field offsets (rule 1 mode 2; see Holder layout).
pub const GRAD_PEAK_OFF: usize = 136; // peak balance u64
pub const GRAD_SOLD_OFF: usize = 144; // cumulative sold u64
pub const GRAD_CAP_OFF: usize = 152; // earned sell cap u64 (ratchets up only)
pub const GRAD_ANCHOR_OFF: usize = 160; // vesting anchor ts i64
pub const GRAD_MIN_PRICE_OFF: usize = 168; // lowest EMA seen u128
// [184..192] reserved
/// V4 Holder region (Engine v4, 2026-10-19): the next length step of the
/// same LENGTH-versioned layout — 224-byte accounts carry, past the
/// graduated region, the Vesting Clock's per-holder anchor. Offsets never
/// overlap the graduated region, so a config stacking rule 1 GRADUATED +
/// rule 13 uses both regions of one 224-byte account. Legacy (136) and
/// graduated (192) accounts grow lazily via `ensure_v4_region`, the same
/// rent-vault pattern as `ensure_graduated`.
pub const HOLDER_SPACE_V3: usize = 224;
pub const VEST_ANCHOR_OFF: usize = 192; // rule 13: balance-weighted receive anchor ts i64
// [200..224] reserved (v4 scratch)

#[derive(Debug)]
enum EngineError {
    NotRegistered = 1,     // rule 3 veto: destination owner not registered
    MaxWalletExceeded = 2, // rule 9 veto: receive would exceed cap
    BadCaller = 3,         // Execute not invoked from a genuine transfer context
    BadConfig = 4,         // config missing/corrupt/foreign
    ConfigLocked = 5,      // update attempted on a Locked config
    BadAuthority = 6,      // signer is not the config authority
    UnknownRule = 7,       // rule_id outside the registry (or unimplemented here)
    UnsupportedMode = 8,   // HolderVote writes need the vote program (later WS)
    HolderMissing = 9,     // required holder state absent where creation is impossible
    BadState = 10,         // state account foreign-owned or corrupt
    MathOverflow = 11,
    InvalidMode = 12,      // authority_mode byte outside 0..=3
    RentVaultUnderfunded = 13, // lazy holder creation cannot be paid for
    AlreadyInit = 14,
    Locked = 15,               // rule 1 veto: price >= basis, not latched
    StalePrice = 16,           // rule 1 fail-closed: price feed stale
    BasisMissing = 17,         // rule 1 fail-closed: sender holds but has no basis
    PriceFeedBad = 18,         // rule 1/crank fail-closed: feed missing/corrupt/wrong pool
    NotGateHolder = 19,        // rule 8 veto: destination gate balance short/absent
    BadGateAccount = 23,       // SyncGateBalance: presented account is not the owner's gate ATA
    VenueTransferForbidden = 20, // rule 7 (P2P-only) veto: venue-context transfer
    P2PTransferForbidden = 21, // rule 7 (No-P2P) veto: wallet-context transfer
    BadRegistration = 22,      // SyncRegistered: presented Registration PDA invalid
    WrongEcosystem = 24,       // rule 17 veto: destination registered, but not attested for the required ecosystem
    PartialLocked = 25,        // rule 1 (graduated) veto: sell exceeds the earned cap
    MissingExtra = 26,         // Execute: a required extra account (per the config's templated set) was not supplied — the meta list is stale relative to the config (refresh it, tag 9) or the client under-supplied
    GrudgeMarked = 27,         // rule 11 veto: wallet is marked (buy-ban, or buy over the marked cap)
    OutsideTradingHours = 28,  // rule 12 veto: transfer outside the configured clock window
    VestingLocked = 29,        // rule 13 veto: outbound amount exceeds the unlocked fraction
    NotAllowlisted = 30,       // rule 10 veto: destination holds no active allowlist entry
    Blocklisted = 31,          // rule 10 veto: destination owner is on the sealed blocklist
    AppNotAllowed = 32,        // rule 4 veto: venue receive via a program not in the rule's app list
    HouseNotReady = 33,        // Phase C: house graduation/seed/reserve condition unmet
    HouseNotCommitted = 34,    // Phase C: no house slot, wrong house program, or pool not committed
}

impl From<EngineError> for ProgramError {
    fn from(e: EngineError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

entrypoint!(process_instruction);

fn token_2022_id() -> Pubkey {
    Pubkey::from_str(TOKEN_2022_ID).unwrap()
}
fn registry_id() -> Pubkey {
    Pubkey::from_str(REGISTRY_ID).unwrap()
}
fn distributor_id() -> Pubkey {
    Pubkey::from_str(DISTRIBUTOR_ID).unwrap()
}
fn dbc_id() -> Pubkey {
    Pubkey::from_str(DBC_ID).unwrap()
}
fn native_mint() -> Pubkey {
    Pubkey::from_str(NATIVE_MINT_ID).unwrap()
}
fn token_id() -> Pubkey {
    Pubkey::from_str(TOKEN_ID).unwrap()
}

// ---------- byte helpers ----------
fn read_u16(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(d[o..o + 2].try_into().unwrap())
}
fn read_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn read_i64(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn read_u128(d: &[u8], o: usize) -> u128 {
    u128::from_le_bytes(d[o..o + 16].try_into().unwrap())
}
fn read_key(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}

fn pda(seeds: &[&[u8]], program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program_id).0
}
fn config_pda(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"config", mint.as_ref()], program_id)
}
fn holder_pda(mint: &Pubkey, token_account: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"holder", mint.as_ref(), token_account.as_ref()], program_id)
}
/// v2 (legacy) Holder PDA derivation — owner-keyed. Used ONLY by
/// MigrateHolder (tag 10) to locate the pre-v3 record for a wallet; the
/// bytes at the two derivations are layout-identical by design.
fn holder_pda_legacy(mint: &Pubkey, owner: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"holder", mint.as_ref(), owner.as_ref()], program_id)
}
/// Canonical ATA address for (owner, token program, mint) — the account
/// SyncRegistered's mirror targets under v3.
fn ata_pda(owner: &Pubkey, token_program: &Pubkey, mint: &Pubkey) -> Pubkey {
    let ata_program = Pubkey::from_str(ATA_PROGRAM_ID).unwrap();
    pda(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ata_program)
}
fn rentvault_pda(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"rentvault", mint.as_ref()], program_id)
}
/// Phase C HouseVault PDA (engine-owned money account for the house seed).
fn housevault_pda(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"housevault", mint.as_ref()], program_id)
}
/// Phase C house pool PDA under the HOUSE program's own id.
fn house_pool_pda(mint: &Pubkey, house_program: &Pubkey) -> Pubkey {
    pda(&[b"pool", mint.as_ref()], house_program)
}
fn price_pda(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"price", mint.as_ref()], program_id)
}
fn meta_list_pda(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"extra-account-metas", mint.as_ref()], program_id)
}
/// Rule 15 (King of the Pool) per-mint tracking PDA (v4).
fn king_pda(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"king", mint.as_ref()], program_id)
}
/// Rule 10 sealed-blocklist PDA (v4).
fn lists_pda(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"lists", mint.as_ref()], program_id)
}
/// Rule 10 per-destination-account allowlist entry PDA (v4). Keyed by the
/// destination TOKEN ACCOUNT (v3 AccountKey discipline), never the owner.
fn allow_pda(mint: &Pubkey, token_account: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"allow", mint.as_ref(), token_account.as_ref()], program_id)
}

// SPL token account base layout: mint 0..32, owner 32..64, amount u64 64..72
fn token_mint(ai: &AccountInfo) -> Result<Pubkey, ProgramError> {
    let d = ai.try_borrow_data()?;
    if d.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(read_key(&d, 0))
}
fn token_owner(ai: &AccountInfo) -> Result<Pubkey, ProgramError> {
    let d = ai.try_borrow_data()?;
    if d.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(read_key(&d, 32))
}
fn token_amount(ai: &AccountInfo) -> Result<u64, ProgramError> {
    let d = ai.try_borrow_data()?;
    if d.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(read_u64(&d, 64))
}
/// Base mint layout: supply u64 at offset 36.
fn mint_supply(mint_ai: &AccountInfo) -> Result<u64, ProgramError> {
    let d = mint_ai.try_borrow_data()?;
    if d.len() < 44 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(read_u64(&d, 36))
}

// ---------- Config (CONFIG_SPACE bytes, byte 0 = tag 1) ----------
//   [1]      engine_version u8
//   [2]      authority_mode u8
//   [3]      rule_count u8
//   [4..36]  mint pubkey
//   [36..68] authority pubkey
//   [68..76] created_slot u64
//   [76]     venue_count u8
//   [77..205]  venue allowlist [MAX_VENUES] pubkeys
//   [205]    exemption_count u8
//   [206..462] exemptions [MAX_EXEMPTIONS] pubkeys
//   [462..]  rules [MAX_RULES] x 68B: rule_id u16 @+0, enabled u8 @+2, params[64] @+4
//   [1006..1008] fee_bps u16      (mirror of TransferFee ext; SS4.1)
//   [1008..1016] fee_max u64
//   [1016]   beneficiary_mode u8
//   [1017..1049] fee_vault pubkey
//   [1049..1088] reserved (zeros)
const OFF_RULES: usize = 462;
const RULE_ENTRY_LEN: usize = 68;

struct RuleEntry {
    rule_id: u16,
    enabled: bool,
    params: [u8; PARAMS_LEN],
}

/// Phase C house commitment slot — the config's house region, present
/// only on CONFIG_SPACE_V2 (1152-byte) configs with house_state != 0:
///   [1088..1120] house_program pubkey (pre-committed venue program)
///   [1120..1128] house_threshold_lamports u64 (graduationThresholdSol)
///   [1128..1136] house_reserve_lamports u64 (committed reserve; 0 = none)
///   [1136..1144] house_activated_ts i64 (0 until activation)
///   [1144]       house_state u8: 1 = pending, 2 = activated
///   [1145..1152] reserved (zeros)
/// The static fields (program/threshold/reserve) are written once at
/// InitializeConfig and are IMMUTABLE thereafter; state/ts are activation
/// state, written only by ActivateHouse (write_config never writes them).
#[derive(Clone, Copy, PartialEq)]
struct HouseSlot {
    program: Pubkey,
    threshold_lamports: u64,
    reserve_lamports: u64,
    activated_ts: i64,
    state: u8,
}

/// The payload form of the house block (parse_config_payload): the static
/// commitment fields only — activation state never travels in a payload.
#[derive(Clone, Copy, PartialEq)]
struct HouseBlock {
    program: Pubkey,
    threshold_lamports: u64,
    reserve_lamports: u64,
}

struct Config {
    authority_mode: u8,
    authority: Pubkey,
    mint: Pubkey,
    rules: Vec<RuleEntry>,
    venues: Vec<Pubkey>,
    exemptions: Vec<Pubkey>,
    house: Option<HouseSlot>,
}

impl Config {
    fn is_exempt(&self, owner: &Pubkey, token_account: &Pubkey) -> bool {
        self.exemptions.iter().any(|e| e == owner || e == token_account)
    }
}

fn load_config(ai: &AccountInfo, program_id: &Pubkey) -> Result<Config, ProgramError> {
    if ai.owner != program_id {
        return Err(EngineError::BadConfig.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < CONFIG_SPACE || d[0] != 1 || d[1] != ENGINE_VERSION {
        return Err(EngineError::BadConfig.into());
    }
    let rule_count = (d[3] as usize).min(MAX_RULES);
    let mut rules = Vec::with_capacity(rule_count);
    for i in 0..rule_count {
        let o = OFF_RULES + i * RULE_ENTRY_LEN;
        let mut params = [0u8; PARAMS_LEN];
        params.copy_from_slice(&d[o + 4..o + 4 + PARAMS_LEN]);
        rules.push(RuleEntry {
            rule_id: read_u16(&d, o),
            enabled: d[o + 2] == 1,
            params,
        });
    }
    let venue_count = (d[76] as usize).min(MAX_VENUES);
    let mut venues = Vec::with_capacity(venue_count);
    for i in 0..venue_count {
        venues.push(read_key(&d, 77 + i * 32));
    }
    let ex_count = (d[205] as usize).min(MAX_EXEMPTIONS);
    let mut exemptions = Vec::with_capacity(ex_count);
    for i in 0..ex_count {
        exemptions.push(read_key(&d, 206 + i * 32));
    }
    // Phase C house region: Some iff the account carries the V2 region
    // AND a commitment was written into it (state != 0).
    let house = if d.len() >= CONFIG_SPACE_V2 && d[HOUSE_STATE_OFF] != 0 {
        Some(HouseSlot {
            program: read_key(&d, HOUSE_PROG_OFF),
            threshold_lamports: read_u64(&d, HOUSE_THRESHOLD_OFF),
            reserve_lamports: read_u64(&d, HOUSE_RESERVE_OFF),
            activated_ts: read_i64(&d, HOUSE_TS_OFF),
            state: d[HOUSE_STATE_OFF],
        })
    } else {
        None
    };
    Ok(Config {
        authority_mode: d[2],
        authority: read_key(&d, 36),
        mint: read_key(&d, 4),
        rules,
        venues,
        exemptions,
        house,
    })
}

/// Write the mutable config fields into an already-created Config account.
/// The caller has validated `cfg` via parse_config_payload.
fn write_config(d: &mut [u8], cfg: &ConfigPayload, mint: &Pubkey, created_slot: u64) {
    d[0] = 1;
    d[1] = ENGINE_VERSION;
    d[2] = cfg.authority_mode;
    d[3] = cfg.rules.len() as u8;
    d[4..36].copy_from_slice(mint.as_ref());
    d[36..68].copy_from_slice(cfg.authority.as_ref());
    d[68..76].copy_from_slice(&created_slot.to_le_bytes());
    d[76] = cfg.venues.len() as u8;
    for (i, v) in cfg.venues.iter().enumerate() {
        d[77 + i * 32..77 + (i + 1) * 32].copy_from_slice(v.as_ref());
    }
    d[205] = cfg.exemptions.len() as u8;
    for (i, e) in cfg.exemptions.iter().enumerate() {
        d[206 + i * 32..206 + (i + 1) * 32].copy_from_slice(e.as_ref());
    }
    for (i, r) in cfg.rules.iter().enumerate() {
        let o = OFF_RULES + i * RULE_ENTRY_LEN;
        d[o..o + 2].copy_from_slice(&r.rule_id.to_le_bytes());
        d[o + 2] = if r.enabled { 1 } else { 0 };
        d[o + 3] = 0;
        d[o + 4..o + 4 + PARAMS_LEN].copy_from_slice(&r.params);
    }
    d[1006..1008].copy_from_slice(&cfg.fee_bps.to_le_bytes());
    d[1008..1016].copy_from_slice(&cfg.fee_max.to_le_bytes());
    d[1016] = cfg.beneficiary_mode;
    d[1017..1049].copy_from_slice(cfg.fee_vault.as_ref());
    // Phase C: write_config writes ONLY the static house fields
    // (program/threshold/reserve) and only into a V2-sized account.
    // Activation state + ts are NEVER written here: InitializeConfig sets
    // state = 1 itself on the fresh (zeroed) account, and UpdateConfig
    // restores the stored state/ts after its zeroing pass.
    if d.len() >= CONFIG_SPACE_V2 {
        if let Some(h) = &cfg.house {
            d[HOUSE_PROG_OFF..HOUSE_PROG_OFF + 32].copy_from_slice(h.program.as_ref());
            d[HOUSE_THRESHOLD_OFF..HOUSE_THRESHOLD_OFF + 8].copy_from_slice(&h.threshold_lamports.to_le_bytes());
            d[HOUSE_RESERVE_OFF..HOUSE_RESERVE_OFF + 8].copy_from_slice(&h.reserve_lamports.to_le_bytes());
        }
    }
}

/// Config payload (shared by InitializeConfig and UpdateConfig), after the tag:
///   authority_mode u8 | authority 32 | rule_count u8
///   rules: n x { rule_id u16, enabled u8, _pad u8, params[64] }   (68B each)
///   venue_count u8 | venues x 32
///   exemption_count u8 | exemptions x 32
///   fee_bps u16 | fee_max u64 | beneficiary_mode u8 | fee_vault 32
struct ConfigPayload {
    authority_mode: u8,
    authority: Pubkey,
    rules: Vec<RuleEntry>,
    venues: Vec<Pubkey>,
    exemptions: Vec<Pubkey>,
    fee_bps: u16,
    fee_max: u64,
    beneficiary_mode: u8,
    fee_vault: Pubkey,
    house: Option<HouseBlock>,
}

fn parse_config_payload(data: &[u8], program_id: &Pubkey) -> Result<ConfigPayload, ProgramError> {
    let mut cur = 1usize; // skip tag
    let need = |cur: usize, n: usize| -> Result<(), ProgramError> {
        if data.len() < cur + n {
            Err(ProgramError::InvalidInstructionData)
        } else {
            Ok(())
        }
    };
    need(cur, 1 + 32 + 1)?;
    let authority_mode = data[cur];
    cur += 1;
    if authority_mode > MODE_HOLDER_VOTE {
        return Err(EngineError::InvalidMode.into());
    }
    let authority = read_key(data, cur);
    cur += 32;
    let rule_count = data[cur] as usize;
    cur += 1;
    if rule_count > MAX_RULES {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut rules = Vec::with_capacity(rule_count);
    // Phase B cross-rule accumulator: crown (5) + seat tithe (6) + king
    // tithe (15) carve from the same Distributor split and must sum
    // <= 10000 bps (checked after the rule loop).
    let mut split_sum: u32 = 0;
    // Phase C: set when an ENABLED rule 2 (Escrow Split) entry is present;
    // such a config MUST carry a house block (checked after the tail parse).
    let mut escrow_enabled = false;
    for _ in 0..rule_count {
        need(cur, RULE_ENTRY_LEN)?;
        let rule_id = read_u16(data, cur);
        let enabled = data[cur + 2] == 1;
        let mut params = [0u8; PARAMS_LEN];
        params.copy_from_slice(&data[cur + 4..cur + 4 + PARAMS_LEN]);
        // FAIL CLOSED AT WRITE TIME (spec SS2.2): unknown rule_id is never
        // accepted into a config; a known rule this build cannot enforce is
        // rejected too, so a config can never claim a rule Execute would skip.
        if !rule_known(rule_id) || (enabled && !rule_implemented(rule_id)) {
            msg!("engine: rejected rule_id {}", rule_id);
            return Err(EngineError::UnknownRule.into());
        }
        // Per-rule parameter sanity, also at write time (an enabled rule
        // with meaningless params is a config that lies about enforcement).
        if enabled && rule_id == RULE_P2P_TOGGLE && params[0] > 1 {
            msg!("engine: rejected p2p mode {} (0 = P2P-only, 1 = No-P2P)", params[0]);
            return Err(ProgramError::InvalidInstructionData);
        }
        if enabled && rule_id == RULE_HOLDER_GATED && params[0..32] == [0u8; 32] {
            msg!("engine: rejected holder-gated rule with a zero gate mint");
            return Err(ProgramError::InvalidInstructionData);
        }
        if enabled && rule_id == RULE_ECOSYSTEM_GATE && (params[0] == 0 || params[0] > MAX_ECOSYSTEM) {
            msg!("engine: rejected ecosystem gate with required ecosystem {} (valid 1..={})", params[0], MAX_ECOSYSTEM);
            return Err(ProgramError::InvalidInstructionData);
        }
        if enabled && rule_id == RULE_BASIS_LATCH && params[18] > 2 {
            msg!("engine: rejected basis latch mode {} (0 = LATCH, 1 = LIVE, 2 = GRADUATED)", params[18]);
            return Err(ProgramError::InvalidInstructionData);
        }
        if enabled && rule_id == RULE_BASIS_LATCH && read_u16(&params, 19) > 10_000 {
            msg!("engine: rejected basis latch base_frac_bps {} (> 10000)", read_u16(&params, 19));
            return Err(ProgramError::InvalidInstructionData);
        }
        // --- v4 rules (write-time sanity mirrors each module's layout) ---
        if enabled && rule_id == RULE_APP_GATED && params[0..32] == [0u8; 32] && params[32..64] == [0u8; 32] {
            msg!("engine: rejected app-gated rule with an empty app list");
            return Err(ProgramError::InvalidInstructionData);
        }
        if enabled && rule_id == RULE_ALLOW_BLOCK_LIST && params[0] > 2 {
            msg!("engine: rejected allow/blocklist mode {} (0 = blocklist, 1 = allowlist, 2 = both)", params[0]);
            return Err(ProgramError::InvalidInstructionData);
        }
        if enabled && rule_id == RULE_GRUDGE {
            let bps = read_u16(&params, 0);
            if bps == 0 || bps > 10_000 {
                msg!("engine: rejected grudge dump_threshold_bps {} (valid 1..=10000)", bps);
                return Err(ProgramError::InvalidInstructionData);
            }
            if params[18] > 1 {
                msg!("engine: rejected grudge penalty mode {} (0 = buy-ban, 1 = buy-cap)", params[18]);
                return Err(ProgramError::InvalidInstructionData);
            }
            if params[18] == 1 && read_u64(&params, 19) == 0 {
                msg!("engine: rejected grudge buy-cap mode with a zero buy_cap_amount");
                return Err(ProgramError::InvalidInstructionData);
            }
        }
        if enabled && rule_id == RULE_TRADING_HOURS {
            // params[0..4] carry the i32 tz offset (seconds east of UTC).
            let tz32 = i32::from_le_bytes(params[0..4].try_into().unwrap()) as i64;
            if !(-43_200..=50_400).contains(&tz32) {
                msg!("engine: rejected trading hours tz offset {} (valid -43200..=50400 secs)", tz32);
                return Err(ProgramError::InvalidInstructionData);
            }
            if params[4] == 0 || params[4] & !0x7f != 0 {
                msg!("engine: rejected trading hours days mask {:#09b} (bits 0..6 = Mon..Sun, at least one day)", params[4]);
                return Err(ProgramError::InvalidInstructionData);
            }
            let start = read_u16(&params, 5);
            let end = read_u16(&params, 7);
            if start >= end || end > 1440 {
                msg!("engine: rejected trading hours window {}..{} (need start < end <= 1440 minutes)", start, end);
                return Err(ProgramError::InvalidInstructionData);
            }
            if params[9] > 1 {
                msg!("engine: rejected trading hours scope {} (0 = all transfers, 1 = venue only)", params[9]);
                return Err(ProgramError::InvalidInstructionData);
            }
        }
        if enabled && rule_id == RULE_VESTING_CLOCK {
            if params[0] > 1 {
                msg!("engine: rejected vesting mode {} (0 = cliff, 1 = linear)", params[0]);
                return Err(ProgramError::InvalidInstructionData);
            }
            if read_u64(&params, 8) == 0 && read_i64(&params, 16) == 0 {
                msg!("engine: rejected vesting clock with neither a hold period nor a release time");
                return Err(ProgramError::InvalidInstructionData);
            }
        }
        // --- Phase B settlement rules (write-time sanity; enforcement is
        // settlement/crank-side, Execute is a no-op for 5/6/14/16) ---
        // All unspecified bytes in each 64-byte params block must be zero.
        if enabled && rule_id == RULE_CROWN_BENEFICIARY {
            let crown_bps = read_u16(&params, 0);
            if crown_bps == 0 || crown_bps > 10_000 {
                msg!("engine: rejected crown beneficiary crown_bps {} (valid 1..=10000)", crown_bps);
                return Err(ProgramError::InvalidInstructionData);
            }
            if params[2..64].iter().any(|&b| b != 0) {
                msg!("engine: rejected crown beneficiary params with nonzero padding bytes [2..64]");
                return Err(ProgramError::InvalidInstructionData);
            }
            split_sum += crown_bps as u32;
        }
        if enabled && rule_id == RULE_TITHE_SEAT {
            if params[0..32] == [0u8; 32] {
                msg!("engine: rejected tithe seat rule with a zero seat mint");
                return Err(ProgramError::InvalidInstructionData);
            }
            let tithe_bps = read_u16(&params, 32);
            if tithe_bps == 0 || tithe_bps > 10_000 {
                msg!("engine: rejected tithe seat tithe_bps {} (valid 1..=10000)", tithe_bps);
                return Err(ProgramError::InvalidInstructionData);
            }
            if params[34..64].iter().any(|&b| b != 0) {
                msg!("engine: rejected tithe seat params with nonzero padding bytes [34..64]");
                return Err(ProgramError::InvalidInstructionData);
            }
            split_sum += tithe_bps as u32;
        }
        if enabled && rule_id == RULE_DECAY_TAX {
            let start_bps = read_u16(&params, 0);
            let floor_bps = read_u16(&params, 2);
            if start_bps == 0 || start_bps > 10_000 {
                msg!("engine: rejected decay tax start_bps {} (valid 1..=10000)", start_bps);
                return Err(ProgramError::InvalidInstructionData);
            }
            if floor_bps > start_bps {
                msg!("engine: rejected decay tax floor_bps {} > start_bps {}", floor_bps, start_bps);
                return Err(ProgramError::InvalidInstructionData);
            }
            if read_u64(&params, 4) == 0 {
                msg!("engine: rejected decay tax with a zero decay_secs");
                return Err(ProgramError::InvalidInstructionData);
            }
            if params[12..64].iter().any(|&b| b != 0) {
                msg!("engine: rejected decay tax params with nonzero padding bytes [12..64]");
                return Err(ProgramError::InvalidInstructionData);
            }
        }
        if enabled && rule_id == RULE_KING_OF_POOL {
            // v4 semantics: 0 = tracking only; all-zero params (every
            // v4-era King config) remain valid.
            let tithe_bps = read_u16(&params, 0);
            if tithe_bps > 10_000 {
                msg!("engine: rejected king of the pool tithe_bps {} (valid 0..=10000)", tithe_bps);
                return Err(ProgramError::InvalidInstructionData);
            }
            if params[2..64].iter().any(|&b| b != 0) {
                msg!("engine: rejected king of the pool params with nonzero padding bytes [2..64]");
                return Err(ProgramError::InvalidInstructionData);
            }
            split_sum += tithe_bps as u32;
        }
        if enabled && rule_id == RULE_BUYBACK_BURN {
            if read_u64(&params, 0) == 0 {
                msg!("engine: rejected buyback & burn with a zero threshold_lamports");
                return Err(ProgramError::InvalidInstructionData);
            }
            let caller_cut_bps = read_u16(&params, 8);
            if caller_cut_bps > 1_000 {
                msg!("engine: rejected buyback & burn caller_cut_bps {} (valid 0..=1000)", caller_cut_bps);
                return Err(ProgramError::InvalidInstructionData);
            }
            if params[10..64].iter().any(|&b| b != 0) {
                msg!("engine: rejected buyback & burn params with nonzero padding bytes [10..64]");
                return Err(ProgramError::InvalidInstructionData);
            }
        }
        // --- Phase C rule 2 (Escrow Split; venue-side enforcement) ---
        // params: split_bps u16 @[0..2], 1..=10000; params[2..64] zero.
        // The house-block cross-check runs after the payload tail is parsed
        // (the block sits after the fee tail), via `escrow_enabled` below.
        if enabled && rule_id == RULE_ESCROW_SPLIT {
            let split_bps = read_u16(&params, 0);
            if split_bps == 0 || split_bps > 10_000 {
                msg!("engine: rejected escrow split split_bps {} (valid 1..=10000)", split_bps);
                return Err(ProgramError::InvalidInstructionData);
            }
            if params[2..64].iter().any(|&b| b != 0) {
                msg!("engine: rejected escrow split params with nonzero padding bytes [2..64]");
                return Err(ProgramError::InvalidInstructionData);
            }
            escrow_enabled = true;
        }
        cur += RULE_ENTRY_LEN;
        rules.push(RuleEntry { rule_id, enabled, params });
    }
    // Phase B cross-rule validation: the Distributor split carve requires
    // crown_bps + seat tithe_bps + king tithe_bps <= 10000.
    if split_sum > 10_000 {
        msg!("engine: rejected config: crown + tithe seat + king tithe bps sum {} > 10000", split_sum);
        return Err(ProgramError::InvalidInstructionData);
    }
    need(cur, 1)?;
    let venue_count = data[cur] as usize;
    cur += 1;
    if venue_count > MAX_VENUES {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut venues = Vec::with_capacity(venue_count);
    for _ in 0..venue_count {
        need(cur, 32)?;
        venues.push(read_key(data, cur));
        cur += 32;
    }
    need(cur, 1)?;
    let ex_count = data[cur] as usize;
    cur += 1;
    if ex_count > MAX_EXEMPTIONS {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut exemptions = Vec::with_capacity(ex_count);
    for _ in 0..ex_count {
        need(cur, 32)?;
        exemptions.push(read_key(data, cur));
        cur += 32;
    }
    need(cur, 2 + 8 + 1 + 32)?;
    let fee_bps = read_u16(data, cur);
    cur += 2;
    let fee_max = read_u64(data, cur);
    cur += 8;
    let beneficiary_mode = data[cur];
    cur += 1;
    let fee_vault = read_key(data, cur);
    cur += 32;
    // Phase C house block, appended AFTER the fee tail, present ONLY for
    // house-committed configs: [1u8][program 32][threshold u64][reserve
    // u64] = 49 bytes. Absent = no commitment. Any other trailing bytes
    // fail closed. Non-house payloads are byte-identical to Phase B.
    let house = if data.len() == cur {
        None
    } else if data.len() == cur + 49 && data[cur] == 1 {
        let program = read_key(data, cur + 1);
        let threshold_lamports = read_u64(data, cur + 33);
        let reserve_lamports = read_u64(data, cur + 41);
        if program == Pubkey::default() {
            msg!("engine: rejected house block with a zero house program");
            return Err(ProgramError::InvalidInstructionData);
        }
        if program == *program_id {
            msg!("engine: rejected house block naming the engine itself as the house program");
            return Err(ProgramError::InvalidInstructionData);
        }
        if threshold_lamports == 0 {
            msg!("engine: rejected house block with a zero house threshold");
            return Err(ProgramError::InvalidInstructionData);
        }
        Some(HouseBlock { program, threshold_lamports, reserve_lamports })
    } else {
        msg!("engine: rejected config payload with malformed trailing bytes ({} past the fee tail)", data.len() - cur);
        return Err(ProgramError::InvalidInstructionData);
    };
    // Phase C cross-check: an enabled Escrow Split (rule 2) entry is
    // venue-side against the house pool — without a house commitment the
    // config would claim an unenforceable rule, so it fails at write.
    if escrow_enabled && house.is_none() {
        msg!("engine: rejected rule 2 (escrow split) without a house commitment block — rule 2 requires a house-committed config");
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(ConfigPayload {
        authority_mode,
        authority,
        rules,
        venues,
        exemptions,
        fee_bps,
        fee_max,
        beneficiary_mode,
        fee_vault,
        house,
    })
}

// ---------- Holder PDA (HOLDER_SPACE bytes, byte 0 = tag 1) — spec SS2.3 ----------
//   [1]      registered u8   (rule 3 flag; mirror of the Registry PDA's
//              `active` byte, written by SyncRegistered)
//   [2]      ecosystem u8    (rule 17 mirror of the Registration PDA's
//              ecosystem byte, written by SyncRegistered; 0 = none/open)
//   [3..6]   reserved
//   [6..22]  basis_num u128  (rule 1; blending logic lands with that module)
//   [22..38] basis_den u128  (default 1)
//   [38]     latched u8
//   [39..47] last_buy_ts i64
//   [47..55] last_sell_ts i64
//   [55..63] dump_window_start i64
//   [63..71] dump_sold_in_window u64
//   [71..87] reward_debt u128        (distributor lazy settlement)
//   [87..103] reward_settled_index u128
//   [103..135] custom [32]  (per-module scratch, namespaced by rule_id;
//              rule 8 uses [103..111] gate_balance u64 + [111..119]
//              gate_sync_ts i64, written by SyncGateBalance;
//              rule 11 (v4) uses [119..127] grudge_mark_until i64 +
//              [127..135] grudge_window_bag u64 — its window start /
//              sold counters are the named fields at [55..71] above)
//   [135]    grudge_offenses u8 (rule 11, v4; was reserved pre-v4 —
//              every pre-v4 writer leaves it zero, which is exactly the
//              "no offenses" value, so no migration is needed)
// Extended region (HOLDER_SPACE_V2 = 192 bytes; GRADUATED mode of rule 1
// only — modes 0/1 never read or write any byte >= 136):
//   [136..144] grad_peak u64       (largest post-transfer balance of the
//              current position; the base the earned cap is a fraction of)
//   [144..152] grad_sold u64       (cumulative amount sold from the
//              current position, counted against grad_cap)
//   [152..160] grad_cap u64        (earned sell allowance; ratchets UP
//              only — see module_basis_latch)
//   [160..168] grad_anchor i64     (vesting anchor timestamp: set when a
//              position opens, balance-weighted on further receives;
//              0 = no open position)
//   [168..184] grad_min_price u128 (lowest feed EMA observed while the
//              position is open; the dip signal for grad_frac_bps)
//   [184..192] reserved
// The extended region exists only on 192-byte accounts: the Holder layout
// is LENGTH-versioned (136 = legacy, 192 = extended), so ENGINE_VERSION
// stays 2 — that byte versions the CONFIG layout, which is untouched.
// Legacy accounts grow lazily via ensure_graduated (rent-vault funded);
// InitializeHolder still creates the legacy 136-byte form and the first
// graduated touch migrates. A full exit zeroes [136..192] (the fields
// above) while basis/latched (below 136) persist as in modes 0/1.
// V4 region (224-byte accounts; rule 13 only — modes and rules that never
// enable Vesting Clock never read or write any byte >= 192):
//   [192..200] vest_anchor i64     (balance-weighted average receive time
//              of the current position; 0 = no open position)
//   [200..224] reserved
// A 224-byte account is a superset: graduated fields [136..192] keep
// their offsets, so stacking rules 1 (GRADUATED) + 13 shares one record.
fn holder_registered(ai: &AccountInfo, program_id: &Pubkey) -> Result<Option<bool>, ProgramError> {
    if ai.data_len() == 0 {
        return Ok(None); // account does not exist yet
    }
    if ai.owner != program_id {
        return Err(EngineError::BadState.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < HOLDER_SPACE || d[0] != 1 {
        return Err(EngineError::BadState.into());
    }
    Ok(Some(d[1] == 1))
}

fn init_holder_data(ai: &AccountInfo) -> ProgramResult {
    let mut d = ai.try_borrow_mut_data()?;
    for b in d.iter_mut() {
        *b = 0;
    }
    d[0] = 1;
    d[22..38].copy_from_slice(&1u128.to_le_bytes()); // basis_den = 1
    Ok(())
}

/// Validate a Holder PDA account structurally (exists, engine-owned, tag 1).
/// Returns false only for "account does not exist" — corrupt/foreign state is
/// an error (fail closed), never a silent absence.
fn holder_valid(ai: &AccountInfo, program_id: &Pubkey) -> Result<bool, ProgramError> {
    if ai.data_len() == 0 {
        return Ok(false);
    }
    if ai.owner != program_id {
        return Err(EngineError::BadState.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < HOLDER_SPACE || d[0] != 1 {
        return Err(EngineError::BadState.into());
    }
    Ok(true)
}

/// Holder's basis as a single scaled price (basis_num / basis_den).
/// Ok(None) = no recorded entry (basis_num == 0: a fresh or zeroed record).
fn holder_basis(ai: &AccountInfo) -> Result<Option<u128>, ProgramError> {
    let d = ai.try_borrow_data()?;
    if d.len() < HOLDER_SPACE || d[0] != 1 {
        return Err(EngineError::BadState.into());
    }
    let num = read_u128(&d, 6);
    let den = read_u128(&d, 22);
    if den == 0 {
        return Err(EngineError::BadState.into());
    }
    if num == 0 {
        return Ok(None);
    }
    Ok(Some(num / den))
}

fn holder_latched(ai: &AccountInfo) -> Result<bool, ProgramError> {
    let d = ai.try_borrow_data()?;
    if d.len() < HOLDER_SPACE || d[0] != 1 {
        return Err(EngineError::BadState.into());
    }
    Ok(d[38] == 1)
}

// ---------- PriceFeed PDA (spec SS2.4; TH PriceFeed generalized) ----------
// Seeds: ["price", mint]. FEED_SPACE bytes:
//   [0]        tag u8 = 1
//   [1..33]    pool pubkey (the venue pool this feed serves)
//   [33..65]   token_vault pubkey (pool's vault for THIS mint)
//   [65..97]   quote_vault pubkey (pool's vault for the quote mint)
//   [97..113]  ema_price u128 (PRICE_SCALE fixed point)
//   [113..121] last_crank_ts i64 (unix seconds; 0 = never cranked)
//   [121..129] crank_count u64
//   [129]      token_dec u8
//   [130]      quote_dec u8
//   [131..136] reserved
pub const FEED_SPACE: usize = 136;

struct PriceFeed {
    pool: Pubkey,
    token_vault: Pubkey,
    quote_vault: Pubkey,
    ema_price: u128,
    last_crank_ts: i64,
    token_dec: u8,
    quote_dec: u8,
}

fn load_feed(ai: &AccountInfo, program_id: &Pubkey) -> Result<PriceFeed, ProgramError> {
    if ai.data_len() == 0 || ai.owner != program_id {
        return Err(EngineError::PriceFeedBad.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < FEED_SPACE || d[0] != 1 {
        return Err(EngineError::PriceFeedBad.into());
    }
    Ok(PriceFeed {
        pool: read_key(&d, 1),
        token_vault: read_key(&d, 33),
        quote_vault: read_key(&d, 65),
        ema_price: read_u128(&d, 97),
        last_crank_ts: read_i64(&d, 113),
        token_dec: d[129],
        quote_dec: d[130],
    })
}

// ---------- PDA creation helpers (TH patterns) ----------
fn create_pda<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    seeds: &[&[u8]],
    size: usize,
) -> ProgramResult {
    let (_, bump) = Pubkey::find_program_address(seeds, program_id);
    let bump_arr = [bump];
    let mut full: Vec<&[u8]> = seeds.to_vec();
    full.push(&bump_arr);
    let rent = Rent::get()?.minimum_balance(size);
    invoke_signed(
        &system_instruction::create_account(payer.key, target.key, rent, size as u64, program_id),
        &[payer.clone(), target.clone(), system.clone()],
        &[&full],
    )
}

/// Holder creation size for a config: the v4 224-byte form iff the config
/// carries an ENABLED Vesting Clock rule (its anchor lives in the v4
/// region from birth), else the extended 192-byte form iff the config
/// carries an ENABLED Basis Latch rule in GRADUATED mode (params mode
/// byte == 2), else the legacy 136-byte HOLDER_SPACE.
fn holder_create_size(cfg: &Config) -> usize {
    if cfg
        .rules
        .iter()
        .any(|r| r.enabled && r.rule_id == RULE_VESTING_CLOCK)
    {
        return HOLDER_SPACE_V3;
    }
    if cfg
        .rules
        .iter()
        .any(|r| r.enabled && r.rule_id == RULE_BASIS_LATCH && r.params[18] == 2)
    {
        HOLDER_SPACE_V2
    } else {
        HOLDER_SPACE
    }
}

/// Lazily grow a Holder PDA to the v4 224-byte form, funded from the rent
/// vault — `ensure_graduated`'s pattern at the next length step (top the
/// account up to the 224-byte rent minimum from the vault, then realloc;
/// the grown tail is zero-filled and every pre-existing byte is left
/// untouched, including a graduated region at [136..192]). Already-v4
/// accounts are a no-op; a missing account is HolderMissing (creation is
/// ensure_dst_holder's job); foreign/corrupt state fails BadState.
fn ensure_v4_region<'a>(
    program_id: &Pubkey,
    holder_ai: &AccountInfo<'a>,
    vault_ai: &AccountInfo<'a>,
    mint: &Pubkey,
) -> ProgramResult {
    if holder_ai.data_len() >= HOLDER_SPACE_V3 {
        return Ok(());
    }
    if holder_ai.data_len() == 0 {
        return Err(EngineError::HolderMissing.into());
    }
    if holder_ai.owner != program_id {
        return Err(EngineError::BadState.into());
    }
    {
        let d = holder_ai.try_borrow_data()?;
        if d.len() < HOLDER_SPACE || d[0] != 1 {
            return Err(EngineError::BadState.into());
        }
    } // data borrow dropped before the CPI below
    let delta = Rent::get()?
        .minimum_balance(HOLDER_SPACE_V3)
        .saturating_sub(holder_ai.lamports());
    if vault_ai.lamports() < delta {
        msg!("engine: rent vault underfunded for v4 holder migration");
        return Err(EngineError::RentVaultUnderfunded.into());
    }
    if delta > 0 {
        let (_, vault_bump) = Pubkey::find_program_address(&[b"rentvault", mint.as_ref()], program_id);
        invoke_signed(
            &system_instruction::transfer(vault_ai.key, holder_ai.key, delta),
            &[vault_ai.clone(), holder_ai.clone()],
            &[&[b"rentvault", mint.as_ref(), &[vault_bump]]],
        )?;
    }
    holder_ai.realloc(HOLDER_SPACE_V3, true)?;
    msg!("engine: holder PDA migrated to v4 layout ({} bytes)", HOLDER_SPACE_V3);
    Ok(())
}

/// Lazily grow a legacy (136-byte) Holder PDA to the extended 192-byte
/// form, funded from the bare rent-vault PDA (TH pattern, same as
/// ensure_dst_holder): the vault tops the account up to the 192-byte
/// rent minimum, then realloc zero-initializes the grown region — the
/// pre-existing first 136 bytes are left untouched. Already-extended
/// accounts are a no-op; a missing account is HolderMissing (creation is
/// ensure_dst_holder's / create_pda's job, never a silent side effect
/// here); foreign-owned or corrupt state fails BadState. `owner` /
/// `system_ai` ride along for call-site symmetry with ensure_dst_holder
/// (the vault transfer signs with the vault's own seeds; realloc needs
/// no CPI), so they are not otherwise used.
fn ensure_graduated<'a>(
    program_id: &Pubkey,
    holder_ai: &AccountInfo<'a>,
    vault_ai: &AccountInfo<'a>,
    _system_ai: &AccountInfo<'a>,
    mint: &Pubkey,
    _owner: &Pubkey,
) -> ProgramResult {
    if holder_ai.data_len() >= HOLDER_SPACE_V2 {
        return Ok(());
    }
    if holder_ai.data_len() == 0 {
        return Err(EngineError::HolderMissing.into());
    }
    if holder_ai.owner != program_id {
        return Err(EngineError::BadState.into());
    }
    {
        let d = holder_ai.try_borrow_data()?;
        if d.len() < HOLDER_SPACE || d[0] != 1 {
            return Err(EngineError::BadState.into());
        }
    } // data borrow dropped before the CPI below
    let delta = Rent::get()?
        .minimum_balance(HOLDER_SPACE_V2)
        .saturating_sub(holder_ai.lamports());
    if vault_ai.lamports() < delta {
        msg!("engine: rent vault underfunded for graduated holder migration");
        return Err(EngineError::RentVaultUnderfunded.into());
    }
    if delta > 0 {
        let (_, vault_bump) = Pubkey::find_program_address(&[b"rentvault", mint.as_ref()], program_id);
        invoke_signed(
            &system_instruction::transfer(vault_ai.key, holder_ai.key, delta),
            &[vault_ai.clone(), holder_ai.clone()],
            &[&[b"rentvault", mint.as_ref(), &[vault_bump]]],
        )?;
    }
    holder_ai.realloc(HOLDER_SPACE_V2, true)?;
    msg!("engine: holder PDA migrated to graduated layout ({} bytes)", HOLDER_SPACE_V2);
    Ok(())
}

/// Lazily create the destination Holder PDA, funded from the bare rent-vault
/// PDA (system-owned address, funded by plain SOL transfers — TH pattern).
/// Fails EXPLICITLY (RentVaultUnderfunded) when the vault cannot pay; never
/// silently approves. `size` is the creation size (HOLDER_SPACE, or
/// HOLDER_SPACE_V2 under a graduated config — see holder_create_size);
/// rent and allocation both use it. v3: `token_account` is the DESTINATION
/// TOKEN ACCOUNT's key — the record's identity under AccountKey derivation.
fn ensure_dst_holder<'a>(
    program_id: &Pubkey,
    holder_ai: &AccountInfo<'a>,
    vault_ai: &AccountInfo<'a>,
    system_ai: &AccountInfo<'a>,
    mint: &Pubkey,
    token_account: &Pubkey,
    size: usize,
) -> ProgramResult {
    if holder_ai.data_len() > 0 {
        return Ok(());
    }
    let rent = Rent::get()?.minimum_balance(size);
    if vault_ai.lamports() < rent {
        msg!("engine: rent vault underfunded for lazy holder creation");
        return Err(EngineError::RentVaultUnderfunded.into());
    }
    let (_, bump) = Pubkey::find_program_address(&[b"holder", mint.as_ref(), token_account.as_ref()], program_id);
    let (_, vault_bump) = Pubkey::find_program_address(&[b"rentvault", mint.as_ref()], program_id);
    invoke_signed(
        &system_instruction::transfer(vault_ai.key, holder_ai.key, rent),
        &[vault_ai.clone(), holder_ai.clone()],
        &[&[b"rentvault", mint.as_ref(), &[vault_bump]]],
    )?;
    invoke_signed(
        &system_instruction::allocate(holder_ai.key, size as u64),
        &[holder_ai.clone(), system_ai.clone()],
        &[&[b"holder", mint.as_ref(), token_account.as_ref(), &[bump]]],
    )?;
    invoke_signed(
        &system_instruction::assign(holder_ai.key, program_id),
        &[holder_ai.clone(), system_ai.clone()],
        &[&[b"holder", mint.as_ref(), token_account.as_ref(), &[bump]]],
    )?;
    init_holder_data(holder_ai)?;
    msg!("engine: holder PDA created lazily for token account {}", token_account);
    Ok(())
}

/// The source-side twin of `ensure_dst_holder` (identical mechanics; the
/// helper is generic over which token account the record is keyed to).
/// Used by rule 11's sell leg, which must create the SENDER's record to
/// start dump tracking when the seller has never held one.
fn ensure_src_holder<'a>(
    program_id: &Pubkey,
    holder_ai: &AccountInfo<'a>,
    vault_ai: &AccountInfo<'a>,
    system_ai: &AccountInfo<'a>,
    mint: &Pubkey,
    token_account: &Pubkey,
    size: usize,
) -> ProgramResult {
    ensure_dst_holder(program_id, holder_ai, vault_ai, system_ai, mint, token_account, size)
}

/// Create a Holder PDA at an explicit size, funded from the rent vault
/// (the ensure_dst_holder transfer/allocate/assign sequence, minus the
/// existence check and the data init — MigrateHolder copies real bytes
/// in, SyncHolder inits-or-merges itself).
fn create_holder_from_vault<'a>(
    program_id: &Pubkey,
    holder_ai: &AccountInfo<'a>,
    vault_ai: &AccountInfo<'a>,
    system_ai: &AccountInfo<'a>,
    mint: &Pubkey,
    token_account: &Pubkey,
    size: usize,
) -> ProgramResult {
    let rent = Rent::get()?.minimum_balance(size);
    if vault_ai.lamports() < rent {
        msg!("engine: rent vault underfunded for holder creation");
        return Err(EngineError::RentVaultUnderfunded.into());
    }
    let (_, bump) = Pubkey::find_program_address(&[b"holder", mint.as_ref(), token_account.as_ref()], program_id);
    let (_, vault_bump) = Pubkey::find_program_address(&[b"rentvault", mint.as_ref()], program_id);
    invoke_signed(
        &system_instruction::transfer(vault_ai.key, holder_ai.key, rent),
        &[vault_ai.clone(), holder_ai.clone()],
        &[&[b"rentvault", mint.as_ref(), &[vault_bump]]],
    )?;
    invoke_signed(
        &system_instruction::allocate(holder_ai.key, size as u64),
        &[holder_ai.clone(), system_ai.clone()],
        &[&[b"holder", mint.as_ref(), token_account.as_ref(), &[bump]]],
    )?;
    invoke_signed(
        &system_instruction::assign(holder_ai.key, program_id),
        &[holder_ai.clone(), system_ai.clone()],
        &[&[b"holder", mint.as_ref(), token_account.as_ref(), &[bump]]],
    )?;
    Ok(())
}

/// Close an engine-owned account: drain its lamports to the rent vault,
/// hand ownership back to the system program, shrink to zero. The
/// runtime purges it at instruction end (zero lamports, zero data,
/// system-owned).
fn close_pda_to_vault(acct: &AccountInfo, vault_ai: &AccountInfo) -> ProgramResult {
    let amount = acct.lamports();
    **vault_ai.try_borrow_mut_lamports()? += amount;
    **acct.try_borrow_mut_lamports()? = 0;
    acct.assign(&solana_program::system_program::id());
    acct.realloc(0, false)?;
    Ok(())
}

// ---------- dispatch ----------
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() >= 8 && data[0..8] == EXECUTE_DISC {
        return execute(program_id, accounts, data);
    }
    if data.len() >= 8 && data[0..8] == INIT_METAS_DISC {
        return initialize_extra_account_meta_list(program_id, accounts);
    }
    match data.first() {
        Some(0) => initialize_extra_account_meta_list(program_id, accounts),
        Some(1) => initialize_config(program_id, accounts, data),
        Some(2) => update_config(program_id, accounts, data),
        Some(3) => initialize_holder(program_id, accounts),
        Some(4) => sync_registered(program_id, accounts, data),
        Some(5) => crank_price(program_id, accounts),
        Some(6) => initialize_price_feed(program_id, accounts, data),
        Some(7) => sync_gate_balance(program_id, accounts),
        Some(8) => crank_price_dbc(program_id, accounts),
        Some(9) => refresh_extra_account_metas(program_id, accounts),
        Some(10) => migrate_holder(program_id, accounts),
        Some(11) => sync_holder(program_id, accounts),
        Some(12) => set_blocklist(program_id, accounts, data),
        Some(13) => set_allowlist_entry(program_id, accounts, data),
        Some(14) => activate_house(program_id, accounts, data),
        Some(15) => crank_price_deep(program_id, accounts),
        Some(16) => deposit_house_fees(program_id, accounts, data),
        Some(17) => record_house_reserve(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ---------- InitializeExtraAccountMetas ----------
// Accounts: [payer(signer,w), meta_list_pda(w), mint, system, config(ro)]
// The meta list is TEMPLATED from the loaded config's enabled rules via
// `required_extras` (classification table at that helper): canonical order
// preserved as a subsequence of the legacy 7-extra superset tail:
//   0 config PDA        seeds ["config", mint]                                  ro
//   1 source holder PDA seeds ["holder", mint, SOURCE token acct key] (v3)       w
//   2 dest holder PDA   seeds ["holder", mint, DEST token acct key]   (v3)       w
//   3 rent vault PDA    seeds ["rentvault", mint]  (bare address, lazy-create)  w
//   4 price feed PDA    seeds ["price", mint]                                   ro
//   5 system program    literal                                                 ro
//   6 instructions sysvar literal (caller validation)                           ro
// A config update that changes the required set desyncs this list by
// design; RefreshExtraAccountMetas (tag 9) is the repair, and Execute
// fails closed (MissingExtra) in the gap — never under-enforces.
fn initialize_extra_account_meta_list(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let meta_list = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let system = next_account_info(it)?;
    let config_ai = next_account_info(it)?;

    if *meta_list.key != meta_list_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if meta_list.data_len() > 0 {
        return Err(EngineError::AlreadyInit.into());
    }
    // Config must exist first (launch order: config -> meta list). The config
    // account itself is validated structurally here; rule contents are the
    // config instructions' concern.
    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let cfg = load_config(config_ai, program_id)?;

    let metas = build_metas(required_extras(&cfg.rules))?;

    let size = ExtraAccountMetaList::size_of(metas.len())?;
    let rent = Rent::get()?.minimum_balance(size);
    let (_, bump) = Pubkey::find_program_address(&[b"extra-account-metas", mint.key.as_ref()], program_id);
    invoke_signed(
        &system_instruction::create_account(payer.key, meta_list.key, rent, size as u64, program_id),
        &[payer.clone(), meta_list.clone(), system.clone()],
        &[&[b"extra-account-metas", mint.key.as_ref(), &[bump]]],
    )?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut meta_list.try_borrow_mut_data()?, &metas)?;
    msg!("engine: extra account meta list initialized ({} metas, templated mask {:#013b})", metas.len(), required_extras(&cfg.rules));
    Ok(())
}

// ---------- RefreshExtraAccountMetas (tag 9) ----------
// Accounts: [payer(signer,w), meta_list_pda(w), mint, config(ro), system]
// THE DESYNC REPAIR. Recomputes the published set from the CURRENT config
// (via `required_extras`) and rewrites the meta list account in place,
// then settles rent NEUTRALLY: the account ends exactly rent-exempt for
// its final size — the payer funds any shortfall with a plain transfer
// inside this instruction and any excess is refunded to the payer.
// Permissionless apart from the payer signature for funding: the
// rewritten contents are a pure function of the on-chain config, so no
// caller can steer them.
//
// ORDER IS LOAD-BEARING (the 2026-10-16 deploy-window bug): the TLV
// entry is rewritten via ExtraAccountMetaList::update BEFORE the
// account is shrunk. update() unpacks the TLV state, which validates
// the entry's DECLARED length against the buffer; shrinking the account
// first truncates the buffer under a still-large declared length
// (launch-era 261 B lists declare 249), the unpack returns
// InvalidAccountData, and the library's unwrap turned that into an SBF
// panic — the v3 window's tag-9 flip died in simulation on exactly
// this. Correct order per case:
//   shrink / same size: update() first (its internal realloc_first
//     rewrites the entry length in place and zeroes the tail), then
//     realloc the account down to size_of.
//   grow: realloc the account up first (zero-filled tail; the intact
//     entry plus trailing zeros stays a valid TLV buffer), then
//     update() writes the larger entry.
fn refresh_extra_account_metas(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let meta_list = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    if *meta_list.key != meta_list_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if meta_list.data_len() == 0 || meta_list.owner != program_id {
        msg!("engine: refresh on a missing/foreign meta list");
        return Err(EngineError::BadState.into());
    }
    let cfg = load_config(config_ai, program_id)?;
    let metas = build_metas(required_extras(&cfg.rules))?;
    let new_size = ExtraAccountMetaList::size_of(metas.len())?;
    let old_size = meta_list.data_len();
    if new_size > old_size {
        meta_list.realloc(new_size, true)?;
    }
    ExtraAccountMetaList::update::<ExecuteInstruction>(&mut meta_list.try_borrow_mut_data()?, &metas)?;
    if new_size < old_size {
        meta_list.realloc(new_size, false)?;
    }
    // Rent settle: exact rent-exemption for the FINAL size, either way.
    let rent_needed = Rent::get()?.minimum_balance(new_size);
    let bal = meta_list.lamports();
    if bal < rent_needed {
        let diff = rent_needed - bal;
        invoke_signed(
            &system_instruction::transfer(payer.key, meta_list.key, diff),
            &[payer.clone(), meta_list.clone(), system.clone()],
            &[],
        )?;
    } else if bal > rent_needed {
        let excess = bal - rent_needed;
        **meta_list.try_borrow_mut_lamports()? = rent_needed;
        **payer.try_borrow_mut_lamports()? += excess;
    }
    msg!("engine: extra account meta list refreshed ({} metas, templated mask {:#013b})", metas.len(), required_extras(&cfg.rules));
    Ok(())
}

// ---------- InitializeConfig ----------
// Accounts: [payer(signer,w), mint, config_pda(w), system,
//            house_vault_pda(w) — REQUIRED iff the payload carries a house
//            block, ignored otherwise]; data = payload (see above).
// Phase C: a house-committed payload creates the config at
// CONFIG_SPACE_V2 (1152) with house_state = 1 (pending) and creates the
// HouseVault PDA in the same instruction (payer-funded); a non-house
// payload creates the config at CONFIG_SPACE exactly as before.
fn initialize_config(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;
    let system = next_account_info(it)?;
    let house_vault_ai = next_account_info(it).ok(); // Phase C, house payloads only

    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if config_ai.data_len() > 0 {
        return Err(EngineError::AlreadyInit.into());
    }
    let payload = parse_config_payload(data, program_id)?;
    let size = if payload.house.is_some() { CONFIG_SPACE_V2 } else { CONFIG_SPACE };
    create_pda(program_id, payer, config_ai, system, &[b"config", mint.key.as_ref()], size)?;
    let slot = Clock::get()?.slot;
    {
        let mut d = config_ai.try_borrow_mut_data()?;
        for b in d.iter_mut() {
            *b = 0;
        }
        write_config(&mut *d, &payload, mint.key, slot);
        if payload.house.is_some() {
            // write_config never writes activation state; init sets the
            // pending byte itself on the fresh account.
            d[HOUSE_STATE_OFF] = 1;
        }
    }
    if payload.house.is_some() {
        let vault_ai = house_vault_ai.ok_or(ProgramError::NotEnoughAccountKeys)?;
        if *vault_ai.key != housevault_pda(mint.key, program_id) {
            return Err(ProgramError::InvalidSeeds);
        }
        if vault_ai.data_len() > 0 {
            return Err(EngineError::AlreadyInit.into());
        }
        create_pda(program_id, payer, vault_ai, system, &[b"housevault", mint.key.as_ref()], HOUSEVAULT_SPACE)?;
        let mut d = vault_ai.try_borrow_mut_data()?;
        for b in d.iter_mut() {
            *b = 0;
        }
        d[0] = 1; // HouseVault tag; counters start at zero (offsets below)
        msg!("engine: house vault created for {} (house program {})", mint.key, payload.house.unwrap().program);
    }
    msg!("engine: config initialized (mode {}, {} rules)", payload.authority_mode, payload.rules.len());
    Ok(())
}

// ---------- UpdateConfig ----------
// Accounts: [authority(signer), mint, config_pda(w)]; data = payload.
// Gating per mode (spec SS2.2/SS5): Locked rejects all writes; Creator/Agent
// require signer == config.authority; HolderVote writes arrive via the vote
// program (later workstream) — direct updates fail UnsupportedMode here.
fn update_config(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;

    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let existing = load_config(config_ai, program_id)?;
    if existing.mint != *mint.key {
        return Err(EngineError::BadConfig.into());
    }
    match existing.authority_mode {
        MODE_LOCKED => {
            msg!("engine: update rejected — config is Locked");
            return Err(EngineError::ConfigLocked.into());
        }
        MODE_CREATOR | MODE_AGENT => {
            if !authority.is_signer || *authority.key != existing.authority {
                return Err(EngineError::BadAuthority.into());
            }
        }
        MODE_HOLDER_VOTE => {
            msg!("engine: HolderVote config writes need the vote program");
            return Err(EngineError::UnsupportedMode.into());
        }
        _ => return Err(EngineError::BadConfig.into()),
    }
    let payload = parse_config_payload(data, program_id)?;
    // Phase C: the house commitment is INIT-ONLY and immutable under every
    // authority mode. A stored commitment cannot be added to, removed, or
    // altered by an update — any mismatch in either direction rejects.
    match (&existing.house, &payload.house) {
        (None, Some(_)) => {
            msg!("engine: update rejected — a house commitment cannot be added after init");
            return Err(ProgramError::InvalidInstructionData);
        }
        (Some(_), None) => {
            msg!("engine: update rejected — a stored house commitment cannot be removed");
            return Err(ProgramError::InvalidInstructionData);
        }
        (Some(stored), Some(new)) => {
            if stored.program != new.program
                || stored.threshold_lamports != new.threshold_lamports
                || stored.reserve_lamports != new.reserve_lamports
            {
                msg!("engine: update rejected — the house commitment (program/threshold/reserve) is immutable");
                return Err(ProgramError::InvalidInstructionData);
            }
        }
        (None, None) => {}
    }
    // DESYNC RULE (meta-list templating): if the new rule set's required
    // extras are NOT a subset of the old set's, the published meta list no
    // longer covers the config. The update is still allowed — but the
    // operator MUST run RefreshExtraAccountMetas (tag 9) before transfers
    // that need the new extras can work; until then Execute fails closed
    // with MissingExtra (26) on exactly those transfers (transfers that
    // only need the old extras keep working — Execute accepts any
    // subsequence of the canonical 7 that covers the required set, and
    // clients may also append the missing extras manually). Client update
    // paths must therefore bundle UpdateConfig + Refresh in one flow
    // (launcher/hook.mjs has no config-update path today — see
    // BUILD-NOTES Phase 2 addendum).
    let old_mask = required_extras(&existing.rules);
    let new_mask = required_extras(&payload.rules);
    if new_mask & !old_mask != 0 {
        msg!(
            "engine: config update expands required extras (mask {:#013b} -> {:#013b}) — RefreshExtraAccountMetas (tag 9) must follow; Execute fails closed with MissingExtra meanwhile",
            old_mask, new_mask
        );
    }
    // created_slot is preserved across updates.
    let created_slot = {
        let d = config_ai.try_borrow_data()?;
        read_u64(&d, 68)
    };
    // Phase C: the stored house activation state + ts survive the zeroing
    // pass below (same discipline as created_slot) — write_config writes
    // only the static house fields, never activation state.
    let stored_house_state = existing.house.map(|h| (h.state, h.activated_ts));
    let mut d = config_ai.try_borrow_mut_data()?;
    for b in d.iter_mut() {
        *b = 0;
    }
    write_config(&mut *d, &payload, mint.key, created_slot);
    if let Some((state, ts)) = stored_house_state {
        d[HOUSE_TS_OFF..HOUSE_TS_OFF + 8].copy_from_slice(&ts.to_le_bytes());
        d[HOUSE_STATE_OFF] = state;
    }
    msg!("engine: config updated ({} rules)", payload.rules.len());
    Ok(())
}

// ---------- InitializeHolder ----------
// Accounts: [payer(signer,w), mint, token_account(ro), holder_pda(w), system]
// v3 RETARGET: the record is keyed by the TOKEN ACCOUNT (account 2), not
// by its owner. The token account need not exist yet — pre-creating the
// record for a known address (e.g. a wallet's ATA, computable offline)
// is the canonical use; when the account DOES exist, its mint field
// must match (a record for a foreign mint's account is meaningless).
fn initialize_holder(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let token_account = next_account_info(it)?;
    let holder_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    if *holder_ai.key != holder_pda(mint.key, token_account.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if token_account.data_len() > 0 && token_mint(token_account)? != *mint.key {
        msg!("engine: initialize holder: token account is for a different mint");
        return Err(ProgramError::InvalidAccountData);
    }
    if holder_ai.data_len() > 0 {
        return Err(EngineError::AlreadyInit.into());
    }
    create_pda(program_id, payer, holder_ai, system, &[b"holder", mint.key.as_ref(), token_account.key.as_ref()], HOLDER_SPACE)?;
    init_holder_data(holder_ai)?;
    msg!("engine: holder PDA initialized for token account {}", token_account.key);
    Ok(())
}

// ---------- SyncRegistered (Registry integration — registry/INTEGRATION.md) ----------
// Accounts: [caller(signer,w), mint, config(ro), owner(ro), holder_pda(w),
//            system, registration_pda(ro) OPTIONAL at index 6]
// Data: [4][registered u8 — path (a) only; ignored under path (b)]
//       [ecosystem u8 OPTIONAL — path (a) only; ignored under path (b)]
//
// The Registry program is the source of truth for Agent-Only; the Holder
// PDA `registered` byte is an execution-layer MIRROR of the Registration
// PDA's `active` byte, and its `ecosystem` byte (Holder byte 2) likewise
// mirrors the Registration PDA's ecosystem byte for the Ecosystem Gate
// (rule 17). (Direct read in Execute is impossible: extra-account
// resolution derives seed-based accounts under the HOOK program's id, so a
// PDA of the REGISTRY program can never appear in the meta tail.) Two
// authorization paths, exactly per INTEGRATION.md:
//   (a) no registration account appended: signer must be the config
//       authority; byte 1 := data[1], byte 2 := data[2] (0 if absent).
//       (Launch/trial flows.)
//   (b) registration account appended at index 6: ANY caller may sync. The
//       account must validate — key == PDA(["registration", owner],
//       REGISTRY_ID), owner == REGISTRY_ID, tag == 1, wallet field == owner
//       — and byte 1 := (active == 1), byte 2 := the registration's
//       ecosystem byte. data bytes are ignored. An appended but
//       invalid registration account FAILS the instruction (no silent
//       fall-back to path (a)). Consistency is re-checked here, not
//       trusted: a nonzero ecosystem byte on a record whose verified_via
//       is not ATTESTED (registry byte 34 != 1) fails BadRegistration —
//       only the registry can write such accounts, and it never writes
//       that combination, so seeing it means a corrupt/foreign account.
// Creates the Holder PDA if missing (caller pays).
// v3 RETARGET: registration remains a WALLET property (the Registration
// PDA is still keyed by owner, both authorization paths unchanged), but
// the MIRROR lands in the record Execute reads for the account that
// will receive — the owner's canonical ATA for this mint, derived here
// from (owner, the mint's token program, mint). A receive into a
// NON-ATA account of a synced wallet therefore reads an empty record
// and fails closed until that account gets its own record (its first
// Execute touch creates it unregistered; SyncHolder can merge records
// across the owner's accounts) — SPEC-ENGINE-V3 SS9.2(iii).
fn sync_registered(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let caller = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;
    let owner = next_account_info(it)?;
    let holder_ai = next_account_info(it)?;
    let system = next_account_info(it)?;
    let registration_ai = next_account_info(it).ok(); // optional, index 6

    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let cfg = load_config(config_ai, program_id)?;
    let ata = ata_pda(owner.key, mint.owner, mint.key);
    if *holder_ai.key != holder_pda(mint.key, &ata, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }

    let (value, eco_value): (u8, u8) = match registration_ai {
        Some(reg) => {
            // Path (b): validate the Registration PDA strictly.
            let expect = Pubkey::find_program_address(
                &[b"registration", owner.key.as_ref()],
                &registry_id(),
            )
            .0;
            if *reg.key != expect || *reg.owner != registry_id() {
                msg!("engine: bad registration account");
                return Err(EngineError::BadRegistration.into());
            }
            let d = reg.try_borrow_data()?;
            if d.len() < 44 || d[0] != 1 || read_key(&d, 1) != *owner.key {
                msg!("engine: bad registration account");
                return Err(EngineError::BadRegistration.into());
            }
            let active = if d[43] == 1 { 1 } else { 0 };
            // Ecosystem byte (registry byte 44). Records shorter than 45
            // bytes predate the field and read as ECO_NONE; a nonzero byte
            // must ride on an ATTESTED record (verified_via == 1).
            let eco = if d.len() >= 45 {
                let e = d[44];
                if e != 0 && d[34] != 1 {
                    msg!("engine: bad registration account (tag without attestation)");
                    return Err(EngineError::BadRegistration.into());
                }
                e
            } else {
                0
            };
            (active, eco)
        }
        None => {
            // Path (a): config authority sets the flags directly.
            if !caller.is_signer || *caller.key != cfg.authority {
                return Err(EngineError::BadAuthority.into());
            }
            let reg_byte = if data.get(1) == Some(&1) { 1 } else { 0 };
            let eco_byte = data.get(2).copied().unwrap_or(0);
            (reg_byte, eco_byte)
        }
    };

    if holder_ai.data_len() == 0 {
        create_pda(program_id, caller, holder_ai, system, &[b"holder", mint.key.as_ref(), ata.as_ref()], holder_create_size(&cfg))?;
        init_holder_data(holder_ai)?;
    } else if holder_ai.owner != program_id {
        return Err(EngineError::BadState.into());
    }
    let mut d = holder_ai.try_borrow_mut_data()?;
    if d.len() < HOLDER_SPACE || d[0] != 1 {
        return Err(EngineError::BadState.into());
    }
    d[1] = value;
    d[2] = eco_value;
    msg!("engine: registered={} ecosystem={} for {} (ATA record {})", value, eco_value, owner.key, ata);
    Ok(())
}

// ---------- InitializePriceFeed ----------
// Accounts: [payer(signer,w), mint, config(ro), price_feed_pda(w), system]
// Data: [6][pool 32][token_vault 32][quote_vault 32][token_dec u8][quote_dec u8]
// The feed starts uncranked (ema 0, last_crank_ts 0): price rules fail
// closed on staleness until the first crank lands.
fn initialize_price_feed(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;
    let feed_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    if data.len() < 1 + 96 + 2 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let _ = load_config(config_ai, program_id)?; // config must exist (launch order)
    if *feed_ai.key != price_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if feed_ai.data_len() > 0 {
        return Err(EngineError::AlreadyInit.into());
    }
    // token_dec must match the mint's own decimals byte (mint layout @44).
    let mint_dec = {
        let d = mint.try_borrow_data()?;
        if d.len() < 45 {
            return Err(ProgramError::InvalidAccountData);
        }
        d[44]
    };
    if data[97] != mint_dec {
        msg!("engine: feed token_dec {} != mint decimals {}", data[97], mint_dec);
        return Err(ProgramError::InvalidInstructionData);
    }
    create_pda(program_id, payer, feed_ai, system, &[b"price", mint.key.as_ref()], FEED_SPACE)?;
    let mut d = feed_ai.try_borrow_mut_data()?;
    for b in d.iter_mut() {
        *b = 0;
    }
    d[0] = 1;
    d[1..97].copy_from_slice(&data[1..97]); // pool, token_vault, quote_vault
    d[129] = data[97];
    d[130] = data[98];
    msg!("engine: price feed initialized for {}", mint.key);
    Ok(())
}

/// Vault-ratio spot (tag 5's math, factored for tag 15's house leg):
/// spot = quote per whole token, PRICE_SCALE fixed point:
///   quote * SCALE * 10^token_dec / (token * 10^quote_dec)
/// operation order chosen to bound u128 headroom, exactly as tag 5 did it.
fn vault_spot(tok_amt: u128, quote_amt: u128, token_dec: u8, quote_dec: u8) -> Result<u128, ProgramError> {
    if tok_amt == 0 {
        return Err(EngineError::PriceFeedBad.into());
    }
    let base = quote_amt
        .checked_mul(PRICE_SCALE)
        .ok_or(EngineError::MathOverflow)?;
    let (num, den) = if token_dec >= quote_dec {
        (
            base.checked_mul(10u128.pow((token_dec - quote_dec) as u32))
                .ok_or(EngineError::MathOverflow)?,
            tok_amt,
        )
    } else {
        (
            base,
            tok_amt
                .checked_mul(10u128.pow((quote_dec - token_dec) as u32))
                .ok_or(EngineError::MathOverflow)?,
        )
    };
    Ok(num / den)
}

/// DBC curve spot (tag 8's decomposed sqrt square, factored for tag 15's
/// curve leg): spot = (sqrt_price^2 / 2^128) * PRICE_SCALE *
/// 10^(token_dec - quote_dec), with the v4 decomposition so no
/// intermediate exceeds u128 (see crank_price_dbc's header).
fn dbc_spot(sqrt_price: u128, token_dec: u8, quote_dec: u8) -> Result<u128, ProgramError> {
    // Decomposed square (v4 fix): s = a*2^64 + f.
    let a = sqrt_price >> 64;
    let f = sqrt_price & ((1u128 << 64) - 1);
    // term1 = a^2 * SCALE              (a < 2^33 on any DBC pool)
    let term1 = a
        .checked_mul(a)
        .and_then(|v| v.checked_mul(PRICE_SCALE))
        .ok_or(EngineError::MathOverflow)?;
    // term2 = (2af / 2^64) * SCALE, remainder carried piecewise:
    //   t = 2af (< 2^98); (t >> 64) * SCALE + ((t mod 2^64) * SCALE) >> 64
    let t = a
        .checked_mul(f)
        .and_then(|v| v.checked_mul(2))
        .ok_or(EngineError::MathOverflow)?;
    let t_hi = t >> 64;
    let t_lo = t & ((1u128 << 64) - 1);
    let term2 = (t_hi.checked_mul(PRICE_SCALE).ok_or(EngineError::MathOverflow)?)
        .checked_add((t_lo.checked_mul(PRICE_SCALE).ok_or(EngineError::MathOverflow)?) >> 64)
        .ok_or(EngineError::MathOverflow)?;
    // term3 = (f^2 / 2^128) * SCALE = ((f^2 >> 64) * SCALE) >> 64
    // (f^2 < 2^128 always: (2^64-1)^2 < u128::MAX).
    let term3 = ((f
        .checked_mul(f)
        .ok_or(EngineError::MathOverflow)?
        >> 64)
        .checked_mul(PRICE_SCALE)
        .ok_or(EngineError::MathOverflow)?)
        >> 64;
    let c = term1
        .checked_add(term2)
        .and_then(|v| v.checked_add(term3))
        .ok_or(EngineError::MathOverflow)?;
    if token_dec >= quote_dec {
        c.checked_mul(10u128.pow((token_dec - quote_dec) as u32))
            .ok_or(EngineError::MathOverflow.into())
    } else {
        Ok(c / 10u128.pow((quote_dec - token_dec) as u32))
    }
}

// ---------- CrankPrice (permissionless) ----------
// Accounts: [config(ro), price_feed(w), token_vault(ro), quote_vault(ro)]
// Spot is read from the feed's PINNED vault balances (TH crank — the price
// is only as manipulable as real liquidity), then folded into the EMA with
// the Basis Latch rule's params (half-life step + per-update clamp). Any
// caller may crank; nobody can inject a price. For DBC venues the vault
// ratio is not the curve spot — use CrankPriceDbc (tag 8) there; this
// crank serves constant-product venues (house swap, DAMM-style vault
// pairs).
fn crank_price(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let config_ai = next_account_info(it)?;
    let feed_ai = next_account_info(it)?;
    let tok_vault = next_account_info(it)?;
    let quote_vault = next_account_info(it)?;

    let cfg = load_config(config_ai, program_id)?;
    if *feed_ai.key != price_pda(&cfg.mint, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let feed = load_feed(feed_ai, program_id)?;
    if *tok_vault.key != feed.token_vault || *quote_vault.key != feed.quote_vault {
        msg!("engine: crank accounts are not the feed's pinned vaults");
        return Err(EngineError::PriceFeedBad.into());
    }
    let tok_amt = token_amount(tok_vault)? as u128;
    let quote_amt = token_amount(quote_vault)? as u128;
    // spot = quote per whole token, PRICE_SCALE fixed point (TH formula) —
    // factored into vault_spot (tag 15's house leg reuses the same math).
    let spot = vault_spot(tok_amt, quote_amt, feed.token_dec, feed.quote_dec)?;

    let (half_life, max_bps) = ema_params(&cfg);
    let now = Clock::get()?.unix_timestamp;
    let new_ema = ema_fold(&feed, half_life, max_bps, spot, now);
    write_crank(feed_ai, new_ema, now)?;
    msg!("engine: crank spot {} ema {} ts {}", spot, new_ema, now);
    Ok(())
}

/// EMA discipline shared by every crank variant (TH): half-life step toward
/// spot + per-update clamp, both parameterized by the Basis Latch rule entry.
/// EMA params ride on the (first enabled) Basis Latch rule entry; absent one,
/// the fold is an immediate, unclamped take of spot.
fn ema_params(cfg: &Config) -> (u64, u16) {
    match cfg
        .rules
        .iter()
        .find(|r| r.enabled && r.rule_id == RULE_BASIS_LATCH)
    {
        Some(r) => {
            let hl = read_u64(&r.params, 8);
            let bps = read_u16(&r.params, 16);
            (hl, if bps == 0 { 10_000 } else { bps })
        }
        None => (0, 10_000),
    }
}

fn ema_fold(feed: &PriceFeed, half_life: u64, max_bps: u16, spot: u128, now: i64) -> u128 {
    if feed.last_crank_ts == 0 || feed.ema_price == 0 {
        return spot; // first crank takes spot (TH)
    }
    let ema = feed.ema_price;
    let elapsed = (now - feed.last_crank_ts).max(1) as u128;
    let frac_bps: u128 = if half_life == 0 {
        10_000
    } else {
        ((elapsed * 10_000) / (half_life.max(1) as u128)).min(10_000)
    };
    let delta = ((spot as i128) - (ema as i128)) * (frac_bps as i128) / 10_000;
    let mut cand = ((ema as i128) + delta).max(0) as u128;
    let max_move = ema * (max_bps as u128) / 10_000;
    if cand > ema + max_move {
        cand = ema + max_move;
    } else if cand + max_move < ema {
        cand = ema.saturating_sub(max_move);
    }
    cand
}

fn write_crank(feed_ai: &AccountInfo, new_ema: u128, now: i64) -> ProgramResult {
    let mut d = feed_ai.try_borrow_mut_data()?;
    d[97..113].copy_from_slice(&new_ema.to_le_bytes());
    d[113..121].copy_from_slice(&now.to_le_bytes());
    let count = read_u64(&d, 121);
    d[121..129].copy_from_slice(&(count + 1).to_le_bytes());
    Ok(())
}

// ---------- CrankPriceDbc (permissionless) ----------
// Accounts: [config(ro), price_feed(w), dbc_pool(ro)]
// The DBC variant of the crank. A bonding curve's vault balances are NOT
// its price (the base vault holds the whole supply incl. vesting/leftover,
// the quote vault is drained by fee claims); the curve's spot lives in the
// pool state's `sqrt_price` (Q64.64) — equivalently, in the curve's implied
// virtual reserves at the current point (L/sqrt_P base, L*sqrt_P quote,
// whose ratio is exactly sqrt_price^2 / 2^128). The pinned DBC program
// stores no literal virtual_*_reserves fields (see BUILD-NOTES deviation).
// Spot uses the SAME convention as the vault crank — quote per whole token
// in PRICE_SCALE fixed point:
//   spot = (sqrt_price^2 / 2^128) * PRICE_SCALE * 10^(token_dec - quote_dec)
//
// v4 FIX (2026-10-19 — the HARVEST EVER overflow): the v3 form squared
// sqrt_price in u128 (`sq = s*s`), which overflows for every s > 2^64 —
// i.e. every pool whose raw sqrt price exceeds 1.0. A `never`-curve's
// sqrt_start_price is ~75.93 (Q64.64), so CrankPriceDbc on EVER failed
// deterministically with Custom 11 (MathOverflow) and the launch died at
// its first crank. The square is now DECOMPOSED (see the body): with
// s = a*2^64 + f, s^2/2^128 = a^2 + (2af)/2^64 + f^2/2^128, and each term
// is scaled by PRICE_SCALE with its division applied piecewise, so no
// intermediate exceeds u128 for any sqrt_price a DBC pool can hold
// (DBC's own MAX_SQRT_PRICE < 2^97 bounds a < 2^33); checked arithmetic
// still fails closed beyond that. Per-term floor losses total < 4 spot
// units (1 unit = 1e-12 quote) — deterministic, and replicated term-for-
// term by the integration trial and the launcher pre-flight.
// Fail closed (PriceFeedBad) on: feed not pinned to this pool, pool not
// owned by the DBC program, malformed pool state (length / base_mint
// mismatch), or a zero price.
fn crank_price_dbc(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let config_ai = next_account_info(it)?;
    let feed_ai = next_account_info(it)?;
    let pool_ai = next_account_info(it)?;

    let cfg = load_config(config_ai, program_id)?;
    if *feed_ai.key != price_pda(&cfg.mint, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let feed = load_feed(feed_ai, program_id)?;
    if feed.pool != *pool_ai.key {
        msg!("engine: dbc crank pool is not the feed's pinned pool");
        return Err(EngineError::PriceFeedBad.into());
    }
    if *pool_ai.owner != dbc_id() {
        msg!("engine: dbc crank account is not a DBC pool (owner)");
        return Err(EngineError::PriceFeedBad.into());
    }
    let sqrt_price = {
        let d = pool_ai.try_borrow_data()?;
        if d.len() != DBC_POOL_SPACE || read_key(&d, DBC_POOL_OFF_BASE_MINT) != cfg.mint {
            msg!("engine: dbc crank pool state malformed for this mint");
            return Err(EngineError::PriceFeedBad.into());
        }
        read_u128(&d, DBC_POOL_OFF_SQRT_PRICE)
    };
    if sqrt_price == 0 {
        return Err(EngineError::PriceFeedBad.into());
    }
    let spot = dbc_spot(sqrt_price, feed.token_dec, feed.quote_dec)?;
    if spot == 0 {
        return Err(EngineError::PriceFeedBad.into());
    }

    let (half_life, max_bps) = ema_params(&cfg);
    let now = Clock::get()?.unix_timestamp;
    let new_ema = ema_fold(&feed, half_life, max_bps, spot, now);
    write_crank(feed_ai, new_ema, now)?;
    msg!("engine: crank(dbc) spot {} ema {} ts {}", spot, new_ema, now);
    Ok(())
}


// ---------- Phase C: HouseVault + house activation ----------
// HouseVault PDA (seeds ["housevault", mint], HOUSEVAULT_SPACE = 128):
//   [0]        tag u8 = 1
//   [1..9]     reserve_balance u64 (accounting mirror of committed-reserve
//              deposits, recorded by tag 17)
//   [9..17]    fee_balance u64 (accounting mirror of fee deposits, tag 16)
//   [17..25]   cut_paid_total u64 (cumulative ActivateHouse caller cuts)
//   [25..33]   seeded_total u64 (cumulative seed moved at activation)
//   [33..128]  reserved (zeros)
// Lamport invariant: vault.lamports == rent_min(128) + reserve_balance +
// fee_balance at all times after init. The vault is engine-owned, so
// lamports leave it by direct debit/credit (the only mechanism the runtime
// allows for program-owned accounts — a system-program transfer CPI from
// a non-system-owned account cannot succeed), signed by this program's
// ownership of the PDA rather than a CPI signature.
fn load_house_vault(ai: &AccountInfo, mint: &Pubkey, program_id: &Pubkey) -> Result<(u64, u64), ProgramError> {
    if *ai.key != housevault_pda(mint, program_id) || ai.owner != program_id {
        return Err(EngineError::BadState.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < HOUSEVAULT_SPACE || d[0] != 1 {
        return Err(EngineError::BadState.into());
    }
    Ok((read_u64(&d, 1), read_u64(&d, 9)))
}

/// Move lamports out of an engine-owned PDA to another account (direct
/// debit/credit — see the HouseVault note above).
fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    **from.try_borrow_mut_lamports()? = from
        .lamports()
        .checked_sub(amount)
        .ok_or(EngineError::MathOverflow)?;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(EngineError::MathOverflow)?;
    Ok(())
}

/// A token account of `expect_mint` whose owner field is `expect_owner`
/// (the ActivateHouse / CrankPriceDeep vault check, contract step 3).
/// Any structural failure maps to BadState.
fn check_pool_vault(ai: &AccountInfo, expect_mint: &Pubkey, expect_owner: &Pubkey) -> ProgramResult {
    let ok = matches!(token_mint(ai), Ok(m) if m == *expect_mint)
        && matches!(token_owner(ai), Ok(o) if o == *expect_owner);
    if ok {
        Ok(())
    } else {
        Err(EngineError::BadState.into())
    }
}

/// Validate a house pool account against the slot + mint (contract 1.4
/// step 2): address == PDA(["pool", mint], house_program), owner == the
/// house program, len >= 264, tag byte 1, mint field @33, committed byte
/// @162 == 1. Returns (token_vault, quote_vault, fee_accrued_quote) read
/// from the pool record. Every failure is HouseNotCommitted (34).
fn read_house_pool(ai: &AccountInfo, mint: &Pubkey, slot: &HouseSlot) -> Result<(Pubkey, Pubkey, u64), ProgramError> {
    let bad = || -> ProgramError { EngineError::HouseNotCommitted.into() };
    if *ai.key != house_pool_pda(mint, &slot.program) || *ai.owner != slot.program {
        return Err(bad());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < 264 || d[0] != 1 || read_key(&d, 33) != *mint || d[162] != 1 {
        return Err(bad());
    }
    Ok((read_key(&d, 97), read_key(&d, 129), read_u64(&d, 202)))
}

// ---------- DepositHouseFees (tag 16) ----------
// Accounts: [payer(signer,w), mint, config(ro), house_vault(w), system]
// Data: [16][amount u64]
// The pre-activation fee seed: the instruction performs the system
// transfer payer -> house vault itself (the payer signs), then mirrors
// it into fee_balance. One-shot by construction: the slot must be
// pending (state 1); after activation deposits reject AlreadyInit —
// later fees route normally, not through here.
fn deposit_house_fees(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;
    let vault_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    if data.len() < 9 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = read_u64(data, 1);
    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let cfg = load_config(config_ai, program_id)?;
    if cfg.mint != *mint.key {
        return Err(EngineError::BadConfig.into());
    }
    let slot = cfg.house.ok_or(EngineError::HouseNotCommitted)?;
    if slot.state == 2 {
        msg!("engine: house fee deposit rejected — house already activated (seed is one-shot)");
        return Err(EngineError::AlreadyInit.into());
    }
    if slot.state != 1 {
        return Err(EngineError::HouseNotCommitted.into());
    }
    let (_reserve, fee) = load_house_vault(vault_ai, mint.key, program_id)?;
    invoke(
        &system_instruction::transfer(payer.key, vault_ai.key, amount),
        &[payer.clone(), vault_ai.clone(), system.clone()],
    )?;
    let mut d = vault_ai.try_borrow_mut_data()?;
    let new_fee = fee.checked_add(amount).ok_or(EngineError::MathOverflow)?;
    d[9..17].copy_from_slice(&new_fee.to_le_bytes());
    msg!("engine: house fees deposited {} (fee_balance {})", amount, new_fee);
    Ok(())
}

// ---------- RecordHouseReserve (tag 17) ----------
// Accounts: [authority(signer), mint, config(ro), house_vault(w)]
// Data: [17]
// Bookkeeping for the committed reserve: the launcher moves the SOL with
// a plain transfer FIRST; this instruction (config-authority signed —
// under Locked configs the authority is the launcher wallet, which can
// sign; this changes no rule) verifies the lamports actually landed and
// mirrors them into reserve_balance. One-way: a repeat call with
// reserve_balance already == the commitment is a no-op success.
fn record_house_reserve(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;
    let vault_ai = next_account_info(it)?;

    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let cfg = load_config(config_ai, program_id)?;
    if cfg.mint != *mint.key {
        return Err(EngineError::BadConfig.into());
    }
    if !authority.is_signer || *authority.key != cfg.authority {
        return Err(EngineError::BadAuthority.into());
    }
    let slot = cfg.house.ok_or(EngineError::HouseNotCommitted)?;
    let (reserve, fee) = load_house_vault(vault_ai, mint.key, program_id)?;
    if reserve == slot.reserve_lamports {
        msg!("engine: house reserve already recorded ({}) — no-op", reserve);
        return Ok(());
    }
    // The plain transfer must have landed: lamports above rent and above
    // the (separately accounted) fee balance must cover the commitment.
    let rent_min = Rent::get()?.minimum_balance(HOUSEVAULT_SPACE);
    let landed = vault_ai
        .lamports()
        .saturating_sub(rent_min)
        .saturating_sub(fee);
    if landed < slot.reserve_lamports {
        msg!("engine: house reserve not landed ({} of {} lamports above rent+fees)", landed, slot.reserve_lamports);
        return Err(EngineError::HouseNotReady.into());
    }
    let mut d = vault_ai.try_borrow_mut_data()?;
    d[1..9].copy_from_slice(&slot.reserve_lamports.to_le_bytes());
    msg!("engine: house reserve recorded {} for {}", slot.reserve_lamports, mint.key);
    Ok(())
}

// ---------- ActivateHouse (tag 14) — the commitment flip ----------
// Accounts: [caller(signer), mint(ro), config(w), dbc_pool(ro),
//            house_vault(w), house_pool(ro), house_token_vault(ro),
//            house_quote_vault(ro), system(ro),
//            token_program(ro — the LEGACY token program, for SyncNative)]
// Permissionless: anyone may flip a house whose on-chain conditions are
// met, and the caller is paid a 100 bps cut of the vault's fee balance
// for doing it. Checks run in the contract's order (1.4 steps 1-7);
// effects are direct field writes into the config account — never a
// full rewrite — so nothing outside venues/exemptions/the house region
// can move.
fn activate_house(program_id: &Pubkey, accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let caller = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;
    let dbc_pool = next_account_info(it)?;
    let vault_ai = next_account_info(it)?;
    let house_pool = next_account_info(it)?;
    let house_token_vault = next_account_info(it)?;
    let house_quote_vault = next_account_info(it)?;
    let _system = next_account_info(it)?;
    let token_program = next_account_info(it)?;

    // 1. Config + slot + pending state.
    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let cfg = load_config(config_ai, program_id)?;
    if cfg.mint != *mint.key {
        return Err(EngineError::BadConfig.into());
    }
    let slot = cfg.house.ok_or(EngineError::HouseNotCommitted)?;
    if slot.state == 2 {
        msg!("engine: house already activated for {}", mint.key);
        return Err(EngineError::AlreadyInit.into());
    }
    if slot.state != 1 {
        return Err(EngineError::HouseNotCommitted.into());
    }
    // 2. House pool: committed venue pool for this mint under the
    //    committed house program.
    let (pool_tok_vault, pool_quote_vault, _fee_accrued) = read_house_pool(house_pool, mint.key, &slot)?;
    // 3. The passed vaults are the pool record's vaults, and are token
    //    accounts of the right mints owned by the pool PDA.
    if *house_token_vault.key != pool_tok_vault || *house_quote_vault.key != pool_quote_vault {
        return Err(EngineError::BadState.into());
    }
    check_pool_vault(house_token_vault, mint.key, house_pool.key)?;
    check_pool_vault(house_quote_vault, &native_mint(), house_pool.key)?;
    // 4. The DBC curve pool (the graduation source).
    let quote_reserve = {
        let d = dbc_pool.try_borrow_data()?;
        if *dbc_pool.owner != dbc_id() || d.len() != DBC_POOL_SPACE || read_key(&d, DBC_POOL_OFF_BASE_MINT) != *mint.key {
            msg!("engine: activate house: dbc pool malformed for this mint");
            return Err(EngineError::PriceFeedBad.into());
        }
        read_u64(&d, 240)
    };
    // 5. Graduation condition: the curve's quote reserve reached the
    //    committed house threshold.
    if quote_reserve < slot.threshold_lamports {
        msg!("engine: house not ready: curve quote reserve {} < house threshold {}", quote_reserve, slot.threshold_lamports);
        return Err(EngineError::HouseNotReady.into());
    }
    // 6. Vault: genuine, invariant-holding, and seeded per the slot —
    //    the committed reserve if one was committed, else some fees.
    let (reserve_balance, fee_balance) = load_house_vault(vault_ai, mint.key, program_id)?;
    let rent_min = Rent::get()?.minimum_balance(HOUSEVAULT_SPACE);
    let expect_lamports = rent_min
        .checked_add(reserve_balance)
        .and_then(|v| v.checked_add(fee_balance))
        .ok_or(EngineError::MathOverflow)?;
    if vault_ai.lamports() != expect_lamports {
        msg!("engine: house vault lamport invariant broken ({} != {})", vault_ai.lamports(), expect_lamports);
        return Err(EngineError::BadState.into());
    }
    if slot.reserve_lamports > 0 {
        if reserve_balance < slot.reserve_lamports {
            msg!("engine: house not ready: reserve {} < committed {}", reserve_balance, slot.reserve_lamports);
            return Err(EngineError::HouseNotReady.into());
        }
    } else if fee_balance == 0 {
        msg!("engine: house not ready: no reserve committed and fee balance is zero");
        return Err(EngineError::HouseNotReady.into());
    }
    // 7. Capacity for the venue + the two vault exemptions. The vault
    //    append is IDEMPOTENT: since the launcher's L3 derivation began
    //    pre-exempting both house vaults (plus the fee-destination ATA)
    //    for house configs — so a rule-9-capped seed transfer into the
    //    token vault is not vetoed before activation — a vault already
    //    present consumes no additional slot, and the capacity check
    //    counts only the additions actually missing.
    let missing_vault_exemptions = (!cfg.exemptions.contains(house_token_vault.key)) as usize
        + (!cfg.exemptions.contains(house_quote_vault.key)) as usize;
    if cfg.venues.len() >= MAX_VENUES || cfg.exemptions.len() + missing_vault_exemptions > MAX_EXEMPTIONS {
        msg!("engine: house activation exceeds venue/exemption capacity");
        return Err(EngineError::BadState.into());
    }
    if *token_program.key != token_id() {
        msg!("engine: activate house: token_program must be the legacy token program (SyncNative)");
        return Err(EngineError::BadState.into());
    }

    // ---- effects ----
    let cut = ((fee_balance as u128) * (HOUSE_CALLER_CUT_BPS as u128) / 10_000) as u64;
    let seed = reserve_balance
        .checked_add(fee_balance)
        .and_then(|v| v.checked_sub(cut))
        .ok_or(EngineError::MathOverflow)?;
    // Caller cut first, then the seed into the house quote vault
    // (contract 1.4 effects), paid by direct lamport debit — the vault
    // is engine-owned, and a system-program transfer CPI from a
    // data-carrying account is impossible ("from must not carry data").
    move_lamports(vault_ai, caller, cut)?;
    move_lamports(vault_ai, house_quote_vault, seed)?;
    // CONTRACT DEVIATION (flagged to the coordinator, Phase C): the
    // contract's literal next step — an in-program SyncNative CPI on
    // the just-credited quote vault — DOES NOT EXECUTE in this
    // runtime: a CPI naming an account whose lamports the calling
    // program directly modified earlier in the same instruction is
    // rejected at dispatch (UnbalancedInstruction: "sum of account
    // balances before and after instruction do not match"; the callee
    // never logs). Proven in LiteSVM 0.8 for invoke and invoke_signed
    // and even for a non-writing CPI (GetAccountDataSize) on the
    // credited account, while crediting a DIFFERENT account leaves a
    // CPI on the uncredited account clean. The seed credit above
    // therefore lands WITHOUT an in-program sync; the quote vault's
    // token amount is synced by a TOP-LEVEL SyncNative appended to
    // the same transaction by the caller (the keeper bundle) — the
    // end-of-transaction state is exactly the contracted one
    // (amount == lamports - rent reserve), and trial-phase-c asserts
    // it that way. The token_program account stays in this
    // instruction's list (contract-fixed) and is validated above; it
    // is the program the bundled sync targets.
    // Vault counters: balances drained, totals accrue.
    {
        let mut d = vault_ai.try_borrow_mut_data()?;
        let cut_total = read_u64(&d, 17).checked_add(cut).ok_or(EngineError::MathOverflow)?;
        let seeded_total = read_u64(&d, 25).checked_add(seed).ok_or(EngineError::MathOverflow)?;
        d[1..9].copy_from_slice(&0u64.to_le_bytes());
        d[9..17].copy_from_slice(&0u64.to_le_bytes());
        d[17..25].copy_from_slice(&cut_total.to_le_bytes());
        d[25..33].copy_from_slice(&seeded_total.to_le_bytes());
    }
    // Config: direct field writes only — venues += house program,
    // exemptions += the two house vaults, house flips to activated.
    let now = Clock::get()?.unix_timestamp;
    {
        let mut d = config_ai.try_borrow_mut_data()?;
        let vc = d[76] as usize;
        d[77 + vc * 32..77 + (vc + 1) * 32].copy_from_slice(slot.program.as_ref());
        d[76] = (vc + 1) as u8;
        // Idempotent vault append (see step 7): append each house vault
        // only if it is not already in the exemption list — a config
        // whose L3 derivation pre-exempted them keeps its count and its
        // existing entries untouched (no duplicates, no burned slots).
        let mut ec = d[205] as usize;
        for vault_key in [house_token_vault.key, house_quote_vault.key] {
            if !cfg.exemptions.contains(vault_key) {
                d[206 + ec * 32..206 + (ec + 1) * 32].copy_from_slice(vault_key.as_ref());
                ec += 1;
            }
        }
        d[205] = ec as u8;
        d[HOUSE_TS_OFF..HOUSE_TS_OFF + 8].copy_from_slice(&now.to_le_bytes());
        d[HOUSE_STATE_OFF] = 2;
    }
    msg!(
        "engine: house activated for {} (program {}, threshold {}, seed {}, caller cut {})",
        mint.key, slot.program, slot.threshold_lamports, seed, cut
    );
    Ok(())
}

// ---------- CrankPriceDeep (tag 15) — deeper-venue-wins ----------
// Accounts: [config(ro), price_feed(w), dbc_pool(ro), house_pool(ro),
//            house_token_vault(ro), house_quote_vault(ro)]
// The shared feed follows whichever venue is DEEPER: curve depth is the
// DBC pool's quote_reserve; house depth is the house quote vault's token
// amount minus the pool's accrued-quote counter (and counts as 0 before
// activation — a pending house is not a venue). The winner's spot folds
// through the same EMA discipline as tags 5/8; if the winner is not the
// feed's pinned venue, the feed REPINS to the winner's triple first.
// Ties stay with the current pin (no flapping).
fn crank_price_deep(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let config_ai = next_account_info(it)?;
    let feed_ai = next_account_info(it)?;
    let dbc_pool = next_account_info(it)?;
    let house_pool = next_account_info(it)?;
    let house_token_vault = next_account_info(it)?;
    let house_quote_vault = next_account_info(it)?;

    let cfg = load_config(config_ai, program_id)?;
    if *feed_ai.key != price_pda(&cfg.mint, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let feed = load_feed(feed_ai, program_id)?;
    // Curve leg: validate the DBC pool exactly as tag 8 (owner/len/mint).
    let (curve_depth, curve_spot, curve_tok_vault, curve_quote_vault) = {
        let d = dbc_pool.try_borrow_data()?;
        if *dbc_pool.owner != dbc_id() || d.len() != DBC_POOL_SPACE || read_key(&d, DBC_POOL_OFF_BASE_MINT) != cfg.mint {
            msg!("engine: deep crank: dbc pool malformed for this mint");
            return Err(EngineError::PriceFeedBad.into());
        }
        let sqrt_price = read_u128(&d, DBC_POOL_OFF_SQRT_PRICE);
        if sqrt_price == 0 {
            return Err(EngineError::PriceFeedBad.into());
        }
        let spot = dbc_spot(sqrt_price, feed.token_dec, feed.quote_dec)?;
        if spot == 0 {
            return Err(EngineError::PriceFeedBad.into());
        }
        (read_u64(&d, 240), spot, read_key(&d, 168), read_key(&d, 200))
    };
    // House leg: needs a house slot; pool validated as in ActivateHouse
    // step 2, vaults as in step 3.
    let slot = cfg.house.ok_or(EngineError::PriceFeedBad)?;
    let (pool_tok_vault, pool_quote_vault, fee_accrued_quote) = read_house_pool(house_pool, &cfg.mint, &slot)?;
    if *house_token_vault.key != pool_tok_vault || *house_quote_vault.key != pool_quote_vault {
        return Err(EngineError::BadState.into());
    }
    check_pool_vault(house_token_vault, &cfg.mint, house_pool.key)?;
    check_pool_vault(house_quote_vault, &native_mint(), house_pool.key)?;
    let house_tok_amt = token_amount(house_token_vault)? as u128;
    let house_quote_amt = token_amount(house_quote_vault)? as u128;
    let house_depth = if slot.state != 2 {
        0u64 // pre-activation the house is not a venue; the feed stays on the curve
    } else {
        (house_quote_amt as u64).saturating_sub(fee_accrued_quote)
    };
    let house_spot = if house_tok_amt > 0 {
        vault_spot(house_tok_amt, house_quote_amt, feed.token_dec, feed.quote_dec)?
    } else {
        0
    };
    // Winner = larger depth; ties stay with the CURRENT pin.
    let house_wins = if house_depth > curve_depth {
        true
    } else if curve_depth > house_depth {
        false
    } else {
        feed.pool == *house_pool.key
    };
    let (win_pool, win_tok, win_quote, win_spot, winner_name) = if house_wins {
        (*house_pool.key, *house_token_vault.key, *house_quote_vault.key, house_spot, "house")
    } else {
        (*dbc_pool.key, curve_tok_vault, curve_quote_vault, curve_spot, "curve")
    };
    if win_spot == 0 {
        return Err(EngineError::PriceFeedBad.into());
    }
    // Repin the feed's [1..97] triple iff the winner differs from the pin.
    let repinned = !(feed.pool == win_pool && feed.token_vault == win_tok && feed.quote_vault == win_quote);
    if repinned {
        let mut d = feed_ai.try_borrow_mut_data()?;
        d[1..33].copy_from_slice(win_pool.as_ref());
        d[33..65].copy_from_slice(win_tok.as_ref());
        d[65..97].copy_from_slice(win_quote.as_ref());
    }
    let (half_life, max_bps) = ema_params(&cfg);
    let now = Clock::get()?.unix_timestamp;
    let new_ema = ema_fold(&feed, half_life, max_bps, win_spot, now);
    write_crank(feed_ai, new_ema, now)?;
    msg!(
        "engine: crank(deep) curve_depth {} curve_spot {} house_depth {} house_spot {} winner {} repinned {} ema {} ts {}",
        curve_depth, curve_spot, house_depth, house_spot, winner_name, repinned, new_ema, now
    );
    Ok(())
}

// ---------- Execute (the transfer hook) ----------
// Accounts: the 5 fixed Token-2022 accounts [source, mint, destination,
//   authority, validation(meta-list PDA)] followed by the SUPPLIED EXTRAS
//   in the published meta list's order. Since Phase 2 the published list
//   is templated per config, so the extras are a subsequence of the
//   canonical list [config, src_holder, dst_holder, rent_vault,
//   price_feed, system, instructions_sysvar] — extended in v4 by [king,
//   lists, allow] at indices 7..9 with the legacy 7 entries byte- and
//   order-identical; execute() KEY-MATCHES them into slots (see the
//   matcher + required-set gate in the body) instead of consuming them
//   positionally. The full legacy 7-extra superset still executes
//   identically (back-compat).
// NOTE (proven in the wave-1 probe): Token-2022 delivers EXACTLY the
// transfer accounts + the meta-list extras + validation to Execute —
// accounts a client appends to the transfer instruction are NOT forwarded,
// in any position. Anything a module needs beyond the tail must arrive as
// engine state written by a companion instruction (SyncRegistered /
// SyncGateBalance pattern), never as a transfer account.
struct ExecuteCtx<'a, 'c> {
    amount: u64,
    src_owner: Pubkey,
    dst_owner: Pubkey,
    /// Caller context from sysvar introspection: true when the executing
    /// top-level instruction is a config-allowlisted venue program
    /// (a trade), false when it is a direct Token-2022 transfer (P2P).
    venue_context: bool,
    /// The executing top-level instruction's program id, captured by the
    /// same introspection (v4): Token-2022 for direct transfers, the
    /// Distributor for payouts, or the venue/app program for trades.
    /// Rule 4 (App-Gated) judges receives against it.
    caller_program: Pubkey,
    // Cloned AccountInfo values (Rc-shared account data): storing `&AccountInfo`
    // refs instead would force the reference lifetime to equal the invariant
    // AccountInfo lifetime, which the entrypoint's elided lifetimes cannot do.
    source: AccountInfo<'a>,
    mint: AccountInfo<'a>,
    dest: AccountInfo<'a>,
    // Optional extras (Phase 2 templating): supplied extras are KEY-MATCHED
    // into canonical slots by execute(); a slot is None when the client did
    // not supply that extra. The required-set gate in execute() guarantees
    // that every slot the CONFIG's enabled rules need is Some before any
    // module runs — that gate, not the slot type, is the guarantee, and the
    // accessors below panic only if a module asks for a slot its own rule
    // did not declare in `required_extras` (a classification bug, never a
    // client-reachable state: clients can only remove slots, and removing
    // a required one fails the gate before dispatch).
    src_holder: Option<AccountInfo<'a>>,
    dst_holder: Option<AccountInfo<'a>>,
    rent_vault: Option<AccountInfo<'a>>,
    price_feed: Option<AccountInfo<'a>>,
    system: Option<AccountInfo<'a>>,
    // v4 extras (same Option discipline as the legacy slots).
    king: Option<AccountInfo<'a>>,
    lists: Option<AccountInfo<'a>>,
    allow: Option<AccountInfo<'a>>,
    ix_sysvar: AccountInfo<'a>,
    cfg: &'c Config,
}

impl<'a, 'c> ExecuteCtx<'a, 'c> {
    fn src_holder(&self) -> &AccountInfo<'a> {
        self.src_holder.as_ref().expect("src holder slot guaranteed by the required-set gate")
    }
    fn dst_holder(&self) -> &AccountInfo<'a> {
        self.dst_holder.as_ref().expect("dst holder slot guaranteed by the required-set gate")
    }
    fn rent_vault(&self) -> &AccountInfo<'a> {
        self.rent_vault.as_ref().expect("rent vault slot guaranteed by the required-set gate")
    }
    fn price_feed(&self) -> &AccountInfo<'a> {
        self.price_feed.as_ref().expect("price feed slot guaranteed by the required-set gate")
    }
    fn system(&self) -> &AccountInfo<'a> {
        self.system.as_ref().expect("system slot guaranteed by the required-set gate")
    }
    fn king(&self) -> &AccountInfo<'a> {
        self.king.as_ref().expect("king slot guaranteed by the required-set gate")
    }
    fn lists(&self) -> &AccountInfo<'a> {
        self.lists.as_ref().expect("lists slot guaranteed by the required-set gate")
    }
    fn allow(&self) -> &AccountInfo<'a> {
        self.allow.as_ref().expect("allow slot guaranteed by the required-set gate")
    }
}

fn execute(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 8 + 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = read_u64(data, 8);

    let it = &mut accounts.iter();
    let source = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let dest = next_account_info(it)?;
    let _authority = next_account_info(it)?;
    let validation = next_account_info(it)?;
    // Everything after the 5 fixed accounts is a SUPPLIED EXTRA, consumed
    // by KEY-MATCHING below (Phase 2) — never positionally. `it` now yields
    // exactly the extras the client's resolved meta list carried.
    let supplied: Vec<&AccountInfo> = it.collect();

    // ---- structural validation (defense in depth vs meta substitution) ----
    if *validation.key != meta_list_pda(mint.key, program_id) {
        return Err(EngineError::BadCaller.into());
    }
    if token_mint(source)? != *mint.key || token_mint(dest)? != *mint.key {
        return Err(ProgramError::InvalidAccountData);
    }
    let src_owner = token_owner(source)?;
    let dst_owner = token_owner(dest)?;

    // ---- key-matching: assign each supplied extra to its canonical slot.
    // Candidates are the derivable keys in canonical order (see the
    // classification table at `required_extras`). A supplied account must
    // match the first not-yet-passed candidate with its key: an
    // unrecognized key, a duplicate, or an out-of-order account all fail
    // closed with BadCaller. This accepts the full legacy 7-extra
    // superset (back-compat: every existing client/trial) AND any
    // templated subsequence, in exactly the published relative order.
    // Alias case: when source and destination are the SAME token account
    // (a true self-transfer) the two holder PDAs are the SAME key. One
    // supplied occurrence then fills BOTH holder slots, and a second
    // occurrence (a superset client listing it twice, once per slot) is
    // accepted as that aliased second entry — not a duplicate. (Under
    // v2's owner-keying, two accounts of one owner aliased the same way;
    // under v3's account-keying only the literal same account does.)
    let candidates: [Pubkey; 10] = [
        config_pda(mint.key, program_id),
        holder_pda(mint.key, source.key, program_id),
        holder_pda(mint.key, dest.key, program_id),
        rentvault_pda(mint.key, program_id),
        price_pda(mint.key, program_id),
        solana_program::system_program::id(),
        solana_program::sysvar::instructions::ID,
        king_pda(mint.key, program_id),
        lists_pda(mint.key, program_id),
        allow_pda(mint.key, dest.key, program_id),
    ];
    let mut slots: [Option<&AccountInfo>; 10] = [None, None, None, None, None, None, None, None, None, None];
    let mut next_candidate = 0usize;
    let mut alias_second_ok = false;
    for extra in &supplied {
        if alias_second_ok && *extra.key == candidates[EXTRA_SRC_HOLDER as usize] {
            alias_second_ok = false;
            continue;
        }
        let mut found: Option<usize> = None;
        let mut p = next_candidate;
        while p < candidates.len() {
            if candidates[p] == *extra.key {
                found = Some(p);
                break;
            }
            p += 1;
        }
        let p = match found {
            Some(p) => p,
            None => {
                msg!("engine: unrecognized/duplicate/out-of-order extra account {}", extra.key);
                return Err(EngineError::BadCaller.into());
            }
        };
        slots[p] = Some(extra);
        if p == EXTRA_SRC_HOLDER as usize && candidates[EXTRA_DST_HOLDER as usize] == *extra.key {
            // src/dst holder alias (same owner both sides): one account
            // fills both slots; allow one redundant second occurrence.
            slots[EXTRA_DST_HOLDER as usize] = Some(extra);
            alias_second_ok = true;
            next_candidate = EXTRA_DST_HOLDER as usize + 1;
        } else {
            next_candidate = p + 1;
        }
    }
    let slot = |idx: u8| slots[idx as usize];

    // Config is unconditional (classification): without it there is no
    // rule set to even compute the required set against.
    let config_ai = match slot(EXTRA_CONFIG) {
        Some(ai) => ai,
        None => {
            msg!("engine: missing required extra: config PDA");
            return Err(EngineError::MissingExtra.into());
        }
    };
    let cfg = load_config(config_ai, program_id)?;
    if cfg.mint != *mint.key {
        return Err(EngineError::BadConfig.into());
    }

    // ---- required-set gate: every extra the config's enabled rules need
    // must have been supplied. This is what makes a stale meta list (post
    // UpdateConfig expansion) or an under-supplying client fail closed
    // instead of silently under-enforcing. ----
    let required = required_extras(&cfg.rules);
    for idx in 0..10u8 {
        if required & EXTRA_BIT[idx as usize] != 0 && slot(idx).is_none() {
            msg!("engine: missing required extra: canonical index {} (required mask {:#013b})", idx, required);
            return Err(EngineError::MissingExtra.into());
        }
    }
    // Slots for the ctx: config was consumed above; the sysvar is
    // unconditional (gate-checked) and stays a plain field.
    let ix_sysvar = slot(EXTRA_SYSVAR).expect("sysvar is unconditional in required_extras");
    let src_holder = slot(EXTRA_SRC_HOLDER).cloned();
    let dst_holder = slot(EXTRA_DST_HOLDER).cloned();
    let rent_vault = slot(EXTRA_RENT_VAULT).cloned();
    let price_feed = slot(EXTRA_PRICE_FEED).cloned();
    let system = slot(EXTRA_SYSTEM).cloned();
    let king = slot(EXTRA_KING).cloned();
    let lists = slot(EXTRA_LISTS).cloned();
    let allow = slot(EXTRA_ALLOW).cloned();

    // ---- caller validation (TH hardening): the executing top-level
    // instruction must be a Token-2022 Transfer/TransferChecked, an
    // instruction of a venue program on the config allowlist (e.g. Meteora
    // DBC swap), or a Distributor payout (distribute / claim / settle)
    // whose transfer authority is THIS mint's distributor state PDA.
    // A direct phantom Execute cannot satisfy any branch. ----
    if *ix_sysvar.key != solana_program::sysvar::instructions::ID {
        return Err(EngineError::BadCaller.into());
    }
    let (venue_context, caller_program) = {
        let cur = load_current_index_checked(ix_sysvar)? as usize;
        let top = load_instruction_at_checked(cur, ix_sysvar)?;
        if top.program_id == token_2022_id() {
            if !matches!(top.data.first(), Some(3) | Some(12)) {
                msg!("engine: rejected caller {}", top.program_id);
                return Err(EngineError::BadCaller.into());
            }
            (false, top.program_id) // direct wallet transfer
        } else if top.program_id == distributor_id() {
            // Distributor payout context (fee fold): the Distributor is
            // top-level for its own instructions, and it is not (and, for
            // Locked configs, cannot become) a venue-allowlist entry.
            // Accept ONLY the genuine payout shape: the transfer's
            // authority must be this mint's distributor state PDA —
            // seeds ["dist", mint] under the Distributor program — which
            // is the vault ATA's owner and the only signer the
            // Distributor can produce for its vault transfers (via
            // invoke_signed). Any other authority under a Distributor
            // top-level instruction is not a payout: reject.
            let expect = pda(&[b"dist", mint.key.as_ref()], &distributor_id());
            if *_authority.key != expect {
                msg!(
                    "engine: rejected distributor caller, authority {} != distributor state PDA {}",
                    _authority.key, expect
                );
                return Err(EngineError::BadCaller.into());
            }
            (false, top.program_id) // a payout is not a venue trade (rule 7: direct-transfer class)
        } else if cfg.venues.iter().any(|v| *v == top.program_id) {
            (true, top.program_id) // venue (trade) context
        } else {
            msg!("engine: rejected caller {}", top.program_id);
            return Err(EngineError::BadCaller.into());
        }
    };
    msg!("engine: execute amount={} accounts={} venue={}", amount, accounts.len(), venue_context);

    if amount == 0 {
        return Ok(());
    }

    let ctx = ExecuteCtx {
        amount,
        src_owner,
        dst_owner,
        venue_context,
        caller_program,
        source: source.clone(),
        mint: mint.clone(),
        dest: dest.clone(),
        src_holder: src_holder.clone(),
        dst_holder: dst_holder.clone(),
        rent_vault: rent_vault.clone(),
        price_feed: price_feed.clone(),
        system: system.clone(),
        king: king.clone(),
        lists: lists.clone(),
        allow: allow.clone(),
        ix_sysvar: ix_sysvar.clone(),
        cfg: &cfg,
    };

    // ---- module dispatch: config order is law; any veto vetoes ----
    for rule in &cfg.rules {
        if !rule.enabled {
            continue;
        }
        run_module(program_id, rule, &ctx)?;
    }
    Ok(())
}

fn run_module(program_id: &Pubkey, rule: &RuleEntry, ctx: &ExecuteCtx<'_, '_>) -> ProgramResult {
    match rule.rule_id {
        RULE_BASIS_LATCH => module_basis_latch(program_id, rule, ctx),
        RULE_MAX_WALLET => module_max_wallet(rule, ctx),
        RULE_AGENT_ONLY => module_agent_only(program_id, rule, ctx),
        RULE_P2P_TOGGLE => module_p2p_toggle(rule, ctx),
        RULE_HOLDER_GATED => module_holder_gated(program_id, rule, ctx),
        RULE_ECOSYSTEM_GATE => module_ecosystem_gate(program_id, rule, ctx),
        RULE_APP_GATED => module_app_gated(rule, ctx),
        RULE_ALLOW_BLOCK_LIST => module_allow_blocklist(program_id, rule, ctx),
        RULE_GRUDGE => module_grudge(program_id, rule, ctx),
        RULE_TRADING_HOURS => module_trading_hours(rule, ctx),
        RULE_VESTING_CLOCK => module_vesting_clock(program_id, rule, ctx),
        RULE_KING_OF_POOL => module_king_of_pool(program_id, rule, ctx),
        // Phase C: Escrow Split is enforced venue-side (the house swap
        // program reads this config itself on its own swaps); the engine
        // has no transfer-time behavior for it.
        RULE_ESCROW_SPLIT => Ok(()),
        // Phase B settlement rules: no transfer-time behavior — enforcement
        // is settlement-side (Distributor / Crown / FeeSchedule programs).
        RULE_CROWN_BENEFICIARY => Ok(()),
        RULE_TITHE_SEAT => Ok(()),
        // Phase B: decay is applied settlement-side via the FeeSchedule
        // program; no transfer-time behavior.
        RULE_DECAY_TAX => Ok(()),
        // Phase B: buyback is crank-side; no transfer-time behavior.
        RULE_BUYBACK_BURN => Ok(()),
        // Unreachable: config writes reject enabled-but-unimplemented rules.
        // Fail closed anyway — never silently skip a configured rule.
        _ => Err(EngineError::UnknownRule.into()),
    }
}

// ---------- rule 9: MAX WALLET ----------
// params: cap_bps u16 @ [0..2]. Veto when the destination's balance exceeds
// cap_bps of total supply.
// BALANCE SEMANTICS (verified, do not "fix" back): Token-2022 applies the
// transfer BEFORE invoking Execute — the destination amount observed here
// ALREADY includes the in-flight amount, so it must NOT be added again.
// Evidence: the engine trial's first 60k receive into a fresh account read a
// 60k destination balance in Execute (LiteSVM, Agave Token-2022 build);
// corroborated by the production max-holding-hook (MidTermDev, mainnet),
// whose published rule reads destination.amount directly. TH never noticed
// because its gate reads basis/price state, never balances. The DBC
// workstream should re-probe this through a real DBC swap (same token
// program, so the semantics carry — but the probe is cheap).
// Skips: exempt destinations, true self-transfers.
fn module_max_wallet(rule: &RuleEntry, ctx: &ExecuteCtx<'_, '_>) -> ProgramResult {
    let cap_bps = read_u16(&rule.params, 0) as u128;
    if ctx.cfg.is_exempt(&ctx.dst_owner, ctx.dest.key) {
        return Ok(());
    }
    if ctx.source.key == ctx.dest.key {
        return Ok(());
    }
    let supply = mint_supply(&ctx.mint)? as u128;
    let balance = token_amount(&ctx.dest)? as u128; // post-transfer (see above)
    if balance * 10_000 > supply * cap_bps {
        msg!("engine: max wallet exceeded ({} of {} over {} bps)", balance, supply, cap_bps);
        return Err(EngineError::MaxWalletExceeded.into());
    }
    Ok(())
}

// ---------- rule 3: AGENT-ONLY ----------
// Destination owner must be registered: Holder PDA byte 1, the mirror of
// the Registry program's Registration PDA `active` byte, written by
// SyncRegistered (registry/INTEGRATION.md). Missing Holder PDA is
// handled EXPLICITLY: lazily created (rent-vault funded) so the check reads a
// real `registered=false`, or an explicit RentVaultUnderfunded error — never
// a silent pass. Skips: exempt destinations.
fn module_agent_only(program_id: &Pubkey, _rule: &RuleEntry, ctx: &ExecuteCtx<'_, '_>) -> ProgramResult {
    if ctx.cfg.is_exempt(&ctx.dst_owner, ctx.dest.key) {
        return Ok(());
    }
    if rule_needs_dst_holder(RULE_AGENT_ONLY) && ctx.dst_holder().data_len() == 0 {
        ensure_dst_holder(program_id, ctx.dst_holder(), ctx.rent_vault(), ctx.system(), ctx.mint.key, ctx.dest.key, holder_create_size(ctx.cfg))?;
    }
    match holder_registered(ctx.dst_holder(), program_id)? {
        Some(true) => Ok(()),
        Some(false) => {
            msg!("engine: not registered: {}", ctx.dst_owner);
            Err(EngineError::NotRegistered.into())
        }
        None => {
            // ensure_dst_holder ran (or the account existed but was empty in
            // a way it could not repair): explicit failure, never approval.
            msg!("engine: holder state missing for {}", ctx.dst_owner);
            Err(EngineError::HolderMissing.into())
        }
    }
}

// ---------- rule 17: ECOSYSTEM GATE ----------
// params: [0] required ecosystem id u8 (1..=MAX_ECOSYSTEM, validated at
// config write; 1 = Muse, 2 = FOMO, 3 = Claude, 4 = Grok).
// The destination owner must hold a Registry registration ATTESTED for
// that ecosystem: Holder PDA byte 1 (registered mirror) must be 1 AND
// byte 2 (ecosystem mirror) must equal the required id; both bytes are
// written together by SyncRegistered from the same Registration PDA
// snapshot, so they can never describe different records. Error split:
// an unregistered/unsynced destination fails NotRegistered (same as
// rule 3 — the remedy is identical: register + sync); a registered
// destination whose attestation names another ecosystem (or none)
// fails WrongEcosystem. Skips: exempt destinations.
fn module_ecosystem_gate(program_id: &Pubkey, rule: &RuleEntry, ctx: &ExecuteCtx<'_, '_>) -> ProgramResult {
    if ctx.cfg.is_exempt(&ctx.dst_owner, ctx.dest.key) {
        return Ok(());
    }
    let required = rule.params[0];
    if rule_needs_dst_holder(RULE_ECOSYSTEM_GATE) && ctx.dst_holder().data_len() == 0 {
        ensure_dst_holder(program_id, ctx.dst_holder(), ctx.rent_vault(), ctx.system(), ctx.mint.key, ctx.dest.key, holder_create_size(ctx.cfg))?;
    }
    if !holder_valid(ctx.dst_holder(), program_id)? {
        msg!("engine: holder state missing for {}", ctx.dst_owner);
        return Err(EngineError::HolderMissing.into());
    }
    let (registered, ecosystem) = {
        let d = ctx.dst_holder().try_borrow_data()?;
        (d[1] == 1, d[2])
    };
    if !registered {
        msg!("engine: ecosystem gate: not registered: {}", ctx.dst_owner);
        return Err(EngineError::NotRegistered.into());
    }
    if ecosystem != required {
        msg!("engine: ecosystem gate: {} attested for ecosystem {}, gate requires {}", ctx.dst_owner, ecosystem, required);
        return Err(EngineError::WrongEcosystem.into());
    }
    Ok(())
}

// ---------- v4 account layouts: KING / LISTS / ALLOW PDAs ----------
// King PDA (["king", mint]; rule 15 tracking record):
//   [0] tag u8 = 1, [1..33] king token account, [33..65] king owner,
//   [65..73] king balance u64 (last observed post-transfer balance),
//   [73..81] updated ts i64, [81..96] reserved.
pub const KING_SPACE: usize = 96;
const KING_ACCT_OFF: usize = 1;
const KING_OWNER_OFF: usize = 33;
const KING_BAL_OFF: usize = 65;
const KING_TS_OFF: usize = 73;
// Lists PDA (["lists", mint]; rule 10 blocklist, sealed by SetBlocklist):
//   [0] tag u8 = 1, [1] sealed u8 (1 once written under a Locked config),
//   [2..4] count u16, [4..] entries x 32B owner pubkeys.
pub const MAX_BLOCKLIST: usize = 36;
pub const LISTS_SPACE: usize = 4 + MAX_BLOCKLIST * 32;
// Allow PDA (["allow", mint, token_account]; rule 10 allowlist entry):
//   [0] tag u8 = 1, [1] active u8, [2..10] updated ts i64, rest zero.
pub const ALLOW_SPACE: usize = 64;

/// Lazily create the King PDA, funded from the rent vault — the
/// ensure_dst_holder sequence (vault-signed transfer, then allocate +
/// assign signed by the PDA's own seeds), with the record initialized
/// empty (no king until the first non-exempt balance is observed).
fn ensure_king<'a>(
    program_id: &Pubkey,
    king_ai: &AccountInfo<'a>,
    vault_ai: &AccountInfo<'a>,
    system_ai: &AccountInfo<'a>,
    mint: &Pubkey,
) -> ProgramResult {
    if king_ai.data_len() > 0 {
        if king_ai.owner != program_id {
            return Err(EngineError::BadState.into());
        }
        return Ok(());
    }
    let rent = Rent::get()?.minimum_balance(KING_SPACE);
    if vault_ai.lamports() < rent {
        msg!("engine: rent vault underfunded for lazy king creation");
        return Err(EngineError::RentVaultUnderfunded.into());
    }
    let (_, bump) = Pubkey::find_program_address(&[b"king", mint.as_ref()], program_id);
    let (_, vault_bump) = Pubkey::find_program_address(&[b"rentvault", mint.as_ref()], program_id);
    invoke_signed(
        &system_instruction::transfer(vault_ai.key, king_ai.key, rent),
        &[vault_ai.clone(), king_ai.clone()],
        &[&[b"rentvault", mint.as_ref(), &[vault_bump]]],
    )?;
    invoke_signed(
        &system_instruction::allocate(king_ai.key, KING_SPACE as u64),
        &[king_ai.clone(), system_ai.clone()],
        &[&[b"king", mint.as_ref(), &[bump]]],
    )?;
    invoke_signed(
        &system_instruction::assign(king_ai.key, program_id),
        &[king_ai.clone(), system_ai.clone()],
        &[&[b"king", mint.as_ref(), &[bump]]],
    )?;
    {
        let mut d = king_ai.try_borrow_mut_data()?;
        for b in d.iter_mut() {
            *b = 0;
        }
        d[0] = 1;
    }
    msg!("engine: king PDA created lazily for mint {}", mint);
    Ok(())
}

// ---------- rule 12: TRADING HOURS ----------
// params (64B):
//   [0..4]  tz_offset_secs i32 (seconds east of UTC; FIXED offset — the
//           config picks EST or EDT; a fixed offset cannot follow DST,
//           stated plainly: re-issue the config at the DST change or
//           accept the seasonal hour shift)
//   [4]     days_mask u8 (bit 0 = Monday .. bit 6 = Sunday, local time)
//   [5..7]  window_start_min u16 (minutes after local midnight)
//   [7..9]  window_end_min u16   (window is [start, end); start < end,
//           validated at write — a window cannot cross midnight in one
//           entry; stack two rule-12 entries for a split day)
//   [9]     scope u8: 0 = all transfers, 1 = venue-context transfers only
//   [10..64] reserved
// Reference behavior: HookedPad's JOB token (Mon–Fi 9–5 New York) is
// exactly one entry: mask 0b0011111 (bits 0..4), start 540, end 1020,
// offset -5h (EST) / -4h (EDT).
fn module_trading_hours(rule: &RuleEntry, ctx: &ExecuteCtx<'_, '_>) -> ProgramResult {
    if rule.params[9] == 1 && !ctx.venue_context {
        return Ok(()); // venue-only scope: wallet transfers are not gated
    }
    let tz = i32::from_le_bytes(rule.params[0..4].try_into().unwrap()) as i64;
    let now = Clock::get()?.unix_timestamp;
    let local = now + tz;
    let days = local.div_euclid(86_400);
    let secs_of_day = local.rem_euclid(86_400);
    // 1970-01-01 was a Thursday; with Mon = 0, Thursday is index 3.
    let dow_mon0 = (days + 3).rem_euclid(7) as u32;
    if rule.params[4] & (1u8 << dow_mon0) == 0 {
        msg!("engine: trading hours: day {} (Mon=0) not in mask {:#09b}", dow_mon0, rule.params[4]);
        return Err(EngineError::OutsideTradingHours.into());
    }
    let minute = (secs_of_day / 60) as u16;
    let start = read_u16(&rule.params, 5);
    let end = read_u16(&rule.params, 7);
    if minute < start || minute >= end {
        msg!("engine: trading hours: local minute {} outside {}..{}", minute, start, end);
        return Err(EngineError::OutsideTradingHours.into());
    }
    Ok(())
}

// ---------- rule 4: APP-GATED ----------
// params: [0..32] app program #1, [32..64] app program #2 (zero key =
// absent; at least one nonzero, validated at config write).
// A receive IN VENUE CONTEXT (a trade) is allowed only when the
// executing top-level program — ctx.caller_program, e.g. the FOMO app or
// our own trade-page program when IT is the top-level instruction — is
// one of the named apps. This is the app-exclusive genre (HookedPad's
// HAMSTER trades only inside the FOMO / Pump apps). Direct DBC swaps
// name the DBC program as caller, so a config that wants curve trades
// only via an app simply does not list the DBC program here while the
// app is allowlisted in cfg.venues for caller validation.
// Non-venue transfers are NOT this rule's business (the P2P toggle,
// rule 7, governs them), and exempt destinations (the pool itself on a
// sell, fee vaults) always pass.
fn module_app_gated(rule: &RuleEntry, ctx: &ExecuteCtx<'_, '_>) -> ProgramResult {
    if !ctx.venue_context {
        return Ok(());
    }
    if ctx.cfg.is_exempt(&ctx.dst_owner, ctx.dest.key) {
        return Ok(());
    }
    let app1 = read_key(&rule.params, 0);
    let app2 = read_key(&rule.params, 32);
    if ctx.caller_program == app1 || (app2 != Pubkey::default() && ctx.caller_program == app2) {
        return Ok(());
    }
    msg!("engine: app-gated: caller {} is not a named app", ctx.caller_program);
    Err(EngineError::AppNotAllowed.into())
}

// ---------- rule 13: VESTING CLOCK ----------
// params (64B):
//   [0]     mode u8: 0 = cliff (nothing unlocks until the schedule
//           completes), 1 = linear (fraction = elapsed / hold)
//   [8..16] hold_secs u64 (per-holder leg; 0 = leg off)
//   [16..24] release_ts i64 (global leg; 0 = leg off) — while now <
//           release_ts the unlocked fraction is 0 regardless of the
//           per-holder leg (the legs compose as AND, per the spec's
//           "global release date or a per-holder hold period", either
//           or both configured; write validation requires at least one)
//   [24..64] reserved
// State: the holder's vest_anchor (v4 region [192..200]) — the
// balance-weighted average receive time of the current position,
// blended on receives exactly like the GRADUATED anchor. "Released"
// means the veto lifts; tokens never move.
// GATE (non-exempt sender): unlocked fraction of the PRE-transfer
// balance (post + amount, per the post-transfer balance semantics) is
// spendable: veto when the post-transfer balance would fall below
// locked = pre * (10_000 - frac) / 10_000. A sender with no Holder
// record fails HolderMissing (fail closed, the rule-1 stance): every
// receive creates the record, so a missing one predates tracking —
// the remedy is InitializeHolder + a receive, never a silent pass.
// Full exit leaves the anchor stale; the next receive into a zero
// balance re-anchors at that receive (bookkeeping below).
fn module_vesting_clock(program_id: &Pubkey, rule: &RuleEntry, ctx: &ExecuteCtx<'_, '_>) -> ProgramResult {
    let mode = rule.params[0];
    let hold_secs = read_u64(&rule.params, 8);
    let release_ts = read_i64(&rule.params, 16);
    if ctx.source.key == ctx.dest.key {
        return Ok(()); // true self-transfer: no position change, no anchor move
    }
    let src_exempt = ctx.cfg.is_exempt(&ctx.src_owner, ctx.source.key);
    let dst_exempt = ctx.cfg.is_exempt(&ctx.dst_owner, ctx.dest.key);
    if src_exempt && dst_exempt {
        return Ok(()); // pure pool-side move
    }
    let now = Clock::get()?.unix_timestamp;

    // ---- GATE ----
    if !src_exempt {
        if !holder_valid(ctx.src_holder(), program_id)? {
            msg!("engine: vesting: no holder record for sender {}", ctx.src_owner);
            return Err(EngineError::HolderMissing.into());
        }
        ensure_v4_region(program_id, ctx.src_holder(), ctx.rent_vault(), ctx.mint.key)?;
        let post_bal = token_amount(&ctx.source)? as u128;
        let pre_bal = post_bal + (ctx.amount as u128);
        let anchor = {
            let d = ctx.src_holder().try_borrow_data()?;
            read_i64(&d, VEST_ANCHOR_OFF)
        };
        let frac_bps: u128 = if release_ts > 0 && now < release_ts {
            0
        } else if hold_secs == 0 {
            10_000
        } else {
            let elapsed: u128 = if anchor == 0 { 0 } else { (now - anchor).max(0) as u128 };
            if mode == 0 {
                if elapsed >= (hold_secs as u128) { 10_000 } else { 0 }
            } else {
                (elapsed * 10_000 / (hold_secs as u128)).min(10_000)
            }
        };
        let locked = pre_bal * (10_000 - frac_bps) / 10_000;
        if post_bal < locked {
            msg!("engine: vesting locked: post {} < locked {} (frac {} bps, anchor {})", post_bal, locked, frac_bps, anchor);
            return Err(EngineError::VestingLocked.into());
        }
        if anchor == 0 && pre_bal > 0 {
            // Record exists but predates anchor tracking (e.g. created by
            // InitializeHolder before this rule governed the mint): anchor
            // the position at first gated touch. Persists only when this
            // transfer itself passes — a vetoed transfer rolls back, which
            // is correct: the position has not moved yet either.
            let mut d = ctx.src_holder().try_borrow_mut_data()?;
            d[VEST_ANCHOR_OFF..VEST_ANCHOR_OFF + 8].copy_from_slice(&now.to_le_bytes());
        }
    }

    // ---- BOOKKEEPING ----
    if !dst_exempt {
        if ctx.dst_holder().data_len() == 0 {
            ensure_dst_holder(program_id, ctx.dst_holder(), ctx.rent_vault(), ctx.system(), ctx.mint.key, ctx.dest.key, holder_create_size(ctx.cfg))?;
        } else if !holder_valid(ctx.dst_holder(), program_id)? {
            return Err(EngineError::BadState.into());
        }
        ensure_v4_region(program_id, ctx.dst_holder(), ctx.rent_vault(), ctx.mint.key)?;
        let post_bal = token_amount(&ctx.dest)? as u128;
        let amt = ctx.amount as u128;
        let old_bal = post_bal.checked_sub(amt).ok_or(EngineError::MathOverflow)?;
        let mut d = ctx.dst_holder().try_borrow_mut_data()?;
        let old_anchor = read_i64(&d, VEST_ANCHOR_OFF);
        let new_anchor = if old_bal == 0 || old_anchor == 0 {
            now // fresh position (or first tracked receive) anchors at now
        } else {
            // Balance-weighted blend, the GRADUATED anchor's arithmetic.
            ((old_bal as i128 * old_anchor as i128 + amt as i128 * now as i128) / post_bal as i128) as i64
        };
        d[VEST_ANCHOR_OFF..VEST_ANCHOR_OFF + 8].copy_from_slice(&new_anchor.to_le_bytes());
    }
    Ok(())
}

// ---------- rule 10: ALLOWLIST / BLOCKLIST ----------
// params: [0] mode — 0 = blocklist only, 1 = allowlist only, 2 = both
// (validated at config write); [1..64] reserved.
// BLOCKLIST leg: the destination OWNER must not appear in the sealed
// Lists PDA (written by SetBlocklist, tag 12 — one-shot under Locked
// configs). A missing Lists PDA is an empty list (the account is only
// created when a list is written). Corrupt/foreign state fails closed.
// ALLOWLIST leg: the destination must hold an ACTIVE Allow PDA entry
// (written by SetAllowlistEntry, tag 13). Missing entry = not allowed
// (fail closed — that is the point of an allowlist); inactive = denied.
// Identity is the destination TOKEN ACCOUNT for the entry (v3
// AccountKey discipline) and the OWNER for the blocklist (the spec
// names wallets there) — see the v4 rows of the classification table.
fn module_allow_blocklist(program_id: &Pubkey, rule: &RuleEntry, ctx: &ExecuteCtx<'_, '_>) -> ProgramResult {
    if ctx.cfg.is_exempt(&ctx.dst_owner, ctx.dest.key) {
        return Ok(());
    }
    let mode = rule.params[0];
    if mode != 1 {
        let lists = ctx.lists();
        if lists.data_len() > 0 {
            if lists.owner != program_id {
                return Err(EngineError::BadState.into());
            }
            let d = lists.try_borrow_data()?;
            if d.len() < LISTS_SPACE || d[0] != 1 {
                return Err(EngineError::BadState.into());
            }
            let count = (read_u16(&d, 2) as usize).min(MAX_BLOCKLIST);
            for i in 0..count {
                if read_key(&d, 4 + i * 32) == ctx.dst_owner {
                    msg!("engine: blocklisted destination owner {}", ctx.dst_owner);
                    return Err(EngineError::Blocklisted.into());
                }
            }
        }
    }
    if mode != 0 {
        let allow = ctx.allow();
        if allow.data_len() == 0 {
            msg!("engine: no allowlist entry for destination {}", ctx.dest.key);
            return Err(EngineError::NotAllowlisted.into());
        }
        if allow.owner != program_id {
            return Err(EngineError::BadState.into());
        }
        let d = allow.try_borrow_data()?;
        if d.len() < ALLOW_SPACE || d[0] != 1 {
            return Err(EngineError::BadState.into());
        }
        if d[1] != 1 {
            msg!("engine: allowlist entry inactive for destination {}", ctx.dest.key);
            return Err(EngineError::NotAllowlisted.into());
        }
    }
    Ok(())
}

// ---------- rule 11: THE GRUDGE (core veto form) ----------
// params (64B):
//   [0..2]   dump_threshold_bps u16 (fraction of the tracked bag whose
//            sale inside the window marks the wallet; 1..=10_000)
//   [2..10]  window_secs u64 (0 = default 86_400)
//   [10..18] penalty_duration_secs u64 (0 = default 86_400) — the BASE
//            mark duration; offense n lasts base * min(n, max_escalation)
//   [18]     penalty_mode u8: 0 = buy-ban, 1 = buy-cap
//   [19..27] buy_cap_amount u64 (mode 1: max tokens per single venue
//            receive while marked)
//   [27]     max_escalation u8 (0 = default 4)
//   [28..64] reserved
// State (Holder PDA): window start [55..63] + sold-in-window [63..71]
// (the layout's named dump fields), window bag at custom [127..135],
// mark-until at custom [119..127], offense count at [135].
// A SALE is a transfer from a non-exempt source to an exempt
// destination (into the venue) — wallet-to-wallet sends are not sales
// and never mark. The window's bag is the seller's PRE-transfer balance
// at the window's first sale; pct = sold_in_window / bag. Marking
// resets the window, so a marked wallet re-offends from a clean slate.
// The RECEIVE leg (venue -> non-exempt destination) enforces the mark:
// mode 0 vetoes outright, mode 1 vetoes receives over the cap. P2P
// receives are not buys and are never penalized. (The extra-fee variant
// from spec SS5 is a Phase B fee-layer build — deliberately absent here.)
const GRUDGE_MARK_UNTIL_OFF: usize = 119;
const GRUDGE_BAG_OFF: usize = 127;
const GRUDGE_OFFENSES_OFF: usize = 135;
const DUMP_WINDOW_START_OFF: usize = 55;
const DUMP_SOLD_OFF: usize = 63;

fn module_grudge(program_id: &Pubkey, rule: &RuleEntry, ctx: &ExecuteCtx<'_, '_>) -> ProgramResult {
    if ctx.source.key == ctx.dest.key {
        return Ok(());
    }
    let src_exempt = ctx.cfg.is_exempt(&ctx.src_owner, ctx.source.key);
    let dst_exempt = ctx.cfg.is_exempt(&ctx.dst_owner, ctx.dest.key);
    let now = Clock::get()?.unix_timestamp;
    let threshold_bps = read_u16(&rule.params, 0) as u128;
    let window_secs: i64 = {
        let v = read_u64(&rule.params, 2);
        if v == 0 { 86_400 } else { v as i64 }
    };
    let base_duration: i64 = {
        let v = read_u64(&rule.params, 10);
        if v == 0 { 86_400 } else { v as i64 }
    };
    let penalty_mode = rule.params[18];
    let buy_cap = read_u64(&rule.params, 19);
    let max_esc: u64 = {
        let v = rule.params[27];
        if v == 0 { 4 } else { v as u64 }
    };

    // ---- SELL leg: track + maybe mark the sender ----
    if !src_exempt && dst_exempt {
        if ctx.src_holder().data_len() == 0 {
            ensure_src_holder(program_id, ctx.src_holder(), ctx.rent_vault(), ctx.system(), ctx.mint.key, ctx.source.key, holder_create_size(ctx.cfg))?;
        } else if !holder_valid(ctx.src_holder(), program_id)? {
            return Err(EngineError::BadState.into());
        }
        let post_bal = token_amount(&ctx.source)? as u128;
        let pre_bal = post_bal + (ctx.amount as u128);
        let mut d = ctx.src_holder().try_borrow_mut_data()?;
        let mut wstart = read_i64(&d, DUMP_WINDOW_START_OFF);
        let mut sold = read_u64(&d, DUMP_SOLD_OFF) as u128;
        let mut bag = read_u64(&d, GRUDGE_BAG_OFF) as u128;
        if wstart == 0 || now - wstart > window_secs || bag == 0 {
            wstart = now;
            sold = 0;
            bag = pre_bal;
        }
        sold += ctx.amount as u128;
        if bag > 0 && sold * 10_000 >= bag * threshold_bps {
            let offenses = ((d[GRUDGE_OFFENSES_OFF] as u64) + 1).min(255);
            d[GRUDGE_OFFENSES_OFF] = offenses as u8;
            let mult = offenses.min(max_esc);
            let until = now.saturating_add(base_duration.saturating_mul(mult as i64));
            d[GRUDGE_MARK_UNTIL_OFF..GRUDGE_MARK_UNTIL_OFF + 8].copy_from_slice(&until.to_le_bytes());
            wstart = 0;
            sold = 0;
            bag = 0;
            msg!("engine: grudge: {} marked until {} (offense {}, x{})", ctx.src_owner, until, offenses, mult);
        }
        d[DUMP_WINDOW_START_OFF..DUMP_WINDOW_START_OFF + 8].copy_from_slice(&wstart.to_le_bytes());
        d[DUMP_SOLD_OFF..DUMP_SOLD_OFF + 8].copy_from_slice(&(sold as u64).to_le_bytes());
        d[GRUDGE_BAG_OFF..GRUDGE_BAG_OFF + 8].copy_from_slice(&(bag as u64).to_le_bytes());
        d[47..55].copy_from_slice(&now.to_le_bytes()); // last_sell_ts
    }

    // ---- RECEIVE leg: enforce the mark on venue buys ----
    if src_exempt && !dst_exempt && holder_valid(ctx.dst_holder(), program_id)? {
        let until = {
            let d = ctx.dst_holder().try_borrow_data()?;
            read_i64(&d, GRUDGE_MARK_UNTIL_OFF)
        };
        if until > now {
            if penalty_mode == 0 {
                msg!("engine: grudge: buy-ban for marked wallet {} (until {})", ctx.dst_owner, until);
                return Err(EngineError::GrudgeMarked.into());
            }
            if ctx.amount > buy_cap {
                msg!("engine: grudge: marked wallet {} buy {} over cap {}", ctx.dst_owner, ctx.amount, buy_cap);
                return Err(EngineError::GrudgeMarked.into());
            }
        }
    }
    Ok(())
}

// ---------- rule 15: KING OF THE POOL (tracking half) ----------
// The per-mint King PDA (layout above) names the largest holder as last
// OBSERVED through Execute: every transfer refreshes the record when
// the reigning king is a party (its post-transfer balance replaces the
// stored one, up or down), and crowns a non-exempt party whose
// post-transfer balance beats the stored record. This is a streaming
// maximum — a third party's balance is only known when it transacts —
// which is the strongest statement any per-transfer hook can make; the
// token page renders it as "largest holder (as observed on-chain)".
// The fee-stream half (Distributor routes a tithe share to the king) is
// a Phase B settlement build; this module never vetoes and never moves
// value. Exempt accounts (pool vaults, fee vaults) can never be king,
// and pool-internal moves (both sides exempt) do not touch the record.
fn module_king_of_pool(program_id: &Pubkey, _rule: &RuleEntry, ctx: &ExecuteCtx<'_, '_>) -> ProgramResult {
    if ctx.source.key == ctx.dest.key {
        return Ok(()); // self-transfer: no balance changes
    }
    let src_exempt = ctx.cfg.is_exempt(&ctx.src_owner, ctx.source.key);
    let dst_exempt = ctx.cfg.is_exempt(&ctx.dst_owner, ctx.dest.key);
    if src_exempt && dst_exempt {
        return Ok(()); // pool-internal move
    }
    ensure_king(program_id, ctx.king(), ctx.rent_vault(), ctx.system(), ctx.mint.key)?;
    let now = Clock::get()?.unix_timestamp;
    let src_post = token_amount(&ctx.source)?;
    let dst_post = token_amount(&ctx.dest)?;
    let mut d = ctx.king().try_borrow_mut_data()?;
    if d.len() < KING_SPACE || d[0] != 1 {
        return Err(EngineError::BadState.into());
    }
    let mut king_acct = read_key(&d, KING_ACCT_OFF);
    let mut king_bal = read_u64(&d, KING_BAL_OFF);
    // Refresh: the reigning king's balance follows its own transfers.
    if king_acct == *ctx.source.key {
        king_bal = src_post;
    }
    if king_acct == *ctx.dest.key {
        king_bal = dst_post;
    }
    // Crown: a non-exempt party beating the (refreshed) record. The
    // destination is evaluated first — it is the only side whose balance
    // grew; the source side can only fire against a stale-low record.
    let mut crown: Option<(Pubkey, Pubkey, u64)> = None;
    if !dst_exempt && *ctx.dest.key != king_acct && dst_post > king_bal {
        crown = Some((*ctx.dest.key, ctx.dst_owner, dst_post));
    } else if !src_exempt && *ctx.source.key != king_acct && src_post > king_bal {
        crown = Some((*ctx.source.key, ctx.src_owner, src_post));
    }
    match crown {
        Some((acct, owner, bal)) => {
            king_bal = bal;
            d[KING_ACCT_OFF..KING_ACCT_OFF + 32].copy_from_slice(acct.as_ref());
            d[KING_OWNER_OFF..KING_OWNER_OFF + 32].copy_from_slice(owner.as_ref());
            msg!("engine: king of the pool: {} ({} tokens)", owner, bal);
        }
        None => {
            // No crowning: persist a refresh if the king was a party.
            if king_acct != *ctx.source.key && king_acct != *ctx.dest.key {
                return Ok(());
            }
        }
    }
    d[KING_BAL_OFF..KING_BAL_OFF + 8].copy_from_slice(&king_bal.to_le_bytes());
    d[KING_TS_OFF..KING_TS_OFF + 8].copy_from_slice(&now.to_le_bytes());
    Ok(())
}

// ---------- SetBlocklist (tag 12) ----------
// Accounts: [authority(signer), mint, config(ro), lists_pda(w), system]
// Data: [0] tag, [1] count u8, [2..] entries x 32B owner pubkeys.
// Writes the rule-10 blocklist into the Lists PDA (created at full size
// on first write, authority-funded). "Sealed" is literal under Locked
// configs: the first write is the only write — a Locked config can never
// have its blocklist edited after launch. Under Creator/Agent modes the
// config authority may replace the list (the config's authority gates
// every write; HolderVote configs reject direct writes like
// UpdateConfig does — the vote program is a later workstream).
fn set_blocklist(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;
    let lists_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if *lists_ai.key != lists_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let cfg = load_config(config_ai, program_id)?;
    if cfg.mint != *mint.key {
        return Err(EngineError::BadConfig.into());
    }
    if cfg.authority_mode == MODE_HOLDER_VOTE {
        msg!("engine: HolderVote blocklist writes need the vote program");
        return Err(EngineError::UnsupportedMode.into());
    }
    if !authority.is_signer || *authority.key != cfg.authority {
        return Err(EngineError::BadAuthority.into());
    }
    if data.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let count = data[1] as usize;
    if count > MAX_BLOCKLIST || data.len() < 2 + count * 32 {
        msg!("engine: rejected blocklist write ({} entries)", count);
        return Err(ProgramError::InvalidInstructionData);
    }
    if lists_ai.data_len() == 0 {
        create_pda(program_id, authority, lists_ai, system, &[b"lists", mint.key.as_ref()], LISTS_SPACE)?;
    } else {
        if lists_ai.owner != program_id {
            return Err(EngineError::BadState.into());
        }
        if cfg.authority_mode == MODE_LOCKED {
            msg!("engine: blocklist is sealed under a Locked config");
            return Err(EngineError::AlreadyInit.into());
        }
        let d = lists_ai.try_borrow_data()?;
        if d.len() < LISTS_SPACE || d[0] != 1 {
            return Err(EngineError::BadState.into());
        }
    }
    let mut d = lists_ai.try_borrow_mut_data()?;
    for b in d.iter_mut() {
        *b = 0;
    }
    d[0] = 1;
    d[1] = if cfg.authority_mode == MODE_LOCKED { 1 } else { 0 };
    d[2..4].copy_from_slice(&(count as u16).to_le_bytes());
    for i in 0..count {
        d[4 + i * 32..4 + (i + 1) * 32].copy_from_slice(&data[2 + i * 32..2 + (i + 1) * 32]);
    }
    msg!("engine: blocklist written ({} entries, sealed {})", count, d[1]);
    Ok(())
}

// ---------- SetAllowlistEntry (tag 13) ----------
// Accounts: [authority(signer), mint, config(ro), target_token_account(ro),
//            allow_pda(w), system]
// Data: [0] tag, [1] active u8 (0/1).
// Sets one destination account's rule-10 allowlist entry. Entry
// management is operational data, not a rule change: the config
// authority may write entries under EVERY authority mode (including
// Locked — the rule itself is what the config locks; a Locked token
// with an unmaintainable allowlist would be a brick). The target token
// account need not exist yet (its address is computable — pre-approving
// a wallet's ATA before its first receive is the canonical use); when
// it exists its mint field must match.
fn set_allowlist_entry(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;
    let target = next_account_info(it)?;
    let allow_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if *allow_ai.key != allow_pda(mint.key, target.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let cfg = load_config(config_ai, program_id)?;
    if cfg.mint != *mint.key {
        return Err(EngineError::BadConfig.into());
    }
    if cfg.authority_mode == MODE_HOLDER_VOTE {
        msg!("engine: HolderVote allowlist writes need the vote program");
        return Err(EngineError::UnsupportedMode.into());
    }
    if !authority.is_signer || *authority.key != cfg.authority {
        return Err(EngineError::BadAuthority.into());
    }
    if target.data_len() > 0 && token_mint(target)? != *mint.key {
        msg!("engine: allowlist target is a token account of a different mint");
        return Err(ProgramError::InvalidAccountData);
    }
    if data.len() < 2 || data[1] > 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if allow_ai.data_len() == 0 {
        create_pda(program_id, authority, allow_ai, system, &[b"allow", mint.key.as_ref(), target.key.as_ref()], ALLOW_SPACE)?;
    } else if allow_ai.owner != program_id {
        return Err(EngineError::BadState.into());
    }
    let now = Clock::get()?.unix_timestamp;
    let mut d = allow_ai.try_borrow_mut_data()?;
    if d.len() < ALLOW_SPACE {
        return Err(EngineError::BadState.into());
    }
    d[0] = 1;
    d[1] = data[1];
    d[2..10].copy_from_slice(&now.to_le_bytes());
    msg!("engine: allowlist entry for {} set active={}", target.key, data[1]);
    Ok(())
}

// ---------- rule 1: BASIS LATCH (TaxHarvest, ported faithfully) ----------
// params (64B):
//   [0..8]   max_stale_secs u64   (0 = default 300) — feed older than this
//            fails the gate closed (StalePrice), TH's stale check.
//   [8..16]  ema_half_life_secs u64 (crank-side; read by CrankPrice)
//   [16..18] max_crank_bps u16    (crank-side; read by CrankPrice)
//   [18]     mode u8: 0 = LATCH (spec SS5 rule 1), 1 = LIVE (TH's other
//            mode), 2 = GRADUATED (below). Validated at config write:
//            mode > 2 is rejected.
//   [19..21] base_frac_bps u16    (GRADUATED only; validated <= 10_000 at
//            config write) — the floor of the earned fraction.
//   [21..29] vesting_secs u64     (GRADUATED only; 0 = default 432_000 =
//            5 days) — the linear time-vesting window from the anchor.
//   [29..31] dip_mult_bps u16     (GRADUATED only; 0 = default 20_000 =
//            2x) — multiplier applied to the observed dip fraction.
//   [31..64] reserved
//
// GATE (sender side; skipped for exempt sources — pool vaults et al.):
//   stale feed -> veto; no basis record -> veto (BasisMissing);
//   unlocked := latched || ema < basis; in LATCH mode the first evaluation
//   with ema < basis SETS latched (persists in the Holder PDA), so a later
//   recovery never re-locks; in LIVE mode unlocked := ema < basis only.
//   Not unlocked -> veto (Locked). Basis is the fee-inclusive entry record,
//   exactly TH's semantics.
// BOOKKEEPING (recipient side; skipped for exempt destinations and
// self-transfers): unit basis = feed EMA when the source is exempt (a buy
// off the pool/venue), else the sender's carried basis (wallet-to-wallet
// carry); blends into the recipient's basis against POST-TRANSFER balances:
//   old_bal = post_bal - amount   (Token-2022 has already applied the move)
//   new_basis = (old_bal * old_basis + amount * unit_basis) / post_bal
// Buys at a lower price therefore ratchet the basis down; a receive into a
// zero balance starts fresh at the unit basis. (TH's literal formula
// weighted by the post-transfer balance AND the amount — double-counting
// the in-flight amount; corrected here, invariants identical.)
//
// GRADUATED mode (2) — partial unlocks instead of the all-or-nothing
// LATCH/LIVE gate. Modes 0/1 keep the exact behavior above and never
// touch Holder bytes >= 136; everything below is graduated-only, stored
// in the extended Holder region (grad_peak / grad_sold / grad_cap /
// grad_anchor / grad_min_price; see the Holder layout). A graduated
// holder may sell only up to an EARNED CAP on their position:
//   earned_frac = max(base_frac_bps,
//                     time_frac  = elapsed-since-anchor / vesting_secs,
//                     dip_frac   = (basis - min_price) / basis
//                                  * dip_mult_bps,
//                     10_000 once latched)
//   cap = max(cap, earned_frac * peak)        — ratchets UP only, so a
// fraction once earned is never taken back by a price recovery, a later
// anchor shift, or a bigger peak diluting an already-earned allowance.
// GATE: the stale/basis checks are shared with modes 0/1; the sender's
// holder is migrated first (ensure_graduated), grad_min_price folds the
// current EMA in and the latch byte is SET the first time ema < basis
// (from then on the fraction is 10_000 — the full position is earned,
// exactly the terminal state of LATCH). A position lazily OPENS on the
// first gated sell (anchor = now, peak = pre-transfer balance). Then the
// cap ratchets and the sell is measured: sold + amount > cap vetoes
// PartialLocked; otherwise sold accrues. A sell that empties the source
// (full exit) zeroes the whole graduated region [136..192]; basis and
// latched below 136 persist. True self-transfers are a no-op.
// BOOKKEEPING additions (after the shared basis blend): a receive into
// a zero balance OPENS the position (anchor = now, sold = cap = 0,
// peak = post_bal, min_price = ema); a receive into an open position
// re-anchors by balance weight (anchor blends old_bal/amt at now),
// raises peak to the new post-transfer high, and folds ema into
// min_price; sold carries over untouched. Either way the cap ratchets
// once more against the post-update state at the NEW basis, so a fresh
// receive can itself earn cap (e.g. the base fraction) immediately.
fn latch_max_stale(params: &[u8; PARAMS_LEN]) -> i64 {
    let v = read_u64(params, 0);
    if v == 0 { 300 } else { v as i64 }
}

/// GRADUATED earned fraction, in bps of the holder's peak balance:
/// max(base_frac, time_frac, dip_frac) — or the full 10_000 once the
/// latch byte is set (d is the holder's data, already migrated to the
/// extended layout; latched is read from d[38] here so callers holding
/// a mutable borrow can fold it in without a second read). All math is
/// u128 intermediates with floor division, in exactly this operation
/// order: time_frac = min(10_000, elapsed * 10_000 / vesting) with
/// elapsed measured from the anchor (0 when no position is open);
/// dip_frac = min(10_000, ((basis - min_price) * 10_000 / basis)
/// * dip_mult / 10_000), 0 unless a dip below basis was observed.
fn grad_frac_bps(d: &[u8], basis: u128, now: i64, params: &[u8; PARAMS_LEN]) -> u64 {
    if d[38] == 1 {
        return 10_000;
    }
    let base = read_u16(params, 19) as u128;
    let vesting = {
        let v = read_u64(params, 21);
        if v == 0 { 432_000u128 } else { v as u128 }
    };
    let dip_mult = {
        let v = read_u16(params, 29);
        if v == 0 { 20_000u128 } else { v as u128 }
    };
    let anchor = read_i64(d, GRAD_ANCHOR_OFF);
    let elapsed: u128 = if anchor == 0 {
        0
    } else {
        (now - anchor).max(0) as u128
    };
    let time_frac = (elapsed * 10_000 / vesting).min(10_000);
    let min_price = read_u128(d, GRAD_MIN_PRICE_OFF);
    let dip_frac: u128 = if min_price > 0 && basis > 0 && min_price < basis {
        (((basis - min_price) * 10_000 / basis) * dip_mult / 10_000).min(10_000)
    } else {
        0
    };
    base.max(time_frac).max(dip_frac) as u64
}

fn module_basis_latch(program_id: &Pubkey, rule: &RuleEntry, ctx: &ExecuteCtx<'_, '_>) -> ProgramResult {
    let mode = rule.params[18];
    let live_mode = mode == 1;
    let graduated = mode == 2;
    if graduated && ctx.source.key == ctx.dest.key {
        return Ok(()); // GRADUATED: true self-transfer is a no-op (pre-feed)
    }
    let max_stale = latch_max_stale(&rule.params);
    let src_exempt = ctx.cfg.is_exempt(&ctx.src_owner, ctx.source.key);
    let dst_exempt = ctx.cfg.is_exempt(&ctx.dst_owner, ctx.dest.key);
    if src_exempt && dst_exempt {
        return Ok(()); // pure pool-side move: nothing to gate or record
    }
    // The feed joins every path below (gate reads ema; bookkeeping prices
    // buys at ema). Missing/corrupt feed = fail closed.
    let feed = load_feed(ctx.price_feed(), program_id)?;
    let ema = feed.ema_price;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // ---- GATE ----
    let mut carried_basis: Option<u128> = None;
    if !src_exempt {
        if feed.last_crank_ts == 0 || now.saturating_sub(feed.last_crank_ts) > max_stale {
            msg!("engine: locked: stale price feed");
            return Err(EngineError::StalePrice.into());
        }
        if !holder_valid(ctx.src_holder(), program_id)? {
            msg!("engine: locked: no basis record");
            return Err(EngineError::BasisMissing.into());
        }
        let basis = match holder_basis(ctx.src_holder())? {
            Some(b) => b,
            None => {
                msg!("engine: locked: no basis record");
                return Err(EngineError::BasisMissing.into());
            }
        };
        carried_basis = Some(basis);
        if graduated {
            // ---- GRADUATED gate (replaces the all-or-nothing lock) ----
            ensure_graduated(program_id, ctx.src_holder(), ctx.rent_vault(), ctx.system(), ctx.mint.key, &ctx.src_owner)?;
            // Source balance is POST-transfer; read it BEFORE the mutable
            // borrow below (post + amount = the pre-transfer position).
            let src_post_bal = token_amount(&ctx.source)?;
            let mut d = ctx.src_holder().try_borrow_mut_data()?;
            // One mutable borrow: min-price fold, latch set, lazy
            // position-open, cap ratchet, sold accrual.
            let old_min = read_u128(&d, GRAD_MIN_PRICE_OFF);
            let new_min = if old_min == 0 { ema } else { old_min.min(ema) };
            if new_min != old_min {
                d[GRAD_MIN_PRICE_OFF..GRAD_MIN_PRICE_OFF + 16].copy_from_slice(&new_min.to_le_bytes());
            }
            if ema < basis && d[38] != 1 {
                d[38] = 1;
                msg!("engine: latch set for sender");
            }
            if read_i64(&d, GRAD_ANCHOR_OFF) == 0 {
                d[GRAD_ANCHOR_OFF..GRAD_ANCHOR_OFF + 8].copy_from_slice(&now.to_le_bytes());
                if read_u64(&d, GRAD_PEAK_OFF) == 0 {
                    let peak = src_post_bal.saturating_add(ctx.amount);
                    d[GRAD_PEAK_OFF..GRAD_PEAK_OFF + 8].copy_from_slice(&peak.to_le_bytes());
                }
            }
            let frac = grad_frac_bps(&d, basis, now, &rule.params);
            let peak = read_u64(&d, GRAD_PEAK_OFF) as u128;
            let old_cap = read_u64(&d, GRAD_CAP_OFF) as u128;
            let cap = old_cap.max((frac as u128) * peak / 10_000);
            if cap != old_cap {
                d[GRAD_CAP_OFF..GRAD_CAP_OFF + 8].copy_from_slice(&(cap as u64).to_le_bytes());
            }
            let sold = read_u64(&d, GRAD_SOLD_OFF) as u128;
            if sold + (ctx.amount as u128) > cap {
                msg!("engine: partially locked: sold {} + amount {} > earned cap {} ({} bps of peak {})", sold, ctx.amount, cap, frac, peak);
                return Err(EngineError::PartialLocked.into());
            }
            let new_sold = (sold + (ctx.amount as u128)) as u64;
            d[GRAD_SOLD_OFF..GRAD_SOLD_OFF + 8].copy_from_slice(&new_sold.to_le_bytes());
            d[47..55].copy_from_slice(&now.to_le_bytes()); // last_sell_ts
            if src_post_bal == 0 {
                // Full exit: reset the graduated position (basis and the
                // latched byte, both below 136, persist).
                for b in d[HOLDER_SPACE..HOLDER_SPACE_V2].iter_mut() {
                    *b = 0;
                }
            }
        } else {
            let latched = holder_latched(ctx.src_holder())?;
            let unlocked = if ema < basis {
                if !live_mode && !latched {
                    let mut d = ctx.src_holder().try_borrow_mut_data()?;
                    d[38] = 1;
                    msg!("engine: latch set for sender");
                }
                true
            } else {
                !live_mode && latched
            };
            if !unlocked {
                msg!("engine: locked: price {} >= basis {}", ema, basis);
                return Err(EngineError::Locked.into());
            }
            let mut d = ctx.src_holder().try_borrow_mut_data()?;
            d[47..55].copy_from_slice(&now.to_le_bytes()); // last_sell_ts
        }
    }

    // ---- BOOKKEEPING ----
    if !dst_exempt && ctx.src_holder().key != ctx.dst_holder().key {
        let unit_basis = if src_exempt {
            ema // a buy: entry at the current reference price
        } else {
            // wallet-to-wallet: carry the sender's basis (gate read it).
            match carried_basis {
                Some(b) => b,
                None => ema,
            }
        };
        if ctx.dst_holder().data_len() == 0 {
            ensure_dst_holder(
                program_id,
                ctx.dst_holder(),
                ctx.rent_vault(),
                ctx.system(),
                ctx.mint.key,
                ctx.dest.key,
                if graduated { HOLDER_SPACE_V2 } else { HOLDER_SPACE },
            )?;
        } else if !holder_valid(ctx.dst_holder(), program_id)? {
            return Err(EngineError::BadState.into());
        }
        if graduated {
            // A just-created dst holder is already HOLDER_SPACE_V2 (above);
            // a pre-existing legacy one migrates here, before any borrow
            // of its data for the updates below.
            ensure_graduated(program_id, ctx.dst_holder(), ctx.rent_vault(), ctx.system(), ctx.mint.key, &ctx.dst_owner)?;
        }
        let post_bal = token_amount(&ctx.dest)? as u128;
        let amt = ctx.amount as u128;
        let old_bal = post_bal.checked_sub(amt).ok_or(EngineError::MathOverflow)?;
        let old_basis = holder_basis(ctx.dst_holder())?.unwrap_or(0);
        let new_basis = if post_bal == 0 {
            unit_basis
        } else {
            old_bal
                .checked_mul(old_basis)
                .and_then(|v| v.checked_add(amt.checked_mul(unit_basis)?))
                .ok_or(EngineError::MathOverflow)?
                / post_bal
        };
        let mut d = ctx.dst_holder().try_borrow_mut_data()?;
        d[6..22].copy_from_slice(&new_basis.to_le_bytes()); // basis_num
        d[22..38].copy_from_slice(&1u128.to_le_bytes()); // basis_den = 1
        d[39..47].copy_from_slice(&now.to_le_bytes()); // last_buy_ts
        if graduated {
            // GRADUATED bookkeeping (same borrow, after the basis blend):
            // fresh balance opens the position; an open position
            // re-anchors by balance weight, peaks, and folds the EMA
            // into min_price; sold carries over untouched.
            if old_bal == 0 {
                d[GRAD_ANCHOR_OFF..GRAD_ANCHOR_OFF + 8].copy_from_slice(&now.to_le_bytes());
                d[GRAD_SOLD_OFF..GRAD_SOLD_OFF + 8].copy_from_slice(&0u64.to_le_bytes());
                d[GRAD_CAP_OFF..GRAD_CAP_OFF + 8].copy_from_slice(&0u64.to_le_bytes());
                d[GRAD_PEAK_OFF..GRAD_PEAK_OFF + 8].copy_from_slice(&(post_bal as u64).to_le_bytes());
                d[GRAD_MIN_PRICE_OFF..GRAD_MIN_PRICE_OFF + 16].copy_from_slice(&ema.to_le_bytes());
            } else {
                let old_anchor = read_i64(&d, GRAD_ANCHOR_OFF);
                let new_anchor = if old_anchor == 0 {
                    now
                } else {
                    ((old_bal as i128 * old_anchor as i128 + amt as i128 * now as i128)
                        / post_bal as i128) as i64
                };
                d[GRAD_ANCHOR_OFF..GRAD_ANCHOR_OFF + 8].copy_from_slice(&new_anchor.to_le_bytes());
                let old_peak = read_u64(&d, GRAD_PEAK_OFF);
                let new_peak = old_peak.max(post_bal as u64);
                if new_peak != old_peak {
                    d[GRAD_PEAK_OFF..GRAD_PEAK_OFF + 8].copy_from_slice(&new_peak.to_le_bytes());
                }
                let old_min = read_u128(&d, GRAD_MIN_PRICE_OFF);
                let new_min = if old_min == 0 { ema } else { old_min.min(ema) };
                if new_min != old_min {
                    d[GRAD_MIN_PRICE_OFF..GRAD_MIN_PRICE_OFF + 16].copy_from_slice(&new_min.to_le_bytes());
                }
            }
            // Ratchet the cap against the POST-update state at the new
            // basis (the latch byte is read from d[38] by grad_frac_bps).
            let frac = grad_frac_bps(&d, new_basis, now, &rule.params);
            let peak = read_u64(&d, GRAD_PEAK_OFF) as u128;
            let old_cap = read_u64(&d, GRAD_CAP_OFF) as u128;
            let cap = old_cap.max((frac as u128) * peak / 10_000);
            if cap != old_cap {
                d[GRAD_CAP_OFF..GRAD_CAP_OFF + 8].copy_from_slice(&(cap as u64).to_le_bytes());
            }
        }
        msg!("engine: recipient basis {} (unit {})", new_basis, unit_basis);
    }
    Ok(())
}

// ---------- rule 7: P2P TOGGLE ----------
// params: [0] mode — 0 = P2P-only, 1 = No-P2P (validated at config write).
// The signal is the transfer's CALLER CONTEXT (ctx.venue_context), not the
// counterparties: any transfer whose executing top-level instruction is a
// config-allowlisted venue program is a venue transfer. Config exemptions
// deliberately do NOT rescue a transfer here — the counterparty on a venue
// trade is the (exempt) pool by construction, so exempting either side
// would make the rule vacuous. (Pool seeding precedes config/meta init in
// the canonical launch order, so creation flows are unaffected.)
fn module_p2p_toggle(rule: &RuleEntry, ctx: &ExecuteCtx<'_, '_>) -> ProgramResult {
    match (rule.params[0], ctx.venue_context) {
        (0, true) => {
            msg!("engine: venue transfer forbidden (p2p-only)");
            Err(EngineError::VenueTransferForbidden.into())
        }
        (1, false) => {
            msg!("engine: wallet transfer forbidden (no-p2p)");
            Err(EngineError::P2PTransferForbidden.into())
        }
        _ => Ok(()),
    }
}

// ---------- rule 8: HOLDER-GATED ----------
// params: [0..32] gate mint pubkey, [32..40] min_amount u64 (raw units).
// The destination owner must hold >= min_amount of the gate mint.
//
// Why a MIRROR (SyncGateBalance), not a meta and not an appended account:
// a gate ATA is a PDA of the ATA program, so no seeded meta can name it
// (metas resolve under the hook program's id); and Token-2022 forwards
// ONLY the resolved meta tail to Execute (probe-proven: appended accounts
// never arrive, in any position). So the balance is mirrored into the
// destination's Holder PDA by a companion instruction in the SAME
// transaction, bound on both sides by instruction introspection:
//   - SyncGateBalance validates the presented account IS the owner's
//     canonical gate ATA (key == ATA(owner, token program, gate mint);
//     account fields re-checked) and requires the NEXT instruction in the
//     tx to be the Token-2022 transfer into that destination.
//   - Execute requires a SyncGateBalance for (this mint, dst owner) to
//     sit immediately before the transfer instruction (a SyncRegistered
//     may sit between, nothing else), then compares the mirrored balance.
// No in-between instruction can move gate tokens, so the mirror cannot be
// stale within its transaction. Transfers built without the sync (venues
// resolving only the meta list, e.g. DBC today) fail closed — rule 8 is a
// client-surface rule in v1 (launcher trade page / skill); see
// BUILD-NOTES.
const GATE_BAL_OFF: usize = 103; // holder custom scratch, namespaced to rule 8
const GATE_TS_OFF: usize = 111;

/// Validate that `ai` is `owner`'s canonical ATA for `gate_mint` (under the
/// account's own token program) and return its live balance.
fn validate_gate_account(ai: &AccountInfo, owner: &Pubkey, gate_mint: &Pubkey) -> Result<u64, ProgramError> {
    let token_program = Pubkey::from_str(TOKEN_ID).unwrap();
    if *ai.owner != token_program && *ai.owner != token_2022_id() {
        msg!("engine: bad gate account (owner is not a token program)");
        return Err(EngineError::BadGateAccount.into());
    }
    let ata_program = Pubkey::from_str(ATA_PROGRAM_ID).unwrap();
    let expect = Pubkey::find_program_address(
        &[owner.as_ref(), ai.owner.as_ref(), gate_mint.as_ref()],
        &ata_program,
    )
    .0;
    if *ai.key != expect {
        msg!("engine: bad gate account (not the canonical ATA)");
        return Err(EngineError::BadGateAccount.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < 72 || read_key(&d, 0) != *gate_mint || read_key(&d, 32) != *owner {
        msg!("engine: bad gate account (field mismatch)");
        return Err(EngineError::BadGateAccount.into());
    }
    Ok(read_u64(&d, 64))
}

// Accounts: [caller(signer,w), mint, config(ro), owner(ro), holder_pda(w),
//            system, gate_token_account(ro), dest_token_account(ro),
//            instructions_sysvar(ro)]
// Permissionless: the mirrored value is fully validated on-chain; the
// caller only pays if the Holder PDA must be created.
fn sync_gate_balance(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let caller = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;
    let owner = next_account_info(it)?;
    let holder_ai = next_account_info(it)?;
    let system = next_account_info(it)?;
    let gate_ai = next_account_info(it)?;
    let dest_ai = next_account_info(it)?;
    let ix_sysvar = next_account_info(it)?;

    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let cfg = load_config(config_ai, program_id)?;
    let rule = cfg
        .rules
        .iter()
        .find(|r| r.enabled && r.rule_id == RULE_HOLDER_GATED)
        .ok_or(ProgramError::InvalidInstructionData)?;
    let gate_mint = read_key(&rule.params, 0);
    // v3: the mirror lands in the record keyed by the DESTINATION token
    // account of the bound transfer (accounts[7]) — the record Execute
    // will read for that transfer — not the owner's record.
    if *holder_ai.key != holder_pda(mint.key, dest_ai.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    // The destination account must be a token account OF this mint owned by
    // `owner` — the balance credit is bound to that transfer's recipient.
    {
        let d = dest_ai.try_borrow_data()?;
        if d.len() < 72 || read_key(&d, 0) != *mint.key || read_key(&d, 32) != *owner.key {
            msg!("engine: bad gate account (destination mismatch)");
            return Err(EngineError::BadGateAccount.into());
        }
    }
    let amount = validate_gate_account(gate_ai, owner.key, &gate_mint)?;

    // The NEXT instruction must be the transfer this sync serves.
    if *ix_sysvar.key != solana_program::sysvar::instructions::ID {
        return Err(EngineError::BadCaller.into());
    }
    let cur = load_current_index_checked(ix_sysvar)? as usize;
    let next = load_instruction_at_checked(cur + 1, ix_sysvar)
        .map_err(|_| EngineError::BadCaller)?;
    if next.program_id != token_2022_id()
        || !matches!(next.data.first(), Some(3) | Some(12))
        || next.accounts.len() < 4
        || next.accounts[1].pubkey != *mint.key
        || next.accounts[2].pubkey != *dest_ai.key
    {
        msg!("engine: gate sync not followed by the bound transfer");
        return Err(EngineError::BadCaller.into());
    }

    if holder_ai.data_len() == 0 {
        create_pda(program_id, caller, holder_ai, system, &[b"holder", mint.key.as_ref(), dest_ai.key.as_ref()], holder_create_size(&cfg))?;
        init_holder_data(holder_ai)?;
    } else if holder_ai.owner != program_id {
        return Err(EngineError::BadState.into());
    }
    let now = Clock::get()?.unix_timestamp;
    let mut d = holder_ai.try_borrow_mut_data()?;
    if d.len() < HOLDER_SPACE || d[0] != 1 {
        return Err(EngineError::BadState.into());
    }
    d[GATE_BAL_OFF..GATE_BAL_OFF + 8].copy_from_slice(&amount.to_le_bytes());
    d[GATE_TS_OFF..GATE_TS_OFF + 8].copy_from_slice(&now.to_le_bytes());
    msg!("engine: gate balance synced {} for {}", amount, owner.key);
    Ok(())
}

fn module_holder_gated(program_id: &Pubkey, rule: &RuleEntry, ctx: &ExecuteCtx<'_, '_>) -> ProgramResult {
    if ctx.cfg.is_exempt(&ctx.dst_owner, ctx.dest.key) {
        return Ok(());
    }
    let min_amount = read_u64(&rule.params, 32);
    // A SyncGateBalance for (this mint, dst owner) must be in THIS
    // transaction, adjacent to the transfer: scan back from the current
    // instruction, skipping only engine sync instructions (SyncRegistered
    // may sit between); anything else breaks the chain = no fresh sync.
    let cur = load_current_index_checked(&ctx.ix_sysvar)? as usize;
    let mut synced = false;
    let mut i = cur;
    while i > 0 {
        i -= 1;
        let ix = match load_instruction_at_checked(i, &ctx.ix_sysvar) {
            Ok(v) => v,
            Err(_) => break,
        };
        if ix.program_id != *program_id {
            break;
        }
        match ix.data.first() {
            Some(7) => {
                // SyncGateBalance accounts: [caller, mint, config, owner, ...]
                if ix.accounts.len() >= 4
                    && ix.accounts[1].pubkey == *ctx.mint.key
                    && ix.accounts[3].pubkey == ctx.dst_owner
                {
                    synced = true;
                }
                break;
            }
            Some(4) => continue, // SyncRegistered may sit between
            _ => break,
        }
    }
    if !synced {
        msg!("engine: holder gate sync missing for {}", ctx.dst_owner);
        return Err(EngineError::NotGateHolder.into());
    }
    if !holder_valid(ctx.dst_holder(), program_id)? {
        msg!("engine: holder gate sync missing for {}", ctx.dst_owner);
        return Err(EngineError::NotGateHolder.into());
    }
    let bal = {
        let d = ctx.dst_holder().try_borrow_data()?;
        read_u64(&d, GATE_BAL_OFF)
    };
    if bal >= min_amount {
        return Ok(());
    }
    msg!("engine: holder gate failed ({} of {} gate tokens)", bal, min_amount);
    Err(EngineError::NotGateHolder.into())
}

// ---------- MigrateHolder (tag 10; v3 retrofit) ----------
// Accounts: [mint, config(ro), owner(ro), owner_ata(ro), old_holder(w),
//            new_holder(w), rent_vault(w), system]
// Permissionless. Copies a wallet's legacy owner-keyed Holder PDA
// (["holder", mint, owner] — the v2 derivation) VERBATIM to its v3
// account-keyed address (["holder", mint, owner_ata]) and closes the
// legacy account, refunding its rent to the rent vault. The layouts are
// identical — only the address changes — so no field is reinterpreted.
// The new account is created at max(legacy size, the config's creation
// size) from the rent vault; at equal sizes the migration is rent-
// neutral to the vault (creation out, closure refund in). Sequencing
// (SPEC-ENGINE-V3 SS9.3): run the crank for every holder BEFORE the
// program upgrade flips the meta lists; this instruction reads only
// legacy state, works identically before or after the flip, and stays
// in the program permanently so stragglers self-heal. A missing legacy
// record fails HolderMissing; an already-existing v3 record fails
// AlreadyInit (two live records are a SyncHolder merge, not a copy).
fn migrate_holder(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;
    let owner = next_account_info(it)?;
    let owner_ata = next_account_info(it)?;
    let old_holder = next_account_info(it)?;
    let new_holder = next_account_info(it)?;
    let rent_vault = next_account_info(it)?;
    let system = next_account_info(it)?;

    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let cfg = load_config(config_ai, program_id)?;
    // The presented account must really be `owner`'s token account for
    // this mint — the new record's address is derived from its key, so
    // a mismatched binding would strand the copied state.
    if token_mint(owner_ata)? != *mint.key || token_owner(owner_ata)? != *owner.key {
        msg!("engine: migrate: presented account is not the owner's account for this mint");
        return Err(EngineError::BadState.into());
    }
    if *old_holder.key != holder_pda_legacy(mint.key, owner.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if *new_holder.key != holder_pda(mint.key, owner_ata.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if !holder_valid(old_holder, program_id)? {
        msg!("engine: migrate: no legacy holder record for {}", owner.key);
        return Err(EngineError::HolderMissing.into());
    }
    if new_holder.data_len() > 0 {
        msg!("engine: migrate: v3 record already exists for {} — use SyncHolder to merge", owner_ata.key);
        return Err(EngineError::AlreadyInit.into());
    }
    let old_len = old_holder.data_len();
    let size = old_len.max(holder_create_size(&cfg));
    create_holder_from_vault(program_id, new_holder, rent_vault, system, mint.key, owner_ata.key, size)?;
    {
        let src = old_holder.try_borrow_data()?;
        let mut dst = new_holder.try_borrow_mut_data()?;
        dst[..old_len].copy_from_slice(&src[..old_len]);
    }
    close_pda_to_vault(old_holder, rent_vault)?;
    msg!("engine: holder migrated {} -> {} ({} bytes, verbatim)", old_holder.key, new_holder.key, old_len);
    Ok(())
}

// ---------- SyncHolder (tag 11; v3 record merge) ----------
// Accounts: [owner(signer), mint, config(ro), src_token_acct(ro),
//            dst_token_acct(ro), src_holder(w), dst_holder(w),
//            rent_vault(w), system]
// Merges the SOURCE token account's Holder record into the DESTINATION
// token account's record (both accounts must belong to the signing
// owner and to this mint), then closes the source record and refunds
// its rent to the rent vault. This is the repair for the fragmentation
// account-keying introduces (SPEC-ENGINE-V3 SS9.2(ii)): an owner with
// several token accounts holds one record per account; merging
// consolidates them CONSERVATIVELY —
//   registered = OR; ecosystem = dst's if set, else src's;
//   latched = OR;
//   basis = balance-weighted blend of the two recorded bases against
//     LIVE token balances (a side with balance but no recorded basis
//     contributes the OTHER side's basis — the wallet-to-wallet carry
//     rule — never a zero, which would understate the merged basis);
//   anchor = balance-weighted blend of the nonzero anchors;
//   peak = max(src peak, dst peak, combined live balance);
//   sold = src sold + dst sold (both histories charged);
//   cap = min(src cap + dst cap, merged peak) — never more than was
//     earned, never more than the position;
//   min_price = min of the nonzero pair;
//   gate mirror (rule 8 region) = the larger balance, with its ts;
//   last_buy/last_sell = max. The reward region [71..103] keeps the
//   DESTINATION's values (the Distributor owns reward state outright;
//   its Claim PDAs are wallet-keyed and untouched by this merge).
// The destination record is created (rent-vault funded) if missing,
// and grown to the extended layout first if either side carries
// graduated state. Merging an account into itself is rejected — it
// would close the only record.
fn sync_holder(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let owner = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;
    let src_acct = next_account_info(it)?;
    let dst_acct = next_account_info(it)?;
    let src_holder = next_account_info(it)?;
    let dst_holder = next_account_info(it)?;
    let rent_vault = next_account_info(it)?;
    let system = next_account_info(it)?;

    if !owner.is_signer {
        return Err(EngineError::BadAuthority.into());
    }
    if *config_ai.key != config_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let cfg = load_config(config_ai, program_id)?;
    if src_acct.key == dst_acct.key {
        msg!("engine: sync holder: source and destination are the same account");
        return Err(ProgramError::InvalidInstructionData);
    }
    for acct in [src_acct, dst_acct] {
        if token_mint(acct)? != *mint.key || token_owner(acct)? != *owner.key {
            msg!("engine: sync holder: account {} is not the signer's account for this mint", acct.key);
            return Err(EngineError::BadState.into());
        }
    }
    if *src_holder.key != holder_pda(mint.key, src_acct.key, program_id)
        || *dst_holder.key != holder_pda(mint.key, dst_acct.key, program_id)
    {
        return Err(ProgramError::InvalidSeeds);
    }
    if !holder_valid(src_holder, program_id)? {
        msg!("engine: sync holder: no source record for {}", src_acct.key);
        return Err(EngineError::HolderMissing.into());
    }
    let dst_existed = holder_valid(dst_holder, program_id)?;

    // Snapshots first: creation/growth CPIs below must not interleave
    // with live borrows of either record.
    let s: Vec<u8> = src_holder.try_borrow_data()?.to_vec();
    let d0: Vec<u8> = if dst_existed {
        dst_holder.try_borrow_data()?.to_vec()
    } else {
        Vec::new()
    };
    let bal_s = token_amount(src_acct)? as u128;
    let bal_d = token_amount(dst_acct)? as u128;
    let bal_total = bal_s + bal_d;

    if !dst_existed {
        create_holder_from_vault(program_id, dst_holder, rent_vault, system, mint.key, dst_acct.key, holder_create_size(&cfg))?;
        init_holder_data(dst_holder)?;
    }
    // Graduated state rides along iff either record is extended; grow
    // the destination first so the merge has somewhere to land.
    let graduated = s.len() >= HOLDER_SPACE_V2 || d0.len() >= HOLDER_SPACE_V2;
    if graduated && dst_holder.data_len() < HOLDER_SPACE_V2 {
        ensure_graduated(program_id, dst_holder, rent_vault, system, mint.key, dst_acct.key)?;
    }

    // ---- field snapshots ----
    let basis_of = |d: &[u8]| -> Option<u128> {
        if d.len() < HOLDER_SPACE {
            return None;
        }
        let num = read_u128(d, 6);
        let den = read_u128(d, 22);
        if num == 0 || den == 0 {
            None
        } else {
            Some(num / den)
        }
    };
    let s_basis = basis_of(&s);
    let d_basis = basis_of(&d0);
    let merged_basis: Option<u128> = match (s_basis, d_basis) {
        (Some(sb), Some(db)) => {
            if bal_total > 0 {
                Some((sb * bal_s + db * bal_d) / bal_total)
            } else {
                Some(db)
            }
        }
        (Some(sb), None) => Some(sb),
        (None, Some(db)) => Some(db),
        (None, None) => None,
    };
    let grad_u64 = |d: &[u8], off: usize| -> u64 {
        if d.len() >= HOLDER_SPACE_V2 {
            read_u64(d, off)
        } else {
            0
        }
    };
    let grad_u128 = |d: &[u8], off: usize| -> u128 {
        if d.len() >= HOLDER_SPACE_V2 {
            read_u128(d, off)
        } else {
            0
        }
    };

    let mut out = if dst_existed {
        d0.clone()
    } else {
        let mut v = vec![0u8; dst_holder.data_len()];
        v[0] = 1;
        v[22..38].copy_from_slice(&1u128.to_le_bytes());
        v
    };
    if out.len() < dst_holder.data_len() {
        out.resize(dst_holder.data_len(), 0);
    }
    // identity / flags
    if s[1] == 1 {
        out[1] = 1;
    }
    if out[2] == 0 {
        out[2] = s[2];
    }
    if s[38] == 1 {
        out[38] = 1;
    }
    // basis
    match merged_basis {
        Some(b) => {
            out[6..22].copy_from_slice(&b.to_le_bytes());
            out[22..38].copy_from_slice(&1u128.to_le_bytes());
        }
        None => {
            out[6..22].copy_from_slice(&0u128.to_le_bytes());
            out[22..38].copy_from_slice(&1u128.to_le_bytes());
        }
    }
    // activity timestamps: most recent wins
    let dcur = out.clone();
    let m_buy = read_i64(&s, 39).max(read_i64(&dcur, 39));
    let m_sell = read_i64(&s, 47).max(read_i64(&dcur, 47));
    out[39..47].copy_from_slice(&m_buy.to_le_bytes());
    out[47..55].copy_from_slice(&m_sell.to_le_bytes());
    // dump window: the pair belonging to the later window start
    if read_i64(&s, 55) > read_i64(&dcur, 55) {
        out[55..71].copy_from_slice(&s[55..71]);
    }
    // rule 8 gate mirror: the larger balance, with its timestamp
    if read_u64(&s, GATE_BAL_OFF) > read_u64(&dcur, GATE_BAL_OFF) {
        out[GATE_BAL_OFF..GATE_BAL_OFF + 8].copy_from_slice(&s[GATE_BAL_OFF..GATE_BAL_OFF + 8]);
        out[GATE_TS_OFF..GATE_TS_OFF + 8].copy_from_slice(&s[GATE_TS_OFF..GATE_TS_OFF + 8]);
    }
    // graduated region
    if graduated {
        let s_anchor = grad_u64(&s, GRAD_ANCHOR_OFF) as i64;
        let d_anchor = grad_u64(&dcur, GRAD_ANCHOR_OFF) as i64;
        let anchor = match (s_anchor != 0, d_anchor != 0) {
            (true, true) => {
                if bal_total > 0 {
                    ((bal_s as i128 * s_anchor as i128 + bal_d as i128 * d_anchor as i128) / bal_total as i128) as i64
                } else {
                    s_anchor.max(d_anchor)
                }
            }
            (true, false) => s_anchor,
            (false, true) => d_anchor,
            (false, false) => 0,
        };
        let peak = (grad_u64(&s, GRAD_PEAK_OFF))
            .max(grad_u64(&dcur, GRAD_PEAK_OFF))
            .max(bal_total as u64);
        let sold = grad_u64(&s, GRAD_SOLD_OFF).saturating_add(grad_u64(&dcur, GRAD_SOLD_OFF));
        let cap = (grad_u64(&s, GRAD_CAP_OFF) as u128 + grad_u64(&dcur, GRAD_CAP_OFF) as u128)
            .min(peak as u128) as u64;
        let s_min = grad_u128(&s, GRAD_MIN_PRICE_OFF);
        let d_min = grad_u128(&dcur, GRAD_MIN_PRICE_OFF);
        let min_price = match (s_min != 0, d_min != 0) {
            (true, true) => s_min.min(d_min),
            (true, false) => s_min,
            (false, true) => d_min,
            (false, false) => 0,
        };
        out[GRAD_PEAK_OFF..GRAD_PEAK_OFF + 8].copy_from_slice(&peak.to_le_bytes());
        out[GRAD_SOLD_OFF..GRAD_SOLD_OFF + 8].copy_from_slice(&sold.to_le_bytes());
        out[GRAD_CAP_OFF..GRAD_CAP_OFF + 8].copy_from_slice(&cap.to_le_bytes());
        out[GRAD_ANCHOR_OFF..GRAD_ANCHOR_OFF + 8].copy_from_slice(&anchor.to_le_bytes());
        out[GRAD_MIN_PRICE_OFF..GRAD_MIN_PRICE_OFF + 16].copy_from_slice(&min_price.to_le_bytes());
    }
    {
        let mut d = dst_holder.try_borrow_mut_data()?;
        d[..out.len()].copy_from_slice(&out);
    }
    close_pda_to_vault(src_holder, rent_vault)?;
    msg!("engine: holder records merged {} -> {} (balances {} + {})", src_acct.key, dst_acct.key, bal_s, bal_d);
    Ok(())
}

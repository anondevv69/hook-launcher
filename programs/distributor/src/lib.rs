// Hook Launcher DISTRIBUTOR — Solana (native, no Anchor).
//
// Spec: SPEC-HOOK-LAUNCHER.md SS4 (fee plumbing), esp. SS4.3 "Holders get the
// fees". An index-accounting fee distributor bound to ONE Token-2022 mint.
// The index/entitlement math is source-agnostic — it distributes whatever
// lands in the vault. How fees REACH the vault is set by the FUNDING MODE
// recorded at initialize (state byte 140), derived from the mint itself:
//
//   * Mode 0 (harvest) — the mint carries the Transfer Fee extension. Fees
//     ACCRUE natively: every transfer withholds fee_bps into the destination
//     account, harvestable into the mint (Token-2022 mechanics).
//     distribute() harvests + withdraws them into the vault (the mint's
//     withdraw_withheld_authority is this program's DistState PDA, so only
//     this program can ever pull them).
//   * Mode 1 (routed) — the mint carries NO TransferFee extension (e.g.
//     DBC-launched tokens, whose extension set is fixed at mint creation).
//     Fees arrive by PLAIN TRANSFER into the vault (fee-claimer routing:
//     the launcher claims curve/LP fees, converts them into the launched
//     token, and transfers them in — see INTEGRATION.md). distribute()
//     takes no fee-source accounts and folds what is already in the vault.
//
//   * distribute() — a PERMISSIONLESS crank — folds new fee amounts from
//     either source, pays the crank caller a configured cut on the total
//     folded amount, and folds the net into a cumulative fee INDEX (fees
//     per token, SCALE 1e12) against eligible supply.
//   * A holder's entitlement is balance x (index - settled_index), paid by
//     claim() (holder-signed) or settle() (permissionless — the lazy
//     settlement surface venues/engine call around a transfer; see
//     INTEGRATION.md for the ownership decision and the first-touch rule).
//
// Own instructions are tagged by data[0]:
//   0 = Initialize  { caller_cut_bps u16 }
//   1 = Distribute  (crank; remaining accounts = withheld-fee source accounts)
//   2 = Claim       (holder-signed payout)
//   3 = Settle      (permissionless payout to the named holder)
//   4 = DistributeWithSplits (Phase B; settlement-time beneficiary splits
//       for engine rules 5 Crown / 6 Tithe Seat / 15 King-of-the-Pool)
//       Fold math is IDENTICAL to tag 1 (both funding modes). After the
//       caller cut, configured shares of the NET fold are carved out in
//       the order crown, seat, king — each = net_fold x bps / 10_000
//       (floor), bps read live from the ENGINE Config PDA (the single
//       source of truth) — and paid LIVE from the vault to whoever
//       currently holds the crown / seat NFT / kingship. The remainder
//       folds into the index exactly as tag 1 does. A split whose live
//       validation fails at runtime is SKIPPED (fail-open per split; its
//       share folds into the index instead) — distribute never bricks
//       over a missing crown/king/seat; only a malformed/wrong Engine
//       Config account, or split bps summing over 10_000, hard-errors.
//       Tag-4 accounts: the six tag-1 core accounts, then in fixed order
//       [engine Config PDA, Crown PDA|sentinel, seat token account|
//       sentinel, King PDA|sentinel, crown recipient token account|
//       sentinel, seat recipient token account|sentinel, king recipient
//       token account|sentinel], then the tag-1 trailing accounts
//       (mode 0: withheld-fee sources; mode 1: hook extras for the CUT
//       transfer). Sentinel = the DistState PDA address itself.
//
//   4x = DistributeWithSplits HOOKED-MINT EXTENSION (2026-10-20).
//       Split legs are transfers OUT of the vault to per-leg
//       destinations, and transfer-hook extras are destination-specific
//       (the destination Holder PDA differs per leg), so the single
//       legacy trailing tail cannot serve them. The extension keeps
//       tag 4 (rather than a new tag: the fold/split semantics are
//       identical, only the account tail grows — a new tag would fork
//       the entry point and invite drift) and extends its DATA:
//         legacy:   data = [4]                          (unchanged)
//         extended: data = [4, 1, tail_n, crown_n, seat_n, king_n]
//       tail_n is the length of the LEGACY tail that still comes first
//       (mode 1: the cut transfer's hook extras; mode 0: the withheld-
//       fee source accounts); crown_n / seat_n / king_n are the lengths
//       of the three per-leg hook-extra groups that follow in that
//       order, each resolved for source = vault, authority = DistState
//       PDA, destination = that leg's recipient token account. The
//       four counts must sum EXACTLY to the trailing account count —
//       any other data length, version byte, or sum hard-errors
//       (InvalidInstructionData) BEFORE any harvest CPI or transfer,
//       so a malformed client can never half-execute a distribution.
//       A group of length 0 means "no extras for that leg" (the leg is
//       attempted bare, exactly as legacy). Mode 0 note: the cut
//       transfer itself still carries no extras in mode 0 (its tail
//       slot is the fee sources) — the extension covers the split legs
//       only there, mirroring tag 1's mode-0 posture.
//       TRANSFER-STAGE FAIL-OPEN IS *NOT* POSSIBLE on Solana and this
//       build does not pretend otherwise: a failed CPI is always
//       fatal to the instruction — the runtime propagates the
//       callee's error through invoke_signed regardless of whether
//       the caller matches on the Result (proven in LiteSVM at two
//       failure depths during this build: a Token-level failure,
//       frozen recipient custom 0x11, and a hook-level veto, engine
//       MaxWallet custom 0x2, each aborting the distributor with the
//       callee's error code; see trial-splits-hooked.mjs section D2
//       and INTEGRATION.md). A split leg whose destination the hook
//       vetoes therefore still reverts the whole tag-4 instruction
//       atomically (no leg pays, no state moves — the fold can be
//       retried). The fail-open surface that exists is the
//       VALIDATION stage (sentinel / mismatched slots skip a leg
//       before any transfer) — clients on hooked mints should skip
//       legs they know the hook will veto by passing sentinel slots
//       for them; the skipped share folds into the index as before.
//
// DistState PDA: seeds ["dist", mint], DIST_STATE_SPACE bytes:
//   [0]         tag u8 = 1
//   [1..33]     mint
//   [33..65]    vault (token account; owner == this state PDA)
//   [65..97]    admin (set at init; reserved for future param governance)
//   [97..113]   index u128 (cumulative fees per token, SCALE)
//   [113..121]  total_harvested u64 (mode-0 gross fees pulled from the mint)
//   [121..129]  total_distributed u64 (net folded into the index, both modes)
//   [129..137]  total_cuts u64 (gross crank cuts paid)
//   [137..139]  caller_cut_bps u16
//   [139]       bump u8
//   [140]       funding_mode u8 (0 = harvest, 1 = routed; set at init)
//   [141..149]  created_slot u64
//   [149..157]  distribute_count u64
//   [157..165]  total_paid_out u64 (gross payouts debited from the vault)
//   [165..173]  total_routed_folded u64 (gross routed principal folded)
//   [173..176]  reserved
//
// Claim PDA: seeds ["claim", mint, holder], CLAIM_SPACE bytes:
//   [0]         tag u8 = 1
//   [1..33]     mint
//   [33..65]    holder
//   [65..81]    settled_index u128
//   [81..89]    total_claimed u64 (gross payouts debited from the vault)
//   [89..97]    last_claim_slot u64
//   [97..104]   reserved
//
// FIRST-TOUCH RULE (load-bearing; see INTEGRATION.md): a Claim PDA created
// for a holder with balance > 0 starts at settled_index = 0 (full history on
// the current balance — the entitlement formula as specced); a Claim PDA
// created at balance == 0 (the venue's pre-receive settle) starts at the
// CURRENT index, so the wallet earns only distributions after that point.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};
use std::str::FromStr;

const TOKEN_2022_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/// Engine program (the transfer-hook rule engine) — the Config PDA and
/// King PDA owner for tag-4 split reads. Two-flavor const, same mechanism
/// as the engine's REGISTRY_ID / DISTRIBUTOR_ID: the committed source
/// carries the MAINNET id; the trial build swaps in the dev keypair id
/// (engine/engine-keypair.json) and that binary rests in
/// target/deploy/distributor.so for the LiteSVM battery.
///   mainnet: EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT
///   trial:   2A3kbQHsUpsnud5VSz3aszFDjhUychWK99NDWyKtSMDt
const ENGINE_ID: &str = "EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT";
/// Crown program (rules 5's beneficiary record: PDA ["crown", mint],
/// layout [0] tag=1, [1..33] mint, [33..65] beneficiary,
/// [65..73] reign_started_ts i64). Two-flavor const like ENGINE_ID:
///   trial:   GbHLMTWixPKYo7gthYf1yTWiEAU1LuCmLUQD7x86MHSy (crown-sol dev keypair)
///   mainnet: HWZpJ7GnDifwo7g77PKefeVXdzbse7sfRjKrNUna3gJN (S2 window,
///            deployed 2026-10-20; keypair deploy/s2-s4-window/crown-mainnet-keypair.json)
const CROWN_ID: &str = "HWZpJ7GnDifwo7g77PKefeVXdzbse7sfRjKrNUna3gJN";
/// Engine Config PDA layout constants (parsed from engine/src/lib.rs —
/// load_config / write_config there are the source of truth):
/// CONFIG_SPACE 1088; [0] tag=1, [1] ENGINE_VERSION (=2), [2]
/// authority_mode, [3] rule_count, [4..36] mint, [36..68] authority;
/// rules start at byte 462, each entry 68 bytes: rule_id u16 @+0,
/// enabled u8 @+2 (== 1), params[64] @+4.
const ENGINE_CONFIG_SPACE: usize = 1088;
const ENGINE_VERSION: u8 = 2;
const ENGINE_OFF_RULES: usize = 462;
const ENGINE_RULE_ENTRY_LEN: usize = 68;
const ENGINE_MAX_RULES: usize = 8;
/// Engine King PDA layout (engine/src/lib.rs, KING_SPACE 96):
/// [0] tag=1, [1..33] king token account, [33..65] king owner,
/// [65..73] king balance u64, [73..81] updated ts i64.
const ENGINE_KING_MIN_LEN: usize = 81;
/// Crown PDA layout minimum (fields through reign_started_ts).
const CROWN_MIN_LEN: usize = 73;
const CROWN_TAG: u8 = 1;
// Engine rule ids (engine/src/lib.rs rule registry).
const RULE_CROWN_BENEFICIARY: u16 = 5;
const RULE_TITHE_SEAT: u16 = 6;
const RULE_KING_OF_POOL: u16 = 15;
/// Cumulative index scale: index units are fee-raw per token-raw x SCALE.
pub const SCALE: u128 = 1_000_000_000_000;

pub const DIST_STATE_SPACE: usize = 176;
pub const CLAIM_SPACE: usize = 104;

// Token-2022 instruction discriminants used in CPIs (hand-built; the family
// idiom — no spl-token crate). TransferFeeExtension is TokenInstruction 26;
// its sub-instructions (spl-token-2022 TransferFeeInstruction enum order,
// cross-checked against @solana/spl-token 0.4.15): Initialize = 0,
// TransferCheckedWithFee = 1, WithdrawWithheldTokensFromMint = 2,
// WithdrawWithheldTokensFromAccounts = 3, HarvestWithheldTokensToMint = 4,
// SetTransferFee = 5.
const IX_TRANSFER_CHECKED: u8 = 12;
const IX_TRANSFER_FEE_EXTENSION: u8 = 26;
const FEE_SUB_WITHDRAW_FROM_MINT: u8 = 2;
const FEE_SUB_HARVEST_TO_MINT: u8 = 4;
/// TLV extension type id for TransferFeeConfig.
const EXT_TRANSFER_FEE_CONFIG: u16 = 1;

#[derive(Debug)]
enum DistError {
    AlreadyInit = 1,
    BadState = 2,           // state/claim account foreign-owned or corrupt
    NoFeeConfig = 3,        // mint carries no TransferFeeConfig extension
    NotWithdrawAuthority = 4, // mint's withdraw authority is not the state PDA
    BadVault = 5,           // vault is not the state's token account for mint
    BadTokenAccount = 6,    // token account mint/owner mismatch
    NoEligibleSupply = 7,   // eligible supply is zero with fees pending
    Insolvent = 8,          // entitlement exceeds vault balance (accounting bug)
    MathOverflow = 9,
    FundModeMismatch = 10,  // retained for error-code stability; no longer emitted
                            // (routed-mode trailing accounts are hook extras now)
    BadConfig = 11,         // tag 4: engine Config account wrong/malformed
    SplitBpsTooLarge = 12,  // tag 4: crown+seat+king bps sum over 10_000
}

impl From<DistError> for ProgramError {
    fn from(e: DistError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

entrypoint!(process_instruction);

fn token_2022_id() -> Pubkey {
    Pubkey::from_str(TOKEN_2022_ID).unwrap()
}

// ---------- byte helpers (engine family idioms) ----------
fn read_u16(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(d[o..o + 2].try_into().unwrap())
}
fn read_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn read_u128(d: &[u8], o: usize) -> u128 {
    u128::from_le_bytes(d[o..o + 16].try_into().unwrap())
}
fn read_key(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}

fn pda(seeds: &[&[u8]], program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, program_id)
}
fn dist_pda(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"dist", mint.as_ref()], program_id).0
}
fn claim_pda(mint: &Pubkey, holder: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"claim", mint.as_ref(), holder.as_ref()], program_id).0
}

// SPL token account base layout: mint 0..32, owner 32..64, amount u64 64..72
fn token_mint(ai: &AccountInfo) -> Result<Pubkey, ProgramError> {
    let d = ai.try_borrow_data()?;
    if d.len() < 72 || ai.owner != &token_2022_id() {
        return Err(DistError::BadTokenAccount.into());
    }
    Ok(read_key(&d, 0))
}
fn token_owner(ai: &AccountInfo) -> Result<Pubkey, ProgramError> {
    let d = ai.try_borrow_data()?;
    if d.len() < 72 || ai.owner != &token_2022_id() {
        return Err(DistError::BadTokenAccount.into());
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
/// Base mint layout: supply u64 @36, decimals u8 @44.
fn mint_supply(mint_ai: &AccountInfo) -> Result<u64, ProgramError> {
    let d = mint_ai.try_borrow_data()?;
    if d.len() < 44 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(read_u64(&d, 36))
}
fn mint_decimals(mint_ai: &AccountInfo) -> Result<u8, ProgramError> {
    let d = mint_ai.try_borrow_data()?;
    if d.len() < 45 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(d[44])
}

/// Parse the mint's TransferFeeConfig extension. Returns
/// (withdraw_withheld_authority, withheld_amount).
///
/// LAYOUT (verified byte-by-byte against a live LiteSVM mint, 2026-10-15 —
/// the naive reading of the struct is wrong in two places):
/// * TLV data starts at byte 166, NOT 83: spl-token-2022 pads extension
///   mints to the 165-byte ACCOUNT base length + 1 account-type byte, so
///   mint and account TLV regions align. (getMintLen([TransferFeeConfig])
///   = 278 = 165 + 1 + 4 + 108.) We probe 166 first, then 83, accepting the
///   first walk that finds the fee config within bounds.
/// * Extension data (108 bytes) uses OptionalNonZeroPubkey (32 bytes,
///   all-zero = None), not tagged COption: config authority @0, withdraw
///   authority @32, withheld_amount u64 @64, then older/newer TransferFee
///   entries (18 bytes each).
fn parse_fee_config(mint_ai: &AccountInfo) -> Result<(Option<Pubkey>, u64), ProgramError> {
    let d = mint_ai.try_borrow_data()?;
    if d.len() <= 82 {
        return Err(DistError::NoFeeConfig.into());
    }
    for start in [166usize, 83usize] {
        if let Some(found) = scan_tlv_for_fee_config(&d, start) {
            return found;
        }
    }
    Err(DistError::NoFeeConfig.into())
}

/// One TLV walk from `start`. None = this start does not parse (try the next
/// candidate); Some(Err) = the fee config was found but malformed.
fn scan_tlv_for_fee_config(
    d: &[u8],
    start: usize,
) -> Option<Result<(Option<Pubkey>, u64), ProgramError>> {
    let mut off = start;
    while off + 4 <= d.len() {
        let ty = read_u16(d, off);
        let len = read_u16(d, off + 2) as usize;
        if off + 4 + len > d.len() {
            return None;
        }
        if ty == EXT_TRANSFER_FEE_CONFIG {
            let data = &d[off + 4..off + 4 + len];
            if len < 108 {
                return Some(Err(DistError::BadState.into()));
            }
            let withdraw = if data[32..64].iter().all(|b| *b == 0) {
                None
            } else {
                Some(read_key(data, 32))
            };
            return Some(Ok((withdraw, read_u64(data, 64))));
        }
        if ty == 0 && len == 0 {
            return None; // ran into zero padding: no fee config on this walk
        }
        off += 4 + len;
    }
    None
}

// ---------- state ----------
struct DistState {
    mint: Pubkey,
    vault: Pubkey,
    index: u128,
    total_distributed: u64,
    caller_cut_bps: u16,
    bump: u8,
    funding_mode: u8,
    total_paid_out: u64,
    total_routed_folded: u64,
}

fn load_state(ai: &AccountInfo, program_id: &Pubkey) -> Result<DistState, ProgramError> {
    if ai.owner != program_id {
        return Err(DistError::BadState.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < DIST_STATE_SPACE || d[0] != 1 {
        return Err(DistError::BadState.into());
    }
    Ok(DistState {
        mint: read_key(&d, 1),
        vault: read_key(&d, 33),
        index: read_u128(&d, 97),
        total_distributed: read_u64(&d, 121),
        caller_cut_bps: read_u16(&d, 137),
        bump: d[139],
        funding_mode: d[140],
        total_paid_out: read_u64(&d, 157),
        total_routed_folded: read_u64(&d, 165),
    })
}

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

// ---------- Token-2022 CPIs ----------
fn cpi_harvest_to_mint<'a>(
    mint: &AccountInfo<'a>,
    sources: &[AccountInfo<'a>],
    token_program: &AccountInfo<'a>,
) -> ProgramResult {
    let mut metas = Vec::with_capacity(1 + sources.len());
    metas.push(AccountMeta::new(*mint.key, false));
    for s in sources {
        metas.push(AccountMeta::new(*s.key, false));
    }
    let ix = Instruction {
        program_id: token_2022_id(),
        accounts: metas,
        data: vec![IX_TRANSFER_FEE_EXTENSION, FEE_SUB_HARVEST_TO_MINT],
    };
    let mut infos = Vec::with_capacity(2 + sources.len());
    infos.push(mint.clone());
    for s in sources {
        infos.push(s.clone());
    }
    infos.push(token_program.clone());
    invoke(&ix, &infos)
}

fn cpi_withdraw_from_mint<'a>(
    state_ai: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    vault: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    mint_key: &Pubkey,
    bump: u8,
) -> ProgramResult {
    let ix = Instruction {
        program_id: token_2022_id(),
        accounts: vec![
            AccountMeta::new(*mint.key, false),
            AccountMeta::new(*vault.key, false),
            AccountMeta::new_readonly(*state_ai.key, true),
        ],
        data: vec![IX_TRANSFER_FEE_EXTENSION, FEE_SUB_WITHDRAW_FROM_MINT],
    };
    invoke_signed(
        &ix,
        &[mint.clone(), vault.clone(), state_ai.clone(), token_program.clone()],
        &[&[b"dist", mint_key.as_ref(), &[bump]]],
    )
}

/// TransferChecked from the vault, signed by the DistState PDA (vault owner).
/// `extras` are transfer-hook extra accounts for the mint (validation PDA,
/// resolved extras, hook program), forwarded verbatim after the four core
/// metas — Token-2022 requires them in the transfer's account list whenever
/// the mint carries a transfer hook. Empty for hookless mints (byte-identical
/// CPI to the pre-fix build).
#[allow(clippy::too_many_arguments)]
fn cpi_vault_transfer<'a>(
    state_ai: &AccountInfo<'a>,
    vault: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    dest: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    mint_key: &Pubkey,
    bump: u8,
    amount: u64,
    decimals: u8,
    extras: &[AccountInfo<'a>],
) -> ProgramResult {
    let mut data = Vec::with_capacity(10);
    data.push(IX_TRANSFER_CHECKED);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let mut metas = Vec::with_capacity(4 + extras.len());
    metas.push(AccountMeta::new(*vault.key, false));
    metas.push(AccountMeta::new_readonly(*mint.key, false));
    metas.push(AccountMeta::new(*dest.key, false));
    metas.push(AccountMeta::new_readonly(*state_ai.key, true));
    for e in extras {
        metas.push(AccountMeta {
            pubkey: *e.key,
            is_writable: e.is_writable,
            is_signer: false,
        });
    }
    let ix = Instruction {
        program_id: token_2022_id(),
        accounts: metas,
        data,
    };
    let mut infos = Vec::with_capacity(5 + extras.len());
    infos.push(vault.clone());
    infos.push(mint.clone());
    infos.push(dest.clone());
    infos.push(state_ai.clone());
    infos.push(token_program.clone());
    for e in extras {
        infos.push(e.clone());
    }
    invoke_signed(
        &ix,
        &infos,
        &[&[b"dist", mint_key.as_ref(), &[bump]]],
    )
}

// ---------- tag 4: settlement-time beneficiary splits ----------

fn engine_id() -> Pubkey {
    Pubkey::from_str(ENGINE_ID).unwrap()
}
fn crown_id() -> Pubkey {
    Pubkey::from_str(CROWN_ID).unwrap()
}

/// Split shares parsed from the engine Config PDA (the single source of
/// truth — the distributor stores NO split parameters of its own).
/// Rule param layouts (64-byte params in the Config PDA's rule entries):
///   rule 5  (Crown):         [0..2]   crown_bps u16 LE
///   rule 6  (Tithe Seat):    [0..32]  seat_mint pubkey, [32..34] tithe_bps u16 LE
///   rule 15 (King of Pool):  [0..2]   tithe_bps u16 LE (0 = tracking only)
struct SplitConfig {
    crown_bps: u16,
    seat_mint: Option<Pubkey>,
    seat_bps: u16,
    king_bps: u16,
}

/// Validate + parse the engine Config account for tag 4. HARD errors only:
/// a wrong account (owner, PDA address, tag/version, mint field) is a
/// client bug and must never silently distribute without the splits the
/// config demands. Per-split runtime problems are NOT handled here —
/// they fail open at validation time below.
fn parse_split_config(config_ai: &AccountInfo, mint: &Pubkey) -> Result<SplitConfig, ProgramError> {
    let engine = engine_id();
    let expected = pda(&[b"config", mint.as_ref()], &engine).0;
    if *config_ai.key != expected || config_ai.owner != &engine {
        msg!("distributor: tag 4 config account is not the engine Config PDA for this mint");
        return Err(DistError::BadConfig.into());
    }
    let d = config_ai.try_borrow_data()?;
    if d.len() < ENGINE_CONFIG_SPACE || d[0] != 1 || d[1] != ENGINE_VERSION || read_key(&d, 4) != *mint {
        msg!("distributor: engine Config PDA malformed (len/tag/version/mint)");
        return Err(DistError::BadConfig.into());
    }
    let mut out = SplitConfig { crown_bps: 0, seat_mint: None, seat_bps: 0, king_bps: 0 };
    let rule_count = (d[3] as usize).min(ENGINE_MAX_RULES);
    for i in 0..rule_count {
        let o = ENGINE_OFF_RULES + i * ENGINE_RULE_ENTRY_LEN;
        if o + ENGINE_RULE_ENTRY_LEN > d.len() {
            break;
        }
        let rule_id = read_u16(&d, o);
        if d[o + 2] != 1 {
            continue; // disabled entries carry no live parameters
        }
        let params = &d[o + 4..o + 4 + 64];
        match rule_id {
            RULE_CROWN_BENEFICIARY => out.crown_bps = read_u16(params, 0),
            RULE_TITHE_SEAT => {
                out.seat_mint = Some(read_key(params, 0));
                out.seat_bps = read_u16(params, 32);
            }
            RULE_KING_OF_POOL => out.king_bps = read_u16(params, 0),
            _ => {}
        }
    }
    Ok(out)
}

// Fail-open split validations. Each returns true only if the split may be
// paid to the passed recipient account. ANY problem (sentinel slot,
// missing/malformed record, wrong seeds/owner/tag, recipient mint/owner
// mismatch) returns false and the split's share folds into the index.

/// A passed recipient token account of the bound mint owned by `owner`.
fn recip_ok(recip: &AccountInfo, mint: &Pubkey, owner: &Pubkey) -> bool {
    token_mint(recip).map(|m| m == *mint).unwrap_or(false)
        && token_owner(recip).map(|o| o == *owner).unwrap_or(false)
}

fn crown_split_ok(
    crown_ai: &AccountInfo,
    recip: &AccountInfo,
    state_ai: &AccountInfo,
    mint: &Pubkey,
) -> bool {
    if crown_ai.key == state_ai.key || recip.key == state_ai.key {
        return false; // sentinel: not applicable / not supplied
    }
    let crown = crown_id();
    if crown_ai.owner != &crown {
        return false;
    }
    if *crown_ai.key != pda(&[b"crown", mint.as_ref()], &crown).0 {
        return false;
    }
    let beneficiary = {
        let d = match crown_ai.try_borrow_data() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if d.len() < CROWN_MIN_LEN || d[0] != CROWN_TAG || read_key(&d, 1) != *mint {
            return false;
        }
        read_key(&d, 33)
    };
    recip_ok(recip, mint, &beneficiary)
}

fn seat_split_ok(
    seat_ai: &AccountInfo,
    recip: &AccountInfo,
    state_ai: &AccountInfo,
    mint: &Pubkey,
    seat_mint: &Pubkey,
) -> bool {
    if seat_ai.key == state_ai.key || recip.key == state_ai.key {
        return false;
    }
    // The seat token account must BE the seat NFT: right mint, amount 1.
    if token_mint(seat_ai).map(|m| m != *seat_mint).unwrap_or(true) {
        return false;
    }
    if token_amount(seat_ai).map(|a| a != 1).unwrap_or(true) {
        return false;
    }
    let seat_owner = match token_owner(seat_ai) {
        Ok(o) => o,
        Err(_) => return false,
    };
    recip_ok(recip, mint, &seat_owner)
}

fn king_split_ok(
    king_ai: &AccountInfo,
    recip: &AccountInfo,
    state_ai: &AccountInfo,
    mint: &Pubkey,
) -> bool {
    if king_ai.key == state_ai.key || recip.key == state_ai.key {
        return false;
    }
    let engine = engine_id();
    if king_ai.owner != &engine {
        return false;
    }
    if *king_ai.key != pda(&[b"king", mint.as_ref()], &engine).0 {
        return false;
    }
    let king_owner = {
        let d = match king_ai.try_borrow_data() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if d.len() < ENGINE_KING_MIN_LEN || d[0] != 1 {
            return false;
        }
        read_key(&d, 33)
    };
    if king_owner == Pubkey::default() {
        return false; // record exists but no king has been crowned yet
    }
    recip_ok(recip, mint, &king_owner)
}

// ---------- dispatch ----------
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match data.first() {
        Some(0) => initialize(program_id, accounts, data),
        Some(1) => distribute(program_id, accounts),
        Some(2) => payout(program_id, accounts, true),
        Some(3) => payout(program_id, accounts, false),
        Some(4) => distribute_with_splits(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ---------- Initialize ----------
// Accounts: [admin(signer,w), mint, vault, state_pda(w), system]
// Data: [0][caller_cut_bps u16]
// The vault must ALREADY exist as a token account of this mint owned by the
// state PDA (the launcher creates the ATA with the PDA as owner; the PDA is
// computable before this program is ever called).
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let admin = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let state_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    if data.len() < 3 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let caller_cut_bps = read_u16(data, 1);
    if caller_cut_bps > 10_000 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if *state_ai.key != dist_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if state_ai.data_len() > 0 {
        return Err(DistError::AlreadyInit.into());
    }
    // Funding mode, derived from the mint's own extension set (a mode can
    // therefore never disagree with what the mint can actually do):
    //   mode 0 (harvest) — TransferFeeConfig present. distribute() pulls
    //     withheld fees from the mint; the withdraw-authority requirement
    //     is enforced at distribute time, exactly as before.
    //   mode 1 (routed) — no TransferFeeConfig (DBC-launched mints, whose
    //     extension set is fixed): no requirement at all here; fees reach
    //     the vault by plain transfer (fee-claimer routing).
    // A fee config that is present but MALFORMED still fails init.
    let funding_mode: u8 = match parse_fee_config(mint) {
        Ok(_) => 0,
        Err(e) if e == ProgramError::Custom(DistError::NoFeeConfig as u32) => 1,
        Err(e) => return Err(e),
    };
    if token_mint(vault)? != *mint.key || token_owner(vault)? != *state_ai.key {
        msg!("distributor: vault must be a token account of the mint owned by the state PDA");
        return Err(DistError::BadVault.into());
    }
    create_pda(program_id, admin, state_ai, system, &[b"dist", mint.key.as_ref()], DIST_STATE_SPACE)?;
    let (_, bump) = pda(&[b"dist", mint.key.as_ref()], program_id);
    let slot = Clock::get()?.slot;
    let mut d = state_ai.try_borrow_mut_data()?;
    for b in d.iter_mut() {
        *b = 0;
    }
    d[0] = 1;
    d[1..33].copy_from_slice(mint.key.as_ref());
    d[33..65].copy_from_slice(vault.key.as_ref());
    d[65..97].copy_from_slice(admin.key.as_ref());
    d[137..139].copy_from_slice(&caller_cut_bps.to_le_bytes());
    d[139] = bump;
    d[140] = funding_mode;
    d[141..149].copy_from_slice(&slot.to_le_bytes());
    msg!(
        "distributor: initialized for mint {} (funding mode {}, crank cut {} bps)",
        mint.key, funding_mode, caller_cut_bps
    );
    Ok(())
}

// ---------- Distribute (the permissionless crank) ----------
// Tag 1 accounts: [cranker(signer), mint(w), state_pda(w), vault(w),
//            cranker_token_account(w), token_2022_program,
//            ...remaining: MODE 0 — withheld-fee source token accounts(w);
//                          MODE 1 — transfer-hook extra accounts for the cut
//                          transfer (source=vault, dest=cranker account,
//                          authority=state PDA), forwarded verbatim]
// Tag 4 accounts: the same six core accounts, then the seven split
// accounts [engine Config PDA(ro), Crown PDA(ro)|sentinel, seat token
// account(ro)|sentinel, King PDA(ro)|sentinel, crown recipient(w)|
// sentinel, seat recipient(w)|sentinel, king recipient(w)|sentinel],
// then the same trailing accounts as tag 1 — or, in the extended data
// form (see the file header), [legacy tail, crown hook-extra group,
// seat hook-extra group, king hook-extra group]. Sentinel = the
// DistState PDA address itself (split not applicable / not supplied
// -> skipped).
// The fold amount has two sources, tracked so nothing double-folds and
// nothing strands:
//   * W — withheld fees harvested from the mint in this call (mode 0 only;
//     the mint's withdraw_withheld_authority is this state PDA).
//   * U — ROUTED balance already sitting in the vault from plain transfers
//     (fee-claimer routing; the only source in mode 1). U is exact by
//     conservation. Writing H = total harvested in, R = total routed in,
//     C = total cuts out, P = total payouts out, N = total net folded:
//       vault_balance = H + R - C - P   and   N = H + (folded routed) - C
//     so vault_balance - (N - P) = R - (folded routed) = the routed amount
//     not yet folded. Hence U = vault_balance - (total_distributed -
//     total_paid_out), with total_routed_folded tracking the folded side.
//     In pure mode-0 operation U is identically 0 (R = 0 throughout).
// Flow: (mode 0) harvest sources -> mint, read withheld W; fold = W + U;
// pay cut = fold * caller_cut_bps / 10_000 from the vault; fold net =
// fold - cut into the index against eligible supply (total supply minus the
// post-distribution vault balance, i.e. tokens actually in holders' hands);
// (mode 0) withdraw W into the vault (PDA-signed CPI). All-or-nothing: any
// failure reverts the whole instruction, CPIs included. fold == 0 is a
// successful no-op (no index change, no cut, no count bump).
fn distribute(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    distribute_inner(program_id, accounts, false, &[])
}

// Tag 4 entry: same fold as tag 1 plus the split accounts/accounting.
// `data` carries the optional hooked-mint extension header (file header).
fn distribute_with_splits(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    distribute_inner(program_id, accounts, true, data)
}

fn distribute_inner(program_id: &Pubkey, accounts: &[AccountInfo], with_splits: bool, data: &[u8]) -> ProgramResult {
    // Tag 4 needs the 6 core accounts + the 7 split accounts.
    let min_accounts = if with_splits { 13 } else { 6 };
    if accounts.len() < min_accounts {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let cranker = &accounts[0];
    let mint = &accounts[1];
    let state_ai = &accounts[2];
    let vault = &accounts[3];
    let cranker_acct = &accounts[4];
    let token_program = &accounts[5];
    // Tag 4 only: the split accounts, in the mandated fixed order, sit
    // between the core list and the trailing accounts.
    let split_accounts: &[AccountInfo] = if with_splits { &accounts[6..13] } else { &[] };
    // Trailing accounts are interpreted by funding mode — which is only
    // known after load_state below. Mode 0: withheld-fee SOURCE accounts.
    // Mode 1: transfer-hook EXTRAS for the cut transfer. The split happens
    // right after the state loads; nothing before that point may treat the
    // trailing accounts as token accounts (mode-1 extras include PDAs and
    // the hook program itself, which are not token accounts of the mint).
    let trailing = &accounts[min_accounts..];

    // Tag 4 hooked-mint extension header (see the file-header docs).
    // data == [4] (len <= 1 here, since dispatch matched the tag byte)
    // is the legacy form: no per-leg groups. The extended form is
    // exactly 6 bytes: [4, 1, tail_n, crown_n, seat_n, king_n]. The
    // counts are validated against the trailing account count NOW —
    // before state load, before any harvest CPI or transfer — so a
    // malformed header can never partially execute.
    let split_ext: Option<[usize; 4]> = if with_splits {
        if data.len() <= 1 {
            None
        } else if data.len() == 6 && data[1] == 1 {
            let counts = [data[2] as usize, data[3] as usize, data[4] as usize, data[5] as usize];
            let sum: usize = counts.iter().sum();
            if sum != trailing.len() {
                msg!(
                    "distributor: tag 4 extension counts sum {} != trailing accounts {}",
                    sum,
                    trailing.len()
                );
                return Err(ProgramError::InvalidInstructionData);
            }
            Some(counts)
        } else {
            msg!("distributor: tag 4 malformed extension header (len {})", data.len());
            return Err(ProgramError::InvalidInstructionData);
        }
    } else {
        None
    };

    if !cranker.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *token_program.key != token_2022_id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    if *state_ai.key != dist_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let st = load_state(state_ai, program_id)?;
    if st.mint != *mint.key || st.vault != *vault.key {
        return Err(DistError::BadState.into());
    }
    // Tag 4: validate + parse the engine Config PDA up front. A wrong
    // config account (BadConfig) or a split-bps sum over 10_000
    // (SplitBpsTooLarge) hard-errors BEFORE any harvest CPI or transfer.
    let split_cfg: Option<SplitConfig> = if with_splits {
        let cfg = parse_split_config(&split_accounts[0], mint.key)?;
        let sum = cfg.crown_bps as u32 + cfg.seat_bps as u32 + cfg.king_bps as u32;
        if sum > 10_000 {
            msg!("distributor: split bps sum {} exceeds 10000", sum);
            return Err(DistError::SplitBpsTooLarge.into());
        }
        Some(cfg)
    } else {
        None
    };
    if token_mint(vault)? != *mint.key || token_owner(vault)? != *state_ai.key {
        return Err(DistError::BadVault.into());
    }
    if token_mint(cranker_acct)? != *mint.key {
        return Err(DistError::BadTokenAccount.into());
    }
    // Mode-conditional split of the trailing accounts (see above). In mode 0
    // `sources` is the full trailing slice and each source is validated as a
    // token account of the mint, exactly as before; `extras` is empty. In
    // mode 1 there are no sources at all and the trailing accounts are hook
    // extras, forwarded unvalidated (Token-2022 + the hook validate them).
    // With the extension, the trailing region is [legacy tail (tail_n),
    // crown group, seat group, king group]; the legacy tail keeps its
    // mode-dependent meaning and therefore stays unambiguous in mode 1
    // (cut extras) and mode 0 (fee sources) alike. Without the
    // extension the slices below reproduce the legacy split exactly and
    // every leg group is empty.
    let (sources, extras, leg_extras): (&[AccountInfo], &[AccountInfo], [&[AccountInfo]; 3]) =
        match (&split_ext, st.funding_mode) {
            (None, 0) => (trailing, &[], [&[], &[], &[]]),
            (None, _) => (&[], trailing, [&[], &[], &[]]),
            (Some(c), 0) => (
                &trailing[..c[0]],
                &[],
                [
                    &trailing[c[0]..c[0] + c[1]],
                    &trailing[c[0] + c[1]..c[0] + c[1] + c[2]],
                    &trailing[c[0] + c[1] + c[2]..],
                ],
            ),
            (Some(c), _) => (
                &[],
                &trailing[..c[0]],
                [
                    &trailing[c[0]..c[0] + c[1]],
                    &trailing[c[0] + c[1]..c[0] + c[1] + c[2]],
                    &trailing[c[0] + c[1] + c[2]..],
                ],
            ),
        };
    for s in sources {
        if token_mint(s)? != *mint.key {
            return Err(DistError::BadTokenAccount.into());
        }
    }

    let vault_entry = token_amount(vault)?;
    let supply = mint_supply(mint)?;

    // Unfolded routed balance U (see the conservation argument above).
    // total_paid_out >= 0 and total_distributed >= total_paid_out are
    // invariants of payout(); a violation is an accounting bug — fail loud.
    let backing = st
        .total_distributed
        .checked_sub(st.total_paid_out)
        .ok_or(DistError::MathOverflow)?;
    let unfolded = vault_entry
        .checked_sub(backing)
        .ok_or(DistError::MathOverflow)?;

    // Harvested withheld W — funding mode 0 only. Mode 1 mints carry no
    // TransferFee extension: nothing to harvest (parse_fee_config would
    // fail), and mode 1 takes no fee sources — its trailing accounts are
    // hook extras for the cut transfer (the `sources` slice is empty there
    // by construction, so this branch simply does nothing).
    let mut w: u64 = 0;
    if st.funding_mode == 0 {
        // The mint's withdraw authority must be this state PDA, or the
        // withdraw CPI below cannot succeed — fail here with a typed error.
        let (withdraw_auth, _) = parse_fee_config(mint)?;
        if withdraw_auth != Some(*state_ai.key) {
            msg!("distributor: mint withdraw authority is not the distributor PDA");
            return Err(DistError::NotWithdrawAuthority.into());
        }
        if !sources.is_empty() {
            cpi_harvest_to_mint(mint, sources, token_program)?;
        }
        let (_, ww) = parse_fee_config(mint)?;
        w = ww;
    }

    let fold = w.checked_add(unfolded).ok_or(DistError::MathOverflow)?;
    if fold == 0 {
        msg!("distributor: nothing to fold — no-op");
        return Ok(());
    }
    let cut = ((fold as u128 * st.caller_cut_bps as u128) / 10_000) as u64;
    let net = fold - cut;
    // Tag 4 splits: carve the configured shares out of the NET fold (after
    // the caller cut), in crown/seat/king order, each floored. A split is
    // carved only if its live validation passes; a skipped split's share
    // simply stays in `remainder` and folds into the index (fail-open per
    // split). For tag 1 (and for tag 4 with nothing configured) all three
    // amounts are 0 and remainder == net — byte-identical fold math.
    let (crown_amt, seat_amt, king_amt) = match &split_cfg {
        Some(cfg) => {
            let carve = |bps: u16| -> u64 { ((net as u128 * bps as u128) / 10_000) as u64 };
            let crown = if cfg.crown_bps > 0
                && crown_split_ok(&split_accounts[1], &split_accounts[4], state_ai, mint.key)
            {
                carve(cfg.crown_bps)
            } else {
                0
            };
            let seat = if cfg.seat_bps > 0 {
                match &cfg.seat_mint {
                    Some(seat_mint) if seat_split_ok(
                        &split_accounts[2],
                        &split_accounts[5],
                        state_ai,
                        mint.key,
                        seat_mint,
                    ) =>
                    {
                        carve(cfg.seat_bps)
                    }
                    _ => 0,
                }
            } else {
                0
            };
            let king = if cfg.king_bps > 0
                && king_split_ok(&split_accounts[3], &split_accounts[6], state_ai, mint.key)
            {
                carve(cfg.king_bps)
            } else {
                0
            };
            (crown, seat, king)
        }
        None => (0, 0, 0),
    };
    let splits_total = crown_amt
        .checked_add(seat_amt)
        .and_then(|s| s.checked_add(king_amt))
        .ok_or(DistError::MathOverflow)?;
    // splits_total <= net always: each carve floors and the bps sum was
    // validated <= 10_000 against this same net.
    let remainder = net - splits_total;
    // Eligible supply: tokens in holders' hands after this distribution
    // settles. The vault will hold vault_entry + W (withdrawn in) - cut
    // (paid out) - splits (paid out) once the dust settles; the routed U
    // is already inside vault_entry, and remainder is what the index owes
    // against it.
    let vault_after = vault_entry
        .checked_add(w)
        .and_then(|v| v.checked_sub(cut))
        .and_then(|v| v.checked_sub(splits_total))
        .ok_or(DistError::MathOverflow)?;
    let eligible = (supply as u128)
        .checked_sub(vault_after as u128)
        .ok_or(DistError::MathOverflow)?;
    if eligible == 0 {
        msg!("distributor: eligible supply is zero");
        return Err(DistError::NoEligibleSupply.into());
    }
    let index_delta = (remainder as u128)
        .checked_mul(SCALE)
        .ok_or(DistError::MathOverflow)?
        / eligible;

    if w > 0 {
        cpi_withdraw_from_mint(state_ai, mint, vault, token_program, mint.key, st.bump)?;
    }
    if cut > 0 {
        let decimals = mint_decimals(mint)?;
        // `extras` is non-empty only in mode 1 (hook extras for this
        // transfer); in mode 0 it is the empty slice — no extras.
        cpi_vault_transfer(state_ai, vault, mint, cranker_acct, token_program, mint.key, st.bump, cut, decimals, extras)?;
    }
    // Split payouts, live from the vault, in carve order (crown, seat,
    // king), each forwarded its OWN hook-extra group from the extension
    // (empty groups in the legacy form). Errors propagate with `?`:
    // a failed CPI is fatal on Solana (see the file header), so a leg
    // the hook vetoes reverts the instruction atomically — the
    // validation-stage skip above is the only fail-open stage.
    if splits_total > 0 {
        let decimals = mint_decimals(mint)?;
        if crown_amt > 0 {
            cpi_vault_transfer(state_ai, vault, mint, &split_accounts[4], token_program, mint.key, st.bump, crown_amt, decimals, leg_extras[0])?;
        }
        if seat_amt > 0 {
            cpi_vault_transfer(state_ai, vault, mint, &split_accounts[5], token_program, mint.key, st.bump, seat_amt, decimals, leg_extras[1])?;
        }
        if king_amt > 0 {
            cpi_vault_transfer(state_ai, vault, mint, &split_accounts[6], token_program, mint.key, st.bump, king_amt, decimals, leg_extras[2])?;
        }
    }

    let mut d = state_ai.try_borrow_mut_data()?;
    let idx = read_u128(&d, 97)
        .checked_add(index_delta)
        .ok_or(DistError::MathOverflow)?;
    d[97..113].copy_from_slice(&idx.to_le_bytes());
    let th = read_u64(&d, 113).checked_add(w).ok_or(DistError::MathOverflow)?;
    d[113..121].copy_from_slice(&th.to_le_bytes());
    // ACCOUNTING (tag 4 splits; load-bearing): total_distributed advances
    // by the FULL net fold (net = fold - cut), exactly as tag 1, and the
    // split payouts are gross vault debits recorded in total_paid_out —
    // the same counter claim/settle use. A leg skipped at the
    // validation stage contributes nothing to total_paid_out: its share
    // is inside `remainder`, which the index owes. The identity
    //   vault == total_distributed - total_paid_out
    // then survives to the unit: after this instruction the vault holds
    // (prior backing) + remainder, and total_distributed - total_paid_out
    // moves by net - splits_total = remainder. The index only ever owes
    // `remainder` (index_delta above is computed on it), so holders can
    // never claim the split money twice, and the next distribute's
    // unfolded computation (vault - (total_distributed - total_paid_out))
    // reads exactly the new routed deposits — split money never
    // double-folds. There is NO separate total_splits counter: DistState
    // is a live 176-byte layout whose only reserved room is bytes
    // [173..176] (3 bytes — too small for a u64), and the layout must not
    // change; splits are tracked inside total_paid_out only.
    let td = read_u64(&d, 121).checked_add(net).ok_or(DistError::MathOverflow)?;
    d[121..129].copy_from_slice(&td.to_le_bytes());
    if splits_total > 0 {
        let tp = read_u64(&d, 157)
            .checked_add(splits_total)
            .ok_or(DistError::MathOverflow)?;
        d[157..165].copy_from_slice(&tp.to_le_bytes());
    }
    let tc = read_u64(&d, 129).checked_add(cut).ok_or(DistError::MathOverflow)?;
    d[129..137].copy_from_slice(&tc.to_le_bytes());
    let trf = read_u64(&d, 165)
        .checked_add(unfolded)
        .ok_or(DistError::MathOverflow)?;
    d[165..173].copy_from_slice(&trf.to_le_bytes());
    let dc = read_u64(&d, 149).checked_add(1).ok_or(DistError::MathOverflow)?;
    d[149..157].copy_from_slice(&dc.to_le_bytes());
    if with_splits {
        msg!(
            "distributor: splits crown {} / seat {} / king {} (total {}), remainder {} into index",
            crown_amt, seat_amt, king_amt, splits_total, remainder
        );
    }
    msg!(
        "distributor: folded {} (harvested {}, routed {}, cut {}, net {} into index, delta {})",
        fold, w, unfolded, cut, net, index_delta
    );
    Ok(())
}

// ---------- Claim (tag 2, holder-signed) / Settle (tag 3, permissionless) ----------
// Accounts: [payer(signer,w), holder, holder_token_account(w), mint,
//            state_pda(w), vault(w), claim_pda(w), token_2022_program, system,
//            ...remaining (optional): transfer-hook extra accounts for the
//            entitlement transfer (source=vault, dest=holder account,
//            authority=state PDA), forwarded verbatim]
// Claim requires payer == holder (the holder claims for themselves).
// Settle allows anyone to trigger the SAME payout to the holder's own token
// account — funds can only ever land with the holder, so permissionless is
// safe; the payer funds Claim PDA creation if the record does not exist yet.
// Payout: balance x (index - settled_index) / SCALE, computed on the balance
// BEFORE the payout transfer. settled_index is advanced before the transfer
// (checks-effects-interactions); a zero entitlement is a successful no-op.
fn payout(program_id: &Pubkey, accounts: &[AccountInfo], holder_signed: bool) -> ProgramResult {
    if accounts.len() < 9 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let payer = &accounts[0];
    let holder = &accounts[1];
    let holder_acct = &accounts[2];
    let mint = &accounts[3];
    let state_ai = &accounts[4];
    let vault = &accounts[5];
    let claim_ai = &accounts[6];
    let token_program = &accounts[7];
    let system = &accounts[8];
    // Optional trailing hook extras for the entitlement transfer (empty on
    // hookless mints — the length check above stays at < 9).
    let extras = &accounts[9..];

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if holder_signed && payer.key != holder.key {
        msg!("distributor: claim must be signed by the holder");
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *token_program.key != token_2022_id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    if *state_ai.key != dist_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let st = load_state(state_ai, program_id)?;
    if st.mint != *mint.key || st.vault != *vault.key {
        return Err(DistError::BadState.into());
    }
    if token_mint(vault)? != *mint.key || token_owner(vault)? != *state_ai.key {
        return Err(DistError::BadVault.into());
    }
    if token_mint(holder_acct)? != *mint.key || token_owner(holder_acct)? != *holder.key {
        return Err(DistError::BadTokenAccount.into());
    }
    if *claim_ai.key != claim_pda(mint.key, holder.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }

    let balance = token_amount(holder_acct)?;
    // Create the Claim PDA on first touch, applying the first-touch rule.
    if claim_ai.data_len() == 0 {
        create_pda(
            program_id,
            payer,
            claim_ai,
            system,
            &[b"claim", mint.key.as_ref(), holder.key.as_ref()],
            CLAIM_SPACE,
        )?;
        let init_settled: u128 = if balance == 0 { st.index } else { 0 };
        let mut d = claim_ai.try_borrow_mut_data()?;
        for b in d.iter_mut() {
            *b = 0;
        }
        d[0] = 1;
        d[1..33].copy_from_slice(mint.key.as_ref());
        d[33..65].copy_from_slice(holder.key.as_ref());
        d[65..81].copy_from_slice(&init_settled.to_le_bytes());
        msg!(
            "distributor: claim record created for {} (settled_index {})",
            holder.key, init_settled
        );
    } else {
        if claim_ai.owner != program_id {
            return Err(DistError::BadState.into());
        }
        let d = claim_ai.try_borrow_data()?;
        if d.len() < CLAIM_SPACE || d[0] != 1 || read_key(&d, 1) != *mint.key || read_key(&d, 33) != *holder.key {
            return Err(DistError::BadState.into());
        }
    }

    let settled = {
        let d = claim_ai.try_borrow_data()?;
        read_u128(&d, 65)
    };
    let entitlement128 = (balance as u128)
        .checked_mul(st.index.saturating_sub(settled))
        .ok_or(DistError::MathOverflow)?
        / SCALE;
    if entitlement128 > u64::MAX as u128 {
        return Err(DistError::MathOverflow.into());
    }
    let entitlement = entitlement128 as u64;

    // Advance settlement BEFORE paying out (CEI). A zero entitlement still
    // advances settled_index — the holder is now current at this balance.
    {
        let slot = Clock::get()?.slot;
        let mut d = claim_ai.try_borrow_mut_data()?;
        d[65..81].copy_from_slice(&st.index.to_le_bytes());
        if entitlement > 0 {
            let tc = read_u64(&d, 81).checked_add(entitlement).ok_or(DistError::MathOverflow)?;
            d[81..89].copy_from_slice(&tc.to_le_bytes());
            d[89..97].copy_from_slice(&slot.to_le_bytes());
        }
    }
    if entitlement == 0 {
        msg!("distributor: nothing owed to {}", holder.key);
        return Ok(());
    }
    if token_amount(vault)? < entitlement {
        msg!("distributor: entitlement exceeds vault — accounting error");
        return Err(DistError::Insolvent.into());
    }
    // Track the gross vault debit in the state. distribute()'s routed-fold
    // accounting (unfolded = vault balance - unpaid folded backing) depends
    // on total_paid_out covering EVERY payout from either tag; written
    // before the transfer per CEI (a failed CPI reverts it with the rest).
    {
        let mut d = state_ai.try_borrow_mut_data()?;
        let tp = read_u64(&d, 157)
            .checked_add(entitlement)
            .ok_or(DistError::MathOverflow)?;
        d[157..165].copy_from_slice(&tp.to_le_bytes());
    }
    let decimals = mint_decimals(mint)?;
    cpi_vault_transfer(state_ai, vault, mint, holder_acct, token_program, mint.key, st.bump, entitlement, decimals, extras)?;
    msg!("distributor: paid {} to {}", entitlement, holder.key);
    Ok(())
}

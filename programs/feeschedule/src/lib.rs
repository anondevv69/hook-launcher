// Hook Launcher FEE SCHEDULE — Solana (native, no Anchor).
//
// Rule 14 ("Decay Tax") in its HONEST, buildable form. The catalog one-liner
// says the transfer-fee rate decays with HOLDER age — that is impossible on
// Solana: the Token-2022 Transfer Fee extension rate is MINT-WIDE, one rate
// for everyone, and a transfer hook is veto-only (it cannot change the fee
// either). What this program builds is a MINT-WIDE TIME SCHEDULE:
//
//   rate(t) = start_bps - (start_bps - floor_bps)
//             * min(elapsed, decay_secs) / decay_secs        (floor math)
//   elapsed = now - schedule_start  (~= time since launch)
//
// The per-holder form is venue-side only (house venue) and is NOT built.
//
// Mechanism (permissionless crank, no key can raise the rate):
//   * At mint creation the mint's transferFeeConfigAuthority is set to a PDA
//     of THIS program, seeds ["feeauth", mint]. (Verified in LiteSVM against
//     @solana/spl-token 0.4.15: the authority can ALSO be rotated to the PDA
//     post-creation via Token-2022 SetAuthority with authority type 4 =
//     TransferFeeConfig, signed by the then-current authority — see
//     INTEGRATION.md. Setting it at mint init is still the launcher path.)
//   * Tag 0 InitSchedule snapshots the rule-14 params out of the engine
//     Config PDA (["config", mint] under the engine program) into a Schedule
//     PDA (["sched", mint] under this program) and records the mint's
//     current fee bps as last_applied_bps.
//   * Tag 1 Apply (the crank) is permissionless: any signer may call it. It
//     recomputes the target PURELY from the stored schedule + Clock, refuses
//     anything outside [floor_bps, start_bps], no-ops when the target is not
//     below last_applied_bps, asserts target <= last_applied_bps immediately
//     before the CPI, and only then CPIs Token-2022 SetTransferFee signed by
//     the feeauth PDA. maximumFee is read back from the mint's existing fee
//     config and re-passed verbatim — this program never changes it.
//
// Token-2022 fee semantics this program is built around (measured in
// LiteSVM, @solana/spl-token 0.4.15): SetTransferFee writes the NEWER fee
// entry with epoch = current_epoch + 2; the new rate takes effect only
// when the chain epoch reaches that entry's epoch. A crank therefore
// schedules ~2 epochs ahead of the rate holders actually pay; the schedule
// PDA's last_applied_bps tracks the latest SCHEDULED rate.
//
// Own instructions are tagged by data[0]:
//   0 = InitSchedule
//   1 = Apply (permissionless crank)
//
// Schedule PDA: seeds ["sched", mint], SCHED_SPACE bytes:
//   [0]        tag u8 = 1
//   [1]        sched_bump u8
//   [2]        feeauth_bump u8
//   [3]        reserved
//   [4..36]    mint pubkey
//   [36..44]   start_ts i64 (Clock unix_timestamp at InitSchedule)
//   [44..52]   decay_secs u64 (snapshot of engine rule-14 params [4..12])
//   [52..54]   start_bps u16  (snapshot of params [0..2])
//   [54..56]   floor_bps u16  (snapshot of params [2..4])
//   [56..58]   last_applied_bps u16 (latest rate this program scheduled;
//              initialized to the mint's effective bps at InitSchedule)
//   [58..66]   last_apply_ts i64 (0 = never applied)
//   [66..74]   apply_count u64 (number of SetTransferFee CPIs issued)
//   [74..128]  reserved
//
// Engine Config PDA (read-only here; layout copied byte-exact from
// engine/src/lib.rs): seeds ["config", mint] under the engine program,
// CONFIG_SPACE = 1088 bytes: tag u8 @0 = 1, engine_version @1 (= 2),
// authority_mode @2, rule_count @3, mint @4..36, authority @36..68,
// rules @462, each entry 68 bytes: rule_id u16 @+0, enabled u8 @+2,
// params[64] @+4. Rule 14 params (coordinator-fixed 64-byte block):
//   [0..2] start_bps u16 LE (1..=10000), [2..4] floor_bps u16 LE
//   (<= start_bps), [4..12] decay_secs u64 LE (> 0), rest zero (ignored
//   here beyond the first 12 bytes).

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};
use std::str::FromStr;

const TOKEN_2022_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/// Engine program (mainnet id; the trial suites load the engine trial
/// binary under this same id, and Config PDAs are derived under it).
const ENGINE_ID: &str = "EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT";
const ENGINE_VERSION: u8 = 2;
const CONFIG_SPACE: usize = 1088;
const OFF_RULES: usize = 462;
const RULE_ENTRY_LEN: usize = 68;
const MAX_RULES: usize = 8;
const PARAMS_LEN: usize = 64;
pub const RULE_DECAY_TAX: u16 = 14;

pub const SCHED_SPACE: usize = 128;

// Token-2022 instruction discriminants (hand-built; family idiom).
// TransferFeeExtension is TokenInstruction 26; its sub-instructions
// (@solana/spl-token 0.4.15 TransferFeeInstruction enum order):
// Initialize = 0, TransferCheckedWithFee = 1, WithdrawFromMint = 2,
// WithdrawFromAccounts = 3, HarvestToMint = 4, SetTransferFee = 5.
const IX_TRANSFER_FEE_EXTENSION: u8 = 26;
const FEE_SUB_SET_TRANSFER_FEE: u8 = 5;
/// TLV extension type id for TransferFeeConfig.
const EXT_TRANSFER_FEE_CONFIG: u16 = 1;

#[derive(Debug)]
enum SchedError {
    AlreadyInit = 1,
    BadState = 2,      // schedule account foreign-owned or corrupt
    NoFeeConfig = 3,   // mint carries no TransferFeeConfig extension
    NotFeeAuthority = 4, // mint's transferFeeConfigAuthority != feeauth PDA
    BadConfig = 5,     // engine Config PDA missing/corrupt/foreign/wrong mint
    RuleNotEnabled = 6, // rule 14 absent or disabled in the engine config
    BadParams = 7,     // schedule params outside their documented bounds
    OutOfBounds = 8,   // a rate outside [floor_bps, start_bps] (defensive)
    WouldRaise = 9,    // target > last_applied_bps at the CPI gate (defensive)
    MathOverflow = 10,
}

impl From<SchedError> for ProgramError {
    fn from(e: SchedError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

entrypoint!(process_instruction);

fn token_2022_id() -> Pubkey {
    Pubkey::from_str(TOKEN_2022_ID).unwrap()
}
fn engine_id() -> Pubkey {
    Pubkey::from_str(ENGINE_ID).unwrap()
}

// ---------- byte helpers (engine family idioms) ----------
fn read_u16(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(d[o..o + 2].try_into().unwrap())
}
fn read_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn read_i64(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn read_key(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}

fn pda(seeds: &[&[u8]], program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, program_id)
}
fn feeauth_pda(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    pda(&[b"feeauth", mint.as_ref()], program_id)
}
fn sched_pda(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    pda(&[b"sched", mint.as_ref()], program_id)
}
fn config_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"config", mint.as_ref()], &engine_id()).0
}

// ---------- Transfer Fee config parsing ----------
// Layout (verified byte-by-byte in LiteSVM; same facts as the distributor):
// extension mints are padded to the 165-byte account base + 1 type byte, so
// TLV data starts at byte 166 (we probe 166, then 83). TransferFeeConfig
// data is 108 bytes of OptionalNonZeroPubkey fields (all-zero = None):
//   config authority @0, withdraw authority @32, withheld_amount u64 @64,
//   older TransferFee @72: epoch u64 @72, maximum_fee u64 @80, bps u16 @88,
//   newer TransferFee @90: epoch u64 @90, maximum_fee u64 @98, bps u16 @106.
#[derive(Clone, Copy)]
struct FeeEntry {
    epoch: u64,
    maximum_fee: u64,
    bps: u16,
}
struct FeeConfig {
    config_authority: Option<Pubkey>,
    older: FeeEntry,
    newer: FeeEntry,
}
impl FeeConfig {
    /// The entry in force at `epoch` (spl-token's getEpochFee rule).
    fn effective(&self, epoch: u64) -> FeeEntry {
        if epoch >= self.newer.epoch {
            self.newer
        } else {
            self.older
        }
    }
}

fn parse_fee_config(mint_ai: &AccountInfo) -> Result<FeeConfig, ProgramError> {
    let d = mint_ai.try_borrow_data()?;
    if d.len() <= 82 {
        return Err(SchedError::NoFeeConfig.into());
    }
    for start in [166usize, 83usize] {
        if let Some(found) = scan_tlv_for_fee_config(&d, start) {
            return found;
        }
    }
    Err(SchedError::NoFeeConfig.into())
}

fn scan_tlv_for_fee_config(d: &[u8], start: usize) -> Option<Result<FeeConfig, ProgramError>> {
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
                return Some(Err(SchedError::BadState.into()));
            }
            let opt_key = |o: usize| -> Option<Pubkey> {
                if data[o..o + 32].iter().all(|b| *b == 0) {
                    None
                } else {
                    Some(read_key(data, o))
                }
            };
            return Some(Ok(FeeConfig {
                config_authority: opt_key(0),
                older: FeeEntry {
                    epoch: read_u64(data, 72),
                    maximum_fee: read_u64(data, 80),
                    bps: read_u16(data, 88),
                },
                newer: FeeEntry {
                    epoch: read_u64(data, 90),
                    maximum_fee: read_u64(data, 98),
                    bps: read_u16(data, 106),
                },
            }));
        }
        if ty == 0 && len == 0 {
            return None; // zero padding: no fee config on this walk
        }
        off += 4 + len;
    }
    None
}

// ---------- engine Config PDA (rule-14 params) ----------
/// Validate the engine Config PDA account for `mint` and return the
/// rule-14 params snapshot (start_bps, floor_bps, decay_secs).
fn read_rule14_params(
    config_ai: &AccountInfo,
    mint: &Pubkey,
) -> Result<(u16, u16, u64), ProgramError> {
    if *config_ai.key != config_pda(mint) {
        return Err(ProgramError::InvalidSeeds);
    }
    if config_ai.owner != &engine_id() {
        return Err(SchedError::BadConfig.into());
    }
    let d = config_ai.try_borrow_data()?;
    if d.len() < CONFIG_SPACE || d[0] != 1 || d[1] != ENGINE_VERSION {
        return Err(SchedError::BadConfig.into());
    }
    if read_key(&d, 4) != *mint {
        return Err(SchedError::BadConfig.into());
    }
    let rule_count = (d[3] as usize).min(MAX_RULES);
    for i in 0..rule_count {
        let o = OFF_RULES + i * RULE_ENTRY_LEN;
        if read_u16(&d, o) != RULE_DECAY_TAX {
            continue;
        }
        if d[o + 2] != 1 {
            return Err(SchedError::RuleNotEnabled.into()); // present but disabled
        }
        let p = &d[o + 4..o + 4 + PARAMS_LEN];
        let start_bps = read_u16(p, 0);
        let floor_bps = read_u16(p, 2);
        let decay_secs = read_u64(p, 4);
        validate_params(start_bps, floor_bps, decay_secs)?;
        return Ok((start_bps, floor_bps, decay_secs));
    }
    Err(SchedError::RuleNotEnabled.into())
}

fn validate_params(start_bps: u16, floor_bps: u16, decay_secs: u64) -> Result<(), ProgramError> {
    if start_bps == 0 || start_bps > 10_000 || floor_bps > start_bps || decay_secs == 0 {
        msg!(
            "feeschedule: bad rule-14 params start {} floor {} decay {}",
            start_bps, floor_bps, decay_secs
        );
        return Err(SchedError::BadParams.into());
    }
    Ok(())
}

// ---------- schedule state ----------
struct Schedule {
    mint: Pubkey,
    start_ts: i64,
    decay_secs: u64,
    start_bps: u16,
    floor_bps: u16,
    last_applied_bps: u16,
    feeauth_bump: u8,
}

fn load_schedule(ai: &AccountInfo, program_id: &Pubkey) -> Result<Schedule, ProgramError> {
    if ai.owner != program_id {
        return Err(SchedError::BadState.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < SCHED_SPACE || d[0] != 1 {
        return Err(SchedError::BadState.into());
    }
    let s = Schedule {
        mint: read_key(&d, 4),
        start_ts: read_i64(&d, 36),
        decay_secs: read_u64(&d, 44),
        start_bps: read_u16(&d, 52),
        floor_bps: read_u16(&d, 54),
        last_applied_bps: read_u16(&d, 56),
        feeauth_bump: d[2],
    };
    // Stored state is validated on EVERY Apply, not trusted: a schedule
    // whose params were tampered with (LiteSVM setAccount in the trial
    // stands in for any state corruption) fails closed, rate unchanged.
    validate_params(s.start_bps, s.floor_bps, s.decay_secs)?;
    if s.start_ts <= 0 {
        return Err(SchedError::BadParams.into());
    }
    if s.last_applied_bps < s.floor_bps || s.last_applied_bps > s.start_bps {
        msg!(
            "feeschedule: stored last_applied {} outside [{}, {}]",
            s.last_applied_bps, s.floor_bps, s.start_bps
        );
        return Err(SchedError::OutOfBounds.into());
    }
    Ok(s)
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

// ---------- dispatch ----------
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match data.first() {
        Some(0) => init_schedule(program_id, accounts),
        Some(1) => apply(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ---------- Tag 0: InitSchedule ----------
// Accounts: [payer (signer, w), mint, engine Config PDA, schedule PDA (w),
//            system]
// Validates the engine config (owner, address, rule 14 enabled + params),
// validates the mint carries a TransferFeeConfig whose
// transferFeeConfigAuthority IS this program's ["feeauth", mint] PDA
// (fail closed otherwise), and snapshots params + start time + the mint's
// current effective fee bps.
fn init_schedule(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let config_ai = next_account_info(it)?;
    let sched_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if mint.owner != &token_2022_id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (sched_addr, sched_bump) = sched_pda(mint.key, program_id);
    if *sched_ai.key != sched_addr {
        return Err(ProgramError::InvalidSeeds);
    }
    if sched_ai.data_len() > 0 {
        return Err(SchedError::AlreadyInit.into());
    }
    let (start_bps, floor_bps, decay_secs) = read_rule14_params(config_ai, mint.key)?;

    let (feeauth_addr, feeauth_bump) = feeauth_pda(mint.key, program_id);
    let fee = parse_fee_config(mint)?;
    if fee.config_authority != Some(feeauth_addr) {
        msg!(
            "feeschedule: mint transferFeeConfigAuthority is not the feeauth PDA {}",
            feeauth_addr
        );
        return Err(SchedError::NotFeeAuthority.into());
    }
    let clock = Clock::get()?;
    let current_bps = fee.effective(clock.epoch).bps;
    // The schedule can only ever LOWER the mint's rate from where it is, so
    // a mint whose current rate already sits outside the schedule bounds
    // can never be scheduled honestly — fail closed at init.
    if current_bps < floor_bps || current_bps > start_bps {
        msg!(
            "feeschedule: mint current bps {} outside schedule [{}, {}]",
            current_bps, floor_bps, start_bps
        );
        return Err(SchedError::OutOfBounds.into());
    }

    create_pda(
        program_id,
        payer,
        sched_ai,
        system,
        &[b"sched", mint.key.as_ref()],
        SCHED_SPACE,
    )?;
    let mut d = sched_ai.try_borrow_mut_data()?;
    for b in d.iter_mut() {
        *b = 0;
    }
    d[0] = 1;
    d[1] = sched_bump;
    d[2] = feeauth_bump;
    d[4..36].copy_from_slice(mint.key.as_ref());
    d[36..44].copy_from_slice(&clock.unix_timestamp.to_le_bytes());
    d[44..52].copy_from_slice(&decay_secs.to_le_bytes());
    d[52..54].copy_from_slice(&start_bps.to_le_bytes());
    d[54..56].copy_from_slice(&floor_bps.to_le_bytes());
    d[56..58].copy_from_slice(&current_bps.to_le_bytes());
    msg!(
        "feeschedule: schedule for mint {} starts at ts {} ({} -> {} bps over {}s; current {} bps; feeauth {})",
        mint.key, clock.unix_timestamp, start_bps, floor_bps, decay_secs, current_bps, feeauth_addr
    );
    Ok(())
}

// ---------- Tag 1: Apply (the permissionless crank) ----------
// Accounts: [cranker (signer — ANYONE), mint (w), schedule PDA (w),
//            feeauth PDA (readonly; the CPI authority), Token-2022]
// Computes the target purely from the stored schedule + Clock:
//   elapsed = max(now - start_ts, 0); capped = min(elapsed, decay_secs)
//   target  = start_bps - (start_bps - floor_bps) * capped / decay_secs
// No-op (success) when target >= last_applied_bps or target equals the
// mint's current effective bps. Otherwise CPIs SetTransferFee signed by
// the feeauth PDA with maximumFee re-passed verbatim from the mint's
// existing (newer) fee entry. The rate can never rise: the target derives
// only from the stored schedule and the clock, is range-checked, and is
// asserted <= last_applied_bps immediately before the CPI.
fn apply(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let cranker = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let sched_ai = next_account_info(it)?;
    let feeauth_ai = next_account_info(it)?;
    let token_program = next_account_info(it)?;

    if !cranker.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *token_program.key != token_2022_id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    if *sched_ai.key != sched_pda(mint.key, program_id).0 {
        return Err(ProgramError::InvalidSeeds);
    }
    let (feeauth_addr, feeauth_bump) = feeauth_pda(mint.key, program_id);
    if *feeauth_ai.key != feeauth_addr {
        return Err(ProgramError::InvalidSeeds);
    }
    let sched = load_schedule(sched_ai, program_id)?;
    if sched.mint != *mint.key {
        return Err(SchedError::BadState.into());
    }
    // Fail closed if the fee authority was rotated away from the PDA after
    // init: without it the CPI cannot sign, and silently no-oping would
    // hide a dead schedule.
    let fee = parse_fee_config(mint)?;
    if fee.config_authority != Some(feeauth_addr) {
        msg!("feeschedule: mint fee authority rotated away from the feeauth PDA");
        return Err(SchedError::NotFeeAuthority.into());
    }

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let elapsed: u64 = now.saturating_sub(sched.start_ts).max(0) as u64;
    let capped = elapsed.min(sched.decay_secs);
    let drop = ((sched.start_bps - sched.floor_bps) as u128 * capped as u128
        / sched.decay_secs as u128) as u64;
    let target = sched.start_bps as u64 - drop;
    if target < sched.floor_bps as u64 || target > sched.start_bps as u64 {
        msg!("feeschedule: computed target {} outside [{}, {}]", target, sched.floor_bps, sched.start_bps);
        return Err(SchedError::OutOfBounds.into());
    }
    let target = target as u16;

    let current_bps = fee.effective(clock.epoch).bps;
    if target >= sched.last_applied_bps || target == current_bps {
        msg!(
            "feeschedule: no-op (target {} bps, last applied {}, mint current {})",
            target, sched.last_applied_bps, current_bps
        );
        return Ok(());
    }
    // Defense-in-depth at the CPI gate: after the no-op early return the
    // only reachable targets are strictly below last_applied_bps; assert
    // it anyway so no future edit can turn this crank into a rate raise.
    if target > sched.last_applied_bps {
        return Err(SchedError::WouldRaise.into());
    }
    // maximumFee: read from the mint's existing NEWER fee entry (the entry
    // SetTransferFee overwrites) and re-pass it verbatim. This program
    // never changes maximumFee; in every launcher mint older == newer
    // maximumFee because init sets both and this is the only writer.
    let maximum_fee = fee.newer.maximum_fee;

    let mut data = Vec::with_capacity(12);
    data.push(IX_TRANSFER_FEE_EXTENSION);
    data.push(FEE_SUB_SET_TRANSFER_FEE);
    data.extend_from_slice(&target.to_le_bytes());
    data.extend_from_slice(&maximum_fee.to_le_bytes());
    let ix = Instruction {
        program_id: token_2022_id(),
        accounts: vec![
            AccountMeta::new(*mint.key, false),
            AccountMeta::new_readonly(feeauth_addr, true),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[mint.clone(), feeauth_ai.clone(), token_program.clone()],
        &[&[b"feeauth", mint.key.as_ref(), &[feeauth_bump]]],
    )?;

    let mut d = sched_ai.try_borrow_mut_data()?;
    d[56..58].copy_from_slice(&target.to_le_bytes());
    d[58..66].copy_from_slice(&now.to_le_bytes());
    let count = read_u64(&d, 66).checked_add(1).ok_or(SchedError::MathOverflow)?;
    d[66..74].copy_from_slice(&count.to_le_bytes());
    msg!(
        "feeschedule: applied {} bps to mint {} (elapsed {}s of {}s; effective at epoch {})",
        target,
        mint.key,
        elapsed,
        sched.decay_secs,
        fee.newer.epoch.max(clock.epoch)
    );
    Ok(())
}

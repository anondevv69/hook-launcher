// Hook Launcher CROWN BENEFICIARY — Solana (native, no Anchor).
//
// Spec: SPEC-HOOK-LAUNCHER.md rule 5 (Crown Beneficiary), adapted from the
// EVM Crown Model 2 brief (~/workspace/crown/BRIEF-M2.md): per launched
// mint, a Crown PDA names the CURRENT fee beneficiary. The token, pool and
// rules never change; only who gets paid. Anyone can challenge for the
// seat with a bonded SOL stake-vote; win, and the PDA flips. The
// Distributor reads the beneficiary from the Crown PDA at settlement time
// (see INTEGRATION.md for the fixed offsets it validates).
//
// Own instructions are tagged by data[0]:
//   0 = Init          (create Crown PDA + vault PDA for a mint)
//   1 = OpenChallenge (bonded; names a candidate beneficiary)
//   2 = Stake         (SOL stake-vote for side 0 = reigning / 1 = challenger)
//   3 = Finalize      (permissionless, after window_end + timelock)
//   4 = Claim         (pull refund / slash-share payout per Stake PDA)
//
// Crown PDA: seeds ["crown", mint], CROWN_SPACE bytes. The first 73 bytes
// are the DISTRIBUTOR CONTRACT and must never move:
//   [0]         tag u8 = 1
//   [1..33]     mint
//   [33..65]    beneficiary        <- Distributor reads exactly here
//   [65..73]    reign_started_ts i64 <- and here
// Extension (this program's own state):
//   [73..105]   treasury
//   [105..137]  authority (init signer; no post-init powers in v1)
//   [137..145]  bond_lamports u64
//   [145..153]  quorum_lamports u64
//   [153..161]  window_secs i64
//   [161..169]  timelock_secs i64
//   [169..177]  min_reign_secs i64
//   [177..185]  cooldown_secs i64
//   [185..187]  slash_bps u16
//   [187..195]  cooldown_until i64 (0 = none)
//   [195..203]  challenge_counter u64 (ids issued; current/last id while > 0)
//   [203]       bump u8
//   [204]       vault_bump u8
//   [205]       active_challenge bool (a challenge is live / unfinalized)
//   [206..214]  total_resolved u64 (challenges finalized, lifetime)
//   [214..222]  total_stake_resolved u64 (lamports staked across finalized challenges)
//   [222..230]  total_slashed u64
//   [230..238]  total_treasury_paid u64
//   [238..256]  reserved
//
// Vault PDA: seeds ["cvault", mint] — a 0-space program-owned account that
// holds all staked SOL. Stakes/bond arrive by system transfer; payouts and
// the treasury slash leave by direct lamport moves (program-owned debit).
//
// Challenge PDA: seeds ["challenge", mint], CHALLENGE_SPACE bytes (one per
// crown — a new challenge may only open once the previous one is finalized
// AND every stake on it has been claimed; see PendingClaims):
//   [0]         tag u8 = 1
//   [1..33]     mint
//   [33..65]    candidate (proposed beneficiary)
//   [65..97]    challenger (bond payer; candidate may differ)
//   [97..105]   opened_ts i64
//   [105..113]  window_end i64
//   [113..121]  challenger_stake u64 (bond included)
//   [121..129]  reigning_stake u64
//   [129]       state u8 (1 = open, 2 = finalized challenger won, 3 = finalized failed)
//   [130]       winning_side u8 (0 = reigning, 1 = challenger, 255 = undecided)
//   [131..139]  finalize_ts i64
//   [139..147]  losing_total u64
//   [147..155]  winning_total u64
//   [155..163]  slash_total u64 (floor(losing_total * slash_bps / 10_000))
//   [163..171]  treasury_paid u64 (slash_total / 2, paid at finalize)
//   [171..179]  slash_pool u64 (slash_total - treasury_paid; pro-rata to
//               winning stakers, pull-claimable)
//   [179..187]  challenge_id u64
//   [187]       bump u8
//   [188..196]  stake_count u64 (distinct Stake PDAs opened on this challenge)
//   [196..204]  claimed_count u64
//   [204..212]  total_claimed_payout u64
//   [212..224]  reserved
//
// Stake PDA: seeds ["stake", mint, staker, side_byte], STAKE_SPACE bytes:
//   [0]         tag u8 = 1
//   [1..33]     mint
//   [33..65]    staker
//   [65]        side u8 (0 = reigning, 1 = challenger)
//   [66]        claimed bool
//   [67..75]    challenge_id u64
//   [75..83]    amount u64 (accumulated stake on this challenge + side)
//   [83..91]    claimed_payout u64
//   [91]        bump u8
//   [92..96]    reserved
//
// Claim math (all floors, u128 intermediates — exact to the lamport against
// these formulas; per-claimant floors may leave a few lamports of dust in
// the vault, as may a slash pool whose winning side has no stakers):
//   winning side: payout = amount + floor(amount * slash_pool / winning_total)
//   losing side:  payout = floor(amount * (10_000 - slash_bps) / 10_000)

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
    sysvar::Sysvar,
};

// ---------- production defaults (init-time overridable) ----------
// SOL-denominated economics are INIT PARAMETERS, not hardcoded (see
// INTEGRATION.md "open forks"): these constants are only the defaults an
// Init without a parameter block stores. Suggested production defaults,
// flagged for Gregory: bond 0.1 SOL, quorum 0.5 SOL total.
pub const DEFAULT_BOND_LAMPORTS: u64 = 100_000_000; // 0.1 SOL
pub const DEFAULT_QUORUM_LAMPORTS: u64 = 500_000_000; // 0.5 SOL
pub const DEFAULT_WINDOW_SECS: i64 = 259_200; // 72h
pub const DEFAULT_TIMELOCK_SECS: i64 = 86_400; // 24h
pub const DEFAULT_MIN_REIGN_SECS: i64 = 604_800; // 7d
pub const DEFAULT_COOLDOWN_SECS: i64 = 259_200; // 3d
pub const DEFAULT_SLASH_BPS: u16 = 2_000; // 20%

pub const CROWN_SPACE: usize = 256;
pub const CHALLENGE_SPACE: usize = 224;
pub const STAKE_SPACE: usize = 96;

pub const SIDE_REIGNING: u8 = 0;
pub const SIDE_CHALLENGER: u8 = 1;
const STATE_OPEN: u8 = 1;
const STATE_WON: u8 = 2;
const STATE_FAILED: u8 = 3;

#[derive(Debug)]
enum CrownError {
    AlreadyInit = 1,
    BadState = 2,        // crown/challenge/stake account foreign-owned or corrupt
    ChallengeLive = 3,   // a challenge is already open for this crown
    MinReign = 4,        // reign younger than min_reign_secs
    Cooldown = 5,        // failed-challenge cooldown still running
    NoLiveChallenge = 6,
    WindowClosed = 7,    // stake after window_end
    TooEarlyFinalize = 8, // before window_end + timelock_secs
    AlreadyClaimed = 9,
    NotFinalized = 10,
    MathOverflow = 11,
    Insolvent = 12,      // vault cannot cover a payout (accounting bug)
    BadSide = 13,
    PendingClaims = 14,  // previous challenge has unclaimed stakes
    BadTreasury = 15,    // finalize treasury account != crown.treasury
    ZeroAmount = 16,
    StaleStake = 17,     // stake PDA belongs to an unclaimed older challenge
}

impl From<CrownError> for ProgramError {
    fn from(e: CrownError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

entrypoint!(process_instruction);

// ---------- byte helpers (engine family idioms) ----------
fn read_u16(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(d[o..o + 2].try_into().unwrap())
}
fn read_i64(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn read_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn read_key(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}

fn pda(seeds: &[&[u8]], program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, program_id)
}
fn crown_pda(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"crown", mint.as_ref()], program_id).0
}
fn vault_pda(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"cvault", mint.as_ref()], program_id).0
}
fn challenge_pda(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"challenge", mint.as_ref()], program_id).0
}
fn stake_pda(mint: &Pubkey, staker: &Pubkey, side: u8, program_id: &Pubkey) -> Pubkey {
    pda(&[b"stake", mint.as_ref(), staker.as_ref(), &[side]], program_id).0
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

/// Move lamports out of the program-owned vault (debit + credit).
fn vault_pay(vault: &AccountInfo, dest: &AccountInfo, amount: u64) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    if vault.lamports() < amount {
        msg!("crown: vault insolvent ({} < {})", vault.lamports(), amount);
        return Err(CrownError::Insolvent.into());
    }
    **vault.try_borrow_mut_lamports()? -= amount;
    **dest.try_borrow_mut_lamports()? += amount;
    Ok(())
}

fn now_ts() -> Result<i64, ProgramError> {
    Ok(Clock::get()?.unix_timestamp)
}

// ---------- state views ----------
struct Crown {
    mint: Pubkey,
    beneficiary: Pubkey,
    reign_started: i64,
    treasury: Pubkey,
    bond: u64,
    quorum: u64,
    window_secs: i64,
    timelock_secs: i64,
    min_reign_secs: i64,
    cooldown_secs: i64,
    slash_bps: u16,
    cooldown_until: i64,
    challenge_counter: u64,
    active: bool,
}

fn load_crown(ai: &AccountInfo, program_id: &Pubkey) -> Result<Crown, ProgramError> {
    if ai.owner != program_id {
        return Err(CrownError::BadState.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < CROWN_SPACE || d[0] != 1 {
        return Err(CrownError::BadState.into());
    }
    Ok(Crown {
        mint: read_key(&d, 1),
        beneficiary: read_key(&d, 33),
        reign_started: read_i64(&d, 65),
        treasury: read_key(&d, 73),
        bond: read_u64(&d, 137),
        quorum: read_u64(&d, 145),
        window_secs: read_i64(&d, 153),
        timelock_secs: read_i64(&d, 161),
        min_reign_secs: read_i64(&d, 169),
        cooldown_secs: read_i64(&d, 177),
        slash_bps: read_u16(&d, 185),
        cooldown_until: read_i64(&d, 187),
        challenge_counter: read_u64(&d, 195),
        active: d[205] != 0,
    })
}

struct Challenge {
    candidate: Pubkey,
    challenger_stake: u64,
    reigning_stake: u64,
    state: u8,
    window_end: i64,
    challenge_id: u64,
    stake_count: u64,
    claimed_count: u64,
}

fn load_challenge(ai: &AccountInfo, program_id: &Pubkey) -> Result<Challenge, ProgramError> {
    if ai.owner != program_id {
        return Err(CrownError::BadState.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < CHALLENGE_SPACE || d[0] != 1 {
        return Err(CrownError::BadState.into());
    }
    Ok(Challenge {
        candidate: read_key(&d, 33),
        challenger_stake: read_u64(&d, 113),
        reigning_stake: read_u64(&d, 121),
        state: d[129],
        window_end: read_i64(&d, 105),
        challenge_id: read_u64(&d, 179),
        stake_count: read_u64(&d, 188),
        claimed_count: read_u64(&d, 196),
    })
}

// ---------- dispatch ----------
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match data.first() {
        Some(0) => initialize(program_id, accounts, data),
        Some(1) => open_challenge(program_id, accounts, data),
        Some(2) => stake(program_id, accounts, data),
        Some(3) => finalize(program_id, accounts),
        Some(4) => claim(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ---------- Init (tag 0) ----------
// Accounts: [authority(signer,w), mint, crown_pda(w), vault_pda(w), system]
// Data: [0][beneficiary 32][treasury 32]
//       optional param block (50 bytes, all-or-nothing):
//       [bond u64][quorum u64][window_secs i64][timelock_secs i64]
//       [min_reign_secs i64][cooldown_secs i64][slash_bps u16]
// Callable for ANY mint — no engine, token program, or mint-account shape
// is consulted (an absent Crown PDA is the Distributor's fail-open case:
// it simply skips the crown split for that mint).
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let crown_ai = next_account_info(it)?;
    let vault_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < 65 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let beneficiary = read_key(data, 1);
    let treasury = read_key(data, 33);
    let (bond, quorum, window_secs, timelock_secs, min_reign_secs, cooldown_secs, slash_bps) =
        if data.len() >= 115 {
            (
                read_u64(data, 65),
                read_u64(data, 73),
                read_i64(data, 81),
                read_i64(data, 89),
                read_i64(data, 97),
                read_i64(data, 105),
                read_u16(data, 113),
            )
        } else {
            (
                DEFAULT_BOND_LAMPORTS,
                DEFAULT_QUORUM_LAMPORTS,
                DEFAULT_WINDOW_SECS,
                DEFAULT_TIMELOCK_SECS,
                DEFAULT_MIN_REIGN_SECS,
                DEFAULT_COOLDOWN_SECS,
                DEFAULT_SLASH_BPS,
            )
        };
    if bond == 0
        || window_secs <= 0
        || timelock_secs < 0
        || min_reign_secs < 0
        || cooldown_secs < 0
        || slash_bps > 10_000
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    if *crown_ai.key != crown_pda(mint.key, program_id) || *vault_ai.key != vault_pda(mint.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if crown_ai.data_len() > 0 {
        return Err(CrownError::AlreadyInit.into());
    }
    create_pda(program_id, authority, crown_ai, system, &[b"crown", mint.key.as_ref()], CROWN_SPACE)?;
    create_pda(program_id, authority, vault_ai, system, &[b"cvault", mint.key.as_ref()], 0)?;
    let (_, crown_bump) = pda(&[b"crown", mint.key.as_ref()], program_id);
    let (_, vault_bump) = pda(&[b"cvault", mint.key.as_ref()], program_id);
    let now = now_ts()?;
    let mut d = crown_ai.try_borrow_mut_data()?;
    for b in d.iter_mut() {
        *b = 0;
    }
    d[0] = 1;
    d[1..33].copy_from_slice(mint.key.as_ref());
    d[33..65].copy_from_slice(beneficiary.as_ref());
    d[65..73].copy_from_slice(&now.to_le_bytes());
    d[73..105].copy_from_slice(treasury.as_ref());
    d[105..137].copy_from_slice(authority.key.as_ref());
    d[137..145].copy_from_slice(&bond.to_le_bytes());
    d[145..153].copy_from_slice(&quorum.to_le_bytes());
    d[153..161].copy_from_slice(&window_secs.to_le_bytes());
    d[161..169].copy_from_slice(&timelock_secs.to_le_bytes());
    d[169..177].copy_from_slice(&min_reign_secs.to_le_bytes());
    d[177..185].copy_from_slice(&cooldown_secs.to_le_bytes());
    d[185..187].copy_from_slice(&slash_bps.to_le_bytes());
    // cooldown_until (187) = 0, challenge_counter (195) = 0, active (205) = 0
    d[203] = crown_bump;
    d[204] = vault_bump;
    msg!(
        "crown: initialized for mint {} (beneficiary {}, bond {}, quorum {})",
        mint.key, beneficiary, bond, quorum
    );
    Ok(())
}

// ---------- OpenChallenge (tag 1) ----------
// Accounts: [challenger(signer,w), mint, crown_pda(w), challenge_pda(w),
//            vault_pda(w), challenger_stake_pda(w), system]
// Data: [1][candidate 32]  (candidate may differ from the challenger; the
// bond stake belongs to the challenger who paid it)
fn open_challenge(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let challenger = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let crown_ai = next_account_info(it)?;
    let challenge_ai = next_account_info(it)?;
    let vault_ai = next_account_info(it)?;
    let stake_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    if !challenger.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < 33 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let candidate = read_key(data, 1);
    if *crown_ai.key != crown_pda(mint.key, program_id)
        || *challenge_ai.key != challenge_pda(mint.key, program_id)
        || *vault_ai.key != vault_pda(mint.key, program_id)
        || *stake_ai.key != stake_pda(mint.key, challenger.key, SIDE_CHALLENGER, program_id)
    {
        return Err(ProgramError::InvalidSeeds);
    }
    let crown = load_crown(crown_ai, program_id)?;
    if crown.mint != *mint.key {
        return Err(CrownError::BadState.into());
    }
    if crown.active {
        return Err(CrownError::ChallengeLive.into());
    }
    let now = now_ts()?;
    let earliest = crown
        .reign_started
        .checked_add(crown.min_reign_secs)
        .ok_or(CrownError::MathOverflow)?;
    if now < earliest {
        msg!("crown: reign too young ({} < {})", now, earliest);
        return Err(CrownError::MinReign.into());
    }
    if now < crown.cooldown_until {
        msg!("crown: cooldown until {}", crown.cooldown_until);
        return Err(CrownError::Cooldown.into());
    }
    // Previous-challenge hygiene: the single Challenge PDA is recycled, so
    // a finalized-but-unclaimed challenge blocks a new open (its outcome
    // record is the claim basis — overwriting it would strand refunds).
    let mut stake_count: u64 = 0;
    if challenge_ai.data_len() > 0 {
        let prev = load_challenge(challenge_ai, program_id)?;
        if prev.state == STATE_OPEN {
            return Err(CrownError::ChallengeLive.into());
        }
        if prev.claimed_count < prev.stake_count {
            return Err(CrownError::PendingClaims.into());
        }
    } else {
        create_pda(program_id, challenger, challenge_ai, system, &[b"challenge", mint.key.as_ref()], CHALLENGE_SPACE)?;
    }
    let new_id = crown
        .challenge_counter
        .checked_add(1)
        .ok_or(CrownError::MathOverflow)?;

    // Challenger's bond-stake record (side 1): create or recycle (a recycled
    // record must be a CLAIMED one from an older challenge — guaranteed for
    // the previous challenge by the PendingClaims gate above; any other
    // unclaimed older record is stale and blocks).
    let fresh_stake = stake_ai.data_len() == 0;
    if fresh_stake {
        create_pda(
            program_id,
            challenger,
            stake_ai,
            system,
            &[b"stake", mint.key.as_ref(), challenger.key.as_ref(), &[SIDE_CHALLENGER]],
            STAKE_SPACE,
        )?;
    } else {
        if stake_ai.owner != program_id {
            return Err(CrownError::BadState.into());
        }
        let d = stake_ai.try_borrow_data()?;
        if d.len() < STAKE_SPACE || d[0] != 1 || read_key(&d, 1) != *mint.key || read_key(&d, 33) != *challenger.key || d[65] != SIDE_CHALLENGER {
            return Err(CrownError::BadState.into());
        }
        if d[66] == 0 && read_u64(&d, 75) > 0 {
            return Err(CrownError::StaleStake.into());
        }
    }
    stake_count += 1;

    // Bond: challenger -> vault (system transfer; fails if underfunded).
    invoke(
        &system_instruction::transfer(challenger.key, vault_ai.key, crown.bond),
        &[challenger.clone(), vault_ai.clone(), system.clone()],
    )?;

    // Write the challenge record.
    let window_end = now.checked_add(crown.window_secs).ok_or(CrownError::MathOverflow)?;
    {
        let (_, bump) = pda(&[b"challenge", mint.key.as_ref()], program_id);
        let mut d = challenge_ai.try_borrow_mut_data()?;
        for b in d.iter_mut() {
            *b = 0;
        }
        d[0] = 1;
        d[1..33].copy_from_slice(mint.key.as_ref());
        d[33..65].copy_from_slice(candidate.as_ref());
        d[65..97].copy_from_slice(challenger.key.as_ref());
        d[97..105].copy_from_slice(&now.to_le_bytes());
        d[105..113].copy_from_slice(&window_end.to_le_bytes());
        d[113..121].copy_from_slice(&crown.bond.to_le_bytes());
        // reigning_stake (121) = 0
        d[129] = STATE_OPEN;
        d[130] = 255; // undecided
        d[179..187].copy_from_slice(&new_id.to_le_bytes());
        d[187] = bump;
        d[188..196].copy_from_slice(&stake_count.to_le_bytes());
    }
    // Write the challenger's bond stake record.
    {
        let (_, bump) = pda(&[b"stake", mint.key.as_ref(), challenger.key.as_ref(), &[SIDE_CHALLENGER]], program_id);
        let mut d = stake_ai.try_borrow_mut_data()?;
        for b in d.iter_mut() {
            *b = 0;
        }
        d[0] = 1;
        d[1..33].copy_from_slice(mint.key.as_ref());
        d[33..65].copy_from_slice(challenger.key.as_ref());
        d[65] = SIDE_CHALLENGER;
        // claimed (66) = 0
        d[67..75].copy_from_slice(&new_id.to_le_bytes());
        d[75..83].copy_from_slice(&crown.bond.to_le_bytes());
        d[91] = bump;
    }
    // Crown: mark live + advance the id counter.
    {
        let mut d = crown_ai.try_borrow_mut_data()?;
        d[195..203].copy_from_slice(&new_id.to_le_bytes());
        d[205] = 1;
    }
    msg!(
        "crown: challenge {} opened for mint {} (candidate {}, bond {})",
        new_id, mint.key, candidate, crown.bond
    );
    Ok(())
}

// ---------- Stake (tag 2) ----------
// Accounts: [staker(signer,w), mint, crown_pda, challenge_pda(w),
//            vault_pda(w), stake_pda(w), system]
// Data: [2][side u8][amount u64]
fn stake(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let staker = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let crown_ai = next_account_info(it)?;
    let challenge_ai = next_account_info(it)?;
    let vault_ai = next_account_info(it)?;
    let stake_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    if !staker.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < 10 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let side = data[1];
    if side != SIDE_REIGNING && side != SIDE_CHALLENGER {
        return Err(CrownError::BadSide.into());
    }
    let amount = read_u64(data, 2);
    if amount == 0 {
        return Err(CrownError::ZeroAmount.into());
    }
    if *crown_ai.key != crown_pda(mint.key, program_id)
        || *challenge_ai.key != challenge_pda(mint.key, program_id)
        || *vault_ai.key != vault_pda(mint.key, program_id)
        || *stake_ai.key != stake_pda(mint.key, staker.key, side, program_id)
    {
        return Err(ProgramError::InvalidSeeds);
    }
    let crown = load_crown(crown_ai, program_id)?;
    if crown.mint != *mint.key || !crown.active {
        return Err(CrownError::NoLiveChallenge.into());
    }
    let ch = load_challenge(challenge_ai, program_id)?;
    if ch.state != STATE_OPEN {
        return Err(CrownError::NoLiveChallenge.into());
    }
    let now = now_ts()?;
    if now > ch.window_end {
        return Err(CrownError::WindowClosed.into());
    }

    // Stake record: create, accumulate, or recycle a claimed older record.
    let fresh = stake_ai.data_len() == 0;
    let mut new_stake_count = ch.stake_count;
    if fresh {
        create_pda(
            program_id,
            staker,
            stake_ai,
            system,
            &[b"stake", mint.key.as_ref(), staker.key.as_ref(), &[side]],
            STAKE_SPACE,
        )?;
        new_stake_count = new_stake_count.checked_add(1).ok_or(CrownError::MathOverflow)?;
    } else {
        if stake_ai.owner != program_id {
            return Err(CrownError::BadState.into());
        }
        let d = stake_ai.try_borrow_data()?;
        if d.len() < STAKE_SPACE || d[0] != 1 || read_key(&d, 1) != *mint.key || read_key(&d, 33) != *staker.key || d[65] != side {
            return Err(CrownError::BadState.into());
        }
        if read_u64(&d, 67) != ch.challenge_id {
            if d[66] == 0 && read_u64(&d, 75) > 0 {
                return Err(CrownError::StaleStake.into());
            }
            // Claimed record from an older challenge: recycle (counts as a
            // distinct stake record on THIS challenge).
            new_stake_count = new_stake_count.checked_add(1).ok_or(CrownError::MathOverflow)?;
        } else if d[66] != 0 {
            // Already claimed on the CURRENT challenge (only possible if
            // finalize already ran — state check above forbids it; defensive).
            return Err(CrownError::AlreadyClaimed.into());
        }
    }

    invoke(
        &system_instruction::transfer(staker.key, vault_ai.key, amount),
        &[staker.clone(), vault_ai.clone(), system.clone()],
    )?;

    // Accumulate the stake record.
    {
        let (_, bump) = pda(&[b"stake", mint.key.as_ref(), staker.key.as_ref(), &[side]], program_id);
        let mut d = stake_ai.try_borrow_mut_data()?;
        if fresh || read_u64(&d, 67) != ch.challenge_id {
            for b in d.iter_mut() {
                *b = 0;
            }
            d[0] = 1;
            d[1..33].copy_from_slice(mint.key.as_ref());
            d[33..65].copy_from_slice(staker.key.as_ref());
            d[65] = side;
            d[67..75].copy_from_slice(&ch.challenge_id.to_le_bytes());
            d[91] = bump;
        }
        let amt = read_u64(&d, 75).checked_add(amount).ok_or(CrownError::MathOverflow)?;
        d[75..83].copy_from_slice(&amt.to_le_bytes());
    }
    // Accumulate the challenge side total + stake count.
    {
        let mut d = challenge_ai.try_borrow_mut_data()?;
        if side == SIDE_CHALLENGER {
            let v = read_u64(&d, 113).checked_add(amount).ok_or(CrownError::MathOverflow)?;
            d[113..121].copy_from_slice(&v.to_le_bytes());
        } else {
            let v = read_u64(&d, 121).checked_add(amount).ok_or(CrownError::MathOverflow)?;
            d[121..129].copy_from_slice(&v.to_le_bytes());
        }
        d[188..196].copy_from_slice(&new_stake_count.to_le_bytes());
    }
    msg!("crown: stake {} lamports on side {} for mint {}", amount, side, mint.key);
    Ok(())
}

// ---------- Finalize (tag 3) ----------
// Accounts: [caller(signer — fee payer only; resolution is rule-based),
//            mint, crown_pda(w), challenge_pda(w), vault_pda(w), treasury(w)]
// Challenger wins iff challenger_stake > reigning_stake AND total >=
// quorum. The losing side is slashed slash_bps: half the slash goes to
// the treasury NOW; the other half stays in the vault as the winners'
// pro-rata slash pool (pull-claimable). On a FAIL (incl. quorum miss) the
// challenger side is the losing side and the crown's cooldown starts.
fn finalize(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let caller = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let crown_ai = next_account_info(it)?;
    let challenge_ai = next_account_info(it)?;
    let vault_ai = next_account_info(it)?;
    let treasury_ai = next_account_info(it)?;
    let _ = caller; // permissionless: any fee payer may crank resolution

    if *crown_ai.key != crown_pda(mint.key, program_id)
        || *challenge_ai.key != challenge_pda(mint.key, program_id)
        || *vault_ai.key != vault_pda(mint.key, program_id)
    {
        return Err(ProgramError::InvalidSeeds);
    }
    let crown = load_crown(crown_ai, program_id)?;
    if crown.mint != *mint.key || !crown.active {
        return Err(CrownError::NoLiveChallenge.into());
    }
    if *treasury_ai.key != crown.treasury {
        return Err(CrownError::BadTreasury.into());
    }
    let ch = load_challenge(challenge_ai, program_id)?;
    if ch.state != STATE_OPEN {
        return Err(CrownError::NotFinalized.into());
    }
    let now = now_ts()?;
    let finalizable_at = ch
        .window_end
        .checked_add(crown.timelock_secs)
        .ok_or(CrownError::MathOverflow)?;
    if now < finalizable_at {
        msg!("crown: finalize too early ({} < {})", now, finalizable_at);
        return Err(CrownError::TooEarlyFinalize.into());
    }

    let total = ch
        .challenger_stake
        .checked_add(ch.reigning_stake)
        .ok_or(CrownError::MathOverflow)?;
    let win = ch.challenger_stake > ch.reigning_stake && total >= crown.quorum;
    let (winning_side, winning_total, losing_total) = if win {
        (SIDE_CHALLENGER, ch.challenger_stake, ch.reigning_stake)
    } else {
        (SIDE_REIGNING, ch.reigning_stake, ch.challenger_stake)
    };
    let slash_total = ((losing_total as u128 * crown.slash_bps as u128) / 10_000) as u64;
    let treasury_paid = slash_total / 2;
    let slash_pool = slash_total - treasury_paid;

    // Treasury's half of the slash leaves at finalize; the winners' half
    // stays in the vault for pull claims.
    vault_pay(vault_ai, treasury_ai, treasury_paid)?;

    // Challenge record: outcome snapshot (the claim basis).
    {
        let mut d = challenge_ai.try_borrow_mut_data()?;
        d[129] = if win { STATE_WON } else { STATE_FAILED };
        d[130] = winning_side;
        d[131..139].copy_from_slice(&now.to_le_bytes());
        d[139..147].copy_from_slice(&losing_total.to_le_bytes());
        d[147..155].copy_from_slice(&winning_total.to_le_bytes());
        d[155..163].copy_from_slice(&slash_total.to_le_bytes());
        d[163..171].copy_from_slice(&treasury_paid.to_le_bytes());
        d[171..179].copy_from_slice(&slash_pool.to_le_bytes());
    }
    // Crown: flip on a win, cooldown on a fail; clear the live flag.
    {
        let mut d = crown_ai.try_borrow_mut_data()?;
        if win {
            d[33..65].copy_from_slice(ch.candidate.as_ref());
            d[65..73].copy_from_slice(&now.to_le_bytes());
        } else {
            let until = now.checked_add(crown.cooldown_secs).ok_or(CrownError::MathOverflow)?;
            d[187..195].copy_from_slice(&until.to_le_bytes());
        }
        d[205] = 0;
        let r = read_u64(&d, 206).checked_add(1).ok_or(CrownError::MathOverflow)?;
        d[206..214].copy_from_slice(&r.to_le_bytes());
        let ts = read_u64(&d, 214).checked_add(total).ok_or(CrownError::MathOverflow)?;
        d[214..222].copy_from_slice(&ts.to_le_bytes());
        let sl = read_u64(&d, 222).checked_add(slash_total).ok_or(CrownError::MathOverflow)?;
        d[222..230].copy_from_slice(&sl.to_le_bytes());
        let tp = read_u64(&d, 230).checked_add(treasury_paid).ok_or(CrownError::MathOverflow)?;
        d[230..238].copy_from_slice(&tp.to_le_bytes());
    }
    msg!(
        "crown: challenge {} finalized for mint {} — {} (win={}, slash {}, treasury {}, pool {})",
        ch.challenge_id,
        mint.key,
        if win { "challenger WINS" } else { "challenge FAILED" },
        win,
        slash_total,
        treasury_paid,
        slash_pool
    );
    Ok(())
}

// ---------- Claim (tag 4) ----------
// Accounts: [staker(signer,w), mint, crown_pda, challenge_pda(w),
//            vault_pda(w), stake_pda(w)]
// Pull payout against the finalized challenge record. Double-claim errors
// cleanly (AlreadyClaimed) and pays 0.
fn claim(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let staker = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let crown_ai = next_account_info(it)?;
    let challenge_ai = next_account_info(it)?;
    let vault_ai = next_account_info(it)?;
    let stake_ai = next_account_info(it)?;

    if !staker.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *crown_ai.key != crown_pda(mint.key, program_id)
        || *challenge_ai.key != challenge_pda(mint.key, program_id)
        || *vault_ai.key != vault_pda(mint.key, program_id)
    {
        return Err(ProgramError::InvalidSeeds);
    }
    let crown = load_crown(crown_ai, program_id)?;
    if crown.mint != *mint.key {
        return Err(CrownError::BadState.into());
    }
    // Load the stake record (its side determines its own PDA key).
    let (side, amount, claimed, stake_challenge_id) = {
        if stake_ai.owner != program_id {
            return Err(CrownError::BadState.into());
        }
        let d = stake_ai.try_borrow_data()?;
        if d.len() < STAKE_SPACE || d[0] != 1 || read_key(&d, 1) != *mint.key || read_key(&d, 33) != *staker.key {
            return Err(CrownError::BadState.into());
        }
        (d[65], read_u64(&d, 75), d[66] != 0, read_u64(&d, 67))
    };
    if *stake_ai.key != stake_pda(mint.key, staker.key, side, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if claimed {
        return Err(CrownError::AlreadyClaimed.into());
    }
    let ch = load_challenge(challenge_ai, program_id)?;
    if ch.state == STATE_OPEN {
        return Err(CrownError::NotFinalized.into());
    }
    if stake_challenge_id != ch.challenge_id {
        return Err(CrownError::StaleStake.into());
    }
    let (winning_side, winning_total, slash_pool) = {
        let d = challenge_ai.try_borrow_data()?;
        (d[130], read_u64(&d, 147), read_u64(&d, 171))
    };
    let payout: u64 = if side == winning_side {
        let share = if winning_total > 0 {
            ((amount as u128 * slash_pool as u128) / winning_total as u128) as u64
        } else {
            0
        };
        amount.checked_add(share).ok_or(CrownError::MathOverflow)?
    } else {
        ((amount as u128 * (10_000u128 - crown.slash_bps as u128)) / 10_000) as u64
    };

    // Effects before interaction: mark claimed + advance the counters.
    {
        let mut d = stake_ai.try_borrow_mut_data()?;
        d[66] = 1;
        d[83..91].copy_from_slice(&payout.to_le_bytes());
    }
    {
        let mut d = challenge_ai.try_borrow_mut_data()?;
        let cc = read_u64(&d, 196).checked_add(1).ok_or(CrownError::MathOverflow)?;
        d[196..204].copy_from_slice(&cc.to_le_bytes());
        let tcp = read_u64(&d, 204).checked_add(payout).ok_or(CrownError::MathOverflow)?;
        d[204..212].copy_from_slice(&tcp.to_le_bytes());
    }
    vault_pay(vault_ai, staker, payout)?;
    msg!("crown: claim paid {} lamports to {} (side {})", payout, staker.key, side);
    Ok(())
}

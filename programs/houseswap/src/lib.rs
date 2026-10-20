// HouseSwap — the Hook Launcher's house venue (native, no Anchor).
//
// Phase C contract SS2 (PHASE-C-CONTRACT.md). Generalizes TaxSwap
// (~/workspace/taxhook/swap): a single constant-product pool per token mint —
// hooked token (Token-2022, engine transfer hook) vs quote (wSOL, legacy SPL
// token program). The first 168 bytes of the Pool account are BYTE-IDENTICAL
// to TaxSwap's layout; the Phase C extension fields live past them.
//
// Deliberate deviations from TaxSwap (both mandated by the contract):
//   * NO hardcoded 30 bps 9970/10000 factor. The swap fee IS pool.fee_bps,
//     mirrored from the curve's creator fee at ActivatePool; before the pool
//     goes live fee_bps is 0 and swaps are fee-free. The fee stays in the
//     input-side vault (reserves grow) and accrues to the pool's counters,
//     paid out by ClaimFees.
//   * The hook tail is GENERIC: TaxSwap forwarded a fixed 9-account tail for
//     the TH hook; this venue forwards whatever tail accounts it is given
//     (the engine's templated extras, in the mint's published meta-list
//     order), appending hook program + meta list per the SPL resolver
//     layout — TaxSwap's transfer_hooked_ix discipline. Venue-extra
//     accounts (escrow / price feed / seller holder / fee-dest) sit AFTER
//     the tail, are consumed by the venue itself, and are NEVER forwarded
//     into a transfer CPI.
//
// Pool account (PDA seeds ["pool", mint], POOL_SIZE = 264):
//   [0] tag=1 | [1..33] authority | [33..65] token_mint | [65..97] quote_mint
//   [97..129] token_vault | [129..161] quote_vault | [161] bump
//   [162] committed u8 (engine tag 14 reads this byte)
//   [163] live u8 (fee mirror written by ActivatePool)
//   [164..168] reserved
//   [168..170] fee_bps u16 | [170..202] fee_dest pubkey
//   [202..210] fee_accrued_quote u64 (engine tag 15 reads this)
//   [210..218] fee_accrued_token u64 | [218..226] activated_ts i64
//   [226..264] reserved
//
// Escrow PDA (rule 2; seeds ["escrow", mint, user_token_account] under THIS
// program, ESCROW_SPACE = 96):
//   [0] tag=1 | [1..33] owner | [33..41] escrow_lamports u64
//   [41..49] total_refunded u64 | [49..57] total_forfeited u64 | [57..96] reserved
// The PDA holds its escrow as its own lamports above rent:
//   lamports == rent_min(96) + escrow_lamports.
//
// Instructions (data[0]):
//   0 InitPool        [payer(s,w), token_mint, quote_mint, token_vault,
//                      quote_vault, pool(w), system] — TaxSwap verbatim.
//   1 Swap [dir u8][amount_in u64][min_out u64]
//                      dir 0 = buy (quote in, token out), 1 = sell.
//                      accounts [pool, token_mint, quote_mint, token_vault(w),
//                      quote_vault(w), user_token(w), user_quote(w), user(s),
//                      token_prog, quote_prog, HOOK TAIL..., VENUE EXTRAS...]
//   2 AddLiquidity [amt_token u64][amt_quote u64]    (TaxSwap accounts; the
//   3 RemoveLiquidity [amt_token u64][amt_quote u64]  token leg is hooked)
//   4 CommitPool      [pool(w), mint, authority(signer)]
//   5 ActivatePool [fee_bps u16]
//                      [pool(w), mint, engine_config(ro), dbc_pool(ro),
//                      dbc_config(ro)]
//   6 ClaimFees       [pool(w), token_mint, quote_mint, token_vault(w),
//                      quote_vault(w), fee_dest_token(w), fee_dest_quote(w),
//                      token_prog, quote_prog, HOOK TAIL...]
//
// Program id: this file is built against the runtime program_id throughout;
// the dev/trial id is houseswap-keypair.json's pubkey (see INTEGRATION.md).

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

/// The hook engine (same id in both flavors — trials load the trial engine
/// AT this id; PHASE-C-CONTRACT SS2).
const ENGINE_ID_STR: &str = "EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT";
/// Meteora Dynamic Bonding Curve program.
const DBC_ID_STR: &str = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const TOKEN_2022_ID_STR: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_ID_STR: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const NATIVE_MINT_STR: &str = "So11111111111111111111111111111111111111112";

fn engine_id() -> Pubkey {
    Pubkey::from_str(ENGINE_ID_STR).unwrap()
}
fn dbc_id() -> Pubkey {
    Pubkey::from_str(DBC_ID_STR).unwrap()
}
fn native_mint() -> Pubkey {
    Pubkey::from_str(NATIVE_MINT_STR).unwrap()
}

const POOL_SIZE: usize = 264;
const ESCROW_SPACE: usize = 96;
// Pool extension offsets (contract SS2.1).
const POOL_COMMITTED_OFF: usize = 162;
const POOL_LIVE_OFF: usize = 163;
const POOL_FEE_BPS_OFF: usize = 168;
const POOL_FEE_DEST_OFF: usize = 170;
const POOL_FEE_ACC_Q_OFF: usize = 202;
const POOL_FEE_ACC_T_OFF: usize = 210;
const POOL_ACTIVATED_OFF: usize = 218;
// Engine Config layout (published): rules at 462, 68B entries.
const CFG_RULES_OFF: usize = 462;
const CFG_RULE_ENTRY_LEN: usize = 68;
const CFG_MAX_RULES: usize = 8;
// Engine house region (CONFIG_SPACE_V2 = 1152).
const HOUSE_PROG_OFF: usize = 1088;
const HOUSE_STATE_OFF: usize = 1144;
// Engine PriceFeed layout (published): ema u128 @97, last_crank_ts i64 @113.
// Engine Holder layout (published): basis_num u128 @6, basis_den u128 @22,
// latched u8 @38.
const RULE_BASIS_LATCH: u16 = 1;
const RULE_ESCROW_SPLIT: u16 = 2;

#[derive(Debug)]
enum HouseswapError {
    BadPool = 1,
    Slippage = 2,
    MathOverflow = 3,
    Unauthorized = 4,
    BadVault = 5,
    AlreadyLive = 6,     // ActivatePool on a live pool (second call rejects)
    NotCommitted = 7,    // ActivatePool before CommitPool
    BadHouseState = 8,   // engine config house slot missing / not activated / wrong program
    BadDbc = 9,          // dbc_pool / dbc_config linkage or shape invalid
    BadFeeBps = 10,      // ActivatePool fee_bps outside 25..=9900
    MissingEscrow = 11,  // rule 2 swap without the escrow venue-extra account
    BadEscrow = 12,      // escrow account is not the derived PDA / is corrupt
    BadFeeDest = 13,     // ClaimFees destination is not fee_dest's account of the right mint
    BadConfig = 14,      // tail config account is not the engine Config PDA
    AlreadyCommitted = 15,
    BadVenueExtra = 16,  // venue-extra account key is not the derived PDA
}

impl From<HouseswapError> for ProgramError {
    fn from(e: HouseswapError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

entrypoint!(process_instruction);

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

// token account: mint @0, owner @32, amount @64
fn acct_mint(ai: &AccountInfo) -> Result<Pubkey, ProgramError> {
    let d = ai.try_borrow_data()?;
    if d.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(read_key(&d, 0))
}
fn acct_owner(ai: &AccountInfo) -> Result<Pubkey, ProgramError> {
    let d = ai.try_borrow_data()?;
    if d.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(read_key(&d, 32))
}
fn acct_amount(ai: &AccountInfo) -> Result<u64, ProgramError> {
    let d = ai.try_borrow_data()?;
    if d.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(read_u64(&d, 64))
}
fn mint_decimals(ai: &AccountInfo) -> Result<u8, ProgramError> {
    let d = ai.try_borrow_data()?;
    if d.len() < 82 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(d[44])
}

// ---------- PDAs ----------
fn pda(seeds: &[&[u8]], program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, program_id)
}
fn pool_pda(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    pda(&[b"pool", mint.as_ref()], program_id)
}
fn poolauth_pda(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    pda(&[b"poolauth", mint.as_ref()], program_id).0
}
fn escrow_pda(mint: &Pubkey, user_token: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    pda(&[b"escrow", mint.as_ref(), user_token.as_ref()], program_id)
}
fn engine_config_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"config", mint.as_ref()], &engine_id()).0
}
fn engine_meta_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"extra-account-metas", mint.as_ref()], &engine_id()).0
}
fn engine_price_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"price", mint.as_ref()], &engine_id()).0
}
fn engine_holder_pda(mint: &Pubkey, token_account: &Pubkey) -> Pubkey {
    pda(&[b"holder", mint.as_ref(), token_account.as_ref()], &engine_id()).0
}

// ---------- Pool state ----------
struct Pool {
    authority: Pubkey,
    token_mint: Pubkey,
    quote_mint: Pubkey,
    token_vault: Pubkey,
    quote_vault: Pubkey,
    bump: u8,
    committed: u8,
    live: u8,
    fee_bps: u16,
    fee_dest: Pubkey,
    fee_accrued_quote: u64,
    fee_accrued_token: u64,
}

fn load_pool(ai: &AccountInfo) -> Result<Pool, ProgramError> {
    let d = ai.try_borrow_data()?;
    if d.len() < POOL_SIZE || d[0] != 1 {
        return Err(HouseswapError::BadPool.into());
    }
    Ok(Pool {
        authority: read_key(&d, 1),
        token_mint: read_key(&d, 33),
        quote_mint: read_key(&d, 65),
        token_vault: read_key(&d, 97),
        quote_vault: read_key(&d, 129),
        bump: d[161],
        committed: d[POOL_COMMITTED_OFF],
        live: d[POOL_LIVE_OFF],
        fee_bps: read_u16(&d, POOL_FEE_BPS_OFF),
        fee_dest: read_key(&d, POOL_FEE_DEST_OFF),
        fee_accrued_quote: read_u64(&d, POOL_FEE_ACC_Q_OFF),
        fee_accrued_token: read_u64(&d, POOL_FEE_ACC_T_OFF),
    })
}

fn accrue_fee(pool_ai: &AccountInfo, buy: bool, fee: u64) -> ProgramResult {
    if fee == 0 {
        return Ok(());
    }
    let mut d = pool_ai.try_borrow_mut_data()?;
    if buy {
        let v = read_u64(&d, POOL_FEE_ACC_Q_OFF)
            .checked_add(fee)
            .ok_or(HouseswapError::MathOverflow)?;
        d[POOL_FEE_ACC_Q_OFF..POOL_FEE_ACC_Q_OFF + 8].copy_from_slice(&v.to_le_bytes());
    } else {
        let v = read_u64(&d, POOL_FEE_ACC_T_OFF)
            .checked_add(fee)
            .ok_or(HouseswapError::MathOverflow)?;
        d[POOL_FEE_ACC_T_OFF..POOL_FEE_ACC_T_OFF + 8].copy_from_slice(&v.to_le_bytes());
    }
    Ok(())
}

// ---------- transfer builders (TaxSwap, verbatim shape) ----------
// SPL token TransferChecked instruction (tag 12). Required for Token-2022
// hook mints (plain Transfer is rejected) and valid for plain mints too.
fn transfer_ix(
    program: &Pubkey,
    source: &Pubkey,
    mint: &Pubkey,
    dest: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.push(12u8);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction {
        program_id: *program,
        accounts: vec![
            AccountMeta::new(*source, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

// TransferChecked for the HOOKED token leg: Token-2022 requires the resolved
// extra accounts appended to the transfer itself — for CPI transfers the
// venue must forward them. Tail layout (per the SPL reference resolver):
// [...extras in meta-list order, hook program id, validation (meta list)].
fn transfer_hooked_ix(
    program: &Pubkey,
    source: &Pubkey,
    mint: &Pubkey,
    dest: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
    tail: &[AccountMeta],
) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.push(12u8);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let mut accounts = vec![
        AccountMeta::new(*source, false),
        AccountMeta::new_readonly(*mint, false),
        AccountMeta::new(*dest, false),
        AccountMeta::new_readonly(*authority, true),
    ];
    accounts.extend_from_slice(tail);
    Instruction { program_id: *program, accounts, data }
}

// ---------- generic hook tail ----------
// The tail begins at accounts[start]. Its LAST account is the engine's
// meta-list PDA for the mint (the SPL resolver layout ends the tail with
// hook program + meta list); everything from `start` through that account
// is tail, everything after it is venue-extra. If no meta-list account is
// present (an unhooked mint), the tail is empty and all remaining accounts
// are venue-extra.
struct Tail<'a> {
    /// AccountInfos to pass to the transfer CPI, in given order.
    infos: Vec<AccountInfo<'a>>,
    /// CPI metas for the same accounts (writability per the meta list's
    /// published flags, reconstructed by key — see tail_metas).
    metas: Vec<AccountMeta>,
    /// Index one past the tail in the instruction account list.
    end: usize,
}

fn tail_writable(key: &Pubkey, mint: &Pubkey, leg_src: &Pubkey, leg_dst: &Pubkey) -> bool {
    // Writable extras in the engine's canonical list: src holder, dst
    // holder, rent vault, king. Everything else (config, price feed,
    // system, sysvar, lists, allow, hook program, meta list) is read-only.
    let eng = engine_id();
    *key == pda(&[b"holder", mint.as_ref(), leg_src.as_ref()], &eng).0
        || *key == pda(&[b"holder", mint.as_ref(), leg_dst.as_ref()], &eng).0
        || *key == pda(&[b"rentvault", mint.as_ref()], &eng).0
        || *key == pda(&[b"king", mint.as_ref()], &eng).0
}

fn scan_tail<'a>(
    accounts: &[AccountInfo<'a>],
    start: usize,
    mint: &Pubkey,
    leg_src: &Pubkey,
    leg_dst: &Pubkey,
) -> Tail<'a> {
    let meta_key = engine_meta_pda(mint);
    let end = match (start..accounts.len()).find(|&i| *accounts[i].key == meta_key) {
        Some(p) => p + 1,
        None => start, // no meta-list account anywhere: no tail at all
    };
    let mut infos = Vec::with_capacity(end - start);
    let mut metas = Vec::with_capacity(end - start);
    for ai in &accounts[start..end] {
        let w = tail_writable(ai.key, mint, leg_src, leg_dst);
        metas.push(if w {
            AccountMeta::new(*ai.key, false)
        } else {
            AccountMeta::new_readonly(*ai.key, false)
        });
        infos.push(ai.clone());
    }
    Tail { infos, metas, end }
}

/// The tail AccountInfos as a CPI account slice: the 4 base transfer
/// accounts followed by the tail infos.
fn cpi_accounts<'a>(
    base: &[AccountInfo<'a>],
    tail: &Tail<'a>,
) -> Vec<AccountInfo<'a>> {
    let mut v = Vec::with_capacity(base.len() + tail.infos.len());
    v.extend_from_slice(base);
    v.extend(tail.infos.iter().cloned());
    v
}

// ---------- engine config reads (venue-side, from the tail's config) ----------
struct VenueRules {
    escrow_split_bps: Option<u16>,
    latch_max_stale: i64,
}

fn read_venue_rules(tail: &Tail, mint: &Pubkey) -> Result<VenueRules, ProgramError> {
    let mut out = VenueRules { escrow_split_bps: None, latch_max_stale: 300 };
    let cfg_key = engine_config_pda(mint);
    let cfg_ai = match tail.infos.iter().find(|ai| *ai.key == cfg_key) {
        Some(ai) => ai,
        None => return Ok(out), // no config in the tail: no venue rules
    };
    if cfg_ai.owner != &engine_id() {
        return Err(HouseswapError::BadConfig.into());
    }
    let d = cfg_ai.try_borrow_data()?;
    if d.len() < CFG_RULES_OFF + CFG_RULE_ENTRY_LEN || d[0] != 1 {
        return Err(HouseswapError::BadConfig.into());
    }
    let rule_count = (d[3] as usize).min(CFG_MAX_RULES);
    for i in 0..rule_count {
        let o = CFG_RULES_OFF + i * CFG_RULE_ENTRY_LEN;
        let rule_id = read_u16(&d, o);
        let enabled = d[o + 2] == 1;
        if !enabled {
            continue;
        }
        if rule_id == RULE_ESCROW_SPLIT {
            out.escrow_split_bps = Some(read_u16(&d, o + 4));
        }
        if rule_id == RULE_BASIS_LATCH {
            let v = read_u64(&d, o + 4);
            out.latch_max_stale = if v == 0 { 300 } else { v as i64 };
        }
    }
    Ok(out)
}

// ---------- dispatch ----------
pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(0) => init_pool(program_id, accounts),
        Some(1) => swap(program_id, accounts, data),
        Some(2) => liquidity(program_id, accounts, data, true),
        Some(3) => liquidity(program_id, accounts, data, false),
        Some(4) => commit_pool(program_id, accounts),
        Some(5) => activate_pool(program_id, accounts, data),
        Some(6) => claim_fees(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ---------- 0 InitPool (TaxSwap verbatim checks; 264-byte account) ----------
fn init_pool(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let token_mint = next_account_info(it)?;
    let quote_mint = next_account_info(it)?;
    let token_vault = next_account_info(it)?;
    let quote_vault = next_account_info(it)?;
    let pool_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    let (expect, bump) = pool_pda(token_mint.key, program_id);
    if *pool_ai.key != expect {
        return Err(ProgramError::InvalidSeeds);
    }
    // vaults must be token accounts of the right mints, controlled by the pool PDA
    if acct_mint(token_vault)? != *token_mint.key || acct_owner(token_vault)? != expect {
        return Err(HouseswapError::BadVault.into());
    }
    if acct_mint(quote_vault)? != *quote_mint.key || acct_owner(quote_vault)? != expect {
        return Err(HouseswapError::BadVault.into());
    }
    let rent = Rent::get()?.minimum_balance(POOL_SIZE);
    let bump_arr = [bump];
    let seeds: &[&[u8]] = &[b"pool", token_mint.key.as_ref(), &bump_arr];
    invoke_signed(
        &system_instruction::create_account(payer.key, pool_ai.key, rent, POOL_SIZE as u64, program_id),
        &[payer.clone(), pool_ai.clone(), system.clone()],
        &[seeds],
    )?;
    let mut d = pool_ai.try_borrow_mut_data()?;
    for b in d.iter_mut() {
        *b = 0; // the whole 264-byte record starts zeroed (extension included)
    }
    d[0] = 1;
    d[1..33].copy_from_slice(payer.key.as_ref());
    d[33..65].copy_from_slice(token_mint.key.as_ref());
    d[65..97].copy_from_slice(quote_mint.key.as_ref());
    d[97..129].copy_from_slice(token_vault.key.as_ref());
    d[129..161].copy_from_slice(quote_vault.key.as_ref());
    d[161] = bump;
    // committed (162) = 0, live (163) = 0, fee_bps = 0, fee_dest = zero,
    // counters = 0, activated_ts = 0 — all from the zeroing pass.
    msg!("houseswap: pool initialized for mint {}", token_mint.key);
    Ok(())
}

// ---------- escrow helpers (rule 2) ----------
struct EscrowState {
    exists: bool,
    escrow_lamports: u64,
    total_refunded: u64,
    total_forfeited: u64,
}

fn load_escrow(ai: &AccountInfo, program_id: &Pubkey) -> Result<EscrowState, ProgramError> {
    if ai.data_len() == 0 {
        return Ok(EscrowState { exists: false, escrow_lamports: 0, total_refunded: 0, total_forfeited: 0 });
    }
    if ai.owner != program_id {
        return Err(HouseswapError::BadEscrow.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < ESCROW_SPACE || d[0] != 1 {
        return Err(HouseswapError::BadEscrow.into());
    }
    Ok(EscrowState {
        exists: true,
        escrow_lamports: read_u64(&d, 33),
        total_refunded: read_u64(&d, 41),
        total_forfeited: read_u64(&d, 49),
    })
}

fn write_escrow(ai: &AccountInfo, st: &EscrowState) -> ProgramResult {
    let mut d = ai.try_borrow_mut_data()?;
    d[33..41].copy_from_slice(&st.escrow_lamports.to_le_bytes());
    d[41..49].copy_from_slice(&st.total_refunded.to_le_bytes());
    d[49..57].copy_from_slice(&st.total_forfeited.to_le_bytes());
    Ok(())
}

/// Create the escrow PDA if absent (user funds rent; this program signs
/// with the escrow seeds). Handles the pre-funded-but-unallocated case via
/// the allocate/assign pattern so a dust-funded PDA cannot brick a buy.
fn ensure_escrow<'a>(
    program_id: &Pubkey,
    user: &AccountInfo<'a>,
    escrow_ai: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    mint: &Pubkey,
    user_token: &Pubkey,
    owner: &Pubkey,
) -> ProgramResult {
    if escrow_ai.data_len() > 0 {
        return Ok(()); // load_escrow validates shape afterwards
    }
    let (expect, bump) = escrow_pda(mint, user_token, program_id);
    if *escrow_ai.key != expect {
        return Err(HouseswapError::BadEscrow.into());
    }
    let bump_arr = [bump];
    let seeds: &[&[u8]] = &[b"escrow", mint.as_ref(), user_token.as_ref(), &bump_arr];
    let rent = Rent::get()?.minimum_balance(ESCROW_SPACE);
    if escrow_ai.lamports() == 0 {
        invoke_signed(
            &system_instruction::create_account(user.key, escrow_ai.key, rent, ESCROW_SPACE as u64, program_id),
            &[user.clone(), escrow_ai.clone(), system.clone()],
            &[seeds],
        )?;
    } else {
        let delta = rent.saturating_sub(escrow_ai.lamports());
        if delta > 0 {
            invoke(
                &system_instruction::transfer(user.key, escrow_ai.key, delta),
                &[user.clone(), escrow_ai.clone(), system.clone()],
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(escrow_ai.key, ESCROW_SPACE as u64),
            &[escrow_ai.clone(), system.clone()],
            &[seeds],
        )?;
        invoke_signed(
            &system_instruction::assign(escrow_ai.key, program_id),
            &[escrow_ai.clone(), system.clone()],
            &[seeds],
        )?;
    }
    let mut d = escrow_ai.try_borrow_mut_data()?;
    for b in d.iter_mut() {
        *b = 0;
    }
    d[0] = 1;
    d[1..33].copy_from_slice(owner.as_ref());
    Ok(())
}

/// Move lamports out of the program-owned escrow PDA (direct debit/credit —
/// the only mechanism for program-owned accounts).
fn escrow_pay(escrow_ai: &AccountInfo, dest: &AccountInfo, amount: u64) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    **escrow_ai.try_borrow_mut_lamports()? = escrow_ai
        .lamports()
        .checked_sub(amount)
        .ok_or(HouseswapError::MathOverflow)?;
    **dest.try_borrow_mut_lamports()? = dest
        .lamports()
        .checked_add(amount)
        .ok_or(HouseswapError::MathOverflow)?;
    Ok(())
}

/// NOTE: there is deliberately no in-program SyncNative helper. The
/// venue's only direct lamport credit into the quote vault is the rule-2
/// resolution depth share, applied AFTER the swap's last CPI (see
/// apply_resolution); the caller's transaction syncs the vault's token
/// amount with a top-level SyncNative — the same pattern the engine's
/// ActivateHouse bundle uses for its seed credit.

// ---------- 1 Swap ----------
fn swap(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 1 + 1 + 8 + 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let dir = data[1];
    if dir > 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount_in = read_u64(data, 2);
    let min_out = read_u64(data, 10);

    let it = &mut accounts.iter();
    let pool_ai = next_account_info(it)?;
    let token_mint_ai = next_account_info(it)?;
    let quote_mint_ai = next_account_info(it)?;
    let token_vault = next_account_info(it)?;
    let quote_vault = next_account_info(it)?;
    let user_token = next_account_info(it)?;
    let user_quote = next_account_info(it)?;
    let user = next_account_info(it)?;
    let token_prog = next_account_info(it)?;
    let quote_prog = next_account_info(it)?;
    // Remaining accounts: hook tail (through the meta list), then venue extras.
    let rest: Vec<AccountInfo> = it.cloned().collect();
    let (leg_src, leg_dst) = if dir == 0 {
        (*token_vault.key, *user_token.key)
    } else {
        (*user_token.key, *token_vault.key)
    };
    let tail = scan_tail(&rest, 0, token_mint_ai.key, &leg_src, &leg_dst);
    let venue: &[AccountInfo] = &rest[tail.end..];

    let pool = load_pool(pool_ai)?;
    if *token_mint_ai.key != pool.token_mint || *quote_mint_ai.key != pool.quote_mint {
        return Err(HouseswapError::BadPool.into());
    }
    if *token_vault.key != pool.token_vault || *quote_vault.key != pool.quote_vault {
        return Err(HouseswapError::BadPool.into());
    }
    if acct_mint(user_token)? != pool.token_mint || acct_mint(user_quote)? != pool.quote_mint {
        return Err(HouseswapError::BadPool.into());
    }
    let dec_token = mint_decimals(token_mint_ai)?;
    let dec_quote = mint_decimals(quote_mint_ai)?;
    let rules = read_venue_rules(&tail, &pool.token_mint)?;
    // The system program account inside the tail (needed only when an
    // escrow PDA must be created or funded on a rule-2 buy).
    let system_ai = tail
        .infos
        .iter()
        .find(|ai| *ai.key == solana_program::system_program::id())
        .cloned();

    let reserve_token = acct_amount(token_vault)? as u128;
    let reserve_quote = acct_amount(quote_vault)? as u128;
    let bump_arr = [pool.bump];
    let pool_seeds: &[&[u8]] = &[b"pool", pool.token_mint.as_ref(), &bump_arr];

    if dir == 0 {
        // ---------------- BUY (quote in, token out) ----------------
        // Rule 2 accounting (contract SS2.3), FIXED order: amount_in is the
        // TOTAL quote the user spends. The split is carved first, the fee
        // is taken from the traded remainder, and the token out is computed
        // on (traded_in - fee). The quote vault receives traded_in (the fee
        // included — it stays in the vault and accrues to the counter); the
        // escrow PDA receives the split as native SOL.
        let split = match rules.escrow_split_bps {
            Some(bps) => ((amount_in as u128 * bps as u128) / 10_000) as u64,
            None => 0,
        };
        let traded_in = amount_in
            .checked_sub(split)
            .ok_or(HouseswapError::MathOverflow)?;
        let fee = ((traded_in as u128 * pool.fee_bps as u128) / 10_000) as u64;
        let effective = (traded_in - fee) as u128;
        let out = reserve_token
            .checked_mul(effective)
            .ok_or(HouseswapError::MathOverflow)?
            / (reserve_quote + effective);
        if out == 0 || out >= reserve_token || out < min_out as u128 {
            return Err(HouseswapError::Slippage.into());
        }
        let out = out as u64;

        // Escrow first (creation + funding), so a missing/short escrow
        // fails before any pool transfer.
        let mut escrow_st: Option<EscrowState> = None;
        if rules.escrow_split_bps.is_some() {
            let escrow_ai = venue.first().ok_or(HouseswapError::MissingEscrow)?;
            let (expect, _) = escrow_pda(&pool.token_mint, user_token.key, program_id);
            if *escrow_ai.key != expect {
                return Err(HouseswapError::BadEscrow.into());
            }
            let system = system_ai
                .as_ref()
                .ok_or(ProgramError::NotEnoughAccountKeys)?;
            let owner = acct_owner(user_token)?;
            ensure_escrow(program_id, user, escrow_ai, system, &pool.token_mint, user_token.key, &owner)?;
            if split > 0 {
                invoke(
                    &system_instruction::transfer(user.key, escrow_ai.key, split),
                    &[user.clone(), escrow_ai.clone(), system.clone()],
                )?;
            }
            let mut st = load_escrow(escrow_ai, program_id)?;
            st.escrow_lamports = st
                .escrow_lamports
                .checked_add(split)
                .ok_or(HouseswapError::MathOverflow)?;
            escrow_st = Some(st); // written back after the pool transfers
        }

        // quote in: user -> quote vault (plain leg; user signs)
        invoke(
            &transfer_ix(quote_prog.key, user_quote.key, quote_mint_ai.key, quote_vault.key, user.key, traded_in, dec_quote),
            &[user_quote.clone(), quote_mint_ai.clone(), quote_vault.clone(), user.clone()],
        )?;
        // token out: pool PDA signs; the hook fires here.
        invoke_signed(
            &transfer_hooked_ix(token_prog.key, token_vault.key, token_mint_ai.key, user_token.key, pool_ai.key, out, dec_token, &tail.metas),
            &cpi_accounts(
                &[token_vault.clone(), token_mint_ai.clone(), user_token.clone(), pool_ai.clone()],
                &tail,
            ),
            &[pool_seeds],
        )?;
        accrue_fee(pool_ai, true, fee)?;
        if let Some(st) = escrow_st {
            write_escrow(&venue[0], &st)?;
            msg!("houseswap: rule2 buy split {} escrowed (traded {}, fee {})", split, traded_in, fee);
        }
        msg!("houseswap: buy: {} quote in (total {}), {} token out", traded_in, amount_in, out);
    } else {
        // ---------------- SELL (token in, quote out) ----------------
        // Rule 2 resolution is COMPUTED first, from pre-sell state
        // (contract SS2.3): the resolved share, the dip test and the
        // 96/2/2 split are all fixed by the seller's pre-sell balance,
        // the escrow record and the cranked feed/holder as passed. The
        // lamport movements are APPLIED after the swap legs (below):
        // this runtime rejects a CPI that names an account whose
        // lamports the calling program directly modified earlier in the
        // same instruction (the same wall the engine's ActivateHouse
        // hit with its in-program SyncNative — see PHASE-C notes), so
        // the escrow's direct lamport credits must come after the last
        // CPI that names the credited accounts. Every amount is
        // identical to the contract's resolution-first order; a failed
        // swap leg reverts the whole instruction, credits included.
        let resolution = if rules.escrow_split_bps.is_some() {
            compute_resolution(program_id, &pool, &rules, venue, user_token, amount_in)?
        } else {
            None
        };
        let fee = ((amount_in as u128 * pool.fee_bps as u128) / 10_000) as u64;
        let effective = (amount_in - fee) as u128;
        let out = reserve_quote
            .checked_mul(effective)
            .ok_or(HouseswapError::MathOverflow)?
            / (reserve_token + effective);
        if out == 0 || out >= reserve_quote || out < min_out as u128 {
            return Err(HouseswapError::Slippage.into());
        }
        let out = out as u64;

        // token in: user signs; the hook fires here and GATES the exit.
        invoke(
            &transfer_hooked_ix(token_prog.key, user_token.key, token_mint_ai.key, token_vault.key, user.key, amount_in, dec_token, &tail.metas),
            &cpi_accounts(
                &[user_token.clone(), token_mint_ai.clone(), token_vault.clone(), user.clone()],
                &tail,
            ),
        )?;
        // quote out: pool PDA signs (plain leg).
        invoke_signed(
            &transfer_ix(quote_prog.key, quote_vault.key, quote_mint_ai.key, user_quote.key, pool_ai.key, out, dec_quote),
            &[quote_vault.clone(), quote_mint_ai.clone(), user_quote.clone(), pool_ai.clone()],
            &[pool_seeds],
        )?;
        // Escrow resolution movements land last (see the note above).
        if let Some(res) = resolution {
            apply_resolution(&res, venue, user, quote_vault)?;
        }
        accrue_fee(pool_ai, false, fee)?;
        msg!("houseswap: sell: {} token in, {} quote out (fee {})", amount_in, out, fee);
    }
    Ok(())
}

/// A computed rule-2 sell resolution: every lamport figure fixed from
/// pre-sell state, ready to be applied after the swap legs.
struct Resolution {
    resolved: u64,
    refund: u64,     // to the seller's wallet (dip only)
    depth: u64,      // to the pool quote vault (dip 2% + any folded treasury; forfeit: all)
    treasury: u64,   // to the fee_dest wallet (dip only; 0 when folded into depth)
    treasury_dest: Pubkey, // the fee_dest wallet key (valid when treasury > 0)
    dip: bool,
    escrow: EscrowState, // counters already updated; escrow_lamports already debited
}

/// Rule 2 sell-side escrow resolution, COMPUTE phase (contract SS2.3).
/// Everything is derived from PRE-SELL state: the seller's pre-sell token
/// balance, the escrow record, and the shared feed/holder as passed.
/// Never bricks the sell and never refunds blind: an unreadable/stale
/// feed or holder means NOT dip (the resolved share forfeits to depth).
/// The dip treasury share goes to the fee_dest WALLET (native SOL); the
/// wallet account is searched among the venue extras past the
/// escrow/feed/holder triple — if it is absent (or no fee_dest is
/// recorded on the pool), the share folds into depth instead of failing.
fn compute_resolution(
    program_id: &Pubkey,
    pool: &Pool,
    rules: &VenueRules,
    venue: &[AccountInfo],
    user_token: &AccountInfo,
    amount_in: u64,
) -> Result<Option<Resolution>, ProgramError> {
    let escrow_ai = venue.first().ok_or(HouseswapError::MissingEscrow)?;
    let (expect, _) = escrow_pda(&pool.token_mint, user_token.key, program_id);
    if *escrow_ai.key != expect {
        return Err(HouseswapError::BadEscrow.into());
    }
    let mut st = load_escrow(escrow_ai, program_id)?;
    if !st.exists || st.escrow_lamports == 0 {
        return Ok(None); // no escrow record: nothing to resolve
    }
    let pre_bal = acct_amount(user_token)?;
    if pre_bal == 0 {
        return Ok(None);
    }
    let resolved = ((st.escrow_lamports as u128 * amount_in as u128) / pre_bal as u128) as u64;
    if resolved == 0 {
        return Ok(None);
    }
    // Venue extras [1] price feed, [2] seller holder — both required when
    // a resolution is actually due; wrong keys are a malformed instruction
    // (fail closed), unreadable STATE on correct keys is the forfeit path.
    let feed_ai = venue.get(1).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let holder_ai = venue.get(2).ok_or(ProgramError::NotEnoughAccountKeys)?;
    if *feed_ai.key != engine_price_pda(&pool.token_mint)
        || *holder_ai.key != engine_holder_pda(&pool.token_mint, user_token.key)
    {
        return Err(HouseswapError::BadVenueExtra.into());
    }
    let dip = read_dip(feed_ai, holder_ai, rules.latch_max_stale);
    let (refund, mut depth, mut treasury) = if dip {
        let refund = ((resolved as u128 * 96) / 100) as u64;
        let depth = ((resolved as u128 * 2) / 100) as u64;
        (refund, depth, resolved - refund - depth) // remainder (incl. rounding) to treasury
    } else {
        (0, resolved, 0)
    };
    let mut treasury_dest = Pubkey::default();
    if treasury > 0 {
        // Treasury is payable only if the fee_dest wallet itself is among
        // the venue extras; otherwise it folds into depth (never fails).
        let payable = pool.fee_dest != Pubkey::default()
            && venue.iter().skip(3).any(|ai| ai.key == &pool.fee_dest);
        if payable {
            treasury_dest = pool.fee_dest;
        } else {
            depth = depth.checked_add(treasury).ok_or(HouseswapError::MathOverflow)?;
            treasury = 0;
        }
    }
    if dip {
        st.total_refunded = st
            .total_refunded
            .checked_add(refund)
            .ok_or(HouseswapError::MathOverflow)?;
        st.total_forfeited = st
            .total_forfeited
            .checked_add(resolved - refund)
            .ok_or(HouseswapError::MathOverflow)?;
        msg!(
            "houseswap: rule2 dip resolution: resolved {} -> refund {} depth {} treasury {}",
            resolved, refund, depth, treasury
        );
    } else {
        st.total_forfeited = st
            .total_forfeited
            .checked_add(resolved)
            .ok_or(HouseswapError::MathOverflow)?;
        msg!("houseswap: rule2 forfeit resolution: resolved {} -> depth", resolved);
    }
    st.escrow_lamports = st
        .escrow_lamports
        .checked_sub(resolved)
        .ok_or(HouseswapError::MathOverflow)?;
    Ok(Some(Resolution { resolved, refund, depth, treasury, treasury_dest, dip, escrow: st }))
}

/// Rule 2 resolution, APPLY phase: the escrow's lamport movements + the
/// record write. Runs AFTER the swap legs — see the sequencing note in
/// the sell branch (a CPI may not name an account this program already
/// credited directly). The quote vault's token amount is NOT synced
/// in-program for the same reason; the caller's transaction appends a
/// top-level SyncNative for the quote vault (INTEGRATION.md) — the same
/// shape the engine's ActivateHouse activation bundle uses.
fn apply_resolution(
    res: &Resolution,
    venue: &[AccountInfo],
    user: &AccountInfo,
    quote_vault: &AccountInfo,
) -> ProgramResult {
    let escrow_ai = venue.first().ok_or(HouseswapError::MissingEscrow)?;
    if res.dip && res.refund > 0 {
        escrow_pay(escrow_ai, user, res.refund)?;
    }
    if res.depth > 0 {
        escrow_pay(escrow_ai, quote_vault, res.depth)?;
    }
    if res.treasury > 0 {
        let dest = venue
            .iter()
            .skip(3)
            .find(|ai| ai.key == &res.treasury_dest)
            .ok_or(HouseswapError::BadFeeDest)?;
        escrow_pay(escrow_ai, dest, res.treasury)?;
    }
    write_escrow(escrow_ai, &res.escrow)?;
    Ok(())
}

/// The rule-1 dip test against the SHARED engine feed + seller holder:
/// DIP := holder exists && basis present && (latched || ema < basis).
/// Any unreadable state (missing/corrupt feed or holder, stale feed)
/// returns false — forfeit, never a blind refund.
fn read_dip(feed_ai: &AccountInfo, holder_ai: &AccountInfo, max_stale: i64) -> bool {
    let eng = engine_id();
    // Feed: engine-owned, tag 1, ema @97..113, last_crank_ts @113..121.
    let (ema, last_crank) = {
        if feed_ai.owner != &eng || feed_ai.data_len() == 0 {
            return false;
        }
        let d = match feed_ai.try_borrow_data() {
            Ok(d) => d,
            Err(_) => return false,
        };
        if d.len() < 121 || d[0] != 1 {
            return false;
        }
        (read_u128(&d, 97), read_i64(&d, 113))
    };
    if last_crank == 0 {
        return false;
    }
    let now = match Clock::get() {
        Ok(c) => c.unix_timestamp,
        Err(_) => return false,
    };
    if now.saturating_sub(last_crank) > max_stale {
        return false; // stale feed: cannot prove a dip
    }
    // Holder: engine-owned, tag 1, basis num/den @6..38, latched @38.
    if holder_ai.owner != &eng || holder_ai.data_len() == 0 {
        return false;
    }
    let d = match holder_ai.try_borrow_data() {
        Ok(d) => d,
        Err(_) => return false,
    };
    if d.len() < 39 || d[0] != 1 {
        return false;
    }
    let num = read_u128(&d, 6);
    let den = read_u128(&d, 22);
    if num == 0 || den == 0 {
        return false; // no basis recorded
    }
    let basis = num / den;
    d[38] == 1 || ema < basis
}

// ---------- 2/3 Add/RemoveLiquidity (TaxSwap verbatim; generic tail) ----------
// After CommitPool the authority is a program PDA nobody can sign for, so
// both instructions are dead — that is the lock. (Pre-commit
// RemoveLiquidity is the seed-recovery path.)
fn liquidity(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8], add: bool) -> ProgramResult {
    if data.len() < 1 + 8 + 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amt_token = read_u64(data, 1);
    let amt_quote = read_u64(data, 9);

    let it = &mut accounts.iter();
    let pool_ai = next_account_info(it)?;
    let token_mint_ai = next_account_info(it)?;
    let quote_mint_ai = next_account_info(it)?;
    let token_vault = next_account_info(it)?;
    let quote_vault = next_account_info(it)?;
    let auth_token = next_account_info(it)?;
    let auth_quote = next_account_info(it)?;
    let authority = next_account_info(it)?;
    let token_prog = next_account_info(it)?;
    let quote_prog = next_account_info(it)?;
    let rest: Vec<AccountInfo> = it.cloned().collect();
    let (leg_src, leg_dst) = if add {
        (*auth_token.key, *token_vault.key)
    } else {
        (*token_vault.key, *auth_token.key)
    };
    let tail = scan_tail(&rest, 0, token_mint_ai.key, &leg_src, &leg_dst);

    let pool = load_pool(pool_ai)?;
    if *token_mint_ai.key != pool.token_mint || *quote_mint_ai.key != pool.quote_mint {
        return Err(HouseswapError::BadPool.into());
    }
    let dec_token = mint_decimals(token_mint_ai)?;
    let dec_quote = mint_decimals(quote_mint_ai)?;
    if *authority.key != pool.authority {
        return Err(HouseswapError::Unauthorized.into());
    }
    if *token_vault.key != pool.token_vault || *quote_vault.key != pool.quote_vault {
        return Err(HouseswapError::BadPool.into());
    }
    let _ = program_id;

    let bump_arr = [pool.bump];
    let pool_seeds: &[&[u8]] = &[b"pool", pool.token_mint.as_ref(), &bump_arr];

    if add {
        if amt_token > 0 {
            invoke(
                &transfer_hooked_ix(token_prog.key, auth_token.key, token_mint_ai.key, token_vault.key, authority.key, amt_token, dec_token, &tail.metas),
                &cpi_accounts(
                    &[auth_token.clone(), token_mint_ai.clone(), token_vault.clone(), authority.clone()],
                    &tail,
                ),
            )?;
        }
        if amt_quote > 0 {
            invoke(
                &transfer_ix(quote_prog.key, auth_quote.key, quote_mint_ai.key, quote_vault.key, authority.key, amt_quote, dec_quote),
                &[auth_quote.clone(), quote_mint_ai.clone(), quote_vault.clone(), authority.clone()],
            )?;
        }
        msg!("houseswap: liquidity added {} token / {} quote", amt_token, amt_quote);
    } else {
        if amt_token > 0 {
            invoke_signed(
                &transfer_hooked_ix(token_prog.key, token_vault.key, token_mint_ai.key, auth_token.key, pool_ai.key, amt_token, dec_token, &tail.metas),
                &cpi_accounts(
                    &[token_vault.clone(), token_mint_ai.clone(), auth_token.clone(), pool_ai.clone()],
                    &tail,
                ),
                &[pool_seeds],
            )?;
        }
        if amt_quote > 0 {
            invoke_signed(
                &transfer_ix(quote_prog.key, quote_vault.key, quote_mint_ai.key, auth_quote.key, pool_ai.key, amt_quote, dec_quote),
                &[quote_vault.clone(), quote_mint_ai.clone(), auth_quote.clone(), pool_ai.clone()],
                &[pool_seeds],
            )?;
        }
        msg!("houseswap: liquidity removed {} token / {} quote", amt_token, amt_quote);
    }
    Ok(())
}

// ---------- 4 CommitPool (one-way) ----------
// [pool(w), mint, authority(signer)] — authority must equal pool.authority;
// sets authority := PDA(["poolauth", mint], this program), committed := 1.
fn commit_pool(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let pool_ai = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let authority = next_account_info(it)?;

    let pool = load_pool(pool_ai)?;
    if *mint.key != pool.token_mint {
        return Err(HouseswapError::BadPool.into());
    }
    if !authority.is_signer || *authority.key != pool.authority {
        return Err(HouseswapError::Unauthorized.into());
    }
    if pool.committed != 0 {
        return Err(HouseswapError::AlreadyCommitted.into());
    }
    let new_auth = poolauth_pda(mint.key, program_id);
    let mut d = pool_ai.try_borrow_mut_data()?;
    d[1..33].copy_from_slice(new_auth.as_ref());
    d[POOL_COMMITTED_OFF] = 1;
    msg!("houseswap: pool committed for mint {} (authority {})", mint.key, new_auth);
    Ok(())
}

// ---------- 5 ActivatePool (permissionless; fee mirror) ----------
// Accounts: [pool(w), mint, engine_config(ro), dbc_pool(ro), dbc_config(ro)]
// Data: [5][fee_bps u16]
// The fee DESTINATION is anchored on-chain: fee_dest is read from the DBC
// config account (PoolConfig fee_claimer @40..72), with the dbc_pool ->
// dbc_config linkage validated. The RATE is caller-supplied from the launch
// record (bounds 25..=9900, the DBC program's own fee bounds) and publicly
// verifiable against the DBC config's fee scheduler — see INTEGRATION.md.
fn activate_pool(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 3 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let fee_bps = read_u16(data, 1);
    if !(25..=9900).contains(&fee_bps) {
        return Err(HouseswapError::BadFeeBps.into());
    }
    let it = &mut accounts.iter();
    let pool_ai = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let engine_config = next_account_info(it)?;
    let dbc_pool = next_account_info(it)?;
    let dbc_config = next_account_info(it)?;

    let pool = load_pool(pool_ai)?;
    if *mint.key != pool.token_mint {
        return Err(HouseswapError::BadPool.into());
    }
    if pool.live != 0 {
        return Err(HouseswapError::AlreadyLive.into());
    }
    if pool.committed == 0 {
        return Err(HouseswapError::NotCommitted.into());
    }
    // Engine config: the derived Config PDA, engine-owned, house region
    // present with state == 2 (activated) naming THIS program.
    if *engine_config.key != engine_config_pda(mint.key) || engine_config.owner != &engine_id() {
        return Err(HouseswapError::BadHouseState.into());
    }
    {
        let d = engine_config.try_borrow_data()?;
        if d.len() < HOUSE_STATE_OFF + 1
            || d[0] != 1
            || d[HOUSE_STATE_OFF] != 2
            || read_key(&d, HOUSE_PROG_OFF) != *program_id
        {
            return Err(HouseswapError::BadHouseState.into());
        }
    }
    // DBC linkage: pool and config both DBC-owned; the pool's config field
    // (@72) names the config account; the pool's base_mint (@136) is ours.
    if dbc_pool.owner != &dbc_id() || dbc_config.owner != &dbc_id() {
        return Err(HouseswapError::BadDbc.into());
    }
    let fee_dest = {
        let dp = dbc_pool.try_borrow_data()?;
        if dp.len() != 424 || read_key(&dp, 136) != *mint.key || read_key(&dp, 72) != *dbc_config.key {
            return Err(HouseswapError::BadDbc.into());
        }
        let dc = dbc_config.try_borrow_data()?;
        if dc.len() < 72 {
            return Err(HouseswapError::BadDbc.into());
        }
        // PoolConfig zero_copy layout: 8-byte discriminator, quote_mint
        // @8..40, fee_claimer @40..72.
        read_key(&dc, 40)
    };
    if fee_dest == Pubkey::default() {
        return Err(HouseswapError::BadDbc.into());
    }
    let now = Clock::get()?.unix_timestamp;
    let mut d = pool_ai.try_borrow_mut_data()?;
    d[POOL_FEE_BPS_OFF..POOL_FEE_BPS_OFF + 2].copy_from_slice(&fee_bps.to_le_bytes());
    d[POOL_FEE_DEST_OFF..POOL_FEE_DEST_OFF + 32].copy_from_slice(fee_dest.as_ref());
    d[POOL_LIVE_OFF] = 1;
    d[POOL_ACTIVATED_OFF..POOL_ACTIVATED_OFF + 8].copy_from_slice(&now.to_le_bytes());
    msg!(
        "houseswap: pool live for mint {} (fee {} bps to {})",
        mint.key, fee_bps, fee_dest
    );
    Ok(())
}

// ---------- 6 ClaimFees (permissionless) ----------
// Accounts: [pool(w), token_mint, quote_mint, token_vault(w), quote_vault(w),
//           fee_dest_token(w), fee_dest_quote(w), token_prog, quote_prog,
//           HOOK TAIL...]
// Pays the accrued counters to the recorded fee_dest's accounts: the token
// leg is hook-forwarded (it succeeds or fails closed with the stack's
// rules); the wSOL leg is a plain TransferChecked. Zero counters = no-op
// success. The pool account itself is the transfer authority (invoke_signed
// with the pool seeds).
fn claim_fees(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let pool_ai = next_account_info(it)?;
    let token_mint_ai = next_account_info(it)?;
    let quote_mint_ai = next_account_info(it)?;
    let token_vault = next_account_info(it)?;
    let quote_vault = next_account_info(it)?;
    let fee_dest_token = next_account_info(it)?;
    let fee_dest_quote = next_account_info(it)?;
    let token_prog = next_account_info(it)?;
    let quote_prog = next_account_info(it)?;
    let rest: Vec<AccountInfo> = it.cloned().collect();
    let tail = scan_tail(&rest, 0, token_mint_ai.key, token_vault.key, fee_dest_token.key);

    let pool = load_pool(pool_ai)?;
    if *token_mint_ai.key != pool.token_mint || *quote_mint_ai.key != pool.quote_mint {
        return Err(HouseswapError::BadPool.into());
    }
    if *token_vault.key != pool.token_vault || *quote_vault.key != pool.quote_vault {
        return Err(HouseswapError::BadPool.into());
    }
    if pool.fee_accrued_token == 0 && pool.fee_accrued_quote == 0 {
        msg!("houseswap: claim fees: nothing accrued");
        return Ok(());
    }
    // Destinations must be the recorded fee_dest's accounts of the right mints.
    if acct_mint(fee_dest_token)? != pool.token_mint
        || acct_owner(fee_dest_token)? != pool.fee_dest
        || acct_mint(fee_dest_quote)? != pool.quote_mint
        || acct_owner(fee_dest_quote)? != pool.fee_dest
    {
        return Err(HouseswapError::BadFeeDest.into());
    }
    let dec_token = mint_decimals(token_mint_ai)?;
    let dec_quote = mint_decimals(quote_mint_ai)?;
    let bump_arr = [pool.bump];
    let pool_seeds: &[&[u8]] = &[b"pool", pool.token_mint.as_ref(), &bump_arr];

    if pool.fee_accrued_token > 0 {
        invoke_signed(
            &transfer_hooked_ix(token_prog.key, token_vault.key, token_mint_ai.key, fee_dest_token.key, pool_ai.key, pool.fee_accrued_token, dec_token, &tail.metas),
            &cpi_accounts(
                &[token_vault.clone(), token_mint_ai.clone(), fee_dest_token.clone(), pool_ai.clone()],
                &tail,
            ),
            &[pool_seeds],
        )?;
    }
    if pool.fee_accrued_quote > 0 {
        invoke_signed(
            &transfer_ix(quote_prog.key, quote_vault.key, quote_mint_ai.key, fee_dest_quote.key, pool_ai.key, pool.fee_accrued_quote, dec_quote),
            &[quote_vault.clone(), quote_mint_ai.clone(), fee_dest_quote.clone(), pool_ai.clone()],
            &[pool_seeds],
        )?;
    }
    let mut d = pool_ai.try_borrow_mut_data()?;
    d[POOL_FEE_ACC_T_OFF..POOL_FEE_ACC_T_OFF + 8].copy_from_slice(&0u64.to_le_bytes());
    d[POOL_FEE_ACC_Q_OFF..POOL_FEE_ACC_Q_OFF + 8].copy_from_slice(&0u64.to_le_bytes());
    msg!(
        "houseswap: fees claimed for mint {} ({} token, {} quote to {})",
        pool.token_mint, pool.fee_accrued_token, pool.fee_accrued_quote, pool.fee_dest
    );
    Ok(())
}

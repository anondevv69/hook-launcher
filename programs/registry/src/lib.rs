// Hook Launcher REGISTRY — Solana (native, no Anchor).
//
// Spec: SPEC-HOOK-LAUNCHER.md SS2.5. The agent-only substrate: one Registration
// PDA per wallet, created by a WALLET-SIGNED self-registration. On Solana,
// signing IS the proof of key possession — the AONLY (Base) EIP-191 signature
// flow collapses into this one transaction. Registration is open to any
// wallet; "agent-only" is enforced as "only registered wallets may receive",
// which is the rule the chain can actually keep (see spec SS2.5).
//
// Own instructions are tagged by data[0]:
//   0 = Register    { kind u8 }   wallet self-registration (signer == wallet)
//   1 = SetActive   { active u8 } wallet toggles its own registration
//   2 = Close                       wallet closes its PDA, rent returns to it
//   3 = InitEcosystemConfig         one-time: create the Ecosystem Config PDA;
//                                   the signer becomes its authority
//   4 = SetAttester { eco u8, attester pubkey }   (config authority only)
//   5 = RegisterAttested { kind u8, eco u8 }      wallet + the ecosystem's
//                                   attester co-sign; creates the registration
//                                   WITH an ecosystem tag
//   6 = AttestExisting { eco u8 }   wallet + attester co-sign; writes the
//                                   ecosystem tag onto an existing active
//                                   self-registration
//   7 = TransferEcosystemAuthority { new authority pubkey } (authority only)
//
// Registration PDA: seeds ["registration", wallet], REGISTRATION_SPACE bytes:
//   [0]        tag u8 = 1
//   [1..33]    wallet pubkey
//   [33]       kind u8 (KIND_HUMAN = 0, KIND_AGENT = 1)
//   [34]       verified_via u8 (0 = self-signed; 1 = ecosystem-attested)
//   [35..43]   registered_at i64 (unix timestamp at first registration)
//   [43]       active u8 (1 = active)
//   [44]       ecosystem u8 (ECOSYSTEM_*; 0 = none/open — the only value a
//              self-registration can ever carry; nonzero values are written
//              ONLY by tags 5/6 under an attester's signature)
//   [45..48]   reserved (zeros)
//
// ECOSYSTEM ATTESTATION (v2). An ecosystem tag is a claim about PROVENANCE:
// "this wallet was created through platform X's flow, and X attests it."
// A wallet cannot make that claim about itself — tags are written only when
// the ecosystem's attester key co-signs, and the attester map lives in the
// Ecosystem Config PDA (seeds ["ecosystem"]), governed by a registry
// authority (in practice the registry's upgrade authority holder, who
// initializes it immediately after a program upgrade). Setting or rotating
// an attester is the authority's act; an attester can be cleared (zero
// pubkey), which closes that ecosystem's attestation path until reset.
// Attestation — self-service boundary: tags 5/6 never bypass the wallet's
// own signature; the wallet consents with its key, the attester vouches
// with theirs. Nobody — authority included — can tag a wallet without BOTH.
//
// AUTHORITY DECISION: a wallet's own record is self-service only. A wallet
// controls exactly its own registration (register / set_active / close), and
// no instruction — the ecosystem authority's included — can create-free,
// deactivate, or close another wallet's record. The v2 ecosystem config is
// deliberately NARROWER than a general admin surface: the authority manages
// only the attester map (which keys may vouch for which ecosystem). Tagging
// a wallet still requires the wallet's own signature (tags 5/6), so the
// authority cannot tag anyone unilaterally either. The registry's security
// promise is unchanged: "registration == key possession, state == the
// wallet's own word" — v2 adds "provenance claims == an attester's word,
// given at the wallet's creation flow and with the wallet's consent."
//
// ENGINE READ CONTRACT (summary; full contract in INTEGRATION.md): the
// engine's Agent-Only module (rule 3) validates the Registration PDA as a
// resolved extra account — it does NOT read a cached flag. Freshness matters:
// set_active(false) must invalidate a wallet on the very next transfer, and a
// cached byte in the engine's Holder PDA can only be invalidated by touching
// every Holder PDA of every mint that wallet ever held (impossible), or by a
// cross-program write the registry cannot perform (programs cannot write
// accounts they do not own; the engine's Holder PDAs are engine-owned).

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

pub const REGISTRATION_SPACE: usize = 48;
pub const KIND_HUMAN: u8 = 0;
pub const KIND_AGENT: u8 = 1;
/// verified_via values. SELF_SIGNED is written by tag 0 (Register);
/// ATTESTED is written only by tags 5/6, under an attester's signature.
pub const VIA_SELF_SIGNED: u8 = 0;
pub const VIA_ATTESTED: u8 = 1;

/// Ecosystem tags (Registration PDA byte 44). 0 = none/open (plain
/// self-registration). Named ecosystems are attester-gated; the id space
/// runs to MAX_ECOSYSTEM so new ecosystems are a config entry, never a
/// program change.
pub const ECO_NONE: u8 = 0;
pub const ECO_MUSE: u8 = 1;
pub const ECO_FOMO: u8 = 2;
pub const ECO_CLAUDE: u8 = 3;
pub const ECO_GROK: u8 = 4;
pub const MAX_ECOSYSTEM: u8 = 16;

/// Ecosystem Config PDA: seeds ["ecosystem"]. Layout:
///   [0]        tag u8 = 1
///   [1..33]    authority pubkey (manages the attester map)
///   [33..]     attester map: MAX_ECOSYSTEM slots x 32B, slot i holds the
///              attester pubkey for ecosystem i+1; all-zero = unset/cleared.
pub const ECO_CONFIG_SPACE: usize = 33 + (MAX_ECOSYSTEM as usize) * 32;

#[derive(Debug)]
enum RegistryError {
    AlreadyRegistered = 1, // register on an existing Registration PDA
    NotRegistered = 2,     // set_active/close on a missing or foreign PDA
    BadState = 3,          // account foreign-owned, wrong size, or bad tag
    BadKind = 4,           // kind byte outside the known set
    BadEcosystem = 5,      // ecosystem byte outside 1..=MAX_ECOSYSTEM
    NotAttester = 6,       // signer is not the ecosystem's configured attester
    BadAuthority = 7,      // signer is not the Ecosystem Config authority
    AlreadyInit = 8,       // Ecosystem Config already initialized
    EcosystemNotConfigured = 9, // Ecosystem Config PDA missing/uninitialized
}

impl From<RegistryError> for ProgramError {
    fn from(e: RegistryError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

entrypoint!(process_instruction);

// ---------- byte helpers ----------
fn read_key(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}

pub fn registration_pda(wallet: &Pubkey, program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"registration", wallet.as_ref()], program_id).0
}

pub fn eco_config_pda(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"ecosystem"], program_id).0
}

fn valid_ecosystem(eco: u8) -> Result<u8, ProgramError> {
    if eco == ECO_NONE || eco > MAX_ECOSYSTEM {
        return Err(RegistryError::BadEcosystem.into());
    }
    Ok(eco)
}

/// Structural validation of the Ecosystem Config account, returning the
/// configured attester for `eco` (Pubkey::default() when unset). Key and
/// ownership are checked against THIS program; a missing account is the
/// dedicated EcosystemNotConfigured error, never a silent "no attester".
fn load_eco_attester(
    ai: &AccountInfo,
    program_id: &Pubkey,
    eco: u8,
) -> Result<Pubkey, ProgramError> {
    if *ai.key != eco_config_pda(program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if ai.data_len() == 0 {
        return Err(RegistryError::EcosystemNotConfigured.into());
    }
    if ai.owner != program_id {
        return Err(RegistryError::BadState.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < ECO_CONFIG_SPACE || d[0] != 1 {
        return Err(RegistryError::BadState.into());
    }
    let off = 33 + (eco as usize - 1) * 32;
    Ok(read_key(&d, off))
}

/// The attestation gate shared by tags 5/6: the presented attester account
/// must be a signer AND exactly the key the Ecosystem Config names for this
/// ecosystem. A cleared (zero) attester entry can never match: no account
/// can sign as the zero pubkey, and we reject it explicitly regardless.
fn require_attester(
    attester: &AccountInfo,
    eco_cfg: &AccountInfo,
    eco: u8,
    program_id: &Pubkey,
) -> ProgramResult {
    let configured = load_eco_attester(eco_cfg, program_id, eco)?;
    if configured == Pubkey::default() || *attester.key != configured || !attester.is_signer {
        msg!("registry: attester check failed for ecosystem {}", eco);
        return Err(RegistryError::NotAttester.into());
    }
    Ok(())
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

/// Structural validation shared by set_active / close: the passed account must
/// be THE Registration PDA for `wallet`, owned by this program, initialized,
/// and naming `wallet` in its wallet field. Returns `active`.
fn load_registration(
    ai: &AccountInfo,
    wallet: &Pubkey,
    program_id: &Pubkey,
) -> Result<bool, ProgramError> {
    if *ai.key != registration_pda(wallet, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if ai.data_len() == 0 {
        return Err(RegistryError::NotRegistered.into());
    }
    if ai.owner != program_id {
        return Err(RegistryError::BadState.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < REGISTRATION_SPACE || d[0] != 1 || read_key(&d, 1) != *wallet {
        return Err(RegistryError::BadState.into());
    }
    Ok(d[43] == 1)
}

// ---------- dispatch ----------
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match data.first() {
        Some(0) => register(program_id, accounts, data),
        Some(1) => set_active(program_id, accounts, data),
        Some(2) => close(program_id, accounts),
        Some(3) => init_ecosystem_config(program_id, accounts),
        Some(4) => set_attester(program_id, accounts, data),
        Some(5) => register_attested(program_id, accounts, data),
        Some(6) => attest_existing(program_id, accounts, data),
        Some(7) => transfer_ecosystem_authority(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ---------- Register ----------
// Accounts: [wallet(signer,w), registration_pda(w), system]
// Data: [0][kind u8]
// The PDA is derived from the SIGNER's key, so registering "for" another
// wallet is impossible by construction: a registration account derived for
// any other wallet fails the seed check.
fn register(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let wallet = next_account_info(it)?;
    let reg_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    if !wallet.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let kind = parse_kind(data, 1)?;
    if *reg_ai.key != registration_pda(wallet.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if reg_ai.data_len() > 0 {
        msg!("registry: already registered: {}", wallet.key);
        return Err(RegistryError::AlreadyRegistered.into());
    }
    // NOTE: Register has no ecosystem parameter and can never write one:
    // extra data bytes are ignored and byte 44 is written ECO_NONE by
    // construction. A self-"tagged" registration is therefore impossible,
    // not merely rejected (see tags 5/6 for the attested paths).
    create_and_write_registration(
        program_id,
        wallet,
        reg_ai,
        system,
        kind,
        VIA_SELF_SIGNED,
        ECO_NONE,
    )?;
    msg!("registry: registered {} (kind {})", wallet.key, kind);
    Ok(())
}
fn parse_kind(data: &[u8], off: usize) -> Result<u8, ProgramError> {
    match data.get(off).copied() {
        Some(k @ KIND_HUMAN) | Some(k @ KIND_AGENT) => Ok(k),
        _ => Err(RegistryError::BadKind.into()),
    }
}

/// Create the Registration PDA and write a full fresh record. `eco` is
/// ECO_NONE for self-registration and the attested ecosystem otherwise —
/// this is the ONLY function that ever writes byte 44, and its attested
/// call sites are gated by require_attester before reaching here.
fn create_and_write_registration<'a>(
    program_id: &Pubkey,
    wallet: &AccountInfo<'a>,
    reg_ai: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    kind: u8,
    via: u8,
    eco: u8,
) -> ProgramResult {
    create_pda(
        program_id,
        wallet,
        reg_ai,
        system,
        &[b"registration", wallet.key.as_ref()],
        REGISTRATION_SPACE,
    )?;
    let ts = Clock::get()?.unix_timestamp;
    let mut d = reg_ai.try_borrow_mut_data()?;
    for b in d.iter_mut() {
        *b = 0;
    }
    d[0] = 1;
    d[1..33].copy_from_slice(wallet.key.as_ref());
    d[33] = kind;
    d[34] = via;
    d[35..43].copy_from_slice(&ts.to_le_bytes());
    d[43] = 1;
    d[44] = eco;
    Ok(())
}

// ---------- SetActive ----------
// Accounts: [wallet(signer), registration_pda(w)]
// Data: [1][active u8]  — any nonzero is stored as 1.
fn set_active(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let wallet = next_account_info(it)?;
    let reg_ai = next_account_info(it)?;

    if !wallet.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let _ = load_registration(reg_ai, wallet.key, program_id)?;
    let active = data.get(1).copied().unwrap_or(0) != 0;
    let mut d = reg_ai.try_borrow_mut_data()?;
    d[43] = if active { 1 } else { 0 };
    msg!("registry: active={} for {}", active as u8, wallet.key);
    Ok(())
}

// ---------- Close ----------
// Accounts: [wallet(signer,w), registration_pda(w)]
// Standard native close: drain lamports to the wallet, assign to the system
// program, shrink to zero. Re-registration starts from a clean slate.
fn close(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let wallet = next_account_info(it)?;
    let reg_ai = next_account_info(it)?;

    if !wallet.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let _ = load_registration(reg_ai, wallet.key, program_id)?;
    let lamports = reg_ai.lamports();
    **reg_ai.try_borrow_mut_lamports()? = 0;
    **wallet.try_borrow_mut_lamports()? = wallet
        .lamports()
        .checked_add(lamports)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    reg_ai.assign(&solana_program::system_program::id());
    reg_ai.realloc(0, false)?;
    msg!("registry: closed registration for {}", wallet.key);
    Ok(())
}

// ---------- InitEcosystemConfig ----------
// Accounts: [authority(signer,w), eco_config_pda(w), system]
// Data: [3]
// One-time. The signer becomes the attester-map authority. Operationally
// this must be the registry upgrade authority holder, run immediately
// after the v2 upgrade lands (see SPEC-ECOSYSTEM-GATE.md): the program
// takes the authority from the init signature because a native program
// has no cheaper trustworthy source for it, and the upgrade runbook is
// what binds the two keys together.
fn init_ecosystem_config(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let cfg_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *cfg_ai.key != eco_config_pda(program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if cfg_ai.data_len() > 0 {
        msg!("registry: ecosystem config already initialized");
        return Err(RegistryError::AlreadyInit.into());
    }
    create_pda(
        program_id,
        authority,
        cfg_ai,
        system,
        &[b"ecosystem"],
        ECO_CONFIG_SPACE,
    )?;
    let mut d = cfg_ai.try_borrow_mut_data()?;
    for b in d.iter_mut() {
        *b = 0;
    }
    d[0] = 1;
    d[1..33].copy_from_slice(authority.key.as_ref());
    msg!("registry: ecosystem config initialized (authority {})", authority.key);
    Ok(())
}

/// Load the Ecosystem Config for an AUTHORITY-gated write: account must be
/// the config PDA, initialized, owned by this program; returns authority.
fn load_eco_authority(ai: &AccountInfo, program_id: &Pubkey) -> Result<Pubkey, ProgramError> {
    if *ai.key != eco_config_pda(program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    if ai.data_len() == 0 {
        return Err(RegistryError::EcosystemNotConfigured.into());
    }
    if ai.owner != program_id {
        return Err(RegistryError::BadState.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() < ECO_CONFIG_SPACE || d[0] != 1 {
        return Err(RegistryError::BadState.into());
    }
    Ok(read_key(&d, 1))
}

fn require_eco_authority(
    signer: &AccountInfo,
    cfg_ai: &AccountInfo,
    program_id: &Pubkey,
) -> ProgramResult {
    let authority = load_eco_authority(cfg_ai, program_id)?;
    if !signer.is_signer || *signer.key != authority {
        msg!("registry: signer is not the ecosystem authority");
        return Err(RegistryError::BadAuthority.into());
    }
    Ok(())
}

// ---------- SetAttester ----------
// Accounts: [authority(signer), eco_config_pda(w)]
// Data: [4][eco u8][attester pubkey 32]
// Sets or rotates the attester for an ecosystem; an all-zero pubkey clears
// the entry (attestation path closed for that ecosystem until reset).
// Rotation does NOT un-attest past registrations: a tag names the
// ecosystem, and the ecosystem vouched when its then-current key signed.
fn set_attester(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let cfg_ai = next_account_info(it)?;

    if data.len() < 2 + 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let eco = valid_ecosystem(data[1])?;
    let attester = read_key(data, 2);
    require_eco_authority(authority, cfg_ai, program_id)?;
    let off = 33 + (eco as usize - 1) * 32;
    let mut d = cfg_ai.try_borrow_mut_data()?;
    d[off..off + 32].copy_from_slice(attester.as_ref());
    msg!("registry: attester for ecosystem {} set to {}", eco, attester);
    Ok(())
}

// ---------- RegisterAttested ----------
// Accounts: [wallet(signer,w), attester(signer), registration_pda(w),
//            eco_config(ro), system]
// Data: [5][kind u8][eco u8]
// The creation-flow registration: the wallet is created through the
// ecosystem's flow, the ecosystem's attester co-signs, and the record is
// born tagged. Both signatures are required — key possession from the
// wallet, provenance from the attester.
fn register_attested(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let wallet = next_account_info(it)?;
    let attester = next_account_info(it)?;
    let reg_ai = next_account_info(it)?;
    let eco_cfg = next_account_info(it)?;
    let system = next_account_info(it)?;

    if !wallet.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let kind = parse_kind(data, 1)?;
    let eco = valid_ecosystem(*data.get(2).ok_or(ProgramError::InvalidInstructionData)?)?;
    if *reg_ai.key != registration_pda(wallet.key, program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    require_attester(attester, eco_cfg, eco, program_id)?;
    if reg_ai.data_len() > 0 {
        msg!("registry: already registered: {}", wallet.key);
        return Err(RegistryError::AlreadyRegistered.into());
    }
    create_and_write_registration(
        program_id,
        wallet,
        reg_ai,
        system,
        kind,
        VIA_ATTESTED,
        eco,
    )?;
    msg!("registry: registered {} (kind {}, ecosystem {})", wallet.key, kind, eco);
    Ok(())
}

// ---------- AttestExisting ----------
// Accounts: [wallet(signer), attester(signer), registration_pda(w),
//            eco_config(ro)]
// Data: [6][eco u8]
// Writes the ecosystem tag onto an existing ACTIVE self-registration
// (kind and registered_at are preserved; verified_via becomes ATTESTED).
// The alternative — close + RegisterAttested — would burn the wallet's
// registration history and any state keyed to its continuity, so the tag
// attaches in place, under the same dual-signature rule as tag 5.
fn attest_existing(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let wallet = next_account_info(it)?;
    let attester = next_account_info(it)?;
    let reg_ai = next_account_info(it)?;
    let eco_cfg = next_account_info(it)?;

    if !wallet.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let eco = valid_ecosystem(*data.get(1).ok_or(ProgramError::InvalidInstructionData)?)?;
    let active = load_registration(reg_ai, wallet.key, program_id)?;
    if !active {
        msg!("registry: cannot attest a deactivated registration");
        return Err(RegistryError::BadState.into());
    }
    require_attester(attester, eco_cfg, eco, program_id)?;
    let mut d = reg_ai.try_borrow_mut_data()?;
    d[34] = VIA_ATTESTED;
    d[44] = eco;
    msg!("registry: attested {} for ecosystem {}", wallet.key, eco);
    Ok(())
}

// ---------- TransferEcosystemAuthority ----------
// Accounts: [authority(signer), eco_config_pda(w)]
// Data: [7][new authority pubkey 32]
// Hands the attester-map authority to another key (e.g. from the deploy
// wallet to a dedicated ops key or a multisig). Touches nothing else.
fn transfer_ecosystem_authority(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let cfg_ai = next_account_info(it)?;

    if data.len() < 1 + 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let new_authority = read_key(data, 1);
    require_eco_authority(authority, cfg_ai, program_id)?;
    let mut d = cfg_ai.try_borrow_mut_data()?;
    d[1..33].copy_from_slice(new_authority.as_ref());
    msg!("registry: ecosystem authority transferred to {}", new_authority);
    Ok(())
}

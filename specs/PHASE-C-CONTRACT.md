# PHASE C — INTERFACE CONTRACT (coordinator-issued, binding on all workers)

Phase C = house venue activation + rule 2 (Escrow Split, venue-side).
Gregory locked the plan 2026-10-19 and the 7 house answers (fee-accumulation
seed + optional reserve; permissionless on-chain-checked trigger with caller
cut; house = commitment; deeper-venue-wins feed; doors default to house pool,
curve legacy; own `graduationThresholdSol`; house fee mirrors the curve's
creator fee bps + destination). This contract fixes every cross-program
layout, tag, and account order so the three workstreams (engine / house
swap / launcher) compose without renegotiation. If a worker hits a point
this contract does not answer, STOP that piece, note it in your report,
and continue with the rest — do not invent semantics.

LOCAL BUILD ONLY. No mainnet, no deploys, no launches, no funds.

## 0. Ground rules inherited from Phases A/B

- ENGINE_VERSION stays 2. Config/Holder layouts change ONLY by the
  length-versioning pattern already used twice (Holder 136→192→224):
  new regions append past the old size; old-size accounts load and
  behave byte-identically.
- `required_extras` does NOT change in Phase C. Rule 2 needs no extras
  (Execute is a no-op for it; the venue reads the Config PDA as one of
  its own instruction accounts). Meta lists of all live configs stay
  byte-identical; the v4 rehearsal must re-pass 106/106.
- Flavor builds: source ends with MAINNET consts; trial flavor swaps
  REGISTRY_ID + DISTRIBUTOR_ID to the dev ids (see phase-b record §1
  table), builds `engine/target/engine-trial.so`, copies it to the
  resting slot `engine/target/deploy/engine.so`, restores mainnet
  consts, builds `engine/target/engine-mainnet.so`.
- Every suite from the Phase B battery (§7 of BUILD-RECORD-PHASE-B.md)
  must re-run at its EXACT baseline count. The two known pre-existing
  failures + the undiagnosed Playwright render item are not yours to
  chase and must not change.
- Paraphrase any competitor/copyrighted material (≤50 words quoted).

## 1. Engine changes (worker A owns engine/)

### 1.1 Config house region (length-versioned)

CONFIG_SPACE stays 1088. New: CONFIG_SPACE_V2 = 1152. The house region
exists only on 1152-byte configs:

| offset | field | type |
|---|---|---|
| [1088..1120] | house_program | pubkey (pre-committed venue program) |
| [1120..1128] | house_threshold_lamports | u64 (graduationThresholdSol in lamports) |
| [1128..1136] | house_reserve_lamports | u64 (committed optional reserve; 0 = none) |
| [1136..1144] | house_activated_ts | i64 (0 until activation) |
| [1144] | house_state | u8: 1 = pending, 2 = activated |
| [1145..1152] | reserved | zeros |

`load_config` gains `house: Option<HouseSlot>` — Some iff
`data_len >= CONFIG_SPACE_V2 && house_state != 0`. All other config
reads/writes are untouched. `write_config` writes the static house
fields (program/threshold/reserve) from the payload; activation state
+ ts are NEVER written by write_config — the UpdateConfig path reads
the stored state/ts before its zeroing pass and restores them after
(same discipline as created_slot).

### 1.2 Payload house block (parse_config_payload + launcher encoder)

Appended AFTER the fee tail, ONLY for house-committed configs:
`[1u8][program 32][threshold u64][reserve u64]` = 49 bytes. Absent =
no commitment. Trailing bytes that are not exactly this block =
InvalidInstructionData. Non-house payloads stay byte-identical to
Phase B (trial-graduation L3 baselines C2/C4 must not move).

Validation at parse (fail closed):
- program != zero, program != the engine's own id.
- threshold > 0.
- If an ENABLED rule 2 entry exists, a house block MUST be present
  (rule 2 without a house commitment is rejected at write —
  InvalidInstructionData with a msg naming the reason).
- InitializeConfig creates the account at CONFIG_SPACE_V2 iff the
  block is present, else CONFIG_SPACE; writes the region with
  house_state = 1.
- UpdateConfig: stored-absent + payload-present → reject;
  stored-present + payload-absent → reject; stored-present +
  payload-present must match program/threshold/reserve exactly
  (any difference → reject). The commitment is init-only and
  immutable thereafter under every authority mode.

### 1.3 HouseVault PDA (engine-owned money account)

Seeds `["housevault", mint]`, HOUSEVAULT_SPACE = 128, created by
InitializeConfig iff the payload carries a house block (config payer
funds it), in the same instruction:

| offset | field |
|---|---|
| [0] | tag = 1 |
| [1..9] | reserve_balance u64 (accounting mirror of committed-reserve deposits) |
| [9..17] | fee_balance u64 (accounting mirror of fee deposits) |
| [17..25] | cut_paid_total u64 |
| [25..33] | seeded_total u64 |
| [33..128] | reserved |

Lamport invariant: `vault.lamports == rent_min(128) + reserve_balance
+ fee_balance` at all times after init. The committed reserve itself
arrives as a plain SOL transfer from the launcher (launch step H6)
followed by tag 17 (below) recording it — no: see tag 16/17 final
form:

- **Tag 16 DepositHouseFees** — accounts: [payer(signer,w), mint,
  config(ro), house_vault(w), system]. Data: [16][amount u64]. House
  slot must exist and state == 1 (pending); post-activation deposits
  reject AlreadyInit (the seed is one-shot; later fees route
  normally). The instruction performs the system transfer
  payer→vault itself (payer signs), then fee_balance += amount.
- **Tag 17 RecordHouseReserve** — accounts: [authority(signer), mint,
  config(ro), house_vault(w)]. Data: [17]. Authority must equal
  cfg.authority. Sets reserve_balance := house_reserve_lamports from
  the slot, AFTER verifying `vault.lamports - rent_min(128) -
  fee_balance >= house_reserve_lamports` (the launcher's plain
  transfer must have landed first). One-way: a second call with
  reserve_balance already == commitment is a no-op success; a call
  when the balance check fails rejects HouseNotReady (33). (Locked
  configs: the authority is the launcher wallet — it can sign; this
  is bookkeeping, not a rule change.)

### 1.4 ActivateHouse (tag 14) — the commitment flip

Accounts: [caller(signer), mint(ro), config(w), dbc_pool(ro),
house_vault(w), house_pool(ro), house_token_vault(ro),
house_quote_vault(ro), system(ro), token_program(ro — the LEGACY
token program, for SyncNative)].

New errors: **33 HouseNotReady** (graduation/seed condition unmet),
**34 HouseNotCommitted** (no slot, wrong program, pool not
committed). Double activation rejects AlreadyInit (14).

Checks, in order:
1. config key == Config PDA, cfg.mint == mint; slot present
   (else 34); state == 1 (state 2 → AlreadyInit).
2. house_pool.key == PDA(["pool", mint], slot.house_program);
   house_pool.owner == slot.house_program; data len >= 264;
   byte[0] == 1; mint field @33 == mint; committed byte @162 == 1
   (else 34).
3. token_vault.key == pool bytes @97..129; quote_vault.key ==
   pool bytes @129..161; token_vault is a token account of mint
   owned by house_pool.key; quote_vault is a token account of the
   native mint (So11111111111111111111111111111111111111112) owned
   by house_pool.key (else BadState 10).
4. dbc_pool: owner == DBC program, len == 424, base_mint @136 ==
   mint (else PriceFeedBad 18 — tag 8's precedent).
5. Condition: quote_reserve u64 @240 of dbc_pool >=
   slot.house_threshold_lamports (else 33).
6. Seed/vault: house_vault key == PDA(["housevault", mint],
   engine); owner == engine; tag == 1; lamport invariant holds
   (else BadState). If slot.house_reserve > 0: reserve_balance >=
   slot.house_reserve (else 33). If slot.house_reserve == 0:
   fee_balance > 0 (else 33).
7. Capacity: venue_count < MAX_VENUES and exemption_count + 2 <=
   MAX_EXEMPTIONS (else BadState).
8. Effects (direct field writes into the config account — never a
   full rewrite):
   - caller cut = fee_balance * 100 / 10_000 (HOUSE_CALLER_CUT_BPS
     = 100, an engine const), paid vault→caller (invoke_signed
     with the vault's seeds).
   - seed = reserve_balance + fee_balance − cut, transferred
     vault→house_quote_vault (invoke_signed), then a SyncNative
     CPI to the legacy token program for the quote vault.
   - vault: seeded_total += seed; cut_paid_total += cut;
     reserve_balance = 0; fee_balance = 0.
   - config: venues += slot.house_program; exemptions +=
     token_vault.key, quote_vault.key; house_state = 2;
     house_activated_ts = Clock now.
   - msg! the activation (mint, threshold, seed, cut).

### 1.5 CrankPriceDeep (tag 15) — deeper-venue-wins

Accounts: [config(ro), price_feed(w), dbc_pool(ro), house_pool(ro)].

- Validates the DBC pool exactly as tag 8 (owner/len/base_mint,
  else PriceFeedBad). Curve depth = quote_reserve @240; curve spot
  = tag 8's decomposed sqrt math (reuse the code path — factor a
  helper if clean, duplicate if not; behavior must be identical).
- House source: requires a house slot (absent → PriceFeedBad).
  house_pool validated as in 1.4 step 2 (address/owner/tag/mint;
  committed byte required). House vaults read from pool bytes
  @97/@129; the house_pool account list carries ONLY the pool —
  its vault accounts are NOT passed, so depth/spot read the vault
  ADDRESSES from the pool record and their balances from... the
  vault accounts are not in the account list. THEREFORE: tag 15
  takes 6 accounts: [config(ro), price_feed(w), dbc_pool(ro),
  house_pool(ro), house_token_vault(ro), house_quote_vault(ro)],
  validated against the pool record exactly as in 1.4 step 3.
  House depth = quote vault amount − pool fee_accrued_quote
  (@202..210 of the pool record; saturating). House spot = the
  tag-5 vault-ratio math over (token vault amount, quote vault
  amount) with the feed's decimals.
- If slot.house_state != 2, house depth counts as 0 (pre-activation
  the house is not a venue; the feed stays on the curve).
- Winner = larger depth; ties stay with the CURRENT pin (no
  flapping). If the winner's (pool, token_vault, quote_vault)
  differ from the feed's pinned triple, REPIN the feed fields
  [1..97] to the winner's. Then fold the winner's spot through
  ema_params/ema_fold/write_crank exactly as tags 5/8.
- msg! both depths, both spots, the winner, and whether a repin
  happened — the choice must be visible in logs.

### 1.6 Rule 2 (Escrow Split) — engine side

- `rule_implemented()` gains RULE_ESCROW_SPLIT (gen-rules then
  flows it to the composer automatically).
- parse validation (enabled): split_bps = u16 @ params[0..2],
  1..=10000; params[2..64] all zero; plus the 1.2 cross-check
  (house block required).
- Execute: explicit no-op arm with the venue-side comment (Phase B
  pattern for 5/6/14/16).
- required_extras: unchanged (rule 2 contributes nothing).

## 2. House swap program (worker B owns houseswap/)

New program dir `houseswap/` (crown-sol Cargo pattern; fresh
keypair `houseswap-keypair.json`, mode 600; program id = that
keypair's pubkey — the TRIAL/DEV id; the deploy sheet notes mainnet
gets a fresh keypair and launch.mjs's const is set at the window).
Generalizes ~/workspace/taxhook/swap (TaxSwap): the first 168 bytes
of the Pool account are BYTE-IDENTICAL to TaxSwap's layout.

Constants the program hardcodes: ENGINE_ID =
EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT (same in both engine
flavors — trials load the trial engine AT this id), TOKEN_2022_ID,
legacy TOKEN_ID, NATIVE_MINT.

### 2.1 Pool account — PDA ["pool", mint], POOL_SIZE = 264

| offset | field |
|---|---|
| [0] | tag = 1 |
| [1..33] | authority |
| [33..65] | token_mint |
| [65..97] | quote_mint (= native mint) |
| [97..129] | token_vault |
| [129..161] | quote_vault |
| [161] | bump |
| [162] | committed u8 (0/1) — engine tag 14 reads this byte |
| [163] | live u8 (0/1 — fee mirror written) |
| [164..168] | reserved |
| [168..170] | fee_bps u16 (mirrored curve creator fee) |
| [170..202] | fee_dest pubkey |
| [202..210] | fee_accrued_quote u64 — engine tag 15 reads this |
| [210..218] | fee_accrued_token u64 |
| [218..226] | activated_ts i64 |
| [226..264] | reserved |

### 2.2 Instructions

- **0 InitPool** — TaxSwap account list + checks verbatim (vaults
  must be token accounts of the right mints owned by the pool PDA);
  writes the 168-byte prefix + zeroes the rest; authority = payer.
- **1 Swap** — TaxSwap shape and account order (pool, token_mint,
  quote_mint, token_vault, quote_vault, user_token, user_quote,
  user(signer), token_prog, quote_prog, HOOK TAIL: meta_list,
  hook_config, hook_price, src_holder, dst_holder, rent_vault,
  system, ix_sysvar, hook_program) — the tail carries the ENGINE's
  templated extras in the mint's published meta-list order, exactly
  as TaxSwap forwards its tail (for engine stacks the tail is:
  config, holders..., rent vault, price feed, system, sysvar —
  worker B reads the mint's meta list order from the trial config
  it builds; the venue forwards whatever tail accounts it is
  given, in given order, appending hook program + meta list per
  the SPL resolver layout — TaxSwap's transfer_hooked_ix tail
  discipline). Then VENUE-EXTRA accounts (consumed by the venue
  itself, NEVER forwarded into the transfer CPI):
  [escrow_pda(w) OPTIONAL, fee_dest_quote_acct(w) OPTIONAL,
  fee_dest_token_acct(w) OPTIONAL] — presence rules in 2.3/2.4.
  Constant-product math on vault balances: FEE FIRST: fee =
  amount_in * fee_bps / 10_000 (0 until live); effective_in =
  amount_in − fee; out = reserve_out * effective_in /
  (reserve_in + effective_in) (u128, checked; out == 0 or >=
  reserve_out or < min_out → Slippage). NOTE the deliberate
  deviation from TaxSwap: no hardcoded 30 bps 9970/10000 factor
  — the house fee IS fee_bps, recorded at activation; before
  live, fee_bps = 0 and the swap is fee-free. The fee stays in
  the input-side vault (reserves grow) and accrues to the
  counters (buy: fee_accrued_quote += fee; sell:
  fee_accrued_token += fee).
- **2 AddLiquidity / 3 RemoveLiquidity** — TaxSwap verbatim
  (authority-signed; token leg hook-forwarded). After CommitPool
  the authority is a program PDA nobody can sign for, so both
  are dead — that is the lock. (Pre-commit RemoveLiquidity is the
  seed-recovery path.)
- **4 CommitPool** — authority(signer) must equal pool.authority
  and committed == 0; sets authority := PDA(["poolauth", mint],
  this program), committed := 1. One-way.
- **5 ActivatePool** — permissionless. Accounts: [pool(w), mint,
  engine_config(ro), dbc_pool(ro), dbc_config(ro)]. Data:
  [5][fee_bps u16]. Validates: engine_config is the engine Config
  PDA (derive with ENGINE_ID), owner == ENGINE_ID, house region
  present, house_state == 2, house_program == this program;
  pool.committed == 1 and pool.live == 0 (second call rejects);
  dbc_pool is the pool the DBC config belongs to: dbc_pool owner
  == DBC_ID (dbcj…), len 424, base_mint @136 == mint, and
  dbc_pool's config field @72 == dbc_config.key; dbc_config owner
  == DBC_ID. fee_dest := dbc_config bytes @40..72 (the PoolConfig
  fee_claimer — zero_copy layout: 8-byte discriminator, quote_mint
  @8..40, fee_claimer @40..72). fee_bps from data, bounds
  25..=9900 (the DBC program's own bounds; 0 is rejected — a
  mirror of "no fee" is expressed by the launch's feeBps floor of
  25). Writes fee_bps, fee_dest, live := 1, activated_ts := now.
  The DESTINATION is anchored on-chain (a griefer cannot divert
  it); the RATE is caller-supplied from the launch record and
  publicly verifiable against the DBC config's fee scheduler —
  stated plainly in INTEGRATION.md.
- **6 ClaimFees** — permissionless. Accounts: [pool(w),
  token_mint, quote_mint, token_vault(w), quote_vault(w),
  fee_dest_token(w), fee_dest_quote(w), pool PDA as authority
  (the pool account itself signs), token_prog, quote_prog, HOOK
  TAIL (same tail discipline as Swap)]. Pays fee_accrued_token
  (token leg, hook-forwarded TransferChecked from token_vault to
  fee_dest_token — succeeds or fails closed with the stack's
  rules, documented) and fee_accrued_quote (wSOL leg, plain
  TransferChecked) to the recorded fee_dest's accounts; zeroes
  the counters it paid. Zero counters = no-op success.
  fee_dest_token/quote must be token accounts of the right mints
  owned by pool.fee_dest.

### 2.3 Rule 2 escrow (venue-side; part of Swap)

The venue reads the engine Config PDA from the tail's config
account (it is already there — validate it is the derived Config
PDA for the mint under ENGINE_ID). If the config carries an
ENABLED rule 2 entry (split_bps @ params[0..2]):

Escrow PDA — seeds ["escrow", mint, user_token_account] under
THIS program, ESCROW_SPACE = 96:

| offset | field |
|---|---|
| [0] | tag = 1 |
| [1..33] | owner (the token account's owner at creation) |
| [33..41] | escrow_lamports u64 |
| [41..49] | total_refunded u64 |
| [49..57] | total_forfeited u64 |
| [57..96] | reserved |

The PDA holds its escrow as its own lamports above rent:
lamports == rent_min(96) + escrow_lamports.

- **Buy (dir 0) with rule 2:** escrow_pda account REQUIRED in the
  venue-extra position (missing → error). split = amount_in *
  split_bps / 10_000 (floor). The buyer funds: total quote in =
  amount_in (transferred user→quote_vault as TaxSwap does) PLUS
  split lamports of native SOL moved user→escrow PDA (a system
  transfer inside the swap — the escrow PDA is created first if
  absent, user pays rent, standard create-with-seeds via
  invoke_signed by this program with user as funder); the swap
  then runs on amount_in (the traded part) with fee taken from
  it per 2.2. Wait — cleaner accounting, FIXED HERE: amount_in
  is the TOTAL quote the user spends. split is carved first:
  escrow gets `split`; traded_in = amount_in − split; fee is
  taken from traded_in. The quote-vault transfer is traded_in −
  fee... no: fee STAYS in the vault (2.2). So quote_vault
  receives traded_in (fee included, accruing to the counter);
  escrow PDA receives split (native SOL transfer user→PDA +
  create if needed); token out computed on (traded_in − fee).
  escrow_lamports += split. msg! the split.
- **Sell (dir 1) with rule 2:** resolution happens FIRST, from
  pre-sell state: pre_bal = user_token amount (the venue reads
  it before any transfer). If escrow PDA absent or
  escrow_lamports == 0 → nothing. resolved =
  escrow_lamports * amount_in / pre_bal (floor; amount_in ==
  pre_bal → all). Dip test reads the SHARED engine PriceFeed +
  the seller's engine Holder PDA — both passed as venue-extra
  accounts [price_feed(ro), seller_holder(ro)] after the escrow
  slot (validate: price_feed == PDA(["price", mint], ENGINE_ID)
  and is engine-owned with tag 1; holder == PDA(["holder", mint,
  user_token], ENGINE_ID); read ema @97..113, basis from holder
  @6..38 num/den, latched @38 — the engine's published layouts).
  DIP := holder exists && basis present && (latched || ema <
  basis). If the feed or holder cannot be read (missing/stale —
  staleness: feed last_crank_ts @113 vs the config's rule-1
  max_stale @ params[0..8], 0 = 300) → NOT dip (forfeit path) —
  resolution NEVER bricks the sell and NEVER refunds blind.
  - DIP: refund = resolved * 96 / 100 to the seller (native SOL
    from the escrow PDA's lamports to the seller's wallet);
    depth = resolved * 2 / 100 → transferred into the quote
    vault as lamports + SyncNative CPI; treasury = resolved −
    refund − depth → native SOL to pool.fee_dest (if fee_dest
    unset/zero, folds into depth). (96/2/2 of resolved — the
    catalog's 48/50 with 1pt depth + 1pt treasury, SPEC-HOOK-
    LAUNCHER §5 rule 2; rounding remainder to treasury.)
  - NOT DIP: resolved → depth (quote vault + SyncNative).
  - escrow_lamports −= resolved; total_refunded/forfeited
    updated. Then the swap proceeds on amount_in with fee per
    2.2 (fee in token units to fee_accrued_token).
- Venue-extra account order for Swap (after the hook tail):
  [escrow_pda?, price_feed?, seller_holder?, fee_dest_token?,
  fee_dest_quote?] — escrow sells need price_feed + holder;
  ClaimFees uses its own list (2.2 tag 6). Document the exact
  presence matrix in INTEGRATION.md: buy+rule2 → escrow required;
  sell+rule2 → escrow + feed + holder required (a seller with no
  escrow record passes the zeroed/nonexistent escrow account —
  clients pass the derived PDA regardless; the venue treats a
  nonexistent one as zero escrow and skips resolution).

## 3. Launcher / composer / doors / keeper (worker C owns launcher/, aonly-site source)

### 3.1 launch.mjs

- HOUSE_SWAP_PROGRAM_ID const = the houseswap dev keypair pubkey
  (worker B generates it; worker C reads
  `../houseswap/houseswap-keypair.json` at build time — the
  const VALUE is written as a literal with a comment: dev id
  until the Phase C window assigns the mainnet keypair, per the
  deploy sheet).
- resolveGraduation: 'house' becomes a mode. Returns { mode:
  'house', thresholdSol: NEVER_THRESHOLD_SOL, thresholdLamports:
  NEVER_THRESHOLD_LAMPORTS (the DBC curve is built with the
  never threshold — house rides never physics), houseThresholdSol:
  spec.graduationThresholdSol, houseThresholdLamports:
  solToLamportsExact(...) }. Hard errors: house without a
  positive graduationThresholdSol; house + migrationThresholdSol
  ("house + migrationThresholdSol is a hard error" — locked
  answer 6); house + graduationThresholdSol on other modes is
  an error too (field belongs to house).
- Spec fields: graduationThresholdSol (number > 0, required for
  house), houseReserveSol (number >= 0, default 0),
  houseSeedTokens (number > 0, REQUIRED for house — UI units,
  converted with spec decimals), houseSeedWalletSol (SOL funding
  for the seed wallet, default = houseSeed buy estimate — keep
  simple: a fixed funding field with default 0.1 + the buy uses
  houseSeedBuySol (number > 0, REQUIRED for house: the SOL the
  seed wallet spends on the curve to acquire the seed tokens)).
  Validation: house mode requires all of graduationThresholdSol,
  houseSeedTokens, houseSeedBuySol.
- validateSpec additions: rule 2 selectable (IMPLEMENTED gains
  2; NAME_TO_ID already maps 'escrow-split'); encodeParams(2):
  splitBps @ [0..2] u16, default 5000, range 1..10000. Rule 2
  hard errors: graduation != 'house' → error (rule 2 requires
  house); rule 1 not enabled → error (rule 2's resolution IS
  rule 1's dip logic — it requires the Basis Latch + feed).
  House warnings: seed-account exemption disclosure; rule-2
  copy (split applies to house-venue trades after activation;
  curve trades are unsplit; escrow resolves only on house-venue
  sells).
- v4 guard: specHasRule1Never also treats mode 'house' as
  applies (rule-1 + house rides the u64::MAX threshold — the
  same crank-overflow exposure the guard exists for). Update the
  pure section's comments; never-behavior decisions unchanged.
- configPayload: gains an optional house argument; when present
  appends the 1.2 block [1][program][threshold][reserve]. L3
  bytes for non-house specs UNCHANGED.
- Plan + execute steps for house (execute path is coded, not run
  — the file's standing convention): after L2 —
  H1 create house vaults (token + wSOL token accounts owned by
  the house pool PDA); H2 houseswap InitPool (authority =
  launcher); L3 config WITH house block and exemptions
  [poolAuthority, baseVault, seedAta] where seedAta = the seed
  wallet's ATA for the mint (a DEDICATED per-launch seed keypair
  is generated, its pubkey recorded; the record carries a
  `house.seedExemption` disclosure naming the account + why);
  L4/L4b/L5 as usual; H3 seed buy: seed wallet buys
  houseSeedBuySol on the curve into seedAta (dev-buy machinery
  shape; seed wallet funded houseSeedWalletSol + buy SOL
  beforehand at H0); H4 seed transfer seedAta → house token
  vault (plain TransferChecked, NO hook tail needed... the
  transfer fires Execute: src exempt (seedAta), dst exempt
  (house token vault — WAIT: the house token vault is NOT in
  exemptions until activation. H4's destination check: rule
  modules judge the DST holder (agent-only etc.) and basis
  bookkeeping writes a holder record for the vault keyed by
  the vault account... Rule 1 bookkeeping: dst non-exempt →
  creates holder record for the house vault with basis = ema
  (src exempt → unit basis = ema) — harmless (the vault's own
  record; pool vaults on DBC carry records the same way? the
  DBC base vault IS exempt at launch so it never gets one; the
  house vault pre-activation getting a basis record is benign
  state, disclosed in INTEGRATION.md. Rules 3/17 would VETO H4
  (vault not registered) — for house + rule 3/17 stacks the
  launch must SyncRegistered the house vault's holder record
  (authority path) before H4, mirroring L7b's distributor-vault
  sync. Add step H4b conditional on rules 3/17, exactly the L7b
  pattern with owner = house pool PDA... SyncRegistered path (a)
  mirrors into the record keyed by the owner's ATA — the owner
  here is the pool PDA; its ATA for the mint IS the house token
  vault only if the vault was created AS the pool PDA's ATA.
  THEREFORE H1 creates the token vault AS the pool PDA's
  canonical ATA (getAssociatedTokenAddressSync(mint, poolPda,
  true, T22)) — then H4b's SyncRegistered(owner = pool PDA)
  lands in the vault's record. The wSOL vault is likewise the
  pool PDA's wSOL ATA on the legacy program.); H5 CommitPool;
  H6 reserve: if houseReserveSol > 0, plain transfer launcher →
  housevault PDA of houseReserveSol, then engine tag 17
  RecordHouseReserve (authority-signed).
  Record: graduation block { mode:'house', thresholdSol:
  NEVER string, thresholdLamports: MAX string,
  houseThresholdSol, houseThresholdLamports } + house block
  { program, pool, tokenVault, quoteVault, seedWallet,
  seedAta, seedBuySol, seedTokensTarget, reserveSol,
  houseVault, seedExemption: seedAta }.
- Dry-run plan lines for H0–H6 with the same wording discipline
  as existing steps; budget line adds house rents + reserve +
  seed funding.

### 3.2 Composer + parity

- Regenerate rules.generated.mjs (gen-rules) — rule 2 flips to
  implemented:true. check-rule-parity must pass: the aonly-site
  launch page source (~/workspace/aonly-site/hooks/launch/
  index.html, LOCAL SOURCE ONLY — publishing stays post-window)
  must offer rule 2 as selectable with house-venue-only labeling
  + a selectable block in the Phase B no-knobs pattern, and the
  coming-soon grid drops rule 2 (nothing remains coming-soon —
  all 17 selectable; keep the grid code path working with an
  empty set).
- entry.mjs (composer): graduation choice gains "house" with
  the graduationThresholdSol input; rule 2 selection forces
  graduation = house (and requires rule 1) with the venue-only
  label visible; rule-1 + house is refused while GUARD.
  fixedEngineSha256 is null (same crank-fix dependency as
  rule-1 + never).
- trial-graduation.mjs B5 asserts house is REFUSED today — that
  baseline is deliberately superseded by Phase C (document the
  recapture in the trial file header, the file's own precedent):
  B5 becomes house-resolves-correctly; add house assertions
  (threshold fields, both contradiction errors, validateSpec
  rule-2 gates, dry-run plan shows H-steps + house GRADUATION
  line). All other baselines (A*, B1–B4, B6–B8, C*, D1–D4)
  unchanged.

### 3.3 Doors (hook.mjs + new launcher/doors.mjs)

- doors.mjs exports: parseHouseSlot(configBytes) → null |
  { program, thresholdLamports, reserveLamports, activatedTs,
  state }; resolveVenue(record, configBytes) → { venue:
  'curve' | 'house', reason } — house iff slot present &&
  state == 2; buildHouseSwapKeys(...) / buildHouseSwapIx(...)
  producing the houseswap Swap instruction (account order per
  §2.2 incl. hook tail resolution from the mint's meta list via
  the same generic resolver hook.mjs already uses
  (hookExtras)), plus escrow/feed/holder extras when the record
  stack has rule 2.
- hook.mjs: buy/sell (and flow buy/sell) route through
  resolveVenue using the token's live config bytes; house route
  builds via doors.mjs; curve route unchanged. Status output
  names the active venue + (for house-pending tokens) the
  threshold progress (DBC quote reserve vs graduationThresholdSol,
  read from the pool account @240 + the slot).
- Doors are exercised against fixtures, not prose: worker C's
  trial drives doors.mjs against the SAME LiteSVM lifecycle
  state shape (it may reuse worker B's trial outputs only if
  B lands first; otherwise its own minimal SVM fixture with
  the real binaries).

### 3.4 Activation keeper (launcher/activation-keeper.mjs)

Buyback-crank pattern: library + guarded CLI (no mainnet mode
in code; --local offline demo), pure planActivation(input)
decision fn. Input: { configBytes, dbcPoolBytes, houseVault:
{ lamports, reserveBalance, feeBalance }, poolBytes }. Output:
{ ready, missing: [...named gaps], steps: ['activate-house',
'activate-pool'] or [] }. Ready iff slot pending && pool
committed && curve reserve >= threshold && seed condition
(reserve met, or fee-only with feeBalance > 0). Already
activated → { ready: false, missing: [], steps: [], done:
true }. The execute path (documented, local-only) builds the
two instructions: engine tag 14 (anyone) + houseswap tag 5
(anyone, fee_bps from the launch record).

## 4. Trials (all must pass; counts reported)

- engine/trial-phase-c.mjs (worker A): house block write/read;
  V1 configs unchanged (byte-compare a Phase B payload + a V2
  payload); rule 2 write validation (bad bps, nonzero padding,
  rule 2 without house → reject; rule 2 with house → accept;
  Execute no-op on a transfer); UpdateConfig house immutability
  matrix; DepositHouseFees (happy, post-activation reject);
  RecordHouseReserve (unfunded reject, funded accept, no-op
  repeat); ActivateHouse: before-threshold reject 33,
  uncommitted-pool reject 34, happy path (venues/exemptions
  appended EXACTLY, state/ts written, seed moved to the quote
  vault with syncNative balance visible, caller cut exact,
  vault counters exact), double-activation reject 14;
  CrankPriceDeep: curve-deeper keeps pin + folds curve spot;
  house-deeper repins + folds house spot; reserves moved back
  flips again; pre-activation house depth ignored.
- houseswap/trial-houseswap.mjs (worker B) — the lifecycle,
  real binaries (Phase C engine trial binary + this program +
  the real DBC binary from ../bin): launch-shaped setup (mint
  via DBC createPoolWithTransferHook like the integration
  suites, or engine-direct setup where DBC is not the subject —
  the ACTIVATION threshold read must run against a REAL DBC
  pool account whose quote reserve crossed via REAL buys);
  curve buys accrue fees → claim → DepositHouseFees; reserve
  path in a second mint (or same mint pre-claim); ActivateHouse
  via the keeper-shaped bundle + ActivatePool; house buys/sells
  enforce rule 1 latch (Locked veto on a house sell above basis;
  dip → sell passes) + rule 9 cap; rule 2 stack on a third mint
  (or second config): split buy escrows exactly split_bps,
  above-entry sell forfeits resolved to depth exactly, dip sell
  refunds 96/2/2 exactly; deeper-venue-wins flip via tag 15
  after moving reserves; failure modes (activation before
  threshold, double activation, house+migrationThresholdSol
  spec error is launcher-side — worker C covers it; pool
  double-ActivatePool reject; swap before activation fails
  BadCaller at the engine).
- launcher/trial-house.mjs (worker C): doors resolveVenue matrix
  (no slot → curve; pending → curve + progress; activated →
  house), doors swap-ix shape (account order vs contract),
  keeper plan matrix, launch.mjs dry-run house plan (H-steps,
  GRADUATION house line, budget), spec-validation error set.
  Plus updated trial-graduation + trial-launch-features stays
  green (with §H house-applies additions), parity CLI OK, site
  composer smoke 65/65 + trade-check 74/74 re-run.

## 5. Coordinator (integration)

Re-run the full Phase B battery + v4 rehearsal against the
Phase C binaries; write deploy/BUILD-RECORD-PHASE-C.md +
deploy/PHASE-C-DEPLOY-SHEET.md (per-program windows: engine
upgrade, houseswap fresh deploy; extends/floats from binary
sizes; post-window wiring: launch.mjs HOUSE_SWAP const,
guard pin, EVER-style finish list n/a, first house launch as
the proof obligation from SPEC-GRADUATION-HOUSE §5).

# HouseSwap — integration contract

The house venue for the Hook Launcher (Phase C contract §2). One
constant-product pool per mint: hooked token (Token-2022, engine transfer
hook) vs wSOL (legacy SPL token program). It generalizes TaxSwap
(`~/workspace/taxhook/swap`); the Pool account's first 168 bytes are
byte-identical to TaxSwap's layout.

- **Program id (dev/trial):** the pubkey of `houseswap-keypair.json` in
  this directory. Mainnet gets a fresh keypair at the Phase C deploy
  window; `launcher/launch.mjs`'s `HOUSE_SWAP_PROGRAM_ID` const is set
  then. The program derives everything from the runtime program id, so
  no code change is needed for the mainnet id.
- **Hardcoded counterparts:** engine `EPdYVfsX7Lk9gtLp8CVouiFrNwtxP5g11NR6DDgs6akT`
  (both flavors — trials load the trial engine at this id), Meteora DBC
  `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, Token-2022, legacy token
  program, native mint.

## Pool account — PDA `["pool", mint]`, 264 bytes

| offset | field |
|---|---|
| `[0]` | tag = 1 |
| `[1..33]` | authority (the InitPool payer; after CommitPool the `["poolauth", mint]` PDA of this program) |
| `[33..65]` | token_mint |
| `[65..97]` | quote_mint (= native mint) |
| `[97..129]` | token_vault |
| `[129..161]` | quote_vault |
| `[161]` | bump |
| `[162]` | committed u8 (0/1) — engine ActivateHouse (tag 14) reads this byte |
| `[163]` | live u8 (0/1 — fee mirror written by ActivatePool) |
| `[164..168]` | reserved |
| `[168..170]` | fee_bps u16 (mirrored curve creator fee; 0 until live) |
| `[170..202]` | fee_dest pubkey (read on-chain from the DBC config at activation) |
| `[202..210]` | fee_accrued_quote u64 — engine CrankPriceDeep (tag 15) reads this (house depth = quote vault amount − this counter) |
| `[210..218]` | fee_accrued_token u64 |
| `[218..226]` | activated_ts i64 |
| `[226..264]` | reserved |

## Escrow PDA (rule 2) — seeds `["escrow", mint, user_token_account]`, 96 bytes

| offset | field |
|---|---|
| `[0]` | tag = 1 |
| `[1..33]` | owner (the token account's owner at creation) |
| `[33..41]` | escrow_lamports u64 |
| `[41..49]` | total_refunded u64 (cumulative dip refunds to sellers) |
| `[49..57]` | total_forfeited u64 (cumulative resolved shares NOT refunded: dip depth+treasury shares and all not-dip resolutions) |
| `[57..96]` | reserved |

The PDA holds its escrow as its own lamports above rent:
`lamports == rent_min(96) + escrow_lamports` at all times. Escrow is
denominated in native SOL (quote lamports) regardless of which side of
the pool a trade touches: buys fund it, sells resolve it.

## Instructions

Data tag is `data[0]`. Error codes are `ProgramError::Custom(n)`:
1 BadPool, 2 Slippage, 3 MathOverflow, 4 Unauthorized, 5 BadVault,
6 AlreadyLive, 7 NotCommitted, 8 BadHouseState, 9 BadDbc, 10 BadFeeBps,
11 MissingEscrow, 12 BadEscrow, 13 BadFeeDest, 14 BadConfig,
15 AlreadyCommitted, 16 BadVenueExtra.

### 0 InitPool
Accounts: `[payer(s,w), token_mint, quote_mint, token_vault, quote_vault, pool(w), system]`.
TaxSwap's checks verbatim: both vaults must be token accounts of the
right mints owned by the pool PDA. Writes the 168-byte TaxSwap prefix
(authority = payer, bump @161) and zeroes the extension (committed 0,
live 0, fee_bps 0, counters 0).

### 1 Swap
Data: `[1][dir u8][amount_in u64][min_out u64]` — dir 0 = buy (quote in,
token out), 1 = sell (token in, quote out).

Accounts, in order:
1. `pool(w)`, `token_mint`, `quote_mint`, `token_vault(w)`,
   `quote_vault(w)`, `user_token(w)`, `user_quote(w)`,
   `user(signer, w)`, `token_prog`, `quote_prog`. The pool is writable
   (fee counters accrue in place) and the user is writable: on a rule-2
   buy the system-program escrow funding debits the user's lamports,
   and on a dip sell the escrow refund credits them — the runtime
   rejects both against a read-only account.
2. **Hook tail** — the engine's resolved extra accounts for the token
   leg, in the mint's published meta-list order, then the hook (engine)
   program, then the meta-list account itself (the SPL resolver layout —
   the same tail TaxSwap's `transfer_hooked_ix` forwards). The venue
   forwards exactly these accounts, in given order, into the token leg's
   TransferChecked CPI. The tail's end is located by the meta-list PDA
   key, so any templated subsequence works.
3. **Venue extras** — consumed by the venue itself and **never**
   forwarded into any transfer CPI (see the presence matrix below).

Math (constant product on live vault token balances, u128, checked):
`fee = traded_in * fee_bps / 10_000`; `out = reserve_out *
(traded_in − fee) / (reserve_in + traded_in − fee)`; `out == 0`,
`out >= reserve_out`, or `out < min_out` → Slippage. There is **no**
hardcoded fee factor: the fee IS `pool.fee_bps`, which is 0 until
ActivatePool, so pre-activation swaps are fee-free. The fee stays in the
input-side vault (reserves grow) and accrues to the counters
(buy → `fee_accrued_quote`, sell → `fee_accrued_token`) for ClaimFees.

Pre-activation venue note: Swap has no live/committed gate of its own.
Before ActivateHouse the engine's venue allowlist does not contain this
program, so the token leg's Execute fails with the engine's BadCaller —
the house is unreachable until activation by construction, not by a
venue-side flag.

### 2 AddLiquidity / 3 RemoveLiquidity
Data: `[tag][amt_token u64][amt_quote u64]`. Accounts: `[pool,
token_mint, quote_mint, token_vault(w), quote_vault(w), auth_token(w),
auth_quote(w), authority(signer), token_prog, quote_prog, HOOK TAIL...]`
— TaxSwap verbatim, authority-signed, token leg hook-forwarded.
After CommitPool the authority is a program PDA nobody can sign for, so
both instructions are permanently dead — that is the liquidity lock.
Pre-commit RemoveLiquidity is the seed-recovery path.

### 4 CommitPool
Accounts: `[pool(w), mint, authority(signer)]`. One-way: the signer must
equal `pool.authority` and `committed` must be 0; sets
`authority := PDA(["poolauth", mint], this program)`, `committed := 1`.

### 5 ActivatePool
Data: `[5][fee_bps u16]`. Permissionless. Accounts: `[pool(w), mint,
engine_config(ro), dbc_pool(ro), dbc_config(ro)]`.
Validates: the engine config is the derived Config PDA for the mint,
engine-owned, with the house region present, `house_state == 2`, and
`house_program == this program`; `pool.committed == 1` and
`pool.live == 0` (a second call rejects AlreadyLive). The DBC linkage is
validated on-chain: both accounts are DBC-owned, `dbc_pool` is 424
bytes with `base_mint @136 == mint` and its config field `@72 ==
dbc_config.key`.

**Fee-mirror honesty note.** The fee *destination* is anchored
on-chain: `fee_dest` is read from the DBC config account itself —
PoolConfig zero-copy layout, 8-byte discriminator, `quote_mint @8..40`,
`fee_claimer @40..72` — so no caller can divert the house fee to another
wallet. The fee *rate* is caller-supplied from the launch record and
bounded to `25..=9900` (the DBC program's own fee bounds; a mirror of
"no fee" is expressed by the launch's feeBps floor of 25, so 0 is
rejected). The rate is publicly verifiable against the DBC config's fee
scheduler, but this program does not re-derive it — that asymmetry is
deliberate and stated here plainly: destination trustless, rate
attested-by-record.

Writes `fee_bps`, `fee_dest`, `live := 1`, `activated_ts := now`.

**The keeper activation bundle.** Activation is a single transaction:
`[engine ActivateHouse, ActivatePool, SyncNative(house quote vault)]`.
Two runtime facts shape it. (1) In the engine's ActivateHouse
instruction the CALLER and the HOUSE QUOTE VAULT must be passed
WRITABLE even though the contract lists them read-only: the engine
pays the caller cut and credits the seed to the quote vault as
lamports, and the runtime rejects balance changes on read-only
accounts. (2) The engine lands the seed as raw lamports WITHOUT an
in-program SyncNative (a CPI naming an account the program already
credited directly is rejected at dispatch — the engine documents this
deviation in its own source), so the bundle's trailing top-level
SyncNative is what makes the quote vault's token amount equal
`lamports − rent reserve` at end of transaction. The trial's bundles
are built exactly this way.

### 6 ClaimFees
Permissionless. Accounts: `[pool(w), token_mint, quote_mint,
token_vault(w), quote_vault(w), fee_dest_token(w), fee_dest_quote(w),
token_prog, quote_prog, HOOK TAIL...]` (tail resolved for the token
leg: source = token vault, destination = fee_dest_token). The
destinations must be token accounts of the right mints owned by
`pool.fee_dest`. Pays `fee_accrued_token` from the token vault
(hook-forwarded TransferChecked, pool PDA signs — it succeeds or fails
closed with the stack's rules; see the rule-9 note below) and
`fee_accrued_quote` from the quote vault (plain TransferChecked), then
zeroes both counters. Zero counters = no-op success.

**ClaimFees vs rule 9 (Max Wallet).** The token leg is an ordinary
hooked transfer into the fee destination's account, so a config with
rule 9 judges the fee_dest balance like any other receive: if accrued
token fees would push the fee_dest over its cap, the claim fails closed
(MaxWalletExceeded) and the counters stay accrued — fees are never
lost, but they are stuck until the destination's balance falls or the
accrual is claimed in smaller pieces (there is no partial-claim
instruction in v1). Fee destinations on capped stacks should be
exempted at config time or expect this.

## Swap venue-extra presence matrix

Venue extras follow the hook tail, in this order:
`[escrow_pda?, price_feed?, seller_holder?, fee_dest_token?,
fee_dest_quote?, fee_dest_wallet?]`. (The first five slots are the
contract §2.3 order; the sixth — the fee_dest *wallet* account itself —
is where a selling client passes the native-SOL recipient of the rule-2
dip treasury share, since slots 4/5 are token accounts. If it is
absent, the treasury share folds into depth instead of failing the
sell.)

| case | escrow | price_feed | seller_holder | fee_dest_token/quote | fee_dest_wallet |
|---|---|---|---|---|---|
| no enabled rule 2 (any dir) | — | — | — | — | — |
| rule 2, buy | **required** (derived PDA; created if absent, buyer funds rent) | — | — | — | — |
| rule 2, sell, no escrow record/balance | **required** (pass the derived PDA regardless; a nonexistent one reads as zero escrow and resolution is skipped) | — | — | — | — |
| rule 2, sell, escrow balance > 0 | **required** | **required** (engine PriceFeed PDA) | **required** (engine Holder PDA for the seller's token account) | optional, ignored | optional — recipient of the 2% treasury share on a dip; absent → folds into depth |

Derivations: escrow = `["escrow", mint, user_token_account]` under this
program; price_feed = `["price", mint]` under the engine; seller_holder
= `["holder", mint, user_token_account]` under the engine. Wrong keys on
a due resolution reject BadVenueExtra; correct keys with unreadable
state take the forfeit path (below).

## Rule 2 escrow mechanics (venue-side)

The venue reads the engine Config PDA from the tail's config account
(it validates the key is the derived PDA and the owner is the engine).
An enabled rule 2 entry carries `split_bps` u16 at `params[0..2]`.

**Buy.** `amount_in` is the TOTAL quote the user spends. The split is
carved from the total BEFORE the fee: `split = amount_in * split_bps /
10_000` (floor); `traded_in = amount_in − split`; the fee is taken from
`traded_in`; token out is computed on `traded_in − fee`. Funding legs:
the wSOL leg moves `traded_in` from the user's quote account to the
quote vault (fee included — it stays in the vault); the split moves as
**native SOL** from the user's wallet to the escrow PDA (a system
transfer inside the swap; the PDA is created first if absent, the user
pays rent). A rule-2 buyer therefore needs both a funded wSOL account
(≥ traded_in) and native SOL (≥ split + rent-if-creating) in the wallet.
`escrow_lamports += split`.

**Sell.** Resolution is COMPUTED first, entirely from pre-sell state:
`pre_bal` = the seller's token balance before any transfer;
`resolved = escrow_lamports * amount_in / pre_bal` (floor; selling the
whole balance resolves all of it). The dip test reads the shared engine
PriceFeed (EMA @97..113) and the seller's engine Holder PDA (basis
num/den @6..38, latched @38): DIP := holder exists && basis present &&
(latched || ema < basis). Staleness uses the config's rule-1
`max_stale` (params[0..8], 0 = 300s) against the feed's
`last_crank_ts @113`. If the feed or holder cannot be read (missing,
corrupt, or stale) the resolution takes the FORFEIT path — resolution
never bricks the sell and never refunds blind.

- **DIP:** refund `resolved * 96 / 100` to the seller's wallet (native
  SOL from the escrow PDA); depth `resolved * 2 / 100` into the quote
  vault (as lamports — see the sync note below); treasury =
  `resolved − refund − depth` (the rounding remainder lands here) to
  `pool.fee_dest`'s wallet — or into depth if fee_dest is unset/zero or
  the wallet account was not passed. (The catalog's 48/50 with 1pt
  depth + 1pt treasury.)
- **NOT DIP:** the whole `resolved` goes to depth (quote vault
  lamports).

The swap then proceeds on `amount_in` with the fee taken in token units
to `fee_accrued_token`, priced on the reserve snapshot taken before the
resolution (the seller's own forfeited escrow never improves their own
fill). The escrow's lamport movements are APPLIED after the swap legs,
inside the same instruction: this runtime rejects a CPI that names an
account whose lamports the calling program directly modified earlier
in the same instruction (the same wall the engine's ActivateHouse hit
with its in-program SyncNative), so the credits must land after the
last transfer CPI that names them. Every amount is exactly the
computed resolution; a failed swap leg reverts the whole instruction,
credits included.

**Sync note (routers must do this).** For the same reason, the venue
does NOT SyncNative the quote vault in-program after crediting the
depth share: the depth lands as lamports, and the caller's transaction
MUST append a top-level `SyncNative` for the pool's quote vault after
any rule-2 sell instruction (a plain token-program instruction on the
vault account — permissionless). Until it lands, the vault's lamport
balance is ahead of its token amount by exactly the depth share. This
is the same shape as the engine's activation bundle (below).

Curve (DBC) trades are never split — rule 2 is a house-venue mechanic
only.

**Pre-activation basis-record note (contract §3.1 H4).** The seed
transfer that stocks the house token vault (seed wallet → house token
vault, before activation) fires the engine hook with the vault as
destination. Until ActivateHouse appends the vaults to the config's
exemptions, the vault is a non-exempt destination, so rule 1 bookkeeping
writes a Holder record for the vault (keyed by the vault token account)
with basis = the feed EMA at that moment (the seed source is exempt, so
the unit basis is the EMA). This is benign state — the vault's own
record, mirroring how curve-side pool vaults carry records — but it is
real: after activation the vault is exempt and the record is never read
again (exempt destinations skip bookkeeping; exempt sources skip the
gate). For rule 3/17 stacks the launch must SyncRegistered the vault's
record before the seed transfer (launcher step H4b) exactly as it does
for the distributor vault, which is why the token vault is created as
the pool PDA's canonical ATA.

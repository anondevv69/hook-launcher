# Router Compatibility — Evaluation Brief (2026-10-16)

Status: EVALUATION ONLY. No code changed, nothing deployed. Prepared after the
2026-10-16 root-cause finding so the go/no-go decision has costed options.

## Root cause (verified on-chain, 2026-10-16)

- Entry [2] of the engine's ExtraAccountMetaList (destination Holder PDA) is
  seeded via an **AccountData** seed that reads the owner field out of the
  buyer's token account. The standard resolver (spl-token's, also used inside
  Meteora's DBC SDK) throws `TokenTransferHookAccountDataNotFound` when that
  token account does not exist yet — i.e. every first-time buyer.
- Result: AGTR and Latch resolve for existing holders, fail for fresh wallets
  on BasedBot / generic routers. HookedPad's FOMO (2 extras) and MHA (4
  extras) derive every extra from the mint alone and resolve in all cases.
- Jupiter refuses all four tokens identically — not the route in question.

## Current state costs (from engine/BUILD-NOTES.md, measured)

| Item | Bytes | Rent |
|---|---|---|
| Holder PDA (legacy) | 136 | 0.001837 SOL |
| Holder PDA (extended, graduated) | 192 | ~0.002227 SOL (formula: (bytes+128)×6,960 lamports) |
| ExtraAccountMetaList PDA | 261 | 0.002707 SOL |
| Config PDA | 1,088 | 0.008463 SOL |

Per-holder rent is currently paid lazily (rent vault / init_holder), scaling
linearly with holders at ~0.002 SOL each, with no single point of contention:
every transfer writes only the two parties' own Holder PDAs.

## Option A — AccountKey seed for the destination Holder PDA (minimal change)

Hypothesis to verify, NOT yet proven: TLV account resolution supports an
**AccountKey** seed (use another instruction account's pubkey as the seed) in
addition to AccountData seeds. The destination token account's *address* is
known at route-building time — it is an account in the swap instruction, and
for ATA buys it is derivable from owner+mint — even when the account does not
exist yet. The resolver never needs to read its contents.

Change sketch:
- Seed dest Holder PDA as `["holder", mint, dest_token_account_pubkey]`
  (AccountKey seed referencing the destination account) instead of deriving
  it from the owner read out of the destination account's data.
- Engine validation derives the expected dest Holder PDA from account #2's
  key directly; the owner read is still available at Execute time (by then
  the ATA exists — buys create it in the same transaction) for rule logic.
- Source Holder PDA can stay AccountData-seeded (source account always
  exists — the sender holds the tokens) or be switched symmetrically.

What this preserves: per-holder PDAs, the existing rent model, all rule
semantics for the normal one-ATA-per-owner case, and the 12-account Execute
layout.

Costs / risks to evaluate:
1. **Identity keying changes**: holder state keys to the token *account*, not
   the owner. A wallet holding through multiple token accounts for the same
   mint fragments its basis / latch / vesting state per account. ATA is the
   norm for bot and retail buys (one ATA per owner per mint), so the common
   case is unaffected; a SyncHolder merge instruction is the possible
   mitigation for the rest.
2. **Resolver support must be proven, not assumed**: build a trial mint whose
   meta list uses the AccountKey seed and run the same reproduction harness
   used on 2026-10-16 (spl-token resolver + Meteora DBC SDK path) for a fresh
   wallet with no token account. If the resolver rejects AccountKey seeds in
   the dest position, Option A dies here and Option B is the path.
3. **Live retrofit question**: the ExtraAccountMetaList is a per-mint PDA
   written by the hook program. Can it be re-initialized / updated for AGTR
   and Latch under the authority fren already holds, swapping only the seed
   type of entry [2]? If yes, live tokens may be fixable in place — which
   would supersede the 2026-10-16 note that live tokens "can't be trivially
   retrofitted." Verify the meta list account's authority and update path
   before promising anything.

## Option B — Mint-scoped holder table (HookedPad shape)

Move all holder records into one mint-wide table account (their "history
account" pattern), keeping the meta list fully mint-derived.

Costing, assuming ~232 B/record (192 B state + 32 B owner key + index slack):
- 1,000 holders: account ≈ 232 KB → **~1.62 SOL** pre-funded rent, one account
- 10,000 holders: ≈ 2.32 MB → **~16.2 SOL** pre-funded rent
- Hard ceiling: 10 MB account limit → ~43k records max at this record size
- Every transfer writes the SAME account → transaction contention /
  serialization on hot tokens, and lookup must be indexed (hash buckets or
  sorted + binary search) or CU cost grows linearly with holder count.
- Rent shifts from pay-per-holder-lazily to launcher pre-funds the table at
  launch (or a grow-as-you-go realloc scheme, which adds its own complexity).

This is a redesign, not a patch: new account layout, new indexing, migration
story for future launches only; live AGTR/Latch holder PDAs do not convert.

## Recommendation for the decision

Evaluate A first (days, possibly retrofits live tokens), fall back to B only
if the resolver test kills A. Either way the doors package stays a custom
route worth having for per-holder rules — but if A verifies, generic-router
compatibility stops depending on it.

## Decisive tests (in order)

1. LiteSVM/resolver repro: AccountKey-seeded dest holder meta + fresh wallet
   (no ATA) → does spl-token resolution + the DBC SDK path succeed?
2. Meta-list authority check on AGTR/Latch: can entry [2]'s seed be updated
   in place, by whom, at what cost?
3. Only if A fails: table indexing design (bucket count vs CU) + pre-fund
   sizing for B.

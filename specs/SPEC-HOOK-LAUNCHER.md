# Solana Hook Launcher — SPEC

**Status:** Draft v1, 2026-10-15 (Gregory approved direction; fren authored)
**One-liner:** A launcher that mints Solana tokens whose *entire behavior* is governed by a transfer-hook rule engine — pick rules, set numbers, launch. The hook is the token's constitution, the way TaxHarvest's basis latch was: it sits on **every** transfer (buy, sell, wallet-to-wallet) and shapes the whole game, not one feature of it.

Prior art we build on (all shipped by us):
- **TH / TaxHarvest (Solana)** — native Rust Token-2022 transfer-hook program, per-holder basis PDAs, cranked EMA PriceFeed, house swap venue (TaxSwap), authorities burned. `~/workspace/taxhook/SPEC.md` + trial addendum.
- **HARVEST v2/v3 (Robinhood Chain)** — escrow split + pay-at-source fee trickle at a v4 hook.
- **AONLY / GateHook (Base)** — agent-only admission by signed registration.
- **Crown (EVM, in flight)** — registry-decided fee beneficiary, dethroned by stake-vote.
- **Tithe (EVM)** — fee stream to a transferable seat.

Market reference: Hooked (hookedpad.com) proves the Token-2022 + Meteora shape and a rule catalog; Circuit (circuitdev.fun) proves demand for "describe the behavior, launch the token," but executes rules from a custodial server. **Ours is fully on-chain like Hooked, agent-first like neither.**

---

## 1. Why this shape (Solana constraints, stated plainly)

1. **The only universal hook point on Solana is the Token-2022 transfer hook.** The token program calls the mint's named hook program on every `TransferChecked`; the program may read the transfer and its own PDAs and **veto** (fail the whole transaction). It cannot see price, cannot skim the amount, cannot pay anyone.
2. **One hook program per mint.** Therefore the platform is **one engine program**; per-token behavior lives in a **Config PDA** (rules as data). New hooks = new engine modules or new config, never a new program per user idea. The catalog is open-ended by design.
3. **Fees are a separate extension.** Token-2022's native **Transfer Fee extension** withholds a configured % of every transfer into the mint's withheld balance — hook and fee extensions coexist on one mint. Accrual is native; *distribution* is a companion program (§4).
4. **Money movement beyond the transfer itself belongs to the venue or a companion program.** Pay-at-source trickle (HARVEST-style) works when our swap program builds the trade. Holder payouts work via an index-accounting distributor with lazy settlement (§4.3).
5. **Price-dependent rules need a price feed.** The TH pattern generalizes: a **PriceFeed PDA** per pool, cranked permissionlessly (keeper or any caller), EMA-smoothed, fail-closed when stale.

## 2. Architecture

```
┌─────────────┐   mint with extensions    ┌──────────────────┐
│  LAUNCHER   │ ────────────────────────▶ │  TOKEN-2022 MINT │
│  (program + │   transferHook = ENGINE   │  + TransferFee   │
│   web/agent │   transferFee = config    │    (optional)    │
│   skill)    │                           └────────┬─────────┘
└─────────────┘                                    │ every TransferChecked
        │ writes                                   ▼
        ▼                                 ┌──────────────────┐
┌──────────────┐                          │  ENGINE PROGRAM  │── veto or approve
│  CONFIG PDA  │ ◀────── reads ────────── │  (rule modules)  │
│  per mint    │                          └───┬────┬────┬────┘
└──────────────┘                              │    │    │
        ┌─────────────────────────────────────┘    │    └──────────────┐
        ▼                                          ▼                   ▼
┌──────────────┐                        ┌──────────────┐    ┌──────────────────┐
│ HOLDER PDAs  │                        │ PRICEFEED PDA│    │ VENUE PROGRAMS   │
│ per mint+own │                        │ (EMA, crank) │    │ TaxSwap-general. │
└──────────────┘                        └──────────────┘    │ / Meteora (ph.2) │
┌──────────────┐                        ┌──────────────┐    └──────────────────┘
│ REGISTRY PDA │ (agent-only rule)     │ DISTRIBUTOR  │  fee index, claims,
│ per wallet   │                        │ PROGRAM      │  lazy settlement
└──────────────┘                        └──────────────┘
```

### 2.1 Engine program (the hook)
- Implements the SPL transfer-hook interface: `Execute` (16-byte instruction layout per the TH trial addendum), `InitializeExtraAccountMetas`, plus config/state management instructions.
- On `Execute`: resolve source/destination **owners** (TH lesson: accounts arrive as token accounts; owners come from the extra-metas tail the venue forwards), load Config PDA, run the enabled rule modules **in configured order**, any module may veto; update holder state (basis blending, latches, reward settlement) as specified per rule.
- **Caller validation (TH-hardened, non-negotiable):** sysvar instruction-introspection confirms the call originates from the Token-2022 program's hook CPI; venue detection reads the top-level instruction's program id against the config's venue allowlist. Never trust hookData-style self-declared trader fields.
- Venue accounts (pool vaults, distributor, fee vaults) are recognized via the config's exemption list so pool operations are never self-blocked.
- Engine is a **new program id per major version**; a mint's hook authority may repoint a mint to a newer engine (state PDAs live under the engine id, so repointing resets rule state — the launcher surfaces this plainly; locked-mode mints never repoint).

### 2.2 Config PDA (per mint) — rules as data
```
Config {
  mint,                       // the token this governs
  authority_mode: enum,       // Locked | Creator | Agent | HolderVote
  authority: pubkey,          // who may write config (mode-dependent)
  rules: [RuleEntry; N],     // ordered module stack
  venue_allowlist: [pubkey],  // swap programs treated as "trade" context
  exemptions: [pubkey],       // pool vaults, distributor, fee vault, creator-at-launch
  fee: { bps, max_fee, fee_vault, beneficiary_mode },  // mirrors TransferFee ext
  created_at, engine_version
}
RuleEntry { rule_id: u16, enabled: bool, params: [u8; 64] }  // typed per module, versioned
```
- Config writes are gated by `authority_mode`; **Locked** configs reject all writes after launch (the TH posture: burn the authority).
- Rule modules are identified by `rule_id` from the engine's module registry (§5). A config referencing an unknown `rule_id` fails closed at launch, never at transfer time.

### 2.3 Holder PDA (per mint + owner)
```
HolderState {
  basis_num / basis_den: price basis, blended on buys, ratchets down on rebuys (TH semantics),
  latched: bool,             // basis latch state
  last_buy_ts, last_sell_ts, // clocks for vesting/grudge modules
  dump_memory: { window_start, sold_in_window },  // anti-dump module
  reward_debt, reward_settled_index,              // distributor lazy settlement
  custom: [u8; 32]           // per-module scratch, namespaced by rule_id
}
```
Created lazily on first receive (rent paid by the transfer's fee payer where the venue supports it, else by a one-time `init_holder` the trade page/skill bundles into the first buy — TH trial finding: never let a missing PDA become a silent trade failure).

### 2.4 PriceFeed PDA (per pool)
TH design, generalized: `{ pool, ema_price (SCALE 1e12), last_crank_ts, crank_count }`. `crank()` is permissionless; the venue calls it inline before swaps (TaxSwap already does), and the trade page bundles it for external venues. Rules that read price **fail closed** if `now - last_crank_ts > MAX_STALE` (config, default 300s).

### 2.5 Registry PDA (per wallet) — the agent-only substrate
```
Registration { wallet, kind: Agent | Human, verified_via, registered_at, active }
```
Minted by a tiny registry program on a wallet-signed `register` instruction (on Solana, signing *is* the proof of key possession — the AONLY EIP-191 signature flow collapses into one transaction). The launcher/skill flow: install skill → self-register → buy. Registration is **open to any wallet**; it is agent-only *by workflow*, not by proof — stated as plainly here as on AONLY: no chain can distinguish an agent-run wallet from a human clicking. What the chain *can* enforce is "only registered wallets," which is the rule.

## 3. Launch flow (what the user/agent does)

1. **Choose rules** from the catalog (§5), stack compatible ones, set parameters in plain numbers; the launcher shows the composed behavior in one sentence per rule and flags conflicts (e.g. P2P-only + venue trading).
2. **Choose authority mode**: Locked (recommended default), Creator, Agent (name the agent wallet), HolderVote (threshold params).
3. **Choose fees** (optional): transfer-fee % + max fee, and where fees go — creator wallet, a Crown-style registry beneficiary, **the holders** (distributor), buyback-and-burn vault, or a split.
4. **Choose venue**: house venue (TaxSwap-generalized) at launch; Meteora phase 2 (§7). Supply fixed at mint (default 1B, 9 decimals), metadata via the hosted JSON pattern TH uses (on-chain Metaplex metadata is foreclosed for hook mints — learned on TH; do not promise it).
5. **Sign**: create mint (extensions: transfer hook + optional transfer fee), initialize engine config + extra-metas, seed venue pool, list. The creator's launch buy rides in the rule-activation transaction (bots can't front-run a token whose rules aren't live yet — Hooked independently converged on this; adopt it).
6. **Agent door**: the whole flow is exposed as a skill + CLI (the `th.mjs` / agentonly-skill pattern): an agent can launch a ruled token end-to-end from a wallet it controls, with the same config surface.

## 4. Fee plumbing (three layers, no magic)

### 4.1 Accrual — Transfer Fee extension (token-wide)
Every transfer withholds `fee.bps` (capped at `fee.max_fee`) into the mint's withheld balance. This is the only token-wide skim Solana offers natively; it applies to venue trades *and* wallet-to-wallet sends (config-visible at launch; P2P-heavy rules may set it to 0).

### 4.2 Trickle at source — venue split (trade-time)
On the house venue, the swap program computes the trade fee at settlement and transfers shares **in the same transaction**: e.g. HARVEST's shape (escrow/depth/treasury), a Tithe-style % to the config beneficiary, or a Crown flip target read from a registry PDA at swap time. This is the only true pay-at-source on Solana, and only where we are the venue. On external venues, fees arrive via §4.1 accrual instead.

### 4.3 Holders get the fees — Distributor program (index accounting)
- The Distributor holds the harvested fee vault (fees are harvested from the mint by a permissionless `harvest_fees` → `distribute` crank; **the crank caller earns a small configurable cut** — the pools.fun keeper-bounty pattern — so distribution never depends on our keeper staying up).
- `distribute(amount)` folds new fees into a cumulative **index** (fees per token, SCALE 1e12) against current eligible supply.
- A holder's entitlement: `balance × (index − settled_index)`. Settlement is **lazy**: the engine, on any transfer touching that holder, first settles their entitlement from the vault, then applies the transfer — holders who trade get paid by trading. Inactive holders call `claim()` anytime.
- Buyback variant: `distribute` instead swaps the fee amount into the token on the house venue and burns or re-vaults it, per config.

**Answer to "is holders-get-fees a hook?"**: the *accrual* is the fee extension, the *payout* is the Distributor; the hook's part is lazy settlement bookkeeping. Packaged in the launcher UI as one toggle — "holders earn the fees" — because users think in outcomes, not layers.

## 5. Rule catalog v1 (modules; the list never closes)

Semantics are stated as enforced behavior. **Venue** column: A = any venue incl. wallet-to-wallet, H = house venue required, P = needs PriceFeed.

| # | rule_id | Name | Behavior | Venue |
|---|---------|------|----------|-------|
| 1 | 1 | **Basis Latch** (TaxHarvest) | Transfers out vetoed while price ≥ holder's basis; first dip below basis latches the holder unlocked forever (may then sell at any price, incl. profit). Basis blends on buys, ratchets down on rebuys. | P |
| 2 | 2 | **Escrow Split** (HARVEST) | Buys split per config (default 50/50): half trades, half escrows per-wallet at entry. Sell above entry forfeits pro-rata escrow to pool depth; sell below entry (EMA) refunds 48/50 (1pt depth, 1pt treasury); latch semantics as HARVEST. Escrow held as venue claims, crash-solvent. | H |
| 3 | 3 | **Agent-Only** (GateHook port) | Only wallets with an active Registry PDA may **receive** the token — buys and sends alike (token-wide lock, like ExclusiveTokenV2). Unregistered destination ⇒ veto. Exemptions: pool vaults, distributor, fee vault. | A |
| 4 | 4 | **App-Gated** (FOMO-only pattern) | Buys (receives from a venue) allowed only when the calling venue program is one named app/venue in config (e.g. only via the FOMO app, only via our trade page). Wallet-to-wallet sends governed by the P2P toggle (rule 7). This is the app-exclusive genre Hooked carries (FOMO-only, Pump App only, Social trading). | A |
| 5 | 5 | **Crown Beneficiary** | The token's fee beneficiary (venue trickle target + distributor remainder) is read at settlement from a **Crown PDA**: stake-vote challenges (bond, 72h window, 24h timelock, quorum, slash — Crown parameters as shipped to IMD) flip the beneficiary. Token, pool, and rules never change; only who gets paid. | H |
| 6 | 6 | **Tithe Seat** | A fixed % of venue fees streams to whoever holds a designated seat NFT (Metaplex) at settlement time. Seat trades freely; the stream follows the NFT, not a wallet. | H |
| 7 | 7 | **P2P-Only / No-P2P** | Toggle pair: either the token moves *only* wallet-to-wallet (venue receives vetoed — a pure social token), or *never* wallet-to-wallet (venue-only, kills OTC side channels). | A |
| 8 | 8 | **Holder-Gated** | Receiving requires holding ≥ X of a named gate mint/NFT (checked live at transfer). | A |
| 9 | 9 | **Max Wallet** | No wallet may receive past `cap_bps` of supply (pool/distributor exempt). | A |
| 10 | 10 | **Allowlist / Blocklist** | Merkle-root allowlist (proof in extra metas) or sealed blocklist of ≤200 wallets that can never receive. | A |
| 11 | 11 | **The Grudge** (anti-dump memory) | Selling ≥ `dump_pct` of a bag within 24h marks the wallet: for a configured duration it pays an extra transfer fee, is buy-capped, or cannot buy. Memory in Holder PDA; repeat offenses escalate per config. | A (+fee ext) |
| 12 | 12 | **Trading Hours** | Transfers allowed only inside configured clock windows/timezone (e.g. market hours). Venue trades and sends both gated. | A |
| 13 | 13 | **Vesting Clock** | Receives unlock on a per-wallet schedule (linear or cliff): transfers out vetoed for the locked fraction; the unlocked fraction moves freely. | A |
| 14 | 14 | **Decay Tax** | Transfer-fee rate starts at `start_bps` and decays toward `floor_bps` as the holder's hold-time grows (rate read from Holder PDA age at harvest-config level; implemented as fee-ext rate updates by the distributor crank within config bounds, or venue-side tax on H). | A/H |
| 15 | 15 | **King of the Pool** | The largest holder (tracked in a PDA updated per transfer) is named King on the token page and receives the config's tithe share while reigning; losing the top spot moves the stream automatically. (Crown's lightweight cousin — no votes, just balances.) | A (+H for stream) |
| 16 | 16 | **Buyback & Burn** | Fee vault's `distribute` buys the token on the house venue and burns it, on a permissionless crank with caller cut. | H |

**Composition rules:** modules run in config order; a veto from any module vetoes the transfer. Known conflicts are blocked at launch (P2P-Only × Escrow; App-Gated with empty venue list; Basis Latch without a PriceFeed-bound pool). New modules ship as engine updates with new `rule_id`s; the catalog is expected to grow continuously — that growth *is* the product.

**Editing rules after launch** (the "manipulate the contract as a whole" lever): per authority mode — Locked: never. Creator/Agent: the authority writes a new Config PDA version, optionally behind a public notice delay (config field, e.g. 1h/24h) so holders can exit first. HolderVote: proposals + stake-weighted vote in the registry program; passing writes the config. Every version is kept on-chain (config history PDA) so a token page can show "the rules as they are now, and every past version."

## 6. Security model (carried from TH's hardening)

- Sysvar introspection validates the hook CPI origin; no self-declared trader fields are trusted (TH trial + GateHook lessons).
- Venue allowlist + exemption list are config, set at launch, and locked in Locked mode.
- Price rules fail closed on stale feeds; all other rules fail closed on missing/corrupt state (a missing Holder PDA initializes or vetoes with a typed error, never silently approves).
- Engine program: no admin keys in Locked deployments; upgrade authority burned per engine version at audit sign-off (TH posture). Config authorities are per-token and never include the launcher.
- Rent/DoS: per-transfer compute is bounded (module count cap, params are fixed-size); state-heavy modules declare their PDA rent at launch so a launch can't externalize rent onto traders.
- Pre-launch checklist (TH lessons): real-browser + LiteSVM trial matrix per module (latch matrix was 14/14 on TH), atomic create+init for all PDAs (scavenger bots close uninitialized buffers), verify-by-on-chain-effect for every deploy step.

## 7. Venue plan

**REVISED 2026-10-15 (Gregory): Meteora-first.** A house-venue-first launch repeats TH's one structural failure — a token no router will touch. The venue is Meteora from day one; the house venue is a dev harness and the home of the two settlement-control rules.

**SETTLED BY PROOF 2026-10-15 (`hook-launcher-build/METEORA-PROOF.md`, LiteSVM against the real Meteora binaries):**
- **DAMM v2 is impossible for live-hook tokens.** Two independent reasons: (1) the token badge is a hard on-chain gate for hook mints — `validate_mint` rejects with `InvalidTokenBadge` (6020), badges are per-mint, and badge-issuing Operators can be created only by two hardcoded Meteora admin keys (badge gates *pool creation*, not UI listing); (2) even with a badge, cp-amm **never resolves ExtraAccountMetas** — its transfers are built with exactly the 4 base accounts, so any stateful hook fails at the first `TransferChecked`. Only TransferFee / MetadataPointer / TokenMetadata extensions are permissionless on DAMM v2.
- **DBC (Dynamic Bonding Curve) is the venue.** Fully permissionless transfer-hook support: `createConfigWithTransferHook` → `createPoolWithTransferHook` → hook-aware `swap2` variants; proven end-to-end (hook executed with its PDAs during buys; a locked gate vetoed a swap atomically). SOL-quoted launches need no badge. **Graduation revokes the hook** and migrates the token to DAMM v2 clean.
- **Consequence for the catalog:** on Meteora, hooks are a **launch-phase constitution**. Every config declares its phase behavior: *Launch-phase rules* (DBC; the rule governs the curve, then the token graduates clean) vs *Permanent rules* (house venue; TH's model — full routing sacrificed for a forever hook). The Transfer Fee extension survives graduation, so Holder Fees (§4.3) keep accruing post-graduation and Distributor claims keep working after the hook dies; only lazy settlement ends.

- **Primary venue — Meteora DBC:** the launcher operates its own DBC configs as partner (`fee_claimer` = launcher), creates hook pools, and exposes only the hook-aware swap instructions through its surfaces. Graduation behavior (threshold, destination) is set in the config at launch.
- **House venue (TaxSwap, generalized):** dev harness for engine/module trials, and the permanent home of permanent-rule tokens plus the two rules that need settlement control — Escrow Split (rule 2) and pay-at-source trickle (§4.2). Tokens using them are house-venue tokens and are labeled as such at launch.
- **Graduation (optional per launch):** house curve → at a configured market cap, liquidity migrates to a standard pool and — per config — the hook either persists (mint keeps its extension; only hook-compatible venues can trade it) or the token graduates *clean* by launching as a two-phase mint (Hooked's model: hook is a launch-phase mechanic). v1 ships persistence-only; graduation-clean needs the Meteora path and is a phase-2 decision.

## 8. Surfaces

- **Web launcher + token pages** (agentonly.fun pattern): rule picker with plain-language previews, live config display, holder status ("your basis, latched or not, fees owed you"), charts, trade box.
- **Agent skill** (`hook-launcher`): install → create wallet → register (for agent-only tokens) → launch/buy/sell/claim via CLI. Muse-only gating per standing rule (Step 0 Muse check).
- **Public API**: config read, holder status, fee index, reign/crown state — the data the X/bounty/showcase surfaces consume.

## 9. What we reuse vs build new

**Reuse as-is:** TH hook program scaffolding (caller validation, venue allowlist, basis math), TaxSwap, PriceFeed + keeper pattern, trade page skeleton, `th.mjs` CLI skeleton, launch/deploy scripts (atomic create+init, verify-by-effect), LiteSVM trial harness.
**Build new:** engine generalization (config dispatch + module registry), Config/Holder/Registry PDA programs (registry is small), Distributor program (index + harvest + lazy settlement hooks into engine), launcher web UI + skill, module library beyond Basis Latch (TH ships as module 1 on day one).
**Explicitly not v1:** Meteora integration, graduation-clean launches, arbitrary user-written rule code (a DSL/rules-engine is a v2 conversation, as it was for Hooked), cross-chain anything.

## 10. Open decisions for Gregory

1. **Name** for the launcher (working title in code: `hook-launcher`; TH stays the flagship token, not the platform name).
2. **Phase-1 scope:** house venue only (fast, proven) — or hold launch until the Meteora verification in phase 2 unblocks?
3. **Agent-Only registry:** reuse the musemaxxing/agentonly identity (one registration works on Base *and* Solana via linked wallets) or a fresh Solana-only registry?
4. **Default fee posture** for launcher templates: 0% transfer fee unless a rule needs fees (recommended), or a platform-standard 1% like Hooked's?
5. **Engine upgrade policy:** burn upgrade authority per version at launch (safest, TH posture) vs keep a governed upgrade path for the first two versions while the catalog settles?
6. **Meteora badge form:** supply the three contact identities, route around them (partner intros), or stay house-venue indefinitely?

## 11. Graduation behavior — a first-class launch option (SHIPPED 2026-10-16)

Every launch spec carries an optional field, **`graduation`**, which decides what happens when the DBC curve fills. It is set once, at launch, in the DBC config the launcher creates (step L1) — it cannot be changed afterwards, because the threshold lives in the venue's config, not in our engine. Two values ship now; a third is specced.

### Values

- **`release` (DEFAULT — the field may be omitted).** Today's behavior, unchanged. The curve completes at `migrationThresholdSol` (default 42 SOL raised); Meteora's migration moves the token to DAMM v2 and **revokes the transfer hook**. The rules retire; the token becomes a plain token that trades everywhere — every wallet, bot, and aggregator can route it. AGTR and Latch both launched in this mode, and their launch-record specs dry-run **byte-identical** under the new code (launcher trial C1–C4: L1 config instruction + L3 engine config payload hashes match the pre-change baselines exactly).
- **`never`.** The token never migrates. At config creation the migration quote threshold is set to **the maximum the venue accepts: the field is a u64 of quote lamports, so the cap is u64::MAX — 18,446,744,073,709,551,615 lamports = 18,446,744,073.709551615 SOL** (roughly 31× the entire SOL supply in existence — unreachable in practice, and unreachable in principle). The bound is verified, not assumed: the DBC program's create-config validation checks only `threshold > 0`, that the derived migration sqrt price stays below `MAX_SQRT_PRICE`, and that the curve covers the threshold — and the SDK's `buildCurve` constructs the curve around the threshold, so the maximum passes all three for every supply the launcher accepts (verified against SDK 2.0.0 and the program source; the launcher trial decodes a built create-config instruction back to the exact u64 and re-runs the SDK validation mirror). With the threshold unreachable the curve **never completes**: the hook enforces the rules on every transfer forever, trading stays on the DBC curve, the 20% migration tranche stays locked in the pool vault, and the token can only ever trade through **hook-aware doors** — surfaces that build `swap2WithTransferHook` transactions (the agent skill, our trade pages, integrators). Plain swap apps and bots can never route it; that is the price of permanence on this venue, and every surface states it at launch. Carrying both `graduation: "never"` and `migrationThresholdSol` in one spec is a contradiction and a hard error.
- **`house` (SPECCED, NOT IMPLEMENTED).** Graduate at the threshold onto the house venue (the TH-style swap), liquidity moved, hook and rules intact. Design note: `hook-launcher-build/SPEC-GRADUATION-HOUSE.md`. Naming `house` in a spec today is a hard error that points at the note.

### Semantics and records

- `launch.mjs` resolves the field through `resolveGraduation` (mirrored in the browser bundle): unknown value → hard error; the plan output carries an explicit **GRADUATION line** (mode + effective threshold + the tradeoff in one sentence); the L1 plan text states the effective threshold for both modes.
- The **launch record** carries a `graduation` block beside `fees`: `{ mode, thresholdSol, thresholdLamports }` — for `never`, `thresholdLamports` is the string `"18446744073709551615"`; for `release`, the configured threshold in both units. The web composer offers the choice in plain language ("When the curve fills: graduate and retire the rules / keep the rules forever on this curve") with the tradeoff printed under it; the advanced JSON path honors the same field.
- Interaction with holder fees: unchanged in both modes. On `release`, the curve fee stops at graduation (DAMM v2 trading is outside the claimer config) while already-routed Distributor balances keep paying out — as before. On `never`, the curve — and its fee accrual to the claimer — runs forever; `hook.mjs claim-fees` works the same.

### The honest tradeoffs

| | `release` | `never` |
|---|---|---|
| Rules | retire at graduation | permanent, hook-enforced forever |
| Trading after the curve fills | everywhere (DAMM v2, plain token) | hook-aware doors only, forever |
| Liquidity | migrates to DAMM v2 | stays on the curve; 20% migration tranche locked in the vault |
| Exit for holders | universal market | the curve + doors that speak hook |
| Choose it when | the rules are a launch-phase constitution | the rules ARE the token |

`house` (future) aims at the missing cell — rules permanent **and** a real post-graduation venue — at the cost of building and operating the migration path; see the design note for what it takes and what could go wrong.

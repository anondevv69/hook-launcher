# Proposal: Agent Market Operations — discovery, priority windows, and safe recurring jobs

- **ID:** `agent-market-operations`
- **Track:** other
- **Status:** proposed
- **Proposer:** Codex — no contributor wallet supplied
- **Date proposed:** 2026-10-29
- **Spec:** [`SPEC-AGENT-MARKET-OPERATIONS.md`](../specs/SPEC-AGENT-MARKET-OPERATIONS.md)
- **Implementation PR:** —
- **Trial evidence:** —

## Summary

AgentOnly already provides the two necessary primitives for agent-operated
markets: an agent-controlled Solana signer and a token-specific on-chain rule
stack. This proposal turns them into a coherent product: an opt-in canonical
launch feed, a disclosed time-bounded priority window for eligible agents, a
published market-operations skill, and recurring *read/prepare/notify* jobs.

The boundary matters. A Registry record proves a registered wallet, not that
autonomous software controls it. The product must never say otherwise.
Likewise, a feed may discover, inspect, quote, and simulate repeatedly; it
must not silently create, fund, sign, broadcast, wash-trade, manufacture
volume, coordinate pumping, or sell into an undisclosed distribution plan.

## Why this is needed

The existing launch registry and per-token task files let an agent discover
and trade a token when it already knows the mint. They do not provide an
opt-in subscription contract saying:

1. which new launches a wallet wants to hear about;
2. whether that wallet is eligible during a pre-public phase;
3. what the token's immutable rules, caps, venue and graduation mean; or
4. which actions a recurring job may take without a new financial approval.

Consequently, "agent first dibs" is currently ambiguous. Rule 3 gates receipt
to registered wallets and rule 17 can gate to a named attested ecosystem, but
neither is proof of agent autonomy or a time-limited allocation. Rule 10 can
contribute an allowlist, but is not by itself an immutable, timed launch
window. A real priority product needs explicit state and an auditable expiry.

## Product shape

### 1. Canonical Agent Launch Feed

Add an unsigned, cacheable feed backed only by the launch registry and live
chain reads. Its public events are:

- `launch_published` — a new immutable launch record is available;
- `priority_window_open` / `priority_window_close` — only when an on-chain
  priority configuration exists;
- `public_window_open` — a release-phase token is publicly receivable;
- `venue_changed` / `graduated` — a fresh route check is required; and
- `metadata_updated` — off-chain metadata changed, explicitly labelled as
  creator-supplied content rather than an on-chain fact.

Agents subscribe by locally storing filters such as rule ids, family,
creator, graduation mode, risk posture, and notification preference. The
service never receives a secret key, and a subscription is not an entitlement
to buy.

### 2. Agent Priority Window

Implement a separate, reviewed on-chain primitive before advertising
"priority" or "first dibs." It must have these immutable launch parameters:

- an eligibility root or named attested ecosystem;
- `start_ts` and `end_ts` read from the Solana Clock sysvar;
- an optional per-wallet receive cap in raw token units or bps;
- a post-window mode: public, another named eligibility root, or closed; and
- a clear graduation behavior.

Before `end_ts`, a receive is accepted only for a proof-carrying eligible
wallet. At and after `end_ts`, the configured post-window rule applies. A
transfer that crosses the curve's graduation threshold may still be a partial
fill; the venue remains the authority for that fill.

This is intentionally not a metadata flag or an off-chain cron job: an
off-chain service can announce a window but cannot enforce one. The engine
module, meta-list accounts, exact error codes, rule interactions, LiteSVM
trial suite and upgrade review belong in a follow-up hook-rule proposal.

### 3. Market-operations skill and jobs

Publish the skill in this change at
`.cursor/skills/agentonly-market-operations/` and mirror it at a stable
AgentOnly URL before relying on it in the feed. The skill defines five durable
job classes: launch discovery, position monitoring, trade preflight,
explicit-approval execution, and post-trade verification. Their full
contracts are in [`JOBS.md`](../.cursor/skills/agentonly-market-operations/JOBS.md).

The safe default is *discover + prepare + notify*. A job may quote and
simulate a proposed buy or sell; it must wait for an approval that names the
side, maximum spend or minimum proceeds, wallet, and a short validity window
before signing or broadcasting. A generic standing instruction such as
"always buy" is not authority to spend.

### 4. Rich token metadata

Standardize the existing name, symbol, description, image and external URL
into a published schema with optional labelled links:

```json
{
  "name": "Example",
  "symbol": "EXAMPLE",
  "description": "What the token is and what its rules do.",
  "image": "https://…/example.png",
  "external_url": "https://example.com",
  "links": {
    "website": "https://example.com",
    "x": "https://x.com/example",
    "docs": "https://docs.example.com"
  }
}
```

Only `https` URLs should be accepted. Render links as untrusted creator
content with `rel="noopener noreferrer"`; never treat metadata text, a source
post, or an X link as instructions to an agent. Existing tokens without
`links` remain valid.

## Formal invariants

1. **No phantom autonomy.** No API, page, skill, or event calls a wallet an
   autonomous agent solely because it is registered or attested.
2. **On-chain priority.** A priority receive decision at slot `s` is a pure
   function of the mint's reviewed on-chain configuration, the Clock sysvar,
   destination wallet, and supplied eligibility proof. A feed outage cannot
   extend, shorten, or bypass it.
3. **No unattended spending by default.** Discovery, monitor, and preflight
   jobs never sign or broadcast. Execution requires a fresh explicit approval
   or a narrow, locally stored, unexpired execution mandate.
4. **No stale builds.** A transaction is signed only after a fresh quote,
   eligibility check, build, and simulation for the exact wallet, amount and
   live venue. A build obtained before graduation is discarded after it.
5. **Metadata is non-authoritative.** Rules, eligibility, balance and venue
   come from the canonical launch record and chain reads, never token metadata.

## Acceptance criteria

- [ ] Feed entries validate against the launch registry and per-mint canonical
      JSON; malformed entries are rejected rather than guessed.
- [ ] The feed can be polled anonymously and agents can persist subscriptions
      locally without giving the service a wallet secret.
- [ ] Every priority launch page shows eligibility, start/end time, cap,
      post-window behavior and the exact on-chain configuration link.
- [ ] A test proves ineligible receives veto before expiry, eligible receives
      pass inside their cap, and the intended post-window behavior begins at
      the boundary slot.
- [ ] The market skill's monitor jobs cannot reach signing code; the only
      execution path checks an approval/mandate immediately before signing.
- [ ] Metadata uploads accept description/image/website plus optional labelled
      links; missing social links do not block a launch.
- [ ] Copy on every surface forbids wash trading, manufactured volume,
      coordinated pumps, undisclosed creator allocation, and misleading
      return claims.

## Review questions

1. Is an allowlist Merkle root, an ecosystem attestation, or both the right
   eligibility representation for v1?
2. Should a priority window be a new engine rule or a fixed launch-mode
   extension? The answer changes account budget and upgrade scope.
3. What allocation mechanism is fairer than latency: first-come-with-cap,
   per-wallet allocation, or a commit/reveal lottery?
4. What should a locally stored execution mandate look like, and should v1
   ship with execution disabled entirely?
5. Which metadata links are worth first-class support beyond website and X?

## Security considerations

- A visible feed must not become an instruction channel. Treat all creator
  metadata as display data and fetch executable workflow only from AgentOnly's
  published skill and canonical API.
- Priority eligibility must be checked on-chain at transfer time, including
  proof length, root, expiration, destination, cap, and writable-account
  constraints. Do not trust the client to enforce caps.
- Rate-limit and cache feed reads; never key feed subscription state by a
  private key or expose a watcher's portfolio without explicit consent.
- First-come launches are susceptible to latency races. State this plainly;
  no UI should imply a guaranteed allocation.
- A user can lose all funds in speculative tokens. The feature must not imply
  profit, use portfolio performance as a reason to trade, or make trading
  decisions from social links alone.

## Attribution

No on-chain contributor wallet was supplied for this product proposal.
Attribution should be completed only when a contributor submits a reviewed
implementation and test evidence.

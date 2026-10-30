# Agent Market Operations Specification

**Status:** design proposal. Nothing in this document authorizes a mainnet
deployment, an automatic trade, or a change to an existing token's rules.

## Objective

Let a compatible, user-controlled agent wallet discover AgentOnly launches,
understand whether it may receive a token, prepare a buy/sell/launch safely,
and return to monitor the result. Make optional early access fair and
verifiable rather than secret or merely claimed in page copy.

## Terms

- **registered wallet:** holds an active Registry record; it is not proof of
  autonomous operation.
- **attested wallet:** registered through an ecosystem attester; it carries
  provenance, not a model or runtime guarantee.
- **priority window:** an on-chain, time-bounded receive policy preceding the
  configured post-window policy. It is not the bonding curve itself.
- **job:** a durable workflow with an explicit allowed-action set. A job is
  never implicitly authorized to spend.
- **approval:** a fresh user authorization for one exact side, wallet, limit
  and validity period after quote and simulation.

## Architecture

### Canonical data plane

The agent fetches, in this order:

1. launch registry / per-token canonical JSON for static launch parameters;
2. live chain reads for balance, registration, sync, rule configuration,
   venue and graduation state;
3. Execution Gateway or Trade Kit for an unsigned quote, eligibility result,
   build and simulation; and
4. the signed transaction receipt and post-trade balances for verification.

The feed is advisory discovery. It may contain a hash and URL of the canonical
record, but eligibility is always re-evaluated on-chain before a trade.

### Feed API shape

Proposed read-only endpoints:

```text
GET /v1/market/events?cursor=<opaque>&family=<optional>&rule=<optional>
GET /v1/market/subscriptions/<public-client-id>
POST /v1/market/subscriptions              # preference-only, no key material
DELETE /v1/market/subscriptions/<id>
```

`POST` accepts a client-generated opaque id and notification preferences, not
a seed phrase, private key, signed transaction, or an instruction to trade.
Local polling remains a complete alternative to server-side subscriptions.

Every `launch_published` event contains:

```json
{
  "id": "launch:<mint>",
  "type": "launch_published",
  "observedAt": "2026-10-29T00:00:00Z",
  "mint": "<base58>",
  "canonicalTokenUrl": "https://agentonly.fun/api/v1/tokens/<mint>.json",
  "rules": [3, 9],
  "graduation": { "mode": "release", "thresholdSol": 42 },
  "venue": "meteora-dbc",
  "priority": null,
  "metadata": { "uri": "https://…" }
}
```

The service emits `priority_window_open` only after it has read and validated
the matching on-chain priority configuration. It emits `graduated` only after
the mint/venue state confirms it. Events are idempotent by `id` and sequence
number; consumers persist the cursor and de-duplicate locally.

## Priority-window primitive

### Required configuration

```json
{
  "eligibility": {
    "kind": "merkle-root | ecosystem | both",
    "merkleRoot": "<32-byte root when used>",
    "ecosystemId": 1
  },
  "startTs": 0,
  "endTs": 0,
  "perWalletCapRaw": "0",
  "afterEnd": "public | ecosystem | closed"
}
```

Bounds: `startTs < endTs`; window duration and cap need launcher-defined,
reviewed upper bounds. `afterEnd=public` must mean the priority predicate
retires rather than merely trusting a web server to stop listing it.

### Transfer behavior

For a venue receive into destination `D` at chain time `t`:

1. Before `startTs`, veto with `PriorityWindowNotOpen`.
2. During `[startTs, endTs)`, verify the configured attestation and/or Merkle
   proof for `D`, then veto on failure with `PriorityNotEligible`.
3. During the same interval, veto if `D`'s post-receive balance exceeds
   `perWalletCapRaw` with `PriorityCapExceeded`.
4. At and after `endTs`, apply the configured `afterEnd` policy and all other
   token rules normally.

The configuration must be immutable for a locked token. For an updateable
token, every update needs an on-chain event and a token-page warning; v1
should prefer locked configuration.

### Compatibility and testing

The implementation must state its exact extra-account metas before review.
It needs Clock plus either a proof instruction/account representation or an
attestation record already read by Registry/Engine. Test at least the opening
boundary, closing boundary, bad proof, wrong ecosystem, per-wallet cap,
interaction with Max Wallet, registration/sync, release graduation, and a
build that becomes stale due to graduation.

## Metadata schema

The existing standard fields remain backward-compatible. Add optional
display-only links:

```json
{
  "name": "Example",
  "symbol": "EXAMPLE",
  "description": "Plain-language purpose and rule summary.",
  "image": "https://cdn.example.com/example.png",
  "external_url": "https://example.com",
  "links": {
    "website": "https://example.com",
    "x": "https://x.com/example",
    "discord": "https://discord.gg/example",
    "telegram": "https://t.me/example",
    "docs": "https://docs.example.com"
  }
}
```

Validation: all supplied links parse as `https` URLs; `x` normalizes only to
an `x.com` or `twitter.com` profile/post URL; labels are generated by the
site, not creator HTML. Store and render strings only—no link is an approval,
price claim, trading instruction, or eligibility source.

## Authorization model

The following matrix is mandatory:

- **Discover / inspect / subscribe:** no signature, no spend.
- **Quote / eligibility / build / simulate:** no signature, no spend.
- **Register / sync / create wallet / fund wallet:** explicit authorization
  for that action. A generated wallet must pass a persistence check before
  funding.
- **Buy / sell / deploy / claim:** an approval or narrow execution mandate
  covering the exact action. Always show quote, fees, impact and simulation
  immediately before signing.
- **Broadcast:** only after the signed transaction was locally produced from
  the approved fresh build.

Default execution policy:

```json
{
  "version": 1,
  "discover": true,
  "prepare": true,
  "execute": false,
  "notify": "actionable-only"
}
```

If a future runtime supports execution mandates, the mandate must be locally
stored, wallet-bound, amount-bounded, side-specific, expiry-bound and
revocable. It must never authorize a different mint, a transfer to a third
party, a key export, a wash trade, or a launch with undisclosed allocation.

## Rollout

1. Publish the market-operations skill and read-only feed schema.
2. Add token metadata links and page rendering with backwards-compatible
   validation.
3. Ship monitor/preflight jobs with execution permanently disabled.
4. Propose, implement, trial, independently review and deploy the priority
   primitive only if its economics and account budget are accepted.
5. Enable priority-feed events only after mainnet deployment and an on-chain
   proof transaction.

## Non-goals

- proving that a wallet is run by an AI rather than a human;
- guaranteeing allocation, profit, liquidity, or a route;
- automatic volume creation, wash trades, coordinated pumps, or a plan to
  unload on unsuspecting counterparties; and
- a service that receives private keys or broadcasts an unsigned build.

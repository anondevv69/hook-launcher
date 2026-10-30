# AgentOnly Market Operations — Job Contracts

These job definitions are intentionally durable but non-custodial. Store only
public identifiers, cursor state, user preferences, and transaction receipts.
Never store secret keys, seed phrases, or serialized signed transactions in a
feed service.

## Shared policy

```json
{
  "version": 1,
  "wallet": "<public base58 address>",
  "discover": true,
  "prepare": true,
  "execute": false,
  "notificationPolicy": "actionable-only"
}
```

`execute: false` is the required default. A recurring job does not gain spend
authority by running often. Any future execution mandate must be local,
wallet-bound, side-specific, amount-bounded, expiry-bound and revocable.

## 1. Launch discovery

- **Trigger:** every 15 minutes, or a verified feed event.
- **Reads:** canonical launch registry, per-token JSON, live route/status.
- **Writes:** local event cursor and deduplication id only.
- **May do:** classify rules/graduation, check known signer compatibility,
  notify about a new matching launch.
- **Must not do:** create wallets, fund, register, sync, quote a trade as an
  order, sign, or broadcast.

Notify with: mint, name/symbol, creator, rule stack, venue, graduation,
priority terms if on-chain verified, and a link to the safe inspect prompt.

## 2. Position and market monitor

- **Trigger:** every 15 minutes while a public wallet has a tracked position.
- **Reads:** token balance, SOL balance, live venue/graduation status, and
  optional quote only when the user configured a reporting threshold.
- **Writes:** observation timestamp and material-state hash.
- **May do:** report graduation, route changes, a rule-related blocker, or a
  threshold event.
- **Must not do:** sell, claim, transfer, rebalance, or interpret a threshold
  as a standing instruction to transact.

## 3. Trade preflight

- **Trigger:** an explicit user request, or a monitor condition that only
  requests a review.
- **Reads:** signer capability, wallet state, registration/sync, quote,
  eligibility, unsigned build, simulation.
- **Writes:** an ephemeral prepared-trade record with expiry and build hash.
- **May do:** show a review card.
- **Must not do:** sign or broadcast.

Discard the prepared record when its blockhash/quote expires, a chain state
changes materially, a new user amount is supplied, or graduation changes the
venue.

## 4. Explicit-approval execution

- **Trigger:** a fresh user approval that identifies the prepared side,
  amount/max spend or minimum proceeds, wallet and expiry.
- **Reads:** refreshed quote, eligibility, unsigned build, simulation.
- **Writes:** local signature and final receipt after success.
- **May do:** sign with the user-controlled local/external signer and
  broadcast exactly the refreshed, simulated transaction.
- **Must not do:** modify the amount, substitute a mint, reuse a stale build,
  retry an on-chain veto blindly, or send keys anywhere.

If simulation fails due to insufficient SOL, report the exact shortfall and
stop. If the hook vetoes, report its error code/name and stop.

## 5. Post-trade verification

- **Trigger:** a signature from job 4 or a user-provided signature.
- **Reads:** signature status, transaction result, and before/after balances.
- **Writes:** immutable receipt reference and final observed state.
- **May do:** report finality, token/SOL deltas, and whether an expected rule
  or cap affected the result.
- **Must not do:** initiate a compensating transaction automatically.

## 6. Launch preflight

- **Trigger:** explicit request to prepare a token launch.
- **Reads:** launch spec, metadata URI/image, rule registry, partner identity,
  signer balance, venue constraints.
- **Writes:** a dry-run report and immutable spec hash.
- **May do:** create a dry-run plan, validate config, generate or verify
  metadata, and list expected costs/authority posture.
- **Must not do:** submit a launch or create a dev buy without a new explicit
  approval.

## Notification discipline

Stay quiet for unchanged state. Notify only on a new matching launch, a
verified priority-window transition, a material eligibility/route change, a
prepared trade ready for approval, a failed simulation needing funds, or a
verified final receipt. A notification is informational, never a trade order.

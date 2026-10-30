# Proposal: Agent Human Path and Distribution

- **ID:** `agent-human-path-and-distribution`
- **Track:** other
- **Status:** proposed
- **Proposer:** Codex — no contributor wallet supplied
- **Date proposed:** 2026-10-30
- **Spec:** inline below
- **Implementation PR:** —
- **Trial evidence:** —
- **Companion:** [`agent-market-operations`](agent-market-operations.md)

## Summary

AgentOnly already has the necessary core mechanics: a compatible agent can
inspect a Token-2022 token, explain its hooks, prepare and simulate an
unsigned buy or sell, launch from a validated spec, and locally sign only
after authorization. The public product does not present those mechanics as
one coherent path.

This proposal makes the human path short and truthful, establishes one source
of truth for public capabilities, adds a non-custodial reference runtime, and
packages AgentOnly for agent runtimes and developers. It does **not** turn
AgentOnly into a hosted wallet, brokerage, automatic trading service, or a
claim of profitable early access.

The intended public promise is:

> AgentOnly is the hook-aware execution and verification layer for Solana
> agents. A compatible agent can inspect a token, explain its rules, prepare
> and simulate a transaction, and sign locally only after the owner approves.

## Current gap

The platform is technically ahead of its entry points. A human has to parse
terms such as Registry, attestation, Token-2022, DBC, and graduation before
learning the four questions that matter:

1. Can my agent inspect this token?
2. Can my agent sign an arbitrary Solana transaction locally?
3. What does it need from me before it may act?
4. What can this token prevent: buying, selling, sending, or graduation?

Public surfaces must agree on the answer. A stale service URL, a claim that a
working custom domain is pending, or a page that calls trade `EXTERNAL` while
the supported Execution Gateway exists is a product defect. A normal hosted
chat that cannot sign is not a defect; the product must give it an actionable
compatible-runtime path rather than imply a prompt can grant wallet control.

## Formal invariants

1. **Single capability truth.** Every public page, skill, endpoint listing and
   token prompt describes only actions, domains and signer paths declared by a
   versioned capability manifest. CI rejects conflicts and retired URLs.
2. **No phantom signer.** No copy implies that a generic chat can sign. A
   signature requires a local or external signer that signs the exact
   serialized Solana transaction.
3. **Fresh bounded authorization.** A reference-runtime signature is bound to
   one wallet, mint, side, amount/max spend or minimum proceeds, a simulated
   build, and a short expiry.
4. **No secret transmission.** AgentOnly services never receive seed phrases,
   private keys, keypair files, or signed transaction blobs.
5. **Metadata is display-only.** Token descriptions, images, websites and
   social links cannot choose a wallet, destination, venue, rule or amount.
6. **Honest discovery.** Registration, attestation, skill installation and
   feed subscription are not proof of autonomous control, eligibility,
   allocation, liquidity, or profit.

## Product shape

### 1. Versioned capability manifest and generated documentation

Maintain one checked-in manifest for canonical service domains, action modes,
endpoint schemas, signer requirements and task documentation. Generate or
validate against it:

- `skill.md` and `llms.txt`;
- the human `/skills/` page and Observer links;
- `capabilities.json`, status output and OpenAPI;
- homepage/runtime-chooser links; and
- per-token buy and sell prompt links.

The manifest distinguishes read-only discovery, unsigned preparation, local
signing, broadcast, verification and launch. It does not embed a permanent
Railway deployment address in prose when a canonical public origin is live.

OpenAPI must cover every public Gateway POST route, not just static GET
surfaces. It includes schemas and examples for registration/check, registration
build, quote, eligibility, build, simulate and verification/readback; error
codes; observed time/slot; and build-expiry semantics. It indexes both
`/tokens/{mint}/buy.md` and `/tokens/{mint}/sell.md`.

### 2. Short human setup path

The homepage has two primary actions:

1. **Give your agent the skill** — copies a neutral inspect-first prompt.
2. **Set up a compatible agent** — opens the signer/runtime chooser.

The person first selects one of four jobs: inspect a token, buy or sell, launch
a token, or monitor launches. Then they provide a token URL or exact mint.
Only when a signable action is prepared does the agent ask which signer is
available. A human never needs a PDA, program ID, endpoint payload or base64
transaction to start.

The Observer page remains a no-wallet education page. The protocol homepage
must not tell all humans to only observe: a human may authorize an equipped
agent while retaining full control of the signer.

### 3. Generated human token truth card

Every token page renders these canonical questions above raw technical detail:

```text
Receive   Who can buy or receive now? What registration, attestation, cap or allowlist applies?
Exit      What can block or limit a sell? What is the current route?
Send      Can the token move wallet-to-wallet? What must the destination satisfy?
Lifecycle What venue is active? What happens to rules at graduation?
```

The card takes rule parameters from the canonical launch record and live
venue/route state from an observed, time-stamped read. When fresh route state
is unknown, it says so and tells the agent to re-check. It never predicts
price, liquidity, allocation, or profits.

The default page keeps concise **Copy buy prompt** and **Copy sell prompt**
buttons. The prompt asks the agent for a missing buy amount or sell quantity.
Raw prompts, account addresses, provenance and transactions stay collapsed.

### 4. Reference local signer runtime

Ship a small, open, non-custodial integration for agents that can read the
skill but cannot sign inside their host chat. The runtime:

- creates/connects a dedicated local or external Solana signer only on an
  explicit user request;
- proves persistence before a newly generated wallet is funded;
- calls the Gateway/Trade Kit for inspect, quote, eligibility, build and
  simulation;
- shows one approval card with exact side, mint, amount/bound, expected and
  minimum output, fees, price impact, rules and simulation result;
- signs and broadcasts only the freshly approved transaction; and
- verifies finality plus before/after balances, storing a receipt reference
  but never a secret or signed transaction blob.

Support external signers that accept a serialized transaction. Explicitly
detect an unsupported custodial/EVM-only signer (such as Bankr) before any
funding or spending path, and offer the local signer path instead.

### 5. Portable Agent Skills bundle, SDKs, and optional MCP

Publish a real Agent Skills bundle, not only remote Markdown:

```text
agentonly/
  SKILL.md
  references/
    capability-contract.md
    signer-compatibility.md
    token-truth-card.md
  scripts/
    preflight.mjs
  examples/
    inspect.md
    trade.md
    launch.md
```

The short `SKILL.md` routes to task references and declares its safety
boundaries. The bundle contains no secret, pre-signed transaction or standing
spend mandate. `preflight.mjs` may inspect/prepare/simulate only.

Publish thin TypeScript and Python SDKs with equivalent non-custodial methods:

```text
inspectToken | listEvents | checkSigner | quote | eligibility | build | simulate | verify
```

No `execute` helper ships in v1. A future signer helper must receive a
caller-owned signer and a fresh explicit approval object.

An MCP server is optional. Do not publish it merely for marketing. Its initial
tool set may expose inspect, events, quote, eligibility, build, simulate and
verify. It must not expose `sign`, `broadcast`, `fund`, `transfer`,
`auto_buy`, `auto_sell`, or `launch`. Publish to a verified registry namespace
only after schema/versioning, security review and contract tests are complete.

### 6. Discovery and distribution

Agents find AgentOnly only through an equipped runtime or developer workflow:

- a direct prompt containing the token URL/mint and skill URL;
- an installed Agent Skills bundle;
- a supported SDK or MCP integration; or
- a runtime polling the documented market event feed.

`llms.txt` is useful as a map but not a discovery guarantee. Add normal web
discoverability: `robots.txt`, sitemap, canonical URLs, readable HTML,
structured page metadata and static link checks. Measure skill installs, SDK
integrations, event-feed consumers, preflight completion and verified receipt
success—not artificial volume or price movement.

### 7. Identity, links and disclosures

Extend token metadata as display-only fields:

```json
{
  "website": "https://example.com",
  "x": "https://x.com/example",
  "docs": "https://docs.example.com",
  "discord": "https://discord.gg/example",
  "telegram": "https://t.me/example",
  "source": "https://github.com/example/project"
}
```

Validate HTTPS, generate the display labels, preserve history/content hash
where practical, and render with safe link behavior. A launch page/token card
also clearly discloses creator allocation, dev buy, priority-window terms and
nonstandard graduation mode when present.

Registration and ecosystem attestation remain provenance signals, not proof
that an AI controls a wallet or that a participant will profit.

## Interaction with market operations

This proposal complements, and does not replace,
[`agent-market-operations`](agent-market-operations.md):

- market operations owns lifecycle-feed semantics, safe recurring jobs and
  the future on-chain priority-window design;
- this proposal owns human onboarding, truthful capability documentation,
  local signer/reference runtime, portable skill/SDK/MCP distribution, and
  token-page clarity.

No launch may claim “first dibs” or agent-exclusive access until the separate
on-chain priority rule is implemented, trialed, reviewed and deployed.

## Acceptance criteria

- [ ] All public capability surfaces are generated/validated from one manifest.
- [ ] CI fails on a dead/retired service URL, an inconsistent certificate
      claim, a task URL absent from the manifest, or conflicting Gateway copy.
- [ ] OpenAPI documents all Gateway POST operations and both buy/sell skills.
- [ ] A keyboard-only mobile user reaches inspect, trade, launch or monitor
      from the homepage without reading an endpoint or raw hook schema.
- [ ] Every token page renders a canonical Receive / Exit / Send / Lifecycle
      card and degrades honestly on stale/unavailable route state.
- [ ] The reference runtime passes fixtures for external signer, persistent
      local signer, unsupported signer, unfunded wallet, hook veto, expired
      build and graduation-driven rebuild.
- [ ] The portable skill validates against the Agent Skills format and contains
      no secret-like file or sign/broadcast instruction.
- [ ] SDK/MCP contract tests prove discovery/preparation cannot invoke signing,
      broadcasting, funding, transfer or launch operations.
- [ ] Website/X/docs/community/source links are optional, HTTPS-only,
      display-only and backward compatible with existing metadata.
- [ ] `robots.txt`, sitemap, canonical metadata and static-link checks are
      published; copy states that discoverability does not guarantee adoption.
- [ ] Copy forbids wash trading, manufactured volume, coordinated pumping,
      undisclosed allocation and misleading return claims.

## Rollout order

1. Documentation integrity: capability manifest, active domains, generated
   docs, OpenAPI, buy/sell indexing and link checks.
2. Human path: homepage split, signer chooser, generated token truth card,
   accessibility/mobile review.
3. Reference integration: local/external signer bridge, approval card and
   receipt verification. Execution remains approval-gated.
4. Distribution: portable skill, SDKs, then audited MCP server/registry entry.
5. Network return path: durable graduation/venue events and route-health
   records. Priority remains a separate on-chain proposal.

## Security considerations

- Treat all token metadata, social links and event descriptions as untrusted
  display content. Rules, eligibility and venue originate in canonical records
  and fresh chain reads.
- A reference runtime must refuse to sign a stale, unsimulated, mismatched or
  expired build, even after the user previously approved another amount.
- Do not let an MCP tool bypass the host application's approval policy.
- Keep analytics aggregate and operational; do not create a hidden portfolio
  or wallet-surveillance product from feed subscriptions.
- Do not use marketing, social links or performance figures to pressure a
  purchase. Speculative tokens can lose all value.

## Non-goals

- giving a generic ChatGPT/Claude chat a signer just by copying a prompt;
- custody, hosted wallets, key recovery or seed backups;
- autonomous buying/selling, volume manufacturing, coordinated pumps or
  selling into uninformed counterparties;
- proving that a registered/attested wallet is autonomous; and
- changing an existing token's on-chain rules through web copy.

## Attribution

No on-chain contributor wallet was supplied for this product proposal.
Attribution should be completed only when a contributor submits a reviewed
implementation and test evidence.

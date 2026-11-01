# AgentOnly MCP server

A dependency-free [MCP](https://modelcontextprotocol.io) server (Node ESM,
stdio transport, newline-delimited JSON-RPC 2.0) that gives an agent
read/prepare access to AgentOnly's public surfaces on
[agentonly.fun](https://agentonly.fun): the canonical token registry, the
market snapshot, the launch event feed, and the Execution Gateway's
unsigned quote / eligibility / build / simulate endpoints.

The server **holds no keys, never signs, and never broadcasts**. `build`
returns an *unsigned* transaction for the host agent's own signer path;
the host application's approval policy still governs every action.

## Run

```bash
node agentonly-mcp.mjs
```

That's it — no install step, no dependencies, no configuration required.
Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `AGENTONLY_BASE` | `https://agentonly.fun` | AgentOnly origin (site + gateway) |
| `SOLANA_RPC` | `https://api.mainnet-beta.solana.com` | RPC used by `verify` |

Point any MCP host at the command above (stdio). Protocol version
`2024-11-05`; server identity `agentonly` `1.1.0`.

## Tools

| Tool | Arguments | What it does |
|---|---|---|
| `inspect_token` | `mint` | Canonical token record (rules, graduation, provenance) + live market snapshot entry |
| `list_events` | `cursor?` | Market events (launches today; lifecycle events as sources land) after a sequence cursor, with `nextCursor` |
| `quote` | `mint, side, amount` | Live hook-aware quote from the Execution Gateway — unsigned, no transaction built |
| `eligibility` | `mint, side, amount, wallet` | Tri-state eligibility (`eligible \| ineligible \| unknown`) with TK_* reason codes |
| `build` | `mint, side, amount, wallet` | UNSIGNED hook-aware swap transaction + simulation, for the host agent's own signer to review, sign, and broadcast after explicit owner approval |
| `simulate` | `mint, transactionBase64` | Simulate a caller-supplied transaction; failures classified (route / signer / hook veto / RPC) |
| `verify` | `signature` | On-chain readback via public Solana RPC: confirmation status, success/failure, slot, fee |

Tool results use the standard MCP content format (a text summary, plus
`structuredContent` where natural). Upstream failures come back as
`isError: true` results carrying the upstream reason — the server never
crashes on an upstream error.

## What's deliberately NOT here

There are **no** `sign`, `broadcast`, `fund`, `transfer`, `auto_buy`,
`auto_sell`, or `launch` tools, and there never will be in this server's
read/prepare line:

- **Signing and broadcasting belong to the agent's own signer**, behind
  the owner's explicit, per-transaction approval. A tool that could sign
  would turn every connected host into a standing spend mandate.
- **The server accepts no key-shaped input.** Any tool argument named
  like key material (`privateKey`, `secretKey`, `seed`, `mnemonic`, …) —
  at any nesting level — is refused before the tool runs, mirroring the
  Execution Gateway's own rejection rule.
- **Tool input schemas are closed.** Every tool declares
  `additionalProperties: false`, and the server enforces it before
  dispatch: an argument whose key is not in the tool's declared
  property set is refused by name, so the input surface is bounded to
  named, typed fields only — a value cannot ride in under an
  undeclared name. The key-shaped scan above stays as defense in
  depth for values passed under declared names.
- The contract test statically scans the server source for
  transaction-submission and key-handling primitives to keep it that way.

## Tests

```bash
node test/contract.test.mjs
```

Spawns the server and asserts: the initialize handshake, that
`tools/list` returns exactly the seven tools above (and none of the
forbidden names), that every tool schema is closed
(`additionalProperties: false`), that live `inspect_token` /
`list_events` / `quote` calls succeed against agentonly.fun, that a
forbidden tool name returns a JSON-RPC error, that a key-shaped
argument is rejected, that a call carrying an undeclared argument key
is rejected before the tool executes, and the static source guard.

## Publication status

**Not published.** Per the build spec (`SPEC-MCP-SERVER.md`), registry
publication (official MCP registry, verified namespace) happens only
after schema/versioning, security review, and these contract tests are
complete **and** Gregory approves. Do not publish this server anywhere
on your own initiative.

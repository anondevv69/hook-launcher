# Proposal: Self-Service Metadata — launch recipe (metadataService + own-hosted)

- **ID:** `recipe-self-service-metadata`
- **Track:** launch recipe
- **Status:** proposed
- **Proposer:** outsider acceptance-test agent — wallet `HkPQhmHTgjk2KbfghU57Sb25dCA3PEgGqh6wUp53xPtc`
- **Date proposed:** 2026-10-24
- **Spec:** inline below
- **Implementation PR:** None — proposal only. No code change is proposed:
  both launcher paths described here already exist in `launcher/launch.mjs`
  (L0 `stageMetadata`) and were exercised as-is by an outside agent in the
  trial run cited below.
- **Trial evidence:** Outsider acceptance run, 2026-10-24 — the OUTDRY
  upload + verification transcripts in
  `hidden_files/outsider-test/` (step-g.txt: dry run, wallet-signed
  service upload, independent GET verification of the metadata JSON and
  image, and the own-hosted `--stage-metadata` verification; step-f.txt:
  offline validation of the same spec). Metadata produced by that run:
  https://metadata-production-b46e.up.railway.app/meta/outdry.json
  (image: https://metadata-production-b46e.up.railway.app/meta/outdry.png).

## Summary

This recipe is the standard way to launch a token whose metadata is
hosted before the pool exists, with no operator involvement. The
launcher offers two self-serve paths, selected by the spec:

1. **Metadata service (default self-serve path).** Set
   `"metadataService": true` in the launch spec (or a service base-URL
   string, or env `LAUNCH_METADATA_SERVICE`). At L0 the launcher
   generates a 512×512 monogram image (or uses
   `spec.metadataImageFile`), signs the upload with the launcher
   wallet, POSTs it to the public metadata service
   (`https://metadata-production-b46e.up.railway.app/meta/upload`), and
   uses the returned `metadataUrl` as the mint's metadata URI. The
   predicted URL has the shape `<serviceBase>/meta/<slug>.json`, where
   the slug is the lowercased symbol.
2. **Own-hosted (operator-supplied URI).** Omit `metadataService` and
   set `"metadataUri": "<url>"` to a JSON document the creator hosts
   anywhere. The launcher uses it verbatim.

What this recipe does *not* do: it does not change any on-chain
program, any rule, or the launch sequence after L0. It standardizes
only how the metadata URI that L2 writes into the mint is produced and
verified. Catalog copy must never claim more: hosting is off-chain,
and a hosted document can change after launch if its host changes it —
the invariant below is about launch time, not about immutability of
the hosted bytes forever.

## Formal invariant

For every launch executed through this recipe, at the moment L1 runs:

- the metadata URI written at L2 is never empty;
- that URI has been verified live during L0 of the same run: a GET on
  it returned parseable JSON whose `name` and `symbol` match the spec
  and whose `image` field resolves to a response with an `image/*`
  content type (service and generated paths check name/symbol/image
  equality against the staged document; the own-hosted path requires
  parseable JSON and a live image);
- on the service path, the symbol is bound to the creator's own
  wallet: the service accepts an upload for a symbol only from the
  wallet that first claimed that symbol (the upload is an ed25519
  signature by that wallet over
  `agentonly-meta:<wallet>:<SYMBOL>:<sha256hex(image bytes)>:<nonce>`),
  so no operator and no third party can front-run the claim or
  reassign the symbol to a different wallet.

Falsification shape: exhibit a completed launch through either path
whose L2 URI is empty, or whose L0 verification passed against a dead
or mismatched URI, or a service-hosted symbol whose upload was
accepted from a wallet other than its first claimant — any one breaks
this recipe.

## Mechanism

L0 order of operations (all of it before L1, in `launch.mjs`):

1. `resolveMetadata(spec)` selects the source: `metadataUri` present
   → `spec` (own-hosted); else `metadataService` set → `service`;
   else the legacy generated/site path (outside this recipe).
2. Service path (`stageMetadata`, source `service`): build the image
   bytes (spec file or generated monogram); compute
   `imageSha = sha256(image bytes)`; pick a random 16-hex-char nonce;
   sign `agentonly-meta:<wallet>:<SYMBOL>:<imageSha>:<nonce>` with
   the launcher wallet (ed25519; the signature is sent base58-encoded);
   POST `{ wallet, name, symbol, imageBase64, nonce, signature }`
   (plus optional `description` / `externalUrl`) to
   `<serviceBase>/meta/upload`. The response's `metadataUrl` and
   `imageUrl` replace the predicted URI and image.
3. Own-hosted path (source `spec`): no upload happens at all; the
   spec's URI is taken verbatim.
4. Both paths then run live verification (`verifyMetadataLive`,
   fetch-with-retry): GET the URI, require parseable JSON, and GET
   the JSON's `image`, requiring an `image/*` content type. Any
   failure throws and the launch refuses — L1 never runs.
5. `node launch.mjs <spec> --stage-metadata` runs exactly steps 1–4
   and stops: it is the preflight an outside creator runs before a
   launch. `--dry-run` prints the full ordered plan — including the
   predicted service URI in the L0/L2 lines — and sends nothing.

Parameters and bounds: the service enforces its own upload bounds
(documented in `skills/launch.md`, "Host your metadata first": image
≤ 512 KB, PNG/JPEG/WebP/GIF sniffed by magic bytes, nonce 8–64 chars,
single-use per wallet, symbol uppercased before verification). The
recipe adds no parameters of its own.

## Account / meta-list impact

None. Metadata is off-chain. The L2 mint carries the URI (written by
DBC at pool creation, as on every launch); no extra accounts are
added to any instruction, the transfer hook's extra-account meta
list is unchanged (the OUTDRY trial spec's L4 line templated exactly
5 extras, the same count as any rules-[3, 9] launch without this
recipe), and no PDA is created, read, or written by the metadata
step. Total extra-account count attributable to this recipe: 0.

## Error codes

No new engine error codes are requested — this recipe touches no
engine code, and no on-chain code is allocated to it. The refusal
conditions are the service's HTTP results and the launcher's existing
L0 refusal (a thrown `L0 metadata: …` error that aborts the run
before L1):

- **Service 409 — symbol owned by another wallet.** The symbol was
  already claimed by a different wallet; this wallet cannot upload
  to it. Resolution is creator-side only: choose a different symbol
  or launch from the owning wallet. Nobody — including the operator —
  can reassign the symbol.
- **Service 401 — bad signature.** The signature does not verify
  against the claimed wallet over the canonical message (wrong
  signer, wrong message shape, or a base64 signature sent where the
  service expects base58). The upload is rejected; nothing is stored.
- **Dead or mismatched `metadataUri` (own-hosted path).** The URI
  does not resolve, does not parse as JSON, or its image does not
  serve an `image/*` content type: L0 verification fails and the
  launcher refuses to launch. The same refusal applies on the
  service path if the just-uploaded document fails live verification.
- **Service upload failure (any other non-200).** L0 throws with the
  HTTP status and response body; the launch aborts before L1. There
  is no fallback to an empty URI — ever.

## Interaction with existing rules

Orthogonal to all 17 catalog rules. The recipe runs entirely at L0,
before any rule is written at L3, and no rule module reads the
metadata URI at transfer time: rules 1–17 behave identically whether
the URI came from the service path, the own-hosted path, or the
legacy generated path. A spec may combine this recipe with any
launchable rule stack (the trial used rules 3 Agent-Only + 9 Max
Wallet, capBps 500).

Graduation behavior: graduation does not change the URI. On
`release` graduation the hook is revoked and the token migrates, but
the mint's metadata URI written at L2 is untouched; on `never` and
`house` graduations the same URI likewise persists. The recipe has
no graduation-specific state to retire, migrate, or preserve beyond
the URI itself.

## Trial plan

Trial cases (initial state → action → expected outcome):

1. **Dry-run plan shape.** Fresh checkout, no `deploy/` directory,
   spec with `"metadataService": true` → `launch.mjs <spec>
   --dry-run` → full ordered plan printed; L1 and L2 lines name the
   platform tag signer
   `95uGAjvVB3xLkqdGZoq2CncLunqcUPe8NxhetRVkiVgF` (tier-2 bundled
   tag); L0/L2 show the predicted URI
   `https://metadata-production-b46e.up.railway.app/meta/outdry.json`;
   nothing is sent, no RPC is touched. *(Executed in the cited run —
   step-g.txt.)*
2. **Service upload binds the symbol to the creator's wallet.** A
   brand-new, unfunded keypair (balance 0) → `--stage-metadata` with
   `LAUNCH_KEYPAIR` set to that wallet → prints
   `ok L0 metadata (public metadata service, wallet-signed upload) —
   verified live: https://metadata-production-b46e.up.railway.app/meta/outdry.json`,
   and the staged report names that same wallet as the service
   wallet. *(Executed — step-g.txt.)*
3. **Independent verification.** No launcher code involved → GET the
   returned `metadataUrl` → 200 JSON with `name` "Outsider Dry Run",
   `symbol` "OUTDRY", and `image` equal to the hosted image URL;
   GET the image URL → 200, `image/png`, a 512×512 PNG.
   *(Executed — step-g.txt. Observation from the same run: a HEAD
   request to the image URL returned 404 while GET returned 200 —
   recorded under Security considerations; it does not affect the
   launcher, which verifies by GET.)*
4. **Own-hosted path uploads nothing and verifies live.** Spec
   identical to case 2 except no `metadataService` and
   `"metadataUri"` set to the case-2 URL → `--stage-metadata` →
   prints `ok L0 metadata (operator-supplied URI, verified live)`
   with that URI; no upload is performed (the source is reported as
   `spec`). *(Executed — step-g.txt.)*
5. **Offline spec validation.** The same spec →
   `validate-config.mjs <spec>` → `{ ok: true, errors: [],
   warnings: [] }`, fully offline. *(Executed — step-f.txt.)*
6. **Symbol collision.** A second wallet (not the case-2 claimant)
   uploads the same symbol → service returns 409 and stores nothing;
   the original owner's document is unchanged on re-GET.
   *(Required before `trial-proven`; specified here from the
   service's documented first-claimant binding — not executed in the
   cited run, whose signing constraint was the single fresh wallet.)*
7. **Bad signature.** An upload whose signature does not verify for
   the claimed wallet → service returns 401; nothing is stored.
   *(Required before `trial-proven`; same status as case 6.)*
8. **Dead own-hosted URI.** Spec with a `metadataUri` that 404s or
   returns non-JSON → `--stage-metadata` (and any live launch)
   refuses at L0; L1 never runs. *(Required before `trial-proven`;
   the refusal is the launcher's existing `verifyMetadataLive`
   failure path, exercised in its positive form by cases 2–4.)*

Trial evidence committed for this proposal so far is the cited
outsider acceptance run (cases 1–5). Cases 6–8 must pass — with
evidence committed under `verification/` — before this recipe can be
marked `trial-proven`, per the index's status definitions.

## Security considerations

- **Signer checks.** The only signature in the recipe is the
  creator's own ed25519 signature over the canonical upload message.
  The secret key never leaves the creator's machine; `wallet.mjs`
  and `launch.mjs` print addresses and signatures only, never key
  material. The signature binds wallet + symbol + exact image bytes
  (sha256) + a single-use nonce, so a captured upload cannot be
  replayed for a different image or a different symbol.
- **Front-running / reassignment.** Symbol ownership is
  first-claimant, enforced by the service against the signing
  wallet. An operator cannot front-run or reassign a symbol because
  the operator's wallet is simply a different wallet (→ 409). A
  creator who stages metadata with an ephemeral wallet orphans the
  symbol to that wallet — the launcher warns about exactly this when
  `--stage-metadata` runs without a keypair.
- **CPI surface.** None. The recipe adds no CPI, no program call,
  and no account to any on-chain instruction; its only network
  effects are one HTTPS POST and the verification GETs at L0.
- **Failure mode.** Fail closed, everywhere: upload failure,
  verification failure, and symbol/signature refusal all abort the
  launch before L1. The pre-recipe failure this closes is a mint
  born with an empty URI; under this recipe that outcome is
  unreachable, because there is no code path from a failed L0 to L1.
- **Hosted-content risk (disclosed, not hidden).** Verification is a
  launch-time check. Whoever controls the hosting wallet (service
  path) or the host (own-hosted path) can update the document after
  launch; the recipe does not pin content hashes on-chain. Buyers
  should treat metadata as creator-controlled content, exactly as
  the skills instruct.
- **Observation — HEAD requests 404 on the service's image route.**
  In the cited run, GET on the image URL returned 200 `image/png`
  while HEAD returned 404. The launcher and this recipe verify by
  GET, so launches are unaffected; any third-party checker that
  probes images with HEAD would misread a live image as dead. Worth
  a service-side fix (answer HEAD like GET, headers only), recorded
  here so review can triage it.
- **Griefing.** Claiming a symbol is free and instant, so symbol
  squatting is possible in principle; the cost to the ecosystem is
  bounded (a squatted symbol only blocks that exact symbol on this
  one service, and creators can always fall back to the own-hosted
  path, which no one can squat).

## Attribution

Proposer: outsider acceptance-test agent — wallet
`HkPQhmHTgjk2KbfghU57Sb25dCA3PEgGqh6wUp53xPtc` — the fresh,
unfunded wallet created for the cited acceptance run, which signed
the OUTDRY metadata upload this proposal's trial evidence rests on.

On acceptance, this section is completed with: agent name,
verifiable wallet address, link to the merged PR, and link to the
trial evidence. That record is what any launch-time royalty
(FeeSchedule pattern — see CONTRIBUTING.md) attaches to.

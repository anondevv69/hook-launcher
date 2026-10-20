// tag.mjs — the Hook Launcher LAUNCH TAG keypair, embedded in the browser
// bundle (Phase 4, Feature A). READ THIS BEFORE TOUCHING IT.
//
// SECURITY NOTE, clear-eyed: this is a SECRET KEY shipped in a public
// JavaScript bundle. That is acceptable here — and only here — because
// this key is FUNDLESS and POWERLESS by design:
//   * it holds no funds and must never be sent any (it is not a wallet);
//   * it owns nothing, authorities nothing, and can sign exactly one
//     thing anyone cares about: the read-only memo signature in a
//     launch's L2 transaction (the tag);
//   * its ONLY value is as a label — terminals/routers recognizing the
//     extra signer as "a Hook Launcher launch";
//   * the worst case of compromise is SPOOFED TAGS: someone else's
//     launches carrying our label. No funds, no launches, no configs can
//     be touched with it. The real attestation for any launch remains
//     on-chain — the token's engine Config PDA + meta list — and
//     verifiers must check those, never the tag alone.
// The CLI flow reads the same keypair from
// deploy/launcher-tag.json (mode 600, build tree only). This embedded
// copy exists so browser-composed launches carry the identical tag.
// Marker text: "hook-launcher:v1" (SPL Memo v2, sole signer below).
export const LAUNCH_TAG_SECRET = [102,48,228,9,121,226,27,90,224,125,38,124,167,44,198,130,223,184,114,58,200,78,23,14,215,103,37,236,42,89,84,8,120,30,233,50,210,64,53,189,215,166,100,147,73,193,72,39,108,42,16,176,159,229,82,132,22,153,151,15,38,132,110,236];

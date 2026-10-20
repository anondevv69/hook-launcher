// shim.mjs — browser globals the Solana/Anchor dependency graph expects.
// Imported FIRST by entry.mjs so these exist before any library code runs.
import { Buffer } from 'buffer';

if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer;
if (typeof globalThis.global === 'undefined') globalThis.global = globalThis;
if (typeof globalThis.process === 'undefined') {
  globalThis.process = {
    env: {},
    browser: true,
    version: '',
    nextTick: (fn, ...args) => setTimeout(() => fn(...args), 0),
  };
}

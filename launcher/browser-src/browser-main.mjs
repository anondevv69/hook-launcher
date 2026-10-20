// browser-main.mjs — esbuild entry for the self-hosted browser bundle.
// Build: node build-bundle.mjs  →  ~/workspace/aonly-site/hooks/launch/launch.bundle.js
import { createHookLaunch } from './entry.mjs';

window.HookLaunch = createHookLaunch();

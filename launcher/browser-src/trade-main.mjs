// trade-main.mjs — esbuild entry for the self-hosted trade bundle.
// Build: node build-trade-bundle.mjs  →  ~/workspace/aonly-site/hooks/trade/trade.bundle.js
import { createHookTrade } from './trade-entry.mjs';

window.HookTrade = createHookTrade();

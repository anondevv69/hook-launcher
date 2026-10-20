#!/usr/bin/env node
// build-bundle.mjs — bundle the in-browser launcher (entry.mjs + the real
// @solana/web3.js, @solana/spl-token and @meteora-ag/dynamic-bonding-curve-sdk
// from this package's pinned node_modules) into ONE self-hosted file for the
// composer page. No CDN: the output is vendored into the site tree.
//   node build-bundle.mjs
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', '..', '..', '..', 'aonly-site', 'hooks', 'launch', 'launch.bundle.js');

await esbuild.build({
  entryPoints: [path.join(here, 'browser-main.mjs')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: out,
  logLevel: 'info',
});
console.log('vendored bundle →', out);

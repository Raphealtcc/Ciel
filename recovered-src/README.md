# Recovered CIEL Worker source sections

These files are source sections extracted from the active Cloudflare Worker bundle on 2026-11-01. Cloudflare's deployment artifact retained esbuild module markers for six original source files:

1. `symbols.ts`
2. `cloudflare-forecast.ts`
3. `advisor.ts`
4. `telegram.ts`
5. `hyperliquid_feed.ts`
6. `index.ts`

The recovered sections are JavaScript emitted by the build, not the original TypeScript. Imports/types have already been erased or rewritten by the bundler. No source map was available in the deployed export, so original type declarations, exact import graph, original package scripts, and original tests are not recovered.

Each section is split into ordered `.part-NNN` files to keep the GitLab transfer reliable. Reassemble them using:

```bash
node ciel/scripts/reassemble-recovered-worker.mjs
```

This writes:
- `ciel/reconstructed/src/<module>.js` — each recovered section as a standalone evidence fragment
- `ciel/reconstructed/worker.js` — the sections concatenated in the exact order emitted by the deployed bundle

The concatenated worker is intended to reproduce the deployed bundle's runtime logic. It is not yet a cleanly modular source project and must be syntax-checked and tested before deployment.

**Do not deploy this recovery snapshot directly.** First validate the reconstructed worker, reconstruct the exact Durable Object migration history, check D1/KV bindings and secrets, and run endpoint/Telegram smoke tests on a staging Worker.

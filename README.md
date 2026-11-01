# CIEL

Hyperliquid market monitoring, technical setup detection, research enrichment, and trade lifecycle alerts running on Cloudflare Workers.

- Live Worker: https://ciel.leno3z4rrrri.workers.dev
- Health: https://ciel.leno3z4rrrri.workers.dev/health
- Verified deployed bundle SHA-256: `24e6452b4a2854a1e37f864adcb201d588771460eed68bcd100f5cfbafd564b6`

## Layout
- `recovered-src/`: recovered JavaScript module fragments from the deployed bundle.
- `cloudflare-export/`: compressed original Worker export, split into chunks.
- `scripts/`: reassembly and Reverse Engineer Anything analysis helpers.
- `migrations/`: recovered live D1 schema only.
- `docs/`: architecture, runtime snapshot, and reverse-engineering findings.
- `wrangler.jsonc`: fresh-target template; review bindings and Durable Object migrations before deployment.

## Verify
Requires Node.js and npm.

```sh
npm run reassemble
npm run check
```

The check verifies recovered module lengths and the deployed bundle SHA-256, then runs Node syntax validation.

## Recovery limits
Cloudflare exposed deployed JavaScript, not the original TypeScript project. Original TypeScript, source maps, git history, lockfile, tests, and release assets were not recovered. The D1 schema was exported, but database rows, KV values, Durable Object storage, and secrets were not. Never commit secrets.

The Wrangler file is a target-environment template. Do not deploy it over the live Worker without checking bindings, resource IDs, and Durable Object migration compatibility.

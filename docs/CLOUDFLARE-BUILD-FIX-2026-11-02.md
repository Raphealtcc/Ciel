# CIEL Cloudflare staging build — 2026-11-02

## Correct staging target

The staging Worker is `ciel2`. The account used by Workers Builds owns the staging resources:
- D1 `ciel-paper-staging`: `a41e95fe-58cc-443a-839e-5ee0525e9fcf`
- KV `CIEL_STATE`: `6e1fa505914c4d3b87b5b49c9d54f6fe`

The Wrangler config uses those IDs for both the Worker and Worker Previews. It declares the Worker name `ciel2` so Workers Builds does not silently override a different name. `workers_dev` and `preview_urls` are enabled to match the staging Worker settings. Durable Object classes are migrated as fresh SQLite-backed namespaces.

## Build bootstrap

Cloudflare Workers Builds must build branch `audit/paper-trading-fix` from the repository root. The branch's package.json postinstall runs `npm run build`, which:
1. Reassembles the byte-exact recovered Worker bundle.
2. Applies the isolated paper-tier patch to `reconstructed/patched-worker.js`.
3. Syntax-checks the patched Worker.
4. Runs deterministic paper behavior tests.
5. Validates the staging Worker name, D1/KV IDs, Preview bindings and Durable Object migration.

The original recovered fragments remain immutable. The duplicate `lastMessageAt` property is removed only from the patched staging output, not from the byte-exact recovery evidence.

Deploy command:
```sh
npx wrangler deploy --config wrangler.jsonc
```

## Important diagnosis from the 2026-11-02 01:55 build log

That build did invoke the explicit config path, but its resolved config did not match this branch:
- It used Worker name `ciel`, then Cloudflare overrode it to `ciel2`.
- It bound KV ID `8b5c4b6078ce43a8aec4d9343855a70f` and D1 database `ciel`, not the staging resources above.
- It showed a different variable set and a different compatibility date.
- Its install output only showed the recovery script, not the full `npm run build` verification chain.

Those facts establish that Workers Builds was not building the current `audit/paper-trading-fix` tree/configuration (or was using a different repository root/config). Merely changing the deploy command cannot fix that. Point the Workers Builds connected branch at `audit/paper-trading-fix`, keep the root directory at the repository root, and retain the explicit deploy command above. Do not point the build at `main`.

## Deployment gate

Before allowing the next deploy, inspect the Wrangler binding summary. It must show:
- Worker `ciel2`
- KV `6e1fa505914c4d3b87b5b49c9d54f6fe`
- D1 `ciel-paper-staging` / `a41e95fe-58cc-443a-839e-5ee0525e9fcf`

If any old source ID or D1 name appears, stop. Do not deploy. Production Worker v505 and its resources remain untouched. The MR remains draft/unmerged pending successful CI and staging runtime checks.

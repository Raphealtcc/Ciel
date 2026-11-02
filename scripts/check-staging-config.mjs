import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const raw = await readFile("wrangler.jsonc", "utf8");
const json = raw.replace(/^\\s*\\/\\/.*$/gm, "");
const config = JSON.parse(json);

assert.equal(config.name, "ciel-paper-staging");
assert.equal(config.main, "reconstructed/patched-worker.js");
assert.equal(config.compatibility_date, "2026-09-08");
assert.deepEqual(config.triggers.crons, ["* * * * *"]);

const d1 = config.d1_databases.find((item) => item.binding === "DB");
const kv = config.kv_namespaces.find((item) => item.binding === "CIEL_STATE");
assert.ok(d1?.database_id?.startsWith("REPLACE_WITH_NEW_ACCOUNT_"), "D1 must remain an explicit target placeholder");
assert.ok(kv?.id?.startsWith("REPLACE_WITH_NEW_ACCOUNT_"), "KV must remain an explicit target placeholder");

assert.ok(config.previews && typeof config.previews === "object", "Worker Preview configuration is required");
assert.deepEqual(config.previews.vars, config.vars, "Preview must define the full staging variable set");
const previewD1 = config.previews.d1_databases?.find((item) => item.binding === "DB");
const previewKv = config.previews.kv_namespaces?.find((item) => item.binding === "CIEL_STATE");
assert.equal(previewD1?.database_id, d1.database_id, "Preview must use the isolated staging D1, never production D1");
assert.equal(previewKv?.id, kv.id, "Preview must use the isolated staging KV, never production KV");
assert.equal(config.previews.triggers, undefined, "Cron triggers must not be configured for Worker Previews");

const serialized = JSON.stringify(config);
assert.ok(!serialized.includes("fb55e85b-af9b-45b3-ba43-6c7f7996dfa8"), "Source D1 ID must not appear in staging config");
assert.ok(!serialized.includes("8b5c4b6078ce43a8aec4d9343855a70f"), "Source KV ID must not appear in staging config");

const migration = config.migrations?.[0];
assert.equal(migration?.tag, "v1");
assert.deepEqual(new Set(migration?.new_sqlite_classes || []), new Set(["HyperliquidFeed", "TradingEngine"]));
assert.equal(migration?.new_classes, undefined, "Fresh staging namespaces must use SQLite-backed DO classes");

const bindings = new Set(config.durable_objects.bindings.map((item) => item.name));
assert.ok(bindings.has("HYPERLIQUID_FEED"));
assert.ok(bindings.has("TRADING_ENGINE"));

console.log("PASS: staging deploy and Worker Preview configs are isolated from source resources and use fresh SQLite-backed Durable Object migrations.");

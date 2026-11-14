import assert from "node:assert/strict";
import { readTradingControl, writeTradingControls } from "../src/trading-controls.js";
const calls = [];
const cache = new Map();
const env = {
  CIEL_STATE: {
    async get(key) { return cache.get(key) ?? null; },
    async put(key, value) { cache.set(key, value); },
  },
  DB: {
    prepare(sql) {
      return { sql, values: [], bind(...values) { this.values = values; return this; },
        async first() { calls.push({ kind: "first", sql: this.sql, values: this.values }); return this.values[0] === "missing" ? null : { control_value: "true" }; } };
    },
    async batch(statements) { calls.push({ kind: "batch", count: statements.length, statements }); return statements.map(() => ({ success: true })); },
  },
};
assert.equal(await readTradingControl(env, "ciel:control:live-enabled", null), "true");
assert.equal(calls.filter((call) => call.kind === "first").length, 1);
assert.equal(calls[0].values[0], "ciel:control:live-enabled");
assert.equal(await readTradingControl(env, "ciel:control:live-enabled", null), "true", "fresh KV control cache should avoid another D1 read");
assert.equal(calls.filter((call) => call.kind === "first").length, 1);
assert.equal(await readTradingControl(env, "missing", "false"), "false", "missing D1 row must honor the safe fallback");
assert.deepEqual(await writeTradingControls(env, [["ciel:control:live-enabled", true], ["ciel:control:live-entry-enabled", false]]), [{ success: true }, { success: true }]);
assert.equal(calls.at(-1).kind, "batch");
assert.equal(calls.at(-1).count, 2);
assert.equal(await readTradingControl(env, "ciel:control:live-entry-enabled", "true"), "false", "successful D1 writes must update the KV control cache");
await assert.rejects(() => writeTradingControls(env, [["ciel:control:unknown", true]]), /TRADING_CONTROL_UPDATE_INVALID/);
await assert.rejects(() => writeTradingControls({ DB: { prepare() {} } }, [["ciel:control:paper-enabled", true]]), /TRADING_CONTROL_D1_BATCH_UNAVAILABLE/);
assert.equal(await readTradingControl({}, "ciel:control:live-enabled", "false"), "false", "missing D1 binding must return the safe fallback instead of aborting the advisor");
const staleCache = new Map([["ciel:control-cache:v1:ciel:control:paper-enabled", JSON.stringify({ value: "true", cachedAt: Date.now() - 60 * 60 * 1e3 })]]);
const unavailableEnv = {
  CIEL_STATE: { async get(key) { return staleCache.get(key) ?? null; } },
  DB: { prepare() { return { bind() { return this; }, async first() { throw new Error("D1 daily row read limit exceeded"); } }; } },
};
assert.equal(await readTradingControl(unavailableEnv, "ciel:control:paper-enabled", "false"), "true", "recent cached paper mode must survive temporary D1 read exhaustion");
console.log("PASS: five-minute KV control cache, mirrored writes, stale-cache fallback during D1 exhaustion, and safe defaults.");

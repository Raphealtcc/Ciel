import assert from "node:assert/strict";
import { readTradingControl, writeTradingControls } from "../src/trading-controls.js";
const calls = [];
const env = {
  DB: {
    prepare(sql) {
      return { sql, values: [], bind(...values) { this.values = values; return this; },
        async first() { calls.push({ kind: "first", sql: this.sql, values: this.values }); return this.values[0] === "missing" ? null : { control_value: "true" }; } };
    },
    async batch(statements) { calls.push({ kind: "batch", count: statements.length, statements }); return statements.map(() => ({ success: true })); },
  },
};
assert.equal(await readTradingControl(env, "ciel:control:live-enabled", null), "true");
assert.equal(calls[0].values[0], "ciel:control:live-enabled");
assert.equal(await readTradingControl(env, "missing", "false"), "false", "missing D1 row must honor the safe fallback");
assert.deepEqual(await writeTradingControls(env, [["ciel:control:live-enabled", true], ["ciel:control:live-entry-enabled", false]]), [{ success: true }, { success: true }]);
assert.equal(calls.at(-1).kind, "batch");
assert.equal(calls.at(-1).count, 2);
await assert.rejects(() => writeTradingControls(env, [["ciel:control:unknown", true]]), /TRADING_CONTROL_UPDATE_INVALID/);
await assert.rejects(() => writeTradingControls({ DB: { prepare() {} } }, [["ciel:control:paper-enabled", true]]), /TRADING_CONTROL_D1_BATCH_UNAVAILABLE/);
await assert.rejects(() => readTradingControl({}, "ciel:control:live-enabled"), /TRADING_CONTROL_D1_BINDING_UNAVAILABLE/);
console.log("PASS: D1 control reads, atomic batched writes, key validation and missing-binding failures.");

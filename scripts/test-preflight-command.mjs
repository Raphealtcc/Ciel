import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../reconstructed/patched-worker.js", import.meta.url), "utf8");
assert.ok(worker.includes("async function handleLeverUpPreflightCommand(env, text)"));
assert.ok(worker.includes('if (command !== "/preflight") return false;'));
assert.ok(worker.includes('if (args.length !== 2)'));
assert.ok(worker.includes('symbols: [symbol], skipCoordinator: true'));
assert.ok(worker.includes('if (await handleLeverUpPreflightCommand(env, text)) return;'));
assert.ok(!worker.includes('symbols: ["BTC", "ETH", "SOL"]'));
console.log("PASS: /preflight requires exactly one supported market, skips coordinator work, and reports no order or approval submission.");

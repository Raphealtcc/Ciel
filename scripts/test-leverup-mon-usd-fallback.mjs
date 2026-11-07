import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile("reconstructed/patched-worker.js", "utf8");
const advisorStart = worker.indexOf("async function runAdvisorCycle");
const advisorEnd = worker.indexOf("__name(runAdvisorCycle", advisorStart);
assert.ok(advisorStart >= 0 && advisorEnd > advisorStart, "advisor cycle must exist");
const advisor = worker.slice(advisorStart, advisorEnd);
assert.ok(worker.includes("async function getCachedLeverUpMonUsd"), "fresh cached LeverUp MON/USD quote helper must exist");
assert.ok(advisor.includes("liveMode ? await getCachedLeverUpMonUsd(env, now)"), "live advisor must not require a Hyperliquid MON market");
assert.ok(!advisor.includes("if (now - lastTickAt > MAX_AGE || !(prices.MON > 0))"), "old MON hard gate must be removed");

const managerStart = worker.indexOf("async function manageOpenPositions");
const managerEnd = worker.indexOf("__name(manageOpenPositions", managerStart);
const manager = worker.slice(managerStart, managerEnd);
assert.ok(manager.includes("await getCachedLeverUpMonUsd(env, now)"), "position management must use the cached MON/USD quote");

const callbackStart = worker.indexOf("async function handleAdvisorCallback");
const callbackEnd = worker.indexOf("__name(handleAdvisorCallback", callbackStart);
const callback = worker.slice(callbackStart, callbackEnd);
assert.ok(callback.includes("await getCachedLeverUpMonUsd(env, now)"), "Telegram tracking callbacks must use the cached MON/USD quote");

assert.ok(worker.includes("return sampled > 0 ? sampled : await getCachedLeverUpMonUsd(env, Date.now())"), "Telegram commands must use the cached MON/USD quote");
assert.ok(worker.includes("if (!lastTickAt || now - lastTickAt > 18e4)"), "scheduled advisor must run without requiring prices.MON");
assert.ok(worker.includes("ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY close_ts_ms DESC)"), "advisor must recover fresh 5m candles from D1 when the Durable Object buffer is empty");
assert.ok(worker.includes("if (!candles || candles.five.length < 40)"), "5m trend continuation must not be blocked by missing 1m candles");
assert.ok(worker.includes("await runAdvisorCycle(env, prices, now, lastTickAt, null, null, null)"), "scheduled advisor must run with the fresh 5m D1 fallback when no DO candle buffers are passed");
assert.ok(worker.includes("runAdvisorCycle(this.env, this.latest, now, this.lastTickAt, this.history, this.liveMarketInputs(now), this.state.storage, this.coreScalpCandles, this.coreTrendCandles)"), "Durable Object advisor must run with fresh closed-candle buffers");
console.log("PASS: CIEL advisor, position alerts, Telegram callbacks and commands use a fresh cached LeverUp MON/USD quote when Hyperliquid has no MON market.");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
const start = source.indexOf("  async scheduled(_event, env, ctx) {");
const end = source.indexOf("\n};", start);
assert.ok(start >= 0 && end > start, "scheduled handler must exist");
const scheduled = source.slice(start, end);

assert.ok(scheduled.includes("feedStub2(env).fetch(\"https://feed/ensure\""), "scheduled signal feed must remain Hyperliquid");
assert.ok(!scheduled.includes("runAdvisorCycle(env, prices"), "scheduled handler must not run a second D1-only advisor pass; HyperliquidFeed Durable Object owns the in-memory scan");
assert.ok(scheduled.includes("CIEL ADVISOR SCAN FRESH"), "scheduler must report freshness of the Durable Object scan");
assert.ok(scheduled.includes("CIEL ADVISOR SCAN STALE"), "scheduler must surface a stale/missing Durable Object scan");
assert.ok(!scheduled.includes("runLeverUpNativeSampler("), "LeverUp native sampler must not run on a schedule");
assert.ok(!scheduled.includes("runLeverUpDiagnostics("), "periodic LeverUp diagnostics/preflight must be removed");
assert.ok(!scheduled.includes("fetchLeverUpPairs("), "scheduled path must not fetch LeverUp pair catalogue");
assert.ok(scheduled.includes("status IN ('SUBMITTED','PENDING','UNCERTAIN','EXECUTED')"), "position manager must be gated by active/pending entry records");
assert.ok(scheduled.includes("runLeverUpPositionManager("), "position manager must remain available for real open positions");

const candidateCall = source.indexOf("prepareLeverUpAdvisorPlan({ env, candidate, reviewed");
assert.ok(candidateCall > 0, "candidate-time LeverUp preflight must remain");
const advisorStart = source.indexOf("async function runAdvisorCycle");
const advisorEnd = source.indexOf("async function manageOpenPositions", advisorStart);
const advisor = source.slice(advisorStart, advisorEnd);
const leverUpAdvisor = await readFile("src/leverup-advisor.js", "utf8");
assert.ok(leverUpAdvisor.includes('reviewed?.verdict !== "APPROVE" || technicalOnly'), "LeverUp preflight helper must require a fully approved non-technical-only candidate");
assert.ok(advisor.includes("prepareLeverUpAdvisorPlan({ env, candidate, reviewed"), "candidate preflight call must remain in advisor pipeline");

console.log("PASS: Hyperliquid leads signal discovery; LeverUp is not polled on schedule and is queried only for approved candidates or active-position management.");

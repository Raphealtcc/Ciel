import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const raw = await readFile("wrangler.jsonc", "utf8");
const json = raw.replace(/^\s*\/\/.*$/gm, "");
const config = JSON.parse(json);

const expectedD1 = "a41e95fe-58cc-443a-839e-5ee0525e9fcf";
const expectedKv = "6e1fa505914c4d3b87b5b49c9d54f6fe";
const expectedWebhook = "https://ciel2.gatakehanami.workers.dev/telegram/webhook";
const expectedBotId = "9190238402";
const traderAddress = "0xd422fc040ad9294d553150Cf5646Ab0B1729E443";
const agentAddress = "0x77DF3ae15b994131797905e59675da3544C90DFF";
const retiredProductionHost = "ciel.leno3z4rrrri.workers.dev";

assert.equal(config.name, "ciel2", "Cloudflare Workers Builds target name must match the replacement Worker");
assert.equal(config.main, "reconstructed/patched-worker.js");
assert.equal(config.compatibility_date, "2026-09-08");
assert.equal(config.workers_dev, true);
assert.equal(config.preview_urls, true);
assert.equal(config.vars.TELEGRAM_WEBHOOK_URL, expectedWebhook, "Telegram webhook must target the confirmed ciel2 replacement Worker");
assert.equal(config.vars.TELEGRAM_STAGING_BOT_ID, expectedBotId, "Telegram bot identity must match the original production bot");
assert.equal(config.vars.LEVERUP_TRADER_ADDRESS, traderAddress);
assert.equal(config.vars.LEVERUP_AGENT_ADDRESS, agentAddress);
assert.equal(config.vars.LEVERUP_AUTO_APPROVE, "true");
assert.equal(config.vars.LEVERUP_RPC_URL, "https://monad-mainnet.drpc.org");
assert.equal(config.vars.LEVERUP_PREFLIGHT_ENABLED, "true");
assert.equal(config.vars.PAPER_TRADING_ENABLED, "false");
assert.equal(config.previews.vars.PAPER_TRADING_ENABLED, "false");
assert.equal(config.vars.LEVERUP_LIVE_TRADING, "false");
assert.equal(config.vars.LEVERUP_KILL_SWITCH, "true");
assert.equal(config.vars.LEVERUP_PURGE_LIVE_ENABLED, "true", "Only the explicit manual purge command may close live positions while the kill switch is on");
assert.equal(config.vars.LEVERUP_MIN_LEVERAGE, "50");
assert.equal(config.vars.LEVERUP_TOTAL_ALLOCATION_MON, "50");
assert.equal(config.vars.LEVERUP_RESERVE_MON, "25");
assert.equal(config.vars.LEVERUP_MAX_TRADE_MARGIN_MON, "25");
assert.equal(config.vars.LEVERUP_MAX_CONCURRENT_POSITIONS, "1");
assert.equal(config.vars.LEVERUP_MAX_DAILY_LOSS_MON, "9");
assert.equal(config.vars.LEVERUP_MAX_DRAWDOWN_MON, "9");
assert.equal(config.vars.LEVERUP_MAX_AGGREGATE_STOP_RISK_MON, "6");
assert.equal(config.vars.LEVERUP_COLLATERAL_100X_USD, "0.23");
assert.equal(config.vars.LEVERUP_COLLATERAL_50X_USD, "0.43");
assert.equal(config.vars.LEVERUP_WMON_COLLATERAL_RATIO, undefined, "Do not invent a live collateral ratio");
const webhook = new URL(config.vars.TELEGRAM_WEBHOOK_URL);
assert.equal(webhook.protocol, "https:");
assert.equal(webhook.hostname, "ciel2.gatakehanami.workers.dev");
assert.equal(webhook.pathname, "/telegram/webhook");
assert.notEqual(webhook.hostname, retiredProductionHost, "Telegram must never be routed to retired production v505");
assert.deepEqual(config.triggers.crons, ["* * * * *"]);

const d1 = config.d1_databases.find((item) => item.binding === "DB");
const kv = config.kv_namespaces.find((item) => item.binding === "CIEL_STATE");
assert.equal(d1?.database_name, "ciel-paper-staging");
assert.equal(d1?.database_id, expectedD1, "Top-level D1 must use the supplied staging ID");
assert.equal(kv?.id, expectedKv, "Top-level KV must use the supplied staging ID");

assert.ok(config.previews && typeof config.previews === "object", "Worker Preview configuration is required");
const expectedPreviewVars = {
  ...config.vars,
  TELEGRAM_WEBHOOK_URL: "",
  TELEGRAM_STAGING_BOT_ID: "",
  LEVERUP_PURGE_LIVE_ENABLED: "false"
};
assert.deepEqual(config.previews.vars, expectedPreviewVars, "Previews must retain the full variable set but must not claim the shared Telegram bot/webhook");
const previewD1 = config.previews.d1_databases?.find((item) => item.binding === "DB");
const previewKv = config.previews.kv_namespaces?.find((item) => item.binding === "CIEL_STATE");
assert.equal(previewD1?.database_id, expectedD1, "Preview must use the isolated staging D1");
assert.equal(previewKv?.id, expectedKv, "Preview must use the isolated staging KV");
assert.equal(config.previews.triggers, undefined, "Cron triggers must not be configured for Worker Previews");

const serialized = JSON.stringify(config);
assert.ok(!serialized.includes("REPLACE_WITH_NEW_ACCOUNT_"), "No staging resource placeholders may remain");
assert.ok(!serialized.includes("fb55e85b-af9b-45b3-ba43-6c7f7996dfa8"), "Source D1 ID must not appear in staging config");
assert.ok(!serialized.includes("8b5c4b6078ce43a8aec4d9343855a70f"), "Source KV ID must not appear in staging config");

const durableObjectExports = config.exports || {};
assert.deepEqual(
  Object.keys(durableObjectExports).sort(),
  ["HyperliquidFeed", "TradingEngine"],
  "Every provisioned Durable Object class must be declared in exports"
);
for (const className of ["HyperliquidFeed", "TradingEngine"]) {
  assert.deepEqual(durableObjectExports[className], {
    type: "durable-object",
    storage: "sqlite"
  }, className + " must retain its existing SQLite namespace");
}
assert.equal(config.migrations, undefined, "Do not mix legacy migrations with declarative Durable Object exports");

const bindings = new Set(config.durable_objects.bindings.map((item) => item.name));
assert.ok(bindings.has("HYPERLIQUID_FEED"));
assert.ok(bindings.has("TRADING_ENGINE"));

console.log("PASS: ciel2 replacement Worker uses the original production bot identity and webhook; previews cannot claim the shared bot; isolated D1/KV and existing SQLite Durable Object namespaces are preserved through declarative exports.");

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");
const start = source.indexOf("  async scheduled(_event, env, ctx) {");
const end = source.indexOf("\n  }\n};", start);
if (start < 0 || end < 0) throw new Error("Could not locate the scheduled Worker handler.");

const replacement = `  async scheduled(_event, env, ctx) {
    ctx.waitUntil(ensureTelegramWebhook(env));
    // Hyperliquid is the only scheduled signal source. LeverUp is called from
    // prepareLeverUpAdvisorPlan only after a Hyperliquid candidate is approved.
    ctx.waitUntil((async () => {
      const now = Date.now();
      try {
        const marketResponse = await feedStub2(env).fetch("https://feed/ensure", { method: "POST" });
        const marketSnapshot = await marketResponse.json().catch(() => ({}));
        if (!marketResponse.ok || !Array.isArray(marketSnapshot.markets)) throw new Error("SHARED_SIGNAL_MARKET_FEED_UNAVAILABLE: " + String(marketSnapshot.status || marketResponse.status));
        const prices = Object.fromEntries(marketSnapshot.markets.filter((market) => market && market.symbol && Number.isFinite(Number(market.price)) && Number(market.price) > 0).map((market) => [String(market.symbol).toUpperCase(), Number(market.price)]));
        const lastTickAt = Number(marketSnapshot.lastTickAt || 0);
        if (!lastTickAt || now - lastTickAt > 18e4) console.log("CIEL shared advisor waiting for fresh Hyperliquid prices; no setup emitted.");
        else {
          const scan = await env.CIEL_STATE.get("ciel:advisor:last-scan", "json").catch(() => null);
          const scanAt = Number(scan?.at || 0);
          const scanAgeMs = scanAt > 0 ? Math.max(0, now - scanAt) : Infinity;
          if (scanAt > 0 && scanAgeMs <= 18e4 + 3e5) {
            console.log("CIEL ADVISOR SCAN FRESH: " + Number(scan?.historySymbols || 0) + " markets, " + (Array.isArray(scan?.candidates) ? scan.candidates.length : 0) + " technical candidates; age=" + Math.round(scanAgeMs / 1e3) + "s. HyperliquidFeed Durable Object owns the scan.");
          } else {
            console.warn("CIEL ADVISOR SCAN STALE: no completed HyperliquidFeed scan within the freshness window; last successful scan=" + (scanAt > 0 ? new Date(scanAt).toISOString() : "none") + ". No cached candidates are reported as new.");
          }
        }
      } catch (advisorError) { console.error("CIEL Hyperliquid advisor cycle failed: " + String(advisorError?.message || advisorError).slice(0, 220)); }
      // Run the live position manager every scheduled minute. It discovers positions
      // from the LeverUp account index rather than relying on a matching CIEL entry row.
      try {
        await env.CIEL_STATE.put("ciel:leverup:position-manager:last-run", JSON.stringify({ at: now, status: "STARTED" }), { expirationTtl: 3600 });
        const lifecycle = await runLeverUpPositionManager({ env, db: env.DB, now });
        await env.CIEL_STATE.put("ciel:leverup:position-manager:last-run", JSON.stringify({ at: now, status: lifecycle.status, checked: lifecycle.checked || 0, submitted: lifecycle.submitted || 0, adaptiveUpdatesBlocked: lifecycle.adaptiveUpdatesBlocked || 0, closePermissionBlocked: lifecycle.closePermissionBlocked || 0, aiReviewed: lifecycle.aiReviewed || 0, aiCloseSignals: lifecycle.aiCloseSignals || 0, canUpdateTpSl: lifecycle.canUpdateTpSl ?? null, discoveryError: lifecycle.discoveryError || null, reconciliation: lifecycle.reconciliation?.status || null, settlements: lifecycle.settlements || null }), { expirationTtl: 3600 });
        if (lifecycle.adaptiveUpdatesBlocked) console.warn("LeverUp adaptive TP/SL updates blocked by missing agent permission: " + lifecycle.adaptiveUpdatesBlocked);
        if (lifecycle.closePermissionBlocked) console.error("LeverUp position closes blocked by missing agent close permission: " + lifecycle.closePermissionBlocked);
        if (lifecycle.status === "BLOCKED_POSITION_DISCOVERY") console.error("LeverUp position management blocked: position indexer unavailable; no false empty-position state assumed.");
        if (lifecycle.submitted) console.log("LeverUp position manager submitted " + lifecycle.submitted + " exit intent(s).");
      } catch (error) {
        const detail = String(error?.message || error).slice(0, 400);
        console.error("LeverUp active-position management failed: " + detail);
        await env.CIEL_STATE.put("ciel:leverup:position-manager:last-error", JSON.stringify({ at: now, error: detail }), { expirationTtl: 3600 }).catch(() => void 0);
      }
    })());
    ctx.waitUntil((async () => {
      const liveOverride = await readTradingControl(env, "ciel:control:live-enabled", null).catch(() => null);
      const liveMode = String(liveOverride ?? env?.LEVERUP_LIVE_TRADING).toLowerCase() === "true" && String(env?.LEVERUP_KILL_SWITCH).toLowerCase() === "false";
      if (liveMode) return;
      try {
        const response = await feedStub2(env).fetch("https://feed/ensure", { method: "POST" });
        if (!response.ok) { const body = await response.text(); console.error("Hyperliquid feed ensure returned HTTP " + response.status + ": " + body.slice(0, 500)); }
      } catch (error) { console.error("Hyperliquid feed ensure failed: " + String(error).slice(0, 500)); }
    })());
  }`;

source = source.slice(0, start) + replacement + source.slice(end + 4);
const scheduledStart = source.indexOf("  async scheduled(_event, env, ctx) {");
const scheduledEnd = source.indexOf("\n};", scheduledStart);
const scheduled = source.slice(scheduledStart, scheduledEnd);
if (scheduled.includes("runLeverUpNativeSampler(") || scheduled.includes("runLeverUpDiagnostics(")) {
  throw new Error("Periodic LeverUp sampling or diagnostics remain in scheduled handler.");
}
if (!scheduled.includes("HyperliquidFeed Durable Object owns the scan.") || !scheduled.includes("ciel:advisor:last-scan")) throw new Error("HyperliquidFeed-owned advisor scan freshness check is missing.");
if (!scheduled.includes("status IN ('SUBMITTED','PENDING','UNCERTAIN','EXECUTED','RECONCILED')")) throw new Error("Active-position-only LeverUp management gate is missing.");
if (!source.includes("prepareLeverUpAdvisorPlan({ env, candidate, reviewed")) throw new Error("Candidate-time LeverUp preflight call is missing.");

await writeFile(file, source);
console.log("Applied Hyperliquid-led architecture: no scheduled LeverUp sampler or diagnostics; LeverUp preflight remains candidate-triggered; position management runs only for active/pending entries.");

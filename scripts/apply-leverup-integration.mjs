import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
  console.log("Applied LeverUp advisor integration: " + label);
}

const importLine = 'import { prepareLeverUpAdvisorPlan, formatLeverUpAdvisorLine, runLeverUpDiagnostics } from "../src/leverup-advisor.js";';
const nativeFeedImport = 'import { runLeverUpNativeSampler } from "../src/leverup-native-feed.js";';
const coordinatorImport = 'import { runLeverUpPositionManager } from "../src/leverup-coordinator.js";';
const approvalSimulationImport = 'import { simulateLeverUpTokenApproval } from "../src/leverup-approval.js";';
const profitsImport = 'import { buildLeverUpProfitReport } from "../src/leverup-profits.js";';
if (!source.includes(importLine)) source = importLine + "\n" + source;
if (!source.includes(nativeFeedImport)) source = nativeFeedImport + "\n" + source;
if (!source.includes(coordinatorImport)) source = coordinatorImport + "\n" + source;
if (!source.includes(approvalSimulationImport)) source = approvalSimulationImport + "\n" + source;
if (!source.includes(profitsImport)) source = profitsImport + "\n" + source;
if (!source.includes("function compactCielSetupMessage(")) {
  const compactHelper = `function compactCielSetupMessage(p, s, r, monUsd, forecast) {
  const score = Math.round(Number(s?.confidence || 0) * 100);
  const mode = s?.mode === "RANGE_SCALP" ? "RANGE" : "TREND";
  const review = String(r?.verdict || "WAIT");
  const median = Number(forecast?.medianReturnPct);
  const lower = Number(forecast?.lowerReturnPct);
  const upper = Number(forecast?.upperReturnPct);
  const forecastLine = forecast?.available && [median, lower, upper].every(Number.isFinite)
    ? "Forecast 5m: " + median.toFixed(3) + "% (" + lower.toFixed(3) + " to " + upper.toFixed(3) + "%)"
    : "Forecast: unavailable";
  return [
    (review === "APPROVE" ? "📈 " : "🟡 ") + String(p?.side || "—") + " " + String(p?.symbol || "—") + " · " + mode,
    "Signal: " + String(p?.id || "—") + " · PROPOSED",
    "Entry $" + fmt(p?.entry_price) + " · SL $" + fmt(p?.stop_price) + " · TP $" + fmt(p?.target_price),
    "Technical: " + score + "/100 · " + String(s?.strategy || "—"),
    forecastLine,
    "Review: " + review + " · hold ≤" + Number(s?.holdMinutes || (mode === "RANGE" ? 12 : 180)) + "m"
  ].join("\\n");
}
`;

  source = source.replace(coordinatorImport + "\n", coordinatorImport + "\n" + compactHelper);
}

const nativeAdvisorBefore = "  if (liveMode) {\n    console.log(\"CIEL live signal cycle skipped: Hyperliquid-derived signals are not eligible for live mode.\");\n    return;\n  }";
once(nativeAdvisorBefore, "", "route live and paper through the same CIEL candidate generation, scoring and review pipeline");
const monUsdHelper = [
  "async function getCachedLeverUpMonUsd(env, now = Date.now()) {",
  "  try {",
  '    const diagnostics = await env?.CIEL_STATE?.get("ciel:leverup:diagnostics:v1", "json");',
  '    const quotes = Object.values(diagnostics?.marketPreflights || {}).map((item) => ({ at: Number(item?.checkedAt || 0), price: Number(item?.usdLimits?.monUsdPrice), status: String(item?.status || "") })).filter((item) => item.status === "PASS" && item.at > 0 && now >= item.at && now - item.at <= 10 * 60 * 1000 && Number.isFinite(item.price) && item.price > 0).sort((a, b) => b.at - a.at);',
  "    return quotes[0]?.price || 0;",
  "  } catch { return 0; }",
  "}",
  ""
].join("\n");
once("async function runAdvisorCycle(", monUsdHelper + "async function runAdvisorCycle(", "use a fresh cached LeverUp MON/USD oracle quote when Hyperliquid has no MON market");

function patchFunctionMonUsd(startMarker, endMarker, gate, replacement, label) {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  if (start < 0 || end < start) throw new Error(label + ": function boundaries missing");
  let segment = source.slice(start, end).replaceAll("prices.MON", "monUsdPrice");
  const count = segment.split(gate).length - 1;
  if (count !== 1) throw new Error(label + ": expected one MON gate, found " + count);
  segment = segment.replace(gate, replacement);
  source = source.slice(0, start) + segment + source.slice(end);
  console.log("Applied LeverUp advisor integration: " + label);
}

patchFunctionMonUsd("async function runAdvisorCycle(", "__name(runAdvisorCycle",
  "if (now - lastTickAt > MAX_AGE || !(monUsdPrice > 0)) return;",
  "const monUsdPrice = Number(prices.MON) > 0 ? Number(prices.MON) : 0;\n  if (now - lastTickAt > MAX_AGE) return;",
  "run technical analysis without requiring a collateral conversion quote; LeverUp obtains its own fresh oracle quote during candidate preflight");

patchFunctionMonUsd("async function manageOpenPositions(", "__name(manageOpenPositions",
  "if (now - lastTickAt > MAX_AGE || !(monUsdPrice > 0)) return;",
  "const monUsdPrice = Number(prices.MON) > 0 ? Number(prices.MON) : await getCachedLeverUpMonUsd(env, now);\n  if (now - lastTickAt > MAX_AGE) return;",
  "keep stop/target/profit-protection monitoring active when MON/USD conversion is unavailable; P&L remains unavailable until a valid quote exists");

patchFunctionMonUsd("async function handleAdvisorCallback(", "__name(handleAdvisorCallback",
  'if (!lastTickAt || now - lastTickAt > MAX_AGE || !(monUsdPrice > 0)) return { handled: true, removeButtons: false, reply: "Market data is stale. Tracking was not started; try again when the feed is fresh." };',
  'const monUsdPrice = Number(prices.MON) > 0 ? Number(prices.MON) : await getCachedLeverUpMonUsd(env, now);\n    if (!lastTickAt || now - lastTickAt > MAX_AGE) return { handled: true, removeButtons: false, reply: "Market data is stale. Tracking was not started; try again when the feed is fresh." };',
  "allow reference-price tracking and close confirmations without blocking on a MON/USD display conversion");

const oldLiveMon = 'async function liveMon(env) {\n  const x = await env.DB.prepare("SELECT mid_price,ts_ms FROM market_samples WHERE symbol=\'MON\' ORDER BY ts_ms DESC LIMIT 1").first();\n  return x && Date.now() - x.ts_ms <= MAX_AGE ? Number(x.mid_price) || 0 : 0;\n}';
const newLiveMon = 'async function liveMon(env) {\n  const x = await env.DB.prepare("SELECT mid_price,ts_ms FROM market_samples WHERE symbol=\'MON\' ORDER BY ts_ms DESC LIMIT 1").first();\n  const sampled = x && Date.now() - Number(x.ts_ms) <= MAX_AGE ? Number(x.mid_price) || 0 : 0;\n  return sampled > 0 ? sampled : await getCachedLeverUpMonUsd(env, Date.now());\n}';
once(oldLiveMon, newLiveMon, "use the LeverUp MON/USD quote for /signals, /positions and /entered when no Hyperliquid MON sample exists");
const oldCandle = "  for (const [symbol,one,five] of coreCandleResults) coreScalpData.set(symbol,{one,five});";
const newCandle = "  for (const [symbol, one, five] of coreCandleResults) coreScalpData.set(symbol, { one, five });\n  const missingTrendSymbols = coreScalpSymbols.filter((symbol) => {\n    const rows = coreScalpData.get(symbol)?.five || [];\n    const latest = Number(rows[rows.length - 1]?.close_ts_ms || 0);\n    return rows.length < 40 || now - latest > 7 * 60 * 1000;\n  });\n  if (missingTrendSymbols.length) {\n    try {\n      const placeholders = missingTrendSymbols.map(() => \"?\").join(\",\");\n      const candleRows = await env.DB.prepare(\n        \"WITH ranked AS (SELECT symbol,open_ts_ms,close_ts_ms,open_price,high_price,low_price,close_price,volume,ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY close_ts_ms DESC) AS rn FROM market_candles WHERE symbol IN (\" + placeholders + \") AND interval=? AND close_ts_ms<=?) SELECT symbol,open_ts_ms,close_ts_ms,open_price,high_price,low_price,close_price,volume FROM ranked WHERE rn<=60 ORDER BY symbol,close_ts_ms ASC\"\n      ).bind(...missingTrendSymbols, \"5m\", now).all();\n      const bySymbol = new Map();\n      for (const row of candleRows.results || []) {\n        const rows = bySymbol.get(row.symbol) || [];\n        rows.push(row);\n        bySymbol.set(row.symbol, rows);\n      }\n      for (const symbol of missingTrendSymbols) {\n        const existing = coreScalpData.get(symbol) || { one: [], five: [] };\n        const fallback = bySymbol.get(symbol) || [];\n        if (fallback.length >= 40) existing.five = fallback;\n        coreScalpData.set(symbol, existing);\n      }\n    } catch (candleError) {\n      console.error(\"Core 5m candle D1 fallback failed: \" + String(candleError?.message || candleError).slice(0, 200));\n    }\n  }";
once(oldCandle, newCandle, "load fresh closed 5m candles from D1 when Durable Object buffers are empty or stale");



once(
  "  async hyperliquidDisabledForLiveMode() {\n    const liveOverride = await this.env?.CIEL_STATE?.get(\"ciel:control:live-enabled\").catch(() => null);\n    return String(liveOverride ?? this.env?.LEVERUP_LIVE_TRADING).toLowerCase() === \"true\" &&\n      String(this.env?.LEVERUP_KILL_SWITCH).toLowerCase() === \"false\";\n  }",
  "  async hyperliquidDisabledForLiveMode() {\n    // Hyperliquid remains a read-only market-data source for the shared CIEL signal pipeline.\n    // Live execution and position management remain exclusively on LeverUp.\n    return false;\n  }",
  "keep Hyperliquid read-only market data active for shared paper/live signals",
);

once(
  '    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase(), direction = candidate.side === "LONG" ? 1 : -1;\n    const stop = candidate.entry * (1 - direction * candidate.stopPct / 100), target = candidate.entry * (1 + direction * candidate.targetPct / 100), expires = now + 15 * 6e4;',
  '    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase(), direction = candidate.side === "LONG" ? 1 : -1;\n    const stop = candidate.entry * (1 - direction * candidate.stopPct / 100), target = candidate.entry * (1 + direction * candidate.targetPct / 100), expires = now + 15 * 6e4;\n    const leverUpPlan = await prepareLeverUpAdvisorPlan({ env, candidate, reviewed, signalId: id, now, technicalOnly });',
  "run a live read-only LeverUp preflight for fully confirmed CIEL approvals",
);

once(
  '      await notify(env, setupMessage(position, candidate, reviewed, prices.MON, forecast, quality.market, intraday) + paperLine, [',
  '      const leverUpLine = formatLeverUpAdvisorLine(leverUpPlan);\n      await notify(env, compactCielSetupMessage(position, candidate, reviewed, prices.MON, forecast) + paperLine + "\\n\\n" + leverUpLine, [',
  "attach real LeverUp preflight, collateral and fee status to the CIEL trade card",
);


once(
  "    if (url.pathname === \"/health\") {",
  "    if (url.pathname === \"/api/leverup/diagnostics\") {\n      const supplied = request.headers.get(\"authorization\") || \"\";\n      const expected = String(env?.TELEGRAM_WEBHOOK_SECRET || \"\").trim();\n      if (!expected || supplied !== \"Bearer \" + expected) return json2({ ok: false, error: \"Unauthorized\", orderSubmitted: false }, 401);\n      try { return json2(await runLeverUpDiagnostics({ env })); }\n      catch (error) { return json2({ ok: false, mode: \"READ_ONLY_DRY_RUN\", error: String(error?.message || error).slice(0, 240), orderSubmitted: false }, 503); }\n    }\n    if (url.pathname === \"/health\") {",
  "protect read-only LeverUp diagnostics with the existing Telegram webhook secret",
);


const oneTimeMarketDiagnosticRoute = `    if (url.pathname === "/_internal/leverup-diagnostics-once" && request.method === "GET") {
      const tokenKey = "ciel:leverup:diagnostics:one-time-token";
      const expected = String(await env?.CIEL_STATE?.get(tokenKey) || "");
      const supplied = String(url.searchParams.get("token") || "");
      if (!expected || supplied !== expected) return json2({ ok: false, error: "Unauthorized", orderSubmitted: false }, 401);
      await env.CIEL_STATE.delete(tokenKey);
      const requestedSymbol = String(url.searchParams.get("symbol") || "BTC").toUpperCase();
      const allowedSymbols = ["BTC","ETH","BNB","XRP","HYPE","ONDO","KPEPE","TRX","AAVE","ADA","DOGE","LINK","PUMP","SEI","SOL","SUI","UNI","VIRTUAL"];
      if (!allowedSymbols.includes(requestedSymbol)) return json2({ ok: false, error: "Unsupported market symbol", allowedSymbols, orderSubmitted: false }, 400);
      const skipCoordinator = url.searchParams.get("skipCoordinator") === "true";
      const candidates = [
        ["ALCHEMY_RPC", env?.ALCHEMY_RPC],
        ["MONAD_RPC2", "https://rpc2.monad.xyz"],
        ["LEVERUP_RPC_URL", env?.LEVERUP_RPC_URL],
        ["MONAD_RPC1", "https://rpc1.monad.xyz"],
        ["MONAD_RPC", "https://rpc.monad.xyz"],
      ];
      const rpcCandidates = [];
      let selectedRpc = null;
      for (const [provider, endpoint] of candidates) {
        if (!endpoint) continue;
        let host = "unknown";
        try { host = new URL(endpoint).hostname; } catch {}
        try {
          const response = await fetch(endpoint, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
            signal: AbortSignal.timeout(5000),
          });
          const payload = await response.json();
          const chainId = String(payload?.result || "").toLowerCase();
          rpcCandidates.push({ provider, host, httpStatus: response.status, chainId, isMonadMainnet: response.ok && chainId === "0x8f" });
          if (response.ok && chainId === "0x8f") { selectedRpc = { provider, endpoint, host, chainId }; break; }
        } catch (error) {
          rpcCandidates.push({ provider, host, error: String(error?.message || error).slice(0, 140) });
        }
      }
      if (!selectedRpc) return json2({ ok: false, rpcCandidates, marketPreflights: {}, orderSubmitted: false, approvalTransactionSubmitted: false }, 503);
      try {
        const diagnostics = await runLeverUpDiagnostics({ env: { ...env, LEVERUP_RPC_URL: selectedRpc.endpoint }, now: Date.now(), symbols: [requestedSymbol], skipCoordinator });
        const marketPreflights = Object.fromEntries(Object.entries(diagnostics.marketPreflights || {}).map(([symbol, market]) => [symbol, {
          status: market.status, reason: market.reason || null,
          selectedLeverage: market.selectedLeverage || null, marketMaxLeverage: market.marketMaxLeverage || null,
          minimumNotionalUsd: market.minimumNotionalUsd || null, minimumCollateralUsd: market.minimumCollateralUsd || null,
          minimumMarginMon: market.minimumMarginMon || null, plannedMarginMon: market.plannedMarginMon || null,
          plannedNotionalUsd: market.plannedNotionalUsd || null,
          wmonAllowanceRaw: market.wmonAllowanceRaw || "0",
          wmonRequiredAllowanceRaw: market.wmonRequiredAllowanceRaw || "0",
          wmonAllowanceReady: market.wmonAllowanceShortfallRaw === "0",
          feeToken: market.feeToken || null,
          feeAllowanceRaw: market.feeAllowanceRaw || "0",
          feeRequiredAllowanceRaw: market.feeRequiredAllowanceRaw || "0",
          feeAllowanceShortfallRaw: market.feeAllowanceShortfallRaw || "0",
          autoApprovalConfigured: market.autoApprovalConfigured === true,
          approvalWillRunOnlyOnLiveEntry: market.approvalWillRunOnlyOnLiveEntry === true,
          orderSubmitted: false, approvalTransactionSubmitted: false,
        }]));
        let approvalSimulation = null;
        if (url.searchParams.get("simulateApproval") === "true") {
          const btc = diagnostics.marketPreflights?.BTC;
          if (!btc || btc.status !== "PASS" || !btc.wmonRequiredAllowanceRaw) {
            approvalSimulation = { status: "NOT_RUN", reason: btc?.reason || "BTC_PREFLIGHT_NOT_PASS", transactionBroadcast: false };
          } else {
            approvalSimulation = await simulateLeverUpTokenApproval({
              env: { ...env, LEVERUP_RPC_URL: selectedRpc.endpoint },
              tokenAddress: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
              requiredAmount: btc.wmonRequiredAllowanceRaw,
            });
          }
        }
        return json2({
          ok: diagnostics.ok, checkedAt: diagnostics.checkedAt,
          rpc: { provider: selectedRpc.provider, host: selectedRpc.host, chainId: selectedRpc.chainId },
          rpcCandidates, marketPreflights, approvalSimulation,
          coordinator: { status: diagnostics.coordinator?.status || "NOT_CHECKED", reason: diagnostics.coordinator?.reason || null },
          liveTradingEnabled: diagnostics.liveTradingEnabled, killSwitchActive: diagnostics.killSwitchActive,
          orderSubmitted: false, approvalTransactionSubmitted: false,
        });
      } catch (error) {
        return json2({ ok: false, rpcCandidates, rpc: { provider: selectedRpc.provider, host: selectedRpc.host, chainId: selectedRpc.chainId },
          error: String(error?.message || error).slice(0, 220), orderSubmitted: false, approvalTransactionSubmitted: false }, 503);
      }
    }
`;
once(
  '  if (cmd === "/profits") {',
  '  if (cmd === "/profits") {\n    const liveOverride = await env?.CIEL_STATE?.get("ciel:control:live-enabled").catch(() => null);\n    const liveMode = String(liveOverride ?? env?.LEVERUP_LIVE_TRADING).toLowerCase() === "true" && String(env?.LEVERUP_KILL_SWITCH).toLowerCase() === "false";\n    if (liveMode) {\n      try { await notify(env, await buildLeverUpProfitReport({ env })); }\n      catch (error) { await notify(env, "🔴 LIVE PROFITS UNAVAILABLE — no paper figures were substituted. " + String(error?.message || error).slice(0, 240)); }\n      return true;\n    }',
  "route /profits to the live LeverUp settlement ledger whenever live execution is enabled",
);

const blockVisionContractSourceRoute = `    if (url.pathname === "/internal/blockvision/leverup-diamond-source" && request.method === "GET") {
      const expected = String(env?.TELEGRAM_WEBHOOK_SECRET || "").trim();
      if (!expected || request.headers.get("authorization") !== "Bearer " + expected) return json2({ ok: false, error: "Unauthorized" }, 401);
      const apiKey = String(env?.BLOCKVISION_API_KEY || "").trim();
      if (!apiKey) return json2({ ok: false, error: "BLOCKVISION_API_KEY secret is not bound" }, 503);
      const address = "0xea1b8E4aB7f14F7dCA68c5B214303B13078FC5ec";
      const headers = { accept: "application/json", "x-api-key": apiKey };
      try {
        const [sourceResponse, detailResponse] = await Promise.all([
          fetch("https://api.blockvision.org/v2/monad/contract/source/code?address=" + address, { headers, signal: AbortSignal.timeout(15000) }),
          fetch("https://api.blockvision.org/v2/monad/contract/detail?address=" + address, { headers, signal: AbortSignal.timeout(15000) })
        ]);
        const [source, detail] = await Promise.all([sourceResponse.json().catch(() => ({})), detailResponse.json().catch(() => ({}))]);
        return json2({ ok: sourceResponse.ok && Number(source?.code) === 0, http: { source: sourceResponse.status, detail: detailResponse.status }, source: { code: source?.code, reason: source?.reason, message: source?.message, contractAddress: source?.result?.contractAddress, contractName: source?.result?.contractName, verificationStatus: source?.result?.status, sourceCode: Array.isArray(source?.result?.sourceCode) ? source.result.sourceCode : [] }, detail: { code: detail?.code, reason: detail?.reason, creator: detail?.result?.creator, creationTx: detail?.result?.creationTx, verifyStatus: detail?.result?.verifyStatus, contractMeta: detail?.result?.contractMeta, bytecodeHash: detail?.result?.bytecodeHash } });
      } catch (error) { return json2({ ok: false, error: String(error?.message || error).slice(0, 220) }, 502); }
    }
`;
once(
  '    if (url.pathname === "/health") {',
  blockVisionContractSourceRoute + '    if (url.pathname === "/health") {',
  "add authenticated BlockVision contract source and proxy metadata retrieval without exposing the API key",
);
once(
  '    if (url.pathname === "/health") {',
  oneTimeMarketDiagnosticRoute + '    if (url.pathname === "/health") {',
  "add one-time token-protected read-only LeverUp market and RPC diagnostics",
);

once(
  '  async scheduled(_event, env, ctx) {\n    ctx.waitUntil(ensureTelegramWebhook(env));',
  `  async scheduled(_event, env, ctx) {
    ctx.waitUntil(ensureTelegramWebhook(env));
    if (String(env?.LEVERUP_PREFLIGHT_ENABLED).toLowerCase() === "true") {
      ctx.waitUntil((async () => {
        const now = Date.now();
        try {
          const nativeFeed = await runLeverUpNativeSampler({ env, now });
          await env.CIEL_STATE.put("ciel:leverup:native-feed:last-error", "", { expirationTtl: 3600 });
          console.log("LeverUp-native feed " + nativeFeed.status + ": " + nativeFeed.warmedMarkets + "/" + nativeFeed.marketCount + " markets warmed.");
        } catch (nativeFeedError) {
          await env.CIEL_STATE.put("ciel:leverup:native-feed:status", "DEGRADED").catch(() => void 0);
          await env.CIEL_STATE.put("ciel:leverup:native-feed:last-error", String(nativeFeedError?.message || nativeFeedError).slice(0, 220), { expirationTtl: 3600 }).catch(() => void 0);
          console.error("LeverUp-native sampler failed: " + String(nativeFeedError?.message || nativeFeedError).slice(0, 220));
        }
        try {
          const marketResponse = await feedStub2(env).fetch("https://feed/ensure", { method: "POST" });
          const marketSnapshot = await marketResponse.json().catch(() => ({}));
          if (!marketResponse.ok || !Array.isArray(marketSnapshot.markets)) {
            throw new Error("SHARED_SIGNAL_MARKET_FEED_UNAVAILABLE: " + String(marketSnapshot.status || marketResponse.status));
          }
          const prices = Object.fromEntries(marketSnapshot.markets.filter((market) => market && market.symbol && Number.isFinite(Number(market.price)) && Number(market.price) > 0).map((market) => [String(market.symbol).toUpperCase(), Number(market.price)]));
          const lastTickAt = Number(marketSnapshot.lastTickAt || 0);
          if (!lastTickAt || now - lastTickAt > 18e4) {
            console.log("CIEL shared advisor waiting for fresh Hyperliquid prices; no setup emitted.");
          } else {
            await runAdvisorCycle(env, prices, now, lastTickAt, null, null, null);
            const scan = await env.CIEL_STATE.get("ciel:advisor:last-scan", "json").catch(() => null);
            console.log("CIEL shared live advisor evaluated: " + Number(scan?.historySymbols || 0) + " history markets, " + (Array.isArray(scan?.candidates) ? scan.candidates.length : 0) + " technical candidates.");
          }
        } catch (advisorError) {
          console.error("CIEL shared live advisor cycle failed: " + String(advisorError?.message || advisorError).slice(0, 220));
          await env.CIEL_STATE.put("ciel:leverup:native-feed:advisor-error", String(advisorError?.message || advisorError).slice(0, 220), { expirationTtl: 3600 }).catch(() => void 0);
        }
        try {
          const diagnosticKey = "ciel:leverup:diagnostics:v1";
          const last = Number(await env.CIEL_STATE.get(diagnosticKey + ":checkedAt") || 0);
          if (!last || now - last >= 5 * 60 * 1000) {
            const symbols = ["BTC","ETH","SOL"];
            const symbol = symbols[Math.floor(now / (5 * 60 * 1000)) % symbols.length];
            let diagnostics;
            try { diagnostics = await runLeverUpDiagnostics({ env: { ...env, LEVERUP_LIVE_TRADING: "false", LEVERUP_KILL_SWITCH: "true" }, now, symbols: [symbol], skipCoordinator: false }); }
            catch (error) { diagnostics = { ok: false, mode: "READ_ONLY_DRY_RUN", error: String(error?.message || error).slice(0, 220), marketPreflights: {}, orderSubmitted: false }; }
            const previous = await env.CIEL_STATE.get(diagnosticKey, "json").catch(() => null) || {};
            const merged = { ...diagnostics, marketPreflights: { ...(previous.marketPreflights || {}), ...(diagnostics.marketPreflights || {}) }, coordinator: diagnostics.coordinator || previous.coordinator || { status: "NOT_CHECKED" } };
            merged.ok = Object.keys(merged.marketPreflights).length === 3 && Object.values(merged.marketPreflights).every((market) => market.status === "PASS") && merged.coordinator.status === "PASS";
            merged.status = merged.ok ? "READ_ONLY_CHECKS_PASS" : "READ_ONLY_CHECKS_INCOMPLETE";
            await env.CIEL_STATE.put(diagnosticKey, JSON.stringify(merged), { expirationTtl: 3600 });
            await env.CIEL_STATE.put(diagnosticKey + ":checkedAt", String(now), { expirationTtl: 3600 });
          }
          const lifecycle = await runLeverUpPositionManager({ env, db: env.DB, now });
          await env.CIEL_STATE.put("ciel:leverup:position-manager:last-run", JSON.stringify({ at: now, status: lifecycle.status, checked: lifecycle.checked || 0, submitted: lifecycle.submitted || 0, discoveryError: lifecycle.discoveryError || null, reconciliation: lifecycle.reconciliation?.status || null }), { expirationTtl: 3600 });
          if (lifecycle.status === "BLOCKED_POSITION_DISCOVERY") console.error("LeverUp position management blocked: position indexer unavailable; no false empty-position state assumed.");
          if (lifecycle.submitted) console.log("LeverUp position manager submitted " + lifecycle.submitted + " exit intent(s).");
        } catch (error) {
          console.error("LeverUp scheduled diagnostics/position-management cycle failed: " + String(error?.message || error).slice(0, 220));
        }
      })());
    }`,
  "run read-only diagnostics and position/settlement management from the existing minute cron"
);

await writeFile(file, source);
console.log("Wrote LeverUp-integrated Worker candidate: " + file);

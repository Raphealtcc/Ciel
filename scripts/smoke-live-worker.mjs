const BASE = process.env.CIEL_STAGING_BASE_URL || "https://ciel2.gatakehanami.workers.dev";
const stagingHost = "ciel2.gatakehanami.workers.dev";
if (new URL(BASE).hostname !== stagingHost) {
  throw new Error("Refusing to smoke-test a non-staging host: " + new URL(BASE).hostname);
}

const routes = [
  ["/", "root"],
  ["/health", "health"],
  ["/api/markets", "markets"],
  ["/api/candles?symbol=BTC&interval=15m", "candles"],
  ["/api/orderbook?symbol=BTC", "orderbook-BTC"],
  ["/api/orderbook?symbol=ETH", "orderbook-ETH"],
  ["/api/orderbook?symbol=MON", "orderbook-MON"],
  ["/api/orderbook?symbol=ONDO", "orderbook-ONDO"],
  ["/api/orderbook?symbol=ADA", "orderbook-ADA"],
  ["/api/positions", "positions"],
  ["/api/signals", "signals"],
  ["/api/research", "research"],
  ["/api/intraday?symbol=BTC", "intraday"],
  ["/api/alerts?limit=5", "alerts"],\n  ["/api/paper", "paper"],\n  ["/api/diagnostics", "diagnostics"],\n  ["/api/candles?symbol=BTC&interval=15m&limit=500", "candles-history"],
];

const results = [];
const failures = [];
for (const [path, name] of routes) {
  const response = await fetch(new URL(path, BASE), {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  const details = {};
  if (name === "health") Object.assign(details, { ok: body?.ok, connected: body?.connected, websocketConnected: body?.websocketConnected, connectionState: body?.connectionState, degraded: body?.degraded, fresh: body?.fresh, lastTickAt: body?.lastTickAt, lastTickAgeMs: body?.lastTickAt ? Date.now() - Number(body.lastTickAt) : null, lastOpenAt: body?.lastOpenAt, lastCloseAt: body?.lastCloseAt, lastConnectAttemptAt: body?.lastConnectAttemptAt, lastPongAt: body?.lastPongAt, lastCloseCode: body?.lastCloseCode, lastCloseReason: body?.lastCloseReason, reconnectAttempts: body?.reconnectAttempts, lastError: body?.lastError });
  if (name === "markets") Object.assign(details, { connected: body?.connected, connectionState: body?.connectionState, marketCount: body?.markets?.length, pricedMarketCount: body?.markets?.filter((m) => Number(m.price) > 0).length, missingPriceSymbols: body?.markets?.filter((m) => !(Number(m.price) > 0)).map((m) => m.symbol), bookCount: body?.bookCount, bookWatchlistCount: body?.bookWatchlistCount, missingBookSymbols: body?.missingBookSymbols, monUsd: body?.markets?.find((m) => String(m.symbol).toUpperCase() === "MON")?.price ?? null });
  if (name === "candles") Object.assign(details, { count: body?.count, source: body?.source });
  if (name.startsWith("orderbook-")) Object.assign(details, { stale: body?.stale, source: body?.source, snapshotKeys: body?.snapshot && typeof body.snapshot === "object" ? Object.keys(body.snapshot).slice(0, 8) : [] });
  if (name === "positions" || name === "signals") Object.assign(details, { count: body?.count, monUsd: body?.monUsd, mode: body?.mode });
  if (name === "research") Object.assign(details, { model: body?.model, recentResearchCount: body?.recentResearch?.length, geminiCooldownActive: body?.geminiAnalysis?.cooldown?.active ?? null });
  if (name === "intraday") Object.assign(details, { sampledAt: body?.sampledAt, historyDays: body?.analysis?.historyDays, status: body?.analysis?.status, sampleDays: body?.analysis?.sampleDays ?? body?.analysis?.days ?? null });
  if (name === "alerts") Object.assign(details, { count: body?.count });\n  if (name === "paper") Object.assign(details, { starterBalanceMon: body?.starterBalanceMon, availableBalanceMon: body?.availableBalanceMon, openCount: body?.openCount, closedCount: body?.closedCount, fresh: body?.fresh });\n  if (name === "diagnostics") Object.assign(details, { schemaOk: body?.d1?.schemaOk, missingTables: body?.d1?.missingTables, geminiKeyCount: body?.secrets?.geminiKeyCount, telegramBotTokenConfigured: body?.secrets?.telegramBotTokenConfigured, telegramChatIdConfigured: body?.secrets?.telegramChatIdConfigured, telegramWebhookSecretConfigured: body?.secrets?.telegramWebhookSecretConfigured, webhookMarkerPresent: body?.telegramWebhookRegistrationMarkerPresent, paperOpenCount: body?.paper?.openCount });\n  if (name === "candles-history") Object.assign(details, { count: body?.count, source: body?.source });
  const result = {
    name,
    path,
    status: response.status,
    json: Boolean(body && typeof body === "object"),
    keys: body && typeof body === "object" ? Object.keys(body).slice(0, 12) : [],
    details,
  };
  results.push(result);
  console.log(JSON.stringify(result));
  if (!response.ok) throw new Error(name + " returned HTTP " + response.status + ": " + text.slice(0, 300));
  if (!body || typeof body !== "object") throw new Error(name + " did not return JSON");
  if (name === "health" && (body.ok !== true || body.connected !== true || body.fresh !== true)) failures.push("Health endpoint is not connected and fresh: " + JSON.stringify(body).slice(0, 500));
  if (name === "root" && body.mode !== "read-only-advisory") throw new Error("Unexpected root mode: " + JSON.stringify(body).slice(0, 300));
  if (name === "markets" && !Array.isArray(body.markets)) throw new Error("Markets endpoint did not return a markets array");\n  if (name === "markets" && body.missingSymbols?.includes("QNT")) failures.push("QNT xyz DEX alias still has no price.");\n  if (name === "markets" && body.missingBookSymbols?.includes("QNT")) failures.push("QNT xyz DEX alias still has no order book.");\n  if (name === "markets" && body.markets?.find((market) => market.symbol === "QNT")?.advisorReady !== false) failures.push("QNT must remain monitor-only until derivatives context exists.");
  if ((name === "candles" || name === "candles-history") && !Array.isArray(body.candles)) throw new Error("Candles endpoint did not return a candles array");\n  if (name === "candles-history" && Number(body.count) < 200) failures.push("Benchmark candle history has not reached 200 15m candles; bootstrap is incomplete.");\n  if (name === "paper" && (body.ok !== true || body.mode !== "paper-only" || body.readOnly !== true)) throw new Error("Paper ledger status endpoint is not healthy and read-only");\n  if (name === "paper" && Number(body.starterBalanceMon) !== 100) failures.push("Staging paper ledger must start at 100 MON.");\n  if (name === "diagnostics" && body.d1?.schemaOk !== true) failures.push("Staging D1 schema is incomplete: " + JSON.stringify(body.d1?.missingTables || []));\n  if (name === "intraday" && Number(body.analysis?.historyDays || 0) < 3) failures.push("Intraday history has fewer than three complete historical days.");
  if (name.startsWith("orderbook-") && !Object.hasOwn(body, "snapshot")) failures.push("Orderbook endpoint did not return its documented snapshot field");
  if (name.startsWith("orderbook-") && typeof body.stale !== "boolean") failures.push("Orderbook endpoint did not return its documented stale flag");
}
console.log("PASS: staging read-only Worker smoke-tested " + results.length + " GET routes; no POSTs or state-changing endpoints were called.");
if (failures.length) throw new Error(failures.join("\\n"));

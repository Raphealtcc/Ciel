const BASE = process.env.CIEL_LIVE_BASE_URL || "https://ciel.leno3z4rrrri.workers.dev";

const routes = [
  ["/", "root"],
  ["/health", "health"],
  ["/api/markets", "markets"],
  ["/api/candles?symbol=BTC&interval=15m", "candles"],
  ["/api/orderbook?symbol=BTC", "orderbook"],
  ["/api/positions", "positions"],
  ["/api/signals", "signals"],
  ["/api/research", "research"],
  ["/api/intraday?symbol=BTC", "intraday"],
  ["/api/alerts?limit=5", "alerts"],
];

const results = [];
for (const [path, name] of routes) {
  const response = await fetch(new URL(path, BASE), {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  const result = {
    name,
    path,
    status: response.status,
    json: Boolean(body && typeof body === "object"),
    keys: body && typeof body === "object" ? Object.keys(body).slice(0, 12) : [],
  };
  results.push(result);
  console.log(JSON.stringify(result));
  if (!response.ok) throw new Error(name + " returned HTTP " + response.status + ": " + text.slice(0, 300));
  if (!body || typeof body !== "object") throw new Error(name + " did not return JSON");
  if (name === "health" && body.ok !== true) throw new Error("Health endpoint is not healthy: " + JSON.stringify(body).slice(0, 500));
  if (name === "root" && body.mode !== "read-only-advisory") throw new Error("Unexpected root mode: " + JSON.stringify(body).slice(0, 300));
  if (name === "markets" && !Array.isArray(body.markets)) throw new Error("Markets endpoint did not return a markets array");
  if (name === "candles" && !Array.isArray(body.candles)) throw new Error("Candles endpoint did not return a candles array");
  if (name === "orderbook" && !body.orderbook && !body.book && !body.bids && !body.data) throw new Error("Orderbook endpoint returned no recognizable book payload");
}
console.log("PASS: live read-only Worker smoke-tested " + results.length + " GET routes; no POSTs or state-changing endpoints were called.");

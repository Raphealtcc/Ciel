import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");
const importLine = 'import { calculateCrossAssetBreadth, appendBookFlowSnapshot, appendTradeFlowEvents, summarizePersistentOrderFlow } from "../src/market-confirmation.js";';
if (!source.includes(importLine)) source = importLine + "\n" + source;

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
  console.log("Applied market-confirmation patch: " + label);
}

once(
  "  latestBooks = {};",
  "  latestBooks = {};\n  orderFlow = {};\n  orderFlowLastPersistAt = 0;",
  "add bounded in-memory order-flow state to the Hyperliquid Durable Object"
);
once(
  '      this.state.storage.get("lastContextSnapshotPersistAt")',
  '      this.state.storage.get("lastContextSnapshotPersistAt"),\n      this.state.storage.get("orderFlow")',
  "restore the recent order-flow ring from Durable Object storage"
);
once(
  "    this.lastContextSnapshotPersistAt = Number(values[21]) || 0;",
  "    this.lastContextSnapshotPersistAt = Number(values[21]) || 0;\n    this.orderFlow = values[22] || {};",
  "restore order-flow state without changing D1 schema"
);
once(
  '          // Temporary isolation: keep one allMids stream while diagnosing upstream 1006 closes.\n          // REST order-book fallback remains enabled independently.',
  '          // Keep order-flow subscriptions restricted to the six enabled markets.\n          for (const symbol of ["BTC", "ETH", "SOL", "BNB", "HYPE", "ADA", "PUMP"]) {\n            socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: symbol } }));\n            socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: symbol } }));\n          }',
  "subscribe to L2 and trades for BTC, ETH, SOL, BNB, HYPE"
);

const tradeAnchor = "    const data = packet.data;\n    if (packet.channel === \"candle\") {";
const tradeHandler = `    const data = packet.data;
    if (packet.channel === "trades") {
      const updates = Array.isArray(data) ? data : [data];
      const symbols = new Set(["BTC", "ETH", "SOL", "BNB", "HYPE", "ADA", "PUMP"]);
      for (const trade of updates) {
        const symbol = String(trade?.coin || "").trim().toUpperCase();
        if (!symbols.has(symbol)) continue;
        this.orderFlow[symbol] = appendTradeFlowEvents(this.orderFlow[symbol], [trade], Date.now());
      }
      const persistAt = Date.now();
      if (persistAt - Number(this.orderFlowLastPersistAt || 0) >= 10000) {
        this.orderFlowLastPersistAt = persistAt;
        await this.state.storage.put("orderFlow", this.orderFlow).catch(() => void 0);
      }
      return;
    }
    if (packet.channel === "candle") {`;
once(tradeAnchor, tradeHandler, "collect signed trade notional for independent order-flow validation");

once(
  "      this.latestBooks[symbol] = snapshot;\n      this.bookLastWrite[symbol] = now;",
  "      this.latestBooks[symbol] = snapshot;\n      if ([\"BTC\",\"ETH\",\"SOL\",\"BNB\",\"HYPE\",\"ADA\",\"PUMP\"].includes(symbol)) {\n        this.orderFlow[symbol] = appendBookFlowSnapshot(this.orderFlow[symbol], snapshot, now);\n        if (now - Number(this.orderFlowLastPersistAt || 0) >= 10000) {\n          this.orderFlowLastPersistAt = now;\n          await this.state.storage.put(\"orderFlow\", this.orderFlow).catch(() => void 0);\n        }\n      }\n      this.bookLastWrite[symbol] = now;",
  "calculate best-quote OFI from consecutive L2 snapshots and persist at most every 10 seconds"
);

once(
  `        oiChangePct
      };`,
  `        oiChangePct,
        marketBreadth: calculateCrossAssetBreadth({
          history: this.history,
          symbols: this.watchlist(),
          excludeSymbol: symbol,
          volumeBySymbol: Object.fromEntries(this.watchlist().map((asset) => [asset, Number(this.contextHistory[asset]?.[this.contextHistory[asset].length - 1]?.day_ntl_volume)])),
          minimumVolumeUsd: 250000,
          now
        }),
        orderFlow: summarizePersistentOrderFlow(this.orderFlow[symbol], now)
      };`,
  "attach candidate-excluded 5m/15m cross-asset breadth and persistent-flow research snapshots"
);

const reviewerAnchor = "    const reviewerMarket = { ...quality.market, fundingHourlyPct: Number.isFinite(fundingHourly) ? fundingHourly * 100 : null, fundingAprPct };";
const reviewerReplacement = `    const reviewerMarket = { ...quality.market, fundingHourlyPct: Number.isFinite(fundingHourly) ? fundingHourly * 100 : null, fundingAprPct };
    reviewerMarket.marketBreadth = liveEvidence?.[candidate.symbol]?.marketBreadth || null;
    reviewerMarket.orderFlow = liveEvidence?.[candidate.symbol]?.orderFlow || null;
    candidate.marketBreadth = reviewerMarket.marketBreadth;
    candidate.orderFlow = reviewerMarket.orderFlow;`;
once(reviewerAnchor, reviewerReplacement, "attach independent breadth and order-flow observations to the existing audit record and proposal");

const telegramAnchor = '"Signal quality: " + Number(s?.signalQualityScore || 0) + "/100 evidence score, not win probability",';
const telegramReplacement = `"Signal quality: " + Number(s?.signalQualityScore || 0) + "/100 evidence score, not win probability",
"Market breadth (research only): " + (s?.marketBreadth?.status === "READY" ? Number(s.marketBreadth.up5Pct).toFixed(0) + "% up 5m / " + Number(s.marketBreadth.up15Pct).toFixed(0) + "% up 15m (n=" + s.marketBreadth.n15 + ")" : "insufficient cross-asset history"),
"Persistent flow (research only): " + (s?.orderFlow?.status || "INSUFFICIENT") + (s?.orderFlow?.direction ? " " + s.orderFlow.direction : ""),`;
once(telegramAnchor, telegramReplacement, "show the two shadow research measurements without changing entry eligibility");

await writeFile(file, source);
console.log("Wrote independently measured breadth/order-flow Worker candidate: " + file);

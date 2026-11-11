import { readFile, writeFile } from "node:fs/promises";

const file = "reconstructed/patched-worker.js";
let source = await readFile(file, "utf8");

const oldBlock = [
  '        const placeholders = fallbackEligible.map(() => "?").join(",");',
  "        const candleRows = await env.DB.prepare(",
  '          "WITH ranked AS (SELECT symbol,open_ts_ms,close_ts_ms,open_price,high_price,low_price,close_price,volume,ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY open_ts_ms DESC) AS rn FROM market_candles WHERE symbol IN (" + placeholders + ") AND interval=? AND open_ts_ms<=?) SELECT symbol,open_ts_ms,close_ts_ms,open_price,high_price,low_price,close_price,volume FROM ranked WHERE rn<=60 ORDER BY symbol,open_ts_ms ASC"',
  '        ).bind(...fallbackEligible, "5m", now - 5 * 60 * 1e3).all();',
  "        const bySymbol = /* @__PURE__ */ new Map();",
  "        for (const row of candleRows.results || []) {",
  "          const rows = bySymbol.get(row.symbol) || [];",
  "          rows.push(row);",
  "          bySymbol.set(row.symbol, rows);",
  "        }",
].join("\n");

const newBlock = [
  "        const candleResults = await Promise.all(fallbackEligible.map(async (symbol) => {",
  "          const result = await env.DB.prepare(",
  '            "SELECT symbol,open_ts_ms,close_ts_ms,open_price,high_price,low_price,close_price,volume FROM market_candles WHERE symbol=? AND interval=? AND open_ts_ms<=? ORDER BY open_ts_ms DESC LIMIT 60"',
  '          ).bind(symbol, "5m", now - 5 * 60 * 1e3).all();',
  "          return [symbol, (result.results || []).reverse()];",
  "        }));",
  "        const bySymbol = /* @__PURE__ */ new Map(candleResults);",
].join("\n");

const count = source.split(oldBlock).length - 1;
if (count !== 1) throw new Error("Indexed candle fallback patch: expected one window-function block, found " + count);
source = source.replace(oldBlock, newBlock);
await writeFile(file, source);
console.log("Applied indexed per-symbol 5m fallback: max 60 indexed rows per missing symbol.");

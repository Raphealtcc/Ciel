import { readFile, writeFile } from "node:fs/promises";

const file = "reconstructed/patched-worker.js";
let source = await readFile(file, "utf8");

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected one match, found " + count);
  source = source.replace(before, after);
}

once(
  "if (now - last >= 30 * 60e3) fallbackEligible.push(symbol);",
  "if (now - last >= 5 * 60e3) fallbackEligible.push(symbol);",
  "retry missing 5m history after five minutes"
);
once(
  `const rows = coreScalpData.get(symbol)?.five || [];
    const latest = Number(rows[rows.length - 1]?.close_ts_ms || 0);
    return rows.length < 40 || now - latest > 7 * 60 * 1e3;`,
  `const rows = coreScalpData.get(symbol)?.five || [];
    const validRows = rows.filter((row) => Number(row.close_ts_ms) > 0 && [row.open_price, row.high_price, row.low_price, row.close_price].every((value) => Number(value) > 0));
    const latest = Number(validRows[validRows.length - 1]?.close_ts_ms || 0);
    return validRows.length < 40 || now - latest > 7 * 60 * 1e3;`,
  "retry fallback when the DO cache has fewer than 40 valid OHLC candles"
);

const oldLoop = [
  "        for (const symbol of fallbackEligible) {",
  "          const existing = coreScalpData.get(symbol) || { one: [], five: [] };",
  "          const fallback = bySymbol.get(symbol) || [];",
  "          if (fallback.length >= 40) existing.five = fallback;",
  "          coreScalpData.set(symbol, existing);",
  "        }"
].join("\n");

const newLoop = [
  "        let persistedCoreTrendCandles = false;",
  "        for (const symbol of fallbackEligible) {",
  "          const existing = coreScalpData.get(symbol) || { one: [], five: [] };",
  "          const fallback = bySymbol.get(symbol) || [];",
  "          if (fallback.length >= 40) {",
  "            existing.five = fallback;",
  "            coreTrendCandles[symbol] = fallback;",
  "            persistedCoreTrendCandles = true;",
  "          }",
  "          coreScalpData.set(symbol, existing);",
  "        }",
  "        if (persistedCoreTrendCandles && paperStorage?.put) {",
  "          await paperStorage.put(\"coreTrendCandles\", coreTrendCandles).catch(() => void 0);",
  "        }"
].join("\n");

once(oldLoop, newLoop, "persist D1 fallback candles into Durable Object storage");
await writeFile(file, source);
console.log("Applied persistent 5m D1 fallback with bounded five-minute retry.");

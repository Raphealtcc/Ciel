import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const workerPath = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let worker = await readFile(workerPath, "utf8");
const universeImport = 'import { restrictTemporaryMarketUniverse } from "../src/market-universe.js";';
if (!worker.includes(universeImport)) worker = universeImport + "\n" + worker;

function once(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected one match, found " + count);
  return source.replace(before, after);
}

worker = once(worker,
  "  return [...new Set(parsed)].slice(0, 100);",
  "  return restrictTemporaryMarketUniverse([...new Set(parsed)]);",
  "restrict the Hyperliquid watchlist to BTC, ETH, SOL and BNB");

worker = once(worker,
  'var CANDLE_HISTORY_SYMBOLS = /* @__PURE__ */ new Set(["BTC", "ETH", "MON", "SOL"]);',
  'var CANDLE_HISTORY_SYMBOLS = /* @__PURE__ */ new Set(["BTC", "ETH", "SOL", "BNB"]);',
  "retain native 5m candle history for the four active markets");

worker = once(worker,
  'async function openPaperTrade(storage, params) {\n  if (!storage) return { opened: false, reason: "Durable Object paper storage is unavailable." };',
  'async function openPaperTrade(storage, params) {\n  if (!["BTC","ETH","SOL","BNB"].includes(String(params?.symbol || "").trim().toUpperCase())) return { opened: false, reason: "Temporarily restricted market universe: only BTC, ETH, SOL and BNB may receive new paper entries." };\n  if (!storage) return { opened: false, reason: "Durable Object paper storage is unavailable." };',
  "hard-block non-core paper entries");

await writeFile(workerPath, worker);

const advisorPath = path.join(process.cwd(), "src", "leverup-advisor.js");
let advisor = await readFile(advisorPath, "utf8");
const advisorImport = 'import { isTemporaryMarketAllowed } from "./market-universe.js";';
if (!advisor.includes(advisorImport)) advisor = advisorImport + "\n" + advisor;
advisor = once(advisor,
  '  if (!candidate?.symbol) return result("BLOCKED", "CIEL candidate symbol is missing.");',
  '  if (!candidate?.symbol) return result("BLOCKED", "CIEL candidate symbol is missing.");\n  if (!isTemporaryMarketAllowed(candidate.symbol)) return result("BLOCKED_TEMPORARY_MARKET_UNIVERSE", "Only BTC, ETH, SOL and BNB are temporarily eligible for new LeverUp entries.");',
  "hard-block non-core live and manual LeverUp entries");
await writeFile(advisorPath, advisor);

const nativePath = path.join(process.cwd(), "src", "leverup-native-feed.js");
let native = await readFile(nativePath, "utf8");
const nativeImport = 'import { restrictTemporaryMarketUniverse } from "./market-universe.js";';
if (!native.includes(nativeImport)) native = nativeImport + "\n" + native;
native = once(native,
  '  const watch = [...new Set(watchValues.map(upper).filter(Boolean))];',
  '  const watch = restrictTemporaryMarketUniverse(watchValues.map(upper));',
  "restrict LeverUp native sampling to the four active markets");
await writeFile(nativePath, native);

console.log("Applied temporary four-market universe: BTC, ETH, SOL, BNB. Existing-position management is unchanged.");

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const workerPath = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let worker = await readFile(workerPath, "utf8");
const universeImport = 'import { isTemporaryMarketAllowed, restrictTemporaryMarketUniverse } from "../src/market-universe.js";';
if (!worker.includes(universeImport)) worker = universeImport + "\n" + worker;

function once(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected one match, found " + count);
  return source.replace(before, after);
}

worker = once(worker,
  '    const isScalpMode = candidate.mode === "RANGE_SCALP" || candidate.mode === "CORE_PULLBACK_SCALP";',
  '    if (!isTemporaryMarketAllowed(candidate.symbol)) continue;\n    const isScalpMode = candidate.mode === "RANGE_SCALP" || candidate.mode === "CORE_PULLBACK_SCALP";',
  "restrict Gemini candidate reviews to the six enabled markets");
worker = once(worker,
  "  return [...restrictTemporaryMarketUniverse([...new Set([\"BTC\",\"ETH\",\"SOL\",\"BNB\",\"HYPE\",\"ZEC\", ...parsed])]), \"MON\"]; ",
  "  return [...restrictTemporaryMarketUniverse([...new Set(parsed)]), \"MON\"]; ",
  "restrict the Hyperliquid watchlist to BTC, ETH, SOL and BNB");

worker = once(worker,
  'async function openPaperTrade(storage, params) {\n  if (!storage) return { opened: false, reason: "Durable Object paper storage is unavailable." };',
  'async function openPaperTrade(storage, params) {\n  if (!["BTC","ETH","SOL","BNB","HYPE","ZEC"].includes(String(params?.symbol || "").trim().toUpperCase())) return { opened: false, reason: "Market is outside the enabled six-market universe." };\n  if (!storage) return { opened: false, reason: "Durable Object paper storage is unavailable." };',
  "hard-block non-core paper entries");

worker = once(worker,
  'const rows = await env.DB.prepare("SELECT * FROM advisor_positions WHERE status IN (\'PROPOSED\',\'OPEN\',\'EXIT_ALERTED\',\'CLOSING\') ORDER BY created_at_ms DESC LIMIT 20").all();',
  'const rows = await env.DB.prepare("SELECT * FROM advisor_positions WHERE status IN (\'PROPOSED\',\'OPEN\',\'EXIT_ALERTED\',\'CLOSING\') ORDER BY created_at_ms DESC LIMIT 20").all();\n  if (cmd === "/signals") rows.results = (rows.results || []).filter((position) => isTemporaryMarketAllowed(position.symbol));',
  "hide old non-core proposals from Telegram /signals while preserving /positions");

worker = once(worker,
  'const filtered = url.pathname === "/api/signals" ? positions.filter((p) => p.status === "PROPOSED" || p.status === "OPEN" || p.status === "EXIT_ALERTED") : positions;',
  'const filtered = url.pathname === "/api/signals" ? positions.filter((p) => isTemporaryMarketAllowed(p.symbol) && (p.status === "PROPOSED" || p.status === "OPEN" || p.status === "EXIT_ALERTED")) : positions;',
  "hide old non-core recommendations from the signals API while preserving position management");

worker = once(worker,
  '    if (!proposal) return { handled: true, removeButtons: true, reply: "This proposal has expired or is no longer pending." };',
  '    if (!proposal) return { handled: true, removeButtons: true, reply: "This proposal has expired or is no longer pending." };\n    if (!isTemporaryMarketAllowed(proposal.symbol)) return { handled: true, removeButtons: true, reply: "This proposal is outside the enabled six-market universe." };',
  "reject stale non-core Telegram proposal buttons");

await writeFile(workerPath, worker);

const advisorPath = path.join(process.cwd(), "src", "leverup-advisor.js");
let advisor = await readFile(advisorPath, "utf8");
const advisorImport = 'import { isTemporaryMarketAllowed } from "./market-universe.js";';
if (!advisor.includes(advisorImport)) advisor = advisorImport + "\n" + advisor;
advisor = once(advisor,
  '  if (!candidate?.symbol) return result("BLOCKED", "CIEL candidate symbol is missing.");',
  '  if (!candidate?.symbol) return result("BLOCKED", "CIEL candidate symbol is missing.");\n  if (!isTemporaryMarketAllowed(candidate.symbol)) return result("BLOCKED_TEMPORARY_MARKET_UNIVERSE", "Only BTC, ETH, SOL, BNB, HYPE and ZEC are eligible for new LeverUp entries.");',
  "hard-block non-core live and manual LeverUp entries");
await writeFile(advisorPath, advisor);

const nativePath = path.join(process.cwd(), "src", "leverup-native-feed.js");
let native = await readFile(nativePath, "utf8");
const nativeImport = 'import { restrictTemporaryMarketUniverse } from "./market-universe.js";';
if (!native.includes(nativeImport)) native = nativeImport + "\n" + native;
native = once(native,
  '  const watch = [...new Set(watchValues.map(upper).filter(Boolean))];',
  '  const watch = restrictTemporaryMarketUniverse(watchValues.map(upper));',
  "restrict LeverUp native sampling to the six enabled markets");
await writeFile(nativePath, native);

console.log("Applied temporary six-market universe: BTC, ETH, SOL, BNB. Existing-position management is unchanged.");

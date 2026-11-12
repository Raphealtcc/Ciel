import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");

function once(text, before, after, label) {
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  return text.replace(before, after);
}

source = once(source,
  "function getPaperSummary(storage, prices, now, lastTickAt) {",
  "function getPaperSummary(storage, prices, now, lastTickAt, includeHistory = false) {",
  "add opt-in paper trade history",
);
source = once(source,
  "const recentClosed = closedTrades.slice(0, 5).map((trade) => ({",
  "const recentClosed = closedTrades.slice(0, includeHistory ? 250 : 5).map((trade) => ({",
  "return bounded recent closed-trade history only when requested",
);
source = once(source,
  'if (path === "/paper/profits") {\n      try {\n        const summary = await getPaperSummary(this.state.storage, this.latest, Date.now(), this.lastTickAt);',
  'if (path === "/paper/profits") {\n      try {\n        const includeHistory = new URL(request.url).searchParams.get("history") === "1";\n        const summary = await getPaperSummary(this.state.storage, this.latest, Date.now(), this.lastTickAt, includeHistory);',
  "expose optional history through the feed Durable Object",
);
source = once(source,
  'if (url.pathname === "/api/paper") {\n      try {\n        const response = await feedStub2(env).fetch("https://feed/paper/profits");',
  'if (url.pathname === "/api/paper") {\n      try {\n        const includeHistory = url.searchParams.get("history") === "1";\n        const response = await feedStub2(env).fetch("https://feed/paper/profits" + (includeHistory ? "?history=1" : ""));',
  "allow opt-in paper history at the read-only API",
);
await writeFile(file, source);
console.log("Applied opt-in, bounded paper-trade history diagnostics.");

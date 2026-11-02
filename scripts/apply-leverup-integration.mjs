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

const importLine = 'import { prepareLeverUpAdvisorPlan, formatLeverUpAdvisorLine } from "../src/leverup-advisor.js";';
if (!source.includes(importLine)) source = importLine + "\n" + source;

once(
  '    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase(), direction = candidate.side === "LONG" ? 1 : -1;\n    const stop = candidate.entry * (1 - direction * candidate.stopPct / 100), target = candidate.entry * (1 + direction * candidate.targetPct / 100), expires = now + 15 * 6e4;',
  '    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase(), direction = candidate.side === "LONG" ? 1 : -1;\n    const stop = candidate.entry * (1 - direction * candidate.stopPct / 100), target = candidate.entry * (1 + direction * candidate.targetPct / 100), expires = now + 15 * 6e4;\n    const leverUpPlan = await prepareLeverUpAdvisorPlan({ env, candidate, reviewed, signalId: id, now, technicalOnly });',
  "run a live read-only LeverUp preflight for fully confirmed CIEL approvals",
);

once(
  '      await notify(env, setupMessage(position, candidate, reviewed, prices.MON, forecast, quality.market, intraday) + paperLine, [',
  '      const leverUpLine = formatLeverUpAdvisorLine(leverUpPlan);\n      await notify(env, setupMessage(position, candidate, reviewed, prices.MON, forecast, quality.market, intraday) + paperLine + "\\n\\n" + leverUpLine, [',
  "attach real LeverUp preflight, collateral and fee status to the CIEL trade card",
);

await writeFile(file, source);
console.log("Wrote LeverUp-integrated Worker candidate: " + file);

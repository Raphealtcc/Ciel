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

const importLine = 'import { prepareLeverUpAdvisorPlan, formatLeverUpAdvisorLine, runLeverUpDiagnostics } from "../src/leverup-advisor.js";
import { runLeverUpPositionManager } from "../src/leverup-coordinator.js";';
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


once(
  "    if (url.pathname === \"/health\") {",
  "    if (url.pathname === \"/api/leverup/diagnostics\") {\n      const supplied = request.headers.get(\"authorization\") || \"\";\n      const expected = String(env?.TELEGRAM_WEBHOOK_SECRET || \"\").trim();\n      if (!expected || supplied !== \"Bearer \" + expected) return json2({ ok: false, error: \"Unauthorized\", orderSubmitted: false }, 401);\n      try { return json2(await runLeverUpDiagnostics({ env })); }\n      catch (error) { return json2({ ok: false, mode: \"READ_ONLY_DRY_RUN\", error: String(error?.message || error).slice(0, 240), orderSubmitted: false }, 503); }\n    }\n    if (url.pathname === \"/health\") {",
  "protect read-only LeverUp diagnostics with the existing Telegram webhook secret",
);

once(
  '  async scheduled(_event, env, ctx) {\\n    ctx.waitUntil(ensureTelegramWebhook(env));',
  '  async scheduled(_event, env, ctx) {\\n    ctx.waitUntil(ensureTelegramWebhook(env));\\n    if (String(env?.LEVERUP_PREFLIGHT_ENABLED).toLowerCase() === "true") {\\n      ctx.waitUntil((async () => {\\n        try {\\n          const now = Date.now();\\n          const diagnosticKey = "ciel:leverup:diagnostics:v1";\\n          const last = Number(await env.CIEL_STATE.get(diagnosticKey + ":checkedAt") || 0);\\n          if (!last || now - last >= 15 * 60 * 1000) {\\n            let diagnostics;\\n            try { diagnostics = await runLeverUpDiagnostics({ env, now }); }\\n            catch (error) { diagnostics = { ok: false, mode: "READ_ONLY_DRY_RUN", error: String(error?.message || error).slice(0, 220), orderSubmitted: false }; }\\n            await env.CIEL_STATE.put(diagnosticKey, JSON.stringify(diagnostics), { expirationTtl: 3600 });\\n            await env.CIEL_STATE.put(diagnosticKey + ":checkedAt", String(now), { expirationTtl: 3600 });\\n          }\\n          const lifecycle = await runLeverUpPositionManager({ env, db: env.DB, now });\\n          if (lifecycle.submitted) console.log("LeverUp position manager submitted " + lifecycle.submitted + " exit intent(s).");\\n        } catch (error) {\\n          console.error("LeverUp scheduled read/management cycle failed: " + String(error?.message || error).slice(0, 220));\\n        }\\n      })());\\n    }',
  "run read-only diagnostics and position/settlement management from the existing minute cron"
);

await writeFile(file, source);
console.log("Wrote LeverUp-integrated Worker candidate: " + file);

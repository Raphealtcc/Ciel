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

const importLine = 'import { prepareLeverUpAdvisorPlan, formatLeverUpAdvisorLine, runLeverUpDiagnostics } from "../src/leverup-advisor.js";';
const coordinatorImport = 'import { runLeverUpPositionManager } from "../src/leverup-coordinator.js";';
const approvalSimulationImport = 'import { simulateLeverUpTokenApproval } from "../src/leverup-approval.js";';
const profitsImport = 'import { buildLeverUpProfitReport } from "../src/leverup-profits.js";';
if (!source.includes(importLine)) source = importLine + "\n" + source;
if (!source.includes(coordinatorImport)) source = coordinatorImport + "\n" + source;
if (!source.includes(approvalSimulationImport)) source = approvalSimulationImport + "\n" + source;
if (!source.includes(profitsImport)) source = profitsImport + "\\n" + source;
if (!source.includes("function compactCielSetupMessage(")) {
  const compactHelper = `function compactCielSetupMessage(p, s, r, monUsd, forecast) {
  const mode = s?.mode === "RANGE_SCALP" ? "RANGE" : "TREND";
  const confidence = Math.round(Number(s?.confidence || 0) * 100);
  const review = String(r?.verdict || "WAIT");
  const forecastStatus = forecast?.available ? "forecast ready" : "forecast unavailable";
  const hold = Number(s?.holdMinutes || (mode === "RANGE" ? 12 : 180));
  return [
    (review === "APPROVE" && forecast?.available ? "📈 " : "🟡 ") + String(p?.side || "—") + " " + String(p?.symbol || "—") + " · " + mode + " · " + confidence + "/100",
    "Entry $" + fmt(p?.entry_price) + " | SL $" + fmt(p?.stop_price) + " | TP $" + fmt(p?.target_price),
    "Review " + review + " · " + forecastStatus + " · hold ≤" + hold + "m",
    "PROPOSED — not tracking"
  ].join("\\n");
}
`;
  source = source.replace(coordinatorImport + "\n", coordinatorImport + "\n" + compactHelper);
}

once(
  '    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase(), direction = candidate.side === "LONG" ? 1 : -1;\n    const stop = candidate.entry * (1 - direction * candidate.stopPct / 100), target = candidate.entry * (1 + direction * candidate.targetPct / 100), expires = now + 15 * 6e4;',
  '    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase(), direction = candidate.side === "LONG" ? 1 : -1;\n    const stop = candidate.entry * (1 - direction * candidate.stopPct / 100), target = candidate.entry * (1 + direction * candidate.targetPct / 100), expires = now + 15 * 6e4;\n    const leverUpPlan = await prepareLeverUpAdvisorPlan({ env, candidate, reviewed, signalId: id, now, technicalOnly });',
  "run a live read-only LeverUp preflight for fully confirmed CIEL approvals",
);

once(
  '      await notify(env, setupMessage(position, candidate, reviewed, prices.MON, forecast, quality.market, intraday) + paperLine, [',
  '      const leverUpLine = formatLeverUpAdvisorLine(leverUpPlan);\n      await notify(env, compactCielSetupMessage(position, candidate, reviewed, prices.MON, forecast) + paperLine + "\\n\\n" + leverUpLine, [',
  "attach real LeverUp preflight, collateral and fee status to the CIEL trade card",
);


once(
  "    if (url.pathname === \"/health\") {",
  "    if (url.pathname === \"/api/leverup/diagnostics\") {\n      const supplied = request.headers.get(\"authorization\") || \"\";\n      const expected = String(env?.TELEGRAM_WEBHOOK_SECRET || \"\").trim();\n      if (!expected || supplied !== \"Bearer \" + expected) return json2({ ok: false, error: \"Unauthorized\", orderSubmitted: false }, 401);\n      try { return json2(await runLeverUpDiagnostics({ env })); }\n      catch (error) { return json2({ ok: false, mode: \"READ_ONLY_DRY_RUN\", error: String(error?.message || error).slice(0, 240), orderSubmitted: false }, 503); }\n    }\n    if (url.pathname === \"/health\") {",
  "protect read-only LeverUp diagnostics with the existing Telegram webhook secret",
);


const oneTimeMarketDiagnosticRoute = `    if (url.pathname === "/_internal/leverup-diagnostics-once" && request.method === "GET") {
      const tokenKey = "ciel:leverup:diagnostics:one-time-token";
      const expected = String(await env?.CIEL_STATE?.get(tokenKey) || "");
      const supplied = String(url.searchParams.get("token") || "");
      if (!expected || supplied !== expected) return json2({ ok: false, error: "Unauthorized", orderSubmitted: false }, 401);
      await env.CIEL_STATE.delete(tokenKey);
      const requestedSymbol = String(url.searchParams.get("symbol") || "BTC").toUpperCase();
      if (!["BTC","ETH","SOL"].includes(requestedSymbol)) return json2({ ok: false, error: "Unsupported market symbol", orderSubmitted: false }, 400);
      const skipCoordinator = url.searchParams.get("skipCoordinator") === "true";
      const candidates = [
        ["ALCHEMY_RPC", env?.ALCHEMY_RPC],
        ["MONAD_RPC2", "https://rpc2.monad.xyz"],
        ["LEVERUP_RPC_URL", env?.LEVERUP_RPC_URL],
        ["MONAD_RPC1", "https://rpc1.monad.xyz"],
        ["MONAD_RPC", "https://rpc.monad.xyz"],
      ];
      const rpcCandidates = [];
      let selectedRpc = null;
      for (const [provider, endpoint] of candidates) {
        if (!endpoint) continue;
        let host = "unknown";
        try { host = new URL(endpoint).hostname; } catch {}
        try {
          const response = await fetch(endpoint, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
            signal: AbortSignal.timeout(5000),
          });
          const payload = await response.json();
          const chainId = String(payload?.result || "").toLowerCase();
          rpcCandidates.push({ provider, host, httpStatus: response.status, chainId, isMonadMainnet: response.ok && chainId === "0x8f" });
          if (response.ok && chainId === "0x8f") { selectedRpc = { provider, endpoint, host, chainId }; break; }
        } catch (error) {
          rpcCandidates.push({ provider, host, error: String(error?.message || error).slice(0, 140) });
        }
      }
      if (!selectedRpc) return json2({ ok: false, rpcCandidates, marketPreflights: {}, orderSubmitted: false, approvalTransactionSubmitted: false }, 503);
      try {
        const diagnostics = await runLeverUpDiagnostics({ env: { ...env, LEVERUP_RPC_URL: selectedRpc.endpoint }, now: Date.now(), symbols: [requestedSymbol], skipCoordinator });
        const marketPreflights = Object.fromEntries(Object.entries(diagnostics.marketPreflights || {}).map(([symbol, market]) => [symbol, {
          status: market.status, reason: market.reason || null,
          selectedLeverage: market.selectedLeverage || null, marketMaxLeverage: market.marketMaxLeverage || null,
          minimumNotionalUsd: market.minimumNotionalUsd || null, minimumCollateralUsd: market.minimumCollateralUsd || null,
          minimumMarginMon: market.minimumMarginMon || null, plannedMarginMon: market.plannedMarginMon || null,
          plannedNotionalUsd: market.plannedNotionalUsd || null,
          wmonAllowanceRaw: market.wmonAllowanceRaw || "0",
          wmonRequiredAllowanceRaw: market.wmonRequiredAllowanceRaw || "0",
          wmonAllowanceReady: market.wmonAllowanceShortfallRaw === "0",
          feeToken: market.feeToken || null,
          feeAllowanceRaw: market.feeAllowanceRaw || "0",
          feeRequiredAllowanceRaw: market.feeRequiredAllowanceRaw || "0",
          feeAllowanceShortfallRaw: market.feeAllowanceShortfallRaw || "0",
          autoApprovalConfigured: market.autoApprovalConfigured === true,
          approvalWillRunOnlyOnLiveEntry: market.approvalWillRunOnlyOnLiveEntry === true,
          orderSubmitted: false, approvalTransactionSubmitted: false,
        }]));
        let approvalSimulation = null;
        if (url.searchParams.get("simulateApproval") === "true") {
          const btc = diagnostics.marketPreflights?.BTC;
          if (!btc || btc.status !== "PASS" || !btc.wmonRequiredAllowanceRaw) {
            approvalSimulation = { status: "NOT_RUN", reason: btc?.reason || "BTC_PREFLIGHT_NOT_PASS", transactionBroadcast: false };
          } else {
            approvalSimulation = await simulateLeverUpTokenApproval({
              env: { ...env, LEVERUP_RPC_URL: selectedRpc.endpoint },
              tokenAddress: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
              requiredAmount: btc.wmonRequiredAllowanceRaw,
            });
          }
        }
        return json2({
          ok: diagnostics.ok, checkedAt: diagnostics.checkedAt,
          rpc: { provider: selectedRpc.provider, host: selectedRpc.host, chainId: selectedRpc.chainId },
          rpcCandidates, marketPreflights, approvalSimulation,
          coordinator: { status: diagnostics.coordinator?.status || "NOT_CHECKED", reason: diagnostics.coordinator?.reason || null },
          liveTradingEnabled: diagnostics.liveTradingEnabled, killSwitchActive: diagnostics.killSwitchActive,
          orderSubmitted: false, approvalTransactionSubmitted: false,
        });
      } catch (error) {
        return json2({ ok: false, rpcCandidates, rpc: { provider: selectedRpc.provider, host: selectedRpc.host, chainId: selectedRpc.chainId },
          error: String(error?.message || error).slice(0, 220), orderSubmitted: false, approvalTransactionSubmitted: false }, 503);
      }
    }
`;
once(
  '  if (cmd === "/profits") {',
  '  if (cmd === "/profits") {\n    const liveOverride = await env?.CIEL_STATE?.get("ciel:control:live-enabled").catch(() => null);\n    const liveMode = String(liveOverride ?? env?.LEVERUP_LIVE_TRADING).toLowerCase() === "true" && String(env?.LEVERUP_KILL_SWITCH).toLowerCase() === "false";\n    if (liveMode) {\n      try { await notify(env, await buildLeverUpProfitReport({ env })); }\n      catch (error) { await notify(env, "🔴 LIVE PROFITS UNAVAILABLE — no paper figures were substituted. " + String(error?.message || error).slice(0, 240)); }\n      return true;\n    }',
  "route /profits to the live LeverUp settlement ledger whenever live execution is enabled",
);

once(
  '    if (url.pathname === "/health") {',
  oneTimeMarketDiagnosticRoute + '    if (url.pathname === "/health") {',
  "add one-time token-protected read-only LeverUp market and RPC diagnostics",
);

once(
  '  async scheduled(_event, env, ctx) {\n    ctx.waitUntil(ensureTelegramWebhook(env));',
  '  async scheduled(_event, env, ctx) {\n    ctx.waitUntil(ensureTelegramWebhook(env));\n    if (String(env?.LEVERUP_PREFLIGHT_ENABLED).toLowerCase() === "true") {\n      ctx.waitUntil((async () => {\n        try {\n          const now = Date.now();\n          const diagnosticKey = "ciel:leverup:diagnostics:v1";\n          const last = Number(await env.CIEL_STATE.get(diagnosticKey + ":checkedAt") || 0);\n          if (!last || now - last >= 5 * 60 * 1000) {\n            const symbols = ["BTC","ETH","SOL"];\n            const symbol = symbols[Math.floor(now / (5 * 60 * 1000)) % symbols.length];\n            let diagnostics;\n            try { diagnostics = await runLeverUpDiagnostics({ env, now, symbols: [symbol], skipCoordinator: true }); }\n            catch (error) { diagnostics = { ok: false, mode: "READ_ONLY_DRY_RUN", error: String(error?.message || error).slice(0, 220), marketPreflights: {}, orderSubmitted: false }; }\n            const previous = await env.CIEL_STATE.get(diagnosticKey, "json").catch(() => null) || {};\n            const merged = { ...diagnostics, marketPreflights: { ...(previous.marketPreflights || {}), ...(diagnostics.marketPreflights || {}) }, coordinator: previous.coordinator || { status: "NOT_CHECKED" } };\n            merged.ok = Object.keys(merged.marketPreflights).length === 3 && Object.values(merged.marketPreflights).every((market) => market.status === "PASS") && merged.coordinator.status === "PASS";\n            merged.status = merged.ok ? "READ_ONLY_CHECKS_PASS" : "READ_ONLY_CHECKS_INCOMPLETE";\n            await env.CIEL_STATE.put(diagnosticKey, JSON.stringify(merged), { expirationTtl: 3600 });\n            await env.CIEL_STATE.put(diagnosticKey + ":checkedAt", String(now), { expirationTtl: 3600 });\n          }\n          const lifecycle = await runLeverUpPositionManager({ env, db: env.DB, now });\n          if (lifecycle.submitted) console.log("LeverUp position manager submitted " + lifecycle.submitted + " exit intent(s).");\n        } catch (error) {\n          console.error("LeverUp scheduled read/management cycle failed: " + String(error?.message || error).slice(0, 220));\n        }\n      })());\n    }',
  "run read-only diagnostics and position/settlement management from the existing minute cron"
);

await writeFile(file, source);
console.log("Wrote LeverUp-integrated Worker candidate: " + file);

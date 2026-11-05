import { readFile, writeFile } from "node:fs/promises";

async function patchFile(path, transform) {
  const original = await readFile(path, "utf8");
  const updated = transform(original);
  if (updated === original) throw new Error("D1 controls patch made no change to " + path);
  await writeFile(path, updated);
}

await patchFile("src/leverup-advisor.js", (source) => {
  if (!source.includes('import { readTradingControl } from "./trading-controls.js";')) {
    source = 'import { readTradingControl } from "./trading-controls.js";\n' + source;
  }
  const before = `  const [liveOverride, liveEntryOverride] = env?.CIEL_STATE && typeof env.CIEL_STATE.get === "function"
    ? await Promise.all([env.CIEL_STATE.get("ciel:control:live-enabled"), env.CIEL_STATE.get("ciel:control:live-entry-enabled")])
    : [null, null];`;
  const after = `  const [liveOverride, liveEntryOverride] = await Promise.all([
    readTradingControl(env, "ciel:control:live-enabled", null),
    readTradingControl(env, "ciel:control:live-entry-enabled", null),
  ]);`;
  if (!source.includes(after)) {
    if (source.split(before).length !== 2) throw new Error("Advisor D1 control read anchor mismatch");
    source = source.replace(before, after);
  }
  return source;
});

await patchFile("src/leverup-coordinator.js", (source) => {
  if (!source.includes('import { readTradingControl } from "./trading-controls.js";')) {
    source = 'import { readTradingControl } from "./trading-controls.js";\n' + source;
  }
  const beforeEntry = `  const [liveOverride, entryOverride] = env?.CIEL_STATE && typeof env.CIEL_STATE.get === "function"
    ? await Promise.all([env.CIEL_STATE.get("ciel:control:live-enabled"), env.CIEL_STATE.get("ciel:control:live-entry-enabled")])
    : [null, null];`;
  const afterEntry = `  const [liveOverride, entryOverride] = await Promise.all([
    readTradingControl(env, "ciel:control:live-enabled", null),
    readTradingControl(env, "ciel:control:live-entry-enabled", null),
  ]);`;
  if (!source.includes(afterEntry)) {
    if (source.split(beforeEntry).length !== 2) throw new Error("Coordinator entry control read anchor mismatch");
    source = source.replace(beforeEntry, afterEntry);
  }
  const beforeManager = `  const liveOverride = env?.CIEL_STATE && typeof env.CIEL_STATE.get === "function"
    ? await env.CIEL_STATE.get("ciel:control:live-enabled")
    : null;`;
  const afterManager = `  const liveOverride = await readTradingControl(env, "ciel:control:live-enabled", null);`;
  if (!source.includes(afterManager)) {
    if (source.split(beforeManager).length !== 2) throw new Error("Coordinator manager control read anchor mismatch");
    source = source.replace(beforeManager, afterManager);
  }
  return source;
});

console.log("Patched LeverUp advisor and coordinator to read D1 trading controls.");

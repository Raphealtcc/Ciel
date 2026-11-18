import { readFile, writeFile } from "node:fs/promises";

const file = "reconstructed/patched-worker.js";
let source = await readFile(file, "utf8");
const importLine = 'import { reviewEntrySignalWithAI } from "../src/leverup-position-ai.js";';
if (!source.includes(importLine)) source = importLine + "\n" + source;

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
  console.log("Applied Qwen/Groq entry-review integration: " + label);
}

once(
  '  if (!keys.length) return wait("No Gemini key configured.", "NO_GEMINI_KEY");',
  '  if (!keys.length && !env?.AI?.run && !String(env?.GROQ_API_KEY || "").trim()) return wait("No AI provider configured.", "NO_AI_PROVIDER");',
  "allow Workers AI and Groq when Gemini keys are absent"
);

const cooldownBlockPattern = /  if \(Number\(cooldown\.untilMs\) > Date\.now\(\)\) \{\s*const seconds = Math\.max\(1, Math\.ceil\(\(Number\(cooldown\.untilMs\) - Date\.now\(\)\) \/ 1000\)\);\s*return \{[^\n]*\};\s*\}\s*/;
const cooldownBlocks = [...source.matchAll(new RegExp(cooldownBlockPattern.source, "g"))];
if (cooldownBlocks.length !== 1) throw new Error("Gemini cooldown block expected exactly once; found " + cooldownBlocks.length);
source = source.replace(cooldownBlockPattern,
  '  const geminiCooldownActive = Number(cooldown.untilMs) > Date.now();\n');

const insertion = [
'  const entryModelReview = await reviewEntrySignalWithAI({ env, prompt }).catch(() => null);',
'  if (entryModelReview) {',
'    return {',
'      verdict: entryModelReview.verdict,',
'      reason: entryModelReview.reason,',
'      flags: [...entryModelReview.flags, "PROVIDED_DATA_ONLY", ...(eventIntel ? ["EVENT_INTELLIGENCE_SUPPLIED"] : ["NEWS_NOT_ASSESSED"])],',
'      model: entryModelReview.model,',
'      provider: entryModelReview.provider,',
'      queries: [],',
'      sources: (eventIntel?.articles || []).slice(0, 5).map((x) => ({ title: String(x.title || "").slice(0, 120), url: x.url })),',
'      analysisMode: eventIntel ? "provided-market-data-plus-event-headlines" : "provided-market-data-only",',
'      analysisBasis: eventIntel',
'        ? "CIEL technical/forecast/market-quality evidence plus separately triaged GDELT headlines and source domains; full article text was not fetched."',
'        : "CIEL technical signal, local trend check, supplementary intraday price history and live funding/open-interest/order-book data only. External news and fundamentals were not checked."',
'    };',
'  }',
'  if (geminiCooldownActive) {',
'    const seconds = Math.max(1, Math.ceil((Number(cooldown.untilMs) - Date.now()) / 1000));',
'    return { ...wait("Gemini cooldown after HTTP " + (cooldown.httpStatus || "error") + " " + (cooldown.errorCode || "") + ": " + (cooldown.message || "quota/service backoff") + " Retry in about " + Math.ceil(seconds / 60) + " minute(s).", "GEMINI_COOLDOWN"), flags: ["GEMINI_COOLDOWN", ...(cooldown.httpStatus === 429 ? ["GEMINI_RATE_LIMIT"] : [])], httpStatus: cooldown.httpStatus || null, retryAt: Number(cooldown.untilMs), retryInSeconds: seconds, errorCode: cooldown.errorCode || null };',
'  }',
'  if (!keys.length) return wait("Qwen and Groq were unavailable and no Gemini fallback key is configured.", "AI_PROVIDERS_FAILED");',
'  let transientAttempts = 0;'
].join("\n");
once(
  "  let transientAttempts = 0;",
  insertion,
  "attempt Qwen then Groq before Gemini entry review and Gemini cooldown fallback"
);

await writeFile(file, source);
console.log("Qwen/Groq entry-review provider chain applied to the reconstructed Worker.");

import { readFile, writeFile } from "node:fs/promises";

const file = "reconstructed/patched-worker.js";
let source = await readFile(file, "utf8");
const legacy = 'const geminiKeyCount = [env.GEMINI_API_KEY_1,env.GEMINI_API_KEY_2,env.GEMINI_API_KEY_3,env.GEMINI_API_KEY_4,env.GEMINI_API_KEY_5,env.GEMINI_API_KEY_6,env.GEMINI_API_KEY_7].filter((value) => String(value || "").trim()).length;';
const current = 'const geminiKeyCount = [...new Set(String(env.GEMINI_API_KEYS || "").split(/[,;\\n]+/).map((value) => value.trim()).filter(Boolean))].length;';
const count = source.split(legacy).length - 1;
if (count === 1) source = source.replace(legacy, current);
else if (count !== 0 || !source.includes(current)) throw new Error("Gemini diagnostics key-count patch target missing or duplicated.");
await writeFile(file, source);
console.log("Patched diagnostics to count comma-separated GEMINI_API_KEYS without exposing values.");

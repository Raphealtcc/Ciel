import { readFile, writeFile } from "node:fs/promises";

const path = "reconstructed/patched-worker.js";
let source = await readFile(path, "utf8");

function replaceExactlyOnce(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}. Refusing to patch.`);
  }
  source = source.replace(before, after);
  console.log(`Applied replacement-host safeguard: ${label}`);
}

replaceExactlyOnce(
  'if (target.protocol !== "https:" || target.pathname !== "/telegram/webhook" || ["ciel2.gatakehanami.workers.dev","ciel.leno3z4rrrri.workers.dev"].includes(target.hostname)) return;',
  'if (target.protocol !== "https:" || target.pathname !== "/telegram/webhook" || target.hostname === "ciel.leno3z4rrrri.workers.dev") return;',
  "allow the confirmed ciel2 host while blocking retired production v505",
);

replaceExactlyOnce(
  'if (!expectedBotId || target.protocol !== "https:" || target.pathname !== "/telegram/webhook" || ["ciel2.gatakehanami.workers.dev","ciel.leno3z4rrrri.workers.dev"].includes(target.hostname) || url.origin !== target.origin) return json2({ error: "Staging bot identity and configured staging origin must match." }, 403);',
  'if (!expectedBotId || target.protocol !== "https:" || target.pathname !== "/telegram/webhook" || target.hostname === "ciel.leno3z4rrrri.workers.dev" || url.origin !== target.origin) return json2({ error: "Staging bot identity and configured staging origin must match." }, 403);',
  "allow manual registration on ciel2 while blocking retired production v505",
);

await writeFile(path, source);
console.log("Confirmed replacement Telegram host patch applied.");

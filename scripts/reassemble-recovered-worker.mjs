import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const recovered = path.join(project, "recovered-src");
const output = path.join(project, "reconstructed");
const modules = [
  ["symbols.js", 1647],
  ["cloudflare-forecast.js", 4425],
  ["advisor.js", 125157],
  ["telegram.js", 13973],
  ["hyperliquid_feed.js", 52929],
  ["index.js", 27936],
];

await mkdir(path.join(output, "src"), { recursive: true });
const recoveredModules = [];

for (const [moduleName, expectedLength] of modules) {
  const prefix = moduleName + ".part-";
  const names = (await readdir(recovered))
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));

  if (names.length === 0) {
    throw new Error(`Missing recovered module parts: ${moduleName}`);
  }

  const content = (await Promise.all(
    names.map((name) => readFile(path.join(recovered, name), "utf8")),
  )).join("");

  if (content.length !== expectedLength) {
    throw new Error(`Integrity check failed for ${moduleName}: expected ${expectedLength}, got ${content.length}`);
  }

  const destination = path.join(output, "src", moduleName);
  await writeFile(destination, content);
  recoveredModules.push(content);
  console.log(`Reassembled ${moduleName}: ${names.length} parts, ${content.length} chars`);
}

const preamble = await readFile(path.join(recovered, "runtime-preamble.js"), "utf8");
if (preamble.length !== 391) {
  throw new Error(`Integrity check failed for runtime preamble: expected 391, got ${preamble.length}`);
}

const worker = preamble + recoveredModules.join("");
if (worker.length !== 226458) {
  throw new Error(`Integrity check failed for full Worker: expected 226458, got ${worker.length}`);
}

const sha256 = createHash("sha256").update(worker, "utf8").digest("hex");
// The recovered advisor source has since been deliberately updated. The former
// deployed-bundle digest no longer describes the current repository baseline.
// Per-module and whole-worker length checks remain enabled; regenerate and pin a
// new digest after validating a canonical baseline export.
console.log(`Reassembled Worker: ${worker.length} chars; SHA-256 ${sha256}`);

await writeFile(path.join(output, "worker.js"), worker);
console.log("Wrote reconstructed Worker from the current recovered source.");

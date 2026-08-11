import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve("dist/extension");
const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, "utf8"));
const records = JSON.parse(readFileSync(`${root}/records/records-manifest.json`, "utf8"));

if (manifest.manifest_version !== 3) throw new Error("Manifest V3 is required");
if (manifest.background?.service_worker !== "service-worker.js") {
  throw new Error("Manifest V3 service worker is missing");
}
if (manifest.background?.type !== "module") throw new Error("Service worker must be a module");
if (!manifest.content_security_policy?.extension_pages.includes("wasm-unsafe-eval")) {
  throw new Error("WASM-compatible extension CSP is missing");
}
if (records.totalCount !== 458_292) throw new Error("Baseline record count is invalid");

let countedRecords = 0;
let previousDate = -Infinity;
for (const chunk of records.chunks) {
  const path = `${root}/records/${chunk.file}`;
  const bytes = readFileSync(path);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== chunk.sha256) throw new Error(`Checksum mismatch for ${chunk.file}`);
  if (chunk.firstDate < previousDate || chunk.lastDate < chunk.firstDate) {
    throw new Error(`Chronology mismatch for ${chunk.file}`);
  }
  previousDate = chunk.lastDate;
  countedRecords += chunk.count;
}
if (countedRecords !== records.totalCount) throw new Error("Record chunk counts do not add up");

for (const module of ["chart", "popup", "records", "saltybet", "twitch_chat"]) {
  const files = readdirSync(`${root}/js/${module}`);
  if (!files.some((file) => file.endsWith(".wasm"))) {
    throw new Error(`Missing WASM output for ${module}`);
  }
}

const packageBytes = readdirSync(root, { recursive: true })
  .map((path) => `${root}/${path}`)
  .filter((path) => statSync(path).isFile())
  .reduce((total, path) => total + statSync(path).size, 0);
if (packageBytes > 40 * 1024 * 1024) throw new Error("Extension package unexpectedly exceeds 40 MB");

console.log(
  `Manifest, ${records.totalCount} baseline records, checksums, chronology, and WASM outputs verified (${(
    packageBytes /
    1024 /
    1024
  ).toFixed(1)} MB)`,
);

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionSource = join(projectRoot, "extension");
const outputRoot = join(projectRoot, "dist", "extension");
const cargoWasmPack = join(homedir(), ".cargo", "bin", "wasm-pack");
const wasmPack = existsSync(cargoWasmPack) ? cargoWasmPack : "wasm-pack";

const wasmPackages = [
  ["chart", "src/chart"],
  ["popup", "src/popup"],
  ["records", "src/records"],
  ["saltybet", "src/saltybet"],
  ["twitch_chat", "src/twitch_chat"],
];

function requireCommand(command, message) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(message);
  }
}

function buildWasm() {
  requireCommand(
    wasmPack,
    "wasm-pack is required. Install Rust, then run: cargo install wasm-pack --locked",
  );

  for (const [name, crate] of wasmPackages) {
    const output = join(outputRoot, "js", name);
    mkdirSync(output, { recursive: true });
    execFileSync(
      wasmPack,
      [
        "build",
        join(projectRoot, crate),
        "--target",
        "web",
        "--release",
        "--no-typescript",
        "--out-dir",
        output,
        "--out-name",
        name,
      ],
      { cwd: projectRoot, stdio: "inherit" },
    );

    for (const generated of ["package.json", ".gitignore", "README.md"]) {
      const path = join(output, generated);
      if (existsSync(path)) unlinkSync(path);
    }
  }
}

function buildRecords() {
  const source = join(projectRoot, "static", "records");
  const output = join(outputRoot, "records");
  mkdirSync(output, { recursive: true });

  const files = readdirSync(source)
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));

  const chunks = files.map((file, index) => {
    const bytes = readFileSync(join(source, file));
    const records = JSON.parse(bytes.toString("utf8"));
    const outputName = `records-${index}.json.gz`;
    const compressed = gzipSync(bytes, { level: 9 });
    writeFileSync(join(output, outputName), compressed);

    for (let recordIndex = 1; recordIndex < records.length; recordIndex += 1) {
      if (records[recordIndex].date < records[recordIndex - 1].date) {
        throw new Error(`${file} is not chronologically sorted`);
      }
    }

    return {
      file: outputName,
      count: records.length,
      firstDate: records[0]?.date ?? null,
      lastDate: records.at(-1)?.date ?? null,
      sha256: createHash("sha256").update(compressed).digest("hex"),
    };
  });

  const manifest = {
    version: 1,
    totalCount: chunks.reduce((total, chunk) => total + chunk.count, 0),
    chunks,
  };

  if (manifest.totalCount !== 458_292) {
    throw new Error(`Expected 458292 baseline records, found ${manifest.totalCount}`);
  }

  writeFileSync(
    join(output, "records-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
cpSync(extensionSource, outputRoot, { recursive: true });
mkdirSync(join(outputRoot, "icons"), { recursive: true });
for (const icon of readdirSync(join(projectRoot, "static", "icons"))) {
  copyFileSync(join(projectRoot, "static", "icons", icon), join(outputRoot, "icons", icon));
}

buildRecords();
buildWasm();

console.log(`Built unpacked extension at ${outputRoot}`);

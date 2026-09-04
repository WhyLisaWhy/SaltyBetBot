import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "saltybetbot-webdriver-"));
const configuration = join(temporaryDirectory, "webdriver.json");
const cargoWasmPack = join(homedir(), ".cargo", "bin", "wasm-pack");
const wasmPack = existsSync(cargoWasmPack) ? cargoWasmPack : "wasm-pack";
// wasm-pack selects its own ChromeDriver; prefer an installed system browser so
// the driver and browser come from the same runner-managed version.
const chromeBinary =
  process.env.WASM_BINDGEN_CHROME_BINARY ??
  [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((path) => existsSync(path)) ??
  chromium.executablePath();

await writeFile(
  configuration,
  `${JSON.stringify(
    {
      "goog:chromeOptions": {
        binary: chromeBinary,
      },
    },
    null,
    2,
  )}\n`,
);

try {
  const result = spawnSync(
    wasmPack,
    ["test", "--headless", "--chrome", "src/twitch_chat"],
    {
      env: { ...process.env, WASM_BINDGEN_TEST_WEBDRIVER_JSON: configuration },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const extensionPath = resolve(process.env.SALTYBET_EXTENSION_PATH || "dist/extension");
const artifacts = resolve(process.env.SALTYBET_ARTIFACTS || "output/playwright");
const profile = await mkdtemp(join(tmpdir(), "saltybet-popup-"));
await mkdir(artifacts, { recursive: true });
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 500, height: 740 },
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const pendingHealth = await context.newPage();
  await pendingHealth.addInitScript(() => {
    const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = message => {
      if (message.type === "health.get") return new Promise(() => {});
      if (message.type === "settings.get") return Promise.resolve({ ok: true, data: { automationEnabled: true, maxBet: 32000 } });
      return sendMessage(message);
    };
  });
  await pendingHealth.goto(`chrome-extension://${extensionId}/popup.html`);
  await pendingHealth.waitForFunction(() => {
    const toggle = document.querySelector("#automation-enabled");
    return toggle.checked && !toggle.disabled;
  }, null, { timeout: 3000 });
  await pendingHealth.close();

  const overlapping = await context.newPage();
  await overlapping.addInitScript(() => {
    chrome.tabs.query = async () => [{ id: 123, url: "https://www.saltybet.com/" }];
    chrome.runtime.sendMessage = async message => {
      if (message.type === "health.get") return { ok: true, data: { controllerTabId: 999 } };
      if (message.type === "settings.get") return { ok: true, data: { automationEnabled: false, maxBet: 32000 } };
      if (message.type === "controller.claim") return { ok: true, data: { isController: true } };
      if (message.type === "settings.set") return new Promise(resolve => {
        window.finishMaximum = () => resolve({ ok: true, data: { automationEnabled: false, maxBet: message.payload.maxBet } });
      });
    };
  });
  await overlapping.goto(`chrome-extension://${extensionId}/popup.html`);
  await overlapping.locator("#max-bet").fill("47000");
  await overlapping.locator("#max-bet").press("Enter");
  await overlapping.waitForFunction(() => typeof window.finishMaximum === "function");
  await overlapping.getByRole("button", { name: "Use this SaltyBet tab", exact: true }).click();
  // Claim reenables only after its refresh completes.
  await overlapping.waitForFunction(() => !document.querySelector("#claim-controller").disabled);
  assert.equal(await overlapping.locator("#max-bet").isEnabled(), false,
    "Controller refresh must preserve a pending save's disabled input");
  await overlapping.evaluate(() => window.finishMaximum());
  await overlapping.getByText("Maximum bet saved for the next matchmaking match.", { exact: true }).waitFor();
  assert.equal(await overlapping.locator("#max-bet").inputValue(), "47000");
  await overlapping.close();

  const unavailable = await context.newPage();
  await unavailable.addInitScript(() => {
    const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async message => {
      if (message.type === "health.get") return { ok: false, error: { message: "Fixture database unavailable" } };
      if (message.type === "settings.get") return { ok: true, data: { automationEnabled: true, maxBet: 32000 } };
      if (message.type === "settings.set") {
        window.disabledAutomation = message.payload.automationEnabled === false;
        return { ok: true, data: { automationEnabled: false, maxBet: 32000 } };
      }
      return sendMessage(message);
    };
  });
  await unavailable.goto(`chrome-extension://${extensionId}/popup.html`);
  await unavailable.getByText(/Fixture database unavailable/).waitFor();
  assert.equal(await unavailable.locator("#automation-enabled").isEnabled(), true,
    "Health failure must not prevent disabling automation");
  assert.equal(await unavailable.locator("#automation-enabled").isChecked(), true);
  await unavailable.locator("#automation-enabled").uncheck();
  await unavailable.waitForFunction(() => window.disabledAutomation === true);
  await unavailable.close();

  const retryPage = await context.newPage();
  await retryPage.addInitScript(() => {
    const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    let failSettings = true;
    chrome.runtime.sendMessage = (...args) => {
      if (args[0]?.type === "settings.get" && failSettings) {
        failSettings = false;
        return Promise.resolve({ ok: false, error: { message: "Fixture initial failure" } });
      }
      return sendMessage(...args);
    };
  });
  await retryPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await retryPage.getByText("Could not load settings: Fixture initial failure", { exact: true }).waitFor();
  assert.equal(await retryPage.locator("#automation-enabled").isEnabled(), false);
  await retryPage.getByRole("button", { name: "Retry connection", exact: true }).click();
  await retryPage.locator("#mode-badge").filter({ hasText: "Observe only" }).waitFor();
  assert.equal(await retryPage.locator("#automation-enabled").isEnabled(), true);
  assert.equal(await retryPage.locator("#max-bet").inputValue(), "32000");
  await retryPage.close();

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.getByRole("button", { name: "Import", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "popup-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.screenshot({ path: join(artifacts, "popup-narrow.png"), fullPage: true });
  await page.locator("#import-input").setInputFiles({
    name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"not":"records"}'),
  });
  await page.getByText("Import failed: choose a valid Salty Bet Bot JSON export.", { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await page.getByRole("button", { name: "Import", exact: true }).isEnabled(), true);
  assert.equal(await page.locator("#automation-enabled").isEnabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    "Popup must not overflow at 360px");
  await page.evaluate(() => { document.documentElement.style.fontSize = "28px"; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    "Popup must reflow at 200% text size");
  await page.screenshot({ path: join(artifacts, "popup-large-text.png"), fullPage: true });
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });

  // Use the actual record database and Rust parser; only the browser download
  // boundary is substituted so the test never opens a save dialog or writes a user file.
  const character = name => ({ name, bet_amount: 100, win_streak: 0,
    illuminati_bettors: 1, normal_bettors: 1, ignored_bettors: 0 });
  const record = { left: character("Audit Alpha"), right: character("Audit Beta"),
    winner: "Left", tier: "A", mode: "Matchmaking", bet: "None", duration: 1000,
    date: 1800000000000, sum: 100 };
  const upload = value => page.locator("#import-input").setInputFiles({
    name: "synthetic-records.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });
  await upload([record]);
  await page.getByText("Import complete: 1 new records added. Duplicates were skipped.", { exact: true }).waitFor({ timeout: 180_000 });
  await upload([record]);
  await page.getByText("Import complete: 0 new records added. Duplicates were skipped.", { exact: true }).waitFor({ timeout: 180_000 });
  const count = () => page.evaluate(async () =>
    (await chrome.runtime.sendMessage({ v: 1, type: "records.count_personal", payload: {} })).data.count);
  assert.equal(await count(), 1);

  await page.evaluate(() => {
    chrome.downloads.download = (_options, callback) => callback(undefined);
  });
  await page.getByRole("button", { name: "Export personal records", exact: true }).click();
  await page.getByText("Download failed or was canceled. Try the export again.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Export personal records", exact: true }).isEnabled(), true);
  await page.evaluate(() => {
    window.exportCounts = [];
    chrome.downloads.download = async (options, callback) => {
      const records = await (await fetch(options.url)).json();
      window.exportCounts.push(records.length);
      callback(123);
    };
  });
  await page.getByRole("button", { name: "Export personal records", exact: true }).click();
  await page.getByText("Export download started (1 records).", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Export all records", exact: true }).click();
  await page.getByText("Export download started (458293 records).", { exact: true }).waitFor({ timeout: 180_000 });
  assert.deepEqual(await page.evaluate(() => window.exportCounts), [1, 458293]);

  // Retain an unsaved value through a rejected save, and allow keyboard retry.
  await page.evaluate(() => {
    window.realSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async message => message.type === "settings.set"
      ? { ok: false, error: { message: "Fixture storage failure" } }
      : window.realSendMessage(message);
  });
  await page.locator("#max-bet").fill("47000");
  await page.locator("#max-bet").press("Enter");
  await page.getByText("Maximum was not saved: Fixture storage failure. Try again.", { exact: true }).waitFor();
  assert.equal(await page.locator("#max-bet").inputValue(), "47000");
  await page.evaluate(() => { chrome.runtime.sendMessage = window.realSendMessage; });
  await page.locator("#max-bet").press("Enter");
  await page.getByText("Maximum bet saved for the next matchmaking match.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get("maxBet")).maxBet), 47000);

  // While record work is pending, duplicate actions are disabled and the
  // emergency automation control remains accessible.
  await page.evaluate(() => {
    chrome.runtime.sendMessage = (...args) => {
      const message = args[0] === null ? args[1] : args[0];
      if (message.type === "records.page") {
        window.resumeRecords = () => window.realSendMessage(...args);
        return;
      }
      return window.realSendMessage(...args);
    };
  });
  await page.getByRole("button", { name: "Export personal records", exact: true }).click();
  await page.waitForFunction(() => typeof window.resumeRecords === "function");
  assert.equal(await page.getByRole("button", { name: "Import", exact: true }).isEnabled(), false);
  assert.equal(await page.locator("#automation-enabled").isEnabled(), true);
  await page.evaluate(() => {
    chrome.runtime.sendMessage = window.realSendMessage;
    window.resumeRecords();
  });
  await page.getByText("Export download started (1 records).", { exact: true }).waitFor();

  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "Clear personal records", exact: true }).click();
  assert.equal(await count(), 1, "Cancel must preserve personal records");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Clear personal records", exact: true }).click();
  await page.getByText("Personal records cleared. Bundled history is unchanged.", { exact: true }).waitFor();
  assert.equal(await count(), 0);
  await upload([]);
  await page.getByText("No records found in this export. Nothing was changed.", { exact: true }).waitFor();
  for (const name of ["chart", "records"]) {
    const opened = context.waitForEvent("page");
    await page.getByRole("link", { name: `Open ${name} page` }).click();
    const target = await opened;
    await target.waitForURL(`chrome-extension://${extensionId}/${name}.html`);
    await target.close();
  }
  assert.deepEqual(errors, [], "Recoverable input errors must not crash WASM");
  console.log("Popup import/retry/deduplication, exports/failure, clear/cancel, settings retry, navigation, busy state and responsive checks passed");
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}

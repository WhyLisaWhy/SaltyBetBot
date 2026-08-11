import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const extensionPath = resolve("dist/extension");
const artifacts = resolve("output/playwright");
const profile = await mkdtemp(join(tmpdir(), "saltybetbot-chromium-"));
await mkdir(artifacts, { recursive: true });

const browserErrors = [];
let context;

function watchPage(page, label) {
  page.on("pageerror", (error) => browserErrors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`${label}: ${message.text()}`);
  });
}

const saltyBetFixture = `<!doctype html>
<html><body>
  <header id="header"><span class="navbar-text">MockUser [10,000] #1</span></header>
  <main>
    <span id="balance">10,000</span>
    <input id="wager" value="0">
    <input id="player1" value="Alpha">
    <input id="player2" value="Beta">
    <div id="sbettors1"><span class="redtext"><strong>Alpha</strong><span class="counttext">1</span></span></div>
    <div id="sbettors2"><span class="bluetext"><strong>Beta</strong><span class="counttext">1</span></span></div>
    <div id="bettors1"></div><div id="bettors2"></div>
    <div id="lastbet"></div><div id="betstatus">Bets are OPEN!</div>
    <iframe id="iframeplayer" src="about:blank"></iframe>
    <iframe id="chat" src="https://www.twitch.tv/embed/saltybet/chat?parent=www.saltybet.com"></iframe>
  </main>
  <script>
    window.__saltyBetBotClicks = 0;
    document.querySelector('#player1').addEventListener('click', () => window.__saltyBetBotClicks += 1);
    document.querySelector('#player2').addEventListener('click', () => window.__saltyBetBotClicks += 1);
  </script>
</body></html>`;

const twitchFixture = `<!doctype html>
<html><body>
  <div data-a-target="chat-scrollable-area__message-container">
    <div data-a-target="chat-line-message">WAIFU4u: Bets are OPEN for Alpha vs Beta! (A / B Tier) (matchmaking) www.saltybet.com</div>
  </div>
</body></html>`;

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
    ],
    viewport: { width: 1440, height: 1000 },
  });

  context.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`browser: ${message.text()}`);
  });

  await context.route("https://www.saltybet.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: saltyBetFixture }),
  );
  await context.route("https://www.twitch.tv/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: twitchFixture }),
  );

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) serviceWorker = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  const extensionId = new URL(serviceWorker.url()).host;
  assert.match(extensionId, /^[a-p]{32}$/);

  const saltyPage = context.pages()[0] || (await context.newPage());
  watchPage(saltyPage, "SaltyBet fixture");
  await saltyPage.goto("https://www.saltybet.com/", { waitUntil: "domcontentloaded" });
  await saltyPage.getByText("Observe only — no bets will be placed", { exact: true }).waitFor({
    timeout: 180_000,
  });
  try {
    await saltyPage.waitForFunction(
      () =>
        [...document.querySelectorAll("div")].some(
          (element) =>
            element.textContent === "Alpha" &&
            getComputedStyle(element).backgroundColor === "rgb(176, 68, 68)",
        ) &&
        [...document.querySelectorAll("div")].some(
          (element) =>
            element.textContent === "Beta" &&
            getComputedStyle(element).backgroundColor === "rgb(52, 158, 255)",
        ),
      { timeout: 30_000 },
    );
  } catch (error) {
    const session = await serviceWorker.evaluate(() => chrome.storage.session.get(null));
    throw new Error(`Recommendation overlay did not populate. Session: ${JSON.stringify(session)}`, {
      cause: error,
    });
  }
  assert.equal(await saltyPage.evaluate(() => window.__saltyBetBotClicks), 0);
  await saltyPage.screenshot({ path: join(artifacts, "recommendation.png"), fullPage: true });

  const standbyPage = await context.newPage();
  watchPage(standbyPage, "Standby SaltyBet fixture");
  await standbyPage.goto("https://www.saltybet.com/", { waitUntil: "domcontentloaded" });
  await standbyPage.getByText("Standby — another tab controls betting", { exact: true }).waitFor({
    timeout: 180_000,
  });

  const transferPage = await context.newPage();
  watchPage(transferPage, "Controller transfer");
  await transferPage.goto(`chrome-extension://${extensionId}/popup.html`);
  const transferred = await transferPage.evaluate(async () => {
    const request = (type, payload = {}) =>
      chrome.runtime.sendMessage({ v: 1, type, payload });
    const health = await request("health.get");
    const tabs = await chrome.tabs.query({ url: ["*://saltybet.com/*", "*://www.saltybet.com/*"] });
    const target = tabs.find((tab) => tab.id !== health.data.controllerTabId);
    return request("controller.claim", { tabId: target.id });
  });
  assert.equal(transferred.ok, true);
  await standbyPage.getByText("Observe only — no bets will be placed", { exact: true }).waitFor();
  await saltyPage.getByText("Standby — another tab controls betting", { exact: true }).waitFor();
  await transferPage.close();

  const activeSaltyPage = standbyPage;
  await activeSaltyPage.evaluate(() => {
    document.querySelector("#betstatus").textContent = "Bets are locked until the next match.";
    document.querySelector("#bettors1").innerHTML =
      '<p class="bettor-line"><strong>RedBettor</strong><span class="wager-display">$100</span></p>';
    document.querySelector("#bettors2").innerHTML =
      '<p class="bettor-line"><strong>BlueBettor</strong><span class="wager-display">$100</span></p>';
    const odds = document.createElement("div");
    odds.id = "odds";
    odds.innerHTML = '<span class="redtext">Alpha</span><span class="bluetext">Beta</span>';
    document.body.appendChild(odds);
  });

  const chatFrame = activeSaltyPage.frames().find((frame) =>
    frame.url().includes("twitch.tv/embed/saltybet/chat"),
  );
  assert.ok(chatFrame, "Mock Twitch chat frame was not loaded");
  const appendChat = (text) =>
    chatFrame.evaluate((message) => {
      const line = document.createElement("div");
      line.dataset.aTarget = "chat-line-message";
      line.textContent = message;
      document.querySelector("[data-a-target='chat-scrollable-area__message-container']").appendChild(line);
    }, text);

  await appendChat("WAIFU4u: Bets are locked. Alpha- $10,000, Beta- $12,000");
  await new Promise((resolve) => setTimeout(resolve, 250));
  await appendChat("WAIFU4u: Alpha wins! Payouts to Team Red.");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await appendChat("WAIFU4u: Alpha wins! Payouts to Team Red.");

  const popup = await context.newPage();
  watchPage(popup, "Popup");
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  let personalCount = 0;
  const recordDeadline = Date.now() + 30_000;
  while (Date.now() < recordDeadline && personalCount !== 1) {
    const response = await popup.evaluate(() =>
      chrome.runtime.sendMessage({ v: 1, type: "records.count_personal", payload: {} }),
    );
    personalCount = response?.data?.count ?? 0;
    if (personalCount !== 1) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(personalCount, 1, "A complete observe-only cycle should create exactly one record");
  assert.equal(await activeSaltyPage.evaluate(() => window.__saltyBetBotClicks), 0);
  assert.equal(await saltyPage.evaluate(() => window.__saltyBetBotClicks), 0);

  const settings = await popup.evaluate(async () =>
    chrome.storage.local.get({ automationEnabled: false }),
  );
  assert.equal(settings.automationEnabled, false);
  await activeSaltyPage.screenshot({ path: join(artifacts, "observe-only.png"), fullPage: true });

  await popup.locator("#mode-badge").filter({ hasText: "Observe only" }).waitFor();
  assert.equal(await popup.locator("#automation-enabled").isChecked(), false);
  await popup.screenshot({ path: join(artifacts, "popup.png") });

  for (const pageName of ["records", "chart"]) {
    const page = await context.newPage();
    watchPage(page, pageName);
    await page.goto(`chrome-extension://${extensionId}/${pageName}.html`);
    if (pageName === "records") {
      await page.getByRole("columnheader", { name: "Mode", exact: true }).waitFor({
        timeout: 180_000,
      });
      await page.waitForFunction(() => document.querySelectorAll("tbody tr").length > 0);
    } else {
      await page.locator("svg").waitFor({ timeout: 180_000 });
      await page.locator("select").first().waitFor({ timeout: 30_000 });
      assert.doesNotMatch(await page.locator("body").innerText(), /NaN|Infinity/);
    }
    await page.getByText("LOADING", { exact: true }).waitFor({ state: "hidden" });
    await page.screenshot({ path: join(artifacts, `${pageName}.png`), fullPage: false });
    await page.close();
  }

  assert.deepEqual(browserErrors, []);
  console.log(
    `Extension ${extensionId} passed observe-only, controller-transfer, popup, records, and chart smoke checks`,
  );
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}

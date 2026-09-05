const PROTOCOL_VERSION = 1;

const automation = document.querySelector("#automation-enabled");
const badge = document.querySelector("#mode-badge");
const controllerState = document.querySelector("#controller-state");
const claim = document.querySelector("#claim-controller");
const message = document.querySelector("#control-message");
const maxBet = document.querySelector("#max-bet");
const saveMaxBet = document.querySelector("#save-max-bet");
const maxBetForm = document.querySelector("#max-bet-form");
const retry = document.querySelector("#retry-controls");
let automationPending = false;
let maximumPending = false;
let settingsRevision = 0;

function showMessage(text, failed = false) {
  message.textContent = text;
  message.dataset.state = failed ? "error" : "success";
}
const MIN_MAX_BET = 1;
const MAX_MAX_BET = 1_000_000;

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ v: PROTOCOL_VERSION, type, payload });
  if (!response?.ok) throw new Error(response?.error?.message || "Extension request failed");
  return response.data;
}

function showMode(enabled) {
  automation.checked = enabled;
  badge.textContent = enabled ? "Automation enabled" : "Observe only";
  badge.className = `badge ${enabled ? "enabled" : "observe"}`;
}

async function refresh({ preserveDraft = false } = {}) {
  retry.hidden = true;
  const revision = settingsRevision;
  // Render each result independently: blocked IndexedDB must not block disabling automation.
  await Promise.all([
    (async () => {
      try {
        const settings = await request("settings.get");
        // A refresh started before a write must not repaint stale settings afterward.
        if (revision !== settingsRevision) return;
        if (!automationPending) showMode(settings.automationEnabled);
        if (!preserveDraft && !maximumPending) maxBet.value = String(settings.maxBet);
        automation.disabled = automationPending;
        maxBet.disabled = maximumPending;
        saveMaxBet.disabled = maximumPending;
      } catch (error) {
        if (revision !== settingsRevision) return;
        badge.textContent = "Settings unavailable";
        badge.className = "badge error";
        showMessage(`Could not load settings: ${error.message}`, true);
        retry.hidden = false;
      }
    })(),
    (async () => {
      try {
        const [health, tabs] = await Promise.all([
          request("health.get"),
          chrome.tabs.query({ active: true, currentWindow: true }),
        ]);
        const tab = tabs[0];
        const isSaltyBet = /^https?:\/\/(?:www\.|mugen\.|live\.)?saltybet\.com\//i.test(tab?.url || "");
        claim.disabled = !isSaltyBet;
        controllerState.textContent = !isSaltyBet
          ? "Open SaltyBet to select a controller tab."
          : health.controllerTabId === tab.id
            ? "This is the active SaltyBet controller tab."
            : "This tab is on standby; select it to transfer control.";
      } catch (error) {
        claim.disabled = true;
        controllerState.textContent = `Controller status unavailable: ${error.message}`;
        retry.hidden = false;
      }
    })(),
  ]);
}

automation.addEventListener("change", async () => {
  if (
    automation.checked &&
    !confirm(
      "Enable automatic SaltyBet wagering?\n\nUse this only after observe-only predictions and record collection have been validated. Bets begin with the next complete eligible match.",
    )
  ) {
    automation.checked = false;
    return;
  }
  automationPending = true;
  settingsRevision += 1;
  automation.disabled = true;
  try {
    const settings = await request("settings.set", { automationEnabled: automation.checked });
    showMode(settings.automationEnabled);
    showMessage(settings.automationEnabled
      ? "Automatic betting will begin with the next complete match."
      : "Predictions and record collection remain active without placing bets.");
  } catch (error) {
    showMessage(error.message, true);
    try { showMode((await request("settings.get")).automationEnabled); }
    catch {
      badge.textContent = "Settings unavailable";
      badge.className = "badge error";
      retry.hidden = false;
    }
  } finally {
    automationPending = false;
    settingsRevision += 1;
    automation.disabled = false;
  }
});

maxBetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saveMaxBet.disabled) return;
  const value = Number(maxBet.value);
  if (!Number.isInteger(value) || value < MIN_MAX_BET || value > MAX_MAX_BET) {
    showMessage("Maximum must be an integer between 1 and 1,000,000.", true);
    maxBet.setAttribute("aria-invalid", "true");
    maxBet.focus();
    return;
  }

  maximumPending = true;
  settingsRevision += 1;
  saveMaxBet.disabled = true;
  maxBet.disabled = true;
  maxBet.removeAttribute("aria-invalid");
  try {
    const settings = await request("settings.set", { maxBet: value });
    maxBet.value = String(settings.maxBet);
    showMessage("Maximum bet saved for the next matchmaking match.");
  } catch (error) {
    showMessage(`Maximum was not saved: ${error.message}. Try again.`, true);
  } finally {
    maximumPending = false;
    settingsRevision += 1;
    saveMaxBet.disabled = false;
    maxBet.disabled = false;
  }
});

claim.addEventListener("click", async () => {
  claim.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const status = await request("controller.claim", { tabId: tab.id });
    controllerState.textContent = status.isController
      ? "This is the active SaltyBet controller tab."
      : "Unable to select this tab.";
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    await refresh({ preserveDraft: true });
  }
});

retry.addEventListener("click", async () => {
  retry.disabled = true;
  showMessage("");
  try { await refresh({ preserveDraft: maxBet.value !== "" }); }
  finally { retry.disabled = false; }
});

refresh();

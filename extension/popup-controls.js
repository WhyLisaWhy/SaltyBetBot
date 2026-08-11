const PROTOCOL_VERSION = 1;

const automation = document.querySelector("#automation-enabled");
const badge = document.querySelector("#mode-badge");
const controllerState = document.querySelector("#controller-state");
const claim = document.querySelector("#claim-controller");
const message = document.querySelector("#control-message");

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

async function refresh() {
  try {
    const [settings, health, tabs] = await Promise.all([
      request("settings.get"),
      request("health.get"),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);
    showMode(settings.automationEnabled);
    const tab = tabs[0];
    const isSaltyBet = /^https?:\/\/(?:www\.|mugen\.|live\.)?saltybet\.com\//i.test(tab?.url || "");
    claim.disabled = !isSaltyBet;
    controllerState.textContent = !isSaltyBet
      ? "Open SaltyBet to select a controller tab."
      : health.controllerTabId === tab.id
        ? "This is the active SaltyBet controller tab."
        : "This tab is on standby; select it to transfer control.";
  } catch (error) {
    badge.textContent = "Error";
    badge.className = "badge error";
    message.textContent = error.message;
  }
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
  automation.disabled = true;
  try {
    const settings = await request("settings.set", { automationEnabled: automation.checked });
    showMode(settings.automationEnabled);
    message.textContent = settings.automationEnabled
      ? "Automatic betting will begin with the next complete match."
      : "Predictions and record collection remain active without placing bets.";
  } catch (error) {
    message.textContent = error.message;
    await refresh();
  } finally {
    automation.disabled = false;
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
    message.textContent = error.message;
  } finally {
    await refresh();
  }
});

refresh();

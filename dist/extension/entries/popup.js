import init from "../js/popup/popup.js";

try {
  await init();
  document.querySelector("#record-message").textContent = "";
} catch {
  const message = document.querySelector("#record-message");
  message.dataset.state = "error";
  message.textContent = "Record controls could not load. Reopen the popup or reload the extension.";
}

const signal = document.getElementById("signal");
const title = document.getElementById("status-title");
const description = document.getElementById("description");
const scope = document.getElementById("scope");
const endButton = document.getElementById("end-session");

function render(status) {
  const active = Boolean(status?.active);
  signal.dataset.state = active ? "active" : "offline";
  title.textContent = active ? "Profile live" : "No active profile";
  description.textContent = active
    ? "Tether is controlling only this isolated Chromium profile."
    : "No Tether browser profile is running.";
  scope.textContent = active ? `Isolated · ${status.ownedTabs} owned tab${status.ownedTabs === 1 ? "" : "s"}` : "No profile";
  endButton.disabled = !active;
}

async function refresh() {
  render(await chrome.runtime.sendMessage({ type: "tether_operator_status" }));
}

endButton.addEventListener("click", async () => {
  endButton.disabled = true;
  signal.dataset.state = "ending";
  title.textContent = "Ending session";
  description.textContent = "Closing only tabs and the browser process created by Tether.";
  await chrome.runtime.sendMessage({ type: "tether_operator_end_session" });
  await refresh();
});

void refresh();

const signal = document.getElementById("signal");
const title = document.getElementById("status-title");
const description = document.getElementById("description");
const scope = document.getElementById("scope");
const endButton = document.getElementById("end-session");

function render(status) {
  const active = Boolean(status?.active);
  signal.dataset.state = active ? "active" : "offline";
  title.textContent = active ? "Profile live" : "No live profile";
  description.textContent = active
    ? "Tether is limited to this isolated browser boundary."
    : "Start a session from your MCP client to create a new boundary.";
  scope.textContent = active ? `${status.ownedTabs} owned tab${status.ownedTabs === 1 ? "" : "s"} · isolated` : "No active boundary";
  endButton.disabled = !active;
}

async function refresh() {
  render(await chrome.runtime.sendMessage({ type: "tether_operator_status" }));
}

endButton.addEventListener("click", async () => {
  endButton.disabled = true;
  signal.dataset.state = "ending";
  title.textContent = "Ending now";
  description.textContent = "Closing only the tabs and browser process created by Tether.";
  await chrome.runtime.sendMessage({ type: "tether_operator_end_session" });
  await refresh();
});

void refresh();

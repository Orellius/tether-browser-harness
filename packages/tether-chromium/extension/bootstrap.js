(() => {
  const token = String(location.hash || "").replace(/^#/, "");
  const title = document.getElementById?.("console-title");
  const description = document.getElementById?.("description");
  const signal = document.getElementById?.("signal");
  if (!/^[a-f0-9]{64}$/.test(token)) {
    if (title) title.textContent = "Profile blocked";
    if (description) description.textContent = "Invalid Tether session bootstrap.";
    if (signal) signal.dataset.state = "offline";
    if (!title) document.body.textContent = "Invalid Tether session bootstrap.";
    return;
  }
  chrome.runtime.sendMessage({ type: "tether_profile_bootstrap", token }, (result) => {
    if (result?.ok) {
      if (title) title.textContent = "Profile live";
      if (description) description.textContent = "This boundary is live. The toolbar badge remains LIVE while this isolated profile is active.";
      if (signal) signal.dataset.state = "active";
    }
  });
  globalThis.history?.replaceState?.(null, "", location.pathname || "bootstrap.html");
  if (!title) document.body.textContent = "Tether isolated session ready.";
})();

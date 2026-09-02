const TOKEN_RE = /^[a-f0-9]{64}$/;
const NATIVE_HOST_NAME = "com.tether.browser_harness";
const OWNED_TAB_IDS_KEY = "tetherOwnedTabIds";
let nativePort = null;

async function setOperatorIndicator(state) {
  if (!chrome.action) return;
  const active = state === "active";
  const ending = state === "ending";
  await Promise.all([
    chrome.action.setBadgeText({ text: active ? "LIVE" : ending ? "END" : "" }),
    chrome.action.setBadgeBackgroundColor({ color: active ? "#7C8CFF" : ending ? "#EC6C5D" : "#6E7882" }),
    chrome.action.setTitle({ title: active
      ? "Tether: active isolated profile"
      : ending ? "Tether: ending isolated profile"
        : "Tether: no isolated profile active" }),
  ]);
}

async function ownedTabIds() {
  const stored = await chrome.storage.session.get(OWNED_TAB_IDS_KEY);
  const ids = stored?.[OWNED_TAB_IDS_KEY];
  return new Set(Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id) && id > 0) : []);
}

async function saveOwnedTabIds(ids) {
  await chrome.storage.session.set({ [OWNED_TAB_IDS_KEY]: [...ids] });
}

async function closeOwnedTabs() {
  const ids = await ownedTabIds();
  const tabIds = [...ids];
  if (tabIds.length > 0) await chrome.tabs.remove(tabIds);
  await saveOwnedTabIds(new Set());
  return tabIds.length;
}

async function operatorStatus() {
  const ids = await ownedTabIds();
  return {
    active: Boolean(nativePort),
    profile: "isolated",
    ownedTabs: ids.size,
    operatorControl: true,
  };
}

function requireOwnedTabId(ids, value) {
  if (!Number.isInteger(value) || value <= 0 || !ids.has(value)) {
    throw new Error("Tether can control only tabs it created in this isolated session.");
  }
  return value;
}

function requireHttpUrl(value) {
  if (typeof value !== "string" || value.length > 8_192) throw new Error("A non-empty URL is required.");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("The navigation URL is invalid."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Tether navigation accepts only http or https URLs.");
  }
  return parsed.href;
}

function extractVisiblePageText() {
  return String(document.body?.innerText || "").slice(0, 30_000);
}

function sendToolResponse(port, id, { result, error } = {}) {
  port.postMessage(error
    ? { type: "tool_response", id, error: String(error) }
    : { type: "tool_response", id, result });
}

async function handleToolRequest(port, message) {
  if (message?.type !== "tool_request" || typeof message.id !== "string" || typeof message.tool !== "string") return;
  try {
    const ids = await ownedTabIds();
    if (message.tool === "tabs_create") {
      const tab = await chrome.tabs.create({ url: "about:blank", active: false });
      if (!Number.isInteger(tab?.id) || tab.id <= 0) throw new Error("Chromium did not return a tab id.");
      ids.add(tab.id);
      await saveOwnedTabIds(ids);
      return sendToolResponse(port, message.id, { result: { tabId: tab.id, owned: true } });
    }
    if (message.tool === "navigate") {
      const tabId = requireOwnedTabId(ids, message.args?.tabId);
      const url = requireHttpUrl(message.args?.url);
      await chrome.tabs.update(tabId, { url });
      return sendToolResponse(port, message.id, { result: { tabId, url } });
    }
    if (message.tool === "read_page_text") {
      const tabId = requireOwnedTabId(ids, message.args?.tabId);
      const execution = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractVisiblePageText,
      });
      const text = typeof execution?.[0]?.result === "string" ? execution[0].result : "";
      return sendToolResponse(port, message.id, { result: { tabId, text } });
    }
    if (message.tool === "tabs_close") {
      const tabId = requireOwnedTabId(ids, message.args?.tabId);
      await chrome.tabs.remove(tabId);
      ids.delete(tabId);
      await saveOwnedTabIds(ids);
      return sendToolResponse(port, message.id, { result: { tabId, closed: true } });
    }
    if (message.tool === "end_session") {
      return sendToolResponse(port, message.id, { result: { closedTabs: await closeOwnedTabs() } });
    }
    throw new Error(`Unknown Tether extension tool: ${message.tool}`);
  } catch (error) {
    sendToolResponse(port, message.id, { error: error instanceof Error ? error.message : "Tether extension tool failed." });
  }
}

function connectNative(profileToken) {
  if (nativePort || typeof chrome.runtime.connectNative !== "function") return;
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  nativePort = port;
  port.onMessage.addListener((message) => { void handleToolRequest(port, message); });
  port.onDisconnect.addListener(() => {
    if (nativePort === port) {
      nativePort = null;
      void setOperatorIndicator("inactive");
    }
  });
  port.postMessage({ type: "profile_hello", token: profileToken });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender?.id !== chrome.runtime.id) return false;
  if (message?.type === "tether_profile_bootstrap" && TOKEN_RE.test(message.token || "")) {
    chrome.storage.session.set({ tetherProfileBootstrapToken: message.token })
      .then(async () => {
        connectNative(message.token);
        await setOperatorIndicator("active");
        sendResponse({ ok: true });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "tether_operator_status") {
    operatorStatus().then(sendResponse).catch(() => sendResponse({ active: false, profile: "isolated", ownedTabs: 0, operatorControl: true }));
    return true;
  }
  if (message?.type === "tether_operator_end_session") {
    (async () => {
      const closedTabs = await closeOwnedTabs();
      await setOperatorIndicator("ending");
      if (nativePort && !nativePort.disconnected) nativePort.postMessage({ type: "operator_end_session", closedTabs });
      sendResponse({ ok: true, closedTabs });
    })().catch(() => sendResponse({ ok: false, closedTabs: 0 }));
    return true;
  }
  return false;
});

chrome.runtime.onMessageExternal.addListener(() => false);
chrome.runtime.onConnectExternal.addListener((port) => port.disconnect());

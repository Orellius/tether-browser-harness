import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(here, "../extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createHarness() {
  const listeners = [];
  const stored = {};
  const created = [];
  const updated = [];
  const removed = [];
  const injections = [];
  let nextTabId = 100;
  const port = {
    sent: [],
    messageListeners: [],
    disconnectListeners: [],
    postMessage(message) { this.sent.push(message); },
    onMessage: { addListener(listener) { port.messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { port.disconnectListeners.push(listener); } },
  };
  const chrome = {
    runtime: {
      id: "tether-test-extension",
      connectNative: () => port,
      onMessage: { addListener(listener) { listeners.push(listener); } },
      onMessageExternal: { addListener() {} },
      onConnectExternal: { addListener() {} },
    },
    storage: {
      session: {
        async set(value) { Object.assign(stored, value); },
        async get() { return { ...stored }; },
      },
    },
    tabs: {
      async create(properties) { const tab = { id: nextTabId++, url: "about:blank", ...properties }; created.push(tab); return tab; },
      async update(tabId, properties) { updated.push({ tabId, properties }); return { id: tabId, ...properties }; },
      async remove(tabIds) { removed.push(...(Array.isArray(tabIds) ? tabIds : [tabIds])); },
    },
    scripting: {
      async executeScript(details) { injections.push(details); return [{ result: "Visible page text" }]; },
    },
  };
  vm.runInNewContext(background, { chrome, setTimeout, clearTimeout, URL });
  return { listeners, stored, created, updated, removed, injections, port };
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function deliver(port, message) {
  port.messageListeners[0](message);
}

function response(port, id) {
  return clone(port.sent.find((message) => message.type === "tool_response" && message.id === id));
}

test("page access is injected only for explicit requests on Tether-owned tabs", async () => {
  assert.deepEqual([...manifest.permissions].sort(), ["nativeMessaging", "scripting", "storage", "tabs"]);
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.equal(manifest.content_scripts, undefined);

  const h = createHarness();
  h.listeners[0]({ type: "tether_profile_bootstrap", token: "a".repeat(64) }, { id: "tether-test-extension" }, () => {});
  await tick();
  assert.deepEqual(clone(h.port.sent[0]), { type: "profile_hello", token: "a".repeat(64) });

  deliver(h.port, { type: "tool_request", id: "create", tool: "tabs_create", args: {} });
  await tick();
  assert.deepEqual(response(h.port, "create"), { type: "tool_response", id: "create", result: { tabId: 100, owned: true } });

  deliver(h.port, { type: "tool_request", id: "navigate", tool: "navigate", args: { tabId: 100, url: "https://example.com/article" } });
  await tick();
  assert.deepEqual(clone(h.updated), [{ tabId: 100, properties: { url: "https://example.com/article" } }]);
  assert.deepEqual(response(h.port, "navigate"), { type: "tool_response", id: "navigate", result: { tabId: 100, url: "https://example.com/article" } });

  deliver(h.port, { type: "tool_request", id: "read", tool: "read_page_text", args: { tabId: 100 } });
  await tick();
  assert.deepEqual(h.injections.map((entry) => clone(entry.target)), [{ tabId: 100 }]);
  assert.deepEqual(response(h.port, "read"), { type: "tool_response", id: "read", result: { tabId: 100, text: "Visible page text" } });

  deliver(h.port, { type: "tool_request", id: "foreign", tool: "read_page_text", args: { tabId: 999 } });
  await tick();
  assert.match(response(h.port, "foreign").error, /only tabs it created/);
  assert.equal(h.injections.length, 1);

  deliver(h.port, { type: "tool_request", id: "unsafe", tool: "navigate", args: { tabId: 100, url: "file:///private/secret" } });
  await tick();
  assert.match(response(h.port, "unsafe").error, /http or https/);

  deliver(h.port, { type: "tool_request", id: "end", tool: "end_session", args: {} });
  await tick();
  assert.deepEqual(h.removed, [100]);
  assert.deepEqual(response(h.port, "end"), { type: "tool_response", id: "end", result: { closedTabs: 1 } });
});

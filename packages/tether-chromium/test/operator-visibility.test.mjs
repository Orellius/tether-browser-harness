import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const background = fs.readFileSync(path.join(here, "../extension/background.js"), "utf8");

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function createHarness() {
  const listeners = [];
  const stored = {};
  const action = { badges: [], colors: [], titles: [] };
  const removed = [];
  const port = {
    sent: [], messageListeners: [], disconnectListeners: [],
    postMessage(message) { this.sent.push(message); },
    onMessage: { addListener(listener) { port.messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { port.disconnectListeners.push(listener); } },
  };
  const chrome = {
    runtime: {
      id: "tether-test-extension", connectNative: () => port,
      onMessage: { addListener(listener) { listeners.push(listener); } },
      onMessageExternal: { addListener() {} }, onConnectExternal: { addListener() {} },
    },
    action: {
      async setBadgeText(value) { action.badges.push(value); },
      async setBadgeBackgroundColor(value) { action.colors.push(value); },
      async setTitle(value) { action.titles.push(value); },
    },
    storage: { session: { async set(value) { Object.assign(stored, value); }, async get() { return { ...stored }; } } },
    tabs: {
      async create() { return { id: 100 }; }, async update() { return {}; },
      async remove(tabIds) { removed.push(...(Array.isArray(tabIds) ? tabIds : [tabIds])); },
    },
    scripting: { async executeScript() { return [{ result: "" }]; } },
  };
  vm.runInNewContext(background, { chrome, setTimeout, clearTimeout, URL });
  return { listeners, action, removed, port };
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("an active profile exposes a persistent operator indicator and a user-owned emergency exit", async () => {
  const h = createHarness();
  const replies = [];
  h.listeners[0]({ type: "tether_profile_bootstrap", token: "a".repeat(64) }, { id: "tether-test-extension" }, (value) => replies.push(value));
  await tick();
  assert.deepEqual(clone(h.action.badges.at(-1)), { text: "LIVE" });
  assert.deepEqual(clone(h.action.colors.at(-1)), { color: "#9CFF2E" });
  assert.match(h.action.titles.at(-1).title, /active isolated profile/i);

  h.port.messageListeners[0]({ type: "tool_request", id: "create", tool: "tabs_create", args: {} });
  await tick();
  h.listeners[0]({ type: "tether_operator_status" }, { id: "tether-test-extension" }, (value) => replies.push(value));
  await tick();
  assert.deepEqual(clone(replies.at(-1)), { active: true, profile: "isolated", ownedTabs: 1, operatorControl: true });

  h.listeners[0]({ type: "tether_operator_end_session" }, { id: "tether-test-extension" }, (value) => replies.push(value));
  await tick();
  assert.deepEqual(h.removed, [100]);
  assert.deepEqual(clone(h.port.sent.at(-1)), { type: "operator_end_session", closedTabs: 1 });
  assert.deepEqual(clone(replies.at(-1)), { ok: true, closedTabs: 1 });
});

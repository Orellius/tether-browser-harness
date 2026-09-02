import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(here, "../extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
const bootstrap = fs.readFileSync(path.join(extensionDir, "bootstrap.js"), "utf8");
const background = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");

function extensionIdFromKey(key) {
  const der = Buffer.from(key, "base64");
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, (hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)));
}

test("Tether extension has an independent stable identity and denies external callers", () => {
  assert.equal(manifest.name, "Tether Browser Harness");
  crypto.createPublicKey({ key: Buffer.from(manifest.key, "base64"), type: "spki", format: "der" });
  assert.equal(extensionIdFromKey(manifest.key), "deokmcegoeidoodobjihmbdnkgjebbeo");
  assert.deepEqual(manifest.externally_connectable, {
    ids: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    matches: ["https://deny-all.invalid/*"],
  });
  assert.ok(manifest.permissions.includes("nativeMessaging"));
  assert.equal(manifest.action.default_popup, "control.html");
  assert.equal(manifest.action.default_title, "Tether: no isolated profile active");
  assert.ok(manifest.icons[128]);
});

test("bootstrap relays only a valid one-time profile token to its own extension", () => {
  const messages = [];
  const body = { textContent: "" };
  const token = "a".repeat(64);
  vm.runInNewContext(bootstrap, {
    location: { hash: `#${token}` },
    chrome: { runtime: { sendMessage: (message) => messages.push(message) } },
    document: { body },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: "tether_profile_bootstrap", token }]);
  assert.match(body.textContent, /ready/i);

  const invalid = [];
  const invalidBody = { textContent: "" };
  vm.runInNewContext(bootstrap, {
    location: { hash: "#not-a-token" },
    chrome: { runtime: { sendMessage: (message) => invalid.push(message) } },
    document: { body: invalidBody },
  });
  assert.deepEqual(invalid, []);
  assert.match(invalidBody.textContent, /invalid/i);
});

test("background accepts bootstrap only from itself and keeps the token in session-only storage", async () => {
  const listeners = [];
  const writes = [];
  vm.runInNewContext(background, {
    chrome: {
      runtime: {
        id: "tether-test-extension",
        onMessage: { addListener: (listener) => listeners.push(listener) },
        onMessageExternal: { addListener: () => {} },
        onConnectExternal: { addListener: () => {} },
      },
      storage: { session: { set: async (value) => writes.push(value) } },
    },
  });
  assert.equal(listeners.length, 1);
  const reply = [];
  const keptAlive = listeners[0]({ type: "tether_profile_bootstrap", token: "b".repeat(64) }, { id: "tether-test-extension" }, (value) => reply.push(value));
  assert.equal(keptAlive, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ tetherProfileBootstrapToken: "b".repeat(64) }]);
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), [{ ok: true }]);

  listeners[0]({ type: "tether_profile_bootstrap", token: "c".repeat(64) }, { id: "foreign-extension" }, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
});

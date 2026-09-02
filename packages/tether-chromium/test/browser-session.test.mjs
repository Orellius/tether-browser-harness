import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  browserSessionStatus,
  profileTokenMatches,
  startIsolatedBrowser,
  stopIsolatedBrowser,
} from "../src/browser-session.js";

const TEST_EXTENSION_KEY = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 })
  .publicKey.export({ type: "spki", format: "der" }).toString("base64");

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tether-chromium-state-"));
  const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), "tether-chromium-extension-"));
  fs.writeFileSync(path.join(extensionDir, "manifest.json"), JSON.stringify({ key: TEST_EXTENSION_KEY }));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(extensionDir, { recursive: true, force: true }));
  return { stateDir, extensionDir };
}

function fakeProcessHarness() {
  const live = new Set();
  const calls = [];
  let nextPid = 41001;
  return {
    live,
    calls,
    spawn(command, args) {
      const child = new EventEmitter();
      child.pid = nextPid++;
      child.unref = () => {};
      live.add(child.pid);
      calls.push({ command, args, pid: child.pid });
      return child;
    },
    isAlive(pid) { return live.has(pid); },
    kill(pid, signal) { if (!live.delete(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); calls.push({ killed: pid, signal }); },
  };
}

test("a Chromium session launches once in an isolated profile and never adopts another process", (t) => {
  const { stateDir, extensionDir } = fixture(t);
  const harness = fakeProcessHarness();
  const first = startIsolatedBrowser({ stateDir, extensionDir, browserPath: "/tmp/fake-chromium", spawnProcess: harness.spawn, isAlive: harness.isAlive, validateExecutable: false });
  assert.equal(first.started, true);
  assert.equal(harness.calls.length, 1);
  assert.ok(harness.calls[0].args.includes(`--user-data-dir=${path.join(stateDir, "chromium-profile")}`));
  assert.ok(harness.calls[0].args.includes(`--load-extension=${extensionDir}`));
  assert.ok(harness.calls[0].args.at(-1).startsWith("chrome-extension://"));
  const bootstrapToken = harness.calls[0].args.at(-1).split("#")[1];
  assert.equal(profileTokenMatches(bootstrapToken, { stateDir, isAlive: harness.isAlive }), true);
  assert.equal(profileTokenMatches("a".repeat(64), { stateDir, isAlive: harness.isAlive }), false);
  assert.equal(fs.statSync(path.join(stateDir, "browser-session.json")).mode & 0o777, 0o600);

  const second = startIsolatedBrowser({ stateDir, extensionDir, browserPath: "/tmp/fake-chromium", spawnProcess: harness.spawn, isAlive: harness.isAlive, validateExecutable: false });
  assert.deepEqual(second, { started: false, existing: true, pid: first.pid, profileDir: first.profileDir });
  assert.equal(harness.calls.length, 1);
  assert.equal(browserSessionStatus({ stateDir, isAlive: harness.isAlive }).active, true);
});

test("session stop targets only the exact recorded process", (t) => {
  const { stateDir, extensionDir } = fixture(t);
  const harness = fakeProcessHarness();
  const session = startIsolatedBrowser({ stateDir, extensionDir, browserPath: "/tmp/fake-chromium", spawnProcess: harness.spawn, isAlive: harness.isAlive, validateExecutable: false });
  harness.live.add(99999);
  const stopped = stopIsolatedBrowser({ stateDir, isAlive: harness.isAlive, killProcess: harness.kill });
  assert.deepEqual(stopped, { stopped: true, pid: session.pid, signal: "SIGTERM" });
  assert.equal(harness.live.has(99999), true);
  assert.equal(fs.existsSync(path.join(stateDir, "browser-session.json")), false);
});

test("an invalid extension path is rejected before a browser can start", (t) => {
  const { stateDir } = fixture(t);
  const harness = fakeProcessHarness();
  assert.throws(
    () => startIsolatedBrowser({ stateDir, extensionDir: "/tmp/does-not-exist", browserPath: "/tmp/fake-chromium", spawnProcess: harness.spawn, isAlive: harness.isAlive, validateExecutable: false }),
    /extension manifest is missing/,
  );
  assert.equal(harness.calls.length, 0);
});

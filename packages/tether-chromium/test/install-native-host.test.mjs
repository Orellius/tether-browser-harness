import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startMcpClient } from "../../test-support/mcp-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const installerPath = path.join(here, "../src/install-native-host.mjs");

function runInstaller(env, ...args) {
  return spawnSync(process.execPath, [installerPath, ...args], { env, encoding: "utf8", timeout: 15_000 });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("native-host installation previews without writes and applies only the Tether identity", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tether-install-"));
  const stateDir = path.join(root, "state");
  const nativeHostDir = path.join(root, "NativeMessagingHosts");
  const port = await freePort();
  const env = { ...process.env, TETHER_HOME: stateDir, TETHER_PORT: String(port), TETHER_NATIVE_HOST_DIR: nativeHostDir };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const previewRun = runInstaller(env);
  assert.equal(previewRun.status, 0, previewRun.stderr);
  const preview = JSON.parse(previewRun.stdout);
  assert.equal(preview.apply, false);
  assert.equal(fs.existsSync(stateDir), false);
  assert.equal(preview.nativeManifest, path.join(nativeHostDir, "com.tether.browser_harness.json"));
  assert.match(preview.codexCommand.join(" "), /tether-mcp/);
  assert.deepEqual(preview.stdioMcp.args, [path.join(stateDir, "runtime", "packages", "tether-mcp", "src", "server.js")]);
  assert.equal(preview.stdioMcp.env.TETHER_CHROMIUM_PATH, "/absolute/path/to/Chromium-or-Brave");

  fs.mkdirSync(nativeHostDir, { recursive: true });
  const unrelated = path.join(nativeHostDir, "com.example.another-bridge.json");
  fs.writeFileSync(unrelated, "unrelated bridge sentinel");
  const appliedRun = runInstaller(env, "--apply");
  assert.equal(appliedRun.status, 0, appliedRun.stderr);
  const applied = JSON.parse(appliedRun.stdout);
  const nativeManifest = JSON.parse(fs.readFileSync(applied.nativeManifest, "utf8"));
  assert.equal(nativeManifest.name, "com.tether.browser_harness");
  assert.deepEqual(nativeManifest.allowed_origins, [`chrome-extension://${applied.extensionId}/`]);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "unrelated bridge sentinel");
  assert.equal(fs.statSync(applied.nativeManifest).mode & 0o777, 0o600);
  assert.equal(fs.statSync(applied.wrapper).mode & 0o777, 0o700);
  assert.equal(spawnSync("sh", ["-n", applied.wrapper]).status, 0);
  assert.ok(fs.existsSync(path.join(applied.runtimeDir, "extension", "background.js")));
  assert.ok(fs.existsSync(path.join(applied.runtimeDir, "packages", "tether-mcp", "src", "server.js")));

  const client = await startMcpClient({
    command: process.execPath,
    args: [path.join(applied.runtimeDir, "packages", "tether-mcp", "src", "server.js")],
    env: {
      ...env,
      TETHER_CHROMIUM_EXTENSION_DIR: path.join(applied.runtimeDir, "extension"),
      TETHER_CHROMIUM_PATH: process.execPath,
    },
  });
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "tether_session_end"));

  fs.writeFileSync(applied.nativeManifest, JSON.stringify({ ...nativeManifest, allowed_origins: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"] }));
  const unexpectedRun = runInstaller(env, "--apply");
  assert.notEqual(unexpectedRun.status, 0);
});

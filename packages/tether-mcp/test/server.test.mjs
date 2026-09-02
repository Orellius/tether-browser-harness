import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startMcpClient } from "../../test-support/mcp-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "../src/server.js");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("any MCP client can discover Tether and inspect its provider-neutral runtime", async (t) => {
  const stateDir = path.join(os.tmpdir(), `tether-mcp-${process.pid}-${Date.now()}`);
  const port = await freePort();
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  const client = await startMcpClient({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      TETHER_HOME: stateDir,
      TETHER_PORT: String(port),
      TETHER_MODEL_PROVIDER: "none",
    },
  });
  t.after(() => client.close());
  assert.equal(client.getServerVersion().name, "tether-browser-harness");

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["tether_navigate", "tether_page_read", "tether_runtime_status", "tether_session_end", "tether_session_start", "tether_session_status", "tether_session_stop", "tether_tabs_close", "tether_tabs_create"]);

  const result = await client.callTool({ name: "tether_runtime_status", arguments: {} });
  assert.equal(result.isError, undefined);
  const status = JSON.parse(result.content.find((part) => part.type === "text").text);
  assert.deepEqual(status, {
    browserAdapter: "chromium",
    modelProvider: "none",
    session: "adapter-not-configured",
  });
});

test("a configured Chromium adapter starts and stops only its isolated process", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tether-mcp-session-${process.pid}-${Date.now()}-`));
  const stateDir = path.join(root, "state");
  const extensionDir = path.join(root, "extension");
  const browserScript = path.join(root, "fake-chromium.sh");
  const port = await freePort();
  fs.mkdirSync(extensionDir);
  const key = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  fs.writeFileSync(path.join(extensionDir, "manifest.json"), JSON.stringify({ key }));
  fs.writeFileSync(browserScript, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n", { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const client = await startMcpClient({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, TETHER_HOME: stateDir, TETHER_PORT: String(port), TETHER_CHROMIUM_PATH: browserScript, TETHER_CHROMIUM_EXTENSION_DIR: extensionDir },
  });
  t.after(() => client.close());

  const started = await client.callTool({ name: "tether_session_start", arguments: {} });
  const startPayload = JSON.parse(started.content.find((part) => part.type === "text").text);
  assert.equal(startPayload.started, true);
  const stopped = await client.callTool({ name: "tether_session_stop", arguments: {} });
  const stopPayload = JSON.parse(stopped.content.find((part) => part.type === "text").text);
  assert.equal(stopPayload.stopped, true);
});

test("unknown Tether tools are rejected without starting a browser or model provider", async (t) => {
  const stateDir = path.join(os.tmpdir(), `tether-mcp-${process.pid}-${Date.now()}-unknown`);
  const port = await freePort();
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const client = await startMcpClient({ command: process.execPath, args: [serverPath], env: { ...process.env, TETHER_HOME: stateDir, TETHER_PORT: String(port) } });
  t.after(() => client.close());

  const result = await client.callTool({ name: "browser_session_start", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content.find((part) => part.type === "text").text, /Unknown Tether tool/);
});

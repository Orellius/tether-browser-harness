import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startMcpClient } from "../../test-support/mcp-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "../src/server.js");
const extensionDir = path.join(here, "../../tether-chromium/extension");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function connectNative(port, messages) {
  const socket = net.connect(port, "127.0.0.1");
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let index;
    while ((index = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function waitFor(check, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("an authenticated isolated profile relays a browser tool through the Tether MCP bridge", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tether-native-bridge-"));
  const stateDir = path.join(root, "state");
  const argsPath = path.join(root, "browser-args.txt");
  const browserPath = path.join(root, "fake-chromium.sh");
  fs.writeFileSync(browserPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n`, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const port = await freePort();

  const client = await startMcpClient({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      TETHER_HOME: stateDir,
      TETHER_PORT: String(port),
      TETHER_CHROMIUM_PATH: browserPath,
      TETHER_CHROMIUM_EXTENSION_DIR: extensionDir,
    },
  });
  t.after(() => client.close());

  const started = await client.callTool({ name: "tether_session_start", arguments: {} });
  assert.equal(JSON.parse(started.content[0].text).started, true);
  const launchArgs = await waitFor(() => fs.existsSync(argsPath) && fs.readFileSync(argsPath, "utf8"), "isolated browser args");
  const bootstrapUrl = launchArgs.split("\n").find((entry) => entry.startsWith("chrome-extension://"));
  const profileToken = bootstrapUrl.split("#")[1];
  const token = JSON.parse(fs.readFileSync(path.join(stateDir, "config.json"), "utf8")).token;

  const messages = [];
  const native = await connectNative(port, messages);
  t.after(() => native.destroy());
  native.write(`${JSON.stringify({ type: "host_hello", token })}\n`);
  native.write(`${JSON.stringify({ type: "profile_hello", token: profileToken })}\n`);
  await waitFor(() => messages.find((message) => message.type === "host_ready"), "authenticated host acknowledgement");

  const call = client.callTool({ name: "tether_tabs_create", arguments: {} });
  const request = await waitFor(() => messages.find((message) => message.type === "tool_request"), "tab creation request");
  assert.equal(request.tool, "tabs_create");
  native.write(`${JSON.stringify({ type: "tool_response", id: request.id, result: { tabId: 77, owned: true } })}\n`);
  const result = await call;
  assert.deepEqual(JSON.parse(result.content[0].text), { tabId: 77, owned: true });

  const navigateCall = client.callTool({ name: "tether_navigate", arguments: { tabId: 77, url: "https://example.com/docs" } });
  const navigateRequest = await waitFor(() => messages.find((message) => message.type === "tool_request" && message.tool === "navigate"), "navigation request");
  assert.deepEqual(navigateRequest.args, { tabId: 77, url: "https://example.com/docs" });
  native.write(`${JSON.stringify({ type: "tool_response", id: navigateRequest.id, result: { tabId: 77, url: "https://example.com/docs" } })}\n`);
  assert.deepEqual(JSON.parse((await navigateCall).content[0].text), { tabId: 77, url: "https://example.com/docs" });

  const readCall = client.callTool({ name: "tether_page_read", arguments: { tabId: 77 } });
  const readRequest = await waitFor(() => messages.find((message) => message.type === "tool_request" && message.tool === "read_page_text"), "page read request");
  native.write(`${JSON.stringify({ type: "tool_response", id: readRequest.id, result: { tabId: 77, text: "Example document" } })}\n`);
  assert.deepEqual(JSON.parse((await readCall).content[0].text), { tabId: 77, text: "Example document" });

  native.write(`${JSON.stringify({ type: "operator_end_session", closedTabs: 1 })}\n`);
  const ended = await waitFor(
    () => messages.find((message) => message.type === "operator_end_session_result"),
    "operator end session acknowledgement",
  );
  assert.equal(ended.result.closedTabs, 1);
  assert.equal(ended.result.browser.stopped, true);
  assert.equal(ended.result.browser.signal, "SIGTERM");
  assert.equal(Number.isInteger(ended.result.browser.pid), true);
});

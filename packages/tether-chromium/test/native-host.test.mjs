import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOrCreateToken } from "../../tether-runtime/src/local-auth-token.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostPath = path.join(here, "../src/native-host.js");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function nativeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function readNativeFrames(stream, messages) {
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      messages.push(JSON.parse(buffer.subarray(4, length + 4).toString("utf8")));
      buffer = buffer.subarray(length + 4);
    }
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

test("native host relays only a profile-proven extension connection to Tether TCP", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tether-native-host-"));
  const token = loadOrCreateToken({ stateDir });
  const port = await freePort();
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const received = [];
  let socket;
  const server = net.createServer((connection) => {
    socket = connection;
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line) received.push(JSON.parse(line));
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(port, "127.0.0.1", (error) => error ? reject(error) : resolve()));

  const child = spawn(process.execPath, [hostPath], {
    env: { ...process.env, TETHER_HOME: stateDir, TETHER_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  t.after(async () => {
    if (!child.killed) child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => server.close(() => resolve()));
  });
  const extensionMessages = [];
  readNativeFrames(child.stdout, extensionMessages);

  const profileToken = "a".repeat(64);
  child.stdin.write(nativeFrame({ type: "profile_hello", token: profileToken }));
  await waitFor(() => received.length >= 2, "native host hello frames");
  assert.deepEqual(received.slice(0, 2), [
    { type: "host_hello", token },
    { type: "profile_hello", token: profileToken },
  ]);

  socket.write(`${JSON.stringify({ type: "tool_request", id: "r-1", tool: "tabs_create", args: {} })}\n`);
  await waitFor(() => extensionMessages.find((message) => message.id === "r-1"), "native tool request");
  assert.deepEqual(extensionMessages.find((message) => message.id === "r-1"), { type: "tool_request", id: "r-1", tool: "tabs_create", args: {} });

  child.stdin.write(nativeFrame({ type: "tool_response", id: "r-1", result: { tabId: 55 } }));
  await waitFor(() => received.find((message) => message.type === "tool_response"), "native tool response");
  assert.deepEqual(received.find((message) => message.type === "tool_response"), { type: "tool_response", id: "r-1", result: { tabId: 55 } });
});

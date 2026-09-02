#!/usr/bin/env node

import net from "node:net";

import { loadOrCreateToken } from "../../tether-runtime/src/local-auth-token.js";
import { readRuntimeConfig } from "../../tether-runtime/src/runtime-config.js";

const config = readRuntimeConfig();
const MAX_NATIVE_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_RECONNECT_ATTEMPTS = 60;

let frameBuffer = Buffer.alloc(0);
let tcpSocket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let profileHello = null;

function writeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

function readNativeFrames(chunk) {
  frameBuffer = Buffer.concat([frameBuffer, chunk]);
  const messages = [];
  while (frameBuffer.length >= 4) {
    const size = frameBuffer.readUInt32LE(0);
    if (size > MAX_NATIVE_FRAME_BYTES) {
      process.exitCode = 1;
      process.stdin.destroy();
      return messages;
    }
    if (frameBuffer.length < 4 + size) return messages;
    const body = frameBuffer.subarray(4, 4 + size);
    frameBuffer = frameBuffer.subarray(4 + size);
    try { messages.push(JSON.parse(body.toString("utf8"))); } catch {}
  }
  return messages;
}

function makeLineSplitter(onLine) {
  let buffered = "";
  return (chunk) => {
    buffered += chunk.toString("utf8");
    let index;
    while ((index = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line) onLine(line);
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer || !profileHello) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempts += 1;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) return process.exit(0);
    connectTcp();
  }, 500);
}

function connectTcp() {
  if (!profileHello || tcpSocket) return;
  const socket = net.connect(config.port, "127.0.0.1");
  tcpSocket = socket;
  socket.on("connect", () => {
    reconnectAttempts = 0;
    socket.write(`${JSON.stringify({ type: "host_hello", token: loadOrCreateToken({ stateDir: config.stateDir }) })}\n`);
    socket.write(`${JSON.stringify(profileHello)}\n`);
  });
  socket.on("data", makeLineSplitter((line) => {
    try { writeNativeMessage(JSON.parse(line)); } catch {}
  }));
  socket.on("error", () => {});
  socket.on("close", () => {
    if (tcpSocket !== socket) return;
    tcpSocket = null;
    scheduleReconnect();
  });
}

process.stdin.on("data", (chunk) => {
  for (const message of readNativeFrames(chunk)) {
    if (message?.type === "profile_hello") {
      if (typeof message.token !== "string" || !/^[a-f0-9]{64}$/.test(message.token)) continue;
      if (profileHello?.token === message.token) continue;
      profileHello = { type: "profile_hello", token: message.token };
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (tcpSocket) tcpSocket.destroy();
      tcpSocket = null;
      connectTcp();
      continue;
    }
    if (profileHello && tcpSocket && !tcpSocket.destroyed) {
      tcpSocket.write(`${JSON.stringify(message)}\n`);
    }
  }
});

process.stdin.on("end", () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (tcpSocket) tcpSocket.destroy();
  process.exit(0);
});

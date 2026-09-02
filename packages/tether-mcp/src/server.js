#!/usr/bin/env node

import readline from "node:readline";
import net from "node:net";

import { readRuntimeConfig } from "../../tether-runtime/src/runtime-config.js";
import { loadOrCreateToken, tokensMatch } from "../../tether-runtime/src/local-auth-token.js";
import { browserSessionStatus, profileTokenMatches, startIsolatedBrowser, stopIsolatedBrowser } from "../../tether-chromium/src/browser-session.js";

const config = readRuntimeConfig();
const SERVER_INFO = Object.freeze({ name: "tether-browser-harness", version: "0.1.0" });
const chromium = readChromiumAdapterConfig(process.env);
const localToken = loadOrCreateToken({ stateDir: config.stateDir });
const REQUEST_TIMEOUT_MS = 15_000;
let nativeSocket = null;
let nextNativeRequestId = 1;
const pendingNativeRequests = new Map();

const TOOLS = Object.freeze([
  {
    name: "tether_runtime_status",
    description: "Report Tether's provider-neutral runtime configuration without starting a browser, model provider, or session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tether_session_status",
    description: "Report whether a Tether browser adapter session exists. The initial runtime intentionally does not start a browser.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tether_session_start",
    description: "Start exactly one isolated Chromium process configured for Tether. Refuses when the Chromium adapter is not configured.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tether_session_stop",
    description: "Stop only the exact isolated Chromium process previously launched by Tether.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tether_tabs_create",
    description: "Create a fresh tab in Tether's isolated Chromium session. Requires an authenticated Tether extension connection.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tether_navigate",
    description: "Navigate a Tether-owned tab to an http or https URL. Refuses tabs outside the isolated Tether session.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "integer", minimum: 1 }, url: { type: "string", minLength: 1, maxLength: 8192 } },
      required: ["tabId", "url"],
      additionalProperties: false,
    },
  },
  {
    name: "tether_page_read",
    description: "Read up to 30,000 characters of visible text from a Tether-owned tab after explicit request.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "integer", minimum: 1 } },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "tether_tabs_close",
    description: "Close one tab owned by the isolated Tether session.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "integer", minimum: 1 } },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "tether_session_end",
    description: "Explicitly end the isolated Tether session, closing its owned tabs before stopping its exact browser process.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
]);

function readChromiumAdapterConfig(environment) {
  const browserPath = environment.TETHER_CHROMIUM_PATH;
  const extensionDir = environment.TETHER_CHROMIUM_EXTENSION_DIR;
  if (browserPath === undefined && extensionDir === undefined) return null;
  if (typeof browserPath !== "string" || !browserPath || typeof extensionDir !== "string" || !extensionDir) {
    throw new Error("TETHER_CHROMIUM_PATH and TETHER_CHROMIUM_EXTENSION_DIR must be configured together");
  }
  return { browserPath, extensionDir };
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  write({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function runtimeStatus() {
  return {
    browserAdapter: config.browserAdapter,
    modelProvider: config.modelProvider.kind,
    session: chromium ? browserSessionStatus({ stateDir: config.stateDir }) : "adapter-not-configured",
  };
}

function requireTabId(args) {
  if (!Number.isInteger(args?.tabId) || args.tabId <= 0) throw new Error("tabId must be a positive integer.");
  return args.tabId;
}

function requireHttpUrl(args) {
  if (typeof args?.url !== "string" || args.url.length === 0 || args.url.length > 8_192) {
    throw new Error("url must be a non-empty string up to 8192 characters.");
  }
  let parsed;
  try { parsed = new URL(args.url); } catch { throw new Error("url must be a valid URL."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("url must use http or https.");
  return parsed.href;
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

function rejectPendingRequests(reason) {
  for (const { reject, timer } of pendingNativeRequests.values()) {
    clearTimeout(timer);
    reject(new Error(reason));
  }
  pendingNativeRequests.clear();
}

function sendToExtension(tool, args) {
  if (!nativeSocket || nativeSocket.destroyed) return Promise.reject(new Error("Tether extension is not connected from the authenticated isolated profile."));
  const id = `tether-${nextNativeRequestId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingNativeRequests.delete(id);
      reject(new Error(`Tether extension timed out while handling ${tool}`));
    }, REQUEST_TIMEOUT_MS);
    pendingNativeRequests.set(id, { resolve, reject, timer });
    nativeSocket.write(`${JSON.stringify({ type: "tool_request", id, tool, args })}\n`);
  });
}

function handleNativeMessage(socket, message, state) {
  if (state.phase === "host_hello") {
    if (message?.type !== "host_hello" || !tokensMatch(localToken, message.token)) return socket.destroy();
    state.phase = "profile_hello";
    return;
  }
  if (state.phase === "profile_hello") {
    if (message?.type !== "profile_hello" || !profileTokenMatches(message.token, { stateDir: config.stateDir })) return socket.destroy();
    if (nativeSocket && nativeSocket !== socket) nativeSocket.destroy();
    nativeSocket = socket;
    state.phase = "ready";
    socket.write(`${JSON.stringify({ type: "host_ready" })}\n`);
    return;
  }
  if (message?.type === "operator_end_session") {
    const closedTabs = Number.isInteger(message.closedTabs) && message.closedTabs >= 0 ? message.closedTabs : 0;
    if (!chromium) {
      socket.write(`${JSON.stringify({ type: "operator_end_session_result", error: "Tether Chromium adapter is not configured." })}\n`);
      return;
    }
    try {
      const browser = stopIsolatedBrowser({ stateDir: config.stateDir });
      socket.write(`${JSON.stringify({ type: "operator_end_session_result", result: { closedTabs, browser } })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({ type: "operator_end_session_result", error: error.message })}\n`);
    }
    return;
  }
  if (message?.type !== "tool_response" || typeof message.id !== "string") return;
  const pending = pendingNativeRequests.get(message.id);
  if (!pending) return;
  pendingNativeRequests.delete(message.id);
  clearTimeout(pending.timer);
  if (message.error) pending.reject(new Error(String(message.error)));
  else pending.resolve(message.result);
}

const controlServer = net.createServer((socket) => {
  const state = { phase: "host_hello" };
  const timeout = setTimeout(() => socket.destroy(), 3_000);
  socket.on("data", makeLineSplitter((line) => {
    try {
      handleNativeMessage(socket, JSON.parse(line), state);
      if (state.phase === "ready") clearTimeout(timeout);
    } catch {
      socket.destroy();
    }
  }));
  socket.on("error", () => {});
  socket.on("close", () => {
    clearTimeout(timeout);
    if (nativeSocket === socket) {
      nativeSocket = null;
      rejectPendingRequests("Tether extension disconnected.");
    }
  });
});

await new Promise((resolve, reject) => {
  controlServer.once("error", reject);
  controlServer.listen(config.port, "127.0.0.1", () => {
    controlServer.off("error", reject);
    resolve();
  });
});

function toolResult(payload, { isError = false } = {}) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

async function handleToolCall(params) {
  const name = params?.name;
  if (name === "tether_runtime_status") return toolResult(runtimeStatus());
  if (name === "tether_session_status") return toolResult(chromium ? browserSessionStatus({ stateDir: config.stateDir }) : { session: "adapter-not-configured" });
  if (name === "tether_session_start") {
    if (!chromium) return toolResult({ error: "Tether Chromium adapter is not configured." }, { isError: true });
    try {
      return toolResult(startIsolatedBrowser({ stateDir: config.stateDir, ...chromium }));
    } catch (error) {
      return toolResult({ error: error.message }, { isError: true });
    }
  }
  if (name === "tether_session_stop") {
    if (!chromium) return toolResult({ error: "Tether Chromium adapter is not configured." }, { isError: true });
    try {
      return toolResult(stopIsolatedBrowser({ stateDir: config.stateDir }));
    } catch (error) {
      return toolResult({ error: error.message }, { isError: true });
    }
  }
  if (name === "tether_tabs_create") {
    try {
      return toolResult(await sendToExtension("tabs_create", {}));
    } catch (error) {
      return toolResult({ error: error.message }, { isError: true });
    }
  }
  if (name === "tether_navigate") {
    try {
      return toolResult(await sendToExtension("navigate", { tabId: requireTabId(params.arguments), url: requireHttpUrl(params.arguments) }));
    } catch (error) {
      return toolResult({ error: error.message }, { isError: true });
    }
  }
  if (name === "tether_page_read") {
    try {
      return toolResult(await sendToExtension("read_page_text", { tabId: requireTabId(params.arguments) }));
    } catch (error) {
      return toolResult({ error: error.message }, { isError: true });
    }
  }
  if (name === "tether_tabs_close") {
    try {
      return toolResult(await sendToExtension("tabs_close", { tabId: requireTabId(params.arguments) }));
    } catch (error) {
      return toolResult({ error: error.message }, { isError: true });
    }
  }
  if (name === "tether_session_end") {
    if (!chromium) return toolResult({ error: "Tether Chromium adapter is not configured." }, { isError: true });
    let tabs = { closedTabs: 0, reason: "Tether extension was not connected; stopping the isolated browser closes its profile session." };
    if (nativeSocket && !nativeSocket.destroyed) {
      try {
        tabs = await sendToExtension("end_session", {});
      } catch (error) {
        tabs = { closedTabs: 0, error: error.message, reason: "Stopping the isolated browser still ends the session." };
      }
    }
    try {
      const browser = stopIsolatedBrowser({ stateDir: config.stateDir });
      return toolResult({ tabs, browser });
    } catch (error) {
      return toolResult({ error: error.message, tabs }, { isError: true });
    }
  }
  return toolResult({ error: `Unknown Tether tool: ${String(name)}` }, { isError: true });
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
  const id = message.id;
  if (message.method === "notifications/initialized") return;
  if (message.method === "initialize") {
    result(id, {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: "Tether Browser Harness is provider-neutral. Browser control is unavailable until the isolated Chromium adapter is installed.",
    });
    return;
  }
  if (message.method === "tools/list") {
    result(id, { tools: TOOLS });
    return;
  }
  if (message.method === "tools/call") {
    result(id, await handleToolCall(message.params));
    return;
  }
  if (id !== undefined) error(id, -32601, `Method not found: ${message.method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  try {
    void handle(JSON.parse(line));
  } catch {
    // A malformed stdio frame has no trustworthy request id. Do not write a
    // response that a different MCP request could mistake for its result.
  }
});

input.on("close", () => {
  if (nativeSocket && !nativeSocket.destroyed) nativeSocket.destroy();
  rejectPendingRequests("Tether MCP runtime stopped.");
  controlServer.close();
});

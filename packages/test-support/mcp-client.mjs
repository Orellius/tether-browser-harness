import { spawn } from "node:child_process";

export async function startMcpClient({ command, args, env }) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let buffered = "";
  let nextId = 1;
  const pending = new Map();
  let stderr = "";

  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.stdout.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let boundary;
    while ((boundary = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  child.once("error", (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  child.once("exit", (code) => {
    for (const request of pending.values()) request.reject(new Error(`MCP server exited (${code}): ${stderr}`));
    pending.clear();
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tether-test-client", version: "1.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  return {
    getServerVersion() { return initialized.serverInfo; },
    listTools() { return request("tools/list", {}); },
    callTool({ name, arguments: toolArguments }) { return request("tools/call", { name, arguments: toolArguments }); },
    close() {
      if (!child.killed) child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

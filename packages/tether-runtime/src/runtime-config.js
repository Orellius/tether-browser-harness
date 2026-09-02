import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { readModelProviderConfig } from "../../tether-core/src/model-provider.js";

export class RuntimeConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeConfigurationError";
  }
}

const DEFAULT_PORT = 18768;
const RESERVED_LEGACY_PORTS = new Set([18765, 18766, 18767]);
const LEGACY_STATE_HASHES = new Set([
  "b32078ca8bd772238585117fac2af3347b5364a931eefbef9148998490487c89",
  "b6db9f366db83187c6c055c134b665d8408100255e2e05b66009f40a34b47161",
  "fb0a53468702e69c2ccea599a4f31074bff8514b6a13f73b623ccddd491baa26",
]);

function isReservedLegacyStateName(name) {
  const digest = crypto.createHash("sha256").update(name).digest("hex");
  return LEGACY_STATE_HASHES.has(digest);
}

function readStateDirectory(environment, homeDir) {
  const requested = environment.TETHER_HOME || path.join(homeDir, ".tether-browser-harness");
  if (!path.isAbsolute(requested)) throw new RuntimeConfigurationError("TETHER_HOME must be an absolute path");
  const stateDir = path.resolve(requested);
  const names = stateDir.split(path.sep).filter(Boolean);
  if (names.some(isReservedLegacyStateName)) {
    throw new RuntimeConfigurationError("TETHER_HOME must not reuse a reserved legacy browser-bridge state directory");
  }
  return stateDir;
}

function readPort(environment) {
  const raw = environment.TETHER_PORT ?? String(DEFAULT_PORT);
  const port = Number(raw);
  if (!/^\d+$/.test(String(raw)) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new RuntimeConfigurationError("TETHER_PORT must be an integer from 1024 through 65535");
  }
  if (RESERVED_LEGACY_PORTS.has(port)) {
    throw new RuntimeConfigurationError("TETHER_PORT must not reuse a reserved browser-bridge port");
  }
  return port;
}

function readBrowserAdapter(environment) {
  const adapter = environment.TETHER_BROWSER_ADAPTER || "chromium";
  if (adapter !== "chromium") throw new RuntimeConfigurationError("TETHER_BROWSER_ADAPTER must be chromium");
  return adapter;
}

export function readRuntimeConfig(environment = process.env, { homeDir = os.homedir() } = {}) {
  try {
    return {
      stateDir: readStateDirectory(environment, homeDir),
      port: readPort(environment),
      browserAdapter: readBrowserAdapter(environment),
      modelProvider: readModelProviderConfig(environment),
    };
  } catch (error) {
    if (error instanceof RuntimeConfigurationError) throw error;
    throw new RuntimeConfigurationError(error.message);
  }
}

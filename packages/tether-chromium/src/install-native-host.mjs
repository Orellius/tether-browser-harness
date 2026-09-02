#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadOrCreateToken } from "../../tether-runtime/src/local-auth-token.js";
import { readRuntimeConfig } from "../../tether-runtime/src/runtime-config.js";

const NATIVE_HOST_NAME = "com.tether.browser_harness";
const here = path.dirname(fileURLToPath(import.meta.url));
const chromiumPackageDir = path.dirname(here);
const packagesDir = path.dirname(chromiumPackageDir);

function quoted(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertNotSymlink(target, label) {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Refusing symlink ${label}: ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function extensionId(extensionDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
  const key = Buffer.from(manifest.key || "", "base64");
  crypto.createPublicKey({ key, type: "spki", format: "der" });
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, (hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)));
}

function nativeManifestDirectory(environment) {
  const requested = environment.TETHER_NATIVE_HOST_DIR
    || path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts");
  if (!path.isAbsolute(requested)) throw new Error("TETHER_NATIVE_HOST_DIR must be an absolute path");
  return path.resolve(requested);
}

function copyRuntime(sourcePackagesDir, runtimePackagesDir) {
  fs.mkdirSync(runtimePackagesDir, { recursive: true, mode: 0o700 });
  for (const name of ["tether-core", "tether-runtime", "tether-mcp", "tether-chromium"]) {
    const source = path.join(sourcePackagesDir, name);
    const destination = path.join(runtimePackagesDir, name);
    assertNotSymlink(destination, "runtime package directory");
    fs.cpSync(source, destination, { recursive: true, force: true, dereference: false });
  }
}

export function buildInstallPlan(environment = process.env) {
  if (process.platform !== "darwin") throw new Error("Tether native-host installation currently targets Chromium browsers on macOS only");
  const config = readRuntimeConfig(environment);
  const sourceExtensionDir = path.join(chromiumPackageDir, "extension");
  const runtimeDir = path.join(config.stateDir, "runtime");
  const runtimePackagesDir = path.join(runtimeDir, "packages");
  const runtimeExtensionDir = path.join(runtimeDir, "extension");
  const nativeDir = nativeManifestDirectory(environment);
  const nativeManifest = path.join(nativeDir, `${NATIVE_HOST_NAME}.json`);
  const wrapper = path.join(runtimeDir, "native-host-wrapper.sh");
  const mcpServer = path.join(runtimePackagesDir, "tether-mcp", "src", "server.js");
  const id = extensionId(sourceExtensionDir);
  return {
    extensionName: "Tether Browser Harness",
    extensionId: id,
    stateDir: config.stateDir,
    runtimeDir,
    runtimeExtensionDir,
    nativeManifest,
    wrapper,
    port: config.port,
    stdioMcp: {
      command: process.execPath,
      args: [mcpServer],
      env: {
        TETHER_HOME: config.stateDir,
        TETHER_CHROMIUM_EXTENSION_DIR: runtimeExtensionDir,
        TETHER_CHROMIUM_PATH: "/absolute/path/to/Chromium-or-Brave",
      },
    },
    codexCommand: [
      "codex", "mcp", "add", "tether-browser", "--env", `TETHER_HOME=${config.stateDir}`,
      "--env", `TETHER_CHROMIUM_EXTENSION_DIR=${runtimeExtensionDir}`,
      "--env", "TETHER_CHROMIUM_PATH=/absolute/path/to/Chromium-or-Brave",
      "--", process.execPath, mcpServer,
    ],
    browserStep: "The extension is loaded automatically only when Tether starts its fresh Chromium profile.",
  };
}

export function applyInstallPlan(plan, environment = process.env) {
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Tether Browser Harness isolated Chromium bridge",
    path: plan.wrapper,
    type: "stdio",
    allowed_origins: [`chrome-extension://${plan.extensionId}/`],
  };
  for (const target of [plan.stateDir, plan.runtimeDir, plan.nativeManifest, plan.wrapper]) {
    assertNotSymlink(target, "installation target");
  }
  if (fs.existsSync(plan.nativeManifest)) {
    const existing = JSON.parse(fs.readFileSync(plan.nativeManifest, "utf8"));
    if (existing.name !== manifest.name || existing.path !== manifest.path
      || JSON.stringify(existing.allowed_origins) !== JSON.stringify(manifest.allowed_origins)) {
      throw new Error("Existing Tether native manifest differs; review it before changing its identity or target");
    }
  }

  loadOrCreateToken({ stateDir: plan.stateDir });
  fs.mkdirSync(plan.runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(plan.runtimeDir, 0o700);
  copyRuntime(packagesDir, path.join(plan.runtimeDir, "packages"));
  assertNotSymlink(plan.runtimeExtensionDir, "runtime extension directory");
  fs.cpSync(path.join(chromiumPackageDir, "extension"), plan.runtimeExtensionDir, { recursive: true, force: true, dereference: false });

  const wrapper = `#!/bin/sh\nset -eu\nexport TETHER_HOME=${quoted(plan.stateDir)}\nexport TETHER_PORT=${quoted(String(plan.port))}\nexec ${quoted(process.execPath)} ${quoted(path.join(plan.runtimeDir, "packages", "tether-chromium", "src", "native-host.js"))} "$@"\n`;
  fs.writeFileSync(plan.wrapper, wrapper, { mode: 0o700 });
  fs.chmodSync(plan.wrapper, 0o700);
  fs.mkdirSync(path.dirname(plan.nativeManifest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(plan.nativeManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(plan.nativeManifest, 0o600);
  fs.writeFileSync(path.join(plan.stateDir, "installation.json"), `${JSON.stringify({ ...plan, installedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  return { ...plan, installed: true, browserConnected: "not checked" };
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--apply")) throw new Error("Usage: tether-native-host-install [--apply]");
  const plan = buildInstallPlan();
  if (!args.includes("--apply")) {
    process.stdout.write(`${JSON.stringify({ ...plan, apply: false }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ ...applyInstallPlan(plan), apply: true }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Tether installation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

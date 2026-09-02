import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn as spawnChild } from "node:child_process";

const SESSION_FILE = "browser-session.json";
const LAUNCH_LOCK_FILE = "browser-session.launch.lock";
const TOKEN_RE = /^[a-f0-9]{64}$/;

function assertInsideStateDir(stateDir, target, label) {
  const relative = path.relative(stateDir, target);
  if (relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) return;
  throw new Error(`${label} must stay inside TETHER_HOME`);
}

function ensureDirectory(directory) {
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Refusing symlink directory: ${directory}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(directory, 0o700);
}

function sessionPath(stateDir) {
  return path.join(stateDir, SESSION_FILE);
}

function lockPath(stateDir) {
  return path.join(stateDir, LAUNCH_LOCK_FILE);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function extensionId(extensionDir) {
  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const key = Buffer.from(manifest.key || "", "base64");
  crypto.createPublicKey({ key, type: "spki", format: "der" });
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, (hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)));
}

function acquireLaunchLock(stateDir) {
  ensureDirectory(stateDir);
  const file = lockPath(stateDir);
  try {
    const descriptor = fs.openSync(file, "wx", 0o600);
    return () => {
      try { fs.closeSync(descriptor); } catch {}
      try { fs.unlinkSync(file); } catch {}
    };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Refusing symlink launch lock");
    if (Date.now() - fs.statSync(file).mtimeMs > 30_000) {
      fs.unlinkSync(file);
      return acquireLaunchLock(stateDir);
    }
    throw new Error("A Tether isolated-browser launch is already in progress");
  }
}

function writeBrowserSession(record, stateDir) {
  ensureDirectory(stateDir);
  const file = sessionPath(stateDir);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function removeBrowserSession(stateDir) {
  const file = sessionPath(stateDir);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Tether browser session file must not be a symlink");
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function readBrowserSession({ stateDir } = {}) {
  if (!path.isAbsolute(stateDir || "")) throw new Error("stateDir must be an absolute path");
  const file = sessionPath(stateDir);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Tether browser session file must not be a symlink");
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)
      || !Number.isInteger(record.pid) || record.pid <= 0
      || typeof record.profileDir !== "string" || !/^[a-f0-9]{64}$/.test(record.tokenHash)) {
      throw new Error("Tether browser session file is malformed");
    }
    assertInsideStateDir(stateDir, path.resolve(record.profileDir), "Tether browser profile");
    return record;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function browserSessionStatus({ stateDir, isAlive = isPidAlive } = {}) {
  const record = readBrowserSession({ stateDir });
  if (!record) return { managed: false, active: false };
  return {
    managed: true,
    active: Boolean(isAlive(record.pid)),
    pid: record.pid,
    profileDir: record.profileDir,
    startedAt: record.startedAt,
  };
}

export function profileTokenMatches(token, { stateDir, isAlive = isPidAlive } = {}) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return false;
  const record = readBrowserSession({ stateDir });
  if (!record || !isAlive(record.pid)) return false;
  const expected = Buffer.from(record.tokenHash, "hex");
  const supplied = Buffer.from(tokenHash(token), "hex");
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

export function startIsolatedBrowser({
  stateDir,
  browserPath,
  extensionDir,
  spawnProcess = spawnChild,
  isAlive = isPidAlive,
  validateExecutable = true,
} = {}) {
  if (!path.isAbsolute(stateDir || "")) throw new Error("stateDir must be an absolute path");
  if (!path.isAbsolute(browserPath || "")) throw new Error("browserPath must be an absolute executable path");
  if (!path.isAbsolute(extensionDir || "")) throw new Error("extensionDir must be an absolute path");
  const releaseLock = acquireLaunchLock(stateDir);
  try {
    const existing = readBrowserSession({ stateDir });
    if (existing && isAlive(existing.pid)) {
      return { started: false, existing: true, pid: existing.pid, profileDir: existing.profileDir };
    }
    if (existing) removeBrowserSession(stateDir);
    if (validateExecutable) {
      const stat = fs.statSync(browserPath);
      if (!stat.isFile() || !(stat.mode & 0o111)) throw new Error("browserPath must point to a runnable executable");
    }
    try {
      if (!fs.statSync(path.join(extensionDir, "manifest.json")).isFile()) throw new Error("Tether extension manifest is missing");
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("Tether extension manifest is missing");
      throw error;
    }

    ensureDirectory(stateDir);
    const profileDir = path.join(stateDir, "chromium-profile");
    ensureDirectory(profileDir);
    const token = crypto.randomBytes(32).toString("hex");
    const id = extensionId(extensionDir);
    const bootstrapUrl = `chrome-extension://${id}/bootstrap.html#${token}`;
    const child = spawnProcess(browserPath, [
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-mode",
      `--load-extension=${extensionDir}`,
      "--new-window",
      bootstrapUrl,
    ], { detached: true, stdio: "ignore" });
    if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error("Tether browser launcher did not return a process id");
    child.unref?.();
    const record = {
      version: 1,
      pid: child.pid,
      profileDir,
      browserPath,
      extensionId: id,
      tokenHash: tokenHash(token),
      startedAt: new Date().toISOString(),
    };
    writeBrowserSession(record, stateDir);
    child.once?.("error", () => {
      try {
        const current = readBrowserSession({ stateDir });
        if (current?.pid === child.pid) removeBrowserSession(stateDir);
      } catch {}
    });
    return { started: true, existing: false, pid: child.pid, profileDir, extensionId: id };
  } finally {
    releaseLock();
  }
}

export function stopIsolatedBrowser({ stateDir, signal = "SIGTERM", isAlive = isPidAlive, killProcess = process.kill } = {}) {
  const record = readBrowserSession({ stateDir });
  if (!record) return { stopped: false, reason: "No managed Tether browser session exists." };
  if (!isAlive(record.pid)) {
    removeBrowserSession(stateDir);
    return { stopped: false, reason: "The recorded Tether browser process is already stopped." };
  }
  killProcess(record.pid, signal);
  removeBrowserSession(stateDir);
  return { stopped: true, pid: record.pid, signal };
}

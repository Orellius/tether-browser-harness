import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TOKEN_RE = /^[a-f0-9]{64}$/;

function ensureStateDirectory(stateDir) {
  if (!path.isAbsolute(stateDir || "")) throw new Error("stateDir must be an absolute path");
  try {
    if (fs.lstatSync(stateDir).isSymbolicLink()) throw new Error("Tether state directory must not be a symlink");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(stateDir, 0o700);
}

function configPath(stateDir) {
  return path.join(stateDir, "config.json");
}

function readConfig(stateDir) {
  const file = configPath(stateDir);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Tether config file must not be a symlink");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Tether config must be a JSON object");
    return config;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function tokensMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function loadOrCreateToken({ stateDir } = {}) {
  ensureStateDirectory(stateDir);
  const existing = readConfig(stateDir);
  if (existing) {
    if (!TOKEN_RE.test(existing.token || "")) throw new Error("Tether config has no valid local token; refusing to replace it");
    return existing.token;
  }
  const token = crypto.randomBytes(32).toString("hex");
  const file = configPath(stateDir);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return token;
}

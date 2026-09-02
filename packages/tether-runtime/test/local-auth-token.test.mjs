import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadOrCreateToken, tokensMatch } from "../src/local-auth-token.js";

test("a Tether local token is private, persistent, and constant-time comparable", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tether-token-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const first = loadOrCreateToken({ stateDir });
  const second = loadOrCreateToken({ stateDir });
  const configPath = path.join(stateDir, "config.json");
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(second, first);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.equal(tokensMatch(first, second), true);
  assert.equal(tokensMatch(first, "a".repeat(64)), false);
  assert.equal(tokensMatch(first, "invalid"), false);
});

test("a symlinked Tether token file is refused without being followed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tether-token-symlink-"));
  const stateDir = path.join(root, "state");
  const target = path.join(root, "target.json");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(target, '{"token":"sentinel"}');
  fs.symlinkSync(target, path.join(stateDir, "config.json"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => loadOrCreateToken({ stateDir }), /must not be a symlink/);
  assert.equal(fs.readFileSync(target, "utf8"), '{"token":"sentinel"}');
});

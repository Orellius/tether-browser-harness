import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeConfigurationError, readRuntimeConfig } from "../src/runtime-config.js";

test("runtime defaults to an independent Tether state and no model provider", () => {
  const config = readRuntimeConfig({}, { homeDir: "/Users/tester" });
  assert.deepEqual(config, {
    stateDir: "/Users/tester/.tether-browser-harness",
    port: 18768,
    browserAdapter: "chromium",
    modelProvider: { kind: "none" },
  });
});

test("runtime accepts an explicit local OpenAI-compatible provider", () => {
  const config = readRuntimeConfig({
    TETHER_HOME: "/tmp/tether-state",
    TETHER_PORT: "19100",
    TETHER_BROWSER_ADAPTER: "chromium",
    TETHER_MODEL_PROVIDER: "openai-compatible",
    TETHER_MODEL: "qwen3",
    TETHER_MODEL_BASE_URL: "http://127.0.0.1:11434/v1",
  }, { homeDir: "/Users/tester" });
  assert.deepEqual(config, {
    stateDir: "/tmp/tether-state",
    port: 19100,
    browserAdapter: "chromium",
    modelProvider: {
      kind: "openai-compatible",
      model: "qwen3",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: undefined,
    },
  });
});

test("runtime refuses reserved legacy state, legacy ports, and unknown adapters", () => {
  const reservedLegacyState = Buffer.from("Lm9pYy1jb2RleA==", "base64").toString("utf8");
  assert.throws(
    () => readRuntimeConfig({ TETHER_HOME: `/Users/tester/${reservedLegacyState}` }, { homeDir: "/Users/tester" }),
    RuntimeConfigurationError,
  );
  assert.throws(
    () => readRuntimeConfig({ TETHER_PORT: "18767" }, { homeDir: "/Users/tester" }),
    RuntimeConfigurationError,
  );
  assert.throws(
    () => readRuntimeConfig({ TETHER_BROWSER_ADAPTER: "brave" }, { homeDir: "/Users/tester" }),
    RuntimeConfigurationError,
  );
});

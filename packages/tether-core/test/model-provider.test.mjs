import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelProviderConfigurationError,
  ModelProviderUnavailableError,
  createModelProvider,
  readModelProviderConfig,
} from "../src/model-provider.js";

const INPUT = {
  system: "Return a JSON object.",
  messages: [{ role: "user", content: "Return {\\\"ready\\\":true}." }],
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { ready: { type: "boolean" } },
    required: ["ready"],
  },
};

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("no provider fails closed without contacting a model endpoint", async () => {
  let requests = 0;
  const provider = createModelProvider({ kind: "none" }, {
    fetchImpl: async () => { requests += 1; throw new Error("must not fetch"); },
  });

  await assert.rejects(provider.completeJson(INPUT), ModelProviderUnavailableError);
  assert.equal(requests, 0);
});

test("Anthropic adapter exposes the neutral completeJson result", async () => {
  let request;
  const provider = createModelProvider({
    kind: "anthropic",
    model: "claude-test",
    apiKey: "test-secret",
  }, {
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse({
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 7 },
        content: [{ type: "text", text: '{"ready":true}' }],
      });
    },
  });

  const result = await provider.completeJson(INPUT);
  assert.deepEqual(result, {
    value: { ready: true },
    usage: { inputTokens: 12, outputTokens: 7 },
    stopReason: "end_turn",
  });
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.init.headers["x-api-key"], "test-secret");
  assert.equal(request.init.redirect, "error");
  assert.equal(JSON.parse(request.init.body).model, "claude-test");
});

test("OpenAI-compatible adapter works with a keyless local endpoint", async () => {
  let request;
  const provider = createModelProvider({
    kind: "openai-compatible",
    model: "local-model",
    baseUrl: "http://127.0.0.1:11434/v1",
  }, {
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: '{"ready":true}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      });
    },
  });

  const result = await provider.completeJson(INPUT);
  assert.deepEqual(result, {
    value: { ready: true },
    usage: { inputTokens: 5, outputTokens: 3 },
    stopReason: "stop",
  });
  assert.equal(request.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal("authorization" in request.init.headers, false);
  assert.equal(JSON.parse(request.init.body).response_format.type, "json_schema");
});

test("invalid provider configurations are refused before an outbound request", () => {
  assert.throws(
    () => createModelProvider({ kind: "anthropic", model: "claude-test" }),
    ModelProviderConfigurationError,
  );
  assert.throws(
    () => createModelProvider({ kind: "openai-compatible", model: "local", baseUrl: "file:///tmp/model" }),
    ModelProviderConfigurationError,
  );
  assert.throws(
    () => createModelProvider({ kind: "openai-compatible", model: "local", baseUrl: "https://user:secret@example.com" }),
    ModelProviderConfigurationError,
  );
});

test("environment configuration has no provider default and accepts explicit local configuration", () => {
  assert.deepEqual(readModelProviderConfig({}), { kind: "none" });
  assert.deepEqual(readModelProviderConfig({
    TETHER_MODEL_PROVIDER: "openai-compatible",
    TETHER_MODEL: "qwen-local",
    TETHER_MODEL_BASE_URL: "http://127.0.0.1:1234/v1",
  }), {
    kind: "openai-compatible",
    model: "qwen-local",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: undefined,
  });
});

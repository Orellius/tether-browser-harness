const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 24_000;

export class ModelProviderConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelProviderConfigurationError";
  }
}

export class ModelProviderUnavailableError extends Error {
  constructor(message = "No Tether model provider is configured.") {
    super(message);
    this.name = "ModelProviderUnavailableError";
  }
}

function requireText(value, name, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new ModelProviderConfigurationError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function normaliseBaseUrl(value) {
  const baseUrl = requireText(value, "baseUrl");
  let url;
  try {
    url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    throw new ModelProviderConfigurationError("baseUrl must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ModelProviderConfigurationError("baseUrl must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new ModelProviderConfigurationError("baseUrl must not embed credentials");
  }
  return url.toString();
}

function normaliseMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    throw new ModelProviderConfigurationError(`messages must contain 1 through ${MAX_MESSAGES} items`);
  }
  return messages.map((message, index) => {
    if (!message || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") {
      throw new ModelProviderConfigurationError(`messages[${index}] must have a user or assistant role and string content`);
    }
    if (message.content.length > MAX_MESSAGE_CHARS) {
      throw new ModelProviderConfigurationError(`messages[${index}] content exceeds ${MAX_MESSAGE_CHARS} characters`);
    }
    return { role: message.role, content: message.content };
  });
}

function validateInput(input) {
  if (!input || typeof input !== "object") throw new ModelProviderConfigurationError("completion input must be an object");
  const model = input.model === undefined ? undefined : requireText(input.model, "model");
  const system = input.system === undefined ? undefined : requireText(input.system, "system", { optional: true });
  if (input.schema && typeof input.schema !== "object") throw new ModelProviderConfigurationError("schema must be an object");
  if (input.maxTokens !== undefined && (!Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 32_768)) {
    throw new ModelProviderConfigurationError("maxTokens must be an integer from 1 through 32768");
  }
  return {
    model,
    system,
    messages: normaliseMessages(input.messages),
    schema: input.schema,
    maxTokens: input.maxTokens ?? 1024,
  };
}

function validateJson(value, schema, location = "$") {
  if (!schema || typeof schema !== "object") return [];
  const errors = [];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const matches = types.some((wanted) => (wanted === "integer" ? Number.isInteger(value) : wanted === type));
    if (!matches) return [`${location}: expected ${types.join("|")}, got ${type}`];
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) return [`${location}: does not match const`];
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) return [`${location}: is not an allowed value`];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${location}.${key}: is required`);
    const properties = schema.properties || {};
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in value) errors.push(...validateJson(value[key], subSchema, `${location}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) errors.push(`${location}.${key}: is not allowed`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((entry, index) => errors.push(...validateJson(entry, schema.items, `${location}[${index}]`)));
  return errors;
}

function parseStructuredText(text, schema) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Model response did not contain JSON text");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Model response is not valid JSON: ${error.message}`);
  }
  const errors = validateJson(value, schema);
  if (errors.length) throw new Error(`Model response does not match the requested schema: ${errors.join("; ")}`);
  return value;
}

async function readJson(response, providerName) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.error?.message || body?.error || `HTTP ${response.status}`;
    throw new Error(`${providerName} request failed: ${detail}`);
  }
  return body;
}

function createCompletionRequest(url, headers, body, { fetchImpl, timeoutMs }) {
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`Model provider request timed out after ${timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

function noProvider() {
  return Object.freeze({
    kind: "none",
    async completeJson() { throw new ModelProviderUnavailableError(); },
  });
}

function anthropicProvider(config, { fetchImpl, timeoutMs }) {
  const model = requireText(config.model, "model");
  const apiKey = requireText(config.apiKey, "apiKey");
  return Object.freeze({
    kind: "anthropic",
    async completeJson(input) {
      const request = validateInput(input);
      const body = await readJson(await createCompletionRequest(ANTHROPIC_MESSAGES_URL, {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      }, {
        model: request.model || model,
        max_tokens: request.maxTokens,
        ...(request.system ? { system: request.system } : {}),
        output_config: request.schema ? { format: { type: "json_schema", schema: request.schema } } : undefined,
        messages: request.messages,
      }, { fetchImpl, timeoutMs })(), "Anthropic");
      const text = body?.content?.find((block) => block?.type === "text")?.text;
      return {
        value: parseStructuredText(text, request.schema),
        usage: { inputTokens: Number(body?.usage?.input_tokens) || 0, outputTokens: Number(body?.usage?.output_tokens) || 0 },
        stopReason: body?.stop_reason || "unknown",
      };
    },
  });
}

function openAiCompatibleProvider(config, { fetchImpl, timeoutMs }) {
  const model = requireText(config.model, "model");
  const baseUrl = normaliseBaseUrl(config.baseUrl);
  const apiKey = requireText(config.apiKey, "apiKey", { optional: true });
  const endpoint = new URL("chat/completions", baseUrl).toString();
  return Object.freeze({
    kind: "openai-compatible",
    async completeJson(input) {
      const request = validateInput(input);
      const body = await readJson(await createCompletionRequest(endpoint, {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      }, {
        model: request.model || model,
        max_tokens: request.maxTokens,
        ...(request.schema ? { response_format: { type: "json_schema", json_schema: { name: "tether_response", strict: true, schema: request.schema } } } : {}),
        messages: [
          ...(request.system ? [{ role: "system", content: request.system }] : []),
          ...request.messages,
        ],
      }, { fetchImpl, timeoutMs })(), "OpenAI-compatible provider");
      const choice = body?.choices?.[0];
      const text = choice?.message?.content;
      return {
        value: parseStructuredText(text, request.schema),
        usage: { inputTokens: Number(body?.usage?.prompt_tokens) || 0, outputTokens: Number(body?.usage?.completion_tokens) || 0 },
        stopReason: choice?.finish_reason || "unknown",
      };
    },
  });
}

export function createModelProvider(config = { kind: "none" }, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new ModelProviderConfigurationError("fetchImpl must be a function");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new ModelProviderConfigurationError("timeoutMs must be an integer from 1 through 300000");
  const kind = config?.kind || "none";
  if (kind === "none") return noProvider();
  if (kind === "anthropic") return anthropicProvider(config, { fetchImpl, timeoutMs });
  if (kind === "openai-compatible") return openAiCompatibleProvider(config, { fetchImpl, timeoutMs });
  throw new ModelProviderConfigurationError(`Unsupported model provider: ${kind}`);
}

export function readModelProviderConfig(environment = process.env) {
  const kind = environment.TETHER_MODEL_PROVIDER || "none";
  if (kind === "none") return { kind: "none" };
  if (kind !== "anthropic" && kind !== "openai-compatible") {
    throw new ModelProviderConfigurationError("TETHER_MODEL_PROVIDER must be none, anthropic or openai-compatible");
  }
  return {
    kind,
    model: environment.TETHER_MODEL,
    ...(kind === "openai-compatible" ? { baseUrl: environment.TETHER_MODEL_BASE_URL } : {}),
    apiKey: environment.TETHER_MODEL_API_KEY,
  };
}

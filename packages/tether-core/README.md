# Tether Browser Harness Core

Provider-neutral modules for the future Tether Browser Harness package.

`model-provider.js` has one interface: `completeJson({ system, messages, schema,
maxTokens })`. It returns a normalised structured result independently of the
selected model provider. The current adapters are:

- `anthropic`, with an explicitly supplied API key.
- `openai-compatible`, including keyless local servers such as Ollama, vLLM and
  LM Studio when they expose the compatible chat-completions surface.
- `none`, the default. It fails closed and makes no outbound request.

Provider configuration is explicit:

```text
TETHER_MODEL_PROVIDER=openai-compatible
TETHER_MODEL=qwen-local
TETHER_MODEL_BASE_URL=http://127.0.0.1:11434/v1
```

No provider is configured by default. This package does not launch a browser,
register an MCP server, read another local bridge configuration, or access a
browser profile.

Run the offline tests with `npm test`.

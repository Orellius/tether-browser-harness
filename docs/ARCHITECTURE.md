# Architecture

```text
MCP client
  | stdio JSON-RPC
  v
Tether MCP server -- authenticated loopback TCP -- native host
  |                                                | Chrome native messaging
  |                                                v
  +------------------------------------------- Tether extension
                                                     | tabs and explicit page read
                                                     v
                                           fresh isolated Chromium profile
```

The model provider is outside this path. Tether starts with no provider and no
outbound model connection. Any MCP-capable client, including local model
runners, can use the browser tools through standard stdio MCP.

The browser session opens a Session Console tab and activates the extension's
operator indicator. Browser control ends through either MCP lifecycle tools or
the user's explicit extension action.

# Tether MCP

`tether-mcp` is the provider-neutral stdio MCP entrypoint for Tether Browser
Harness. It contacts no model provider at startup. When both variables below
are explicitly configured, its session tools can launch exactly one isolated
Chromium process and later stop only that recorded process:

```text
TETHER_CHROMIUM_PATH=/absolute/path/to/chromium
TETHER_CHROMIUM_EXTENSION_DIR=/absolute/path/to/tether-extension
```

Without both variables, the adapter remains unconfigured and session start is
refused. Tether does not search for a browser process, adopt a browser profile,
or touch ordinary browser tabs.

The server speaks standard JSON-RPC over stdio and is usable from any
MCP-capable client, independent of the model or provider behind that client.

## Browser tools

After the isolated Chromium adapter and its native host are installed, Tether
exposes these tools:

- `tether_session_start` and `tether_session_status`
- `tether_tabs_create`, `tether_navigate`, `tether_page_read`, and
  `tether_tabs_close`
- `tether_session_end`, which asks the extension to close every Tether-owned
  tab and then stops only Tether's recorded browser process

`tether_page_read` returns at most 30,000 characters of visible page text. It
does not install a persistent page script. `tether_navigate` accepts only
`http` and `https` URLs, and every browser tool other than session lifecycle
is limited to tab IDs created by Tether in its isolated profile.

## Local setup

Preview the native-host plan first:

```sh
node packages/tether-chromium/src/install-native-host.mjs
```

The preview prints the isolated state directory, native-host manifest, copied
extension directory, and an MCP command. Applying the plan writes only Tether's
own runtime and native-host manifest. It never registers an MCP client, reloads
an extension, launches a browser, or touches an ordinary Chromium profile:

```sh
node packages/tether-chromium/src/install-native-host.mjs --apply
```

Then register the printed command with the MCP client of your choice. Tether
loads its copied extension automatically when it launches its fresh Chromium
profile. It does not load the extension into the user's ordinary browser.

## Any MCP client

The installer prints a `stdioMcp` object containing the portable connection
shape: `command`, `args`, and `env`. Add that object to any client that supports
local stdio MCP servers, including provider-neutral desktop clients and local
agent runners. The only machine-specific value is `TETHER_CHROMIUM_PATH`, which
must be set to that user's chosen Chromium or Brave executable.

For Codex, the preview also prints a ready `codex mcp add` command. Other MCP
clients use the same `stdioMcp` values in their own configuration format. No
model API key is required for normal browser control.

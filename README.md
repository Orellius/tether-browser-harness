# Tether Browser Harness

**A local, provider-neutral MCP bridge for one visible, isolated Chromium session.**

Tether gives any MCP-capable client a narrow browser-control surface without
adopting the user's everyday browser, tabs, cookies, or profile. It began as a
private project and is being released as open-source software.

<img src="packages/tether-chromium/extension/icons/tether-mark.svg" width="112" alt="Tether extension mark">

## What the operator sees

Every live Tether session opens a dedicated browser profile with a persistent
Session Console tab. The extension action changes to a blue-violet `LIVE` badge and
its popup identifies the active isolated profile and offers **End isolated
session**. The button closes only Tether-owned tabs and asks the local bridge to
stop the exact browser process it started.

Pin the extension in Chromium's toolbar if you want the `LIVE` indicator to be
continuously visible. Chromium does not let an extension pin itself.

## Security boundary

- A fresh browser profile lives under `TETHER_HOME`; personal profiles are not
  searched, opened, or reused.
- Tether records one browser PID and stops only that PID.
- The local native bridge requires both a private local token and a one-time
  profile proof before it relays tools.
- Tabs must be created by Tether before they can be navigated, read, or closed.
- Page text is injected only after `tether_page_read`, is capped at 30,000
  characters, and navigation accepts only `http` and `https` URLs.
- The extension's `<all_urls>` permission is required by Chromium to allow that
  explicit, owned-tab text read. Tether has no persistent content scripts.

Read [SECURITY.md](SECURITY.md) for scope and reporting details.

## Install on macOS

Requirements: Node.js 20 or later and a Chromium-based browser such as Chromium
or Brave. The current native-host installer is macOS-only.

```sh
git clone https://github.com/<your-account>/tether-browser-harness.git
cd tether-browser-harness
node scripts/install.mjs
node scripts/install.mjs --apply
```

The first command is a no-write preview. The apply command writes only the
Tether state directory, its copied runtime, and its own Chrome native-messaging
manifest. It does not start a browser or register an MCP client.

Copy the printed `stdioMcp` object into the configuration of any MCP client.
For Codex, use the printed `codex mcp add` command after replacing the browser
path with your Chromium or Brave executable. When a client calls
`tether_session_start`, Tether launches its fresh profile and loads its own
extension automatically.

## MCP tools

| Tool | Effect |
| --- | --- |
| `tether_runtime_status` | Shows local adapter and provider configuration. |
| `tether_session_status` | Shows the isolated-session state. |
| `tether_session_start` / `tether_session_stop` | Start or stop only Tether's recorded browser. |
| `tether_tabs_create` | Creates a Tether-owned tab. |
| `tether_navigate` | Navigates an owned tab to an `http` or `https` URL. |
| `tether_page_read` | Reads bounded visible text from an owned tab on request. |
| `tether_tabs_close` | Closes one owned tab. |
| `tether_session_end` | Closes all owned tabs and stops the recorded process. |

## Development

No package install is required for the current test suite.

```sh
node --test packages/tether-core/test/*.test.mjs packages/tether-runtime/test/*.test.mjs packages/tether-mcp/test/*.test.mjs packages/tether-chromium/test/*.test.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/DESIGN.md](docs/DESIGN.md), and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

# Tether Chromium Adapter

This adapter owns only the Chromium process it launches. It requires an
explicit browser executable and extension directory, creates a fresh profile
inside `TETHER_HOME`, records one PID, and stops only that recorded PID.

It does not scan for browser processes, adopt an existing profile, inspect
personal tabs, or launch a browser at module import.

The companion extension connects only to the native host
`com.tether.browser_harness`. That host is pinned by Chrome's native-messaging
manifest to the extension's stable ID, and the host must prove both Tether's
private local token and the fresh profile bootstrap token before it can relay a
tool request.

The extension needs `nativeMessaging`, `tabs`, `scripting`, and `<all_urls>`.
The broad host permission exists so Chromium permits a requested script on the
site opened inside Tether's isolated profile. Tether does not declare content
scripts. It injects a short visible-text reader only after an explicit
`tether_page_read` request, only on a tab ID that Tether created, and returns at
most 30,000 characters. Navigation is limited to `http` and `https` URLs.

Install with a preview first:

```sh
node packages/tether-chromium/src/install-native-host.mjs
node packages/tether-chromium/src/install-native-host.mjs --apply
```

The apply step creates Tether's own local runtime and native-host registration.
Register the printed MCP command with the client of your choice. The extension
is loaded automatically only into the fresh browser process Tether starts; it
is never installed into an ordinary browser profile.

When that profile is active, its Session Console remains open, the toolbar
action shows `LIVE`, and the popup offers an explicit operator-owned end action.
Pinning the toolbar action is a user-controlled browser setting.

The installer prints a provider-neutral `stdioMcp` object with `command`,
`args`, and `env`. Any client supporting local stdio MCP can use those values;
only the chosen Chromium executable path differs between machines.

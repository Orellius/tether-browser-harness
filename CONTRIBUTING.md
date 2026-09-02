# Contributing

Tether's primary invariant is simple: a local client can act only inside a
fresh, visible browser session that Tether itself owns.

Run the complete offline suite before proposing a change:

```sh
npm test
```

Tests use temporary state directories, fake Chromium processes, and temporary
loopback ports. Do not run `npm run install:apply` as part of automated tests or
continuous integration because it writes a real native-host manifest.

Changes affecting the extension must preserve these guarantees:

- external extension callers remain denied;
- the native bridge stays profile-proven and loopback-only;
- browser actions remain limited to Tether-owned tabs;
- operator-visible state stays accurate and the explicit end action continues
  to stop only the exact recorded process.

Keep issues and examples free of personal browser profiles, tokens, account
data, and absolute user paths.

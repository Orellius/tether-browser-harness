# Security policy

## Supported scope

Tether `0.1.x` is a local macOS Chromium adapter. It is intentionally not a
remote browser-control service and does not expose a network listener beyond
loopback on `127.0.0.1`.

## Trust boundary

Tether is permitted to control only a Chromium process it started in its fresh
profile. It must not inspect, adopt, or terminate an ordinary browser process,
profile, or tab. Its native host accepts a connection only from its pinned
extension identity after two local proofs: the private token stored in the
Tether state directory and a one-time token embedded in the fresh-profile
bootstrap page.

The extension declares broad site access solely so Chromium allows a requested
text reader in a Tether-owned tab. It declares no persistent content scripts.

## Reporting a vulnerability

Do not publish a proof of concept containing credentials, local paths, browser
profiles, or session data. Open a private GitHub security advisory for this
repository, including the version, a minimal reproduction, impact, and a safe
way to contact you for follow-up.

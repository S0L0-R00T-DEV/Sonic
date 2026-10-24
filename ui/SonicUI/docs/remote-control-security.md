# Remote Control API and Companion — F-16 / F-17

## Status

Implemented in the active SonicUI application. Remote access is **off by default**. Normal app startup never starts the LAN listener. The user must explicitly enable it in **Settings → Local Wi-Fi remote control**, or explicitly launch a previously configured instance with `--headless --remote-control`.

## Network boundary

- The listener binds to one selected Wi-Fi interface's private IPv4 address on TCP port **47831**. It does not bind to `0.0.0.0`, public addresses, Ethernet, USB, bridges or IPv6.
- Each request's peer IPv4 address must be in the selected Wi-Fi interface's subnet. A request from another subnet is rejected. The HTTP Host and browser Origin are also checked against the selected local IP and port.
- There is no cloud relay, external service, public listener, router configuration, port-forwarding setup, remote shell or arbitrary filesystem endpoint.
- The same-subnet check is a network boundary, not a substitute for authentication: all API routes except one-time pairing require a valid paired-device token and the relevant scope.
- Headless remote service requires **both** `--headless` and `--remote-control`, plus a saved Wi-Fi selection, an installed/trusted Sonic CA certificate and at least one active paired phone. Startup fails closed otherwise. `--headless` alone does not enable remote access.

## TLS identity and storage

- TLS 1.2 or later is mandatory; there is no plaintext fallback.
- Sonic creates a local CA and a short-lived server certificate with the selected Wi-Fi IP in its IP Subject Alternative Name. The CA certificate's SHA-256 fingerprint is shown in desktop Settings.
- The CA private key and remote-control configuration are encrypted using Electron `safeStorage`; remote control refuses to start when OS-protected storage is unavailable or Linux reports the `basic_text` backend.
- Export the public `.crt` from desktop Settings, transfer it to the phone by USB, and install it as a user CA certificate before opening the HTTPS URL. Do not install certificates from other sources. This establishes browser TLS trust; the companion does not ask the user to accept an arbitrary invalid certificate.
- Device tokens are 256-bit random values with a 24-hour expiry. Expired and revoked credentials fail authentication and authorization. Only SHA-256 token hashes are stored. Raw tokens are returned only during successful pairing and are never written to Sonic's config or logs.

## Pairing, permissions and endpoints

A pairing code is generated only from the desktop UI. It is six digits, expires after three minutes, is single-use, and has a five-attempt cap. Device permissions are selected before generating the code:

- `status:read` — task name, status, progress, total bytes and speed only. Source URLs, local paths and recovery details are not exposed.
- `task:add` — add credential-free HTTP(S) URLs or magnet links through Sonic's existing URL/protocol/destination validation.
- `task:control` — pause, resume or cancel a known task.

All mutating API requests require an `Idempotency-Key`; duplicate concurrent requests with the same key share the same result, and reusing a key for a different operation is rejected. Request bodies, connection count, request timeouts, per-peer request rate, pairing attempts and idempotency entries are bounded. Errors sent to the phone are sanitized. The mobile UI uses same-origin requests and has no external scripts or CDN dependencies.

Paired devices can be revoked in desktop Settings. Revocation takes effect on the next request. The desktop UI shows the last ten session audit events; the bounded in-memory audit log records event names and device IDs only, not URLs, tokens, paths or request bodies.

## Companion client — F-17

The responsive phone companion is served by the same local HTTPS listener. It supports pairing, task status/progress, adding HTTP(S)/magnet links, and pause/resume/cancel. The bearer token is retained in that browser's origin-scoped local storage so a refresh does not require re-pairing; if a phone is lost, revoke its device from Sonic on the desktop. No third-party scripts, analytics or cloud endpoints are used.

## Verification

- `npm run typecheck` — PASS (Node, renderer, E2E and extension).
- `npm run lint` — PASS (repository-wide; one formatting warning was corrected and rerun).
- Prettier on changed files — PASS.
- `e2e/remoteControlSecurity.spec.ts` — token hashing, 24-hour expiry, scopes, revocation, rate limiting, private IPv4 and subnet matching.
- `e2e/remoteControlRuntime.spec.ts` — listener disabled by default and Settings UI present.
- `e2e/remoteControlApi.spec.ts` — live loopback-only TLS server, certificate IP SAN, unauthenticated rejection, one-time pairing, scoped authorization, pairing replay rejection, revocation and listener shutdown.
- `npm run build` — PASS (full typecheck plus production main/preload/renderer build).
- Targeted F-16/F-17 regression run — 8 passed.
- `npm run security:gate` — BLOCKED release packaging due to pre-existing, explicitly listed npm audit exceptions (`bittorrent-tracker`, `braces`, `find-yarn-workspace-root`, `ip`, `micromatch`, `patch-package`, `torrent-discovery`, `webtorrent`). This does not fail typecheck, lint or feature tests, but signed/release packaging must remain blocked until those exceptions receive an approved risk decision.

The loopback listener exception used by the integration test is development/E2E-only and is disabled in packaged builds. Production selection still requires a Wi-Fi interface with an RFC 1918 private IPv4 address and valid subnet mask.

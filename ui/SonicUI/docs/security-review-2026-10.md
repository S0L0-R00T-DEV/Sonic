# Security review — 2026-10-23

## Decision

**Release packaging is blocked by default.** The active dependency graph still has known npm audit findings. The application must not be described as vulnerability-free. `npm run build:win` additionally requires a configured trusted code-signing certificate. A maintainer must explicitly accept the currently reviewed dependency exceptions for a particular release by setting `SONIC_ACCEPT_SECURITY_AUDIT_EXCEPTIONS=1`; unknown/new audit findings always fail the gate.

## Dependency audit

- `npm audit fix` safely updated `brace-expansion` 5.0.9 to 5.0.12. The lockfile, `THIRD_PARTY_NOTICES.md`, and CycloneDX SBOM were regenerated.
- The latest full audit reports eight high-severity package entries across two known dependency chains:
  - Production torrent chain: `ip@2.0.1` → `bittorrent-tracker` → `torrent-discovery` → `webtorrent@3.0.21`.
  - Development/build chain: `braces@3.0.3` → `micromatch@4.0.8` → `find-yarn-workspace-root@2.0.0` → `patch-package@8.0.1`.
- `npm audit fix --force` proposes replacing WebTorrent with `webtorrent@0.7.3` and downgrading `patch-package` to `6.0.7`, both breaking changes. Neither forced downgrade was applied.
- `patches/ip+2.0.1.patch` hardens `ip.isPrivate/isPublic` with `ipaddr.js` validation and fail-closed handling of ambiguous addresses. The installed `node_modules/ip/lib/ip.js` contains the patch, and `tests/ip-security.test.mjs` exercises ambiguous loopback/private forms and known public addresses. npm audit still reports the upstream version because the package version itself remains 2.0.1.
- `scripts/security-audit-gate.mjs` only permits the reviewed package/advisory set, pins the tested dependency versions, verifies the applied patch, runs targeted security tests, and blocks by default without explicit exception acceptance. Any unknown package/advisory blocks regardless of the environment variable.
- The gate also blocks while 16 production dependencies have no local license/notice file unless the maintainer has reviewed them or explicitly accepts that gap via `SONIC_ACCEPT_UNVERIFIED_LICENSE_NOTICES=1`. This exception must be recorded alongside the release.

## CLI IPC

- One JSON object per connection, 1 MB request cap, 120-second timeout and 32-connection cap are enforced.
- On Unix, the local socket is changed to owner-only mode `0600`; if this fails, the endpoint is closed. Windows named pipes inherit the creating process token's default security descriptor.
- The CLI endpoint is a local-user interface, not a security boundary against arbitrary code already running as the same user.

## Browser extension

- The extension retains `<all_urls>` host access and the `cookies` permission because it supports explicit user-triggered downloads from arbitrary sites, including authenticated downloads. This is a broad permission and must remain disclosed during browser-store review.
- Cookie retrieval is scoped to the selected download URL(s) and browser store; the Firefox first-party isolation fallback filters cookies to relevant hosts. Page-link extraction only runs after a context-menu action and caps candidates at 50. The extension does not request the broad `tabs` permission; it uses `activeTab` and only inspects tabs it observed opening recently.
- The local bridge checks the Host header and extension Origin, limits JSON bodies to 64 KiB, caps active probes at 4 and pending handoffs at 128, and expires handoff tokens after 15 seconds. Download handoff requires the extension to confirm the token.

## Download handling

- URL probing rejects unsupported schemes, including unsupported FTP schemes and redirect targets.
- Browser bridge rejects malformed requests and filename paths/control characters; filename overrides are limited to a single basename of at most 255 characters.
- Content-Disposition parsing handles RFC 6266/5987 and rejects malformed encoded-word data rather than inventing a filename.
- Existing recovery/publication tests cover staging files, publication failure persistence and retry, EACCES/ENOSPC write failures, and cancellation during active writes.

## Notices, SBOM and installer

- `THIRD_PARTY_NOTICES.md` was regenerated for 213 production dependency instances. Sixteen entries lack a local license text; those require upstream metadata/manual license review before redistribution. The CycloneDX SBOM was regenerated at `diagnostics/sonicui-sbom.cdx.json`.
- Authenticode previously reported the current Windows installer/executable as `NotSigned`; no trusted signing certificate is configured in this environment. `prebuild:win` now runs the security gate with `SONIC_REQUIRE_CODE_SIGNING=1`, so Windows release packaging is blocked until a certificate is configured.
- The security gate does not itself sign an artifact and does not replace a release operator's risk acceptance or manual license review.

## Validation run

- `npm run typecheck`: PASS.
- `npx eslint` on changed security files: PASS.
- `npm run test:security`: PASS — 8 tests.
- `npm run generate:notices`: PASS — 213 production dependency instances inventoried, 16 without local license text.
- `npm run generate:sbom`: PASS — 172 production components inventoried.
- Full project E2E suite not run as part of this security review.

## Residual release gates

1. Remove/upgrade the vulnerable upstream dependency chains where compatible versions become available, or explicitly review/accept the exact exceptions for each release.
2. Configure a trusted Windows code-signing certificate.
3. Complete manual review of the 16 third-party entries without local license text.

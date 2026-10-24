# F-25/F-26 trusted publisher and updater release contract

## Publisher trust (F-25)

Sonic stores an Ed25519 public key and its SHA-256 fingerprint in app settings only after the user compares the fingerprint with an independent trusted source (for example, a separately published security advisory or an out-of-band publisher channel). The public key and fingerprint must not be obtained solely from the same release being verified. The settings panel can verify a detached manifest against that pinned key. A local SHA-256 comparison without a pinned signed statement proves integrity relative to the digest only.

## Signed update assets (F-26)

A stable GitHub release must publish both the platform installer and an asset named `sonic-update-manifest.json`. The manifest is JSON with `payload` (the exact UTF-8 JSON string signed), `signature` (base64 Ed25519 signature over the exact bytes of `payload`), and optional `keyId`. The payload JSON fields are:

- `version`: release version without the optional `v` prefix, matching the release tag.
- `assetName`: exact installer asset name attached to that release.
- `sha256`: 64-character hexadecimal SHA-256 digest of the installer bytes.
- `platform`: `win32`, `darwin`, or `linux`, matching the target platform.

Generate the manifest in a protected release environment; never commit a private key or place it in the app bundle. Supply the private PEM as `SONIC_UPDATE_SIGNING_KEY_PEM` from a protected CI secret and optionally set `SONIC_UPDATE_SIGNING_KEY_ID`:

```powershell
$env:SONIC_UPDATE_SIGNING_KEY_PEM = Get-Content -Raw $env:SONIC_UPDATE_KEY_FILE
$env:SONIC_UPDATE_SIGNING_KEY_ID = 'sonic-release-2026'
node scripts/create-signed-update-manifest.mjs 2.7.0 .\dist-sonic\Speed-o-Freq-Sonic-x64-setup.exe win32 .\dist-sonic\sonic-update-manifest.json
```

Upload the resulting manifest alongside the installer to the same GitHub release. The app checks that the key fingerprint equals the pinned fingerprint, verifies the signature, checks the signed version/name/platform and GitHub asset match, downloads with a 1 GiB bound, verifies SHA-256, and stages the installer. The user must explicitly open the verified installer. Arbitrary paths are not accepted by the launch IPC, and the staged file is hashed again immediately before opening.

## Release limitations

This repository copy has no Git remote metadata and does not establish a canonical publisher repository or trusted release public key. The release operator must configure the correct `owner/repository`, publish the signed manifest, and distribute the corresponding public-key fingerprint independently. Installation is not silent. The existing Windows packaging uses an NSIS installer; the app does not control its rollback behavior, and automated rollback is not implemented. Do not claim an end-to-end production update is verified until a real signed release has passed an integration test on each supported OS.

# Sonic Plugin API — Foundation (API v1)

## Current implementation status

F-15 is implemented as a **declarative, signed plugin manager**, not an arbitrary-code runtime. The main process maintains a local trusted-key registry, verifies Ed25519 signatures and app-version compatibility, reviews/installs manifests disabled by default, persists permission grants and enablement, supports rollback and revocation, and wires the allowed naming and exact-host HTTPS resolution rules into the live probe path. No plugin JavaScript is imported or evaluated.

The trust registry starts empty because no official publisher keys were supplied for bundling. Users must independently verify a publisher's public key before adding it in Settings. A local key registry is not a claim that every plugin publisher is officially endorsed.

## Manifest shape

```json
{
  "id": "vendor.download-helper",
  "name": "Vendor Download Helper",
  "version": "1.0.0",
  "apiVersion": 1,
  "minAppVersion": "2.6.0",
  "permissions": ["link.naming", "host.resolution"],
  "hooks": {
    "filenameRules": [
      {
        "host": "downloads.vendor.example",
        "pathPrefix": "/files/",
        "template": "{host}-{basename}{extension}"
      }
    ],
    "hostResolvers": [
      {
        "host": "downloads.vendor.example",
        "targetOrigin": "https://cdn.vendor.example"
      }
    ],
    "integrations": [
      {
        "id": "vendor.docs",
        "label": "Vendor documentation",
        "homepage": "https://vendor.example/docs"
      }
    ]
  },
  "signature": {
    "algorithm": "ed25519",
    "keyId": "vendor.release-key",
    "value": "BASE64_ED25519_SIGNATURE"
  }
}
```

## Security contract

- Only API version 1 is accepted; `minAppVersion` is checked before trust verification.
- The signature is Ed25519 over the stable `pluginSigningPayload()` serialization, with `signature` excluded and permission names sorted. The public key must come from an app-maintained trusted-key registry; a key supplied by the plugin itself is not trusted.
- Plugins are declarative JSON only. No entrypoint, native module, script, dependency install, filesystem access, arbitrary network request, or code execution is permitted by this format.
- Permissions are explicit: `link.naming`, `host.resolution`, and `integration.metadata`.
- Host matching is exact; wildcard, localhost and IPv4 host rules are rejected. Host resolution targets must be clean HTTPS origins without credentials, paths, queries or fragments.
- Filename rules cannot return paths and support only `{filename}`, `{basename}`, `{extension}`, and `{host}` tokens.
- Optional integrations are metadata links only at this stage, not executable integrations.

## Implemented workflow and release limits

1. In Settings, import an Ed25519 public key under a stable key ID after independently verifying the publisher. Key IDs cannot be rebound to different key material; rotation uses a new ID and can overlap old/new trust.
2. Paste a manifest and review signature validity, compatibility, signer ID, plugin identity, version, and requested permissions before installation.
3. Installation is disabled by default. Grant the manifest's requested permissions explicitly, then enable the plugin in a separate action.
4. Revoke a signer to disable all plugins signed by that key and clear their grants. Plugin updates retain one previous signed version for rollback; rollback returns to disabled state and requires fresh grants.
5. The live probe path applies only the safe declarative filename and exact-host HTTPS resolver hooks. Host resolvers cannot use wildcard, loopback, IP, or non-HTTPS targets.
6. End-to-end coverage exercises trust, signature review, disabled install, permission gating, persistence across relaunch, update/rollback, and revocation. Pure API tests cover signature tampering, version incompatibility, key rotation and host/path restrictions.

No official publisher keys were supplied, so the registry intentionally starts empty. Do not trust a key solely because a plugin package includes it. Arbitrary executable plugins and an online marketplace remain out of scope.

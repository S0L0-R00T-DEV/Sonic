# F-23 - long-term BitTorrent seeding / peer-assisted HTTP

Disposition: **peer-assisted HTTP sharing is removed from product scope** at the user's direction. It is not an unfinished deliverable, is not available in the UI, and must not be implemented or enabled as part of this project scope.

## Retained functionality: explicit long-term BitTorrent seeding

Sonic retains the safe, existing BitTorrent-only seeding policy. The user must explicitly select **Keep seeding until stopped** for an individual torrent; the default remains no post-completion seeding. Per-torrent upload-rate caps and the Stop seeding control remain available. Ratio value `0` means manual stop, not a zero-byte threshold. Seeding ends when Sonic exits and does not silently resume after restart.

## HTTP and alternate transport boundary

- No peer-assisted HTTP uploader, HTTP sharing listener, peer discovery service, or peer-assisted tracker is implemented.
- WebTorrent HTTP/FTP web-seed fetching remains disabled (`webSeeds: false`) because it would bypass Sonic's network-pinned `connect` path.
- Web seeds, uTP, WebRTC, UPnP, NAT-PMP, and local peer discovery are enforced off in the torrent client configuration. Caller-provided options must not override these transport restrictions.
- Ordinary direct HTTP/HTTPS downloads through Sonic's existing download path are unaffected; this decision removes only the proposed peer-assisted HTTP sharing functionality.
- Do not reintroduce this feature without a new explicit product decision and a fresh protocol, privacy, legal/licensing, independent security, and adversarial-test review.

## Verification contract

`tests/feature-f23-gate.test.mjs` guards the out-of-scope disposition, absence of peer-assisted HTTP implementation modules, and the hard-disabled WebTorrent web-seed option. This test is a regression guard for the removal decision, not evidence that an HTTP-sharing feature exists or is approved.

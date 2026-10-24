# Media Preview / Conversion ? Security Notes (F-18)

## Implemented and verified

F-18 HTTP media preview and post-download conversion are implemented in the active SonicUI project. The sequential HTTP preview is available only for supported media files while a download is active and has received bytes; it is served through a short-lived, tokenized loopback HTTP bridge that supports validated byte ranges. Conversion is an explicit user action for a completed, present HTTP media file, with selectable output format and folder.

The conversion path rejects unsupported formats, non-absolute paths, symlink/non-regular executables and source files, missing output folders, insufficient free space, and mismatched FFmpeg SHA-256. It re-hashes the executable before spawning, uses an argument array with `shell: false`, restricts FFmpeg input protocols to `file,pipe`, reserves output paths without overwriting, and removes temporary output on failure/cancellation. Dedicated Playwright tests cover in-progress preview behavior and successful conversion with a matching trusted checksum.

## Trust limitation

SonicUI does not automatically authenticate FFmpeg's publisher or verify a signed release manifest. The user must obtain the expected SHA-256 independently from a trusted distributor and compare it; a locally computed hash alone is not proof of authenticity. The conversion dialog states this explicitly, and conversion fails closed if the supplied checksum does not match. Do not claim automatic signature verification.

## Regression evidence

See `diagnostics/feature-F18-progress.log` and the F-18 tests in `e2e/ui.spec.ts`. On 2026-10-23, the focused F-18 Playwright suite passed 2/2, all four TypeScript typecheck projects passed, and the production Electron/Vite build completed as part of the Playwright run.

# Speed-o'-Freq Sonic

Speed-o'-Freq Sonic is a Windows desktop download manager front end connected to the Sonic .NET download backend.

## Current scope

- Branded Electron desktop shell.
- Direct HTTP/HTTPS download flows through the Sonic backend bridge.
- Download queue controls and download progress reporting exposed by the connected backend.
- Magnet links and .torrent support are present in the inherited UI code; end-to-end integration and release testing must pass before treating them as production-ready.

## Browser integration

The optional browser extension supports Chromium-compatible browsers (including Chrome and Edge) and Firefox. Automatic interception is **off by default** and requires an explicit enable in the extension popup. See [docs/browser-extension.md](docs/browser-extension.md) for installation, permissions, privacy behavior and test coverage.

## Build

Install dependencies with npm, then run `npm run build` for SonicUI and `npm run build:extension` for the browser extension packages. The Windows installer is packaged with electron-builder using electron-builder.yml.

The backend package is staged from the parent project under artifacts/cli-queue-20261018/win-x64. Build or refresh that package before producing a release installer.

## Source and license attribution

The desktop UI is a modified derivative of Sonic by Anmol Kapil, used under the MIT License. The original MIT license and copyright notice are retained in this project. Sonic branding and the Sonic backend integration are project-specific modifications; this notice does not claim original authorship of inherited Sonic code.

See LICENSE for the applicable MIT terms. Third-party dependency notices distributed with Electron and other bundled dependencies must also be retained.

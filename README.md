# Sonic

Sonic is a Windows x64 desktop download manager built with Electron/React and a .NET download backend, with a companion CLI.

## Features

- Manage downloads, queues, progress, retries, pause/resume, cancellation, and history.
- Download HTTP/HTTPS resources with segmented transfers when supported by the server.
- Support magnet links and `.torrent` files for supported BitTorrent workflows.
- Configure network-interface preferences and bandwidth limits.
- Receive links from optional Chromium and Firefox browser extensions.
- Control a running Sonic session through the local Windows CLI.

Actual transfer behavior depends on the source server, torrent swarm, Windows network configuration, and the specific workflow. Sonic does not promise universal single-transfer multi-WAN bonding.

## Repository layout

- `src/SpeedOFreq.App/` — Windows .NET backend/application.
- `src/SpeedOFreq.Core/` — shared download engine.
- `src/SpeedOFreq.Cli/` — command-line controller.
- `ui/SonicUI/src/` — Electron main process, preload bridge, and React UI.
- `ui/SonicUI/extension/` — browser extension source and build.
- `ui/SonicUI/resources/` — application branding assets.
- `build.ps1` — canonical Windows build script.
- `CLI_USAGE.md` — CLI usage reference.

Generated output, dependencies, local backups, test artifacts, credentials, and project-memory notes are not part of the source repository.

## Requirements

- Windows 10/11 x64
- .NET 10 SDK
- Node.js 22 and npm
- Git

## Build the application

From the repository root, run in PowerShell:

```powershell
.\build.ps1
```

This restores dependencies unless skipped, publishes the .NET backend and CLI, builds/type-checks the Electron app and browser extensions, and creates a Windows installer under `ui/SonicUI/dist-sonic-release/`.

For Electron UI development:

```powershell
Set-Location ui/SonicUI
npm ci
npm run dev
```

A local build is not a release certification. Published Windows releases require the configured signing certificate and successful release/security checks.

## License and third-party notices

The project is licensed under the MIT License in `LICENSE`. Review `ui/SonicUI/THIRD_PARTY_NOTICES.md` before redistributing the application, and preserve applicable upstream notices.

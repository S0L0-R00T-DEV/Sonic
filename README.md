<p align="center">
  <img src="logo.png" width="128" alt="Sonic logo">
</p>

<h1 align="center">Sonic</h1>

<p align="center">
  A modern Windows download manager with browser integration, queue controls, and a companion CLI.
</p>

<p align="center">
  <a href="https://github.com/S0L0-R00T-DEV/Sonic/releases/latest">Download Sonic</a> ·
  <a href="#features">Features</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="CLI_USAGE.md">CLI reference</a>
</p>

<p align="center">
  <a href="https://github.com/S0L0-R00T-DEV/Sonic/releases/latest"><img src="https://img.shields.io/github/v/release/S0L0-R00T-DEV/Sonic?label=latest%20release" alt="Latest release"></a>
  <a href="https://github.com/S0L0-R00T-DEV/Sonic/releases"><img src="https://img.shields.io/github/downloads/S0L0-R00T-DEV/Sonic/total" alt="GitHub downloads"></a>
  <a href="https://github.com/S0L0-R00T-DEV/Sonic/actions/workflows/release.yml"><img src="https://github.com/S0L0-R00T-DEV/Sonic/actions/workflows/release.yml/badge.svg?branch=main" alt="Release workflow"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/S0L0-R00T-DEV/Sonic" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11%20%7C%20x64-blue" alt="Windows 10 and 11, x64">
</p>

---

## Overview

**Sonic Download Manager** is a Windows x64 desktop application built with Electron, React, and a .NET download backend. It brings download tracking, queue management, browser hand-off, and command-line control into one application.

The official **Sonic 1.0.0** release includes a signed Windows installer and a signed update manifest.

## Download Sonic

<p align="center">
  <a href="https://github.com/S0L0-R00T-DEV/Sonic/releases/latest"><strong>Get Sonic 1.0.0 for Windows →</strong></a>
</p>

- **Platform:** Windows 10/11, x64
- **Installer:** [Sonic-Setup-x64.exe](https://github.com/S0L0-R00T-DEV/Sonic/releases/download/v1.0.0/Sonic-Setup-x64.exe)
- **Release details and manifest:** [Sonic v1.0.0](https://github.com/S0L0-R00T-DEV/Sonic/releases/tag/v1.0.0)

Download the installer from the official release page and run it yourself. Sonic's in-app updater downloads and verifies an update installer to your Windows **Downloads** folder; it does not launch the installer automatically. When the downloaded installer is present, the update action takes you to the Downloads folder so you can choose when to run it.

## Features

### Download management

- Track download progress and status from the desktop interface.
- Organize downloads into a queue and manage retries, pause/resume, cancellation, and history.
- Use segmented HTTP/HTTPS transfers when the server supports them.
- Support magnet links and `.torrent` files for supported BitTorrent workflows.

### Browser integration

- Send links to Sonic from supported Chromium- and Firefox-based browser extensions.
- Configure browser integration from the app's settings.
- Review the first-launch Terms and Conditions before continuing to setup.

### Network and bandwidth controls

- Configure network-interface preferences for supported download workflows.
- Set bandwidth limits to better fit your connection and usage.
- Actual transfer performance depends on the source server, torrent swarm, and Windows network configuration. Sonic does not promise universal multi-WAN bonding for every individual transfer.

### Companion CLI

- Control a running Sonic session from the local Windows command line.
- Use the CLI for supported download and queue operations.
- See [`CLI_USAGE.md`](CLI_USAGE.md) for command syntax and examples.

### Verified updates

- Retrieve update information from the published signed update manifest.
- Verify the installer before making it available to the user.
- Keep installation under your control: Sonic never starts the downloaded installer automatically.

## Installation

1. Open the [latest GitHub release](https://github.com/S0L0-R00T-DEV/Sonic/releases/latest).
2. Download **Sonic-Setup-x64.exe**.
3. Run the installer and follow the prompts.
4. On first launch, review and accept the Terms and Conditions.
5. Open Settings to finish browser integration setup, if you plan to use the browser extension.

Only download release files from the official Sonic repository.

## Build from source

### Requirements

- Windows 10/11 (x64)
- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- [Node.js 22](https://nodejs.org/) and npm
- [Git](https://git-scm.com/)

### Build the complete application

Run these commands in PowerShell from the repository root:

```powershell
git clone https://github.com/S0L0-R00T-DEV/Sonic.git
Set-Location Sonic
.\build.ps1
```

The canonical build script restores dependencies unless skipped, publishes the .NET backend and CLI, builds and type-checks the Electron application and browser extensions, and produces a Windows installer under `ui/SonicUI/dist-sonic-release/`.

### Run the Electron UI during development

```powershell
Set-Location ui/SonicUI
npm ci
npm run dev
```

A development build is not the same as an official release. Publishing requires the configured signing certificate and successful release/security checks.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/SpeedOFreq.App/` | Windows .NET backend/application |
| `src/SpeedOFreq.Core/` | Shared download engine |
| `src/SpeedOFreq.Cli/` | Command-line controller |
| `ui/SonicUI/src/` | Electron main process, preload bridge, and React UI |
| `ui/SonicUI/extension/` | Browser extension source and build |
| `ui/SonicUI/resources/` | Application branding assets |
| `build.ps1` | Canonical Windows build script |
| `CLI_USAGE.md` | CLI usage reference |

## Support and bug reports

If you encounter a problem, [open an issue](https://github.com/S0L0-R00T-DEV/Sonic/issues) and include reproducible steps, relevant logs, your Windows version, and whether you installed a release build or ran from source. Do not post passwords, signing keys, access tokens, or other secrets.

## License and third-party notices

Sonic is licensed under the [MIT License](LICENSE). Before redistributing the application, review [`ui/SonicUI/THIRD_PARTY_NOTICES.md`](ui/SonicUI/THIRD_PARTY_NOTICES.md) and preserve applicable upstream notices.

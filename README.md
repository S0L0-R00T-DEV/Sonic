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

## Complete repository structure

The tree below lists **every file tracked by Git on `main`** at the time this README was updated. Folder comments describe each directory's responsibility; individual files are listed so the source layout can be browsed without opening the repository first. Generated output, installed dependencies, and ignored local files are not included.

```text
Sonic/
├── .github  # GitHub Actions release automation
│   └── workflows  # CI and release workflow definitions
│       └── release.yml  # Official signed release and asset publishing workflow
├── src  # Windows .NET backend, shared engine, and CLI
│   ├── SpeedOFreq.App  # Windows desktop/backend application and download queue services
│   │   ├── App.xaml
│   │   ├── App.xaml.cs
│   │   ├── AppStoragePaths.cs
│   │   ├── ControlPipeServer.cs
│   │   ├── DownloadQueueService.cs  # Download queue coordination and management
│   │   ├── MainWindow.xaml  # Windows application window layout
│   │   ├── MainWindow.xaml.cs  # Windows application window behavior
│   │   ├── QueueDownloadItem.cs
│   │   └── SpeedOFreq.App.csproj
│   ├── SpeedOFreq.Cli  # Command-line entry point and CLI project configuration
│   │   ├── Program.cs  # CLI command parsing and execution
│   │   └── SpeedOFreq.Cli.csproj
│   └── SpeedOFreq.Core  # Reusable download engine, options, browser context, and bandwidth controls
│       ├── BandwidthLimiter.cs
│       ├── BrowserRequestContext.cs
│       ├── DownloadEngine.cs  # Core download engine
│       ├── DownloadOptions.cs
│       ├── GlobalUsings.cs
│       └── SpeedOFreq.Core.csproj
├── ui  # Desktop UI and browser-integration project
│   └── SonicUI  # Electron, React, updater, browser extension, and packaging project
│       ├── .github
│       │   └── workflows  # UI project CI workflow
│       │       └── ci.yml
│       ├── .vscode  # VS Code launch and workspace settings
│       │   ├── extensions.json
│       │   ├── launch.json
│       │   └── settings.json
│       ├── build  # Installer assets, platform entitlements, and update supervisor
│       │   ├── entitlements.mac.plist
│       │   ├── icon.icns
│       │   ├── icon.ico
│       │   ├── icon.png
│       │   ├── installer.nsh
│       │   ├── installerHeader.bmp
│       │   ├── installerSidebar.bmp
│       │   └── update-supervisor.ps1
│       ├── design-system  # Design-system documentation
│       │   └── speed-o-freq-sonic  # Sonic design tokens and interface guidance
│       │       └── MASTER.md
│       ├── extension  # Browser extension source, icons, manifest, and build script
│       │   ├── icons  # Browser extension icon variants
│       │   │   ├── icon-128.png
│       │   │   ├── icon-16.png
│       │   │   ├── icon-32.png
│       │   │   ├── icon-48.png
│       │   │   ├── icon-off-16.png
│       │   │   └── icon-off-32.png
│       │   ├── src  # Extension background logic, popup, settings, and browser hand-off
│       │   │   ├── api.ts
│       │   │   ├── background.ts
│       │   │   ├── defaults.ts
│       │   │   ├── fileTypes.ts
│       │   │   ├── linkSelection.ts
│       │   │   ├── options.html
│       │   │   ├── options.ts
│       │   │   ├── popup.html
│       │   │   ├── popup.ts
│       │   │   ├── settings.ts
│       │   │   ├── sonic.ts
│       │   │   ├── torInterceptor.ts
│       │   │   └── ui.css
│       │   ├── build.mjs
│       │   ├── INSTALL.md  # Browser extension installation instructions
│       │   ├── manifest.json  # Browser extension manifest
│       │   └── tsconfig.json
│       ├── patches  # Pinned dependency patches maintained by the project
│       │   ├── @thaunknown+simple-peer+10.1.2.patch
│       │   ├── ip+2.0.1.patch
│       │   └── webtorrent+3.0.21.patch
│       ├── resources  # Application icon and logo variants
│       │   ├── sonic-icon-black.png
│       │   ├── sonic-icon-blue.png
│       │   ├── sonic-icon-red.png
│       │   ├── sonic-logo-bg-black.jpg
│       │   ├── sonic-logo-bg-blue.jpg
│       │   └── sonic-logo-bg-red.jpg
│       ├── scripts  # Release generation, signing, security, package checks, and smoke tests
│       │   ├── check-torrent-package.mjs
│       │   ├── contentDisposition.test.mts
│       │   ├── create-installer-artwork.ps1
│       │   ├── create-signed-update-manifest.mjs
│       │   ├── generate-package-sbom.mjs
│       │   ├── generate-release-manifest.mjs
│       │   ├── generate-sbom.mjs
│       │   ├── generate-third-party-notices.mjs
│       │   ├── generate-update-trust.mjs
│       │   ├── installer-smoke-test.ps1  # Installer and updater smoke-test checks
│       │   ├── prepare-backend.mjs
│       │   ├── release-notes.mjs
│       │   ├── security-audit-gate.mjs
│       │   └── sign-plugin-manifest.mjs
│       ├── src  # Electron main process, preload, renderer, and shared contracts
│       │   ├── main  # Main-process services, IPC, updates, network controls, plugins, and downloads
│       │   │   ├── download  # Download orchestration, HTTP/FTP transfers, history, scheduling, integrity, and media
│       │   │   │   ├── torrent  # Torrent engine, metadata, peer handling, file selection, and transfers
│       │   │   │   │   ├── engine.ts
│       │   │   │   │   ├── files.ts
│       │   │   │   │   ├── metadata.ts
│       │   │   │   │   ├── modules.d.ts
│       │   │   │   │   ├── ownedFiles.ts
│       │   │   │   │   ├── paths.ts
│       │   │   │   │   ├── peers.ts
│       │   │   │   │   ├── torrentDestination.ts
│       │   │   │   │   └── torrentTransfer.ts
│       │   │   │   ├── blockProgress.ts
│       │   │   │   ├── browserContext.ts
│       │   │   │   ├── chunkDownloader.ts
│       │   │   │   ├── concurrency.ts
│       │   │   │   ├── contentDisposition.ts
│       │   │   │   ├── downloadFile.ts
│       │   │   │   ├── downloadManager.ts
│       │   │   │   ├── fileVersion.ts
│       │   │   │   ├── ftpProtocol.ts
│       │   │   │   ├── ftpTransfer.ts
│       │   │   │   ├── history.ts
│       │   │   │   ├── httpMediaPreview.ts
│       │   │   │   ├── httpTransfer.ts
│       │   │   │   ├── integrityVerification.ts
│       │   │   │   ├── mediaConversion.ts
│       │   │   │   ├── mediaDownloadManager.ts
│       │   │   │   ├── mediaStreams.ts
│       │   │   │   ├── metalink.ts
│       │   │   │   ├── outputHash.ts
│       │   │   │   ├── paths.ts
│       │   │   │   ├── plan.ts
│       │   │   │   ├── probe.ts
│       │   │   │   ├── savedProgress.ts
│       │   │   │   ├── scheduler.ts
│       │   │   │   ├── sparseFile.ts
│       │   │   │   ├── torrentPreview.ts
│       │   │   │   ├── transfer.ts
│       │   │   │   └── trashDownload.ts
│       │   │   ├── ipc  # IPC handler registration and request routing
│       │   │   │   └── handlers.ts  # Main-process IPC handlers
│       │   │   ├── network  # Network interface discovery, binding, routes, and bandwidth limits
│       │   │   │   ├── deviceBinding.ts
│       │   │   │   ├── interfaces.ts
│       │   │   │   ├── limits.ts
│       │   │   │   └── routes.ts
│       │   │   ├── appBranding.ts
│       │   │   ├── browserBridge.ts
│       │   │   ├── cliControl.ts
│       │   │   ├── completionNotification.ts
│       │   │   ├── diagnosticReport.ts
│       │   │   ├── index.ts  # Electron main-process entry point
│       │   │   ├── instancePipe.ts
│       │   │   ├── jsonFile.ts
│       │   │   ├── openLinks.ts
│       │   │   ├── pluginRegistry.ts
│       │   │   ├── pluginTrust.ts
│       │   │   ├── remoteControlSecurity.ts
│       │   │   ├── remoteControlServer.ts
│       │   │   ├── runtimeLog.ts
│       │   │   ├── settings.ts
│       │   │   ├── siteMirror.ts
│       │   │   ├── sonicBridge.ts
│       │   │   ├── storageBackup.ts
│       │   │   ├── testKnobs.ts
│       │   │   ├── updater.ts  # Update discovery, verification, and installer download handling
│       │   │   ├── updaterVersion.ts
│       │   │   └── updateTrust.generated.ts
│       │   ├── preload  # Secure bridge exposed from Electron to the renderer
│       │   │   ├── globals.d.ts
│       │   │   └── index.ts  # Renderer-safe Electron API bridge
│       │   ├── renderer  # Renderer HTML entry point and React frontend
│       │   │   ├── src  # React application, screens, components, hooks, state, theme, and utilities
│       │   │   │   ├── assets  # Stylesheets, fonts, logos, and brand assets
│       │   │   │   │   ├── brand  # Brand logo variants used in the interface
│       │   │   │   │   │   ├── sonic-black.png
│       │   │   │   │   │   ├── sonic-blue.png
│       │   │   │   │   │   └── sonic-red.png
│       │   │   │   │   ├── fonts  # Bundled UI and monospace fonts
│       │   │   │   │   │   ├── Manrope-Variable.woff2
│       │   │   │   │   │   └── RobotoMono-Variable.woff2
│       │   │   │   │   ├── main.css
│       │   │   │   │   └── sonic-logo.png
│       │   │   │   ├── components  # Reusable interface components and dialogs
│       │   │   │   │   ├── ui  # Shared low-level UI primitives
│       │   │   │   │   │   ├── alert-dialog.tsx
│       │   │   │   │   │   ├── alert.tsx
│       │   │   │   │   │   ├── badge.tsx
│       │   │   │   │   │   ├── button.tsx
│       │   │   │   │   │   ├── calendar.tsx
│       │   │   │   │   │   ├── checkbox.tsx
│       │   │   │   │   │   ├── context-menu.tsx
│       │   │   │   │   │   ├── dialog.tsx
│       │   │   │   │   │   ├── dropdown-menu.tsx
│       │   │   │   │   │   ├── input-group.tsx
│       │   │   │   │   │   ├── input.tsx
│       │   │   │   │   │   ├── popover.tsx
│       │   │   │   │   │   ├── switch.tsx
│       │   │   │   │   │   ├── textarea.tsx
│       │   │   │   │   │   ├── toggle-group.tsx
│       │   │   │   │   │   ├── toggle.tsx
│       │   │   │   │   │   └── tooltip.tsx
│       │   │   │   │   ├── AboutDialog.tsx  # About dialog and update controls
│       │   │   │   │   ├── ActionErrorDialog.tsx
│       │   │   │   │   ├── BatchImportDialog.tsx
│       │   │   │   │   ├── BlockGrid.tsx
│       │   │   │   │   ├── ColorBadge.tsx
│       │   │   │   │   ├── CombineDiagram.tsx
│       │   │   │   │   ├── ContextHelp.tsx
│       │   │   │   │   ├── CyclableChip.tsx
│       │   │   │   │   ├── DetailHeader.tsx
│       │   │   │   │   ├── downloadActionMeta.ts
│       │   │   │   │   ├── downloadActionsContext.ts
│       │   │   │   │   ├── DownloadActionsProvider.tsx
│       │   │   │   │   ├── DownloadContextMenu.tsx
│       │   │   │   │   ├── DownloadFilterMenu.tsx
│       │   │   │   │   ├── DownloadOrganizationDialog.tsx
│       │   │   │   │   ├── FixLinkDialog.tsx
│       │   │   │   │   ├── HeroBand.tsx
│       │   │   │   │   ├── LimitsDialog.tsx
│       │   │   │   │   ├── MediaConversionDialog.tsx
│       │   │   │   │   ├── MirrorSiteDialog.tsx
│       │   │   │   │   ├── MoreActionsMenu.tsx
│       │   │   │   │   ├── NetworkBindingDialog.tsx
│       │   │   │   │   ├── NetworkEditPopover.tsx
│       │   │   │   │   ├── NetworkRow.tsx
│       │   │   │   │   ├── NetworksMenu.tsx
│       │   │   │   │   ├── NewDownloadDialog.tsx
│       │   │   │   │   ├── PerformanceDiagnostics.tsx
│       │   │   │   │   ├── PluginManagement.tsx
│       │   │   │   │   ├── RemoteControlSettings.tsx
│       │   │   │   │   ├── RemoveDialog.tsx
│       │   │   │   │   ├── ScheduleFields.tsx
│       │   │   │   │   ├── ScheduleIndicator.tsx
│       │   │   │   │   ├── ScreenFooter.tsx
│       │   │   │   │   ├── StatusBar.tsx
│       │   │   │   │   ├── TermsOfServiceDialog.tsx  # First-launch Terms and Conditions dialog
│       │   │   │   │   ├── ThemeToggle.tsx
│       │   │   │   │   ├── ThroughputChart.tsx
│       │   │   │   │   ├── TitleBar.tsx
│       │   │   │   │   ├── TorrentBadge.tsx
│       │   │   │   │   ├── TorrentFiles.tsx
│       │   │   │   │   └── TruncatedText.tsx
│       │   │   │   ├── hooks  # React hooks for downloads, scheduling, networks, and formatting
│       │   │   │   │   ├── useDownloadEvents.ts
│       │   │   │   │   ├── useDownloadSchedule.ts
│       │   │   │   │   ├── useFormatSpeed.ts
│       │   │   │   │   ├── useNetworks.ts
│       │   │   │   │   ├── useNetworkVisuals.ts
│       │   │   │   │   └── useOpenedLinks.ts
│       │   │   │   ├── screens  # Primary download and status screens
│       │   │   │   │   ├── CompleteScreen.tsx
│       │   │   │   │   ├── DownloadingScreen.tsx
│       │   │   │   │   ├── DownloadsScreen.tsx  # Main downloads screen
│       │   │   │   │   └── ErrorScreen.tsx
│       │   │   │   ├── store  # Application state management
│       │   │   │   │   └── useAppStore.ts
│       │   │   │   ├── utils  # Shared renderer utility functions
│       │   │   │   │   ├── batchLinks.ts
│       │   │   │   │   ├── downloadActions.ts
│       │   │   │   │   └── format.ts
│       │   │   │   ├── App.tsx  # Root React application and first-launch flow
│       │   │   │   ├── cn.ts
│       │   │   │   ├── env.d.ts
│       │   │   │   ├── i18n.tsx
│       │   │   │   ├── main.tsx
│       │   │   │   └── theme.ts
│       │   │   └── index.html
│       │   └── shared  # Types and contracts shared across Electron processes
│       │       ├── browserBridge.ts
│       │       ├── dataLimits.ts
│       │       ├── downloadSchedule.ts
│       │       ├── downloadUpdate.ts
│       │       ├── errors.ts
│       │       ├── ipc-channels.ts
│       │       ├── ipc-contract.ts  # Typed IPC API contract
│       │       ├── pluginApi.ts
│       │       └── types.ts
│       ├── .editorconfig
│       ├── .gitignore
│       ├── .prettierignore
│       ├── .prettierrc.yaml
│       ├── components.json
│       ├── electron-builder.yml  # Desktop application packaging configuration
│       ├── electron.vite.config.ts  # Electron Vite build configuration
│       ├── eslint.config.mjs
│       ├── LICENSE
│       ├── package-lock.json  # Locked npm dependency graph
│       ├── package.json  # UI package metadata, scripts, and dependencies
│       ├── README.md  # Electron application development notes
│       ├── THIRD_PARTY_NOTICES.md  # Third-party software notices
│       ├── tsconfig.json
│       ├── tsconfig.node.json
│       └── tsconfig.web.json
├── .gitignore  # Git exclusions for generated and local files
├── build.ps1  # Canonical Windows build and packaging script
├── CLI_USAGE.md  # CLI command reference and usage examples
├── LICENSE  # Repository license
├── logo.png  # Main README logo supplied for Sonic branding
└── README.md  # Project overview, features, setup, and complete source tree
```

## Support and bug reports

If you encounter a problem, [open an issue](https://github.com/S0L0-R00T-DEV/Sonic/issues) and include reproducible steps, relevant logs, your Windows version, and whether you installed a release build or ran from source. Do not post passwords, signing keys, access tokens, or other secrets.

## License and third-party notices

Sonic is licensed under the [MIT License](LICENSE). Before redistributing the application, review [`ui/SonicUI/THIRD_PARTY_NOTICES.md`](ui/SonicUI/THIRD_PARTY_NOTICES.md) and preserve applicable upstream notices.

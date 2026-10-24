# Speed-o'-Freq Sonic

**A Windows desktop download manager built for control, visibility, and flexible network use.**

Sonic combines an Electron/React desktop interface with a .NET download backend. It provides a managed download queue, network and bandwidth controls, torrent workflows, browser-assisted link handoff, and a companion command-line interface for controlling a running desktop session.

> Sonic's multi-network throughput depends on the server, the routing available on the machine, and whether selected adapters reach the internet through genuinely separate connections. Results vary by download source and network setup.

## Features

- **Download queue:** inspect progress and manage active downloads, including pause, resume, retry, and cancellation where supported.
- **Direct downloads:** handle HTTP and HTTPS links, with parallel transfer support when the server permits it.
- **Torrent workflows:** work with magnet links and `.torrent` files, including selecting files from supported torrents.
- **Network controls:** select or disable available adapters and configure per-network preferences.
- **Bandwidth management:** set speed limits and use Slow mode to reduce download activity while calls or streaming are in progress.
- **Queue and history:** manage concurrent downloads and review completed-download history.
- **Browser integration:** optional extension for sending links to Sonic from supported Chromium-based browsers and Firefox. Automatic interception is off by default and must be explicitly enabled.
- **CLI control:** query status, inspect downloads, and control the running desktop app through its local Windows named-pipe interface.

Feature availability can depend on the protocol, remote server, adapter configuration, and current release validation.

## Project layout

```text
Sonic/
├── src/
│   ├── SpeedOFreq.App/       # Windows desktop app and queue service
│   ├── SpeedOFreq.Core/      # Shared .NET download engine
│   └── SpeedOFreq.Cli/       # CLI for the running desktop app
├── tests/
│   └── SpeedOFreq.Core.Smoke/# .NET core smoke tests
├── ui/
│   └── SonicUI/
│       ├── src/main/         # Electron main process and download services
│       ├── src/preload/      # Narrow, typed renderer bridge
│       ├── src/renderer/     # React user interface
│       ├── extension/        # Browser extension source
│       ├── e2e/              # Playwright end-to-end tests
│       ├── tests/            # Focused security and unit tests
│       └── scripts/          # Packaging, SBOM, and notice tooling
├── docs/                     # Project structure and cleanup records
├── PRD.md                    # Product requirements
├── IMPLEMENTATION_STATUS.md  # Implementation tracking
└── CLI_USAGE.md               # CLI command reference
```

Generated build output, local dependency directories, test results, and packaged installers should be generated locally or through CI rather than committed as source. Preserve source assets, lockfiles, test fixtures, required license notices, and release evidence.

## Build from source

### Requirements

- Windows 10 or Windows 11 for the complete desktop application and .NET WPF components.
- A supported Node.js/npm toolchain for the Electron UI. Use the version required by the project dependencies and CI workflow.
- .NET 10 SDK for the Windows app, shared core, CLI, and smoke tests.

### Install UI dependencies

```powershell
Set-Location ui/SonicUI
npm ci
```

### Build and validate the UI

```powershell
npm run typecheck
npm run lint
npm run build
npm run build:extension
```

### Build the .NET components

Run these from the repository root:

```powershell
dotnet build src/SpeedOFreq.App/SpeedOFreq.App.csproj -c Release
dotnet build src/SpeedOFreq.Cli/SpeedOFreq.Cli.csproj -c Release
dotnet run --project tests/SpeedOFreq.Core.Smoke/SpeedOFreq.Core.Smoke.csproj -c Release
```

### Focused tests and security checks

From `ui/SonicUI`:

```powershell
npm run test:security
npm run test:ip-security
npm run test:e2e:smoke
```

The full Playwright suite is available with `npm run test:e2e`. Network-dependent tests may require a real, non-loopback LAN configuration; review test output for skipped tests before treating a run as complete. Release builds must also pass the repository's configured security and packaging gates.

## Documentation

- [Product requirements](PRD.md)
- [Implementation status](IMPLEMENTATION_STATUS.md)
- [CLI usage guide](CLI_USAGE.md)
- [Project structure](docs/PROJECT_STRUCTURE.md)
- [Browser extension documentation](ui/SonicUI/docs/browser-extension.md)
- [Security policy](ui/SonicUI/SECURITY.md)
- [Third-party notices](ui/SonicUI/THIRD_PARTY_NOTICES.md)

## Security and release readiness

Sonic includes dependency security checks, third-party license notices, and software bill of materials (SBOM) generation under `ui/SonicUI/scripts/`. Review their generated output as part of release preparation; a successful build alone does not prove every dependency advisory or licensing item is resolved.

Windows Authenticode signing is a separate release step. Unsigned or newly signed installers may still trigger Microsoft Defender SmartScreen warnings until signing and reputation requirements are met. Do not describe an installer as signed unless its Authenticode signature has been verified.

## License and attribution

Review [the UI license](ui/SonicUI/LICENSE) and [third-party notices](ui/SonicUI/THIRD_PARTY_NOTICES.md) before redistributing the application. Keep applicable upstream copyright and license text with redistributed code and dependencies.

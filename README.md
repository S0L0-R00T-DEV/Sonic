# Speed-o'-Freq Sonic

**Sonic is a Windows desktop download manager with an Electron/React interface, a .NET download backend, and a companion command-line interface.**

The active desktop UI lives in `ui/SonicUI/`. The repository also contains the .NET/WPF downloader and CLI projects under `src/`; the Electron app integrates a packaged .NET backend. Sonic focuses on managed downloads, queue visibility, browser-assisted handoff, network-interface controls, and local-first operation.

> **Performance note:** Sonic does not promise universal system-wide or packet-level multi-WAN bonding. Multi-interface behavior depends on the downloader path, server range support/throttling, machine resources, and genuinely independent upstream connections. Two adapters connected through the same constrained router or ISP do not automatically provide additive bandwidth.

## Features

- **Download management:** queue and history workflows, progress reporting, pause/resume/cancel controls, and completion summaries where supported by the active workflow.
- **HTTP(S) transfers:** segmented/range-based transfers when the origin supports them, with fallback paths for servers that do not support range requests.
- **Additional protocols and media workflows:** source code includes FTP/FTPS, BitTorrent/magnet, and HLS/DASH-related paths. Support and validation vary by workflow and release; do not assume every path is production-certified.
- **Network controls:** interface preferences and download scheduling across configured source addresses. This is connection/request-level scheduling, not packet-level bonding.
- **Browser extensions:** optional extension builds for Chromium-based browsers and Firefox. The extension can hand selected links to Sonic; automatic download capture/interception is opt-in and can be disabled. Sonic does not silently install or enable browser extensions.
- **CLI control:** the .NET CLI can control the WPF/backend session over a local Windows named pipe. The pipe is local and is not a LAN listener.
- **Security-oriented behavior:** the project includes input-validation, download-integrity, extension-bridge, dependency-audit, and packaging checks. A passing build alone does not establish release readiness.

## Repository layout

```text
Sonic/
├── src/
│   ├── SpeedOFreq.App/        # Windows WPF app and backend/queue integration
│   ├── SpeedOFreq.Core/       # Shared .NET download engine
│   └── SpeedOFreq.Cli/        # CLI controller
├── tests/
│   └── SpeedOFreq.Core.Smoke/ # Deterministic .NET core smoke tests
├── ui/
│   └── SonicUI/
│       ├── src/main/          # Electron main process and services
│       ├── src/preload/       # Restricted renderer bridge
│       ├── src/renderer/      # React UI
│       ├── extension/         # Browser extension source/build
│       ├── tests/             # Unit/security tests
│       ├── e2e/               # Playwright end-to-end tests
│       └── scripts/           # Build, security, and notice tooling
├── docs/                      # Project structure and engineering records
├── PRD.md                     # Product requirements and decisions
├── PROJECT_MEMORY.md          # Engineering handoff and source map
└── CLI_USAGE.md               # CLI command reference
```

Generated build output, dependency directories, caches, test results, local downloads, diagnostics, and credentials are not source inputs for ordinary checkouts. Preserve lockfiles, source assets, required license notices, and release evidence.

## Requirements

- Windows 10 or Windows 11; the active desktop packaging target is Windows x64. Verify the current Windows baseline and package configuration before relying on other architectures.
- .NET 10 SDK for building the .NET projects.
- Node.js 22 and npm for the Electron UI.
- Git for source checkout.

## Build from source

### Canonical Windows build

From the repository root, run the PowerShell build entry point:

```powershell
.\build.ps1
```

Run this from a clean checkout when validating that the build does not depend on local generated files. Review the script and its prerequisites before running a release/package build.

### Electron UI development

```powershell
Set-Location ui/SonicUI
npm ci
npm run dev
```

### UI validation

From `ui/SonicUI`:

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run build:extension
npm run test:security
npm run test:ip-security
npm run test:e2e:smoke
```

Use the scripts currently declared in `ui/SonicUI/package.json`; some security or packaging gates intentionally block release builds when an advisory or license issue remains unresolved. The full Playwright suite may require a working Windows desktop/runtime environment. Record actual exit codes and test summaries; do not infer that tests passed merely because a process started.

### .NET components and smoke tests

From the repository root:

```powershell
dotnet build src/SpeedOFreq.App/SpeedOFreq.App.csproj -c Release
dotnet build src/SpeedOFreq.Cli/SpeedOFreq.Cli.csproj -c Release
dotnet run --project tests/SpeedOFreq.Core.Smoke/SpeedOFreq.Core.Smoke.csproj -c Release
```

See `CLI_USAGE.md` for CLI commands and examples.

## Browser extension

The extension source and setup notes are under `ui/SonicUI/extension/` and `ui/SonicUI/docs/browser-extension.md`. Build the extension with `npm run build:extension` from `ui/SonicUI`, then follow the browser-specific manual loading steps. Browser security requires user approval; an extension build is not the same as an automatically installed extension. Verify the exact supported browser and installation flow against the current UI and documentation.

## Security, privacy, and release status

- Keep Electron renderer isolation enabled and expose privileged operations only through the intended preload/IPC boundary.
- Browser handoff is user-controlled; review extension permission prompts and privacy behavior before enabling capture.
- The .NET CLI named pipe is intended for local control, not remote network access.
- Preserve third-party copyright/license notices. Review `ui/SonicUI/THIRD_PARTY_NOTICES.md` and the dependency/security audit output before redistribution.
- Verify installer signatures and hashes rather than describing a package as signed based only on its build output.
- Do not treat a successful compile or a local test package as proof of production readiness. End-to-end browser validation, dependency/license gates, clean-profile install/upgrade/uninstall checks, and hardware-dependent network tests remain separate release checks.

## Documentation

- [Product requirements and engineering decisions](PRD.md)
- [Project memory and architecture map](PROJECT_MEMORY.md)
- [CLI usage guide](CLI_USAGE.md)
- [Project structure](docs/PROJECT_STRUCTURE.md)
- [Browser extension guide](ui/SonicUI/docs/browser-extension.md)
- [Security policy](ui/SonicUI/SECURITY.md)
- [Third-party notices](ui/SonicUI/THIRD_PARTY_NOTICES.md)

## License and attribution

The repository root is licensed under the MIT License in `LICENSE`. The UI project also retains its license for its standalone packaging context. Preserve applicable upstream notices and review third-party licensing before redistributing builds.

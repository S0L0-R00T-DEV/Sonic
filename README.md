# Speed-o'-Freq Sonic

Speed-o'-Freq Sonic is a Windows download manager with an Electron-based user interface and a .NET download engine/CLI.

## Active source
- `src/SpeedOFreq.Core/` — shared download engine and core logic.
- `src/SpeedOFreq.App/` — Windows desktop application and queue service.
- `src/SpeedOFreq.Cli/` — command-line interface.
- `tests/SpeedOFreq.Core.Smoke/` — core smoke tests.
- `ui/SonicUI/` — active Electron/React user interface, assets and build configuration.

## Build and delivery
- `build-core.ps1` — builds the core and runs smoke tests.
- `build-preview.ps1` — creates preview packages.
- `build-cli-queue.ps1` — builds the desktop app and CLI and packages self-contained x64/ARM64 outputs.
- `artifacts/EXE output/` — existing .NET executable distribution.
- `artifacts/cli-queue-20261018/` — CLI-enabled packages.
- `artifacts/preview/` — preview packages.
- `artifacts/verified-improved-20261018/` — preserved verification build.
- `ui/SonicUI/dist-sonic/` — packaged UI output.

## Documentation
- `PRD.md` — product requirements.
- `IMPLEMENTATION_STATUS.md` — implementation status.
- `CLI_USAGE.md` — CLI usage.
- `docs/PREVIEW_GUIDE.md` — preview instructions.
- `docs/` — release metadata used to generate release notes.

## Archive and diagnostics
- `archive/` — historical experiments and builds retained where useful.
- `artifacts/archive/` — older staging builds.
- `diagnostics/` — logs, captures, test fixtures and backups.

## Build note
Keep generated output and dependencies out of source control where practical. Existing deliverables should not be deleted until a replacement has been built and verified.

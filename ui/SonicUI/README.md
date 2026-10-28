# Sonic UI

This directory contains Sonic's Electron desktop application, React renderer, browser extensions, updater, and Windows packaging configuration. The repository-level `README.md` is the primary user and contributor guide.

## Build

From the repository root on Windows 10/11 x64, install the required .NET 10 SDK, Node.js 22, npm, and Git, then run:

```powershell
.\build.ps1
```

The root build script is the canonical entry point. It builds the .NET backend and CLI, type-checks and builds the desktop UI and browser extensions, and packages the Windows installer under `ui/SonicUI/dist-sonic-release/`.

For UI-only development:

```powershell
Set-Location ui/SonicUI
npm ci
npm run dev
```

## Validation

The root GitHub Actions CI workflow runs lint, TypeScript checks, and formatting checks for pull requests targeting `main` and pushes to `main`. Official release builds run the Windows release workflow, which performs signing, security and dependency checks, installer smoke tests, and signed-update-manifest validation.

## Licensing

See the repository-level [MIT License](../../LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). Preserve applicable upstream license and notice files when redistributing the application.

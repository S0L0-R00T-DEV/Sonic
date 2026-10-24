# Speed-o'-Freq Sonic — Project Structure

Last reviewed: 2026-10-22

## Active project root

```text
Speed-o'-Freq Sonic/
├── README.md                     Project overview and source map
├── PRD.md                        Product requirements
├── IMPLEMENTATION_STATUS.md      Implementation status
├── CLI_USAGE.md                  CLI usage instructions
├── .gitignore                    Generated-output and editor exclusions
├── build-core.ps1                Build core and run smoke tests
├── build-preview.ps1             Build preview packages
├── build-cli-queue.ps1           Build desktop app + CLI packages
├── src/
│   ├── SpeedOFreq.Core/          Shared download engine/core
│   ├── SpeedOFreq.App/           Windows desktop app / queue service
│   └── SpeedOFreq.Cli/           Command-line interface
├── tests/
│   └── SpeedOFreq.Core.Smoke/    Core smoke tests
├── ui/
│   └── SonicUI/                  Active Electron + React desktop UI
├── artifacts/
│   ├── EXE output/               Existing .NET executable distribution
│   ├── cli-queue-20261018/       x64 and ARM64 app/CLI packages
│   ├── verified-improved-20261018/ Preserved verification packages
│   ├── preview/                  Preview packages
│   └── archive/                  Historical UI/build artifacts
├── archive/
│   ├── historical-builds/        Older preserved builds
│   └── legacy-source/            Historical experiments/source
├── diagnostics/                  Root build/test logs, captures and backups
└── docs/
    ├── PREVIEW_GUIDE.md
    ├── PROJECT_CLEANUP_REPORT.md
    └── PROJECT_STRUCTURE.md      This document
```

## Active UI project: `ui/SonicUI/`

```text
SonicUI/
├── src/
│   ├── main/                     Electron main process and download engines
│   ├── preload/                  Secure renderer bridge
│   ├── renderer/                 React UI
│   └── shared/                   Shared types and contracts
├── extension/                    Browser extension source/build
├── e2e/                          Playwright end-to-end tests and fixtures
├── tests/                        Focused Node tests
├── scripts/                      Build checks, SBOM and third-party notices
├── resources/                    App logos/icons
├── build/                        Installer resources and platform assets
├── design-system/                UI design tokens/assets
├── patches/                      Maintained dependency patches
├── docs/                         Release metadata helpers
├── diagnostics/
│   └── deep-research-backup/     Preserved investigation/source/user-data snapshots
├── package.json                  Scripts and dependency manifest
├── package-lock.json             Locked Node dependency graph
├── electron.vite.config.ts       Electron/Vite build configuration
├── electron-builder.yml          Installer packaging configuration
├── playwright.config.ts          E2E test configuration
├── tsconfig*.json                TypeScript configurations
├── eslint.config.mjs             Lint rules
├── .prettierrc.yaml              Formatting rules
├── .gitignore                    UI generated-output exclusions
├── LICENSE / SECURITY.md         Legal and security documentation
└── THIRD_PARTY_NOTICES.md        Third-party notices
```

## Generated or historical paths

- `src/**/bin/` and `src/**/obj/` are regeneratable .NET build output; removed during cleanup.
- `ui/SonicUI/out/`, `test-results/`, and `.eslintcache` are regeneratable UI/test caches; removed.
- The older UI output formerly in `ui/SonicUI/dist/` was moved intact to `artifacts/archive/historical-ui-dist-20261019/`. The active packager outputs to `ui/SonicUI/dist-sonic/`.
- Prior UI snapshots and batch-import backups were moved under `ui/SonicUI/diagnostics/deep-research-backup/`; contents were preserved.
- `node_modules/`, current `dist-sonic/`, all existing deliverables, source files, tests, lockfiles and historical diagnostic/user-data backups were preserved.
- Root `diagnostics/` and UI `diagnostics/` intentionally retain historical logs, test evidence and recovery backups. They are not disposable caches.

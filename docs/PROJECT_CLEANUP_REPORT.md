# Project Cleanup Report

## 2026-10-20 — Source organization

- Renamed the active UI project directory to `ui/SonicUI`.
- Removed archived duplicate UI/reference source copies that were no longer needed in the working project.
- Renamed the archived UI build directory to a neutral historical name.
- Removed obsolete static-site assets and external-project research notes; retained release metadata helpers in `ui/SonicUI/docs/`.
- Added a root README documenting the active source map.

## 2026-10-22 — Generated output and diagnostics

- Removed regeneratable .NET `bin/` and `obj/` directories under `src/`, preserving packaged .NET outputs under local artifacts.
- Removed Electron/Vite `out/`, Playwright `test-results/`, and `.eslintcache` from the UI working tree.
- Moved the older UI output intact to a historical archive location instead of deleting it.
- Centralized old UI snapshots and batch-import backups under UI diagnostics.
- Added root and UI `.gitignore` rules for generated .NET/Electron output and test reports.
- Added `docs/PROJECT_STRUCTURE.md` to describe active source paths and directory responsibilities.
- Preserved active source, package lockfiles, installers, historical archives, and diagnostic/user-data backups.

## 2026-10-24 — Repository presentation cleanup

- Reworked the root README into a product-oriented project overview with features, architecture, setup, build/test commands, security guidance, and licensing links.
- Removed the obsolete root helper scripts `build-core.ps1`, `build-preview.ps1`, and `build-cli-queue.ps1`. Their underlying source projects and test projects remain in the repository; build commands are now documented in the README.
- Updated the project structure guide to match the tracked source tree.

## Validation notes

- The UI's TypeScript check previously passed for node, web, E2E, and extension projects. Re-run checks after source changes and before release.
- Network-dependent end-to-end tests require a suitable non-loopback LAN setup; skipped tests must be reported separately from passed tests.
- Release readiness requires dependency/security review, complete third-party notices, an SBOM generated from the staged package, packaging checks, and verification of signing state. A successful source build alone is not a release certification.

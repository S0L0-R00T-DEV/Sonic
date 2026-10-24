# Project Cleanup Report — 2026-10-20

## Completed
- Renamed the active UI project directory to `ui/SonicUI`.
- Removed archived duplicate UI/reference source copies that were no longer needed in the working project.
- Renamed the archived UI build directory to a neutral historical name.
- Removed external repository URLs and former source-project names from editable project documentation and source text.
- Removed obsolete static-site assets and external-project research notes; retained only the release metadata helpers in `ui/SonicUI/docs/`.
- Added a root README that documents the active source map.

## Preserved
Active application source, build scripts, existing release artifacts, and dependency lockfiles were preserved. Legally required third-party license/notice files must remain when required by the licenses of code or dependencies shipped with the application.

## Validation
The UI TypeScript check previously completed successfully. Re-run typecheck/build after any further source edits before producing a release. The app's persistent black-square issue remains a separate unresolved defect.


## Additional cleanup — 2026-10-22

- Inspected the root project and active UI project. Neither folder is currently a Git repository; no Git status/diff protection is available.
- Removed regeneratable .NET `bin/` and `obj/` directories under `src/` (2,639 files total), preserving packaged .NET outputs under `artifacts/`.
- Removed Electron/Vite `out/`, Playwright `test-results/`, and `.eslintcache` from `ui/SonicUI/`.
- Moved the older `ui/SonicUI/dist/` tree intact to `artifacts/archive/historical-ui-dist-20261019/`. It contained older installers and unpacked output; it was preserved, not deleted. Current packager output remains in `ui/SonicUI/dist-sonic/`.
- Moved the old UI source snapshot and batch-import backup under `ui/SonicUI/diagnostics/deep-research-backup/` to centralize backups without deleting them.
- Added root `.gitignore` rules for generated .NET/Electron output and updated UI `.gitignore` to include `dist-sonic/` and `playwright-report/`.
- Added `docs/PROJECT_STRUCTURE.md` with the active source tree and the purpose of key directories.
- Preserved all active source files, package lockfile, current UI installer, .NET deliverables, historical archives, and large diagnostic/user-data backups.
- Exact actions recorded in `diagnostics/project-cleanup-20261022.log`.

### Post-cleanup verification still required

- Verify final tree and preserved installer paths.
- Run UI typecheck and a core smoke test. The .NET `bin/` and `obj/` caches were intentionally removed, so a .NET build will recreate them; the cleanup itself did not modify source code.

- Post-cleanup verification completed: UI `npm run typecheck` passed for node, web, E2E, and extension projects; all 11 path/preservation checks passed.
- Removed 2,639 generated .NET build files (approximately 923 MB); no `src/**/bin` or `src/**/obj` directories remain. These are regenerated on the next .NET build.

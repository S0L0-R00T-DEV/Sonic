# Sonic CLI Usage and Verification

Audit date: 2026-10-27
CLI executable used for smoke tests: `artifacts/sonic-cli-win-x64/SpeedOFreq.Cli.exe`
Application version observed through the live CLI: `1.0.1`
Control protocol: `SpeedOFreqSonic.AppControl.v2`

## Command-count summary

The command catalog returned by the running application and checked against the source contains:

- **44 canonical application commands**.
- **23 aliases** for existing commands.
- **67 application command names** when canonical commands and aliases are counted together.
- **6 help/version spellings**: `help`, `--help`, `-h`, `version`, `--version`, `-v`.
- **73 distinct command tokens** including help/version spellings. The global options `--no-launch` and `--compact` are options, not commands.
- **77 checklist test cases**. This is the number of test rows, not the number of commands.

The removed `link-resume` command is not part of the current catalog. Pending links can be listed with `links` and dismissed with `link-dismiss`; do not use documentation for the removed command.

### Canonical commands by group

| Group | Count | Commands |
|---|---:|---|
| Discovery | 4 | `health`, `capabilities`, `status`, `recovery` |
| Downloads | 18 | `download-stats`, `downloads`, `analyze`, `add-batch`, `add`, `start`, `pause`, `resume`, `cancel`, `pause-all`, `resume-all`, `cancel-all`, `remove`, `open`, `reveal`, `torrent-files`, `choose-torrent-files`, `download-network` |
| History | 3 | `history`, `history-clear`, `history-delete` |
| Settings | 9 | `settings`, `settings-set`, `theme`, `slow-mode`, `speed-unit`, `speed-limit`, `slow-mode-speed`, `downloads-at-once`, `destination` |
| Network | 6 | `interfaces`, `networks`, `network-usage`, `network-reset`, `network-pref`, `free-space` |
| Links and window | 4 | `links`, `link-dismiss`, `window`, `clipboard` |
| **Total** | **44** | |

### Alias catalog

The 23 aliases are:

`ping`, `commands`, `command-list`, `list-commands`, `app-status`, `recovery-issues`, `settings-get`, `config`, `mode`, `destination-dir`, `list`, `download-list`, `history-list`, `clear-history`, `history-clear-all`, `delete-history`, `download`, `download-add`, `probe`, `queue-start`, `download-remove`, `reset-network-usage`, `links-list`.

## Current verification status

- **77/77 checklist rows are marked PASS** in the desktop acceptance checklist.
- **0 rows are marked FAIL** and **0 rows are marked skipped/not tested** in that checklist.
- A live smoke test of `health`, `ping`, `capabilities`, `commands`, `command-list`, and `list-commands` returned valid JSON with exit code 0.
- `SpeedOFreq.Cli.exe --help` returned help successfully with exit code 0.
- `npm run build` completed successfully during the audit and again after formatting the changed TypeScript files.
- `npm run lint` completed with exit code 0 and no remaining warnings after formatting.
- The CLI .NET Release build completed with 0 warnings and 0 errors.
- Unpacked Windows packaging was verified. A signed release still requires a valid signing certificate and the release signing configuration.

**Interpretation:** the 77/77 figure is the result recorded in the manual acceptance checklist. It is not a claim that every option combination, failure mode, or real-world transfer scenario has been exhaustively tested, and the checklist is not an automated 77-test CLI test suite.

## Important remaining caveats

The following edge cases were not fully established end-to-end during the audit:

1. `remove --trash-file on` returned success, but the file-removal effect could not be confirmed because the disposable transfer did not create a file.
2. Magnet-add testing used cached/local torrent metadata. Successful discovery and transfer from reachable live peers were not established.
3. The destination argument was accepted by `add` and a queue row was returned, but the resulting destination binding was not independently verified end-to-end.
4. Some history operations were verified using a synthetic completed-history fixture. A successful HTTP fixture download was also tested separately, but that does not certify every transfer scenario.
5. `history-clear` was tested against an isolated empty history. The earlier live-profile incident was not repeated.
6. During development startup, the browser bridge reported that ports 19288, 19289, and 19290 were already occupied. The CLI control endpoint still became ready; the port conflict should be investigated if browser integration behaves unexpectedly.

These are scope limitations, not failed checklist rows. Do not describe the application as fully release-certified on the basis of the checklist alone.

## Basic usage

Run commands from a terminal with Sonic installed or with the CLI executable available.

```powershell
# Show usage and command-line options
.\SpeedOFreq.Cli.exe --help

# Print CLI version and protocol
.\SpeedOFreq.Cli.exe --version

# Check application health without starting Sonic
.\SpeedOFreq.Cli.exe health --no-launch

# Get the full machine-readable command catalog
.\SpeedOFreq.Cli.exe capabilities --compact

# List downloads
.\SpeedOFreq.Cli.exe downloads

# Add a URL
.\SpeedOFreq.Cli.exe add --url "https://example.com/file.zip"

# Add a batch from a JSON file (avoids Windows PowerShell JSON quoting issues)
.\SpeedOFreq.Cli.exe add-batch --json-file ".\downloads.json"

# Update a setting from a JSON file
.\SpeedOFreq.Cli.exe settings-set --json-file ".\settings-patch.json"
```

### Global options

- `--no-launch`: fail if Sonic is not already running; do not auto-launch it.
- `--compact`: emit compact, single-line JSON output.
- `--help`, `-h`, `help`: print CLI help.
- `--version`, `-v`, `version`: print CLI version and protocol.

Commands communicate with the local Sonic application through a Windows named pipe; the CLI endpoint is not a LAN listener. If the app is not running, the CLI attempts to launch Sonic unless `--no-launch` is specified.

## Build and release notes

From the repository root, run:

```powershell
.\build.ps1
```

For Electron UI development:

```powershell
Set-Location .\ui\SonicUI
npm ci
npm run dev
```

A successful development build does not itself certify a production release. Before publishing a release, run the current build and test workflow, verify download completion against appropriate real sources, review security and third-party notices, and complete code signing with the configured certificate.

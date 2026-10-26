# Sonic CLI Usage

The CLI controls the **running Sonic desktop application** through a local Windows named pipe; it does not expose this control endpoint on the LAN. Launch Sonic normally first. Commands return JSON on success; failures return a non-zero exit code and an error on stderr.

The CLI source is in `src/SpeedOFreq.Cli`. Its executable is currently named `SpeedOFreq.Cli.exe` for compatibility with the existing project and scripts.

## Download state and history

```powershell
SpeedOFreq.Cli.exe status
SpeedOFreq.Cli.exe downloads
SpeedOFreq.Cli.exe history
SpeedOFreq.Cli.exe recovery-issues
```

Status reports the current app mode, speed units, limits, slow mode, live status counts, download metadata, finished-history count and saved-state recovery warnings. A recovery warning means data was retained for investigation rather than automatically deleted.

## Add and inspect downloads

```powershell
SpeedOFreq.Cli.exe analyze --url "https://example.com/file.zip"
SpeedOFreq.Cli.exe add --url "https://example.com/file.zip"
SpeedOFreq.Cli.exe add --url "https://example.com/file.zip" --destination-dir "T:\Downloads" --name "Example.zip"
SpeedOFreq.Cli.exe add --url "magnet:?xt=urn:btih:..."
SpeedOFreq.Cli.exe add --url "T:\Torrents\example.torrent" --destination-dir "T:\Downloads"
SpeedOFreq.Cli.exe add --url "T:\Torrents\bundle.torrent" --files 0,2 --interfaces "Wi-Fi"
```

Supported sources include HTTP(S), magnet links and local `.torrent` files. Magnet links require discoverable metadata and may fail if no peers provide it. `analyze` inspects a link without starting it. `--destination-dir` selects a folder, `--destination` an exact output path, `--name` overrides the suggested name, `--interfaces` selects adapter IDs, and `--files` selects zero-based torrent file indexes.

## Control downloads

```powershell
SpeedOFreq.Cli.exe pause --id "<download-id>"
SpeedOFreq.Cli.exe resume --id "<download-id>"
SpeedOFreq.Cli.exe cancel --id "<download-id>"
SpeedOFreq.Cli.exe pause-all
SpeedOFreq.Cli.exe resume-all
SpeedOFreq.Cli.exe cancel-all
SpeedOFreq.Cli.exe torrent-files --id "<torrent-id>"
SpeedOFreq.Cli.exe choose-torrent-files --id "<torrent-id>" --files 0,2
SpeedOFreq.Cli.exe download-network --id "<download-id>" --network-id "Wi-Fi" --enabled off
SpeedOFreq.Cli.exe open --id "<download-id>"
SpeedOFreq.Cli.exe reveal --id "<download-id>"
```

Pause and resume operate on the actual download manager. Resume reports the resulting state after file verification. Cancel stops the transfer but does not automatically remove its row. Cancel an active transfer before removing it if you intend to keep partial data.

## History and removal

```powershell
SpeedOFreq.Cli.exe history-delete --id "<finished-download-id>"
SpeedOFreq.Cli.exe history-clear
SpeedOFreq.Cli.exe remove --id "<download-id>"
SpeedOFreq.Cli.exe remove --id "<finished-download-id>" --trash-file on
```

History deletion removes records, not downloaded files. `remove` removes a row; finished files are kept by default. `--trash-file on` explicitly moves a supported finished file to the system trash. Aliases include `history delete <id>`, `history clear`, `clear-history`, and `delete-history --id <id>`.

## Theme, speed and settings

```powershell
SpeedOFreq.Cli.exe theme sonic
SpeedOFreq.Cli.exe theme light
SpeedOFreq.Cli.exe theme dark
SpeedOFreq.Cli.exe slow-mode status
SpeedOFreq.Cli.exe slow-mode on
SpeedOFreq.Cli.exe slow-mode off
SpeedOFreq.Cli.exe slow-mode toggle
SpeedOFreq.Cli.exe slow-mode-speed --value 2 --unit MiB/s
SpeedOFreq.Cli.exe speed-unit bytes
SpeedOFreq.Cli.exe speed-unit bits
SpeedOFreq.Cli.exe speed-limit --value 20 --unit Mbps
SpeedOFreq.Cli.exe speed-limit --value off
SpeedOFreq.Cli.exe downloads-at-once 3
SpeedOFreq.Cli.exe destination --path "T:\Downloads"
SpeedOFreq.Cli.exe settings
SpeedOFreq.Cli.exe settings-set --key themeSource --value sonic
SpeedOFreq.Cli.exe settings-set --json "{\"themeSource\":\"sonic\",\"speedUnit\":\"bytes\",\"slowMode\":false}"
```

Sonic is the default theme; the modes are `sonic`, `light`, and `dark`. Bytes mode displays MB/s; bits mode displays Mbps. The display-unit switch does not change the underlying transfer rate. Speed caps accept B/s, KB/s, KiB/s, MB/s, MiB/s, GB/s, GiB/s, Kbps, Mbps and Gbps, and are stored as bytes per second.

Supported settings include `themeSource`, `speedUnit`, `slowMode`, `slowModeSpeed`, `speedLimit`, `downloadsAtOnce`, `destinationDir`, `downloadSchedule`, `networkPreferences` and `browserExtensionUsed`. Use `settings-set --json` for structured schedules or per-network preferences.

## Network, pending links and window controls

```powershell
SpeedOFreq.Cli.exe interfaces
SpeedOFreq.Cli.exe network-usage
SpeedOFreq.Cli.exe network-reset --id "Wi-Fi"
SpeedOFreq.Cli.exe network-pref --id "Wi-Fi" --off on
SpeedOFreq.Cli.exe network-pref --id "Wi-Fi" --name "Home Wi-Fi" --network-speed-limit 20 --unit Mbps
SpeedOFreq.Cli.exe network-pref --id "Wi-Fi" --data-limit-bytes 10737418240 --period month
SpeedOFreq.Cli.exe links
SpeedOFreq.Cli.exe link-dismiss --id "<pending-link-id>"
SpeedOFreq.Cli.exe link-resume --link-id "<pending-link-id>" --download-id "<download-id>"
SpeedOFreq.Cli.exe free-space --path "T:\Downloads"
SpeedOFreq.Cli.exe window --action minimize
SpeedOFreq.Cli.exe window --action maximize
SpeedOFreq.Cli.exe window --action show
SpeedOFreq.Cli.exe window --action close
SpeedOFreq.Cli.exe clipboard
```

Use `--off on` or `--off off` to disable or re-enable a network preference. Network IDs come from `interfaces`. `window --action close` closes the desktop application; use it deliberately.

## Build

Run `.\build.ps1` from the repository root to build the Windows desktop application and CLI. The build requires .NET 10, Node.js/npm, and Windows. Do not copy only the CLI executable from a framework-dependent output; use the full published output or the self-contained build produced by the build process.


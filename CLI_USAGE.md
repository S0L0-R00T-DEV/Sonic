# Speed-o'-Freq Sonic CLI

The CLI controls the **running Sonic desktop application**. It uses a local Windows named pipe and does not expose the control endpoint on the LAN. Launch Sonic normally first. Commands return JSON on success; failures return a non-zero exit code and an error on stderr.

## Download state and history

    SpeedOFreq.Cli.exe status
    SpeedOFreq.Cli.exe downloads
    SpeedOFreq.Cli.exe history
    SpeedOFreq.Cli.exe recovery-issues

Status reports the current app mode, speed units, speed limits, slow mode, counts by live status, current download metadata, finished-history count and saved-state recovery warnings. A recovery warning means the data was retained for investigation rather than automatically deleted.

## Add and inspect downloads

    SpeedOFreq.Cli.exe analyze --url "https://example.com/file.zip"
    SpeedOFreq.Cli.exe add --url "https://example.com/file.zip"
    SpeedOFreq.Cli.exe add --url "https://example.com/file.zip" --destination-dir "T:\Downloads" --name "Example.zip"
    SpeedOFreq.Cli.exe add --url "magnet:?xt=urn:btih:..."
    SpeedOFreq.Cli.exe add --url "T:\Torrents\example.torrent" --destination-dir "T:\Downloads"
    SpeedOFreq.Cli.exe add --url "T:\Torrents\bundle.torrent" --files 0,2 --interfaces "Wi-Fi"

Supported sources are HTTP(S) links, magnet links, and local .torrent files. Torrent magnet links need discoverable metadata; a link may fail if no peers provide it. Analyze inspects a link without starting it. Use --destination-dir for a folder, --destination for an exact output path, --name to override the suggested file/folder name, --interfaces to select adapter IDs, and --files to select torrent file indexes.

## Control downloads

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

Pause and resume apply to the app's actual download manager. Resume returns the resulting state after its file verification phase. Cancel stops the transfer; it does not automatically remove its row. Torrent-file indexes are zero-based.

## History and removal

    SpeedOFreq.Cli.exe history-delete --id "<finished-download-id>"
    SpeedOFreq.Cli.exe history-clear
    SpeedOFreq.Cli.exe remove --id "<download-id>"
    SpeedOFreq.Cli.exe remove --id "<finished-download-id>" --trash-file on

history-delete forgets one finished history record, and history-clear forgets all finished records. Neither deletes the downloaded file. remove deletes a download/history row; a finished file is kept by default. --trash-file on explicitly moves a supported finished file to the system trash. Cancel an active transfer before removing it if you intend to keep the partial data.

Aliases also work: history delete <id>, history clear, clear-history, and delete-history --id <id>.

## Modes, speeds, and settings

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

Sonic is the default theme. The three modes are sonic, light, and dark. Speed-unit bytes displays MB/s; bits displays Mbps. The unit switch changes display only, not the underlying rate. Speed caps accept B/s, KB/s, KiB/s, MB/s, MiB/s, GB/s, GiB/s, Kbps, Mbps and Gbps; caps are stored internally as bytes per second. Setting changes are persisted and applied to the running application.

Supported app settings include themeSource, speedUnit, slowMode, slowModeSpeed, speedLimit, downloadsAtOnce, destinationDir, downloadSchedule, networkPreferences and browserExtensionUsed. Use settings-set --json for structured download schedules or per-network preferences.

## Network and window controls

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

Use --off on or off to disable or re-enable a network preference. Network IDs are the interface IDs returned by interfaces. Closing the window closes the desktop application, so use that command deliberately.

## Build notes

The app UI/backend TypeScript build is run from ui/SonicUI with npm run build. The Windows CLI executable is built from src/SpeedOFreq.Cli and then copied into artifacts/cli-queue-20261018/win-x64/cli. The executable must stay with its runtime files; do not copy only the EXE. The installer remains a separate final packaging step.

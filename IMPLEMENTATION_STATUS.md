# Speed-o'-Freq Sonic â€” Implementation Status

Updated: 2026-10-18

## Current milestone: WPF downloader + CLI queue prototype

The dependency-free .NET 10 core at `src/SpeedOFreq.Core` powers the WPF GUI at `src/SpeedOFreq.App`. The GUI has a current-user-only local CLI control pipe and a three-slot concurrent download queue. This remains a prototype: there is no production installer/updater, queue persistence, or production release certification.

### Implemented and locally smoke-tested

- HTTP and HTTPS URL validation; URL-embedded credentials are rejected.
- A one-byte range probe to detect byte-range support.
- Automatic single-stream fallback when the server answers the range probe with HTTP 200.
- Parallel byte-range requests with exact Content-Range, body-length, and total-length validation.
- Source-bound sockets now bind the selected local IP and set Windows IP_UNICAST_IF/IPV6_UNICAST_IF from the matching adapter index; DNS results are filtered to the socket address family. This was necessary because source-IP binding alone failed on a multihomed host with two default routes. System proxy use is disabled for source-bound requests.
- Multi-path prototype: multiple source addresses each have an independent HttpClient/connection pool; range requests and retries round-robin across the configured source addresses. Retry attempts naturally move to another path. This is connection-level range scheduling, not packet-level bonding.
- WPF path selector now allows checking one or more active non-loopback IPv4 addresses, refreshes addresses after DHCP changes, and preserves selections that remain valid; leaving all unchecked uses the Windows default route. The UI warns that throughput gains require independent internet paths.
- Bounded retry/backoff for network failures, HTTP 5xx, HTTP 408 and HTTP 429 during both the range probe and chunk fetches.
- Durable per-chunk checkpoint metadata written through a temporary file and atomic rename.
- Resume only when the source has a matching ETag or Last-Modified validator, URL fingerprint, size, and chunk configuration; the full source URL is not written into checkpoint metadata.
- HTTPS-to-HTTP redirect downgrade rejection; bounded redirect count.
- SHA-256 calculation before final publication.
- Final output is published from a same-directory partial file after successful completion.
- WPF preview UI includes direct URL input, destination picker, parallelism/chunk-size choices, a checkbox list for one or more IPv4 source addresses (empty selection means default route), dark/light theme toggle, progress, cancellation, SHA-256 display, and open-folder action.
- Historical framework-dependent preview builds are under `artifacts/preview`. Current self-contained GUI + CLI packages are under `artifacts/cli-queue-20261018/win-x64` and `artifacts/cli-queue-20261018/win-arm64`; keep each package's files together. ARM64 was cross-published on an x64 host, not tested on ARM64 hardware.

### Smoke test results

Command: dotnet run --project tests/SpeedOFreq.Core.Smoke/SpeedOFreq.Core.Smoke.csproj -c Release

Passed:
1. Parallel byte ranges with exact SHA-256.
2. Automatic single-stream fallback for an origin that ignores Range.
3. Relative HTTP redirect handling.
4. Retry of an injected transient HTTP 503 during the range probe.
5. Source ETag mutation rejection before final publication.
6. Zero-byte file handling with the empty-content SHA-256.
7. Local source-address binding to an active non-loopback IPv4 address.
8. Retry of an injected transient HTTP 503 during chunk fetch.
9. Persistent range failure, durable checkpoint retention, resumed completion, and exact SHA-256.
10. Corrupt checkpoint metadata rejection and safe restart.
11. Round-robin scheduling across two local source addresses, verified by a local server observing both source IPs and checking final SHA-256 (loopback-only scheduler test).
12. Retry/failover after a synthetic stale/unassigned source-address bind failure, with the next configured path completing the download.

### External two-interface functional test (separate from smoke suite)

Wi-Fi and USB-tethered Remote NDIS independently reached the same public HTTPS range origin. The Sonic core downloaded a 331,243-byte, six-chunk file with ranges enabled, matched the SHA-256 of a separate full-file baseline, and both adapter counters increased. Details and limitations are recorded in Phase0/TWO_PATH_TEST_REPORT.md. This is a multi-interface functional test, not a throughput benchmark.

The core library also published successfully for win-x64 and win-arm64 with --self-contained false. ARM64 was cross-published on the x64 machine, not executed on ARM64 hardware.

These are local deterministic tests. They do not establish real two-WAN aggregation or production readiness.

## Known limitations and next engineering tasks

- A multi-download queue manager and CLI control layer now exist; queue state is in-memory and is not restored after restart. No production installer/updater, remote control listener, telemetry service, or production release packaging.
- The round-robin multi-path scheduler now applies a five-second cooldown to a path after transport-level failures, while HTTP 5xx responses do not mark a path unhealthy. Adaptive throughput weighting, per-interface health metrics, independent path throughput measurement, and detailed path-failure reporting are not yet implemented. The UI currently offers IPv4 source addresses only.
- No authentication UI/cookie support, browser capture, game platform integration, torrents, or media extractors.
- Relative redirects and ETag changes during a download have smoke coverage; HTTPS downgrade, long redirect chains, and more source-mutation cases need dedicated tests.
- No configurable overall/idle download timeout, bandwidth policy, adaptive chunk sizing, or structured downloader diagnostic log.
- Added Steam behavior research in STEAM_RESEARCH.md and a non-invasive local capture script at diagnostics/Capture-SteamActivity.ps1. The capture now discovers Steam processes by PID using Get-Process and correlates established TCP connections. A 60-second active capture detected Steam in 26/26 samples and recorded external Steam connections on the USB-tether source IP, not Wi-Fi. Adapter throughput and disk rates remain machine-wide, not per-process network attribution; a synchronized high-rate throughput capture is still needed.
- Disk-full, forced process termination at each checkpoint boundary, destination replacement behavior, and crash recovery need fault-injection tests.
- No third-party dependencies are used by the core today; produce an SBOM and notices for the complete application when dependencies are introduced.
- Windows 10 support policy and actual Windows ARM64 hardware validation remain unresolved.
- A basic two-interface functional test passed on Wi-Fi plus USB-tethered mobile internet. A deterministic synthetic test now injects an HTTP 503 for one configured source address on a mid-download chunk and verifies retry via the alternate source address and matching final SHA-256. Actual physical NIC loss during a live WAN transfer remains untested, and a larger controlled throughput benchmark remains required before making aggregation-performance claims.
- The exact uMerge project identity is still unknown; do not substitute another similarly named project.

## Engineering gate

Continue developing the core behind deterministic tests, but do not describe this prototype as a finished downloader, claim universal system-wide bonding, or produce a production installer until HTTP correctness, crash recovery, independent-WAN validation, Windows compatibility, and security review are complete.


## Additional review â€” network scheduling research (2026-10-17)


The latest 180-second Steam capture is documented in STEAM_RESEARCH.md. It recorded zero Steam process counters and zero Steam TCP connections in all samples, so it cannot yet diagnose the Steam symptom. Machine-wide physical receive counters rose by roughly 197 MiB, mostly on the USB-tether adapter, but traffic cannot be attributed to Steam from adapter totals alone.


## Validation update â€” 2026-10-17 (post-Steam diagnostics)

- Rebuilt the WPF preview and re-published both framework-dependent targets with `build-preview.ps1`. Final run completed with 0 warnings and 0 errors; x64 and ARM64 publish directories were recreated.
- The smoke suite now has 14 passing scenarios, adding (a) a synthetic per-path mid-download chunk failure that retries via the alternate configured source address, and (b) final-publication conflict recovery that preserves the partial/checkpoint and completes after the conflict is removed. All final hashes matched the deterministic 2 MiB fixture.
- NuGet inventory and vulnerability checks were run for Core, WPF App, and Smoke test projects. No package references were found in these projects and NuGet reported no vulnerable packages from the configured nuget.org source. This is not a Windows/.NET runtime vulnerability audit and does not replace a full SBOM.
- Preview executable hashes after the final rebuild:
  - `artifacts/preview/win-x64/SpeedOFreq.exe` SHA-256: `2123A263D25A6A30E2BAA86821D7DA56F7418EB0FB5A6FB30CEDC1C34AC6F422`
  - `artifacts/preview/win-arm64/SpeedOFreq.exe` SHA-256: `8A1D0B2771A1F9F6588E5E1211FBB2D0091CDD3C8E7591E114EDE93ECD1AE9AB`
- The Cloudflare speed-test endpoint was rejected because it ignored Range. A 10 MiB OVH static file was then range-verified and downloaded by Sonic with both source addresses configured; the final SHA-256 matched an independent full-file baseline. Adapter counters were heavily contaminated by concurrent Steam/background traffic, so this is a larger functional test, not a controlled throughput benchmark. Details: Phase0/TWO_PATH_TEST_REPORT.md.
- Steam's active 60-second capture detected Steam in 26/26 samples. All observed external Steam TCP connections used the USB-tether source address `10.47.187.251`; Wi-Fi showed negligible receive traffic during that capture. Adapter counters are machine-wide and the capture average was about 2.10 MiB/s, below the user's earlier reported 23 MB/s. A synchronized capture during a sustained high-rate period is still needed.
- No production installer was created. The current output is a preview publish that requires the .NET 10 Windows Desktop Runtime.

### Remaining release gates

1. Run a controlled, time-aligned throughput benchmark against the validated 10 MiB range-enabled origin over both independent internet paths, with no concurrent large Steam/background transfer; the current run's adapter counters were contaminated.
2. Test real physical adapter loss during an active WAN download without risking the remote desktop session; the current test is synthetic HTTP failure injection.
3. Test disk-full behavior and forced process termination at checkpoint/publication boundaries.
4. Add dedicated HTTPS downgrade, redirect-chain, broader source mutation, and timeout tests.
5. Decide Windows 10 support policy and validate on physical Windows ARM64 hardware.
6. Complete release security review, runtime servicing policy, SBOM/notices, installer and recovery/uninstall testing before any production release.


## Engineering improvements â€” 2026-10-18

### Applied and verified
- Removed the non-functional "DIRECT DOWNLOAD CORE" subtitle and decorative "DARK MODE" header badge; the UI remains a consistent dark theme without implying the badge is a working control.
- Added a persistent "Last Download Summary" panel displaying terminal status, full destination, finalized size when available, exact bytes received during the session, start/finish timestamps, end-to-end elapsed time, average and sampled peak speeds, retries, resume state, diagnostic details, and SHA-256 on success.
- Final telemetry is frozen into the completion summary instead of relying on the live speed display, which is reset to zero after the transfer.
- Corrected the MB/s display to decimal megabytes per second (1 MB = 1,000,000 bytes); Mbps remains decimal megabits per second.
- Unknown-length transfers keep an indeterminate progress bar while transfer progress updates continue.
- Download URL/destination/tuning controls are disabled while a transfer is active to prevent configuration changes from misrepresenting the running transfer.
- Destination paths are normalized before starting. Existing files require explicit confirmation (default is No); the original file remains present unless the user approves replacement and the download reaches publication.
- Retry count is exposed by the core engine and reflected while the transfer is active.
- A server that refuses the one-byte Range probe with HTTP 400/405/501 (or a non-empty-file 416 response) now gets a normal-GET fallback attempt. A server returning 200 to the Range probe continues using the existing single-stream path.
- Removed an obsolete, unreferenced progress-speed updater to reduce duplicate telemetry paths.

### Validation performed on the Windows development machine
- Release WPF build: passed, 0 warnings, 0 errors.
- Core smoke suite: all 15 scenarios passed, including a new regression scenario where the test origin rejects Range with HTTP 405 but serves normal GET correctly.
- Self-contained publish completed for win-x64 and win-arm64. Copied outputs are under `artifacts/verified-improved-20261018/win-x64` and `artifacts/verified-improved-20261018/win-arm64`; the existing `artifacts/EXE output` was not replaced.
- ARM64 was cross-published on an x64 development machine and has not been executed on physical ARM64 hardware. This is a prototype build, not a production-installer/release certification.

### Remaining engineering/release gates
- Physical WAN link-loss testing, controlled independent-WAN throughput benchmarking, Windows ARM64 execution validation, disk-full/crash-recovery fault injection, broader timeout/redirect/TLS tests, and a full application SBOM/release security review remain outstanding.
- There is still no production installer/updater, browser capture, persistent multi-download queue, or completed history store. Do not describe the prototype as a production-ready download manager or universal system-wide network bonding solution.


### Final package verification â€” 2026-10-18
- Final compile after the last UI lockout fix: Release build succeeded with 0 warnings and 0 errors.
- Final regression run: all 15 core smoke scenarios passed.
- Published output app/core DLL SHA-256 hashes match between each runtime-specific publish folder and the copied verification package.
- win-x64 executable: 162,304 bytes; SHA-256 `2123A263D25A6A30E2BAA86821D7DA56F7418EB0FB5A6FB30CEDC1C34AC6F422`.
- win-arm64 executable: 139,776 bytes; SHA-256 `8A1D0B2771A1F9F6588E5E1211FBB2D0091CDD3C8E7591E114EDE93ECD1AE9AB`.
- The old `artifacts/EXE output` was preserved. The verified package is in `artifacts/verified-improved-20261018`.


## CLI control and concurrent queue â€” 2026-10-18

### Implemented in source
- Added a separate console CLI project at `src/SpeedOFreq.Cli`. It exposes `status`, `analyze`, `add`, `download`, `list`, `start`, and `cancel`, with JSON responses and non-zero exit codes on errors.
- The WPF GUI starts a local named-pipe control endpoint while running. The pipe uses Windows current-user-only access and does not listen on the LAN.
- The CLI can launch the GUI from the package root when it cannot connect to the pipe.
- Added a visible download queue with item IDs, URL, destination, status, per-file progress, speed, retries, and completion details/SHA-256.
- Up to three queue items are downloaded concurrently. Each item uses the existing chunked downloader, retries, checkpoint/resume support, and the GUI's current per-file parallelism/chunk-size and selected source-address settings.
- Added safe queue behavior: reject duplicate active destinations and existing files rather than silently overwrite; cancellation is per queue item.
- Added `CLI_USAGE.md` and `build-cli-queue.ps1` for publishing architecture-specific packages.

### Validation status â€” completed on 2026-10-18
- Release GUI build and CLI build both succeeded with 0 warnings and 0 errors.
- Existing Core smoke suite: 15/15 scenarios passed.
- Self-contained packages successfully published for win-x64 and win-arm64. ARM64 was cross-published on the x64 development machine and has not been executed on ARM64 hardware.
- Published CLI --help and status tested; CLI status automatically launched the GUI when no new-package instance was running.
- CLI analyze tested against a local HTTP fixture and returned filename, content type, size, status code, and range support.
- CLI add/list/cancel tested with two queue entries; both appeared in the same queue and cancellation state was reflected.
- Concurrent queue integration test used two throttled 16 MiB local HTTP downloads. Both were observed in Running state at the same time, both reached Completed, and both destination SHA-256 values matched their respective fixture files.
- Existing-destination safety tested: queue add rejected the existing file and returned exit code 1. No existing file was overwritten.
- A single-instance mutex was added after initial testing exposed that multiple GUI instances could each hold a separate in-memory queue. The packaged build was retested with one new-package GUI instance.
- Package outputs:
  - `artifacts/cli-queue-20261018/win-x64/SpeedOFreq.exe`
  - `artifacts/cli-queue-20261018/win-x64/cli/SpeedOFreq.Cli.exe`
  - `artifacts/cli-queue-20261018/win-arm64/SpeedOFreq.exe`
  - `artifacts/cli-queue-20261018/win-arm64/cli/SpeedOFreq.Cli.exe`
- Queue contents are in memory only and are not restored after GUI restart. The existing single-download GUI path remains separate from queue items.
- Queue concurrency is currently fixed at three simultaneous files. Total HTTP connections may be higher because each file also uses parallel range requests.
- Physical ARM64 validation, crash/disk-full fault injection, WAN benchmarks, and broader release/security validation remain outstanding.

## Real-download assessment and queue refinements â€” 2026-10-18

### Observed on the rebuilt x64 package
- An earlier supplied URL was analyzed but not downloaded because the server identified it as a GTA V repack archive. Testing continued with legitimate public test fixtures.
- Downloaded the 100 MiB public test ZIP through the app queue. The file size was 104,857,792 bytes and SHA-256 was `DDE866CDD9D1AFC8E1E511228BFEA08C8F8CE5B850BB85F6945ED1B65C604B8A`, matching the publisher's published checksum. The earlier test harness had a mistyped expected hash string; the actual file hash matches the correct published value.
- Rebuilt package downloaded a 10 MiB zero-data test file through the CLI/GUI queue. It completed in 98.28 seconds, with 0 retries, average measured wire throughput 0.11 MB/s and sampled peak 0.23 MB/s. SHA-256 matched a locally generated 10 MiB all-zero fixture. This endpoint was slow; the result is a functional transfer/integrity test, not a controlled bandwidth benchmark.
- While that download was active, `clear` removed zero items and left the active transfer untouched.
- `remove --id` removed a completed queue item. A reserved invalid DNS name produced a failed item with the underlying DNS failure now visible in the diagnostic chain; `clear` then removed that finished item and the queue returned to zero.
- Queue status now includes start/finish timestamps, elapsed seconds, average and peak bytes/second. Queue speed is smoothed over a rolling five-second window; final speed is set to measured average.
- Added GUI actions for removing the selected finished item and clearing all finished items without canceling active downloads.
- Added CLI commands `remove --id <queue-id>` and `clear`. Failure diagnostics include a bounded chain of inner exception messages.
- GUI and CLI Release builds succeeded with 0 warnings and 0 errors. The existing 15-scenario core smoke suite passed. Self-contained win-x64 and win-arm64 packages were republished under `artifacts/cli-queue-20261018`. ARM64 remains cross-published only.
- New-package CLI help, status, URL analysis, download, remove, and clear were exercised. Current queue was cleared after testing. Test files are retained under `diagnostics/real-world-test` for inspection.

### Interpretation
The app correctly handled range-enabled files and verified final content hashes in the tested cases. Real-world throughput varies by origin and route; the slow 10 MiB endpoint illustrates why a single test cannot establish a reliable maximum-speed claim. Further tests still needed: controlled repeated benchmarks, interrupted network recovery, disk-full/crash injection, and physical ARM64 execution.

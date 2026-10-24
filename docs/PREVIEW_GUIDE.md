# Speed-o'-Freq Sonic Preview Guide

## Launch

Run `artifacts\preview\win-x64\SpeedOFreq.exe` on this x64 Windows machine. The preview is framework-dependent and requires the .NET 10 Windows Desktop Runtime. The ARM64 publish is under `artifacts\preview\win-arm64`, but it has not been executed on ARM64 hardware.

## Try a direct download

1. Paste a direct HTTP(S) file URL. Webpage links that require extraction, login, or JavaScript are not supported in this preview.
2. Choose a destination file.
3. Choose parallelism and chunk size.
4. Leave all network-path checkboxes unchecked to use the Windows default route, or check one or more listed IPv4 addresses.
5. Use Refresh after connecting/disconnecting an adapter or after DHCP changes. An old source IP can become invalid.
6. Start the download. The app shows progress, chunk counts, the final SHA-256, and whether the server allowed byte ranges.

## Multi-interface behavior

The current core distributes separate HTTP range requests across selected source addresses using round-robin scheduling. A path that hits a transport-level failure is temporarily cooled down for five seconds and retries can move to another configured path. This is connection-level path scheduling, not packet-level bonding.

Actual throughput improvement requires independently reachable paths and a server that supports byte ranges. Wi-Fi and Ethernet connected to the same router commonly share the same ISP bottleneck. A server that ignores ranges falls back to one stream and therefore one path for that transfer.

## Diagnose Steam's reported speed

Steam's content update process includes network transfer, chunk reuse, decompression/processing, verification, and local disk I/O. High disk activity alone is not proof of ongoing WAN traffic. No private LanCache DNS signal was found in the baseline capture, but Steam was not running, so the reported symptom remains undiagnosed.

To capture the symptom while Steam is actively downloading, run this from PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File "T:\Projects\Speed-o'-Freq Sonic\diagnostics\Capture-SteamActivity.ps1" -DurationSeconds 180 -IntervalSeconds 2
```

The script creates a timestamped folder under `diagnostics\captures`. Compare physical adapter receive rates with disk activity and Steam process counters. Process I/O counters are not network byte counters. The connection CSV can contain remote IP addresses; review/redact it before sharing.

## Build and tests

From PowerShell:

```powershell
& "T:\Projects\Speed-o'-Freq Sonic\build-preview.ps1"
```

The script builds the WPF app, runs the deterministic core smoke suite, and publishes framework-dependent x64 and ARM64 preview builds.

## Not yet production-ready

No installer has been created. Larger throughput benchmarks, interface-disappearance fault injection, disk-full/crash-consistency tests, Windows 10 policy, and physical ARM64 validation remain open. The current multi-interface test proves functional range distribution and hash correctness on Wi-Fi plus USB tethering; it does not prove a speedup.
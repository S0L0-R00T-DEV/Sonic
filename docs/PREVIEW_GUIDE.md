# Speed-o'-Freq Sonic Preview Guide

## Launch a locally built preview

If a preview package has been staged locally, launch `artifacts\\preview\\win-x64\\SpeedOFreq.exe` on an x64 Windows machine. This framework-dependent preview requires the .NET 10 Windows Desktop Runtime. The ARM64 publish must be validated on ARM64 hardware before being described as tested.

Preview binaries and generated artifacts are not tracked source files. Build them locally using the commands below.

## Try a direct download

1. Paste a direct HTTP(S) file URL. Webpage links that require extraction, login, or JavaScript are not supported by this preview flow.
2. Choose a destination file.
3. Choose parallelism and chunk size.
4. Leave all network-path checkboxes unchecked to use the Windows default route, or select one or more listed IPv4 addresses.
5. Refresh after connecting/disconnecting an adapter or after DHCP changes; a previously selected source IP can become invalid.
6. Start the download. Inspect progress, chunk counts, final SHA-256, and whether the server allowed byte ranges.

## Multi-interface behavior

The .NET core distributes separate HTTP range requests across selected source addresses using round-robin scheduling. A path that hits a transport-level failure is temporarily cooled down, and retries may move to another configured path. This is connection-level path scheduling, not packet-level bonding.

Actual throughput improvement requires independently reachable paths and a server that supports byte ranges. Wi-Fi and Ethernet connected to the same router commonly share the same ISP bottleneck. A server that ignores range requests falls back to one stream and therefore one path for that transfer.

## Diagnose reported Steam speed

Steam's content update process may include network transfer, chunk reuse, decompression, verification, and local disk I/O. High disk activity alone is not proof of ongoing WAN traffic. A prior baseline capture did not diagnose the reported symptom because Steam was not running during that capture.

If you have the local diagnostics capture script, run it while Steam is actively downloading and review the generated CSVs before sharing them. Adapter counters, disk activity, and process I/O counters measure different things; process I/O counters are not network-byte counters. Network captures can contain remote IP addresses, so review and redact them before sharing.

## Build and test from source

Run from the repository root in PowerShell:

```powershell
dotnet build src/SpeedOFreq.App/SpeedOFreq.App.csproj -c Release
dotnet run --project tests/SpeedOFreq.Core.Smoke/SpeedOFreq.Core.Smoke.csproj -c Release
dotnet publish src/SpeedOFreq.App/SpeedOFreq.App.csproj -c Release -r win-x64 --self-contained false
```

The x64 publish output is under `src/SpeedOFreq.App/bin/Release/net10.0-windows/win-x64/publish`. For an ARM64 publish, use `-r win-arm64`; publishing does not replace execution on ARM64 hardware. Copy any output you intend to distribute into a clearly named staging folder under local `artifacts/`, and verify it before sharing.

For the Electron UI and browser extension, follow the build and test commands in the [root README](../README.md).

## Release limitations

A local preview is not a production installer. Throughput benchmarks, interface-disappearance fault injection, disk-full/crash-consistency tests, Windows policy validation, and physical ARM64 validation must be recorded separately. A functional range-distribution test with hash correctness does not by itself prove a speedup.

# SpeedOFreq.Core

A dependency-free .NET 10 HTTP(S) downloader core prototype for Speed-o'-Freq Sonic.

## Basic use

    using SpeedOFreq.Core;

    using var engine = new DownloadEngine();
    var result = await engine.DownloadAsync(new DownloadOptions
    {
        Source = new Uri("https://example.org/file.zip"),
        DestinationPath = @"D:\Downloads\file.zip",
        Parallelism = 4,
        ChunkSizeBytes = 4 * 1024 * 1024,
        RetryCount = 3
    });

    Console.WriteLine($"{result.BytesDownloaded} bytes; SHA-256 {result.Sha256}");

To bind newly opened TCP connections to a chosen local source IP, construct the engine with that address:

    using var engine = new DownloadEngine(IPAddress.Parse("192.0.2.10"));

The address must be assigned to a local interface and be able to reach the origin. Interface binding is not generic packet-level bonding. A scheduler that distributes work over independent interfaces has not yet been implemented.

See the repository-root IMPLEMENTATION_STATUS.md for tested behavior and limitations.

namespace SpeedOFreq.Core;

public sealed record DownloadOptions
{
    public required Uri Source { get; init; }
    public required string DestinationPath { get; init; }
    public int Parallelism { get; init; } = 4;
    public int ChunkSizeBytes { get; init; } = 4 * 1024 * 1024;
    public int RetryCount { get; init; } = 3;
    public BandwidthLimiter? BandwidthLimiter { get; init; }
    public BrowserRequestContext? BrowserContext { get; init; }
    /// <summary>Receives actual body bytes attributed to a source address when the transfer is explicitly bound to it.</summary>
    public Action<string, long>? SourceAddressBytesReceived { get; init; }
    public IReadOnlyDictionary<string, BandwidthLimiter>? SourceAddressLimiters { get; init; }
}

public sealed record DownloadProgress(long BytesWritten, long TotalBytes, int CompletedChunks, int TotalChunks, bool[]? ChunkStates = null, int RetryAttempts = 0);

public sealed record DownloadResult(
    string DestinationPath,
    long BytesDownloaded,
    string Sha256,
    bool UsedByteRanges,
    bool Resumed,
    int ChunksDownloaded);

internal sealed record DownloadState(
    string SourceFingerprint,
    long TotalBytes,
    int ChunkSizeBytes,
    string? ETag,
    string? LastModified,
    bool[] CompletedChunks);

using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Text;
using SpeedOFreq.Core;

var tempRoot = Path.Combine(Path.GetTempPath(), "SpeedOFreq.Core.Smoke." + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(tempRoot);
try
{
    var fixture = Path.Combine(tempRoot, "fixture.bin");
    var random = new Random(73021);
    var fixtureBytes = new byte[2 * 1024 * 1024];
    random.NextBytes(fixtureBytes);
    await File.WriteAllBytesAsync(fixture, fixtureBytes);
    var expectedHash = Hash(fixtureBytes);

    using var server = new FixtureServer(fixture);
    server.Start();
    using var engine = new DownloadEngine();
    var options = new DownloadOptions
    {
        Source = new Uri(server.BaseUrl + "/range"),
        DestinationPath = Path.Combine(tempRoot, "ranged.bin"),
        Parallelism = 4,
        ChunkSizeBytes = 256 * 1024,
        RetryCount = 2
    };

    var ranged = await engine.DownloadAsync(options);
    Require(ranged.UsedByteRanges, "Range-capable server should use byte ranges.");
    Require(ranged.Sha256 == expectedHash, "Ranged output SHA-256 mismatch.");
    Require(ranged.BytesDownloaded == fixtureBytes.Length, "Ranged output size mismatch.");
    Console.WriteLine("PASS parallel byte ranges + SHA-256");

    var fallback = await engine.DownloadAsync(options with
    {
        Source = new Uri(server.BaseUrl + "/norange"),
        DestinationPath = Path.Combine(tempRoot, "fallback.bin")
    });
    Require(!fallback.UsedByteRanges, "Range-unsupported server should fall back to one stream.");
    Require(fallback.Sha256 == expectedHash, "Fallback output SHA-256 mismatch.");
    Console.WriteLine("PASS automatic single-stream fallback");

    var rejectedRange = await engine.DownloadAsync(options with
    {
        Source = new Uri(server.BaseUrl + "/reject-range"),
        DestinationPath = Path.Combine(tempRoot, "rejected-range-fallback.bin")
    });
    Require(!rejectedRange.UsedByteRanges && rejectedRange.Sha256 == expectedHash,
        "A server that rejects Range probes should still download through a normal GET when supported.");
    Console.WriteLine("PASS single-stream fallback when the range probe is rejected");

    var redirected = await engine.DownloadAsync(options with
    {
        Source = new Uri(server.BaseUrl + "/redirect"),
        DestinationPath = Path.Combine(tempRoot, "redirect.bin")
    });
    Require(redirected.Sha256 == expectedHash, "Redirected download SHA-256 mismatch.");
    Console.WriteLine("PASS relative HTTP redirect");

    server.FailProbeOnce = true;
    var probeRetry = await engine.DownloadAsync(options with
    {
        Source = new Uri(server.BaseUrl + "/probe-retry"),
        DestinationPath = Path.Combine(tempRoot, "probe-retry.bin")
    });
    Require(probeRetry.Sha256 == expectedHash && server.ProbeFailureCount == 1,
        "Transient range-probe failure should be retried exactly once.");
    Console.WriteLine("PASS transient HTTP 503 retry during range probe");

    var mutationPath = Path.Combine(tempRoot, "mutation.bin");
    var mutationRejected = false;
    try
    {
        await engine.DownloadAsync(options with
        {
            Source = new Uri(server.BaseUrl + "/mutate"),
            DestinationPath = mutationPath
        });
    }
    catch (InvalidDataException) { mutationRejected = true; }
    Require(mutationRejected && !File.Exists(mutationPath),
        "A changed ETag during ranged download must be rejected before final publication.");
    Console.WriteLine("PASS source-version change rejection");

    var emptyFixture = Path.Combine(tempRoot, "empty-fixture.bin");
    await File.WriteAllBytesAsync(emptyFixture, Array.Empty<byte>());
    using var emptyServer = new FixtureServer(emptyFixture);
    emptyServer.Start();
    var emptyResult = await engine.DownloadAsync(options with
    {
        Source = new Uri(emptyServer.BaseUrl + "/empty"),
        DestinationPath = Path.Combine(tempRoot, "empty.bin")
    });
    Require(emptyResult.BytesDownloaded == 0 && emptyResult.Sha256 == Hash(Array.Empty<byte>()),
        "Empty file should complete with the empty-content SHA-256.");
    Console.WriteLine("PASS zero-byte file handling");

    var localAddress = NetworkInterface.GetAllNetworkInterfaces()
        .Where(network => network.OperationalStatus == OperationalStatus.Up)
        .SelectMany(network => network.GetIPProperties().UnicastAddresses)
        .Select(unicast => unicast.Address)
        .FirstOrDefault(address => address.AddressFamily == AddressFamily.InterNetwork
            && !IPAddress.IsLoopback(address) && !address.ToString().StartsWith("169.254.", StringComparison.Ordinal));
    if (localAddress is not null)
    {
        using var boundServer = new FixtureServer(fixture, localAddress);
        boundServer.Start();
        using var boundEngine = new DownloadEngine(localAddress);
        var bound = await boundEngine.DownloadAsync(options with
        {
            Source = new Uri(boundServer.BaseUrl + "/range"),
            DestinationPath = Path.Combine(tempRoot, "bound.bin")
        });
        Require(bound.Sha256 == expectedHash, "Source-address-bound download SHA-256 mismatch.");
        Console.WriteLine("PASS local source-address binding");
    }
    else
    {
        Console.WriteLine("SKIP local source-address binding (no active non-loopback IPv4 address)");
    }

    using var multiPathServer = new FixtureServer(fixture);
    multiPathServer.Start();
    using var multiPathEngine = new DownloadEngine(new[] { IPAddress.Loopback, IPAddress.Parse("127.0.0.2") });
    var multiPathResult = await multiPathEngine.DownloadAsync(options with
    {
        Source = new Uri(multiPathServer.BaseUrl + "/range"),
        DestinationPath = Path.Combine(tempRoot, "multi-path.bin")
    });
    Require(multiPathResult.Sha256 == expectedHash, "Multi-path output SHA-256 mismatch.");
    Require(multiPathServer.SourceAddresses.Contains("127.0.0.1") && multiPathServer.SourceAddresses.Contains("127.0.0.2"),
        "Range requests should be distributed across both configured source addresses.");
    Console.WriteLine("PASS round-robin multi-source-address range scheduling (loopback-only test, not WAN aggregation)");

    using var failoverServer = new FixtureServer(fixture);
    failoverServer.Start();
    using var failoverEngine = new DownloadEngine(new[] { IPAddress.Parse("192.0.2.1"), IPAddress.Loopback });
    var failoverResult = await failoverEngine.DownloadAsync(options with
    {
        Source = new Uri(failoverServer.BaseUrl + "/range"),
        DestinationPath = Path.Combine(tempRoot, "path-failover.bin"),
        RetryCount = 2
    });
    Require(failoverResult.Sha256 == expectedHash, "A failed source address should retry through the next configured path.");
    Console.WriteLine("PASS retry/failover after a stale source-address bind failure (synthetic local test)");

    using var pathDropServer = new FixtureServer(fixture);
    pathDropServer.Start();
    pathDropServer.FailRangeStart = 256 * 1024;
    pathDropServer.FailRangeFromSource = "127.0.0.1";
    using var pathDropEngine = new DownloadEngine(new[] { IPAddress.Loopback, IPAddress.Parse("127.0.0.2") });
    var pathDropResult = await pathDropEngine.DownloadAsync(options with
    {
        Source = new Uri(pathDropServer.BaseUrl + "/pathdrop"),
        DestinationPath = Path.Combine(tempRoot, "path-drop-failover.bin"),
        Parallelism = 1,
        RetryCount = 3
    });
    Require(pathDropResult.Sha256 == expectedHash, "Download must recover when one configured path fails a chunk.");
    Require(pathDropServer.PathDropFailureCount > 0, "Test must inject a chunk failure on the selected source address.");
    Require(pathDropServer.SourceAddresses.Contains("127.0.0.1") && pathDropServer.SourceAddresses.Contains("127.0.0.2"),
        "Mid-download path failover must use both source addresses.");
    Console.WriteLine("PASS mid-download per-path chunk failure and retry over alternate path");

    server.FailRangeOnceStart = 256 * 1024;
    var retried = await engine.DownloadAsync(options with
    {
        Source = new Uri(server.BaseUrl + "/retry"),
        DestinationPath = Path.Combine(tempRoot, "retry.bin")
    });
    Require(retried.Sha256 == expectedHash, "Output hash mismatch after transient retry.");
    Require(server.RetryFailureCount == 1, "The test server should inject exactly one transient failure.");
    Console.WriteLine("PASS transient HTTP 503 retry");

    server.FailRangeStart = 512 * 1024;
    var resumeOptions = options with
    {
        Source = new Uri(server.BaseUrl + "/resume"),
        DestinationPath = Path.Combine(tempRoot, "resume.bin"),
        RetryCount = 1
    };
    var interrupted = false;
    try { await engine.DownloadAsync(resumeOptions); }
    catch (HttpRequestException) { interrupted = true; }
    Require(interrupted, "Injected persistent range failure should interrupt the first run.");
    var resumeStatePath = resumeOptions.DestinationPath + ".sonic.json";
    Require(File.Exists(resumeStatePath), "Resume checkpoint should exist after interruption.");
    var savedState = await File.ReadAllTextAsync(resumeStatePath);
    Require(!savedState.Contains("/resume", StringComparison.Ordinal),
        "Checkpoint metadata should not persist the source URL in plaintext.");
    server.FailRangeStart = -1;
    var resumed = await engine.DownloadAsync(resumeOptions);
    Require(resumed.Resumed, "Second run should reuse completed checkpoints.");
    Require(resumed.Sha256 == expectedHash, "Resumed output SHA-256 mismatch.");
    Console.WriteLine("PASS retry, checkpoint persistence, resume and final SHA-256");

    server.FailRangeStart = 512 * 1024;
    var corruptOptions = resumeOptions with { DestinationPath = Path.Combine(tempRoot, "corrupt-state.bin") };
    try { await engine.DownloadAsync(corruptOptions); }
    catch (HttpRequestException) { }
    var corruptStatePath = corruptOptions.DestinationPath + ".sonic.json";
    Require(File.Exists(corruptStatePath), "Checkpoint should exist before corruption test.");
    await File.WriteAllTextAsync(corruptStatePath, "{not-json");
    server.FailRangeStart = -1;
    var recovered = await engine.DownloadAsync(corruptOptions);
    Require(!recovered.Resumed && recovered.Sha256 == expectedHash,
        "Corrupt checkpoint metadata must be discarded and safely restarted.");
    Console.WriteLine("PASS corrupt checkpoint rejection and safe restart");

    var blockedDestination = Path.Combine(tempRoot, "publication-recovery.bin");
    Directory.CreateDirectory(blockedDestination);
    var publicationOptions = options with
    {
        Source = new Uri(server.BaseUrl + "/range"),
        DestinationPath = blockedDestination
    };
    var publicationBlocked = false;
    try { await engine.DownloadAsync(publicationOptions); }
    catch (IOException) { publicationBlocked = true; }
    catch (UnauthorizedAccessException) { publicationBlocked = true; }
    Require(publicationBlocked && Directory.Exists(blockedDestination),
        "Failed final publication must not remove or overwrite the existing destination directory.");
    Require(File.Exists(blockedDestination + ".sonic.partial")
        && File.Exists(blockedDestination + ".sonic.json"),
        "Failed final publication should preserve the partial data and checkpoint for recovery.");
    Directory.Delete(blockedDestination);
    var publicationRecovered = await engine.DownloadAsync(publicationOptions);
    Require(publicationRecovered.Resumed && publicationRecovered.Sha256 == expectedHash
        && File.Exists(blockedDestination),
        "A completed partial download must recover and publish after the destination conflict is removed.");
    Console.WriteLine("PASS final-publication failure preserves resumable partial and checkpoint");

    Console.WriteLine("ALL SMOKE TESTS PASSED");
}
finally
{
    try { Directory.Delete(tempRoot, recursive: true); } catch (IOException) { }
}

static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

sealed class FixtureServer : IDisposable
{
    private readonly string _fixturePath;
    private readonly long _size;
    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentBag<Task> _handlers = new();
    private readonly ConcurrentDictionary<string, int> _sourceAddressCounts = new(StringComparer.Ordinal);
    private Task? _acceptTask;
    private long _failRangeStart = -1;
    private long _failRangeOnceStart = -1;
    private readonly ConcurrentDictionary<long, int> _retryFailureCounts = new();
    private int _retryFailuresInjected;
    private int _failProbeOnce;
    private int _probeFailuresInjected;
    private int _pathDropFailureCount;

    public FixtureServer(string fixturePath, IPAddress? bindAddress = null)
    {
        _fixturePath = fixturePath;
        _size = new FileInfo(fixturePath).Length;
        _listener = new TcpListener(bindAddress ?? IPAddress.Loopback, 0);
    }

    public string BaseUrl => $"http://{((IPEndPoint)_listener.LocalEndpoint).Address}:{((IPEndPoint)_listener.LocalEndpoint).Port}";
    public IReadOnlyCollection<string> SourceAddresses => _sourceAddressCounts.Keys.ToArray();
    public string? FailRangeFromSource { get; set; }
    public int PathDropFailureCount => Volatile.Read(ref _pathDropFailureCount);
    public long FailRangeStart
    {
        get => Interlocked.Read(ref _failRangeStart);
        set => Interlocked.Exchange(ref _failRangeStart, value);
    }
    public long FailRangeOnceStart
    {
        get => Interlocked.Read(ref _failRangeOnceStart);
        set => Interlocked.Exchange(ref _failRangeOnceStart, value);
    }
    public int RetryFailureCount => Volatile.Read(ref _retryFailuresInjected);
    public int ProbeFailureCount => Volatile.Read(ref _probeFailuresInjected);
    public bool FailProbeOnce
    {
        set => Interlocked.Exchange(ref _failProbeOnce, value ? 1 : 0);
    }

    public void Start()
    {
        _listener.Start();
        _acceptTask = Task.Run(AcceptLoopAsync);
    }

    private async Task AcceptLoopAsync()
    {
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                _handlers.Add(HandleAsync(client));
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
        catch (SocketException) when (_stop.IsCancellationRequested) { }
    }

    private async Task HandleAsync(TcpClient client)
    {
        using (client)
        {
            try
            {
                if (client.Client.RemoteEndPoint is IPEndPoint remoteEndpoint)
                    _sourceAddressCounts.AddOrUpdate(remoteEndpoint.Address.ToString(), 1, (_, count) => count + 1);
                client.NoDelay = true;
                var stream = client.GetStream();
                using var reader = new StreamReader(stream, Encoding.ASCII, false, 4096, leaveOpen: true);
                var requestLine = await reader.ReadLineAsync();
                if (string.IsNullOrWhiteSpace(requestLine)) return;

                string? rangeHeader = null;
                string? line;
                while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync()))
                {
                    var separator = line.IndexOf(':');
                    if (separator > 0 && line[..separator].Equals("Range", StringComparison.OrdinalIgnoreCase))
                        rangeHeader = line[(separator + 1)..].Trim();
                }

                var path = requestLine.Split(' ', StringSplitOptions.RemoveEmptyEntries).ElementAtOrDefault(1) ?? "/";
                if (path.StartsWith("/reject-range", StringComparison.Ordinal) && rangeHeader is not null)
                {
                    await WriteResponseHeaderAsync(stream, 405, "Method Not Allowed", 0, null);
                    return;
                }
                if (path.StartsWith("/redirect", StringComparison.Ordinal))
                {
                    await WriteRedirectAsync(stream, "/range");
                    return;
                }
                var ignoreRanges = path.StartsWith("/norange", StringComparison.Ordinal);
                long start = 0;
                long end = _size - 1;
                var useRange = !ignoreRanges && rangeHeader is not null;
                if (useRange)
                {
                    var value = rangeHeader!.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase)
                        ? rangeHeader[6..] : throw new InvalidDataException("Malformed Range header.");
                    var pieces = value.Split('-', 2);
                    start = long.Parse(pieces[0]);
                    end = long.Parse(pieces[1]);
                    if (start < 0 || end < start || end >= _size)
                    {
                        await WriteResponseHeaderAsync(stream, 416, "Range Not Satisfiable", 0, $"bytes */{_size}");
                        return;
                    }

                    if (path.StartsWith("/pathdrop", StringComparison.Ordinal)
                        && start == FailRangeStart
                        && string.Equals((client.Client.RemoteEndPoint as IPEndPoint)?.Address.ToString(),
                            FailRangeFromSource, StringComparison.Ordinal))
                    {
                        Interlocked.Increment(ref _pathDropFailureCount);
                        await WriteResponseHeaderAsync(stream, 503, "Service Unavailable", 0, null);
                        return;
                    }

                    if (path.StartsWith("/probe-retry", StringComparison.Ordinal) && start == 0
                        && Interlocked.Exchange(ref _failProbeOnce, 0) == 1)
                    {
                        Interlocked.Increment(ref _probeFailuresInjected);
                        await WriteResponseHeaderAsync(stream, 503, "Service Unavailable", 0, null);
                        return;
                    }
                    if (path.StartsWith("/resume", StringComparison.Ordinal) && start == FailRangeStart)
                    {
                        await WriteResponseHeaderAsync(stream, 503, "Service Unavailable", 0, null);
                        return;
                    }
                    if (path.StartsWith("/retry", StringComparison.Ordinal) && start == FailRangeOnceStart)
                    {
                        var count = _retryFailureCounts.AddOrUpdate(start, 1, (_, oldCount) => oldCount + 1);
                        if (count == 1)
                        {
                            Interlocked.Increment(ref _retryFailuresInjected);
                            await WriteResponseHeaderAsync(stream, 503, "Service Unavailable", 0, null);
                            return;
                        }
                    }
                }

                var length = end - start + 1;
                var status = useRange ? 206 : 200;
                var reason = useRange ? "Partial Content" : "OK";
                var contentRange = useRange ? $"bytes {start}-{end}/{_size}" : null;
                var responseEtag = path.StartsWith("/mutate", StringComparison.Ordinal)
                    && rangeHeader != "bytes=0-0" ? "\"fixture-v2\"" : "\"fixture-v1\"";
                await WriteResponseHeaderAsync(stream, status, reason, length, contentRange, responseEtag);

                await using var file = new FileStream(_fixturePath, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous | FileOptions.RandomAccess);
                file.Position = start;
                var buffer = new byte[65536];
                long remaining = length;
                while (remaining > 0)
                {
                    var read = await file.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)), _stop.Token);
                    if (read == 0) break;
                    await stream.WriteAsync(buffer.AsMemory(0, read), _stop.Token);
                    remaining -= read;
                }
            }
            catch (IOException) { }
            catch (OperationCanceledException) { }
            catch (ObjectDisposedException) { }
        }
    }

    private static async Task WriteRedirectAsync(NetworkStream stream, string location)
    {
        var header = Encoding.ASCII.GetBytes($"HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(header);
    }

    private static async Task WriteResponseHeaderAsync(NetworkStream stream, int status, string reason, long length, string? contentRange, string etag = "\"fixture-v1\"")
    {
        var rangeLine = contentRange is null ? "" : $"Content-Range: {contentRange}\r\n";
        var header = Encoding.ASCII.GetBytes($"HTTP/1.1 {status} {reason}\r\nContent-Length: {length}\r\n{rangeLine}ETag: {etag}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(header);
    }

    public void Dispose()
    {
        _stop.Cancel();
        _listener.Stop();
        try { _acceptTask?.GetAwaiter().GetResult(); } catch (OperationCanceledException) { }
        try { Task.WhenAll(_handlers.ToArray()).GetAwaiter().GetResult(); } catch { }
        _stop.Dispose();
    }
}

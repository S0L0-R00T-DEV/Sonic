using System.Net;
using System.Net.Sockets;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace SpeedOFreq.Core;

/// <summary>
/// Dependency-free HTTP(S) downloader. Uses concurrent byte ranges when the origin supports them.
/// Construct with a local source IP to bind new TCP connections to a chosen network interface.
/// </summary>
public sealed class DownloadEngine : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private static readonly HttpRequestOptionsKey<string> SourceAddressKey = new("SpeedOFreqSonic.SourceAddress");
    private readonly HttpClient[] _clients;
    private readonly IPAddress?[] _clientAddresses;
    private readonly long[] _pathCooldownUntilTicks;
    private int _nextClientIndex;
    private int _retryAttempts;

    public int RetryAttempts => Volatile.Read(ref _retryAttempts);

    public DownloadEngine(IPAddress? localAddress = null)
    {
        _clients = [CreateClient(localAddress)];
        _clientAddresses = [localAddress];
        _pathCooldownUntilTicks = new long[_clients.Length];
    }

    /// <summary>
    /// Creates a download engine that round-robins independent HTTP requests across the supplied local source addresses.
    /// Each address must be assigned to a local interface. This is connection-level path distribution, not packet-level bonding.
    /// </summary>
    public DownloadEngine(IReadOnlyList<IPAddress> localAddresses)
    {
        ArgumentNullException.ThrowIfNull(localAddresses);
        var uniqueAddresses = localAddresses.Distinct().ToArray();
        if (uniqueAddresses.Length == 0)
            throw new ArgumentException("At least one local source address is required.", nameof(localAddresses));
        if (uniqueAddresses.Any(address => address.AddressFamily is not (AddressFamily.InterNetwork or AddressFamily.InterNetworkV6)
            || address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any)))
            throw new ArgumentException("Every source address must be a specific local IPv4 or IPv6 address.", nameof(localAddresses));

        _clients = uniqueAddresses.Select(CreateClient).ToArray();
        _clientAddresses = uniqueAddresses.Cast<IPAddress?>().ToArray();
        _pathCooldownUntilTicks = new long[_clients.Length];
    }

    private static HttpClient CreateClient(IPAddress? localAddress)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
            ConnectTimeout = TimeSpan.FromSeconds(15),
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            UseProxy = localAddress is null
        };

        if (localAddress is not null)
        {
            handler.ConnectCallback = async (context, cancellationToken) =>
            {
                var remoteAddresses = (await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, cancellationToken))
                    .Where(address => address.AddressFamily == localAddress.AddressFamily)
                    .Distinct()
                    .ToArray();
                if (remoteAddresses.Length == 0)
                    throw new SocketException((int)SocketError.AddressFamilyNotSupported);

                Exception? lastError = null;
                foreach (var remoteAddress in remoteAddresses)
                {
                    var socket = new Socket(localAddress.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
                    try
                    {
                        socket.Bind(new IPEndPoint(localAddress, 0));
                        var interfaceIndex = TryGetInterfaceIndex(localAddress);
                        if (interfaceIndex.HasValue)
                        {
                            // Windows IP_UNICAST_IF (31) forces outbound IPv4 traffic through this interface.
                            // IPv4 expects the interface index in network byte order; IPV6_UNICAST_IF expects host byte order.
                            if (localAddress.AddressFamily == AddressFamily.InterNetwork)
                                socket.SetSocketOption(SocketOptionLevel.IP, (SocketOptionName)31, IPAddress.HostToNetworkOrder(interfaceIndex.Value));
                            else
                                socket.SetSocketOption(SocketOptionLevel.IPv6, (SocketOptionName)31, interfaceIndex.Value);
                        }
                        await socket.ConnectAsync(new IPEndPoint(remoteAddress, context.DnsEndPoint.Port), cancellationToken);
                        return new NetworkStream(socket, ownsSocket: true);
                    }
                    catch (SocketException ex)
                    {
                        lastError = ex;
                        socket.Dispose();
                    }
                    catch
                    {
                        socket.Dispose();
                        throw;
                    }
                }

                throw new HttpRequestException(
                    $"Could not connect to {context.DnsEndPoint.Host}:{context.DnsEndPoint.Port} from source address {localAddress}.",
                    lastError);
            };
        }
        else
        {
            // Prefer IPv6 first and fall back quickly to IPv4 (or vice versa if DNS order
            // changes). Some Windows networks have a working IPv6 route while IPv4 stalls.
            // Use a short per-address timeout so one broken address cannot stall the queue.
            handler.ConnectCallback = ConnectAnyAddressAsync;
        }

        return new HttpClient(handler, disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan };
    }

    private static async ValueTask<Stream> ConnectAnyAddressAsync(
        SocketsHttpConnectionContext context, CancellationToken cancellationToken)
    {
        var remoteAddresses = (await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, cancellationToken))
            .Distinct()
            .OrderBy(address => address.AddressFamily == AddressFamily.InterNetworkV6 ? 0 : 1)
            .ToArray();
        if (remoteAddresses.Length == 0)
            throw new SocketException((int)SocketError.HostNotFound);

        Exception? lastError = null;
        foreach (var remoteAddress in remoteAddresses)
        {
            cancellationToken.ThrowIfCancellationRequested();
            using var attemptTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            attemptTimeout.CancelAfter(TimeSpan.FromSeconds(3));
            var socket = new Socket(remoteAddress.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
            try
            {
                await socket.ConnectAsync(
                    new IPEndPoint(remoteAddress, context.DnsEndPoint.Port), attemptTimeout.Token);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                lastError = new TimeoutException($"Connection attempt to {remoteAddress} timed out after 3 seconds.");
                socket.Dispose();
            }
            catch (SocketException ex)
            {
                lastError = ex;
                socket.Dispose();
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
        throw new HttpRequestException(
            $"Could not connect to {context.DnsEndPoint.Host}:{context.DnsEndPoint.Port} using resolved IPv4/IPv6 addresses.",
            lastError);
    }

    private static int? TryGetInterfaceIndex(IPAddress address)
    {
        foreach (var network in NetworkInterface.GetAllNetworkInterfaces())
        {
            var properties = network.GetIPProperties();
            var ownsAddress = properties.UnicastAddresses.Any(item => item.Address.Equals(address));
            var loopbackMatch = IPAddress.IsLoopback(address) && network.NetworkInterfaceType == NetworkInterfaceType.Loopback;
            if (!ownsAddress && !loopbackMatch) continue;

            try
            {
                return address.AddressFamily == AddressFamily.InterNetwork
                    ? properties.GetIPv4Properties().Index
                    : properties.GetIPv6Properties().Index;
            }
            catch (NetworkInformationException)
            {
                return null;
            }
        }
        // A stale address (e.g. an adapter removed during a download) will still fail at Bind;
        // leave the failure visible to the retry scheduler so it can choose another configured path.
        return null;
    }

    private HttpClient NextClient(HttpClient? avoid = null)
    {
        var start = Interlocked.Increment(ref _nextClientIndex) - 1;
        var now = Environment.TickCount64;
        for (var offset = 0; offset < _clients.Length; offset++)
        {
            var index = (int)(((uint)start + (uint)offset) % (uint)_clients.Length);
            var candidate = _clients[index];
            if (_clients.Length > 1 && ReferenceEquals(candidate, avoid)) continue;
            if (Volatile.Read(ref _pathCooldownUntilTicks[index]) > now) continue;
            return candidate;
        }

        // If every path is cooling down, still attempt a path rather than stalling the download.
        for (var offset = 0; offset < _clients.Length; offset++)
        {
            var index = (int)(((uint)start + (uint)offset) % (uint)_clients.Length);
            var candidate = _clients[index];
            if (_clients.Length == 1 || !ReferenceEquals(candidate, avoid))
                return candidate;
        }
        return _clients[(int)((uint)start % (uint)_clients.Length)];
    }

    private void MarkPathUnhealthy(HttpClient? client)
    {
        if (client is null) return;
        var index = Array.IndexOf(_clients, client);
        if (index >= 0)
            Interlocked.Exchange(ref _pathCooldownUntilTicks[index], Environment.TickCount64 + 5000);
    }

    private static bool IsTransportFailure(Exception exception) =>
        exception is IOException or TaskCanceledException
        || exception is HttpRequestException { StatusCode: null };

    public async Task<DownloadResult> DownloadAsync(
        DownloadOptions options,
        IProgress<DownloadProgress>? progress = null,
        CancellationToken cancellationToken = default,
        IProgress<long>? transferProgress = null)
    {
        Validate(options);
        long wireBytesReceived = 0;
        void ReportWireBytes(int count)
        {
            var current = Interlocked.Add(ref wireBytesReceived, count);
            transferProgress?.Report(current);
        }
        Interlocked.Exchange(ref _retryAttempts, 0);
        var destination = Path.GetFullPath(options.DestinationPath);
        var directory = Path.GetDirectoryName(destination)!;
        Directory.CreateDirectory(directory);
        var partialPath = destination + ".sonic.partial";
        var statePath = destination + ".sonic.json";
        var sourceFingerprint = Fingerprint(options.Source.AbsoluteUri);

        HttpResponseMessage probeResponse;
        try
        {
            probeResponse = await SendProbeWithRetryAsync(options.Source, cancellationToken, options.BrowserContext);
        }
        catch (HttpRequestException rangeProbeError) when (!cancellationToken.IsCancellationRequested)
        {
            // Some origins, CDNs, signed download URLs, and security gateways reject
            // tiny Range requests even though an ordinary GET is downloadable.
            // Retry with a normal GET before declaring the URL unusable.
            try
            {
                probeResponse = await SendFullGetWithRetryAsync(options.Source, cancellationToken, options.BandwidthLimiter, options.BrowserContext);
            }
            catch (Exception fullGetError) when (fullGetError is HttpRequestException or IOException or TaskCanceledException)
            {
                throw new HttpRequestException(
                    $"Could not start the download. The byte-range probe failed ({rangeProbeError.Message}) and the normal GET fallback also failed ({fullGetError.Message}). Check that the URL points directly to a file and that the server/network allows access.",
                    fullGetError);
            }
        }

        using var probe = probeResponse;

        if (probe.StatusCode == HttpStatusCode.OK)
            return await CompleteSingleStreamAsync(
                probe, partialPath, statePath, destination, progress, cancellationToken, ReportWireBytes, options.BandwidthLimiter, options.SourceAddressBytesReceived, options.SourceAddressLimiters);

        if (probe.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable
            && probe.Content.Headers.ContentRange?.Length == 0)
        {
            await File.WriteAllBytesAsync(partialPath, Array.Empty<byte>(), cancellationToken);
            var emptyHash = await HashFileAsync(partialPath, cancellationToken);
            File.Move(partialPath, destination, overwrite: true);
            TryDelete(statePath);
            progress?.Report(new DownloadProgress(0, 0, 0, 0));
            return new DownloadResult(destination, 0, emptyHash, false, false, 0);
        }

        if (probe.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.MethodNotAllowed
            or HttpStatusCode.NotImplemented or HttpStatusCode.RequestedRangeNotSatisfiable)
        {
            // A server may reject the Range header while still serving ordinary GET requests.
            // Retry without Range before reporting the URL as unusable.
            probe.Dispose();
            using var fullResponse = await SendFullGetWithRetryAsync(options.Source, cancellationToken, options.BandwidthLimiter, options.BrowserContext);
            return await CompleteSingleStreamAsync(
                fullResponse, partialPath, statePath, destination, progress, cancellationToken, ReportWireBytes, options.BandwidthLimiter, options.SourceAddressBytesReceived, options.SourceAddressLimiters);
        }

        if (probe.StatusCode != HttpStatusCode.PartialContent)
            throw new HttpRequestException($"Range probe failed: HTTP {(int)probe.StatusCode} {probe.ReasonPhrase}.");

        var contentRange = probe.Content.Headers.ContentRange;
        if (contentRange?.From != 0 || contentRange.To != 0 || contentRange.Length is null or < 1)
            throw new InvalidDataException("Origin returned an invalid Content-Range for the range probe.");

        // Drain the one-byte probe response before opening worker requests. Leaving a
        // response body unread can prevent safe connection reuse on some proxies/origins.
        await probe.Content.CopyToAsync(Stream.Null, cancellationToken);

        var totalBytes = contentRange.Length.Value;
        var etag = probe.Headers.ETag?.ToString();
        var lastModified = probe.Content.Headers.LastModified?.ToString("R");
        var chunkSize = options.ChunkSizeBytes;
        var chunkCount = checked((int)((totalBytes + chunkSize - 1) / chunkSize));
        var resumed = false;

        DownloadState? state = null;
        if (File.Exists(partialPath) && File.Exists(statePath))
        {
            try
            {
                state = JsonSerializer.Deserialize<DownloadState>(await File.ReadAllTextAsync(statePath, cancellationToken));
            }
            catch (JsonException) { state = null; }
        }

        var canResume = state is not null
            && (etag is not null || lastModified is not null)
            // A freshly issued signed URL may differ while still identifying the same file.
            // Permit that only when a strong validator still matches; range requests also use If-Range.
            && (state.SourceFingerprint == sourceFingerprint
                || (etag is not null && string.Equals(state.ETag, etag, StringComparison.Ordinal))
                || (lastModified is not null && string.Equals(state.LastModified, lastModified, StringComparison.Ordinal)))
            && state.TotalBytes == totalBytes
            && state.ChunkSizeBytes == chunkSize
            && state.ETag == etag
            && state.LastModified == lastModified
            && state.CompletedChunks is not null
            && state.CompletedChunks.Length == chunkCount
            && new FileInfo(partialPath).Length == totalBytes;

        if (canResume)
        {
            resumed = state!.CompletedChunks!.Any(done => done);
        }
        else
        {
            TryDelete(partialPath);
            TryDelete(statePath);
            await using var create = new FileStream(partialPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.ReadWrite);
            create.SetLength(totalBytes);
            await create.FlushAsync(cancellationToken);
            state = new DownloadState(sourceFingerprint, totalBytes, chunkSize, etag, lastModified, new bool[chunkCount]);
            await SaveStateAsync(statePath, state, cancellationToken);
        }

        if (state is null) throw new InvalidOperationException("Download state could not be initialized.");
        var completedState = state.CompletedChunks ?? throw new InvalidDataException("Checkpoint metadata has no chunk state.");
        var stateLock = new SemaphoreSlim(1, 1);
        var queue = new System.Collections.Concurrent.ConcurrentQueue<int>(
            Enumerable.Range(0, chunkCount).Where(index => !completedState[index]));
        long completedBytes = completedState.Select((done, index) =>
            done ? Math.Min(chunkSize, totalBytes - (long)index * chunkSize) : 0L).Sum();
        var completedChunks = completedState.Count(done => done);
        var freshChunks = 0;
        progress?.Report(new DownloadProgress(completedBytes, totalBytes, completedChunks, chunkCount, completedState.ToArray(), Volatile.Read(ref _retryAttempts)));

        async Task WorkerAsync()
        {
            while (queue.TryDequeue(out var index))
            {
                cancellationToken.ThrowIfCancellationRequested();
                var start = (long)index * chunkSize;
                var end = Math.Min(totalBytes - 1, start + chunkSize - 1);
                var expectedLength = checked((int)(end - start + 1));
                var bytes = await FetchRangeWithRetryAsync(options, start, end, expectedLength, totalBytes, etag, lastModified, cancellationToken, ReportWireBytes, options.SourceAddressBytesReceived);

                await using (var stream = new FileStream(partialPath, FileMode.Open, FileAccess.ReadWrite,
                    FileShare.ReadWrite, 65536, FileOptions.Asynchronous | FileOptions.RandomAccess))
                {
                    await RandomAccess.WriteAsync(stream.SafeFileHandle, bytes, start, cancellationToken);
                    stream.Flush(flushToDisk: true);
                }

                await stateLock.WaitAsync(cancellationToken);
                try
                {
                    completedState[index] = true;
                    await SaveStateAsync(statePath, state, cancellationToken);
                    Interlocked.Add(ref completedBytes, expectedLength);
                    Interlocked.Increment(ref completedChunks);
                    Interlocked.Increment(ref freshChunks);
                    progress?.Report(new DownloadProgress(
                        Interlocked.Read(ref completedBytes), totalBytes,
                        Volatile.Read(ref completedChunks), chunkCount, completedState.ToArray(), Volatile.Read(ref _retryAttempts)));
                }
                finally { stateLock.Release(); }
            }
        }

        try
        {
            await Task.WhenAll(Enumerable.Range(0, Math.Min(options.Parallelism, Math.Max(1, queue.Count)))
                .Select(_ => WorkerAsync()));
        }
        finally { stateLock.Dispose(); }

        var actualLength = new FileInfo(partialPath).Length;
        if (actualLength != totalBytes)
            throw new InvalidDataException($"Downloaded file length mismatch: expected {totalBytes}, got {actualLength}.");

        var sha256 = await HashFileAsync(partialPath, cancellationToken);
        File.Move(partialPath, destination, overwrite: true);
        TryDelete(statePath);
        return new DownloadResult(destination, totalBytes, sha256, true, resumed, freshChunks);
    }

    private static async Task<DownloadResult> CompleteSingleStreamAsync(
        HttpResponseMessage response, string partialPath, string statePath, string destination,
        IProgress<DownloadProgress>? progress, CancellationToken cancellationToken, Action<int> reportWireBytes,
        BandwidthLimiter? bandwidthLimiter, Action<string, long>? reportSourceBytesReceived,
        IReadOnlyDictionary<string, BandwidthLimiter>? sourceAddressLimiters)
    {
        response.EnsureSuccessStatusCode();
        var sourceAddress = response.RequestMessage is not null
            && response.RequestMessage.Options.TryGetValue(SourceAddressKey, out var address) ? address : null;
        await SaveFullResponseAsync(response, partialPath, progress, cancellationToken, reportWireBytes,
            bandwidthLimiter, sourceAddress, reportSourceBytesReceived, sourceAddressLimiters);
        var sha256 = await HashFileAsync(partialPath, cancellationToken);
        var bytes = new FileInfo(partialPath).Length;
        File.Move(partialPath, destination, overwrite: true);
        TryDelete(statePath);
        progress?.Report(new DownloadProgress(bytes, bytes, 1, 1));
        return new DownloadResult(destination, bytes, sha256, false, false, 1);
    }

    private async Task<HttpResponseMessage> SendFullGetWithRetryAsync(Uri source, CancellationToken cancellationToken, BandwidthLimiter? bandwidthLimiter, BrowserRequestContext? browserContext = null)
    {
        Exception? lastError = null;
        HttpClient? previousClient = null;
        const int retries = 2;
        for (var attempt = 0; attempt <= retries; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            HttpResponseMessage? response = null;
            HttpClient? attemptedClient = null;
            try
            {
                var client = NextClient(previousClient);
                attemptedClient = client;
                previousClient = client;
                response = await SendFollowingRedirectsAsync(
                    client, CreateRequest(source, HttpMethod.Get, range: null, browserContext), cancellationToken, browserContext);
                if (!IsTransientStatusCode(response.StatusCode)) return response;
                lastError = new HttpRequestException(
                    $"Transient full-download response: HTTP {(int)response.StatusCode}.", null, response.StatusCode);
                response.Dispose();
                response = null;
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException)
            {
                lastError = ex;
                response?.Dispose();
                if (!cancellationToken.IsCancellationRequested && IsTransportFailure(ex))
                    MarkPathUnhealthy(attemptedClient);
            }

            if (attempt == retries) break;
            Interlocked.Increment(ref _retryAttempts);
            await Task.Delay(TimeSpan.FromMilliseconds(300 * (1 << attempt)), cancellationToken);
        }

        throw new HttpRequestException("Normal GET fallback failed after retries.", lastError);
    }

    private async Task<HttpResponseMessage> SendProbeWithRetryAsync(Uri source, CancellationToken cancellationToken, BrowserRequestContext? browserContext = null)
    {
        Exception? lastError = null;
        HttpClient? previousClient = null;
        const int retries = 3;
        for (var attempt = 0; attempt <= retries; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            HttpResponseMessage? response = null;
            HttpClient? attemptedClient = null;
            try
            {
                var client = NextClient(previousClient);
                attemptedClient = client;
                previousClient = client;
                response = await SendFollowingRedirectsAsync(
                    client, CreateRequest(source, HttpMethod.Get, new RangeHeaderValue(0, 0), browserContext), cancellationToken, browserContext);
                if (!IsTransientStatusCode(response.StatusCode)) return response;
                lastError = new HttpRequestException($"Transient range-probe response: HTTP {(int)response.StatusCode}.", null, response.StatusCode);
                response.Dispose();
                response = null;
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException)
            {
                lastError = ex;
                response?.Dispose();
                if (!cancellationToken.IsCancellationRequested && IsTransportFailure(ex))
                    MarkPathUnhealthy(attemptedClient);
            }

            if (attempt == retries) break;
            Interlocked.Increment(ref _retryAttempts);
            await Task.Delay(TimeSpan.FromMilliseconds(250 * (1 << attempt)), cancellationToken);
        }
        throw new HttpRequestException("HTTP range probe failed after retries.", lastError);
    }

    private static bool IsTransientStatusCode(HttpStatusCode status) =>
        (int)status >= 500 || status is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests;

    private async Task<byte[]> FetchRangeWithRetryAsync(
        DownloadOptions options, long start, long end, int expectedLength, long totalBytes,
        string? etag, string? lastModified, CancellationToken cancellationToken, Action<int>? reportBytesReceived,
        Action<string, long>? reportSourceBytesReceived)
    {
        Exception? lastError = null;
        HttpClient? previousClient = null;
        for (var attempt = 0; attempt <= options.RetryCount; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            HttpClient? attemptedClient = null;
            try
            {
                var client = NextClient(previousClient);
                attemptedClient = client;
                previousClient = client;
                using var request = CreateRequest(options.Source, HttpMethod.Get, new RangeHeaderValue(start, end), options.BrowserContext);
                if (etag is not null) request.Headers.TryAddWithoutValidation("If-Range", etag);
                else if (lastModified is not null) request.Headers.TryAddWithoutValidation("If-Range", lastModified);

                using var response = await SendFollowingRedirectsAsync(client, request, cancellationToken, options.BrowserContext);
                if (IsTransientStatusCode(response.StatusCode))
                    throw new HttpRequestException($"Transient origin response: HTTP {(int)response.StatusCode}.", null, response.StatusCode);

                if (response.StatusCode != HttpStatusCode.PartialContent)
                    throw new InvalidDataException($"Origin stopped honoring byte ranges (HTTP {(int)response.StatusCode}); refusing to mix source versions.");

                var range = response.Content.Headers.ContentRange;
                if (range?.From != start || range.To != end || range.Length != totalBytes)
                    throw new InvalidDataException($"Origin returned an unexpected byte range or source length for {start}-{end}.");
                if (etag is not null && response.Headers.ETag is not null
                    && !string.Equals(response.Headers.ETag.ToString(), etag, StringComparison.Ordinal))
                    throw new InvalidDataException("Origin ETag changed during the download.");
                var responseLastModified = response.Content.Headers.LastModified?.ToString("R");
                if (lastModified is not null && responseLastModified is not null
                    && !string.Equals(responseLastModified, lastModified, StringComparison.Ordinal))
                    throw new InvalidDataException("Origin Last-Modified changed during the download.");

                if (response.Content.Headers.ContentLength is long length && length != expectedLength)
                    throw new InvalidDataException($"Range length mismatch: expected {expectedLength}, got {length}.");

                await using var responseStream = await response.Content.ReadAsStreamAsync(cancellationToken);
                using var buffer = new MemoryStream(expectedLength);
                using var readTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                var readBuffer = new byte[131072];
                while (true)
                {
                    // Reset an inactivity timer for every read. Slow but active transfers are
                    // allowed to continue; a dead connection is retried instead of hanging forever.
                    readTimeout.CancelAfter(TimeSpan.FromSeconds(20));
                    var read = await responseStream.ReadAsync(readBuffer.AsMemory(), readTimeout.Token);
                    if (read == 0) break;
                    var sourceAddress = GetSourceAddress(client);
                    if (options.BandwidthLimiter is not null)
                        await options.BandwidthLimiter.WaitAsync(read, cancellationToken);
                    if (sourceAddress is not null && options.SourceAddressLimiters is not null
                        && options.SourceAddressLimiters.TryGetValue(sourceAddress, out var pathLimiter))
                        await pathLimiter.WaitAsync(read, cancellationToken);
                    await buffer.WriteAsync(readBuffer.AsMemory(0, read), cancellationToken);
                    reportBytesReceived?.Invoke(read);
                    if (sourceAddress is not null) reportSourceBytesReceived?.Invoke(sourceAddress, read);
                }
                var bytes = buffer.ToArray();
                if (bytes.Length != expectedLength)
                    throw new EndOfStreamException($"Short range body: expected {expectedLength}, got {bytes.Length}.");
                return bytes;
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException)
            {
                if (cancellationToken.IsCancellationRequested) throw;
                lastError = ex is OperationCanceledException
                    ? new TimeoutException("No range data was received for 20 seconds.", ex)
                    : ex;
                if (IsTransportFailure(ex) || ex is OperationCanceledException)
                    MarkPathUnhealthy(attemptedClient);
                if (attempt == options.RetryCount) break;
                Interlocked.Increment(ref _retryAttempts);
                await Task.Delay(TimeSpan.FromMilliseconds(Math.Min(4000, 250 * (1 << Math.Min(attempt, 4)))), cancellationToken);
            }
        }
        throw new HttpRequestException($"Range {start}-{end} failed after {options.RetryCount + 1} attempt(s).", lastError);
    }

    private async Task<HttpResponseMessage> SendFollowingRedirectsAsync(HttpClient client, HttpRequestMessage initial, CancellationToken cancellationToken, BrowserRequestContext? browserContext = null)
    {
        var current = initial;
        for (var redirect = 0; redirect <= 10; redirect++)
        {
            HttpResponseMessage response;
            try
            {
                // Bound time-to-headers independently from the streaming body. A server or
                // proxy that stops answering must not leave a queue item Running forever.
                var sourceAddress = GetSourceAddress(client);
                if (sourceAddress is not null) current.Options.Set(SourceAddressKey, sourceAddress);
                using var headerTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                headerTimeout.CancelAfter(TimeSpan.FromSeconds(20));
                response = await client.SendAsync(current, HttpCompletionOption.ResponseHeadersRead, headerTimeout.Token);
            }
            catch
            {
                current.Dispose();
                throw;
            }

            if (!IsRedirect(response.StatusCode) || response.Headers.Location is null)
            {
                current.Dispose();
                return response;
            }

            Uri nextUri;
            try
            {
                nextUri = response.Headers.Location.IsAbsoluteUri
                    ? response.Headers.Location
                    : new Uri(current.RequestUri!, response.Headers.Location);
            }
            catch
            {
                response.Dispose();
                current.Dispose();
                throw;
            }

            if (!nextUri.IsAbsoluteUri ||
                (nextUri.Scheme != Uri.UriSchemeHttp && nextUri.Scheme != Uri.UriSchemeHttps) ||
                !string.IsNullOrWhiteSpace(nextUri.UserInfo))
            {
                response.Dispose();
                current.Dispose();
                throw new HttpRequestException("Refusing an unsupported or credential-bearing redirect target.");
            }

            response.Dispose();
            if (current.RequestUri!.Scheme == Uri.UriSchemeHttps && nextUri.Scheme != Uri.UriSchemeHttps)
            {
                current.Dispose();
                throw new HttpRequestException("Refusing an HTTPS-to-HTTP redirect.");
            }
            if (redirect == 10)
            {
                current.Dispose();
                throw new HttpRequestException("Too many HTTP redirects.");
            }

            var next = CreateRequest(nextUri, current.Method, current.Headers.Range, browserContext);
            if (current.Headers.TryGetValues("If-Range", out var values))
                next.Headers.TryAddWithoutValidation("If-Range", values);
            current.Dispose();
            current = next;
        }
        throw new InvalidOperationException("Redirect loop exited unexpectedly.");
    }

    private string? GetSourceAddress(HttpClient client)
    {
        var index = Array.IndexOf(_clients, client);
        return index >= 0 ? _clientAddresses[index]?.ToString() : null;
    }

    private static HttpRequestMessage CreateRequest(Uri uri, HttpMethod method, RangeHeaderValue? range, BrowserRequestContext? browserContext = null)
    {
        var request = new HttpRequestMessage(method, uri);
        if (range is not null) request.Headers.Range = range;
        request.Headers.AcceptEncoding.ParseAdd("identity");
        if (browserContext is not null)
        {
            foreach (var header in browserContext.HeadersFor(uri))
                request.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
        return request;
    }

    private static bool IsRedirect(HttpStatusCode status) =>
        status is HttpStatusCode.MovedPermanently or HttpStatusCode.Redirect or
            HttpStatusCode.RedirectMethod or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect;

    private static async Task SaveFullResponseAsync(HttpResponseMessage response, string path, IProgress<DownloadProgress>? progress,
        CancellationToken cancellationToken, Action<int>? reportBytesReceived, BandwidthLimiter? bandwidthLimiter,
        string? sourceAddress, Action<string, long>? reportSourceBytesReceived,
        IReadOnlyDictionary<string, BandwidthLimiter>? sourceAddressLimiters)
    {
        var totalBytes = response.Content.Headers.ContentLength ?? 0;
        long bytesCopied = 0;
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 131072, FileOptions.Asynchronous);
        var buffer = new byte[131072];
        while (true)
        {
            var read = await input.ReadAsync(buffer.AsMemory(), cancellationToken);
            if (read == 0) break;
            if (bandwidthLimiter is not null)
                await bandwidthLimiter.WaitAsync(read, cancellationToken);
            if (!string.IsNullOrWhiteSpace(sourceAddress) && sourceAddressLimiters is not null
                && sourceAddressLimiters.TryGetValue(sourceAddress, out var pathLimiter))
                await pathLimiter.WaitAsync(read, cancellationToken);
            await file.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            bytesCopied += read;
            reportBytesReceived?.Invoke(read);
            if (!string.IsNullOrWhiteSpace(sourceAddress)) reportSourceBytesReceived?.Invoke(sourceAddress, read);
            progress?.Report(new DownloadProgress(bytesCopied, totalBytes, 0, 1));
        }
        await file.FlushAsync(cancellationToken);
        file.Flush(flushToDisk: true);
    }

    private static async Task SaveStateAsync(string path, DownloadState state, CancellationToken cancellationToken)
    {
        var temporary = path + ".tmp";
        await using (var file = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 16384, FileOptions.Asynchronous))
        {
            await JsonSerializer.SerializeAsync(file, state, JsonOptions, cancellationToken);
            await file.FlushAsync(cancellationToken);
            file.Flush(flushToDisk: true);
        }
        File.Move(temporary, path, overwrite: true);
    }

    private static string Fingerprint(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static async Task<string> HashFileAsync(string path, CancellationToken cancellationToken)
    {
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 131072, FileOptions.Asynchronous | FileOptions.SequentialScan);
        return Convert.ToHexString(await SHA256.HashDataAsync(file, cancellationToken)).ToLowerInvariant();
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { }
    }

    public void Dispose()
    {
        foreach (var client in _clients) client.Dispose();
    }

    private static void Validate(DownloadOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (options.Source is null || !options.Source.IsAbsoluteUri ||
            (options.Source.Scheme != Uri.UriSchemeHttp && options.Source.Scheme != Uri.UriSchemeHttps))
            throw new ArgumentException("Source must be an absolute HTTP or HTTPS URL.", nameof(options));
        if (!string.IsNullOrWhiteSpace(options.Source.UserInfo))
            throw new ArgumentException("Credentials embedded in download URLs are not supported.", nameof(options));
        if (string.IsNullOrWhiteSpace(options.DestinationPath))
            throw new ArgumentException("Destination path is required.", nameof(options));
        if (options.Parallelism is < 1 or > 32)
            throw new ArgumentOutOfRangeException(nameof(options.Parallelism), "Parallelism must be between 1 and 32.");
        if (options.ChunkSizeBytes is < 64 * 1024 or > 64 * 1024 * 1024)
            throw new ArgumentOutOfRangeException(nameof(options.ChunkSizeBytes), "Chunk size must be between 64 KiB and 64 MiB.");
        if (options.RetryCount is < 0 or > 10)
            throw new ArgumentOutOfRangeException(nameof(options.RetryCount), "Retry count must be between 0 and 10.");
    }
}

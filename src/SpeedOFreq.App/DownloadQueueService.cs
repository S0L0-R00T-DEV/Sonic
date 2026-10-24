using System.Collections.ObjectModel;
using System.IO;
using System.Diagnostics;
using System.Net;
using System.Text.Json;
using System.Collections.Specialized;
using System.Collections.Concurrent;
using System.Windows.Threading;
using SpeedOFreq.Core;

namespace SpeedOFreq.App;

public sealed class DownloadQueueService
{
    private readonly SemaphoreSlim _slots = new(4, 4);
    private readonly BandwidthLimiter _bandwidthLimiter = new();
    private readonly ConcurrentDictionary<string, BandwidthLimiter> _sourceAddressLimiters = new(StringComparer.OrdinalIgnoreCase);
    private bool _downloadsAllowed = true;
    private int _downloadsAtOnce = 3;
    private long? _speedLimitBytesPerSecond;
    private readonly HashSet<string> _scheduled = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<QueueDownloadItem> _hookedItems = [];
    private readonly Func<IReadOnlyList<IPAddress>> _getSourceAddresses;
    private readonly Func<int> _getParallelism;
    private readonly Func<int> _getChunkSize;
    private readonly string _queuePath = Path.Combine(AppStoragePaths.Root, "queue-v1.json");
    private readonly string _usagePath = Path.Combine(AppStoragePaths.Root, "network-usage-v1.json");
    private readonly Dictionary<string, Dictionary<string, long>> _usageByDate = new(StringComparer.Ordinal);
    private readonly DispatcherTimer _usageSaveTimer;
    private readonly DispatcherTimer _saveTimer;
    private static readonly JsonSerializerOptions QueueJsonOptions = new() { WriteIndented = true };
    public ObservableCollection<QueueDownloadItem> Items { get; } = [];

    public DownloadQueueService(Func<IReadOnlyList<IPAddress>> getSourceAddresses, Func<int> getParallelism, Func<int> getChunkSize)
    {
        _getSourceAddresses = getSourceAddresses;
        _getParallelism = getParallelism;
        _getChunkSize = getChunkSize;
        _saveTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(700) };
        _saveTimer.Tick += (_, _) => { _saveTimer.Stop(); PersistQueue(); };
        _usageSaveTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(900) };
        _usageSaveTimer.Tick += (_, _) => { _usageSaveTimer.Stop(); PersistUsageLedger(); };
        Items.CollectionChanged += Items_CollectionChanged;
        LoadUsageLedger();
        LoadQueue();
    }

    private void Items_CollectionChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        if (e.NewItems is not null)
            foreach (QueueDownloadItem item in e.NewItems) HookItem(item);
        SchedulePersist();
    }

    private void HookItem(QueueDownloadItem item)
    {
        if (_hookedItems.Add(item)) item.PropertyChanged += (_, _) => SchedulePersist();
    }

    private void SchedulePersist()
    {
        _saveTimer.Stop();
        _saveTimer.Start();
    }

    public void FlushPersistence()
    {
        _saveTimer.Stop();
        _usageSaveTimer.Stop();
        PersistQueue();
        PersistUsageLedger();
    }

    private void PersistQueue()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_queuePath)!);
            var snapshot = Items.Select(item => new PersistedQueueItem
            {
                Id = item.Id, CreatedAt = item.CreatedAt, Url = item.Url, Destination = item.Destination,
                SourceAddresses = item.SourceAddresses?.Select(address => address.ToString()).ToArray(),
                PreferredSourceAddresses = item.PreferredSourceAddresses?.Select(address => address.ToString()).ToArray(),
                NetworkPolicyPaused = item.NetworkPolicyPaused,
                Status = item.Status, ProgressText = item.ProgressText, Details = item.Details,
                ProgressPercent = item.ProgressPercent, BytesDownloaded = item.BytesDownloaded,
                WireBytesReceived = item.WireBytesReceived, TotalBytes = item.TotalBytes, Retries = item.Retries,
                Speed = item.Speed, StartedAt = item.StartedAt, FinishedAt = item.FinishedAt,
                ElapsedSeconds = item.ElapsedSeconds, AverageBytesPerSecond = item.AverageBytesPerSecond,
                PeakBytesPerSecond = item.PeakBytesPerSecond,
                BytesBySourceAddress = new Dictionary<string, long>(item.BytesBySourceAddress, StringComparer.OrdinalIgnoreCase)
            }).ToArray();
            var temp = _queuePath + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(snapshot, QueueJsonOptions));
            File.Move(temp, _queuePath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            Debug.WriteLine($"Queue state could not be saved: {ex.Message}");
        }
    }

    private void RecordSourceBytes(QueueDownloadItem item, string sourceAddress, long bytes)
    {
        if (bytes <= 0 || !IPAddress.TryParse(sourceAddress, out var parsedAddress)) return;
        var address = parsedAddress.ToString();
        item.RecordSourceBytes(address, bytes);
        var today = DateOnly.FromDateTime(DateTime.Now).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        if (!_usageByDate.TryGetValue(today, out var daily)) _usageByDate[today] = daily = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        daily[address] = daily.GetValueOrDefault(address) + bytes;

        var oldestAllowed = DateOnly.FromDateTime(DateTime.Now).AddDays(-400).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        foreach (var date in _usageByDate.Keys.Where(date => string.CompareOrdinal(date, oldestAllowed) < 0).ToArray()) _usageByDate.Remove(date);
        _usageSaveTimer.Stop();
        _usageSaveTimer.Start();
        SchedulePersist();
    }

    public Dictionary<string, long> NetworkUsage(string startDate, IEnumerable<string> sourceAddresses)
    {
        var start = DateOnly.TryParse(startDate, out var parsedStart) ? parsedStart : DateOnly.FromDateTime(DateTime.Now);
        var first = start.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        var last = DateOnly.FromDateTime(DateTime.Now).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        var addresses = sourceAddresses.Where(address => IPAddress.TryParse(address, out _)).Select(address => IPAddress.Parse(address).ToString())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var result = addresses.ToDictionary(address => address, _ => 0L, StringComparer.OrdinalIgnoreCase);
        foreach (var entry in _usageByDate)
        {
            if (string.CompareOrdinal(entry.Key, first) < 0 || string.CompareOrdinal(entry.Key, last) > 0) continue;
            foreach (var pair in entry.Value)
                if (addresses.Contains(pair.Key)) result[pair.Key] = result.GetValueOrDefault(pair.Key) + Math.Max(0, pair.Value);
        }
        return result;
    }

    public void ResetNetworkUsage(IEnumerable<string> sourceAddresses)
    {
        var addresses = sourceAddresses.Where(address => IPAddress.TryParse(address, out _)).Select(address => IPAddress.Parse(address).ToString())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (addresses.Count == 0) return;
        foreach (var date in _usageByDate.Keys.ToArray())
        {
            foreach (var address in addresses) _usageByDate[date].Remove(address);
            if (_usageByDate[date].Count == 0) _usageByDate.Remove(date);
        }
        _usageSaveTimer.Stop();
        PersistUsageLedger();
    }

    private void LoadUsageLedger()
    {
        try
        {
            if (!File.Exists(_usagePath)) return;
            var loaded = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, long>>>(File.ReadAllText(_usagePath));
            if (loaded is null) return;
            foreach (var entry in loaded.Take(450))
            {
                if (!DateOnly.TryParseExact(entry.Key, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out _)) continue;
                var daily = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
                foreach (var pair in entry.Value.Take(256))
                    if (IPAddress.TryParse(pair.Key, out var address) && pair.Value > 0) daily[address.ToString()] = pair.Value;
                if (daily.Count > 0) _usageByDate[entry.Key] = daily;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            Debug.WriteLine($"Network usage ledger could not be restored: {ex.Message}");
        }
    }

    private void PersistUsageLedger()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_usagePath)!);
            var temp = _usagePath + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(_usageByDate, QueueJsonOptions));
            File.Move(temp, _usagePath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            Debug.WriteLine($"Network usage ledger could not be saved: {ex.Message}");
        }
    }

    private void LoadQueue()
    {
        try
        {
            if (!File.Exists(_queuePath)) return;
            var saved = JsonSerializer.Deserialize<PersistedQueueItem[]>(File.ReadAllText(_queuePath)) ?? [];
            foreach (var record in saved.Take(5000))
            {
                if (string.IsNullOrWhiteSpace(record.Id) || string.IsNullOrWhiteSpace(record.Url)
                    || string.IsNullOrWhiteSpace(record.Destination)) continue;
                if (!Uri.TryCreate(record.Url, UriKind.Absolute, out var uri)
                    || uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo)) continue;
                var item = new QueueDownloadItem
                {
                    Id = record.Id, CreatedAt = record.CreatedAt, Url = uri.AbsoluteUri,
                    Destination = record.Destination,
                    SourceAddresses = record.SourceAddresses?.Select(value => IPAddress.TryParse(value, out var address) ? address : null)
                        .Where(address => address is not null).Cast<IPAddress>().Distinct().ToArray(),
                    PreferredSourceAddresses = (record.PreferredSourceAddresses ?? record.SourceAddresses)?.Select(value => IPAddress.TryParse(value, out var address) ? address : null)
                        .Where(address => address is not null).Cast<IPAddress>().Distinct().ToArray(),
                    NetworkPolicyPaused = record.NetworkPolicyPaused
                };
                item.ProgressText = record.ProgressText ?? "Restored queue item";
                item.Details = record.Details ?? "Restored from the previous session.";
                item.ProgressPercent = Math.Clamp(record.ProgressPercent, 0, 100);
                item.BytesDownloaded = Math.Max(0, record.BytesDownloaded);
                item.WireBytesReceived = Math.Max(0, record.WireBytesReceived);
                item.TotalBytes = record.TotalBytes;
                item.Retries = Math.Max(0, record.Retries);
                item.Speed = record.Speed ?? "—";
                item.StartedAt = record.StartedAt;
                item.FinishedAt = record.FinishedAt;
                item.ElapsedSeconds = Math.Max(0, record.ElapsedSeconds);
                item.AverageBytesPerSecond = Math.Max(0, record.AverageBytesPerSecond);
                item.PeakBytesPerSecond = Math.Max(0, record.PeakBytesPerSecond);
                if (record.BytesBySourceAddress is not null)
                    foreach (var pair in record.BytesBySourceAddress.Take(16))
                        if (IPAddress.TryParse(pair.Key, out _) && pair.Value > 0) item.BytesBySourceAddress[pair.Key] = pair.Value;
                item.Status = string.Equals(record.Status, "Running", StringComparison.OrdinalIgnoreCase)
                    ? "Queued" : record.Status is "Completed" or "Failed" or "Canceled" or "Paused" or "Queued" ? record.Status : "Queued";
                if (string.Equals(record.Status, "Running", StringComparison.OrdinalIgnoreCase))
                    item.Details = "Recovered after restart; start the queue to resume from the saved download checkpoint where available.";
                Items.Add(item);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            Debug.WriteLine($"Saved queue could not be restored: {ex.Message}");
        }
    }

    private sealed class PersistedQueueItem
    {
        public string Id { get; set; } = "";
        public DateTimeOffset CreatedAt { get; set; }
        public string Url { get; set; } = "";
        public string Destination { get; set; } = "";
        public string[]? SourceAddresses { get; set; }
        public string[]? PreferredSourceAddresses { get; set; }
        public bool NetworkPolicyPaused { get; set; }
        public string Status { get; set; } = "Queued";
        public string? ProgressText { get; set; }
        public string? Details { get; set; }
        public double ProgressPercent { get; set; }
        public long BytesDownloaded { get; set; }
        public long WireBytesReceived { get; set; }
        public long TotalBytes { get; set; } = -1;
        public int Retries { get; set; }
        public string? Speed { get; set; }
        public DateTimeOffset? StartedAt { get; set; }
        public DateTimeOffset? FinishedAt { get; set; }
        public double ElapsedSeconds { get; set; }
        public double AverageBytesPerSecond { get; set; }
        public double PeakBytesPerSecond { get; set; }
        public Dictionary<string, long>? BytesBySourceAddress { get; set; }
    }

    public QueueDownloadItem Add(string rawUrl, string? destination = null, IReadOnlyList<IPAddress>? sourceAddresses = null, BrowserRequestContext? browserContext = null)
    {
        if (!Uri.TryCreate(rawUrl?.Trim(), UriKind.Absolute, out var source)
            || source.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(source.UserInfo))
            throw new ArgumentException("Provide a complete HTTP(S) URL without embedded credentials.", nameof(rawUrl));
        if (string.IsNullOrWhiteSpace(destination))
        {
            var filename = Path.GetFileName(source.LocalPath);
            if (string.IsNullOrWhiteSpace(filename)) filename = "download-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".bin";
            destination = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", filename);
        }
        var fullDestination = Path.GetFullPath(destination.Trim());
        if (Directory.Exists(fullDestination)) throw new ArgumentException("Destination must be a file path, not a directory.");
        if (File.Exists(fullDestination)) throw new InvalidOperationException("Queue mode will not overwrite an existing file. Choose a new destination or remove the existing file first.");
        if (Items.Any(item => string.Equals(item.Destination, fullDestination, StringComparison.OrdinalIgnoreCase)
            && item.Status is "Queued" or "Running"))
            throw new InvalidOperationException("A queued or running download already targets that destination.");
        var configuredAddresses = sourceAddresses?.Distinct().ToArray();
        var item = new QueueDownloadItem { Url = source.AbsoluteUri, Destination = fullDestination, SourceAddresses = configuredAddresses,
            PreferredSourceAddresses = configuredAddresses, BrowserContext = browserContext };
        Items.Add(item);
        return item;
    }

    public void StartQueued()
    {
        if (!_downloadsAllowed) return;
        var capacity = Math.Max(0, _downloadsAtOnce - _scheduled.Count);
        if (capacity == 0) return;
        foreach (var item in Items.Where(item => item.Status == "Queued").Take(capacity).ToArray())
            if (_scheduled.Add(item.Id)) _ = RunAsync(item);
    }

    public void SetSourceAddressSpeedLimits(IReadOnlyDictionary<string, long> limits)
    {
        foreach (var entry in _sourceAddressLimiters)
        {
            if (!limits.TryGetValue(entry.Key, out var rate) || rate <= 0)
                entry.Value.SetLimitBytesPerSecond(null);
        }
        foreach (var pair in limits)
        {
            if (!IPAddress.TryParse(pair.Key, out var address) || pair.Value <= 0) continue;
            _sourceAddressLimiters.GetOrAdd(address.ToString(), _ => new BandwidthLimiter())
                .SetLimitBytesPerSecond(pair.Value);
        }
    }

    public void SetPolicy(bool downloadsAllowed, int downloadsAtOnce, long? speedLimitBytesPerSecond)
    {
        _downloadsAtOnce = Math.Clamp(downloadsAtOnce, 1, 4);
        _speedLimitBytesPerSecond = speedLimitBytesPerSecond is > 0 ? speedLimitBytesPerSecond : null;
        _bandwidthLimiter.SetLimitBytesPerSecond(_speedLimitBytesPerSecond);
        var wasAllowed = _downloadsAllowed;
        _downloadsAllowed = downloadsAllowed;
        if (!downloadsAllowed)
        {
            foreach (var item in Items.Where(item => item.Status == "Running").ToArray())
            {
                item.PolicyStopRequested = true;
                item.PauseRequested = true;
                item.Cancellation.Cancel();
            }
        }
        else if (!wasAllowed || _scheduled.Count < _downloadsAtOnce)
        {
            StartQueued();
        }
        SchedulePersist();
    }

    public bool Cancel(string id)
    {
        var item = Items.FirstOrDefault(candidate => string.Equals(candidate.Id, id, StringComparison.OrdinalIgnoreCase));
        if (item is null || item.Status is not ("Queued" or "Running" or "Paused")) return false;
        if (item.Status is "Queued" or "Paused")
        {
            var wasPaused = item.Status == "Paused";
            item.Status = "Canceled";
            item.Details = wasPaused ? "Canceled while paused." : "Canceled before a download slot was assigned.";
            return true;
        }
        item.Cancellation.Cancel();
        return true;
    }

    public bool Pause(string id)
    {
        var item = Items.FirstOrDefault(candidate => string.Equals(candidate.Id, id, StringComparison.OrdinalIgnoreCase));
        if (item is null || item.Status is not ("Queued" or "Running")) return false;
        if (item.Status == "Queued")
        {
            item.Status = "Paused";
            item.Details = "Paused before a download slot was assigned.";
            return true;
        }
        item.PauseRequested = true;
        item.Cancellation.Cancel();
        return true;
    }

    public bool SetSourceAddresses(string id, IReadOnlyList<IPAddress>? sourceAddresses, bool policyLimited = false)
    {
        var item = Items.FirstOrDefault(candidate => string.Equals(candidate.Id, id, StringComparison.OrdinalIgnoreCase));
        if (item is null || item.Status is "Completed" or "Failed" or "Canceled") return false;
        var wasNetworkPolicyPaused = item.NetworkPolicyPaused;
        item.SourceAddresses = sourceAddresses?.Distinct().ToArray();
        if (!policyLimited) item.PreferredSourceAddresses = item.SourceAddresses;
        item.NetworkPolicyPaused = policyLimited && item.SourceAddresses is { Count: 0 };
        if (item.Status == "Paused" && wasNetworkPolicyPaused && !item.NetworkPolicyPaused && item.SourceAddresses is { Count: > 0 })
        {
            item.Cancellation.Dispose();
            item.Cancellation = new CancellationTokenSource();
            item.Status = "Queued";
            StartQueued();
        }
        if (item.Status == "Running")
        {
            item.SwitchRequested = true;
            item.PauseRequested = true;
            item.Cancellation.Cancel();
            item.Details = "Switching network path; the download will restart from its safe checkpoint where available.";
        }
        SchedulePersist();
        return true;
    }

    public bool Relink(string id, string rawUrl, BrowserRequestContext? browserContext = null)
    {
        if (!Uri.TryCreate(rawUrl?.Trim(), UriKind.Absolute, out var source)
            || source.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(source.UserInfo))
            throw new ArgumentException("Provide a complete HTTP(S) replacement URL without embedded credentials.", nameof(rawUrl));
        var item = Items.FirstOrDefault(candidate => string.Equals(candidate.Id, id, StringComparison.OrdinalIgnoreCase));
        if (item is null || item.Status is "Completed" or "Canceled") return false;
        item.Url = source.AbsoluteUri;
        if (browserContext is not null) item.BrowserContext = browserContext;
        item.Details = "Replacement link set; matching server validators will be checked before any checkpoint is reused.";
        if (item.Status == "Running")
        {
            item.SwitchRequested = true;
            item.PauseRequested = true;
            item.Cancellation.Cancel();
        }
        else if (item.Status is "Paused" or "Failed")
        {
            item.Cancellation.Dispose();
            item.Cancellation = new CancellationTokenSource();
            item.PauseRequested = false;
            item.Status = "Queued";
            StartQueued();
        }
        SchedulePersist();
        return true;
    }

    public bool Resume(string id)
    {
        var item = Items.FirstOrDefault(candidate => string.Equals(candidate.Id, id, StringComparison.OrdinalIgnoreCase));
        if (item is null || item.Status is not ("Paused" or "Failed")) return false;
        item.Cancellation.Dispose();
        item.Cancellation = new CancellationTokenSource();
        item.PauseRequested = false;
        item.Status = "Queued";
        item.Details = "Waiting to resume from the saved checkpoint where available.";
        StartQueued();
        return true;
    }

    public bool RemoveFinished(string id)
    {
        var item = Items.FirstOrDefault(candidate => string.Equals(candidate.Id, id, StringComparison.OrdinalIgnoreCase));
        if (item is null || item.Status is "Queued" or "Running") return false;
        Items.Remove(item);
        item.Cancellation.Dispose();
        return true;
    }

    public int ClearFinished()
    {
        var finished = Items.Where(item => item.Status is "Completed" or "Failed" or "Canceled").ToArray();
        foreach (var item in finished)
        {
            Items.Remove(item);
            item.Cancellation.Dispose();
        }
        return finished.Length;
    }

    public object Snapshot() => Items.Select(item => new
    {
        id = item.Id, url = item.Url, destination = item.Destination, status = item.Status,
        createdAt = item.CreatedAt,
        sourceAddresses = item.SourceAddresses?.Select(address => address.ToString()).ToArray(),
        preferredSourceAddresses = item.PreferredSourceAddresses?.Select(address => address.ToString()).ToArray(),
        networkPolicyPaused = item.NetworkPolicyPaused,
        progressPercent = Math.Round(item.ProgressPercent, 2), bytesDownloaded = item.BytesDownloaded,
        wireBytesReceived = item.WireBytesReceived, totalBytes = item.TotalBytes,
        retries = item.Retries, speed = item.Speed, details = item.Details,
        startedAt = item.StartedAt, finishedAt = item.FinishedAt,
        elapsedSeconds = Math.Round(item.ElapsedSeconds, 2),
        averageBytesPerSecond = Math.Round(item.AverageBytesPerSecond, 2),
        peakBytesPerSecond = Math.Round(item.PeakBytesPerSecond, 2),
        bytesBySourceAddress = new Dictionary<string, long>(item.BytesBySourceAddress, StringComparer.OrdinalIgnoreCase)
    }).ToArray();

    private async Task RunAsync(QueueDownloadItem item)
    {
        var started = false;
        var paused = false;
        long runStartedTick = 0;
        try
        {
            await _slots.WaitAsync(item.Cancellation.Token);
            started = true;
            if (item.Status != "Queued") return;
            if (item.SourceAddresses is { Count: 0 })
            {
                item.Status = "Paused";
                item.Speed = "Paused";
                item.Details = "No enabled network paths remain. Enable a network and resume this item.";
                return;
            }
            item.Status = "Running";
            item.StartedAt = DateTimeOffset.Now;
            item.Details = "Preparing HTTP(S) download.";
            runStartedTick = Stopwatch.GetTimestamp();
            var speedSamples = new Queue<(long Tick, long Bytes)>();
            var addresses = item.SourceAddresses ?? _getSourceAddresses();
            using var engine = addresses.Count == 0 ? new DownloadEngine() : new DownloadEngine(addresses);
            var progress = new Progress<DownloadProgress>(update =>
            {
                item.BytesDownloaded = update.BytesWritten;
                item.TotalBytes = update.TotalBytes;
                var committedPercent = update.TotalBytes > 0
                    ? Math.Clamp(update.BytesWritten * 100d / update.TotalBytes, 0, 100) : 0;
                item.ProgressPercent = Math.Max(item.ProgressPercent, committedPercent);
                item.ProgressText = update.TotalBytes > 0
                    ? $"{item.ProgressPercent:0.0}% Â· {FormatBytes(update.BytesWritten)} committed / {FormatBytes(update.TotalBytes)}"
                    : $"{FormatBytes(update.BytesWritten)} committed Â· size unknown";
                item.Retries = Math.Max(update.RetryAttempts, engine.RetryAttempts);
                item.Details = "Download active; progress advances as chunks are committed to disk.";
            });
            var transferProgress = new Progress<long>(wireBytes =>
            {
                item.WireBytesReceived = wireBytes;
                var now = Stopwatch.GetTimestamp();
                speedSamples.Enqueue((now, wireBytes));
                while (speedSamples.Count > 1
                    && (now - speedSamples.Peek().Tick) / (double)Stopwatch.Frequency > 5)
                    speedSamples.Dequeue();

                var oldest = speedSamples.Peek();
                var sampleSeconds = (now - oldest.Tick) / (double)Stopwatch.Frequency;
                if (sampleSeconds >= 0.5)
                {
                    var smoothedBytesPerSecond = Math.Max(0, wireBytes - oldest.Bytes) / sampleSeconds;
                    item.Speed = $"{smoothedBytesPerSecond / 1_000_000:0.00} MB/s";
                    item.PeakBytesPerSecond = Math.Max(item.PeakBytesPerSecond, smoothedBytesPerSecond);
                }

                if (item.TotalBytes > 0)
                {
                    // Wire bytes include retried data, so use this only as an estimate until
                    // the engine commits completed chunks and finally validates the full file.
                    var estimatedPercent = Math.Clamp(wireBytes * 100d / item.TotalBytes, 0, 99.5);
                    item.ProgressPercent = Math.Max(item.ProgressPercent, estimatedPercent);
                    item.ProgressText = $"{item.ProgressPercent:0.0}% Â· {FormatBytes(wireBytes)} network bytes received";
                }
                else
                {
                    item.ProgressText = $"{FormatBytes(wireBytes)} network bytes received Â· size unknown";
                }
                item.Details = "Receiving data; progress is an estimate until each chunk is committed.";
            });
            var result = await engine.DownloadAsync(new DownloadOptions
            {
                Source = new Uri(item.Url), DestinationPath = item.Destination,
                // Several queued files already multiply the request count; cap per-file range
                // workers to avoid overwhelming origins when three queue slots are active.
                Parallelism = Math.Clamp(_getParallelism(), 1, 4),
                ChunkSizeBytes = _getChunkSize(), RetryCount = 3,
                BandwidthLimiter = _bandwidthLimiter, BrowserContext = item.BrowserContext,
                SourceAddressLimiters = _sourceAddressLimiters,
                SourceAddressBytesReceived = (address, bytes) =>
                {
                    var dispatcher = System.Windows.Application.Current?.Dispatcher;
                    if (dispatcher is not null)
                        dispatcher.BeginInvoke(new Action(() => RecordSourceBytes(item, address, bytes)));
                }
            }, progress, item.Cancellation.Token, transferProgress);
            item.BytesDownloaded = result.BytesDownloaded;
            item.WireBytesReceived = Math.Max(item.WireBytesReceived, result.BytesDownloaded);
            item.TotalBytes = result.BytesDownloaded;
            item.ProgressPercent = 100;
            item.ProgressText = $"100% ({FormatBytes(result.BytesDownloaded)})";
            item.Retries = Math.Max(item.Retries, engine.RetryAttempts);
            item.Status = "Completed";
            item.Details = $"SHA-256 {result.Sha256}";
        }
        catch (OperationCanceledException)
        {
            if (item.SwitchRequested)
            {
                paused = true;
                item.Speed = "Switching network";
                item.Details = "Network path changed; resuming from the saved checkpoint where supported.";
            }
            else if (item.PauseRequested)
            {
                paused = true;
                item.Speed = "Paused";
                item.Details = "Paused; resumable checkpoint retained where supported.";
            }
            else
            {
                item.Status = "Canceled";
                item.Speed = "Canceled";
                item.Details = "Canceled; resumable checkpoint retained where supported.";
            }
        }
        
        catch (Exception ex)
        {
            item.Status = "Failed";
            item.Speed = "â€”";
            item.Details = DescribeFailure(ex);
        }
        finally
        {
            if (item.StartedAt is not null)
            {
                item.FinishedAt = DateTimeOffset.Now;
                item.ElapsedSeconds = Math.Max(0.001,
                    (Stopwatch.GetTimestamp() - runStartedTick) / (double)Stopwatch.Frequency);
                item.AverageBytesPerSecond = item.WireBytesReceived / item.ElapsedSeconds;
                if (item.Status == "Completed")
                    item.Speed = $"{item.AverageBytesPerSecond / 1_000_000:0.00} MB/s";
                var metrics = $"Elapsed {FormatDuration(item.ElapsedSeconds)} Â· average {item.AverageBytesPerSecond / 1_000_000:0.00} MB/s Â· peak {item.PeakBytesPerSecond / 1_000_000:0.00} MB/s Â· wire {FormatBytes(item.WireBytesReceived)}";
                if (item.Status == "Completed")
                    item.Details = $"{item.Details} Â· {metrics}";
                else
                    item.Details = $"{item.Details} Â· {metrics}";
            }
            if (started) _slots.Release();
            _scheduled.Remove(item.Id);
            if (paused)
            {
                var restartAfterSwitch = item.SwitchRequested || item.PolicyStopRequested;
                item.Cancellation.Dispose();
                item.Cancellation = new CancellationTokenSource();
                item.PauseRequested = false;
                item.SwitchRequested = false;
                item.PolicyStopRequested = false;
                item.Status = restartAfterSwitch ? "Queued" : "Paused";
            }
            StartQueued();
        }
    }

    private static string DescribeFailure(Exception exception)
    {
        var messages = new List<string>();
        for (Exception? current = exception; current is not null && messages.Count < 4; current = current.InnerException)
        {
            var message = current.Message.Trim();
            if (message.Length > 220) message = message[..217] + "...";
            if (message.Length > 0 && !messages.Contains(message, StringComparer.OrdinalIgnoreCase))
                messages.Add(message);
        }
        return messages.Count == 0 ? exception.GetType().Name : string.Join(" â†’ ", messages);
    }

    private static string FormatDuration(double seconds)
    {
        var duration = TimeSpan.FromSeconds(Math.Max(0, seconds));
        return duration.TotalHours >= 1 ? duration.ToString(@"h\:mm\:ss") : duration.ToString(@"m\:ss");
    }

    private static string FormatBytes(long value)
    {
        if (value < 0) return "unknown";
        string[] units = ["B", "KiB", "MiB", "GiB", "TiB"];
        double size = value;
        var unit = 0;
        while (size >= 1024 && unit < units.Length - 1) { size /= 1024; unit++; }
        return $"{size:0.##} {units[unit]}";
    }
}

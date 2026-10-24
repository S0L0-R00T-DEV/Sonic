using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Net;
using SpeedOFreq.Core;

namespace SpeedOFreq.App;

public sealed class QueueDownloadItem : INotifyPropertyChanged
{
    private string _status = "Queued";
    private string _progressText = "Waiting";
    private string _details = "";
    private double _progressPercent;
    private long _bytesDownloaded;
    private long _wireBytesReceived;
    private long _totalBytes = -1;
    private int _retries;
    private string _speed = "—";
    private DateTimeOffset? _startedAt;
    private DateTimeOffset? _finishedAt;
    private double _elapsedSeconds;
    private double _averageBytesPerSecond;
    private double _peakBytesPerSecond;

    public string Id { get; init; } = Guid.NewGuid().ToString("N")[..8];
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.Now;
    public string Url { get; set; } = "";
    public string Destination { get; init; } = "";
    public IReadOnlyList<IPAddress>? SourceAddresses { get; set; }
    public IReadOnlyList<IPAddress>? PreferredSourceAddresses { get; set; }
    public bool NetworkPolicyPaused { get; set; }
    // Browser session data is memory-only and intentionally excluded from persisted queue DTOs.
    public BrowserRequestContext? BrowserContext { get; set; }
    public Dictionary<string, long> BytesBySourceAddress { get; } = new(StringComparer.OrdinalIgnoreCase);
    public bool PauseRequested { get; set; }

    internal void RecordSourceBytes(string address, long bytes)
    {
        if (bytes <= 0) return;
        BytesBySourceAddress[address] = BytesBySourceAddress.GetValueOrDefault(address) + bytes;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(BytesBySourceAddress)));
    }
    public bool SwitchRequested { get; set; }
    public bool PolicyStopRequested { get; set; }
    public string Status { get => _status; set => Set(ref _status, value); }
    public string ProgressText { get => _progressText; set => Set(ref _progressText, value); }
    public string Details { get => _details; set => Set(ref _details, value); }
    public double ProgressPercent { get => _progressPercent; set => Set(ref _progressPercent, value); }
    public long BytesDownloaded { get => _bytesDownloaded; set => Set(ref _bytesDownloaded, value); }
    public long WireBytesReceived { get => _wireBytesReceived; set => Set(ref _wireBytesReceived, value); }
    public long TotalBytes { get => _totalBytes; set => Set(ref _totalBytes, value); }
    public int Retries { get => _retries; set => Set(ref _retries, value); }
    public string Speed { get => _speed; set => Set(ref _speed, value); }
    public DateTimeOffset? StartedAt { get => _startedAt; set => Set(ref _startedAt, value); }
    public DateTimeOffset? FinishedAt { get => _finishedAt; set => Set(ref _finishedAt, value); }
    public double ElapsedSeconds { get => _elapsedSeconds; set => Set(ref _elapsedSeconds, value); }
    public double AverageBytesPerSecond { get => _averageBytesPerSecond; set => Set(ref _averageBytesPerSecond, value); }
    public double PeakBytesPerSecond { get => _peakBytesPerSecond; set => Set(ref _peakBytesPerSecond, value); }
    internal CancellationTokenSource Cancellation { get; set; } = new();

    public event PropertyChangedEventHandler? PropertyChanged;
    private void Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return;
        field = value;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }
}

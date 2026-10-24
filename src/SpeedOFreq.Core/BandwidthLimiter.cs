using System.Diagnostics;

namespace SpeedOFreq.Core;

/// <summary>
/// A shared, cooperative byte-rate limiter. Share one instance across concurrent transfers to apply
/// the configured ceiling to their combined network traffic rather than to each worker separately.
/// </summary>
public sealed class BandwidthLimiter
{
    private readonly object _gate = new();
    private long _bytesPerSecond;
    private long _nextSlotTicks;

    public void SetLimitBytesPerSecond(long? bytesPerSecond)
    {
        Interlocked.Exchange(ref _bytesPerSecond, Math.Max(0, bytesPerSecond ?? 0));
        if (bytesPerSecond is null or <= 0)
        {
            lock (_gate) _nextSlotTicks = Stopwatch.GetTimestamp();
        }
    }

    public async ValueTask WaitAsync(int byteCount, CancellationToken cancellationToken)
    {
        if (byteCount <= 0) return;
        var rate = Volatile.Read(ref _bytesPerSecond);
        if (rate <= 0) return;

        long waitTicks;
        lock (_gate)
        {
            rate = Volatile.Read(ref _bytesPerSecond);
            if (rate <= 0) return;
            var now = Stopwatch.GetTimestamp();
            var start = Math.Max(now, _nextSlotTicks);
            waitTicks = start - now;
            var serviceTicks = Math.Max(1, (long)Math.Ceiling(byteCount * (double)Stopwatch.Frequency / rate));
            _nextSlotTicks = start + serviceTicks;
        }

        if (waitTicks > 0)
            await Task.Delay(TimeSpan.FromSeconds(waitTicks / (double)Stopwatch.Frequency), cancellationToken);
    }
}
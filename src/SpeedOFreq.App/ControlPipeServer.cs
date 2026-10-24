using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace SpeedOFreq.App;

public sealed class ControlPipeServer : IAsyncDisposable
{
    public static string PipeName
    {
        get
        {
            var configured = Environment.GetEnvironmentVariable("SONIC_BACKEND_PIPE");
            return string.IsNullOrWhiteSpace(configured) ? "SpeedOFreqSonic.Control.v1" : configured;
        }
    }
    private readonly Func<JsonElement, Task<object>> _handler;
    private readonly CancellationTokenSource _stop = new();
    private Task? _loop;

    public ControlPipeServer(Func<JsonElement, Task<object>> handler) => _handler = handler;
    public void Start() => _loop ??= Task.Run(RunAsync);

    private async Task RunAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            NamedPipeServerStream? pipe = null;
            try
            {
                pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 8,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(_stop.Token);
                using (pipe)
                using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, leaveOpen: true))
                using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true })
                {
                    var line = await reader.ReadLineAsync(_stop.Token);
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    object response;
                    try
                    {
                        using var document = JsonDocument.Parse(line);
                        response = await _handler(document.RootElement.Clone());
                    }
                    catch (Exception ex) { response = new { ok = false, error = ex.Message }; }
                    await writer.WriteLineAsync(JsonSerializer.Serialize(response));
                }
                pipe = null;
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested) { break; }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
            finally { pipe?.Dispose(); }
        }
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        if (_loop is not null) { try { await _loop; } catch (OperationCanceledException) { } }
        _stop.Dispose();
    }
}

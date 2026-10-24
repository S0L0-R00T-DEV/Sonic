using Microsoft.Win32;
using SpeedOFreq.Core;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.NetworkInformation;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using Polyline = System.Windows.Shapes.Polyline;

namespace SpeedOFreq.App;

public partial class MainWindow : Window
{
    private readonly string _settingsPath = Path.Combine(AppStoragePaths.Root, "settings.json");
    private CancellationTokenSource? _downloadCancellation;
    private string? _lastDestination;
    private bool _isInitializing = true;
    private bool _pauseRequested;
    private CancellationTokenSource? _urlAnalysisDebounce;
    private double _currentBytesPerSecond;
    private double _peakBytesPerSecond;
    private double _averageBytesPerSecond;
    private readonly Queue<double> _speedSamples = new();
    private readonly List<Border> _chunkTiles = new();
    private string _speedUnit = "MB";
    private long _downloadStartTimestamp;
    private DownloadEngine? _activeEngine;
    private long _wireBytesReceived;
    private long _lastWireBytesReceived;
    private long _lastTelemetryTimestamp;
    private readonly DispatcherTimer _telemetryTimer;
    private readonly Dictionary<string, long> _lastInterfaceBytes = new(StringComparer.Ordinal);
    private DownloadQueueService _queue = null!;
    private ControlPipeServer _controlServer = null!;

    public MainWindow()
    {
        InitializeComponent();
        // Use the mode resolved from WPF startup args. Environment.GetCommandLineArgs can diverge
        // from StartupEventArgs.Args for this WinExe launch path; a false negative leaves the
        // backend's full-size WPF window visible behind the Electron UI.
        if (App.BackendMode)
        {
            ShowInTaskbar = false;
            ShowActivated = false;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            Width = 1;
            Height = 1;
            Left = -10000;
            Top = -10000;
            Opacity = 0;
        }
        _telemetryTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _telemetryTimer.Tick += TelemetryTimer_Tick;
        LoadSettings();
        if (string.IsNullOrWhiteSpace(DestinationTextBox.Text))
            DestinationTextBox.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "download.bin");
        PopulateInterfaces();
        _queue = new DownloadQueueService(
            () => InterfaceListBox.Items.OfType<NetworkPathOption>().Where(path => path.IsSelected).Select(path => path.Address).Distinct().ToArray(),
            () => SelectedInt(ParallelismComboBox, 8),
            () => SelectedInt(ChunkSizeComboBox, 4 * 1024 * 1024));
        QueueListView.ItemsSource = _queue.Items;
        _controlServer = new ControlPipeServer(DispatchControlRequestAsync);
        _controlServer.Start();
        _isInitializing = false;
        SaveSettings();
        UpdateInterfaceSpeeds();
        _telemetryTimer.Start();
    }

    private void LoadSettings()
    {
        try
        {
            if (!File.Exists(_settingsPath)) return;
            var settings = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(_settingsPath));
            if (settings is null) return;
            if (!string.IsNullOrWhiteSpace(settings.DestinationPath))
                DestinationTextBox.Text = settings.DestinationPath;
            SelectComboTag(ParallelismComboBox, settings.Parallelism.ToString());
            SelectComboTag(ChunkSizeComboBox, settings.ChunkSizeBytes.ToString());
            _speedUnit = settings.SpeedUnit == "Mbps" ? "Mbps" : "MB";
            SpeedUnitComboBox.SelectedIndex = _speedUnit == "Mbps" ? 1 : 0;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            // Invalid preferences are ignored; the application remains usable with defaults.
        }
    }

    private static void SelectComboTag(ComboBox combo, string tag)
    {
        foreach (var item in combo.Items.OfType<ComboBoxItem>())
        {
            if (string.Equals(item.Tag?.ToString(), tag, StringComparison.Ordinal))
            {
                combo.SelectedItem = item;
                return;
            }
        }
    }

    private void SaveSettings()
    {
        if (_isInitializing) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_settingsPath)!);
            var settings = new AppSettings
            {
                DestinationPath = DestinationTextBox.Text,
                Parallelism = SelectedInt(ParallelismComboBox, 8),
                ChunkSizeBytes = SelectedInt(ChunkSizeComboBox, 4 * 1024 * 1024),
                SpeedUnit = _speedUnit
            };
            File.WriteAllText(_settingsPath, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            SetStatus("Settings could not be saved; downloads are still available.", true);
        }
    }

    private static int SelectedInt(ComboBox combo, int fallback) =>
        combo.SelectedItem is ComboBoxItem item && int.TryParse(item.Tag?.ToString(), out var value) ? value : fallback;

    private void PopulateInterfaces(bool preserveSelection = false)
    {
        var selected = preserveSelection
            ? InterfaceListBox.Items.OfType<NetworkPathOption>().Where(path => path.IsSelected)
                .Select(path => path.Address.ToString()).ToHashSet(StringComparer.Ordinal)
            : new HashSet<string>(StringComparer.Ordinal);

        var paths = new List<NetworkPathOption>();
        foreach (var network in NetworkInterface.GetAllNetworkInterfaces()
                     .Where(item => item.OperationalStatus == OperationalStatus.Up
                         && item.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel)
                         && !IsLikelyVirtualAdapter(item))
                     .OrderBy(item => item.Name, StringComparer.OrdinalIgnoreCase))
        {
            foreach (var address in network.GetIPProperties().UnicastAddresses
                         .Select(item => item.Address)
                         .Where(address => address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork
                             && !IPAddress.IsLoopback(address)
                             && !address.ToString().StartsWith("169.254.", StringComparison.Ordinal))
                         .Distinct())
            {
                paths.Add(new NetworkPathOption($"{network.Name} · {address}", address)
                {
                    IsSelected = selected.Contains(address.ToString())
                });
            }
        }
        InterfaceListBox.ItemsSource = paths;
    }

    private static bool IsLikelyVirtualAdapter(NetworkInterface network)
    {
        var identity = network.Name + " " + network.Description;
        string[] markers = ["hyper-v", "vethernet", "virtualbox", "vmware", "virtual ethernet",
            "virtual adapter", "wi-fi direct", "docker", "wsl", "wintun", "wireguard", "tap-windows", "npcap", "vpn tunnel"];
        return markers.Any(marker => identity.Contains(marker, StringComparison.OrdinalIgnoreCase));
    }

    private void RefreshPathsButton_Click(object sender, RoutedEventArgs e)
    {
        PopulateInterfaces(preserveSelection: true);
        SetStatus("Network addresses refreshed. Select only independent internet paths.", false);
    }

    private void PasteButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (!Clipboard.ContainsText())
            {
                SetStatus("Clipboard does not contain text.", true);
                return;
            }
            UrlTextBox.Text = Clipboard.GetText().Trim();
            UrlTextBox.CaretIndex = UrlTextBox.Text.Length;
        }
        catch (Exception ex) when (ex is System.Runtime.InteropServices.ExternalException or InvalidOperationException)
        {
            SetStatus("Could not read the clipboard. Paste the URL into the field manually.", true);
        }
    }

    private async void AnalyzeButton_Click(object sender, RoutedEventArgs e) => await AnalyzeUrlAsync();

    private void UrlTextBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        if (_isInitializing) return;
        PreviewNameText.Text = "URL changed — analyze to refresh file details";
        PreviewDetailText.Text = "The file has not been inspected yet.";
        FileTypeIcon.Text = "FILE";
        ChunkSummaryText.Text = "Waiting for file details";
        SaveSettings();
        _urlAnalysisDebounce?.Cancel();
        var value = UrlTextBox.Text.Trim();
        if (value.Length > 0)
        {
            _urlAnalysisDebounce = new CancellationTokenSource();
            var token = _urlAnalysisDebounce.Token;
            _ = AnalyzeAfterTypingAsync(value, token);
        }
    }

    private async Task AnalyzeAfterTypingAsync(string value, CancellationToken token)
    {
        try
        {
            await Task.Delay(750, token);
            if (!token.IsCancellationRequested && string.Equals(UrlTextBox.Text.Trim(), value, StringComparison.Ordinal))
                await AnalyzeUrlAsync();
        }
        catch (OperationCanceledException) { }
    }

    private async Task AnalyzeUrlAsync()
    {
        if (_downloadCancellation is not null) return;
        var raw = UrlTextBox.Text.Trim();
        if (!TryParseDirectUrl(raw, out var source, out var error))
        {
            PreviewNameText.Text = "URL error";
            PreviewDetailText.Text = error;
            FileTypeIcon.Text = "ERR";
            SetStatus(error, true);
            return;
        }

        PreviewNameText.Text = "Inspecting URL…";
        PreviewDetailText.Text = "Checking response headers and byte-range support.";
        SetStatus("Inspecting the file URL…", false);
        AnalyzeButton.IsEnabled = false;
        PasteButton.IsEnabled = false;
        try
        {
            using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
            {
                Timeout = TimeSpan.FromSeconds(12)
            };
            using var response = await SendMetadataProbeAsync(client, source, CancellationToken.None);
            if ((int)response.StatusCode >= 400)
                throw new HttpRequestException($"Server returned HTTP {(int)response.StatusCode} ({response.ReasonPhrase}).");

            var total = response.Content.Headers.ContentRange?.Length ?? response.Content.Headers.ContentLength ?? -1;
            var filename = GetSuggestedFileName(response, source);
            var contentType = response.Content.Headers.ContentType?.MediaType ?? "unknown content type";
            var supportsRanges = response.StatusCode == HttpStatusCode.PartialContent;
            PreviewNameText.Text = filename;
            var extension = Path.GetExtension(filename).TrimStart('.').ToUpperInvariant();
            FileTypeIcon.Text = extension.Length > 0 ? extension[..Math.Min(4, extension.Length)] : "FILE";
            PreviewDetailText.Text = $"{(total >= 0 ? FormatBytes(total) : "Size unknown")} · {contentType} · {(supportsRanges ? "byte ranges supported" : "server did not confirm byte ranges")}";
            ChunkSummaryText.Text = total > 0 && supportsRanges
                ? $"{Math.Ceiling((double)total / SelectedInt(ChunkSizeComboBox, 4 * 1024 * 1024)):N0} chunks estimated · {FormatBytes(total)} total"
                : supportsRanges ? "Range-enabled file · size unknown" : "Single-stream fallback may be required";
            BuildChunkTiles(total > 0 && supportsRanges
                ? (int)Math.Min(256, Math.Ceiling((double)total / SelectedInt(ChunkSizeComboBox, 4 * 1024 * 1024)))
                : 0);
            SetStatus("URL inspected. Review the file details before starting.", false);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException or InvalidOperationException)
        {
            PreviewNameText.Text = "Could not inspect this URL";
            PreviewDetailText.Text = ex.Message;
            FileTypeIcon.Text = "ERR";
            SetStatus("URL analysis failed: " + ex.Message, true);
        }
        finally
        {
            AnalyzeButton.IsEnabled = _downloadCancellation is null;
            PasteButton.IsEnabled = _downloadCancellation is null;
        }
    }

    private static bool TryParseDirectUrl(string raw, out Uri source, out string error)
    {
        source = null!;
        error = "";
        if (string.IsNullOrWhiteSpace(raw))
        {
            error = "Enter or paste a direct HTTP(S) file URL.";
            return false;
        }
        if (raw.StartsWith("magnet:", StringComparison.OrdinalIgnoreCase) || raw.EndsWith(".torrent", StringComparison.OrdinalIgnoreCase))
        {
            error = "Torrent and magnet links are not supported in this direct HTTP(S) preview.";
            return false;
        }
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var parsed)
            || (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps)
            || !string.IsNullOrWhiteSpace(parsed.UserInfo)
            || string.IsNullOrWhiteSpace(parsed.Host))
        {
            error = "URL error: enter a complete http:// or https:// download URL without embedded credentials.";
            return false;
        }
        source = parsed;
        return true;
    }

    private static async Task<HttpResponseMessage> SendMetadataProbeAsync(HttpClient client, Uri source, CancellationToken token)
    {
        var current = source;
        for (var hop = 0; hop <= 8; hop++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, current);
            request.Headers.Range = new RangeHeaderValue(0, 0);
            request.Headers.AcceptEncoding.ParseAdd("identity");
            var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
            if ((int)response.StatusCode is >= 300 and < 400 && response.Headers.Location is not null)
            {
                var next = response.Headers.Location.IsAbsoluteUri ? response.Headers.Location : new Uri(current, response.Headers.Location);
                response.Dispose();
                if ((next.Scheme != Uri.UriSchemeHttp && next.Scheme != Uri.UriSchemeHttps)
                    || (current.Scheme == Uri.UriSchemeHttps && next.Scheme != Uri.UriSchemeHttps)
                    || !string.IsNullOrWhiteSpace(next.UserInfo))
                    throw new HttpRequestException("The URL redirects to an unsupported or insecure destination.");
                current = next;
                continue;
            }
            if ((int)response.StatusCode is >= 300 and < 400)
            {
                response.Dispose();
                throw new HttpRequestException("The server returned a redirect without a usable destination.");
            }
            return response;
        }
        throw new HttpRequestException("The URL redirected too many times.");
    }

    private static string GetSuggestedFileName(HttpResponseMessage response, Uri source)
    {
        var disposition = response.Content.Headers.ContentDisposition;
        var candidate = disposition?.FileNameStar ?? disposition?.FileName;
        if (!string.IsNullOrWhiteSpace(candidate))
            candidate = candidate.Trim().Trim('"');
        if (string.IsNullOrWhiteSpace(candidate))
            candidate = Path.GetFileName(response.RequestMessage?.RequestUri?.LocalPath ?? source.LocalPath);
        if (string.IsNullOrWhiteSpace(candidate) || candidate is "." or "/")
            candidate = "download.bin";
        foreach (var invalid in Path.GetInvalidFileNameChars()) candidate = candidate.Replace(invalid, '_');
        return candidate;
    }

    private async void StartButton_Click(object sender, RoutedEventArgs e)
    {
        if (_downloadCancellation is not null) return;
        if (!TryParseDirectUrl(UrlTextBox.Text.Trim(), out var source, out var error))
        {
            PreviewNameText.Text = "URL error";
            PreviewDetailText.Text = error;
            SetStatus(error, true);
            return;
        }
        var destination = DestinationTextBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(destination) || Directory.Exists(destination))
        {
            SetStatus("Choose a full destination file path, including the file name.", true);
            return;
        }

        try
        {
            destination = Path.GetFullPath(destination);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            SetStatus("Destination path is invalid: " + ex.Message, true);
            return;
        }

        if (File.Exists(destination))
        {
            var answer = MessageBox.Show(this,
                $"The destination already exists:\n{destination}\n\nReplace it only after the new download completes and passes verification?",
                "Confirm file replacement", MessageBoxButton.YesNo, MessageBoxImage.Warning, MessageBoxResult.No);
            if (answer != MessageBoxResult.Yes)
            {
                SetStatus("Download not started; the existing file was preserved.", false);
                return;
            }
        }

        DestinationTextBox.Text = destination;
        if (ParallelismComboBox.SelectedItem is not ComboBoxItem parallelItem
            || !int.TryParse(parallelItem.Tag?.ToString(), out var parallelism)
            || ChunkSizeComboBox.SelectedItem is not ComboBoxItem chunkItem
            || !int.TryParse(chunkItem.Tag?.ToString(), out var chunkSize))
        {
            SetStatus("Select valid download settings.", true);
            return;
        }

        _urlAnalysisDebounce?.Cancel();
        SaveSettings();
        var selectedAddresses = InterfaceListBox.Items.OfType<NetworkPathOption>()
            .Where(path => path.IsSelected).Select(path => path.Address).Distinct().ToArray();
        var pathDescription = selectedAddresses.Length == 0 ? "Windows default route" : $"{selectedAddresses.Length} selected source address(es)";
        _downloadCancellation = new CancellationTokenSource();
        _pauseRequested = false;
        FinalStatsCard.Visibility = Visibility.Collapsed;
        SetDownloadInputsEnabled(false);
        StartButton.IsEnabled = false;
        StartButton.Content = "Downloading…";
        PauseButton.IsEnabled = true;
        PauseButton.Content = "Pause";
        CancelButton.IsEnabled = true;
        OpenFolderButton.IsEnabled = false;
        DownloadProgressBar.IsIndeterminate = true;
        DownloadProgressBar.Value = 0;
        ProgressPercentText.Text = "0%";
        ResultText.Text = "";
        RetryCountText.Text = "0";
        EtaText.Text = "—";
        Interlocked.Exchange(ref _wireBytesReceived, 0);
        Interlocked.Exchange(ref _lastWireBytesReceived, 0);
        _lastTelemetryTimestamp = Stopwatch.GetTimestamp();
        _lastInterfaceBytes.Clear();
        _downloadStartTimestamp = Stopwatch.GetTimestamp();
        var downloadStartedAt = DateTimeOffset.Now;
        var terminalStatus = "Failed";
        var terminalDetails = "";
        long? finalFileSize = null;
        string? finalSha256 = null;
        var resumedFromCheckpoint = false;
        _currentBytesPerSecond = 0;
        _peakBytesPerSecond = 0;
        _averageBytesPerSecond = 0;
        _speedSamples.Clear();
        SpeedText.Text = FormatSpeed(0);
        SpeedSubText.Text = $"AVG {FormatSpeed(0)} · PEAK {FormatSpeed(0)}";
        UpdateSpeedChart();
        SetStatus("Starting download and checking server…", false);
        ProgressDetailText.Text = "Inspecting source and preparing chunks…";

        try
        {
            using var engine = selectedAddresses.Length == 0 ? new DownloadEngine() : new DownloadEngine(selectedAddresses);
            _activeEngine = engine;
            var progress = new Progress<DownloadProgress>(update =>
            {
                var hasKnownTotal = update.TotalBytes >= 0;
                var percentage = update.TotalBytes > 0 ? Math.Clamp(update.BytesWritten * 100.0 / update.TotalBytes, 0, 100) : 0;
                DownloadProgressBar.IsIndeterminate = !hasKnownTotal;
                if (update.TotalBytes > 0) DownloadProgressBar.Value = percentage;
                ProgressPercentText.Text = update.TotalBytes > 0 ? $"{percentage:0.0}%" : update.TotalBytes == 0 ? "—" : "…";
                ProgressDetailText.Text = $"{FormatBytes(update.BytesWritten)} / {FormatBytes(update.TotalBytes)} · {update.CompletedChunks}/{update.TotalChunks} chunks";
                RetryCountText.Text = Math.Max(update.RetryAttempts, _activeEngine?.RetryAttempts ?? 0).ToString();
                UpdateChunkTiles(update);
                if (hasKnownTotal && update.BytesWritten > 0 && _currentBytesPerSecond > 0)
                {
                    var remaining = Math.Max(0, update.TotalBytes - update.BytesWritten);
                    EtaText.Text = FormatDuration(TimeSpan.FromSeconds(remaining / _currentBytesPerSecond));
                }
                else EtaText.Text = "—";
                PathSpeedText.Text = selectedAddresses.Length == 0
                    ? $"Default route · {FormatSpeed(_currentBytesPerSecond)}"
                    : $"{selectedAddresses.Length} selected path(s) · combined {FormatSpeed(_currentBytesPerSecond)}";
            });

            _telemetryTimer.Start();
            UpdateInterfaceSpeeds();
            var result = await engine.DownloadAsync(new DownloadOptions
            {
                Source = source, DestinationPath = destination, Parallelism = parallelism,
                ChunkSizeBytes = chunkSize, RetryCount = 3
            }, progress, _downloadCancellation.Token, new InlineProgress<long>(value => Interlocked.Exchange(ref _wireBytesReceived, value)));

            _lastDestination = result.DestinationPath;
            terminalStatus = "Completed";
            terminalDetails = pathDescription;
            finalFileSize = result.BytesDownloaded;
            finalSha256 = result.Sha256;
            resumedFromCheckpoint = result.Resumed;
            DownloadProgressBar.IsIndeterminate = false;
            DownloadProgressBar.Value = 100;
            ProgressPercentText.Text = "100%";
            ProgressDetailText.Text = $"{FormatBytes(result.BytesDownloaded)} · {(result.UsedByteRanges ? "parallel byte ranges" : "single stream")}"
                + (result.Resumed ? " · resumed" : "") + $" · {pathDescription}";
            ResultText.Text = $"SHA-256  {result.Sha256}";
            OpenFolderButton.IsEnabled = true;
            ChunkSummaryText.Text = $"{result.ChunksDownloaded} chunks fetched · integrity hash verified";
            SetStatus("Download completed and final file published.", false);
        }
        catch (OperationCanceledException)
        {
            if (_pauseRequested)
            {
                terminalStatus = "Paused";
                terminalDetails = "Safe checkpointing allows the next session to resume where possible.";
                SetStatus("Paused. Resume to continue from the last safe checkpoint.", false);
                ProgressDetailText.Text = "The current request was stopped safely. Resume can continue when the source supports validated byte-range recovery.";
                StartButton.Content = "Resume download";
            }
            else
            {
                terminalStatus = "Canceled";
                terminalDetails = "The current attempt was canceled; resumable partial data is retained where supported.";
                SetStatus("Canceled. Recoverable checkpoints are retained where supported.", false);
                ProgressDetailText.Text = "You can start the same URL and destination again to resume.";
                StartButton.Content = "Start download";
            }
        }
        catch (Exception ex)
        {
            terminalStatus = "Failed";
            terminalDetails = ex.Message;
            SetStatus(ex.Message, true);
            ProgressDetailText.Text = "The partial file and checkpoint, if present, were retained for safe recovery.";
            StartButton.Content = "Start download";
        }
        finally
        {
            DownloadProgressBar.IsIndeterminate = false;
            var finishedAt = DateTimeOffset.Now;
            UpdateTelemetryDisplay(forceZero: true);
            var elapsedSeconds = Math.Max(0.001,
                (Stopwatch.GetTimestamp() - _downloadStartTimestamp) / (double)Stopwatch.Frequency);
            var transferredBytes = Interlocked.Read(ref _wireBytesReceived);
            _averageBytesPerSecond = transferredBytes / elapsedSeconds;
            SpeedSubText.Text = $"AVG {FormatSpeed(_averageBytesPerSecond)} · PEAK {FormatSpeed(_peakBytesPerSecond)} · final session stats";
            var retryCount = _activeEngine?.RetryAttempts ?? 0;
            if (int.TryParse(RetryCountText.Text, out var displayedRetryCount))
                retryCount = Math.Max(retryCount, displayedRetryCount);
            RetryCountText.Text = retryCount.ToString();
            RenderFinalStatistics(terminalStatus, destination, downloadStartedAt, finishedAt, elapsedSeconds,
                transferredBytes, finalFileSize, finalSha256, retryCount, resumedFromCheckpoint, terminalDetails);
            _activeEngine = null;
            _downloadCancellation.Dispose();
            _downloadCancellation = null;
            SetDownloadInputsEnabled(true);
            StartButton.IsEnabled = true;
            PauseButton.IsEnabled = false;
            PauseButton.Content = "Pause";
            CancelButton.IsEnabled = false;
            SaveSettings();
        }
    }

    private void AddToQueueButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var destination = DestinationTextBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(destination)
                || string.Equals(Path.GetFileName(destination), "download.bin", StringComparison.OrdinalIgnoreCase))
                destination = "";
            var item = _queue.Add(UrlTextBox.Text, destination.Length == 0 ? null : destination);
            QueueListView.SelectedItem = item;
            SetStatus($"Added download {item.Id} to the queue.", false);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            SetStatus("Could not queue download: " + ex.Message, true);
        }
    }

    private void StartQueueButton_Click(object sender, RoutedEventArgs e)
    {
        _queue.StartQueued();
        SetStatus("Queued downloads started; up to three downloads run concurrently.", false);
    }

    private void CancelQueuedButton_Click(object sender, RoutedEventArgs e)
    {
        if (QueueListView.SelectedItem is not QueueDownloadItem item)
        {
            SetStatus("Select a queued or running download first.", true);
            return;
        }
        SetStatus(_queue.Cancel(item.Id) ? $"Cancellation requested for {item.Id}." : "That download is no longer cancellable.", false);
    }

    private void RemoveSelectedButton_Click(object sender, RoutedEventArgs e)
    {
        if (QueueListView.SelectedItem is not QueueDownloadItem item)
        {
            SetStatus("Select a finished queue item to remove.", true);
            return;
        }
        SetStatus(_queue.RemoveFinished(item.Id)
            ? $"Removed finished queue item {item.Id}."
            : "Only completed, failed, or canceled items can be removed.", false);
    }

    private void ClearFinishedButton_Click(object sender, RoutedEventArgs e)
    {
        var removed = _queue.ClearFinished();
        SetStatus($"Removed {removed} finished queue item(s); active downloads were left untouched.", false);
    }

    private async Task<object> DispatchControlRequestAsync(JsonElement request)
    {
        var operation = Dispatcher.InvokeAsync(() => HandleControlCommandAsync(request));
        return await operation.Task.Unwrap();
    }

    private async Task<object> HandleControlCommandAsync(JsonElement request)
    {
        var command = GetJsonString(request, "command")?.ToLowerInvariant();
        switch (command)
        {
            case "status":
                return new { ok = true, application = "Speed-o'-Freq Sonic", directDownloadActive = _downloadCancellation is not null, queue = _queue.Snapshot() };
            case "list":
                return new { ok = true, queue = _queue.Snapshot() };
            case "add":
            case "download":
            {
                var url = GetJsonString(request, "url");
                if (string.IsNullOrWhiteSpace(url)) throw new ArgumentException("The --url option is required.");
                var requestedAddresses = GetJsonStringArray(request, "sourceAddresses")
                    .Select(value => IPAddress.TryParse(value, out var address) ? address : null)
                    .Where(address => address is not null).Cast<IPAddress>().ToArray();
                var browserContext = GetBrowserContext(request);
                var item = _queue.Add(url, GetJsonString(request, "destination"),
                    requestedAddresses.Length > 0 ? requestedAddresses : null, browserContext);
                if (command == "download") _queue.StartQueued();
                return new { ok = true, queued = item.Id, destination = item.Destination, status = item.Status, started = command == "download" };
            }
            case "start":
                _queue.StartQueued();
                return new { ok = true, message = "Queued downloads scheduled; concurrency limit is three.", queue = _queue.Snapshot() };
            case "pause":
            {
                var id = GetJsonString(request, "id");
                if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException("The --id option is required.");
                if (!_queue.Pause(id)) throw new InvalidOperationException($"Queue item '{id}' was not found or cannot be paused.");
                return new { ok = true, paused = id, queue = _queue.Snapshot() };
            }
            case "resume":
            {
                var id = GetJsonString(request, "id");
                if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException("The --id option is required.");
                if (!_queue.Resume(id)) throw new InvalidOperationException($"Queue item '{id}' was not found or cannot be resumed.");
                return new { ok = true, resumed = id, queue = _queue.Snapshot() };
            }
            case "set-policy":
            {
                var allowed = GetJsonBoolean(request, "allowed", true);
                var downloadsAtOnce = GetJsonInt32(request, "downloadsAtOnce", 3);
                var speedLimit = GetJsonInt64(request, "speedLimitBytesPerSecond", 0);
                _queue.SetPolicy(allowed, downloadsAtOnce, speedLimit > 0 ? speedLimit : null);
                _queue.SetSourceAddressSpeedLimits(GetJsonNetworkSpeedLimits(request));
                return new { ok = true, allowed, downloadsAtOnce = Math.Clamp(downloadsAtOnce, 1, 4), speedLimitBytesPerSecond = speedLimit > 0 ? speedLimit : (long?)null };
            }
            case "set-networks":
            {
                var id = GetJsonString(request, "id");
                if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException("The id field is required.");
                var addresses = GetJsonStringArray(request, "sourceAddresses")
                    .Select(value => IPAddress.TryParse(value, out var address) ? address : null)
                    .Where(address => address is not null).Cast<IPAddress>().ToArray();
                var policyLimited = GetJsonBoolean(request, "policyLimited", false);
                if (!_queue.SetSourceAddresses(id, addresses, policyLimited)) throw new InvalidOperationException($"Queue item '{id}' was not found or is already finished.");
                return new { ok = true, id, sourceAddresses = addresses.Select(address => address.ToString()).ToArray(), queue = _queue.Snapshot() };
            }
            case "relink":
            {
                var id = GetJsonString(request, "id");
                var url = GetJsonString(request, "url");
                if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(url)) throw new ArgumentException("The id and url fields are required.");
                if (!_queue.Relink(id, url, GetBrowserContext(request))) throw new InvalidOperationException($"Queue item '{id}' cannot be relinked.");
                return new { ok = true, relinked = id, queue = _queue.Snapshot() };
            }
            case "network-usage":
            {
                var startDate = GetJsonString(request, "startDate") ?? DateOnly.FromDateTime(DateTime.Now).ToString("yyyy-MM-dd");
                var addresses = GetJsonStringArray(request, "sourceAddresses");
                return new { ok = true, usage = _queue.NetworkUsage(startDate, addresses) };
            }
            case "reset-network-usage":
            {
                var addresses = GetJsonStringArray(request, "sourceAddresses");
                _queue.ResetNetworkUsage(addresses);
                return new { ok = true, resetAddresses = addresses };
            }
            case "cancel":
            {
                var id = GetJsonString(request, "id");
                if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException("The --id option is required.");
                if (!_queue.Cancel(id)) throw new InvalidOperationException($"Queue item '{id}' was not found or is already finished.");
                return new { ok = true, canceled = id };
            }
            case "remove":
            {
                var id = GetJsonString(request, "id");
                if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException("The --id option is required.");
                if (!_queue.RemoveFinished(id)) throw new InvalidOperationException($"Queue item '{id}' was not found or is still active.");
                return new { ok = true, removed = id };
            }
            case "clear":
            {
                var removed = _queue.ClearFinished();
                return new { ok = true, removedCount = removed, message = "Finished queue items removed; active downloads were left untouched." };
            }
            case "analyze":
            {
                var raw = GetJsonString(request, "url");
                if (!TryParseDirectUrl(raw ?? "", out var source, out var error)) throw new ArgumentException(error);
                using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(12) };
                using var response = await SendMetadataProbeAsync(client, source, CancellationToken.None);
                if ((int)response.StatusCode >= 400) throw new HttpRequestException($"Server returned HTTP {(int)response.StatusCode} ({response.ReasonPhrase}).");
                var size = response.Content.Headers.ContentRange?.Length ?? response.Content.Headers.ContentLength ?? -1;
                return new
                {
                    ok = true,
                    url = source.AbsoluteUri,
                    filename = GetSuggestedFileName(response, source),
                    sizeBytes = size,
                    contentType = response.Content.Headers.ContentType?.MediaType ?? "unknown",
                    rangeSupported = response.StatusCode == HttpStatusCode.PartialContent,
                    statusCode = (int)response.StatusCode
                };
            }
            default:
                throw new ArgumentException("Unsupported command. Supported: status, analyze, add, download, list, start, cancel, remove, clear.");
        }
    }

    private static string[] GetJsonStringArray(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var values)
            && values.ValueKind == JsonValueKind.Array
                ? values.EnumerateArray().Where(value => value.ValueKind == JsonValueKind.String)
                    .Select(value => value.GetString()!).Where(value => !string.IsNullOrWhiteSpace(value)).ToArray()
                : Array.Empty<string>();

    private static string? GetJsonString(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value)
            && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static Dictionary<string, long> GetJsonNetworkSpeedLimits(JsonElement request)
    {
        var limits = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        if (request.ValueKind != JsonValueKind.Object || !request.TryGetProperty("networkSpeedLimits", out var values)
            || values.ValueKind != JsonValueKind.Array) return limits;
        foreach (var value in values.EnumerateArray().Take(128))
        {
            var addressText = GetJsonString(value, "sourceAddress");
            var speed = GetJsonInt64(value, "speedLimitBytesPerSecond", 0);
            if (addressText is not null && IPAddress.TryParse(addressText, out var address) && speed > 0)
                limits[address.ToString()] = speed;
        }
        return limits;
    }

    private static BrowserRequestContext? GetBrowserContext(JsonElement request)
    {
        if (request.ValueKind != JsonValueKind.Object || !request.TryGetProperty("browser", out var browser)
            || browser.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return null;
        if (browser.ValueKind != JsonValueKind.Object) throw new ArgumentException("Browser context must be an object.");

        var cookies = new List<BrowserCookie>();
        if (browser.TryGetProperty("cookies", out var cookieElement))
        {
            if (cookieElement.ValueKind != JsonValueKind.Array || cookieElement.GetArrayLength() > 500)
                throw new ArgumentException("Browser context contains an invalid cookie list.");
            foreach (var cookie in cookieElement.EnumerateArray())
            {
                if (cookie.ValueKind != JsonValueKind.Object) throw new ArgumentException("Invalid browser cookie entry.");
                var name = GetJsonString(cookie, "name") ?? throw new ArgumentException("Browser cookie name is missing.");
                var value = GetJsonString(cookie, "value") ?? throw new ArgumentException("Browser cookie value is missing.");
                var domain = GetJsonString(cookie, "domain") ?? throw new ArgumentException("Browser cookie domain is missing.");
                var path = GetJsonString(cookie, "path") ?? "/";
                if (name.Length > 8192 || value.Length > 8192 || domain.Length > 255 || path.Length > 8192
                    || !path.StartsWith('/') || name.Any(char.IsControl) || value.Any(c => char.IsControl(c) || c == ';')
                    || string.IsNullOrWhiteSpace(domain))
                    throw new ArgumentException("Browser cookie contains an unsafe value.");
                var hostOnly = GetJsonBoolean(cookie, "hostOnly", false);
                var secure = GetJsonBoolean(cookie, "secure", false);
                cookies.Add(new BrowserCookie(name, value, domain, hostOnly, path, secure));
            }
        }
        var referer = GetJsonString(browser, "referer");
        var userAgent = GetJsonString(browser, "userAgent");
        var nameValue = GetJsonString(browser, "name");
        if (referer is not null && (!Uri.TryCreate(referer, UriKind.Absolute, out var refUri)
            || refUri.Scheme is not ("http" or "https") || referer.Any(char.IsControl)))
            throw new ArgumentException("Browser referer is invalid.");
        if (userAgent is not null && (userAgent.Length > 8192 || userAgent.Any(char.IsControl)))
            throw new ArgumentException("Browser user-agent is invalid.");
        if (nameValue is not null && (nameValue.Length > 40 || nameValue.Any(char.IsControl)))
            throw new ArgumentException("Browser name is invalid.");
        return new BrowserRequestContext { Cookies = cookies, Referer = referer, UserAgent = userAgent, Name = nameValue };
    }

    private static bool GetJsonBoolean(JsonElement element, string property, bool fallback) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value)
            && value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : fallback;

    private static int GetJsonInt32(JsonElement element, string property, int fallback) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value)
            && value.TryGetInt32(out var result) ? result : fallback;

    private static long GetJsonInt64(JsonElement element, string property, long fallback) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value)
            && value.TryGetInt64(out var result) ? result : fallback;

    private void SetDownloadInputsEnabled(bool enabled)
    {
        UrlTextBox.IsEnabled = enabled;
        PasteButton.IsEnabled = enabled;
        DestinationTextBox.IsEnabled = enabled;
        BrowseButton.IsEnabled = enabled;
        SpeedUnitComboBox.IsEnabled = enabled;
        ParallelismComboBox.IsEnabled = enabled;
        ChunkSizeComboBox.IsEnabled = enabled;
        InterfaceListBox.IsEnabled = enabled;
        RefreshPathsButton.IsEnabled = enabled;
        AnalyzeButton.IsEnabled = enabled;
    }

    private void RenderFinalStatistics(
        string status, string destination, DateTimeOffset startedAt, DateTimeOffset finishedAt,
        double elapsedSeconds, long transferredBytes, long? finalSize, string? sha256,
        int retryCount, bool resumed, string details)
    {
        var averageBytesPerSecond = transferredBytes / Math.Max(0.001, elapsedSeconds);
        var finalSizeText = finalSize is long size
            ? $"{FormatBytes(size)} ({size:N0} bytes)"
            : "Not finalized";
        var lines = new List<string>
        {
            $"Status: {status}",
            $"File: {destination}",
            $"Final file size: {finalSizeText}",
            $"Started: {startedAt:yyyy-MM-dd HH:mm:ss zzz}",
            $"Finished: {finishedAt:yyyy-MM-dd HH:mm:ss zzz}",
            $"Elapsed (end-to-end): {FormatDuration(TimeSpan.FromSeconds(elapsedSeconds))}",
            $"Received this session: {FormatBytes(transferredBytes)} ({transferredBytes:N0} bytes)",
            $"Average speed (end-to-end): {FormatSpeed(averageBytesPerSecond)}",
            $"Peak sampled speed (1 s samples): {FormatSpeed(_peakBytesPerSecond)}",
            $"Retries: {retryCount} · Resumed from checkpoint: {(resumed ? "Yes" : "No")}"
        };
        if (!string.IsNullOrWhiteSpace(details))
            lines.Add($"Details: {details}");
        if (!string.IsNullOrWhiteSpace(sha256))
            lines.Add($"SHA-256: {sha256}");

        FinalStatsText.Text = string.Join(Environment.NewLine, lines);
        FinalStatsCard.Visibility = Visibility.Visible;
    }

    private void TelemetryTimer_Tick(object? sender, EventArgs e)
    {
        UpdateTelemetryDisplay();
        if (_activeEngine is not null)
            RetryCountText.Text = _activeEngine.RetryAttempts.ToString();
    }

    private void UpdateTelemetryDisplay(bool forceZero = false)
    {
        var now = Stopwatch.GetTimestamp();
        var elapsed = Math.Max(0.001, (now - _lastTelemetryTimestamp) / (double)Stopwatch.Frequency);
        var currentWireBytes = Interlocked.Read(ref _wireBytesReceived);
        var delta = Math.Max(0, currentWireBytes - _lastWireBytesReceived);
        var instant = forceZero ? 0 : delta / elapsed;
        _currentBytesPerSecond = instant;
        _peakBytesPerSecond = Math.Max(_peakBytesPerSecond, instant);
        var elapsedTotal = Math.Max(0.1, (now - _downloadStartTimestamp) / (double)Stopwatch.Frequency);
        _averageBytesPerSecond = currentWireBytes / elapsedTotal;
        _lastWireBytesReceived = currentWireBytes;
        _lastTelemetryTimestamp = now;
        _speedSamples.Enqueue(_currentBytesPerSecond);
        while (_speedSamples.Count > 60) _speedSamples.Dequeue();
        SpeedText.Text = FormatSpeed(_currentBytesPerSecond);
        SpeedSubText.Text = $"AVG {FormatSpeed(_averageBytesPerSecond)} · PEAK {FormatSpeed(_peakBytesPerSecond)} · 1 s samples";
        UpdateSpeedChart();
        UpdateInterfaceSpeeds();
    }

    private void UpdateInterfaceSpeeds()
    {
        var selectedAddresses = InterfaceListBox.Items.OfType<NetworkPathOption>()
            .Where(path => path.IsSelected).Select(path => path.Address).ToHashSet();
        var adapters = NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up
                && n.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel)
                && !IsLikelyVirtualAdapter(n))
            .Select(network =>
            {
                var addresses = network.GetIPProperties().UnicastAddresses.Select(a => a.Address).ToArray();
                var selected = addresses.Any(selectedAddresses.Contains);
                long received;
                try { received = network.GetIPv4Statistics().BytesReceived; }
                catch (NetworkInformationException) { return null; }
                var rate = 0d;
                if (_lastInterfaceBytes.TryGetValue(network.Id, out var previous))
                    rate = Math.Max(0, received - previous);
                _lastInterfaceBytes[network.Id] = received;
                return new { Network = network, Rate = rate, Selected = selected };
            })
            .Where(item => item is not null)
            .OrderByDescending(item => item!.Selected)
            .ThenBy(item => item!.Network.Name, StringComparer.OrdinalIgnoreCase)
            .Take(4)
            .ToArray();

        if (adapters.Length == 0)
        {
            InterfaceSpeedText.Text = "No active physical network adapters detected.";
            return;
        }

        InterfaceSpeedText.Text = string.Join(Environment.NewLine, adapters.Select(item =>
            $"{item!.Network.Name}  {(item.Selected ? "· selected download path" : "")}\n   {FormatSpeed(item.Rate)} RX · adapter receive traffic"));
    }

    private string FormatSpeed(double bytesPerSecond)
    {
        return _speedUnit == "Mbps"
            ? $"{bytesPerSecond * 8 / 1_000_000:0.00} Mbps"
            : $"{bytesPerSecond / 1_000_000:0.00} MB/s";
    }

    private void UpdateSpeedChart()
    {
        if (SpeedChartLine is null || SpeedChart is null) return;
        var width = Math.Max(1, SpeedChart.ActualWidth);
        var height = Math.Max(1, SpeedChart.ActualHeight);
        var values = _speedSamples.ToArray();
        var points = new PointCollection();
        if (values.Length == 0)
        {
            points.Add(new Point(0, height - 2));
            points.Add(new Point(width, height - 2));
        }
        else
        {
            var max = Math.Max(1, values.Max());
            for (var i = 0; i < values.Length; i++)
            {
                var x = values.Length == 1 ? width : i * width / (values.Length - 1);
                var y = height - 4 - (values[i] / max) * (height - 8);
                points.Add(new Point(x, y));
            }
        }
        SpeedChartLine.Points = points;
    }

    private void SpeedChart_SizeChanged(object sender, SizeChangedEventArgs e) => UpdateSpeedChart();

    private void BuildChunkTiles(int count)
    {
        ChunkPanel.Children.Clear();
        _chunkTiles.Clear();
        var visible = Math.Clamp(count, 0, 256);
        for (var i = 0; i < visible; i++)
        {
            var tile = new Border { Width = 13, Height = 10, CornerRadius = new CornerRadius(3), Margin = new Thickness(2), BorderThickness = new Thickness(1) };
            tile.SetResourceReference(Border.BackgroundProperty, "Outline");
            tile.SetResourceReference(Border.BorderBrushProperty, "TextSecondary");
            tile.ToolTip = $"Chunk {i + 1}";
            _chunkTiles.Add(tile);
            ChunkPanel.Children.Add(tile);
        }
    }

    private void UpdateChunkTiles(DownloadProgress update)
    {
        if (update.TotalChunks > 0 && (_chunkTiles.Count == 0 || _chunkTiles.Count != Math.Min(256, update.TotalChunks)))
            BuildChunkTiles(update.TotalChunks);
        for (var i = 0; i < _chunkTiles.Count; i++)
        {
            var completed = update.ChunkStates is { Length: > 0 } states
                ? i < states.Length && states[i]
                : i < update.CompletedChunks;
            _chunkTiles[i].SetResourceReference(Border.BackgroundProperty, completed ? "Accent" : "Outline");
            _chunkTiles[i].Opacity = completed ? 1 : 0.55;
            _chunkTiles[i].ToolTip = $"Chunk {i + 1}: {(completed ? "complete" : "pending")}";
        }
        ChunkSummaryText.Text = $"{update.CompletedChunks}/{update.TotalChunks} chunks complete · {FormatBytes(update.BytesWritten)} transferred";
    }

    private void Settings_Changed(object sender, SelectionChangedEventArgs e) => SaveSettings();

    private void SpeedUnitComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_isInitializing || SpeedUnitComboBox.SelectedItem is not ComboBoxItem item) return;
        _speedUnit = item.Tag?.ToString() == "Mbps" ? "Mbps" : "MB";
        SpeedText.Text = FormatSpeed(_currentBytesPerSecond);
        SpeedSubText.Text = $"AVG {FormatSpeed(_averageBytesPerSecond)} · PEAK {FormatSpeed(_peakBytesPerSecond)}";
        SaveSettings();
    }

    private void BrowseButton_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new SaveFileDialog
        {
            Title = "Choose download destination",
            FileName = Path.GetFileName(DestinationTextBox.Text),
            Filter = "All files (*.*)|*.*",
            AddExtension = false,
            OverwritePrompt = false
        };
        var directory = Path.GetDirectoryName(DestinationTextBox.Text);
        if (!string.IsNullOrWhiteSpace(directory) && Directory.Exists(directory)) dialog.InitialDirectory = directory;
        else dialog.InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) is string home
            ? Path.Combine(home, "Downloads") : "";
        if (dialog.ShowDialog(this) == true)
        {
            DestinationTextBox.Text = dialog.FileName;
            SaveSettings();
        }
    }

    private void PauseButton_Click(object sender, RoutedEventArgs e)
    {
        if (_downloadCancellation is null) return;
        _pauseRequested = true;
        PauseButton.IsEnabled = false;
        SetStatus("Pausing at the next safe cancellation point…", false);
        _downloadCancellation.Cancel();
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        _pauseRequested = false;
        _downloadCancellation?.Cancel();
        SetStatus("Cancellation requested…", false);
    }

    private void OpenFolderButton_Click(object sender, RoutedEventArgs e)
    {
        var target = _lastDestination ?? DestinationTextBox.Text.Trim();
        var directory = Path.GetDirectoryName(target);
        if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory))
        {
            SetStatus("The destination folder no longer exists.", true);
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo { FileName = directory, UseShellExecute = true });
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            SetStatus("Could not open the destination folder: " + ex.Message, true);
        }
    }

    private void SetStatus(string message, bool isError)
    {
        StatusText.Text = message;
        StatusText.Foreground = (Brush)Resources[isError ? "ErrorBrush" : "TextPrimary"];
        StatusDot.Fill = (Brush)Resources[isError ? "ErrorBrush" : "Accent"];
    }

    private void Window_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        _urlAnalysisDebounce?.Cancel();
        _telemetryTimer.Stop();
        foreach (var item in _queue.Items.Where(item => item.Status is "Queued" or "Running").ToArray()) _queue.Cancel(item.Id);
        _ = _controlServer.DisposeAsync();
        _queue?.FlushPersistence();
        SaveSettings();
    }

    private sealed class InlineProgress<T>(Action<T> report) : IProgress<T>
    {
        public void Report(T value) => report(value);
    }

    private sealed class NetworkPathOption(string displayName, IPAddress address)
    {
        public string DisplayName { get; } = displayName;
        public IPAddress Address { get; } = address;
        public bool IsSelected { get; set; }
    }

    private sealed class AppSettings
    {
        public string DestinationPath { get; set; } = "";
        public int Parallelism { get; set; } = 8;
        public int ChunkSizeBytes { get; set; } = 4 * 1024 * 1024;
        public string SpeedUnit { get; set; } = "MB";
    }

    private static string FormatDuration(TimeSpan value)
    {
        value = value < TimeSpan.Zero ? TimeSpan.Zero : value;
        if (value.TotalHours >= 1) return $"{(int)value.TotalHours}h {value.Minutes}m {value.Seconds}s";
        if (value.TotalMinutes >= 1) return $"{value.Minutes}m {value.Seconds}s";
        if (value.TotalSeconds < 10) return $"{value.TotalSeconds:0.0}s";
        return $"{value.Seconds}s";
    }

    private static string FormatBytes(long value)
    {
        if (value < 0) return "unknown size";
        string[] units = ["B", "KiB", "MiB", "GiB", "TiB"];
        double size = value;
        var unit = 0;
        while (size >= 1024 && unit < units.Length - 1) { size /= 1024; unit++; }
        return $"{size:0.##} {units[unit]}";
    }
}
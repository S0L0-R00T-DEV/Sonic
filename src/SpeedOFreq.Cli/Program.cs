using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var noLaunch = args.Contains("--no-launch", StringComparer.OrdinalIgnoreCase);
var compactOutput = args.Contains("--compact", StringComparer.OrdinalIgnoreCase);
var commandArgs = args.Where(arg => !string.Equals(arg, "--no-launch", StringComparison.OrdinalIgnoreCase)
    && !string.Equals(arg, "--compact", StringComparison.OrdinalIgnoreCase)).ToArray();

if (commandArgs.Length == 0 || commandArgs[0] is "-h" or "--help" or "help")
{
    PrintHelp();
    return 0;
}

if (commandArgs[0] is "-v" or "--version" or "version")
{
    Console.WriteLine(JsonSerializer.Serialize(new {
        application = "Sonic CLI",
        version = System.Reflection.Assembly.GetEntryAssembly()?.GetName().Version?.ToString() ?? "unknown",
        protocol = "SpeedOFreqSonic.AppControl.v2"
    }, new JsonSerializerOptions { WriteIndented = !compactOutput }));
    return 0;
}

var command = commandArgs[0].Trim().ToLowerInvariant();
var request = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase)
{
    ["command"] = NormalizeCommand(command)
};

try
{
    ParseArguments(commandArgs.Skip(1).ToArray(), request, command);
    // A JSON file avoids native-command-line quoting problems in Windows PowerShell 5.1.
    if ((command is "settings-set" or "add-batch") && request.TryGetValue("jsonFile", out var jsonFile) && jsonFile is string jsonPath)
    {
        var fileContents = await File.ReadAllTextAsync(jsonPath);
        if (command == "settings-set") request["json"] = fileContents;
        else request["items"] = fileContents;
        request.Remove("jsonFile");
    }
    var response = await SendAsync(JsonSerializer.Serialize(request), noLaunch);
    using var document = JsonDocument.Parse(response);
    var root = document.RootElement;

    if (!root.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True)
    {
        Console.Error.WriteLine(root.TryGetProperty("error", out var error)
            ? error.GetString() ?? "Sonic rejected the command."
            : "Sonic returned an invalid response.");
        return 1;
    }

    if (root.TryGetProperty("result", out var result))
        Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = !compactOutput }));
    else
        Console.WriteLine(JsonSerializer.Serialize(root, new JsonSerializerOptions { WriteIndented = !compactOutput }));
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex.Message);
    return 1;
}

static string NormalizeCommand(string command) => command switch
{
    "app-status" => "status",
    "settings-get" or "config" => "settings",
    "mode" => "theme",
    "download-list" => "downloads",
    "history-list" => "history",
    "clear-history" or "history-clear-all" => "history-clear",
    "delete-history" => "history-delete",
    "download-add" => "add",
    "queue-start" => "start",
    "download-remove" => "remove",
    "reset-network-usage" => "network-reset",
    "links-list" => "links",
    "ping" => "health",
    "command-list" or "list-commands" => "capabilities",
    "download-stats" => "download-stats",
    _ => command
};

static string CamelCase(string key)
{
    var parts = key.TrimStart('-').Split('-', StringSplitOptions.RemoveEmptyEntries);
    if (parts.Length == 0) return key;
    return parts[0] + string.Concat(parts.Skip(1).Select(part =>
        part.Length == 0 ? part : char.ToUpperInvariant(part[0]) + part[1..]));
}

static void ParseArguments(string[] values, Dictionary<string, object?> request, string command)
{
    var positional = new List<string>();
    for (var i = 0; i < values.Length; i++)
    {
        var arg = values[i];
        if (!arg.StartsWith("--", StringComparison.Ordinal))
        {
            positional.Add(arg);
            continue;
        }

        var key = CamelCase(arg);
        if (i + 1 < values.Length && !values[i + 1].StartsWith("--", StringComparison.Ordinal))
            request[key] = values[++i];
        else
            request[key] = "true";
    }

    if (command == "settings-set")
    {
        if (request.TryGetValue("json", out var json) && json is string jsonText)
            request["json"] = jsonText;
        return;
    }

    if (positional.Count > 0 && !request.ContainsKey("value"))
        request["value"] = string.Join(" ", positional);

    // Common short forms: "history delete <id>" and "history clear".
    if (command == "history" && positional.Count > 0)
    {
        var subcommand = positional[0].ToLowerInvariant();
        if (subcommand is "clear" or "delete")
            request["command"] = subcommand == "clear" ? "history-clear" : "history-delete";
        if (subcommand == "delete" && positional.Count > 1 && !request.ContainsKey("id"))
            request["id"] = positional[1];
    }

    if (command == "destination" && positional.Count > 0 && !request.ContainsKey("path"))
        request["path"] = string.Join(" ", positional);

    if (command == "free-space" && positional.Count > 0 && !request.ContainsKey("path"))
        request["path"] = string.Join(" ", positional);

    if (command == "window" && positional.Count > 0 && !request.ContainsKey("action"))
        request["action"] = positional[0];
}

static async Task<string> SendAsync(string json, bool noLaunch)
{
    var client = new NamedPipeClientStream(
        ".",
        GetPipeName(),
        PipeDirection.InOut,
        PipeOptions.Asynchronous);
    try
    {
        try
        {
            await client.ConnectAsync(1800);
        }
        catch (Exception ex) when (ex is TimeoutException or IOException)
        {
            await client.DisposeAsync();
            if (noLaunch)
                throw new InvalidOperationException("Sonic is not running (--no-launch was specified). Start Sonic and retry.", ex);

            var executable = FindSonicExecutable();
            if (executable is null)
                throw new InvalidOperationException("Sonic is not running and its application executable could not be located. Set SONIC_APP_EXE to Sonic.exe or start Sonic manually.", ex);

            try
            {
                Process.Start(new ProcessStartInfo(executable)
                {
                    UseShellExecute = true,
                    WorkingDirectory = Path.GetDirectoryName(executable) ?? AppContext.BaseDirectory
                });
            }
            catch (Exception launchError)
            {
                throw new InvalidOperationException($"Could not launch Sonic at '{executable}': {launchError.Message}", launchError);
            }

            var deadline = DateTime.UtcNow.AddSeconds(25);
            Exception? lastError = ex;
            while (DateTime.UtcNow < deadline)
            {
                await Task.Delay(500);
                client = new NamedPipeClientStream(".", GetPipeName(), PipeDirection.InOut, PipeOptions.Asynchronous);
                try
                {
                    await client.ConnectAsync(1000);
                    lastError = null;
                    break;
                }
                catch (Exception retryError) when (retryError is TimeoutException or IOException)
                {
                    lastError = retryError;
                    await client.DisposeAsync();
                }
            }
            if (lastError is not null)
                throw new InvalidOperationException("Sonic was launched, but its CLI endpoint did not become ready within 25 seconds.", lastError);
        }

        using var reader = new StreamReader(client, Encoding.UTF8, false, 4096, leaveOpen: true);
        using var writer = new StreamWriter(client, new UTF8Encoding(false), 4096, leaveOpen: true)
        {
            AutoFlush = true
        };
        await writer.WriteLineAsync(json);
        var response = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(245));
        return response ?? throw new IOException("Sonic closed the CLI connection without returning a response.");
    }
    finally
    {
        await client.DisposeAsync();
    }
}

static string GetPipeName()
{
    var configured = Environment.GetEnvironmentVariable("SONIC_CLI_PIPE");
    if (!string.IsNullOrWhiteSpace(configured)) return configured;
    var userData = Environment.GetEnvironmentVariable("SONIC_USER_DATA");
    if (string.IsNullOrWhiteSpace(userData)) return "SpeedOFreqSonic.AppControl.v2";
    var resolved = Path.GetFullPath(userData);
    var identity = OperatingSystem.IsWindows() ? resolved.ToLowerInvariant() : resolved;
    var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity))).ToLowerInvariant()[..12];
    return "SpeedOFreqSonic.AppControl.v2.test-" + hash;
}

static string? FindSonicExecutable()
{
    var candidates = new List<string>();
    var configured = Environment.GetEnvironmentVariable("SONIC_APP_EXE");
    if (!string.IsNullOrWhiteSpace(configured)) candidates.Add(configured);
    candidates.Add(Path.Combine(AppContext.BaseDirectory, "Sonic.exe"));
    candidates.Add(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "Sonic.exe")));
    var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
    candidates.Add(Path.Combine(local, "Programs", "Sonic", "Sonic.exe"));
    candidates.Add(Path.Combine(local, "Programs", "Speed-o'-Freq Sonic", "Sonic.exe"));
    if (!string.IsNullOrWhiteSpace(programFiles))
    {
        candidates.Add(Path.Combine(programFiles, "Sonic", "Sonic.exe"));
        candidates.Add(Path.Combine(programFiles, "Speed-o'-Freq Sonic", "Sonic.exe"));
    }
    return candidates.FirstOrDefault(File.Exists);
}

static void PrintHelp()
{
    Console.WriteLine("""
Sonic CLI — control Sonic through its local, current-user control pipe.
Live commands auto-launch Sonic when its executable can be located. Use --no-launch to disable this.
Commands return JSON; use --compact for single-line JSON. Sizes/speeds are bytes unless otherwise indicated.
  -h | --help | help                          Show this help
  -v | --version | version                    Show CLI version and protocol information
  --no-launch                                 Fail instead of opening Sonic automatically
  --compact                                   Emit compact JSON for pipelines and AI clients
  capabilities                                Return the machine-readable command catalog
  health                                      Quick app/CLI health response
  download-stats                              Aggregate queue/history counts and byte totals
  downloads --status <state> --query <text>   Filter download rows (also supports --kind, --limit, --offset)
  history --query <text> --limit <n>          Filter finished history (also supports --offset)

DOWNLOADS
  status | app-status                        App settings, live download states and recovery warnings
  recovery | recovery-issues                  Show saved downloads that need recovery; no files are deleted
  downloads | list                            All queued, downloading, paused and errored downloads
  history                                     Finished download history
  add --url <URL|magnet:...|path.torrent>     Add HTTP(S), magnet, or local .torrent download
      [--destination-dir <folder>] [--destination <full-path>] [--name <name>]
      [--interfaces <id,id>] [--files <0,2>]
  analyze --url <link>                        Inspect a link/torrent without starting it
  add-batch --json-file <path>                 Add up to 100 downloads from a JSON array
      Each item: {"url":"https://...","destinationDir":"T:\\Downloads","name":"file.zip"}
  pause --id <id>                             Pause one download
  resume --id <id>                            Resume one download
  cancel --id <id>                            Cancel one download, retaining history where applicable
  pause-all | resume-all | cancel-all         Apply an action to all applicable downloads
  remove --id <id> [--trash-file on]           Remove a download/history row; file is kept by default
  open --id <id> | reveal --id <id>           Open a file or show it in Explorer
  torrent-files --id <id>                      List the torrent's file entries and indexes
  choose-torrent-files --id <id> --files 0,2   Change the selected files in a torrent
  start                                       Start queued legacy HTTP downloads
  history-delete --id <id>                     Delete one finished history entry; keep downloaded file
  history-clear                                Clear all finished history entries; keep downloaded files

SETTINGS
  settings                                    Read current settings
  settings-set --key <setting> --value <value>
  settings-set --json <JSON-object>             Update settings as a JSON patch
  settings-set --json-file <path>               Read a JSON patch from a file (PowerShell-safe)
  theme [sonic|light|dark]                    Read/change the three application themes
  slow-mode [on|off|toggle|status]              Read/change slow mode
  slow-mode-speed --value <n> [--unit MiB/s]    Configure slow-mode cap
  speed-limit --value <n|off> [--unit Mbps]     Configure overall cap; off removes the cap
  speed-unit [bytes|bits]                      Display speed as MB/s or Mbps
  downloads-at-once [1-4]                     Concurrent downloads limit
  destination [--path <folder>]                Read/change default download folder

NETWORKS & APP CONTROLS
  interfaces | networks                       List network interfaces
  network-usage                                Report native per-network usage
  network-reset --id <interface-id>             Reset the network usage counter
  network-pref --id <interface-id> [options]   Read/update an interface preference
      [--off on|off] [--name <label>] [--color <swatch>]
      [--network-speed-limit <n> --unit MiB/s] [--data-limit-bytes <n>]
      [--period day|week|month]
  download-network --id <id> --network-id <interface-id> --enabled on|off
  links                                       List links waiting for review
  link-dismiss --id <link-id>                   Dismiss a pending link
  window --action minimize|maximize|show|restore|close  Control the app window
  free-space --path <folder>                   Report free bytes on the selected volume
  clipboard                                   Read clipboard text

ALIASES
  commands | command-list | list-commands      Same as capabilities
  ping                                          Same as health
  settings-get | config                         Same as settings
  mode                                          Same as theme
  list | download-list                          Same as downloads
  history-list                                  Same as history
  clear-history | history-clear-all             Same as history-clear
  delete-history                                Same as history-delete
  download | download-add                       Same as add
  probe                                         Same as analyze
  queue-start                                   Same as start
  download-remove                               Same as remove
  reset-network-usage                           Same as network-reset
  links-list                                    Same as links
  destination-dir                               Same as destination

Speed units accepted: B/s, KB/s, KiB/s, MB/s, MiB/s, GB/s, GiB/s, Kbps, Mbps, Gbps.
Speed limits are stored internally as bytes per second. "speed-unit" changes display only.
Examples:
  SpeedOFreq.Cli.exe status
  SpeedOFreq.Cli.exe theme sonic
  SpeedOFreq.Cli.exe slow-mode off
  SpeedOFreq.Cli.exe speed-limit --value 20 --unit Mbps
  SpeedOFreq.Cli.exe add --url "magnet:?xt=urn:btih:..."
  SpeedOFreq.Cli.exe pause --id "<download-id>"
""");
}

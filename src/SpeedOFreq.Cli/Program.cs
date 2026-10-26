using System.IO.Pipes;
using System.Text;
using System.Text.Json;

if (args.Length == 0 || args[0] is "-h" or "--help" or "help")
{
    PrintHelp();
    return 0;
}

var command = args[0].Trim().ToLowerInvariant();
var request = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase)
{
    ["command"] = NormalizeCommand(command)
};

try
{
    ParseArguments(args.Skip(1).ToArray(), request, command);
    // A JSON file avoids native-command-line quoting problems in Windows PowerShell 5.1.
    if (command == "settings-set" && request.TryGetValue("jsonFile", out var jsonFile) && jsonFile is string jsonPath)
    {
        request["json"] = await File.ReadAllTextAsync(jsonPath);
        request.Remove("jsonFile");
    }
    var response = await SendAsync(JsonSerializer.Serialize(request));
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
        Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
    else
        Console.WriteLine(JsonSerializer.Serialize(root, new JsonSerializerOptions { WriteIndented = true }));
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

static async Task<string> SendAsync(string json)
{
    using var client = new NamedPipeClientStream(
        ".",
        "SpeedOFreqSonic.AppControl.v2",
        PipeDirection.InOut,
        PipeOptions.Asynchronous);

    try
    {
        await client.ConnectAsync(1800);
    }
    catch (TimeoutException)
    {
        throw new InvalidOperationException(
            "Could not connect to Sonic. Launch the app first, then rerun the CLI command.");
    }
    catch (IOException ex)
    {
        throw new InvalidOperationException(
            "Sonic CLI endpoint is unavailable. Launch the app first and make sure its window has finished loading.",
            ex);
    }

    using var reader = new StreamReader(client, Encoding.UTF8, false, 4096, leaveOpen: true);
    using var writer = new StreamWriter(client, new UTF8Encoding(false), 4096, leaveOpen: true)
    {
        AutoFlush = true
    };
    await writer.WriteLineAsync(json);
    var response = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(125));
    return response ?? throw new IOException("Sonic closed the CLI connection without returning a response.");
}

static void PrintHelp()
{
    Console.WriteLine("""
Sonic CLI — control the running desktop app.
The GUI must be running. Commands return JSON; sizes/speeds are bytes unless otherwise indicated.

DOWNLOADS
  status                                      App settings, live download states and recovery warnings
  recovery-issues                              Show saved downloads that need recovery; no files are deleted
  downloads | list                            All queued, downloading, paused and errored downloads
  history                                     Finished download history
  add --url <URL|magnet:...|path.torrent>     Add HTTP(S), magnet, or local .torrent download
      [--destination-dir <folder>] [--destination <full-path>] [--name <name>]
      [--interfaces <id,id>] [--files <0,2>]
  analyze --url <link>                        Inspect a link/torrent without starting it
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
  link-resume --link-id <link-id> --download-id <id>
  window --action minimize|maximize|show|close  Control the app window
  free-space --path <folder>                   Report free bytes on the selected volume
  clipboard                                   Read clipboard text

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

using System;
using System.IO;

namespace SpeedOFreq.App;

/// <summary>
/// The legacy queue backend normally stores state under LocalAppData. E2E-launched instances
/// must not mutate the real user's queue, settings, or network-usage ledger, so a backend whose
/// named pipe has an instance-specific test suffix uses a storage folder inside that test's
/// isolated Electron user-data directory.
/// </summary>
internal static class AppStoragePaths
{
    public static string Root
    {
        get
        {
            var userData = Environment.GetEnvironmentVariable("SONIC_USER_DATA");
            var pipeName = Environment.GetEnvironmentVariable("SONIC_BACKEND_PIPE");
            if (!string.IsNullOrWhiteSpace(userData) &&
                pipeName?.Contains(".test-", StringComparison.Ordinal) == true)
            {
                return Path.Combine(userData, "legacy-backend");
            }

            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "SpeedOFreq");
        }
    }
}

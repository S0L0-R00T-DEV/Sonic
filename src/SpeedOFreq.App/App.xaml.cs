using System.Threading;
using System.Windows;

namespace SpeedOFreq.App;

public partial class App : Application
{
    private Mutex? _singleInstanceMutex;
    public static bool BackendMode { get; private set; }

    protected override void OnStartup(StartupEventArgs e)
    {
        var backendMode = e.Args.Any(argument => string.Equals(argument, "--backend", StringComparison.OrdinalIgnoreCase));
        BackendMode = backendMode;
        // E2E backend instances use their own named pipe and must have a matching, isolated mutex.
        var configuredPipe = Environment.GetEnvironmentVariable("SONIC_BACKEND_PIPE");
        var suffixAt = configuredPipe?.LastIndexOf(".test-", StringComparison.Ordinal) ?? -1;
        var testSuffix = suffixAt >= 0 ? configuredPipe![suffixAt..] : string.Empty;
        var mutexName = backendMode
            ? @"Local\SpeedOFreqSonic.Backend" + testSuffix
            : @"Local\SpeedOFreqSonic.SingleInstance";
        _singleInstanceMutex = new Mutex(initiallyOwned: true, mutexName, out var createdNew);
        if (!createdNew)
        {
            _singleInstanceMutex.Dispose();
            _singleInstanceMutex = null;
            Shutdown();
            return;
        }
        base.OnStartup(e);
        // The Electron UI is the visible frontend; the WPF window exists only to host the local
        // control pipe and download queue. Never show it in backend mode, or it becomes a blank
        // top-level window behind Electron. Keep the hidden backend alive until its parent stops it.
        if (backendMode) ShutdownMode = ShutdownMode.OnExplicitShutdown;
        var mainWindow = new MainWindow();
        MainWindow = mainWindow;
        if (!backendMode) mainWindow.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        if (_singleInstanceMutex is not null)
        {
            try { _singleInstanceMutex.ReleaseMutex(); } catch (ApplicationException) { }
            _singleInstanceMutex.Dispose();
            _singleInstanceMutex = null;
        }
        base.OnExit(e);
    }
}

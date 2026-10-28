import type { AppSettings, DownloadState, FinishedDownload, RecoveryIssue } from '@shared/types'
import { useEffect, useLayoutEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { DownloadActionsProvider } from './components/DownloadActionsProvider'
import { LimitsDialog } from './components/LimitsDialog'
import { AboutDialog } from './components/AboutDialog'
import { TERMS_ACCEPTED_KEY, TermsOfServiceDialog } from './components/TermsOfServiceDialog'
import { NetworkBindingDialog } from './components/NetworkBindingDialog'
import { NewDownloadDialog } from './components/NewDownloadDialog'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { TooltipProvider } from './components/ui/tooltip'
import { useDownloadEvents } from './hooks/useDownloadEvents'
import { useNetworkEvents } from './hooks/useNetworks'
import { useNewDownloadShortcuts, useOpenedLinks } from './hooks/useOpenedLinks'
import { CompleteScreen } from './screens/CompleteScreen'
import { DownloadingScreen } from './screens/DownloadingScreen'
import { DownloadsScreen } from './screens/DownloadsScreen'
import { ErrorScreen } from './screens/ErrorScreen'
import { useAppStore } from './store/useAppStore'
import { LocaleProvider } from './i18n'

function assertNever(status: never): never {
  throw new Error(`Unhandled download status: ${String(status)}`)
}

/** One screen per download.status — a switch with an assertNever default so a new
 * DownloadStatus value is a compile error here instead of silently falling into whichever branch
 * happened to be last. */
function renderDownload(download: DownloadState | FinishedDownload): React.JSX.Element {
  if ('unitsWritten' in download) return <CompleteScreen download={download} />
  switch (download.status) {
    case 'queued':
    case 'downloading':
    case 'paused':
      return <DownloadingScreen download={download} />
    case 'completed':
      return <CompleteScreen download={download} />
    case 'error':
    case 'cancelled':
      return <ErrorScreen download={download} />
    default:
      return assertNever(download.status)
  }
}

/** The download shown, or the list. Only this re-renders on a progress update — App, the title
 * bar, the status bar and the dialogs around it don't. */
function CurrentScreen(): React.JSX.Element {
  // Just the one shown: an update to any other download leaves this selector's result alone.
  const shown = useAppStore((store) => {
    const { view } = store
    if (view.name !== 'download') return null
    // A download that's gone (removed, deleted) leaves the list showing.
    return store.downloads[view.id] ?? store.history.find((entry) => entry.id === view.id) ?? null
  })
  const cancelled = shown && !('unitsWritten' in shown) && shown.status === 'cancelled'
  return shown && !cancelled ? renderDownload(shown) : <DownloadsScreen />
}

function RecoveryIssuesBanner({ issues }: { issues: RecoveryIssue[] }): React.JSX.Element | null {
  if (issues.length === 0) return null
  return (
    <section
      role="alert"
      aria-live="assertive"
      className="mx-4 mt-3 flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground"
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {issues.length === 1
            ? 'A saved download needs attention'
            : issues.length + ' saved downloads need attention'}
        </p>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
          {issues.map((issue) => (
            <li key={issue.id}>
              <span className="font-medium text-foreground">Download {issue.id.slice(0, 8)}:</span>{' '}
              {issue.message}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Sonic preserved the saved data. Review the affected download folders before deleting or
          moving any files.
        </p>
      </div>
    </section>
  )
}
function App(): React.JSX.Element {
  const themeSource = useAppStore((store) => store.themeSource)
  const [termsOpen, setTermsOpen] = useState(() => {
    try {
      return window.localStorage.getItem(TERMS_ACCEPTED_KEY) !== '1'
    } catch {
      return true
    }
  })
  const BROWSER_SETUP_PROMPTED_KEY = 'sonic-browser-setup-prompted-v3'

  const [settingsOpen, setSettingsOpen] = useState(() => {
    try {
      return (
        window.localStorage.getItem(TERMS_ACCEPTED_KEY) === '1' &&
        window.localStorage.getItem(BROWSER_SETUP_PROMPTED_KEY) !== '1'
      )
    } catch {
      return false
    }
  })
  const [recoveryIssues, setRecoveryIssues] = useState<RecoveryIssue[]>([])
  const [settingsPage, setSettingsPage] = useState<string | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [updateNotificationVersion, setUpdateNotificationVersion] = useState<string | null>(null)
  useEffect(() => window.sonic.onUpdateDetected(setUpdateNotificationVersion), [])
  useEffect(() => {
    return window.sonic.onUpdateAvailable((version) => {
      setUpdateNotificationVersion(version)
      setAboutOpen(true)
    })
  }, [])
  useEffect(() => {
    if (!settingsOpen) return
    try {
      // First launch opens the browser setup instructions. Mark them seen so closing the dialog is respected.
      window.localStorage.setItem(BROWSER_SETUP_PROMPTED_KEY, '1')
    } catch {
      // A restricted storage environment must not prevent the app from launching.
    }
  }, [settingsOpen])
  useEffect(() => {
    let disposed = false
    void window.sonic
      .listRecoveryIssues()
      .then((issues) => {
        if (!disposed) setRecoveryIssues(issues)
      })
      .catch((error: unknown) => {
        console.error('[Sonic] failed to load recovery issues', error)
      })
    return () => {
      disposed = true
    }
  }, [])
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', themeSource)
    document.documentElement.style.colorScheme = themeSource
  }, [themeSource])
  useEffect(() => {
    const unsubscribe = window.sonic.onSettingsChanged((patch: AppSettings) => {
      useAppStore.setState((state) => ({
        themeSource: patch.themeSource ?? 'sonic',
        downloadSchedule: patch.downloadSchedule,
        completionAction: patch.completionAction ?? state.completionAction,
        networkPreferences: patch.networkPreferences ?? {},
        downloadsAtOnce: patch.downloadsAtOnce ?? 2,
        slowMode: patch.slowMode ?? false,
        slowModeSpeed: patch.slowModeSpeed ?? 2 * 1024 * 1024,
        speedUnit: patch.speedUnit ?? 'bytes',
        destinationDir: patch.destinationDir ?? state.downloadsDir,
        customTags: patch.customTags ?? state.customTags,
        downloadTags: patch.downloadTags ?? state.downloadTags,
        destinationRules: patch.destinationRules ?? state.destinationRules
      }))
    })
    return unsubscribe
  }, [])

  useDownloadEvents()
  useOpenedLinks()
  useNewDownloadShortcuts()
  useNetworkEvents()

  return (
    <LocaleProvider>
      <TooltipProvider>
        <DownloadActionsProvider>
          <div className="flex h-full flex-col">
            <TitleBar
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenAbout={() => setAboutOpen(true)}
              updateAvailable={Boolean(updateNotificationVersion)}
            />
            <RecoveryIssuesBanner issues={recoveryIssues} />
            <div className="min-h-0 flex-1">
              <CurrentScreen />
            </div>
            <StatusBar />
            <NewDownloadDialog />
            <NetworkBindingDialog />
            <LimitsDialog
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              page={settingsPage}
              onPageChange={setSettingsPage}
            />
            <AboutDialog
              open={aboutOpen}
              onOpenChange={setAboutOpen}
              updateNotificationVersion={updateNotificationVersion}
            />
            <TermsOfServiceDialog
              open={termsOpen}
              onOpenChange={setTermsOpen}
              mandatory
              onAccept={() => {
                try {
                  if (window.localStorage.getItem(BROWSER_SETUP_PROMPTED_KEY) !== '1') {
                    setSettingsOpen(true)
                  }
                } catch {
                  // Terms acceptance remains usable if local storage is unavailable.
                }
              }}
            />
          </div>
        </DownloadActionsProvider>
      </TooltipProvider>
    </LocaleProvider>
  )
}

export default App

import type { AppSettings, DownloadState, FinishedDownload, RecoveryIssue } from '@shared/types'
import { useEffect, useLayoutEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { DownloadActionsProvider } from './components/DownloadActionsProvider'
import { LimitsDialog } from './components/LimitsDialog'
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

/** One screen per download.status Ã¢â‚¬â€ a switch with an assertNever default so a new
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

/** The download shown, or the list. Only this re-renders on a progress update Ã¢â‚¬â€ App, the title
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recoveryIssues, setRecoveryIssues] = useState<RecoveryIssue[]>([])
  const [settingsPage, setSettingsPage] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    void window.sonic
      .listRecoveryIssues()
      .then((issues) => {
        if (!disposed) setRecoveryIssues(issues)
      })
      .catch((error: unknown) => {
        console.error('[Speed-o-Freq Sonic] failed to load recovery issues', error)
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
        speedLimit: patch.speedLimit,
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

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    const hasTorrent = Array.from(event.dataTransfer.items).some(
      (item) => item.kind === 'file' || item.type === 'text/uri-list' || item.type === 'text/plain'
    )
    if (hasTorrent) event.preventDefault()
  }
  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    const files = Array.from(event.dataTransfer.files)
    const torrentFile = files.find((file) => file.name.toLowerCase().endsWith('.torrent'))
    if (torrentFile) {
      event.preventDefault()
      const path = window.sonic.pathForFile(torrentFile)
      if (path) useAppStore.getState().openNewDownload(path)
      return
    }
    const droppedCandidates = [
      event.dataTransfer.getData('text/uri-list'),
      event.dataTransfer.getData('text/plain')
    ]
      .flatMap((text) => text.split(/\r?\n/))
      .map((value) => value.trim())
      .filter((value) => value && !value.startsWith('#'))
    const droppedText = droppedCandidates.find((value) => {
      if (/^magnet:\?/i.test(value)) return true
      try {
        const url = new URL(value)
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      } catch {
        return false
      }
    })
    if (droppedText) {
      event.preventDefault()
      useAppStore.getState().openNewDownload(droppedText)
    }
  }

  useDownloadEvents()
  useOpenedLinks()
  useNewDownloadShortcuts()
  useNetworkEvents()

  return (
    <LocaleProvider>
      <TooltipProvider>
        <DownloadActionsProvider>
          <div className="flex h-full flex-col" onDragOver={handleDragOver} onDrop={handleDrop}>
            <TitleBar onOpenSettings={() => setSettingsOpen(true)} />
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
          </div>
        </DownloadActionsProvider>
      </TooltipProvider>
    </LocaleProvider>
  )
}

export default App

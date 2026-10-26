import type { DownloadState } from '@shared/types'
import { ClipboardCopy, FileDown, Folder } from 'lucide-react'
import { useLocale } from '../i18n'
import { useState } from 'react'
import { headerActions } from '../utils/downloadActions'
import { ACTION_META } from '../components/downloadActionMeta'
import { DetailHeader } from '../components/DetailHeader'
import { TruncatedText } from '../components/TruncatedText'
import {
  describeError,
  fileExtensionBadge,
  formatBytes,
  formatPercent,
  isFolder,
  wantedBytes
} from '../utils/format'

export function ErrorScreen({ download }: { download: DownloadState }): React.JSX.Element {
  const { t } = useLocale()
  const [copied, setCopied] = useState(false)
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false)
  const [reportSaved, setReportSaved] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)
  const cancelled = download.status === 'cancelled'
  const retryAction = headerActions(download).find((id) => ['retry', 'fix', 'again'].includes(id))
  const retryLabel = retryAction ? t(ACTION_META[retryAction].label) : t('Unavailable')
  const networkRetries = download.networks.reduce((total, network) => total + network.retries, 0)

  // Deliberately omit URLs, raw errors, cookies and request headers: links may contain credentials.
  const diagnosticText = [
    'Sonic diagnostic',
    `File: ${download.fileName}`,
    `Status: ${download.status}`,
    `Progress: ${download.bytesDownloaded} / ${download.totalBytes} bytes`,
    `Resume available: ${download.resumable === false ? 'no' : download.bytesDownloaded > 0 ? 'yes' : 'not applicable'}`,
    `Suggested action: ${retryLabel}`,
    'Automatic retry: not scheduled; retry is user-initiated',
    `Network retries: ${networkRetries}`,
    ...download.networks.map(
      (network) => `Network ${network.label}: ${network.status}; retries ${network.retries}`
    )
  ].join('\\n')
  const diagnosticReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    application: {
      name: 'Sonic',
      version: window.sonic.initialState.appVersion ?? 'unknown',
      platform: window.sonic.platform,
      electronVersion: window.sonic.initialState.electronVersion ?? 'unknown',
      nodeVersion: window.sonic.initialState.nodeVersion ?? 'unknown'
    },
    task: {
      id: download.id,
      fileName: download.fileName,
      kind: download.kind,
      status: download.status,
      startedAt: download.startedAt,
      completedAt: download.completedAt ?? null,
      bytesDownloaded: download.bytesDownloaded,
      totalBytes: download.totalBytes,
      bytesUploaded: 'bytesUploaded' in download ? (download.bytesUploaded ?? 0) : 0,
      totalPausedMs: download.totalPausedMs ?? 0,
      resumable: download.resumable !== false,
      retryCount: networkRetries,
      suggestedAction: retryLabel,
      error: download.error ?? null,
      finalPath: '[redacted by default]',
      sourceUrl: '[omitted]'
    },
    networks: download.networks.map((network) => ({
      label: network.label,
      kind: network.kind,
      status: network.status,
      bytesDownloaded: network.bytesDownloaded,
      speedBytesPerSecond: network.speedBytesPerSec,
      retries: network.retries,
      error: network.error ?? null
    })),
    privacy: {
      urlsAndCredentialsRedactedBeforeSave: true,
      fullLocalPathsOmittedByDefault: true
    }
  }
  const knownSize = download.totalBytes > 0
  const percent = knownSize ? formatPercent(download.bytesDownloaded, wantedBytes(download)) : 0
  const heading = t(cancelled ? 'Download cancelled' : 'Download failed')
  const description = cancelled
    ? t('The download was stopped before finishing.')
    : download.error
      ? describeError(download.error)
      : t('The download stopped unexpectedly. Try again.')

  const handleCopyUrl = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(download.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Ignore clipboard write failures
    }
  }

  const handleCopyDiagnostics = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(diagnosticText)
      setDiagnosticsCopied(true)
      setTimeout(() => setDiagnosticsCopied(false), 2000)
    } catch {
      // Clipboard may be unavailable; keep the screen usable.
    }
  }

  const handleSaveReport = async (): Promise<void> => {
    setReportError(null)
    setReportSaved(false)
    try {
      const saved = await window.sonic.saveDiagnosticReport(JSON.stringify(diagnosticReport))
      if (saved) {
        setReportSaved(true)
        setTimeout(() => setReportSaved(false), 2500)
      }
    } catch {
      // Never expose raw filesystem errors or paths in the UI; keep the action retryable.
      setReportError(
        t(
          'Could not save the diagnostic report. Check the destination and permissions, then try again.'
        )
      )
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <DetailHeader download={download} />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 py-6">
        <div className="flex w-full max-w-[440px] flex-col items-center gap-[18px] rounded-xl border-[0.5px] border-border bg-card p-6 text-center">
          {/* Status Icon */}
          <div
            className={`flex size-12 shrink-0 items-center justify-center rounded-full border ${
              cancelled
                ? 'border-[var(--color-usb-border)] bg-[var(--color-usb-bg)]'
                : 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)]'
            }`}
          >
            {cancelled ? (
              <svg viewBox="0 0 24 24" className="size-[22px]" aria-hidden="true">
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  stroke="var(--color-usb-text)"
                  strokeWidth="2"
                />
                <line
                  x1="8"
                  y1="12"
                  x2="16"
                  y2="12"
                  stroke="var(--color-usb-text)"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="size-[22px]" aria-hidden="true">
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  className="stroke-destructive"
                  strokeWidth="2"
                />
                <line
                  x1="12"
                  y1="8"
                  x2="12"
                  y2="12.5"
                  className="stroke-destructive"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
                <circle cx="12" cy="15.5" r="1.2" className="fill-destructive" />
              </svg>
            )}
          </div>

          {/* Heading */}
          <div role="alert" className="flex flex-col gap-[5px]">
            <div className="font-sans text-[17px] leading-[1.2] font-bold text-foreground">
              {heading}
            </div>
            <div className="font-sans text-[12px] leading-[1.4] text-[var(--text-secondary)]">
              {description}
            </div>
          </div>

          {/* File capsule */}
          <div className="flex w-full items-center gap-[11px] rounded-[9px] border-[0.5px] border-border bg-background p-[10px_12px] text-left">
            <div className="flex size-[34px] shrink-0 items-center justify-center rounded-[7px] border-[0.5px] border-[var(--border-strong)] bg-card font-mono text-[8.5px] leading-none font-semibold text-[var(--text-secondary)]">
              {isFolder(download) ? (
                <Folder aria-label="Folder" className="size-[15px]" />
              ) : (
                fileExtensionBadge(download.fileName)
              )}
            </div>
            <div className="min-w-0 flex-1">
              <TruncatedText
                text={download.fileName}
                className="font-sans text-[12.5px] leading-[1.3] font-semibold text-foreground"
              />
              <div className="mt-0.5 font-mono text-[11px] leading-none tabular-nums text-muted-foreground">
                {download.bytesDownloaded > 0 ? (
                  <>
                    {formatBytes(download.bytesDownloaded)}
                    {knownSize
                      ? ` of ${formatBytes(wantedBytes(download))} (${percent}%)`
                      : ' downloaded'}
                  </>
                ) : (
                  'No data downloaded'
                )}
              </div>
            </div>
          </div>

          <div className="flex w-full min-w-0 items-center gap-2 border-t-[0.5px] border-border pt-3">
            <div className="min-w-0 flex-1 text-left font-mono text-[11px] leading-none text-muted-foreground">
              <TruncatedText text={download.url} />
            </div>
            <button
              type="button"
              onClick={handleCopyUrl}
              className={`min-h-6 shrink-0 border-none bg-transparent px-1 py-0.5 font-mono text-[11px] leading-none ${
                copied ? 'text-[var(--color-success)]' : 'text-primary'
              }`}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>

          <div className="flex w-full flex-col gap-2 text-left">
            <div className="text-[12.5px] font-semibold text-foreground">What happens next</div>
            <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {cancelled
                ? 'This download is cancelled. Start it again if you still need the file.'
                : retryAction
                  ? `${retryLabel} is available from the buttons above. Automatic retry is not scheduled.`
                  : 'No retry action is available for this task.'}
            </p>
            <div className="flex items-center justify-between gap-3 text-[11.5px] text-muted-foreground">
              <span>{networkRetries} network retries recorded</span>
              <span>
                {download.resumable === false
                  ? 'Partial progress cannot be resumed'
                  : download.bytesDownloaded > 0
                    ? 'Partial progress may be resumed'
                    : 'No partial progress to resume'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleCopyDiagnostics()}
              className="inline-flex min-h-8 items-center justify-center gap-2 self-start rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-secondary"
            >
              <ClipboardCopy aria-hidden className="size-3.5" />
              {diagnosticsCopied ? 'Diagnostics copied' : 'Copy diagnostic details'}
            </button>
            {reportError && (
              <p role="alert" className="text-left text-[12px] text-destructive">
                {reportError}
              </p>
            )}
            <button
              type="button"
              onClick={() => void handleSaveReport()}
              className="inline-flex min-h-8 items-center justify-center gap-2 self-start rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-secondary"
            >
              <FileDown aria-hidden className="size-3.5" />
              {reportSaved ? 'Report saved' : 'Export diagnostic report…'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

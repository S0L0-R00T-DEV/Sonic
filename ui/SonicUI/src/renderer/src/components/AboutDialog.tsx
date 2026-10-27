import { useEffect, useState } from 'react'
import { CheckCircle2, Download, ExternalLink, Info, LoaderCircle, RefreshCw } from 'lucide-react'
import { describeError } from '../utils/format'
import sonicBlueLogo from '../assets/brand/sonic-blue.png'
import sonicBlackLogo from '../assets/brand/sonic-black.png'
import sonicRedLogo from '../assets/brand/sonic-red.png'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/button'
import { TermsOfServiceDialog } from './TermsOfServiceDialog'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import type { UpdateDownloadProgress } from '../../../shared/types'

const UPDATE_REPOSITORY = 'S0L0-R00T-DEV/Sonic'
const REPOSITORY_URL = 'https://github.com/S0L0-R00T-DEV/Sonic'

type UpdateResult = Awaited<ReturnType<typeof window.sonic.checkForUpdate>>

export function AboutDialog({
  open,
  onOpenChange,
  updateNotificationVersion
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  updateNotificationVersion: string | null
}): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<UpdateResult | null>(null)
  const [installing, setInstalling] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<UpdateDownloadProgress | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [termsOpen, setTermsOpen] = useState(false)
  const themeSource = useAppStore((store) => store.themeSource)
  const brandLogo =
    themeSource === 'dark' ? sonicBlackLogo : themeSource === 'light' ? sonicRedLogo : sonicBlueLogo
  const installedVersion = window.sonic.initialState.appVersion ?? 'Unknown'

  useEffect(() => {
    if (!installing) return
    return window.sonic.onUpdateDownloadProgress(setUpdateProgress)
  }, [installing])

  const checkForUpdates = (): void => {
    setChecking(true)
    setMessage(null)
    void window.sonic
      .checkForUpdate(UPDATE_REPOSITORY)
      .then(setResult)
      .catch((cause: unknown) =>
        setResult({
          configured: true,
          currentVersion: 'unknown',
          error: describeError(cause)
        })
      )
      .finally(() => setChecking(false))
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.sonic
      .checkForUpdate(UPDATE_REPOSITORY)
      .then((update) => {
        if (!cancelled) setResult(update)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setResult({
            configured: true,
            currentVersion: 'unknown',
            error: describeError(cause)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, updateNotificationVersion])

  const installUpdate = (): void => {
    setInstalling(true)
    setUpdateProgress({ bytesDownloaded: 0, totalBytes: 0, percent: 0, phase: 'downloading' })
    setMessage(null)
    void window.sonic
      .downloadVerifiedUpdate(UPDATE_REPOSITORY)
      .then(async (download) => {
        setUpdateProgress({
          bytesDownloaded: 0,
          totalBytes: 0,
          percent: 100,
          phase: 'starting-installer'
        })
        const started = await window.sonic.openVerifiedUpdate(download.operationId)
        if (!started.opened) {
          setMessage(
            'The verified update could not be started: ' + (started.error ?? 'unknown error')
          )
          setInstalling(false)
        }
      })
      .catch((cause: unknown) => {
        setMessage('Update could not be installed: ' + describeError(cause))
        setInstalling(false)
      })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex max-h-[min(620px,calc(100%-2rem))] max-w-[520px] flex-col gap-0 overflow-y-auto p-0 sm:max-w-[520px]"
      >
        <div className="flex items-center gap-2 border-b-[0.5px] border-border px-5 py-4">
          <Info className="size-5 text-[var(--text-secondary)]" />
          <DialogTitle className="text-base font-semibold">About Sonic</DialogTitle>
        </div>
        <div className="flex flex-col gap-4 px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-secondary">
              <img src={brandLogo} alt="" className="size-9 object-contain" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">Sonic Download Manager</h2>
              <p className="mt-1 text-sm font-medium text-foreground">
                Installed version: {installedVersion}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                A desktop download manager for organizing downloads, managing queues, and
                integrating with your browsers.
              </p>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setTermsOpen(true)}
          >
            <Info className="mr-2 size-4" />
            Read Terms of Service
          </Button>

          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 self-start text-sm underline underline-offset-4"
          >
            <ExternalLink className="size-4" />
            Sonic on GitHub
          </a>

          <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <div>
              <h3 className="font-semibold">Software updates</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Sonic checks for new stable releases in the background and notifies you when one is
                available. Updates are only installed when you press the update button.
              </p>
            </div>

            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="self-start"
              disabled={checking || installing}
              onClick={checkForUpdates}
            >
              {checking ? (
                <>
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  Checking…
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 size-4" />
                  Check for updates
                </>
              )}
            </Button>

            {result && (
              <div role="status" className="break-words text-sm text-muted-foreground">
                {result.error ? (
                  <p>{result.error}</p>
                ) : result.updateAvailable ? (
                  <div className="flex flex-col gap-2">
                    <p className="font-medium text-foreground">
                      Update available: Sonic {result.latestVersion}
                    </p>
                    {result.publishedAt && (
                      <p>Released {new Date(result.publishedAt).toLocaleDateString()}</p>
                    )}
                    {result.releaseNotes && (
                      <details className="rounded-md border border-border px-3 py-2">
                        <summary className="cursor-pointer font-medium">Release notes</summary>
                        <p className="mt-2 whitespace-pre-wrap">{result.releaseNotes}</p>
                      </details>
                    )}
                    {result.verificationError && (
                      <p className="text-amber-600">{result.verificationError}</p>
                    )}
                    {result.assetName && result.assetSha256 && !result.verificationError && (
                      <p className="text-xs">
                        Manifest signature verified; installer hash check follows download.
                      </p>
                    )}
                    {result.assetName && result.assetSha256 && !result.verificationError ? (
                      <Button type="button" size="sm" disabled={installing} onClick={installUpdate}>
                        {installing ? (
                          <>
                            <LoaderCircle className="mr-2 size-4 animate-spin" />
                            Downloading update…
                          </>
                        ) : (
                          <>
                            <Download className="mr-2 size-4" />
                            Update Sonic
                          </>
                        )}
                      </Button>
                    ) : (
                      <p className="text-xs text-amber-600">
                        This development build does not include the release publisher trust key, so
                        installation cannot be tested from this build. Signed release builds embed
                        that key and install verified updates directly in Sonic.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="inline-flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-emerald-600" />
                    Sonic is up to date (version {result.currentVersion}).
                  </p>
                )}
              </div>
            )}
            {installing && updateProgress && (
              <div
                role="dialog"
                aria-label="Downloading Sonic update"
                className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-sm"
              >
                <div className="flex items-center gap-2">
                  <LoaderCircle className="size-4 animate-spin text-primary" />
                  <p className="font-medium text-foreground">
                    {updateProgress.phase === 'downloading'
                      ? 'Downloading update…'
                      : updateProgress.phase === 'verifying'
                        ? 'Verifying downloaded update…'
                        : 'Starting installer…'}
                  </p>
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-secondary"
                  role="progressbar"
                  aria-label="Update download progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={updateProgress.percent}
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-150"
                    style={{ width: `${updateProgress.percent}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>
                    {updateProgress.phase === 'downloading'
                      ? updateProgress.totalBytes > 0
                        ? `${(updateProgress.bytesDownloaded / 1024 / 1024).toFixed(1)} / ${(updateProgress.totalBytes / 1024 / 1024).toFixed(1)} MB`
                        : 'Receiving installer…'
                      : updateProgress.phase === 'verifying'
                        ? 'Checking installer SHA-256...'
                        : '100%'}
                  </span>
                  <span>{updateProgress.percent}%</span>
                </div>
              </div>
            )}
            {message && (
              <p role="status" className="break-words text-sm text-muted-foreground">
                {message}
              </p>
            )}
          </section>
          <p className="text-xs text-muted-foreground">
            Updates are downloaded and cryptographically verified before installation. Sonic never
            opens an installer whose publisher signature or file hash cannot be verified.
          </p>
        </div>
      </DialogContent>
      <TermsOfServiceDialog open={termsOpen} onOpenChange={setTermsOpen} />
    </Dialog>
  )
}

import { DEFAULT_DOWNLOAD_SCHEDULE, validSchedule } from '@shared/downloadSchedule'
import {
  DEFAULT_SLOW_MODE_SPEED,
  DOWNLOADS_AT_ONCE,
  type AppSettings,
  type DownloadSchedule
} from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { describeError } from '../utils/format'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { Alert, AlertDescription } from './ui/alert'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Check, Download, Minus, Plus, Tags } from 'lucide-react'
import { ScheduleFields } from './ScheduleFields'
import { DownloadOrganizationDialog } from './DownloadOrganizationDialog'
import { PluginManagement } from './PluginManagement'
import { RemoteControlSettings } from './RemoteControlSettings'
import { PerformanceDiagnostics } from './PerformanceDiagnostics'
import { useLocale } from '../i18n'

type Draft = Pick<
  ReturnType<typeof useAppStore.getState>,
  'downloadsAtOnce' | 'downloadSchedule' | 'completionAction' | 'slowModeSpeed'
>

const DEFAULTS = {
  downloadsAtOnce: DOWNLOADS_AT_ONCE.default,
  downloadSchedule: undefined,
  completionAction: 'notify',
  slowModeSpeed: DEFAULT_SLOW_MODE_SPEED
} satisfies Partial<Draft>

export function LimitsDialog({
  showSchedule = false,
  open,
  onOpenChange
}: {
  showSchedule?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  page: string | null
  onPageChange: (page: string | null) => void
}): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  return (
    <Dialog open={open} disablePointerDismissal onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        initialFocus={
          showSchedule
            ? () => {
                contentRef.current
                  ?.querySelector<HTMLElement>('[aria-label="Download schedule"]')
                  ?.scrollIntoView({ block: 'start' })
                return (
                  contentRef.current?.querySelector<HTMLElement>(
                    '[aria-label="Enable download schedule"]'
                  ) ?? false
                )
              }
            : undefined
        }
        showCloseButton={false}
        className="flex h-[min(520px,calc(100%-2rem))] max-w-[560px] flex-col gap-0 p-0 sm:max-w-[560px]"
      >
        {open && <SettingsEditor onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function SettingsEditor({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useLocale()
  const [draft, setDraft] = useState<Draft>(() => {
    const { downloadsAtOnce, downloadSchedule, completionAction, slowModeSpeed } =
      useAppStore.getState()
    return { downloadsAtOnce, downloadSchedule, completionAction, slowModeSpeed }
  })
  const [speedMagnitude, setSpeedMagnitude] = useState<'KB' | 'MB' | 'GB'>(() => {
    const unit = useAppStore.getState().speedUnit
    return unit.startsWith('GB') ? 'GB' : unit.startsWith('KB') ? 'KB' : 'MB'
  })
  const [slowModeLimit, setSlowModeLimit] = useState(() =>
    String(Math.max(1, Math.round(useAppStore.getState().slowModeSpeed / (1024 * 1024))))
  )
  const [confirmReset, setConfirmReset] = useState(false)
  const [tagsRulesOpen, setTagsRulesOpen] = useState(false)
  const [confirmClearHistory, setConfirmClearHistory] = useState(false)
  const [clearingHistory, setClearingHistory] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [storageInfo, setStorageInfo] = useState<{ userDataDir: string } | null>(
    null
  )
  const [storageBusy, setStorageBusy] = useState(false)
  const [exportChoiceOpen, setExportChoiceOpen] = useState(false)
  const [storageMessage, setStorageMessage] = useState<string | null>(null)
  const [browserBusy, setBrowserBusy] = useState<string | null>(null)
  const [chromiumPathCopied, setChromiumPathCopied] = useState(false)
  const [firefoxDownloaded, setFirefoxDownloaded] = useState(false)
  const [browserActionMessage, setBrowserActionMessage] = useState<string | null>(null)
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(
    () => useAppStore.getState().autoUpdateEnabled ?? true
  )
  const updateRepository = 'S0L0-R00T-DEV/Sonic'
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateResult, setUpdateResult] = useState<Awaited<
    ReturnType<typeof window.sonic.checkForUpdate>
  > | null>(null)
  const [updateDownloadBusy, setUpdateDownloadBusy] = useState(false)
  const [verifiedUpdate, setVerifiedUpdate] = useState<{
    operationId: string
    fileName: string
    sha256: string
  } | null>(null)
  const [updateActionMessage, setUpdateActionMessage] = useState<string | null>(null)
  useEffect(() => {
    void window.sonic
      .getStorageInfo()
      .then(setStorageInfo)
      .catch((cause: unknown) => {
        setStorageMessage(describeError(cause))
      })
  }, [t])
  const requestedSlowModeSpeed = Number(slowModeLimit) * 1024 * 1024
  const validSlowModeLimit =
    slowModeLimit.trim() !== '' &&
    Number.isInteger(Number(slowModeLimit)) &&
    Number.isFinite(requestedSlowModeSpeed) &&
    requestedSlowModeSpeed > 0 &&
    requestedSlowModeSpeed <= Number.MAX_SAFE_INTEGER
  const atDefaults =
    draft.downloadsAtOnce === DEFAULTS.downloadsAtOnce &&
    draft.downloadSchedule === DEFAULTS.downloadSchedule &&
    draft.completionAction === DEFAULTS.completionAction &&
    Math.round(requestedSlowModeSpeed) === DEFAULT_SLOW_MODE_SPEED &&
    speedMagnitude === 'MB'
  const valid =
    (draft.downloadSchedule === undefined || validSchedule(draft.downloadSchedule)) &&
    validSlowModeLimit

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const current = useAppStore.getState()
    const patch: AppSettings = {}
    if (draft.downloadsAtOnce !== current.downloadsAtOnce)
      patch.downloadsAtOnce = draft.downloadsAtOnce
    if (draft.downloadSchedule !== current.downloadSchedule)
      patch.downloadSchedule = draft.downloadSchedule
    if (draft.completionAction !== current.completionAction)
      patch.completionAction = draft.completionAction
    const slowModeSpeed = Math.round(requestedSlowModeSpeed)
    if (slowModeSpeed !== current.slowModeSpeed) patch.slowModeSpeed = slowModeSpeed
    if (
      speedMagnitude !==
      (current.speedUnit.startsWith('GB') ? 'GB' : current.speedUnit.startsWith('KB') ? 'KB' : 'MB')
    ) {
      patch.speedUnit =
        `${speedMagnitude}${current.speedUnit.endsWith('ps') ? 'ps' : '/s'}` as AppSettings['speedUnit']
    }
    try {
      await window.sonic.updateSettings(patch)
      useAppStore.setState(patch)
      onClose()
    } catch (cause) {
      setError(describeError(cause))
      setSaving(false)
    }
  }

  const resetDraft = (): void => {
    setDraft({ ...DEFAULTS })
    setSpeedMagnitude('MB')
    setSlowModeLimit(String(Math.round(DEFAULT_SLOW_MODE_SPEED / (1024 * 1024))))
    setConfirmReset(false)
  }

  const runStorageAction = async (action: 'export' | 'restore', exportKind?: 'settings' | 'history'): Promise<void> => {
    setStorageBusy(true)
    setStorageMessage(null)
    try {
      if (action === 'export') {
        if (!exportKind) return
        const saved = await window.sonic.exportStorageBackup(exportKind)
        setExportChoiceOpen(false)
        setStorageMessage(saved ? (exportKind === 'history' ? 'Download history exported.' : 'Sonic settings exported.') : 'Export cancelled.')
      } else {
        const restored = await window.sonic.restoreStorageBackup()
        if (restored?.kind === 'history') {
          setStorageMessage(`Download history imported (${restored.historyEntries} entries merged).`)
        } else if (restored?.kind === 'settings') {
          setStorageMessage('Sonic settings restored. Sonic is restarting to load them.')
        } else if (restored?.kind === 'sonic') {
          setStorageMessage('Sonic backup restored. Sonic is restarting to load saved tasks.')
        }
      }
    } catch (cause) {
      setStorageMessage(describeError(cause))
    } finally {
      setStorageBusy(false)
    }
  }

  return (
    <>
      <div className="flex items-center border-b-[0.5px] border-border px-4 py-3">
        <DialogTitle className="text-[16px] font-semibold">{t('settings')}</DialogTitle>
      </div>
      <fieldset disabled={saving} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <section className="flex flex-col gap-2 border-t-[0.5px] border-border py-3">
          <h3 className="font-sans text-[14px] leading-none font-semibold">Chromium browser integration</h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">Sonic does not detect or launch Chromium browsers. Open your preferred browser and choose Manage extensions, or enter <code>chrome://extensions</code>. Other Chromium browsers may use their own browser-name scheme or the same Manage extensions menu.</p>
          <div>
            <Button type="button" size="sm" variant={chromiumPathCopied ? 'default' : 'secondary'} className={chromiumPathCopied ? 'bg-emerald-600 text-white hover:bg-emerald-700' : undefined} disabled={browserBusy === 'chromium-copy-path'} onClick={() => {
              setBrowserBusy('chromium-copy-path')
              setChromiumPathCopied(false)
              setBrowserActionMessage(null)
              void window.sonic.copyChromiumExtensionFolderPath()
                .then((result) => {
                  setChromiumPathCopied(result.copied)
                  setBrowserActionMessage(result.copied ? 'Path copied. In the folder picker, paste it into the address bar and select the chromium folder.' : (result.error ?? 'Could not find the Chromium folder.'))
                })
                .catch((cause: unknown) => setBrowserActionMessage(describeError(cause)))
                .finally(() => setBrowserBusy(null))
            }}>{chromiumPathCopied ? <><Check className="mr-1 size-4" />Copied</> : browserBusy === 'chromium-copy-path' ? 'Copying…' : 'Copy extension path'}</Button>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            <li>Open <code>chrome://extensions</code> in Chrome, or open your browser’s own Extensions / Manage extensions page in another Chromium browser.</li>
            <li>Turn on <strong>Developer mode</strong>.</li>
            <li>Click <strong>Load unpacked</strong>. A folder-selection pop-up window will appear.</li>
            <li>Click <strong>Copy extension path</strong> above. In the pop-up window, paste the copied path into the address bar, then open and select the <strong>chromium</strong> folder. Make sure you select the folder that directly contains <code>manifest.json</code>, then click <strong>Select Folder</strong>.</li>
            <li>Enable the extension and configure it through the browser’s extension menu or the extension’s Options page.</li>
          </ol>
          <details className="mt-3 rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Tested and working Chromium browsers</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              <li>Dia</li>
              <li>Opera</li>
              <li>Google Chrome</li>
              <li>UC Browser</li>
              <li>Brave</li>
            </ul>
          </details>
          <div className="mt-3 border-t border-border pt-3">
            <h4 className="text-sm font-semibold">Firefox integration</h4>
            <p className="text-xs text-muted-foreground">Firefox uses its separate XPI package and Add-ons Manager.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" disabled={browserBusy === "firefox"} onClick={() => { setBrowserBusy("firefox"); setBrowserActionMessage(null); void window.sonic.openBrowserExtensionPage().then((result) => { if (!result.opened) setBrowserActionMessage(result.error ?? "Could not open Firefox Add-ons Manager."); }).catch((cause: unknown) => setBrowserActionMessage(describeError(cause))).finally(() => setBrowserBusy(null)); }}>{browserBusy === "firefox" ? t("opening") : "Open Firefox Add-ons"}</Button>
              <Button type="button" size="sm" variant={firefoxDownloaded ? 'default' : 'outline'} className={firefoxDownloaded ? 'bg-emerald-600 text-white hover:bg-emerald-700' : undefined} disabled={browserBusy === "firefox-download"} onClick={() => { setBrowserBusy("firefox-download"); setFirefoxDownloaded(false); setBrowserActionMessage(null); void window.sonic.copyBrowserExtensionFolderPath().then((result) => { setFirefoxDownloaded(result.copied); setBrowserActionMessage(result.copied ? "Downloaded to your Downloads folder." : (result.error ?? "Could not save the package.")); }).catch((cause: unknown) => setBrowserActionMessage(describeError(cause))).finally(() => setBrowserBusy(null)); }}>{firefoxDownloaded ? <><Download className="mr-1 size-4" />Downloaded</> : browserBusy === "firefox-download" ? "Downloading…" : "Download Firefox extension"}</Button>
            </div>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
              <li>Press <strong>Download extension</strong>. Sonic saves <strong>SDMFFE.xpi</strong> to your Downloads folder automatically.</li>
              <li>Press <strong>Open Firefox Add-ons</strong> to open Firefox Add-ons Manager.</li>
              <li>In the top-right area, click the settings gear icon.</li>
              <li>Choose <strong>Install Add-on From File…</strong>.</li>
              <li>Open your Downloads folder, select <strong>SDMFFE.xpi</strong>, and click Open.</li>
              <li>When Firefox asks for confirmation, click <strong>Add</strong>. The Sonic Download Manager extension is installed.</li>
            </ol>
          </div>
          {browserActionMessage && <p role="status" className="break-all text-xs text-muted-foreground">{browserActionMessage}</p>}
        </section>
        <section className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3">
          <h3 className="font-sans text-[14px] leading-none font-semibold">Tags & automatic rules</h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            Sonic assigns basic category tags automatically. Manage available tags and destination rules here; removing a tag also removes it from existing assignments.
          </p>
          <Button type="button" variant="secondary" size="sm" className="self-start" onClick={() => setTagsRulesOpen(true)}>
            <Tags data-icon="inline-start" /> Manage tags & rules
          </Button>
        </section>

        <section
          aria-labelledby="completion-notifications-title"
          className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3"
        >
          <h3
            id="completion-notifications-title"
            className="font-sans text-[14px] leading-none font-semibold"
          >
            Download notifications
          </h3>
          <label className="flex items-center justify-between gap-4 text-sm">
            Show completion notifications
            <input
              aria-label="Show completion notifications"
              type="checkbox"
              checked={draft.completionAction !== 'none'}
              onChange={(event) => {
                const enabled = event.currentTarget.checked
                setDraft((previous) => ({
                  ...previous,
                  completionAction: enabled ? 'notify' : 'none'
                }))
              }}
            />
          </label>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            Show a Sonic-themed notification when a download finishes, even when Sonic is minimized
            or hidden in the system tray. Select Open to launch a recognized installer or reveal an
            ordinary file in its folder. Your choice is saved when you press Save.
          </p>
        </section>
        <section className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3">
          <h3 className="font-sans text-[14px] leading-none font-semibold">Speed display units</h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            Choose the magnitude shown in the main window. Use its bottom-right switch to display
            bytes per second or bits per second.
          </p>
          <select
            aria-label="Speed display magnitude"
            value={speedMagnitude}
            onChange={(event) => setSpeedMagnitude(event.currentTarget.value as 'KB' | 'MB' | 'GB')}
            className="h-10 rounded-md border border-input bg-background px-3 text-foreground"
          >
            <option value="KB">KB</option>
            <option value="MB">MB</option>
            <option value="GB">GB</option>
          </select>
        </section>
        <section className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3">
          <h3 className="font-sans text-[14px] leading-none font-semibold">
            Slow mode speed limit
          </h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            Set the maximum combined download speed used when Slow mode is switched on from the main
            window. This limit applies across downloads and networks.
          </p>
          <label htmlFor="sonic-slow-mode-limit" className="text-sm">
            Maximum download speed
          </label>
          <div className="flex gap-2">
            <input
              id="sonic-slow-mode-limit"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              value={slowModeLimit}
              onChange={(event) => {
                const value = event.currentTarget.value
                setSlowModeLimit(value)
                const rate = Number(value) * 1024 * 1024
                if (
                  Number.isInteger(Number(value)) &&
                  Number.isFinite(rate) &&
                  rate >= 1024 * 1024 &&
                  rate <= Number.MAX_SAFE_INTEGER
                ) {
                  setDraft((previous) => ({ ...previous, slowModeSpeed: Math.round(rate) }))
                }
              }}
              className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-foreground"
              aria-describedby="sonic-slow-mode-help"
            />
            <span className="flex h-10 items-center rounded-md border border-input bg-muted px-3 text-sm">
              MB/s
            </span>
          </div>
          <p id="sonic-slow-mode-help" className="text-xs text-muted-foreground">
            Slow mode is only a toggle in the main window; change its speed here.
          </p>
        </section>
        <section className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3">
          <h3 className="font-sans text-[14px] leading-none font-semibold">
            {t('downloadsAtOnce')}
          </h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            Other downloads wait in the queue and start automatically.
          </p>
          <div className="flex items-center gap-3 text-[13.5px]">
            <div className="flex items-center rounded-lg border border-input">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Decrease simultaneous downloads"
                disabled={draft.downloadsAtOnce <= DOWNLOADS_AT_ONCE.min}
                onClick={() =>
                  setDraft((previous) => ({
                    ...previous,
                    downloadsAtOnce: previous.downloadsAtOnce - 1
                  }))
                }
              >
                <Minus />
              </Button>
              <output
                aria-label="Downloads at once"
                className="w-8 text-center font-mono tabular-nums"
              >
                {draft.downloadsAtOnce}
              </output>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Increase simultaneous downloads"
                disabled={draft.downloadsAtOnce >= DOWNLOADS_AT_ONCE.max}
                onClick={() =>
                  setDraft((previous) => ({
                    ...previous,
                    downloadsAtOnce: previous.downloadsAtOnce + 1
                  }))
                }
              >
                <Plus />
              </Button>
            </div>
            at the same time
          </div>
        </section>

        <ScheduleFields
          schedule={draft.downloadSchedule ?? DEFAULT_DOWNLOAD_SCHEDULE}
          onChange={(downloadSchedule: DownloadSchedule) =>
            setDraft((previous) => ({ ...previous, downloadSchedule }))
          }
        />
        <section className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3">
          <h3 className="font-sans text-[14px] leading-none font-semibold">Software updates</h3>
          <label className="flex items-center justify-between text-sm">
            Automatic software updates{' '}
            <input
              type="checkbox"
              checked={autoUpdateEnabled}
              onChange={(event) => {
                const enabled = event.currentTarget.checked
                setAutoUpdateEnabled(enabled)
                void window.sonic
                  .updateSettings({ autoUpdateEnabled: enabled })
                  .then(() => useAppStore.setState({ autoUpdateEnabled: enabled }))
              }}
            />
          </label>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            Automatically check for updates while Sonic is running, or disable automatic updates and
            check manually here.
          </p>

          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={updateBusy}
            onClick={() => {
              setUpdateBusy(true)
              setUpdateResult(null)
              void window.sonic
                .checkForUpdate(updateRepository)
                .then(setUpdateResult)
                .catch((cause: unknown) =>
                  setUpdateResult({
                    configured: true,
                    currentVersion: 'unknown',
                    error: describeError(cause)
                  })
                )
                .finally(() => setUpdateBusy(false))
            }}
          >
            {updateBusy ? 'Checkingâ€¦' : 'Check for updates'}
          </Button>
          {updateResult && (
            <div role="status" className="break-words text-xs text-muted-foreground">
              {updateResult.error
                ? updateResult.error
                : updateResult.updateAvailable
                  ? 'Update available: ' + updateResult.latestVersion
                  : 'Sonic is up to date (installed ' +
                    updateResult.currentVersion +
                    ', latest ' +
                    updateResult.latestVersion +
                    ').'}
              {updateResult.releaseNotes && (
                <p className="mt-2 whitespace-pre-wrap">{updateResult.releaseNotes}</p>
              )}
              {updateResult.releaseUrl && (
                <p className="mt-2">
                  <a
                    className="underline"
                    href={updateResult.releaseUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open release page and notes
                  </a>
                </p>
              )}
              {updateResult.verificationError && (
                <p className="mt-2">{updateResult.verificationError}</p>
              )}
              {updateResult.assetName && updateResult.assetSha256 && (
                <div className="mt-2 space-y-2">
                  <p>
                    Publisher signature verified for {updateResult.assetName}. Signed SHA-256:{' '}
                    <span className="break-all font-mono">{updateResult.assetSha256}</span>
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={updateDownloadBusy}
                    onClick={() => {
                      setUpdateDownloadBusy(true)
                      setUpdateActionMessage(null)
                      setVerifiedUpdate(null)
                      void window.sonic
                        .downloadVerifiedUpdate(updateRepository.trim())
                        .then((result) => {
                          setVerifiedUpdate(result)
                          setUpdateActionMessage(
                            'Installer downloaded and SHA-256 verified: ' +
                              result.fileName +
                              '. Hash: ' +
                              result.sha256
                          )
                        })
                        .catch((cause: unknown) =>
                          setUpdateActionMessage('Update download blocked: ' + describeError(cause))
                        )
                        .finally(() => setUpdateDownloadBusy(false))
                    }}
                  >
                    {updateDownloadBusy
                      ? 'Downloading and verifyingâ€¦'
                      : 'Download and verify installer'}
                  </Button>
                </div>
              )}
              {verifiedUpdate && (
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  onClick={() => {
                    setUpdateActionMessage('')
                    void window.sonic
                      .openVerifiedUpdate(verifiedUpdate.operationId)
                      .then((result) =>
                        setUpdateActionMessage(
                          result.opened
                            ? 'Verified installer opened. Follow the installer prompts; close Sonic first if requested.'
                            : 'Installer could not be opened: ' + (result.error ?? 'unknown error')
                        )
                      )
                      .catch((cause: unknown) =>
                        setUpdateActionMessage('Installer launch blocked: ' + describeError(cause))
                      )
                  }}
                >
                  Open verified installer
                </Button>
              )}
              {updateActionMessage && (
                <p role="status" className="mt-2 break-all">
                  {updateActionMessage}
                </p>
              )}
              {updateResult.updateAvailable && (
                <p className="mt-2">
                  Sonic does not run downloaded code automatically. The installer is opened only
                  after signature and SHA-256 verification and an explicit click. Installer rollback
                  is not provided by this updater.
                </p>
              )}
            </div>
          )}
        </section>
        <section className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3">
          <h3 className="font-sans text-[14px] leading-none font-semibold">{t('backupStorage')}</h3>
          <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            Export settings separately from download history. Settings backups contain Sonic preferences; history backups contain finished-download records. Older full Sonic backups can also be restored, including saved queue metadata. Keep backups in a trusted location.
          </p>
          <p className="break-all text-xs text-muted-foreground">
            {storageInfo ? 'Storage: ' + storageInfo.userDataDir : 'Checking storage location…'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={storageBusy}
              onClick={() => { setExportChoiceOpen((open) => !open); setStorageMessage(null) }}
            >
              {t('exportBackup')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={storageBusy}
              onClick={() => void runStorageAction('restore')}
            >
              {storageBusy ? 'Restoring…' : t('restoreBackup')}
            </Button>
          </div>
          {exportChoiceOpen && (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <p className="text-sm font-medium">What would you like to export?</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="secondary" disabled={storageBusy} onClick={() => void runStorageAction('export', 'settings')}>
                  Export settings
                </Button>
                <Button type="button" size="sm" variant="secondary" disabled={storageBusy} onClick={() => void runStorageAction('export', 'history')}>
                  Export download history
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={storageBusy} onClick={() => setExportChoiceOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {storageMessage && (
            <p role="status" className="text-xs text-muted-foreground">
              {storageMessage}
            </p>
          )}
        </section>
        <PerformanceDiagnostics />
        <RemoteControlSettings />
        <div id="plugin-management-section">
          <PluginManagement />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t-[0.5px] border-border pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={clearingHistory}
            onClick={() => setConfirmClearHistory(true)}
          >
            Clear history
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={atDefaults}
            onClick={() => setConfirmReset(true)}
          >
            Reset to defaults
          </Button>
        </div>
      </fieldset>
      {tagsRulesOpen && (
        <DownloadOrganizationDialog open={true} onOpenChange={setTagsRulesOpen} selectedIds={[]} />
      )}
      {(!valid || error) && (
        <div className="px-4 pb-2">
          <Alert variant="destructive">
            <AlertDescription>
              {error ?? 'Check schedule times, repeat days and end date.'}
            </AlertDescription>
          </Alert>
        </div>
      )}
      <div className="flex items-center justify-end gap-2 border-t-[0.5px] border-border px-4 py-2">
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
          {t('cancel')}
        </Button>
        <Button type="button" disabled={!valid || saving} onClick={() => void save()}>
          {saving ? t('saving') : t('save')}
        </Button>
      </div>
      <AlertDialog
        open={confirmClearHistory}
        onOpenChange={(open) => !clearingHistory && setConfirmClearHistory(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear download history?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently clears saved download history. Downloaded files are not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearingHistory}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={clearingHistory}
              onClick={(event) => {
                event.preventDefault()
                setClearingHistory(true)
                void window.sonic
                  .clearHistory()
                  .then(() => {
                    useAppStore.setState({ history: [] })
                    setConfirmClearHistory(false)
                  })
                  .catch((cause: unknown) => setError(describeError(cause)))
                  .finally(() => setClearingHistory(false))
              }}
            >
              {clearingHistory ? 'Clearingâ€¦' : 'Clear history'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset settings to defaults?</AlertDialogTitle>
            <AlertDialogDescription>
              This resets downloads at once, the slow mode speed limit, and disables the download
              schedule. Other app settings are not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={resetDraft}>Reset to defaults</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

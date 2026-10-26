import { ChevronLeft } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  headerActions,
  isFinished,
  manageActions,
  type ActionId,
  type DownloadItem
} from '../utils/downloadActions'
import { useDownloadActions, useDownloadActionsState } from './downloadActionsContext'
import { ACTION_META } from './downloadActionMeta'
import { Button } from './ui/button'
import { useLocale } from '../i18n'
import { useFormatSpeedLimit } from '../hooks/useFormatSpeed'

/** The top of a download's own screen, laid out as the list's header is: the way back to the
 * list on the left; on the right the ways out (Cancel while it's unfinished; Remove, and Move to
 * Trash, after) and what the download can do next. They're what its row and its menu offer, from the same list. */
export function DetailHeader({ download }: { download: DownloadItem }): React.JSX.Element {
  const { t } = useLocale()
  const formatSpeedLimit = useFormatSpeedLimit()
  const setView = useAppStore((store) => store.setView)
  const { perform } = useDownloadActions()
  const { busy } = useDownloadActionsState()
  const [priorityError, setPriorityError] = useState<string | null>(null)
  const [downloadSpeedError, setDownloadSpeedError] = useState<string | null>(null)
  const [uploadRatioError, setUploadRatioError] = useState<string | null>(null)
  const [trackerRefreshError, setTrackerRefreshError] = useState<string | null>(null)
  const [trackerRefreshBusy, setTrackerRefreshBusy] = useState(false)
  const manage = manageActions(download)
  const next = headerActions(download)

  // Resuming round-trips through the main process to re-verify the download before its status
  // flips (an ETag re-check over the network for a real download). With no feedback in between,
  // a slow check reads as the button not having registered the click: it says so until the
  // download's state moves on.
  const state = isFinished(download) ? 'finished' : `${download.status}|${download.error ?? ''}`
  const [working, setWorking] = useState<{ id: ActionId; state: string } | null>(null)

  const run = (id: ActionId): void => {
    if (id === 'pause' || id === 'resume' || id === 'retry') setWorking({ id, state })
    void perform(id, [download]).then((done) => done || setWorking(null))
  }

  const button = (
    id: ActionId,
    variant: 'default' | 'secondary' | 'destructive'
  ): React.ReactNode => {
    const meta = ACTION_META[id]
    const isWorking = working?.id === id && working.state === state
    return (
      <Button
        key={id}
        type="button"
        variant={variant}
        disabled={isWorking || (busy && manage.includes(id))}
        onClick={() => run(id)}
      >
        {t(isWorking && meta.working ? meta.working : meta.label)}
      </Button>
    )
  }

  return (
    <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b-[0.5px] border-border px-4 py-2">
      <button
        type="button"
        onClick={() => setView({ name: 'list' })}
        className="-ml-2 flex items-center gap-1 rounded-md px-1.5 py-1 font-sans text-[15px] leading-none font-medium text-[var(--text-secondary)] hover:text-foreground"
      >
        <ChevronLeft className="size-4.5" />
        {t('Downloads')}
      </button>
      <div className="min-w-[6px] flex-1" />
      {!isFinished(download) && (
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="hidden 2xl:inline">{t('Priority')}</span>
          <select
            aria-label={t('Download queue priority')}
            className="h-8 max-w-28 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            value={String(download.priority ?? 1)}
            onChange={(event) => {
              const priority = Number(event.currentTarget.value) as 0 | 1 | 2
              setPriorityError(null)
              void window.sonic
                .setDownloadPriority(download.id, priority)
                .catch((error: unknown) => {
                  setPriorityError(error instanceof Error ? error.message : String(error))
                })
            }}
            title={priorityError ?? t('Choose which queued download starts first')}
          >
            <option value="0">{t('Low')}</option>
            <option value="1">{t('Normal')}</option>
            <option value="2">{t('High')}</option>
          </select>
        </label>
      )}

      {!isFinished(download) && (
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="hidden 2xl:inline">{t('Download receive speed limit')}</span>
          <select
            aria-label={t('Download receive speed limit')}
            className="h-8 max-w-32 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            value={download.maxDownloadSpeedBytesPerSecond?.toString() ?? ''}
            onChange={(event) => {
              const value = event.currentTarget.value
              const bytesPerSecond = value === '' ? null : Number(value)
              setDownloadSpeedError(null)
              void window.sonic
                .setDownloadSpeedLimit(download.id, bytesPerSecond)
                .catch((error: unknown) => {
                  setDownloadSpeedError(error instanceof Error ? error.message : String(error))
                })
            }}
            title={downloadSpeedError ?? t('Limit the combined receive speed of this download')}
          >
            <option value="">Unlimited</option>
            {[64, 128, 256, 512, 1024, 2048, 5120, 10240].map((kib) => {
              const bytesPerSecond = kib * 1024
              return (
                <option key={bytesPerSecond} value={String(bytesPerSecond)}>
                  {formatSpeedLimit(bytesPerSecond)}
                </option>
              )
            })}
          </select>
          {downloadSpeedError && (
            <span role="alert" className="max-w-40 truncate text-xs text-destructive">
              {downloadSpeedError}
            </span>
          )}
        </label>
      )}

      {download.kind === 'torrent' && !isFinished(download) && (
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="hidden 2xl:inline">{t('Upload ratio')}</span>
          <select
            aria-label={t('Torrent upload ratio limit')}
            className="h-8 max-w-32 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            value={download.uploadRatioLimit?.toString() ?? ''}
            onChange={(event) => {
              const value = event.currentTarget.value
              const ratio = value === '' ? null : Number(value)
              setUploadRatioError(null)
              void window.sonic.setUploadRatioLimit(download.id, ratio).catch((error: unknown) => {
                setUploadRatioError(error instanceof Error ? error.message : String(error))
              })
            }}
            title={
              uploadRatioError ??
              t('Stop uploading when uploaded bytes reach this multiple of downloaded bytes')
            }
          >
            <option value="">{t('Do not seed after completion')}</option>
            <option value="0">{t('Keep seeding until stopped')}</option>
            <option value="0.5">0.5×</option>
            <option value="1">1×</option>
            <option value="2">2×</option>
            <option value="5">5×</option>
            <option value="10">10×</option>
          </select>
          {download.uploadRatioReached && (
            <span role="status" aria-live="polite" className="text-xs text-amber-600">
              {t('Ratio reached')}
            </span>
          )}
          {uploadRatioError && (
            <span
              role="alert"
              aria-live="polite"
              className="max-w-40 truncate text-xs text-destructive"
              title={uploadRatioError}
            >
              {uploadRatioError}
            </span>
          )}
        </label>
      )}
      {download.kind === 'torrent' && !isFinished(download) && (
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={
              trackerRefreshBusy || (download.status !== 'downloading' && !download.seeding)
            }
            title={
              trackerRefreshError ??
              download.discoveryWarning ??
              t('Refresh peer discovery from configured trackers')
            }
            onClick={() => {
              setTrackerRefreshBusy(true)
              setTrackerRefreshError(null)
              void window.sonic
                .refreshTorrentTrackers(download.id)
                .catch((error: unknown) => {
                  setTrackerRefreshError(error instanceof Error ? error.message : String(error))
                })
                .finally(() => setTrackerRefreshBusy(false))
            }}
          >
            {t(trackerRefreshBusy ? 'Refreshing…' : 'Refresh trackers')}
          </Button>
          {(trackerRefreshError || download.discoveryWarning) && (
            <span
              role={trackerRefreshError ? 'alert' : 'status'}
              aria-live="polite"
              className="max-w-48 truncate text-xs text-destructive"
              title={trackerRefreshError ?? download.discoveryWarning}
            >
              {t('Tracker')}: {trackerRefreshError ?? download.discoveryWarning}
            </span>
          )}
        </>
      )}
      {download.kind === 'torrent' && download.seeding && (
        <Button
          type="button"
          variant="secondary"
          title={t('Stop sharing this completed torrent and move it to history')}
          onClick={() => {
            setTrackerRefreshError(null)
            void window.sonic.stopSeeding(download.id).catch((error: unknown) => {
              setTrackerRefreshError(error instanceof Error ? error.message : String(error))
            })
          }}
        >
          {t('Stop seeding')}
        </Button>
      )}
      {manage.map((id) => button(id, ACTION_META[id].destructive ? 'destructive' : 'secondary'))}
      {next.map((id, index) =>
        // The last is the main one; Pause is never the main one, it's the way to stop.
        button(id, index === next.length - 1 && id !== 'pause' ? 'default' : 'secondary')
      )}
    </div>
  )
}

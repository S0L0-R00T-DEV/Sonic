import type { ProbeResult } from '@shared/types'
import { cn } from 'cn'
import { AlertTriangle, ChevronLeft, ChevronRight, FolderOpen, Globe, Lock, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useFormatSpeedLimit } from '../hooks/useFormatSpeed'
import { useNetworkUsage } from '../hooks/useNetworks'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useDownloadSchedule } from '../hooks/useDownloadSchedule'
import { useAppStore } from '../store/useAppStore'
import {
  acceptedLink,
  describeError,
  describeFileCount,
  fileExtensionBadge,
  formatBytes,
  toDisplayPath
} from '../utils/format'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { TorrentFileList } from './TorrentFiles'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useLocale } from '../i18n'
type ProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'ready'; result: ProbeResult }
  | { status: 'error'; message: string }

const PROBE_DEBOUNCE_MS = 600

type StreamsChoice = 'auto' | number
/** Streams per network the user can pick instead of Auto. */
const STREAMS_CHOICES: StreamsChoice[] = ['auto', 4, 8, 16, 32]

const labelClass = 'w-16 shrink-0 text-[12.5px] text-[var(--text-secondary)]'

/** New download: a link, then only what differs from one download to the next — its name (or a
 * torrent's files), where it goes, over which networks, and how many streams each runs. Everything set once for every
 * download lives in Speed & data limits and the networks menu. */
export function NewDownloadDialog(): React.JSX.Element {
  const open = useAppStore((store) => store.newDownloadOpen)
  const close = useAppStore((store) => store.closeNewDownload)
  const formKey = useAppStore((store) => store.formKey)

  return (
    <Dialog open={open} disablePointerDismissal onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-w-[560px]"
      >
        {/* Mounted only while open, and keyed by what it shows, so each opening and each
            download stacked in it starts fresh. */}
        {open && <NewDownloadForm key={formKey} onDone={close} />}
      </DialogContent>
    </Dialog>
  )
}

function NewDownloadForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { t } = useLocale()
  const { schedule, window: scheduleWindow } = useDownloadSchedule()
  const scheduledWait = schedule?.enabled && !scheduleWindow.allowed
  const interfaces = useAppStore((store) => store.interfaces)
  // Object.values creates a fresh array on every store snapshot. Keep the selector referentially
  // stable so Zustand's useSyncExternalStore doesn't trigger an infinite render loop when the
  // dialog opens while downloads are present.
  const downloads = useAppStore(useShallow((store) => Object.values(store.downloads)))
  const homeDir = useAppStore((store) => store.homeDir)
  const url = useAppStore((store) => store.draftUrl)
  const setUrl = useAppStore((store) => store.setDraftUrl)
  const links = useAppStore((store) => store.links)
  const shownId = useAppStore((store) => store.shownId)
  const showLink = useAppStore((store) => store.showLink)
  const finishLink = useAppStore((store) => store.finishLink)
  const dropLink = useAppStore((store) => store.dropLink)
  const shownLink = links.find((link) => link.id === shownId)
  const position = shownLink ? links.indexOf(shownLink) : -1
  const destinationDir = useAppStore((store) => store.destinationDir)
  const setDestinationDir = useAppStore((store) => store.setDestinationDir)
  const full = useAppStore(
    (store) =>
      Object.values(store.downloads).filter((download) => download.status === 'downloading')
        .length >= store.downloadsAtOnce
  )
  const networkVisual = useNetworkVisuals()
  const networkPreferences = useAppStore((store) => store.networkPreferences)
  const globalSpeedLimit = useAppStore((store) => store.speedLimit)
  const slowMode = useAppStore((store) => store.slowMode)
  const setNetworkPreference = useAppStore((store) => store.setNetworkPreference)
  const usage = useNetworkUsage(true)
  const formatSpeedLimit = useFormatSpeedLimit()
  const linkInput = useRef<HTMLInputElement>(null)

  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' })
  // Tracks deselections rather than selections, so a newly-detected interface starts selected.
  // Starts from the last download's pick: the networks it left out are saved as `off`.
  const [deselectedInterfaceIds, setDeselectedInterfaceIds] = useState<string[]>(() =>
    Object.entries(useAppStore.getState().networkPreferences)
      .filter(([, preference]) => preference.off)
      .map(([id]) => id)
  )
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [fileNameOverride, setFileNameOverride] = useState<string | null>(null)
  const [metalinkFileIndex, setMetalinkFileIndex] = useState(0)
  // A torrent's files left out, by index: every file is downloaded unless unticked.
  const [skippedFiles, setSkippedFiles] = useState<number[]>([])
  // For this download only: the next one starts on Auto again.
  const [streamsChoice, setStreamsChoice] = useState<StreamsChoice>('auto')
  const [mediaVariantId, setMediaVariantId] = useState<string | null>(null)
  const [mirrorUrlsText, setMirrorUrlsText] = useState('')

  // Opened with nothing in it: a link on the clipboard is most likely what it's for, as download
  // managers have long assumed. Anything else on the clipboard is left alone.
  useEffect(() => {
    if (useAppStore.getState().draftUrl) return
    void window.sonic
      .readClipboardText()
      .then((text) => {
        const link = acceptedLink(text)
        const { draftUrl, startedUrl } = useAppStore.getState()
        if (link && link !== startedUrl && !draftUrl) setUrl(link)
      })
      .catch(() => {})
  }, [setUrl])

  useEffect(() => {
    const trimmed = url.trim()
    if (!trimmed) {
      // Resetting derived probe state when its trigger (the URL) is cleared.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProbe({ status: 'idle' })
      setFileNameOverride(null)
      setSkippedFiles([])
      setMirrorUrlsText('')
      return
    }

    // Checking here would go without the browser's sign-in, and could spend a single-use link.
    const { links: stacked, shownId: shown } = useAppStore.getState()
    const given = stacked.find((link) => link.id === shown)
    if (given && given.url !== trimmed) dropLink(given.id, false)
    setFileNameOverride(null)
    setMetalinkFileIndex(0)
    setSkippedFiles([])
    setMediaVariantId(null)
    setMirrorUrlsText('')
    if (given?.url === trimmed && given.probe) {
      setProbe({ status: 'ready', result: given.probe })
      return
    }

    // Set once the link changes, cleared included: a magnet can take a while to answer, and its
    // answer is no longer wanted then.
    let stale = false
    setProbe({ status: 'probing' })
    const timer = setTimeout(async () => {
      try {
        const result = await window.sonic.probeUrl(trimmed)
        if (stale) return
        setProbe({ status: 'ready', result })
      } catch (error) {
        if (stale) return
        setProbe({ status: 'error', message: describeError(error) })
      }
    }, PROBE_DEBOUNCE_MS)

    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [url, dropLink])

  const ready = probe.status === 'ready' ? probe.result : null
  const torrent = ready?.kind === 'torrent' ? ready.torrent : null
  const metalinkFiles = ready?.kind === 'http' ? (ready.metalink?.files ?? []) : []
  const selectedMetalinkFile = metalinkFiles[metalinkFileIndex] ?? metalinkFiles[0]
  const media = ready?.kind === 'http' ? (ready.media ?? null) : null
  const selectedMediaVariant =
    media?.variants.find((variant) => variant.id === mediaVariantId) ?? media?.variants[0] ?? null
  const mediaPolicyBlocked = Boolean(
    media &&
    ((globalSpeedLimit !== undefined && globalSpeedLimit > 0) ||
      slowMode ||
      Object.values(networkPreferences).some(
        (preference) => preference.speedLimit !== undefined || preference.dataLimit !== undefined
      ))
  )
  const chosenFiles = torrent
    ? torrent.files.flatMap((_, index) => (skippedFiles.includes(index) ? [] : [index]))
    : []
  // What will be downloaded: a torrent's chosen files, or the whole file.
  const sizeToFetch = torrent
    ? chosenFiles.reduce((sum, index) => sum + torrent.files[index].length, 0)
    : (selectedMetalinkFile?.size ?? ready?.totalBytes ?? null)
  const multiChunkAllowed = ready !== null && ready.supportsRanges && ready.totalBytes !== null
  const isSingleStreamOnly = ready !== null && !multiChunkAllowed
  // Advisory duplicate detection: allow intentional copies, but make existing active work visible.
  const duplicateDownload = ready
    ? downloads.find(
        (download) =>
          ['downloading', 'queued', 'paused'].includes(download.status) &&
          (download.url === ready.finalUrl || download.url === url.trim())
      )
    : undefined

  const detectedIds = interfaces.map((iface) => iface.id)
  // A network that has used up its data limit can't carry anything, so it can't be picked.
  const isReached = (id: string): boolean => {
    const dataLimit = networkPreferences[id]?.dataLimit
    return dataLimit !== undefined && (usage[id] ?? 0) >= dataLimit
  }
  const availableIds = detectedIds.filter((id) => !isReached(id))
  const pickedIds = availableIds.filter((id) => !deselectedInterfaceIds.includes(id))
  // The last pick may be all used up. Then nothing is picked, rather than what was left out: a
  // network left out is often left out on purpose (a phone's metered data), so it's chosen here
  // by hand, never stood in for the one that ran out.
  const selectedInterfaceIds = isSingleStreamOnly ? pickedIds.slice(0, 1) : pickedIds
  // The networks of the last pick that have used up their data, to say why nothing is picked.
  const usedUpPick =
    pickedIds.length === 0 && availableIds.length > 0
      ? interfaces.filter(
          (iface) => isReached(iface.id) && !deselectedInterfaceIds.includes(iface.id)
        )
      : []

  const canStart =
    probe.status === 'ready' &&
    (!media || (media.protocol === 'hls' && selectedMediaVariant !== null)) &&
    (!media || (!full && !scheduledWait && !mediaPolicyBlocked)) &&
    (!torrent || chosenFiles.length > 0) &&
    (media !== null || selectedInterfaceIds.length > 0) &&
    Boolean(destinationDir) &&
    !starting
  const startLabel = starting
    ? 'Starting'
    : probe.status === 'probing'
      ? 'Checking'
      : media
        ? 'Download media'
        : scheduledWait
          ? 'Add to scheduled queue'
          : full
            ? 'Add to queue'
            : 'Download'

  // Two networks on one subnet: the OS sends both down one route, so there's nothing to combine.
  let subnetConflict: { subnet: string; names: string[] } | null = null
  if (selectedInterfaceIds.length > 1) {
    const subnets = new Map<string, string[]>()
    for (const id of selectedInterfaceIds) {
      const iface = interfaces.find((i) => i.id === id)
      const subnet = iface?.addresses.find((address) => address.family === 4)?.subnet
      if (subnet && iface) {
        const names = subnets.get(subnet) ?? []
        names.push(networkVisual(iface.id, iface.kind, iface.displayName).name)
        subnets.set(subnet, names)
      }
    }
    for (const [subnet, names] of subnets.entries()) {
      if (names.length > 1) {
        subnetConflict = { subnet, names }
        break
      }
    }
  }

  const handleToggleInterface = (id: string): void => {
    if (isReached(id)) return
    if (isSingleStreamOnly) {
      // Single-stream mode can only download through 1 interface at a time
      setDeselectedInterfaceIds(detectedIds.filter((otherId) => otherId !== id))
      return
    }
    setDeselectedInterfaceIds((prev) => {
      if (prev.includes(id)) return prev.filter((entry) => entry !== id)
      // Keep at least 1 interface selected
      const remaining = availableIds.filter((other) => !prev.includes(other) && other !== id)
      return remaining.length === 0 ? prev : [...prev, id]
    })
  }

  const handleBrowse = async (): Promise<void> => {
    const chosen = await window.sonic.chooseDestinationFolder(destinationDir)
    if (chosen) setDestinationDir(chosen)
  }

  // A .torrent file goes in the link field as its path; the probe reads it from there.
  const handleOpenTorrent = async (): Promise<void> => {
    const path = await window.sonic.chooseTorrentFile()
    if (path) setUrl(path)
  }

  const handleResume = async (): Promise<void> => {
    const link = shownLink
    const resumes = link?.resumes
    if (!link || !resumes) return
    setStarting(true)
    setStartError(null)
    try {
      await window.sonic.resumeFromLink(link.id, resumes.id)
      useAppStore.setState({ view: { name: 'download', id: resumes.id } })
      finishLink(link.id, true)
    } catch (error) {
      setStartError(describeError(error))
      setStarting(false)
    }
  }

  const handleStart = async (): Promise<void> => {
    if (probe.status !== 'ready' || !canStart) return
    // Captured now: links can arrive and change what's shown while this starts.
    const linkId = shownLink?.id
    const form = useAppStore.getState().formKey
    setStarting(true)
    setStartError(null)
    try {
      let startResult = probe.result
      if (probe.result.kind === 'http' && selectedMetalinkFile) {
        const mirror = selectedMetalinkFile.mirrors.find((entry) => /^https?:/i.test(entry.url))
        if (!mirror) throw new Error('The selected Metalink file has no supported HTTP(S) mirror.')
        const checkedMirror = await window.sonic.probeUrl(mirror.url)
        if (checkedMirror.kind !== 'http' || checkedMirror.media || checkedMirror.metalink) {
          throw new Error('The selected Metalink mirror is not a direct file URL.')
        }
        if (
          selectedMetalinkFile.size !== undefined &&
          checkedMirror.totalBytes !== null &&
          selectedMetalinkFile.size !== checkedMirror.totalBytes
        ) {
          throw new Error('The selected Metalink file size does not match its mirror.')
        }
        startResult = {
          ...checkedMirror,
          requestedUrl: probe.result.requestedUrl,
          suggestedFileName: selectedMetalinkFile.name,
          totalBytes: selectedMetalinkFile.size ?? checkedMirror.totalBytes,
          metalink: probe.result.metalink
        }
      }
      const common = {
        url:
          startResult.kind === 'http' && startResult.transferProtocol && /^ftps?:/i.test(url.trim())
            ? url.trim()
            : startResult.finalUrl,
        destinationDir,
        suggestedFileName: fileNameOverride?.trim() || startResult.suggestedFileName,
        totalBytes: startResult.totalBytes ?? 0,
        supportsRanges: startResult.supportsRanges,
        interfaceIds: selectedInterfaceIds,
        etag: startResult.etag,
        lastModified: startResult.lastModified
      }
      const id = await window.sonic.startDownload(
        startResult.kind === 'torrent'
          ? {
              ...common,
              kind: 'torrent',
              infoHash: startResult.torrent.infoHash,
              selectedFiles: skippedFiles.length > 0 ? chosenFiles : undefined
            }
          : {
              ...common,
              kind: 'http',
              streamsPerNetwork: streamsChoice === 'auto' ? undefined : streamsChoice,
              ...(selectedMetalinkFile?.sha256
                ? { expectedSha256: selectedMetalinkFile.sha256 }
                : {}),
              ...(selectedMetalinkFile?.mirrors &&
              (selectedMetalinkFile.sha256 ||
                (startResult.etag && !startResult.etag.toLowerCase().startsWith('w/')))
                ? {
                    mirrorUrls: selectedMetalinkFile.mirrors
                      .filter(
                        (mirror) =>
                          mirror.url !== startResult.finalUrl && /^https?:/i.test(mirror.url)
                      )
                      .slice(0, 4)
                      .map((mirror) => mirror.url)
                  }
                : {}),
              ...(mirrorUrlsText.trim()
                ? {
                    mirrorUrls: [
                      ...new Set(
                        mirrorUrlsText
                          .split(/\r?\n/)
                          .map((entry) => entry.trim())
                          .filter(Boolean)
                      )
                    ]
                  }
                : {}),
              ...(media && selectedMediaVariant
                ? {
                    mediaStream: {
                      protocol: media.protocol,
                      manifestUrl: media.manifestUrl,
                      variantId: selectedMediaVariant.id,
                      variantUrl: selectedMediaVariant.url,
                      ...(selectedMediaVariant.audioUrl
                        ? { audioUrl: selectedMediaVariant.audioUrl }
                        : {})
                    }
                  }
                : {})
            },
        linkId
      )
      // Remembered for the next download, like the folder. Not a single-stream pick: that's one
      // network because the file allows no more, not because the others were unwanted.
      if (!isSingleStreamOnly) {
        for (const id of availableIds) {
          const off = !selectedInterfaceIds.includes(id)
          if (off !== Boolean(networkPreferences[id]?.off)) {
            setNetworkPreference(id, { off: off || undefined })
          }
        }
      }
      // Started: the link is spent, so the next download starts from an empty one. Its own
      // screen opens, unless it was only added to the queue.
      useAppStore.setState({
        startedUrl: url.trim(),
        ...(full || scheduledWait ? {} : { view: { name: 'download', id } as const })
      })
      if (linkId) {
        finishLink(linkId, true)
      } else if (useAppStore.getState().formKey === form) {
        // Only while this form is still the one shown: closing would dismiss a link that arrived.
        useAppStore.setState({ draftUrl: '' })
        onDone()
      }
    } catch (error) {
      setStartError(describeError(error))
      setStarting(false)
    }
  }

  const fileName = ready ? (fileNameOverride ?? ready.suggestedFileName) : ''

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        void handleStart()
      }}
    >
      <div className="flex items-center gap-2 border-b-[0.5px] border-border py-3 pr-3 pl-5">
        <DialogTitle className="flex-1 py-1 text-[16px] font-semibold">
          {t('newDownload')}
        </DialogTitle>
        {shownLink && links.length > 1 && (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Previous download')}
              disabled={position === 0}
              onClick={() => showLink(links[position - 1].id)}
            >
              <ChevronLeft />
            </Button>
            <span className="min-w-12 text-center font-mono text-[11.5px] text-muted-foreground tabular-nums">
              {t('{{current}} of {{total}}', { current: position + 1, total: links.length })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Next download')}
              disabled={position === links.length - 1}
              onClick={() => showLink(links[position + 1].id)}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-5 py-4">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[9px] border bg-[var(--input-bg)] px-3',
              probe.status === 'error' ? 'border-destructive' : 'border-input'
            )}
          >
            <input
              ref={linkInput}
              autoFocus
              type="text"
              id="new-download-link"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t('Paste a link') + ': https:// or magnet:'}
              spellCheck={false}
              aria-label={t('Link')}
              className="min-w-0 flex-1 border-none bg-transparent font-mono text-[13px] text-foreground"
            />
            {url && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => {
                        setUrl('')
                        linkInput.current?.focus()
                      }}
                      aria-label={t('Clear link')}
                      className="flex size-5 shrink-0 cursor-default items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <X aria-hidden className="size-3.5" />
                    </button>
                  }
                />
                <TooltipContent>{t('Clear link')}</TooltipContent>
              </Tooltip>
            )}
          </div>
          <Button type="button" variant="secondary" onClick={handleOpenTorrent} className="h-9">
            <FolderOpen data-icon="inline-start" />
            {t('Open .torrent')}
          </Button>
        </div>

        {shownLink?.from && (
          <div className="flex h-6 items-center gap-1.5 self-start rounded-full border-[0.5px] border-[var(--color-wifi-border)] bg-[var(--color-wifi-bg)] px-2.5 text-[12px] font-medium text-[var(--color-wifi-text)]">
            {shownLink.signedInTo ? (
              <Lock aria-hidden className="size-3" />
            ) : (
              <Globe aria-hidden className="size-3" />
            )}
            {t('From {{from}}', { from: shownLink.from })}
            {shownLink.signedInTo
              ? ` · ${t('with your {{service}} sign-in', { service: shownLink.signedInTo })}`
              : ''}
          </div>
        )}

        {shownLink?.resumes && (
          <div className="flex items-center gap-3 rounded-lg border-[0.5px] border-border bg-card px-3 py-2 text-[12.5px]">
            <span className="min-w-0 flex-1">
              {t('Same file as {{name}}, which failed. Resume that instead?', {
                name: shownLink.resumes.fileName
              })}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={starting}
              onClick={() => void handleResume()}
            >
              {t('Resume it')}
            </Button>
          </div>
        )}

        {probe.status === 'probing' && (
          <div className="font-mono text-[11.5px] text-muted-foreground">
            {t('Checking the link…')}
          </div>
        )}
        {duplicateDownload && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12.5px] text-muted-foreground"
          >
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <span>
              {t(
                'This link is already {{status}} as {{name}}. You can still start another copy if that is intentional.',
                {
                  status: t(
                    duplicateDownload.status === 'downloading'
                      ? 'downloading'
                      : duplicateDownload.status === 'queued'
                        ? 'queued'
                        : 'paused'
                  ),
                  name: duplicateDownload.fileName
                }
              )}
            </span>
          </div>
        )}

        {probe.status === 'error' && (
          <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-danger)]">
            <AlertTriangle className="size-4 shrink-0" />
            {probe.message}
          </div>
        )}

        {ready && (
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border-[0.5px] border-border bg-card font-mono text-[10px] font-semibold text-muted-foreground">
              {torrent && torrent.files.length > 1 ? 'DIR' : fileExtensionBadge(fileName)}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {metalinkFiles.length > 1 && (
                <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
                  {t('Metalink file')}
                  <select
                    aria-label={t('Metalink file')}
                    className="min-w-0 flex-1 rounded-md border border-input bg-card px-2 py-1 text-[12px] text-foreground"
                    value={metalinkFileIndex}
                    onChange={(event) => {
                      const nextIndex = Number(event.target.value)
                      setMetalinkFileIndex(nextIndex)
                      setFileNameOverride(metalinkFiles[nextIndex]?.name ?? null)
                    }}
                  >
                    {metalinkFiles.map((file, index) => (
                      <option key={`${file.name}-${index}`} value={index}>
                        {file.name}
                        {file.size === undefined ? '' : ` · ${formatBytes(file.size)}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {torrent ? (
                <div className="truncate text-[14px] font-medium">{ready.suggestedFileName}</div>
              ) : (
                <input
                  type="text"
                  value={fileName}
                  onChange={(event) => setFileNameOverride(event.target.value)}
                  aria-label={t('File name')}
                  spellCheck={false}
                  className="min-w-0 rounded-md border border-transparent bg-transparent px-1 -ml-1 text-[14px] font-medium hover:border-input focus:border-input"
                />
              )}
              <div className="font-mono text-[11.5px] text-muted-foreground">
                {[
                  torrent && describeFileCount(chosenFiles.length, torrent.files.length),
                  sizeToFetch !== null ? formatBytes(sizeToFetch) : t('size unknown'),
                  !torrent &&
                    (media
                      ? t('Media stream · FFmpeg')
                      : isSingleStreamOnly
                        ? ready.supportsRanges
                          ? t('Uses one connection. The file size is unknown.')
                          : t(
                              'Uses one connection. This server doesn’t support parallel downloads.'
                            )
                        : t('resumable'))
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
          </div>
        )}

        {ready?.kind === 'http' && !media && ready.supportsRanges && (
          <section className="flex flex-col gap-1.5">
            <label
              htmlFor="download-mirrors"
              className="text-[12.5px] text-[var(--text-secondary)]"
            >
              {t('Alternate mirrors (optional, one URL per line)')}
            </label>
            <textarea
              id="download-mirrors"
              aria-label={t('Alternate mirror URLs')}
              value={mirrorUrlsText}
              onChange={(event) => setMirrorUrlsText(event.target.value)}
              placeholder="https://mirror.example/file.zip"
              rows={2}
              spellCheck={false}
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-[11.5px] text-foreground focus:border-ring"
            />
            <p className="text-[11px] text-muted-foreground">
              {t(
                'Sonic only uses mirrors that match the primary file size, support ranges, and share its strong ETag. Maximum four mirrors.'
              )}
            </p>
          </section>
        )}

        {media && (
          <section className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-medium">
                  {media.protocol.toUpperCase()} {t('Media stream')}
                </div>
                <div className="text-[11.5px] text-muted-foreground">
                  {t('On-demand, non-DRM stream · FFmpeg required')}
                </div>
              </div>
              <span className="rounded-md border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
                {media.variants.length} {t(media.variants.length === 1 ? 'variant' : 'variants')}
              </span>
            </div>
            <label className="flex items-center gap-3 text-[12.5px]">
              <span className={labelClass}>{t('Quality')}</span>
              <select
                aria-label={t('Media stream quality')}
                value={selectedMediaVariant?.id ?? ''}
                onChange={(event) => setMediaVariantId(event.target.value)}
                disabled={media.variants.length < 2}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-2 text-foreground"
              >
                {media.variants.map((variant) => (
                  <option key={variant.id} value={variant.id}>
                    {variant.label}
                  </option>
                ))}
              </select>
            </label>
            {media.protocol === 'dash' && (
              <p role="status" className="text-[11.5px] text-amber-600">
                {t(
                  'DASH variants are detected, but DASH downloading is not enabled yet. HLS on-demand downloads are supported.'
                )}
              </p>
            )}
            {(full || scheduledWait || mediaPolicyBlocked) && (
              <p role="status" className="text-[11.5px] text-amber-600">
                {t(
                  mediaPolicyBlocked
                    ? 'Media downloads do not yet enforce bandwidth or data caps. Disable those policies before starting a media download.'
                    : 'Media downloads do not enter the queue yet. Wait for an available download slot and an active schedule window.'
                )}
              </p>
            )}
          </section>
        )}

        {torrent && (
          <TorrentFileList
            files={torrent.files}
            skipped={skippedFiles}
            onChange={setSkippedFiles}
          />
        )}

        <div className="flex items-center gap-3">
          <div className={labelClass}>{t('Save to')}</div>
          <div className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
            {toDisplayPath(destinationDir, homeDir)}
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={handleBrowse}>
            {t('Change')}
          </Button>
        </div>

        <div hidden={Boolean(media)} className="flex items-start gap-3">
          <div className={cn(labelClass, 'pt-1.5')} id="new-download-networks">
            {t('networks')}
          </div>
          <div
            role="group"
            aria-labelledby="new-download-networks"
            className="flex min-w-0 flex-1 flex-wrap gap-1.5"
          >
            {interfaces.map((iface) => {
              const visual = networkVisual(iface.id, iface.kind, iface.displayName)
              const selected = selectedInterfaceIds.includes(iface.id)
              const reached = isReached(iface.id)
              const speedLimit = networkPreferences[iface.id]?.speedLimit
              // What's worth knowing before it's picked: it can't be, or it's capped.
              const note = reached
                ? 'Data limit reached'
                : speedLimit !== undefined
                  ? `Limited to ${formatSpeedLimit(speedLimit)}`
                  : null
              const chip = (
                <button
                  key={iface.id}
                  type="button"
                  aria-pressed={selected}
                  // Not `disabled`: a disabled button never gets the hover that says why.
                  aria-disabled={reached || undefined}
                  onClick={() => handleToggleInterface(iface.id)}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors',
                    selected
                      ? 'border-transparent'
                      : 'border-border text-[var(--text-secondary)] opacity-70',
                    reached && 'cursor-not-allowed line-through opacity-50'
                  )}
                  style={
                    selected ? { background: visual.bg, borderColor: visual.border } : undefined
                  }
                >
                  <span className="size-2 rounded-full" style={{ background: visual.solid }} />
                  {visual.name}
                </button>
              )
              return note === null ? (
                chip
              ) : (
                <Tooltip key={iface.id}>
                  <TooltipTrigger render={chip} />
                  <TooltipContent>{note}</TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </div>

        {/* A torrent's speed comes from its peers, and an unsplittable file has one stream. */}
        {ready && !torrent && !media && !isSingleStreamOnly && (
          <div className="flex items-center gap-3">
            <div className={labelClass} id="new-download-streams">
              Streams
            </div>
            <ToggleGroup
              value={[String(streamsChoice)]}
              onValueChange={(values) => {
                if (values.length === 0) return
                setStreamsChoice(values[0] === 'auto' ? 'auto' : Number(values[0]))
              }}
              aria-labelledby="new-download-streams"
              variant="pill"
              size="xs"
              spacing={1}
            >
              {STREAMS_CHOICES.map((choice) => (
                // h-6/min-w-6: WCAG 2.5.8's 24px floor — the xs toggle size is 20px.
                <ToggleGroupItem key={choice} value={String(choice)} className="h-6 min-w-6 px-2">
                  {choice === 'auto' ? 'Auto' : choice}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="font-mono text-[11px] text-muted-foreground">{t('per network')}</div>
          </div>
        )}

        {subnetConflict && !media && (
          <div className="flex items-start gap-2 text-[12px] leading-snug text-[var(--color-usb-text)]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {t(
              '{{names}} share a subnet ({{subnet}}), so the computer sends both down one route and they can’t be combined.',
              {
                names: subnetConflict.names.join(' and '),
                subnet: subnetConflict.subnet
              }
            )}
          </div>
        )}
        {usedUpPick.length > 0 && !media && (
          <div className="flex items-start gap-2 text-[12px] leading-snug text-[var(--color-usb-text)]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {t(
              '{{names}} {{verb}} reached {{possessive}} data limit. Choose another network for this download.',
              {
                names: usedUpPick
                  .map((iface) => networkVisual(iface.id, iface.kind, iface.displayName).name)
                  .join(' and '),
                verb: usedUpPick.length === 1 ? 'has' : 'have',
                possessive: usedUpPick.length === 1 ? 'its' : 'their'
              }
            )}
          </div>
        )}
        {interfaces.length > 0 && availableIds.length === 0 && (
          <div className="flex items-start gap-2 text-[12px] leading-snug text-[var(--color-usb-text)]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {t('Every network has reached its data limit. Raise one in Speed & data limits.')}
          </div>
        )}
        {isSingleStreamOnly && selectedInterfaceIds.length === 1 && interfaces.length > 1 && (
          <div className="text-[12px] text-muted-foreground">
            {t('This download uses one connection on one network.')}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t-[0.5px] border-border px-4 py-2">
        {startError ? (
          <div className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-danger)]">
            {startError}
          </div>
        ) : (
          <div className="flex-1" />
        )}
        <Button type="button" variant="secondary" onClick={onDone}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={!canStart}>
          {t(startLabel)}
        </Button>
      </div>
    </form>
  )
}

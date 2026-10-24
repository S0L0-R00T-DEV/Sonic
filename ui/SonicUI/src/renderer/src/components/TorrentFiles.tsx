import type { TorrentFileEntry, TorrentPieceState } from '@shared/types'
import { cn } from 'cn'
import { Folder } from 'lucide-react'
import { useEffect, useState } from 'react'
import { describeError, formatBytes, formatPercent, pathInTorrent } from '../utils/format'
import { Checkbox } from './ui/checkbox'
import { useLocale } from '../i18n'

/** Bytes of each file that are in verified pieces. Files and pieces both run in byte order, so
 * one pass over each. */
const PREVIEW_EXTENSIONS = new Set([
  '.mp4',
  '.webm',
  '.m4v',
  '.mov',
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.ogg',
  '.oga',
  '.opus'
])
const canPreview = (path: string): boolean =>
  PREVIEW_EXTENSIONS.has(path.slice(path.lastIndexOf('.')).toLowerCase())

function verifiedBytes(files: TorrentFileEntry[], pieces: TorrentPieceState[]): number[] {
  // Exclusive. A piece's rangeEnd is never null: that's for HTTP downloads of unknown size.
  const endOf = (piece: TorrentPieceState): number => (piece.rangeEnd ?? piece.rangeStart) + 1
  let start = 0
  let first = 0
  return files.map((file) => {
    const end = start + file.length
    while (first < pieces.length && endOf(pieces[first]) <= start) first++
    let done = 0
    for (let at = first; at < pieces.length && pieces[at].rangeStart < end; at++) {
      const piece = pieces[at]
      if (piece.status === 'completed') {
        done += Math.min(end, endOf(piece)) - Math.max(start, piece.rangeStart)
      }
    }
    start = end
    return done
  })
}

/** A torrent's files, each ticked to be downloaded. Several come in the torrent's folder, whose
 * row above them, by its name, ticks all of them. Given `done` (each file's bytes in), each shows
 * how far it is, and one all in stays ticked: it's downloaded. */
export function TorrentFileList({
  files,
  skipped,
  onChange,
  onPriorityChange,
  onPreview,
  done
}: {
  files: Array<{ path: string; length: number; priority?: 0 | 1 | 2; chosen?: boolean }>
  skipped: number[]
  onChange: (skipped: number[]) => void
  onPriorityChange?: (fileIndex: number, priority: 0 | 1 | 2) => void
  onPreview?: (fileIndex: number) => void
  done?: number[]
}): React.JSX.Element {
  const { t } = useLocale()
  // A torrent in a folder (always so with several files) starts every path with it.
  const parts = files[0]?.path.split(/[\\/]/) ?? []
  const folder = parts.length > 1 ? parts[0] : null
  const finished = (index: number): boolean =>
    done !== undefined && done[index] >= files[index].length
  return (
    <div
      role="group"
      aria-label={t('Files')}
      className="max-h-44 overflow-y-auto rounded-[9px] border border-border px-3 py-1.5"
    >
      {folder && (
        <label className="flex items-center gap-2 py-0.5 font-mono text-[11.5px] font-medium">
          <Checkbox
            checked={skipped.length === 0}
            indeterminate={skipped.length > 0 && skipped.length < files.length}
            onCheckedChange={(checked) =>
              // Unticking all leaves the downloaded ones: they're in.
              onChange(checked ? [] : files.flatMap((_, index) => (finished(index) ? [] : [index])))
            }
          />
          <Folder aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{folder}</span>
        </label>
      )}
      {files.map((file, index) => (
        <label
          key={index}
          className={cn('flex items-center gap-2 py-0.5 font-mono text-[11.5px]', folder && 'pl-6')}
        >
          <Checkbox
            checked={!skipped.includes(index)}
            disabled={finished(index)}
            onCheckedChange={(checked) =>
              onChange(checked ? skipped.filter((entry) => entry !== index) : [...skipped, index])
            }
          />
          <span className="min-w-0 flex-1 truncate">{pathInTorrent(file.path)}</span>
          <span className="shrink-0 text-muted-foreground">{formatBytes(file.length)}</span>
          {onPreview && file.chosen !== false && canPreview(file.path) && !finished(index) && (
            <button
              type="button"
              onClick={() => onPreview(index)}
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground hover:bg-muted"
              aria-label={`${t('Preview')} ${pathInTorrent(file.path)} ${t('while downloading')}`}
            >
              {t('Preview')}
            </button>
          )}
          {onPriorityChange && !finished(index) && !skipped.includes(index) && (
            <select
              aria-label={`${t('Priority for')} ${pathInTorrent(file.path)}`}
              className="h-6 max-w-20 rounded border border-border bg-background px-1 text-[10px] text-foreground"
              value={String(file.priority ?? 1)}
              onChange={(event) =>
                onPriorityChange(index, Number(event.currentTarget.value) as 0 | 1 | 2)
              }
              title={t("Set this file's download priority")}
            >
              <option value="0">{t('Low')}</option>
              <option value="1">{t('Normal')}</option>
              <option value="2">{t('High')}</option>
            </select>
          )}
          {done && (
            <span className="w-14 shrink-0 text-right tabular-nums text-[var(--text-secondary)]">
              {skipped.includes(index)
                ? t('Skipped')
                : finished(index)
                  ? t('Done')
                  : `${formatPercent(done[index], file.length)}%`}
            </span>
          )}
        </label>
      ))}
    </div>
  )
}

/** A torrent download's files once it has started: how far each is, and which to fetch, changed
 * as it runs. The choice is main's, `selected` as its state has it (unset: every file): a change
 * is asked for, and shows once the state it's sent back has it. */
export function TorrentFiles({
  downloadId,
  pieces,
  selected,
  customTrackers,
  previewEnabled = false
}: {
  downloadId: string
  pieces: TorrentPieceState[]
  selected: number[] | undefined
  customTrackers?: string[]
  previewEnabled?: boolean
}): React.JSX.Element | null {
  const { t } = useLocale()
  const [files, setFiles] = useState<TorrentFileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const trackerValue = customTrackers?.join('\n') ?? ''
  const [trackerText, setTrackerText] = useState(trackerValue)
  const [trackerBusy, setTrackerBusy] = useState(false)
  const [trackerError, setTrackerError] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    void window.sonic.torrentFiles(downloadId).then((entries) => {
      if (!stale) setFiles(entries)
    })
    return () => {
      stale = true
    }
  }, [downloadId])

  if (!files) return null
  const skipped = selected
    ? files.flatMap((_, index) => (selected.includes(index) ? [] : [index]))
    : []
  const choose = (next: number[]): void => {
    if (next.length === files.length) {
      setError(t('Keep at least one file.'))
      return
    }
    setError(null)
    const chosen = files.flatMap((_, index) => (next.includes(index) ? [] : [index]))
    window.sonic
      .chooseTorrentFiles(downloadId, chosen)
      .catch((cause) => setError(describeError(cause)))
  }
  const setPriority = (fileIndex: number, priority: 0 | 1 | 2): void => {
    setError(null)
    void window.sonic
      .setTorrentFilePriority(downloadId, fileIndex, priority)
      .then(() =>
        setFiles(
          (current) =>
            current?.map((file, index) => (index === fileIndex ? { ...file, priority } : file)) ??
            null
        )
      )
      .catch((cause) => setError(describeError(cause)))
  }
  const preview = (fileIndex: number): void => {
    void window.sonic
      .previewTorrentFile(downloadId, fileIndex)
      .catch((cause) => setError(describeError(cause)))
  }
  const saveTrackers = (): void => {
    const trackers = trackerText
      .split(/[\r\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean)
    setTrackerBusy(true)
    setTrackerError(null)
    void window.sonic
      .setTorrentTrackers(downloadId, trackers)
      .then(() => setTrackerText(trackers.join('\n')))
      .catch((cause) => setTrackerError(describeError(cause)))
      .finally(() => setTrackerBusy(false))
  }

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <TorrentFileList
        files={files}
        skipped={skipped}
        onChange={choose}
        onPriorityChange={setPriority}
        onPreview={previewEnabled ? preview : undefined}
        done={verifiedBytes(files, pieces)}
      />
      <div className="rounded-[9px] border border-border p-2.5">
        <label
          htmlFor={`torrent-trackers-${downloadId}`}
          className="mb-1 block text-xs font-medium text-foreground"
        >
          {t('Custom trackers (one URL per line)')}
        </label>
        <textarea
          id={`torrent-trackers-${downloadId}`}
          value={trackerText}
          onChange={(event) => setTrackerText(event.currentTarget.value)}
          rows={2}
          maxLength={40960}
          spellCheck={false}
          placeholder="https://tracker.example/announce"
          className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground"
        />
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            disabled={trackerBusy}
            onClick={saveTrackers}
            className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            {t(trackerBusy ? 'Applying…' : 'Apply trackers')}
          </button>
          <span className="text-[11px] text-muted-foreground">
            {t('Up to 20 HTTP(S)/UDP URLs; blank removes custom entries.')}
          </span>
        </div>
        {trackerError && (
          <p role="alert" className="mt-1 text-[12px] text-[var(--color-danger)]">
            {trackerError}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[12px] text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </div>
  )
}

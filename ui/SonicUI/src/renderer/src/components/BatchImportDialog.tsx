import type { ProbeResult, StartDownloadRequest } from '@shared/types'
import { AlertCircle, Check, FileUp, FolderOpen, ListPlus, LoaderCircle, X } from 'lucide-react'
import { Fragment, useRef, useState } from 'react'
import { describeError, formatBytes } from '../utils/format'
import { directoryListingLinks } from '../utils/batchLinks'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Textarea } from './ui/textarea'
import { Checkbox } from './ui/checkbox'
import { useLocale } from '../i18n'

const MAX_BATCH_SIZE = 100

type RowStatus = 'checking' | 'ready' | 'queued' | 'failed' | 'duplicate' | 'waiting'
interface BatchRow {
  id: string
  line: number
  input: string
  url?: string
  packageName?: string
  status: RowStatus
  detail: string
  selected?: boolean
  probe?: ProbeResult
  suggestedName?: string
}

function normalPath(path: string): string {
  const slash = String.fromCharCode(92)
  return path.split(slash).join('/').split('/').filter(Boolean).join('/').toLowerCase()
}

function cleanFileName(value: string): string {
  const slash = String.fromCharCode(92)
  let name = (value.split('/').pop() ?? '').split(slash).pop() ?? ''
  const invalid = '<>:"/|?*' + slash
  name = [...name]
    .map((character) =>
      character.charCodeAt(0) < 32 || invalid.includes(character) ? '_' : character
    )
    .join('')
    .replace(/[. ]+$/, '')
    .trim()
  if (!name || name === '.' || name === '..') name = 'download'
  const reserved = new Set([
    'con',
    'prn',
    'aux',
    'nul',
    ...Array.from({ length: 9 }, (_, i) => 'com' + (i + 1)),
    ...Array.from({ length: 9 }, (_, i) => 'lpt' + (i + 1))
  ])
  if (reserved.has(name.split('.')[0].toLowerCase())) name = '_' + name
  return name.slice(0, 180)
}

function uniqueFileName(name: string, directory: string, reserved: Set<string>): string {
  const safe = cleanFileName(name)
  const dot = safe.lastIndexOf('.')
  const base = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  let candidate = safe
  let suffix = 1
  while (reserved.has(normalPath(directory + '/' + candidate))) {
    candidate = base + ' (' + suffix++ + ')' + ext
  }
  reserved.add(normalPath(directory + '/' + candidate))
  return candidate
}

function parseCandidate(value: string): string | null {
  const candidate = value.trim().replace(/^<(.+)>$/, '$1')
  if (/^magnet:\?/i.test(candidate)) return candidate
  const slash = String.fromCharCode(92)
  const isTorrentPath = candidate.toLowerCase().endsWith('.torrent')
  const isDrivePath = /^[a-z]:/i.test(candidate) && (candidate[2] === slash || candidate[2] === '/')
  const isUncPath = candidate.startsWith(slash + slash)
  if (isTorrentPath && (isDrivePath || isUncPath)) return candidate
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    if (url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}
/** URL schemes and hosts are case-insensitive, but paths and query values are not. */
function candidateKey(value: string): string {
  if (/^magnet:\?/i.test(value)) return value.replace(/^magnet:/i, 'magnet:')
  try {
    const url = new URL(value)
    url.hash = '' // fragments are not sent to the server and do not identify a different file
    return url.toString()
  } catch {
    return value
  }
}

function packageFor(value: string): string {
  if (/^magnet:\?/i.test(value)) return 'Magnet links'
  if (/\.torrent$/i.test(value) && !/^https?:/i.test(value)) return 'Local torrent files'
  try {
    return new URL(value).hostname.toLowerCase() || 'Imported links'
  } catch {
    return 'Unresolved links'
  }
}

function linksFromLine(value: string, listingBaseUrl?: string): string[] {
  if (parseCandidate(value)) return [value]
  // This parses a user-supplied listing only; it never fetches or recursively follows a site.
  const resolved = directoryListingLinks(value, listingBaseUrl)
  // Also accept copied paragraphs and HTML snippets with absolute URLs. Strip common trailing
  // punctuation and decode HTML ampersands before URL validation.
  const absolute = (value.match(/https?:\/\/[^\s"'<>]+|magnet:\?[^\s"'<>]+/gi) ?? [])
    .map((candidate) => candidate.replace(/&amp;/gi, '&').replace(/[.,;!?]+$/, ''))
    .filter(Boolean)
    .filter((candidate) => {
      if (!(listingBaseUrl ?? '').trim() || /^magnet:\?/i.test(candidate)) return true
      try {
        const base = new URL((listingBaseUrl ?? '').trim())
        const url = new URL(candidate)
        return (
          ['http:', 'https:'].includes(base.protocol) &&
          url.origin === base.origin &&
          !url.username &&
          !url.password
        )
      } catch {
        return false
      }
    })
  // A copied HTML listing can yield the same absolute href through both the directory-listing
  // parser and the plain-text URL extractor. De-duplicate only within this source line; duplicates
  // across separate lines remain visible to uniqueCandidates as intentional skip notices.
  const seenOnLine = new Set<string>()
  return [...resolved, ...absolute].filter((candidate) => {
    const key = candidateKey(candidate)
    if (seenOnLine.has(key)) return false
    seenOnLine.add(key)
    return true
  })
}

function uniqueCandidates(
  text: string,
  listingBaseUrl?: string
): { rows: BatchRow[]; candidates: BatchRow[] } {
  const rows: BatchRow[] = []
  const candidates: BatchRow[] = []
  const seen = new Set<string>()
  const lines = text.split(/\r?\n/)
  let validCount = 0

  lines.forEach((raw, index) => {
    const value = raw.trim()
    if (!value || value.startsWith('#')) return
    const extracted = linksFromLine(value, listingBaseUrl)
    if (!extracted.length) {
      rows.push({
        id: `${index + 1}-0`,
        line: index + 1,
        input: value,
        status: 'failed',
        detail: 'Unsupported or invalid link. Use HTTP(S), magnet, or a local .torrent path.'
      })
      return
    }

    extracted.forEach((candidate, candidateIndex) => {
      const url = parseCandidate(candidate)
      const id = `${index + 1}-${candidateIndex + 1}`
      if (!url) {
        rows.push({
          id,
          line: index + 1,
          input: candidate,
          status: 'failed',
          detail: 'Unsupported or invalid link. Use HTTP(S), magnet, or a local .torrent path.'
        })
        return
      }
      const key = candidateKey(url)
      if (seen.has(key)) {
        rows.push({
          id,
          line: index + 1,
          input: url,
          url,
          packageName: packageFor(url),
          status: 'duplicate',
          detail: 'Duplicate link; skipped.'
        })
        return
      }
      seen.add(key)
      validCount += 1
      if (validCount > MAX_BATCH_SIZE) {
        rows.push({
          id,
          line: index + 1,
          input: url,
          url,
          packageName: packageFor(url),
          status: 'failed',
          detail: `Batch limit is ${MAX_BATCH_SIZE} unique links.`
        })
        return
      }
      const row: BatchRow = {
        id,
        line: index + 1,
        input: url,
        url,
        packageName: packageFor(url),
        status: 'waiting',
        detail: 'Waiting to check link'
      }
      rows.push(row)
      candidates.push(row)
    })
  })

  return { rows, candidates }
}

/**
 * Bulk import for direct URLs, magnet links and local .torrent files.
 * Items are probed and submitted sequentially so a pasted list cannot launch an unbounded burst.
 */
export function BatchImportDialog({
  open,
  onOpenChange,
  initialInput
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialInput?: string
}): React.JSX.Element {
  const { t } = useLocale()
  const initialFolder = useAppStore((store) => store.destinationDir)
  const setDestinationDir = useAppStore((store) => store.setDestinationDir)
  const [input, setInput] = useState(initialInput ?? '')
  const [listingBaseUrl, setListingBaseUrl] = useState('')
  const destinationDir = initialFolder
  const [rows, setRows] = useState<BatchRow[]>([])
  const [running, setRunning] = useState(false)
  const [previewReady, setPreviewReady] = useState(false)
  const [summary, setSummary] = useState('')
  const filePicker = useRef<HTMLInputElement>(null)

  const updateRow = (id: string, patch: Partial<BatchRow>): void => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }
  const displayRows = [...rows].sort(
    (left, right) =>
      (left.packageName ?? 'Unresolved links').localeCompare(
        right.packageName ?? 'Unresolved links'
      ) || left.line - right.line
  )

  const chooseFolder = async (): Promise<void> => {
    const selected = await window.sonic.chooseDestinationFolder(destinationDir)
    if (!selected) return
    setDestinationDir(selected)
    setRows([])
    setPreviewReady(false)
    setSummary(t('Destination changed. Preview links again before queueing.'))
  }

  const loadTextFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    try {
      setInput(await file.text())
      setRows([])
      setPreviewReady(false)
      setSummary(t('Loaded {{name}}. Review the list, then preview links.', { name: file.name }))
    } catch (error) {
      setSummary(t('Could not read file: {{error}}', { error: describeError(error) }))
    }
  }

  const previewLinks = async (): Promise<void> => {
    if (running) return
    if (!destinationDir.trim()) {
      setSummary(t('Choose a destination folder first.'))
      return
    }
    const parsed = uniqueCandidates(input, listingBaseUrl.trim() || undefined)
    setRows(parsed.rows)
    setPreviewReady(false)
    if (!parsed.candidates.length) {
      setSummary(t('No valid links to preview.'))
      return
    }

    setRunning(true)
    const snapshot = useAppStore.getState()
    const occupied = new Set<string>([
      ...Object.values(snapshot.downloads).map((item) => normalPath(item.destinationPath)),
      ...snapshot.history.map((item) => normalPath(item.destinationPath))
    ])
    let ready = 0
    let failed = parsed.rows.filter((row) => row.status === 'failed').length
    const skipped = parsed.rows.filter((row) => row.status === 'duplicate').length

    try {
      for (const row of parsed.candidates) {
        updateRow(row.id, { status: 'checking', detail: 'Checking link metadata…' })
        try {
          const probe: ProbeResult = await window.sonic.probeUrl(row.url!)
          const suggestedName = uniqueFileName(probe.suggestedFileName, destinationDir, occupied)
          const size =
            probe.totalBytes ??
            (probe.kind === 'torrent'
              ? probe.torrent.files.reduce((sum, file) => sum + file.length, 0)
              : 0)
          const type =
            probe.kind === 'torrent'
              ? 'TORRENT'
              : probe.media
                ? `${probe.media.protocol.toUpperCase()} media`
                : 'HTTP'
          ready += 1
          updateRow(row.id, {
            status: 'ready',
            selected: true,
            probe,
            suggestedName,
            detail: `${suggestedName} · ${type} · ${formatBytes(size)} · Package ${row.packageName ?? packageFor(row.url!)}`
          })
        } catch (error) {
          failed += 1
          updateRow(row.id, { status: 'failed', detail: describeError(error) })
        }
      }
    } finally {
      setRunning(false)
      setPreviewReady(true)
      setSummary(
        t(
          'Preview ready: {{ready}} selectable · Failed {{failed}} · Skipped duplicates {{skipped}}',
          {
            ready,
            failed,
            skipped
          }
        )
      )
    }
  }

  const queueSelected = async (): Promise<void> => {
    if (running) return
    const selectedRows = rows.filter(
      (row) => row.status === 'ready' && row.selected && row.probe && row.suggestedName
    )
    if (!selectedRows.length) {
      setSummary(t('Select at least one successfully checked link to add to the queue.'))
      return
    }
    setRunning(true)
    let added = 0
    let failed = rows.filter((row) => row.status === 'failed').length
    const skipped = rows.filter((row) => row.status === 'duplicate').length
    try {
      for (const row of selectedRows) {
        try {
          const probe = row.probe!
          const suggestedName = row.suggestedName!
          const common = {
            url: probe.finalUrl,
            destinationDir,
            suggestedFileName: suggestedName,
            ...(row.packageName && { packageName: row.packageName }),
            totalBytes:
              probe.totalBytes ??
              (probe.kind === 'torrent'
                ? probe.torrent.files.reduce((sum, file) => sum + file.length, 0)
                : 0),
            supportsRanges: probe.kind === 'http' && probe.supportsRanges,
            interfaceIds: [],
            etag: probe.kind === 'http' ? probe.etag : null,
            lastModified: probe.kind === 'http' ? probe.lastModified : null
          }
          const request: StartDownloadRequest =
            probe.kind === 'torrent'
              ? { ...common, kind: 'torrent', infoHash: probe.torrent.infoHash }
              : { ...common, kind: 'http' }
          const downloadId = await window.sonic.startDownload(request)
          added += 1
          updateRow(row.id, {
            status: 'queued',
            selected: false,
            detail: t('Added to queue · {{name}} · Package {{package}} · ID {{id}}', {
              name: suggestedName,
              package: row.packageName ?? t('Imported links'),
              id: downloadId
            })
          })
        } catch (error) {
          failed += 1
          updateRow(row.id, { status: 'failed', detail: describeError(error) })
        }
      }
    } finally {
      setRunning(false)
      setSummary(
        t('Added {{added}} · Failed {{failed}} · Skipped duplicates {{skipped}}', {
          added,
          failed,
          skipped
        })
      )
    }
  }

  const retryFailedChecks = async (): Promise<void> => {
    const retryRows = rows.filter((row) => row.status === 'failed' && row.url)
    if (running || !retryRows.length) return
    setRunning(true)
    const snapshot = useAppStore.getState()
    const occupied = new Set<string>([
      ...Object.values(snapshot.downloads).map((item) => normalPath(item.destinationPath)),
      ...snapshot.history.map((item) => normalPath(item.destinationPath))
    ])
    for (const row of rows) {
      if (row.suggestedName && ['ready', 'queued'].includes(row.status)) {
        occupied.add(normalPath(`${destinationDir}/${row.suggestedName}`))
      }
    }
    let recovered = 0
    try {
      for (const row of retryRows) {
        updateRow(row.id, { status: 'checking', detail: 'Retrying link check…' })
        try {
          const probe = await window.sonic.probeUrl(row.url!)
          const suggestedName = uniqueFileName(probe.suggestedFileName, destinationDir, occupied)
          const size =
            probe.totalBytes ??
            (probe.kind === 'torrent'
              ? probe.torrent.files.reduce((sum, file) => sum + file.length, 0)
              : 0)
          const type =
            probe.kind === 'torrent'
              ? 'TORRENT'
              : probe.media
                ? `${probe.media.protocol.toUpperCase()} media`
                : 'HTTP'
          const packageName = row.packageName ?? packageFor(row.url!)
          recovered += 1
          updateRow(row.id, {
            status: 'ready',
            selected: true,
            probe,
            suggestedName,
            packageName,
            detail: `${suggestedName} · ${type} · ${formatBytes(size)} · Package ${packageName}`
          })
        } catch (error) {
          updateRow(row.id, { status: 'failed', detail: describeError(error) })
        }
      }
    } finally {
      setRunning(false)
      setPreviewReady(true)
      setSummary(
        t('Retry complete: {{recovered}} recovered · {{failed}} still unresolved', {
          recovered,
          failed: retryRows.length - recovered
        })
      )
    }
  }

  const reset = (): void => {
    if (running) return
    setInput('')
    setRows([])
    setPreviewReady(false)
    setSummary('')
  }

  return (
    <Dialog
      open={open}
      disablePointerDismissal
      onOpenChange={(next) => {
        if (!running) onOpenChange(next)
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-w-[720px]"
      >
        <div className="flex items-start gap-3 border-b-[0.5px] border-border px-5 py-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ListPlus className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base font-semibold">
              {t('Import multiple downloads')}
            </DialogTitle>
            <DialogDescription className="mt-1">
              {t(
                'Paste a link manifest or copied HTML directory listing, or load a text file. Supports HTTP(S), magnet links and local .torrent paths. Relative listing links require a base URL and are restricted to that origin; folders are not crawled. Review items before queueing.'
              )}
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('Close import')}
            disabled={running}
            onClick={() => onOpenChange(false)}
          >
            <X />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          <Textarea
            value={input}
            onChange={(event) => {
              setInput(event.target.value)
              setRows([])
              setPreviewReady(false)
              setSummary('')
            }}
            placeholder={
              'https://example.com/file.zip\nhttps://example.com/another-file.iso\nmagnet:?xt=urn:btih:…\nHTML snippets and paragraphs with links are also accepted; # lines are comments'
            }
            aria-label={t('Download links, one per line or pasted text')}
            spellCheck={false}
            disabled={running}
            className="min-h-[150px] resize-y font-mono text-[12px] leading-relaxed"
          />
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('Directory-listing base URL (optional; relative file links only)')}
            <input
              type="url"
              value={listingBaseUrl}
              onChange={(event) => {
                setListingBaseUrl(event.target.value)
                setRows([])
                setPreviewReady(false)
                setSummary('')
              }}
              placeholder="https://example.com/files/"
              aria-label="Directory listing base URL"
              disabled={running}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <input
            ref={filePicker}
            type="file"
            accept=".txt,.urls,.html,.htm,.json,.csv,text/plain,text/html,application/json,text/csv"
            className="hidden"
            onChange={(event) => void loadTextFile(event)}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={running}
              onClick={() => filePicker.current?.click()}
            >
              <FileUp data-icon="inline-start" />
              Load link list
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={running}
              onClick={() => void chooseFolder()}
            >
              <FolderOpen data-icon="inline-start" />
              Destination
            </Button>
            <span
              className="ml-auto max-w-full truncate font-mono text-[11px] text-muted-foreground"
              title={destinationDir}
            >
              {destinationDir || 'No destination selected'}
            </span>
          </div>
          <div className="text-[11.5px] text-muted-foreground">
            Up to {MAX_BATCH_SIZE} unique links per batch. Unsupported lines and duplicate links are
            skipped with a report. Files are kept if a queue item is later removed.
          </div>

          {summary && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg border border-border bg-secondary/50 px-3 py-2 text-[12px]"
            >
              {running && <LoaderCircle className="mr-1.5 inline size-3.5 animate-spin" />}
              {summary}
            </div>
          )}

          {previewReady && rows.some((row) => row.status === 'failed' && row.url) && (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="secondary"
                disabled={running}
                onClick={() => void retryFailedChecks()}
              >
                {t('Retry failed checks')}
              </Button>
            </div>
          )}

          {rows.length > 0 && (
            <div className="max-h-52 overflow-y-auto rounded-lg border border-border">
              {displayRows.map((row, index) => (
                <Fragment key={row.id}>
                  {(index === 0 || displayRows[index - 1].packageName !== row.packageName) && (
                    <div className="bg-secondary/50 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t('Package')} · {t(row.packageName ?? 'Unresolved links')}
                    </div>
                  )}
                  <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2 last:border-b-0">
                    {row.status === 'ready' && (
                      <Checkbox
                        aria-label={`Select ${row.suggestedName ?? row.input}`}
                        checked={row.selected === true}
                        onCheckedChange={(checked) =>
                          updateRow(row.id, { selected: checked === true })
                        }
                        disabled={running}
                      />
                    )}
                    <span className="mt-0.5 shrink-0 text-muted-foreground font-mono text-[10px]">
                      {row.line}
                    </span>
                    {row.status === 'queued' ? (
                      <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                    ) : row.status === 'ready' ? (
                      <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    ) : row.status === 'failed' ? (
                      <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                    ) : row.status === 'duplicate' ? (
                      <X className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    ) : row.status === 'checking' ? (
                      <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
                    ) : (
                      <span className="mt-0.5 size-3.5 shrink-0 rounded-full border border-border" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[11px]" title={row.input}>
                        {row.input}
                      </div>
                      <div
                        className={`mt-0.5 break-words text-[11px] ${row.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
                      >
                        {t(row.detail)}
                      </div>
                    </div>
                  </div>
                </Fragment>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t-[0.5px] border-border px-4 py-2">
          <div className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            disabled={running || (!input && !rows.length)}
            onClick={reset}
          >
            {t('Clear')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={running}
            onClick={() => onOpenChange(false)}
          >
            {t('close')}
          </Button>
          <Button
            type="button"
            disabled={
              running ||
              (previewReady
                ? !rows.some((row) => row.status === 'ready' && row.selected)
                : !input.trim())
            }
            onClick={() => void (previewReady ? queueSelected() : previewLinks())}
          >
            {running ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <ListPlus data-icon="inline-start" />
            )}
            {running
              ? previewReady
                ? t('Adding…')
                : t('Checking…')
              : previewReady
                ? t('Add selected to queue')
                : t('Preview links')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

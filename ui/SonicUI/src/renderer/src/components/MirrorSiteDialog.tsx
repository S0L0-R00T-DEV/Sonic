import type { SiteMirrorPreview, SiteMirrorProgressEvent } from '@shared/types'
import { Globe, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { describeError } from '../utils/format'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { useLocale } from '../i18n'

export function MirrorSiteDialog({
  open,
  onOpenChange,
  onUseLinks
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUseLinks: (links: string[]) => void
}): React.JSX.Element {
  const { t } = useLocale()
  const [url, setUrl] = useState('')
  const [depth, setDepth] = useState(1)
  const [maxPages, setMaxPages] = useState(20)
  const [delaySeconds, setDelaySeconds] = useState(1)
  const [extensions, setExtensions] = useState('.zip, .iso, .pdf, .7z, .rar, .mp4')
  const [termsConfirmed, setTermsConfirmed] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<SiteMirrorPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const operationIdRef = useRef<string | null>(null)
  const [progress, setProgress] = useState<SiteMirrorProgressEvent | null>(null)

  useEffect(
    () =>
      window.sonic.onSiteMirrorProgress((event) => {
        if (event.operationId === operationIdRef.current) setProgress(event)
      }),
    []
  )

  const runPreview = async (): Promise<void> => {
    if (running) return
    setRunning(true)
    setError('')
    setPreview(null)
    setSelected(new Set())
    setProgress(null)
    const operationId = crypto.randomUUID()
    operationIdRef.current = operationId
    try {
      const normalizedExtensions = extensions
        .split(/[\s,;]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
        .map((value) => (value.startsWith('.') ? value : `.${value}`))
      const result = await window.sonic.previewSiteMirror(
        {
          url: url.trim(),
          termsConfirmed,
          maxDepth: depth,
          maxPages,
          delayMs: Math.round(delaySeconds * 1000),
          extensions: normalizedExtensions
        },
        operationId
      )
      setPreview(result)
      setSelected(new Set(result.links))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      if (operationIdRef.current === operationId) operationIdRef.current = null
      setRunning(false)
    }
  }

  const cancelPreview = async (): Promise<void> => {
    const operationId = operationIdRef.current
    if (!operationId) return
    try {
      await window.sonic.cancelSiteMirror(operationId)
    } catch (cause) {
      setError(describeError(cause))
    }
  }

  const useSelected = (): void => {
    const links = (preview?.links ?? []).filter((link) => selected.has(link))
    if (links.length) onUseLinks(links)
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
        className="flex max-h-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-w-[680px]"
      >
        <div className="flex items-start gap-3 border-b-[0.5px] border-border px-5 py-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Globe className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base font-semibold">
              {t('Mirror site — dry run')}
            </DialogTitle>
            <DialogDescription className="mt-1">
              Explore only the entered HTTP(S) origin. Sonic reads robots.txt, never crosses
              origins, never submits forms, and does not download or queue anything during preview.
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close site mirror"
            disabled={running}
            onClick={() => onOpenChange(false)}
          >
            <X />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('Starting page URL')}
            <input
              type="url"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                setPreview(null)
                setError('')
              }}
              placeholder="https://example.com/downloads/"
              disabled={running}
              aria-label="Site mirror starting URL"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('File extensions (comma-separated)')}
            <input
              type="text"
              value={extensions}
              onChange={(event) => {
                setExtensions(event.target.value)
                setPreview(null)
              }}
              disabled={running}
              aria-label="Site mirror file type filters"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('Link depth (0–3)')}
              <select
                aria-label="Site mirror depth"
                value={depth}
                onChange={(event) => {
                  setDepth(Number(event.target.value))
                  setPreview(null)
                }}
                disabled={running}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              >
                {[0, 1, 2, 3].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('Page limit (1–50)')}
              <input
                type="number"
                min={1}
                max={50}
                value={maxPages}
                onChange={(event) => {
                  setMaxPages(Number(event.target.value))
                  setPreview(null)
                }}
                disabled={running}
                aria-label="Site mirror page limit"
                className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('Delay (0.5–5 sec)')}
              <input
                type="number"
                min={0.5}
                max={5}
                step={0.5}
                value={delaySeconds}
                onChange={(event) => {
                  setDelaySeconds(Number(event.target.value))
                  setPreview(null)
                }}
                disabled={running}
                aria-label="Site mirror request delay"
                className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              />
            </label>
          </div>
          <label className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <input
              type="checkbox"
              checked={termsConfirmed}
              onChange={(event) => setTermsConfirmed(event.target.checked)}
              disabled={running}
              aria-label="Confirm website terms and permission"
              className="mt-0.5"
            />
            I have reviewed this website’s terms and have permission to mirror its content. Sonic
            checks robots.txt, but robots.txt does not replace legal or contractual permission.
          </label>
          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={running || !url.trim() || !termsConfirmed}
              onClick={() => void runPreview()}
            >
              {running ? (
                <LoaderCircle className="size-4 animate-spin" data-icon="inline-start" />
              ) : (
                <Globe data-icon="inline-start" />
              )}
              {running ? t('Previewing…') : t('Preview site')}
            </Button>
            {running && (
              <Button type="button" variant="secondary" onClick={() => void cancelPreview()}>
                {t('Cancel preview')}
              </Button>
            )}
            <span className="text-[11px] text-muted-foreground">
              {t('Max 50 pages, 100 candidate files, 1 MB per page.')}
            </span>
          </div>
          {running && progress && (
            <div role="status" aria-live="polite" className="text-xs text-muted-foreground">
              Requested {progress.pagesRequested} of {progress.maxPages} pages · visited{' '}
              {progress.pagesVisited} · candidates {progress.candidateCount} · robots blocked{' '}
              {progress.blockedByRobots} · current {progress.currentPath}
            </div>
          )}

          {preview && (
            <section className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <div role="status" className="text-sm font-medium">
                Dry run: {preview.pagesVisited} pages visited · {preview.links.length} files found ·{' '}
                {preview.blockedByRobots} robots exclusions
              </div>
              {preview.cancelled && (
                <p className="text-xs text-amber-600">
                  Preview cancelled; partial results are shown.
                </p>
              )}
              {preview.truncated && (
                <p className="text-xs text-amber-600">
                  Preview reached a configured safety limit; results may be incomplete.
                </p>
              )}
              {preview.issues.map((issue, index) => (
                <p key={`${index}-${issue}`} className="text-xs text-amber-600">
                  {issue}
                </p>
              ))}
              {preview.links.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No matching files found. Try a different extension filter or starting page.
                </p>
              ) : (
                <div className="max-h-52 overflow-y-auto rounded-md border border-border">
                  {preview.links.map((link) => (
                    <label
                      key={link}
                      className="flex items-start gap-2 border-b border-border/60 px-2 py-2 text-xs last:border-0"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(link)}
                        onChange={(event) =>
                          setSelected((previous) => {
                            const next = new Set(previous)
                            if (event.target.checked) next.add(link)
                            else next.delete(link)
                            return next
                          })
                        }
                        aria-label={`Select ${link}`}
                        className="mt-0.5"
                      />
                      <span className="break-all">{link}</span>
                    </label>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  Selected {selected.size} of {preview.links.length}
                </span>
                <Button type="button" disabled={selected.size === 0} onClick={useSelected}>
                  Review selected in batch importer
                </Button>
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

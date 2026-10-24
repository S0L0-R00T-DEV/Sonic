import { useEffect, useState } from 'react'
import type {
  MediaConversionFormat,
  MediaConversionOptions,
  MediaConversionProgress
} from '@shared/types'
import { FolderOpen, ShieldCheck, X } from 'lucide-react'
import { Button } from './ui/button'

const FORMATS: { value: MediaConversionFormat; label: string }[] = [
  { value: 'mp4', label: 'MP4 video (H.264 + AAC)' },
  { value: 'mkv', label: 'Matroska video (H.264 + AAC)' },
  { value: 'webm', label: 'WebM video (VP9 + Opus)' },
  { value: 'mp3', label: 'MP3 audio' },
  { value: 'wav', label: 'WAV audio' },
  { value: 'ogg', label: 'OGG audio' },
  { value: 'flac', label: 'FLAC audio' }
]

export function MediaConversionDialog({
  open,
  onOpenChange,
  downloadId,
  sourcePath,
  fileName
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  downloadId: string
  sourcePath: string
  fileName: string
}): React.JSX.Element | null {
  const [ffmpegPath, setFfmpegPath] = useState('')
  const [actualHash, setActualHash] = useState('')
  const [expectedHash, setExpectedHash] = useState('')
  const [trusted, setTrusted] = useState(false)
  const [outputDir, setOutputDir] = useState(() => sourcePath.replace(/[\\/][^\\/]*$/, ''))
  const [format, setFormat] = useState<MediaConversionFormat>('mp4')
  const [operationId, setOperationId] = useState('')
  const [progress, setProgress] = useState<MediaConversionProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    return window.sonic.onMediaConversionProgress((event) => {
      if (event.downloadId !== downloadId) return
      setOperationId(event.operationId)
      setProgress(event)
      if (event.status !== 'running') setBusy(false)
    })
  }, [open, downloadId])

  if (!open) return null
  const active =
    !!operationId && (progress?.operationId !== operationId || progress?.status === 'running')
  const chooseExecutable = async (): Promise<void> => {
    setError('')
    try {
      const picked = await window.sonic.chooseFfmpegExecutable()
      if (!picked) return
      setFfmpegPath(picked.path)
      setActualHash(picked.sha256)
      setExpectedHash('')
      setTrusted(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const chooseOutput = async (): Promise<void> => {
    const picked = await window.sonic.chooseDestinationFolder(outputDir)
    if (picked) setOutputDir(picked)
  }
  const start = async (): Promise<void> => {
    if (busy || active) return
    setError('')
    setBusy(true)
    setProgress(null)
    setOperationId('')
    try {
      const options: MediaConversionOptions = {
        ffmpegPath,
        expectedSha256: expectedHash.trim().toLowerCase(),
        outputDir,
        format
      }
      const id = await window.sonic.startMediaConversion(downloadId, options)
      setOperationId(id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }
  const cancel = async (): Promise<void> => {
    if (!operationId || !active) return
    setError('')
    try {
      await window.sonic.cancelMediaConversion(operationId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !active) onOpenChange(false)
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-conversion-title"
        className="w-full max-w-xl rounded-xl border border-border bg-background p-5 shadow-xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="media-conversion-title" className="text-base font-semibold">
              Convert completed media
            </h2>
            <p className="mt-1 break-all text-xs text-muted-foreground">Source: {fileName}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close conversion dialog"
            disabled={active}
            onClick={() => onOpenChange(false)}
          >
            <X aria-hidden />
          </Button>
        </div>
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            <p className="font-medium">
              <ShieldCheck className="mr-1 inline size-4" aria-hidden /> Verify FFmpeg before using
              it
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose an FFmpeg executable from a trusted distributor. The displayed hash is the
              file&apos;s current hash, not proof of authenticity. Paste the independently published
              SHA-256 and confirm you checked it.
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">FFmpeg executable</label>
            <div className="flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm"
                readOnly
                value={ffmpegPath}
                placeholder="Select ffmpeg.exe / ffmpeg"
              />
              <Button type="button" variant="outline" onClick={() => void chooseExecutable()}>
                Browse?
              </Button>
            </div>
            {actualHash && (
              <p className="break-all text-xs text-muted-foreground">
                Actual SHA-256: {actualHash}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="media-trusted-hash">
              Trusted SHA-256 checksum
            </label>
            <input
              id="media-trusted-hash"
              className="w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-xs"
              value={expectedHash}
              onChange={(event) => setExpectedHash(event.target.value)}
              placeholder="64 hexadecimal characters"
              autoComplete="off"
              spellCheck={false}
            />
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={trusted}
                onChange={(event) => setTrusted(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                I compared this checksum with the trusted distributor&apos;s release information.
              </span>
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="media-output-format">
                Output format
              </label>
              <select
                id="media-output-format"
                className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
                value={format}
                onChange={(event) => setFormat(event.target.value as MediaConversionFormat)}
              >
                {FORMATS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Output folder</label>
              <div className="flex gap-2">
                <input
                  className="min-w-0 flex-1 rounded-md border border-border bg-card px-3 py-2 text-xs"
                  readOnly
                  value={outputDir}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Choose output folder"
                  onClick={() => void chooseOutput()}
                >
                  <FolderOpen aria-hidden />
                </Button>
              </div>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {progress?.status === 'running' && (
            <p role="status" className="text-sm">
              Converting? Keep Sonic open until it finishes.
            </p>
          )}
          {progress?.status === 'completed' && (
            <div role="status" className="rounded-md border border-border p-3 text-sm">
              <p className="font-medium">Conversion complete</p>
              <p className="mt-1 break-all text-xs text-muted-foreground">{progress.outputPath}</p>
            </div>
          )}
          {progress?.status === 'cancelled' && (
            <p role="status" className="text-sm">
              Conversion cancelled. Temporary output was removed.
            </p>
          )}
          {progress?.status === 'error' && (
            <p role="alert" className="text-sm text-destructive">
              {progress.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={active}
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            {active ? (
              <Button type="button" variant="destructive" onClick={() => void cancel()}>
                Cancel conversion
              </Button>
            ) : (
              <Button
                type="button"
                disabled={
                  busy ||
                  !ffmpegPath ||
                  !/^[a-f0-9]{64}$/i.test(expectedHash.trim()) ||
                  !trusted ||
                  !outputDir
                }
                onClick={() => void start()}
              >
                {busy ? 'Checking?' : 'Convert file'}
              </Button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

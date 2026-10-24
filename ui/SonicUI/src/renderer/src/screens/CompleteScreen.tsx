import type { DownloadState, FinishedDownload } from '@shared/types'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { HeroBand } from '../components/HeroBand'
import { DetailHeader } from '../components/DetailHeader'
import { ThroughputChart } from '../components/ThroughputChart'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import {
  describeFileCount,
  dirnameOf,
  formatBytes,
  formatDuration,
  toDisplayPath,
  wantedBytes
} from '../utils/format'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { useLocale } from '../i18n'

const sectionHeaderClass =
  'font-mono text-[10px] leading-none tracking-[0.16em] text-muted-foreground uppercase'

export function CompleteScreen({
  download
}: {
  /** Just finished, or as history keeps it. */
  download: DownloadState | FinishedDownload
}): React.JSX.Element {
  const { t } = useLocale()
  const formatSpeed = useFormatSpeed()
  const homeDir = useAppStore((store) => store.homeDir)
  const networkVisual = useNetworkVisuals()
  const missing = 'missing' in download && download.missing === true
  const [hashCopied, setHashCopied] = useState(false)
  const sha256 = 'sha256' in download ? download.sha256 : undefined
  const sha256Scope = 'sha256Scope' in download ? download.sha256Scope : undefined
  const copyHash = async (): Promise<void> => {
    if (!sha256) return
    try {
      await navigator.clipboard.writeText(sha256)
      setHashCopied(true)
      setTimeout(() => setHashCopied(false), 2000)
    } catch {
      // Clipboard permissions vary by platform; the hash remains visible for manual copying.
    }
  }

  const finalSize = wantedBytes(download) || download.bytesDownloaded
  const totalPausedMs = download.totalPausedMs ?? 0
  // completedAt is always set by the time a download reaches 'completed' — the
  // fallback here is just to keep this pure (no Date.now() during render).
  const elapsedSeconds = Math.max(
    0,
    ((download.completedAt ?? download.startedAt) - download.startedAt - totalPausedMs) / 1000
  )
  const avgSpeed = elapsedSeconds > 0 ? finalSize / elapsedSeconds : 0
  const [avgSpeedValue, avgSpeedUnit] = formatSpeed(avgSpeed).split(' ')

  // The networks that carried part of the file.
  const groups = download.networks.filter((network) => network.bytesDownloaded > 0)
  const visuals = groups.map((group) => networkVisual(group.id, group.kind, group.label))
  const totalWeight = groups.reduce((sum, group) => sum + group.bytesDownloaded, 0) || 1
  const totalRetries = download.networks.reduce((sum, network) => sum + network.retries, 0)
  const isTorrent = download.kind === 'torrent'
  // "Chunks" in the block grid means byte ranges, not parallel connections. A torrent's are its
  // pieces, those its chosen files needed.
  const totalChunkCount =
    'unitsWritten' in download
      ? download.unitsWritten
      : download.kind === 'torrent'
        ? download.pieces.filter((piece) => piece.status !== 'skipped').length
        : download.totalBlocks
  const files = isTorrent && download.files.total > 1 ? download.files : null

  return (
    <div className="flex h-full flex-col bg-background">
      <DetailHeader download={download} />
      <div role="status" className="sr-only">
        {t('Download complete')}: {download.fileName}
      </div>
      <HeroBand>
        <div className="flex items-center gap-[18px]">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full border border-[var(--color-wifi-border)] bg-[var(--color-wifi-bg)]">
            <svg viewBox="0 0 24 24" className="size-[21px]" aria-hidden="true">
              <path
                d="M5,13 L10,18 L19,7"
                fill="none"
                stroke="var(--color-wifi)"
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-sans text-[16px] leading-[1.2] font-bold">
              {download.fileName}
            </div>
            <div className="mt-[5px] truncate font-mono text-[11.5px] leading-[1.3] text-muted-foreground">
              {files && `${describeFileCount(files.chosen, files.total)} · `}
              {formatBytes(finalSize)} ·{' '}
              {missing
                ? t('moved or deleted since')
                : toDisplayPath(dirnameOf(download.destinationPath), homeDir)}
            </div>
          </div>
          <div className="flex flex-col items-end gap-[5px]">
            <div className="font-mono text-[9px] leading-none font-medium tracking-[0.16em] text-muted-foreground">
              {t('AVERAGE')}
            </div>
            <div className="flex items-baseline gap-1.5">
              <div className="font-mono text-[26px] leading-[0.9] font-semibold tracking-[-0.02em] tabular-nums text-foreground">
                {avgSpeedValue}
              </div>
              <div className="font-mono text-[11px] leading-none font-medium text-muted-foreground">
                {avgSpeedUnit}
              </div>
            </div>
          </div>
        </div>
      </HeroBand>

      <div className="mx-5 my-[18px] grid grid-cols-5 overflow-hidden rounded-[10px] border-[0.5px] border-border bg-card">
        {[
          { label: t('Size'), value: formatBytes(finalSize) },
          { label: t('Time'), value: formatDuration(elapsedSeconds) },
          {
            label: t('Peak'),
            value:
              download.peakSpeedBytesPerSec === undefined
                ? '—'
                : formatSpeed(download.peakSpeedBytesPerSec)
          },
          { label: t('Networks'), value: String(groups.length) },
          // The most it ran at once: streams that didn't make it faster were closed along the way.
          {
            label: t(isTorrent ? 'Peers' : 'Streams'),
            value: String(isTorrent ? download.peakPeers : download.peakStreams)
          }
        ].map((stat, index) => (
          <div
            key={stat.label}
            className={`flex flex-col gap-[5px] p-[11px_14px] ${
              index > 0 ? 'border-l-[0.5px] border-border' : ''
            }`}
          >
            <div className="font-mono text-[9px] leading-none font-medium tracking-[0.14em] text-muted-foreground uppercase">
              {stat.label}
            </div>
            <div className="font-mono text-[14px] leading-none font-medium tabular-nums">
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      <div className="mx-5 mb-4 flex flex-col gap-2">
        <h2 className={sectionHeaderClass}>{t('Speed over the download')}</h2>
        <ThroughputChart
          order={groups.map((g, i) => ({
            interfaceId: g.id,
            solid: visuals[i].solid,
            name: visuals[i].name
          }))}
          historyByInterface={download.speedHistory ?? {}}
          endsAt="end"
        />
      </div>

      <div className="mx-5 mb-5 flex flex-1 flex-col gap-[9px]">
        <h2 className={sectionHeaderClass}>{t('Contribution by network')}</h2>
        <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted">
          {groups.map((group, index) => (
            <div
              key={group.id}
              style={{ flex: group.bytesDownloaded || 0.0001, background: visuals[index].solid }}
            />
          ))}
        </div>
        <div className="flex flex-col gap-[9px]">
          {groups.map((group, index) => (
            <div key={group.id} className="flex items-center gap-[9px]">
              <div
                className="size-[7px] shrink-0 rounded-full"
                style={{ background: visuals[index].solid }}
              />
              <div className="font-sans text-[12px] leading-none font-medium">
                {visuals[index].name}
              </div>
              <div className="flex-1" />
              <div className="font-mono text-[11.5px] leading-none text-[var(--text-secondary)]">
                {formatBytes(group.bytesDownloaded)} ·{' '}
                {Math.round((group.bytesDownloaded / totalWeight) * 100)}%
              </div>
            </div>
          ))}
        </div>
        <div className="mt-auto pt-3 font-mono text-[11px] leading-[1.4] text-muted-foreground">
          {[
            `${t('written in')} ${totalChunkCount} ${t(isTorrent ? 'pieces' : 'chunks')}`,
            // What its peers got from it while it downloaded.
            isTorrent && `${t('uploaded')} ${formatBytes(download.bytesUploaded ?? 0)}`,
            `${totalRetries} ${t(totalRetries === 1 ? 'retry' : 'retries')}`
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
        {sha256 && (
          <div className="flex min-w-0 items-center gap-2 border-t-[0.5px] border-border pt-3">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
                {t('Local SHA-256')} · {t(sha256Scope === 'tree' ? 'selected-file tree' : 'file')}
              </div>
              <div className="mt-1 break-all font-mono text-[10.5px] leading-relaxed text-foreground">
                {sha256}
              </div>
              <div className="mt-1 text-[10.5px] text-muted-foreground">
                {t('Computed from the saved output; not a publisher-provided checksum.')}
              </div>
            </div>
            <button
              type="button"
              aria-label={t('Copy SHA-256')}
              onClick={() => void copyHash()}
              className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              {hashCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

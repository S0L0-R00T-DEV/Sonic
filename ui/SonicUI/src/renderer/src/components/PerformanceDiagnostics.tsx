import { useState } from 'react'
import { Download, FileDown, Gauge, RotateCcw } from 'lucide-react'
import type { NetworkInterfaceInfo } from '@shared/types'
import { Button } from './ui/button'
import { describeError } from '../utils/format'

type Snapshot = { at: number; usage: Record<string, number>; interfaces: NetworkInterfaceInfo[] }
type BenchmarkRun = {
  id: string
  label: 'single-link' | 'multi-interface'
  startedAt: string
  finishedAt: string
  elapsedSeconds: number
  totalBytes: number
  bytesPerSecond: number
  interfaces: { id: string; name: string; bytes: number }[]
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(2)} ${units[unit]}`
}

/** Manual, repeatable before/after capture of Sonic's per-interface receive ledger. */
export function PerformanceDiagnostics(): React.JSX.Element {
  const [label, setLabel] = useState<'single-link' | 'multi-interface'>('single-link')
  const [baseline, setBaseline] = useState<Snapshot | null>(null)
  const [runs, setRuns] = useState<BenchmarkRun[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const capture = async (): Promise<Snapshot> => {
    const [usage, interfaces] = await Promise.all([
      window.sonic.networkUsage(),
      window.sonic.listInterfaces()
    ])
    return { at: Date.now(), usage, interfaces }
  }

  const start = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      setBaseline(await capture())
      setMessage(
        `Baseline captured for ${label}. Run your test download now; then finish the capture.`
      )
    } catch (error) {
      setMessage(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  const finish = async (): Promise<void> => {
    if (!baseline) return
    setBusy(true)
    setMessage(null)
    try {
      const end = await capture()
      const elapsedSeconds = Math.max(0.001, (end.at - baseline.at) / 1000)
      const ids = new Set([...Object.keys(baseline.usage), ...Object.keys(end.usage)])
      const interfaces = [...ids]
        .map((id) => {
          const bytes = Math.max(0, (end.usage[id] ?? 0) - (baseline.usage[id] ?? 0))
          const info =
            end.interfaces.find((item) => item.id === id) ??
            baseline.interfaces.find((item) => item.id === id)
          return { id, name: info?.displayName ?? id, bytes }
        })
        .filter((item) => item.bytes > 0)
        .sort((a, b) => b.bytes - a.bytes)
      const totalBytes = interfaces.reduce((sum, item) => sum + item.bytes, 0)
      const run: BenchmarkRun = {
        id: `${end.at}-${runs.length + 1}`,
        label,
        startedAt: new Date(baseline.at).toISOString(),
        finishedAt: new Date(end.at).toISOString(),
        elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
        totalBytes,
        bytesPerSecond: totalBytes / elapsedSeconds,
        interfaces
      }
      setRuns((previous) => [...previous, run])
      setBaseline(null)
      setMessage(
        `Capture finished: ${formatBytes(totalBytes)} received across ${elapsedSeconds.toFixed(1)} seconds.`
      )
    } catch (error) {
      setMessage(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  const exportReport = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const report = {
        schema: 'sonic-performance-benchmark/v1',
        generatedAt: new Date().toISOString(),
        methodology:
          'Manual capture of Sonic per-interface received-byte counters before and after a user-run download. Throughput is aggregate Sonic-attributed receive bytes divided by wall-clock capture duration.',
        caveats: [
          'This is a measurement capture, not a controlled internet speed test. Start and finish immediately around the test download.',
          'The capture includes all Sonic traffic during the window, not only one task; pause unrelated Sonic transfers for cleaner results.',
          'Single-link and multi-interface runs should use the same URL/file, destination conditions, and comparable server conditions; repeat each mode several times.',
          'Server throttling, cache state, routing, Wi-Fi signal, VPNs, and other traffic affect results. Interface contribution reports bytes credited to each Sonic interface, not independent ISP capacity.',
          'Interface IDs and labels are included for reproducibility; source URLs, file names, local paths, and credentials are not collected by this report.'
        ],
        runs
      }
      const saved = await window.sonic.saveDiagnosticReport(JSON.stringify(report))
      setMessage(saved ? 'Benchmark report exported.' : 'Export cancelled.')
    } catch (error) {
      setMessage(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="performance-diagnostics-title"
      className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3"
    >
      <h3
        id="performance-diagnostics-title"
        className="font-sans text-[14px] leading-none font-semibold flex items-center gap-2"
      >
        <Gauge className="size-4" /> Performance diagnostics & benchmark
      </h3>
      <p className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
        Capture Sonic&apos;s per-interface receive counters around a test download, compare repeated
        single-link and multi-interface runs, and export a reproducible JSON report.
      </p>
      <label htmlFor="benchmark-mode" className="text-sm">
        Run mode
      </label>
      <select
        id="benchmark-mode"
        value={label}
        disabled={busy || Boolean(baseline)}
        onChange={(event) => setLabel(event.currentTarget.value as typeof label)}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
      >
        <option value="single-link">Single-link baseline</option>
        <option value="multi-interface">Multi-interface</option>
      </select>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || Boolean(baseline)}
          onClick={() => void start()}
        >
          <Gauge /> Start capture
        </Button>
        <Button type="button" size="sm" disabled={busy || !baseline} onClick={() => void finish()}>
          <Download /> Finish capture
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || runs.length === 0}
          onClick={() => void exportReport()}
        >
          <FileDown /> Export results
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || (!baseline && runs.length === 0)}
          onClick={() => {
            setBaseline(null)
            setRuns([])
            setMessage('Benchmark session cleared.')
          }}
        >
          <RotateCcw /> Reset session
        </Button>
      </div>
      {baseline && (
        <p className="text-xs text-muted-foreground" role="status">
          Capture is running. Start/continue the chosen test download, then select Finish capture.
        </p>
      )}
      {runs.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/60">
              <tr>
                <th className="p-2">Mode</th>
                <th className="p-2">Received</th>
                <th className="p-2">Average</th>
                <th className="p-2">Duration</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t border-border">
                  <td className="p-2">
                    {run.label === 'single-link' ? 'Single-link' : 'Multi-interface'}
                  </td>
                  <td className="p-2">{formatBytes(run.totalBytes)}</td>
                  <td className="p-2">{formatBytes(run.bytesPerSecond)}/s</td>
                  <td className="p-2">{run.elapsedSeconds.toFixed(1)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="space-y-1 p-2">
            {runs.map((run) => (
              <p key={`${run.id}-interfaces`} className="text-muted-foreground">
                {run.label}:{' '}
                {run.interfaces.length
                  ? run.interfaces
                      .map((item) => `${item.name}: ${formatBytes(item.bytes)}`)
                      .join(' · ')
                  : 'No interface receive bytes recorded'}
              </p>
            ))}
          </div>
        </div>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        For comparable results, use the same file/source and repeat each mode several times. Pause
        unrelated Sonic transfers. Server limits, cache state, VPN/routing, Wi-Fi signal and other
        traffic can skew results. This is not an ISP speed test.
      </p>
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
    </section>
  )
}

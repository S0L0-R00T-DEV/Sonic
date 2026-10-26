import { useEffect, useState } from 'react'
import type { PluginSummary } from '@shared/pluginApi'
import { describeError } from '../utils/format'
import { Button } from './ui/button'
import { Download, Trash2 } from 'lucide-react'
import { ContextHelp } from './ContextHelp'

type PluginList = { trustedKeyIds: string[]; plugins: PluginSummary[] }

export function PluginManagement(): React.JSX.Element {
  const [data, setData] = useState<PluginList>({ trustedKeyIds: [], plugins: [] })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = async (): Promise<void> => setData(await window.sonic.listPlugins())
  useEffect(() => {
    let disposed = false
    void window.sonic
      .listPlugins()
      .then((result) => {
        if (!disposed) setData(result)
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(describeError(cause))
      })
    return () => {
      disposed = true
    }
  }, [])
  const install = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await window.sonic.installPlugin()
      if (result) {
        await refresh()
        setMessage(
          result.name +
            ' was verified and installed. It remains disabled until its requested permissions are granted.'
        )
      }
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }
  const uninstall = async (plugin: PluginSummary): Promise<void> => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await window.sonic.uninstallPlugin(plugin.id)
      await refresh()
      setMessage(plugin.name + ' was removed.')
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="flex flex-col gap-3 border-t-[0.5px] border-border py-3">
      <div>
        <div className="flex items-center gap-1">
          <h3 className="font-sans text-[14px] font-semibold">Plugins</h3>
          <ContextHelp title="How Sonic plugins work" label="Plugin help">
            <p>
              Plugins add supported download-source rules to Sonic, such as recognizing a site’s
              download URL or suggesting a filename.
            </p>
            <p>
              Plugins are signed <code>.sdm</code> packages. Sonic checks the package manifest,
              compatibility, and signature against a trusted public key before installing. A plugin
              stays disabled until its requested permissions are explicitly granted.
            </p>
            <p>
              For safety, plugins use declarative rules only; they cannot run arbitrary JavaScript.
              Create a plugin for one well-defined supported task, test it with representative URLs,
              and distribute the signed package.
            </p>
          </ContextHelp>
        </div>
        <p className="mt-1 text-[12.5px] leading-snug text-[var(--text-secondary)]">
          Install a signed Sonic plugin package (.sdm). Sonic checks its format, manifest,
          compatibility, and signature before installing. Plugins contain declarative rules only and
          cannot run arbitrary JavaScript.
        </p>
      </div>
      <Button type="button" size="sm" disabled={busy} onClick={() => void install()}>
        <Download className="mr-1 size-4" />
        {busy ? 'Installing…' : 'Install plugin'}
      </Button>
      <div className="rounded-lg border border-border p-3">
        <h4 className="text-sm font-medium">Installed plugins</h4>
        {data.plugins.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No plugins installed.</p>
        ) : (
          data.plugins.map((plugin) => (
            <div
              key={plugin.id}
              className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {plugin.name}{' '}
                  <span className="text-xs text-muted-foreground">v{plugin.version}</span>
                </p>
                <p className="break-all font-mono text-[10px] text-muted-foreground">{plugin.id}</p>
                <p
                  className={
                    plugin.enabled ? 'text-xs text-emerald-600' : 'text-xs text-muted-foreground'
                  }
                >
                  {plugin.enabled ? 'Enabled' : 'Installed · disabled'}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => void uninstall(plugin)}
              >
                <Trash2 className="mr-1 size-4" />
                Delete
              </Button>
            </div>
          ))
        )}
      </div>
      {(message || error) && (
        <p
          role={error ? 'alert' : 'status'}
          className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
        >
          {error ?? message}
        </p>
      )}
    </section>
  )
}

import { useEffect, useState } from 'react'
import type { PluginReview, PluginSummary, SonicPluginPermission } from '@shared/pluginApi'
import { describeError } from '../utils/format'
import { Button } from './ui/button'

type PluginList = { trustedKeyIds: string[]; plugins: PluginSummary[] }

export function PluginManagement(): React.JSX.Element {
  const [data, setData] = useState<PluginList>({ trustedKeyIds: [], plugins: [] })
  const [keyId, setKeyId] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [manifest, setManifest] = useState('')
  const [review, setReview] = useState<PluginReview | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setData(await window.sonic.listPlugins())
  }
  useEffect(() => {
    let disposed = false
    void window.sonic
      .listPlugins()
      .then((plugins) => {
        if (!disposed) setData(plugins)
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(describeError(cause))
      })
    return () => {
      disposed = true
    }
  }, [])

  const run = async (action: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await action()
      await refresh()
      setMessage(success)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const trust = (): void => {
    void run(async () => {
      await window.sonic.trustPluginKey(keyId.trim(), publicKey)
      setKeyId('')
      setPublicKey('')
    }, 'Signer key added to the local trust registry.')
  }
  const reviewManifest = (): void => {
    setBusy(true)
    setError(null)
    setMessage(null)
    void window.sonic
      .reviewPluginManifest(manifest)
      .then(setReview)
      .catch((cause: unknown) => setError(describeError(cause)))
      .finally(() => setBusy(false))
  }
  const install = (): void => {
    void run(async () => {
      await window.sonic.installPlugin(manifest)
      setReview(null)
      setManifest('')
    }, 'Signature verified. Plugin installed disabled; permissions must be granted explicitly.')
  }

  return (
    <section className="flex flex-col gap-3 border-t-[0.5px] border-border py-3">
      <div>
        <h3 className="font-sans text-[14px] font-semibold">Plugin API</h3>
        <p className="mt-1 text-[12.5px] leading-snug text-[var(--text-secondary)]">
          Plugins are signed declarative rules only; they cannot run arbitrary JavaScript. Sonic has
          no publisher keys bundled yet, so only trust a signer after independently verifying its
          public key. New installs start disabled.
        </p>
      </div>

      <div className="rounded-lg border border-border p-3">
        <h4 className="text-sm font-medium">Trust a signer key</h4>
        <label className="mt-2 block text-xs text-muted-foreground" htmlFor="sonic-plugin-key-id">
          Key ID
        </label>
        <input
          id="sonic-plugin-key-id"
          value={keyId}
          onChange={(event) => setKeyId(event.currentTarget.value)}
          placeholder="publisher-key-2026"
          maxLength={64}
          className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        />
        <label
          className="mt-2 block text-xs text-muted-foreground"
          htmlFor="sonic-plugin-public-key"
        >
          Ed25519 public key (PEM)
        </label>
        <textarea
          id="sonic-plugin-public-key"
          value={publicKey}
          onChange={(event) => setPublicKey(event.currentTarget.value)}
          rows={3}
          maxLength={16384}
          spellCheck={false}
          className="mt-1 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
          placeholder="-----BEGIN PUBLIC KEY-----"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || !keyId.trim() || !publicKey.trim()}
          onClick={trust}
          className="mt-2"
        >
          Trust signer
        </Button>
        {data.trustedKeyIds.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {data.trustedKeyIds.map((id) => (
              <div key={id} className="flex items-center justify-between gap-2 text-xs">
                <code>{id}</code>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => window.sonic.revokePluginKey(id),
                      'Signer revoked; its plugins were disabled and grants cleared.'
                    )
                  }
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border p-3">
        <h4 className="text-sm font-medium">Review signed plugin manifest</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Paste the plugin manifest JSON. Review verifies the signature and app-version policy
          before the install button is enabled.
        </p>
        <textarea
          aria-label="Plugin manifest JSON"
          value={manifest}
          onChange={(event) => {
            setManifest(event.currentTarget.value)
            setReview(null)
          }}
          rows={5}
          maxLength={1048576}
          spellCheck={false}
          className="mt-2 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
          placeholder="{ ... signed manifest ... }"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || !manifest.trim()}
            onClick={reviewManifest}
          >
            Review signature
          </Button>
          <Button type="button" size="sm" disabled={busy || !review?.valid} onClick={install}>
            Install disabled
          </Button>
        </div>
        {review && (
          <div
            role={review.valid ? 'status' : 'alert'}
            className="mt-2 rounded-md bg-muted p-2 text-xs"
          >
            {review.valid && review.summary ? (
              <>
                <p className="font-medium">
                  {review.summary.name} {review.summary.version}
                </p>
                <p>
                  Signer: {review.summary.keyId} · ID: {review.summary.id}
                </p>
                <p className="mt-1">
                  Requested permissions: {review.summary.permissions.join(', ') || 'none'}
                </p>
              </>
            ) : (
              <p>{review.errors.join(' ') || 'Manifest signature was not accepted.'}</p>
            )}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border p-3">
        <h4 className="text-sm font-medium">Installed plugins</h4>
        {data.plugins.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No plugins installed.</p>
        ) : (
          data.plugins.map((plugin) => (
            <div key={plugin.id} className="mt-2 border-t border-border pt-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {plugin.name} {plugin.version}
                  </p>
                  <p className="break-all font-mono text-[10px] text-muted-foreground">
                    {plugin.id} · signer {plugin.keyId}
                  </p>
                  <p className="mt-1 text-xs">
                    Requested: {plugin.permissions.join(', ') || 'none'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Granted: {plugin.grantedPermissions.join(', ') || 'none'}
                  </p>
                </div>
                <span className="rounded border border-border px-2 py-0.5 text-xs">
                  {plugin.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={
                    busy ||
                    plugin.permissions.length === 0 ||
                    plugin.permissions.every((permission: SonicPluginPermission) =>
                      plugin.grantedPermissions.includes(permission)
                    )
                  }
                  onClick={() =>
                    void run(
                      () => window.sonic.setPluginPermissions(plugin.id, plugin.permissions),
                      'All requested permissions granted.'
                    )
                  }
                >
                  Grant requested
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={
                    busy ||
                    (plugin.enabled
                      ? false
                      : !plugin.permissions.every((permission) =>
                          plugin.grantedPermissions.includes(permission)
                        ))
                  }
                  onClick={() =>
                    void run(
                      () => window.sonic.setPluginEnabled(plugin.id, !plugin.enabled),
                      plugin.enabled ? 'Plugin disabled.' : 'Plugin enabled.'
                    )
                  }
                >
                  {plugin.enabled ? 'Disable' : 'Enable'}
                </Button>
                {plugin.hasRollback && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => window.sonic.rollbackPlugin(plugin.id),
                        'Previous version restored disabled.'
                      )
                    }
                  >
                    Rollback
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    void run(() => window.sonic.uninstallPlugin(plugin.id), 'Plugin removed.')
                  }
                >
                  Uninstall
                </Button>
              </div>
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

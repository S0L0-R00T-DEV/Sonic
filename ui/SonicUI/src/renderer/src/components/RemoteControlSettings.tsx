import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Alert, AlertDescription } from './ui/alert'
import type { RemoteControlScope, RemoteControlState } from '@shared/types'

const SCOPES: { id: RemoteControlScope; label: string; description: string }[] = [
  {
    id: 'status:read',
    label: 'View downloads',
    description: 'Read names, status, progress and speed.'
  },
  { id: 'task:add', label: 'Add downloads', description: 'Add HTTP(S) links and magnet links.' },
  { id: 'task:control', label: 'Control downloads', description: 'Pause, resume and cancel tasks.' }
]

export function RemoteControlSettings(): React.JSX.Element {
  const [state, setState] = useState<RemoteControlState | null>(null)
  const [interfaceId, setInterfaceId] = useState('')
  const [scopes, setScopes] = useState<RemoteControlScope[]>([
    'status:read',
    'task:add',
    'task:control'
  ])
  const [pairCode, setPairCode] = useState<string | null>(null)
  const [pairExpiresAt, setPairExpiresAt] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    const next = await window.sonic.remoteControlState()
    setState(next)
    if (!interfaceId && next.wifiInterfaces.length) setInterfaceId(next.wifiInterfaces[0].id)
    if (next.pairingExpiresAt && pairCode) setPairExpiresAt(next.pairingExpiresAt)
  }
  useEffect(() => {
    let alive = true
    void window.sonic
      .remoteControlState()
      .then((next) => {
        if (!alive) return
        setState(next)
        setInterfaceId(next.interfaceId ?? next.wifiInterfaces[0]?.id ?? '')
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive = false
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
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const enable = (): void => {
    void run(async () => {
      const next = await window.sonic.enableRemoteControl(interfaceId)
      setState(next)
      setPairCode(null)
      setPairExpiresAt(null)
    }, 'Remote control is enabled on the selected Wi-Fi interface only.')
  }
  const disable = (): void => {
    void run(async () => {
      await window.sonic.disableRemoteControl()
      setPairCode(null)
      setPairExpiresAt(null)
    }, 'Remote control disabled; the HTTPS listener is closed.')
  }
  const createPair = (): void => {
    void run(async () => {
      const result = await window.sonic.createRemotePairingCode(scopes)
      setPairCode(result.code)
      setPairExpiresAt(result.expiresAt)
    }, 'One-time pairing code generated.')
  }

  return (
    <section className="flex flex-col gap-3 border-t-[0.5px] border-border py-3">
      <div>
        <h3 className="font-sans text-[14px] font-semibold">Local Wi-Fi remote control</h3>
        <p className="mt-1 text-[12.5px] leading-snug text-[var(--text-secondary)]">
          Control Sonic from a phone on the same Wi-Fi subnet. The server binds only to the chosen
          Wi-Fi IPv4 address and rejects clients outside that subnet. No cloud relay, internet
          listener, Ethernet/USB interface, port forwarding or remote shell.
        </p>
      </div>
      {!state?.enabled && (
        <div className="flex flex-col gap-2">
          <label htmlFor="remote-wifi" className="text-sm font-medium">
            Wi-Fi interface
          </label>
          <select
            id="remote-wifi"
            value={interfaceId}
            onChange={(event) => setInterfaceId(event.currentTarget.value)}
            disabled={busy || !state?.wifiInterfaces.length}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {(state?.wifiInterfaces ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName} — {item.addresses.join(', ')}
              </option>
            ))}
          </select>
          {!state?.wifiInterfaces.length && (
            <p className="text-xs text-muted-foreground">
              No active Wi-Fi adapter with a private IPv4 address was detected. Ethernet, USB,
              bridge and public interfaces are intentionally excluded.
            </p>
          )}
          <Button type="button" disabled={busy || !interfaceId} onClick={enable}>
            Enable on this Wi-Fi only
          </Button>
        </div>
      )}
      {state?.enabled && (
        <div className="rounded-lg border border-border p-3">
          <p className="text-sm font-medium">HTTPS listener active</p>
          <p className="mt-1 break-all font-mono text-xs">{state.url}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Open this exact address on the phone while it is connected to the same Wi-Fi.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(
                  () => window.sonic.exportRemoteCaCertificate(),
                  'Certificate exported. Transfer it to the phone using USB, then install it as a user CA certificate before opening the companion URL.'
                )
              }
            >
              Export phone-trust certificate
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={disable}>
              Disable remote control
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            CA SHA-256 fingerprint (keep this for verification):
          </p>
          <p className="break-all font-mono text-[11px]">{state.caFingerprint ?? 'Unavailable'}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            On Android, transfer the .crt file by USB, then use Settings → Security → Encryption &
            credentials → Install a certificate → CA certificate (menu names vary). Install only the
            certificate exported by Sonic. Do not install certificates from other sources. Then open
            the HTTPS URL above.
          </p>
        </div>
      )}
      <div className="rounded-lg border border-border p-3">
        <p className="text-sm font-medium">Pair a phone</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose the minimum permissions for this device. The pairing code expires in 3 minutes, is
          single-use and is not saved to disk.
        </p>
        <div className="mt-2 flex flex-col gap-2">
          {SCOPES.map((scope) => (
            <label key={scope.id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={scopes.includes(scope.id)}
                disabled={busy || !state?.enabled}
                onChange={(event) => {
                  const checked = event.currentTarget.checked
                  setScopes((current) =>
                    checked ? [...current, scope.id] : current.filter((value) => value !== scope.id)
                  )
                }}
              />
              <span>
                <span className="font-medium">{scope.label}</span>
                <span className="block text-xs text-muted-foreground">{scope.description}</span>
              </span>
            </label>
          ))}
        </div>
        <Button
          type="button"
          className="mt-3"
          variant="secondary"
          disabled={busy || !state?.enabled || scopes.length === 0}
          onClick={createPair}
        >
          Generate one-time pairing code
        </Button>
        {pairCode && pairExpiresAt && state?.enabled && (
          <div className="mt-3 rounded-md bg-muted p-3 text-center">
            <p className="text-xs text-muted-foreground">
              Enter this code on the phone companion page
            </p>
            <p className="my-1 font-mono text-3xl font-bold tracking-[0.25em]">{pairCode}</p>
            <p className="text-xs text-muted-foreground">
              Expires {new Date(pairExpiresAt).toLocaleTimeString()}
            </p>
          </div>
        )}
      </div>
      <div className="rounded-lg border border-border p-3">
        <p className="text-sm font-medium">Paired devices</p>
        {(state?.devices ?? []).filter((device) => !device.revoked).length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No active paired phones.</p>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {(state?.devices ?? [])
              .filter((device) => !device.revoked)
              .map((device) => (
                <div
                  key={device.id}
                  className="flex items-start justify-between gap-3 border-t border-border pt-2"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">{device.label}</p>
                    <p className="text-xs text-muted-foreground">{device.scopes.join(' · ')}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Paired {new Date(device.createdAt).toLocaleDateString()} · expires{' '}
                      {new Date(device.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => window.sonic.revokeRemoteDevice(device.id),
                        'Device revoked immediately.'
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
        <p className="text-sm font-medium">Recent remote activity</p>
        {(state?.auditEvents ?? []).length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            No remote-control requests recorded in this session.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {(state?.auditEvents ?? []).map((event, index) => (
              <li
                key={`${event.at}-${event.event}-${index}`}
                className="text-xs text-muted-foreground"
              >
                {new Date(event.at).toLocaleTimeString()} · {event.event.replaceAll('-', ' ')}
                {event.deviceId ? ` · device ${event.deviceId.slice(0, 8)}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
    </section>
  )
}

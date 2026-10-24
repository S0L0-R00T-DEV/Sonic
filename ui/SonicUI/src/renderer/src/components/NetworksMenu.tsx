import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Button } from './ui/button'
import { NetworkEditPopover } from './NetworkEditPopover'
import { useLocale } from '../i18n'

/** Shows active-address network interfaces and their aggregate download speed. */
export function NetworksMenu(): React.JSX.Element {
  const { t } = useLocale()
  const formatSpeed = useFormatSpeed()
  const allInterfaces = useAppStore((store) => store.interfaces)
  const interfaces = allInterfaces.filter((iface) => iface.addresses.length > 0)
  const downloads = useAppStore((store) => store.downloads)
  const networkVisual = useNetworkVisuals()
  const [open, setOpen] = useState(false)

  const speeds = new Map<string, number>()
  for (const download of Object.values(downloads)) {
    if (download.status !== 'downloading') continue
    for (const network of download.networks) {
      speeds.set(network.id, (speeds.get(network.id) ?? 0) + network.speedBytesPerSec)
    }
  }
  const total = [...speeds.values()].reduce((sum, speed) => sum + speed, 0)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" variant="secondary" className="gap-2.5 px-3 text-[13px]" />}
      >
        <span className="flex gap-1" aria-hidden>
          {interfaces.slice(0, 4).map((iface) => (
            <span
              key={iface.id}
              className="size-2 rounded-full"
              style={{ background: networkVisual(iface.id, iface.kind, iface.displayName).solid }}
            />
          ))}
        </span>
        {interfaces.length === 0 ? (
          <span className="text-[var(--color-danger)]">{t('noActiveNetwork')}</span>
        ) : (
          <>
            {interfaces.length} {interfaces.length === 1 ? 'network' : 'networks'}
            {total > 0 && (
              <span className="font-mono text-[11.5px] text-muted-foreground">
                {formatSpeed(total)}
              </span>
            )}
          </>
        )}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] gap-0 p-0">
        <div className="border-b-[0.5px] border-border px-4 py-3 text-[14px] font-semibold">
          {t('activeNetworks')}
        </div>
        {interfaces.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted-foreground">
            No network interfaces with an assigned address.
          </p>
        ) : (
          interfaces.map((iface) => {
            const visual = networkVisual(iface.id, iface.kind, iface.displayName)
            const speed = speeds.get(iface.id) ?? 0
            return (
              <div
                key={iface.id}
                className="flex items-center gap-3 border-b-[0.5px] border-border px-4 py-3"
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: visual.solid }}
                />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {visual.name}
                </span>
                <NetworkEditPopover
                  interfaceId={iface.id}
                  interfaceKind={iface.kind}
                  osName={iface.displayName}
                />
                <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
                  {speed > 0 ? formatSpeed(speed) : 'Idle'}
                </span>
              </div>
            )
          })
        )}
      </PopoverContent>
    </Popover>
  )
}

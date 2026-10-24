import type { SpeedUnit } from '@shared/types'
import { useEffect, useState } from 'react'
import { useLocale } from '../i18n'
import { useAppStore } from '../store/useAppStore'
import { formatBytes } from '../utils/format'
import { useFormatSpeedLimit } from '../hooks/useFormatSpeed'
import { useDownloadSchedule } from '../hooks/useDownloadSchedule'
import { ScreenFooter } from './ScreenFooter'
import { ThemeToggle } from './ThemeToggle'
import { Switch } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const FREE_SPACE_POLL_MS = 30_000
const BALANCED_SPEED_BYTES_PER_SEC = 5 * 1024 * 1024
const QUIET_SPEED_BYTES_PER_SEC = 512 * 1024

type TrafficProfile = 'full' | 'balanced' | 'quiet' | 'custom'

/** A quick preset changes the existing enforced global limiter, not just its label. */
function TrafficProfileToggle(): React.JSX.Element {
  const { t } = useLocale()
  const speedLimit = useAppStore((store) => store.speedLimit)
  const slowMode = useAppStore((store) => store.slowMode)
  const slowModeSpeed = useAppStore((store) => store.slowModeSpeed)
  const setSpeedLimit = useAppStore((store) => store.setSpeedLimit)
  const setSlowMode = useAppStore((store) => store.setSlowMode)
  const setSlowModeSpeed = useAppStore((store) => store.setSlowModeSpeed)
  const profile: TrafficProfile = slowMode
    ? slowModeSpeed === QUIET_SPEED_BYTES_PER_SEC
      ? 'quiet'
      : 'custom'
    : speedLimit === undefined
      ? 'full'
      : speedLimit === BALANCED_SPEED_BYTES_PER_SEC
        ? 'balanced'
        : 'custom'

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ToggleGroup
            aria-label={t('Quick traffic profile')}
            value={profile === 'custom' ? [] : [profile]}
            onValueChange={(values) => {
              const selected = values[0] as TrafficProfile | undefined
              if (!selected || selected === 'custom') return
              if (selected === 'full') {
                setSlowMode(false)
                setSpeedLimit(undefined)
              } else if (selected === 'balanced') {
                setSlowMode(false)
                setSpeedLimit(BALANCED_SPEED_BYTES_PER_SEC)
              } else {
                setSlowModeSpeed(QUIET_SPEED_BYTES_PER_SEC)
                setSlowMode(true)
              }
            }}
            size="xs"
            spacing={0.5}
            className="h-[26px] rounded-[6px] border-[0.5px] border-border p-0.5 [-webkit-app-region:no-drag]"
          >
            {(
              [
                ['full', 'FULL'],
                ['balanced', 'BALANCED'],
                ['quiet', 'QUIET']
              ] as const
            ).map(([value, label]) => (
              <ToggleGroupItem
                key={value}
                value={value}
                aria-label={`${t(`${label.toLowerCase()} traffic profile`)}`}
                className="h-full rounded-[4px] px-1.5 font-mono text-[9px] font-medium text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground"
              >
                {t(label)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />
      <TooltipContent>
        {profile === 'full'
          ? t('Full speed: no global download speed cap')
          : profile === 'balanced'
            ? t('Balanced: global download cap of 5 MiB/s')
            : profile === 'quiet'
              ? t('Quiet: global download cap of 512 KiB/s')
              : t('Custom speed limit active; choose a preset to apply it')}
      </TooltipContent>
    </Tooltip>
  )
}

/** MB/s or Mbps for every speed in the app; sits with the theme toggle as a view preference. */
function SpeedUnitToggle(): React.JSX.Element {
  const { t } = useLocale()
  const speedUnit = useAppStore((store) => store.speedUnit)
  const setSpeedUnit = useAppStore((store) => store.setSpeedUnit)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ToggleGroup
            aria-label={t('Speed units')}
            value={[speedUnit]}
            onValueChange={(values) => {
              // Clicking the pressed one would unpress it; one unit is always on.
              if (values[0] !== undefined) setSpeedUnit(values[0] as SpeedUnit)
            }}
            size="xs"
            spacing={0.5}
            className="h-[26px] rounded-[6px] border-[0.5px] border-border p-0.5 [-webkit-app-region:no-drag]"
          >
            {(['bytes', 'bits'] as const).map((unit) => (
              <ToggleGroupItem
                key={unit}
                value={unit}
                className="h-full rounded-[4px] px-1.5 font-mono text-[11px] font-medium text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground"
              >
                {unit === 'bytes' ? 'MB/s' : 'Mbps'}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />
      <TooltipContent>{t('Speed units')}</TooltipContent>
    </Tooltip>
  )
}

/** Along the bottom of every screen: the room left where downloads are saved, the queue, the
 * slow mode switch, and view preferences. Speeds and their limits are left to the screens that
 * show them â€” repeated down here they only doubled up, or read as a limit with no cause. */
export function StatusBar(): React.JSX.Element {
  const { t } = useLocale()
  const formatSpeedLimit = useFormatSpeedLimit()
  const { message } = useDownloadSchedule()
  // A count, not the downloads: progress ticks don't re-render the footer.
  const waiting = useAppStore(
    (store) =>
      Object.values(store.downloads).filter((download) => download.status === 'queued').length
  )
  const slowMode = useAppStore((store) => store.slowMode)
  const slowModeSpeed = useAppStore((store) => store.slowModeSpeed)
  const setSlowMode = useAppStore((store) => store.setSlowMode)
  const destinationDir = useAppStore((store) => store.destinationDir)
  const [free, setFree] = useState<number | null>(null)

  useEffect(() => {
    let disposed = false
    const load = (): void => {
      void window.sonic
        .freeSpace(destinationDir)
        .then((bytes) => !disposed && setFree(bytes))
        .catch(() => {})
    }
    load()
    const interval = setInterval(load, FREE_SPACE_POLL_MS)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [destinationDir])

  // Limits show by the speeds they cap (the Downloading screen, the networks menu), not here.
  const status = [
    free !== null && `${formatBytes(free)} ${t('free')}`,
    waiting > 0 && t('{{count}} waiting', { count: waiting })
  ].filter(Boolean)

  return (
    <ScreenFooter className="gap-4 font-mono text-[11.5px] text-muted-foreground">
      <span className="min-w-0 flex-1 truncate tabular-nums">{status.join(' Â· ')}</span>
      {message && <span className="truncate">{message}</span>}
      {/* Controls, most-flipped first: the edge holds the set-once view preferences. */}
      <div className="flex shrink-0 items-center gap-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <label className="flex items-center gap-2">
                {t('Slow mode')}
                <Switch checked={slowMode} onCheckedChange={setSlowMode} />
              </label>
            }
          />
          <TooltipContent>Limit downloads to {formatSpeedLimit(slowModeSpeed)}</TooltipContent>
        </Tooltip>
        <TrafficProfileToggle />
        <SpeedUnitToggle />
        <ThemeToggle />
      </div>
    </ScreenFooter>
  )
}

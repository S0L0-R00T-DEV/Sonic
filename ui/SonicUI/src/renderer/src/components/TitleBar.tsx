import { Minus, Maximize2, X, Settings } from 'lucide-react'
import { TITLE_BAR_HEIGHT } from '../theme'
import { useLocale } from '../i18n'

const isMac = window.sonic.platform === 'darwin'

/** App-owned controls use macOS-style traffic-light buttons on non-macOS platforms. */
export function TitleBar({ onOpenSettings }: { onOpenSettings: () => void }): React.JSX.Element {
  const { t } = useLocale()
  const buttonBase =
    'group relative flex size-6 shrink-0 items-center justify-center rounded-full border border-black/15 shadow-[inset_0_0.5px_0_rgba(255,255,255,0.35)] outline-none transition-[filter,transform] hover:brightness-95 active:scale-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [-webkit-app-region:no-drag]'
  const glyphBase =
    'pointer-events-none absolute opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100'

  return (
    <div
      style={{ height: TITLE_BAR_HEIGHT }}
      className="relative flex shrink-0 items-center justify-center border-b-[0.5px] border-border bg-card px-[140px] [-webkit-app-region:drag]"
    >
      <button
        type="button"
        aria-label={t('openSettings')}
        title={t('settings')}
        onClick={onOpenSettings}
        className="absolute left-2 top-1/2 z-10 flex size-8 -translate-y-1/2 items-center justify-center rounded-md bg-transparent text-[var(--text-secondary)] transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
      >
        <Settings size={16} strokeWidth={1.7} />
      </button>

      <div className="truncate font-sans text-[13px] leading-none font-semibold text-[var(--text-secondary)]">
        Speed-o&apos;-Freq Sonic
      </div>

      {!isMac && (
        <div
          aria-label="Window controls"
          className="absolute right-0 top-0 z-10 flex h-full items-center gap-[8px] px-3 [-webkit-app-region:no-drag]"
        >
          <button
            type="button"
            aria-label={t('closeWindow')}
            title={t('close')}
            onClick={() => void window.sonic.closeWindow()}
            style={{ backgroundColor: '#ff5f57' }}
            className={buttonBase}
          >
            <X size={9} strokeWidth={2.5} className={glyphBase} />
          </button>
          <button
            type="button"
            aria-label={t('minimizeWindow')}
            title={t('minimizeWindow')}
            onClick={() => void window.sonic.minimizeWindow()}
            style={{ backgroundColor: '#febc2e' }}
            className={buttonBase}
          >
            <Minus size={9} strokeWidth={2.5} className={glyphBase} />
          </button>
          <button
            type="button"
            aria-label={t('maximizeWindow')}
            title={t('maximizeWindow')}
            onClick={() => void window.sonic.toggleMaximizeWindow()}
            style={{ backgroundColor: '#28c840' }}
            className={buttonBase}
          >
            <Maximize2 size={8} strokeWidth={2.5} className={glyphBase} />
          </button>
        </div>
      )}
    </div>
  )
}

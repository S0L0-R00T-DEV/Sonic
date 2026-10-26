import type { DownloadState, FinishedDownload } from '@shared/types'
import {
  ChevronRight,
  Plus,
  X,
  History as HistoryIcon,
  Search,
  Tags as TagsIcon
} from 'lucide-react'
import { cn } from 'cn'
import { DownloadOrganizationDialog } from '../components/DownloadOrganizationDialog'
import { Fragment, memo, useCallback, useEffect, useState } from 'react'
import { DownloadContextMenu } from '../components/DownloadContextMenu'
import { DownloadFilterMenu } from '../components/DownloadFilterMenu'
import { useDownloadActions, useDownloadActionsState } from '../components/downloadActionsContext'
import { ACTION_META, toolbarLabel } from '../components/downloadActionMeta'
import { MoreActionsMenu } from '../components/MoreActionsMenu'
import { CombineDiagram } from '../components/CombineDiagram'
import { LimitsDialog } from '../components/LimitsDialog'
import { ScheduleIndicator } from '../components/ScheduleIndicator'
import { networkStatusText } from '../components/NetworkRow'
import { scheduleMessage, scheduleWindow } from '@shared/downloadSchedule'
import { NetworksMenu } from '../components/NetworksMenu'
import { TorrentBadge } from '../components/TorrentBadge'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { useNetworkVisuals, type ResolveNetworkVisual } from '../hooks/useNetworkVisuals'
import { useAppStore, type DownloadFilter } from '../store/useAppStore'
import {
  describeError,
  fileExtensionBadge,
  formatBytes,
  formatEta,
  formatPercent,
  formatWhen,
  isFolder,
  sourceOf,
  wantedBytes
} from '../utils/format'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { useLocale } from '../i18n'
import {
  availableActions,
  isFinished,
  rowAction,
  splitToolbar,
  type ActionId
} from '../utils/downloadActions'

type Item = DownloadState | FinishedDownload
type SortOrder = 'newest' | 'oldest' | 'name' | 'size'

interface Group {
  label: string
  items: Item[]
}

function filterOf(item: Item): Exclude<DownloadFilter, 'all'> {
  if ('unitsWritten' in item || item.status === 'completed') return 'finished'
  return item.status === 'error' ? 'failed' : 'progress'
}

function groupsOf(downloads: DownloadState[], history: FinishedDownload[]): Group[] {
  const byStatus = (status: DownloadState['status']): DownloadState[] =>
    downloads.filter((download) => download.status === status)
  return [
    { label: 'Downloading', items: byStatus('downloading') },
    {
      label: 'Queued',
      items: byStatus('queued').sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))
    },
    { label: 'Paused', items: byStatus('paused') },
    { label: 'Needs attention', items: byStatus('error') },
    // Completed but not in history yet: on its way there, so listed with it.
    { label: 'Finished', items: [...byStatus('completed'), ...history] }
  ].filter((group) => group.items.length > 0)
}

/** "2 downloading · 1 queued", or "all done". */
function summaryOf(downloads: DownloadState[]): string {
  const count = (status: DownloadState['status']): number =>
    downloads.filter((download) => download.status === status).length
  const parts = [
    [count('downloading'), 'downloading'],
    [count('queued'), 'queued'],
    [count('paused'), 'paused'],
    [count('error'), 'need attention']
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, label]) => `${n} ${label}`)
  return parts.length > 0 ? parts.join(' · ') : 'all done'
}

const groupLabelClass =
  'font-mono text-[10.5px] leading-none font-medium tracking-[0.18em] text-muted-foreground uppercase'

export function DownloadsScreen(): React.JSX.Element {
  const { t } = useLocale()
  const downloadsById = useAppStore((store) => store.downloads)
  const history = useAppStore((store) => store.history)
  const setView = useAppStore((store) => store.setView)
  const openNewDownload = useAppStore((store) => store.openNewDownload)
  const filter = useAppStore((store) => store.downloadFilter)
  const setFilter = useAppStore((store) => store.setDownloadFilter)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const downloadTags = useAppStore((store) => store.downloadTags)
  const { perform } = useDownloadActions()
  const { busy } = useDownloadActionsState()
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [showSchedule, setShowSchedule] = useState(false)
  const [limitsPage, setLimitsPage] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  const downloads = Object.values(downloadsById)
    .filter((download) => download.status !== 'cancelled')
    .sort((a, b) => a.startedAt - b.startedAt)
  const historyGroups = groupsOf(downloads, history)
  const historyItems = historyGroups.flatMap((group) => group.items)
  const allGroups = groupsOf(
    downloads,
    history.filter((entry) => !entry.removedAt)
  )
  const allItems = allGroups.flatMap((group) => group.items)
  const counts: Record<DownloadFilter, number> = {
    all: allItems.length,
    progress: 0,
    finished: 0,
    failed: 0
  }
  for (const item of allItems) counts[filterOf(item)]++
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase()
  const groups = allGroups
    .filter((group) => filter === 'all' || filterOf(group.items[0]) === filter)
    .map((group) => {
      const matches = group.items.filter(
        (item) =>
          !normalizedSearch ||
          item.fileName.toLocaleLowerCase().includes(normalizedSearch) ||
          sourceOf(item.url).toLocaleLowerCase().includes(normalizedSearch) ||
          (downloadTags[item.id] ?? []).some((tag) =>
            tag.toLocaleLowerCase().includes(normalizedSearch)
          )
      )
      const sorted = [...matches].sort((a, b) => {
        // Queue order is operational priority; display sorting must never reorder it.
        if (group.label === 'Queued') return (a.queuedAt ?? 0) - (b.queuedAt ?? 0)
        switch (sortOrder) {
          case 'name':
            return a.fileName.localeCompare(b.fileName)
          case 'size':
            return wantedBytes(b) - wantedBytes(a)
          case 'oldest':
            return a.startedAt - b.startedAt
          default:
            return (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt)
        }
      })
      return { ...group, items: sorted }
    })
    .filter((group) => group.items.length > 0)
  const items = groups.flatMap((group) => group.items)
  // Only what's still listed counts: one that finished or went is no longer selected.
  const chosen = items.filter((item) => selected.has(item.id))

  const toggle = useCallback(
    (ids: string[], on: boolean): void =>
      setSelected((previous) => {
        const next = new Set(previous)
        for (const id of ids) {
          if (on) next.add(id)
          else next.delete(id)
        }
        return next
      }),
    []
  )
  // Stable, with the colors resolved once here, so a finished row skips every progress push.
  const networkVisual = useNetworkVisuals()
  const selectRow = useCallback((id: string, on: boolean) => toggle([id], on), [toggle])
  const openRow = useCallback((id: string) => setView({ name: 'download', id }), [setView])
  // Keys for the selection: Esc clears it, Select all, and Delete takes
  // the selected off the list (with Cmd/Ctrl, moves their files to the Trash), each asking first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      if (
        event.defaultPrevented ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) ||
        document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
      )
        return
      const command = window.sonic.platform === 'darwin' ? event.metaKey : event.ctrlKey
      if (event.key === 'Escape') setSelected(new Set())
      else if (command && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setSelected(new Set(items.map((item) => item.id)))
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        const id = command ? 'trash' : 'remove'
        const action = availableActions(chosen)
          .flat()
          .find((available) => available.id === id)
        if (!action) return
        event.preventDefault()
        void perform(id, action.targets)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [items, chosen, perform])

  // What the toolbar offers: the two actions most needed for what's selected as buttons, and
  // the rest of what the menu does for the selection behind More, so six never need more room.
  const { buttons: toolbarButtons, more: moreActions } = splitToolbar(availableActions(chosen))

  const openSchedule = (): void => {
    setLimitsPage(null)
    setShowSchedule(true)
    setLimitsOpen(true)
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {chosen.length === 0 ? (
        <div className="flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-border px-5">
          <Button type="button" variant="secondary" onClick={() => setHistoryOpen(true)}>
            <HistoryIcon data-icon="inline-start" />
            {t('history')}
          </Button>
          {/* One group already says it in its header. */}
          {allGroups.length > 1 && (
            <div className="font-mono text-[11.5px] leading-none text-muted-foreground">
              {summaryOf(downloads)}
            </div>
          )}
          <div className="flex-1" />
          <ScheduleIndicator onClick={openSchedule} />
          <NetworksMenu />
          <Button type="button" onClick={() => openNewDownload()}>
            <Plus data-icon="inline-start" />
            {t('newDownload')}
          </Button>
        </div>
      ) : (
        <div
          role="toolbar"
          aria-label="Selected downloads"
          aria-busy={busy}
          className="flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-border px-5"
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Deselect all"
                  disabled={busy}
                  onClick={() => setSelected(new Set())}
                >
                  <X />
                </Button>
              }
            />
            <TooltipContent>Deselect all</TooltipContent>
          </Tooltip>
          <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold">
            {chosen.length} selected
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || chosen.length === items.length}
            onClick={() => setSelected(new Set(items.map((item) => item.id)))}
          >
            Select all
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => setTagsOpen(true)}
          >
            <TagsIcon data-icon="inline-start" />
            Tags
          </Button>
          <div className="flex-1" />
          <div className="flex min-w-0 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {toolbarButtons.map(({ id, targets }) => (
              <Button
                key={id}
                type="button"
                size="sm"
                variant={ACTION_META[id].destructive ? 'destructive' : 'secondary'}
                disabled={busy}
                onClick={() => void perform(id, targets)}
              >
                {toolbarLabel(id, targets.length)}
              </Button>
            ))}
            <MoreActionsMenu groups={moreActions} disabled={busy} />
          </div>
          <ScheduleIndicator onClick={openSchedule} />
        </div>
      )}

      <div className="flex min-h-10 shrink-0 items-center gap-3 border-b-[0.5px] border-border px-5 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            aria-label={t('searchDownloads')}
            placeholder={t('searchDownloads')}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value)
              setSelected(new Set())
            }}
            className="h-8 w-full rounded-lg border border-border bg-card pl-8 pr-3 text-[12.5px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <DownloadFilterMenu
          value={filter}
          counts={counts}
          onChange={(value) => {
            setFilter(value)
            setSelected(new Set())
          }}
        />
        <label className="flex shrink-0 items-center gap-2 text-[11.5px] text-muted-foreground">
          <span>{t('Sort')}</span>
          <select
            aria-label={t('sortDownloads')}
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value as SortOrder)}
            className="h-8 max-w-[118px] rounded-lg border border-border bg-card px-2 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="newest">{t('sortNewest')}</option>
            <option value="oldest">{t('sortOldest')}</option>
            <option value="name">{t('sortName')}</option>
            <option value="size">{t('sortSize')}</option>
          </select>
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {groups.length === 0 &&
          (normalizedSearch ? (
            <div role="status" className="flex flex-col items-center gap-2 px-5 py-16 text-center">
              <p className="text-[16px] font-semibold">
                {t('No downloads match “{{search}}”', { search: searchQuery.trim() })}
              </p>
              <Button type="button" variant="secondary" onClick={() => setSearchQuery('')}>
                {t('Clear search')}
              </Button>
            </div>
          ) : filter === 'all' ? (
            <EmptyState />
          ) : (
            <div role="status" className="flex flex-col items-center gap-2 px-5 py-16 text-center">
              <p className="text-[16px] font-semibold">
                {t(
                  filter === 'progress'
                    ? 'No downloads in progress'
                    : filter === 'finished'
                      ? 'No finished downloads'
                      : 'No downloads need attention'
                )}
              </p>
              <Button type="button" variant="secondary" onClick={() => setFilter('all')}>
                {t('Show all downloads')}
              </Button>
            </div>
          ))}
        {groups.map((group) => {
          const ids = group.items.map((item) => item.id)
          const all = ids.every((id) => selected.has(id))
          const some = !all && ids.some((id) => selected.has(id))
          return (
            <section key={group.label} aria-label={t(group.label)}>
              <div className="flex items-center gap-3 border-b-[0.5px] border-border pt-5 pb-3">
                <Checkbox
                  aria-label={
                    group.label === 'Needs attention'
                      ? t('Select all downloads needing attention')
                      : t('Select all {{group}} downloads', {
                          group: group.label.toLowerCase()
                        })
                  }
                  checked={all}
                  indeterminate={some}
                  onCheckedChange={(on) => toggle(ids, on)}
                />
                <h2 className={groupLabelClass}>
                  {group.label}
                  <span className="ml-2.5 tracking-normal">{group.items.length}</span>
                </h2>
                <div className="flex-1" />
              </div>
              {group.items.map((item) => (
                <ListedDownload
                  key={item.id}
                  item={item}
                  tags={downloadTags[item.id] ?? []}
                  now={now}
                  selected={selected.has(item.id)}
                  // Only a selected row's menu acts on the selection.
                  chosen={selected.has(item.id) ? chosen : NOT_CHOSEN}
                  networkVisual={
                    isFinished(item) || item.status === 'completed' ? undefined : networkVisual
                  }
                  onSelect={selectRow}
                  onOpen={openRow}
                  onPerform={perform}
                />
              ))}
            </section>
          )
        })}
      </div>
      {historyOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setHistoryOpen(false)
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t('Download history')}
            className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-2xl"
          >
            <header className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-semibold">{t('History')}</h2>
                <p className="text-xs text-muted-foreground">
                  {t('Finished, in-progress, queued and paused downloads')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">To clear your history, open Settings and press Clear history at the bottom.</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close history"
                onClick={() => setHistoryOpen(false)}
              >
                <X />
              </Button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {historyItems.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  {t('No download history yet.')}
                </p>
              ) : (
                historyGroups.map((group) => (
                  <div key={group.label} className="mb-3">
                    <h3 className="px-2 py-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {group.label}
                    </h3>
                    {group.items.map((item) => {
                      const record = item as DownloadState & {
                        name?: string
                        filename?: string
                        fileName?: string
                        url?: string
                      }
                      const label =
                        record.name ?? record.filename ?? record.fileName ?? record.url ?? item.id
                      const status =
                        'unitsWritten' in item
                          ? 'Finished'
                          : item.status === 'downloading'
                            ? 'In progress'
                            : item.status === 'queued'
                              ? 'Queued'
                              : item.status === 'paused'
                                ? 'Paused'
                                : item.status === 'completed'
                                  ? 'Finished'
                                  : item.status === 'error'
                                    ? 'Needs attention'
                                    : item.status
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-secondary"
                          onClick={() => {
                            setView({ name: 'download', id: item.id })
                            setHistoryOpen(false)
                          }}
                        >
                          <span className="min-w-0 truncate">{label}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {t(
                              'unitsWritten' in item && item.removedAt
                                ? 'Removed from list'
                                : status
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      )}
      <DownloadOrganizationDialog
        open={tagsOpen}
        onOpenChange={setTagsOpen}
        selectedIds={chosen.map((item) => item.id)}
      />
      <LimitsDialog
        open={limitsOpen}
        showSchedule={showSchedule}
        onOpenChange={setLimitsOpen}
        page={limitsPage}
        onPageChange={setLimitsPage}
      />
    </div>
  )
}

// Colors are irrelevant here — the diagram is rendered `muted`, which overrides them all to
// var(--icon-muted) — these are just three placeholder rows to draw the illustration with.
const PLACEHOLDER_NETWORKS = [
  { solid: 'var(--icon-muted)', label: 'Wi-Fi' },
  { solid: 'var(--icon-muted)', label: 'USB' },
  { solid: 'var(--icon-muted)', label: 'Ethernet' }
]
const PASTE_SHORTCUT = window.sonic.platform === 'darwin' ? '⌘V' : 'Ctrl+V'
const NEW_SHORTCUT = window.sonic.platform === 'darwin' ? '⌘N' : 'Ctrl+N'

/** Nothing listed yet: how to start one — or, with no network connected, how to get one. */
function EmptyState(): React.JSX.Element {
  const noNetworks = useAppStore(
    (store) => store.interfacesStatus === 'ready' && store.interfaces.length === 0
  )
  const loadInterfaces = useAppStore((store) => store.loadInterfaces)
  const openNewDownload = useAppStore((store) => store.openNewDownload)

  return (
    <div className="flex flex-col items-center gap-4 px-5 pt-16 pb-10 text-center">
      <CombineDiagram networks={PLACEHOLDER_NETWORKS} muted />
      {noNetworks ? (
        <>
          <div className="font-sans text-[16px] leading-[1.2] font-bold">No networks connected</div>
          <div className="max-w-[380px] text-[12.5px] leading-[1.6] text-[var(--text-secondary)]">
            Speed-o&apos;-Freq Sonic needs at least one active network. Join a Wi-Fi network, plug
            in Ethernet, or connect your phone using USB tethering.
          </div>
          <div className="mt-1 flex gap-2">
            <Button type="button" variant="secondary" onClick={() => loadInterfaces()}>
              Scan again
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => window.sonic.openNetworkSettings()}
            >
              Network settings
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="font-sans text-[16px] leading-[1.2] font-bold">
            {import.meta.env.VITE_SONIC_UPDATE_TEST_BUILD === 'true'
              ? 'Software update test successful'
              : 'No downloads yet'}
          </div>
          <div className="max-w-[380px] text-[12.5px] leading-[1.6] text-[var(--text-secondary)]">
            {import.meta.env.VITE_SONIC_UPDATE_TEST_BUILD === 'true'
              ? 'This is the update-test build. If you can see this message after updating, the software update succeeded.'
              : <>Paste a link ({PASTE_SHORTCUT}) or drop a .torrent anywhere in this window.</>}
          </div>
          <Button type="button" className="mt-1" onClick={() => openNewDownload()}>
            <Plus data-icon="inline-start" />
            New download
            <span className="ml-1 font-mono text-[11px]">{NEW_SHORTCUT}</span>
          </Button>
        </>
      )}
    </div>
  )
}

const NOT_CHOSEN: Item[] = []

/** A row with its right-click menu, memoized as one: a progress update to one download leaves
 * every other row, menu included, as it was. */
const ListedDownload = memo(function ListedDownload({
  chosen,
  ...row
}: React.ComponentProps<typeof DownloadRow> & { chosen: Item[] }): React.JSX.Element {
  return (
    <DownloadContextMenu item={row.item} selected={row.selected} chosen={chosen}>
      <DownloadRow {...row} />
    </DownloadContextMenu>
  )
})

const DownloadRow = memo(function DownloadRow({
  item,
  tags,
  now,
  selected,
  networkVisual,
  onSelect,
  onOpen,
  onPerform
}: {
  item: Item
  tags: string[]
  now: number
  selected: boolean
  /** Colors its progress bar and network dots; a finished row has none. */
  networkVisual?: ResolveNetworkVisual
  onSelect: (id: string, on: boolean) => void
  onOpen: (id: string) => void
  /** Does what the row's button says, the way the menu, the toolbar and its screen do. */
  onPerform: (id: ActionId, targets: Item[]) => Promise<boolean>
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const schedule = useAppStore((store) => store.downloadSchedule)
  const [working, setWorking] = useState(false)
  const finished = isFinished(item) || item.status === 'completed'
  const badge = isFolder(item) ? 'DIR' : fileExtensionBadge(item.fileName)
  const wanted = wantedBytes(item)
  const percent = formatPercent(item.bytesDownloaded, wanted)

  let detail: string
  let tone = 'text-muted-foreground'
  if (isFinished(item) || item.status === 'completed') {
    detail = [
      formatBytes(wanted || item.bytesDownloaded),
      // A torrent's badge already says where it came from.
      item.kind === 'http' && sourceOf(item.url),
      isFinished(item) && item.missing
        ? 'moved or deleted'
        : formatWhen(item.completedAt ?? now, now)
    ]
      .filter(Boolean)
      .join(' · ')
  } else {
    const download = item
    const sizes =
      wanted > 0
        ? `${formatBytes(download.bytesDownloaded)} of ${formatBytes(wanted)}`
        : formatBytes(download.bytesDownloaded)
    switch (download.status) {
      case 'downloading':
        detail = [
          wanted > 0 && `${percent}%`,
          sizes,
          download.timeLeftSeconds !== undefined && formatEta(download.timeLeftSeconds)
        ]
          .filter(Boolean)
          .join(' · ')
        break
      case 'queued':
        detail = `${schedule?.enabled && !scheduleWindow(schedule, now).allowed ? (scheduleMessage(schedule, now) ?? 'Waiting for a turn') : 'Waiting for a turn'} · ${sizes}`
        break
      case 'paused':
        detail = wanted > 0 ? `Paused at ${percent}% · ${sizes}` : `Paused · ${sizes}`
        break
      default:
        detail = describeError(download.error ?? 'Something went wrong')
        tone = 'text-[var(--color-danger)]'
    }
  }
  if (item.packageName) detail = `Package ${item.packageName} · ${detail}`

  // Its next step, if it has one: the first thing its menu offers.
  const actionId = rowAction(item)
  const action = actionId ? ACTION_META[actionId] : null

  // The bar shows each network's share of the file in its color; a failed one shows in red.
  const segments =
    finished || isFinished(item) || !networkVisual
      ? []
      : item.status === 'error'
        ? [
            {
              id: 'error',
              share: item.bytesDownloaded / (wanted || 1),
              color: 'var(--color-danger)'
            }
          ]
        : item.networks
            .filter((network) => network.bytesDownloaded > 0)
            .map((network) => ({
              id: network.id,
              share: network.bytesDownloaded / (wanted || 1),
              color: networkVisual(network.id, network.kind, network.label).solid
            }))

  // Which networks it's on, at a glance, when it isn't on all of them. One on every network says
  // nothing new, so it shows none.
  const dots =
    !finished &&
    networkVisual &&
    !isFinished(item) &&
    item.networks.some((network) => !network.enabled)
      ? item.networks.map((network) => {
          const visual = networkVisual(network.id, network.kind, network.label)
          return {
            id: network.id,
            on: network.enabled,
            color: visual.solid,
            name: visual.name,
            // Its speed while it runs; otherwise whether it's on, or what's stopping it.
            state: !network.enabled
              ? 'Off'
              : network.status !== 'on'
                ? networkStatusText(network.status, network.transfer)
                : item.status === 'downloading'
                  ? formatSpeed(network.speedBytesPerSec)
                  : 'On'
          }
        })
      : null
  const speed =
    !finished && !isFinished(item) && item.status === 'downloading'
      ? formatSpeed(item.speedBytesPerSec)
      : null

  return (
    <div
      data-selected={selected || undefined}
      className={cn(
        'group/download-row my-0.5 -mx-2 flex items-center gap-3 rounded-lg px-2 py-3 transition-colors',
        selected
          ? 'bg-primary/10 hover:bg-primary/15 focus-within:bg-primary/15'
          : 'hover:bg-secondary focus-within:bg-secondary'
      )}
    >
      <Checkbox
        aria-label={`Select ${item.fileName}`}
        checked={selected}
        onCheckedChange={(on) => onSelect(item.id, on)}
      />
      <button
        type="button"
        onClick={() => onOpen(item.id)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border-[0.5px] border-border bg-card font-mono text-[10px] font-semibold text-muted-foreground">
          {badge}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-sans text-[14px] leading-tight font-medium">
              {item.fileName}
            </span>
            {item.kind === 'torrent' && <TorrentBadge />}
            {tags.length > 0 && (
              <span className="flex shrink-0 items-center gap-1">
                {tags.slice(0, 3).map((tag) => (
                  <span
                    key={tag}
                    className="max-w-20 truncate rounded border border-border bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </span>
            )}
            {(dots || speed) && (
              <div className="ml-auto flex shrink-0 items-center gap-2.5 pl-2">
                {dots && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          role="img"
                          aria-label={dots.map((dot) => `${dot.name} ${dot.state}`).join(', ')}
                          className="flex items-center gap-1 rounded-full border border-border px-1.5 py-1"
                        >
                          {dots.map((dot) => (
                            <span
                              key={dot.id}
                              className={cn(
                                'size-1.5 rounded-full',
                                !dot.on && 'bg-muted-foreground/30'
                              )}
                              style={dot.on ? { background: dot.color } : undefined}
                            />
                          ))}
                        </span>
                      }
                    />
                    <TooltipContent>
                      <div className="grid grid-cols-[auto_auto_auto] items-center gap-x-2 gap-y-1">
                        {dots.map((dot) => (
                          <Fragment key={dot.id}>
                            <span
                              className={cn(
                                'size-2 rounded-full',
                                !dot.on && 'border border-current opacity-60'
                              )}
                              style={dot.on ? { background: dot.color } : undefined}
                            />
                            <span>{dot.name}</span>
                            <span className="pl-3 text-right font-mono tabular-nums opacity-80">
                              {dot.state}
                            </span>
                          </Fragment>
                        ))}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                )}
                {speed && (
                  <span className="font-mono text-[12.5px] font-medium tabular-nums">{speed}</span>
                )}
              </div>
            )}
          </div>
          {segments.length > 0 && (
            <div
              className={cn(
                'flex h-1 overflow-hidden rounded-full bg-muted',
                // Not moving: the colors stay, faded, so it doesn't read as running.
                !isFinished(item) &&
                  (item.status === 'paused' || item.status === 'queued') &&
                  'opacity-40'
              )}
            >
              {segments.map((segment) => (
                <div
                  key={segment.id}
                  style={{
                    width: `${Math.min(100, segment.share * 100)}%`,
                    background: segment.color
                  }}
                />
              ))}
            </div>
          )}
          <div className={`truncate font-mono text-[11.5px] leading-tight ${tone}`}>{detail}</div>
        </div>
      </button>
      {action && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`${action.label} ${item.fileName}`}
                aria-busy={working}
                disabled={working}
                onClick={() => {
                  setWorking(true)
                  void onPerform(actionId!, [item]).finally(() => setWorking(false))
                }}
                className="text-muted-foreground group-hover/download-row:text-foreground"
              >
                <action.icon />
              </Button>
            }
          />
          <TooltipContent>
            {working && action.working ? action.working : action.label}
          </TooltipContent>
        </Tooltip>
      )}
      <button
        type="button"
        aria-label={`Open ${item.fileName}`}
        onClick={() => onOpen(item.id)}
        className="rounded-md p-1 text-muted-foreground transition-colors group-hover/download-row:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  )
})

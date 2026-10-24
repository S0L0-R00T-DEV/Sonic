import { ArrowUp, PlayCircle } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { availableActions, isFinished, type DownloadItem } from '../utils/downloadActions'
import { useDownloadActions } from './downloadActionsContext'
import { MediaConversionDialog } from './MediaConversionDialog'
import { ACTION_META, menuLabel } from './downloadActionMeta'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from './ui/context-menu'

/** Right-click menu for a download row: everything that can be done to it, from the same list
 * as its row button, the toolbar and its own screen. Right-clicking inside the selection acts
 * on everything selected; outside it, on just that row, which is left unselected (selecting
 * would swap the header into the selection toolbar). */
export function DownloadContextMenu({
  item,
  selected,
  chosen,
  children
}: {
  item: DownloadItem
  selected: boolean
  chosen: DownloadItem[]
  children: React.ReactNode
}): React.JSX.Element {
  const { perform } = useDownloadActions()
  const [conversionOpen, setConversionOpen] = useState(false)
  const itemId = item.id
  const itemKind = item.kind
  const itemStatus = item.status
  const [previewEligibility, setPreviewEligibility] = useState<{
    id: string
    available: boolean
  } | null>(null)
  useEffect(() => {
    if (itemKind !== 'http' || itemStatus !== 'downloading') return
    let current = true
    void window.sonic
      .canPreviewHttpMedia(itemId)
      .then((available) => {
        if (current) setPreviewEligibility({ id: itemId, available })
      })
      .catch(() => {
        if (current) setPreviewEligibility({ id: itemId, available: false })
      })
    return () => {
      current = false
    }
  }, [itemId, itemKind, itemStatus])
  const httpPreviewAvailable =
    previewEligibility?.id === item.id &&
    previewEligibility.available &&
    item.kind === 'http' &&
    !isFinished(item) &&
    item.status === 'downloading'
  const groups = availableActions(selected ? chosen : [item])
  const canConvert =
    item.kind === 'http' &&
    isFinished(item) &&
    !item.missing &&
    /\.(mp4|m4v|mov|mkv|webm|avi|flv|ts|mpg|mpeg|mp3|m4a|aac|wav|ogg|oga|opus|flac|3gp)$/i.test(
      item.fileName
    )
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>{children}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-52">
          {canConvert && (
            <>
              <ContextMenuItem onClick={() => setConversionOpen(true)}>
                <PlayCircle aria-hidden />
                Convert media?
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {httpPreviewAvailable && item.kind === 'http' && !isFinished(item) && (
            <>
              <ContextMenuItem
                onClick={() =>
                  void window.sonic
                    .previewHttpMedia(item.id)
                    .catch((error: unknown) =>
                      window.alert(error instanceof Error ? error.message : String(error))
                    )
                }
              >
                <PlayCircle aria-hidden />
                Preview while downloading
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {item.status === 'queued' && (
            <ContextMenuItem
              onClick={() => {
                // Pause/resume reuses the manager's verified resume path, which enqueues a
                // user-requested restart at the front without changing its saved partial file.
                void window.sonic
                  .pauseDownload(item.id)
                  .then(() => window.sonic.resumeDownload(item.id))
                  .catch(() => {})
              }}
            >
              <ArrowUp aria-hidden />
              Move to front of queue
            </ContextMenuItem>
          )}
          {groups.map((group, index) => (
            <Fragment key={group[0].id}>
              {index > 0 && <ContextMenuSeparator />}
              {group.map(({ id, targets }, position) => {
                const meta = ACTION_META[id]
                return (
                  <ContextMenuItem
                    key={id}
                    variant={meta.destructive ? 'destructive' : 'default'}
                    // The first is what the row's own button does.
                    className={index === 0 && position === 0 ? 'font-medium' : undefined}
                    onClick={() => void perform(id, targets)}
                  >
                    <meta.icon aria-hidden />
                    {menuLabel(id, targets)}
                  </ContextMenuItem>
                )
              })}
            </Fragment>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      {canConvert && isFinished(item) && (
        <MediaConversionDialog
          open={conversionOpen}
          onOpenChange={setConversionOpen}
          downloadId={item.id}
          sourcePath={item.destinationPath}
          fileName={item.fileName}
        />
      )}
    </>
  )
}

import type { ReactNode } from 'react'
import { CircleHelp } from 'lucide-react'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { useState } from 'react'

export function ContextHelp({
  title,
  children,
  label = 'Help'
}: {
  title: string
  children: ReactNode
  label?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`${label}: ${title}`}
        title={`${label}: ${title}`}
        onClick={() => setOpen(true)}
        className="size-7 shrink-0 text-muted-foreground"
      >
        <CircleHelp aria-hidden className="size-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100%-2rem)] overflow-y-auto sm:max-w-[460px]">
          <DialogTitle>{title}</DialogTitle>
          <div className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
            {children}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

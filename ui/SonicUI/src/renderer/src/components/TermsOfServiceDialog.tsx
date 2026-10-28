import { useState } from 'react'
import { FileText, ShieldAlert } from 'lucide-react'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

export const TERMS_ACCEPTED_KEY = 'sonic-terms-accepted-1.0.0'

export function TermsOfServiceDialog({
  open,
  onOpenChange,
  mandatory = false,
  onAccept
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mandatory?: boolean
  onAccept?: () => void
}): React.JSX.Element {
  const [accepted, setAccepted] = useState(false)

  const acceptTerms = (): void => {
    try {
      window.localStorage.setItem(TERMS_ACCEPTED_KEY, '1')
    } catch {
      // The app can continue even if browser storage is unavailable.
    }
    onAccept?.()
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!mandatory || next) onOpenChange(next)
      }}
    >
      <DialogContent
        showCloseButton={!mandatory}
        className="flex max-h-[min(680px,calc(100%-2rem))] max-w-[600px] flex-col gap-0 overflow-y-auto p-0 sm:max-w-[600px]"
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-4">
          <FileText className="size-5 text-[var(--text-secondary)]" />
          <DialogTitle className="text-base font-semibold">Sonic Terms of Service</DialogTitle>
        </div>
        <div className="flex flex-col gap-4 px-5 py-5 text-sm">
          <p className="text-muted-foreground">
            Please read these basic terms before using Sonic Download Manager.
          </p>
          <section className="flex flex-col gap-1">
            <h3 className="font-semibold">1. Purpose of Sonic</h3>
            <p>
              Sonic is a download-management tool intended to help you organize downloads and
              improve transfer efficiency. It may use parallel connections, retries, and integrity
              checks where supported, but it cannot guarantee that every download will be faster,
              complete, available, or free of corruption.
            </p>
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="font-semibold">2. Your responsibility for downloaded content</h3>
            <p>
              You are solely responsible for the files, links, websites, and other content you
              choose to download or access through Sonic. You must ensure that your downloads comply
              with applicable laws, copyright and licensing terms, website rules, and any rights of
              other people. Do not use Sonic to obtain or distribute unlawful or unauthorized
              content.
            </p>
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="font-semibold">3. No responsibility for third-party content</h3>
            <p>
              Sonic does not control, endorse, or verify all content hosted by third parties. The
              developers and distributors of Sonic are not responsible for the nature, legality,
              safety, accuracy, or consequences of content you download, or for loss or damage
              arising from third-party websites, files, or services. Scan files with trusted
              security software and verify important downloads independently.
            </p>
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="font-semibold">4. Availability and limitations</h3>
            <p>
              Sonic is provided on an “as available” basis. To the extent permitted by applicable
              law, no guarantee is made that the application will be uninterrupted, error-free,
              secure, compatible with every source, or suitable for every purpose. Keep separate
              backups of important files and settings.
            </p>
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="font-semibold">5. Updates and changes</h3>
            <p>
              Features and these terms may change as Sonic develops. Your use of Sonic remains
              subject to applicable law. Nothing in these terms excludes rights or responsibilities
              that cannot legally be excluded in your jurisdiction.
            </p>
          </section>
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p className="text-xs text-muted-foreground">
              Important: Sonic helps manage downloads; it does not decide whether a download is
              lawful or safe. You decide what to download and are responsible for that choice.
            </p>
          </div>
          {mandatory && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.currentTarget.checked)}
                className="mt-1"
              />
              <span>I have read and agree to the Sonic Terms of Service.</span>
            </label>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          {!mandatory && (
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
          {mandatory && (
            <Button type="button" disabled={!accepted} onClick={acceptTerms}>
              I Agree and Continue
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

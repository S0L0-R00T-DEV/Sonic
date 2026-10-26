import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'
import { acceptedLink } from '../utils/format'

/** Opens New download with links handed to Sonic, for the user to look at and start. */
export function useOpenedLinks(): void {
  const receiveLinks = useAppStore((store) => store.receiveLinks)

  useEffect(() => {
    const unsubscribe = window.sonic.onLinkReceived(() => void receiveLinks())
    // Some may have arrived before the window was listening.
    void receiveLinks()
    return unsubscribe
  }, [receiveLinks])
}

const isMac = window.sonic.platform === 'darwin'

/** The ways into New download from anywhere in the window, as download managers have them:
 * pasting a link (outside a text field), ⌘N / Ctrl+N, and dropping a link or a .torrent. */
export function useNewDownloadShortcuts(): void {
  const openNewDownload = useAppStore((store) => store.openNewDownload)

  useEffect(() => {
    const busy = (target: EventTarget | null): boolean =>
      useAppStore.getState().newDownloadOpen ||
      (target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName)))

    const onPaste = (event: ClipboardEvent): void => {
      if (busy(event.target)) return
      const link = acceptedLink(event.clipboardData?.getData('text') ?? '')
      if (link) openNewDownload(link)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'n' || !(isMac ? event.metaKey : event.ctrlKey)) return
      if (useAppStore.getState().newDownloadOpen) return
      event.preventDefault()
      openNewDownload()
    }
    // Handle drops at the window capture phase so a .torrent works anywhere, including title-bar
    // edges and empty-state corners, before any child component can consume the event.
    const acceptExternalDrop = (event: DragEvent): void => {
      // On Windows, Explorer may not populate DataTransfer.files/types until late in the drag.
      // Accept dragenter AND dragover unconditionally so Chromium marks the window as a valid
      // native drop target instead of showing the prohibited/unavailable cursor.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (event: DragEvent): void => {
      // Always cancel the native default; only recognized torrent files and links are imported.
      event.preventDefault()
      const transfer = event.dataTransfer
      if (!transfer) return
      const file = Array.from(transfer.files).find((candidate) => /\.torrent$/i.test(candidate.name))
      if (file) {
        event.preventDefault()
        event.stopImmediatePropagation()
        const path = window.sonic.pathForFile(file)
        if (path) openNewDownload(path)
        return
      }
      const text = [transfer.getData('text/uri-list'), transfer.getData('text/plain'), transfer.getData('text')]
        .flatMap((value) => value.split(/\r?\n/))
        .map((value) => value.trim())
        .find((value) => value && !value.startsWith('#') && acceptedLink(value) !== null)
      if (text) {
        event.preventDefault()
        event.stopImmediatePropagation()
        openNewDownload(acceptedLink(text) ?? text)
      } else {
        // Prevent Electron from navigating to a dropped file or URL.
        event.preventDefault()
      }
    }

    window.addEventListener('paste', onPaste)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('dragenter', acceptExternalDrop, true)
    window.addEventListener('dragover', acceptExternalDrop, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('dragenter', acceptExternalDrop, true)
      window.removeEventListener('dragover', acceptExternalDrop, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [openNewDownload])
}

import { BrowserWindow, screen, shell } from 'electron'
import { stat } from 'node:fs/promises'
import type { ThemeSource } from '../shared/types'

interface CompletionToastOptions {
  title: string
  fileName: string
  path?: string
  sizeBytes?: number
  dedupeKey?: string
  themeSource: ThemeSource
  onOpenApp: () => void
}

const activeToasts = new Set<BrowserWindow>()
const seenCompletionKeys = new Set<string>()
const TOAST_WIDTH = 376
const TOAST_HEIGHT = 156
const TOAST_GAP = 10
const TOAST_MARGIN = 16

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function formatNotificationSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'Size unavailable'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes / 1024
  let unit = units[0]
  for (let index = 1; size >= 1024 && index < units.length; index++) {
    size /= 1024
    unit = units[index]
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${unit}`
}

function themeColors(theme: ThemeSource): {
  background: string
  foreground: string
  muted: string
  border: string
  accent: string
} {
  if (theme === 'light') {
    return {
      background: '#fffdf5',
      foreground: '#172033',
      muted: '#596579',
      border: '#d6deea',
      accent: '#1769c2'
    }
  }
  if (theme === 'dark') {
    return {
      background: '#050505',
      foreground: '#f5f7fb',
      muted: '#b5bdca',
      border: '#353535',
      accent: '#438cf5'
    }
  }
  return {
    background: '#081522',
    foreground: '#eef6ff',
    muted: '#b5c7da',
    border: '#23517a',
    accent: '#2688e8'
  }
}

async function openCompletedPath(path: string): Promise<void> {
  try {
    const details = await stat(path)
    if (details.isDirectory()) {
      const error = await shell.openPath(path)
      if (error) console.warn('[Sonic] could not open completed folder:', error)
      return
    }
  } catch (error) {
    console.warn('[Sonic] completed file is no longer available:', error)
    return
  }

  // Only recognized Windows launch/install packages get a Run-style action. Scripts and unknown
  // file types reveal their location instead, so a notification cannot silently execute them.
  if (/\.(exe|msi|com|msix|appx)$/i.test(path)) {
    const error = await shell.openPath(path)
    if (error) console.warn('[Sonic] could not launch completed installer:', error)
  } else {
    shell.showItemInFolder(path)
  }
}

export async function showCompletionToast(options: CompletionToastOptions): Promise<void> {
  const { title, fileName, path, themeSource, onOpenApp } = options
  if (options.dedupeKey) {
    if (seenCompletionKeys.has(options.dedupeKey)) return
    seenCompletionKeys.add(options.dedupeKey)
    if (seenCompletionKeys.size > 1000) {
      const oldest = seenCompletionKeys.values().next().value
      if (oldest) seenCompletionKeys.delete(oldest)
    }
  }
  const details = path ? await stat(path).catch(() => null) : null
  const sizeBytes = details?.isFile() ? details.size : options.sizeBytes
  const colors = themeColors(themeSource)

  // Bound the stack. Closing the oldest toast avoids overlap on small displays or rapid batches.
  if (activeToasts.size >= 4) {
    const oldest = activeToasts.values().next().value as BrowserWindow | undefined
    if (oldest && !oldest.isDestroyed()) {
      activeToasts.delete(oldest)
      oldest.close()
    }
  }

  const display = screen.getPrimaryDisplay()
  const workArea = display.workArea
  const toastWidth = Math.min(TOAST_WIDTH, Math.max(220, workArea.width - 2 * TOAST_MARGIN))
  const toastHeight = Math.min(TOAST_HEIGHT, Math.max(120, workArea.height - 2 * TOAST_MARGIN))
  const stackIndex = activeToasts.size
  const window = new BrowserWindow({
    width: toastWidth,
    height: toastHeight,
    x: workArea.x + workArea.width - toastWidth - TOAST_MARGIN,
    y:
      workArea.y +
      workArea.height -
      toastHeight -
      TOAST_MARGIN -
      stackIndex * (toastHeight + TOAST_GAP),
    show: false,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    movable: false,
    focusable: true,
    hasShadow: true,
    backgroundColor: colors.background,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  activeToasts.add(window)

  let timer: NodeJS.Timeout | undefined
  const closeTimer = (): void => {
    if (timer) clearTimeout(timer)
  }
  window.once('closed', () => {
    closeTimer()
    activeToasts.delete(window)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'sonic-notification://open') {
      if (path) void openCompletedPath(path)
    } else if (url === 'sonic-notification://focus') {
      onOpenApp()
    }
    if (!window.isDestroyed()) window.close()
    return { action: 'deny' }
  })

  const openButton = path
    ? `<button type="button" aria-label="Open" onclick="event.stopPropagation();window.open('sonic-notification://open')">Open</button>`
    : ''
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sonic notification</title>
<style>
:root{color-scheme:${themeSource === 'light' ? 'light' : 'dark'}}
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;overflow:hidden}
body{font-family:Segoe UI,system-ui,sans-serif;background:${colors.background};color:${colors.foreground};border:1px solid ${colors.border};border-radius:14px;cursor:pointer}
article{height:100%;display:flex;flex-direction:column;padding:14px 15px 13px;gap:7px}
header{display:flex;align-items:center;gap:9px;font-size:12px;color:${colors.muted};letter-spacing:.04em;text-transform:uppercase}
.mark{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:${colors.accent};color:white;font-weight:800;font-size:13px}
h1{margin:0;font-size:15px;line-height:1.2;font-weight:700}
p{margin:0;font-size:12px;line-height:1.35;color:${colors.muted};overflow-wrap:anywhere}
footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:auto}
.size{font-size:11px;color:${colors.muted};white-space:nowrap}
button{border:0;border-radius:8px;background:${colors.accent};color:white;padding:7px 16px;font:600 12px Segoe UI,system-ui,sans-serif;cursor:pointer}
button:hover{filter:brightness(1.08)}
button:focus-visible{outline:2px solid ${colors.foreground};outline-offset:2px}
</style>
</head>
<body onclick="window.open('sonic-notification://focus')">
<article>
<header><span class="mark">S</span><span>Sonic</span></header>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(fileName)}</p>
<footer><span class="size">${escapeHtml(formatNotificationSize(sizeBytes))}</span>${openButton}</footer>
</article>
</body>
</html>`

  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    if (window.isDestroyed()) return
    window.showInactive()
    timer = setTimeout(() => {
      if (!window.isDestroyed()) window.close()
    }, 10_000)
    timer.unref()
  } catch (error) {
    if (!window.isDestroyed()) window.close()
    console.warn('[Sonic] could not show completion notification:', error)
  }
}

import { app, BrowserWindow, nativeImage, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
let activeTray: Tray | null = null

function iconFileName(): string {
  // Keep Sonic's product identity consistent across themes, taskbar, and tray.
  return 'sonic-icon-blue.png'
}

/** Packaged assets live outside app.asar so Windows can load them as real image files. */
function iconCandidates(fileName: string): string[] {
  return [
    join(process.resourcesPath, 'app.asar.unpacked', 'resources', fileName),
    join(process.resourcesPath, 'resources', fileName),
    join(app.getAppPath(), 'resources', fileName),
    join(__dirname, '../../resources', fileName)
  ]
}

export function currentBrandIcon(): Electron.NativeImage {
  const name = iconFileName()
  for (const file of iconCandidates(name)) {
    if (!existsSync(file)) continue
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) return image
  }
  console.error('[Sonic branding] Could not load the theme icon:', name, iconCandidates(name))
  return nativeImage.createEmpty()
}

export function registerBrandTray(tray: Tray): void {
  activeTray = tray
  tray.setImage(currentBrandIcon())
}

export function setBrandTheme(): void {
  const image = currentBrandIcon()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setIcon(image)
  }
  if (activeTray && !activeTray.isDestroyed()) activeTray.setImage(image)
}

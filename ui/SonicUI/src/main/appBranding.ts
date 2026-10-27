import { app, BrowserWindow, nativeImage, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ThemeSource } from '../shared/types'
let activeTray: Tray | null = null
let activeThemeSource: ThemeSource = 'sonic'

function iconFileName(themeSource: ThemeSource): string {
  // Sonic mode uses the blue-and-white brand mark; each explicit appearance has its own icon.
  if (themeSource === 'light') return 'sonic-icon-red.png'
  if (themeSource === 'dark') return 'sonic-icon-black.png'
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

export function currentBrandIcon(
  themeSource: ThemeSource = activeThemeSource
): Electron.NativeImage {
  const name = iconFileName(themeSource)
  for (const file of iconCandidates(name)) {
    if (!existsSync(file)) continue
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) return image
  }
  console.error('[Sonic branding] Could not load the theme icon:', name, iconCandidates(name))
  return nativeImage.createEmpty()
}

export function registerBrandTray(tray: Tray, themeSource: ThemeSource = activeThemeSource): void {
  activeTray = tray
  tray.setImage(currentBrandIcon(themeSource))
}

export function setBrandTheme(themeSource: ThemeSource = activeThemeSource): void {
  activeThemeSource = themeSource
  const image = currentBrandIcon(themeSource)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setIcon(image)
  }
  if (activeTray && !activeTray.isDestroyed()) activeTray.setImage(image)
}

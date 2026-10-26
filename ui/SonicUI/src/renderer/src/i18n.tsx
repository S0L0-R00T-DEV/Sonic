/* eslint-disable react-refresh/only-export-components -- provider and hook intentionally share this module. */
/* English-only UI strings. Keep interpolation keys as {{name}}. */
import { createContext, useContext, useMemo, type ReactNode } from 'react'

export type Locale = 'en'
type LocaleContextValue = {
  locale: 'en'
  t: (key: string, values?: Record<string, string | number>) => string
}

const messages: Record<string, string> = {
  settings: 'Settings',
  openSettings: 'Open settings',
  closeWindow: 'Close window',
  minimizeWindow: 'Minimize window',
  maximizeWindow: 'Maximize or restore window',
  downloads: 'Downloads',
  newDownload: 'New download',
  batchImport: 'Batch import',
  searchDownloads: 'Search downloads',
  sortDownloads: 'Sort downloads',
  all: 'All',
  inProgress: 'In progress',
  finished: 'Finished',
  failed: 'Failed',
  history: 'History',
  networks: 'Networks',
  addDownload: 'Add download',
  downloadLink: 'Download link',
  destination: 'Destination',
  chooseFolder: 'Choose folder',
  startDownload: 'Start download',
  cancel: 'Cancel',
  save: 'Save',
  saving: 'Savingâ€¦',
  resetDefaults: 'Reset to defaults',
  settingsSaved: 'Settings saved',
  keyboardHelp: 'Keyboard navigation',
  downloadSchedule: 'Download schedule',
  downloadsAtOnce: 'Downloads at once',
  backupStorage: 'Backup and storage',
  exportBackup: 'Export backup',
  restoreBackup: 'Restore backup',
  remoteControl: 'Local Wi-Fi remote control',
  plugins: 'Plugins',
  close: 'Close',
  sortNewest: 'Newest first',
  sortOldest: 'Oldest first',
  sortName: 'Name',
  sortSize: 'Size',
  noDownloads: 'No downloads yet',
  selectAll: 'Select all',
  clearSelection: 'Clear selection',
  importLinks: 'Import links',
  mirrorSite: 'Mirror site',
  activeNetworks: 'Active networks',
  noActiveNetwork: 'No active network',
  browserIntegration: 'Browser extensions',
  browserIntegrationDescription:
    'Connect a Sonic browser extension to send direct download links and download-button clicks straight to Sonic Download Manager.',
  browserSetupStep1:
    '1. Press Open extensions and verify that this browser’s extension-management page opened.',
  browserSetupStep2:
    '2. In Chromium browsers, enable Developer mode (it may be at the top-left or top-right), then choose Load unpacked. Firefox uses Load Temporary Add-on instead.',
  browserSetupStep3:
    '3. Complete the browser-specific steps 4–7 shown below. Confirm Sonic is enabled in the browser extension list and turn on direct-download handoff in the extension settings.',
  openExtensions: 'Open extensions',
  copyExtensionPath: 'Copy extension folder path',
  opening: 'Opening...',
  noBrowserDetected:
    'No supported browser was detected in its standard installation folder. Install Brave, Chrome, Dia, Edge, Firefox, Opera, or Vivaldi, then restart Sonic. If your browser uses a custom install location, open its extension page manually; Sonic cannot open an undetected browser.',
  browserDetectError: 'Could not detect installed browsers: ',
  browserPageError: 'Could not open the browser extensions page.',
  browserFolderError: 'Could not find the bundled extension folder.',
  browserConnection: 'Extension connection',
  checkConnection: 'Check connection',
  connectionConnected: 'Connected: the extension checked in recently.',
  connectionNotConnected:
    'Not connected. Enable the Sonic extension, keep Sonic running, then check again.',
}
const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const value = useMemo<LocaleContextValue>(
    () => ({
      locale: 'en',
      t: (key, values) =>
        Object.entries(values ?? {}).reduce(
          (current, [name, value]) => current.split(`{{${name}}}`).join(String(value)),
          messages[key] ?? key
        )
    }),
    []
  )
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext)
  if (!value) throw new Error('useLocale must be used inside LocaleProvider')
  return value
}

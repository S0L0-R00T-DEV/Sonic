/** File extensions allowed during automatic browser capture. */
export type FileTypeMode = 'all' | 'allow' | 'deny'

/** Settings that govern whether a browser may automatically hand downloads to Sonic. */
export interface Settings {
  capture: boolean
  sites: string[]
  skipSmall: boolean
  minMegabytes: number
  fileTypeMode: FileTypeMode
  fileTypes: string[]
}

/** Capture is enabled after the user explicitly installs the extension; it can be disabled any time. */
export const DEFAULT_SETTINGS: Settings = {
  capture: true,
  sites: [],
  skipSmall: false,
  minMegabytes: 1,
  fileTypeMode: 'all',
  fileTypes: []
}

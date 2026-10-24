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

/** Automatic interception is opt-in; explicit context-menu handoffs still work while it is off. */
export const DEFAULT_SETTINGS: Settings = {
  capture: false,
  sites: [],
  skipSmall: false,
  minMegabytes: 1,
  fileTypeMode: 'all',
  fileTypes: []
}

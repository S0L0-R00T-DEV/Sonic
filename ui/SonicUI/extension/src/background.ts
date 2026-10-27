import { api } from './api'
import type { BridgeAddRequest } from '../../src/shared/browserBridge'
import { browserContext, confirm, reach, send, storeOf, wake, type Reach } from './sonic'
import { extractSelectedLinks, MAX_BATCH_URLS, uniqueSupportedLinks } from './linkSelection'
import { fileTypeAllowed } from './fileTypes'
import { excluded, loadSettings } from './settings'

const MENU_ID = 'download-with-sonic'
const IMAGE_MENU_ID = 'download-with-sonic-image'
const SELECTION_MENU_ID = 'download-with-sonic-selection'
const PAGE_MENU_ID = 'download-with-sonic-page'
const MAX_PARALLEL_HANDOFFS = 3
// Sonic can't tell the extension it has quit, so the toolbar icon checks on a timer.
const CHECK_ALARM = 'check-sonic'

const openedAt = new Map<number, number>()

const ICON = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' }
// A greyed-out icon rather than a badge: the browser draws badges too small to notice.
const ICON_OFF = { 16: 'icons/icon-off-16.png', 32: 'icons/icon-off-32.png' }

async function showState(reached?: Reach): Promise<void> {
  const { capture } = await loadSettings()
  reached ??= await reach()
  const title = !capture
    ? 'Sonic: capture is off'
    : reached === 'closed'
      ? 'Sonic isn’t open: downloads stay in the browser'
      : reached === 'update'
        ? 'Update Sonic to use this extension'
        : 'Sonic'
  await api.action.setIcon({ path: capture && reached === 'ok' ? ICON : ICON_OFF })
  await api.action.setTitle({ title })
}

/** True when Sonic took the download; otherwise the browser keeps it. */
async function capture(item: chrome.downloads.DownloadItem): Promise<boolean> {
  const settings = await loadSettings()
  const url = item.finalUrl || item.url
  // blob: and data: downloads exist only inside the browser.
  if (!settings.capture || !/^https?:/i.test(url)) return false
  if (excluded(settings.sites, [item.url, item.finalUrl, item.referrer])) return false
  if (!fileTypeAllowed(item.filename || url, settings.fileTypeMode, settings.fileTypes))
    return false

  const request: BridgeAddRequest = {
    url,
    autoStart: settings.autoStart,
    browser: await browserContext([item.url, item.finalUrl], storeOf(item), item.referrer),
    pageUrl: item.referrer || undefined,
    minBytes: settings.skipSmall ? settings.minMegabytes * 1024 * 1024 : undefined,
    // Chrome and Firefox both give a path here.
    fileName: item.filename.split(/[\\/]/).pop() || undefined
  }
  const handoff = await send(request)
  if (typeof handoff === 'string') {
    if (handoff === 'closed') await showState('closed')
    return false
  }
  // Sonic shows the download only once the browser's copy is gone. Firefox can't hold a download
  // while Sonic checks it, so a small one may have finished meanwhile: cancelling then does
  // nothing, and the browser keeps it rather than both ending up with it.
  await api.downloads.cancel(item.id).catch(() => {})
  const [after] = await api.downloads.search({ id: item.id }).catch(() => [])
  if (after?.state === 'complete') return false
  await api.downloads.erase({ id: item.id }).catch(() => {})
  const shown = await confirm(handoff)
  await closeEmptyTab([item.url, item.finalUrl])
  await showState(shown ? 'ok' : undefined)
  return true
}

/** A link that opens a tab only to download leaves that tab empty once Sonic takes it. */
async function closeEmptyTab(urls: readonly (string | undefined)[]): Promise<void> {
  const recently = Date.now() - 30_000
  // Only inspect tabs this extension observed being opened recently; don't enumerate every tab.
  // This avoids the broad `tabs` permission while preserving the empty-download-tab cleanup.
  for (const [tabId, createdAt] of openedAt) {
    if (createdAt < recently) {
      openedAt.delete(tabId)
      continue
    }
    const tab = await api.tabs.get(tabId).catch(() => undefined)
    const shows = tab?.pendingUrl ?? tab?.url
    if (shows === undefined || !urls.includes(shows)) continue
    await api.tabs.remove(tabId).catch(() => {})
    openedAt.delete(tabId)
  }
}

// Tor has a response-header interceptor that can decide before the native download UI starts.
// Running the normal downloads listener as well races that handoff and can submit the same URL twice.
// All other browsers retain their existing downloads API path.
const isTorExtension = /Tor Browser/i.test(api.runtime.getManifest().name)
const determining = api.downloads.onDeterminingFilename
if (!isTorExtension && determining) {
  determining.addListener((item, suggest) => {
    void capture(item).then((taken) => taken || suggest())
    return true
  })
} else if (!isTorExtension) {
  api.downloads.onCreated.addListener((item) => void capture(item))
} else {
  console.info('[Sonic Tor] Using response-header interception for automatic downloads.')
}

/** Deliberate context-menu actions are user-approved and can override automatic capture rules. */
async function handoffOne(
  url: string,
  tab: chrome.tabs.Tab | undefined,
  pageUrl: string | undefined
): Promise<boolean> {
  const settings = await loadSettings()
  const request: BridgeAddRequest = /^magnet:/i.test(url)
    ? { url, autoStart: settings.autoStart }
    : {
        url,
        autoStart: settings.autoStart,
        browser: await browserContext([url], tab && storeOf(tab), pageUrl),
        pageUrl
      }
  let sent = await send(request)
  if (sent === 'closed' && (await wake())) sent = await send(request)
  return typeof sent !== 'string' && (await confirm(sent))
}

/** Batches remain bounded and send only a few probes concurrently to avoid flooding Sonic. */
async function handoffMany(
  candidates: readonly string[],
  tab: chrome.tabs.Tab | undefined,
  pageUrl: string | undefined
): Promise<void> {
  const urls = uniqueSupportedLinks(candidates, pageUrl)
  let taken = 0
  for (let offset = 0; offset < urls.length; offset += MAX_PARALLEL_HANDOFFS) {
    const chunk = urls.slice(offset, offset + MAX_PARALLEL_HANDOFFS)
    const results = await Promise.all(
      chunk.map((url) => handoffOne(url, tab, pageUrl).catch(() => false))
    )
    taken += results.filter(Boolean).length
  }
  await showState(taken > 0 ? 'ok' : undefined)
}

/** Send the clicked link or image URL; no original browser transfer needs cancelling. */
async function sendLink(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): Promise<void> {
  const url = info.linkUrl
  if (url) await handoffMany([url], tab, info.pageUrl ?? tab?.url)
}

async function sendImage(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): Promise<void> {
  const url = info.srcUrl
  if (url) await handoffMany([url], tab, info.pageUrl ?? tab?.url)
}

async function sendSelection(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): Promise<void> {
  await handoffMany(extractSelectedLinks(info.selectionText ?? ''), tab, info.pageUrl ?? tab?.url)
}

/** Runs only after an explicit page context-menu click, and passes links through validation/cap. */
async function sendPageLinks(tab?: chrome.tabs.Tab): Promise<void> {
  if (tab?.id === undefined) {
    await showState()
    return
  }
  try {
    const results = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: () =>
        Array.from(document.querySelectorAll('a[href]'), (node) => (node as HTMLAnchorElement).href)
    })
    const candidates = results.flatMap((result) =>
      Array.isArray(result.result)
        ? result.result.filter((value): value is string => typeof value === 'string')
        : []
    )
    await handoffMany(candidates, tab, tab.url)
  } catch {
    // Browser internal pages and protected tabs don't permit script injection; don't disrupt them.
    await showState()
  }
}

// Run on install and on every browser start: menus and alarms don't always survive a restart.
function setUp(): void {
  createMenu()
  void api.alarms.create(CHECK_ALARM, { periodInMinutes: 0.5 })
  void showState()
}

function createMenu(): void {
  void api.contextMenus.removeAll().then(() => {
    api.contextMenus.create({
      id: MENU_ID,
      title: 'Download with Sonic',
      contexts: ['link']
    })
    api.contextMenus.create({
      id: IMAGE_MENU_ID,
      title: 'Download image with Sonic',
      contexts: ['image']
    })
    api.contextMenus.create({
      id: SELECTION_MENU_ID,
      title: 'Download selected URLs with Sonic',
      contexts: ['selection']
    })
    api.contextMenus.create({
      id: PAGE_MENU_ID,
      title: `Download up to ${MAX_BATCH_URLS} links on this page with Sonic`,
      contexts: ['page']
    })
  })
}

api.runtime.onInstalled.addListener(setUp)
api.runtime.onStartup.addListener(setUp)
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) void showState()
})
api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) void sendLink(info, tab)
  else if (info.menuItemId === IMAGE_MENU_ID) void sendImage(info, tab)
  else if (info.menuItemId === SELECTION_MENU_ID) void sendSelection(info, tab)
  else if (info.menuItemId === PAGE_MENU_ID) void sendPageLinks(tab)
})
api.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) openedAt.set(tab.id, Date.now())
})
api.storage.onChanged.addListener(() => void showState())

api.runtime.onMessage.addListener((message) => {
  const { wakeSonic, checkSonic } = message as { wakeSonic?: boolean; checkSonic?: boolean }
  if (checkSonic) void showState()
  if (wakeSonic) void wake().then((woke) => showState(woke ? 'ok' : 'closed'))
})

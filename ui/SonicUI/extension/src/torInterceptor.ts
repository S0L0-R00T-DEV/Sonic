import { api } from './api'
import { browserContext, confirm, send } from './sonic'
import type { BridgeAddRequest } from '../../src/shared/browserBridge'

type TorResponseDetails = chrome.webRequest.OnHeadersReceivedDetails & {
  originUrl?: string
  documentUrl?: string
  cookieStoreId?: string
}

/** Read a response header without assuming the server supplied it. */
function headerValue(headers: chrome.webRequest.HttpHeader[] | undefined, name: string): string {
  const header = headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())
  return typeof header?.value === 'string' ? header.value : ''
}

/** Only intercept explicit attachments or binary responses likely to be direct downloads. */
function isDownloadResponse(details: TorResponseDetails): boolean {
  const disposition = headerValue(details.responseHeaders, 'content-disposition')
  if (/\battachment\b/i.test(disposition)) return true

  // A binary MIME type is only a useful signal for navigations or download-like requests;
  // do not capture embedded images, scripts, stylesheets, or media streams.
  if (!['main_frame', 'sub_frame', 'other', 'xmlhttprequest'].includes(details.type)) return false
  const mime = headerValue(details.responseHeaders, 'content-type').split(';', 1)[0].trim().toLowerCase()
  return [
    'application/octet-stream', 'application/zip', 'application/x-zip-compressed',
    'application/x-7z-compressed', 'application/x-rar-compressed', 'application/x-tar',
    'application/gzip', 'application/x-gzip', 'application/x-msdownload',
    'application/vnd.microsoft.portable-executable', 'application/pdf',
    'application/x-bittorrent'
  ].includes(mime)
}

console.info('[Sonic Tor] Response-header interceptor loaded.', api.runtime.getManifest().version)

const torHeaderListener = (async (
  details: TorResponseDetails
): Promise<chrome.webRequest.BlockingResponse> => {
  if (details.method !== 'GET' || !isDownloadResponse(details)) return {}

  let parsed: URL
  try {
    parsed = new URL(details.url)
  } catch {
    return {}
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return {}

  // Sonic is not routed through Tor, so leave onion-service downloads inside Tor Browser.
  if (parsed.hostname.toLowerCase().endsWith('.onion')) {
    console.info('[Sonic Tor] Keeping .onion download inside Tor Browser.')
    return {}
  }

  console.info('[Sonic Tor] Candidate download detected:', details.type, parsed.hostname)
  try {
    const referrer = details.originUrl || details.documentUrl || undefined
    const request: BridgeAddRequest = {
      url: details.url,
      browser: await browserContext([details.url], details.cookieStoreId, referrer),
      pageUrl: referrer
    }

    const handoff = await send(request)
    if (typeof handoff === 'string') {
      console.warn('[Sonic Tor] Sonic did not accept the handoff:', handoff)
      return {}
    }

    const accepted = await confirm(handoff)
    if (!accepted) {
      console.warn('[Sonic Tor] Sonic did not confirm the handoff; letting Tor continue.')
      return {}
    }

    console.info('[Sonic Tor] Sonic accepted the download; cancelling Tor response.')
    return { cancel: true }
  } catch (error) {
    console.error('[Sonic Tor] Interception failed; allowing Tor to continue:', error)
    return {}
  }
}) as unknown as Parameters<typeof api.webRequest.onHeadersReceived.addListener>[0]

// Firefox/Tor supports asynchronous blocking listeners. Chromium's type definitions only describe
// synchronous BlockingResponse listeners, so the listener is cast to the event's declared type.
api.webRequest.onHeadersReceived.addListener(
  torHeaderListener,
  {
    urls: ['<all_urls>'],
    types: ['main_frame', 'sub_frame', 'other', 'xmlhttprequest']
  },
  ['blocking', 'responseHeaders']
)

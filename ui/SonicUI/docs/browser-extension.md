# Browser extension integration

Sonic includes a browser extension and a loopback-only bridge for Chromium-compatible browsers (including Chrome and Edge) and Firefox. The extension build produces separate packages under `extension/dist/chrome` and `extension/dist/firefox`.

## Install for local testing

1. From the SonicUI project directory, run `npm run build:extension`.
2. For Chrome or Edge, open the browser's extensions page, enable Developer mode, and choose **Load unpacked**. Select `extension/dist/chrome`.
3. For Firefox, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extension/dist/firefox/manifest.json`. A temporary add-on must be loaded again after Firefox restarts.
4. Start Sonic. Open the extension's popup and turn on **Capture downloads** only if you want automatic interception. It is off by default. With capture off, ordinary downloads stay in the browser; intentional right-click handoffs remain available for links, images, selected URLs, or a page's links.
5. In extension options, choose whether automatic capture applies to all file types, only listed extensions, or all except listed extensions. The existing site-exclusion list keeps downloads from those sites in the browser. These filters only govern automatic capture; a deliberate context-menu handoff remains a user override.

## Privacy and handoff behavior

- The browser requests the extension permissions needed for download interception, context menus, site cookies, and website access. Review those browser permission prompts before installing.
- Automatic interception is opt-in and can be switched off at any time. Site exclusions and the skip-small-files option are available in extension options.
- Cookies and the browser user agent are collected for a selected download handoff so sign-in-protected files can work. Sonic filters cookies by domain/path/security rules before sending them to a destination. Use context-menu commands only for content you intend to send.
- The page-link command runs only after an explicit click, reads anchor URLs from the active page, filters unsafe/unsupported URLs, deduplicates and caps the handoff at 50 links. It does not start the downloads automatically.
- The bridge binds to `127.0.0.1` and uses a short-lived, random, one-time confirmation token. Web-page origins are rejected. The token must be confirmed before the link is offered to Sonic; the link is shown for review and does not start automatically.
- If Sonic is unavailable, the browser keeps its download. Blob/data URLs and streams that cannot be probed as supported HTTP(S) downloads are not automatically handed off.

## Verification coverage

`e2e/browserBridge.spec.ts` checks that ordinary web-page origins are rejected, the extension preflight is allowed, a one-time token can be confirmed once, and handoff only fills the composer. `e2e/contextMenuRules.spec.ts` checks URL filtering/deduplication, the 50-link cap, selected-text extraction, and file-extension allow/deny rules. `e2e/browserExtensionSettings.spec.ts` verifies automatic interception defaults to off. These automated tests exercise the bridge and rule helpers; they are not a substitute for manual compatibility testing in every browser/version.

# Sonic Browser Extension (Local Installation)

Sonic includes local browser-extension builds; no paid extension-store account is required to use them.

## Brave, Chrome, Edge, Opera, and other Chromium browsers

1. Open `brave://extensions` in Brave (or the browser's equivalent extensions page).
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Select the `chrome` folder inside Sonic's `resources\browser-extensions` directory. For a development checkout, use `extension\dist\chrome` in the Sonic source folder.
5. Pin **Sonic Download Manager** to the toolbar and confirm the extension popup shows Sonic is reachable.

## Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on** and choose `manifest.json` inside the `firefox` folder in `resources\browser-extensions` (or `extension\dist\firefox` in a development checkout).
3. Temporary add-ons are removed when Firefox restarts. A persistent release installation requires Firefox's normal signing/distribution process; Sonic cannot bypass browser policy.

## Automatic handoff

Automatic capture is off by default. Enable it in the extension popup/options only if you want supported HTTP(S) downloads handed to Sonic instead of the browser. When Sonic is running and reachable, supported downloads are handed to Sonic; if Sonic is unavailable or the handoff fails, the browser download is retained. Context-menu actions are available as a manual fallback.

Browser security requires a one-time user-approved extension install. Sonic cannot silently install an extension into Brave or other browsers. Blob/data URLs, protected streams, browser-internal pages, and some login/session-bound downloads cannot always be handed off; these stay in the browser rather than being promised as universally supported.

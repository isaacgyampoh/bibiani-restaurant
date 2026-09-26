# MY FOOD — desktop POS: decision and plan

## What a till needs

- **Must have:**
  - fast startup, full screen, touch and keyboard;
  - stable pairing;
  - clear online and offline state;
  - automatic updates;
  - receipt and kitchen printing;
  - a cash drawer kick;
  - a browser fallback.
- **Later:** safe offline operation.

## What exists today (and works)

- **The POS is a web app.** It already runs full screen, with touch targets of 44 px or more, keyboard focus, PIN sign-in, and an idle lock.
- **Printing is already hardware-independent.** The server renders every receipt and kitchen ticket as a printer-agnostic document. The **print agent** (`apps/print-agent`, Node) runs on one computer on the restaurant network. It prints to ESC/POS network printers (IP:9100) with the logo raster, retries, and reports failures. Nothing in the POS is tied to one printer model.
- **Cash drawers** normally open through the receipt printer: an ESC/POS "drawer kick" pulse on the printer's RJ-11 port. That belongs in the print agent, not in the POS window.
- **Duplicate safety.** Every order, kitchen send and payment carries an id generated on the device, so a retry after a dropped connection never duplicates anything. Proven by the browser tests "response lost after the server saved the order" and "API unreachable during send".

## Options considered

| Option | Printing and cash drawer | Updates | Size | Security | Fit |
|---|---|---|---|---|---|
| **Installable web app (PWA)**: Chrome or Edge "Install app" | Through the print agent (network printers). The browser itself cannot reach USB printers | Automatic with every release (it *is* the release) | None to install | Browser sandbox; same security headers as the site | **Chosen for now** |
| **Electron wrapper** | Direct USB/serial printing and drawer kick in the main process; can bundle the print agent | electron-updater (needs code signing for Windows) | about 90–120 MB | Node in the main process: must be locked down (context isolation, no remote content with Node) | Best when a till needs a **USB-only** printer or drawer |
| **Tauri wrapper** | Rust side for USB/serial; smaller | Built-in updater (signing) | about 5–15 MB | Smaller attack surface | Good, but adds a Rust toolchain the team does not use today |

## Decision

**Phase 1 (this release): the installable app.** No new framework.

- The manifest is complete: name, icons, a maskable icon, standalone window, and shortcuts to POS, Kitchen screen and Customer display.
- **Install MY FOOD on this computer** appears on the pairing screen and in Settings → POS when the browser offers installation.
- Installed, MY FOOD opens in its own window with the MY FOOD icon and updates itself with each release.
- Printing and the drawer go through the print agent.
- The ordinary browser stays available as a fallback.

**Phase 2 (when real hardware is on site): an Electron shell**, only if the restaurant's printer or cash drawer is **USB-only**.

- It would load the production app in a locked-down window, in kiosk mode.
- The print agent would be bundled as a background service, adding USB/serial transport and the ESC/POS drawer kick.
- The device login would be stored in the operating system's secure storage instead of browser storage.
- Signed Windows installer, with electron-updater.
- It keeps the same pairing flow: "Pair this device" shows a code.
- Electron is recommended over Tauri here because the print agent is already Node/TypeScript, and a second language and toolchain would add maintenance.

**Not built yet, deliberately:** building an Electron app without the actual printer and drawer to test against would ship untested hardware claims.

## Offline strategy

**Today:**
- the POS shows its connection state ("Live", "Reconnecting…");
- retries never duplicate orders or payments;
- operations fail visibly, never silently;
- an unsent cart is lost if the page is reloaded. This is a known limitation, documented by a browser test.

**Next phase, to build carefully and test:**
1. Cache the menu and device configuration locally.
2. Keep the current cart in device storage (not a secret), so a reload or crash doesn't lose it.
3. Queue order submissions and kitchen sends with the existing **outbox** (`packages/client-core/src/outbox.ts`). It is already written and tested: durable, ordered per order, never drops operations, and flags permanent failures for a person. Sending on reconnect is safe because the server is idempotent.
4. **Payments stay online-only** unless card or mobile-money providers support offline confirmation. Cash taken offline would be recorded as "pending sync", with a clear banner.
5. Show a clear **Offline — orders will be sent when the connection returns** state, and the number of queued items.

## Status

| Item | Status |
|---|---|
| Installable app (manifest, icons, shortcuts, install button) | Implemented. Not yet tested on a Windows till |
| Printing (network ESC/POS via print agent) | Implemented and tested with the document model. **Physical printer not tested** (no hardware) |
| Cash drawer | **Not implemented** (needs the printer model; ESC/POS drawer kick in the print agent) |
| Electron desktop shell | **Not built** (Phase 2, when hardware is available) |
| Offline operation | **Not implemented** beyond duplicate-safe retries (next phase, above) |

# MY FOOD — desktop: the MY FOOD Hub for Windows

## Decision

- **Windows only.**
- **One MY FOOD Hub PC per restaurant.** Tills, kitchen screens and the customer display open MY FOOD from the hub over the restaurant network, so they keep working without internet. See [OFFLINE-ARCHITECTURE.md](OFFLINE-ARCHITECTURE.md).
- **Electron, not Tauri.** Everything the hub runs is already TypeScript/Node: the application layer, the API, the print agent, and PGlite (the embedded Postgres). Electron runs it in-process. Tauri would need a Node sidecar plus a Rust toolchain.
- **One web app everywhere.** Tills and screens use the same web app as the cloud. There is no second POS to maintain.

## What the Windows app does

`apps/desktop`:
- **Runs the hub:**
  - local database (created and migrated automatically; upgrades apply only new migrations);
  - the MY FOOD API;
  - the web app on port 8080 of the PC;
  - the print agent;
  - sync with the cloud.
- **Shows the hub window:**
  - connection to MY FOOD;
  - "All sent" or changes waiting;
  - the address tills should open;
  - devices, and pairing approvals with a manager PIN.
- **Pairs itself with the cloud on first start.** It shows a code; a manager enters it in the back office on the device of type *MY FOOD Hub*.
- **Keeps running in the tray** when the window is closed. The tray menu has *Open MY FOOD Hub*, *Open a till on this computer*, and *Quit (tills stop working)*.
- **Starts with Windows.** Single instance.
- **Keeps its secrets** (token key, PIN key) encrypted with the Windows key store. No secret is built into the installer; only public values are (cloud address, Supabase URL and anon key).
- **Updates:** checks GitHub Releases for new versions (electron-updater).
- **Logs** to `%APPDATA%\myfood-hub\hub\hub.log`.

## Building the installer

- **From GitHub:** Actions → **MY FOOD Hub (Windows installer)** → *Run workflow*. It builds on a Windows machine and attaches `MY FOOD Hub Setup <version>.exe` to the run.
  - It needs two repository **variables** (public values): `PROD_SUPABASE_URL` and `PROD_SUPABASE_ANON_KEY`.
- **Locally:** `pnpm --filter @rp/desktop dist:win`. On a Windows machine this is the full build; on a Mac, pass `-c.win.signAndEditExecutable=false`.

## Setting up the hub PC

1. Use an always-on Windows 10 or 11 PC on the restaurant network, wired if possible. Give it a fixed IP address in the router.
2. Install *MY FOOD Hub Setup*. Until a code-signing certificate is bought, Windows SmartScreen shows a warning; choose *More info → Run anyway*.
3. In the back office, **Devices & printing**:
   - add a device of type **MY FOOD Hub**;
   - press *Enter code from device* and type the code the hub window shows;
   - then press **Run branch from hub**. Finish any open web POS orders first; the system checks this.
4. On each till, kitchen screen and customer display, open the address the hub window shows (e.g. `http://192.168.1.20:8080`) in Chrome or Edge. Each shows a code: approve it in the hub window with a manager PIN.
5. Staff sign in once with their PIN while the internet is on. After that their PIN also works offline.

## Status

| Item | Status |
|---|---|
| Hub (API, database, sync, offline PIN, web on LAN) | Built and tested (automated, HTTP and real-browser tests) |
| Windows app and installer | Built. The package contents were verified (PGlite and migrations load from the shipped app). **Not yet installed on a Windows PC** |
| Code signing | Not yet (needs a certificate) |
| Network ESC/POS printing from the hub | Built; **no physical printer tested** |
| USB printers, cash drawer | Not built (needs the restaurant's hardware) |
| macOS / Linux hub | Not offered (Windows only) |

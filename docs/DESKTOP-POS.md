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
- **Tray and start-up (as designed; to be confirmed on the hub PC, see [HARDWARE-ACCEPTANCE.md](HARDWARE-ACCEPTANCE.md) §1):**
  - Closing the window hides it; the hub keeps running in the tray.
  - The tray menu has *Open MY FOOD Hub*, *Open a till on this computer*, and *Quit (tills stop working)*.
  - It starts when this Windows account signs in.
  - Starting it a second time only brings the running hub's window forward.
- **Secrets:** the token key and PIN key are generated on the PC at first start and kept encrypted with the Windows key store (DPAPI) in `secrets.bin`. The installer contains no secret, only public values (cloud address, Supabase URL and anon key). If the hub runs under a different Windows account than the one that set it up, it cannot read its keys and says so.
- **Updates:** a production hub checks GitHub Releases for newer versions. No releases are published yet, so today an update means installing the new installer over the old one; data is kept.
- **Logs:** `%APPDATA%\myfood-hub\hub\hub.log`. They contain events, never PINs, keys or session tokens (checked by an automated test).

## Production and test installers

| | Production | Test |
|---|---|---|
| Built by | GitHub Actions → **MY FOOD Hub (Windows installer)** only | `pnpm --filter @rp/desktop dist:win:test` |
| Talks to | Production cloud; the build **refuses** other Supabase projects, and refuses a cloud address that does not report "production" | Staging |
| Name | **MY FOOD Hub**, `MY-FOOD-Hub-Setup-<version>-production.exe` | **MY FOOD Hub (TEST)** everywhere, `MY-FOOD-Hub-TEST-Setup-<version>.exe`, a TEST badge in the hub window, and its own data folder |
| After build | The workflow checks the app contains the production project and no staging values, then uploads artifact `MY-FOOD-Hub-production-<commit>` | Never given to the restaurant |

## Building the production installer

1. **One-time: add the repository variables.** These are public values, the same as in the web app, so they go under **Variables**, not Secrets:
   - GitHub → repository **isaacgyampoh/bibiani-restaurant** → **Settings** → **Secrets and variables** → **Actions** → tab **Variables** → **New repository variable**;
   - `PROD_SUPABASE_URL` = `https://lgoirbfyspuflqekrcgp.supabase.co`;
   - `PROD_SUPABASE_ANON_KEY` = the production **anon (public)** key: Supabase dashboard → project → Settings → API. **Never the service-role key.**
2. GitHub → **Actions** → **MY FOOD Hub (Windows installer)** → **Run workflow** (branch `main`; keep the default cloud address).
3. When it finishes, download the artifact `MY-FOOD-Hub-production-<commit>`. It contains `MY-FOOD-Hub-Setup-<version>-production.exe`.

If the variables are missing, the workflow stops and says which ones to add.

## Code signing

- **Current status:** the Windows installer is functional but **unsigned**. Windows SmartScreen shows "Windows protected your PC" on first run; choose **More info → Run anyway**.
- **Future:** buy a Windows code-signing certificate (for example, an EV or OV certificate from a certificate authority, or a cloud signing service), then configure signing in the GitHub Actions workflow. Nothing is purchased or configured yet.

## Setting up the hub PC

1. Use an always-on Windows 10 or 11 PC on the restaurant network, wired if possible. Give it a fixed IP address in the router.
2. Install `MY-FOOD-Hub-Setup-<version>-production.exe` (from the workflow above). Windows SmartScreen shows a warning because the installer is unsigned; choose *More info → Run anyway*. When Windows Firewall asks, allow MY FOOD Hub on **private** networks (tills reach it on port 8080).
3. In the back office, **Devices & printing**:
   - add a device of type **MY FOOD Hub**;
   - press *Enter code from device* and type the code the hub window shows;
   - then press **Run branch from hub**. Finish any open web POS orders first; the system checks this.
4. On each till, kitchen screen and customer display, open the address the hub window shows (e.g. `http://192.168.1.20:8080`) in Chrome or Edge. Each shows a code: approve it in the hub window with a manager PIN.
5. Staff sign in once with their PIN while the internet is on. After that their PIN also works offline.
6. Run the on-site acceptance test: [HARDWARE-ACCEPTANCE.md](HARDWARE-ACCEPTANCE.md).

## Status

| Item | Status |
|---|---|
| Hub (API, database, sync, offline PIN, web on LAN) | **Verified in software** (automated, HTTP and real-browser tests) |
| Printing through the hub over the network, with failure, retry and backup | **Verified in software** with simulated network printers (`apps/hub/test/hub-printing.test.ts`). **No physical printer tested yet** |
| Windows app and installer | Built. Package contents verified (PGlite and migrations load from the shipped app). **Not yet installed on a Windows PC** |
| Windows key store, tray, start with Windows, single instance | Implemented; **not yet verified on Windows** |
| Production installer from GitHub Actions | Workflow ready and guarded. **Not yet run** (needs the two repository variables) |
| Code signing | **Not implemented** (needs a certificate) |
| USB printers | **Not implemented.** Use Ethernet (network) receipt printers |
| Cash drawer | **Not implemented.** A diagnostic can check on site whether the printer opens the drawer (`pnpm hardware:printer-check <ip> --drawer`) |
| macOS / Linux hub | Not offered (Windows only) |

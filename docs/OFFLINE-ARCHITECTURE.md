# MY FOOD — offline architecture (in-store hub)

Status markers: **[built]** implemented and tested · **[in progress]** partly built · **[planned]** designed, not built yet.
This document is updated as each part lands; nothing marked [planned] may be described to the client as available.

## Decision

One **MY FOOD Hub** per restaurant branch: an always-on Windows PC running the MY FOOD desktop app. (Decided with the owner on 2026-09-26, over "every till independent".)

```
             Supabase (production)          ← back office, reports, remote access, backups
                    ▲  sync (HTTPS, when internet is up)
                    │
        ┌───────────┴────────────┐
        │   MY FOOD Hub (PC)     │  local database · same MY FOOD API · same web app
        │                        │  print queue + print agent · sync engine · offline PIN check
        └───┬─────────┬──────────┘
   restaurant LAN / Wi-Fi (works without internet)
        │         │          │            │
     Tills     Kitchen    Customer     Printers
     (POS)     screens    display     (ESC/POS, IP:9100)
```

No new cloud service: Cloudflare (DNS) → Vercel (app) → Supabase (data). The hub is software on the restaurant's own PC.

## Why this shape

- **Same engine everywhere.** The hub runs the existing application layer (orders, pricing, promotions, routing, tickets, payments, stock, audit) and the existing HTTP API, unchanged, on an embedded Postgres (**PGlite**) created from the same migrations. There is no second order, routing, inventory or auth engine. The test suite already runs these migrations and use cases on PGlite.
- **Why PGlite over SQLite.** About 3,700 lines of repository SQL are Postgres. SQLite would need a second implementation of every repository; PGlite runs them as they are. The local database holds only this branch's data (below), not a copy of the cloud.
- **Why Electron over Tauri.** Everything the hub runs is TypeScript/Node (application layer, API, print agent). Electron runs it in-process. Tauri would need a Node sidecar anyway, plus a Rust toolchain.
- **No mode switch.** In a hub branch the floor always works through the hub, online or offline, so there is no risky "switch to offline" moment in the middle of service. Internet only changes how quickly data reaches the cloud.

## Who is authoritative

| Data | Authority | Direction |
|---|---|---|
| Menu, prices, promotions, categories, modifiers, taxes | Cloud (owner edits in the back office) | Cloud → hub (snapshot) |
| Staff, roles, stations, devices, printers, routing, floor | Cloud | Cloud → hub |
| Inventory items and recipes | Cloud | Cloud → hub |
| Orders, rounds, items, kitchen tickets, payments, discounts, table status, order numbers | **Hub** (for its branch) | Hub → cloud |
| Sale stock movements (and their reversals) | Hub | Hub → cloud, applied as a delta |
| Deliveries, waste, adjustments, stock counts (back office) | Cloud | Cloud → hub, applied as a delta |
| Audit events, order/ticket events | Where they happen | Both, deduplicated by origin id |

The cloud refuses floor writes for a branch while a hub operates it. The owner has an emergency switch that detaches the hub; the web POS then takes over again.

## Conflict rules (explicit, not timestamp-based)

- **Price changed while the hub was offline.** The sale keeps the price actually charged, which is stored on the order line. The cloud never re-prices a synced order. The new price reaches the hub with the next snapshot and applies to new orders only.
- **Product sold out in the back office while offline.** Orders already taken stay valid (they were sold). The next snapshot marks the product sold out for new orders.
- **Staff deactivated, or their permissions changed, while offline.**
  - The hub's offline sign-in list expires. After reconnecting, the snapshot removes or changes that person, and their PIN stops working on the hub at once.
  - Sales they made offline are kept and audited as made by them.
- **Order numbers.** Only the hub numbers its branch's orders, so numbers cannot collide. Order IDs are UUIDs generated at creation.
- **Stock.** Movements have stable IDs and are applied exactly once on each side as a quantity change. The quantity itself is never copied across, so neither side overwrites the other.
- **Duplicates.** Every upload is an upsert by primary key, or by origin ID for event tables. Uploading the same batch twice changes nothing.

## Sync engine

Hub-side change capture writes one outbox row per changed floor record. The engine uploads batches in order. Each batch carries a stable batch ID; the cloud applies it in one transaction and returns an acknowledgement.

Statuses:
- `PENDING`: waiting to upload;
- `SYNCING`: being uploaded;
- `SYNCED`: acknowledged by the cloud;
- `RETRYING` / `FAILED`: backing off, with the last error kept;
- `CONFLICT`: the cloud refused a record. It is kept and shown for a manager, never dropped.

## Offline staff sign-in

- The environment-wide PIN key stays in the cloud and is never sent to a hub.
- When a staff member signs in on the hub while online, the cloud verifies the PIN. The hub then stores its own slow hash of that PIN (scrypt with a per-hub salt), encrypted with a key held in the Windows credential store.
- Offline, the hub checks that stored hash. It keeps its own lockout, and the staff member's role and permissions come from the last snapshot. Offline authorisations expire after a set number of days without sync.
- **Limit:** a person who has never signed in on this hub while online cannot sign in offline.

## Payments offline

- Cash is recorded normally.
- MoMo and card are manual records in MY FOOD (ADR 0002): the cashier records them only after the customer's payment shows as confirmed on the phone or card terminal. Those confirmations do not depend on the restaurant's internet.
- A payment recorded on the hub shows as "not yet synced" until the cloud acknowledges it. MY FOOD never marks an unconfirmed provider payment as settled.

## Local devices

- Tills, kitchen screens and the customer display open the app from the hub's address on the local network. The web app is the same build.
- They pair with the hub using the same show-a-code flow.
- Updates arrive by frequent polling from the hub, since Supabase Realtime isn't available offline.
- The print agent runs inside the hub and prints to network printers on the LAN.

## Build status (2026-09-26)

| Part | Status | Where |
|---|---|---|
| Stations with screen only, printer only, both, or neither | [built] | `station-outputs.test.ts` |
| Test print; printer on/off | [built] | Devices & printing |
| Hub core: same application and API on local PGlite, incremental migrations | [built] | `packages/hub`, `apps/hub` |
| Cloud snapshot for hubs (config down), stock movements both ways | [built] | `hub-sync.test.ts` |
| Change capture, upload batches, cloud ingest with acknowledgement, conflicts kept | [built] | `hub-sync.test.ts` |
| Cloud refuses floor writes for a hub branch; attach/detach with open-order check | [built] | migration `20260926000800_hub_sync.sql` |
| Order numbers continue across hub and web POS (no reuse) | [built] | `hub-sync.test.ts` |
| Offline PIN sign-in (hub-own digests, lockouts, revocation on sync) | [built] | `hub-pins.test.ts`, [OFFLINE-AUTHENTICATION.md](OFFLINE-AUTHENTICATION.md) |
| Hub logins for local devices; the same web build served on the LAN | [built] | `apps/hub/test/hub-http.test.ts` |
| Device pairing at the hub window with a manager PIN | [built] | `hub-http.test.ts`, `e2e-hub/hub.spec.ts` |
| Print agent inside the hub (network ESC/POS printers), failure, retry, backup | [built] | `apps/hub/test/hub-printing.test.ts` over real TCP with simulated printers; **no physical printer tested** |
| Offline line on tills; hub window (connection, sync, addresses, devices) | [built] | `e2e-hub/hub.spec.ts` (real browser) |
| Hub health in the back office (sync state, devices seen by the hub) | [built] | Devices & printing |
| Windows desktop app (Electron): tray, start with Windows, secrets in the Windows key store, updates | [built] | `apps/desktop`; installer built; **not yet run on a Windows PC** |
| Windows installer from CI, production channel with guards against staging values | [built] | `.github/workflows/desktop-windows.yml`; **not yet run** (needs the repository variables) |
| No PINs, secrets or tokens in hub logs or files | [built] | automated check in `apps/hub/test/hub-http.test.ts` |
| Real hardware: Windows PC, printers, local network, physical outage | **not yet verified** | [HARDWARE-ACCEPTANCE.md](HARDWARE-ACCEPTANCE.md) |
| USB printers, cash drawer | [planned] | needs the restaurant's hardware |
| Manual "send to another printer" for a failed ticket | [planned] | failed tickets retry and fall back to the backup printer automatically today |
| Code-signed installer | [planned] | needs a code-signing certificate (Windows shows a SmartScreen warning until then) |

## Known limits (by design, for now)

- **One hub.** If the hub PC is off, the tills cannot work locally. If the internet still works, detach the hub in the back office and use the web POS.
- **Offline sign-in.** Works only for staff who have signed in on this hub at least once while it was online.
- **Stock takes.** A stock count done on the hub stays on the hub; the stock changes it causes are synced.
- **Photos and back office.** Menu, prices, staff and settings are changed in the cloud back office; the hub picks up changes within about 15 seconds when online. Product photos seen once are cached on the hub for offline use.

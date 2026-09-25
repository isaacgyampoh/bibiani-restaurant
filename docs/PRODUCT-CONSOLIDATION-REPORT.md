# Product Consolidation Report

Date: 2026-09-25 · Application: **https://bibiani-restaurant.vercel.app**

This follows [PRODUCT-CONSOLIDATION-AUDIT.md](PRODUCT-CONSOLIDATION-AUDIT.md) (Phase 1) and the owner's decisions recorded there.

## 1. Existing architecture preserved

Nothing was rewritten. The layers are unchanged: domain → contracts → application → infrastructure → apps.

New work followed the same pattern:
- domain rules in `packages/domain/src/inventory.ts`;
- one use case per action (`use-cases/inventory.ts`, `use-cases/operations.ts`);
- read models (`read-models-ops.ts`);
- migrations `…001600` (permissions and roles) and `…001700` (inventory). Earlier migrations were not edited.

These stayed as they were:
- the order state machine, routing engine and production tickets;
- the payment model;
- RLS and transaction boundaries;
- idempotency;
- audit logging.

Stock is sold in the **same transaction** as the order submission.

## 2. Supabase project now used

**One project: `lgoirbfyspuflqekrcgp`** (eu-west-1, daily backups).
- **Configuration:** `.env.production` (gitignored) and the Vercel project `restaurant-management-prod`.
- **Browser:** receives only the URL and the anon key.
- **Server-side only:** `DATABASE_URL` (least-privilege `rp_api`), `SUPABASE_SECRET_KEY` and `MONITOR_TOKEN`.

Standard commands:

| Command | What it does |
|---|---|
| `pnpm db:push` | apply migrations |
| `pnpm deploy` | build and deploy |
| `pnpm demo:seed` | create the demo restaurant (refuses if it exists) |

No script creates Supabase or Vercel projects.

## 3. Supabase projects no longer required

- DEV `nkijnjovztglmwxoemqg`
- Staging `impairlsvhkumjzhjhti`

Nothing in production depends on them. The owner may pause or delete them; nothing was deleted automatically.

Staging was still used during this work as a rehearsal target. The `staging:*` scripts remain available as optional pre-release tooling. Automated tests use in-memory PGlite and need no project.

## 4. Authentication status

- Real Supabase Auth: JWT verified on the server, permissions checked on every action.
- The demo login signs in and lands on the dashboard of the demo restaurant. This was verified in a browser on production.
- Owners and staff set their own password from a single-use link (`/set-password`).

## 5. Demo credentials

| | |
|---|---|
| URL | https://bibiani-restaurant.vercel.app |
| Email | `demo@restaurant.test` |
| Password | **not written here: this repository is public.** It is in the gitignored `.demo-credentials.json` on the owner's machine and was given to the owner directly. |
| Role | Owner of **"Bibiani Restaurant — Demo"** only (it cannot see the real restaurant) |

## 6. Demo restaurant data

"Bibiani Restaurant — Demo" is a separate restaurant, isolated by RLS. The real "Bibiani Restaurant" stays clean.

Everything was created through the API, so it is validated and audited:

| Area | Content |
|---|---|
| Floor | Main Hall (15 tables), Terrace (6 tables), Takeaway (pay before handover, customer name required) |
| Stations | Main Kitchen, Grill, Pastry, Drinks, each with its own kitchen screen |
| Devices | 3 POS, customer display |
| Menu | 17 dishes and drinks (GHS). 5 modifier groups: spice level, add protein, side swap, drink options, cake options. Category routing. A demo tax rate, clearly named. |
| Staff | 7 staff (cashiers, waiters, kitchen, manager) with standard roles; Supervisor and Inventory Manager roles |
| Today's orders | orders at every stage (new, cooking, 3/4 ready, ready, completed); payments by cash, MoMo, card and split |
| Stock | 18 stock items with deliveries (invoice numbers) and wastage; recipes for 15 products; one approved stock count with explained variances; one count in progress; 2 low-stock items |

## 7. POS status: working

- Tables per area, takeaway, category and product search, modifiers, notes, send, manual payment (cash / MoMo / card / split), print or reprint receipt, "Completed" tab, order status.
- Receipts:
  - Without a receipt printer, "Print receipt" shows the receipt on screen.
  - With a printer, it queues a print job; the first print is the original and later ones are marked REPRINT and audited.
- **Not built:** discounts; table transfer, merge and split.

## 8. Routing status: working for product / category / default rules

- Rules can be per service area, with extra printers per rule.
- One order is split into one ticket per station; the customer sees one order number.
- **Menu** shows where each product goes. **Stations & routing** shows a "where each item goes" map per area. Both are computed by the same domain function the server uses.
- **Not built yet:**
  - routing by modifier;
  - one item to several stations;
  - an automatic packing or expo station for takeaway.

  The routing rule picks one station per item. These are listed as next work.

## 9. Kitchen status: working

- Per-station screen with large ticket cards: order number, table or takeaway, elapsed time, late highlight, modifiers, notes. Actions: start, pause, ready, recall, bump.
- **Notifications:** new order, items added, item voided, recalled. They show an unread count, a banner and an optional sound.
- Staff choose a station from a tile screen; paired screens open their own station.
- **Not built:** readiness per item (it is per ticket) and order priority.

## 10. Supervisor status: working

- Every active order with each station's state, "3/4 READY" progress, elapsed time per station, the late station ("Waiting on Grill") and payment due.
- Actions: mark a station ready, and "Served" / "Handed to customer" when all stations are ready.
- Notifications: station ready, order ready, order delayed.

## 11. Customer display status: working

- Two columns: "Now preparing" and "Ready for collection", with large numbers and live updates.
- No staff data, IDs or controls.

## 12. Inventory status: working

- Stock items (unit, category, SKU, minimum, cost), stock on hand, value at unit cost, low-stock warnings, last change, and "used in" (products whose recipes use it).
- Deliveries (with invoice or reference), wastage (reason required), adjustments (reason required), full movement history.
- The quantity never changes without an append-only movement.
- **Recipes:** a product's recipe deducts stock when the item is sent to the kitchen.
- **Limitations:**
  - cancelling an order before cooking does not return stock;
  - no transfers between branches;
  - valuation uses the current unit cost (no FIFO or average cost).

## 13. Stock taking status: working

- Start a count (all items or chosen ones). Enter physical quantities: the system quantity and variance are shown live, and each variance needs a reason.
- Submit, then a manager (`inventory.manage`) approves.
- Only approval changes stock: it writes "stock count" movements against the stock at approval time. Every step is audited.
- Cancel is also available. A submitted count with an unexplained variance cannot be approved.

## 14. Staff and permissions status: working

- Staff list: create, deactivate, reactivate.
- A role matrix shows what each role can do, in plain words.
- New permissions: `reports.view`, `inventory.manage`, `stock.count`.
- New roles: Supervisor and Inventory Manager.
- The server enforces every permission; the UI only hides what a role cannot use. People cannot change their own access.

## 15. Testing results

| Check | Result |
|---|---|
| Lint, typecheck | pass (6 CSS style warnings) |
| Unit and integration tests (PGlite) | **129 / 129**, 22 files |
| New integration tests | inventory ledger (idempotency, reasons, no negative stock, append-only for the API role, cross-restaurant isolation); stock take lifecycle and audit; recipe deduction inside the order transaction; supervisor 3/4 → 4/4 with the late station; dashboard figures; modifier admin; permissions |
| Migrations from empty + RLS on every table | pass (17 migrations, 45 tables) |
| Browser tests on staging | milestone 3/3, operations 3/3 (supervisor + display, inventory + stock take, reports), failures 6/6, password 1/1, Realtime 1/1 |
| Manual demo run on production (demo login, real browser) | login → dashboard → POS Table 12: Jollof Rice, Grilled Chicken, Coke, Chocolate Cake → sent (4 station tickets) → Supervisor 0/4 → 3/4 → 4/4 READY → customer display READY → Served → split payment cash 50 + MoMo 95 = GHS 145 → **completed, paid** |
| Screens reviewed on production | dashboard, orders, supervisor, inventory, stock taking, menu, routing, floor, staff, devices, reports, settings, display, kitchen, POS. No console errors. |
| Multi-POS concurrency | covered by the existing concurrency suite and load test (unique order numbers, no duplicate orders, tickets or payments; 100 concurrent submissions). Unchanged by this work. |

## 16. Known limitations

- Routing: see §8.
- POS: no discounts; no table transfer, merge or split; no pickup time.
- Kitchen: no per-item completion; no order priority.
- Inventory: see §12.
- An unsent POS cart is lost on browser refresh.
- The owner of the real restaurant still has to receive the set-password email. The project uses Supabase's built-in email; see [13-production-go-live-report.md](13-production-go-live-report.md).
- No PITR (daily backups only). No error tracking or log drain. No Content-Security-Policy header.

## 17. Hardware intentionally deferred

- Printers, the print agent machine, paired tablets and TVs, cash drawer.
- The software keeps the print queue, device pairing and printer health. Without a printer, receipts are shown on screen.
- Physical printing was validated only against TCP test printers on staging.

## 18. URL

https://bibiani-restaurant.vercel.app

## 19. Demo login

Email `demo@restaurant.test`. For the password, see §5.

## 20. Next recommended product work

1. Routing extensions: modifier rules, one item to several stations, a takeaway packing / expo station (a migration plus the routing engine).
2. Discounts (with permission and audit), and table transfer, merge and split.
3. Per-item "done" on the KDS, and order priority.
4. Returning stock when an order is cancelled before cooking; average cost; stock transfers.
5. Printer and device installation on site, and custom SMTP for staff password emails.

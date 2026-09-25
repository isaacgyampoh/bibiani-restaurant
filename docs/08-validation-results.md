# Phase 4 Validation Results

Date: 2026-09-25. Target: Supabase **DEV** project `nkijnjovztglmwxoemqg` (eu-west-1). Tests ran from a developer laptop about 140 ms from the database. Nothing here was run against production, which does not exist.

## 1. Hosted database

| Check | Result |
|---|---|
| Migrations | 13 applied in order with `supabase db push` (CLI temporary login role; no database password used) |
| Tables | 40, all with RLS enabled, all owned by `postgres` |
| Constraints | 82+ foreign keys (tenant-scoped composite keys), 49 checks, 36 uniques (at migration 900; more added since) |
| Triggers / functions | realtime notify triggers on orders, tickets, print jobs, device status, printer status; identity, pairing and sweep functions |
| Browser roles | `anon` and `authenticated` have **0** privileges on public tables |
| Realtime | private-topic policy on `realtime.messages`; `realtime.send` present |
| pg_cron | `rp-sweep-offline-devices` scheduled every minute |
| API login | `rp_api`: direct table read **denied (42501)**; reads only via `SET ROLE app_api` + RLS; can't run the sweeper |
| Supabase advisors | Security: 1 warning, leaked-password protection is off (Auth setting; **enable before PROD**). Performance: 75 info notes, "composite tenant FK without covering index"; reviewed, not added (parents are never deleted, and hot queries have their own indexes, enforced by `query-budget.test.ts`) |

## 2. Test suites against hosted DEV

`pnpm test:hosted` runs the database-backed suites against DEV with real parallel connections and real Supabase Auth users.

- **Full run: 72 passed, 2 failed, 10 skipped.** The two failures were test defects, since fixed: a 50× sequential replay exceeding the time limit from the remote laptop, and a test comparing the app clock with wall time. Eight skips came from one fixture setup that timed out while starved by another worker; two tests are local-only by design.
- **Re-run of the affected files in isolation: 19/19 passed.**
- **Concurrency and realtime, run in isolation: 10/10 passed.**

## 3. Real concurrency (multiple simultaneous connections)

| Case | What ran at the same time | Result |
|---|---|---|
| A | 12 different orders submitted at once | 12 orders, numbers **5001–5012**, no duplicates, no gaps |
| B | the same order submitted 8× at once | 8 identical responses; **1** order, 2 items, 1 submission, 2 tickets, 2 print jobs |
| C | two send-to-kitchen calls (different ids) at once | 1 sent, 1 `NOTHING_TO_SEND`; **1** set of tickets |
| D | same payment id ×2; two different full payments | **1** payment; 1 accepted + 1 `ORDER_ALREADY_PAID` (no double charge) |
| E | two kitchen screens pressing READY on one ticket | 1 applied + 1 `INVALID_TRANSITION`; exactly **1** ready event |
| F | two agents claiming, then both reporting one job | claims 20 + 20 with **0 overlap**; 1 report accepted, 1 attempt row |
| G | kitchen ready ×2 + new round + payment on one order, then two people serving | all 5 writes applied, state consistent; double serve → 1 applied |
| Tenants | 16 interleaved transactions for two restaurants through the pooler | **0** foreign rows returned |

After each case an invariant checker recomputed totals, payment status, order status, "each sent item on exactly one ticket" and "one ticket per station per submission" from the rows, using the domain rules. All held.

**Issue found and fixed:** the order-number counter was locked for the whole submission, so 12 simultaneous orders queued for more than 60 s from the laptop. Numbers are now reserved in a short transaction keyed by the order id (migration 1300). This is also why case A is gap-free.

## 4. Realtime with authenticated clients

Real API on the `rp_api` login, real Supabase sessions, private channels.

| Flow | Result |
|---|---|
| POS (cashier) → KDS device receives `ticket_changed` | ✓ delivered **64 ms** after the API call returned |
| KDS ready → POS and customer display receive `order_changed(ready)` | ✓ |
| Agent reports printer error → owner's ops view receives `printer_changed` | ✓ |
| User of **another restaurant** joins this branch's topic | ✓ refused by Supabase: *"Unauthorized: You do not have permissions to read from this Channel topic"* |
| Payloads | ids, status and version only; no names, phones or totals |
| KDS disconnect → orders missed → reconnect | ✓ reconnect detected, full reload, missed ticket shown, live updates resumed |

**Supabase behaviour to know:** on a brand-new project, `realtime.send` logged *"no partition of relation messages found for row"* and private joins failed, until the Realtime service created the daily partitions of `realtime.messages`. Screens stayed correct through the safety poll. Plan a realtime check on every new environment (STAGING/PROD) before go-live.

## 5. Browser end-to-end (Playwright, real Chromium)

`pnpm test:e2e` creates a fresh DEV restaurant through the platform script and the admin API, then drives the UI.

| Scenario | Steps verified | Result |
|---|---|---|
| **A — Table 12** | Four station screens and a customer display paired with one-time codes. Waiter opens table 12, adds 2×Jollof, 2×Grilled Chicken, 2×Meat Pie, 2×Coke, and sends. Each KDS shows only its items. START/READY on each. Customer display shows **5001** under READY. Waiter serves. Cashier on the paired POS-01 till takes a split payment (cash 150.00 with 50.00 change, MoMo 110.00): paid, completed. The receipt is queued on RECEIPT-PRINTER-01. | ✓ |
| **B — Takeaway** | Customer name, 1×Birthday Cake, 2×Meat Pie, 1×Chicken Sandwich, 2×Coke → Pastry / Kitchen / Drinks only, nothing to Grill. Card payment. Ready on three stations, then READY on the display. Picked up: completed, and gone from the display. The cake ticket is queued on **both** pastry printers. | ✓ |

**Issues found and fixed by these runs:**
1. `ApiClient` called an unbound `fetch`. Browsers throw "Illegal invocation"; Node doesn't, so only a real browser could find it.
2. The KDS sent a stale ticket version when READY followed START quickly. It now applies the version from each response and retries "busy" responses once.
3. The e2e cashier had been using an unpaired till, so no receipt printer was set. The test now uses a paired till and asserts the receipt is queued.

## 6. Print agent against the real backend

`pnpm dev:agent-smoke` runs the **built** agent process. It is paired with a one-time code, authenticates only with its device refresh token, and drives local TCP ESC/POS test printers in place of hardware.

- It printed **9/9** queued jobs from the e2e run: 8 kitchen tickets across Kitchen, Grill, Pastry, Drinks and the second pastry printer, plus the receipt. Queue afterwards: empty.
- Admin ops view: agent **online**, all six printers **healthy**.
- **Issue found and fixed:** the API and agent builds weren't self-contained (workspace packages left as runtime TypeScript imports). Both now bundle, and the built API was started and passed `/health/ready` against DEV.
- **Not yet done:** a physical ESC/POS printer. The checklist is in [06-device-and-printing.md](06-device-and-printing.md) §6.

## 7. Performance (measured, not optimised prematurely)

| Operation | DB statements | Observed from laptop (~140 ms RTT) |
|---|---|---|
| Submit order, 4 stations | 44 (was 50) | ~14 s first call; several seconds warm |
| KDS ticket ready | 16 | 5–12 s (includes queueing behind simultaneous READYs on the same order) |
| Record payment | 13 | — |
| KDS board | 5 | ~1 s |
| POS menu | 7 | — |
| Customer board | 1 | ~1.1 s |
| Admin save | ~12 | ~1.7 s |

These numbers are dominated by distance. **The API must run in the same region as the database**; co-located estimates are in [05-deployment.md](05-deployment.md) §7 and must be confirmed on STAGING. Query budgets fail CI on regressions.

## 8. Security checks

- RLS on all 40 tables (CI check and hosted check). Tenant isolation holds through the application, raw SQL as `app_api`, parallel pooled transactions and realtime channels.
- Restaurant-wide grants apply only to that restaurant's branches (a fix made this phase).
- The API holds the only database credentials, on a least-privilege login. The server secret key is used only by the API's auth-admin adapter.
- Build output scanned for secret keys, database URLs with passwords, service_role JWTs and exact secret values: **clean**. The scanner was self-tested against planted fakes.
- Device auth uses one-time hashed codes with a 10-minute TTL, single use, and 5 attempts per minute per IP (per API instance). Re-pairing and revoking delete the old login.
- Staff auth: Supabase email/password; permissions come from roles, resolved server-side; deactivation denies access immediately.
- **Open:**
  - enable leaked-password protection;
  - consider MFA for owners;
  - device sessions in the browser are stored in `localStorage` (acceptable for dedicated kiosk tablets; needs a physical-security note);
  - the pairing rate limit is per instance.

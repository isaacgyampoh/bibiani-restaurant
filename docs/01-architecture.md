# Restaurant Operating Platform — Architecture & Product Audit

Status: **Phase 1 deliverable, for review.** No feature code has been written yet.
Companion files: [02-proposed-schema.sql](02-proposed-schema.sql) (database design, compiles on PostgreSQL) and [03-backlog.md](03-backlog.md) (implementation backlog).

> **Phase 3 amendments (2026-09-25).** Where this document and the following disagree, these win:
> - [ADR 0001](adr/0001-application-layer-and-transactions.md): business rules live in a TypeScript domain and application layer, executed by an API in **one Postgres transaction per command**. They are *not* Postgres RPC functions called from browsers. Browser roles have no table privileges. RLS, tenant-scoped foreign keys and unique constraints remain the database-level backstop. References below to `submit_order(...)` RPCs describe the same transaction, now implemented by the `SubmitOrder` use case.
> - [ADR 0002](adr/0002-manual-payments-v1.md): V1 payments are **manual records only** (cash, MoMo, card; split = several records). No MoMo or card provider integration, no webhooks, no automatic verification.
> - Operational areas (`operational_areas`: Hall, Takeaway, …) replace the Phase 1 `order_types` table. Stations are branch-level and shared by all areas; routing rules can be area-specific.
> - The implemented schema is `supabase/migrations/`. `02-proposed-schema.sql` is historical.
> - Current state: see [README](../README.md) and [07-testing-strategy.md](07-testing-strategy.md) for what is tested, and what isn't.
>
> **Phase 4 amendments (2026-09-25):**
> - **Least-privilege API login.** The API connects as `rp_api`, which can only `SET ROLE app_api` (RLS) and call three identity functions. It never uses the `postgres` password.
> - **Order numbers are reserved in a short separate transaction** keyed by the client's order id. Numbers are unique per branch and business day, gap-free under concurrency, and an abandoned order may leave a gap.
> - **Payment policy is per-area configuration:** `pay_before_fulfillment` or `pay_after_fulfillment`. `allow_credit` is reserved for later.
> - **Devices are paired with one-time codes** and get their own Supabase login. Staff sign in with Supabase Auth, and permissions come from roles resolved server-side. A restaurant-wide grant expands only to that restaurant's branches.
> - **Offline (§I) is not implemented yet in the web POS:** no IndexedDB outbox, no LAN print fallback. What exists: idempotent retries with stable ids, and reconnect-and-reconcile on every screen.
> - **Realtime caveat:** on a new Supabase project, database broadcasts are dropped until the Realtime service creates the date partitions of `realtime.messages`. Screens stay correct through the safety poll. See [08-validation-results.md](08-validation-results.md).

---

## A. Current Architecture

**Nothing exists yet.** An audit on 2026-09-25 found:

| Checked | Finding |
|---|---|
| Git repository `bibiani-restaurant` | Initialised on `main`, **zero commits, zero files** |
| Vercel | No project matching "bibiani" |
| Supabase | The Supabase connector isn't authorized in this environment, so no existing project could be inspected. **Action for owner:** confirm whether a Supabase project already exists (see open questions, §O). |
| Local tooling | Node 24, pnpm, Supabase CLI installed. **Docker is not installed**, so the local Supabase stack (`supabase start`) can't run on this machine yet. |

The audit items about existing modules, database, auth, UI, APIs, realtime, printing, payments, POS, inventory, reporting and deployment all get the same answer: **none exist**. No working logic needs preserving and there's no legacy code to migrate. This is a greenfield build, so the rule "never silently remove existing functionality" doesn't yet apply.

If an earlier version of this system exists elsewhere (another repo, a spreadsheet workflow, a vendor POS), please point to it before Phase 3. Its data and business rules would change the migration and seed plan.

## B. Current Features

None.

## C. Current Problems

No code-level bugs or technical debt exist yet. The real risks at this stage are **process** risks:

1. **No source of truth for requirements besides a long prompt.** Mitigation: these three docs become the spec; changes go through them.
2. **No local database environment** (Docker missing). Mitigation: install Docker Desktop or OrbStack, or run migrations and pgTAP against a dedicated Supabase dev project. The schema draft was syntax-checked in PGlite, an in-process Postgres, but that doesn't replace real Supabase (Auth, Realtime, Storage, pg_cron).
3. **Scope.** The brief describes what commercial vendors build over several years. Reliability needs the core loop (order → route → KDS/print → ready → display → pay) hardened *before* breadth. The implementation plan (§L) orders the work that way.

---

## D. Target Architecture

### D.1 Principles

1. **The database is the source of truth.** Realtime, print agents and device caches are delivery mechanisms. Every screen can rebuild its state with one query.
2. **Critical writes are single-transaction RPCs.** Order submission, routing, ticket creation and print-job creation happen in one Postgres transaction. Either all of it exists or none of it does.
3. **Client-generated ids make retries safe.** An order, submission or payment keeps its UUID on every retry, so a retry can't create a duplicate.
4. **Snapshot, don't reference, for history.** Order lines copy name, price, tax and station at submit time. Menu edits never rewrite past orders or re-route live ones.
5. **Configuration over code.** Stations, order types, routing, printers, displays, taxes and roles are data. Nothing like "Main Kitchen" or "Pastry" appears in code.
6. **Fail loudly, recover automatically, never silently drop.** Every failure path ends in a retry, a visible alert, or both.

### D.2 System topology

```
┌──────────────────────────── Supabase (cloud, authoritative) ────────────────────────────┐
│  Postgres: schema + RLS + RPC functions (order engine, routing, payments, shifts)        │
│  Auth: staff logins + paired device identities       Storage: media, logos              │
│  Realtime: Broadcast-from-DB on private branch topics    pg_cron: sweeps & retries       │
│  Edge Functions: device pairing, PIN login, MoMo webhooks, platform admin, report export │
└───────────────▲──────────────────────▲─────────────────────▲───────────────▲─────────────┘
                │ HTTPS/WSS            │                     │               │
      ┌─────────┴────────┐   ┌─────────┴───────┐   ┌─────────┴─────┐  ┌──────┴────────┐
      │ POS / Waiter PWA │   │ KDS PWA         │   │ Display PWA   │  │ Admin web     │
      │ IndexedDB outbox │   │ station screen  │   │ customer/mktg │  │ (same app)    │
      └───────┬──────────┘   └─────────────────┘   └───────────────┘  └───────────────┘
              │ LAN (offline fallback only)
      ┌───────▼──────────────────────────────┐
      │ Print Agent (Node, on a mini-PC/POS) │── TCP 9100 ──► ESC/POS kitchen & receipt printers
      │ claims jobs, reports status, LAN API │── USB ───────► USB printers / cash drawer kick
      └──────────────────────────────────────┘
```

### D.3 Technology choices

| Concern | Choice | Why |
|---|---|---|
| Repo | pnpm workspaces + Turborepo monorepo | Shared domain types across the app, print agent and tests |
| Operational + admin frontend | **React + TypeScript + Vite SPA, installable PWA** (`apps/web`) with modes `/pos`, `/kds`, `/display`, `/admin` | Offline shell and service worker are first-class. SSR adds nothing on a kitchen tablet. Static hosting on Vercel. |
| Data fetching | TanStack Query + supabase-js; generated DB types | Cache invalidation driven by realtime and reconnect |
| Local persistence | IndexedDB via Dexie: outbox, menu cache, number leases | Survives refresh and restart |
| UI | Tailwind + Radix primitives, components owned in-repo | Touch-sized, fast, consistent; no heavy template look |
| Backend | Supabase Postgres (SQL migrations), plpgsql RPCs, Edge Functions (Deno) | Business rules enforced server-side |
| Print agent | Node + TypeScript service (`apps/print-agent`), ESC/POS encoder | Browsers can't reliably reach raw TCP printers |
| Money | `bigint` minor units end to end; a TS `Money` type | No float drift |
| Tests | Vitest (domain), pgTAP (RLS, RPCs, concurrency), Playwright (end-to-end flows), a fake ESC/POS printer server | See §N |
| Observability | `alerts` + `client_errors` + `device_events` tables surfaced in the admin UI; Sentry for the frontend and agent | The owner sees problems without a developer |

### D.4 Module boundaries

```
apps/web/src/modules/
  auth  restaurant  menu  pos  orders  routing(preview only)  kitchen  printers
  displays  hall  takeaway  payments  shifts  inventory  staff  reports  devices  audit
packages/domain     pure TS: money, tax calc, status rollup mirror, routing preview, validation (zod)
packages/db-types   generated Supabase types
packages/escpos     document model → ESC/POS bytes (used by agent; tested against fake printer)
supabase/migrations one ordered migration per concern
supabase/functions  pairing, pin-login, momo-webhook, platform-admin
supabase/tests      pgTAP
apps/print-agent
```

Rule: `packages/domain` may *preview* totals and routing for UX. The **authoritative** computation is the SQL RPC. A pgTAP and Vitest parity suite runs the same fixtures through both.

---

## E. Database Architecture

The full DDL is in **[02-proposed-schema.sql](02-proposed-schema.sql)**: 60+ tables, enums, keys, indexes, constraints, RLS helpers, example policies and RPC signatures. It compiles on PostgreSQL (checked in PGlite with auth stubs). Key decisions:

**Tenancy.** `restaurants → branches`. Every tenant row carries `restaurant_id`, and branch-scoped rows also carry `branch_id`, so each RLS check is one indexed predicate with no joins up a hierarchy.

**Three independent status dimensions** (§4 of the brief):
- `orders.status`: fulfilment lifecycle, one of draft · open · submitted · in_preparation · partially_ready · ready · served/picked_up · completed · on_hold · cancelled · voided
- `orders.payment_state`: unpaid · partially_paid · paid · partially_refunded · **refunded**. Refunds are a money event, not a kitchen state.
- `order_items.status` and `production_tickets.status`, each tracked separately.

`orders.status` is **derived**: `app.recompute_order_status()` runs after every item or ticket change inside the same transaction. "On hold" is a manual overlay (`held_at`) that the rollup never clears by accident.

**Submissions.** Every "send to kitchen" is an `order_submissions` row with a client-generated id. A dine-in tab can have round 1, round 2, and so on. Tickets are unique on `(submission_id, station_id)`. **That unique constraint is the database-level guarantee that a retried send can't create duplicate tickets.**

**Order numbers.** `(branch_id, business_day, order_number)` is unique. Business day uses a per-branch cutoff (default 04:00, Africa/Accra), so a 1 a.m. sale belongs to the evening shift.

**Routing snapshot.** `order_items.station_id` stores the resolved station. Tickets link items via `production_ticket_items`, with a unique index so each item sits on exactly one ticket.

**Printing as a transactional outbox.** `print_jobs` rows are inserted in the same transaction as the ticket. `dedupe_key` is unique. Every attempt is logged in `print_job_attempts`.

**Payments are append-only.** Refunds are new rows with `refund_of` pointing at the original charge. `(method_id, provider_ref)` is unique, so the same MoMo transaction id can't be recorded twice.

**Inventory is ledger-first.** `stock_movements` is append-only, with `dedupe_key` `sale:<order_item_id>` preventing double deduction. `stock_levels` is maintained from the ledger. The module is optional: `products.track_stock` defaults to false.

**Audit.** `audit_logs` is append-only (update and delete revoked). `order_events`, `production_ticket_events` and `device_events` give per-entity timelines.

**RLS summary.**

| Table group | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| Config (menu, stations, routing, devices, taxes, tables) | Members of the restaurant, branch-filtered | Direct, gated by `app.has_permission(..., '<area>.edit')` |
| Operational (orders, items, tickets, payments, shifts, stock, print_jobs) | Members with branch access | **None.** Writes only through RPCs. |
| audit_logs | `audit.view` permission | None (append via RPCs and triggers) |
| Customer display | Via `public_order_board` view: number and state only, no PII | — |
| platform_admins | Not exposed | Service role via Edge Function only |

**Realtime considerations.** No `postgres_changes` on hot tables. Postgres Changes checks RLS once per subscriber per change, which doesn't scale during a rush. Triggers use **Broadcast from Database** on private topics with small payloads (ids, status, version). See §H.

---

## F. Order Routing Architecture

### F.1 End-to-end flow (the Table 12 scenario, §26)

```
Waiter tablet                    Postgres (one transaction: submit_order)                 Consumers
─────────────                    ────────────────────────────────────────                 ─────────
1. Open Table 12
   → upsert_draft_order(id=A)    orders A: status=open, table 12 → occupied
2. Add 2 Jollof, 2 Chicken,
   2 Meat Pie, 2 Coke
   (local; outbox)
3. Tap SEND
   → submit_order(A, sub=S1, items)
                                 a. SELECT … FOR UPDATE orders A (serialises concurrent edits)
                                 b. if submission S1 exists → return stored result (idempotent)
                                 c. validate each product: active, available at branch,
                                    modifiers valid; PRICE FROM DB, not from client
                                 d. insert order_items (status=sent, submission=S1)
                                 e. resolve station per item:
                                      product rule → category rule (walk up tree) → branch default
                                      (order-type-specific rule beats generic)
                                      combo → expand to components, route each
                                      requires_preparation=false or station.auto_ready → 'ready' now
                                 f. group by station → production_tickets
                                      KIT: 2×Jollof  GRL: 2×Chicken  PAS: 2×Meat Pie  DRK: 2×Coke
                                    unique(S1, station) blocks duplicates
                                 g. for each ticket × station_outputs(printer) → print_jobs
                                    (+ routing_rule_extra_outputs, + copies)
                                 h. recompute totals & taxes, order status → submitted
                                 i. order_events, stock_movements (if deduct_on=submit)
                                 j. realtime.send() → branch:B:station:KIT, …GRL, …PAS, …DRK,
                                    branch:B:orders, branch:B:print
                                 COMMIT
4. Tablet gets {order_number 5001,                                                       KDS KIT/GRL/PAS/DRK
   tickets[]} and clears outbox                                                          refetch open tickets
                                                                                         Print agent claims
                                                                                         4 jobs, prints
5. Each station: Accept → Start → Ready
   → ticket_transition(T, 'ready', expected_version)
                                 lock ticket; check version; set items ready;
                                 recompute order: 1 of 4 ready → partially_ready … 4 of 4 → READY
                                 broadcast branch:B:orders
6.                                                                                       Customer display
                                                                                         refetches board:
                                                                                         "5001 READY"
                                                                                         Waiter tablet: table 12
                                                                                         badge "Ready to serve"
7. Waiter taps Served → item_transition(serve) → order served → pay → completed, table → cleaning
```

The takeaway scenario (§27) works the same way. The pastry ticket holds Birthday Cake and Meat Pie, the kitchen ticket holds Chicken Sandwich, and the drinks ticket holds Coke. The `takeaway` channel changes only the labels ("TAKEAWAY #5002", "READY FOR PICKUP") and the terminal state (`picked_up`).

### F.2 Routing rules

- The rule table is per branch, because stations are physical.
- Admins get a **routing preview**: pick a product and an order type, and see the station and devices it will hit. They also get a **coverage report** listing products with no reachable station. `submit_order` refuses to create a ticket for a station with no active output and falls back to the branch default. The default route is mandatory and enforced by a unique index.
- Station → outputs: `primary` (normal), `copy` (always also), `backup` (used only when the primary printer is offline or dead).
- Product-specific extras (for example "Birthday Cake also → Pastry Display 2") use `routing_rule_extra_outputs`.

### F.3 Changes after submission

| Action | Effect |
|---|---|
| Add items to open tab | New submission, new tickets, only for affected stations |
| Void a sent item | Item → voided (reason + approver), `void_ticket` print job to the same station ("VOID 1× Jollof — #5001"), KDS strikes it through |
| Cancel order | All non-served items cancelled or voided, tickets cancelled, void slips printed, payments must be refunded explicitly |
| KDS recall | Ticket ready → in_preparation; order rolls back from ready to partially_ready; event logged |
| Transfer table | `orders.table_id` updated under lock; both tables' status recomputed; tickets reprinted only if configured |

---

## G. Device Architecture

### G.1 Device identity and pairing

1. The admin creates a device (`POS-01`, `PASTRY-KDS-01`, ...) and gets a 6-digit **pairing code** that expires in 10 minutes. Only its hash is stored.
2. On the physical device, the admin opens `/pair` and enters the code. The `device-pair` Edge Function verifies it, creates a dedicated Supabase Auth user for the device, links `devices.auth_user_id`, and returns a session. The device stores the refresh token.
3. From then on, the device authenticates as itself. RLS scopes it to its restaurant and branch. A KDS device can read its station's tickets but can't read payments.
4. **Staff on shared devices** (POS, KDS) identify with a PIN. The `pin-login` RPC checks the bcrypt hash with lockout after 5 failures and creates a short-lived `staff_sessions` row bound to *that device*. Every operational RPC checks both the device and the staff session's permissions. A manager override, such as approving a void, is a second PIN in the same RPC call.
5. Revoking a device sets `is_active=false` and revokes its auth user's sessions. The device loses access on its next token refresh (within 1 hour). The data is RLS-blocked immediately because the policies check `is_active`.

### G.2 Heartbeats and status

- Every device calls `device_heartbeat()` every 30 s with app version, online state, queue depth and, for agents, printer statuses.
- A pg_cron sweep every minute marks any device silent for more than 90 s as `offline`. It writes `device_events` and opens an `alerts` row, deduplicated per device. Recovery resolves the alert automatically.
- The admin **Devices** page shows everything live: green, amber or red; last seen; queue depth; failed print jobs.

### G.3 Printers and the print agent

Browsers can't open raw TCP sockets to printers, and pop-up print dialogs aren't acceptable in a kitchen. Printing therefore goes through a **print agent**, a small Node service on any always-on machine on the restaurant LAN (a mini-PC, Raspberry Pi, or the main POS PC).

```
print_jobs (pending) ──realtime nudge──► agent ──claim_print_jobs() [FOR UPDATE SKIP LOCKED, 30 s lease]
                                            │
                                            ├─ render payload → ESC/POS bytes (packages/escpos)
                                            ├─ query printer status (DLE EOT): paper / cover / offline
                                            │     offline before send → outcome failed_before_send
                                            ├─ write bytes over TCP 9100, wait for flush
                                            │     socket error after partial write → failed_after_send
                                            └─ complete_print_job(outcome)
Server side:
  failed_before_send → status failed, next_attempt_at = backoff (2 s, 5 s, 15 s, 30 s, 60 s...)
  failed_after_send  → status uncertain → retry prints header "** POSSIBLE DUPLICATE — REPRINT **"
  lease expired      → back to pending (agent crashed)
  attempts ≥ 3 on primary and a backup exists → reroute to backup (original_printer_id kept)
  attempts exhausted → dead → CRITICAL alert "PASTRY PRINTER OFFLINE – 3 tickets not printed"
```

**Delivery guarantee (stated honestly).** Exactly-once printing isn't achievable with ESC/POS network printers, because a printer can't reliably confirm a print. The platform gives **at-least-once with visible duplicate marking**. For a kitchen, an extra marked ticket is acceptable; a missing ticket is not. Two further safeguards: a station with a KDS never depends on paper alone, and the KDS shows a red banner "Printer offline — N tickets unprinted" alongside the tickets themselves.

Printer drivers sit behind an interface: `network_escpos` (primary), `usb_escpos` (through the agent), `android_builtin` (a later adapter for Sunmi-style Android POS terminals, which are common locally), and `browser` (receipt fallback only). The cash drawer is kicked through the receipt printer's drawer port with an ESC/POS pulse.

### G.4 Displays

- **KDS**: subscribes to `branch:B:station:S` and shows tickets not in completed or cancelled. It has touch actions, colour-coded ticket age against `stations.target_prep_seconds`, an audible chime for new tickets (configurable), and optional all-stations "expo" mode.
- **Customer display**: reads `public_order_board`, which carries no names, phones or totals. Two columns, PREPARING and READY. Ready numbers stay visible for N minutes after pickup. The config lives in `devices.config` (order types, logo, playlist in a side panel).
- **Marketing display**: plays a playlist from Supabase Storage. Media is cached by the service worker, so playback continues with no internet. An `order_status` slide type can show ready orders. It uses a separate device identity with **read-only** access, so it can't interfere with operations.

---

## H. Realtime Architecture

**Rule: realtime tells you *that* something changed. The database tells you *what*.**

| Topic (private) | Published by trigger on | Subscribers |
|---|---|---|
| `branch:{id}:orders` | orders (status, payment_state, version) | POS, waiter tablets, customer and marketing displays, manager view |
| `branch:{id}:station:{id}` | production_tickets, ticket items | KDS for that station, expo |
| `branch:{id}:tables` | dining_tables | POS floor map |
| `branch:{id}:print` | print_jobs insert and retry | Print agents |
| `branch:{id}:ops` | devices, alerts | Admin and manager dashboards |

- **Mechanism:** Postgres triggers call `realtime.send(payload, event, topic, private=true)` (Broadcast from Database). Channel authorization uses RLS policies on `realtime.messages` that reuse `app.has_branch_access()`.
- **Payload:** `{id, status, version, order_number}`. Clients never render from the payload alone. They invalidate the query and refetch, or apply the update if `version` is exactly the next one.
- **Recovery protocol** (every operational screen):
  1. On load, fetch the full open state (KDS: open tickets for station; POS: open orders and tables).
  2. Subscribe.
  3. On `SUBSCRIBED` after any disconnect, on `visibilitychange` to visible, and on `online`, do a full refetch.
  4. A **safety poll** every 20 s (KDS) or 60 s (POS and displays) fetches `max(updated_at)`/version and refetches if it changed. This catches silent socket death, which is common on cheap Wi-Fi.
  5. The connection indicator shows green when live, amber when polling only, and red when offline.
- **Why not Postgres Changes:** it checks RLS once per subscriber per row, which gets slow at scale during a rush. It also can't express per-station fan-out cheaply.

---

## I. Offline Strategy

The honest boundary: **Supabase is cloud-hosted. With the internet down, the cloud database can't be reached.** Plan for what each device can safely do, and prove each claim with tests (§N).

| Capability during internet outage | v1 (planned) | How |
|---|---|---|
| POS keeps taking orders | **Yes** | Menu, taxes, routing rules and printer map are cached in IndexedDB. Orders go into the **outbox** with client UUIDs. |
| Order numbers stay unique | **Yes** | Each POS holds a **leased block** of numbers for today (for example POS-01 has 5001–5050), topped up while online. Numbers aren't strictly sequential across tills, but they are never duplicated. |
| Kitchen still gets tickets | **Yes, on paper** | The POS computes routing locally (same rules, preview engine) and sends print documents to the **print agent's LAN endpoint**, keyed by submission id. The agent prints them and records the submission id. When the server later creates the real jobs, their `dedupe_key` matches and the agent **suppresses the second print**. |
| KDS screens update | **No (v1)** | KDS shows "OFFLINE — use printed tickets" plus a stale-data banner. **v2 option:** the print agent becomes a *local hub* that also serves KDS over the LAN. That's a significant project (local database, conflict rules), deferred deliberately. |
| Cash payments | **Yes** | Recorded in the outbox (client UUID), receipt printed through the agent. Synced later. |
| MoMo / card | **Manual record only** | Staff enter the provider reference. Automated MoMo confirmation needs internet, so the payment is marked `pending` until verified. |
| Customer display | Shows last known state plus "Updating…"; marketing loop continues from cache | |
| Refunds, voids after sync, reports, admin changes | **Blocked** (need authoritative state) | UI disables these with an explanation |

**Sync rules:**
- The outbox is FIFO per order. Operations are idempotent RPC calls (same UUIDs), so replay is always safe.
- Prices: the server normally recomputes every price. For an order created offline, the customer has already been charged, so **the charged price wins** if it matches the menu version the POS had cached. The server records `price_source='offline_cache'` and audits it. A price matching no known menu version is rejected into the stuck-operations queue (OFF-05).
- Conflicts, for example two tablets editing the same table offline, resolve as **append, don't overwrite**. Items are separate rows with their own UUIDs, so both sets survive. Destructive operations (void, transfer, merge) require being online.
- Failed syncs after N retries become `client_errors` plus an alert. **Nothing is ever dropped from the outbox automatically.** A manager can see and retry or resolve each stuck operation.
- **Browser refresh / POS restart:** the outbox lives in IndexedDB, not memory, and replays on boot. The app requests `navigator.storage.persist()` so the browser doesn't evict it.

---

## J. Security Architecture

**Authentication**
- Owners and managers: Supabase Auth email/password (phone OTP optional) plus TOTP MFA for owner and platform roles.
- Devices: device auth users created only through pairing (§G.1).
- Staff on shared devices: PIN, then a device-bound, short-lived `staff_session`. PINs are bcrypt-hashed with lockout and never leave the server.

**Authorization**
- Permission codes (`order.void`, `order.discount`, `payment.refund`, `menu.edit`, `shift.review`, `report.view`, `device.manage`, `audit.view`, ...) are assigned to per-restaurant roles. System role templates are seeded: Owner, Branch Manager, Supervisor, Cashier, Waiter, Kitchen, Accountant, Inventory Manager. Roles can be branch-scoped.
- Enforcement happens in three places, and the frontend is never the only one: (1) RLS on every table; (2) `app.assert_permission()` inside every RPC; (3) the UI hides what you can't do, for usability only.
- Threshold rules are server-side, for example discounts above X% or voids after preparation require a manager PIN.

**Tenant isolation**
- Every table has RLS enabled, checked in CI by a pgTAP test that fails if any public table lacks RLS or has a policy that doesn't reference the tenant helpers.
- A cross-tenant test suite runs as Restaurant A's users and devices and tries to read and write B's rows through every table and RPC.
- `security definer` functions live in the non-exposed `app` schema with `search_path = ''`. Each one checks tenant membership explicitly.
- The service-role key exists **only** in Edge Function secrets and the CI environment, never in `apps/web` or the print agent. The print agent uses its own device identity. A CI check greps the built bundles for the service key pattern.

**Other controls**
- Input validation: zod on the client for UX, plus plpgsql validation in the RPCs as the authority.
- Rate limiting: PIN attempts (lockout), pairing-code attempts, and Edge Functions (per-IP and per-device limits); Supabase Auth's built-in limits.
- Payments: no card data is ever stored or handled. Card terminals are standalone, and the system records only an auth code or reference. MoMo provider secrets live in Edge Functions, and webhooks are signature-verified.
- Storage: buckets are private per restaurant (`media/<restaurant_id>/…`), read by signed URL or by policies that check membership.
- Audit: every sensitive RPC writes `audit_logs`, and config tables get a generic before/after trigger.

---

## K. Product Backlog

See **[03-backlog.md](03-backlog.md)**. It has 104 items, each with an ID, epic, user story, acceptance criteria, dependencies, priority, technical notes and tests.

---

## L. Implementation Plan

The order follows dependencies and operational necessity. **Milestone M1 is a complete, reliable Table 12 / Takeaway #5002 loop on real hardware** before any breadth work starts.

| Step | Phase(s) | Delivers | Exit gate |
|---|---|---|---|
| 0 | — | Monorepo, CI (lint, typecheck, Vitest, pgTAP, Playwright), Supabase dev project, Docker or OrbStack locally, Sentry | Green CI on an empty app |
| 1 | 3 | Migrations for tenancy, identity, config, menu, orders, production, print, payments, audit. RLS on everything. Seed script for a demo tenant (clearly separated from real data) | pgTAP: RLS coverage and cross-tenant tests pass |
| 2 | 4 | Owner auth, device pairing, PIN sessions, permission helpers, role templates | Permission matrix tests |
| 3 | 5–6 | Admin: branches, stations, order types, floors and tables, categories, products, modifiers, taxes, routing rules plus preview and coverage | Can configure the §26 restaurant entirely from the UI |
| 4 | 8–9 | `submit_order`, routing, tickets, rollups, voids and cancels, realtime triggers | §26 and §27 scenarios pass as pgTAP tests, including a 50× retry that produces no duplicates |
| 5 | 7 | POS (takeaway first): catalogue, cart, modifiers, notes, send, IndexedDB outbox | Playwright: takeaway order end to end |
| 6 | 10 | KDS: station view, actions, recovery protocol, expo | Kill Wi-Fi or refresh mid-rush with no lost tickets |
| 7 | 11 | Print agent, ESC/POS, queue, retries, backup, reprint, alerts; fake printer for CI | Unplug the printer mid-order: job retries, alert raised, nothing lost |
| 8 | 16 + 21 (shifts) | Cash, manual MoMo, card reference, split and partial payments, receipts, refunds, shifts and cash-up | Shift variance maths verified; refund idempotent |
| **M1** | | **Pilot-ready core loop** | Dry run with staff at one branch, one peak service |
| 9 | 12 | Hall: floor map, table lifecycle, transfer, merge, split bill, move items, courses | |
| 10 | 13 | Takeaway board, pickup flow, customer name and phone, ETA | |
| 11 | 14–15 | Customer display, marketing playlists | |
| 12 | 19 | Device management UI, heartbeats, alert centre | |
| 13 | 20 | Offline: number leases, LAN print fallback, sync UI, chaos tests | Offline test matrix (§N) passes |
| 14 | 18 | Reports (SQL functions), exports | Report totals equal the ledger to the pesewa |
| 15 | 17 | Inventory: stock items, recipes, deduction, purchases, wastage, counts, low-stock alerts | |
| 16 | 21–22 | Security hardening, load test (peak-hour simulation), penetration checklist, runbooks | Definition of Done (§N) |
| 17 | later | Automated MoMo (provider API), multi-branch reporting, local hub, online ordering | |

Offline (step 13) comes after the core loop, but the core loop is **built offline-ready from day one**: client UUIDs, outbox and idempotent RPCs. Step 13 adds the LAN fallback and number leases on top.

---

## M. Risks

| # | Area | Risk | Mitigation |
|---|---|---|---|
| 1 | **Printing** | Network printers give no reliable delivery acknowledgement. Cheap printers drop off Wi-Fi. Codepage issues garble text. | Wired Ethernet for kitchen printers (install requirement). At-least-once delivery with duplicate marking. DLE EOT status polling. Backup routing. Dead-job alerts. KDS as a parallel channel. Fake-printer CI plus a hardware test lab with the actual printer models before go-live. |
| 2 | **Realtime** | Silent socket death on flaky Wi-Fi: the KDS *looks* fine but is stale. | Safety poll and refetch on reconnect, connection indicator, ticket-age alarm ("no new tickets for 20 min during service" warning). |
| 3 | **Offline** | Split-brain between offline POS and cloud. Price and stock drift. | Narrow offline scope (§I). Append-only merge. Destructive ops need online. Every offline claim has a test. The local hub is deferred rather than half-built. |
| 4 | **Duplicate orders** | Double-tap, retry after timeout, outbox replay. | Client UUIDs, `unique(submission_id, station_id)`, `dedupe_key` on print jobs and stock, send button disabled until acknowledged, 50× replay tests. |
| 5 | **Multi-station routing** | An unrouted product means food never made. Config changes mid-service. | Mandatory branch default route, coverage report, routing snapshot on items, "unrouted" alert, preview tool. |
| 6 | **Payment consistency** | Double charge; MoMo callback races; paid order still shows unpaid. | Payment id idempotency, unique provider_ref, payment_state derived in the same transaction, MoMo `pending` → webhook → `succeeded`, daily reconciliation report. |
| 7 | **Device connectivity** | Devices lose session or go offline unnoticed. | Heartbeats, sweeps, alerts, long-lived refresh tokens with re-pair flow. |
| 8 | **Supabase RLS** | A missing policy leaks data. A security definer function without tenant checks gives cross-tenant writes. Slow policies under load. | CI RLS coverage test, cross-tenant suite, definer functions only in `app` with explicit checks, indexed `restaurant_id`, helper functions marked `stable` and wrapped in `(select …)` so they're evaluated once per query, `EXPLAIN` checks on hot queries. |
| 9 | **Concurrent updates** | Two waiters edit a table; KDS double-bumps; merge while paying. | `SELECT … FOR UPDATE` on the order row in every mutating RPC, `version` checks with a clear "someone else changed this, refreshed" UX, consistent lock ordering (order, then items, then tickets) to avoid deadlocks, pgTAP concurrency tests with parallel sessions. |
| 10 | **Scope** | Breadth before reliability. | M1 gate; nothing after step 8 starts until M1 survives a real service. |
| 11 | **Tax correctness** | Ghana VAT and levy structure changes by budget; rounding. | Taxes fully configurable (inclusive or exclusive, compound, order). Rates confirmed with the restaurant's accountant, never hard-coded. Rounding rule documented and tested. |

---

## N. Definition of Done (production-ready)

**Reliability**
- [ ] §26 and §27 scenarios pass automated end-to-end tests on real Supabase and a fake printer, and in a manual run on the actual printer and KDS hardware.
- [ ] Replaying any submit or payment call 50× produces exactly one order, one ticket per station, one charge.
- [ ] Chaos matrix passes: Wi-Fi off mid-send, browser refresh mid-send, POS kill, KDS reconnect, printer unplugged, print agent restart, realtime blocked (poll only), internet down for 30 min then restored. **Zero lost orders, zero lost tickets, every failure visible.**
- [ ] Peak-load test: 3 POS, 6 KDS, 2 displays, 1 agent at 4× expected peak order rate for 2 hours. p95 submit < 500 ms, ticket on KDS < 2 s, printed < 5 s.
- [ ] Offline capabilities in §I behave exactly as documented. Anything not tested is removed from the docs and UI.

**Data consistency**
- [ ] Every report reconciles to the payments and orders ledger to the pesewa.
- [ ] Shift expected cash equals opening + cash charges − cash refunds ± cash movements, verified by tests.
- [ ] Order, item and ticket statuses can't contradict each other (property tests on the rollup).

**Security**
- [ ] 100% of public tables have RLS (CI-enforced). Cross-tenant suite passes for every table and RPC.
- [ ] No service key in any client bundle (CI-enforced). Secrets only in Supabase and Vercel secret stores.
- [ ] Permission matrix tests for every role × sensitive action.
- [ ] PIN and pairing brute-force limits verified.

**Operability**
- [ ] Owner can see printer, device, sync and payment problems in the app, with alerts, without developer help.
- [ ] Runbooks exist: printer offline, internet down, device replacement, end-of-day, restore from backup.
- [ ] Point-in-time recovery enabled on the Supabase plan; a restore has been rehearsed.
- [ ] Sentry wired for web and agent; alert routing to the owner's phone (push or SMS) for critical alerts.

**Usability**
- [ ] Waiter can open a table and send a 4-item order in ≤ 15 taps, measured with real staff.
- [ ] KDS readable at 2 m; all touch targets ≥ 48 px; works with greasy or gloved hands (large buttons, no small swipes).
- [ ] Staff trained. Pilot ran through at least 3 full peak services with no Sev-1 incident.

---

## O. Open Questions for the Owner

These decide details, not architecture. Where no answer comes, the defaults in brackets apply.

1. Does a Supabase project already exist, and are there existing menus or data to import? [new project, manual menu entry]
2. Which printers and POS hardware are on site or planned: brand, model, network vs USB, Android POS? [80 mm Ethernet ESC/POS, e.g. Epson TM-T20 / Xprinter class]
3. Which MoMo networks and aggregator (MTN MoMo, Telecel Cash, AirtelTigo via Hubtel or Paystack)? [manual reference entry in v1]
4. Tax setup: which levies apply and are prices tax-inclusive? [configurable, inclusive, rates from accountant]
5. Number of branches at launch? [1, schema supports many]
6. Is the product only for Bibiani Restaurant, or intended as SaaS for other restaurants from the start? [single tenant operationally, multi-tenant enforced in schema and tests]

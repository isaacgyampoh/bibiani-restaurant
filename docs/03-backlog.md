# Implementation Backlog

> **Phase 4 status (2026-09-25):** built and validated on hosted DEV:
> - AUTH-01 (platform script), AUTH-02 (roles, backend + admin), AUTH-03 (device pairing), CFG-01..08 (minimal admin), MENU-01/02/04, RTE-01/03 (admin), POS-01..05, KDS-01..03, KDS-05, DSP-01, TKW-01/02, HALL-01/02, ORD-05 (cancel/void), PAY-04 (receipts), DEV-01/02, parts of DEV-03, SEC-01 (partial).
> - **Not built:** PIN login (AUTH-04/05), MFA (AUTH-06), modifier admin, combos, discounts, shifts, table transfer/merge/split, marketing display, offline outbox in the POS and LAN print fallback (OFF-*), inventory, reports.
>
> **Phase 3 status and amendments (2026-09-25):**
> - Built in Phase 3 (backend and tests, no UI): DB-01..04 (partial: see migrations), ORD-01..04, ORD-08, RTE-02, PRN-01..04 and PRN-05 (backend: queue view + retry; reprint and alert centre not yet), PRN-07, PAY-01..03, PAY-05 (backend), AUD-01 (payments and print retries), part of DEV-02 (heartbeat).
> - PAY-02 changed and PAY-06 removed by [ADR 0002](adr/0002-manual-payments-v1.md): MoMo and card are manual records, and there are no provider integrations in V1. CFG-06 becomes an enable/disable setting over the fixed methods cash, momo and card.
> - FND-02: local Supabase needs Docker; tests use PGlite meanwhile ([07-testing-strategy.md](07-testing-strategy.md)).

Priority reflects **dependency and operational necessity only**, not a value ranking:

- **P0**: required for Milestone M1 (the reliable core loop: order → route → KDS/print → ready → display → pay → shift)
- **P1**: required before production go-live
- **P2**: after go-live

Every item also inherits the global Definition of Done in [01-architecture.md §N](01-architecture.md#n-definition-of-done-production-ready): code reviewed, tests in CI, RLS covered, audit written for sensitive actions, no mock data in production paths.

Build sequence: see [01-architecture.md §L](01-architecture.md#l-implementation-plan).

---

## Epic FND — Foundation

### FND-01 · Monorepo, CI and quality gates
- **Priority:** P0 · **Depends on:** none
- **Story:** As an engineer, I want one repo with enforced checks so regressions can't reach the restaurant.
- **Description:** pnpm + Turborepo workspace (`apps/web`, `apps/print-agent`, `packages/domain`, `packages/escpos`, `packages/db-types`, `supabase/`). GitHub Actions: lint, typecheck, Vitest, pgTAP, Playwright, bundle secret scan.
- **Acceptance:** A PR with a type error, failing test, or `service_role` string in a built bundle fails CI. `pnpm dev` starts the web app against the dev Supabase.
- **Technical notes:** Strict TS. ESLint with import boundaries between modules. Renovate for dependencies.
- **Testing:** CI self-test: a deliberately failing fixture branch.

### FND-02 · Supabase environments and migration pipeline
- **Priority:** P0 · **Depends on:** FND-01
- **Story:** As an engineer, I want reproducible dev/staging/prod databases so schema changes are safe.
- **Description:** Supabase projects for dev, staging and prod. `supabase/migrations` ordered SQL. Type generation into `packages/db-types`. CI runs migrations on an ephemeral database, then pgTAP.
- **Acceptance:** A fresh database reaches the current schema with one command. Generated types match. Prod deploys only via tagged release.
- **Technical notes:** Needs Docker/OrbStack locally or a CI-hosted Postgres. PITR enabled on prod.
- **Testing:** Migration up from zero in CI on every PR.

### FND-03 · Domain package: money, tax, rollup mirror
- **Priority:** P0 · **Depends on:** FND-01
- **Story:** As an engineer, I want one tested implementation of money and tax maths shared by the UI previews.
- **Description:** `Money` (bigint minor units, currency), tax calculation (inclusive/exclusive/compound, ordered), rounding rule, status rollup function, zod schemas for RPC payloads.
- **Acceptance:** No `number` arithmetic on money anywhere in the app (lint rule). Rounding rule documented.
- **Technical notes:** The SQL is authoritative. The parity fixture set is shared with pgTAP (see ORD-03).
- **Testing:** Property-based tests (fast-check) for tax and rollup. Parity fixtures.

### FND-04 · Observability baseline
- **Priority:** P0 · **Depends on:** FND-02
- **Story:** As an owner, I want failures recorded so problems are visible without a developer.
- **Description:** Sentry for web and agent. `client_errors` ingestion RPC (rate-limited). Structured logs in Edge Functions.
- **Acceptance:** A thrown error on a KDS appears in Sentry with device name and branch, and in `client_errors`.
- **Technical notes:** Scrub PII (phones, names) from Sentry payloads.
- **Testing:** Integration test posts an error and asserts the row. Rate-limit test.

### FND-05 · Touch-first design system
- **Priority:** P0 · **Depends on:** FND-01
- **Story:** As staff on a busy shift, I want large, clear, consistent controls so I don't mis-tap.
- **Description:** Tailwind tokens, Radix-based components: buttons (≥48 px), numeric keypad, PIN pad, modal sheet, status badge, toast, connection indicator, ticket card, order tile. Light and dark (KDS dark default).
- **Acceptance:** Component gallery page. WCAG AA contrast. No layout breakage at 768×1024 and 1920×1080.
- **Technical notes:** No gradients or decorative motion. Transitions ≤150 ms.
- **Testing:** Playwright visual snapshots. axe checks.

---

## Epic DB — Schema and tenancy

### DB-01 · Tenancy, identity and configuration migrations
- **Priority:** P0 · **Depends on:** FND-02
- **Story:** As the platform, I need tenant-scoped tables for restaurants, branches, staff, roles, stations, devices, printers and menu.
- **Description:** Implement the corresponding sections of `02-proposed-schema.sql` as migrations, with RLS enabled and policies per table.
- **Acceptance:** Every table has RLS and `restaurant_id` indexed. Config writes gated by permission.
- **Technical notes:** Wrap helpers as `(select app.fn())` in policies for initplan caching.
- **Testing:** pgTAP: schema, constraints, policies.

### DB-02 · Operational migrations: orders, submissions, items, tickets, events
- **Priority:** P0 · **Depends on:** DB-01
- **Story:** As the order engine, I need persistent, constraint-protected order and production tables.
- **Description:** orders, order_submissions, order_items, modifiers, discounts, taxes, production_tickets(+items, events), order_events, counters. No direct write policies.
- **Acceptance:** Direct `insert into orders` as an authenticated user fails. Unique constraints from the design exist.
- **Technical notes:** Check constraints on money ≥ 0 where applicable.
- **Testing:** pgTAP: direct writes denied, constraints enforced.

### DB-03 · Printing, payments, shifts, alerts, audit migrations
- **Priority:** P0 · **Depends on:** DB-01
- **Story:** As the platform, I need durable print queues, payment ledger, shift and audit tables.
- **Description:** print_jobs(+attempts, templates), payment_methods, payments, shifts, cash_movements, alerts, audit_logs, client_errors, idempotency_keys, staff_sessions.
- **Acceptance:** audit_logs can't be updated or deleted by any non-superuser role.
- **Technical notes:** Partial indexes for queue scans.
- **Testing:** pgTAP: revokes, unique dedupe keys.

### DB-04 · Tenant isolation test suite
- **Priority:** P0 · **Depends on:** DB-01..03
- **Story:** As an owner, I want a guarantee that no other restaurant can see or change my data.
- **Description:** Two seeded tenants. For every table: select, insert, update, delete as tenant A's owner, cashier, KDS device and display device against B's rows. For every RPC: call with B's ids.
- **Acceptance:** 0 cross-tenant reads/writes. A CI meta-test fails if any `public` table lacks RLS or any RPC lacks a test entry.
- **Technical notes:** Generate the table list from `pg_catalog` so new tables are covered automatically.
- **Testing:** This item *is* the test suite. Runs on every PR.

### DB-05 · Demo/seed tenant (non-production)
- **Priority:** P0 · **Depends on:** DB-01..03
- **Story:** As an engineer or trainer, I want a realistic sandbox restaurant separate from real data.
- **Description:** Seed script creating "Demo Restaurant": stations Kitchen, Grill, Pastry, Drinks; §26/§27 products; tables 1–20.
- **Acceptance:** Seed only runs against dev/staging (guarded by env). Never on prod.
- **Technical notes:** The same fixtures drive E2E tests.
- **Testing:** Seed then E2E smoke.

---

## Epic AUTH — Authentication and authorization

### AUTH-01 · Owner sign-up and restaurant onboarding
- **Priority:** P0 · **Depends on:** DB-01
- **Story:** As a restaurant owner, I want to create my restaurant and first branch so I can configure it.
- **Description:** Email/password sign-up, then an onboarding wizard (restaurant name, currency, timezone, first branch). Creates Owner role and staff row via Edge Function (service role, audited).
- **Acceptance:** New owner lands in admin with a branch. A second restaurant is fully isolated.
- **Technical notes:** Platform-controlled sign-up toggle (invite-only at first).
- **Testing:** E2E onboarding. pgTAP ownership.

### AUTH-02 · Roles and permissions management
- **Priority:** P0 · **Depends on:** AUTH-01
- **Story:** As an owner, I want to assign roles with specific permissions, optionally per branch.
- **Description:** Seeded permission catalogue and system role templates. UI to create or edit roles, assign staff and branch scope.
- **Acceptance:** Removing `order.void` from Cashier makes `void_items` fail for cashiers immediately.
- **Technical notes:** Permission changes are audited (`role.permission_change`).
- **Testing:** Matrix test: role × permission × RPC.

### AUTH-03 · Device pairing
- **Priority:** P0 · **Depends on:** DB-01
- **Story:** As a manager, I want to pair a tablet as "PASTRY-KDS-01" with a short code so it only sees what it should.
- **Description:** Admin generates a code (hashed, 10 min TTL, 5 attempts). `/pair` page. Edge Function creates a device auth user and returns a session.
- **Acceptance:** Paired KDS can read only its branch. Revoked device loses data access immediately (RLS `is_active`).
- **Technical notes:** Store refresh token in IndexedDB. Handle re-pair.
- **Testing:** Brute-force lockout. Revoke test. Cross-branch denial.

### AUTH-04 · Staff PIN sessions on shared devices
- **Priority:** P0 · **Depends on:** AUTH-03
- **Story:** As a cashier, I want to switch into the POS with my PIN in two seconds.
- **Description:** `pin_login` RPC (bcrypt check, 5-fail lockout for 5 min), device-bound `staff_sessions` (idle timeout configurable), quick user switch.
- **Acceptance:** Every operational RPC records the staff member. A PIN from another restaurant fails.
- **Technical notes:** Unique PIN per restaurant enforced at set time.
- **Testing:** Lockout, expiry, device binding.

### AUTH-05 · Manager override
- **Priority:** P0 · **Depends on:** AUTH-04
- **Story:** As a cashier, I want a manager to approve a void or big discount on my screen without logging me out.
- **Description:** Override modal takes a manager PIN. RPC verifies the approver's permission and records `approved_by`.
- **Acceptance:** Void after preparation without an approver is rejected server-side.
- **Technical notes:** Thresholds configured per restaurant.
- **Testing:** Approver lacking permission → rejected.

### AUTH-06 · MFA for owners and platform admins
- **Priority:** P1 · **Depends on:** AUTH-01
- **Story:** As an owner, I want my account protected beyond a password.
- **Description:** Supabase TOTP MFA. Required for Owner and platform roles to access admin.
- **Acceptance:** Owner without MFA is prompted to enrol. AAL2 required by admin RPCs.
- **Technical notes:** Check `auth.jwt()->>'aal'` in admin-only RPCs.
- **Testing:** RPC denied at AAL1.

---

## Epic CFG — Restaurant configuration

### CFG-01 · Branches
- **Priority:** P0 · **Depends on:** AUTH-02
- **Story:** As an owner, I want to manage branches with their own business-day cutoff and settings.
- **Description:** Admin screens to create and edit branches: name, code, address, phone, business-day cutoff, per-branch settings (receipt footer, default order type).
- **Acceptance:** Create, edit and deactivate a branch. Deactivated branches reject new orders.
- **Technical notes:** `business_day` computed by `app.business_day(branch, ts)`.
- **Testing:** Cutoff edge cases (03:59 / 04:00).

### CFG-02 · Production stations
- **Priority:** P0 · **Depends on:** CFG-01
- **Story:** As an owner, I want to define my own stations (Kitchen, Grill, Pastry, Bar...) without code changes.
- **Description:** CRUD, colour, code, target prep time, auto-accept, auto-ready.
- **Acceptance:** A new station can receive tickets once it has a route and an output. Deactivating a station with routes warns and shows the coverage impact.
- **Technical notes:** Station `code` is unique per branch and used in device names and ticket headers.
- **Testing:** Deactivation guard.

### CFG-03 · Order types
- **Priority:** P0 · **Depends on:** CFG-01
- **Story:** As an owner, I want order types like "Hall", "Takeaway", "Staff meal" mapped to behaviours.
- **Description:** Name, channel, requires table or name, customer-display visibility, service charge.
- **Acceptance:** A dine-in type requires a table on submit (server check).
- **Technical notes:** `channel` is the fixed behaviour key. `name` is free text, so restaurants rename freely.
- **Testing:** RPC validation tests.

### CFG-04 · Floors, sections and table layout editor
- **Priority:** P1 · **Depends on:** CFG-01
- **Story:** As a manager, I want to draw my hall so staff see a real floor map.
- **Description:** Drag-and-drop layout (position, size, shape, rotation), labels, capacity, sections.
- **Acceptance:** Layout persists and renders identically on POS at different resolutions (relative coordinates).
- **Technical notes:** Coordinates stored relative to the canvas (0–1000 grid) so maps scale across screens.
- **Testing:** Playwright drag tests.

### CFG-05 · Taxes and service charges
- **Priority:** P0 · **Depends on:** CFG-01
- **Story:** As an accountant, I want to configure taxes (inclusive or exclusive, compound, order) and service charges.
- **Description:** Admin screens for tax rates (basis points, inclusive or exclusive, compound flag, apply order) and service charges (percent or fixed, taxable flag), assignable to products and order types.
- **Acceptance:** Test calculator shows the breakdown for a sample basket. Changes apply only to new orders.
- **Technical notes:** No hard-coded Ghana rates. Rates entered from the accountant's instruction.
- **Testing:** Parity fixtures SQL ↔ TS.

### CFG-06 · Payment methods
- **Priority:** P0 · **Depends on:** CFG-01
- **Story:** As an owner, I want to configure Cash, MTN MoMo, Telecel Cash, Card...
- **Description:** Admin screens for payment methods: name, kind, provider key, reference-required, opens-drawer flag, sort order, active flag.
- **Acceptance:** Kind, reference required, opens drawer, sort order. Inactive methods hidden on POS.
- **Technical notes:** Kind drives reporting and shift maths. Name is display only.
- **Testing:** Validation.

### CFG-07 · Branding, receipt and ticket templates
- **Priority:** P1 · **Depends on:** CFG-01, PRN-01
- **Story:** As an owner, I want my logo, header and footer on receipts and displays, and a readable kitchen ticket layout.
- **Description:** Structured template blocks (logo, text, order meta, lines, totals, QR, barcode). Live preview at 58/80 mm.
- **Acceptance:** Preview matches actual print on the fake printer renderer.
- **Technical notes:** Templates are JSON block lists rendered by `packages/escpos`, not HTML, so output is predictable on thermal paper.
- **Testing:** Snapshot of rendered ESC/POS bytes.

### CFG-08 · Staff management
- **Priority:** P0 · **Depends on:** AUTH-02
- **Story:** As a manager, I want to add staff, set PINs and roles, and deactivate leavers.
- **Description:** Staff directory: create PIN-only or login staff, set or reset PIN, assign roles with branch scope, deactivate. Deactivation ends active staff_sessions.
- **Acceptance:** Deactivated staff can't PIN in. Historical records keep their name.
- **Technical notes:** PINs set via RPC that hashes server-side. The PIN never stored or logged in plain text.
- **Testing:** Deactivation and session kill.

---

## Epic MENU — Products and categories

### MENU-01 · Categories
- **Priority:** P0 · **Depends on:** CFG-01
- **Story:** As a manager, I want nested categories with colours and ordering for fast POS navigation.
- **Description:** Category tree CRUD with colour, image, sort order and active flag, used by POS navigation and category routing.
- **Acceptance:** Reorder by drag. Category with products can't be hard-deleted.
- **Technical notes:** Soft-deactivate rather than delete. Category tree depth limited to 3 for POS usability.
- **Testing:** Constraint tests.

### MENU-02 · Products (with images)
- **Priority:** P0 · **Depends on:** MENU-01, CFG-05
- **Story:** As a manager, I want to create products with price, kitchen name, taxes, image, SKU and barcode.
- **Description:** CRUD, soft delete, image upload to Storage (resized), `requires_preparation`, `track_stock`.
- **Acceptance:** Price change is audited and doesn't alter existing orders.
- **Technical notes:** `version` increments; POS menu cache keyed by max version.
- **Testing:** Audit written. Snapshot integrity.

### MENU-03 · Modifiers and add-ons
- **Priority:** P0 · **Depends on:** MENU-02
- **Story:** As a waiter, I want to add "No pepper" or "Extra chicken" with correct pricing and min/max rules.
- **Description:** Modifier groups (min/max selection) and modifiers (price delta, optional linked product for stock), attached to products in order.
- **Acceptance:** Server rejects selections violating min/max. Modifiers print on tickets.
- **Technical notes:** Modifier snapshots copied to order_item_modifiers at submit.
- **Testing:** Validation matrix.

### MENU-04 · Branch availability and "86" (sold out)
- **Priority:** P0 · **Depends on:** MENU-02
- **Story:** As a kitchen lead, I want to mark Meat Pie sold out so POS stops selling it immediately.
- **Description:** Per-branch price overrides and availability toggle, reachable from admin and from a quick '86 board' on POS and KDS for users with permission.
- **Acceptance:** Sold-out item greys out on all POS within 2 s (realtime) or on next poll. Server rejects it on submit.
- **Technical notes:** Availability broadcast on `branch:{id}:orders` topic as a menu-version bump.
- **Testing:** Race: submit during 86 → rejected with clear message.

### MENU-05 · Combos
- **Priority:** P1 · **Depends on:** MENU-02, RTE-02
- **Story:** As a manager, I want combo meals whose parts go to different stations.
- **Description:** Combo products with component list. Price is on the combo line; components are child order_items with zero price, routed individually.
- **Acceptance:** "Burger Meal" produces Grill (burger) and Drinks (Coke) tickets, with one price line on the receipt.
- **Technical notes:** Combo children carry `parent_item_id`. Receipts collapse children under the parent line.
- **Testing:** Routing and pricing tests.

---

## Epic RTE — Routing engine

### RTE-01 · Routing rules administration
- **Priority:** P0 · **Depends on:** CFG-02, MENU-02
- **Story:** As an owner, I want to say "Pastries → Pastry station" and "Birthday Cake also → Pastry Display 2".
- **Description:** Rules by product, category or default, optional order type, priority, extra outputs. Mandatory branch default.
- **Acceptance:** Can't delete the last default rule. Conflicts at the same priority are flagged.
- **Technical notes:** Partial unique index guarantees one active default rule per branch.
- **Testing:** Constraint tests.

### RTE-02 · Routing resolution function
- **Priority:** P0 · **Depends on:** RTE-01
- **Story:** As the order engine, I need a deterministic station for every item.
- **Description:** `app.resolve_station(branch, product, order_type)`: product rule, then category (walk tree), then default; order-type-specific first; combo expansion.
- **Acceptance:** Deterministic for the same inputs. p95 < 2 ms per item.
- **Technical notes:** Implemented in SQL. The TS mirror in `packages/domain` is used only for preview and offline LAN printing, and is checked by parity tests.
- **Testing:** pgTAP table-driven tests covering every precedence path.

### RTE-03 · Routing preview and coverage report
- **Priority:** P0 · **Depends on:** RTE-02
- **Story:** As an owner, I want to see where each product will go and be warned about unrouted products or stations with no output.
- **Description:** Admin page: pick product and order type and see the resolved station plus every output device. Coverage report across all products and stations.
- **Acceptance:** Coverage page lists products resolving only to the default, and stations with zero active outputs (critical).
- **Technical notes:** Coverage query is a SQL function so it can also run as a nightly check that raises an alert.
- **Testing:** Fixture with gaps → report lists them.

### RTE-04 · Station outputs (printers, KDS, backup, copies)
- **Priority:** P0 · **Depends on:** CFG-02, DEV-01
- **Story:** As an owner, I want the Pastry station to print on Pastry Printer and show on Pastry KDS, with a backup printer.
- **Description:** Assign KDS screens and printers to each station with role (primary, copy, backup) and copy count.
- **Acceptance:** Outputs with primary, copy and backup roles and copy count. Backup used only on primary failure (PRN-04).
- **Technical notes:** A station with a KDS but no printer is valid. A station with neither is flagged critical.
- **Testing:** Job generation tests.

---

## Epic ORD — Order engine

### ORD-01 · Draft and open orders
- **Priority:** P0 · **Depends on:** DB-02, AUTH-04
- **Story:** As a waiter, I want to open Table 12 and build the order before sending.
- **Description:** `upsert_draft_order` (client uuid), pending items, one active order per table.
- **Acceptance:** Two tablets opening the same table get the same order (second call returns existing).
- **Technical notes:** `insert … on conflict (id) do nothing`, then select. Unique partial index on active order per table.
- **Testing:** Concurrency test with parallel sessions.

### ORD-02 · submit_order: transactional submit, route, ticket, outbox
- **Priority:** P0 · **Depends on:** ORD-01, RTE-02, RTE-04, CFG-05
- **Story:** As a waiter, I want one tap to send an order to every right station, exactly once.
- **Description:** Single-transaction RPC per architecture §F.1: lock, idempotency check, server pricing, items, routing, tickets, print jobs, totals, events, broadcast.
- **Acceptance:** §26 and §27 produce exactly the documented tickets. Replaying the same submission 50× yields identical results and no extra rows. Invalid product aborts the whole transaction.
- **Technical notes:** Lock order: order → items → tickets. Returns full order payload.
- **Testing:** pgTAP scenario tests. Replay test. Concurrent double-submit from two sessions.

### ORD-03 · Status rollup
- **Priority:** P0 · **Depends on:** ORD-02
- **Story:** As a waiter or customer, I want the order status to reflect item and ticket reality.
- **Description:** `app.recompute_order_status` per the rules in the schema doc, including partially_ready, served or picked_up, completed only when paid, and the held overlay.
- **Acceptance:** Every transition in §26 yields the expected order state. Recall moves ready → partially_ready.
- **Technical notes:** Pure function of item statuses plus held and paid flags. Called at the end of every mutating RPC.
- **Testing:** Exhaustive state-table tests. TS/SQL parity fixtures. Property tests.

### ORD-04 · Order numbering and business day
- **Priority:** P0 · **Depends on:** CFG-01
- **Story:** As a customer, I want a short order number that's unique today at this branch.
- **Description:** Counter row with `update … returning` under lock. Business-day cutoff. Configurable start (e.g. 5001).
- **Acceptance:** 1000 concurrent allocations produce no duplicates and no gaps online.
- **Technical notes:** Counter row locked per branch-day. Contention is negligible at restaurant scale.
- **Testing:** Concurrency test.

### ORD-05 · Void items and cancel orders
- **Priority:** P0 · **Depends on:** ORD-02, AUTH-05, PRN-02
- **Story:** As a manager, I want to void a sent item or cancel an order with a reason, and the station must know.
- **Description:** `void_items` and `cancel_order` RPCs: status changes, void print jobs, ticket updates, stock reversal, rollup, audit. Blocked when paid until refunded.
- **Acceptance:** Void prints a VOID slip to the same station and strikes it on KDS. Reason and approver audited. Paid orders require refund first.
- **Technical notes:** Void slips use `void_ticket` print kind and a dedupe key per item and void event.
- **Testing:** Void, cancel and paid-guard tests. Audit rows.

### ORD-06 · Discounts
- **Priority:** P1 · **Depends on:** ORD-02, AUTH-05
- **Story:** As a cashier, I want to apply item or order discounts (percent or fixed) within my limits.
- **Description:** Item- and order-level discounts (percent or fixed) with reason, applied through an RPC that recomputes tax and totals and enforces per-role limits.
- **Acceptance:** Above-threshold discount requires override. Totals recomputed server-side. Audited.
- **Technical notes:** Discounts apply before tax for exclusive taxes. Inclusive tax re-derived from the discounted gross. Rule documented in FND-03.
- **Testing:** Tax-after-discount maths. Threshold tests.

### ORD-07 · Order timeline
- **Priority:** P1 · **Depends on:** ORD-02
- **Story:** As a manager, I want to see everything that happened to order #5001.
- **Description:** Read model joining order_events, production_ticket_events, print_job_attempts, payments and audit_logs for one order, shown in admin and POS.
- **Acceptance:** Timeline shows submissions, tickets, status changes, prints, payments, voids, with staff and device.
- **Technical notes:** Implemented as a SQL function returning a unified, time-ordered event list.
- **Testing:** Snapshot of the §26 timeline.

### ORD-08 · Realtime broadcast triggers and channel auth
- **Priority:** P0 · **Depends on:** DB-02
- **Story:** As a KDS, I want to be told within a second that my station has a new ticket.
- **Description:** Triggers calling `realtime.send` on private topics. RLS on `realtime.messages`.
- **Acceptance:** A KDS for Pastry never receives Grill topic messages. Another tenant can't join topics.
- **Technical notes:** Topic names built by a single SQL helper so KDS and triggers can't disagree.
- **Testing:** Integration test with two clients. Unauthorized join rejected.

---

## Epic POS

### POS-01 · POS shell, catalogue, search, barcode
- **Priority:** P0 · **Depends on:** FND-05, MENU-02, AUTH-04
- **Story:** As a cashier, I want to find any product in two taps or by search or scan.
- **Description:** The POS app shell: device and staff header, connection indicator, order-type switcher, category grid, product tiles, search box, scanner input.
- **Acceptance:** Category grid, search under 100 ms from local cache, USB/Bluetooth scanner input (keyboard wedge).
- **Technical notes:** Product list served from the OFF-01 cache. Scanner handled by a global keydown buffer with a timing heuristic.
- **Testing:** Playwright. Scanner simulation.

### POS-02 · Cart, modifiers, notes, quantity
- **Priority:** P0 · **Depends on:** POS-01, MENU-03
- **Story:** As a cashier, I want to build an order with modifiers and notes quickly.
- **Description:** Cart panel: add or remove lines, quantity stepper, modifier sheet, line and order notes, seat and course fields, live totals preview.
- **Acceptance:** Required modifier groups prompt automatically. Totals preview matches the server result.
- **Technical notes:** Cart state in IndexedDB-backed store so a refresh keeps the in-progress order.
- **Testing:** Parity with server totals on submit.

### POS-03 · Send with outbox and acknowledgement
- **Priority:** P0 · **Depends on:** POS-02, ORD-02, OFF-02
- **Story:** As a cashier, I want "Send" to either confirm or clearly queue, never silently fail.
- **Description:** Send action writes the submission to the outbox, calls `submit_order`, handles ack, retry and queued states, and shows the order number from the server (or a lease number offline).
- **Acceptance:** Button locks until acknowledged. On network error the order shows "Queued – will send"; on reconnect it sends with no duplicate. Refresh doesn't lose it.
- **Technical notes:** Idempotency via client submission uuid. UI state machine: idle, sending, acked, queued, failed-needs-attention.
- **Testing:** Playwright with network throttling, offline toggling and page reload mid-send.

### POS-04 · Open orders list and recall
- **Priority:** P0 · **Depends on:** POS-03
- **Story:** As a cashier, I want to see and reopen open orders to add items or take payment.
- **Description:** List of open orders for the branch with live status, filters, search by number or name, and open-to-edit.
- **Acceptance:** Filter by type and status. Live status badges. Adding items creates a new submission.
- **Technical notes:** Data from TanStack Query invalidated by realtime and safety poll.
- **Testing:** E2E add-round flow.

### POS-05 · Checkout screen
- **Priority:** P0 · **Depends on:** POS-04, PAY-01
- **Story:** As a cashier, I want a fast checkout with quick-cash buttons and clear change due.
- **Description:** Payment screen: amount due, method buttons, quick-cash amounts, tendered and change, split tender list, receipt options.
- **Acceptance:** Quick amounts, change calculation, split entry, print or skip receipt.
- **Technical notes:** Change and remaining balance computed with the `Money` type. The server result is authoritative on submit.
- **Testing:** E2E cash sale.

---

## Epic KDS

### KDS-01 · Station board
- **Priority:** P0 · **Depends on:** FND-05, ORD-02, ORD-08, AUTH-03
- **Story:** As a pastry cook, I want to see only my station's tickets, oldest first, readable from 2 m.
- **Description:** Ticket cards (order #, type, table or name, time, items, modifiers, notes, age), age colouring vs target, new-ticket chime, priority flag.
- **Acceptance:** New ticket appears < 2 s after submit. Layout adapts 1–4 rows. Dark theme.
- **Technical notes:** Virtualised list is unnecessary at this volume. Keep DOM simple for low-end Android tablets.
- **Testing:** Playwright with seeded tickets. Visual snapshot.

### KDS-02 · Ticket actions
- **Priority:** P0 · **Depends on:** KDS-01
- **Story:** As a cook, I want Accept, Start, Pause, Ready, Recall and per-item bump with one tap.
- **Description:** Touch actions on ticket cards and items mapped to `ticket_transition` / `item_transition` RPCs, with optimistic UI rolled back on version conflict.
- **Acceptance:** Actions call `ticket_transition` with version. Conflicting taps from two screens: one wins, the other refreshes with a toast. Undo available for 5 s after Ready.
- **Technical notes:** Every action passes `expected_version`. The server rejects stale actions with a typed error.
- **Testing:** pgTAP transition table. Concurrency test.

### KDS-03 · Recovery protocol
- **Priority:** P0 · **Depends on:** KDS-01
- **Story:** As a kitchen, we must never miss a ticket because the Wi-Fi blinked.
- **Description:** Full refetch on subscribe, reconnect, visibility and online events. 20 s safety poll. Connection indicator. Stale banner.
- **Acceptance:** With realtime blocked entirely, tickets still appear within 20 s. After 5 min offline, all tickets appear on reconnect.
- **Technical notes:** Shared `useResilientQuery` hook used by all operational screens.
- **Testing:** Playwright with WebSocket blocked. Network drop.

### KDS-04 · Expo / all-stations view
- **Priority:** P1 · **Depends on:** KDS-02
- **Story:** As an expeditor, I want to see all stations for an order and know when it's complete.
- **Description:** An expeditor mode showing orders grouped across stations with per-station progress and serve or pickup actions.
- **Acceptance:** Order-grouped view with per-station status. Mark served or picked up.
- **Technical notes:** Reads tickets across all stations of the branch; requires `kitchen.expo` permission.
- **Testing:** §26 flow on expo.

### KDS-05 · Printer health on KDS
- **Priority:** P0 · **Depends on:** KDS-01, PRN-03
- **Story:** As a cook, I want to know if my station printer is down.
- **Description:** KDS subscribes to its station printers' status and dead or uncertain print jobs, and shows a persistent banner until resolved.
- **Acceptance:** Red banner "Printer offline — N unprinted" within 60 s of failure.
- **Technical notes:** Printer status comes from agent heartbeats stored on `printers` and from the `alerts` table.
- **Testing:** Fake printer down → banner.

---

## Epic PRN — Printing

### PRN-01 · ESC/POS document renderer
- **Priority:** P0 · **Depends on:** FND-01
- **Story:** As the print agent, I need to turn document models into printer bytes reliably.
- **Description:** `packages/escpos`: text styles, sizes, alignment, columns, codepages, logo raster, QR/barcode, cut, drawer kick, "POSSIBLE DUPLICATE" banner.
- **Acceptance:** Renders 58 mm and 80 mm. Byte snapshots stable.
- **Technical notes:** Pure TS, no native deps, so the same package runs in the agent and in admin preview.
- **Testing:** Byte snapshot tests. Render to PNG for review.

### PRN-02 · Print agent core
- **Priority:** P0 · **Depends on:** PRN-01, AUTH-03, PRN-03
- **Story:** As a restaurant, I want a small service that reliably drives all our printers.
- **Description:** Node service: device identity, realtime nudge plus 5 s poll, claim with lease, status query, TCP send with timeout, report outcome, heartbeat with printer statuses. Installer as a system service (Windows service / systemd).
- **Acceptance:** Agent restart mid-job: job re-claimed after lease expiry, printed with duplicate marker only if bytes may have been sent.
- **Technical notes:** Local job journal (SQLite) for dedupe across restarts.
- **Testing:** Against fake printer (PRN-07) with fault injection.

### PRN-03 · Queue RPCs and retry sweep
- **Priority:** P0 · **Depends on:** DB-03
- **Story:** As the platform, I need job claiming, completion, backoff and lease expiry.
- **Description:** `claim_print_jobs` (SKIP LOCKED), `complete_print_job`, pg_cron sweep for expired leases and backoff.
- **Acceptance:** Two agents never print the same job concurrently. Expired leases return to pending.
- **Technical notes:** `claim_print_jobs` uses `for update skip locked` and sets a 30 s `lease_expires_at`.
- **Testing:** pgTAP concurrency. Lease expiry.

### PRN-04 · Backup routing and dead-job alerts
- **Priority:** P0 · **Depends on:** PRN-03, DEV-03
- **Story:** As a manager, I want tickets to go to the backup printer if the main one fails, and to be told.
- **Description:** Server-side reroute logic in the retry sweep plus alert creation and auto-resolution when the printer recovers.
- **Acceptance:** After 3 failed attempts, job reroutes to backup (original kept). Exhausted jobs become `dead` with a critical alert. Nothing is deleted.
- **Technical notes:** Reroute threshold and max attempts configurable per branch.
- **Testing:** Fault injection scenarios.

### PRN-05 · Print queue UI and reprint
- **Priority:** P0 · **Depends on:** PRN-03
- **Story:** As a manager, I want to see failed prints and retry, redirect or reprint any ticket or receipt.
- **Description:** Admin and manager screen listing jobs by printer and status with retry, redirect, cancel and reprint actions.
- **Acceptance:** Queue per printer with status. Retry, send to other printer, cancel (with reason). Reprints labelled REPRINT and audited.
- **Technical notes:** Reprint creates a new job with `is_reprint=true` and a new dedupe key. Original history kept.
- **Testing:** E2E reprint.

### PRN-06 · Test print and printer registration
- **Priority:** P0 · **Depends on:** PRN-02, DEV-01
- **Story:** As an installer, I want to add a printer by IP and test it.
- **Description:** Printer create and edit form (connection, address, agent, paper width, codepage, backup) and a Test Print action that queues a `test` job.
- **Acceptance:** Test print shows printer name, IP, time, codepage sample. Status reflected in admin.
- **Technical notes:** Test print also measures round-trip time, stored for diagnostics.
- **Testing:** Fake printer.

### PRN-07 · Fake ESC/POS printer harness
- **Priority:** P0 · **Depends on:** PRN-01
- **Story:** As an engineer, I need to test printing without hardware.
- **Description:** TCP 9100 server that records jobs and can simulate offline, paper-out, slow and mid-stream disconnect.
- **Acceptance:** Used by CI E2E.
- **Technical notes:** Node TCP server in `apps/print-agent/test`, controllable over HTTP for fault injection.
- **Testing:** Self-tests.

### PRN-08 · Cash drawer kick
- **Priority:** P1 · **Depends on:** PRN-02, PAY-01
- **Story:** As a cashier, I want the drawer to open on cash payment only.
- **Description:** Drawer pulse appended to receipt jobs for drawer-opening methods, and a permissioned 'No sale' action.
- **Acceptance:** Drawer pulse sent only for methods with `opens_drawer`. "No sale" open requires permission and is audited.
- **Technical notes:** Drawer pulse bytes (ESC p) configurable per printer model.
- **Testing:** Fake printer receives the pulse bytes.

---

## Epic PAY — Payments

### PAY-01 · Record cash payment
- **Priority:** P0 · **Depends on:** ORD-02, CFG-06, SHF-01
- **Story:** As a cashier, I want to take cash, see change and close the order.
- **Description:** `record_payment` (client uuid), tendered and change, links to open shift, updates `payment_state`, completes order if fulfilled.
- **Acceptance:** Replay creates one payment. Payment without an open shift is rejected (configurable).
- **Technical notes:** `record_payment` locks the order row. `payment_state` and `paid_total` updated in the same transaction.
- **Testing:** Idempotency. Shift linkage.

### PAY-02 · Mobile Money and card (manual reference)
- **Priority:** P0 · **Depends on:** PAY-01
- **Story:** As a cashier, I want to record a MoMo or card payment with its reference.
- **Description:** Record non-cash payments with a provider reference and optional payer phone. Status `succeeded` when a human confirms receipt of funds.
- **Acceptance:** Reference required when configured. Duplicate reference for the same method rejected.
- **Technical notes:** Unique index on (method_id, provider_ref) enforces no duplicate references.
- **Testing:** Unique reference test.

### PAY-03 · Split and partial payments
- **Priority:** P0 · **Depends on:** PAY-01
- **Story:** As a cashier, I want to split a bill across methods or take a deposit.
- **Description:** Multiple payment rows per order with remaining-balance tracking. Optional split by amount or percentage in the UI.
- **Acceptance:** `partially_paid` until the total is covered. Overpayment only allowed on cash (as change).
- **Technical notes:** Remaining = grand_total − paid_total + refunded_total, computed server-side.
- **Testing:** Combinatorial tests.

### PAY-04 · Receipts and bills
- **Priority:** P0 · **Depends on:** PAY-01, PRN-02, CFG-07
- **Story:** As a customer, I want an accurate receipt. As a waiter, I want to print the bill before payment.
- **Description:** Receipt and pre-payment bill print jobs rendered from DB totals using templates. Reprint on demand.
- **Acceptance:** Receipt totals equal DB totals exactly, including the tax breakdown. Bill marks the table `payment_pending`.
- **Technical notes:** Receipt payload built by SQL function from persisted totals and taxes, never recalculated in the agent.
- **Testing:** Snapshot of rendered receipt.

### PAY-05 · Refunds
- **Priority:** P0 · **Depends on:** PAY-01, AUTH-05
- **Story:** As a manager, I want to refund all or part of a payment with a reason.
- **Description:** `refund_payment` RPC creating refund rows linked to the original charge, with approval, reason, shift impact and payment_state update.
- **Acceptance:** Refund ≤ remaining refundable amount. Cash refunds affect the shift. Idempotent. Audited. `payment_state` updated.
- **Technical notes:** Lock original payment row. Refundable = amount − sum(refunds).
- **Testing:** Over-refund rejected. Concurrent refunds.

### PAY-06 · MoMo provider integration
- **Priority:** P2 · **Depends on:** PAY-02
- **Story:** As a cashier, I want to push a MoMo prompt to the customer's phone and see confirmation automatically.
- **Description:** Edge Function to the provider (TBD: Hubtel, Paystack, MTN direct). Payment `pending`, then a signed webhook, then `succeeded`. Reconciliation job.
- **Acceptance:** Duplicate webhooks are harmless. Timeout leaves the payment pending, visible and resolvable.
- **Technical notes:** Provider secrets only in Edge Function env. Webhook signature verified and idempotent on provider_ref.
- **Testing:** Provider sandbox. Webhook replay.

---

## Epic SHF — Shifts

### SHF-01 · Open shift
- **Priority:** P0 · **Depends on:** AUTH-04, DB-03
- **Story:** As a cashier, I want to open my till with a counted float.
- **Description:** Open-shift flow on POS: count float, `open_shift` RPC, till bound to shift, sales blocked without a shift when configured.
- **Acceptance:** One open shift per till (DB constraint). Opening cash recorded.
- **Technical notes:** Partial unique index: one open shift per till device.
- **Testing:** Constraint test.

### SHF-02 · Cash movements and close with count
- **Priority:** P0 · **Depends on:** SHF-01, PAY-01
- **Story:** As a cashier, I want to record payouts and count my drawer by denomination at close.
- **Description:** Pay-in and payout entries during shift. Close flow: denomination count, `close_shift` computes expected cash and variance, prints the shift report.
- **Acceptance:** Expected cash computed server-side. Variance shown only after the count is submitted (blind close). Shift report printed.
- **Technical notes:** Expected cash = opening + cash charges − cash refunds + Σ cash_movements. Computed in `close_shift`.
- **Testing:** Variance maths fixtures.

### SHF-03 · Manager shift review
- **Priority:** P1 · **Depends on:** SHF-02
- **Story:** As a manager, I want to review and sign off shifts with variances.
- **Description:** Manager review screen: per-shift breakdown, variance, notes, sign-off that locks the shift from further changes.
- **Acceptance:** Per-method totals, refunds, voids, discounts. Review is audited and locks the shift.
- **Technical notes:** Reviewed shifts reject further cash movements (status check in RPCs).
- **Testing:** Report equals ledger.

---

## Epic HALL — Hall and tables

### HALL-01 · Live floor map
- **Priority:** P1 · **Depends on:** CFG-04, ORD-01
- **Story:** As a waiter, I want to see which tables are free, occupied, ready to serve or awaiting payment.
- **Description:** Floor map rendered from the layout with live table state derived from orders and table status.
- **Acceptance:** Status colours and badges update < 2 s. Tap to open the table.
- **Technical notes:** Floor map subscribes to `branch:{id}:tables` plus order status. Safety poll 60 s.
- **Testing:** E2E.

### HALL-02 · Table lifecycle
- **Priority:** P1 · **Depends on:** HALL-01
- **Story:** As staff, I want tables to move available → occupied → payment pending → cleaning → available.
- **Description:** Server-enforced table state machine driven by order events (open, bill printed, paid) and manual actions (clean done, reserve).
- **Acceptance:** Transitions enforced server-side. Reserved and out-of-service states manual.
- **Technical notes:** Status transitions via RPC only. Timestamps kept for turn-time reporting.
- **Testing:** Transition table.

### HALL-03 · Transfer and merge tables
- **Priority:** P1 · **Depends on:** HALL-02
- **Story:** As a waiter, I want to move a party to another table or combine two tables.
- **Description:** `transfer_table` and `merge_orders` RPCs locking both orders or tables in a consistent order.
- **Acceptance:** Merge moves items into the target order and marks the source `merged_into`. Both audited. Kitchen notified if configured.
- **Technical notes:** Lock rows in ascending id order to avoid deadlocks.
- **Testing:** Concurrency (merge while paying rejected).

### HALL-04 · Split bill and move items
- **Priority:** P1 · **Depends on:** HALL-03, PAY-03
- **Story:** As a waiter, I want to split by item, by seat or evenly.
- **Description:** `split_order` and `move_items` RPCs to split by item, by seat or evenly, producing child orders or payment allocations.
- **Acceptance:** Split creates child orders or payment allocations. Totals conserve to the pesewa.
- **Technical notes:** Rounding remainder assigned deterministically.
- **Testing:** Property test: sum of splits = original.

### HALL-05 · Guests, seats and courses
- **Priority:** P2 · **Depends on:** HALL-01
- **Story:** As a waiter, I want to hold mains until starters are done ("fire course 2").
- **Description:** Seat and course numbers on items. Held courses stay `pending` until a 'fire' submission routes them.
- **Acceptance:** Held course items are not routed until fired.
- **Technical notes:** Fire action creates a normal submission for held items, reusing the ORD-02 path.
- **Testing:** Routing on fire.

---

## Epic TKW — Takeaway

### TKW-01 · Takeaway order flow
- **Priority:** P0 · **Depends on:** POS-03
- **Story:** As a cashier, I want to take a takeaway order with the customer's name, phone and ETA.
- **Description:** Takeaway order type flow on POS: customer name and phone capture, pay-now or pay-at-pickup, ticket shows TAKEAWAY and name, ETA shown on screen and receipt.
- **Acceptance:** §27 scenario end to end. Name printed on tickets. ETA from station targets.
- **Technical notes:** ETA = max over routed stations of (queue-based estimate or target_prep_seconds).
- **Testing:** E2E §27.

### TKW-02 · Pickup board and handover
- **Priority:** P1 · **Depends on:** TKW-01, ORD-03
- **Story:** As counter staff, I want to see ready takeaway orders and mark them picked up.
- **Description:** Counter view of takeaway orders by status with a picked-up action and an unpaid guard.
- **Acceptance:** Ready list, mark picked up, unpaid warning before handover.
- **Technical notes:** Pickup is an `item_transition('serve')` bulk on the order, reusing the rollup.
- **Testing:** E2E.

---

## Epic DSP — Displays

### DSP-01 · Customer order display
- **Priority:** P0 · **Depends on:** ORD-03, ORD-08, AUTH-03
- **Story:** As a customer, I want to see when my order is preparing and when it's ready.
- **Description:** Preparing and Ready columns from `public_order_board`, large numbers, logo, chime on ready, full-screen, recovery protocol.
- **Acceptance:** "5001 READY" within 2 s of the last station bump. No PII shown.
- **Technical notes:** Reads only the `public_order_board` view. Display device role has no base-table grants.
- **Testing:** E2E. RLS: display device can't read orders' names or totals.

### DSP-02 · Marketing playlists admin
- **Priority:** P1 · **Depends on:** MENU-02
- **Story:** As an owner, I want to build playlists of promos, products and announcements with schedules.
- **Description:** Media upload to Storage, playlist builder with slide types (media, product, announcement, order_status), durations and schedules.
- **Acceptance:** Upload media (size limits), order slides, set durations and schedules, assign to displays.
- **Technical notes:** Storage path `media/<restaurant_id>/`. Upload limits enforced by bucket policy.
- **Testing:** Storage policies.

### DSP-03 · Marketing player
- **Priority:** P1 · **Depends on:** DSP-02
- **Story:** As a display, I want to loop the playlist even without internet.
- **Description:** Full-screen player on marketing display devices that follows playlist schedule, caches assets, and reads the order board for status slides.
- **Acceptance:** Media cached by the service worker. Plays offline. `order_status` slide shows live ready orders.
- **Technical notes:** Service worker precaches playlist assets with a version manifest.
- **Testing:** Offline playback test.

---

## Epic DEV — Device management

### DEV-01 · Device registry
- **Priority:** P0 · **Depends on:** AUTH-03
- **Story:** As an owner, I want to see and manage every POS, KDS, printer, agent and display.
- **Description:** Admin devices page: create device by kind, pairing code, assignments (station, receipt printer, playlist), status, deactivate or revoke.
- **Acceptance:** Create, pair, assign station, printer or playlist, deactivate. Naming conventions suggested.
- **Technical notes:** Device names unique per branch. Kind can't change after pairing.
- **Testing:** RLS and permission tests.

### DEV-02 · Heartbeats and offline sweep
- **Priority:** P0 · **Depends on:** DEV-01
- **Story:** As a manager, I want to know within 2 minutes if any device goes offline.
- **Description:** `device_heartbeat` RPC and pg_cron sweep that updates `devices.status`, writes device_events and opens or resolves alerts.
- **Acceptance:** Heartbeat every 30 s. Offline after 90 s. `device_events` written. Recovery logged.
- **Technical notes:** Sweep is idempotent. Alerts use dedupe_key `device_offline:<id>`.
- **Testing:** pg_cron sweep test with stale timestamps.

### DEV-03 · Alert centre and notifications
- **Priority:** P0 · **Depends on:** DEV-02
- **Story:** As an owner, I want a single place (and a push or SMS for critical items) showing printer, device, sync and print-job problems.
- **Description:** Alerts table UI with severity and filters, acknowledgement, and delivery of critical alerts to manager devices via web push (SMS optional later).
- **Acceptance:** Deduplicated open alerts, acknowledge and auto-resolve. Critical alerts notify manager devices.
- **Technical notes:** Web Push via VAPID keys stored in Edge Function secrets.
- **Testing:** Alert lifecycle tests.

---

## Epic OFF — Offline and reliability

### OFF-01 · Local menu and config cache
- **Priority:** P0 · **Depends on:** POS-01
- **Story:** As a cashier, I want the POS to work from a local copy of the menu.
- **Description:** Versioned snapshot of menu, modifiers, taxes, routing rules, station outputs and printers stored in IndexedDB and refreshed on change.
- **Acceptance:** Cache refreshed on version change. POS boots with no network using the cached config.
- **Technical notes:** Snapshot fetched through one RPC returning JSON with a version hash.
- **Testing:** Offline boot test.

### OFF-02 · Outbox sync engine
- **Priority:** P0 · **Depends on:** OFF-01, ORD-02
- **Story:** As a cashier, I want queued operations to sync automatically and safely.
- **Description:** IndexedDB FIFO per order, exponential backoff, persistent storage request, idempotent replay, poison-message handling (never auto-drop).
- **Acceptance:** Kill the browser mid-sync: replay on boot, no duplicates.
- **Technical notes:** Operations serialised per order key. Different orders sync in parallel.
- **Testing:** Chaos tests (OFF-06).

### OFF-03 · Order number leases
- **Priority:** P1 · **Depends on:** ORD-04, OFF-02
- **Story:** As an offline POS, I need to keep issuing unique numbers.
- **Description:** `lease_order_numbers` RPC and client logic that keeps a buffer of per-device numbers for the current business day.
- **Acceptance:** Lease top-up when < 20 remaining. Offline numbers never collide across tills.
- **Technical notes:** Lease numbers are drawn from the same counter, so online and offline numbers never overlap.
- **Testing:** Multi-till offline simulation.

### OFF-04 · LAN print fallback
- **Priority:** P1 · **Depends on:** PRN-02, OFF-02, RTE-02
- **Story:** As a kitchen, we want tickets printed even when the internet is down.
- **Description:** Agent LAN endpoint (device-token authenticated) accepts ticket documents keyed by submission and station. Server jobs with matching dedupe keys are suppressed after sync.
- **Acceptance:** Internet off: order sent, tickets printed at each station. Internet on: no duplicate prints.
- **Technical notes:** LAN endpoint authenticated with a device-signed token issued while online. Agent journal keyed by `ticket:<submission>:<station>`.
- **Testing:** Chaos test with the fake printer.

### OFF-05 · Sync status and stuck-operation UI
- **Priority:** P1 · **Depends on:** OFF-02
- **Story:** As a manager, I want to see what hasn't synced and fix it.
- **Description:** Admin and POS views of the outbox per device: pending, failing and rejected operations with actions.
- **Acceptance:** Per-device pending count, errors, manual retry, and resolve with reason (audited).
- **Technical notes:** Resolution actions audited. No automatic deletion of outbox entries.
- **Testing:** E2E with a forced server rejection.

### OFF-06 · Chaos and reliability test suite
- **Priority:** P0 · **Depends on:** POS-03, KDS-03, PRN-02
- **Story:** As the business, I want proof that orders survive real-world failures.
- **Description:** Automated Playwright and agent scenarios implementing the DoD chaos matrix against staging with the fake printer.
- **Acceptance:** The DoD chaos matrix is automated and runs nightly.
- **Technical notes:** Runs nightly on staging. Failures page the on-call engineer.
- **Testing:** This item is the suite.

---

## Epic INV — Inventory (optional module)

### INV-01 · Units, stock items and locations
- **Priority:** P1 · **Depends on:** DB-01
- **Story:** As an inventory manager, I want to define ingredients, units and store locations.
- **Description:** CRUD for units (with base conversion), stock items (ingredients and finished goods) and stock locations per branch.
- **Acceptance:** Unit conversions validated. Module hidden until enabled.
- **Technical notes:** Module flag per restaurant hides inventory UI and skips deduction.
- **Testing:** Conversion tests.

### INV-02 · Recipes
- **Priority:** P1 · **Depends on:** INV-01, MENU-02
- **Story:** As a chef, I want Jollof Rice to consume rice, tomato, oil, onion and spices per portion.
- **Description:** Recipe editor per product: ingredient lines with quantity and unit, yield, deduction timing.
- **Acceptance:** Recipe cost preview. Deduction timing configurable.
- **Technical notes:** Recipe quantities converted to the stock item unit at save time.
- **Testing:** Cost calculation.

### INV-03 · Sale deduction
- **Priority:** P1 · **Depends on:** INV-02, ORD-02
- **Story:** As a manager, I want stock to go down as we sell.
- **Description:** On the configured event (submit, ready or paid), insert sale movements per recipe line. Voids insert sale_reversal. Finished goods deduct directly.
- **Acceptance:** One ledger row per item and ingredient (dedupe key). Voids reverse. Negative stock allowed with alert (sales never blocked).
- **Technical notes:** `dedupe_key = sale:<order_item_id>:<stock_item_id>` makes deduction replay-safe.
- **Testing:** Replay and void reversal tests.

### INV-04 · Purchases, wastage, adjustments, transfers
- **Priority:** P1 · **Depends on:** INV-01
- **Story:** As a storekeeper, I want to record deliveries, waste and moves between locations.
- **Description:** Forms and RPCs for purchases (receipts with cost), wastage, manual adjustments and inter-location transfers, all writing ledger rows.
- **Acceptance:** All via ledger. Adjustments need a reason and are audited.
- **Technical notes:** Transfers write paired out and in movements in one transaction.
- **Testing:** Ledger balance tests.

### INV-05 · Stock counts and low-stock alerts
- **Priority:** P2 · **Depends on:** INV-04, DEV-03
- **Story:** As a manager, I want periodic counts and alerts when items run low.
- **Description:** Count sessions that record counted quantities and post variance movements. Reorder levels drive low-stock alerts.
- **Acceptance:** Count creates variance movements. Reorder-level alerts deduplicated.
- **Technical notes:** Alert dedupe per location and stock item.
- **Testing:** Alert trigger tests.

---

## Epic RPT — Reporting

### RPT-01 · Sales reports and export
- **Priority:** P1 · **Depends on:** PAY-01
- **Story:** As an owner, I want daily sales by product, category, employee, branch and payment method.
- **Description:** SQL report functions by business day and range. CSV export.
- **Acceptance:** Totals reconcile to the payments ledger exactly.
- **Technical notes:** `security invoker` report functions so RLS still applies. Grouped by business_day.
- **Testing:** Reconciliation tests on seeded data.

### RPT-02 · Operations reports
- **Priority:** P1 · **Depends on:** KDS-02
- **Story:** As a manager, I want prep times per station and product, and counts of cancellations and voids.
- **Description:** Report functions over production_tickets and ticket events for prep and wait times, and over order_items for void and cancel counts and reasons.
- **Acceptance:** Prep time = started → ready minus paused. Percentiles.
- **Technical notes:** Paused time tracked via ticket events and subtracted.
- **Testing:** Fixture timing tests.

### RPT-03 · Financial reports
- **Priority:** P1 · **Depends on:** RPT-01
- **Story:** As an accountant, I want taxes, discounts, service charges and refunds per period.
- **Description:** Report functions over order_taxes, order_discounts, service charges and refund payments per period and branch.
- **Acceptance:** Tax report sums `order_taxes`. Refunds net correctly.
- **Technical notes:** Uses stored per-order tax snapshots, never recomputed from current rates.
- **Testing:** Reconciliation.

### RPT-04 · Cash reconciliation and shift reports
- **Priority:** P1 · **Depends on:** SHF-03
- **Story:** As an owner, I want to see every shift's expected vs actual cash.
- **Description:** Shift list and detail reports with expected vs counted cash and variance history per cashier and till.
- **Acceptance:** Variance trend per cashier.
- **Technical notes:** Built on the same SQL as `close_shift` to avoid drift.
- **Testing:** Equals the shift ledger.

### RPT-05 · Daily summary materialisation
- **Priority:** P2 · **Depends on:** RPT-01
- **Story:** As an owner with a year of data, I want reports to stay fast.
- **Description:** Nightly pg_cron job populating daily summary tables per branch and product, used by long-range reports.
- **Acceptance:** Nightly summary tables. Reports < 1 s for a 12-month range.
- **Technical notes:** Summaries rebuilt for a day when late offline syncs land in it.
- **Testing:** Summary equals live-query parity.

---

## Epic AUD — Audit

### AUD-01 · Audit capture
- **Priority:** P0 · **Depends on:** DB-03
- **Story:** As an owner, I want every sensitive change recorded with who, what, when, where and why.
- **Description:** Generic before/after trigger on config tables. Explicit audit in sensitive RPCs (void, refund, discount, price change, permission change, stock adjust, table transfer, reprint, no-sale).
- **Acceptance:** Every action listed in the brief §22 produces an audit row with device and staff.
- **Technical notes:** Generic trigger captures `to_jsonb(old)` / `to_jsonb(new)`. RPC audits add reason and approver.
- **Testing:** One test per audited action.

### AUD-02 · Audit viewer
- **Priority:** P1 · **Depends on:** AUD-01
- **Story:** As an owner, I want to search the audit log.
- **Description:** Admin audit log browser with filters, pagination and a JSON before/after diff view.
- **Acceptance:** Filter by user, action, entity, date. Before/after diff view.
- **Technical notes:** Paginated by id (keyset), not offset.
- **Testing:** Permission gating.

---

## Epic SEC — Security hardening

### SEC-01 · Security review and hardening
- **Priority:** P1 · **Depends on:** all P0
- **Story:** As an owner, I want independent assurance the system is safe.
- **Description:** Review all definer functions, Storage policies, Edge Function auth, CSP headers, dependency audit, Supabase security advisor clean.
- **Acceptance:** Zero high findings open.
- **Technical notes:** Use Supabase security advisor and `pg_stat_statements` for slow RLS queries.
- **Testing:** Checklist plus automated advisor in CI.

### SEC-02 · Rate limiting
- **Priority:** P1 · **Depends on:** AUTH-03, AUTH-04, FND-04
- **Story:** As the platform, I want brute-force and abuse limits.
- **Description:** Postgres-side counters for PIN, pairing and error ingestion. Per-IP and per-device limits in Edge Functions.
- **Acceptance:** Limits on PIN, pairing, client_errors, Edge Functions. Violations logged.
- **Technical notes:** Lockouts reset on successful auth. Counters expire.
- **Testing:** Limit tests.

---

## Epic QA — Production readiness

### QA-01 · Peak-hour load test
- **Priority:** P1 · **Depends on:** M1 items
- **Story:** As the business, I want proof the system holds up on our busiest night ×4.
- **Description:** Scripted simulation of POS submits, KDS transitions, payments and agent claims at 4× projected peak on staging.
- **Acceptance:** DoD performance thresholds met for 2 h (see §N).
- **Technical notes:** k6 scripts authenticate as seeded devices to exercise real RLS.
- **Testing:** k6 or Artillery scripts against staging.

### QA-02 · Pilot, training and runbooks
- **Priority:** P1 · **Depends on:** M1 items
- **Story:** As staff, we want to be trained and know what to do when something breaks.
- **Description:** Pilot plan at one branch, staff training material, runbooks for common failures, go/no-go checklist.
- **Acceptance:** Runbooks written. 3 supervised peak services without Sev-1.
- **Technical notes:** Runbooks live in `docs/runbooks/` and are linked from the alert centre.
- **Testing:** Pilot checklist.

### QA-03 · Backup and restore drill
- **Priority:** P1 · **Depends on:** FND-02
- **Story:** As an owner, I want confidence we can recover from disaster.
- **Description:** Scheduled restore of a prod PITR snapshot into staging, with verification queries and timing recorded.
- **Acceptance:** PITR restore to staging rehearsed and timed. Procedure documented.
- **Technical notes:** Restore target is staging only. Verify row counts and a sample of report totals.
- **Testing:** Drill record.

# Product Consolidation Audit (Phase 1)

Date: 2026-09-25. Nothing was changed to produce this audit. It records what exists today, what the product plan needs, and the decisions to make before Phase 2.

## 1. Architecture: keep as is

The layers are sound and tested: **domain → contracts → application → infrastructure → apps**.

| Part | State | Keep |
|---|---|---|
| Domain | Order state machine, derived order status, submission planning, routing engine, production tickets, payments (cash/MoMo/card, split = several payments), payment policy per area, tax, business day, receipt/ticket documents | ✅ |
| Application | One use case per action, one Postgres transaction per command, permission checks, audit logging, idempotency (client ids, submission ids, payment ids, print dedupe keys, order-number reservations) | ✅ |
| Infrastructure | Postgres repositories and read models, Supabase Auth (JWKS), Realtime broadcast as a change signal, print queue with leases | ✅ |
| Security | RLS on all 40 tables, least-privilege API login (`rp_api`), no table grants to browser roles, rate-limited pairing | ✅ |
| Tests | 122 local tests (PGlite), hosted concurrency and Realtime suites, 11 browser tests | ✅ |

Multi-restaurant support is a **database capability only**. The UI already never shows tenant switching: a signed-in user sees their one restaurant. No SaaS administration exists in the UI. The single-restaurant experience needs no backend change.

## 2. Supabase and hosting: what exists

| Environment | Supabase project | Vercel project | URL | Local config |
|---|---|---|---|---|
| DEV | `nkijnjovztglmwxoemqg` (eu-west-1) | none (local `pnpm dev`) | localhost | `.env` |
| Staging | `impairlsvhkumjzhjhti` (eu-west-1) | `restaurant-management-staging` | restaurant-management-staging.vercel.app | `.env.staging` |
| **Production** | **`lgoirbfyspuflqekrcgp`** (eu-west-1, daily backups) | `restaurant-management-prod` | **bibiani-restaurant.vercel.app** | `.env.production` |

- **Where the configuration lives:**
  - The Supabase URL and anon key are in `SUPABASE_URL` / `SUPABASE_ANON_KEY` for the API, and in `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` for the browser, sealed into the bundle per environment by `scripts/deploy/build-vercel.mjs`.
  - The server-only values are `DATABASE_URL` (`rp_api`), `SUPABASE_SECRET_KEY` and `MONITOR_TOKEN`, kept in Vercel's encrypted environment variables and the gitignored `.env*` files. Nothing secret is committed.
- **Multiple environments:** the code has no hard-coded environment. It runs against whatever the env vars point to. The multiple-environment assumptions live only in:
  - the `staging:*` scripts in `package.json`,
  - `scripts/env/configure-staging.sh`, `configure-production.sh` and `fresh-restaurant.sh`,
  - `.github` CI (which uses PGlite, not Supabase),
  - docs 05, 10 and 11.
- **Migrations:** 15, in `supabase/migrations/` (`…000100` to `…001500`). They are applied identically to all three projects. There are no duplicates and no unused tables. The only infrastructure table is `app.ops_counters`, which browser roles can't reach. Migrations are history and stay as they are.
- **Scripts that create infrastructure:** **none.** No script creates Supabase or Vercel projects. All three projects were created by hand during earlier phases, on instruction.
  - `configure-*.sh` only sets up logins inside an existing project.
  - `platform/create-restaurant.ts` creates a restaurant row, not a project.
- **Docs that tell people to create projects:** doc 05 §3 and doc 11 §3 ("Create the prod Supabase project"). They need rewording to "the project".

**Recommended single project: production `lgoirbfyspuflqekrcgp`.**

- It is the one with backups, the live domain and clean data, and it already holds the real Bibiani Restaurant.
- DEV and staging then become unnecessary. I won't delete or pause them myself, because that's destructive and it's the owner's call. Unused, they cost nothing on the free tier.
- Automated tests keep using in-memory PGlite, which needs no Supabase project.

## 3. Product: what works today (database + API + UI together)

| Module | Status |
|---|---|
| Login, owner self-service password | ✅ |
| POS: Hall tables, Takeaway, categories, modifiers, notes, send, manual payment incl. split, print/reprint receipt, Completed orders | ✅ works, but looks like a form, not a premium POS. No product search, no discount. |
| Multi-POS: concurrent orders, unique numbers, no duplicates | ✅ tested (100 concurrent submits, idempotent retries) |
| Routing: one order → many station tickets; match by product / category / default, per area; extra printers per rule | ✅ domain + admin UI (plain table) |
| Routing by **modifier**, one item → **several stations**, station + **expediter** | ❌ not supported (the rule picks one station per item) |
| KDS: ticket cards, start / ready / recall, elapsed time | ✅ basic look |
| Supervisor / expediter view (all stations of an order, 3/4 ready, delays) | ❌ missing (only a "Mark ready" button on the POS) |
| Kitchen notifications (new / modified / voided, sound, unread) | ❌ missing (the screens update live, with no notification layer) |
| Customer display (Preparing / Ready) | ✅ basic |
| Hall floor with table statuses | ✅ basic. **Transfer, merge, split table: not implemented** in the domain. |
| Dashboard | ❌ missing (the owner lands on POS or Admin) |
| Products, categories, modifiers, stations, staff, roles, areas, devices, print queue | ✅ one long Admin screen (900 lines), functional but technical |
| Reports (sales per day, per method, per product) | ❌ missing |
| **Inventory** (items, units, stock, movements, low stock, wastage) | ❌ **nothing exists.** No tables, domain or UI. |
| **Stock taking** (count, variance, approve, audit) | ❌ nothing exists |
| Recipes / BOM (sales deduct stock) | ❌ nothing exists |
| Settings (restaurant name, currency, business day, receipt text) | partial (branch fields in the API, no screen) |

## 4. Size of the work (honest)

This is a large build, not a polish pass.

| Block | Work |
|---|---|
| A. Consolidation | Pick the project, add the demo restaurant, demo login and realistic demo data (menu, orders, payments, stock). Reword docs. Small. |
| B. Product shell and design system | Navigation, dashboard, restyled POS, KDS and display, admin split into proper pages (Products, Stations, Routing, Staff, Settings), empty, loading and error states. Large. |
| C. Supervisor / expediter view + kitchen notifications | New read model (order × station progress, delays), screen and notification feed with sound. Medium. |
| D. Routing extensions | Modifier routing and multi-station / expediter outputs: a domain, migration and UI change to the routing engine. Medium, needs care. |
| E. Inventory + stock taking | New migrations (items, units, movements, stock counts), domain rules (no silent changes, every movement audited), use cases, API, three screens. Optionally recipes, with deduction on sale. Large. |
| F. Reports | Sales by day, payment method, product and station timings, read from existing data. Medium. |
| G. Table transfer / merge / split | New domain operations. Medium. **Not in the plan's demo scenario.** Proposed later. |

Proposed order:

1. **A** (consolidation and demo data).
2. **B + C** (the demo scenario of §26 end to end).
3. **E** (inventory and stock taking).
4. **F** (reports).
5. **D** (routing extensions).
6. **G** later.

Each block is shipped with tests and a browser check before the next starts.

## 5. Conflicts to decide before Phase 2

1. **Which Supabase project is "the one".** Recommendation: production (`lgoirbfyspuflqekrcgp`), see §2.
2. **Demo data vs the real restaurant.** The real "Bibiani Restaurant" was created today in production, clean, with owner nanagyams99@gmail.com. The plan asks for a demo login and sample orders in "Bibiani Restaurant".
   - **Recommendation:** a separate **"Bibiani Restaurant — Demo"** restaurant in the same project, fully isolated by RLS, holding all the demo data and the demo login. The real restaurant's sales, order numbers and audit history stay clean.
   - The alternative, filling the real restaurant with demo data, would mix fake sales into its books and its audit history, which must not be deleted.
3. **Demo password in documentation.** The GitHub repository is **public**. A password written into `docs/` would be readable by anyone, and the demo login is a manager-level account on the live system.
   - **Recommendation:** return the password in the final report message and in a gitignored local file only. Docs say where to find it, not what it is. The demo account can only see the demo restaurant.
4. **Hardware:** agreed. Not a blocker. Printing uses the queue with print preview (already exists) plus a simulated printer.

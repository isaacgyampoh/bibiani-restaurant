# Development Standards

These rules apply to every change. The goal is software a restaurant can trust during its busiest 30 minutes.

## 1. Architecture: dependencies point inward

```
apps/api (presentation: HTTP)      apps/print-agent (separate process: LAN hardware)
        │                                   │
        ▼                                   ▼
packages/infrastructure ──────► packages/client-core (API client, reconciling feed, outbox)
(Postgres repositories, auth,               │
 unit of work, logging)                     ▼
        │                          packages/escpos (document → printer bytes)
        ▼
packages/application (use cases, ports, principal/authorization)
        │
        ▼
packages/contracts (request schemas + response views: ONE definition for server and clients)
        │
        ▼
packages/domain (entities, rules, enums. No I/O, no Node types, no Supabase.)
```

| Layer | May import | Must not contain |
|---|---|---|
| domain | nothing | SQL, HTTP, Supabase, Node or browser APIs, printer bytes |
| contracts | domain, zod | business rules |
| application | domain, contracts | SQL, HTTP, Supabase SDK |
| infrastructure | application, domain, contracts | business rules (only persistence, auth plumbing, logging) |
| apps/api | everything above | SQL or rules. Routes validate, call one use case, and return its view. |

Rules of thumb:
- **One authoritative implementation per rule.** Status derivation, routing, tax and payment balance exist only in `packages/domain`. Clients may *display* derived values, but they get them from the API.
- **One use case = one transaction.** Anything that must be all-or-nothing happens inside `uow.run(...)`.
- **Status is derived, never set by callers.** `settleOrderState()` is the only writer of `orders.status` and `payment_status`.
- **No "RestaurantService".** Add a focused use case per operation.
- Repositories exist where they protect a boundary. Read models (`ReadModels`) are screen-shaped queries. Don't wrap trivial SQL in extra abstractions.

## 2. Technology choices and why

| Choice | Why | Alternatives considered |
|---|---|---|
| **TypeScript everywhere** (TS 7) | One language for domain, API, print agent and future web apps, so contracts are shared and not duplicated | Separate backend language: would duplicate contracts and rules |
| **Supabase Postgres** | Required. Mature relational engine with RLS, transactions and constraints | — |
| **Supabase Auth** (JWT, verified via the public JWKS) | Tokens verified locally in the API; no shared secret stored | Custom auth: more risk, no benefit |
| **Supabase Realtime, private broadcast from triggers** | Scales with per-branch topics and needs no table grants for browsers. Used only as a "something changed" signal | `postgres_changes`: needs table SELECT for browsers and checks RLS per subscriber per row |
| **Hono on Node** for the API | Small, fast, standard `fetch` interface, so it runs on Node, Vercel Functions or containers unchanged, and tests call it in-process | Express (older, heavier); Supabase Edge Functions (Deno: awkward to share the pnpm workspace domain packages) |
| **postgres.js** | Fast, supports transactions over the Supavisor transaction pooler (`prepare: false`) | node-postgres (fine, slightly more ceremony) |
| **zod** | Runtime validation and TS types from one schema (`packages/contracts`) | — |
| **PGlite** in tests | Real PostgreSQL 17 engine in-process, so the real migrations, RLS, triggers and constraints are exercised without Docker | Docker Supabase (not installed here; planned for concurrency tests) |
| **Vitest, Biome** | Fast; Biome is a single tool for lint and format | ESLint + Prettier (two tools, more config) |
| **Separate print-agent process** | Browsers cannot reliably drive raw TCP ESC/POS printers; a LAN process can | Browser printing (dialogs, no queue), vendor cloud print (vendor lock-in) |
| **Modular monolith** (one API) | Simplest reliable deployment; modules are separated in code, not in network hops | Microservices: operational cost with no current benefit |

## 2a. Frontend (apps/web)

- Screens call the typed `ApiClient` (`packages/client-core`). They never read or write tables, and never import Supabase except through `apps/web/src/infra/session.ts`, which handles sign-in and realtime signals only.
- Every live screen uses `useFeed`. A realtime signal, reconnect, tab becoming visible, or the safety poll each trigger a reload from the API. Screens never render from a realtime payload.
- Every write keeps its id (order, submission, payment, void request) until the server confirms it, so the retry button is always safe.
- Permissions only hide buttons (`hasPermission`). The server authorizes every call.
- Only `VITE_*` variables reach the bundle, and those are public values only. `pnpm security:scan` checks every build.

## 3. Identifiers and idempotency

- Primary keys are UUIDs. Human numbers (order #5001) are display fields, unique per `(branch, business_day)`.
- Retryable writes use **client-generated ids**: `orderId`, item `id`s, `send.submissionId`, `paymentId`, `refundId`. The server:
  - returns the stored result when the same id arrives with the same content,
  - rejects with `IDEMPOTENCY_MISMATCH` when the id arrives with *different* content (it never merges silently),
  - is backed by unique constraints if application checks are ever bypassed.

## 4. Errors

- Business violations are `DomainError(code, message, details)`. Messages are written for restaurant staff, and `details` go to logs only.
- Postgres errors are translated in `translatePgError`. Raw database text never reaches a user.
- When the server could not complete a command, the API returns an operation-specific message ("Payment was not recorded. Please try again.") with `retryable: true` and a `correlationId`.
- Never swallow an error. The only deliberate exception is a failed realtime notification, which logs a warning because clients reconcile by polling. It is documented in the migration.

## 5. Observability

- Structured JSON logs, one event per line. Every request has a correlation id (`x-request-id` in and out).
- Use-case events carry the correlation chain: `order.submitted` includes `orderId`, `submissionId`, `tickets[{ticketId, stationId}]` and `printJobIds`. `print_job.*` events carry `printJobId`, `orderId`, `productionTicketId` and `printerId`. Payments carry `paymentId`.
- Logs are flushed **after commit**, so they never describe rolled-back work.
- Durable trails in the database: `order_events`, `production_ticket_events`, `print_job_attempts`, `device_events`, `audit_logs` (append-only for the API role).

## 6. Security rules

- Never expose or use a service-role key in `apps/*`. CI fails if one appears in build output.
- Never trust client tenant ids or permissions. The principal is resolved server-side from the verified token plus membership tables.
- Never disable RLS. Every public table has it (checked by `pnpm db:check` and a test).
- New tables: include `restaurant_id`, call `app.enable_tenant_rls('<table>')`, and use composite `(restaurant_id, x_id)` foreign keys.

## 7. Database changes

- Every change is a new file in `supabase/migrations/` named `YYYYMMDDHHMMSS_description.sql`. Never edit a migration that has been applied to a shared environment; add a new one.
- A migration must apply cleanly from empty (`pnpm db:check`) and keep the enum parity test green. If you add an enum value, add it to `packages/domain/src/enums.ts` in the same change.
- Never change production schema by hand.

## 7a. Database round trips

Every statement is a network round trip. `query-budget.test.ts` records the count for the hot paths and fails if it grows. Batch with `jsonb_to_recordset`, compute sequences inside inserts, and don't re-read what the transaction already loaded.

## 8. Definition of done for a change

- `pnpm ci` is green: lint, typecheck, `db:check`, tests, build.
- New behaviour has tests at the lowest useful level: domain unit tests for rules, integration tests for use cases against Postgres.
- Docs updated when behaviour or architecture changes.
- Don't claim an integration works unless a test or a recorded manual check proves it.

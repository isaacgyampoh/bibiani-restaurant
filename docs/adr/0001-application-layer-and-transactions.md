# ADR 0001: Business rules live in a TypeScript domain/application layer; one Postgres transaction per command

- Status: Accepted (Phase 3, 2026-09-25)
- Supersedes: parts of `01-architecture.md` §D.1 (principle 2), §D.3 ("plpgsql RPCs" as the authoritative backend) and §F.1 (where the flow says `submit_order` RPC)

## Context

The Phase 1 architecture put the authoritative order logic in PostgreSQL functions called by clients through Supabase RPC. The engineering standards issued with Phase 3 require Clean Architecture:

- The domain must not depend on Supabase, PostgreSQL, React, HTTP frameworks or printer SDKs.
- Presentation calls application use cases, never tables.
- Every business rule has one authoritative implementation.

Both approaches meet the reliability requirement, as long as each command runs in one server-side transaction.

## Decision

1. **Domain** (`packages/domain`) is pure TypeScript and holds the rules:
   - money and tax
   - routing precedence
   - derived order and payment status
   - the ticket state machine
   - the print retry policy
   - the kitchen ticket document model

   It has no I/O dependencies. Its tsconfig excludes Node types.
2. **Application** (`packages/application`) holds use cases (`SubmitOrder`, `SendOrderToKitchen`, `TransitionTicket`, `FulfilOrder`, `RecordPayment`, `VoidPayment`, `RefundPayment`, `ClaimPrintJobs`, `ReportPrintJobResult`, `RetryPrintJob`, plus queries) and the ports they need (`UnitOfWork`, repositories, `Clock`, `Logger`, and so on).
3. **Infrastructure** (`packages/infrastructure`) implements the ports with SQL. `PgUnitOfWork` runs each use case in ONE transaction:
   - `SET LOCAL ROLE app_api`
   - a transaction-local `app.restaurant_id`
   - statement and lock timeouts
   - automatic retry on deadlock or serialization failure (safe because every command is idempotent)
4. **Presentation** (`apps/api`, Hono on Node): validate the request, call one use case, map errors. There is no SQL in this layer.
5. **Postgres remains the last line of defence** even though it no longer holds the business logic:
   - RLS on every table (as `app_api`)
   - tenant-scoped composite foreign keys
   - unique constraints for idempotency (`orders.id`, `order_submissions.id`, `unique(submission_id, station_id)`, `payments.id`, `print_jobs.dedupe_key`)
   - check constraints
   - a unique index for one active order per table
6. **Browser roles** (`anon`, `authenticated`) have no privileges on any public table. Clients go through the API. Supabase is still used for Auth (tokens verified with the project's public JWKS), Realtime (private broadcast signals from triggers), and Postgres.

## Consequences

- One extra network hop (client → API → Postgres) compared with direct RPC. Mitigation: host the API in the same region as the database, and use one transaction per command with bulk inserts (`jsonb_to_recordset`).
- The API needs `DATABASE_URL` (a server secret). The browser never holds it.
- Business logic is portable to any PostgreSQL host. Only `infrastructure` knows the SQL dialect details.
- Transactions are held open across several round trips. Row locks are taken in a fixed order (order row → ticket rows) and statement and lock timeouts bound the damage.

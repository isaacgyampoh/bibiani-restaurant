# Testing Strategy

```bash
pnpm test           # local: 120 tests, PGlite (≈8 s)
pnpm db:check       # applies all migrations to an EMPTY Postgres; fails if any table lacks RLS
pnpm test:hosted    # the same suites + concurrency + realtime against hosted Supabase DEV (needs .env; ~20–30 min)
pnpm test:e2e       # Playwright: milestone scenarios A and B in real browsers (needs a configured DEV restaurant)
pnpm ci             # lint + typecheck + test + build (+ db:check and secret scan in CI)
```

## 1. Layers

| Level | Where | Engine | What it proves |
|---|---|---|---|
| Domain unit | `packages/domain/test` | none | Tax maths, routing precedence, status derivation, payment planning, ticket state machine, print retry policy, business day, ticket document |
| Renderer | `packages/escpos/test` | none | ESC/POS bytes, 58/80 mm widths, duplicate/reprint banners, ASCII safety |
| Integration (use cases) | `packages/testing/test` | **Real PostgreSQL 17 (PGlite)** with the real migrations, RLS, triggers, constraints | Scenarios A and B, idempotency, atomic rollback, tenant isolation, printing lifecycle, payments, kitchen rules, schema contract |
| HTTP | `apps/api/test` | PGlite + real Hono app + real ES256 JWT verification | Auth rejection, error mapping, correlation ids, realtime-disconnect reconciliation, outbox replay after a lost response |
| Print agent | `apps/print-agent/test` | PGlite + API + **real TCP** fake printers | Station printing, offline printer recovery, no double print after lost report, heartbeat, journal crash recovery |

Test databases are fresh copies of a migrated snapshot, one per test file. The snapshot is rebuilt whenever a migration changes. `pnpm db:check` always migrates from empty.

## 2. Required Phase 3 tests → where they are

| # | Requirement | Test |
|---|---|---|
| 1 | Simple order: one order, items, ticket, print job | `idempotency.test.ts` (TEST 3 setup), `kitchen.test.ts`, `scenario-hall.test.ts` |
| 2 | Multi-station order → 4 tickets | `scenario-hall.test.ts` |
| 3 | Retry same order → no duplicate | `idempotency.test.ts` "TEST 3" |
| 4 | Retry same send → no duplicate tickets | `idempotency.test.ts` "TEST 4" (50 retries) |
| 5 | Printer failure → order valid, job pending/failed, no loss | `printing.test.ts`, `print-agent/test/agent.test.ts` |
| 6 | DB transaction failure → nothing partial | `atomicity.test.ts` (a real Postgres error raised inside the transaction at the last write; runs locally and on hosted DEV) |
| 7 | Tenant isolation | `tenant-isolation.test.ts` (use-case level and raw SQL as `app_api`) |
| 8 | Realtime disconnect → client reconciles | `apps/api/test/client-resilience.test.ts` "TEST 8" |
| 9 | Payment retry → one payment | `idempotency.test.ts` "TEST 9", outbox replay test |
| 10 | Correct routing for every item | `scenario-takeaway.test.ts` "TEST 10", `domain/test/routing.test.ts` |

## 3. Hosted validation (Phase 4)

`TEST_TARGET=hosted` runs the database suites against the hosted Supabase DEV project:
- a real pooler with real parallel connections,
- real Supabase Auth users for every fixture account,
- the API role switch done exactly as in production.

Suites that need a single engine for fault injection or captured realtime messages run locally only (`it.skipIf(HOSTED)`).

| Suite | What it adds on hosted |
|---|---|
| `test-hosted/concurrency.test.ts` | Cases A–G of the Phase 4 brief with **multiple simultaneous connections**, plus tenant interleaving through the pooler. An invariant checker recomputes each order's totals, status and payment status from its rows using the domain rules. |
| `apps/api/test-hosted/realtime.test.ts` | **Real Supabase Realtime** with signed-in clients (cashier, KDS device, display device, owner, plus a user from another restaurant). The real API runs on the `rp_api` login. Covers disconnect → reconnect → reload → resume. |
| `query-budget.test.ts` (local) | Database statements per hot operation, with budgets that fail on N+1 regressions. |

Results are recorded in [08-validation-results.md](08-validation-results.md).

## 4. What is still NOT proven (honest gaps)

- **Hardware.** No physical printer, POS terminal, kitchen tablet or TV has been used. See the checklist in [06-device-and-printing.md](06-device-and-printing.md) §6.
- **Load.** There has been no sustained peak-hour load test (QA-01). The concurrency tests prove correctness under contention, not throughput.
- **Co-located latency.** All hosted measurements were taken from a laptop about 140 ms from the database. Production numbers must be measured on STAGING with the API in-region.
- **Offline POS.** The outbox exists and is tested in `client-core`, but the web POS does not yet persist unsent orders to IndexedDB (OFF-02). A POS refresh during an outage loses the unsent cart. Already-submitted orders are never lost, and retries are safe.

## 5. Rules

- Test business rules at the domain level. Test use cases against the real Postgres engine, not in-memory fakes.
- Test doubles are allowed only for things outside our control: the realtime socket (`ControlledSignal`), the network (flaky `fetch`), printers (TCP fake), the clock (`TestClock`). They never replace our own core logic.
- Fixtures (`seedRestaurant`) configure a restaurant as data, the same way an owner would through admin. They are never loaded into a real environment.
- Every bug fix gets a test that fails without the fix.

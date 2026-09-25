# Restaurant Platform

A configurable restaurant operating system: POS, order routing to production stations, kitchen tickets, a durable print queue, manual payments, and order completion. Built SaaS-ready (restaurant → branch → areas / stations / devices).

**Status: deployed to STAGING (`https://restaurant-management-staging.vercel.app`) and PRODUCTION (`https://restaurant-management-prod-rouge.vercel.app`, empty, open risks accepted); see [docs/10-production-readiness.md](docs/10-production-readiness.md).** POS (hall and takeaway), KDS, customer display, admin, device pairing, staff sign-in, manual payments (cash / MoMo / card / split), receipts and cancel/void are built. They are tested locally and against the hosted DEV database, including real concurrency and real Supabase Realtime. **Not deployed; not tested on real restaurant hardware; not production-ready.**

## Repository layout

```
apps/
  web/            React PWA: POS (hall/takeaway), KDS, customer display, admin, pairing
  api/            HTTP API (Hono). Presentation only: validate → use case → view
  print-agent/    LAN service: leases print jobs from the API, drives ESC/POS printers over TCP
packages/
  domain/         Business rules. No I/O. (routing, status derivation, tax, payments, print retry policy)
  contracts/      Request schemas + response views shared by server and clients (zod)
  application/    Use cases + ports (UnitOfWork, repositories, clock, logger) + authorization
  infrastructure/ Postgres repositories, unit of work (RLS tenant context), JWT verification, logging
  client-core/    API client, reconciling feed (realtime = hint, DB = truth), durable outbox
  escpos/         Printer-agnostic document → ESC/POS bytes
  testing/        PGlite harness, restaurant fixtures, integration test suites
supabase/
  migrations/     Versioned SQL migrations (the database source of truth)
docs/             Architecture, backlog, ADRs, standards, deployment, printing, testing
```

## Getting started

Requirements: Node ≥ 22 (developed on 24), pnpm 10. Docker is optional (only for a local Supabase stack).

```bash
pnpm install
cp .env.example .env        # fill in values; .env is gitignored
pnpm ci                     # lint, typecheck, tests, build
pnpm db:check               # migrations apply from an empty database; every table has RLS
```

Tests use PGlite (PostgreSQL 17 in-process). No Docker or network access is needed.

### Running locally against Supabase DEV

```bash
pnpm dev:logins            # DEV only: creates/rotates DB logins + fetches the server key into .env
pnpm dev:api               # API on :8787 (rp_api login, JWKS token verification)
pnpm dev:web               # web app on :5173 (proxies /v1 to the API)
```

First restaurant (platform operator, then owner):

```bash
OWNER_PASSWORD=... pnpm platform:create-restaurant --name "Bibiani Restaurant" --slug bibiani \
  --owner-email owner@example.com --start 5001
OWNER_EMAIL=owner@example.com OWNER_PASSWORD=... pnpm dev:configure-demo   # DEV demo menu/stations/printers via the admin API
```

Devices: Admin → Devices → "Pairing code", then open `/pair` on the tablet or TV.

`DATABASE_URL` must point at a database with the migrations applied. See [docs/05-deployment.md](docs/05-deployment.md) §4.

### Database migrations

```bash
supabase link --project-ref <ref>   # once; asks for the DB password
supabase db push                    # apply pending migrations
```

New change → new file `supabase/migrations/YYYYMMDDHHMMSS_name.sql`. Never edit an applied migration.

## Documentation

| Doc | Contents |
|---|---|
| [01-architecture.md](docs/01-architecture.md) | Product and architecture audit (Phase 1) plus Phase 3 amendments |
| [02-proposed-schema.sql](docs/02-proposed-schema.sql) | Phase 1 schema draft (superseded by `supabase/migrations`) |
| [03-backlog.md](docs/03-backlog.md) | Implementation backlog |
| [04-development-standards.md](docs/04-development-standards.md) | Layering rules, stack rationale, idempotency, errors, logging |
| [05-deployment.md](docs/05-deployment.md) | Environments, hosting, secrets, migrations, rollback, backups |
| [06-device-and-printing.md](docs/06-device-and-printing.md) | Print queue guarantees, print agent, device permissions, hardware checklist |
| [07-testing-strategy.md](docs/07-testing-strategy.md) | Test layers, required-test map, known gaps |
| [08-validation-results.md](docs/08-validation-results.md) | DEV validation (Phase 4) |
| [09-phase5-audit.md](docs/09-phase5-audit.md) | Phase 5 audit before staging |
| [10-production-readiness.md](docs/10-production-readiness.md) | Staging validation, statuses and production blockers |
| [11-production-deployment-plan.md](docs/11-production-deployment-plan.md) | Production plan (not executed) |

### Staging commands

```bash
pnpm staging:configure   # (re)create staging logins, write .env.staging (gitignored)
pnpm staging:verify      # schema, RLS, least-privilege checks against staging
pnpm staging:deploy      # production-style build + prebuilt deploy (dub1)
pnpm staging:realtime    # realtime suite against the deployed API
pnpm staging:test        # correctness + concurrency suites, file by file
pnpm staging:e2e         # fresh restaurant + Playwright against the deployed site
pnpm staging:load        # load test (server timings via Server-Timing)
pnpm staging:agent-smoke # real print agent against staging (TCP test printers)
```
| [adr/](docs/adr) | Architecture decision records |

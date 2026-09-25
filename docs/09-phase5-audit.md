# Phase 5 Audit: Before Staging

Date: 2026-09-25. Method: reading the repository and docs 05, 06 and 08, plus live checks where stated (tag **[LIVE]**). Everything else is **[CODE REVIEW]**.

## 1. Already complete (reuse, don't redo)

| Area | Evidence | Status |
|---|---|---|
| Schema | 13 migrations, apply from empty (`pnpm db:check`), applied to DEV | DEV TEST |
| Tenant isolation, RLS, least-privilege `rp_api` | local + DEV suites; rp_api denied direct reads on DEV | DEV TEST |
| Concurrency cases A–G | DEV run, 10/10 | DEV TEST |
| Realtime, private channels, reconnect | DEV run with real sessions | DEV TEST |
| Pairing, staff auth, revoke, deactivate | DEV integration tests | DEV TEST |
| POS / hall / takeaway / KDS / display / admin UI | Playwright against local API + DEV | REAL BROWSER (local servers) |
| Print agent (built binary) | paired, printed 9/9 to TCP test printers | DEV TEST (simulated printer) |
| Secret scan | self-tested against planted fakes | LOCAL TEST |
| Production builds | API and agent self-contained bundles; built API started against DEV | DEV TEST |

## 2. Genuinely missing

| Item | Kind of work |
|---|---|
| STAGING Supabase project, logins, secrets | configuration + script generalisation |
| Scripts are DEV-specific (`configure-dev-logins.sh` refuses any ref but DEV; fixtures guard `TEST_ALLOWED_PROJECT_REF`) | small code change: per-environment env files |
| API cannot run on Vercel: there is only a Node `serve()` entry point | code: a serverless handler plus a shared composition root (no domain changes) |
| Deployment packaging (web + API on one origin) | code: a Vercel Build Output bundle script |
| Health checks only ping the database | code: readiness must also check schema version, Auth (JWKS) and Realtime storage; one small migration for version/realtime probes |
| Server-side timing for performance measurement | code: `Server-Timing` (db time and statement count) from the unit of work |
| Load-test tooling | new script (no load testing exists yet) |
| Leaked-password protection | configuration (plan-dependent) |
| Playwright can only target local servers | small change: base URL from env |
| GitHub CI | **needs your approval to commit**. The remote `origin` now exists; there are still no commits. |
| Physical printer validation | **needs hardware**. None is available to this session. |

## 3. Needs configuration only

Staging env vars and Vercel project settings (function region next to the database). Also Supabase Auth settings: leaked-password protection, and site URL for the staging domain.

## 4. Risks

**Deployment**
- Serverless API plus the pooler: each warm function instance holds its own small pool (max 5). Burst traffic multiplies connections, and the Supavisor pool size on a small instance is the limit. **Must be measured** (Step 9).
- A cold start costs JWKS fetch, pool connect and TLS on the first request after idle.
- Function region must be pinned next to the database. The default region may be far away.
- A new Supabase project drops realtime broadcasts until the daily `realtime.messages` partitions exist (seen on DEV).

**Security**
- The pairing rate limit is in memory per instance. On serverless it's effectively per warm instance, so weaker. Codes are single-use, 10-minute, and there are about 6.6×10¹¹ of them, so brute force stays impractical. Still document it.
- Device sessions are stored in `localStorage` on tablets and displays. See the physical-security note (Step 16).
- Owner MFA is not implemented.
- Refresh-token rotation: the print agent reads its refresh token from the environment at every start. **[LIVE, DEV]**: reusing the original token after a restart still worked with DEV's Auth settings. Stricter rotation settings would lock the agent out after a restart, so the agent should persist the latest token (hardening fix, below).
- A staging URL is public by default. Protect it or accept that login is required for everything; there's no anonymous data access.

**Hardware**
- No physical printer is available. Everything print-related remains **simulated-printer tested**. Codepage, cut command, paper width, and whether the `DLE EOT` status reply works vary by model and need a real device.

## 5. Plan for this phase (in order)
1. Create the STAGING project (a separate project in eu-west-1, next to the Vercel `dub1` region), and generalise the env scripts.
2. Push 13 migrations from empty, then verify; add the health migration as number 14 to both environments.
3. Security settings, then the auth/authz suites on staging.
4. Serverless entry point, bundle, deploy (production-style builds only), health checks.
5. Staging suites: realtime (against the **deployed** API), concurrency, integration.
6. Load test with server-side timings.
7. Playwright against the deployed staging URL.
8. Failure tests.
9. Readiness report (doc 10) with a PASS / PARTIAL / BLOCKED / NOT TESTED status for each area.

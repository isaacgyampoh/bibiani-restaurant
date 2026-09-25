# Production Readiness Report (after Phase 5)

Date: 2026-09-25. Environments: DEV `nkijnjovztglmwxoemqg` and **STAGING `impairlsvhkumjzhjhti`** (Supabase eu-west-1), with the staging app at `https://restaurant-management-staging.vercel.app` (Vercel, function region dub1).

**Overall verdict: NOT production-ready yet.** Everything software-side that can be tested without hardware passes on deployed staging, and GitHub CI is green. Two things block production:
1. No physical printer has been tested.
2. Owner MFA and the PITR/backup setup are not in place.

**Evidence levels used below:** CODE REVIEW · LOCAL TEST · DEV TEST · STAGING TEST (deployed API + staging database) · REAL BROWSER (Playwright Chromium against deployed staging) · REAL HARDWARE.

| # | Area | Status | Evidence |
|---|---|---|---|
| 1 | Architecture | PASS | CODE REVIEW. Clean Architecture unchanged. Phase 5 added only a composition root, a serverless entry, a health module and infra metrics. No domain changes. |
| 2 | Database | PASS | STAGING TEST: 14 migrations applied **from empty**, then `verify-environment.ts` passes 14/14 checks (40 tables, RLS on all, 88 FKs, 49 checks, 38 uniques, 104 indexes, cron sweep, realtime policy). |
| 3 | Security | PARTIAL | See §3. Owner MFA missing; the pairing rate limit is per instance. |
| 4 | Authentication | PASS (staff and devices) / PARTIAL (MFA) | STAGING TEST + REAL BROWSER |
| 5 | Authorization | PASS | STAGING TEST (administration, kitchen, payments suites) + REAL BROWSER (revoked device, deactivated staff) |
| 6 | Multi-tenancy | PASS | STAGING TEST: tenant-isolation 11/11, parallel pooled transactions with 0 foreign rows, realtime outsider refused |
| 7 | Realtime | PASS (after warm-up) | STAGING TEST with real sessions through the deployed API. The new-environment `MissingPartition` behaviour was reproduced and resolved by warm-up. |
| 8 | POS | PASS (online) / PARTIAL (offline) | REAL BROWSER. No offline outbox in the web POS; an unsent cart is lost on refresh. |
| 9 | Hall | PASS | REAL BROWSER Scenario A (pay after hand-over) |
| 10 | Takeaway | PASS | REAL BROWSER Scenario B (pay before hand-over) |
| 11 | KDS | PASS | REAL BROWSER + STAGING realtime |
| 12 | Customer display | PASS | REAL BROWSER, including offline/reconnect |
| 13 | Printing | **BLOCKED (hardware)** / PASS (simulated) | STAGING TEST: the real agent binary printed 16/16 jobs to TCP test printers. **No physical printer.** |
| 14 | Payments | PASS | STAGING TEST + REAL BROWSER (cash with change, MoMo, card, split, void, refund, duplicate) |
| 15 | Devices | PASS | STAGING TEST + REAL BROWSER (pairing, expiry, single use, re-pair, revoke, heartbeat, status) |
| 16 | Performance | PASS for single-restaurant load | STAGING TEST, measured (§16) |
| 17 | Failure recovery | PASS (as designed) | REAL BROWSER on staging (6/6), plus LOCAL TEST for database-down |
| 18 | Observability | PARTIAL | Health checks and `Server-Timing` exist; log drain, alerting and error tracking are not set up |
| 19 | Backups | **BLOCKED** | No production project; PITR not enabled; restore not rehearsed |
| 20 | CI/CD | PASS (CI) / PARTIAL (CD) | **GitHub CI green** on `104c03b` (run 36160536012). Staging deployed from that exact commit (release `staging-104c03b`). Deployment is scripted (`pnpm staging:deploy`), not yet automated in CI. |
| 21 | Known limitations | documented | §21 |
| 22 | Production deployment plan | written | [11-production-deployment-plan.md](11-production-deployment-plan.md) |

## 2. Database (STAGING TEST)
- Migrations 1–14 apply cleanly to an empty staging database with `supabase db push --db-url`. Staging was never modified by hand; migration 14 (health probes) was added as a new file.
- `rp_api` (the API login): direct table read denied (42501); cannot run the sweeper; sees nothing without a tenant; is not BYPASSRLS. `audit_logs` delete is denied for the API role (append-only).
- Cross-restaurant references are rejected (FK 23503) and cross-tenant inserts are refused by RLS (42501): `tenant-isolation.test.ts` on staging, 11/11.

## 3. Security
| Check | Result | Evidence |
|---|---|---|
| Leaked-password protection | **Enabled on staging**; a breached password ("password123456") is rejected with a clear 422 | STAGING TEST |
| Public sign-up | **Disabled on staging** (it was open by default): "Signups not allowed for this instance" | STAGING TEST |
| Minimum password length | 10 on staging (was 6) | STAGING TEST |
| Browser roles on tables | 0 privileges | STAGING TEST |
| Secrets in builds | web bundle, API and agent scanned with staging's **exact** secret values plus patterns: clean. The web bundle references only the staging project (build refuses otherwise). | LOCAL + STAGING bundle |
| DEV vs STAGING credentials | 0 shared values | LOCAL check |
| Security headers | HSTS, nosniff, frame DENY, referrer policy, permissions policy on the deployed app | STAGING TEST |
| Owner MFA | **Not implemented** (production item) | — |
| Pairing brute force | codes: 30⁸ possibilities, 10 min, single use; rate limit 5/min/IP **per function instance** (weaker on serverless) | CODE REVIEW |
| Device sessions on tablets | stored in browser storage; see §15 | CODE REVIEW |
| DEV auth settings | leaked-password protection and sign-up are still at defaults on DEV (development only) | — |

## 4–5. Authentication and authorization (STAGING TEST + REAL BROWSER)
- Staff sign-in works. A **deactivated staff member** is refused on their next action (browser test).
- A **revoked device** is refused and drops to sign-in (browser test).
- Pairing codes: 10-minute expiry (clock-controlled test), single use, re-pairing deletes the old login (the old identity no longer resolves).
- Permissions are checked server-side: cashier can't cancel or void; KDS can't act on another station; the display is read-only. A restaurant-wide grant can't reach another restaurant's branch.

## 7. Realtime (STAGING TEST, deployed API)
- POS → deployed API → KDS signal; KDS READY → POS and display; printer error → admin; outsider refused ("Unauthorized"); disconnect → reload → resume. Both tests pass.
- **New-environment check (explicit):** on a fresh staging project, every private join first failed with **`MissingPartition`** and broadcasts were dropped. Realtime created the daily partitions (24–28 Sep) after the first join attempt; since then `/health/ready` reports `storageReadyToday: true` and all tests pass. The production procedure includes a warm-up step.
- Safety polling restores state regardless (the offline browser test proves recovery).

## 8–12. POS, Hall, Takeaway, KDS, Customer display (REAL BROWSER on staging)
- **Scenario A** (18 s): Table 12; four stations each showing only their items; START/READY; partial then full readiness; display READY; served; split payment (cash 150 with 50 change, MoMo 110); completed; receipt queued on the till's printer; **second print = REPRINT**, audited, with no extra payment.
- **Scenario B** (7.7 s): customer name; Pastry / Kitchen / Drinks only; card payment (pay-before-hand-over area); ready; picked up; completed; the cake ticket queued on both pastry printers.
- **Admin:** devices with status, menu, stations and outputs, areas with payment policy, staff, print queue.

## 13. Printing
- **Simulated:** the real built agent against deployed staging.
  - It paired with a one-time code and printed **16/16** queued jobs (kitchen tickets on all stations, the cake's second printer, and 2 receipts).
  - The queue drained, and it reported all printers healthy.
  - It **survived two restarts that reused the original token**, signing in through its persisted rotated token (hardening fix this phase).
- Retry, backoff, backup reroute, possible-duplicate marking, dead-job visibility: STAGING TEST (`printing.test.ts` 5/5) and DEV agent tests.
- **REAL HARDWARE: NOT DONE.** No physical ESC/POS printer was available to this session. Codepage, cut, logo raster, paper width and `DLE EOT` status are unverified on a real device. This is a production blocker.

## 14. Payments (STAGING TEST + REAL BROWSER)
Cash exact and with change; insufficient cash rejected; non-cash overpayment rejected; fully-paid order refuses more payments; MoMo and card manual recording with reference; split 100 + 50 = paid, 50 + 50 = partially paid; payment void (permission, audit, balance reopens); refund (permission, cap, audit, completed stays completed); duplicate payment id records once (also under concurrency).

## 15. Devices
Pairing for POS, KDS, display and print agent; heartbeats; ONLINE/OFFLINE/last seen in admin; revoke and re-pair (STAGING TEST + REAL BROWSER).

**Physical security:** a paired tablet or display holds a long-lived device login in browser storage, and anyone with the unlocked device can act as that device. Dedicated devices must:
- run in kiosk mode,
- be screen-locked,
- be used for nothing else,
- be revoked immediately if lost or retired.

The blast radius is limited by design: a KDS can only operate its own station, a display can only read order numbers, and a POS can do nothing without a staff sign-in.

Edge case found: if the network drops **during** pairing, the code is used up and staff must generate a new one.

## 16. Performance (STAGING TEST, `perf-results/staging-2026-09-25T15-52-59-998Z.json`)
Server times come from `Server-Timing` on the deployed API (dub1 → Supabase eu-west-1). Client times include the test machine's network.

| Scenario | Server p50 / p95 / p99 (ms) | Client p50 / p95 (ms) | Errors |
|---|---|---|---|
| order submit ×1 | 321 | 843 | 0 |
| order submit ×10 sequential | 231 / 256 / 256 | 537 / 621 | 0 |
| order submit ×10 concurrent | 424 / 523 / 523 | 1057 / 1662 | 0 |
| order submit ×50 concurrent | 536 / 864 / 956 | 1311 / 10330 | 4/50: client-side connection failures from the test machine. **They never reached the server** (181 attempts produced 177 orders and 177 reservations). |
| order submit ×100 concurrent | 1121 / 1914 / 1959 | 2025 / 2917 | 0 (throughput ≈ 32 orders/s) |
| record payment ×10 | 76 / 81 | 374 / 396 | 0 |
| print-agent claim (10 jobs) | 91 / 156 | 387 / 458 | 0 |
| realtime: API response → KDS signal | — | 31 / 49 after the API response | 10/10 received |
| cold path (first request) | — | 345 | — |

- **Database statements per submit: 43.** Each costs about 5–7 ms between the function and the pooler, which explains the roughly 230–320 ms server time for a single order.
- **Bottleneck at 100 concurrent:** database connections. The pooler held at most **16** backend connections for the API on the staging compute tier (`max_connections` 60), so requests queued and database time grew to match server time.
- **For one restaurant** (peak on the order of 1–2 orders/s) there is roughly 15–30× headroom. Multi-restaurant production needs a larger compute tier or fewer statements per order. No optimisation was done this phase (measure first).

## 17. Failure recovery (REAL BROWSER on staging unless noted)
| Failure | What the user sees | Data safe | Retry safe | Duplicate possible |
|---|---|---|---|---|
| API unreachable during send | "No connection to the server…", then "Retry send" | yes (nothing created) | yes | no (one order after retry) |
| Response lost after a successful save | error, then retry succeeds | yes (saved once) | yes | **no** (tested) |
| Database unavailable (LOCAL TEST) | 503 "Unable to submit order. Please try again." (fixed this phase; was 500) | yes | yes | no |
| Realtime disconnect | amber "Offline sync"; screens keep polling | yes | n/a | n/a |
| Browser refresh during an unsent order | cart is lost (**known limitation**) | yes, nothing was sent | re-enter items | no |
| Browser refresh after sending | order fully restored | yes | n/a | n/a |
| Printer offline | KDS printer banner; job retries or reroutes; dead jobs visible and retryable | yes | yes | possible, **marked** "POSSIBLE DUPLICATE" |
| Print agent offline | jobs wait; admin shows agent offline after 90 s | yes | yes | marked on lease expiry |
| Device revoked while active | refused, drops to sign-in | yes | n/a | n/a |
| Staff deactivated while active | refused on next action | yes | n/a | n/a |
| Duplicate command / payment | one logical operation | yes | yes | no (concurrency suite on staging) |
| KDS / display disconnect | missed order appears after reconnect (≤ 10 s in test) | yes | n/a | n/a |

## 18. Observability
- **In place:**
  - `/health` (liveness plus release) and `/health/ready` (database, schema version, Auth keys, Realtime storage)
  - `Server-Timing` and structured logs carrying `dbMs` and `dbStatements`
  - device and printer status in admin
- **Missing:** log drain, alerting (5xx, `print_job.dead`), error tracking.

## 19. Backups
Blocked until the production project exists: PITR, nightly dump and restore drill (see the plan).

## 20. CI/CD
- **LOCAL CI:** green. That's lint, typecheck, 14 migrations from empty, 120 tests, builds, and the secret scan.
- **GITHUB CI:** **green** on commit `104c03b`, https://github.com/isaacgyampoh/bibiani-restaurant/actions/runs/36160536012. All steps passed on GitHub's runners (frozen-lockfile install, lint, typecheck, migrations from empty, tests, build, secret scan).
- **DEV VALIDATION:** done in Phase 4.
- **STAGING VALIDATION:** this report.
- **HARDWARE VALIDATION:** not done.

## 21. Known limitations (not built, by decision)
- Offline POS (no IndexedDB outbox; unsent carts are lost on refresh)
- Offline kitchen server
- PIN login
- Discounts and shifts
- Table transfer, merge and split
- Modifier administration
- Owner MFA
- **Reprinting a receipt for an already-completed order from the POS** (completed orders aren't listed; reprint works while the order is open)
- Inventory, marketing, loyalty, reservations, delivery, online ordering, AI
- Payment-provider integrations (manual payments by design)

## 22. Production deployment
See [11-production-deployment-plan.md](11-production-deployment-plan.md). **Do not deploy without explicit approval and the blockers below cleared.**

### Production blockers
1. **Real printer validation**: the §6 checklist in [06-device-and-printing.md](06-device-and-printing.md) with at least one 80 mm network ESC/POS printer, covering a kitchen ticket and a receipt.
2. **Backups:** production project on a paid plan with PITR, plus a rehearsed restore.
3. **Owner MFA** (or an explicit, documented risk acceptance by the owner).
4. **Monitoring/alerting** minimum: uptime check on `/health/ready`, alert on 5xx and dead print jobs.

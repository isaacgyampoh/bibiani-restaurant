# Production Deployment Plan

> **Status:** production is live at `https://bibiani-restaurant.vercel.app`; see [13-production-go-live-report.md](13-production-go-live-report.md) for the launch results, open items and final status. PITR is off by the owner's choice (daily backups only).

## 1. Target

| Item | Production | Rehearsed on staging |
|---|---|---|
| Supabase project | `restaurant-management-prod`, **paid plan** (PITR add-on, adequate compute for peak), region **eu-west-1** | `restaurant-management-staging` (eu-west-1) |
| API | Vercel project `restaurant-management-prod`, one Node serverless function pinned to **dub1** (next to eu-west-1) | `restaurant-management-staging`, dub1 |
| Web | same Vercel project, static, same origin as the API (`/v1`, `/health` routed to the function) | same |
| Print agent | built `apps/print-agent/dist/main.js` as a system service on an always-on LAN machine in the restaurant | built binary against staging (TCP test printers only) |

## 2. Environment variables (Vercel project, Production target, all "Sensitive")

| Variable | Value source |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | prod project settings |
| `SUPABASE_SECRET_KEY` | prod project's secret key (`sb_secret_…`), **never** on a laptop longer than needed |
| `DATABASE_URL` | `rp_api` login on the prod transaction pooler (6543); password generated at setup |
| `APP_ENV=production`, `DB_POOL_MAX=3`, `DEVICE_ACCOUNT_DOMAIN` | fixed |
| `RELEASE` | set per deployment by the deploy step |

Browser build: only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (public), sealed per environment by `scripts/deploy/build-vercel.mjs`. The build refuses to finish if the bundle references another Supabase project or contains a secret.

## 3. First-time setup, in order ☐

1. ~~Create the prod Supabase project~~ **Done once (2026-09-25). Use the existing project `lgoirbfyspuflqekrcgp`; do not create new Supabase projects.** Store the postgres password in the team password manager, not in the repository.
2. Auth settings through the Management API (as done on staging):
   - `password_hibp_enabled=true`
   - `password_min_length=10`
   - `disable_signup=true`
   - site URL = production domain
   - consider **owner MFA** (not implemented yet; see readiness report)
3. `supabase db push --db-url <prod postgres url>`: all migrations from empty.
4. Create logins: `scripts/env/configure-production.sh` (sets `rp_api` only).
   - **Do not create `rp_test_admin` in production.**
   - Platform operations use a separate, short-lived privileged connection.
5. Run `scripts/env/verify-environment.ts` against prod. All checks must pass.
6. **Realtime warm-up.** The known new-project behaviour: broadcasts and private joins fail with `MissingPartition` until the Realtime service creates the daily partitions.
   - Run `scripts/env/realtime-warmup.ts` (temporary login, deleted afterwards).
   - Confirm `/health/ready` reports `realtime.storageReadyToday: true`.
7. Enable **Point-in-Time Recovery** and confirm it in the dashboard. Schedule a nightly `pg_dump` to separate storage.
8. Create the Vercel project and set the env vars (§2). Pin the function region to dub1 (in the bundle's `.vc-config.json`).
9. Build: `node scripts/deploy/build-vercel.mjs production .env.production`. Then deploy with `vercel deploy --prebuilt --prod`.
10. Check `/health` and `/health/ready` (all four checks `ok`).
11. Custom domain and TLS (§5).

## 4. Deploying a new release (every time)

1. GitHub CI green on the commit (☐: CI has not run on GitHub yet).
2. Migrations first: `supabase db push` to STAGING, then verify. Migrations must be backward compatible with the release currently live (expand, then contract).
3. Build and deploy to STAGING. Run the smoke checks: `/health/ready`, the Playwright milestone scenarios, realtime suite.
4. Approval.
5. `supabase db push` to PROD, then deploy the same commit's build to PROD.
6. Check `/health/ready`. Watch the logs for 15 minutes.

## 5. Domains and TLS ☐

`app.<restaurant-domain>` points at the Vercel project, with automatic TLS. The API is same-origin (`/v1`), so no CORS is needed. Restaurant network: outbound 443 only.

## 6. Health checks and monitoring

| Endpoint | Meaning | Use |
|---|---|---|
| `GET /health` | process alive; returns `release` | uptime monitor, 1 min |
| `GET /health/ready` | 200 only if the database is reachable (as `rp_api`), the schema version is ≥ the build's, and the Auth signing keys are reachable; reports Realtime storage without affecting status | uptime monitor with alert on 503; checked after each deploy |
| Admin → Devices | device heartbeats (30 s), offline after 90 s (pg_cron sweep), printer health from the agent | restaurant manager |
| Admin → Print queue | failed/dead jobs with retry | restaurant manager |
| Logs | structured JSON with `correlationId`, `dbMs`, `dbStatements` per request; `server-timing` header | Vercel log drain ☐ + alerts on 5xx rate and `print_job.dead` ☐ |

## 7. Backups and rollback

- **Backups:** PITR (paid add-on) plus a nightly independent `pg_dump`. Proposed RPO ≤ 5 min and RTO ≤ 2 h, to be agreed with the owner. Restore drill into STAGING before go-live ☐.
- **App rollback:** `vercel rollback` or promote the previous deployment (instant). The release id is visible in `/health`.
- **Database:** never down-migrate. Fix forward with a new migration.

## 8. Device pairing procedure (on site)

1. Manager: Admin → Devices → the device (e.g. `KITCHEN-01`) → **Pairing code**. It shows 8 characters, valid 10 minutes, single use.
2. On the tablet or TV: open `https://app.<domain>/pair` and enter the code. The KDS and customer display go straight to their screens. The POS then shows "This till: POS-01" and a staff sign-in.
3. Confirm in Admin → Devices that the device turns **online** within 30 s.
4. Lost or stolen device: **Revoke** in Admin → Devices. Its login is deleted, and the API refuses it immediately.
5. **Physical security:** paired tablets hold their login in browser storage. Treat them like keys: kiosk mode, screen lock, no personal browsing, revoke when a device leaves the restaurant.

## 9. Printer setup procedure (on site) ☐ (not yet done with real hardware)

1. Give each printer a fixed IP (DHCP reservation). Print its self-test page and note the IP.
2. Install the agent machine: Node 22+, copy `apps/print-agent/dist/main.js`, create the service user, and create `.env` from `apps/print-agent/.env.example`.
3. Admin → Devices → `PRINT-AGENT-01` → Pairing code. Pair the agent through the API (see the pairing request in `scripts/dev/print-agent-smoke.ts`) and put the returned refresh token in `AGENT_REFRESH_TOKEN`. The agent persists rotated tokens itself.
4. Admin → Devices → each printer: set the address (`IP:9100`) and the driving agent.
5. Start the service (systemd or Windows service, auto-restart). Admin shows the agent **online** and each printer **healthy**.
6. Run the hardware checklist in [06-device-and-printing.md](06-device-and-printing.md) §6: test ticket, codepage, cut, offline and recovery, duplicate banner.

## 10. First restaurant onboarding

1. Platform operator: `scripts/platform/create-restaurant.ts` creates the restaurant, first branch, role templates and owner login (numbers start at 5001 or as agreed).
2. Owner signs in, then in Admin sets up:
   - areas (Hall pay-after / Takeaway pay-before, or as the restaurant prefers) and tables,
   - stations and printers/KDS outputs,
   - categories, products and taxes (**rates from the restaurant's accountant**),
   - routing rules (and check the Stations & routing tab),
   - staff and roles.
3. Pair devices (§8) and printers (§9).
4. Dry run: place one order per station, print, ready, pay, receipt. Then a supervised first service.

## 11. Emergency recovery

| Situation | Action |
|---|---|
| API errors after a deploy | `vercel rollback` to the previous release; check `/health/ready` |
| Database unavailable | POS shows "Unable to … Please try again" (retryable, nothing half-saved). Check the Supabase status page; readiness shows the database check failing. Resume when it's back. Retries are safe (idempotent ids). |
| Realtime down | Screens keep working from the safety poll (KDS 20 s, others 15–30 s). No action needed except monitoring. |
| Printer offline | KDS shows the red printer banner; jobs retry, then reroute to the backup printer if configured, then show as dead in the print queue. Fix the printer and press Retry. Tickets are always visible on the KDS. |
| Print agent machine down | Jobs wait in the queue. Admin shows the agent offline after 90 s. Restart the machine or service; the agent resumes and marks possible duplicates. |
| Lost or stolen tablet | Admin → Devices → Revoke |
| Staff member leaves | Admin → Staff → Deactivate (effective on their next action) |
| Data loss / corruption | Restore by PITR to a new project, verify, then repoint `DATABASE_URL`. Follow the rehearsed procedure (☐ rehearse). |

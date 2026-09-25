# Production Go-Live Report

Date: 2026-09-25 · Production URL: **https://bibiani-restaurant.vercel.app**

## Final status: **BLOCKED** (software live; restaurant not yet able to trade)

The platform is deployed, healthy, monitored and validated in production. What remains is on the restaurant side:

1. **The owner has not signed in yet.** A set-password email was sent to nanagyams99@gmail.com, but see §9 about delivery.
2. **There is no menu, and no prices or taxes.** The owner enters these, as agreed ("structure only").
3. **The hardware has not been validated:** `HARDWARE VALIDATION PENDING` (§12).

Once items 1 and 2 are done, the restaurant can take orders using KDS screens. Printing needs item 3 as well.

## 1. Release

| Item | Value |
|---|---|
| Commit | `3070a2a` (API/web deployed), later commits are scripts, tests and docs only (`f0d6222`, `9fc24f4`) |
| Release id (`/health`) | `production-3070a2a` |
| GitHub CI | green on `59f334f`, `2b7d783`, `3070a2a`, `f0d6222` (lint, typecheck, migrations + RLS, 122 tests, build, secret scan) |
| Local checks | lint, typecheck, 122/122 tests, 15 migrations applied from empty with RLS on all 40 tables, secret scan on every build output |

## 2. Changes in this launch

- **Completed-order receipt reprint.** POS → **Completed** tab (today's and yesterday's closed orders) → **Open** → **Reprint receipt**.
  - The reprint is marked `** REPRINT **` and audited (`receipt.reprint`).
  - It needs the `receipt.print` permission.
  - It never reopens the order, never changes status or payments, and never creates a sale.
  - Covered by an integration test (state before and after compared, REPRINT banner rendered, permission refused for a kitchen screen) and an e2e test on staging and production.
- **Owners and staff set their own password.** "Forgot password?" on sign-in sends a single-use link to `/set-password` (minimum 10 characters, breached passwords refused). Any recovery session is routed to that screen.
- **Monitoring** (migration `20260925001500_ops_monitoring`, §8).
- **Platform scripts:**
  - `create-restaurant.ts` no longer needs or prints an owner password.
  - `initial-structure.ts` builds the starting structure through the admin API as a temporary, clearly named setup account. That account is deactivated and its login deleted afterwards.

## 3. Supabase production

| Check | Result |
|---|---|
| Project | `lgoirbfyspuflqekrcgp`, eu-west-1, Postgres 17.6, ACTIVE_HEALTHY |
| Schema version | `20260925001500` = the version the build requires (readiness check) |
| Migrations | 15, applied with `supabase db push` only. No manual schema changes. |
| API login | `rp_api` only (can only `SET ROLE app_api`; RLS applies). **No test logins in production.** |
| Auth | signup disabled, HIBP check on, minimum password length 10, site URL `https://bibiani-restaurant.vercel.app`, redirects limited to the production domains |
| New objects' privileges | `anon` / `authenticated` have **no** access to `app.ops_counters`, `app.ops_health()` or `app.ops_record()` (verified) |

## 4. Security

- Browser bundle contains only the public URL and anon key. The secret scan passed on the production build.
- Service keys (`SUPABASE_SECRET_KEY`, `DATABASE_URL`, `MONITOR_TOKEN`) live only in Vercel's encrypted environment variables and the gitignored `.env.production`.
- Headers: HSTS, `X-Frame-Options: DENY`, `nosniff`, strict referrer policy. **Gap:** no Content-Security-Policy header yet.
- Plain `http://` requests from the test network were intercepted by the ISP (Vodafone GH portal). Always use `https://`; HSTS enforces this after the first visit.
- Pairing endpoint is rate-limited (5 per minute per address). This was observed working during testing.

## 5. Backups and recovery

- **Daily backups: ON** (WAL-G). 1 completed backup, taken 2026-09-25 15:54 UTC. **PITR: OFF** (owner's choice).
- Worst-case data loss is therefore up to ~24 h of orders.
- **Restore has NOT been tested.**
- Recovery procedure:
  1. Supabase dashboard → Database → Backups → restore the chosen daily backup. Supabase restores into the same project, which means downtime.
  2. Check `/health/ready` (schema version).
  3. Run `scripts/env/realtime-warmup.ts` if Realtime reports storage not ready.
  4. Reconcile orders taken since the backup from paper or the till receipts.
- Recommended before heavy trading: enable PITR, or schedule an independent nightly `pg_dump`.

## 6. Hosting and health

| Check | Result |
|---|---|
| `/health` | `{"status":"ok","release":"production-3070a2a"}` |
| `/health/ready` | ready: database 64 ms, schema OK, Auth signing keys 1, Realtime storage ready |
| API | same origin (`/v1`), Vercel function pinned to dub1 next to eu-west-1 |
| Rollback | `vercel rollback` / promote the previous deployment (instant) |

## 7. Domain

`https://bibiani-restaurant.vercel.app` (Vercel subdomain, as chosen) is assigned to the production project, so it follows every production deploy. TLS is valid over HTTP/2. The older `restaurant-management-prod-rouge.vercel.app` still works.

## 8. Monitoring (minimum)

The GitHub Actions workflow `.github/workflows/monitor.yml` runs every 5 minutes. **A failed run is the alert:** GitHub emails the repository owner.

| Alert | Condition |
|---|---|
| App down | `/health` not 200 three times, 20 s apart |
| Database, schema or Auth failure | `/health/ready` not 200 three times, 20 s apart |
| Repeated 5xx | ≥ 5 server errors in 15 min |
| Auth failures | ≥ 50 failed authentications in 15 min |
| Print jobs failing | ≥ 3 failed or dead jobs in the last hour |
| Repeated retries | any job on its 3rd or later attempt |
| Print agent offline | any **paired** agent offline |
| Printer offline | any active printer reporting an error |
| Jobs not being claimed | warning only: jobs waiting over 5 min |

- The counts come from `GET /v1/ops/health`. It is protected by `MONITOR_TOKEN` (the GitHub secret must match the Vercel variable) and returns counts only, no restaurant data.
- A manual run on 2026-09-25 passed.
- Not included: log drain or Sentry, and Supabase CPU and connection alerts.

## 9. First restaurant: Bibiani Restaurant

Created on 2026-09-25 with structure only:

| Item | Created |
|---|---|
| Branch | Main (order numbers from 1) |
| Areas | Hall (dine in, table required, **pay after**), Takeaway (**pay before** handover) |
| Tables | 1–10, capacity 4 (the owner adjusts in Admin) |
| Stations | Kitchen (KIT), Drinks (DRK), each shown on its own KDS |
| Devices | POS-01, KITCHEN-01, DRINKS-01, CUSTOMER-DISPLAY-01, PRINT-AGENT-01 (none paired) |
| Routing | default → Kitchen (the owner adds e.g. "category Drinks → Drinks") |
| Roles | standard templates (Owner, Manager, Cashier, Waiter, Kitchen, …) |
| Menu, prices, taxes | **none**: the owner enters them (tax rates from the accountant) |
| Owner | nanagyams99@gmail.com, Owner role on all branches. **No password was created or shared.** A single-use set-password link was emailed at 17:04 UTC. |

**Email delivery risk:** the project uses Supabase's built-in email. It only delivers to members of the Supabase organization, and the only member is room38303@gmail.com. If the owner receives nothing, do one of the following, then press **Forgot password?** on the sign-in screen:

- invite nanagyams99@gmail.com to the Supabase organization, or
- configure custom SMTP in Supabase Auth (recommended before staff use self-service reset).

## 10. Staff users

Production has exactly **one** login: the owner. The temporary setup account and all smoke-test logins are deleted, and their staff records are deactivated for the audit trail. The owner creates real staff in Admin → Staff.

## 11. Device pairing

No devices are paired yet. On site:

1. Admin → Devices → the device → **Pairing code**.
2. On the device, open `https://bibiani-restaurant.vercel.app/pair` and enter the code.

See [11-production-deployment-plan.md](11-production-deployment-plan.md) §8.

## 12. Printer: `HARDWARE VALIDATION PENDING`

- No physical printer or agent machine was available. **No hardware test was performed.**
- Printers were deliberately **not** created, because their LAN addresses are unknown and placeholder addresses would produce failing jobs.
- Printing was validated only against TCP test printers on staging (16/16).
- On site:
  1. Create the printers with their real IPs and attach them to stations and to POS-01's receipt printer.
  2. Pair PRINT-AGENT-01.
  3. Run the checklist in [06-device-and-printing.md](06-device-and-printing.md) §6.

## 13. Production smoke tests

- **Where they ran:** a separate tenant, "Platform smoke test (not a real restaurant)", slug `platform-smoke-test`. This kept Bibiani's order numbers, sales and audit history clean.
- **Its printers** used the non-routable documentation range 192.0.2.x.
- **Afterwards:** the tenant is deactivated, its 12 logins are deleted, and its data and audit history are kept.

| Test (browser, against `https://bibiani-restaurant.vercel.app`) | Result |
|---|---|
| Hall: Table 12, four stations, split cash + MoMo, served, completed; later Completed → Reprint (REPRINT, audited, still 2 payments) | ✅ |
| Takeaway: pay before handover (card), ready, picked up | ✅ |
| Admin: devices, print queue, menu, routing, areas and payment policy, staff | ✅ |
| Set own password from a recovery link; link single use; sign in with the new password | ✅ |
| Realtime with real clients: paired KDS + customer display "Live", new order shown **1.5 s** after submit | ✅ |

## 14. Safe failure checks (production, smoke tenant)

All 6 passed. None of them is destructive to the database.

- API unreachable during send: clear error, nothing created, and the retry creates exactly one order.
- Response lost after save: the retry does not duplicate the order.
- Browser refresh: an unsent cart is lost (known limitation), and a sent order is recovered in full.
- KDS and display offline: both catch up after reconnecting.
- Device revoked: its next action is refused.
- Staff deactivated: their next action is refused.

## 15. Production data

Before the tenant was created, production had 0 restaurants, 0 users, 0 orders and 0 audit rows. Nothing was copied from DEV or staging.

## 16. Go-live checklist

| Item | Status |
|---|---|
| Release candidate committed, CI green | ✅ |
| Migrations applied, schema version matches | ✅ |
| Security settings (signup off, HIBP, least-privilege API login, no test logins) | ✅ |
| Backups (daily) | ✅, restore not tested |
| Health, readiness, domain, TLS | ✅ |
| Realtime | ✅ |
| Monitoring and alerts | ✅ |
| Tenant structure | ✅ |
| Smoke and failure tests | ✅ |
| Owner signed in and password set | ☐ (email delivery, §9) |
| Menu, prices, taxes, routing per category | ☐ owner |
| Real staff accounts | ☐ owner |
| Devices paired | ☐ on site |
| Printers and agent (`HARDWARE VALIDATION PENDING`) | ☐ on site |
| Supervised first service | ☐ |

## 17. Accepted risks and follow-ups

- No PITR (up to ~24 h data loss) and no rehearsed restore.
- Built-in email is not suitable for staff password resets (configure SMTP).
- No CSP header. No error tracking or log drain.
- An unsent cart is lost on refresh. An interrupted pairing consumes the code.
- The owner has no MFA.

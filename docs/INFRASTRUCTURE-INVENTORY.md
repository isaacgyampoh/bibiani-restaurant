# MY FOOD — infrastructure inventory

Date: 2026-09-26. Every resource below was inspected directly (Vercel API/CLI, Supabase CLI/Management API, GitHub API, the production and staging databases). **Nothing was deleted.** Two clean-up actions were attempted but blocked by the session's permission policy, so they are listed under **Actions for the owner**.

Classification:
- **KEEP – PRODUCTION**
- **KEEP – DEVELOPMENT**
- **ARCHIVED / OPTIONAL**
- **SAFE TO DELETE**
- **UNKNOWN – DO NOT DELETE**

## Summary

| Resource | Provider | Name / ID | Environment | Used by production? | Classification |
|---|---|---|---|---|---|
| Web + API deployment | Vercel | `restaurant-management-prod` (`prj_2v8lZfXUPR9RpvIk3dj0ccrULg27`) | Production | **YES**: serves https://bibiani-restaurant.vercel.app | **KEEP – PRODUCTION** |
| Database, Auth, Storage, Realtime | Supabase | `lgoirbfyspuflqekrcgp` "restaurant-management-prod", eu-west-1 | Production | **YES** | **KEEP – PRODUCTION** |
| Source code, CI, monitor | GitHub | `isaacgyampoh/bibiani-restaurant` (public), branch `main` | All | **YES** (source of every release; monitor checks production every 5 min) | **KEEP – PRODUCTION** |
| Staging deployment | Vercel | `restaurant-management-staging` (`prj_L0nJfaCJVHE0VMpqt2SwQ8p6UiPV`) | Staging | No | **KEEP – DEVELOPMENT** (release gate: browser tests run here). Disconnect Git (see below) |
| Staging database | Supabase | `impairlsvhkumjzhjhti` "restaurant-management-staging", eu-west-1 | Staging | No | **KEEP – DEVELOPMENT** (release gate) |
| Old DEV database | Supabase | `nkijnjovztglmwxoemqg` "bibiani-restauran", eu-west-1 | Local development | No | **ARCHIVED / OPTIONAL** (see below) |
| Stray web project | Vercel | `web` (`prj_Ql7IJqd9hVPbJLLV7kh3x0n1tZOH`), root `apps/web` | None | No | **SAFE TO DELETE** (see evidence) |
| 17 other Vercel projects (e.g. bedtime-beddings-home, tagitela, susu, carl, desktop, erbliving-shop…) | Vercel | various | Other products | No | **UNKNOWN – DO NOT DELETE** (not part of MY FOOD) |
| 8 other Supabase projects (Gyampo, carl-staging, WHOLESALE-DISTRIBUTION-MANAGEMENT-SYS, Mimi, susu, room38303@gmail.com, AM-EXPRESS-TRADING, Carl) | Supabase | various | Other products | No | **UNKNOWN – DO NOT DELETE** (not part of MY FOOD) |

## Production in detail

### Vercel `restaurant-management-prod`
- Team `isaacs-projects-7cdab31a`. Aliases:
  - `bibiani-restaurant.vercel.app` (the production URL);
  - `restaurant-management-prod-rouge.vercel.app` (Vercel's project alias).
- **Not connected to Git.** Every production release is a prebuilt deployment made by `pnpm release`, after the release gate. This is deliberate: a push can never deploy production by accident.
- Environment variable names (values never shown):
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`;
  - `APP_ENV`, `APP_URL`, `DB_POOL_MAX`, `DEVICE_ACCOUNT_DOMAIN`;
  - `MONITOR_TOKEN`, `PIN_PEPPER`.
- Serverless function region: `dub1` (Dublin, next to the database in eu-west-1).

### Supabase `lgoirbfyspuflqekrcgp`
- Postgres 17, database size 16 MB. 28 migrations applied (latest `20260926000700`); 51 tables, all with row-level security.
- **Restaurants inside it** (isolated from each other by row-level security):

| Restaurant | Staff | Orders | Products | Devices | Role |
|---|---|---|---|---|---|
| **Chefelisha Restaurant** | 1 active owner login + 1 deactivated setup record | **0** | **0** | 5 (none paired) | **The real client restaurant**. Clean: no demo staff, orders, payments, stock or fake history |
| Chefelisha Restaurant — Demo | 8 | 12 | 17 | 8 | Demonstration, kept for verification (read-only checks) |
| Platform smoke test (not a real restaurant) | 7 (logins deleted at go-live) | 7 | 8 | 13 | Go-live smoke test. **ARCHIVED**: kept because deleting it would delete its audit history |

- **Auth:**
  - public sign-up **disabled**; passwords at least 10 characters;
  - site URL https://bibiani-restaurant.vercel.app; redirect allow-list is the production aliases;
  - **email uses Supabase's built-in sender**: at most 2 emails an hour, delivered only to members of the Supabase organization (see Actions);
  - MFA (TOTP) available.
- **Storage:** bucket `product-images` (public read; only the API writes). 0 objects today.
- **Scheduled job:** `rp-sweep-offline-devices` (pg_cron, every minute; marks silent devices offline). Needed.
- **Edge functions:** none.
- **Backups:** daily backups ON; point-in-time recovery OFF (owner's choice at go-live).

## Development resources

- **Staging** (Vercel + Supabase `impairlsvhkumjzhjhti`, 32 MB). Every release is deployed here first. The browser test suite (18 tests) creates a fresh test restaurant for each run. It holds only test data. Keep while releases continue.
- **Old DEV database `nkijnjovztglmwxoemqg`.** Used only by a developer laptop's `.env` for `pnpm dev`, and as the allowed target of a few dev-only scripts (`TEST_ALLOWED_PROJECT_REF`). The automated tests do not use it (they run on in-memory Postgres). Older docs called it "retired", which is right for production but not for local development.
  - **Recommendation:** point local development at staging (or local Supabase), then pause or delete this project to save its monthly compute cost.
  - Not done here: deleting a database is irreversible, and it is still referenced by local configuration.

## Evidence for "SAFE TO DELETE": Vercel project `web`

- **Created:** 2026-09-25 16:55 by importing this GitHub repo, with root directory `apps/web`.
- **Deploys:** a new production deployment on every push to `main`, the most recent 4 hours ago.
- **Zero environment variables:** the bundle it serves contains no Supabase address, and `/v1/*` returns 404. It cannot sign anyone in or reach any data.
- **No custom domain.** Its only URLs are `web-one-nu-29.vercel.app`, `web-isaacs-projects-7cdab31a.vercel.app` and `web-git-main-…`.
- **Nothing refers to it:** no doc, script, environment or DNS record.
- **Risk if kept:** someone could open the wrong URL and see a MY FOOD sign-in page that doesn't work. It also uses build minutes on every push.
- **Rollback:** re-importing the repo recreates it in a minute. It holds no data.

## Actions for the owner (blocked in this session; each is reversible or evidence-backed)

1. **Delete the Vercel project `web`:** Vercel dashboard, project `web`, Settings, Delete Project.
2. **Disconnect Git from `restaurant-management-staging`:** Settings, Git, Disconnect.
   - Every push currently starts a Git build of staging that fails ("Error" deployments).
   - Staging is always deployed by `pnpm staging:deploy` instead.
   - Disconnecting stops the failed builds and removes the risk of a Git build replacing staging with a misconfigured one.
3. **Connect a real email provider (SMTP) to production Supabase** (Authentication, Emails, SMTP settings) with a sender on the client's domain, e.g. `no-reply@<domain>`. **Required before owner sign-up and password emails reach anyone outside the Supabase organization.** Then apply `supabase/templates/recovery.html` as the "Reset password" template.
4. **Optional:** retire the old DEV database `nkijnjovztglmwxoemqg` (see above).

## Cost notes

- **Supabase:** the organization has 11 active projects. Three belong to MY FOOD (production, staging, old DEV). Only production is essential. Staging is needed while releases continue. Old DEV is optional.
- **Vercel:** MY FOOD uses two projects (production, staging) plus the stray `web`. No paid add-ons were found.
- **GitHub Actions:** CI and the 5-minute monitor run free on a public repository.

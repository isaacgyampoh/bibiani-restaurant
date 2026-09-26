# MY FOOD — production architecture

The single source of truth for the system the restaurant runs on. No secrets are in this document.

```
CLIENT (browser, installed app, tills, kitchen screens, customer display)
  ↓
DOMAIN          https://bibiani-restaurant.vercel.app   (+ the client's own domain when purchased)
  ↓
VERCEL          project restaurant-management-prod  (team isaacs-projects-7cdab31a)
                web app (static) + API function (region dub1)
  ↓
ENV VARIABLES   set on the Vercel project (names below)
  ↓
SUPABASE        project lgoirbfyspuflqekrcgp  (eu-west-1): Postgres 17, Auth, Storage, Realtime
  ↓
DATA            restaurant "Chefelisha Restaurant" (real) · demo · smoke test (isolated by RLS)
```

## Components

| Part | Where | Notes |
|---|---|---|
| Production URL | https://bibiani-restaurant.vercel.app | Stays working after a custom domain is added |
| Vercel project | `restaurant-management-prod` | **Not connected to Git**; deployed only by `pnpm release` |
| Git repository | github.com/isaacgyampoh/bibiani-restaurant | Production branch `main`; CI on every push; monitor every 5 minutes |
| Supabase project | `lgoirbfyspuflqekrcgp`, region eu-west-1 | Single production database; migrations in `supabase/migrations` (forward only) |
| API | Hono on Vercel Node functions, region `dub1` | Clean Architecture: domain → application → infrastructure → apps; every write authorized server-side |
| Database security | Row level security on every table; the API connects as a restricted role and sets the restaurant per transaction | Verified by `scripts/env/verify-environment.ts` (15 checks) |
| Auth | Supabase Auth | Owners and managers: email + password (at least 10 characters, breached passwords refused). Staff: PIN on a paired till (keyed digest, lockouts). Devices: their own login per pairing. Public sign-up disabled |
| Email | **Supabase built-in sender today**; production needs custom SMTP (see Domain and email) | Templates: `supabase/templates/` |
| Storage | Bucket `product-images`, public read, written only by the API | Photos 640 px and 320 px thumbnails, 1-day cache |
| Realtime | Supabase Realtime private channels per branch | Kitchen, supervisor and customer display update live, with a safety poll |
| Scheduled job | `rp-sweep-offline-devices` (pg_cron, every minute) | Marks silent devices offline |
| Security headers | CSP, HSTS, X-Frame-Options DENY, nosniff, referrer and permissions policies | Set in `scripts/deploy/build-vercel.mjs` |
| Monitoring | `/health` and `/health/ready` (database, schema version, auth keys); GitHub Actions `monitor.yml` | A failed monitor run emails the repository owner |

### Environment variables (Vercel production; names only)

| Variable | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase project address and public key |
| `SUPABASE_SECRET_KEY` | Server-only key (creating logins, storage writes). Never sent to browsers: the build checks the bundle for secrets |
| `DATABASE_URL` | Restricted API database login (row level security applies) |
| `PIN_PEPPER` | Server-only secret for staff PIN digests |
| `APP_URL` | Public address used in email links (change it to the custom domain later) |
| `APP_ENV`, `DB_POOL_MAX`, `DEVICE_ACCOUNT_DOMAIN`, `MONITOR_TOKEN` | Environment name, pool size, device-login domain, monitor access |

## Deployment procedure (release gate)

Never deploy first and fix afterwards. In order:

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm test`: all automated tests (in-memory Postgres with the real migrations).
4. `pnpm db:check`: migrations apply cleanly, and every table has row level security.
5. **Staging:**
   - `supabase db push` to staging;
   - `node scripts/deploy/stamp-schema-version.mjs`;
   - `pnpm staging:deploy`;
   - `pnpm staging:e2e`: all browser tests, on a fresh test restaurant.
6. **Production database:** `supabase db push` with the production database URL. Migrations must be additive, so the running release keeps working. The readiness check accepts a newer schema.
7. **Production app:** `pnpm release`, which builds, checks the bundle for secrets and deploys with `RELEASE=production-<git sha>`.
8. **Post-deploy verification:**
   - `curl https://bibiani-restaurant.vercel.app/health/ready` shows `ready`, the new release and the expected schema;
   - run `scripts/env/verify-environment.ts` against production (15/15);
   - read-only browser sweep (`e2e/zz-qa-prod-readonly.spec.ts`, demo restaurant): no console errors, no policy violations;
   - CI green on the pushed commit.

## Rollback

- **App:** Vercel dashboard, `restaurant-management-prod`, Deployments. Pick the previous production deployment and choose **Instant Rollback** (or `vercel promote <deployment-url>`). The production URL moves back at once.
- **Database:** migrations are forward-only and additive, so an older app runs against a newer schema. Do not undo migrations. If a bad data change needs undoing, restore from a Supabase backup (daily backups ON; point-in-time recovery OFF). A restore replaces the whole database, so take it only after deciding what is lost since the backup.

## Backup and recovery

- **Supabase daily backups:** ON. Retention depends on the Supabase plan; check it in the dashboard (Database, Backups).
- **Point-in-time recovery:** OFF. Turning it on allows restoring to any minute, and is recommended once the restaurant trades daily.
- **Audit history** (`audit_logs`) is append-only for the API role and is never deleted.
- **Code:** GitHub. Every production release is tagged in the deployment as `production-<sha>`.

## Staging and development

- **Staging:** Vercel `restaurant-management-staging` with Supabase `impairlsvhkumjzhjhti`, at https://restaurant-management-staging.vercel.app. Test data only. Used by the release gate.
- **Local:** `pnpm dev`. Automated tests need no Supabase project.
- **Old DEV project:** `nkijnjovztglmwxoemqg`. Optional; see [INFRASTRUCTURE-INVENTORY.md](INFRASTRUCTURE-INVENTORY.md).

## Domain and email: adding the client's domain

The existing URL keeps working. When the client has bought a domain (example `myfood.example.com`):

1. **Vercel:** in project `restaurant-management-prod`, open Settings, Domains, and add `myfood.example.com` (and `www.myfood.example.com` if wanted).
2. **DNS** (at the domain registrar), exactly what Vercel shows. Typically:
   - apex `@`: `A` record to `76.76.21.21`;
   - `www`: `CNAME` to `cname.vercel-dns.com`.

   HTTPS certificates are issued automatically. Set `www` to redirect to the apex (or the reverse) in Vercel's Domains page.
3. **App URL for emails:** set the Vercel env `APP_URL=https://myfood.example.com`, then release. Email links then use the new domain.
4. **Supabase Auth** (Authentication, URL Configuration):
   - Site URL `https://myfood.example.com`;
   - add `https://myfood.example.com/**` to the redirect URLs;
   - keep the existing `https://bibiani-restaurant.vercel.app/**`, so links from either address work.
5. **Email sender:** add custom SMTP with a sender on the domain (for example `no-reply@myfood.example.com`, using SPF and DKIM records from the email provider). Apply the MY FOOD template `supabase/templates/recovery.html`.
6. **Security policy:** no change needed. The policy allows the app's own origin, whatever the domain.
7. **App manifest and icons:** relative paths, so they work unchanged on the new domain. Receipts carry no web links.
8. **Devices:** already-paired tills and screens keep working on the old URL. To move one to the new domain, open the new address on it and pair it again: its old login stops at once.

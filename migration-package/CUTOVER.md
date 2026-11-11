# MY FOOD — cutover from Supabase to the central server

For the day the Contabo server exists. Nothing here has been run against production.
Everything before step 4 can be repeated freely; step 4 starts the only write freeze.

## What must not be lost

Orders, payments, kitchen tickets, stock, registers, customers, staff, logins, paired devices,
photos. The restaurant trades every day (2,615 orders and GHS 321,400 recorded by 2026-11-11),
so any copy is stale within the hour. The **final** copy is taken during a short write freeze.

## The order

### Before the day (repeatable, no effect on production)

1. **Server ready.** `bootstrap.sh` (platform), then
   `migration-package/deploy.sh --supabase-host supabase.chefelisha.cc --web-host www.chefelisha.cc --web-host chefelisha.cc --realtime`
   with the real R2 settings (`MYFOOD_R2_*`). It must end with *MY FOOD … is running*.
2. **Rehearsal with real data.** On the Mac: `backup-production.sh`, then
   `restore-and-reconcile.sh` (writes the backup's fingerprint). Copy the dump, `.sha256` and
   `.fingerprint.json` to the server and run `deploy.sh … --restore <dump> --pin-pepper-file <file>`.
   It must print **RECONCILED**. Sign in on a spare browser through the server address
   (hosts-file entry, no DNS change) as the owner and as a till PIN; open the kitchen screen.
3. **Photos.** `backup-photos.mjs` then `upload-photos.mjs` against the server's Storage:
   *330/330 verified by retrieval*. Photos change rarely; repeat in step 4 only if a product photo
   changed since.

### The window (≈10 minutes, outside service; business day ends 04:00 Accra)

4. **Freeze writes on Supabase** (needs explicit approval at the time):
   `alter role rp_api nologin; select pg_terminate_backend(pid) from pg_stat_activity where usename = 'rp_api';`
   The web POS then refuses changes ("try again"); nothing is half-written, every order is either in
   or not. (Undo: `alter role rp_api login;`.)
5. **Final backup → reconcile → restore**: steps 2's commands again with the new dump. Must print
   **RECONCILED** on the Mac and on the server.
6. **Auth delta, immediately before switching.** Paired tills refresh their session with Supabase
   about hourly; one that refreshes between step 5 and step 7 holds a token the server does not
   have and would ask to be paired again. Re-copy only `auth.sessions` and `auth.refresh_tokens`
   (seconds) right before step 7. A device that still drops to the pairing screen is re-paired in
   a minute (Devices & printing, *Enter code from device*).
7. **Switch.** In Cloudflare DNS, point `www.chefelisha.cc` and `chefelisha.cc` at the server
   (remove the Worker custom domains first). Devices keep their sign-in: the web app stores it
   under a fixed key (`rp.session`), not one derived from the Supabase address.
8. **Check**: `/health/ready` ready on both names; owner signs in; one till signs in with a PIN
   and opens an order; the kitchen screen receives it; MY FOOD Printing 1.1.2 prints (update the
   desktop apps' cloud address to the same name — it is already www.chefelisha.cc).

### After

9. Keep Supabase running and frozen (rp_api NOLOGIN) for at least two weeks. Do not cancel it.
10. Server backups: the platform's `backup.sh` (nightly + off-site R2) — check the first one restores.

## Rollback

Until step 7 nothing changed for the restaurant: `alter role rp_api login;` on Supabase and carry on.
After step 7: point DNS back at the Cloudflare Worker (it still talks to Supabase), then re-enable
`rp_api`. Orders taken on the server in between would have to be re-entered — which is why step 8
is done within minutes and the window is outside service.

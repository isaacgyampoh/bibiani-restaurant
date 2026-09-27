# MY FOOD — release checklist

**Rule: never deploy production before CI has finished successfully on the exact commit being deployed.**

```
Change → Typecheck → Lint → Automated tests → Browser tests → Build → push → CI PASS → Production deployment
```

`pnpm release` enforces the last part. It runs `scripts/deploy/require-ci-green.mjs` first, which **refuses** to deploy when:
- there are uncommitted changes;
- the commit is not the pushed `origin/main`;
- CI for that commit has not started, is still running, or did not succeed.

Check without deploying: `pnpm release:check`.

## Steps

1. `pnpm typecheck` and `pnpm lint`.
2. `pnpm test`: all automated tests, including hub sync, offline PINs, hub HTTP and hub printing.
3. `pnpm db:check`.
4. Browser tests:
   - `pnpm hub:e2e`: the in-store hub, local;
   - if there are database changes: push migrations to **staging**, run `node scripts/deploy/stamp-schema-version.mjs`, then `pnpm staging:deploy` and `pnpm staging:e2e`.
5. `pnpm build`.
6. Commit and push to `main`. **Wait for CI to pass** (GitHub → Actions → CI).
7. Production database, only if there are new migrations:
   - `supabase db push` with the production database URL, after a dry run;
   - migrations must be additive.
8. `pnpm release`. This refuses if step 6 is not green.
9. Post-deploy:
   - `/health/ready` shows the new release and schema;
   - the environment verifier passes;
   - the read-only production sweep (`e2e/zz-qa-prod-readonly.spec.ts`) passes.

## Windows hub installer

- **Production:** built only by GitHub Actions → **MY FOOD Hub (Windows installer)**. That uses the production channel, which refuses non-production values, and checks the result for staging values.
- **Test installers:** built with `pnpm --filter @rp/desktop dist:win:test`. They are named **MY FOOD Hub (TEST)**, use their own data folder, and are never given to the restaurant.

## Record of past incident

On 2026-09-26, release `dfa4cc7` was deployed before its CI run finished. CI then failed because `pnpm build` tried to build the desktop installer. The deployed code was not affected. The fix `a748f91` touched only desktop build scripts, and CI passed on it. The guard above was added so this cannot happen by accident again.

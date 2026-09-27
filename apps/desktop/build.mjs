#!/usr/bin/env node
/**
 * Builds the MY FOOD Hub desktop app into ./app and writes the installer settings for its channel.
 *   node build.mjs --channel production [--env .env.production] [--cloud https://bibiani-restaurant.vercel.app]
 *   node build.mjs --channel test --env .env.staging --cloud https://restaurant-management-staging.vercel.app
 *
 * production: must use the production Supabase project, and the cloud address must report itself as
 *   production (checked over the network). Installer: "MY-FOOD-Hub-Setup-<version>-production.exe".
 * test: named "MY FOOD Hub (TEST)" everywhere, with its own app id and data folder, so it can never
 *   be mistaken for, or mix data with, the production hub.
 * Only PUBLIC values are embedded (Supabase URL and anon key, the cloud address). The hub's own
 * secrets are generated on the restaurant PC at first start and kept in the Windows key store.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** The production Supabase project (public project reference, part of every public URL). */
const PRODUCTION_SUPABASE_REF = 'lgoirbfyspuflqekrcgp';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const channel = arg('channel', null);
if (channel !== 'production' && channel !== 'test')
  throw new Error('Choose the channel explicitly: --channel production, or --channel test');
const envFile = resolve(root, arg('env', '.env.production'));
const cloudUrl = arg('cloud', 'https://bibiani-restaurant.vercel.app').replace(/\/$/, '');
const env = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, 'utf8')
        .split('\n')
        .filter((l) => /^VITE_[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
    )
  : {};
if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY)
  throw new Error(`${envFile} needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY`);

const supabaseHost = new URL(env.VITE_SUPABASE_URL).host;
if (channel === 'production') {
  if (supabaseHost !== `${PRODUCTION_SUPABASE_REF}.supabase.co`)
    throw new Error(`A production hub must use the production Supabase project, not ${supabaseHost}`);
  if (!cloudUrl.startsWith('https://')) throw new Error('A production hub must talk to the cloud over https');
  const health = await fetch(`${cloudUrl}/health/ready`, { signal: AbortSignal.timeout(20_000) })
    .then((r) => r.json())
    .catch((e) => {
      throw new Error(`Cannot reach ${cloudUrl}/health/ready to confirm it is production: ${e.message}`);
    });
  if (health.environment !== 'production')
    throw new Error(`${cloudUrl} reports environment "${health.environment}", not production`);
} else if (supabaseHost === `${PRODUCTION_SUPABASE_REF}.supabase.co`) {
  throw new Error('A test hub must not use the production Supabase project');
}

const app = join(here, 'app');
rmSync(app, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

// 1. The web app (same build as the cloud; the hub marks its pages at serve time).
const envDir = mkdtempSync(join(tmpdir(), 'desktop-web-env-'));
writeFileSync(
  join(envDir, '.env'),
  `VITE_SUPABASE_URL=${env.VITE_SUPABASE_URL}\nVITE_SUPABASE_ANON_KEY=${env.VITE_SUPABASE_ANON_KEY}\nVITE_API_URL=\n`,
);
execFileSync(
  'pnpm',
  ['--filter', '@rp/web', 'exec', 'vite', 'build', '--outDir', join(app, 'web'), '--emptyOutDir'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_ENV_DIR: envDir },
    shell: process.platform === 'win32', // pnpm is a .cmd on Windows
  },
);
rmSync(envDir, { recursive: true, force: true });

// 2. Database migrations (applied incrementally on the restaurant PC).
cpSync(join(root, 'supabase/migrations'), join(app, 'migrations'), { recursive: true });

// 3. The main process with the whole hub bundled in. PGlite stays a real package (it loads its
//    WebAssembly and data files from disk).
await build({
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(app, 'main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', '@electric-sql/pglite'],
  define: {
    'process.env.MYFOOD_CLOUD_URL': JSON.stringify(cloudUrl),
    'process.env.MYFOOD_SUPABASE_URL': JSON.stringify(env.VITE_SUPABASE_URL),
    'process.env.MYFOOD_SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_ANON_KEY),
    'process.env.MYFOOD_CHANNEL': JSON.stringify(channel),
  },
  logLevel: 'warning',
});
// The pnpm symlink of the hub package's dependency (dereferenced on copy).
const pglite = join(root, 'packages/hub/node_modules/@electric-sql/pglite');
cpSync(pglite, join(app, 'node_modules/@electric-sql/pglite'), { recursive: true, dereference: true });
const pgliteVersion = JSON.parse(readFileSync(join(pglite, 'package.json'), 'utf8')).version;
cpSync(join(root, 'apps/web/public/logo-512.png'), join(app, 'icon.png'));

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const production = channel === 'production';
const productName = production ? 'MY FOOD Hub' : 'MY FOOD Hub (TEST)';
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify(
    {
      // The name decides the data folder (%APPDATA%\\<name>): test and production never share data.
      name: production ? 'myfood-hub' : 'myfood-hub-test',
      productName,
      version: pkg.version,
      main: 'main.cjs',
      author: pkg.author,
      description: pkg.description,
      // Declared so the installer keeps it (everything else is bundled into main.cjs).
      dependencies: { '@electric-sql/pglite': pgliteVersion },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(app, 'build-info.json'),
  JSON.stringify({ channel, cloudUrl, supabaseHost, version: pkg.version }),
);

// Installer settings for this channel (Windows only).
writeFileSync(
  join(here, 'electron-builder.generated.json'),
  JSON.stringify(
    {
      appId: production ? 'com.myfood.hub' : 'com.myfood.hub.test',
      productName,
      artifactName: production
        ? 'MY-FOOD-Hub-Setup-${version}-production.${ext}'
        : 'MY-FOOD-Hub-TEST-Setup-${version}.${ext}',
      directories: { app: 'app', output: 'release' },
      files: ['**/*'],
      asar: true,
      asarUnpack: ['node_modules/@electric-sql/pglite/**'],
      win: { target: 'nsis', icon: 'app/icon.png' },
      nsis: {
        oneClick: false,
        perMachine: true,
        allowToChangeInstallationDirectory: false,
        createDesktopShortcut: 'always',
        shortcutName: productName,
      },
      // Updates: only from releases published by the production workflow (none yet).
      publish: production
        ? { provider: 'github', owner: 'isaacgyampoh', repo: 'bibiani-restaurant', releaseType: 'release' }
        : null,
    },
    null,
    2,
  ),
);
console.log(
  `Built ${productName} ${pkg.version} [${channel}] into ${app} (cloud ${cloudUrl}, ${supabaseHost})`,
);

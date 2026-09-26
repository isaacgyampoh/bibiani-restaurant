#!/usr/bin/env node
/**
 * Builds the MY FOOD Hub desktop app into ./app (then packaged by electron-builder).
 *   node build.mjs [env-file] [cloud-url]
 * Defaults: ../../.env.production and https://bibiani-restaurant.vercel.app.
 * Only PUBLIC values are embedded (Supabase URL and anon key, the cloud address). The hub's own
 * secrets are generated on the restaurant PC at first start and kept in the Windows key store.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const envFile = resolve(root, process.argv[2] ?? '.env.production');
const cloudUrl = process.argv[3] ?? 'https://bibiani-restaurant.vercel.app';
const env = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, 'utf8')
        .split('\n')
        .filter((l) => /^VITE_[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    )
  : {};
if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY)
  throw new Error(`${envFile} needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY`);

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
  },
  logLevel: 'warning',
});
// The pnpm symlink of the hub package's dependency (dereferenced on copy).
const pglite = join(root, 'packages/hub/node_modules/@electric-sql/pglite');
cpSync(pglite, join(app, 'node_modules/@electric-sql/pglite'), { recursive: true, dereference: true });
const pgliteVersion = JSON.parse(readFileSync(join(pglite, 'package.json'), 'utf8')).version;
cpSync(join(root, 'apps/web/public/logo-512.png'), join(app, 'icon.png'));

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify(
    {
      name: 'myfood-hub',
      productName: 'MY FOOD Hub',
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
console.log(`Built MY FOOD Hub ${pkg.version} into ${app} (cloud ${cloudUrl})`);

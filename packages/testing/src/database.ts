import { createPostgresDatabase } from '@rp/infrastructure';
import { createPgliteDatabase, type TestDatabase } from './pglite';

/**
 * TEST_TARGET=hosted runs the same suites against the hosted Supabase DEV
 * database (real connections, real pooler, real concurrency). Default: PGlite.
 */
export const HOSTED = process.env.TEST_TARGET === 'hosted';

const ALLOWED_REF = process.env.TEST_ALLOWED_PROJECT_REF ?? 'nkijnjovztglmwxoemqg';

export async function createTestDatabase(
  options: { fresh?: boolean; maxConnections?: number } = {},
): Promise<TestDatabase> {
  if (!HOSTED) return createPgliteDatabase(options);
  const url = process.env.TEST_DATABASE_URL;
  if (!url)
    throw new Error('TEST_TARGET=hosted needs TEST_DATABASE_URL (see scripts/dev/configure-dev-logins.sh)');
  // Guard rail: hosted tests write data. They may only ever touch the DEV project.
  if (!url.includes(`.${ALLOWED_REF}:`))
    throw new Error(`Refusing to run tests against a project other than ${ALLOWED_REF}`);
  const db = createPostgresDatabase(url, { max: options.maxConnections ?? 10 });
  return { ...db, target: 'hosted' };
}

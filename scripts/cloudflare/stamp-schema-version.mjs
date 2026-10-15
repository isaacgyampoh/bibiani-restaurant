// Writes the newest migration version into the API source before building.
import { readdirSync, writeFileSync } from 'node:fs';

const latest = readdirSync('supabase/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .at(-1)
  .slice(0, 14);
writeFileSync(
  'apps/api/src/schema-version.ts',
  `// The newest migration this build of the API was written against. Updated by scripts/deploy/stamp-schema-version.mjs\n// (run in the build) so a deployment cannot report "ready" against an older database schema.\nexport const EXPECTED_SCHEMA_VERSION = '${latest}';\n`,
);
console.log(`schema version stamped: ${latest}`);

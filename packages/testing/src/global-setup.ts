import { buildTemplate } from './pglite';

// Vitest global setup: migrate once per run, before any test file starts.
export default async function setup() {
  await buildTemplate();
}

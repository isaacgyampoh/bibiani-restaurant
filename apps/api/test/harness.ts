import { ApiClient } from '@rp/client-core';
import { JwksTokenVerifier } from '@rp/infrastructure';
import {
  createTestApp,
  createTestDatabase,
  type RestaurantFixture,
  seedRestaurant,
  type TestApp,
  type TestDatabase,
} from '@rp/testing';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHttpApp } from '../src';

export const SUPABASE_URL = 'https://test-project.supabase.co';
export const MONITOR_TOKEN = 'monitor-token-for-tests-0123456789abcdef';

export interface HttpHarness {
  db: TestDatabase;
  f: RestaurantFixture;
  t: TestApp;
  http: ReturnType<typeof createHttpApp>;
  token(sub: string, overrides?: { issuer?: string; expiresIn?: string }): Promise<string>;
  client(sub: string, opts?: { deviceId?: string; fetch?: typeof fetch }): ApiClient;
  /** fetch that goes straight into the Hono app (no network). */
  fetch: typeof fetch;
  logs: { event: string; fields: Record<string, unknown> }[];
}

export async function createHttpHarness(): Promise<HttpHarness> {
  const db = await createTestDatabase();
  const f = await seedRestaurant(db, { slug: 'http', orderNumberStart: 5001 });
  const t = createTestApp(db);
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256' };
  const verifier = new JwksTokenVerifier(SUPABASE_URL, createLocalJWKSet({ keys: [jwk] }));
  const logs: HttpHarness['logs'] = [];
  const logger = {
    info: (event: string, fields = {}) => logs.push({ event, fields }),
    warn: (event: string, fields = {}) => logs.push({ event, fields }),
    error: (event: string, fields = {}) => logs.push({ event, fields }),
  };
  const http = createHttpApp({
    app: t.app,
    verifier,
    resolver: t.resolver,
    logger,
    monitorToken: MONITOR_TOKEN,
    ops: {
      record: async (kind) => {
        await db.query('select app.ops_record($1)', [kind]);
      },
      health: async () => (await db.query<{ h: unknown }>('select app.ops_health() as h'))[0]?.h,
    },
  });
  const token = (sub: string, o: { issuer?: string; expiresIn?: string } = {}) =>
    new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(sub)
      .setIssuer(o.issuer ?? `${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(o.expiresIn ?? '1h')
      .sign(privateKey);
  const appFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    http.fetch(new Request(input, init))) as typeof fetch;
  return {
    db,
    f,
    t,
    http,
    token,
    fetch: appFetch,
    logs,
    client: (sub, opts = {}) =>
      new ApiClient({
        baseUrl: 'http://api.test',
        getAccessToken: () => token(sub),
        fetch: opts.fetch ?? appFetch,
        deviceId: opts.deviceId ?? null,
      }),
  };
}

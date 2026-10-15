import type { ExecutionContext } from 'hono';
import { compose } from './composition';

/**
 * Cloudflare Workers entry (production host since 2026-10-15; Vercel disabled the deployments).
 * The web app is served from Workers Static Assets; only /v1/* and /health* reach this code.
 *
 * A Worker cannot reuse a database connection across requests, so each request composes the app
 * with its own single connection (cheap: no I/O happens until a query runs) and closes it after
 * the response has been sent. Same Supabase database and data as before.
 */
interface Env {
  /** Optional Cloudflare Hyperdrive binding (pooled connections); DATABASE_URL is used without it. */
  HYPERDRIVE?: { connectionString: string };
  [name: string]: unknown;
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const vars: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) if (typeof value === 'string') vars[name] = value;
    if (env.HYPERDRIVE) vars.DATABASE_URL = env.HYPERDRIVE.connectionString;
    vars.DB_POOL_MAX = '1';
    const { http, db } = compose(vars);
    try {
      const response = await http.fetch(request, env, ctx);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(SECURITY_HEADERS))
        if (!headers.has(name)) headers.set(name, value);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } finally {
      ctx.waitUntil(db.close().catch(() => undefined));
    }
  },
};

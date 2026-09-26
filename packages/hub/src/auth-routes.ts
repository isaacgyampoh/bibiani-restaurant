import type { AuthSession } from '@rp/application';
import { Hono } from 'hono';
import type { HubAuthDirectory } from './local-auth';

/**
 * The few Supabase Auth (GoTrue) endpoints the web app's supabase-js client calls, answered by the
 * hub, so the SAME web build runs on tills, kitchen screens and the customer display connected to
 * the hub. Only what the web app uses: refresh, password sign-in (paired devices), user, logout.
 * Staff never have passwords on the hub: they unlock tills with their PIN.
 */
export function hubAuthRoutes(auth: HubAuthDirectory): Hono {
  const app = new Hono();
  const invalid = (description: string) => ({
    error: 'invalid_grant',
    error_description: description,
    code: 'invalid_credentials',
    msg: description,
  });

  const sessionBody = async (session: AuthSession, userId: string) => ({
    access_token: session.accessToken,
    token_type: 'bearer',
    expires_in: session.expiresAt - Math.floor(Date.now() / 1000),
    expires_at: session.expiresAt,
    refresh_token: session.refreshToken,
    user: await userBody(userId),
  });

  const userBody = async (id: string) => ({
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email: (await auth.getUser(id)).email ?? undefined,
    app_metadata: { provider: 'myfood-hub' },
    user_metadata: {},
    created_at: new Date(0).toISOString(),
  });

  app.post('/auth/v1/token', async (c) => {
    const grant = c.req.query('grant_type');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (grant === 'refresh_token' && typeof body.refresh_token === 'string') {
      try {
        const session = await auth.refresh(body.refresh_token);
        return c.json(await sessionBody(session, session.userId));
      } catch {
        return c.json(
          { ...invalid('Invalid Refresh Token: Refresh Token Not Found'), code: 'refresh_token_not_found' },
          400,
        );
      }
    }
    if (grant === 'password' && typeof body.email === 'string' && typeof body.password === 'string') {
      try {
        const session = await auth.signIn(body.email, body.password);
        const userId = (await auth.verifier().verify(session.accessToken)).authUserId;
        return c.json(await sessionBody(session, userId));
      } catch {
        return c.json(invalid('Invalid login credentials'), 400);
      }
    }
    return c.json(invalid('Unsupported grant type'), 400);
  });

  app.get('/auth/v1/user', async (c) => {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer /, '');
    try {
      const { authUserId } = await auth.verifier().verify(token);
      return c.json(await userBody(authUserId));
    } catch {
      return c.json({ code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }, 401);
    }
  });

  app.post('/auth/v1/logout', (c) => c.body(null, 204));

  // Password recovery and email changes are cloud features.
  app.all('/auth/v1/*', (c) =>
    c.json({ code: 501, error_code: 'not_available_on_hub', msg: 'This needs the MY FOOD cloud' }, 501),
  );
  return app;
}

import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

export interface VerifiedToken {
  authUserId: string;
  /** How the session was established (Supabase `amr`): password, otp (PIN session), recovery (email link). */
  authMethods: string[];
  /** The sign-in session (Supabase `session_id`); binds a PIN session to its device. */
  sessionId?: string | null;
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid access token: ${reason}`);
    this.name = 'InvalidTokenError';
  }
}

/**
 * Verifies Supabase Auth access tokens locally.
 *  - Hosted Supabase: against the project's published asymmetric signing keys (JWKS).
 *  - Self-hosted Auth (the shared VPS platform signs with one secret per application): HS256 with
 *    that secret, when `jwtSecret` is given.
 * Each mode accepts only its own algorithms, so a token cannot choose how it is checked.
 */
export class JwksTokenVerifier implements AccessTokenVerifier {
  private readonly keys: JWTVerifyGetKey | Uint8Array;
  private readonly algorithms: string[];
  private readonly issuer: string;

  constructor(
    supabaseUrl: string,
    keys?: JWTVerifyGetKey,
    options: { jwtSecret?: string; issuer?: string } = {},
  ) {
    const base = supabaseUrl.replace(/\/+$/, '');
    this.issuer = options.issuer ?? `${base}/auth/v1`;
    if (options.jwtSecret) {
      if (options.jwtSecret.length < 32) throw new Error('AUTH_JWT_SECRET must be at least 32 characters');
      this.keys = new TextEncoder().encode(options.jwtSecret);
      this.algorithms = ['HS256'];
    } else {
      this.keys = keys ?? createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`));
      this.algorithms = ['ES256', 'RS256', 'EdDSA'];
    }
  }

  async verify(token: string): Promise<VerifiedToken> {
    try {
      const { payload } = await jwtVerify(token, this.keys as JWTVerifyGetKey, {
        issuer: this.issuer,
        audience: 'authenticated',
        algorithms: this.algorithms,
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0)
        throw new InvalidTokenError('missing subject');
      const amr = Array.isArray(payload.amr) ? (payload.amr as { method?: unknown }[]) : [];
      return {
        authUserId: payload.sub,
        authMethods: amr.map((a) => String(a?.method ?? '')).filter(Boolean),
        sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
      };
    } catch (error) {
      if (error instanceof InvalidTokenError) throw error;
      throw new InvalidTokenError((error as Error).message);
    }
  }
}

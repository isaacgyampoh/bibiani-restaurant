import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

export interface VerifiedToken {
  authUserId: string;
  /** How the session was established (Supabase `amr`): password, otp (PIN session), recovery (email link). */
  authMethods: string[];
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
 * Verifies Supabase Auth access tokens locally against the project's published
 * signing keys (asymmetric JWT signing keys; no shared secret needed).
 */
export class JwksTokenVerifier implements AccessTokenVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly issuer: string;

  constructor(supabaseUrl: string, keys?: JWTVerifyGetKey) {
    const base = supabaseUrl.replace(/\/+$/, '');
    this.issuer = `${base}/auth/v1`;
    this.keys = keys ?? createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`));
  }

  async verify(token: string): Promise<VerifiedToken> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        audience: 'authenticated',
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0)
        throw new InvalidTokenError('missing subject');
      const amr = Array.isArray(payload.amr) ? (payload.amr as { method?: unknown }[]) : [];
      return {
        authUserId: payload.sub,
        authMethods: amr.map((a) => String(a?.method ?? '')).filter(Boolean),
      };
    } catch (error) {
      if (error instanceof InvalidTokenError) throw error;
      throw new InvalidTokenError((error as Error).message);
    }
  }
}

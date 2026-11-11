import { JwksTokenVerifier } from '@rp/infrastructure';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

/**
 * The API checks Auth tokens two ways: hosted Supabase publishes asymmetric keys (JWKS); the
 * self-hosted Auth on the VPS signs with one secret per application (HS256). Each mode must accept
 * only its own tokens, so a token can never pick a weaker way of being checked.
 */
const BASE = 'https://api.example.test';
const SECRET = 'a-per-application-secret-of-at-least-32-chars';
const claims = { aud: 'authenticated', amr: [{ method: 'password' }], session_id: 's-1' };

const hs256 = (secret: string, issuer = `${BASE}/auth/v1`) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuer(issuer)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));

describe('token verifier modes', () => {
  it('shared-secret mode: accepts a token signed with the secret', async () => {
    const v = new JwksTokenVerifier(BASE, undefined, { jwtSecret: SECRET });
    await expect(v.verify(await hs256(SECRET))).resolves.toMatchObject({
      authUserId: 'user-1',
      authMethods: ['password'],
      sessionId: 's-1',
    });
  });

  it('shared-secret mode: refuses a wrong secret and a foreign issuer', async () => {
    const v = new JwksTokenVerifier(BASE, undefined, { jwtSecret: SECRET });
    await expect(v.verify(await hs256('another-application-secret-32-chars-long'))).rejects.toThrow(
      /Invalid access token/,
    );
    await expect(v.verify(await hs256(SECRET, 'https://other.example/auth/v1'))).rejects.toThrow(
      /Invalid access token/,
    );
  });

  it('public-key mode refuses an HS256 token (no algorithm switching)', async () => {
    const { publicKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'k1' };
    const v = new JwksTokenVerifier(BASE, async () => {
      const { importJWK } = await import('jose');
      return importJWK(jwk, 'ES256');
    });
    await expect(v.verify(await hs256(SECRET))).rejects.toThrow(/Invalid access token/);
  });

  it('a short secret is refused at start-up', () => {
    expect(() => new JwksTokenVerifier(BASE, undefined, { jwtSecret: 'short' })).toThrow(/32 characters/);
  });
});

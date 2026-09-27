import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { AuthDirectory, AuthSession } from '@rp/application';
import { DomainError } from '@rp/domain';
import type { AccessTokenVerifier, Database, VerifiedToken } from '@rp/infrastructure';
import { jwtVerify, SignJWT } from 'jose';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const ACCESS_SECONDS = 60 * 60;
const REFRESH_DAYS = 30;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const LOCAL_AUTH_SQL = `
create table if not exists hub.credentials (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  email          text not null unique,
  password_hash  text not null
);
create table if not exists hub.refresh_tokens (
  token_hash  text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  method      text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz
);
`;

/**
 * Logins on the hub for devices paired to it (and PIN sessions on its tills). The cloud's Supabase
 * Auth is not reachable offline, so the hub issues its own short-lived signed tokens with the same
 * claims the API reads (sub, amr). Refresh tokens rotate and are stored only as hashes; device
 * passwords only as scrypt hashes. Nothing here is ever sent to the cloud.
 */
export class HubAuthDirectory implements AuthDirectory {
  private readonly key: Uint8Array;

  constructor(
    private readonly db: Database,
    jwtSecret: string,
  ) {
    if (jwtSecret.length < 32) throw new Error('The hub token secret must be at least 32 characters');
    this.key = new TextEncoder().encode(jwtSecret);
  }

  async createUser(input: { email: string; password: string }) {
    const email = input.email.toLowerCase();
    const [taken] = await this.db.query('select 1 from hub.credentials where email = $1', [email]);
    if (taken) throw new DomainError('VALIDATION_FAILED', 'An account with this email already exists');
    const id = randomUUID();
    await this.db.transaction(async (sql) => {
      await sql.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
      await sql.query('insert into hub.credentials (user_id, email, password_hash) values ($1, $2, $3)', [
        id,
        email,
        await hashPassword(input.password),
      ]);
    });
    return { id };
  }

  async deleteUser(id: string) {
    await this.db.query('delete from auth.users where id = $1', [id]);
  }

  async updatePassword(id: string, password: string) {
    await this.db.query('update hub.credentials set password_hash = $2 where user_id = $1', [
      id,
      await hashPassword(password),
    ]);
  }

  async getUser(id: string) {
    const [r] = await this.db.query<{ email: string | null }>('select email from auth.users where id = $1', [
      id,
    ]);
    return { email: r?.email ?? null };
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    const [r] = await this.db.query<{ user_id: string; password_hash: string }>(
      'select user_id, password_hash from hub.credentials where email = $1',
      [email.toLowerCase()],
    );
    if (!r || !(await verifyPassword(password, r.password_hash)))
      throw new DomainError('UNAUTHENTICATED', 'Sign-in failed');
    return this.issue(r.user_id, 'password');
  }

  /** A PIN session on a till (the API treats amr "otp" as a PIN session). */
  async createSession(userId: string): Promise<AuthSession> {
    return this.issue(userId, 'otp');
  }

  async sendRecoveryEmail(): Promise<void> {
    throw new DomainError(
      'UNAVAILABLE',
      'Recovery emails are sent from the MY FOOD cloud, not the in-store hub',
    );
  }

  /** Exchanges a refresh token for a new session; the old refresh token stops working (rotation). */
  async refresh(refreshToken: string): Promise<AuthSession & { userId: string }> {
    const hash = sha256(refreshToken);
    const [r] = await this.db.query<{ user_id: string; method: string }>(
      `update hub.refresh_tokens set used_at = now()
        where token_hash = $1 and used_at is null and expires_at > now()
        returning user_id, method`,
      [hash],
    );
    if (!r) throw new DomainError('UNAUTHENTICATED', 'Session expired. Sign in again.');
    return { ...(await this.issue(r.user_id, r.method)), userId: r.user_id };
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.db.query('update hub.refresh_tokens set used_at = now() where token_hash = $1', [
      sha256(refreshToken),
    ]);
  }

  private async issue(userId: string, method: string): Promise<AuthSession> {
    const now = Math.floor(Date.now() / 1000);
    const sessionId = randomUUID();
    const accessToken = await new SignJWT({
      role: 'authenticated',
      amr: [{ method, timestamp: now }],
      session_id: sessionId,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setAudience('authenticated')
      .setIssuer('myfood-hub')
      .setIssuedAt(now)
      .setExpirationTime(now + ACCESS_SECONDS)
      .sign(this.key);
    const refreshToken = randomBytes(32).toString('base64url');
    await this.db.query(
      `insert into hub.refresh_tokens (token_hash, user_id, method, expires_at)
       values ($1, $2, $3, now() + interval '${REFRESH_DAYS} days')`,
      [sha256(refreshToken), userId, method],
    );
    // Housekeeping: used or expired refresh tokens are kept one day, then removed.
    await this.db.query(
      `delete from hub.refresh_tokens where (used_at is not null and used_at < now() - interval '1 day') or expires_at < now()`,
    );
    return { accessToken, refreshToken, expiresAt: now + ACCESS_SECONDS, sessionId };
  }

  verifier(): AccessTokenVerifier {
    return {
      verify: async (token: string): Promise<VerifiedToken> => {
        try {
          const { payload } = await jwtVerify(token, this.key, {
            audience: 'authenticated',
            issuer: 'myfood-hub',
          });
          const amr = (payload.amr as { method?: string }[] | undefined) ?? [];
          return {
            authUserId: String(payload.sub),
            authMethods: amr.map((m) => String(m.method)),
            sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
          };
        } catch {
          throw new DomainError('UNAUTHENTICATED', 'Your session has expired. Sign in again.');
        }
      },
    };
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

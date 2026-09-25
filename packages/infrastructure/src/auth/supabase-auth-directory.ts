import type { AuthDirectory, AuthSession } from '@rp/application';
import { DomainError } from '@rp/domain';
import { InfrastructureError } from '../postgres/util';

/**
 * Supabase Auth admin operations over HTTPS. Holds the project's SECRET key, so
 * it must only ever be constructed in server processes (API, platform scripts).
 */
export class SupabaseAuthDirectory implements AuthDirectory {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly secretKey: string,
    private readonly anonKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
  }

  private headers(key: string): Record<string, string> {
    const h: Record<string, string> = { apikey: key, 'content-type': 'application/json' };
    // Legacy JWT keys also go in Authorization; new sb_secret_/sb_publishable_ keys use apikey only.
    if (key.startsWith('eyJ')) h.authorization = `Bearer ${key}`;
    return h;
  }

  private async call<T>(path: string, init: RequestInit, key: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        headers: { ...this.headers(key), ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (cause) {
      throw new InfrastructureError('Auth service unreachable', true, { cause });
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message = String(
        body.msg ?? body.message ?? body.error_description ?? body.error ?? res.statusText,
      );
      const code = String(body.error_code ?? '');
      // Rejections a person can fix: never report these as "try again".
      if (code === 'weak_password') {
        throw new DomainError(
          'VALIDATION_FAILED',
          'Choose a different password: this one is too weak or has appeared in a known data breach',
        );
      }
      if (code === 'email_address_invalid' || code === 'validation_failed') {
        throw new DomainError('VALIDATION_FAILED', 'That email address is not valid');
      }
      if (code === 'email_exists' || (res.status === 422 && /already|registered|exists/i.test(message))) {
        throw new DomainError('VALIDATION_FAILED', 'An account with this email already exists');
      }
      if (res.status === 400 && path.startsWith('/token')) {
        throw new DomainError('UNAUTHENTICATED', 'Sign-in failed');
      }
      throw new InfrastructureError(`Auth service error ${res.status}: ${message}`, res.status >= 500);
    }
    return body as T;
  }

  async createUser(input: { email: string; password: string; metadata?: Record<string, unknown> }) {
    const user = await this.call<{ id: string }>(
      '/admin/users',
      {
        method: 'POST',
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          email_confirm: true,
          app_metadata: input.metadata ?? {},
        }),
      },
      this.secretKey,
    );
    return { id: user.id };
  }

  async deleteUser(id: string) {
    await this.call(`/admin/users/${id}`, { method: 'DELETE' }, this.secretKey);
  }

  async updatePassword(id: string, password: string) {
    await this.call(
      `/admin/users/${id}`,
      { method: 'PUT', body: JSON.stringify({ password }) },
      this.secretKey,
    );
  }

  /**
   * A session for an existing user without their password: an admin-generated one-time magic-link
   * token, verified immediately server-side. Nothing is emailed. Used only after a PIN was checked
   * on a registered till.
   */
  async createSession(userId: string): Promise<AuthSession> {
    const user = await this.call<{ email?: string }>(
      `/admin/users/${userId}`,
      { method: 'GET' },
      this.secretKey,
    );
    if (!user.email) throw new InfrastructureError('Staff login has no email', false);
    const link = await this.call<{ hashed_token?: string; properties?: { hashed_token?: string } }>(
      '/admin/generate_link',
      { method: 'POST', body: JSON.stringify({ type: 'magiclink', email: user.email }) },
      this.secretKey,
    );
    const tokenHash = link.properties?.hashed_token ?? link.hashed_token;
    if (!tokenHash) throw new InfrastructureError('Auth service did not return a sign-in token', true);
    const s = await this.call<{ access_token: string; refresh_token: string; expires_at: number }>(
      '/verify',
      { method: 'POST', body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }) },
      this.anonKey,
    );
    return { accessToken: s.access_token, refreshToken: s.refresh_token, expiresAt: s.expires_at };
  }

  async sendRecoveryEmail(email: string, redirectTo: string): Promise<void> {
    await this.call(
      `/recover?redirect_to=${encodeURIComponent(redirectTo)}`,
      { method: 'POST', body: JSON.stringify({ email }) },
      this.anonKey,
    );
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    const s = await this.call<{ access_token: string; refresh_token: string; expires_at: number }>(
      '/token?grant_type=password',
      { method: 'POST', body: JSON.stringify({ email, password }) },
      this.anonKey,
    );
    return { accessToken: s.access_token, refreshToken: s.refresh_token, expiresAt: s.expires_at };
  }
}

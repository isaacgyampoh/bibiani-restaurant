import type { ImageStore } from '@rp/application';
import { InfrastructureError } from '../postgres/util';

/**
 * Product photos in Supabase Storage (bucket `product-images`, public read). Holds the project's
 * SECRET key, so it must only ever be constructed in server processes.
 */
export class SupabaseImageStore implements ImageStore {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly secretKey: string,
    private readonly bucket = 'product-images',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `${supabaseUrl.replace(/\/+$/, '')}/storage/v1`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { apikey: this.secretKey, ...extra };
    // Legacy JWT keys also go in Authorization; new sb_secret_ keys use apikey only.
    if (this.secretKey.startsWith('eyJ')) h.authorization = `Bearer ${this.secretKey}`;
    return h;
  }

  async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/object/${this.bucket}/${path}`, {
      method: 'POST',
      headers: this.headers({
        'content-type': contentType,
        'cache-control': 'max-age=31536000',
        'x-upsert': 'false',
      }),
      body: bytes,
      signal: AbortSignal.timeout(20_000),
    }).catch((cause) => {
      throw new InfrastructureError('Photo storage unreachable', true, { cause });
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new InfrastructureError(
        `Photo could not be stored (${res.status}): ${detail}`,
        res.status >= 500,
      );
    }
  }

  async remove(path: string): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/object/${this.bucket}`, {
      method: 'DELETE',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prefixes: [path] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new InfrastructureError(`Photo could not be deleted (${res.status})`, true);
  }

  publicUrl(path: string): string {
    return `${this.base}/object/public/${this.bucket}/${path}`;
  }
}

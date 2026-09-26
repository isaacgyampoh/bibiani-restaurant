import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CloudPairingState {
  status: 'paired' | 'waiting' | 'error';
  code?: string;
  expiresAt?: string;
  message?: string;
}

/**
 * First start: the hub pairs with the MY FOOD cloud like any device. It shows a code; a manager
 * enters it in the back office (Devices & printing, on the HUB device, "Enter code from device").
 * The hub's own refresh token is then kept in `sessionFile` (mode 0600) and rotated by the token
 * source. Resolves once paired. Codes expire after 10 minutes; a new one is fetched automatically.
 */
export async function pairHubWithCloud(options: {
  cloudApiUrl: string;
  sessionFile: string;
  onState: (state: CloudPairingState) => void;
  fetch?: typeof fetch;
  pollMs?: number;
}): Promise<void> {
  const http = options.fetch ?? fetch;
  const post = async (path: string, body: unknown) => {
    const res = await http(`${options.cloudApiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as Record<string, any> | null;
    if (!res.ok)
      throw Object.assign(new Error(json?.error?.message ?? `HTTP ${res.status}`), {
        code: json?.error?.code,
      });
    return json!;
  };
  for (;;) {
    let request: { code: string; secret: string; expiresAt: string };
    try {
      request = (await post('/v1/devices/pairing-requests', {})) as typeof request;
    } catch (error) {
      options.onState({ status: 'error', message: `No connection to MY FOOD: ${(error as Error).message}` });
      await sleep(15_000);
      continue;
    }
    options.onState({ status: 'waiting', code: request.code, expiresAt: request.expiresAt });
    while (Date.now() < Date.parse(request.expiresAt)) {
      await sleep(options.pollMs ?? 3000);
      try {
        const result = await post('/v1/devices/pairing-requests/collect', { secret: request.secret });
        if (result.status !== 'paired') continue;
        if (result.device?.kind !== 'hub') {
          options.onState({
            status: 'error',
            message: `That code was used for ${result.device?.name ?? 'another device'}, not a hub. Enter it on the HUB device.`,
          });
          break;
        }
        mkdirSync(dirname(options.sessionFile), { recursive: true });
        writeFileSync(
          options.sessionFile,
          JSON.stringify({ refreshToken: result.session.refreshToken, savedAt: new Date().toISOString() }),
          { mode: 0o600 },
        );
        chmodSync(options.sessionFile, 0o600);
        options.onState({ status: 'paired' });
        return;
      } catch (error) {
        if ((error as { code?: string }).code === 'PAIRING_CODE_INVALID') break; // expired: new code
      }
    }
  }
}

export function isPaired(sessionFile: string): boolean {
  return existsSync(sessionFile);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

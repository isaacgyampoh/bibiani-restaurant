import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { Logger } from '@rp/application';
import { supabaseDeviceTokenSource } from '@rp/print-agent';
import { type CloudPairingState, isPaired, pairHubWithCloud } from './cloud-pairing';
import { createHub } from './server';

export interface HubSecrets {
  jwtSecret: string;
  pinPepper: string;
}

/** Where hub-only secrets live. The desktop app encrypts them with the OS key store. */
export interface SecretStore {
  load(): HubSecrets | null;
  save(secrets: HubSecrets): void;
}

/** Plain private file (mode 0600): used when running the hub as a Node process. */
export function fileSecretStore(dataDir: string): SecretStore {
  const file = join(dataDir, 'secrets.json');
  return {
    load: () => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as HubSecrets) : null),
    save: (secrets) => {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
      chmodSync(file, 0o600);
    },
  };
}

export interface RunHubOptions {
  dataDir: string;
  port: number;
  migrationsDir: string;
  webDist: string;
  cloudApiUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  secrets: SecretStore;
  logger: Logger;
  release: string;
}

/** Addresses tills, kitchen screens and the customer display use to reach the hub. */
export function lanAddresses(port: number): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a!.address}:${port}`);
}

/**
 * Starts the MY FOOD Hub: local database, API, web app for the restaurant network, print agent and
 * sync. On first start it also pairs itself with the cloud (the code shows in the hub window).
 */
export async function runHub(
  o: RunHubOptions,
): Promise<{ stop: () => void; url: string; needsCloudPairing: () => boolean }> {
  let secrets = o.secrets.load();
  if (!secrets) {
    secrets = {
      jwtSecret: randomBytes(48).toString('base64url'),
      pinPepper: randomBytes(48).toString('base64url'),
    };
    o.secrets.save(secrets);
  }
  const sessionFile = join(o.dataDir, 'cloud-session.json');
  let pairing: CloudPairingState | null = null;
  if (!isPaired(sessionFile)) {
    pairing = { status: 'waiting' };
    void pairHubWithCloud({
      cloudApiUrl: o.cloudApiUrl,
      sessionFile,
      onState: (state) => {
        pairing = state.status === 'paired' ? null : state;
        o.logger.info('hub.cloud_pairing', { status: state.status });
      },
    });
  }
  const cloudLogin = supabaseDeviceTokenSource(o.supabaseUrl, o.supabaseAnonKey, '', sessionFile);
  const hub = await createHub({
    dataDir: o.dataDir,
    migrationsDir: o.migrationsDir,
    webDist: o.webDist,
    cloudApiUrl: o.cloudApiUrl,
    supabaseUrl: o.supabaseUrl,
    secrets,
    cloudToken: async () => {
      if (!isPaired(sessionFile))
        throw new Error(
          'Not connected to MY FOOD yet: enter the code shown in the hub window in the back office',
        );
      try {
        return await cloudLogin();
      } catch (error) {
        throw new Error(
          /sign-in failed/i.test(String(error))
            ? 'The hub’s MY FOOD login was removed or has expired: pair the hub again in the back office'
            : String((error as Error).message ?? error),
        );
      }
    },
    logger: o.logger,
    release: o.release,
    port: o.port,
    describe: () => ({ cloudPairing: pairing, addresses: lanAddresses(o.port) }),
  });
  const server = serve({ fetch: hub.fetch, port: o.port, hostname: '0.0.0.0' });
  o.logger.info('hub.listening', { port: o.port, addresses: lanAddresses(o.port) });
  const stopHub = await hub.start();
  return {
    url: `http://127.0.0.1:${o.port}`,
    needsCloudPairing: () => pairing !== null,
    stop: () => {
      stopHub();
      server.close();
      void hub.db.close();
    },
  };
}

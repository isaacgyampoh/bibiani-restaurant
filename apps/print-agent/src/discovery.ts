import { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * Finds receipt printers on the restaurant network: every address of this PC's local networks
 * (the /24 around each of its IPv4 addresses) is tried on the raw printing port 9100. Only
 * printers (and the rare other device that listens on 9100) answer. Takes a few seconds.
 */
export function localSubnets(): { own: string; hosts: string[] }[] {
  const out: { own: string; hosts: string[] }[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        const base = a.address.split('.').slice(0, 3).join('.');
        if (out.some((s) => s.own.startsWith(`${base}.`))) continue;
        out.push({
          own: a.address,
          hosts: Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`).filter((h) => h !== a.address),
        });
      }
  return out;
}

export function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host, () => done(true));
  });
}

export async function scanHosts(
  hosts: string[],
  port = 9100,
  timeoutMs = 500,
  concurrency = 64,
): Promise<string[]> {
  const found: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++]!;
      if (await portOpen(host, port, timeoutMs)) found.push(host);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found.sort((a, b) => Number(a.split('.').pop()) - Number(b.split('.').pop()));
}

/** Network printers answering on port 9100, with the address to enter in MY FOOD. */
export async function discoverNetworkPrinters(): Promise<{ address: string; network: string }[]> {
  const results: { address: string; network: string }[] = [];
  for (const s of localSubnets()) {
    for (const host of await scanHosts(s.hosts)) results.push({ address: host, network: `${s.own}/24` });
  }
  return results;
}

/** Addresses that are almost always the router, not a printer (e.g. 192.168.0.1). */
export function looksLikeRouter(address: string): boolean {
  const host = address.split(':')[0] ?? '';
  return /^\d+\.\d+\.\d+\.(1|254)$/.test(host);
}

import { Socket } from 'node:net';

/**
 * Physical printer transport. Swap implementations (USB, Android built-in,
 * vendor SDK) without touching the agent loop or the order domain.
 */
export interface SendResult {
  ok: boolean;
  /** Bytes handed to the OS socket before failure. >0 means the printer may have printed. */
  bytesWritten: number;
  error?: string;
}

export interface PrinterDriver {
  send(bytes: Uint8Array): Promise<SendResult>;
  probe(): Promise<{ ok: boolean; error?: string }>;
}

export function parseAddress(address: string): { host: string; port: number } {
  const match = /^([^:]+)(?::(\d+))?$/.exec(address.trim());
  if (!match) throw new Error(`Invalid printer address: ${address}`);
  return { host: match[1]!, port: Number(match[2] ?? 9100) };
}

/**
 * Raw TCP (port 9100) ESC/POS. "ok" means the printer accepted every byte and
 * closed cleanly. That is the strongest confirmation these printers give; it
 * is not proof that paper came out, which is why the domain treats printing as
 * at-least-once with duplicate marking and the KDS shows tickets independently.
 */
export class NetworkEscPosDriver implements PrinterDriver {
  constructor(
    private readonly address: string,
    private readonly timeoutMs = 8000,
  ) {}

  send(bytes: Uint8Array): Promise<SendResult> {
    const { host, port } = parseAddress(this.address);
    return new Promise((resolve) => {
      const socket = new Socket();
      let written = 0;
      let settled = false;
      const done = (result: SendResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(this.timeoutMs, () =>
        done({ ok: false, bytesWritten: written, error: 'printer timeout' }),
      );
      socket.once('error', (e) => done({ ok: false, bytesWritten: written, error: e.message }));
      socket.connect(port, host, () => {
        written = bytes.length; // handed to the kernel from here on
        socket.end(bytes, () => {
          // All bytes flushed to the printer; wait for the peer to close or a short grace period.
          socket.once('close', (hadError) =>
            done(
              hadError
                ? { ok: false, bytesWritten: written, error: 'connection error' }
                : { ok: true, bytesWritten: written },
            ),
          );
          setTimeout(() => done({ ok: true, bytesWritten: written }), 1500).unref();
        });
      });
    });
  }

  probe(): Promise<{ ok: boolean; error?: string }> {
    const { host, port } = parseAddress(this.address);
    return new Promise((resolve) => {
      const socket = new Socket();
      const finish = (r: { ok: boolean; error?: string }) => {
        socket.destroy();
        resolve(r);
      };
      socket.setTimeout(3000, () => finish({ ok: false, error: 'printer timeout' }));
      socket.once('error', (e) => finish({ ok: false, error: e.message }));
      socket.connect(port, host, () => finish({ ok: true }));
    });
  }
}

import { createServer, type Server, type Socket } from 'node:net';

/** A TCP 9100 "printer" that records every job it receives. Used instead of hardware in automated tests. */
export class FakePrinter {
  readonly jobs: Buffer[] = [];
  private server: Server | null = null;
  port = 0;

  async start(port = 0): Promise<void> {
    this.server = createServer((socket: Socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => {
        if (chunks.length) this.jobs.push(Buffer.concat(chunks));
        socket.end();
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server!.address() as { port: number }).port;
  }

  /** Power off: nothing listens on the port any more (connection refused). */
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  text(i: number): string {
    return this.jobs[i]?.toString('latin1') ?? '';
  }
}

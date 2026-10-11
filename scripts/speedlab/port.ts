import { createServer } from 'node:net';

/** Probe the actual TCP port, including non-HTTP listeners, without touching their processes. */
export async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`Port ${port} is unavailable; choose another port. Existing services were left running.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
  });
}

import { createServer } from 'node:net';
import { expect, test } from 'vitest';
import { assertPortFree } from '../../scripts/speedlab/port';

test('a non-HTTP listener is refused and remains available to its owner', async () => {
  const owner = createServer(socket => socket.end('still running'));
  await new Promise<void>(resolve => owner.listen(0, '127.0.0.1', resolve));
  const port = (owner.address() as { port: number }).port;
  try {
    await expect(assertPortFree(port)).rejects.toThrow('Existing services were left running');
    expect(owner.listening).toBe(true);
  } finally { await new Promise<void>((resolve, reject) => owner.close(error => error ? reject(error) : resolve())); }
  await expect(assertPortFree(port)).resolves.toBeUndefined();
});

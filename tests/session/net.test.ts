import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../../src/web/net';

class TestSocket {
  static OPEN = 1;
  static instances: TestSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url: string) { TestSocket.instances.push(this); }
  open() { this.readyState = TestSocket.OPEN; this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  end(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

beforeEach(() => {
  vi.useFakeTimers();
  TestSocket.instances = [];
  vi.stubGlobal('WebSocket', TestSocket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'reader.example' });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('reconnecting socket ownership', () => {
  it('does not deliver late callbacks after the page closes its connection', () => {
    const onOpen = vi.fn();
    const onMessage = vi.fn();
    const onStatus = vi.fn();
    const connection = connect('/ws/control', { onOpen, onMessage, onStatus });
    const old = TestSocket.instances[0];
    connection.close();
    onStatus.mockClear();
    old.open();
    old.message({ type: 'display', state: 'old' });
    old.end();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
    expect(connection.send({ type: 'hello' })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores retired-socket messages and closes after a replacement connects', async () => {
    const onMessage = vi.fn();
    const onStatus = vi.fn();
    const connection = connect('/ws/overlay', { onMessage, onStatus });
    const old = TestSocket.instances[0];
    old.open();
    old.end();
    await vi.advanceTimersByTimeAsync(250);
    const current = TestSocket.instances[1];
    current.open();
    onStatus.mockClear();
    old.message({ type: 'display', state: 'old' });
    old.end();
    current.message({ type: 'display', state: 'current' });
    expect(onMessage.mock.calls).toEqual([[{ type: 'display', state: 'current' }]]);
    expect(onStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(TestSocket.instances).toHaveLength(2);
    expect(connection.send({ type: 'painted', revision: 2 })).toBe(true);
    expect(current.send).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it('keeps normal reconnect, fresh state delivery and auth refusal working', async () => {
    const onMessage = vi.fn();
    const connection = connect('/ws/overlay', { onMessage, shouldRetry: code => code !== 4401 });
    expect(TestSocket.instances[0].url).toBe('wss://reader.example/ws/overlay');
    TestSocket.instances[0].end();
    await vi.advanceTimersByTimeAsync(249);
    expect(TestSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    TestSocket.instances[1].open();
    TestSocket.instances[1].message({ type: 'display', state: 'latest' });
    expect(onMessage).toHaveBeenCalledWith({ type: 'display', state: 'latest' });
    TestSocket.instances[1].end(4401);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(TestSocket.instances).toHaveLength(2);
    connection.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

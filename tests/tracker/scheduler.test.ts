// Ported behaviour from Moard harbor/actions/test_contextual_ranking.py (see docs/REUSE_NOTES.md).
import { describe, expect, it } from 'vitest';
import { DecisionScheduler, type Outcome } from '../../src/server/tracker/scheduler';
import { VirtualClock } from '../helpers';

const cfg = { coalesceMs: 100, minIntervalMs: 250, deadlineMs: 600, failureTtlMs: 2000 };

function setup(run: (p: string, signal: AbortSignal) => Promise<string>) {
  const clock = new VirtualClock();
  const outcomes: Array<{ fp: string; o: Outcome<string> }> = [];
  const s = new DecisionScheduler<string, string>(cfg, (p, signal) => run(p, signal), (job, o) => outcomes.push({ fp: job.fingerprint, o }), clock);
  return { clock, s, outcomes };
}

describe('decision scheduler', () => {
  it('starts within the coalescing window even while new evidence keeps arriving', async () => {
    const calls: Array<{ packet: string; at: number }> = [];
    const { clock, s } = setup(async (packet) => {
      calls.push({ packet, at: clock.now() });
      return packet;
    });
    s.submit({ fingerprint: 'a', packet: 'a' });
    await clock.advance(40);
    s.submit({ fingerprint: 'b', packet: 'b' });
    await clock.advance(40);
    s.submit({ fingerprint: 'c', packet: 'c' });
    await clock.advance(20);
    expect(calls).toEqual([{ packet: 'c', at: 100 }]);

    // New evidence replaces the pending job without extending the minimum interval either.
    s.submit({ fingerprint: 'd', packet: 'd' });
    await clock.advance(50);
    s.submit({ fingerprint: 'e', packet: 'e' });
    await clock.advance(50);
    s.submit({ fingerprint: 'f', packet: 'f' });
    await clock.advance(150);
    expect(calls).toEqual([{ packet: 'c', at: 100 }, { packet: 'f', at: 350 }]);
    s.cancelAll();
  });

  it('a blocked provider never blocks submitters, and identical requests are single-flight', async () => {
    let calls = 0;
    let release!: () => void;
    const { clock, s, outcomes } = setup(() => {
      calls++;
      return new Promise((r) => (release = () => r('ok')));
    });
    for (let i = 0; i < 100; i++) s.submit({ fingerprint: 'same', packet: 'p' });
    await clock.advance(150);
    expect(calls).toBe(1);
    for (let i = 0; i < 100; i++) s.submit({ fingerprint: 'same', packet: 'p' });
    release();
    await clock.advance(10);
    expect(calls).toBe(1);
    expect(outcomes).toHaveLength(1);
    expect(s.stats.deduplicated).toBeGreaterThanOrEqual(199);
  });

  it('coalesces to the latest context while an old provider ignores cancellation', async () => {
    const seen: string[] = [];
    const pending: Array<() => void> = [];
    const { clock, s, outcomes } = setup((p) => {
      seen.push(p);
      return new Promise((r) => pending.push(() => r(p)));
    });
    s.submit({ fingerprint: 'a', packet: 'a' });
    await clock.advance(120);
    for (let i = 0; i < 30; i++) s.submit({ fingerprint: `n${i}`, packet: `n${i}` });
    await clock.advance(200);
    expect(seen).toEqual(['a']);
    pending[0]();
    await clock.advance(400);
    expect(seen).toEqual(['a', 'n29']);
    pending[1]();
    await clock.advance(10);
    expect(outcomes.map((x) => x.fp)).toEqual(['a', 'n29']);
  });

  it('drops a result that lands after the deadline and after cancelAll', async () => {
    let resolveLate!: (v: string) => void;
    const { clock, s, outcomes } = setup(() => new Promise((r) => (resolveLate = r)));
    s.submit({ fingerprint: 'x', packet: 'x' });
    await clock.advance(100 + 600 + 5);
    expect(outcomes.map((o) => o.o.kind)).toEqual(['deadline']);
    resolveLate('late');
    await clock.advance(10);
    expect(outcomes).toHaveLength(1);

    const second = setup(() => new Promise((r) => (resolveLate = r)));
    second.s.submit({ fingerprint: 'y', packet: 'y' });
    await second.clock.advance(150);
    second.s.cancelAll();
    resolveLate('late');
    await second.clock.advance(10);
    expect(second.outcomes).toHaveLength(0);
  });

  it('negative-caches failures without a retry storm, then allows one retry after the TTL', async () => {
    let calls = 0;
    const { clock, s } = setup(async () => {
      calls++;
      throw Object.assign(new Error('x'), { code: 'SERVICE_UNAVAILABLE' });
    });
    s.submit({ fingerprint: 'f', packet: 'f' });
    await clock.advance(200);
    for (let i = 0; i < 20; i++) {
      s.submit({ fingerprint: 'f', packet: 'f' });
      await clock.advance(50);
    }
    expect(calls).toBe(1);
    await clock.advance(2000);
    s.submit({ fingerprint: 'f', packet: 'f' });
    await clock.advance(200);
    expect(calls).toBe(2);
  });

  it('respects a rate-limit cooldown before the next start', async () => {
    const starts: number[] = [];
    let first = true;
    const { clock, s } = setup(async () => {
      starts.push(clock.now());
      if (first) {
        first = false;
        throw Object.assign(new Error('rl'), { code: 'RATE_LIMITED', retryAfterMs: 3000 });
      }
      return 'ok';
    });
    s.submit({ fingerprint: 'a', packet: 'a' });
    await clock.advance(150);
    s.submit({ fingerprint: 'b', packet: 'b' });
    await clock.advance(5000);
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(3000);
  });
});

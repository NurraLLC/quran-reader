import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { CommandResolver, HEDGE_MS, SEARCH_DEADLINE_MS } from '../../src/server/commands/reducer';
import type { Decision, DecisionClient } from '../../src/server/providers/jev';
import { SemanticRetriever } from '../../src/server/search/semantic';
import { fullCorpus } from '../helpers';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function resolver(semantic: ConstructorParameters<typeof CommandResolver>[1] = null) {
  const signals: AbortSignal[] = [];
  const evaluate = vi.fn<DecisionClient['evaluate']>((_state, _questions, options) => {
    signals.push(options!.signal!);
    // Deliberately ignores abort: cancellation must be owned by the resolver too.
    return new Promise<Decision>(() => undefined);
  });
  const client: DecisionClient = { gateway: 'openrouter', evaluate };
  return { r: new CommandResolver(fullCorpus().corpus, semantic, client), evaluate, signals };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('search cancellation ownership', () => {
  it('does not start provider work for an already cancelled request', async () => {
    const { r, evaluate } = resolver();
    const ctrl = new AbortController();
    ctrl.abort();
    const completion = r.search('with hardship comes ease', ctrl.signal);
    const outcome = completion.catch(error => error);
    await vi.advanceTimersByTimeAsync(SEARCH_DEADLINE_MS + 1);
    expect(await outcome).toMatchObject({ code: 'CANCELLED' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not emit cards or call JEV when cancellation happens during semantic retrieval', async () => {
    const retrieval = deferred<Array<{ verseIndex: number; score: number }>>();
    const semantic = new SemanticRetriever();
    vi.spyOn(semantic, 'ready', 'get').mockReturnValue(true);
    vi.spyOn(semantic, 'search').mockReturnValue(retrieval.promise);
    const { r, evaluate } = resolver(semantic);
    const ctrl = new AbortController();
    const preliminary = vi.fn();
    const completion = r.search('with hardship comes ease', ctrl.signal, preliminary);
    const outcome = completion.catch(error => error);
    ctrl.abort();
    retrieval.resolve([]);
    await vi.advanceTimersByTimeAsync(SEARCH_DEADLINE_MS + 1);
    expect(await outcome).toMatchObject({ code: 'CANCELLED' });
    expect(preliminary).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, HEDGE_MS])('settles cancellation and removes listeners after %i ms of provider work', async (elapsed) => {
    const { r, evaluate, signals } = resolver();
    const ctrl = new AbortController();
    const completion = r.search('with hardship comes ease', ctrl.signal);
    const outcome = completion.catch(error => error);
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(evaluate).toHaveBeenCalledTimes(elapsed ? 2 : 1);
    ctrl.abort();
    expect(await outcome).toMatchObject({ code: 'CANCELLED' });
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(getEventListeners(ctrl.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SEARCH_DEADLINE_MS);
    expect(evaluate).toHaveBeenCalledTimes(elapsed ? 2 : 1);
  });

  it('cleans up the abort listener after an ordinary provider failure', async () => {
    const { r, evaluate } = resolver();
    evaluate.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' }));
    const ctrl = new AbortController();
    const result = await r.search('with hardship comes ease', ctrl.signal);
    expect(result.kind === 'candidates' && result.status).toContain('RATE_LIMITED');
    expect(getEventListeners(ctrl.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SEARCH_DEADLINE_MS);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});

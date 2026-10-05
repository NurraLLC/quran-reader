// Transport-fixture tests for the JEV Decisions client. No network; no paid provider call.
import { describe, expect, it } from 'vitest';
import { buildCommandChoice, buildLocate, readLocate, WAIT } from '../../src/server/providers/decisions';
import {
  byteLength,
  encodeRequest,
  fitToBudget,
  JevClient,
  JevError,
  parseDecision,
  probabilitiesSumOk,
  REQUEST_BUDGET_BYTES,
  type FetchLike,
  type Question,
} from '../../src/server/providers/jev';

const Q: Record<string, Question> = {
  location: { type: 'choice', instructions: 'i', criteria: { c0: 'a', c1: 'b', WAIT: 'w' } },
  has_match: { type: 'noul', instructions: 'n' },
};

const good = (over: Record<string, unknown> = {}, gateway: 'openrouter' | 'typesafe' = 'openrouter') =>
  JSON.stringify({
    ...(gateway === 'openrouter' ? { id: 'gen-dec-1', provider: 'TypeSafe', model: 'typesafe/jev-1.13-20260917' } : { model: 'jev-1.13.0' }),
    answers: {
      location: { type: 'choice', choice: 'c0', probabilities: { c0: 0.93, c1: 0.05, WAIT: 0.02 }, confidence: 0.9 },
      has_match: { type: 'noul', noul: 0.96 },
    },
    usage: { input_tokens: 476, output_tokens: 70, cost: 0.00002 },
    ...over,
  });

function fakeFetch(status: number, body: string, headers: Record<string, string> = {}, calls: Array<{ url: string; body: string; headers: Record<string, string> }> = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    return { status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => body };
  };
}

describe('JEV request encoding', () => {
  it('uses the real Decisions endpoint/model per gateway and pins OpenRouter to TypeSafe without fallback', async () => {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    await new JevClient('openrouter', 'sk-test', fakeFetch(200, good(), {}, calls)).evaluate({ a: 1 }, Q, { timeoutMs: 600 });
    expect(calls[0].url).toBe('https://openrouter.ai/api/alpha/decisions');
    const body = JSON.parse(calls[0].body);
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.provider).toEqual({ only: ['TypeSafe'], allow_fallbacks: false, data_collection: 'deny' });
    expect(Object.keys(body).sort()).toEqual(['model', 'provider', 'questions', 'state']);
    expect(calls[0].headers.Authorization).toBe('Bearer sk-test');

    const calls2: typeof calls = [];
    await new JevClient('typesafe', 'ts-test', fakeFetch(200, good({}, 'typesafe'), {}, calls2)).evaluate({}, Q, { timeoutMs: 600 });
    expect(calls2[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(JSON.parse(calls2[0].body)).toMatchObject({ model: 'jev-1.13.0' });
    expect(JSON.parse(calls2[0].body).provider).toBeUndefined();
  });

  it('redacts the key when serialized', () => {
    expect(JSON.stringify(new JevClient('typesafe', 'secret-key'))).not.toContain('secret-key');
  });

  it('refuses an oversized request before sending anything', async () => {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const big = { text: 'x'.repeat(REQUEST_BUDGET_BYTES) };
    await expect(new JevClient('typesafe', 'k', fakeFetch(200, good(), {}, calls)).evaluate(big, Q, { timeoutMs: 600 })).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' });
    expect(calls).toHaveLength(0);
  });
});

describe('JEV response validation (ported from Moard openrouter_jev tests)', () => {
  it.each(['TypeSafe', 'typesafe', 'TYPESAFE', undefined])('preserves optional pinned provider %s', async (provider) => {
    const { state, questions } = buildCommandChoice('No, I meant Ash-Shams, not Ash-Shuara.', '2:255', [
      { id: 'a0', label: 'Go to Ash-Shams', description: 'Show 91:1' },
      { id: 'a1', label: 'Go to Ash-Shuara', description: 'Show 26:1' },
    ]);
    const answers = { action: { type: 'choice', choice: 'a0', probabilities: { a0: 0.95, a1: 0.03, NO_ACTION: 0.02 }, confidence: 0.9 } };
    const d = await new JevClient('openrouter', 'test-key', fakeFetch(200, good({ provider, answers })))
      .evaluate(state, questions, { timeoutMs: 600 });
    expect(d.answers.action).toMatchObject({ choice: 'a0', tied: false });
  });

  it.each(['Other', 'TypeSafe-fallback'])('rejects a response served by %s through the real command packet', async (provider) => {
    const { state, questions } = buildCommandChoice('No, I meant Ash-Shams, not Ash-Shuara.', '2:255', [
      { id: 'a0', label: 'Go to Ash-Shams', description: 'Show 91:1' },
      { id: 'a1', label: 'Go to Ash-Shuara', description: 'Show 26:1' },
    ]);
    const answers = { action: { type: 'choice', choice: 'a0', probabilities: { a0: 0.95, a1: 0.03, NO_ACTION: 0.02 }, confidence: 0.9 } };
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    await expect(new JevClient('openrouter', 'test-key', fakeFetch(200, good({ provider, answers }), {}, calls))
      .evaluate(state, questions, { timeoutMs: 600 })).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['missing confidence', { type: 'choice', choice: 'a0', probabilities: { a0: 0.95, a1: 0.03, NO_ACTION: 0.02 } }],
    ['missing probabilities', { type: 'choice', choice: 'a0', confidence: 0.9 }],
    ['wrong probability keys', { type: 'choice', choice: 'a0', probabilities: { a0: 0.95, other: 0.03, NO_ACTION: 0.02 }, confidence: 0.9 }],
    ['nonfinite probability', { type: 'choice', choice: 'a0', probabilities: { a0: Infinity, a1: 0.03, NO_ACTION: 0.02 }, confidence: 0.9 }],
    ['wrong winner', { type: 'choice', choice: 'a1', probabilities: { a0: 0.95, a1: 0.03, NO_ACTION: 0.02 }, confidence: 0.9 }],
  ])('refuses %s for the actual command options', async (_name, action) => {
    const { state, questions } = buildCommandChoice('No, I meant Ash-Shams, not Ash-Shuara.', '2:255', [
      { id: 'a0', label: 'Go to Ash-Shams', description: 'Show 91:1' },
      { id: 'a1', label: 'Go to Ash-Shuara', description: 'Show 26:1' },
    ]);
    await expect(new JevClient('openrouter', 'test-key', fakeFetch(200, good({ answers: { action } })))
      .evaluate(state, questions, { timeoutMs: 600 })).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
  });

  it('a metering field the provider has not shipped yet does not end the decision', () => {
    const d = parseDecision('openrouter', good({ usage: { input_tokens: 476, output_tokens: 70, cached_input_tokens: 41 } }), Q);
    expect(d.usage.inputTokens).toBe(476);
  });

  it('two-decimal rounding keeps reported scores without normalization', () => {
    expect(probabilitiesSumOk([0.8, 0.1, 0.09])).toBe(true);
    expect(probabilitiesSumOk([0.33, 0.33, 0.33])).toBe(true);
    expect(probabilitiesSumOk([0.8, 0.1, 0.05])).toBe(false);
    expect(probabilitiesSumOk([0.81, 0.2, 0.2])).toBe(false);
    expect(probabilitiesSumOk([0.801, 0.1, 0.09])).toBe(false);
    const d = parseDecision('openrouter', good({ answers: { location: { type: 'choice', choice: 'c0', probabilities: { c0: 0.8, c1: 0.1, WAIT: 0.09 }, confidence: 0.7 }, has_match: { type: 'noul', noul: 0.9 } } }), Q);
    const loc = d.answers.location;
    expect(loc.type === 'choice' && loc.probabilities.c0).toBe(0.8);
  });

  it('marks tied top probabilities so they can never become an action', () => {
    const d = parseDecision('openrouter', good({ answers: { location: { type: 'choice', choice: 'c0', probabilities: { c0: 0.34, c1: 0.34, WAIT: 0.33 }, confidence: 0.01 }, has_match: { type: 'noul', noul: 0.9 } } }), Q);
    expect(d.answers.location.type === 'choice' && d.answers.location.tied).toBe(true);
  });

  it.each([
    ['unknown top-level key', good({ extra: 1 })],
    ['wrong model (router is not the decision primitive)', good({ model: 'typesafe/jev-router' })],
    ['invented option', good({ answers: { location: { type: 'choice', choice: 'c9', probabilities: { c0: 0.9, c1: 0.05, WAIT: 0.05 }, confidence: 0.9 }, has_match: { type: 'noul', noul: 0.9 } } })],
    ['missing option probability', good({ answers: { location: { type: 'choice', choice: 'c0', probabilities: { c0: 0.95, WAIT: 0.05 }, confidence: 0.9 }, has_match: { type: 'noul', noul: 0.9 } } })],
    ['boolean as number', good({ answers: { location: { type: 'choice', choice: 'c0', probabilities: { c0: true, c1: 0, WAIT: 0 }, confidence: 0.9 }, has_match: { type: 'noul', noul: 0.9 } } })],
    ['choice is not the max', good({ answers: { location: { type: 'choice', choice: 'c1', probabilities: { c0: 0.9, c1: 0.05, WAIT: 0.05 }, confidence: 0.9 }, has_match: { type: 'noul', noul: 0.9 } } })],
    ['missing token counts', good({ usage: { cost: 0.1 } })],
    ['extra question answer', good({ answers: { location: { type: 'choice', choice: 'c0', probabilities: { c0: 0.9, c1: 0.05, WAIT: 0.05 }, confidence: 0.9 }, has_match: { type: 'noul', noul: 0.9 }, other: { type: 'noul', noul: 1 } } })],
    ['not JSON', '{oops'],
  ])('rejects %s', (_name, body) => {
    expect(() => parseDecision('openrouter', body, Q)).toThrowError(JevError);
  });

  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [402, 'CREDITS_EXHAUSTED'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVICE_UNAVAILABLE'],
    [529, 'SERVICE_UNAVAILABLE'],
    [302, 'REDIRECT_BLOCKED'],
    [422, 'REQUEST_REJECTED'],
  ])('maps HTTP %i to %s without reading the error body', async (status, code) => {
    let read = false;
    const f: FetchLike = async () => ({ status, headers: { get: (n) => (n === 'retry-after' ? '7' : null) }, text: async () => ((read = true), 'private echo') });
    const err = await new JevClient('openrouter', 'k', f).evaluate({}, Q, { timeoutMs: 600 }).catch((e) => e);
    expect(err).toMatchObject({ code });
    if (status === 429) expect(err.retryAfterMs).toBe(7000);
    expect(read).toBe(false);
  });

  it('times out inside the deadline and never retries', async () => {
    let calls = 0;
    const f: FetchLike = (_u, init) => {
      calls++;
      return new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('abort'))));
    };
    await expect(new JevClient('typesafe', 'k', f).evaluate({}, Q, { timeoutMs: 60 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(calls).toBe(1);
  });
});

describe('candidate budget (ported: an oversized pack keeps relevant candidates inside the actual budget)', () => {
  it('keeps the fixed relevant candidate, fits the serialized request, and reports truncation', () => {
    const filler = Array.from({ length: 99 }, (_, i) => ({ id: `f${i}`, d: 'x'.repeat(150) }));
    const wanted = { id: 'subject', d: 'Subject' };
    const encode = (items: typeof filler) => JSON.stringify({ q: Object.fromEntries(items.map((c) => [c.id, c.d])) });
    const { kept, truncated } = fitToBudget([wanted], filler, encode, 4096);
    expect(kept[0]).toBe(wanted);
    expect(kept.length).toBeLessThan(100);
    expect(byteLength(encode(kept))).toBeLessThanOrEqual(4096);
    expect(truncated).toBe(true);
    expect(fitToBudget([wanted], filler, encode, 1).kept).toEqual([]);
  });

  it('locate packets always keep WAIT and map option ids back to local verse indices', () => {
    const cand = (verseIndex: number) => ({ verseIndex, score: 1, startPos: 0, endPos: 3, matched: 3, matchedWeight: 2, subs: 0, ins: 0, dels: 0, lastObs: 2, trailing: 0, run: 3, pairs: [[0, 0, 1], [1, 1, 1], [2, 2, 1]] as Array<[number, number, number]>, inVerse: 3, source: 'global' as const, relation: 'jump' as const });
    const obs = ['a', 'b', 'c'].map((k) => ({ key: k, cons: k, foreign: false, startMs: 0, endMs: 1 }));
    const ix = { consWords: ['w0', 'w1', 'w2', 'w3', 'w4'], totalWords: 5 } as never;
    const p = buildLocate(ix, 'typesafe', obs, '', '2:255', [cand(7), cand(9)]);
    const q = p.questions.location;
    expect(q.type === 'choice' && Object.keys(q.criteria)).toEqual(['c0', 'c1', WAIT]);
    expect(p.options.get('c1')).toBe(9);
    expect(byteLength(encodeRequest('typesafe', p.state, p.questions))).toBeLessThanOrEqual(REQUEST_BUDGET_BYTES);
    const d = { ...parseDecision('typesafe', good({}, 'typesafe'), p.questions), latencyMs: 1 };
    expect(readLocate(d, p)).toMatchObject({ kind: 'selected', verseIndex: 7 });
    const low = { latencyMs: 1, ...parseDecision('typesafe', good({ answers: { location: { type: 'choice', choice: 'c0', probabilities: { c0: 0.6, c1: 0.4, WAIT: 0 }, confidence: 0.2 }, has_match: { type: 'noul', noul: 0.99 } } }, 'typesafe'), p.questions) };
    expect(readLocate(low, p).kind).toBe('below_gate');
  });
});

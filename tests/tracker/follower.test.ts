import { describe, expect, it } from 'vitest';
import { SimulatedDecisionClient } from '../../src/server/providers/decisions';
import type { Decision, DecisionClient, Question } from '../../src/server/providers/jev';
import { RecitationFollower, type FollowerEvent, type TrackerMode } from '../../src/server/tracker/follower';
import { Timeline } from '../../src/replay/synth';
import { TranscriptBuffer } from '../../src/shared/transcript';
import { fullCorpus, VirtualClock } from '../helpers';

function harness(mode: TrackerMode, client: DecisionClient | null, clock = new VirtualClock()) {
  const { corpus, ix } = fullCorpus();
  const events: FollowerEvent[] = [];
  const f = new RecitationFollower(ix, corpus.id, 's1', client, mode, (e) => events.push(e), clock);
  const buf = new TranscriptBuffer();
  const play = async (tl: Timeline, until = Infinity) => {
    for (const ev of tl.sorted()) {
      if (ev.t > until) break;
      if (ev.t > clock.now()) await clock.advance(ev.t - clock.now());
      if (ev.type !== 'result') continue;
      const r = buf.apply(ev.tokens);
      f.onTranscript(buf.evidence(), '', r.evidenceChanged);
    }
  };
  const commits = () => events.filter((e): e is Extract<FollowerEvent, { kind: 'commit' }> => e.kind === 'commit').map((e) => ({ key: corpus.at(e.verseIndex)!.key, via: e.via }));
  return { f, events, play, commits, clock, corpus };
}

function recite(keys: string[]) {
  const { corpus } = fullCorpus();
  const tl = new Timeline();
  for (const k of keys) {
    const [a, b] = k.split('-');
    for (let i = corpus.verse(a)!.index; i <= corpus.verse(b ?? a)!.index; i++) tl.reciteVerse(corpus.at(i)!);
  }
  return tl;
}

describe('follower modes', () => {
  it('deterministic never calls a decision provider', async () => {
    const clock = new VirtualClock();
    const client = new SimulatedDecisionClient(300, (ms, s) => clock.wait(ms, s));
    const h = harness('deterministic', client, clock);
    await h.play(recite(['2:254-2:256']));
    expect(client.calls).toBe(0);
    expect(h.commits().map((c) => c.key)).toEqual(['2:254', '2:255', '2:256']);
  });

  it('hybrid asks only on ambiguity and still commits obvious transitions deterministically', async () => {
    const clock = new VirtualClock();
    const client = new SimulatedDecisionClient(300, (ms, s) => clock.wait(ms, s));
    const h = harness('hybrid', client, clock);
    await h.play(recite(['2:254-2:256']));
    await clock.advance(2000);
    const c = h.commits();
    expect(c.map((x) => x.key)).toContain('2:256');
    expect(c.filter((x) => x.key === '2:255' || x.key === '2:256').every((x) => x.via === 'deterministic')).toBe(true);
    expect(client.calls).toBeGreaterThan(0); // the common opening "يا أيها الذين آمنوا" is ambiguous
    expect(client.calls).toBeLessThan(10);
  });

  it('jev_required commits every transition only through a decision', async () => {
    const clock = new VirtualClock();
    const client = new SimulatedDecisionClient(300, (ms, s) => clock.wait(ms, s));
    const h = harness('jev_required', client, clock);
    await h.play(recite(['55:10-55:16']));
    await clock.advance(2000);
    const c = h.commits();
    expect(c.length).toBeGreaterThan(3);
    expect(c.every((x) => x.via === 'jev')).toBe(true);
  });

  it('without a decision provider, hybrid degrades to the deterministic baseline', async () => {
    const h = harness('hybrid', null);
    await h.play(recite(['55:10-55:16']));
    expect(h.commits().map((c) => c.key).slice(-4)).toEqual(['55:13', '55:14', '55:15', '55:16']);
  });

  it('rejects a late decision after a manual seek (authority change) and records it as stale', async () => {
    const clock = new VirtualClock();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: DecisionClient = {
      gateway: 'typesafe',
      async evaluate(_s: unknown, q: Record<string, Question>): Promise<Decision> {
        await gate;
        const opts = Object.keys((q.location as { criteria: Record<string, string> }).criteria);
        const probabilities = Object.fromEntries(opts.map((o, i) => [o, i === 0 ? 0.95 : 0.05 / (opts.length - 1)]));
        return { id: 'd1', model: 'jev-1.13.0', gateway: 'typesafe', answers: { location: { type: 'choice', choice: opts[0], probabilities, confidence: 0.9, tied: false }, has_match: { type: 'noul', noul: 0.97 } }, usage: { inputTokens: 1, outputTokens: 0, cost: null }, latencyMs: 1 };
      },
    };
    const h = harness('jev_required', slow, clock);
    const tl = recite(['36:1-36:5']);
    await h.play(tl, 4700);
    expect(h.f.stats?.started).toBeGreaterThan(0);
    h.f.seek(h.corpus.verse('112:1')!.index);
    release();
    await clock.advance(100);
    expect(h.commits()).toHaveLength(0);
    const recs = h.events.filter((e) => e.kind === 'decision');
    // The in-flight request was cancelled by the seek; nothing it returns can move the screen.
    expect(recs.every((e) => e.kind === 'decision' && e.record.outcome !== 'accepted')).toBe(true);
  });

  it.each(['stop', 'new capture', 'mode change', 'manual seek', 'unlocate', 'provider removal'])(
    '%s defeats a real in-flight decision even when the provider ignores cancellation', async (change) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let signal!: AbortSignal;
      const answer = new SimulatedDecisionClient(0, async () => undefined);
      const client: DecisionClient = {
        gateway: answer.gateway,
        async evaluate(state, questions, options) {
          signal = options.signal!;
          await gate;
          // Return a confident answer even though the old request was aborted.
          return answer.evaluate(state, questions, {});
        },
      };
      const h = harness('jev_required', client);
      h.f.newCapture(1);
      const buffer = new TranscriptBuffer();
      buffer.apply([{ text: h.corpus.verse('67:1')!.searchText + ' ', isFinal: true }]);
      h.f.onTranscript(buffer.evidence(), '', true);
      await h.clock.advance(101);
      expect(h.f.stats?.started).toBe(1);
      expect(signal.aborted).toBe(false); // prove the cancellation window was actually reached
      const manual = h.corpus.verse('112:1')!.index;
      try {
        if (change === 'stop') h.f.stop();
        else if (change === 'new capture') h.f.newCapture(2);
        else if (change === 'mode change') h.f.setMode('deterministic');
        else if (change === 'manual seek') h.f.seek(manual);
        else if (change === 'unlocate') h.f.unlocate();
        else h.f.setClient(null);
        expect(signal.aborted).toBe(true);
        release();
        await h.clock.advance(1000);
        expect(answer.calls).toBe(1); // the uncooperative provider really returned
        expect(h.commits()).toEqual([]);
        expect(h.f.currentVerse).toBe(change === 'manual seek' ? manual : null);
      } finally {
        release();
        h.f.stop();
      }
    },
  );

  it('a decision can never resolve identical-text collisions (regression: "الحمد لله" at 18:1 chose 1:2)', async () => {
    const clock = new VirtualClock();
    // Stand-in decider that confidently picks the top local option: exactly the failure mode to guard.
    const client = new SimulatedDecisionClient(350, (ms, s) => clock.wait(ms, s));
    for (const mode of ['hybrid', 'jev_required'] as const) {
      const h = harness(mode, client, clock);
      await h.play(recite(['18:1-18:3']));
      await clock.advance(2000);
      const keys = h.commits().map((c) => c.key);
      expect(keys.every((k) => k.startsWith('18:')), `${mode}: ${keys.join(',')}`).toBe(true);
    }
  });
});

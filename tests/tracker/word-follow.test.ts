// Live highlights follow heard words, including repeated words and ayah openings.
import { describe, expect, it } from 'vitest';
import { fullCorpus, VirtualClock } from '../helpers';
import { mapDisplayWords } from '../../src/server/corpus/word-map';
import { Session } from '../../src/server/sessions';
import { CommandResolver } from '../../src/server/commands/reducer';

describe('the session follows heard words', () => {
  const { corpus, ix } = fullCorpus();
  const verse = corpus.verse('36:9')!;
  const words = verse.searchText.split(/\s+/);
  const spans = mapDisplayWords(verse.searchText, verse.arabicDisplay);
  const STEP = 700;
  const LAG = 750;

  function reciting(withClock = true) {
    const clock = new VirtualClock();
    const s = new Session({ corpus, ix, resolver: new CommandResolver(corpus, null, null), decisionClient: null, mode: 'deterministic', setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: () => '', clock });
    s.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
    s.handle({ type: 'goto', key: '36:9' });
    let seq = 0;
    let first = true;
    /** The recogniser reports words 0..n-1 (word i began at i × STEP), LAG after the newest began. */
    const hear = async (n: number) => {
      await clock.advance(Math.max(0, (n - 1) * STEP + LAG - clock.t));
      const tokens = words.slice(0, n).map((w, i) => ({ text: `${i ? ' ' : ''}${w}`, isFinal: false, startMs: i * STEP, endMs: i * STEP + 400 }));
      s.handle({ type: 'transcript', captureEpoch: 1, seq: seq++, receivedAt: clock.t, tokens, ...(withClock ? { audioMs: clock.t } : {}) });
      // Initial batched speech visibly passes through its first words before reaching its endpoint.
      if (first) { await clock.advance(90 * (n - 1)); first = false; }
    };
    return { s, clock, hear };
  }
  const word = (s: Session) => spans.findIndex((x) => x?.from === s.display.cursor?.from);

  for (const from of [0, 4]) it(`starts a manual-anchor batch at its first supported word (${from}), without inventing earlier words`, async () => {
    const { s, clock } = reciting(false);
    s.handle({ type: 'transcript', captureEpoch: 1, seq: 0, receivedAt: 0,
      tokens: [{ text: words.slice(from, from + 3).join(' '), isFinal: false }] });
    expect(word(s)).toBe(from);
    await clock.advance(90);
    expect(word(s)).toBe(from + 1);
    await clock.advance(90);
    expect(word(s)).toBe(from + 2);
    s.handle({ type: 'capture', captureEpoch: 1, event: 'stopped' });
  });

  it('keeps a visible word through rapid hypothesis updates before catching up', async () => {
    const { s, clock, hear } = reciting(false);
    await hear(3);
    const send = (n: number, seq: number) => s.handle({ type: 'transcript', captureEpoch: 1, seq, receivedAt: clock.t,
      tokens: [{ text: words.slice(0, n).join(' '), isFinal: false }] });
    send(6, 10);
    await clock.advance(20);
    send(7, 11);
    expect(word(s)).toBe(2);
    await clock.advance(69);
    expect(word(s)).toBe(2);
    await clock.advance(1);
    expect(word(s)).toBe(3);
    s.handle({ type: 'capture', captureEpoch: 1, event: 'stopped' });
  });

  it('shows an ayah’s opening before prediction, including batched words on the next ayah', async () => {
    const { s, clock } = reciting();
    s.handle({ type: 'goto', key: '95:1' });
    const first = corpus.verse('95:1')!;
    const next = corpus.verse('95:2')!;
    const firstWords = first.searchText.split(/\s+/);
    const nextWords = next.searchText.split(/\s+/);
    const tokens = (parts: string[], start: number) => parts.map((text, i) => ({
      text: `${i || start ? ' ' : ''}${text}`, isFinal: false,
      startMs: start + i * 1200, endMs: start + i * 1200 + 500,
    }));
    await clock.advance(1400);
    s.handle({ type: 'transcript', captureEpoch: 1, seq: 0, receivedAt: clock.t, audioMs: clock.t, tokens: tokens(firstWords.slice(0, 1), 0) });
    expect(s.display.verse?.key).toBe('95:1');
    expect(s.display.cursor).toEqual(mapDisplayWords(first.searchText, first.arabicDisplay)[0]);
    await clock.advance(2000);
    s.handle({ type: 'transcript', captureEpoch: 1, seq: 1, receivedAt: clock.t, audioMs: clock.t, tokens: tokens(firstWords, 0) });
    await clock.advance(2000);
    s.handle({ type: 'transcript', captureEpoch: 1, seq: 2, receivedAt: clock.t, audioMs: clock.t,
      tokens: [...tokens(firstWords, 0), ...tokens(nextWords, 3600)] });
    expect(s.display.verse?.key).toBe('95:2');
    expect(s.display.cursor).toEqual(mapDisplayWords(next.searchText, next.arabicDisplay)[0]);
    await clock.advance(90);
    expect(s.display.cursor).toEqual(mapDisplayWords(next.searchText, next.arabicDisplay)[1]);
    s.handle({ type: 'capture', captureEpoch: 1, event: 'stopped' });
  });

  it('never moves to an unheard word on the clock, including a held syllable', async () => {
    const { s, clock, hear } = reciting();
    await hear(4);
    expect(s.display.verse?.key).toBe('36:9');
    const now = word(s);
    expect(now).toBeGreaterThanOrEqual(3);
    await clock.advance(1500);
    expect(word(s)).toBe(now);
  });

  it('holds through a breath and voice onset until a word is heard', async () => {
    const { s, clock, hear } = reciting();
    await hear(4);
    // Word 4 begins at 2800 and ends by 3300, where the reciter takes a breath: the page's detector
    // reports it 180 ms later, before the recogniser reports word 4 itself.
    await clock.advance(3480 - clock.t);
    s.handle({ type: 'voice', captureEpoch: 1, speaking: false, audioMs: 3300 });
    await hear(5);
    expect(word(s)).toBe(4);
    await clock.advance(2500);
    expect(word(s)).toBe(4);
    s.handle({ type: 'voice', captureEpoch: 1, speaking: true, audioMs: clock.t });
    expect(word(s)).toBe(4);
    await hear(6);
    expect(word(s)).toBe(5);
  });

  it('follows the reciter back when they restart a few words back after a breath', async () => {
    const { s, clock, hear } = reciting();
    await hear(6);
    const ahead = word(s);
    expect(ahead).toBeGreaterThanOrEqual(5);
    // After a breath the reciter goes back to "وجعلنا من بين": later audio, earlier words.
    const restart = (n: number) => {
      const tokens = [...words.slice(0, 6), ...words.slice(0, n)].map((w, i) => ({ text: `${i ? ' ' : ''}${w}`, isFinal: false, startMs: i * STEP, endMs: i * STEP + 400 }));
      s.handle({ type: 'transcript', captureEpoch: 1, seq: 100 + n, receivedAt: clock.t, tokens, audioMs: clock.t });
    };
    await clock.advance(6 * STEP + 2 * STEP + LAG - clock.t);
    restart(3);
    expect(word(s)).toBeLessThan(ahead);
    expect(word(s)).toBeLessThanOrEqual(3);
  });

  it('passes through the words between when it catches up, instead of jumping over them', async () => {
    const { s, clock, hear } = reciting(false);
    await hear(3);
    expect(word(s)).toBe(2);
    await hear(6);
    expect(word(s)).toBe(3);
    await clock.advance(90);
    expect(word(s)).toBe(4);
    await clock.advance(90);
    expect(word(s)).toBe(5);
  });

  it('without the page’s audio clock, follows the recogniser only (no timers)', async () => {
    const { s, clock, hear } = reciting(false);
    await hear(4);
    const now = word(s);
    await clock.advance(3000);
    expect(word(s)).toBe(now);
  });

  it('follows repeated identical words, a return to an earlier word, and continuation', async () => {
    const { s, clock } = reciting();
    s.handle({ type: 'goto', key: '93:5' });
    const v = corpus.verse('93:5')!;
    const parts = v.searchText.split(/\s+/);
    const mapped = mapDisplayWords(v.searchText, v.arabicDisplay);
    const spoken: string[] = [];
    let seq = 0;
    const hearWord = async (index: number) => {
      await clock.advance(1200);
      spoken.push(parts[index]);
      s.handle({ type: 'transcript', captureEpoch: 1, seq: seq++, receivedAt: clock.t, audioMs: clock.t,
        tokens: spoken.map((text, i) => ({ text: `${i ? ' ' : ''}${text}`, isFinal: false, startMs: i * 1200, endMs: i * 1200 + 500 })) });
    };
    await hearWord(0);
    await hearWord(1);
    await hearWord(2);
    for (let i = 0; i < 3; i++) {
      await hearWord(2);
      expect(s.display.cursor).toEqual(mapped[2]);
      await clock.advance(4000);
      expect(s.display.cursor).toEqual(mapped[2]);
    }
    await hearWord(1);
    expect(s.display.cursor).toEqual(mapped[1]);
    await hearWord(2);
    expect(s.display.cursor).toEqual(mapped[2]);
    await hearWord(3);
    expect(s.display.cursor).toEqual(mapped[3]);
    s.handle({ type: 'capture', captureEpoch: 1, event: 'stopped' });
  });

  it('corrects a provisional word at the same audio timestamp instead of forcing forward progress', async () => {
    const { s, clock } = reciting();
    s.handle({ type: 'goto', key: '93:5' });
    const v = corpus.verse('93:5')!;
    const parts = v.searchText.split(/\s+/);
    const mapped = mapDisplayWords(v.searchText, v.arabicDisplay);
    const send = (last: number, seq: number) => s.handle({ type: 'transcript', captureEpoch: 1, seq, receivedAt: clock.t, audioMs: clock.t,
      tokens: [parts[0], parts[1], parts[last]].map((text, i) => ({ text: `${i ? ' ' : ''}${text}`, isFinal: false, startMs: i * 700, endMs: i * 700 + 400 })) });
    await clock.advance(2200);
    send(2, 0);
    await clock.advance(180);
    expect(s.display.cursor).toEqual(mapped[2]);
    send(1, 1); // the recogniser corrects its latest hypothesis, not the audio clock
    expect(s.display.cursor).toEqual(mapped[1]);
    send(2, 2);
    await clock.advance(90);
    expect(s.display.cursor).toEqual(mapped[2]);
    s.handle({ type: 'capture', captureEpoch: 1, event: 'stopped' });
  });
});

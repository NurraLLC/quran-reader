import { describe, expect, it } from 'vitest';
import { fullCorpus, VirtualClock } from '../helpers';
import { TranscriptBuffer, type Word } from '../../src/shared/transcript';
import { LiveCursor } from '../../src/server/tracker/live-cursor';
import { mapDisplayWords } from '../../src/server/corpus/word-map';
import { Session } from '../../src/server/sessions';
import { CommandResolver } from '../../src/server/commands/reducer';

describe('live hypothesis following', () => {
  it('assembles the pending final subword exactly once and replaces rewritten partials', () => {
    const b = new TranscriptBuffer();
    b.apply([{ text: 'الح', isFinal: true }, { text: 'مد لله', isFinal: false }]);
    expect(b.liveWords().map(w => w.text)).toEqual(['الحمد', 'لله']);
    b.apply([{ text: 'مد للرحمن', isFinal: false }]);
    expect(b.liveWords().map(w => w.text)).toEqual(['الحمد', 'للرحمن']);
    expect(b.evidence().map(w => w.text)).toEqual(['الح']);
  });
  it('locates and advances on partial-only results without committing or waiting for an endpoint', () => {
    const { corpus, ix } = fullCorpus();
    const c = new LiveCursor(ix), v = corpus.verse('18:1')!;
    const words: Word[] = v.searchText.split(/\s+/).map((text, i) => ({ text, index: -1, startMs: i * 300, endMs: (i + 1) * 300 }));
    const first = c.update(words.slice(0, 6), null, true);
    expect(first?.verseIndex).toBe(v.index);
    const later = c.update(words.slice(0, 9), null, true);
    expect(later?.word).toBeGreaterThan(first!.word);
    expect(c.update([{ text: 'unrelated', index: -1, startMs: null, endMs: null }], null, true)).toBeNull();
  });
  it('does not invent a location from an ambiguous two-word opening', () => {
    const { ix } = fullCorpus();
    const c = new LiveCursor(ix);
    expect(c.update(['الحمد', 'لله'].map(text => ({ text, index: -1, startMs: null, endMs: null })), null, true)).toBeNull();
  });
  it('recovers from the screenshot location when fresh Al-Ikhlas speech contradicts it', () => {
    const { corpus, ix } = fullCorpus();
    const c = new LiveCursor(ix), old = corpus.verse('93:11')!, next = corpus.verse('112:1')!;
    const words = next.searchText.split(/\s+/).map(text => ({ text, index: -1, startMs: null, endMs: null }));
    const p = c.update(words, { verseIndex: old.index, pos: ix.verseStart[old.index] + ix.verseLen[old.index] - 1 }, true);
    expect(p?.verseIndex).toBe(next.index);
  });
  it('maps supported split/join word spans and leaves unrelated words unmapped', () => {
    expect(mapDisplayWords('و ما ربك', 'وما ربك')).toEqual([{ from: 0, to: 0 }, { from: 0, to: 0 }, { from: 1, to: 1 }]);
    expect(mapDisplayWords('الحمد لله', 'الحمد الرحمن')).toEqual([{ from: 0, to: 0 }, null]);
    expect(mapDisplayWords('الله', 'الله الله')).toEqual([null]);
    expect(mapDisplayWords('ريب فيه هدى', 'ريب ۛ فيه ۛ هدى')).toEqual([{ from: 0, to: 0 }, { from: 2, to: 2 }, { from: 4, to: 4 }]);
  });
  it('publishes partial word changes atomically, freezes on Hold, and ignores results after Stop', async () => {
    const { corpus, ix } = fullCorpus();
    const clock = new VirtualClock();
    const s = new Session({ corpus, ix, resolver: new CommandResolver(corpus, null, null), decisionClient: null, mode: 'hybrid', setup: { soniox: false, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: () => '', clock });
    s.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
    const parts = corpus.verse('18:1')!.searchText.split(/\s+/);
    const send = (n: number, seq: number) => s.handle({ type: 'transcript', captureEpoch: 1, seq, receivedAt: seq, tokens: [{ text: parts.slice(0, n).join(' '), isFinal: false }] });
    send(6, 0);
    expect(s.display.verse?.key).toBe('18:1');
    expect(s.display.cursor).not.toBeNull();
    expect(s.follower.currentVerse).toBeNull();
    const cursor = s.display.cursor!.from;
    send(9, 1);
    await clock.advance(90);
    expect(s.display.cursor!.from).toBeGreaterThan(cursor);
    s.handle({ type: 'hold', on: true });
    const held = s.display.cursor;
    send(11, 2);
    expect(s.display.cursor).toEqual(held);
    s.handle({ type: 'hold', on: false });
    await clock.advance(90);
    expect(s.display.verse?.key).toBe('18:1');
    expect(s.display.cursor!.from).toBeGreaterThan(held!.from);
    s.handle({ type: 'capture', captureEpoch: 1, event: 'stopped' });
    const rev = s.display.revision;
    send(12, 3);
    expect(s.display.revision).toBe(rev);
    expect(s.display.cursor).toBeNull();
  });
});

// Reversible display following over the current complete ASR hypothesis. This never commits
// provisional text to the confirmed follower, sends JEV requests, or edits the Quran corpus.
import type { Word } from '../../shared/transcript';
import type { CorpusIndex } from './index';
import { DEFAULT_TRACKER_CONFIG, TrackerEngine } from './reducer';
import type { Candidate, NeighbourProvider } from './candidates';

export type LivePosition = {
  verseIndex: number;
  word: number;
  /** First aligned word in this ayah, including when several words arrived together. */
  firstWord: number;
  provisional: boolean;
  /** When the heard word placed at `word` began (provider audio ms), if known. */
  startMs: number | null;
};
type Anchor = { pos: number; verseIndex: number };

export class LiveCursor {
  private anchor: Anchor | null = null;
  private confirmedVerse: number | null = null;
  private last: LivePosition | null = null;
  /** Heard words when `last` was found. */
  private lastLen = 0;
  constructor(
    private readonly ix: CorpusIndex,
    public advanceWords: 1 | 2 = 1,
  ) {}
  reset() { this.anchor = null; this.confirmedVerse = null; this.last = null; }

  update(words: readonly Word[], confirmed: Anchor | null, provisional: boolean, prior: number | null = null, neighbours: NeighbourProvider | null = null): LivePosition | null {
    if (!words.length) { this.reset(); return null; }
    // Re-align the complete latest hypothesis every time. A subword correction is not a new
    // location: preserve the local path as a prior while requiring present speech to support it.
    // One exact word of the next ayah is enough on the confirmed path (see oneWordAdvance): waiting
    // for a second word was the visible first-word delay at every ayah change.
    // A confirmed move the live path has not made (e.g. a surah opening identified from finals while
    // the live hypothesis was still forming) is adopted: the live cursor was still on the previously
    // confirmed ayah, or the move is further along the same surah. A lagging confirmation of a place
    // the live path already left is old news and never pulls the display back.
    if (confirmed && confirmed.verseIndex !== this.confirmedVerse) {
      const live = this.anchor?.verseIndex;
      const sameSurahAhead = live !== undefined && confirmed.verseIndex > live && this.ix.verses[confirmed.verseIndex].surah === this.ix.verses[live].surah;
      if (live !== undefined && (live === this.confirmedVerse || sameSurahAhead)) this.anchor = confirmed;
      this.confirmedVerse = confirmed.verseIndex;
    }
    const engine = new TrackerEngine(this.ix, { ...DEFAULT_TRACKER_CONFIG, advanceWords: this.advanceWords });
    engine.prior = prior;
    engine.neighbours = neighbours;
    engine.anchor = this.anchor ?? confirmed;
    engine.phase = engine.anchor ? 'tracking' : 'unlocated';
    const step = engine.step(words);
    let pos: Anchor | null = null;
    let by: Candidate | null = null;
    if (step.proposal) {
      pos = { verseIndex: step.proposal.verseIndex, pos: step.proposal.pos };
      by = step.proposal.candidate;
    } else if (step.progress) {
      const candidate = step.top.find(c => c.verseIndex === step.progress!.verseIndex && c.trailing <= 1 && c.matched > 0);
      if (candidate) {
        pos = { verseIndex: candidate.verseIndex, pos: candidate.endPos };
        by = candidate;
      }
    }
    if (pos) this.anchor = pos;
    // One new word that does not match yet is not evidence of anything: an elongated madd or a long
    // word spoken slowly arrives in pieces ("وملائ" before "كته", sometimes finalized mid-word).
    // Keep the last position rather than blinking the highlight off; a second unmatched word, or a
    // rewritten (shorter) hypothesis, clears it.
    if (!pos) return this.last && words.length >= this.lastLen && words.length <= this.lastLen + 1 ? { ...this.last, provisional } : (this.last = null);
    const obs = step.obs ?? [];
    let startMs: number | null = null;
    for (const [oi, p] of by?.pairs ?? []) {
      const s = obs[oi]?.startMs;
      if (s === null || s === undefined) continue;
      if (p === pos.pos) startMs = s;
    }
    const start = this.ix.verseStart[pos.verseIndex];
    const first = by?.pairs.find(([, p]) => this.ix.wordVerse[p] === pos.verseIndex)?.[1] ?? pos.pos;
    this.last = { verseIndex: pos.verseIndex, word: Math.max(0, pos.pos - start), firstWord: Math.max(0, first - start), provisional, startMs };
    this.lastLen = words.length;
    return this.last;
  }
}

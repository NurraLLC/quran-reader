// npm run replay:timing -- [capture.jsonl | folder ...] [--provider-lag 600] [--each]
//
// Word-level "keeping up": replays real captures through the actual session (live cursor, display
// state, timers) in virtual time and compares, moment by moment, the highlighted word with the word
// being recited. The recited word comes from the provider's final transcript (its audio timings),
// matched in order to the ayahs the session showed.
//
// Clock: captures record when results arrived, not when audio started. Audio time 0 is placed
// `--provider-lag` ms (default 600, the speed-lab measurement) before the earliest any token was
// seen after its end, so absolute values are estimates; before/after comparisons on the same
// captures are exact.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { CommandResolver } from '../src/server/commands/reducer';
import { Corpus, loadCorpus } from '../src/server/corpus/load';
import { mapDisplayWords, type WordSpan } from '../src/server/corpus/word-map';
import { Session } from '../src/server/sessions';
import { buildIndex } from '../src/server/tracker/index';
import { similarity, tokenize } from '../src/server/tracker/normalize';
import { loadFixture } from '../src/replay/run';
import { VClock } from '../src/replay/vclock';
import { TranscriptBuffer, type WireToken } from '../src/shared/transcript';

const corpus = new Corpus(loadCorpus());
const ix = buildIndex(corpus.verses);
const resolver = new CommandResolver(corpus, null, null);
const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const PROVIDER_LAG = Number(flag('--provider-lag') ?? 600);
if (process.argv.includes('--pace')) throw new Error('Pace prediction was retired. Live highlighting follows heard words; --pace is no longer supported.');
const values = new Set([flag('--provider-lag'), flag('--window')]);
const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && !values.has(a));
const expand = (p: string) => (p.endsWith('.jsonl') ? [p] : readdirSync(p).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(p, f)));
const files = (args.length ? args : ['data/captures']).flatMap(expand);

type Truth = { pos: number; start: number; end: number };
type Shown = { t: number; pos: number | null; verse: number | null };

const spans = new Map<number, Array<WordSpan | null>>();
/** Search-word index of a display cursor. */
function searchWord(verse: number, from: number): number | null {
  let m = spans.get(verse);
  if (!m) {
    const v = corpus.at(verse)!;
    m = mapDisplayWords(v.searchText, v.arabicDisplay);
    spans.set(verse, m);
  }
  const k = m.findIndex((s) => s?.from === from);
  return k < 0 ? null : k;
}

const same = (a: string, b: string) => a === b || similarity(a, b) >= 0.8;
const trace = process.argv.includes('--trace');
const label = (pos: number) => `${corpus.at(ix.wordVerse[pos])!.key}#${pos - ix.verseStart[ix.wordVerse[pos]]} ${ix.words[pos]}`;

/** Final heard words matched in order to corpus words of the shown ayahs (and their neighbours). */
function groundTruth(words: Array<{ key: string; start: number; end: number }>, verses: Set<number>): Truth[] {
  const allowed: number[] = [];
  for (const v of [...verses].sort((a, b) => a - b)) {
    for (const u of [v - 1, v, v + 1]) {
      if (u < 0 || u >= ix.verses.length) continue;
      for (let p = ix.verseStart[u]; p < ix.verseStart[u] + ix.verseLen[u]; p++) allowed.push(p);
    }
  }
  const pool = [...new Set(allowed)].sort((a, b) => a - b);
  const out: Truth[] = [];
  let ptr: number | null = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    let hit: number | null = null;
    if (ptr !== null) {
      for (let d = 1; d <= 3 && hit === null; d++) if (ptr + d < ix.totalWords && same(w.key, ix.words[ptr + d])) hit = ptr + d;
      if (hit === null) {
        // Going back within the ayah (a restart after a breath): the next heard word must agree.
        const vs = ix.verseStart[ix.wordVerse[ptr]];
        for (let q: number = ptr; q >= Math.max(vs, ptr - 20) && hit === null; q--) if (same(w.key, ix.words[q]) && (!next || (q + 1 < ix.totalWords && same(next.key, ix.words[q + 1])))) hit = q;
      }
    }
    if (hit === null) {
      let best: number | null = null;
      for (const q of pool) {
        if (!same(w.key, ix.words[q]) || !next || q + 1 >= ix.totalWords || !same(next.key, ix.words[q + 1])) continue;
        if (best === null || (ptr !== null && Math.abs(q - ptr) < Math.abs(best - ptr))) best = q;
      }
      hit = best;
    }
    if (hit !== null) {
      out.push({ pos: hit, start: w.start, end: w.end });
      ptr = hit;
    }
  }
  return out;
}

type Stats = { sync: number; behind: number; ahead: number; none: number; unlit: number; behindWords: number; onset: number[]; back: number; skips: number; words: number };

async function run(file: string): Promise<Stats & { offset: number }> {
  const clock = new VClock();
  const session = new Session({
    corpus,
    ix,
    resolver,
    decisionClient: null,
    mode: 'deterministic',
    setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' },
    overlayUrl: (v) => v,
    clock,
  });
  const fx = loadFixture(file, corpus);
  const results = fx.events.flatMap((e) => (e.type === 'result' ? [{ t: e.t, tokens: e.tokens as WireToken[] }] : []));
  // Audio time 0 in the capture clock (see the header).
  let minSeen = Infinity;
  const seen = new Set<number>();
  for (const r of results)
    for (const k of r.tokens) {
      if (typeof k.startMs !== 'number' || typeof k.endMs !== 'number' || /^<.*>$/.test(k.text.trim()) || seen.has(k.startMs)) continue;
      seen.add(k.startMs);
      minSeen = Math.min(minSeen, r.t - k.endMs);
    }
  const offset = Math.max(0, minSeen - PROVIDER_LAG);
  const shown: Shown[] = [];
  // --window 23-30 (audio seconds): print every screen change with the words heard so far.
  const win = flag('--window')?.split('-').map((x) => Number(x) * 1000) ?? null;
  const live = new TranscriptBuffer();
  const heardNow = () => live.liveWords().slice(-5).map((w) => `${w.text}@${w.startMs}`).join(' ');
  const verses = new Set<number>();
  session.onDisplay((s) => {
    const verse = s.visible && s.verse ? corpus.verse(s.verse.key)!.index : null;
    if (verse !== null) verses.add(verse);
    const w = verse !== null && s.cursor ? searchWord(verse, s.cursor.from) : null;
    shown.push({ t: clock.now() - offset, verse, pos: verse !== null && w !== null ? ix.verseStart[verse] + w : null });
    if (win && clock.now() - offset >= win[0] && clock.now() - offset <= win[1]) console.log(`      ${((clock.now() - offset) / 1000).toFixed(2)}s show ${shown.at(-1)!.pos === null ? '-' : label(shown.at(-1)!.pos!)}   heard: ${heardNow()}`);
  });
  session.handle({ type: 'capture', captureEpoch: 1, event: 'starting' });
  session.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
  let seq = 0;
  for (const e of fx.events) {
    clock.advanceTo(e.t);
    if (e.type === 'result') live.apply(e.tokens as WireToken[]);
    if (e.type === 'result') session.handle({ type: 'transcript', captureEpoch: 1, seq: seq++, tokens: e.tokens as WireToken[], receivedAt: e.t, audioMs: e.audioMs ?? Math.max(0, e.t - offset) });
    else if (e.type === 'voice') session.handle({ type: 'voice', captureEpoch: 1, speaking: e.speaking, audioMs: e.audioMs });
    else if (e.action.kind === 'manual') session.handle({ type: 'goto', key: e.action.key });
    await new Promise((r) => setImmediate(r));
  }
  clock.advanceTo(clock.now() + 4000);
  session.dispose();

  const buf = new TranscriptBuffer();
  for (const r of results) buf.apply(r.tokens);
  buf.flush();
  const heard = buf.finals.flatMap((w) => tokenize(w.text).filter((t) => !t.foreign).map((t) => ({ key: t.key, start: w.startMs ?? NaN, end: w.endMs ?? NaN })));
  const truth = groundTruth(heard.filter((w) => Number.isFinite(w.start)), verses);

  const st: Stats = { sync: 0, behind: 0, ahead: 0, none: 0, unlit: 0, behindWords: 0, onset: [], back: 0, skips: 0, words: truth.length };
  const at = (t: number) => {
    let s: Shown | null = null;
    for (const x of shown) {
      if (x.t > t) break;
      s = x;
    }
    return s;
  };
  // Moment by moment while a word is being recited (pauses longer than 400 ms are left out).
  for (let n = 0; n < truth.length; n++) {
    const g = truth[n];
    const nextStart = truth[n + 1]?.start ?? g.end + 400;
    const until = nextStart - g.end <= 400 ? nextStart : g.end + 400;
    for (let t = g.start; t < until; t += 10) {
      const s = at(t);
      if (s && s.pos === null && s.verse === ix.wordVerse[g.pos]) st.unlit++;
      if (!s || s.pos === null || ix.wordVerse[s.pos] !== ix.wordVerse[g.pos]) st.none++;
      else if (s.pos === g.pos) st.sync++;
      else if (s.pos < g.pos) {
        st.behind++;
        st.behindWords += g.pos - s.pos;
      } else st.ahead++;
    }
    // Onset: when the highlight last moved onto this word (or past it) around its recitation,
    // relative to its first sound (negative: early). Only for words continuing the previous one.
    if (n > 0 && truth[n - 1].pos === g.pos - 1 && ix.wordVerse[g.pos] === ix.wordVerse[g.pos - 1]) {
      const reached = (x: Shown | undefined) => !!x && x.pos !== null && x.pos >= g.pos && ix.wordVerse[x.pos] === ix.wordVerse[g.pos];
      let crossing: number | null = null;
      for (let i = 0; i < shown.length && shown[i].t <= g.start + 3000; i++) if (reached(shown[i]) && !reached(shown[i - 1])) crossing = shown[i].t;
      if (crossing !== null && crossing >= truth[n - 1].start - 3000) st.onset.push(crossing - g.start);
    }
    if (trace) {
      // Stretches where the highlight was ahead of the voice for over 250 ms.
      let run: { from: number; shownPos: number } | null = null;
      for (let t = g.start; t <= until; t += 10) {
        const s = t < until ? at(t) : null;
        const ahead = !!s && s.pos !== null && s.pos > g.pos && ix.wordVerse[s.pos] === ix.wordVerse[g.pos];
        if (ahead && !run) run = { from: t, shownPos: s!.pos! };
        if (!ahead && run) {
          if (t - run.from > 250) console.log(`    ${(run.from / 1000).toFixed(2).padStart(7)}s ahead ${t - run.from} ms: reciting ${label(g.pos)}, showing ${label(run.shownPos)} (word took ${nextStart - g.start} ms)`);
          run = null;
        }
      }
    }
  }
  for (let i = 1; i < shown.length; i++) {
    const a = shown[i - 1].pos;
    const b = shown[i].pos;
    if (a !== null && b !== null && ix.wordVerse[a] === ix.wordVerse[b] && b < a && a - b <= 2) st.back++;
    if (a !== null && b !== null && ix.wordVerse[a] === ix.wordVerse[b] && b - a >= 2) st.skips++;
  }
  return { ...st, offset };
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.floor(s.length * p))] / 1000).toFixed(2) : '—';
};
const pc = (a: number, total: number) => `${total ? Math.round((a / total) * 100) : 0}%`;
const total: Stats = { sync: 0, behind: 0, ahead: 0, none: 0, unlit: 0, behindWords: 0, onset: [], back: 0, skips: 0, words: 0 };
for (const f of files) {
  const r = await run(f);
  total.sync += r.sync;
  total.behind += r.behind;
  total.ahead += r.ahead;
  total.none += r.none;
  total.unlit += r.unlit;
  total.behindWords += r.behindWords;
  total.onset.push(...r.onset);
  total.back += r.back;
  total.skips += r.skips;
  total.words += r.words;
  if (process.argv.includes('--each') || trace) {
    const all = r.sync + r.behind + r.ahead + r.none;
    console.log(`  ${path.basename(f)}: ${r.words} words, on the word ${pc(r.sync, all)}, behind ${pc(r.behind, all)}, ahead ${pc(r.ahead, all)}, none ${pc(r.none, all)} | onset p50 ${q(r.onset, 0.5)} s p90 ${q(r.onset, 0.9)} s | back-steps ${r.back} | audio origin ${r.offset} ms`);
  }
}
const all = total.sync + total.behind + total.ahead + total.none;
console.log(
  `${files.length} captures, ${total.words} recited words (provider lag assumed ${PROVIDER_LAG} ms):\n` +
    `  while a word is being recited, the highlight is on it ${pc(total.sync, all)}, behind ${pc(total.behind, all)} (by ${(total.behindWords / Math.max(1, total.behind)).toFixed(2)} words), ahead ${pc(total.ahead, all)}, on no word of that ayah ${pc(total.none, all)} (that ayah on screen, no highlight: ${pc(total.unlit, all)})\n` +
    `  word start -> highlighted: p10 ${q(total.onset, 0.1)} s, p50 ${q(total.onset, 0.5)} s, p90 ${q(total.onset, 0.9)} s (${total.onset.length} words; negative = early)\n` +
    `  highlight stepped back 1-2 words: ${total.back}; jumped forward over a word or more: ${total.skips}`,
);

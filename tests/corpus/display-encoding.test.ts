// The display encoding adapts the source-owned Quran.com Uthmani text to the codepoints the KFGQPC
// Uthmanic Hafs font is built for (QPC-Hafs). The source text is never changed; these tests pin the
// only differences the display may have from it and prove, over all 6,236 ayahs, that nothing else
// differs.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toQpcHafsEncoding } from '../../src/shared/display-encoding';
import { fullCorpus } from '../helpers';

const TATWEEL = 'ـ';
const DAGGER_ALIF = 'ٰ';
/** The documented codepoint mapping for the same marks (source -> font). */
const MARKS: Readonly<Record<string, string>> = { 'ْ': 'ۡ', '۟': 'ْ', '۫': '۬' };
/**
 * Its inverse where it is exact. U+06EB (12:11) and U+06EC (in the source itself, 41:44) are both
 * drawn as U+06EC: that pre-existing pair is compared as one mark in the round trip below (the walk in
 * `violation` still checks it codepoint by codepoint).
 */
const UNMARK: Readonly<Record<string, string>> = { 'ۡ': 'ْ', 'ْ': '۟' };
const foldHighStop = (s: string) => s.replaceAll('۫', '۬');

const hex = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');
const text = (codepoints: string) => String.fromCodePoint(...codepoints.split(' ').map((h) => parseInt(h, 16)));
const word = (key: string, i: number) => fullCorpus().corpus.verse(key)!.arabicDisplay.split(' ')[i];

/**
 * Walks the source and the display text together. Every source codepoint must reappear, in order, as
 * itself or as its documented mark; the only codepoint allowed to disappear is a tatweel immediately
 * before a dagger alif. Returns the first violation, or null.
 */
function violation(source: string, shown: string): string | null {
  const s = [...source];
  const d = [...shown];
  let j = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === TATWEEL && s[i + 1] === DAGGER_ALIF) {
      if (d[j] === TATWEEL) return `tatweel kept before the dagger alif at source codepoint ${i}`;
      continue;
    }
    const want = MARKS[s[i]] ?? s[i];
    if (d[j] !== want) return `source codepoint ${i} (${hex(s[i])}) shown as ${d[j] === undefined ? 'nothing' : hex(d[j])}`;
    j++;
  }
  return j === d.length ? null : `${d.length - j} extra codepoint(s) at the end`;
}

describe('the dagger alif sits on its letter, as the font draws it', () => {
  it('ٱلرَّحۡمَـٰنِ (1:1 and 1:3) is shown in the QPC-Hafs spelling: no tatweel seat before the dagger alif', () => {
    const source = '0671 0644 0631 0651 064E 062D 0652 0645 064E 0640 0670 0646 0650';
    expect(hex(word('1:1', 2))).toBe(source); // the source keeps its own spelling
    expect(hex(word('1:3', 0))).toBe(source);
    expect(hex(toQpcHafsEncoding(text(source)))).toBe('0671 0644 0631 0651 064E 062D 06E1 0645 064E 0670 0646 0650');
  });

  it('ٱلۡكِتَـٰبُ (2:2) and ٱلشَّيۡطَـٰنُ (7:20): the long vowel stays above the letter before the final letter', () => {
    expect(hex(toQpcHafsEncoding(word('2:2', 1)))).toBe('0671 0644 06E1 0643 0650 062A 064E 0670 0628 064F');
    expect(hex(toQpcHafsEncoding(word('7:20', 2)))).toBe('0671 0644 0634 0651 064E 064A 06E1 0637 064E 0670 0646 064F');
  });

  it('keeps every tatweel that seats anything other than a dagger alif', () => {
    // hamza above (9:18 ٱلْـَٔاخِرِ), small yeh (33:7 ٱلنَّبِيِّـۧنَ), small waw (17:7), small high noon, a
    // bare tatweel before a letter, and one ending the text.
    for (const seated of ['0640 0654', '0640 06E7', '0640 06E5', '0640 06E8', '0640 0628', '0628 0640']) {
      expect(hex(toQpcHafsEncoding(text(seated)))).toBe(seated);
    }
    expect(hex(toQpcHafsEncoding(word('9:18', 8)))).toBe('0671 0644 06E1 0640 0654 064E 0627 062E 0650 0631 0650');
    expect(hex(toQpcHafsEncoding(word('33:7', 3)))).toBe(hex(word('33:7', 3)));
  });

  it('a hamza seated on a tatweel keeps its seat when a dagger alif follows it (ٱلْـَٔـٰنَ, 4:18)', () => {
    expect(hex(toQpcHafsEncoding(word('4:18', 13)))).toBe('0671 0644 06E1 0640 0654 064E 0670 0646 064E');
  });

  it('changes nothing else: letters, other marks, digits, spaces and Latin pass through', () => {
    const untouched = text('0628 0650 0633 0640 0645 0650 0020 0627 0653 0670 0651 06E1 06EC 06E3 06D6 065E 0661 0032 0041 00A0');
    expect(toQpcHafsEncoding(untouched)).toBe(untouched);
    expect(hex(toQpcHafsEncoding(text('0652 06DF 06EB')))).toBe('06E1 0652 06EC');
  });

  it('is stable on its own output where it matters: no further tatweel is ever removed', () => {
    for (const v of fullCorpus().corpus.verses) {
      const once = toQpcHafsEncoding(v.arabicDisplay);
      const twice = toQpcHafsEncoding(once);
      expect(twice.replace(/[^ـ\s]/g, ''), v.key).toBe(once.replace(/[^ـ\s]/g, ''));
      expect(twice.includes(TATWEEL + DAGGER_ALIF), v.key).toBe(false);
    }
  });
});

describe('every ayah keeps its source text (all 6,236)', () => {
  const { corpus } = fullCorpus();

  it('only ever removes a tatweel immediately before a dagger alif; every other codepoint is the source or its documented mark', () => {
    let removed = 0;
    for (const v of corpus.verses) {
      const shown = toQpcHafsEncoding(v.arabicDisplay);
      expect(violation(v.arabicDisplay, shown), v.key).toBeNull();
      expect(shown.includes(TATWEEL + DAGGER_ALIF), v.key).toBe(false);
      removed += [...v.arabicDisplay].length - [...shown].length;
    }
    expect(corpus.verses).toHaveLength(6236);
    expect(removed).toBe(5924); // every tatweel + dagger alif seat in the source, and nothing more
  });

  it('round-trips: undoing the mark mapping gives the source with only those seats ignored, word for word', () => {
    for (const v of corpus.verses) {
      const shown = toQpcHafsEncoding(v.arabicDisplay);
      const undone = [...shown].map((c) => UNMARK[c] ?? c).join('');
      expect(undone, v.key).toBe(foldHighStop(v.arabicDisplay).split(TATWEEL + DAGGER_ALIF).join(DAGGER_ALIF));
      // Word counts (and so word meanings, the recited-word cursor and paging) are unchanged.
      expect(shown.split(/\s+/).length, v.key).toBe(v.arabicDisplay.split(/\s+/).length);
    }
  });

  it('never touches the source: the corpus text is the same before and after display', () => {
    const before = corpus.verses.map((v) => v.arabicDisplay).join('\n');
    for (const v of corpus.verses) toQpcHafsEncoding(v.arabicDisplay);
    expect(corpus.verses.map((v) => v.arabicDisplay).join('\n')).toBe(before);
  });
});

// The repository's QUL development sample (QPC-Hafs, the font's own text) is a local research file,
// not a fetched source: skipped when it is absent.
const SAMPLE = 'data/raw/qul-dev-dump-qpc-hafs-sample.tsv';
describe.skipIf(!existsSync(SAMPLE))('agreement with the font’s own encoding (QUL QPC-Hafs sample)', () => {
  it('the font’s text never writes a tatweel before a dagger alif, and neither does the display', () => {
    const { corpus } = fullCorpus();
    let verses = 0;
    let exact = 0;
    for (const line of readFileSync(SAMPLE, 'utf8').split(/\r?\n/)) {
      const [key, , qpc] = line.split('\t');
      const v = key && qpc ? corpus.verse(key) : undefined;
      if (!v) continue;
      verses++;
      const target = qpc.replace(/\s*[٠-٩]+\s*$/, '').trim();
      expect(target.includes(TATWEEL + DAGGER_ALIF), key).toBe(false);
      if (toQpcHafsEncoding(v.arabicDisplay) === target) exact++;
    }
    expect(verses).toBe(1923);
    expect(exact).toBeGreaterThanOrEqual(547); // 384 before the dagger alif rule
  });
});

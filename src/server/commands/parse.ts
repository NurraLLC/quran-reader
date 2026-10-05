// Typed/voice English command → intent. Purely local and deterministic; ordinary text that is not
// an explicit reference or navigation word becomes a meaning search (never an action).

import { HAFS_VERSE_COUNTS } from '../../shared/corpus-types';
import { NAMED_PASSAGES, normalizeEnglish, parseNumberAt, type ChapterMatch, type ChapterNames } from '../search/references';

export type Intent =
  | { kind: 'empty' }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'reference'; surah: number; ayah: number | null; route: 'numeric' | 'named_chapter' | 'named_passage' | 'current_chapter' | 'position'; position?: 'first' | 'last' }
  | { kind: 'invalid_reference'; message: string }
  /** `last`: each option opens at its own last ayah ("last ayah of surah Fatih"). */
  | { kind: 'ambiguous_chapter'; options: ChapterMatch[]; ayah: number | null; last?: boolean }
  | { kind: 'division'; type: 'juz' | 'hizb' | 'rub' | 'manzil'; number: number }
  | { kind: 'search'; query: string; scope?: 'surah' | 'ayah' }
  | { kind: 'control'; action: ControlAction };

/** A display/following setting spoken or typed instead of clicked. */
export type ControlAction = {
  label: string;
  style?: { language?: 'both' | 'arabic' | 'english'; readingMode?: 'follow' | 'word' | 'ayah' };
  hold?: boolean;
  blank?: boolean;
};

// Words that carry no meaning in a setting request ("go full English only mode please").
const CONTROL_FILLER = new Set(['go', 'to', 'switch', 'change', 'turn', 'into', 'in', 'put', 'it', 'make', 'set', 'please', 'the', 'a', 'mode', 'view', 'can', 'you', 'lets', 'let', 'us', 'now', 'me', 'full', 'fully', 'use', 'back', 'screen', 'overlay', 'display']);
// Every remaining word must be one of these, so "the ayah about English speakers" is never a setting.
const CONTROL_VOCAB = new Set(['english', 'arabic', 'only', 'just', 'both', 'and', 'translation', 'translations', 'word', 'by', 'focus', 'follow', 'words', 'along', 'whole', 'ayah', 'verse', 'pause', 'stop', 'following', 'resume', 'start', 'unpause', 'hide', 'unhide', 'show', 'blank', 'unblank', 'one', 'single', 'off', 'on', 'with', 'without', 'no', 'highlight', 'languages', 'language', 'meaning', 'meanings']);

function parseControl(all: string[]): ControlAction | null {
  const joined = all.join(' ');
  const has = (w: string) => all.includes(w);
  if (/\b(full|whole) (ayah|verse)\b/.test(joined) && !has('english') && !has('arabic')) return { label: 'Showing the full ayah.', style: { readingMode: 'ayah' } };
  const t = all.filter((w) => !CONTROL_FILLER.has(w));
  if (!t.length || t.some((w) => !CONTROL_VOCAB.has(w))) return null;
  const s = new Set(t);
  const en = s.has('english') || s.has('translation') || s.has('translations') || s.has('meaning') || s.has('meanings');
  const ar = s.has('arabic');
  const only = s.has('only') || s.has('just');
  const off = s.has('hide') || s.has('off') || s.has('without') || s.has('no');
  if ((ar && en && !only && !off) || s.has('both') || (en && !ar && (s.has('show') || s.has('with') || s.has('on')) && !only)) return { label: 'Showing Arabic with the English translation.', style: { language: 'both' } };
  if ((en && off && !ar) || (ar && (only || t.length === 1))) return { label: 'Showing Arabic only.', style: { language: 'arabic' } };
  if (en && !ar && (only || t.length === 1 || (t.length === 2 && s.has('translation') && s.has('english')))) return { label: 'Showing the English translation only.', style: { language: 'english' } };
  if ((s.has('word') && (s.has('by') || s.has('focus') || s.has('one') || s.has('single'))) || joined === 'word') return { label: 'Word focus: one word at a time.', style: { readingMode: 'word' } };
  if (s.has('follow') || s.has('highlight')) return { label: 'Following word by word.', style: { readingMode: 'follow' } };
  if (s.has('unpause') || s.has('resume') || (s.has('start') && s.has('following'))) return { label: 'Following resumed.', hold: false };
  if (s.has('pause') || (s.has('stop') && s.has('following'))) return { label: 'Following paused; the screen holds this ayah.', hold: true };
  if (s.has('unhide') || s.has('unblank') || (s.has('show') && t.length === 1)) return { label: 'The screen is showing again.', blank: false };
  if (s.has('hide') || s.has('blank')) return { label: 'The screen is hidden.', blank: true };
  return null;
}

// "surah about patience", "a surah where ..." are searches, not surah names.
const ABOUT = new Set(['about', 'on', 'regarding', 'where', 'which', 'that', 'with', 'concerning', 'discussing', 'describing', 'mentioning', 'related', 'of']);

/** A name match is taken only when it is unmistakable; close alternatives are offered instead. */
function clearWinner(m: ChapterMatch[]): boolean {
  if (!m.length) return false;
  if (m.length === 1) return true;
  return m[0].distance === 0 ? m[1].distance > 0 : m[1].distance >= m[0].distance + 2;
}

const LEADING = [
  ['please'],
  ['can', 'you'],
  ['go', 'to'],
  ['goto'],
  ['jump', 'to'],
  ['take', 'me', 'to'],
  ['show', 'me'],
  ['show'],
  ['open'],
  ['display'],
  ['go'],
];
const CHAPTER_WORDS = new Set(['surah', 'sura', 'surat', 'soorah', 'chapter']);
const AYAH_WORDS = new Set(['ayah', 'aya', 'ayat', 'verse', 'number', 'ayahs', 'verses']);
const NEXT = new Set(['next', 'next ayah', 'next verse', 'forward', 'continue', 'next one']);
const PREV = new Set(['previous', 'prev', 'back', 'go back', 'previous ayah', 'previous verse', 'last verse', 'last ayah', 'previous one']);

function stripLeading(tokens: string[]): string[] {
  let t = tokens;
  let changed = true;
  while (changed && t.length) {
    changed = false;
    for (const p of LEADING) {
      if (p.every((w, i) => t[i] === w) && t.length > p.length) {
        t = t.slice(p.length);
        changed = true;
        break;
      }
    }
  }
  if (t[0] === 'the' && t.length > 1) t = t.slice(1);
  return t;
}

/** Number that may be spoken digit-by-digit ("two five five" = 255). */
function numberAt(t: string[], i: number) {
  const n = parseNumberAt(t, i);
  if (!n) return null;
  if (n.value < 10 && n.next === i + 1) {
    const b = parseNumberAt(t, n.next);
    const c = b ? parseNumberAt(t, b.next) : null;
    if (b && c && b.value < 10 && c.value < 10 && b.next === n.next + 1 && c.next === b.next + 1) {
      return { value: n.value * 100 + b.value * 10 + c.value, next: c.next };
    }
  }
  return n;
}

const FIRST = new Set(['first', 'opening']);
const LAST = new Set(['last', 'final', 'closing']);
const START = new Set(['beginning', 'start']);
const END = new Set(['end', 'ending']);

/**
 * A place named by its position in a surah: "last ayah of Al-Baqarah", "the end of surah Al-Kahf",
 * "first verse of Al-Mulk", or just "verse of Maryam" (its start). Only an exact surah name is used;
 * anything else is left to the other readings (never a sound-alike guess).
 */
function parsePosition(t: string[], names: ChapterNames): Intent | null {
  let which: 'first' | 'last' | null;
  let i: number;
  if ((FIRST.has(t[0]) || LAST.has(t[0])) && AYAH_WORDS.has(t[1] ?? '') && t[2] === 'of') {
    which = FIRST.has(t[0]) ? 'first' : 'last';
    i = 3;
  } else if ((START.has(t[0]) || END.has(t[0])) && t[1] === 'of') {
    which = START.has(t[0]) ? 'first' : 'last';
    i = 2;
  } else if (AYAH_WORDS.has(t[0]) && t[1] === 'of') {
    which = null;
    i = 2;
  } else return null;
  if (t[i] === 'the') i++;
  if (CHAPTER_WORDS.has(t[i] ?? '')) i++;
  const name = t.slice(i);
  if (!name.length || name.some((w) => /\d/.test(w))) return null;
  const matches = names.match(name.join(' '));
  if (!matches.length) return null;
  if (!clearWinner(matches)) return { kind: 'ambiguous_chapter', options: matches.slice(0, 5), ayah: which === 'last' ? null : 1, last: which === 'last' };
  const surah = matches[0].number;
  if (!which) return validate(surah, null, 'named_chapter', names);
  return { kind: 'reference', surah, ayah: which === 'first' ? 1 : HAFS_VERSE_COUNTS[surah - 1], route: 'position', position: which };
}

function validate(surah: number, ayah: number | null, route: Extract<Intent, { kind: 'reference' }>['route'], names: ChapterNames): Intent {
  if (surah < 1 || surah > 114) return { kind: 'invalid_reference', message: `There is no surah ${surah}. Surahs are numbered 1 to 114.` };
  const count = HAFS_VERSE_COUNTS[surah - 1];
  const name = names.chapters[surah - 1].nameSimple;
  if (ayah !== null && (ayah < 1 || ayah > count)) {
    return { kind: 'invalid_reference', message: `Surah ${name} (${surah}) has ${count} ayahs; ${ayah} is out of range.` };
  }
  return { kind: 'reference', surah, ayah, route };
}

export function parseIntent(text: string, names: ChapterNames, currentSurah: number | null): Intent {
  const all = normalizeEnglish(text);
  if (!all.length) return { kind: 'empty' };
  const joined = all.join(' ');
  if (NEXT.has(joined)) return { kind: 'next' };
  if (PREV.has(joined)) return { kind: 'previous' };
  const control = parseControl(all);
  if (control) return { kind: 'control', action: control };
  const t = stripLeading(all);
  const phrase = t.join(' ');
  if (NEXT.has(phrase)) return { kind: 'next' };
  if (PREV.has(phrase)) return { kind: 'previous' };

  // "juz 30", "para 30", "hizb five", "manzil 3", "rub 12"
  const DIV: Record<string, 'juz' | 'hizb' | 'rub' | 'manzil'> = { juz: 'juz', juzz: 'juz', para: 'juz', parah: 'juz', hizb: 'hizb', rub: 'rub', manzil: 'manzil' };
  if (t.length >= 2 && DIV[t[0]]) {
    const n = numberAt(t, 1);
    if (n && n.next === t.length) {
      const type = DIV[t[0]];
      const max = { juz: 30, hizb: 60, rub: 240, manzil: 7 }[type];
      if (n.value < 1 || n.value > max) return { kind: 'invalid_reference', message: `There are ${max} ${type === 'rub' ? 'rub‘ sections' : `${type}s`}; ${n.value} is out of range.` };
      return { kind: 'division', type, number: n.value };
    }
  }

  // "2 255" (from "2:255" / "2.255")
  if (t.length === 2 && /^\d{1,3}$/.test(t[0]) && /^\d{1,3}$/.test(t[1])) return validate(Number(t[0]), Number(t[1]), 'numeric', names);

  for (const p of NAMED_PASSAGES) {
    if (p.phrases.includes(phrase)) {
      const [s, a] = p.key.split(':').map(Number);
      return validate(s, a, 'named_passage', names);
    }
  }

  const position = parsePosition(t, names);
  if (position) return position;

  // Optional trailing "(ayah|verse) N" or bare N.
  const readAyah = (i: number): { ayah: number | null; ok: boolean } => {
    if (i >= t.length) return { ayah: null, ok: true };
    let j = i;
    if (AYAH_WORDS.has(t[j])) j++;
    const n = numberAt(t, j);
    if (n && n.next === t.length) return { ayah: n.value, ok: true };
    return { ayah: null, ok: false };
  };

  const ci = t.findIndex((w) => CHAPTER_WORDS.has(w));
  // "(the) surah about elephants" asks for a surah; "ayah about the orphan" for an ayah. The scope
  // word is dropped from the query: translations mention "a surah" often enough to pollute results.
  if (ci >= 0 && ABOUT.has(t[ci + 1] ?? '')) return { kind: 'search', query: t.slice(ci + 2).join(' ') || text.trim(), scope: 'surah' };
  const ai = t.findIndex((w) => AYAH_WORDS.has(w));
  if (ai >= 0 && ai <= 1 && ABOUT.has(t[ai + 1] ?? '') && t.length > ai + 2) return { kind: 'search', query: t.slice(ai + 2).join(' '), scope: 'ayah' };
  if (ci >= 0) {
    const n = numberAt(t, ci + 1);
    if (n) {
      const rest = readAyah(n.next);
      if (rest.ok) return validate(n.value, rest.ayah, 'numeric', names);
    }
    // Name words until an ayah keyword / number / end.
    let end = ci + 1;
    while (end < t.length && !AYAH_WORDS.has(t[end]) && !numberAt(t, end)) end++;
    const namePhrase = t.slice(ci + 1, end).join(' ');
    const rest = readAyah(end);
    if (namePhrase && rest.ok) {
      const matches = names.match(namePhrase);
      if (clearWinner(matches)) return validate(matches[0].number, rest.ayah, 'named_chapter', names);
      if (matches.length > 1) return { kind: 'ambiguous_chapter', options: matches.slice(0, 5), ayah: rest.ayah };
      return { kind: 'invalid_reference', message: `No surah named “${namePhrase}”.` };
    }
  }

  // "(ayah|verse) N" in the current surah.
  if (AYAH_WORDS.has(t[0])) {
    const n = numberAt(t, 1);
    if (n && n.next === t.length) {
      if (currentSurah === null) return { kind: 'invalid_reference', message: 'No current surah yet — say the surah too, e.g. “Surah Maryam ayah 3”.' };
      return validate(currentSurah, n.value, 'current_chapter', names);
    }
  }

  // Bare chapter name, optionally followed by an ayah: "baqarah 255", "yaseen", "al kahf verse 10".
  // A name never contains digits: name keys ignore them, so "kahf 10" would otherwise match Al-Kahf
  // as a whole and lose its ayah.
  for (let len = Math.min(3, t.length); len >= 1; len--) {
    if (t.slice(0, len).some((w) => /\d/.test(w))) continue;
    const rest = readAyah(len);
    if (!rest.ok) continue;
    const matches = names.match(t.slice(0, len).join(' '));
    if (!matches.length) continue;
    if (clearWinner(matches)) return validate(matches[0].number, rest.ayah, 'named_chapter', names);
    return { kind: 'ambiguous_chapter', options: matches.slice(0, 5), ayah: rest.ayah };
  }

  return { kind: 'search', query: text.trim() };
}

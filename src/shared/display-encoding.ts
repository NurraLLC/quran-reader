// Display encoding for the KFGQPC Uthmanic Hafs font (QUL font 245).
//
// Our display source (Quran.com Uthmani) and QPC-Hafs (the text this font is built for) encode
// these Mushaf marks with different codepoints:
//   mark                       Quran.com Uthmani   QPC-Hafs / this font
//   silent letter (round zero) U+06DF              U+0652
//   sukun (jazm)               U+0652              U+06E1
//   rounded high stop (12:11)  U+06EB              U+06EC
// Rendering the source directly draws every U+06DF as an unattached dotted circle (verified in the
// browser) and every sukun as a round zero. This is a codepoint mapping for the same marks, not a
// text change; scripts/check-display-encoding.ts measures it against QUL's QPC-Hafs text.
//
// The dagger (superscript) alif: the source seats it on a tatweel (U+0640 U+0670); QPC-Hafs writes it
// directly on its letter and never keeps that tatweel (0 of 1,590 seats in the 1,923-verse QUL
// sample). With the seat, this font draws the dagger alif as a separate stroke after words ending in
// ب/ت/ث/ن/ل (ٱلرَّحۡمَـٰنِ in 1:1, ٱلۡكِتَـٰبُ in 2:2: 1,238 such words). So that one tatweel is not
// displayed. Every other tatweel stays (QPC keeps it before hamza U+0654, small yeh U+06E7, small waw
// U+06E5). Word count and order are unchanged, so meanings, the recited-word cursor and paging align.
//
// Known remaining defect: U+06E3 (small low seen, only in 52:37) still renders unattached; QPC
// evidence for it is not in the local sample, so it is not guessed. Importing QUL resource 86
// (QPC-Hafs text) would replace this mapping entirely.
// Search/recognition never uses this (it reads the Imlaei text). The source text is never changed:
// tests/corpus/display-encoding.test.ts proves, for all 6,236 ayahs, that these are the only
// differences between what is shown and the source.

const MAP: ReadonlyMap<string, string> = new Map([
  [String.fromCodePoint(0x0652), String.fromCodePoint(0x06e1)],
  [String.fromCodePoint(0x06df), String.fromCodePoint(0x0652)],
  [String.fromCodePoint(0x06eb), String.fromCodePoint(0x06ec)],
]);
const TATWEEL = String.fromCodePoint(0x0640);
const DAGGER_ALIF = String.fromCodePoint(0x0670);

export function toQpcHafsEncoding(uthmani: string): string {
  const chars = [...uthmani];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === TATWEEL && chars[i + 1] === DAGGER_ALIF) continue;
    out += MAP.get(chars[i]) ?? chars[i];
  }
  return out;
}

/** Codepoints verified to render unattached with this font even after re-encoding. */
export const KNOWN_UNRENDERABLE: ReadonlySet<number> = new Set([0x06e3]);

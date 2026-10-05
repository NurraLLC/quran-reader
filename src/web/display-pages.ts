import type { DisplayState } from '../shared/contracts';

export type PageWords = { arabicPageWords: number[]; englishPageWords: number[] };

/** The page holding a word position (or the last page when the ayah is complete). */
function pageAtWord(words: number[], at: number): number {
  let page = 0;
  for (let i = 1, before = words[0]; i < words.length; before += words[i], i++) if (before <= at) page = i;
  return page;
}

/** The pages actually shown by this measured renderer; also the origin for its control arrows. */
export function shownPages(
  pages: PageWords,
  state: Pick<DisplayState, 'arabicPage' | 'englishPage' | 'cursor' | 'progress' | 'style'>,
  displayWords: number,
): { arabic: number; english: number } {
  const nA = pages.arabicPageWords.length;
  const nE = pages.englishPageWords.length;
  const arabicWords = pages.arabicPageWords.reduce((a, b) => a + b, 0);
  const arabicAt = state.cursor?.from ?? (state.progress === null ? 0 : Math.floor(state.progress * arabicWords));
  const arabic = state.arabicPage === null ? pageAtWord(pages.arabicPageWords, arabicAt) : Math.min(state.arabicPage, nA - 1);
  let english = Math.min(state.englishPage ?? 0, nE - 1);
  const at = state.cursor && displayWords ? (state.cursor.from + 1) / displayWords : state.progress;
  if (state.style.language !== 'arabic' && state.englishPage === null && !state.style.translationPageSeconds && at !== null) {
    const total = pages.englishPageWords.reduce((a, b) => a + b, 0);
    for (let i = 1, before = pages.englishPageWords[0]; i < nE; before += pages.englishPageWords[i], i++) {
      if (before / (total || 1) <= at) english = i;
    }
  }
  return { arabic, english };
}
